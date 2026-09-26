import { SIDES, type Side } from '../contracts/common.ts';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import type { SolidBox } from '../contracts/environment.ts';
import type { ContactInterval, MotionPlan, Track } from '../contracts/plan.ts';
import type { JointSpec, RigDefinition } from '../contracts/rig.ts';
import { solids } from '../environment/surfaces.ts';
import { clamp, lerp, RAD2DEG, smootherstep } from '../math/curves.ts';
import { IDENTITY_Q, quatAngleBetween, quatRotateVec3, type Quat } from '../math/quat.ts';
import { add, distance, sub, type Vec3 } from '../math/vec3.ts';
import { deriveContactSchedule, intervalWeight, phaseIndexAt, seatWeight } from '../plan/contactSchedule.ts';
import { evalTrack } from '../plan/tracks.ts';
import { SEAT_SITE } from '../rig/canonical.ts';
import { composeJointRotation, forwardKinematics, getRigModel, type RigModel } from '../rig/model.ts';
import { TOLERANCES } from '../tolerances.ts';
import { footGeom, footTargetAt, siteUnderTarget, type FootGeom } from './footPose.ts';
import { legIndices, solveLegChain, type LegJointsIdx } from './legChain.ts';
import { kneeForwardDot } from './legIk.ts';
import { stabilizePelvis } from './stabilize.ts';
import type { ContactEvaluation, FootTarget, LegReport, LimitEvent, PoseSample, SolverTier, StabilizationReport } from './types.ts';

interface ContactMeta {
  interval: ContactInterval;
  siteIdx: number;
  segment: 'foot' | 'toes' | 'pelvis';
  offset: Vec3;
  side: Side | null;
}

interface PlanCache {
  model: RigModel;
  legs: Record<Side, LegJointsIdx>;
  geom: Record<Side, FootGeom>;
  rootIdx: number;
  pelvisIdx: number;
  tracked: { idx: number; joint: JointSpec; tracks: (Track | null)[] }[];
  contacts: ContactMeta[];
  seatSite: number | null;
  penetrationSites: number[];
  boxes: SolidBox[];
  frozen?: { root: Vec3; pelvisOffset: Vec3; rootLocal: Quat; pelvisLocal: Quat; pelvisAngles: number[] };
}

const caches = new WeakMap<MotionPlan, WeakMap<RigDefinition, PlanCache>>();

/** Plans and rigs are treated as immutable values: mutate a copy, never a plan being sampled. */
function planCache(plan: MotionPlan, rig: RigDefinition): PlanCache {
  let byRig = caches.get(plan);
  if (!byRig) {
    byRig = new WeakMap();
    caches.set(plan, byRig);
  }
  const hit = byRig.get(rig);
  if (hit) return hit;
  const model = getRigModel(rig);
  const legs = { left: legIndices(model, 'left'), right: legIndices(model, 'right') };
  const tracked: PlanCache['tracked'] = [];
  for (const [name, dofTracks] of Object.entries(plan.joints)) {
    const idx = model.index.get(name);
    if (idx === undefined) throw new Error(`plan animates joint '${name}' that rig '${rig.id}' does not have`);
    const joint = model.joints[idx]!;
    for (const key of Object.keys(dofTracks))
      if (!joint.dofs.some((d) => d.name === key)) throw new Error(`plan animates unknown DOF '${name}.${key}'`);
    tracked.push({ idx, joint, tracks: joint.dofs.map((d) => dofTracks[d.name] ?? null) });
  }
  const contacts: ContactMeta[] = deriveContactSchedule(plan).map((interval) => {
    if (interval.kind === 'orientation') {
      const side = interval.side as Side;
      return { interval, siteIdx: -1, segment: interval.segment ?? 'foot', offset: [0, 0, 0] as Vec3, side };
    }
    const siteIdx = model.siteIndex.get(interval.site);
    if (siteIdx === undefined) throw new Error(`contact site '${interval.site}' missing on rig '${rig.id}'`);
    const jointName = rig.sites[siteIdx]!.joint;
    const segment = jointName.startsWith('mtp') ? 'toes' : jointName.startsWith('ankle') ? 'foot' : 'pelvis';
    return {
      interval,
      siteIdx,
      segment,
      offset: [...rig.sites[siteIdx]!.offset] as Vec3,
      side: interval.side === 'center' ? null : (interval.side as Side),
    };
  });
  const cache: PlanCache = {
    model,
    legs,
    geom: { left: footGeom(rig, 'left'), right: footGeom(rig, 'right') },
    rootIdx: model.index.get('root')!,
    pelvisIdx: model.index.get('pelvis')!,
    tracked,
    contacts,
    seatSite: model.siteIndex.get(SEAT_SITE) ?? null,
    penetrationSites: rig.sites.flatMap((s, i) => (s.role === 'contact' || s.role === 'penetration' ? [i] : [])),
    boxes: solids(plan.environment),
  };
  byRig.set(rig, cache);
  return cache;
}

