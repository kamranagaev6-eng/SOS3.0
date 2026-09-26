/**
 * Immutable 3-vector helpers. Coordinates follow the project convention:
 * right-handed, +Y up, +Z forward (subject faces +Z), +X = subject's left, metres.
 */
export type Vec3 = [number, number, number];

export const ZERO3: Vec3 = [0, 0, 0];
export const UNIT_X: Vec3 = [1, 0, 0];
export const UNIT_Y: Vec3 = [0, 1, 0];
export const UNIT_Z: Vec3 = [0, 0, 1];

export function v3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** a + b * s */
export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Normalises `a`; returns `fallback` when |a| is below `eps` (degenerate input is the caller's problem to report). */
export function normalize(a: Vec3, fallback: Vec3 = UNIT_Y, eps = 1e-12): Vec3 {
  const l = length(a);
  if (!(l > eps)) return fallback;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function negate(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}

export function isFiniteVec3(a: Vec3): boolean {
  return Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
}

/** Component of `a` perpendicular to unit vector `n`. */
export function rejectFrom(a: Vec3, n: Vec3): Vec3 {
  return addScaled(a, n, -dot(a, n));
}

/** Mirror across the sagittal (YZ) plane: x -> -x. */
export function mirrorX(a: Vec3): Vec3 {
  return [-a[0], a[1], a[2]];
}

export function maxAbsComponent(a: Vec3): number {
  return Math.max(Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2]));
}
