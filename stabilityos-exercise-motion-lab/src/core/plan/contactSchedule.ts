import { SIDES } from '../contracts/common.ts';
import type { ContactInterval, FootState, MotionPlan } from '../contracts/plan.ts';
import { smootherstep } from '../math/curves.ts';
import { footSites, SEAT_SITE } from '../rig/canonical.ts';

const scheduleCache = new WeakMap<MotionPlan, ContactInterval[]>();

type Raw = ContactInterval & { anchorKey: string };

function anchorKey(s: FootState): string {
  return s.kind === 'swing' ? 'swing' : `${s.surface}|${s.anchor.x}|${s.anchor.z}|${s.anchor.yaw}`;
}

/**
 * Explicit contact schedule derived from foot states and seat intervals.
 *   flat:     position contacts heel, ball, toe + orientation contact of the foot segment
 *   forefoot: position contacts ball, toe + orientation contact of the toes segment (heel free)
 *   seat:     position contact of the `seat` site (pelvis may rotate about it)
 * Consecutive intervals of the same site on the same anchor are merged (e.g. the ball stays in
 * contact across flat → forefoot → flat in a heel raise), so "planted displacement" is measured
 * over the whole time a site is supposed to stay put.
 */
export function deriveContactSchedule(plan: MotionPlan): ContactInterval[] {
  const hit = scheduleCache.get(plan);
  if (hit) return hit;
  const raw: Raw[] = [];
  for (const side of SIDES) {
    const fs = footSites(side);
    for (const s of plan.feet[side]) {
      if (s.kind === 'swing') continue;
      const key = anchorKey(s);
      const base = { surface: s.surface, side, start: s.start, end: s.end, blendIn: 0, blendOut: 0, anchorKey: key } as const;
      const sites = s.kind === 'flat' ? [fs.heel, fs.ball, fs.toe] : [fs.ball, fs.toe];
      for (const site of sites) raw.push({ ...base, id: '', site, kind: 'position' });
      raw.push({ ...base, id: '', site: s.kind === 'flat' ? `foot${side === 'left' ? '_L' : '_R'}` : `toes${side === 'left' ? '_L' : '_R'}`, kind: 'orientation', segment: s.kind === 'flat' ? 'foot' : 'toes' });
    }
  }
  const merged: Raw[] = [];
  for (const r of raw) {
    const prev = merged.findLast((m) => m.site === r.site && m.kind === r.kind);
    if (prev && Math.abs(prev.end - r.start) < 1e-12 && prev.anchorKey === r.anchorKey && prev.surface === r.surface) {
      prev.end = r.end;
    } else merged.push({ ...r });
  }
  const out: ContactInterval[] = merged.map(({ anchorKey: _k, ...c }) => c);
  if (plan.seat) {
    for (const iv of plan.seat.intervals)
      out.push({ id: '', site: SEAT_SITE, surface: plan.seat.surface, kind: 'position', side: 'center', start: iv.start, end: iv.end, blendIn: iv.blendIn, blendOut: iv.blendOut });
  }
  const counts = new Map<string, number>();
  for (const c of out) {
    const base = `${c.kind === 'position' ? c.site : `${c.site}.orientation`}@${c.surface}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    c.id = `${base}#${n}`;
  }
  out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  scheduleCache.set(plan, out);
  return out;
}

/**
 * Constraint weight in [0, 1]. Blend windows are centred on the nominal start/end and shaped by
 * smootherstep (C2). No blending at the clip boundaries.
 */
export function intervalWeight(c: Pick<ContactInterval, 'start' | 'end' | 'blendIn' | 'blendOut'>, t: number, duration: number): { w: number; phase: 'rising' | 'falling' | 'full' | 'off' } {
  const rise = c.start <= 1e-12 || c.blendIn <= 0 ? (t >= c.start ? 1 : 0) : smootherstep((t - (c.start - c.blendIn / 2)) / c.blendIn);
  const fall = c.end >= duration - 1e-12 || c.blendOut <= 0 ? (t <= c.end ? 1 : 0) : 1 - smootherstep((t - (c.end - c.blendOut / 2)) / c.blendOut);
  const w = Math.min(rise, fall);
  if (w <= 0) return { w: 0, phase: 'off' };
  if (w >= 1) return { w: 1, phase: 'full' };
  return { w, phase: rise < fall ? 'rising' : 'falling' };
}

export function seatWeight(plan: MotionPlan, t: number): number {
  if (!plan.seat) return 0;
  let w = 0;
  for (const iv of plan.seat.intervals) w = Math.max(w, intervalWeight(iv, t, plan.duration).w);
  return w;
}

export function phaseIndexAt(plan: MotionPlan, t: number): number {
  const ps = plan.phases;
  for (let i = 0; i < ps.length; i++) if (t < ps[i]!.end) return i;
  return ps.length - 1;
}
