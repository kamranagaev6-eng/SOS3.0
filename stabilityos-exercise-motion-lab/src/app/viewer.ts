import type { Environment } from '../core/contracts/environment.ts';
import type { MotionPlan } from '../core/contracts/plan.ts';
import type { RigDefinition } from '../core/contracts/rig.ts';
import { samplePose } from '../core/engine.ts';
import type { Vec3 } from '../core/math/vec3.ts';
import type { PoseSample, SolverTier } from '../core/solver/types.ts';
import { createPlayer, phaseIndexAt, type Player } from '../player/index.ts';
import type { Bounds3, HostBoneView, Stage } from '../render/index.ts';

export interface LiveReadout {
  t: number;
  duration: number;
  phaseIndex: number;
  sample: PoseSample | null;
  comparisonSample: PoseSample | null;
  error: string | null;
}

export type FrameListener = (t: number, duration: number) => void;
export type HostBoneProvider = ((sample: PoseSample) => HostBoneView[] | null) | null;

const READOUT_INTERVAL_MS = 100; // ≤ 10 Hz React updates

/**
 * Owns the playback clock and the per-frame loop. Each animation frame: read t from the player
 * (anchor-based, see player/clock.ts), sample the engine once (twice in comparison mode) only if t
 * or the content changed, push poses to the stage and render only when needed. React receives
 * readouts at most every 100 ms; per-frame DOM bits (playhead, scrubber) go through frame listeners.
 */
export class ViewerController {
  readonly player: Player;
  private stage: Stage | null = null;
  private plan: MotionPlan | null = null;
  private rig: RigDefinition | null = null;
  private envKey = '';
  private tier: SolverTier = 'stabilized';
  private comparison = false;
  private hostBones: HostBoneProvider = null;
  private lastT = Number.NaN;
  private contentVersion = 0;
  private sampledVersion = -1;
  private raf = 0;
  private running = false;
  private lastReadoutAt = -Infinity;
  private readoutDirty = true;
  private readonly frameListeners = new Set<FrameListener>();
  private current: LiveReadout = { t: 0, duration: 1, phaseIndex: -1, sample: null, comparisonSample: null, error: null };
  private readonly onReadout: (r: LiveReadout) => void;
  private framing: Bounds3 | null = null;

  constructor(onReadout: (r: LiveReadout) => void, now: () => number = () => performance.now()) {
    this.onReadout = onReadout;
    this.player = createPlayer({ duration: 1, now, loop: true });
    this.player.subscribe(() => {
      this.readoutDirty = true;
    });
  }

  attachStage(stage: Stage | null): void {
    this.stage = stage;
    if (stage) {
      stage.setRig(this.rig);
      stage.setEnvironment(this.plan?.environment ?? null);
      stage.setComparison(this.comparison);
      stage.setFraming(this.framing);
    }
    this.invalidate();
  }

  getStage(): Stage | null {
    return this.stage;
  }

  /** New compiled plan and/or rig. Clamps the current time into the new duration. */
  setContent(plan: MotionPlan | null, rig: RigDefinition | null, framing: Bounds3 | null): void {
    const rigChanged = rig !== this.rig;
    this.plan = plan;
    this.rig = rig;
    this.framing = framing;
    if (plan) this.player.setDuration(plan.duration);
    const env: Environment | null = plan?.environment ?? null;
    const envKey = env ? JSON.stringify(env) : '';
    if (this.stage) {
      if (rigChanged) this.stage.setRig(rig);
      if (envKey !== this.envKey || rigChanged) this.stage.setEnvironment(env);
      this.stage.setTrajectory(null, null);
      this.stage.setFraming(framing);
      if (!plan) this.stage.setPose(null, null);
    }
    this.envKey = envKey;
    this.invalidate();
  }

  setTrajectories(primary: readonly Vec3[] | null, comparison: readonly Vec3[] | null): void {
    this.stage?.setTrajectory(primary, comparison);
  }

  setTier(tier: SolverTier): void {
    this.tier = tier;
    this.invalidate();
  }

  getTier(): SolverTier {
    return this.tier;
  }

  /** Tier shown in the primary (right-hand) viewport while comparing against the baseline. */
  primaryTier(): SolverTier {
    return this.comparison && this.tier === 'baseline' ? 'stabilized' : this.tier;
  }

  setComparison(on: boolean): void {
    this.comparison = on;
    this.stage?.setComparison(on);
    this.invalidate();
  }

  getComparison(): boolean {
    return this.comparison;
  }

  setHostBoneProvider(p: HostBoneProvider): void {
    this.hostBones = p;
    if (!p) this.stage?.setHostBones(null);
    this.invalidate();
  }

  invalidate(): void {
    this.contentVersion++;
    this.readoutDirty = true;
  }

  getPlan(): MotionPlan | null {
    return this.plan;
  }

  getRig(): RigDefinition | null {
    return this.rig;
  }

  getReadout(): LiveReadout {
    return this.current;
  }

  addFrameListener(l: FrameListener): () => void {
    this.frameListeners.add(l);
    l(this.player.time(), this.player.snapshot().duration);
    return () => {
      this.frameListeners.delete(l);
    };
  }

  /** Samples the engine for the current tier(s) at t. Pure: depends only on (plan, rig, t, tier). */
  sampleAt(t: number): { primary: PoseSample | null; comparison: PoseSample | null } {
    if (!this.plan || !this.rig) return { primary: null, comparison: null };
    const primary = samplePose(this.plan, this.rig, t, this.primaryTier());
    const comparison = this.comparison ? samplePose(this.plan, this.rig, t, 'baseline') : null;
    return { primary, comparison };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (): void => {
      if (!this.running) return;
      this.frame(performance.now());
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  /** One frame of work; also called directly by tests / the static inspection mode. */
  frame(now: number): void {
    const t = this.player.time();
    const duration = this.player.snapshot().duration;
    const changed = t !== this.lastT || this.sampledVersion !== this.contentVersion;
    if (changed) {
      this.lastT = t;
      this.sampledVersion = this.contentVersion;
      let error: string | null = null;
      let s: { primary: PoseSample | null; comparison: PoseSample | null } = { primary: null, comparison: null };
      try {
        s = this.sampleAt(t);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (this.stage) {
        this.stage.setPose(s.primary, s.comparison);
        if (this.hostBones && s.primary) {
          try {
            this.stage.setHostBones(this.hostBones(s.primary));
          } catch {
            this.stage.setHostBones(null);
          }
        }
      }
      const phaseIndex = this.plan ? phaseIndexAt(this.plan.phases, t) : -1;
      this.current = { t, duration, phaseIndex, sample: s.primary, comparisonSample: s.comparison, error };
      this.readoutDirty = true;
      for (const l of this.frameListeners) l(t, duration);
    }
    if (this.stage?.needsRender()) this.stage.render();
    if (this.readoutDirty && now - this.lastReadoutAt >= READOUT_INTERVAL_MS) {
      this.lastReadoutAt = now;
      this.readoutDirty = false;
      this.onReadout(this.current);
    }
  }

  dispose(): void {
    this.stop();
    this.frameListeners.clear();
  }
}
