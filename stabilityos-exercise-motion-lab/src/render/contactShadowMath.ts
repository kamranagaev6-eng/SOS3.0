/**
 * Contact-shadow geometry, pure (no three.js): which support surface a point projects onto, how a
 * shadow fades and spreads with height above it, and the capsule layout of a foot shadow. The
 * render adapter (contactShadows.ts) turns these numbers into one dynamic mesh per pose layer; unit
 * tests check them directly in Node.
 *
 * These shadows are a readability cue (planted vs lifted), not a lighting model: they are
 * projected straight down (+Y up), independent of the scene lights.
 */
import type { SupportSurface } from '../core/contracts/environment.ts';
import type { Vec3 } from '../core/math/vec3.ts';

/** Height above the support surface at which a contact shadow has faded out completely (m). */
export const SHADOW_FADE_HEIGHT = 0.12;
/** Footprint growth at (and above) the fade height; 1 = the footprint at contact. */
export const SHADOW_MAX_SPREAD = 1.5;
/**
 * A surface counts as "beneath" a point when its top is at most this far ABOVE the point (m), so
 * solver residuals and small penetrations still project onto the surface being stood on. Surfaces
 * further above the point (a chair seat over a foot) are ignored.
 */
export const SURFACE_SLACK = 0.01;
/** Soft rim of the shadow beyond the foot / seat footprint at contact (m). */
export const SHADOW_MARGIN = 0.025;
/** Radial fraction of the gradient texture that stays at full darkness (the core under the footprint). */
export const SHADOW_CORE = 0.55;

export interface ShadowFalloff {
  /** Relative opacity: 1 at contact (and below the surface), 0 from `SHADOW_FADE_HEIGHT` up. */
  opacity: number;
  /** Footprint scale: 1 at contact, `SHADOW_MAX_SPREAD` from `SHADOW_FADE_HEIGHT` up. */
  scale: number;
}

/**
 * Opacity and size of a contact shadow for a point `height` metres above its support surface:
 * dark and tight at 0 mm, lighter and wider as the point rises, gone by `SHADOW_FADE_HEIGHT`.
 * opacity = (1 − s)², scale = 1 + (SHADOW_MAX_SPREAD − 1)·s with s = clamp(h / fade, 0, 1): both
 * monotonic in height, and the quadratic makes the first centimetres of lift clearly visible
 * (−16 % at 1 cm, −31 % at 2 cm) while the fade-out itself is smooth (zero slope at the top).
 */
export function contactShadowFalloff(height: number): ShadowFalloff {
  if (Number.isNaN(height)) return { opacity: 0, scale: SHADOW_MAX_SPREAD };
  const s = Math.min(Math.max(height / SHADOW_FADE_HEIGHT, 0), 1);
  const k = 1 - s;
  return { opacity: k * k, scale: 1 + (SHADOW_MAX_SPREAD - 1) * s };
}

/**
 * Radial alpha profile of the shared gradient texture (r = 0 centre, r = 1 edge): a flat core
 * under the footprint, then a smoothstep rim down to 0.
 */
export function shadowProfile(r: number): number {
  if (r <= SHADOW_CORE) return 1;
  if (r >= 1) return 0;
  const x = (r - SHADOW_CORE) / (1 - SHADOW_CORE);
  return 1 - x * x * (3 - 2 * x);
}

export interface SurfaceHit {
  id: string;
  y: number;
}

/**
 * Highest support surface beneath a point: the surface's footprint contains (x, z) (the floor is
 * unbounded) and its top is not above the point by more than `slack`. Null when there is none.
 */
export function supportBelow(surfaces: readonly SupportSurface[], p: Readonly<Vec3>, slack = SURFACE_SLACK): SurfaceHit | null {
  let best: SupportSurface | null = null;
  for (const s of surfaces) {
    if (s.y > p[1] + slack) continue;
    const b = s.bounds;
    if (b && (p[0] < b.minX || p[0] > b.maxX || p[2] < b.minZ || p[2] > b.maxZ)) continue;
    if (!best || s.y > best.y) best = s;
  }
  return best ? { id: best.id, y: best.y } : null;
}

export interface ShadowPointState {
  /** Height above the surface the shadow lies on (m; negative = below it). */
  height: number;
  opacity: number;
  scale: number;
}

/** One cross-section of a shadow capsule, in the ground plane. */
export interface ShadowStation {
  x: number;
  z: number;
  /** Half-width of the capsule here (m), including the soft rim and the height spread. */
  halfWidth: number;
  /** Relative opacity at this station (0..1). */
  alpha: number;
  /** Texture v: 0 / 1 at the cap ends, 0.5 along the straight part (the gradient's middle row). */
  v: number;
}

export interface FootShadowInput {
  heel: Readonly<Vec3>;
  ball: Readonly<Vec3>;
  toe: Readonly<Vec3>;
  /** Half-widths of the foot footprint at the heel, ball and toe (m). */
  halfWidth: { heel: number; ball: number; toe: number };
  /** Unit (x, z) heading used when heel→toe is (nearly) vertical. Default +Z. */
  fallbackHeading?: readonly [number, number];
}

