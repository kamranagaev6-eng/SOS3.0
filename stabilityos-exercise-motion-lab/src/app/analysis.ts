import type { MotionPlan } from '../core/contracts/plan.ts';
import type { RigDefinition } from '../core/contracts/rig.ts';
import { samplePose } from '../core/engine.ts';
import type { Vec3 } from '../core/math/vec3.ts';
import type { SolverTier } from '../core/solver/types.ts';
import { TOLERANCES } from '../core/tolerances.ts';
import type { Bounds3 } from '../render/index.ts';
import { analyzeTier, type AnalysisRequest, type AnalysisResponse, type TierAnalysis } from './analysisCore.ts';

export type { TierAnalysis } from './analysisCore.ts';

/** Metrics are computed at the continuity-check rate so every tolerance (incl. velocity jumps) is judged. */
export const METRICS_RATE = TOLERANCES.continuityRate;
export const TRAJECTORY_FPS = 30;
export const ANALYSIS_TIERS: readonly SolverTier[] = ['stabilized', 'analytic', 'baseline'];

export interface AnalysisState {
  status: 'idle' | 'running' | 'done';
  key: number;
  results: Partial<Record<SolverTier, TierAnalysis>>;
}

type Listener = (r: AnalysisResponse) => void;
let worker: Worker | null = null;
let workerBroken = false;
const listeners = new Set<Listener>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module', name: 'motion-lab-analysis' });
    worker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
      for (const l of listeners) l(e.data);
    };
    worker.onerror = () => {
      workerBroken = true;
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

let nextKey = 1;

/**
 * Whole-clip analysis for every tier. Runs in a Web Worker when available (never blocks typing);
 * otherwise falls back to one tier per macrotask on the main thread. Starts after a short delay
 * so rapid parameter edits do not queue work; `cancel()` ignores a stale run's results.
 */
export function runAnalysis(
  plan: MotionPlan,
  rig: RigDefinition,
  onUpdate: (tier: SolverTier, result: TierAnalysis, done: boolean) => void,
  delayMs = 200,
): { cancel(): void } {
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const key = nextKey++;
  const tiers = [...ANALYSIS_TIERS];
  const listener: Listener = (r) => {
    if (cancelled || r.key !== key) return;
    onUpdate(r.tier, r.result, r.done);
    if (r.done) listeners.delete(listener);
  };
  const mainThread = (i: number): void => {
    if (cancelled) return;
    const tier = tiers[i];
    if (!tier) return;
    const result = analyzeTier(plan, rig, tier, METRICS_RATE, TRAJECTORY_FPS, 'main thread');
    const done = i === tiers.length - 1;
    onUpdate(tier, result, done);
    if (!done) timer = setTimeout(() => mainThread(i + 1), 0);
  };
  timer = setTimeout(() => {
    if (cancelled) return;
    const w = getWorker();
    if (w) {
      listeners.add(listener);
      const req: AnalysisRequest = { key, plan, rig, tiers, rate: METRICS_RATE, trajectoryFps: TRAJECTORY_FPS };
      try {
        w.postMessage(req);
        return;
      } catch {
        listeners.delete(listener);
      }
    }
    mainThread(0);
  }, delayMs);
  return {
    cancel() {
      cancelled = true;
      listeners.delete(listener);
      if (timer !== null) clearTimeout(timer);
    },
  };
}

/**
 * Framing bounds for the camera: a coarse sampling of the clip (~25 samples) plus the environment
 * furniture, padded. Computed synchronously when the plan changes.
 */
export function clipFraming(plan: MotionPlan, rig: RigDefinition): Bounds3 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const grow = (p: readonly number[]): void => {
    for (let k = 0; k < 3; k++) {
      const v = p[k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  };
  const n = 24;
  for (let i = 0; i <= n; i++) {
    try {
      const s = samplePose(plan, rig, (i / n) * plan.duration, 'stabilized');
      s.worldPos.forEach(grow);
      s.sitePos.forEach(grow);
    } catch {
      // Sampling problems are reported elsewhere; framing falls back to the environment.
    }
  }
  for (const o of plan.environment.objects) {
    if (o.kind === 'chair') {
      grow([o.centerX - o.seatWidth / 2, 0, o.frontZ - o.seatDepth]);
      grow([o.centerX + o.seatWidth / 2, o.seatHeight + o.backrestHeight, o.frontZ]);
    } else if (o.kind === 'step') {
      grow([o.centerX - o.width / 2, 0, o.frontZ]);
      grow([o.centerX + o.width / 2, o.height, o.frontZ + o.depth]);
    }
  }
  if (!Number.isFinite(min[0])) return { min: [-0.5, 0, -0.5], max: [0.5, 1.8, 0.5] };
  const pad = 0.05;
  return {
    min: [min[0] - pad, Math.min(0, min[1]), min[2] - pad],
    max: [max[0] + pad, max[1] + pad, max[2] + pad],
  };
}
