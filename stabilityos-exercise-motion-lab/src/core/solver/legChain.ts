import type { Side } from '../contracts/common.ts';
import type { JointSpec } from '../contracts/rig.ts';
import { quatConjugate, quatMultiply, quatRotateVec3, type Quat } from '../math/quat.ts';
import { add, type Vec3 } from '../math/vec3.ts';
import { legJoints } from '../rig/canonical.ts';
import { decomposeJointRotation, type RigModel } from '../rig/model.ts';
import { solveLegIk, type LegIkResult } from './legIk.ts';
import type { FootTarget } from './types.ts';

export interface LegJointsIdx {
  hip: number;
  knee: number;
  ankle: number;
  mtp: number;
}

export function legIndices(model: RigModel, side: Side): LegJointsIdx {
  const n = legJoints(side);
  const get = (k: string): number => {
    const i = model.index.get(k);
    if (i === undefined) throw new Error(`rig ${model.rig.id} lacks joint ${k}`);
    return i;
  };
  return { hip: get(n.hip), knee: get(n.knee), ankle: get(n.ankle), mtp: get(n.mtp) };
}

export interface LegChainSolution {
  ik: LegIkResult;
  hipWorld: Vec3;
  /** Unclamped local rotations requested by the IK. */
  local: { hip: Quat; knee: Quat; ankle: Quat; mtp: Quat };
  /** Unclamped DOF angles and off-axis residuals. */
  angles: { hip: number[]; knee: number[]; ankle: number[]; mtp: number[] };
  residual: { hip: number[]; knee: number[]; ankle: number[]; mtp: number[] };
}

/** Solve one leg for a pelvis world pose and a foot target (no clamping here). */
export function solveLegChain(
  model: RigModel,
  idx: LegJointsIdx,
  pelvisPos: Vec3,
  pelvisRot: Quat,
  target: FootTarget,
): LegChainSolution {
  const hipOffset = model.offset[idx.hip]!;
  const hipWorld = add(pelvisPos, quatRotateVec3(pelvisRot, hipOffset));
  const thigh = -model.offset[idx.knee]![1];
  const shank = -model.offset[idx.ankle]![1];
  const pelvisForward = quatRotateVec3(pelvisRot, [0, 0, 1]);
  const ik = solveLegIk(hipWorld, target.anklePos, target.footRot, pelvisForward, thigh, shank);
  const hip = quatMultiply(quatConjugate(pelvisRot), ik.thighRot);
  const knee = quatMultiply(quatConjugate(ik.thighRot), ik.shankRot);
  const ankle = quatMultiply(quatConjugate(ik.shankRot), target.footRot);
  const mtp = quatMultiply(quatConjugate(target.footRot), target.toesRot);
  const j = model.joints as JointSpec[];
  const dh = decomposeJointRotation(j[idx.hip]!, hip);
  const dk = decomposeJointRotation(j[idx.knee]!, knee);
  const da = decomposeJointRotation(j[idx.ankle]!, ankle);
  const dm = decomposeJointRotation(j[idx.mtp]!, mtp);
  return {
    ik,
    hipWorld,
    local: { hip, knee, ankle, mtp },
    angles: { hip: dh.angles, knee: dk.angles, ankle: da.angles, mtp: dm.angles },
    residual: { hip: dh.residual, knee: dk.residual, ankle: da.residual, mtp: dm.residual },
  };
}

/** Radians → metres-equivalent lever used to mix angular and positional violations (documented). */
export const ANGULAR_LEVER = 0.1;

/** Sum of limit exceedances (rad) for a joint's DOF angles. */
export function limitExcess(joint: JointSpec, angles: readonly number[]): number {
  let e = 0;
  for (let i = 0; i < joint.dofs.length; i++) {
    const d = joint.dofs[i]!;
    const a = angles[i] ?? 0;
    if (a > d.max) e += a - d.max;
    else if (a < d.min) e += d.min - a;
  }
  return e;
}