interface Clamped {
  q: Quat;
  angles: number[];
}

function clampJoint(joint: JointSpec, requested: readonly number[], events: LimitEvent[], residual: readonly number[] = []): Clamped {
  const angles = joint.dofs.map((d, i) => {
    const r = requested[i] ?? 0;
    const a = clamp(r, d.min, d.max);
    if (Math.abs(a - r) > 1e-9) events.push({ joint: joint.name, dof: d.name, requested: r, applied: a });
    return a;
  });
  residual.forEach((r, i) => {
    if (Math.abs(r) > 1e-6) events.push({ joint: joint.name, dof: `offAxis${i}`, requested: r, applied: 0 });
  });
  return { q: composeJointRotation(joint, angles), angles };
}

const DISABLED_STAB: StabilizationReport = {
  enabled: false,
  offset: [0, 0, 0],
  iterations: 0,
  converged: true,
  boundReached: false,
  initialViolation: 0,
  finalViolation: 0,
};

/**
 * Sample the plan at time t. Pure: depends only on (plan, rig, t, tier). Time is clamped to
 * [0, duration]; non-finite t is rejected.
 */
export function samplePose(plan: MotionPlan, rig: RigDefinition, t: number, tier: SolverTier = 'stabilized'): PoseSample {
  if (!Number.isFinite(t)) throw new RangeError(`sample time must be finite (got ${t})`);
  const tc = clamp(t, 0, plan.duration);
  if (tier === 'baseline') return sampleBaseline(plan, rig, tc);
  return sampleSolved(plan, rig, tc, tier);
}

function sampleSolved(plan: MotionPlan, rig: RigDefinition, t: number, tier: 'analytic' | 'stabilized'): PoseSample {
  const c = planCache(plan, rig);
  const { model } = c;
  const events: LimitEvent[] = [];
  const local: Quat[] = new Array(model.jointCount).fill(IDENTITY_Q);
  const angles: number[][] = model.joints.map((j) => j.dofs.map(() => 0));

  // 1. Authored pelvis orientation (clamped to declared plausibility bounds).
  const pj = model.joints[c.pelvisIdx]!;
  const pel = clampJoint(
    pj,
    pj.dofs.map((d) => evalTrack(plan.pelvis[d.name as 'rotation' | 'tilt' | 'obliquity'], t)),
    events,
  );
  local[c.pelvisIdx] = pel.q;
  angles[c.pelvisIdx] = pel.angles;
  const pelvisRot = pel.q; // root heading is 0 for all v1 recipes (root local = identity)

  // 2. Authored pelvis position, blended toward the seat-contact placement while seated.
  const authored: Vec3 = [evalTrack(plan.pelvis.x, t), evalTrack(plan.pelvis.y, t), evalTrack(plan.pelvis.z, t)];
  const ws = seatWeight(plan, t);
  let base = authored;
  if (ws > 0 && plan.seat && c.seatSite !== null) {
    const seatOffset = model.siteOffset[c.seatSite]!;
    const seatPlaced = sub(plan.seat.target, quatRotateVec3(pelvisRot, seatOffset));
    base = [lerp(authored[0], seatPlaced[0], ws), lerp(authored[1], seatPlaced[1], ws), lerp(authored[2], seatPlaced[2], ws)];
  }

  // 3. Foot targets from contact states / swing paths.
  const targets: Record<Side, FootTarget> = {
    left: footTargetAt(plan, rig, 'left', t),
    right: footTargetAt(plan, rig, 'right', t),
  };

  // 4. Optional bounded stabilisation (tier 2). Never modifies authored channels.
  let stab = DISABLED_STAB;
  if (tier === 'stabilized' && plan.stabilization.enabled) {
    stab = stabilizePelvis({ model, legs: c.legs, base, pelvisRot, targets, seatWeight: ws, spec: plan.stabilization, swingWeight: swingReachWeights(plan, t) });
  }
  const P = add(base, stab.offset);

  // 5. Legs: closed-form IK, then clamp every DOF to its limit.
  const legReports: LegReport[] = [];
  for (const side of SIDES) {
    const idx = c.legs[side];
    const sol = solveLegChain(model, idx, P, pelvisRot, targets[side]);
    const hip = clampJoint(model.joints[idx.hip]!, sol.angles.hip, events, sol.residual.hip);
    const knee = clampJoint(model.joints[idx.knee]!, [sol.ik.kneeFlexion], events);
    const ankleReq = targets[side].mode === 'swing' ? swingSoftLimit(plan, side, t, model.joints[idx.ankle]!, sol.angles.ankle, events) : sol.angles.ankle;
    const ankle = clampJoint(model.joints[idx.ankle]!, ankleReq, events, sol.residual.ankle);
    const mtp = clampJoint(model.joints[idx.mtp]!, sol.angles.mtp, events, sol.residual.mtp);
    local[idx.hip] = hip.q;
    local[idx.knee] = knee.q;
    local[idx.ankle] = ankle.q;
    local[idx.mtp] = mtp.q;
    angles[idx.hip] = hip.angles;
    angles[idx.knee] = knee.angles;
    angles[idx.ankle] = ankle.angles;
    angles[idx.mtp] = mtp.angles;
    legReports.push({
      side,
      hipToAnkle: sol.ik.distance,
      maxReach: sol.ik.maxReach,
      reachable: sol.ik.reachable,
      kneeFlexion: sol.ik.kneeFlexion,
      kneeForwardDot: 1,
    });
  }

  // 6. Spine, neck and arms from authored DOF tracks.
  for (const tj of c.tracked) {
    const req = tj.tracks.map((tr) => (tr ? evalTrack(tr, t) : 0));
    const r = clampJoint(tj.joint, req, events);
    local[tj.idx] = r.q;
    angles[tj.idx] = r.angles;
  }

  const rootTranslation: Vec3 = [P[0], 0, P[2]];
  const pelvisOffset: Vec3 = [0, P[1], 0];
  return finishSample(plan, c, t, tier, rootTranslation, pelvisOffset, local, angles, targets, stab, events, legReports);
}

