import { samplePose } from '../core/engine.ts';
import type { SolverTier } from '../core/solver/types.ts';
import type { StageStats } from '../render/index.ts';
import type { ViewerController } from './viewer.ts';

/**
 * Small, read-mostly hook for Playwright tests and the render benchmark. Installed only when the
 * page is driven by automation (navigator.webdriver) or `?testHooks` is in the URL. It can seek
 * and read state; it cannot change recipes, parameters or anything persistent.
 */
export interface MotionLabTestHook {
  seek(t: number): void;
  pause(): void;
  getState(): MotionLabState;
  /** In-page benchmark over the current plan: engine sampling and render timings, separately. */
  runRenderBench(opts: { frames?: number; comparison?: boolean; fps?: number; finish?: boolean }): Promise<RenderBenchRun>;
}

export interface MotionLabState {
  recipeId: string;
  rigId: string;
  t: number;
  duration: number;
  playing: boolean;
  speed: number;
  phaseId: string | null;
  phaseLabel: string | null;
  view: string;
  comparison: boolean;
  tier: SolverTier;
  webgl: boolean;
  split: string;
  stats: StageStats | null;
  planOk: boolean;
  phases: { id: string; label: string; start: number; end: number }[];
  overlays: Record<string, boolean>;
  inspectSide: string | null;
  staticMode: boolean;
}

export interface RenderBenchRun {
  recipeId: string;
  comparison: boolean;
  frames: number;
  samplesPerFrame: number;
  /** Engine sampling time per frame (1 or 2 samplePose calls), ms. */
  sampleMs: number[];
  /** Stage update (setPose, overlays) per frame, ms. */
  updateMs: number[];
  /** CPU time inside renderer.render per frame, ms. */
  renderCpuMs: number[];
  /** renderCpuMs + gl.finish(), ms (only when finish=true). */
  renderFinishMs: number[];
  /** Whole frame (sample + update + render [+ finish]), ms. */
  frameMs: number[];
  stats: StageStats | null;
  gpu: { renderer: string; vendor: string; webglVersion: string } | null;
  canvas: { width: number; height: number; pixelRatio: number } | null;
}

declare global {
  interface Window {
    __motionLab?: MotionLabTestHook;
  }
}

export function shouldInstallTestHook(): boolean {
  try {
    return navigator.webdriver === true || new URLSearchParams(location.search).has('testHooks');
  } catch {
    return false;
  }
}

export function installTestHook(controller: ViewerController, getState: () => Omit<MotionLabState, 't' | 'duration' | 'playing' | 'speed' | 'stats' | 'split'>): () => void {
  const hook: MotionLabTestHook = {
    seek(t) {
      controller.player.pause();
      controller.player.seek(t);
    },
    pause() {
      controller.player.pause();
    },
    getState() {
      const snap = controller.player.snapshot();
      const stage = controller.getStage();
      return {
        ...getState(),
        t: snap.t,
        duration: snap.duration,
        playing: snap.playing,
        speed: snap.speed,
        stats: stage ? stage.getStats() : null,
        split: stage ? stage.getSplit() : 'none',
      };
    },
    async runRenderBench(opts) {
      const plan = controller.getPlan();
      const rig = controller.getRig();
      const stage = controller.getStage();
      if (!plan || !rig) throw new Error('no compiled plan');
      const frames = opts.frames ?? 600;
      const fps = opts.fps ?? 60;
      const comparison = opts.comparison ?? false;
      const finish = opts.finish ?? true;
      const prevComparison = controller.getComparison();
      controller.stop();
      controller.player.pause();
      controller.setComparison(comparison);
      const tier: SolverTier = 'stabilized';
      const out: RenderBenchRun = {
        recipeId: plan.recipe.id,
        comparison,
        frames,
        samplesPerFrame: comparison ? 2 : 1,
        sampleMs: [],
        updateMs: [],
        renderCpuMs: [],
        renderFinishMs: [],
        frameMs: [],
        stats: null,
        gpu: stage ? stage.getGpuInfo() : null,
        canvas: null,
      };
      // Warm-up (shader compilation, JIT) is excluded from the measurement.
      for (let i = 0; i < 10; i++) {
        const t = (i / fps) % plan.duration;
        const p = samplePose(plan, rig, t, tier);
        const c = comparison ? samplePose(plan, rig, t, 'baseline') : null;
        stage?.setPose(p, c);
        stage?.renderAndFinish();
      }
      for (let i = 0; i < frames; i++) {
        const t = (i / fps) % plan.duration;
        const f0 = performance.now();
        const p = samplePose(plan, rig, t, tier);
        const c = comparison ? samplePose(plan, rig, t, 'baseline') : null;
        const f1 = performance.now();
        stage?.setPose(p, c);
        const f2 = performance.now();
        const r = stage ? (finish ? stage.renderAndFinish() : stage.render()) : { renderCpuMs: 0, renderFinishMs: 0 };
        const f3 = performance.now();
        out.sampleMs.push(f1 - f0);
        out.updateMs.push(f2 - f1);
        out.renderCpuMs.push(r.renderCpuMs);
        out.renderFinishMs.push(r.renderFinishMs);
        out.frameMs.push(f3 - f0);
        // Yield occasionally so the page stays responsive to the test runner.
        if (i % 100 === 99) await new Promise((res) => setTimeout(res, 0));
      }
      if (stage) {
        const s = stage.getStats();
        out.stats = s;
        out.canvas = { width: s.width, height: s.height, pixelRatio: s.pixelRatio };
      }
      controller.setComparison(prevComparison);
      controller.invalidate();
      controller.start();
      return out;
    },
  };
  window.__motionLab = hook;
  return () => {
    if (window.__motionLab === hook) delete window.__motionLab;
  };
}
