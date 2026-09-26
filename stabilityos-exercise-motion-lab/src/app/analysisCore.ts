import type { MotionPlan } from '../core/contracts/plan.ts';
import type { RigDefinition } from '../core/contracts/rig.ts';
import { analyzePlan, samplePose } from '../core/engine.ts';
import type { Vec3 } from '../core/math/vec3.ts';
import type { ClipMetrics } from '../core/metrics/types.ts';
import type { SolverTier } from '../core/solver/types.ts';

export interface TierAnalysis {
  tier: SolverTier;
  metrics: ClipMetrics | null;
  error: string | null;
  /** Pelvis world trajectory for the overlay (coarse, `trajectoryFps`). */
  trajectory: Vec3[];
  analyzeMs: number;
  where: 'worker' | 'main thread';
}

export interface AnalysisRequest {
  key: number;
  plan: MotionPlan;
  rig: RigDefinition;
  tiers: SolverTier[];
  rate: number;
  trajectoryFps: number;
}

export interface AnalysisResponse {
  key: number;
  tier: SolverTier;
  result: TierAnalysis;
  done: boolean;
}

/** Real engine metrics for one tier (streamed at `rate`, bounded memory) + coarse trajectory. */
export function analyzeTier(plan: MotionPlan, rig: RigDefinition, tier: SolverTier, rate: number, trajectoryFps: number, where: TierAnalysis['where'] = 'worker'): TierAnalysis {
  const t0 = performance.now();
  let metrics: ClipMetrics | null = null;
  let error: string | null = null;
  const trajectory: Vec3[] = [];
  try {
    metrics = analyzePlan(plan, rig, tier, rate);
    const n = Math.max(2, Math.ceil(plan.duration * trajectoryFps));
    for (let k = 0; k <= n; k++) trajectory.push(samplePose(plan, rig, (k / n) * plan.duration, tier).pelvisWorld);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { tier, metrics, error, trajectory, analyzeMs: performance.now() - t0, where };
}
