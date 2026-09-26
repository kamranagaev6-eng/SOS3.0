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
      rawJointVelocityJump: 0,
      rawLinearVelocityJump: 0,
      refinedCandidates: 0,
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
      const { joint, linear } = secondDifferenceJumps(a, b, c, this.h);
      m.rawJointVelocityJump = Math.max(m.rawJointVelocityJump, joint);
      m.rawLinearVelocityJump = Math.max(m.rawLinearVelocityJump, linear);
      if (joint > TOLERANCES.jointVelocityJump * CANDIDATE_FRACTION || linear > TOLERANCES.linearVelocityJump * CANDIDATE_FRACTION) this.candidates.push(b.t);
      else {
        this.smoothJoint = Math.max(this.smoothJoint, joint);
        this.smoothLinear = Math.max(this.smoothLinear, linear);
      }
    }
  }

  private readonly candidates: number[] = [];
  private smoothJoint = 0;
  private smoothLinear = 0;

  /**
   * Discontinuity refinement. A velocity break ΔV between two raw samples splits across (at most)
   * two raw stencils, so each shows ≥ ΔV/2; smooth acceleration shows |θ''|·h. Therefore:
   *  - every raw value above CANDIDATE_FRACTION × tolerance is re-sampled over [t − h, t + h] at
   *    q = h/8, and the velocity change across adjacent stencils, |(θ₃ − θ₂) − (θ₁ − θ₀)|/q, is
   *    measured — this captures a split break in full, while acceleration contributes only 2q|θ''|;
   *  - values that were not refined are counted twice (the most a split break could hide).
   * Hence a break ≥ tolerance can never be reported as passing, and smooth acceleration of
   * ~150 rad/s² reads as ≈ 0.16 rad/s instead of ≈ 0.6 rad/s. Without a sampler, raw values stand.
   */
  refine(sampleAt: (t: number) => PoseSample): void {
    const m = this.m;
    let joint = 2 * this.smoothJoint;
    let linear = 2 * this.smoothLinear;
    // Merge overlapping candidate windows [t − h, t + h] (candidates arrive in time order).
    const windows: [number, number][] = [];
    for (const t of this.candidates) {
      const a = Math.max(0, t - this.h);
      const b = Math.min(this.plan.duration, t + this.h);
      const last = windows.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else windows.push([a, b]);
    }
    for (const [a, b] of windows) {
      m.refinedCandidates++;
      const n = Math.max(3, Math.round(((b - a) / this.h) * REFINE_SUBDIVISION));
      const q = (b - a) / n;
      const ss: PoseSample[] = [];
      for (let k = 0; k <= n; k++) ss.push(sampleAt(a + (b - a) * (k / n)));
      for (let k = 0; k + 3 < ss.length; k++) {
        const r = velocityChangeAcross(ss[k]!, ss[k + 1]!, ss[k + 2]!, ss[k + 3]!, q);
        joint = Math.max(joint, r.joint);
        linear = Math.max(linear, r.linear);
      }
    }
    m.maxJointVelocityJump = joint;
    m.maxLinearVelocityJump = linear;
    this.refined = true;
  }

  private refined = false;

  finish(): ClipMetrics {
    const m = this.m;
    if (!this.refined) {
      m.maxJointVelocityJump = m.rawJointVelocityJump;
      m.maxLinearVelocityJump = m.rawLinearVelocityJump;
    }
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

/** Raw values above this fraction of the tolerance are refined (see ClipAnalyzer.refine). */
const CANDIDATE_FRACTION = 0.25;
/** Refinement step is h / REFINE_SUBDIVISION. */
const REFINE_SUBDIVISION = 8;

/** Velocity change across two adjacent stencils: |(d − c) − (b − a)| / q per DOF and per point. */
function velocityChangeAcross(a: PoseSample, b: PoseSample, c: PoseSample, d: PoseSample, q: number): { joint: number; linear: number } {
  let joint = 0;
  for (let j = 0; j < a.angles.length; j++)
    for (let k = 0; k < a.angles[j]!.length; k++)
      joint = Math.max(joint, Math.abs(d.angles[j]![k]! - c.angles[j]![k]! - b.angles[j]![k]! + a.angles[j]![k]!) / q);
  const lin = (pa: Vec3, pb: Vec3, pc: Vec3, pd: Vec3) =>
    Math.hypot(pd[0] - pc[0] - pb[0] + pa[0], pd[1] - pc[1] - pb[1] + pa[1], pd[2] - pc[2] - pb[2] + pa[2]) / q;
  let linear = lin(a.pelvisWorld, b.pelvisWorld, c.pelvisWorld, d.pelvisWorld);
  for (let i = 0; i < a.sitePos.length; i++) linear = Math.max(linear, lin(a.sitePos[i]!, b.sitePos[i]!, c.sitePos[i]!, d.sitePos[i]!));
  return { joint, linear };
}

function secondDifferenceJumps(a: PoseSample, b: PoseSample, c: PoseSample, h: number): { joint: number; linear: number } {
  let joint = 0;
  for (let j = 0; j < a.angles.length; j++)
    for (let k = 0; k < a.angles[j]!.length; k++) joint = Math.max(joint, Math.abs(c.angles[j]![k]! - 2 * b.angles[j]![k]! + a.angles[j]![k]!) / h);
  const lin = (pa: Vec3, pb: Vec3, pc: Vec3) => Math.hypot(pc[0] - 2 * pb[0] + pa[0], pc[1] - 2 * pb[1] + pa[1], pc[2] - 2 * pb[2] + pa[2]) / h;
  let linear = lin(a.pelvisWorld, b.pelvisWorld, c.pelvisWorld);
  for (let i = 0; i < a.sitePos.length; i++) linear = Math.max(linear, lin(a.sitePos[i]!, b.sitePos[i]!, c.sitePos[i]!));
  return { joint, linear };
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
  a.refine((t) => samplePose(plan, rig, t, tier));
  return a.finish();
}