/** Reach-constraint weight per leg: 1 in contact; inside a swing 1 at lift-off/landing, 0 in the middle 60 %. */
function swingReachWeights(plan: MotionPlan, t: number): Record<Side, number> {
  const w = { left: 1, right: 1 };
  for (const side of SIDES) {
    const st = plan.feet[side].find((s) => s.kind === 'swing' && t >= s.start && t <= s.end);
    if (!st) continue;
    const tau = (t - st.start) / (st.end - st.start);
    w[side] = 1 - smootherstep(tau / 0.2) * smootherstep((1 - tau) / 0.2);
  }
  return w;
}

/** Width of the soft-limit zone for swing-foot ankle angles (rad). */
export const SWING_SOFT_ZONE = (8 * Math.PI) / 180;

/** C1 saturation: identity until `zone` before a limit, then exponential approach to the limit. */
export function softLimit(x: number, lo: number, hi: number, zone: number): number {
  const a = hi - zone;
  if (x > a) return hi - zone * Math.exp(-(x - a) / zone);
  const b = lo + zone;
  if (x < b) return lo + zone * Math.exp((x - b) / zone);
  return x;
}

/**
 * Swing feet are not contacts, so their authored orientation is a preference: when it would push
 * the ankle past its range, the ankle angle is saturated smoothly (C1) instead of hard-clamped.
 * The effect is weighted by a window that is 0 at lift-off and landing, so contact poses are
 * untouched, and it is reported (JOINT_LIMIT_CLAMPED with dof suffix '~swing').
 */
function swingSoftLimit(plan: MotionPlan, side: Side, t: number, joint: JointSpec, req: readonly number[], events: LimitEvent[]): number[] {
  const states = plan.feet[side];
  const st = states.find((s) => s.kind === 'swing' && t >= s.start && t <= s.end);
  if (!st) return [...req];
  const tau = (t - st.start) / (st.end - st.start);
  const w = smootherstep(tau / 0.2) * smootherstep((1 - tau) / 0.2);
  return joint.dofs.map((d, i) => {
    const r = req[i] ?? 0;
    const soft = lerp(r, softLimit(r, d.min, d.max, SWING_SOFT_ZONE), w);
    if (Math.abs(soft - r) > 1e-4) events.push({ joint: joint.name, dof: `${d.name}~swing`, requested: r, applied: soft });
    return soft;
  });
}

