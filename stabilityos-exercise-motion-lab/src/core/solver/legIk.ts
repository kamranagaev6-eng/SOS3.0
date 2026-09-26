import { clamp } from '../math/curves.ts';
import { mat3FromColumns } from '../math/mat3.ts';
import { quatFromMat3, quatRotateVec3, type Quat } from '../math/quat.ts';
import { addScaled, cross, dot, length, normalize, rejectFrom, scale, sub, type Vec3 } from '../math/vec3.ts';

export interface LegIkResult {
  thighRot: Quat;
  shankRot: Quat;
  knee: Vec3;
  /** Knee flexion implied by the triangle (rad), before joint-limit clamping. */
  kneeFlexion: number;
  distance: number;
  maxReach: number;
  minReach: number;
  reachable: boolean;
  degenerate: boolean;
}

/** Hip–ankle distance for a given knee flexion κ: d² = L1² + L2² + 2 L1 L2 cos κ. */
export function reachForKneeFlexion(l1: number, l2: number, kappa: number): number {
  return Math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(kappa));
}

/**
 * Closed-form two-bone leg IK.
 *
 * The knee plane is spanned by the hip→ankle axis â and the foot's forward direction projected
 * perpendicular to â (the pole). The knee always lies on the pole side, so knee direction follows
 * the foot and cannot flip; flexion comes from the law of cosines and is always in [0, π].
 * Segment frames: y = -bone direction (rest bones point -Y), x = knee hinge axis
 * (= normalize(p⊥ × â), +X at rest), z = x × y. Unreachable targets are not stretched to: the leg
 * extends toward the target and `reachable=false` is reported.
 */
export function solveLegIk(hip: Vec3, ankleTarget: Vec3, footRot: Quat, fallbackForward: Vec3, l1: number, l2: number): LegIkResult {
  const a = sub(ankleTarget, hip);
  const d = length(a);
  const maxReach = l1 + l2;
  const minReach = Math.abs(l1 - l2);
  const axis = normalize(a, [0, -1, 0]);
  const reachable = d <= maxReach + 1e-12 && d >= minReach - 1e-12;
  const dc = clamp(d, minReach + 1e-9, maxReach);
  const cosInterior = clamp((l1 * l1 + l2 * l2 - dc * dc) / (2 * l1 * l2), -1, 1);
  const kneeFlexion = Math.PI - Math.acos(cosInterior);
  const cosHip = clamp((l1 * l1 + dc * dc - l2 * l2) / (2 * l1 * dc), -1, 1);
  const sinHip = Math.sqrt(Math.max(0, 1 - cosHip * cosHip));

  const footForward = quatRotateVec3(footRot, [0, 0, 1]);
  let poleRaw = rejectFrom(footForward, axis);
  let degenerate = false;
  if (length(poleRaw) < 1e-6) {
    degenerate = true;
    poleRaw = rejectFrom(fallbackForward, axis);
  }
  const pole = normalize(poleRaw, [0, 0, 1]);
  const hinge = normalize(cross(pole, axis), [1, 0, 0]);

  const knee = addScaled(addScaled(hip, axis, l1 * cosHip), pole, l1 * sinHip);
  const ankle = addScaled(hip, axis, dc);
  const u1 = scale(sub(knee, hip), 1 / l1);
  const u2 = normalize(sub(ankle, knee), axis);
  const thighY = scale(u1, -1);
  const shankY = scale(u2, -1);
  const thighX = normalize(rejectFrom(hinge, thighY), hinge);
  const shankX = normalize(rejectFrom(hinge, shankY), hinge);
  const thighRot = quatFromMat3(mat3FromColumns(thighX, thighY, cross(thighX, thighY)));
  const shankRot = quatFromMat3(mat3FromColumns(shankX, shankY, cross(shankX, shankY)));
  return { thighRot, shankRot, knee, kneeFlexion, distance: d, maxReach, minReach, reachable, degenerate };
}

/** cos of the angle between the knee's forward offset (from the hip–ankle line) and the foot forward direction. */
export function kneeForwardDot(hip: Vec3, knee: Vec3, ankle: Vec3, footForward: Vec3): number {
  const axis = normalize(sub(ankle, hip));
  const off = rejectFrom(sub(knee, hip), axis);
  const f = rejectFrom(footForward, axis);
  const lo = length(off);
  const lf = length(f);
  if (lo < 1e-9 || lf < 1e-9) return 1; // straight knee: direction undefined, not a flip
  return dot(off, f) / (lo * lf);
}
