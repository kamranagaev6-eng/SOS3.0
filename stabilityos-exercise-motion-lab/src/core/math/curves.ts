/** Scalar easing and interpolation primitives. All are pure and C1 or better. */

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Quintic smootherstep: zero 1st and 2nd derivatives at both ends (C2). */
export function smootherstep(t: number): number {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export function smootherstepDerivative(t: number): number {
  const x = clamp01(t);
  return 30 * x * x * (x - 1) * (x - 1);
}

/** Smootherstep restricted to the window [a, b] of t in [0, 1]. */
export function windowedSmootherstep(t: number, a: number, b: number): number {
  if (b <= a) return t < a ? 0 : 1;
  return smootherstep((t - a) / (b - a));
}

/** Bump with value 1 at t = 0.5, zero value/slope/curvature at both ends (C2). */
export function bump(t: number): number {
  const x = clamp01(t);
  const v = x * (1 - x);
  return 64 * v * v * v;
}

/** Cubic Hermite basis evaluation on a unit interval. */
export function hermite(p0: number, m0: number, p1: number, m1: number, s: number): number {
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * p0 + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * p1 + (s3 - s2) * m1;
}

export const DEG = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function deg(x: number): number {
  return x * DEG;
}
