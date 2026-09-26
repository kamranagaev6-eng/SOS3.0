/**
 * Whole-clip analysis off the main thread: the real engine's streaming analyser at the
 * continuity-check rate, plus a coarse pelvis trajectory for the overlay. Pure computation.
 */
import { analyzeTier, type AnalysisRequest, type AnalysisResponse } from './analysisCore.ts';

const ctx = self as unknown as { onmessage: ((e: MessageEvent<AnalysisRequest>) => void) | null; postMessage(m: AnalysisResponse): void };

ctx.onmessage = (e) => {
  const req = e.data;
  req.tiers.forEach((tier, i) => {
    const result = analyzeTier(req.plan, req.rig, tier, req.rate, req.trajectoryFps);
    ctx.postMessage({ key: req.key, tier, result, done: i === req.tiers.length - 1 });
  });
};
