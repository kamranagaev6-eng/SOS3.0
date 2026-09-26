import type { MotionPlan } from '../contracts/plan.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { findSurface, penetrationDepth, solids } from '../environment/surfaces.ts';
import { quatRotateVec3 } from '../math/quat.ts';
import { distance, dot, type Vec3 } from '../math/vec3.ts';
import { decomposeJointRotation, getRigModel, rigidLinks } from '../rig/model.ts';
import { samplePose } from '../solver/sample.ts';
import type { PoseSample, SolverTier } from '../solver/types.ts';
import { TOLERANCES } from '../tolerances.ts';
import { bakeTimes } from './bake.ts';
import type { BakedClip, ClipMetrics } from './types.ts';

/**
 * Streaming clip analysis. Every metric is recomputed from the FK output (world joint/site
 * positions, local rotations) and the environment geometry, independently of the solver's own
 * residual bookkeeping:
 *  - planted displacement: site position vs its position when its contact first became fully active
 *  - contact height: active position-contact sites vs the support surface height
 *  - sole tilt: active orientation-contact segment's up axis vs world up
 *  - penetration: every contact/penetration site vs floor and solids
 *  - bone lengths: joint-to-joint and joint-to-site distances vs rig rest geometry
 *  - joint limits: local rotations re-decomposed and compared with limits
 *  - discontinuities: second differences of DOF angles, pelvis and contact-site positions
 */
export class ClipAnalyzer {
  private readonly model;
  private readonly links;
  private readonly siteLinks: { site: number; joint: number; length: number }[];
  private readonly boxes;
  private readonly anchors = new Map<string, Vec3>();
  private prev: PoseSample[] = [];
  private readonly m: ClipMetrics;
  private readonly h: number;

  private readonly plan: MotionPlan;

  constructor(plan: MotionPlan, rig: RigDefinition, tier: SolverTier, rate: number) {
    this.plan = plan;
    this.model = getRigModel(rig);
    this.links = rigidLinks(this.model);
    this.siteLinks = rig.sites.map((s, i) => ({ site: i, joint: this.model.index.get(s.joint)!, length: Math.hypot(...s.offset) }));
    this.boxes = solids(plan.environment);
    this.h = 1 / rate;
    this.m = {
      tier,
      sampleRate: rate,
      samples: 0,
      maxContactPositionError: 0,
      maxPlantedDisplacement: 0,
      maxContactOrientationError: 0,
      maxPenetration: 0,
      maxBoneLengthRelError: 0,
      jointLimitViolations: 0,
      clampedSamples: 0,
      maxJointVelocityJump: 0,
      maxLinearVelocityJump: 0,
      maxStabilizationOffset: 0,
      stabilizedSamples: 0,
      nonConvergedSamples: 0,
      unreachableSamples: 0,
      kneeFlipSamples: 0,
      diagnosticsByCode: {},
      withinTolerance: true,
      failures: [],
    };
  }

  push(s: PoseSample): void {
    const m = this.m;
    m.samples++;
    // Contacts (independent geometry checks).
    for (const c of s.contacts) {
      if (c.state !== 'active') {
        this.anchors.delete(c.interval.id);
        continue;
      }
      if (c.interval.kind === 'position' && c.actual) {
        const surf = findSurface(this.plan.environment, c.interval.surface);
        if (surf) m.maxContactPositionError = Math.max(m.maxContactPositionError, Math.abs(c.actual[1] - surf.y));
        if (c.positionError !== null) m.maxContactPositionError = Math.max(m.maxContactPositionError, c.positionError);
        const a = this.anchors.get(c.interval.id);
        if (!a) this.anchors.set(c.interval.id, c.actual);
        else m.maxPlantedDisplacement = Math.max(m.maxPlantedDisplacement, distance(a, c.actual));
      } else if (c.interval.kind === 'orientation') {
        const side = c.interval.side === 'left' ? '_L' : '_R';
        const j = this.model.index.get(`${c.interval.segment === 'toes' ? 'mtp' : 'ankle'}${side}`)!;
        const up = quatRotateVec3(s.worldRot[j]!, [0, 1, 0]);
        const tilt = Math.acos(Math.min(1, Math.max(-1, dot(up, [0, 1, 0]))));
        m.maxContactOrientationError = Math.max(m.maxContactOrientationError, tilt, c.orientationError ?? 0);
      }
    }
    for (const id of [...this.anchors.keys()]) if (!s.contacts.some((c) => c.interval.id === id && c.state === 'active')) this.anchors.delete(id);
    // Penetration.
    for (let i = 0; i < this.model.rig.sites.length; i++) {
      const role = this.model.rig.sites[i]!.role;
      if (role === 'marker') continue;
      m.maxPenetration = Math.max(m.maxPenetration, penetrationDepth(s.sitePos[i]!, this.boxes).depth);
    }
    // Rigidity.
    for (const l of this.links) {
      const d = distance(s.worldPos[l.a]!, s.worldPos[l.b]!);
      if (l.length > 0) m.maxBoneLengthRelError = Math.max(m.maxBoneLengthRelError, Math.abs(d - l.length) / l.length);
    }
    for (const l of this.siteLinks) {
      const d = distance(s.worldPos[l.joint]!, s.sitePos[l.site]!);
      if (l.length > 0) m.maxBoneLengthRelError = Math.max(m.maxBoneLengthRelError, Math.abs(d - l.length) / l.length);
    }
    // Joint limits from re-decomposed local rotations.
    let violated = false;
    for (let j = 0; j < this.model.jointCount; j++) {
      const spec = this.model.joints[j]!;
      if (spec.kind === 'root') continue;
      const { angles } = decomposeJointRotation(spec, s.local[j]!);
      spec.dofs.forEach((d, i) => {
        const a = angles[i]!;
        if (a < d.min - 1e-7 || a > d.max + 1e-7) violated = true;
      });
    }
    if (violated) m.jointLimitViolations++;
    if (s.limitEvents.some((e) => !e.dof.endsWith('~swing'))) m.clampedSamples++;
    // Solver bookkeeping.
    const off = Math.hypot(...s.stabilization.offset);
    m.maxStabilizationOffset = Math.max(m.maxStabilizationOffset, off);
    if (off > 1e-9) m.stabilizedSamples++;
    if (!s.stabilization.converged) m.nonConvergedSamples++;
    if (s.diagnostics.some((d) => d.code === 'TARGET_UNREACHABLE')) m.unreachableSamples++;
    if (s.legs.some((l) => l.kneeFlexion > 0.09 && l.kneeForwardDot < 0)) m.kneeFlipSamples++;
    for (const d of s.diagnostics) if (d.severity !== 'info') m.diagnosticsByCode[d.code] = (m.diagnosticsByCode[d.code] ?? 0) + 1;
    // Discontinuities (second differences over three consecutive samples).
    this.prev.push(s);
    if (this.prev.length > 3) this.prev.shift();
    if (this.prev.length === 3) {
      const [a, b, c] = this.prev as [PoseSample, PoseSample, PoseSample];
      for (let j = 0; j < a.angles.length; j++)
        for (let k = 0; k < a.angles[j]!.length; k++) {
          const jump = Math.abs(c.angles[j]![k]! - 2 * b.angles[j]![k]! + a.angles[j]![k]!) / this.h;
          m.maxJointVelocityJump = Math.max(m.maxJointVelocityJump, jump);
        }
      const lin = (pa: Vec3, pb: Vec3, pc: Vec3) => Math.hypot(pc[0] - 2 * pb[0] + pa[0], pc[1] - 2 * pb[1] + pa[1], pc[2] - 2 * pb[2] + pa[2]) / this.h;
      m.maxLinearVelocityJump = Math.max(m.maxLinearVelocityJump, lin(a.pelvisWorld, b.pelvisWorld, c.pelvisWorld));
      for (let i = 0; i < a.sitePos.length; i++) m.maxLinearVelocityJump = Math.max(m.maxLinearVelocityJump, lin(a.sitePos[i]!, b.sitePos[i]!, c.sitePos[i]!));
    }
  }

