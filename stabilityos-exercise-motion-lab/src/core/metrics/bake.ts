import type { MotionPlan } from '../contracts/plan.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { samplePose } from '../solver/sample.ts';
import type { SolverTier } from '../solver/types.ts';
import type { BakedClip } from './types.ts';

/** Frame times: k / fps for k = 0.. while < duration, then exactly `duration`. No accumulation. */
export function bakeTimes(duration: number, fps: number): number[] {
  if (!(fps > 0 && fps <= 1000 && Number.isFinite(fps))) throw new RangeError(`fps must be in (0, 1000], got ${fps}`);
  const times: number[] = [];
  const n = Math.floor(duration * fps + 1e-9);
  for (let k = 0; k <= n; k++) times.push(k / fps);
  if (duration - (times.at(-1) ?? 0) > 1e-9) times.push(duration);
  else times[times.length - 1] = Math.min(times.at(-1)!, duration);
  return times;
}

/**
 * Deterministic bake: every frame is an independent `samplePose` call at an exact time, so a bake
 * at any rate agrees with direct sampling at the shared times (no drift, no sequential state).
 * Memory is O(frames); for long analyses prefer `analyzePlan`, which streams.
 */
export function bakeClip(plan: MotionPlan, rig: RigDefinition, fps: number, tier: SolverTier = 'stabilized'): BakedClip {
  const times = bakeTimes(plan.duration, fps);
  return { plan, rig, tier, fps, times, frames: times.map((t) => samplePose(plan, rig, t, tier)) };
}
