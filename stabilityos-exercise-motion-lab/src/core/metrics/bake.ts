import type { MotionPlan } from '../contracts/plan.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import type { SolverTier } from '../solver/types.ts';
import type { BakedClip } from './types.ts';

/** IMPLEMENTATION IN PROGRESS. */
export function bakeClip(_plan: MotionPlan, _rig: RigDefinition, _fps: number, _tier: SolverTier = 'stabilized'): BakedClip {
  throw new Error('bakeClip: not implemented yet');
}
