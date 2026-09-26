import type { ScalarKey, Track } from '../contracts/plan.ts';
import { hermite } from '../math/curves.ts';

/**
 * Keyframe track evaluation: piecewise cubic Hermite, C1 everywhere.
 * 'stop' keys have zero tangent. 'flow' keys use the Fritsch–Butland weighted harmonic mean of
 * adjacent secant slopes, which is zero at local extrema and preserves monotonicity (no overshoot
 * beyond authored key values). The first and last keys always have zero tangent.
 * Outside the key range the track holds its end values.
 */
export function evalTrack(track: Track, t: number): number {
  const k = track.keys;
  const n = k.length;
  const first = k[0]!;
  if (n === 1 || t <= first.t) return first.v;
  const last = k[n - 1]!;
  if (t >= last.t) return last.v;
  // binary search: largest i with k[i].t <= t
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (k[mid]!.t <= t) lo = mid;
    else hi = mid;
  }
  const a = k[lo]!;
  const b = k[lo + 1]!;
  const h = b.t - a.t;
  if (!(h > 0)) return b.v;
  const s = (t - a.t) / h;
  return hermite(a.v, tangent(k, lo) * h, b.v, tangent(k, lo + 1) * h, s);
}

function tangent(k: readonly ScalarKey[], i: number): number {
  const key = k[i]!;
  if (key.mode === 'stop' || i === 0 || i === k.length - 1) return 0;
  const p = k[i - 1]!;
  const q = k[i + 1]!;
  const h0 = key.t - p.t;
  const h1 = q.t - key.t;
  const d0 = (key.v - p.v) / h0;
  const d1 = (q.v - key.v) / h1;
  if (d0 === 0 || d1 === 0 || Math.sign(d0) !== Math.sign(d1)) return 0;
  return (3 * (h0 + h1)) / ((2 * h1 + h0) / d0 + (h1 + 2 * h0) / d1);
}

/** Convenience: build a track from [t, v] pairs; `flow` lists key indices that flow through. */
export function track(pairs: readonly (readonly [number, number])[], flow: readonly number[] = []): Track {
  return { keys: pairs.map(([t, v], i) => ({ t, v, mode: flow.includes(i) ? 'flow' : 'stop' })) };
}

export function constantTrack(v: number): Track {
  return { keys: [{ t: 0, v, mode: 'stop' }] };
}

export function validateTrackKeys(tr: Track, duration: number): string | null {
  for (let i = 0; i < tr.keys.length; i++) {
    const key = tr.keys[i]!;
    if (!Number.isFinite(key.t) || !Number.isFinite(key.v)) return `key ${i} not finite`;
    if (key.t < 0 || key.t > duration + 1e-9) return `key ${i} time ${key.t} outside [0, ${duration}]`;
    if (i > 0 && !(key.t > tr.keys[i - 1]!.t)) return `key ${i} time not strictly increasing`;
  }
  return null;
}
