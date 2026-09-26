/**
 * Seeded property tests for the math layer. Every property is checked on thousands of inputs
 * drawn from fixed seeds, so failures are reproducible (the failing iteration index is reported).
 */
import { describe, expect, it } from 'vitest';
import { eulerAlternate, eulerFromMat3, mat3FromEuler, type EulerOrder } from '../../src/core/math/euler.ts';
import { mat3Determinant, mat3Multiply, mat3Transpose, type Mat3 } from '../../src/core/math/mat3.ts';
import {
  mat3FromQuat,
  quatAngleBetween,
  quatConjugate,
  quatFromMat3,
  quatFromUnitVectors,
  quatMultiply,
  quatRotateVec3,
  quatSlerp,
  type Quat,
} from '../../src/core/math/quat.ts';
import { hermite, smootherstep } from '../../src/core/math/curves.ts';
import { createRng, type Rng } from '../../src/core/math/rng.ts';
import type { Vec3 } from '../../src/core/math/vec3.ts';

const N = 5000;
const ORDERS: EulerOrder[] = [
  [0, 1, 2],
  [1, 2, 0],
  [2, 0, 1],
  [0, 2, 1],
  [2, 1, 0],
  [1, 0, 2],
];

function randomQuat(rng: Rng): Quat {
  const u1 = rng.next();
  const u2 = rng.next();
  const u3 = rng.next();
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  return [a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3)];
}
function randomUnitVec(rng: Rng): Vec3 {
  for (;;) {
    const v: Vec3 = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
    const l = Math.hypot(...v);
    if (l > 0.1 && l <= 1) return [v[0] / l, v[1] / l, v[2] / l];
  }
}
function norm4(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}
function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}
function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
/** Rotate v by angle about unit axis n (Rodrigues vector form, independent of quat code). */
function rotate(n: Vec3, ang: number, v: Vec3): Vec3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const k = dot3(n, v) * (1 - c);
  const x: Vec3 = [n[1] * v[2] - n[2] * v[1], n[2] * v[0] - n[0] * v[2], n[0] * v[1] - n[1] * v[0]];
  return [v[0] * c + x[0] * s + n[0] * k, v[1] * c + x[1] * s + n[1] * k, v[2] * c + x[2] * s + n[2] * k];
}