function sampleBaseline(plan: MotionPlan, rig: RigDefinition, t: number): PoseSample {
  const c = planCache(plan, rig);
  if (!c.frozen) {
    const s0 = sampleSolved(plan, rig, 0, 'stabilized');
    c.frozen = {
      root: s0.rootTranslation,
      pelvisOffset: s0.pelvisOffset,
      rootLocal: s0.local[c.rootIdx]!,
      pelvisLocal: s0.local[c.pelvisIdx]!,
      pelvisAngles: s0.angles[c.pelvisIdx]!.slice(),
    };
  }
  const solved = sampleSolved(plan, rig, t, 'stabilized');
  const local = solved.local.slice();
  local[c.rootIdx] = c.frozen.rootLocal;
  local[c.pelvisIdx] = c.frozen.pelvisLocal;
  const angles = solved.angles.map((a) => a.slice());
  angles[c.pelvisIdx] = c.frozen.pelvisAngles.slice();
  return finishSample(
    plan,
    c,
    t,
    'baseline',
    c.frozen.root,
    c.frozen.pelvisOffset,
    local,
    angles,
    solved.footTargets,
    DISABLED_STAB,
    [],
    solved.legs.map((l) => ({ ...l })),
  );
}

function finishSample(
  plan: MotionPlan,
  c: PlanCache,
  t: number,
  tier: SolverTier,
  rootTranslation: Vec3,
  pelvisOffset: Vec3,
  local: Quat[],
  angles: number[][],
  targets: Record<Side, FootTarget>,
  stab: StabilizationReport,
  events: LimitEvent[],
  legReports: LegReport[],
): PoseSample {
  const { model } = c;
  const fk = forwardKinematics(model, rootTranslation, pelvisOffset, local);
  const diagnostics: Diagnostic[] = [];

  // Knee direction check from FK output (independent of the IK's own pole construction).
  for (const lr of legReports) {
    const idx = c.legs[lr.side];
    const footFwd = quatRotateVec3(fk.worldRot[idx.ankle]!, [0, 0, 1]);
    lr.kneeForwardDot = kneeForwardDot(fk.worldPos[idx.hip]!, fk.worldPos[idx.knee]!, fk.worldPos[idx.ankle]!, footFwd);
    if (tier !== 'baseline' && !lr.reachable)
      diagnostics.push(
        diag('TARGET_UNREACHABLE', 'error', `${lr.side} foot target is ${((lr.hipToAnkle - lr.maxReach) * 1000).toFixed(1)} mm beyond leg reach`, {
          time: t,
          subject: `leg_${lr.side}`,
          value: lr.hipToAnkle,
          limit: lr.maxReach,
          hint: 'Lower the pelvis trajectory, reduce step/chair height, or check rig proportions.',
        }),
      );
  }

  // Contacts.
  const contacts: ContactEvaluation[] = [];
  for (const m of c.contacts) {
    const iv = m.interval;
    const { w, phase } = intervalWeight(iv, t, plan.duration);
    if (w <= 0) continue;
    const state: ContactEvaluation['state'] = phase === 'full' ? 'active' : phase === 'rising' ? 'engaging' : 'releasing';
    if (iv.kind === 'orientation') {
      const side = m.side!;
      const jointIdx = m.segment === 'toes' ? c.legs[side].mtp : c.legs[side].ankle;
      const targetRot = m.segment === 'toes' ? targets[side].toesRot : targets[side].footRot;
      const err = quatAngleBetween(fk.worldRot[jointIdx]!, targetRot);
      const ok = state !== 'active' || err <= TOLERANCES.contactOrientation;
      contacts.push({ interval: iv, weight: w, state, target: null, actual: null, positionError: null, orientationError: err, withinTolerance: ok });
      if (!ok)
        diagnostics.push(
          diag('CONTACT_ORIENTATION_VIOLATION', 'error', `${iv.site} orientation off by ${(err * RAD2DEG).toFixed(2)}°`, {
            time: t,
            subject: iv.id,
            value: err,
            limit: TOLERANCES.contactOrientation,
          }),
        );
      continue;
    }
    let target: Vec3;
    if (m.segment === 'pelvis') {
      if (!plan.seat) continue;
      target = plan.seat.target;
    } else {
      target = siteUnderTarget(targets[m.side!], c.geom[m.side!], m.segment, m.offset);
    }
    const actual = fk.sitePos[m.siteIdx]!;
    const err = distance(actual, target);
    const ok = state !== 'active' || err <= TOLERANCES.contactPosition;
    contacts.push({ interval: iv, weight: w, state, target, actual, positionError: err, orientationError: null, withinTolerance: ok });
    if (!ok)
      diagnostics.push(
        diag('CONTACT_POSITION_VIOLATION', 'error', `${iv.site} is ${(err * 1000).toFixed(2)} mm from its contact target`, {
          time: t,
          subject: iv.id,
          value: err,
          limit: TOLERANCES.contactPosition,
        }),
      );
  }

  // Penetration of sole / seat sites into the floor or solids.
  for (const si of c.penetrationSites) {
    const p = fk.sitePos[si]!;
    let depth = p[1] < 0 ? -p[1] : 0;
    let solid = 'floor';
    for (const b of c.boxes) {
      if (p[0] > b.min[0] && p[0] < b.max[0] && p[1] > b.min[1] && p[1] < b.max[1] && p[2] > b.min[2] && p[2] < b.max[2]) {
        const d = Math.min(p[0] - b.min[0], b.max[0] - p[0], p[1] - b.min[1], b.max[1] - p[1], p[2] - b.min[2], b.max[2] - p[2]);
        if (d > depth) {
          depth = d;
          solid = b.id;
        }
      }
    }
    if (depth > TOLERANCES.penetration)
      diagnostics.push(
        diag('SURFACE_PENETRATION', 'error', `${model.siteNames[si]} is ${(depth * 1000).toFixed(1)} mm inside ${solid}`, {
          time: t,
          subject: model.siteNames[si]!,
          value: depth,
          limit: TOLERANCES.penetration,
        }),
      );
  }

  for (const e of events)
    diagnostics.push(
      diag(
        'JOINT_LIMIT_CLAMPED',
        e.dof.endsWith('~swing') ? 'info' : 'warning',
        e.dof.startsWith('offAxis')
          ? `${e.joint} requested ${(e.requested * RAD2DEG).toFixed(2)}° about an axis it cannot rotate about; removed`
          : e.dof.endsWith('~swing')
            ? `swing ${e.joint}.${e.dof.replace('~swing', '')} softened from ${(e.requested * RAD2DEG).toFixed(1)}° to ${(e.applied * RAD2DEG).toFixed(1)}° (swing foot orientation is a preference, not a contact)`
            : `${e.joint}.${e.dof} clamped from ${(e.requested * RAD2DEG).toFixed(1)}° to ${(e.applied * RAD2DEG).toFixed(1)}°`,
        { time: t, subject: `${e.joint}.${e.dof}`, value: e.requested, limit: e.applied },
      ),
    );

  if (stab.enabled) {
    const mag = Math.hypot(...stab.offset);
    if (mag > TOLERANCES.notableStabilization)
      diagnostics.push(
        diag('STABILIZATION_APPLIED', 'warning', `pelvis corrected by ${(mag * 1000).toFixed(1)} mm (notable: authored trajectory disagrees with rig geometry)`, {
          time: t,
          subject: 'pelvis',
          value: mag,
          limit: TOLERANCES.notableStabilization,
        }),
      );
    else if (mag > 5e-4)
      diagnostics.push(diag('STABILIZATION_APPLIED', 'info', `pelvis corrected by ${(mag * 1000).toFixed(2)} mm`, { time: t, subject: 'pelvis', value: mag }));
    if (stab.boundReached)
      diagnostics.push(diag('STABILIZATION_BOUND_REACHED', 'warning', 'pelvis correction reached its declared bound', { time: t, subject: 'pelvis' }));
    if (!stab.converged)
      diagnostics.push(
        diag('SOLVER_NOT_CONVERGED', 'error', `stabiliser left ${(stab.finalViolation * 1000).toFixed(2)} mm-equivalent constraint violation`, {
          time: t,
          subject: 'pelvis',
          value: stab.finalViolation,
          hint: 'The authored motion is infeasible for this rig within the declared stabilisation bounds.',
        }),
      );
  }

  const phaseIndex = phaseIndexAt(plan, t);
  return {
    t,
    tier,
    phaseIndex,
    phaseId: plan.phases[phaseIndex]!.id,
    rootTranslation,
    pelvisOffset,
    pelvisWorld: fk.worldPos[c.pelvisIdx]!,
    angles,
    local,
    worldPos: fk.worldPos,
    worldRot: fk.worldRot,
    sitePos: fk.sitePos,
    footTargets: targets,
    contacts,
    stabilization: stab,
    limitEvents: events,
    legs: legReports,
    diagnostics,
  };
}
