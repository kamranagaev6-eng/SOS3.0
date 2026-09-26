import type { MotionPlan } from '../contracts/plan.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import type { PoseSample, SolverTier } from './types.ts';

/** Pure function of (plan, rig, t, tier). IMPLEMENTATION IN PROGRESS. */
export function samplePose(_plan: MotionPlan, _rig: RigDefinition, _t: number, _tier: SolverTier = 'stabilized'): PoseSample {
  throw new Error('samplePose: not implemented yet');
}
