/**
 * Framework-agnostic playback clock.
 *
 * Time is never accumulated from per-frame deltas. It is always computed as
 *   t = anchorTime + (now - anchorWallClock) * speed
 * and the anchor is reset on every play / pause / seek / speed change. Poses therefore depend only
 * on t, and frame rate, dropped frames or long playback cannot make playback drift.
 */
export interface PhaseSpan {
  id: string;
  label: string;
  start: number;
  end: number;
}

export type PlaybackSpeed = number;
export const SPEEDS: readonly PlaybackSpeed[] = [0.25, 0.5, 1, 2];
export const DEFAULT_INSPECTION_RATE = 30;

export interface PlayerSnapshot {
  t: number;
  duration: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  /** Set once when a non-looping playback reaches the end. */
  ended: boolean;
}

export interface PlayerOptions {
  duration: number;
  /** Wall clock in milliseconds (performance.now in the browser, a fake in tests). */
  now: () => number;
  speed?: number;
  loop?: boolean;
  inspectionRate?: number;
}

export type PlayerListener = (s: PlayerSnapshot) => void;

export interface Player {
  /** Current time. At the end of a non-looping clip this transitions to paused (deterministically). */
  time(): number;
  snapshot(): PlayerSnapshot;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(t: number): void;
  setSpeed(speed: number): void;
  setLoop(loop: boolean): void;
  setDuration(duration: number): void;
  setInspectionRate(rate: number): void;
  readonly inspectionRate: number;
  /** Pauses and moves by `frames` inspection frames (negative = reverse), snapping to the frame grid. */
  stepFrames(frames: number): void;
  /** Pauses and jumps to the start of the next (+1) or previous (-1) phase. */
  jumpPhase(direction: 1 | -1, phases: readonly PhaseSpan[]): void;
  subscribe(listener: PlayerListener): () => void;
}

const EPS = 1e-9;

export function phaseIndexAt(phases: readonly PhaseSpan[], t: number): number {
  if (phases.length === 0) return -1;
  for (let i = phases.length - 1; i >= 0; i--) {
    if (t >= phases[i]!.start - EPS) return i;
  }
  return 0;
}

export function createPlayer(opts: PlayerOptions): Player {
  const now = opts.now;
  let duration = Math.max(opts.duration, 1e-6);
  let speed = opts.speed ?? 1;
  let loop = opts.loop ?? true;
  let playing = false;
  let ended = false;
  let anchorTime = 0;
  let anchorWall = now();
  let rate = opts.inspectionRate ?? DEFAULT_INSPECTION_RATE;
  const listeners = new Set<PlayerListener>();

  const raw = (): number => (playing ? anchorTime + ((now() - anchorWall) / 1000) * speed : anchorTime);
  /** Paused times are already clamped; while playing, loop wraps and non-loop clamps. */
  const wrap = (t: number): number => {
    if (loop && (t > duration || t < 0)) {
      const m = t % duration;
      return m < 0 ? m + duration : m;
    }
    return Math.min(Math.max(t, 0), duration);
  };
  const reanchor = (t: number): void => {
    anchorTime = t;
    anchorWall = now();
  };
  const emit = (): void => {
    const s = api.snapshot();
    for (const l of listeners) l(s);
  };

  const api: Player = {
    time() {
      const r = raw();
      if (playing && !loop && r >= duration) {
        playing = false;
        ended = true;
        reanchor(duration);
        emit();
        return duration;
      }
      return wrap(r);
    },
    snapshot() {
      const t = playing && !loop && raw() >= duration ? duration : wrap(raw());
      return { t, duration, playing, speed, loop, ended };
    },
    play() {
      if (playing) return;
      let t = wrap(raw());
      if (!loop && t >= duration - EPS) t = 0;
      ended = false;
      playing = true;
      reanchor(t);
      emit();
    },
    pause() {
      if (!playing) return;
      const t = api.time();
      playing = false;
      reanchor(t);
      emit();
    },
    toggle() {
      if (playing) api.pause();
      else api.play();
    },
    seek(t) {
      if (!Number.isFinite(t)) return;
      ended = false;
      reanchor(Math.min(Math.max(t, 0), duration));
      emit();
    },
    setSpeed(s) {
      if (!(s > 0) || !Number.isFinite(s)) return;
      const t = api.time();
      speed = s;
      reanchor(t);
      emit();
    },
    setLoop(l) {
      const t = api.time();
      loop = l;
      reanchor(t);
      emit();
    },
    setDuration(d) {
      if (!(d > 0)) return;
      const t = api.time();
      duration = d;
      reanchor(Math.min(t, d));
      emit();
    },
    setInspectionRate(r) {
      if (r > 0 && Number.isFinite(r)) rate = r;
    },
    get inspectionRate() {
      return rate;
    },
    stepFrames(frames) {
      const t = api.time();
      playing = false;
      ended = false;
      const k = Math.round(t * rate);
      // If t is between grid frames, a step lands on the adjacent grid frame in that direction.
      const onGrid = Math.abs(k / rate - t) < 1e-7;
      let target: number;
      if (onGrid) target = (k + frames) / rate;
      else target = (frames > 0 ? Math.floor(t * rate) + frames : Math.ceil(t * rate) + frames) / rate;
      // Stepping clamps at both ends (it does not wrap, even when looping): predictable inspection.
      reanchor(Math.min(Math.max(target, 0), duration));
      emit();
    },
    jumpPhase(direction, phases) {
      if (phases.length === 0) return;
      const t = api.time();
      playing = false;
      ended = false;
      const i = phaseIndexAt(phases, t);
      let target: number;
      if (direction > 0) {
        const next = phases[i + 1];
        target = next ? next.start : duration;
      } else {
        const cur = phases[i]!;
        // Inside a phase: go to its start; already at its start: go to the previous phase.
        if (t - cur.start > 1e-3 || i === 0) target = cur.start;
        else target = phases[i - 1]!.start;
      }
      reanchor(Math.min(Math.max(target, 0), duration));
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return api;
}

export function formatTime(t: number): string {
  return `${t.toFixed(2)} s`;
}