  finish(): ClipMetrics {
    const m = this.m;
    const f: string[] = [];
    const chk = (ok: boolean, msg: string) => {
      if (!ok) f.push(msg);
    };
    const mm = (x: number) => `${(x * 1000).toFixed(3)} mm`;
    chk(m.maxContactPositionError <= TOLERANCES.contactPosition, `contact position error ${mm(m.maxContactPositionError)} > ${mm(TOLERANCES.contactPosition)}`);
    chk(m.maxPlantedDisplacement <= TOLERANCES.plantedDisplacement, `planted displacement ${mm(m.maxPlantedDisplacement)} > ${mm(TOLERANCES.plantedDisplacement)}`);
    chk(m.maxContactOrientationError <= TOLERANCES.contactOrientation, `contact orientation error ${((m.maxContactOrientationError * 180) / Math.PI).toFixed(3)}° > 1°`);
    chk(m.maxPenetration <= TOLERANCES.penetration, `penetration ${mm(m.maxPenetration)} > ${mm(TOLERANCES.penetration)}`);
    chk(m.maxBoneLengthRelError <= TOLERANCES.boneLengthRel, `bone length error ${m.maxBoneLengthRelError.toExponential(2)} > ${TOLERANCES.boneLengthRel}`);
    chk(m.jointLimitViolations === 0, `${m.jointLimitViolations} samples outside joint limits`);
    if (m.sampleRate >= 200) {
      chk(m.maxJointVelocityJump <= TOLERANCES.jointVelocityJump, `joint velocity jump ${m.maxJointVelocityJump.toFixed(3)} rad/s > ${TOLERANCES.jointVelocityJump}`);
      chk(m.maxLinearVelocityJump <= TOLERANCES.linearVelocityJump, `linear velocity jump ${m.maxLinearVelocityJump.toFixed(3)} m/s > ${TOLERANCES.linearVelocityJump}`);
    }
    chk(m.nonConvergedSamples === 0, `${m.nonConvergedSamples} non-converged samples`);
    chk(m.unreachableSamples === 0, `${m.unreachableSamples} samples with unreachable targets`);
    chk(m.kneeFlipSamples === 0, `${m.kneeFlipSamples} samples with knee flips`);
    m.failures = f;
    m.withinTolerance = f.length === 0;
    return m;
  }
}

export function analyzeClip(clip: BakedClip): ClipMetrics {
  const a = new ClipAnalyzer(clip.plan, clip.rig, clip.tier, clip.fps);
  for (const f of clip.frames) a.push(f);
  return a.finish();
}

/** Streams samples without storing frames (bounded memory). Default 240 Hz = continuity-check rate. */
export function analyzePlan(plan: MotionPlan, rig: RigDefinition, tier: SolverTier = 'stabilized', rate: number = TOLERANCES.continuityRate): ClipMetrics {
  const a = new ClipAnalyzer(plan, rig, tier, rate);
  for (const t of bakeTimes(plan.duration, rate)) a.push(samplePose(plan, rig, t, tier));
  return a.finish();
}