describe('quaternion properties (seeded)', () => {
  it(`products of unit quaternions stay unit; conjugate inverts (${N} samples)`, () => {
    const rng = createRng(0xa11ce);
    for (let i = 0; i < N; i++) {
      const a = randomQuat(rng);
      const b = randomQuat(rng);
      const ab = quatMultiply(a, b);
      expect(Math.abs(norm4(ab) - 1), `i=${i}`).toBeLessThan(1e-15);
      expect(maxAbsDiff(quatMultiply(quatConjugate(ab), ab), [0, 0, 0, 1]), `i=${i}`).toBeLessThan(1e-15);
      // (ab)* = b* a*
      expect(maxAbsDiff(quatConjugate(ab), quatMultiply(quatConjugate(b), quatConjugate(a))), `i=${i}`).toBeLessThan(1e-15);
    }
  });

  it('rotateVec3 is an orientation-preserving isometry that agrees with the matrix', () => {
    const rng = createRng(0xb0b);
    for (let i = 0; i < N; i++) {
      const q = randomQuat(rng);
      const u: Vec3 = [rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)];
      const v: Vec3 = [rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)];
      const ru = quatRotateVec3(q, u);
      const rv = quatRotateVec3(q, v);
      expect(Math.abs(dot3(ru, rv) - dot3(u, v)), `i=${i}`).toBeLessThan(1e-13);
      const cuv: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const crr: Vec3 = [ru[1] * rv[2] - ru[2] * rv[1], ru[2] * rv[0] - ru[0] * rv[2], ru[0] * rv[1] - ru[1] * rv[0]];
      expect(maxAbsDiff(quatRotateVec3(q, cuv), crr), `i=${i}`).toBeLessThan(1e-13); // R(u x v) = Ru x Rv
      const m = mat3FromQuat(q);
      expect(maxAbsDiff([m[0] * u[0] + m[1] * u[1] + m[2] * u[2], m[3] * u[0] + m[4] * u[1] + m[5] * u[2], m[6] * u[0] + m[7] * u[1] + m[8] * u[2]], ru)).toBeLessThan(1e-14);
    }
  });

  it('mat3 <-> quat round trips; matrices are orthonormal with det +1', () => {
    const rng = createRng(0xc0ffee);
    for (let i = 0; i < N; i++) {
      const q = randomQuat(rng);
      const m = mat3FromQuat(q);
      expect(maxAbsDiff(mat3Multiply(mat3Transpose(m), m), [1, 0, 0, 0, 1, 0, 0, 0, 1]), `i=${i}`).toBeLessThan(1e-14);
      expect(Math.abs(mat3Determinant(m) - 1), `i=${i}`).toBeLessThan(1e-14);
      const back = quatFromMat3(m);
      expect(back[3]).toBeGreaterThanOrEqual(0);
      expect(Math.abs(norm4(back) - 1)).toBeLessThan(1e-15);
      expect(Math.min(maxAbsDiff(back, q), maxAbsDiff(back, q.map((v) => -v))), `i=${i}`).toBeLessThan(1e-14);
    }
  });

  it('angleBetween is a bi-invariant metric (symmetry, triangle inequality, invariance)', () => {
    const rng = createRng(0xd00d);
    for (let i = 0; i < N; i++) {
      const a = randomQuat(rng);
      const b = randomQuat(rng);
      const c = randomQuat(rng);
      const g = randomQuat(rng);
      const ab = quatAngleBetween(a, b);
      expect(ab).toBeGreaterThanOrEqual(0);
      expect(ab).toBeLessThanOrEqual(Math.PI + 1e-15);
      expect(Math.abs(quatAngleBetween(b, a) - ab)).toBeLessThan(1e-13);
      expect(ab, `i=${i}`).toBeLessThanOrEqual(quatAngleBetween(a, c) + quatAngleBetween(c, b) + 1e-12);
      expect(Math.abs(quatAngleBetween(quatMultiply(g, a), quatMultiply(g, b)) - ab), `i=${i}`).toBeLessThan(1e-12);
      expect(Math.abs(quatAngleBetween(quatMultiply(a, g), quatMultiply(b, g)) - ab), `i=${i}`).toBeLessThan(1e-12);
    }
  });

  it('slerp stays unit and moves at constant angular speed along the shortest arc', () => {
    const rng = createRng(0xe1e);
    for (let i = 0; i < N; i++) {
      const a = randomQuat(rng);
      const b = randomQuat(rng);
      const t = rng.next();
      const s = quatSlerp(a, b, t);
      const total = quatAngleBetween(a, b);
      expect(Math.abs(norm4(s) - 1), `i=${i}`).toBeLessThan(1e-14);
      expect(Math.abs(quatAngleBetween(a, s) - t * total), `i=${i}`).toBeLessThan(1e-11);
      expect(Math.abs(quatAngleBetween(s, b) - (1 - t) * total), `i=${i}`).toBeLessThan(1e-11);
    }
  });

  it('fromUnitVectors maps from onto to for random pairs, including near-parallel and near-antiparallel', () => {
    const rng = createRng(0xf00);
    for (let i = 0; i < N; i++) {
      const from = randomUnitVec(rng);
      let to: Vec3;
      const kind = i % 3;
      if (kind === 0) to = randomUnitVec(rng);
      else {
        // perturb +-from by a random angle 10^[-12, -1] about a random perpendicular axis
        const r = randomUnitVec(rng);
        const k = dot3(r, from);
        const perp: Vec3 = [r[0] - k * from[0], r[1] - k * from[1], r[2] - k * from[2]];
        const pl = Math.hypot(...perp);
        const axis: Vec3 = [perp[0] / pl, perp[1] / pl, perp[2] / pl];
        const base: Vec3 = kind === 1 ? from : [-from[0], -from[1], -from[2]];
        to = rotate(axis, 10 ** rng.range(-12, -1), base);
      }
      const q = quatFromUnitVectors(from, to);
      expect(Math.abs(norm4(q) - 1), `i=${i}`).toBeLessThan(1e-15);
      expect(maxAbsDiff(quatRotateVec3(q, from), to), `i=${i} kind=${kind}`).toBeLessThan(1e-7);
      if (kind === 0) expect(maxAbsDiff(quatRotateVec3(q, from), to), `i=${i}`).toBeLessThan(1e-12);
    }
  });
});

