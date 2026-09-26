import type { HumanoidProportions, RigDefinition } from '../contracts/rig.ts';
import type { Rng } from '../math/rng.ts';
import type { Vec3 } from '../math/vec3.ts';
import { composeJointRotation, forwardKinematics, getRigModel } from '../rig/model.ts';
import type { PoseSample } from '../solver/types.ts';

/** The PoseSample fields produced by plain FK (no solver). */
export type FkPose = Pick<PoseSample, 'local' | 'worldPos' | 'worldRot' | 'sitePos' | 'rootTranslation' | 'pelvisOffset'>;

/**
 * Builds a PoseSample-compatible pose directly from DOF angles (rad, in each joint's DOF order)
 * via composeJointRotation + forwardKinematics. Joints not listed stay at rest. Intended for
 * tests and fixtures that must not depend on the solver. Throws on unknown joint names (typos).
 */
export function poseFromAngles(
  rig: RigDefinition,
  rootTranslation: Vec3,
  pelvisOffset: Vec3,
  anglesByJointName: Readonly<Record<string, readonly number[]>> = {},
): FkPose {
  const model = getRigModel(rig);
  for (const name of Object.keys(anglesByJointName))
    if (!model.index.has(name)) throw new Error(`poseFromAngles: rig '${rig.id}' has no joint '${name}'`);
  const local = model.joints.map((j) => composeJointRotation(j, anglesByJointName[j.name] ?? []));
  const fk = forwardKinematics(model, rootTranslation, pelvisOffset, local);
  return { local, worldPos: fk.worldPos, worldRot: fk.worldRot, sitePos: fk.sitePos, rootTranslation: [...rootTranslation], pelvisOffset: [...pelvisOffset] };
}

/**
 * Uniformly random DOF angles within each joint's limits, shrunk toward the middle of the range
 * by `fraction` (1 = full range). Deterministic for a seeded Rng.
 */
export function randomJointAngles(rig: RigDefinition, rng: Rng, fraction = 1): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const j of rig.joints) {
    out[j.name] = j.dofs.map((d) => {
      const mid = (d.min + d.max) / 2;
      const half = ((d.max - d.min) / 2) * fraction;
      return rng.range(mid - half, mid + half);
    });
  }
  return out;
}

/** Pelvis-origin height above the floor when standing in the canonical rest pose. */
export function standingPelvisHeight(p: HumanoidProportions, side: 'left' | 'right' = 'left'): number {
  const L = p[side].leg;
  return L.thigh + L.shank + L.ankleHeight + p.pelvis.hipDrop;
}

/** Canonical rest pose (identity rotations) standing on the floor with the root at `ground`. */
export function restPose(rig: RigDefinition, ground: Vec3 = [0, 0, 0]): FkPose {
  return poseFromAngles(rig, ground, [0, standingPelvisHeight(rig.proportions), 0]);
}