export interface FootShadowLayout {
  surface: SurfaceHit;
  /** Unit heading of the foot in the ground plane (x, z). */
  heading: [number, number];
  points: { heel: ShadowPointState; ball: ShadowPointState; toe: ShadowPointState };
  /** Rear cap end, rear cap centre, ball, front cap centre, front cap end. */
  stations: ShadowStation[];
}

function pointState(p: Readonly<Vec3>, own: SurfaceHit | null, surface: SurfaceHit): ShadowPointState {
  const height = p[1] - surface.y;
  const f = contactShadowFalloff(height);
  // A sole point over a different surface (e.g. the heel off the step edge) casts nothing onto this one.
  const sameSurface = own !== null && Math.abs(own.y - surface.y) < 1e-6;
  return { height, opacity: sameSurface ? f.opacity : 0, scale: f.scale };
}

/**
 * Foot shadow as a soft capsule from heel to toe, oriented with the foot's heading and lying flat
 * on ONE support surface: the one beneath the sole point closest to its surface (so a foot planted
 * on a step top shadows the step top, never the floor through it). Heel, ball and toe each set the
 * opacity and spread of their end of the capsule, so a raised heel fades while the forefoot stays
 * dark. Null when no support surface lies beneath the foot.
 */
export function footShadowLayout(surfaces: readonly SupportSurface[], input: FootShadowInput): FootShadowLayout | null {
  const hits = [supportBelow(surfaces, input.heel), supportBelow(surfaces, input.ball), supportBelow(surfaces, input.toe)] as const;
  const pts = [input.heel, input.ball, input.toe] as const;
  let surface: SurfaceHit | null = null;
  let lowest = Infinity;
  hits.forEach((h, i) => {
    if (!h) return;
    const height = pts[i]![1] - h.y;
    if (height < lowest) {
      lowest = height;
      surface = h;
    }
  });
  if (!surface) return null;
  const s: SurfaceHit = surface;
  const heel = pointState(input.heel, hits[0], s);
  const ball = pointState(input.ball, hits[1], s);
  const toe = pointState(input.toe, hits[2], s);

  let hx = input.toe[0] - input.heel[0];
  let hz = input.toe[2] - input.heel[2];
  let len = Math.hypot(hx, hz);
  if (len < 1e-4) {
    [hx, hz] = input.fallbackHeading ?? [0, 1];
    const fl = Math.hypot(hx, hz) || 1;
    hx /= fl;
    hz /= fl;
    len = 0;
  } else {
    hx /= len;
    hz /= len;
  }
  const tBall = (input.ball[0] - input.heel[0]) * hx + (input.ball[2] - input.heel[2]) * hz;
  const w = input.halfWidth;
  const rHeel = (w.heel + SHADOW_MARGIN) * heel.scale;
  const rBall = (w.ball + SHADOW_MARGIN) * ball.scale;
  const rToe = (w.toe + SHADOW_MARGIN) * toe.scale;
  // Cap centres sit one footprint half-width inside the heel / toe, so the foot outline falls on
  // the edge of the dark core and the rim extends SHADOW_MARGIN beyond it.
  const tA = Math.min(w.heel, tBall);
  const tB = Math.max(len - w.toe, tBall);
  const at = (t: number): [number, number] => [input.heel[0] + hx * t, input.heel[2] + hz * t];
  const station = (t: number, halfWidth: number, alpha: number, v: number): ShadowStation => {
    const [x, z] = at(t);
    return { x, z, halfWidth, alpha, v };
  };
  return {
    surface: s,
    heading: [hx, hz],
    points: { heel, ball, toe },
    stations: [
      station(tA - rHeel, rHeel, heel.opacity, 0),
      station(tA, rHeel, heel.opacity, 0.5),
      station(tBall, rBall, ball.opacity, 0.5),
      station(tB, rToe, toe.opacity, 0.5),
      station(tB + rToe, rToe, toe.opacity, 1),
    ],
  };
}

export interface SeatShadowLayout {
  surface: SurfaceHit;
  point: ShadowPointState;
  /** Centre (x, z), unit heading (x, z) and half extents across / along the heading, spread applied. */
  center: [number, number];
  heading: [number, number];
  halfAcross: number;
  halfAlong: number;
}

/** Elliptical shadow under the pelvis seat point, on the highest surface beneath it (e.g. the chair seat). */
export function seatShadowLayout(
  surfaces: readonly SupportSurface[],
  seat: Readonly<Vec3>,
  heading: readonly [number, number],
  halfAcross: number,
  halfAlong: number,
): SeatShadowLayout | null {
  const hit = supportBelow(surfaces, seat);
  if (!hit) return null;
  const point = pointState(seat, hit, hit);
  let [hx, hz] = heading;
  const l = Math.hypot(hx, hz);
  if (l < 1e-6) [hx, hz] = [0, 1];
  else {
    hx /= l;
    hz /= l;
  }
  return {
    surface: hit,
    point,
    center: [seat[0], seat[2]],
    heading: [hx, hz],
    halfAcross: halfAcross * point.scale,
    halfAlong: halfAlong * point.scale,
  };
}
