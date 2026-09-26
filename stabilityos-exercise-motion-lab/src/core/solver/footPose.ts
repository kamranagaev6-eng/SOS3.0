import type { Side } from '../contracts/common.ts';
import type { Environment } from '../contracts/environment.ts';
import type { FootAnchor, FootState, MotionPlan } from '../contracts/plan.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { findSurface } from '../environment/surfaces.ts';
import { clamp, lerp, smootherstep, windowedSmootherstep } from '../math/curves.ts';
import { quatFromAxisAngle, quatMultiply, quatRotateVec3, quatSlerp, type Quat } from '../math/quat.ts';
import { add, type Vec3 } from '../math/vec3.ts';
import { evalTrack } from '../plan/tracks.ts';
import type { FootTarget } from './types.ts';

export interface FootGeom {
  ankleHeight: number;
  heelBack: number;
  footLength: number;
  mtpHeight: number;
  toeLength: number;
}

export function footGeom(rig: RigDefinition, side: Side): FootGeom {
  const L = rig.proportions[side].leg;
  return { ankleHeight: L.ankleHeight, heelBack: L.heelBack, footLength: L.footLength, mtpHeight: L.mtpHeight, toeLength: L.toeLength };
}

export function yawQuat(yaw: number): Quat {
  return quatFromAxisAngle([0, 1, 0], yaw);
}

/** Rotation about the foot's local +X axis (positive = toes down / heel up). */
function pitchQuat(a: number): Quat {
  return quatFromAxisAngle([1, 0, 0], a);
}

/** MTP joint centre relative to the ankle joint, in the foot frame (rest geometry). */
export function mtpOffset(g: FootGeom): Vec3 {
  return [0, -(g.ankleHeight - g.mtpHeight), g.footLength];
}

/**
 * Foot rotation about the MTP axis that lifts the heel contact point to height `h` above the
 * surface while ball and toes stay flat. Heel relative to the MTP centre is (0, -m, -D):
 *   h(φ) = D sin φ + m (1 - cos φ)  ⇒  φ = δ + asin((h - m)/R),  R = √(D² + m²), δ = atan2(m, D).
 */
export function mtpAngleForHeelLift(g: FootGeom, h: number): number {
  const D = g.heelBack + g.footLength;
  const m = g.mtpHeight;
  const R = Math.hypot(D, m);
  const delta = Math.atan2(m, D);
  return delta + Math.asin(clamp((h - m) / R, -1, 1));
}

export function heelLiftForMtpAngle(g: FootGeom, phi: number): number {
  const D = g.heelBack + g.footLength;
  const m = g.mtpHeight;
  return D * Math.sin(phi) + m * (1 - Math.cos(phi));
}

export function flatPose(side: Side, anchor: FootAnchor, surfaceY: number, surface: string, g: FootGeom): FootTarget {
  const q = yawQuat(anchor.yaw);
  return {
    side,
    mode: 'flat',
    anklePos: [anchor.x, surfaceY + g.ankleHeight, anchor.z],
    footRot: q,
    toesRot: q,
    mtpExtension: 0,
    surface,
  };
}

export function forefootPose(
  side: Side,
  anchor: FootAnchor,
  surfaceY: number,
  surface: string,
  g: FootGeom,
  heelLift: number,
): FootTarget {
  const yaw = yawQuat(anchor.yaw);
  const flatAnkle: Vec3 = [anchor.x, surfaceY + g.ankleHeight, anchor.z];
  const mtpWorld = add(flatAnkle, quatRotateVec3(yaw, mtpOffset(g)));
  const phi = mtpAngleForHeelLift(g, Math.max(0, heelLift));
  const footRot = quatMultiply(yaw, pitchQuat(phi));
  const anklePos = add(mtpWorld, quatRotateVec3(footRot, [0, g.ankleHeight - g.mtpHeight, -g.footLength]));
  return { side, mode: 'forefoot', anklePos, footRot, toesRot: yaw, mtpExtension: phi, surface };
}

export function footStateIndexAt(states: readonly FootState[], t: number): number {
  for (let i = 0; i < states.length; i++) {
    const s = states[i]!;
    if (t < s.end) return i;
  }
  return states.length - 1;
}

function surfaceY(env: Environment, id: string): number {
  const s = findSurface(env, id);
  if (!s) throw new Error(`unknown surface '${id}'`);
  return s.y;
}

export function contactPose(env: Environment, side: Side, state: FootState, t: number, g: FootGeom): FootTarget {
  if (state.kind === 'flat') return flatPose(side, state.anchor, surfaceY(env, state.surface), state.surface, g);
  if (state.kind === 'forefoot')
    return forefootPose(side, state.anchor, surfaceY(env, state.surface), state.surface, g, evalTrack(state.heelLift, t));
  throw new Error('contactPose called on a swing state');
}

/**
 * Target foot transform for one side at time t. Swing states interpolate between the end pose
 * of the previous contact state and the start pose of the next one:
 *   horizontal: smootherstep over [horizontalDelay, 1 - horizontalLead]
 *   vertical:   rise to max(y0, y1) + clearance over [0, riseEnd], hold, descend over [descendStart, 1]
 *   rotation:   slerp with smootherstep over [0, 0.8]; MTP angle interpolated alongside.
 * All pieces are C2 at their window ends, so the swing leaves and lands with zero velocity.
 */
export function footTargetAt(plan: MotionPlan, rig: RigDefinition, side: Side, t: number): FootTarget {
  const states = plan.feet[side];
  const g = footGeom(rig, side);
  const i = footStateIndexAt(states, t);
  const s = states[i]!;
  if (s.kind !== 'swing') return contactPose(plan.environment, side, s, t, g);
  const prev = states[i - 1];
  const next = states[i + 1];
  if (!prev || !next || prev.kind === 'swing' || next.kind === 'swing') throw new Error('swing state must sit between contact states');
  const a = contactPose(plan.environment, side, prev, prev.end, g);
  const b = contactPose(plan.environment, side, next, next.start, g);
  const tau = clamp((t - s.start) / (s.end - s.start), 0, 1);
  const sh = windowedSmootherstep(tau, s.horizontalDelay, 1 - s.horizontalLead);
  const y0 = a.anklePos[1];
  const y1 = b.anklePos[1];
  const peak = Math.max(y0, y1) + s.clearance;
  let y: number;
  if (tau <= s.riseEnd) y = lerp(y0, peak, smootherstep(tau / s.riseEnd));
  else if (tau < s.descendStart) y = peak;
  else y = lerp(peak, y1, smootherstep((tau - s.descendStart) / (1 - s.descendStart)));
  const sr = windowedSmootherstep(tau, 0, 0.8);
  const footRot = quatSlerp(a.footRot, b.footRot, sr);
  const mtp = lerp(a.mtpExtension, b.mtpExtension, sr);
  return {
    side,
    mode: 'swing',
    anklePos: [lerp(a.anklePos[0], b.anklePos[0], sh), y, lerp(a.anklePos[2], b.anklePos[2], sh)],
    footRot,
    toesRot: quatMultiply(footRot, pitchQuat(-mtp)),
    mtpExtension: mtp,
    surface: null,
  };
}

/** World position of a foot site under a target foot transform (for contact targets). */
export function siteUnderTarget(target: FootTarget, g: FootGeom, segment: 'foot' | 'toes', offset: Vec3): Vec3 {
  if (segment === 'foot') return add(target.anklePos, quatRotateVec3(target.footRot, offset));
  const mtp = add(target.anklePos, quatRotateVec3(target.footRot, mtpOffset(g)));
  return add(mtp, quatRotateVec3(target.toesRot, offset));
}