describe('Euler properties (seeded)', () => {
  it(`all six orders: decompose(random rotation) recomposes, both branches (${N} samples)`, () => {
    const rng = createRng(0x5eed);
    for (let i = 0; i < N; i++) {
      const order = ORDERS[i % 6]!;
      const m = mat3FromQuat(randomQuat(rng));
      const e = eulerFromMat3(order, m);
      expect(Math.abs(e[1])).toBeLessThanOrEqual(Math.PI / 2);
      expect(maxAbsDiff(mat3FromEuler(order, e), m), `i=${i}`).toBeLessThan(1e-14);
      expect(maxAbsDiff(mat3FromEuler(order, eulerAlternate(e)), m), `i=${i}`).toBeLessThan(1e-14);
    }
  });

  it('angles with middle in (-pi/2, pi/2) are recovered exactly (outer angles mod 2pi)', () => {
    const rng = createRng(0x5eee);
    const wrap = (d: number) => Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
    for (let i = 0; i < N; i++) {
      const order = ORDERS[i % 6]!;
      const a: [number, number, number] = [rng.range(-4, 4), rng.range(-Math.PI / 2 + 1e-3, Math.PI / 2 - 1e-3), rng.range(-4, 4)];
      const e = eulerFromMat3(order, mat3FromEuler(order, a));
      expect(wrap(e[0] - a[0]), `i=${i}`).toBeLessThan(1e-11);
      expect(Math.abs(e[1] - a[1]), `i=${i}`).toBeLessThan(1e-11);
      expect(wrap(e[2] - a[2]), `i=${i}`).toBeLessThan(1e-11);
    }
  });

  it('gimbal-locked and near-locked matrices still recompose', () => {
    const rng = createRng(0x10c);
    for (let i = 0; i < N; i++) {
      const order = ORDERS[i % 6]!;
      const mid = (rng.next() < 0.5 ? 1 : -1) * (Math.PI / 2 - (i % 4 === 0 ? 0 : 10 ** rng.range(-14, -3)));
      const m: Mat3 = mat3FromEuler(order, [rng.range(-Math.PI, Math.PI), mid, rng.range(-Math.PI, Math.PI)]);
      expect(maxAbsDiff(mat3FromEuler(order, eulerFromMat3(order, m)), m), `i=${i}`).toBeLessThan(1e-13);
    }
  });
});

describe('curve properties (seeded)', () => {
  it('smootherstep is monotone, bounded and symmetric; hermite reproduces cubics', () => {
    const rng = createRng(0xcafe);
    for (let i = 0; i < N; i++) {
      const t0 = rng.range(-0.5, 1.5);
      const t1 = t0 + rng.range(0, 0.5);
      const s0 = smootherstep(t0);
      expect(s0).toBeGreaterThanOrEqual(0);
      expect(s0).toBeLessThanOrEqual(1);
      expect(smootherstep(t1)).toBeGreaterThanOrEqual(s0);
      expect(Math.abs(smootherstep(1 - t0) - (1 - s0))).toBeLessThan(4e-15);
      const c = [rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)] as const;
      const P = (s: number) => c[0] + c[1] * s + c[2] * s * s + c[3] * s * s * s;
      const dP = (s: number) => c[1] + 2 * c[2] * s + 3 * c[3] * s * s;
      const s = rng.next();
      expect(Math.abs(hermite(P(0), dP(0), P(1), dP(1), s) - P(s)), `i=${i}`).toBeLessThan(1e-13);
    }
  });
});
