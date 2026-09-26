/**
 * Independent unit tests for src/core/math (vec3, mat3, quat, curves, rng).
 *
 * Reference values are computed in this file from first principles (Rodrigues' formula,
 * explicit matrix products, an independent BigInt mulberry32) rather than by calling the
 * function under test.
 */
import { describe, expect, it } from 'vitest';
import {
  IDENTITY3,
  mat3AxisRotation,
  mat3Column,
  mat3Determinant,
  mat3FromColumns,
  mat3Get,
  mat3Multiply,
  mat3MulVec,
  mat3Transpose,
  type Mat3,
} from '../../src/core/math/mat3.ts';
import {
  IDENTITY_Q,
  isFiniteQuat,
  mat3FromQuat,
  quatAlignHemisphere,
  quatAngleBetween,
  quatCanonical,
  quatConjugate,
  quatDot,
  quatFromAxisAngle,
  quatFromMat3,
  quatFromUnitVectors,
  quatMultiply,
  quatNegate,
  quatNormalize,
  quatRotateVec3,
  quatSlerp,
  type Quat,
} from '../../src/core/math/quat.ts';
import {
  add,
  addScaled,
  cross,
  distance,
  dot,
  isFiniteVec3,
  length,
  lerp3,
  maxAbsComponent,
  mirrorX,
  negate,
  normalize,
  rejectFrom,
  scale,
  sub,
  UNIT_X,
  UNIT_Y,
  UNIT_Z,
  v3,
  type Vec3,
} from '../../src/core/math/vec3.ts';
import {
  bump,
  clamp,
  clamp01,
  deg,
  DEG,
  hermite,
  lerp,
  RAD2DEG,
  smootherstep,
  smootherstepDerivative,
  windowedSmootherstep,
} from '../../src/core/math/curves.ts';
import { createRng, type Rng } from '../../src/core/math/rng.ts';

// ---------------------------------------------------------------------------------------------
// Independent reference helpers (no calls into the code under test)
// ---------------------------------------------------------------------------------------------

type M3 = number[];

/** Rodrigues' rotation formula, row-major, for a unit axis. */
function rodrigues(axis: Vec3, angle: number): M3 {
  const [x, y, z] = axis;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const t = 1 - c;
  return [
    c + x * x * t, x * y * t - z * s, x * z * t + y * s,
    y * x * t + z * s, c + y * y * t, y * z * t - x * s,
    z * x * t - y * s, z * y * t + x * s, c + z * z * t,
  ];
}

function mm(a: M3, b: M3): M3 {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[r * 3 + k]! * b[k * 3 + c]!;
      o.push(s);
    }
  }
  return o;
}

function mv(m: M3, v: Vec3): Vec3 {
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

function unit(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** Quaternion [x,y,z,w] for a rotation of `angle` about unit `axis`, written out by hand. */
function qAxis(axis: Vec3, angle: number): Quat {
  const s = Math.sin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

/** Independent Hamilton product for reference values. */
function qmul(a: Quat, b: Quat): Quat {
  const [x1, y1, z1, w1] = a;
  const [x2, y2, z2, w2] = b;
  return [
    w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
    w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
    w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
  ];
}

/** Rotation angle of the relative rotation between two unit quaternions, computed with atan2 (exact near 0). */
function refAngle(a: Quat, b: Quat): number {
  const r = qmul([-a[0], -a[1], -a[2], a[3]], b);
  return 2 * Math.atan2(Math.hypot(r[0], r[1], r[2]), Math.abs(r[3]));
}

/** Shoemake uniform random unit quaternion. */
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
    const l = Math.hypot(v[0], v[1], v[2]);
    if (l > 0.1 && l <= 1) return [v[0] / l, v[1] / l, v[2] / l];
  }
}

function qnorm(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

/** Same rotation up to the q / -q double cover. */
function expectSameRotation(a: Quat, b: Quat, tol: number): void {
  const d = Math.min(maxAbsDiff(a, b), maxAbsDiff(a, [-b[0], -b[1], -b[2], -b[3]]));
  expect(d).toBeLessThanOrEqual(tol);
}

// ---------------------------------------------------------------------------------------------
// vec3
// ---------------------------------------------------------------------------------------------

describe('vec3', () => {
  it('basic arithmetic', () => {
    const a = v3(1, -2, 3);
    const b: Vec3 = [0.5, 4, -1];
    expect(add(a, b)).toEqual([1.5, 2, 2]);
    expect(sub(a, b)).toEqual([0.5, -6, 4]);
    expect(scale(a, -2)).toEqual([-2, 4, -6]);
    expect(addScaled(a, b, 2)).toEqual([2, 6, 1]);
    expect(dot(a, b)).toBe(0.5 - 8 - 3);
    expect(negate(a)).toEqual([-1, 2, -3]);
    expect(lerp3(a, b, 0)).toEqual(a);
    expect(lerp3(a, b, 1)).toEqual(b);
    expect(lerp3(a, b, 0.5)).toEqual([0.75, 1, 1]);
    expect(length([3, 4, 12])).toBe(13);
    expect(distance([1, 1, 1], [4, 5, 13])).toBe(13);
    expect(maxAbsComponent([-7, 2, 5])).toBe(7);
    expect(mirrorX([1, 2, 3])).toEqual([-1, 2, 3]);
  });

  it('cross product is right-handed and orthogonal to its inputs', () => {
    expect(cross(UNIT_X, UNIT_Y)).toEqual([0, 0, 1]);
    expect(cross(UNIT_Y, UNIT_Z)).toEqual([1, 0, 0]);
    expect(cross(UNIT_Z, UNIT_X)).toEqual([0, 1, 0]);
    const rng = createRng(11);
    for (let i = 0; i < 100; i++) {
      const a: Vec3 = [rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)];
      const b: Vec3 = [rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)];
      const c = cross(a, b);
      expect(Math.abs(dot(c, a))).toBeLessThan(1e-13);
      expect(Math.abs(dot(c, b))).toBeLessThan(1e-13);
      // |a x b|^2 = |a|^2 |b|^2 - (a.b)^2 (Lagrange identity)
      const lhs = dot(c, c);
      const rhs = dot(a, a) * dot(b, b) - dot(a, b) ** 2;
      expect(Math.abs(lhs - rhs)).toBeLessThan(1e-12);
    }
  });

  it('normalize returns a unit vector or the fallback for degenerate input', () => {
    const n = normalize([3, 0, 4]);
    expect(n[0]).toBeCloseTo(0.6, 15);
    expect(n[2]).toBeCloseTo(0.8, 15);
    expect(normalize([0, 0, 0])).toEqual(UNIT_Y);
    expect(normalize([1e-13, 0, 0], UNIT_Z)).toEqual(UNIT_Z);
    expect(normalize([Number.NaN, 0, 0], UNIT_X)).toEqual(UNIT_X);
  });

  it('rejectFrom removes the component along a unit normal', () => {
    const n = unit([1, 2, 2]);
    const r = rejectFrom([3, -1, 5], n);
    expect(Math.abs(dot(r, n))).toBeLessThan(1e-14);
    expect(rejectFrom([0, 5, 0], UNIT_Y)).toEqual([0, 0, 0]);
  });

  it('isFiniteVec3', () => {
    expect(isFiniteVec3([0, 1, 2])).toBe(true);
    expect(isFiniteVec3([0, Number.NaN, 2])).toBe(false);
    expect(isFiniteVec3([0, 1, Number.POSITIVE_INFINITY])).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// mat3
// ---------------------------------------------------------------------------------------------

describe('mat3', () => {
  it('multiply, transpose and determinant match hand computation', () => {
    const a: Mat3 = [1, 2, 3, 4, 5, 6, 7, 8, 10];
    const b: Mat3 = [2, 0, 1, -1, 3, 0, 0.5, 1, -2];
    // hand-expanded product
    expect(mat3Multiply(a, b)).toEqual([
      1 * 2 + 2 * -1 + 3 * 0.5, 1 * 0 + 2 * 3 + 3 * 1, 1 * 1 + 2 * 0 + 3 * -2,
      4 * 2 + 5 * -1 + 6 * 0.5, 4 * 0 + 5 * 3 + 6 * 1, 4 * 1 + 5 * 0 + 6 * -2,
      7 * 2 + 8 * -1 + 10 * 0.5, 7 * 0 + 8 * 3 + 10 * 1, 7 * 1 + 8 * 0 + 10 * -2,
    ]);
    expect(mat3Transpose(a)).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 10]);
    expect(mat3Determinant(a)).toBeCloseTo(-3, 12);
    expect(mat3Determinant(IDENTITY3)).toBe(1);
    expect(mat3MulVec(a, [1, 0, -1])).toEqual([-2, -2, -3]);
    expect(mat3Get(a, 2, 1)).toBe(8);
  });

  it('columns are the rotated basis vectors', () => {
    const m = mat3FromColumns([1, 2, 3], [4, 5, 6], [7, 8, 9]);
    expect(m).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
    expect(mat3Column(m, 0)).toEqual([1, 2, 3]);
    expect(mat3Column(m, 1)).toEqual([4, 5, 6]);
    expect(mat3Column(m, 2)).toEqual([7, 8, 9]);
    const r = mat3AxisRotation(2, 0.7);
    expect(maxAbsDiff(mat3MulVec(r, UNIT_X), mat3Column(r, 0))).toBe(0);
  });

  it('elementary rotations are right-handed and equal Rodrigues about the principal axes', () => {
    const axes: Vec3[] = [UNIT_X, UNIT_Y, UNIT_Z];
    for (const axis of [0, 1, 2] as const) {
      for (const ang of [-2.5, -0.3, 0, 0.4, 1.2, Math.PI]) {
        expect(maxAbsDiff(mat3AxisRotation(axis, ang), rodrigues(axes[axis]!, ang))).toBeLessThan(1e-15);
      }
    }
    // +90 deg right-handed: X: Y->Z, Y: Z->X, Z: X->Y
    const q = Math.PI / 2;
    expect(maxAbsDiff(mat3MulVec(mat3AxisRotation(0, q), UNIT_Y), UNIT_Z)).toBeLessThan(1e-15);
    expect(maxAbsDiff(mat3MulVec(mat3AxisRotation(1, q), UNIT_Z), UNIT_X)).toBeLessThan(1e-15);
    expect(maxAbsDiff(mat3MulVec(mat3AxisRotation(2, q), UNIT_X), UNIT_Y)).toBeLessThan(1e-15);
  });
});

// ---------------------------------------------------------------------------------------------
// quat
// ---------------------------------------------------------------------------------------------

describe('quat: algebra', () => {
  it('Hamilton basis identities i*j = k, j*k = i, k*i = j, i*i = -1', () => {
    const i: Quat = [1, 0, 0, 0];
    const j: Quat = [0, 1, 0, 0];
    const k: Quat = [0, 0, 1, 0];
    expect(quatMultiply(i, j)).toEqual([0, 0, 1, 0]);
    expect(quatMultiply(j, k)).toEqual([1, 0, 0, 0]);
    expect(quatMultiply(k, i)).toEqual([0, 1, 0, 0]);
    expect(quatMultiply(j, i)).toEqual([0, 0, -1, 0]);
    expect(quatMultiply(i, i)).toEqual([0, 0, 0, -1]);
  });

  it('matches an independent Hamilton product on random inputs', () => {
    const rng = createRng(1);
    for (let n = 0; n < 200; n++) {
      const a: Quat = [rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)];
      const b: Quat = [rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2), rng.range(-2, 2)];
      expect(maxAbsDiff(quatMultiply(a, b), qmul(a, b))).toBeLessThan(1e-14);
    }
  });

  it('identity is a two-sided unit; multiplication is associative and not commutative', () => {
    const rng = createRng(2);
    for (let n = 0; n < 200; n++) {
      const a = randomQuat(rng);
      const b = randomQuat(rng);
      const c = randomQuat(rng);
      expect(maxAbsDiff(quatMultiply(a, IDENTITY_Q), a)).toBe(0);
      expect(maxAbsDiff(quatMultiply(IDENTITY_Q, a), a)).toBe(0);
      expect(maxAbsDiff(quatMultiply(quatMultiply(a, b), c), quatMultiply(a, quatMultiply(b, c)))).toBeLessThan(1e-15);
    }
    const x = qAxis(UNIT_X, 0.8);
    const y = qAxis(UNIT_Y, 0.5);
    expect(maxAbsDiff(quatMultiply(x, y), quatMultiply(y, x))).toBeGreaterThan(0.05);
  });

  it('a*b applies b first, then a (matches matrix product and nested vector rotation)', () => {
    const rng = createRng(3);
    for (let n = 0; n < 200; n++) {
      const na = randomUnitVec(rng);
      const nb = randomUnitVec(rng);
      const ta = rng.range(-Math.PI, Math.PI);
      const tb = rng.range(-Math.PI, Math.PI);
      const ab = quatMultiply(qAxis(na, ta), qAxis(nb, tb));
      const refM = mm(rodrigues(na, ta), rodrigues(nb, tb));
      expect(maxAbsDiff(mat3FromQuat(ab), refM)).toBeLessThan(1e-14);
      const v: Vec3 = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
      expect(maxAbsDiff(quatRotateVec3(ab, v), mv(rodrigues(na, ta), mv(rodrigues(nb, tb), v)))).toBeLessThan(1e-14);
    }
  });

  it('conjugate is the inverse of a unit quaternion', () => {
    const rng = createRng(4);
    for (let n = 0; n < 200; n++) {
      const q = randomQuat(rng);
      const c = quatConjugate(q);
      expect(maxAbsDiff(quatMultiply(q, c), IDENTITY_Q)).toBeLessThan(1e-15);
      expect(maxAbsDiff(quatMultiply(c, q), IDENTITY_Q)).toBeLessThan(1e-15);
      const v: Vec3 = [rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)];
      expect(maxAbsDiff(quatRotateVec3(c, quatRotateVec3(q, v)), v)).toBeLessThan(1e-14);
    }
  });

  it('quatFromAxisAngle equals the half-angle formula; its matrix equals Rodrigues', () => {
    const rng = createRng(5);
    for (let n = 0; n < 200; n++) {
      const axis = randomUnitVec(rng);
      const ang = rng.range(-2 * Math.PI, 2 * Math.PI);
      const q = quatFromAxisAngle(axis, ang);
      expect(maxAbsDiff(q, qAxis(axis, ang))).toBeLessThan(1e-15);
      expect(Math.abs(qnorm(q) - 1)).toBeLessThan(1e-15);
      expect(maxAbsDiff(mat3FromQuat(q), rodrigues(axis, ang))).toBeLessThan(1e-14);
    }
  });

  it('quatRotateVec3 equals the Rodrigues matrix and preserves length', () => {
    const rng = createRng(6);
    for (let n = 0; n < 500; n++) {
      const axis = randomUnitVec(rng);
      const ang = rng.range(-Math.PI, Math.PI);
      const v: Vec3 = [rng.range(-3, 3), rng.range(-3, 3), rng.range(-3, 3)];
      const r = quatRotateVec3(qAxis(axis, ang), v);
      expect(maxAbsDiff(r, mv(rodrigues(axis, ang), v))).toBeLessThan(1e-14);
      expect(Math.abs(Math.hypot(...r) - Math.hypot(...v))).toBeLessThan(1e-14);
    }
    // q and -q rotate identically
    const q = qAxis(unit([1, 2, 3]), 1.1);
    expect(maxAbsDiff(quatRotateVec3(q, [1, 0, 0]), quatRotateVec3(quatNegate(q), [1, 0, 0]))).toBeLessThan(1e-15);
  });

  it('normalize / negate / canonical / alignHemisphere / dot / isFiniteQuat', () => {
    expect(quatNormalize([0, 0, 0, 0])).toEqual(IDENTITY_Q);
    expect(quatNormalize([Number.NaN, 0, 0, 1])).toEqual(IDENTITY_Q);
    const n = quatNormalize([0, 3, 0, 4]);
    expect(maxAbsDiff(n, [0, 0.6, 0, 0.8])).toBeLessThan(1e-16);
    expect(quatNegate([1, -2, 3, -4])).toEqual([-1, 2, -3, 4]);
    expect(quatCanonical([0.6, 0, 0, -0.8])).toEqual([-0.6, -0, -0, 0.8]);
    expect(quatCanonical([0.6, 0, 0, 0.8])).toEqual([0.6, 0, 0, 0.8]);
    const ref: Quat = [0, 0, 0.6, 0.8];
    expect(quatAlignHemisphere([0, 0, -0.6, -0.8], ref)).toEqual([-0, -0, 0.6, 0.8]);
    expect(quatAlignHemisphere([0, 0, 0.6, 0.8], ref)).toEqual([0, 0, 0.6, 0.8]);
    expect(quatDot([1, 2, 3, 4], [5, 6, 7, 8])).toBe(70);
    expect(isFiniteQuat([0, 0, 0, 1])).toBe(true);
    expect(isFiniteQuat([0, 0, Number.NaN, 1])).toBe(false);
    expect(isFiniteQuat([0, 0, 0, Number.NEGATIVE_INFINITY])).toBe(false);
  });
});

describe('quat: matrix conversions', () => {
  it('mat3FromQuat yields an orthonormal, det=+1 matrix for random unit quaternions', () => {
    const rng = createRng(7);
    for (let n = 0; n < 300; n++) {
      const m = mat3FromQuat(randomQuat(rng));
      const mtm = mm(mat3Transpose(m), m);
      expect(maxAbsDiff(mtm, IDENTITY3)).toBeLessThan(1e-14);
      expect(Math.abs(mat3Determinant(m) - 1)).toBeLessThan(1e-14);
    }
  });

  it('quatFromMat3 recovers the axis-angle quaternion (w >= 0, unit) for random rotations', () => {
    const rng = createRng(8);
    for (let n = 0; n < 1000; n++) {
      const axis = randomUnitVec(rng);
      const ang = rng.range(0, Math.PI - 1e-6); // w = cos(ang/2) > 0 -> unique canonical answer
      const q = quatFromMat3(rodrigues(axis, ang) as Mat3);
      expect(maxAbsDiff(q, qAxis(axis, ang))).toBeLessThan(1e-14);
      expect(q[3]).toBeGreaterThanOrEqual(0);
      expect(Math.abs(qnorm(q) - 1)).toBeLessThan(1e-15);
    }
  });

  it('mat3 -> quat -> mat3 round trip on random rotations', () => {
    const rng = createRng(9);
    for (let n = 0; n < 1000; n++) {
      const m = mat3FromQuat(randomQuat(rng));
      expect(maxAbsDiff(mat3FromQuat(quatFromMat3(m)), m)).toBeLessThan(1e-14);
    }
  });

  // Each case is checked to actually hit the intended Shepperd branch before testing the result.
  type Branch = 'trace' | 'x' | 'y' | 'z';
  function shepperdBranch(m: M3): Branch {
    const tr = m[0]! + m[4]! + m[8]!;
    if (tr > 0) return 'trace';
    if (m[0]! > m[4]! && m[0]! > m[8]!) return 'x';
    if (m[4]! > m[8]!) return 'y';
    return 'z';
  }
  const branchCases: { name: string; axis: Vec3; angle: number; branch: Branch }[] = [
    { name: 'small rotation', axis: unit([1, 2, 3]), angle: 0.3, branch: 'trace' },
    { name: 'identity', axis: UNIT_X, angle: 0, branch: 'trace' },
    { name: '119.9 deg (trace just > 0)', axis: unit([1, -1, 2]), angle: (119.9 * Math.PI) / 180, branch: 'trace' },
    { name: 'x-dominant 170 deg', axis: unit([0.9, 0.3, 0.1]), angle: (170 * Math.PI) / 180, branch: 'x' },
    { name: 'y-dominant 175 deg', axis: unit([0.2, -0.95, 0.1]), angle: (175 * Math.PI) / 180, branch: 'y' },
    { name: 'z-dominant 160 deg', axis: unit([-0.1, 0.25, 0.96]), angle: (160 * Math.PI) / 180, branch: 'z' },
    { name: 'exactly 180 deg about X', axis: UNIT_X, angle: Math.PI, branch: 'x' },
    { name: 'exactly 180 deg about Y', axis: UNIT_Y, angle: Math.PI, branch: 'y' },
    { name: 'exactly 180 deg about Z', axis: UNIT_Z, angle: Math.PI, branch: 'z' },
    { name: '180 deg about -Y', axis: [0, -1, 0], angle: Math.PI, branch: 'y' },
    { name: '180 deg about (1,-2,0.5)', axis: unit([1, -2, 0.5]), angle: Math.PI, branch: 'y' },
    { name: '180 deg - 1e-9 about (1,1,-3)', axis: unit([1, 1, -3]), angle: Math.PI - 1e-9, branch: 'z' },
    { name: '180 deg - 1e-12 about (-2,1,0.3)', axis: unit([-2, 1, 0.3]), angle: Math.PI - 1e-12, branch: 'x' },
    { name: '180 deg about (1,1,0) (tie m00 = m11)', axis: unit([1, 1, 0]), angle: Math.PI, branch: 'y' },
  ];
  for (const c of branchCases) {
    it(`Shepperd branch '${c.branch}': ${c.name}`, () => {
      const m = rodrigues(c.axis, c.angle);
      expect(shepperdBranch(m)).toBe(c.branch);
      const q = quatFromMat3(m as Mat3);
      expect(Math.abs(qnorm(q) - 1)).toBeLessThan(1e-15);
      expect(q[3]).toBeGreaterThanOrEqual(0);
      expectSameRotation(q, qAxis(c.axis, c.angle), 1e-14);
      expect(maxAbsDiff(mat3FromQuat(q), m)).toBeLessThan(1e-14);
    });
  }

  it("Shepperd branch 'z': exact 120 deg cyclic permutation (trace exactly 0, all diagonal ties)", () => {
    // 120 deg about (1,1,1)/sqrt(3) maps X->Y->Z->X; its matrix is exact in floating point.
    const m: Mat3 = [0, 0, 1, 1, 0, 0, 0, 1, 0];
    expect(shepperdBranch(m)).toBe('z');
    const q = quatFromMat3(m);
    expect(maxAbsDiff(q, [0.5, 0.5, 0.5, 0.5])).toBeLessThan(1e-15);
    expect(maxAbsDiff(quatRotateVec3(q, UNIT_X), UNIT_Y)).toBeLessThan(1e-15);
  });

  it('near-180 deg rotations about random axes round trip accurately', () => {
    const rng = createRng(10);
    for (let n = 0; n < 500; n++) {
      const axis = randomUnitVec(rng);
      const ang = Math.PI - 10 ** rng.range(-12, -2);
      const m = rodrigues(axis, ang);
      const q = quatFromMat3(m as Mat3);
      expectSameRotation(q, qAxis(axis, ang), 2e-14);
      expect(maxAbsDiff(mat3FromQuat(q), m)).toBeLessThan(2e-14);
    }
  });
});

describe('quat: slerp', () => {
  /** Reference slerp: a * exp(t * log(a^-1 b)) using the shortest arc, built from atan2 axis/angle. */
  function refSlerp(a: Quat, b0: Quat, t: number): Quat {
    const b: Quat = a[0] * b0[0] + a[1] * b0[1] + a[2] * b0[2] + a[3] * b0[3] < 0 ? [-b0[0], -b0[1], -b0[2], -b0[3]] : b0;
    const r = qmul([-a[0], -a[1], -a[2], a[3]], b);
    const s = Math.hypot(r[0], r[1], r[2]);
    if (s === 0) return a;
    const half = Math.atan2(s, r[3]);
    const axis: Vec3 = [r[0] / s, r[1] / s, r[2] / s];
    return qmul(a, qAxis(axis, 2 * half * t));
  }

  it('hits both endpoints (up to sign) and stays unit length', () => {
    const rng = createRng(20);
    for (let n = 0; n < 300; n++) {
      const a = randomQuat(rng);
      const b = randomQuat(rng);
      expect(maxAbsDiff(quatSlerp(a, b, 0), a)).toBeLessThan(1e-15);
      expectSameRotation(quatSlerp(a, b, 1), b, 1e-14);
      for (let k = 0; k <= 10; k++) {
        expect(Math.abs(qnorm(quatSlerp(a, b, k / 10)) - 1)).toBeLessThan(1e-14);
      }
    }
  });

  it('matches the exp/log reference (constant angular velocity along the geodesic)', () => {
    const rng = createRng(21);
    for (let n = 0; n < 300; n++) {
      const a = randomQuat(rng);
      const b = randomQuat(rng);
      const total = refAngle(a, b);
      for (let k = 0; k <= 8; k++) {
        const t = k / 8;
        const s = quatSlerp(a, b, t);
        expect(maxAbsDiff(s, refSlerp(a, b, t))).toBeLessThan(1e-13);
        // angle from a grows linearly in t and angle to b shrinks linearly
        expect(Math.abs(refAngle(a, s) - t * total)).toBeLessThan(1e-12);
        expect(Math.abs(refAngle(s, b) - (1 - t) * total)).toBeLessThan(1e-12);
      }
    }
  });

  it('takes the shortest path: slerp(a, b) and slerp(a, -b) are the same rotation', () => {
    const rng = createRng(22);
    for (let n = 0; n < 200; n++) {
      const a = randomQuat(rng);
      const b = randomQuat(rng);
      const total = refAngle(a, b); // <= pi by construction
      expect(total).toBeLessThanOrEqual(Math.PI + 1e-15);
      for (const t of [0.25, 0.5, 0.75]) {
        const s1 = quatSlerp(a, b, t);
        const s2 = quatSlerp(a, quatNegate(b), t);
        expectSameRotation(s1, s2, 1e-14);
        expect(quatDot(s1, a)).toBeGreaterThanOrEqual(0);
        expect(Math.abs(refAngle(a, s1) - t * total)).toBeLessThan(1e-12);
      }
    }
    // explicit: 350 deg about Z is -10 deg; the midpoint must be -5 deg, not 175 deg
    const a = IDENTITY_Q;
    const b = qAxis(UNIT_Z, (350 * Math.PI) / 180);
    expectSameRotation(quatSlerp(a, b, 0.5), qAxis(UNIT_Z, (-5 * Math.PI) / 180), 1e-15);
  });

  it('small-angle (nlerp) branch stays within 1e-9 of the exact geodesic', () => {
    const rng = createRng(23);
    for (let n = 0; n < 200; n++) {
      const a = randomQuat(rng);
      const axis = randomUnitVec(rng);
      const ang = 10 ** rng.range(-9, -2.72); // below and around the 0.9999995 cos-half threshold
      const b = qmul(a, qAxis(axis, ang));
      for (let k = 0; k <= 8; k++) {
        const s = quatSlerp(a, b, k / 8);
        expect(Math.abs(qnorm(s) - 1)).toBeLessThan(1e-15);
        expect(refAngle(s, refSlerp(a, b, k / 8))).toBeLessThan(1e-9);
      }
    }
  });

  it('is continuous across the nlerp / slerp switch', () => {
    const a = qAxis(unit([0.3, 1, -0.2]), 0.4);
    const axis = unit([1, 0.2, 0.5]);
    const threshold = 2 * Math.acos(0.9999995);
    for (const ang of [threshold * (1 - 1e-6), threshold * (1 + 1e-6)]) {
      const b = qmul(a, qAxis(axis, ang));
      expect(refAngle(quatSlerp(a, b, 0.37), refSlerp(a, b, 0.37))).toBeLessThan(1e-10);
    }
  });

  it('identical and antipodal inputs return the same rotation', () => {
    const a = qAxis(unit([1, 2, -1]), 0.9);
    for (const t of [0, 0.3, 1]) {
      expectSameRotation(quatSlerp(a, a, t), a, 1e-15);
      expectSameRotation(quatSlerp(a, quatNegate(a), t), a, 1e-15);
    }
  });
});

describe('quat: angleBetween', () => {
  it('equals the known rotation angle, is symmetric and sign-invariant', () => {
    const rng = createRng(30);
    for (let n = 0; n < 500; n++) {
      const a = randomQuat(rng);
      const axis = randomUnitVec(rng);
      const ang = rng.range(1e-3, Math.PI);
      const b = qmul(a, qAxis(axis, ang));
      const d = quatAngleBetween(a, b);
      expect(Math.abs(d - ang)).toBeLessThan(1e-12);
      expect(Math.abs(quatAngleBetween(b, a) - d)).toBeLessThan(1e-14);
      expect(Math.abs(quatAngleBetween(quatNegate(a), b) - d)).toBeLessThan(1e-14);
      expect(Math.abs(quatAngleBetween(a, quatNegate(b)) - d)).toBeLessThan(1e-14);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.PI);
    }
  });

  it('rotations beyond pi report the shorter angle (2pi - angle)', () => {
    const a = qAxis(UNIT_Y, 0.2);
    const b = qmul(a, qAxis(UNIT_Y, (300 * Math.PI) / 180));
    expect(quatAngleBetween(a, b)).toBeCloseTo((60 * Math.PI) / 180, 7);
  });

  it('keeps full precision for tiny angles (no acos sqrt(eps) floor)', () => {
    // A 2*acos(|dot|) formulation cannot resolve angles below ~3e-8 rad; the atan2 form must.
    const rng = createRng(31);
    for (let n = 0; n < 200; n++) {
      const q = randomQuat(rng);
      expect(quatAngleBetween(q, quatFromMat3(mat3FromQuat(q)))).toBeLessThan(1e-14);
      expect(quatAngleBetween(q, q)).toBeLessThan(1e-15);
      const axis = randomUnitVec(rng);
      for (const tiny of [1e-6, 1e-9, 1e-12]) {
        const d = quatAngleBetween(q, qmul(q, qAxis(axis, tiny)));
        expect(Math.abs(d - tiny) / tiny).toBeLessThan(1e-3);
      }
    }
    expect(quatAngleBetween(IDENTITY_Q, qAxis(UNIT_Z, 1e-10))).toBeCloseTo(1e-10, 20);
  });
});

describe('quat: fromUnitVectors', () => {
  it('maps from -> to along the shortest arc (axis orthogonal to both, angle = acos(from.to))', () => {
    const rng = createRng(40);
    for (let n = 0; n < 1000; n++) {
      const from = randomUnitVec(rng);
      const to = randomUnitVec(rng);
      const q = quatFromUnitVectors(from, to);
      expect(Math.abs(qnorm(q) - 1)).toBeLessThan(1e-15);
      expect(maxAbsDiff(quatRotateVec3(q, from), to)).toBeLessThan(1e-12);
      const c = cross(from, to);
      const expectedAngle = Math.atan2(Math.hypot(...c), dot(from, to));
      const angle = 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), q[3]);
      expect(Math.abs(angle - expectedAngle)).toBeLessThan(1e-12);
      // rotation axis is along from x to
      if (Math.hypot(...c) > 1e-6) {
        const ax = unit([q[0], q[1], q[2]]);
        expect(maxAbsDiff(ax, unit(c))).toBeLessThan(1e-9);
      }
    }
  });

  it('parallel vectors give the identity', () => {
    for (const v of [UNIT_X, UNIT_Y, UNIT_Z, unit([1, -2, 3])]) {
      expectSameRotation(quatFromUnitVectors(v, v), IDENTITY_Q, 1e-15);
    }
  });

  it('exactly antiparallel vectors give a 180 deg rotation about an orthogonal axis (both axis-choice branches)', () => {
    const rng = createRng(41);
    const cases: Vec3[] = [UNIT_X, [-1, 0, 0], UNIT_Y, [0, -1, 0], UNIT_Z, [0, 0, -1], unit([0.95, 0.3, 0.1]), unit([-0.1, 0.2, -0.97])];
    for (let n = 0; n < 200; n++) cases.push(randomUnitVec(rng));
    let sawXBranch = false;
    let sawOtherBranch = false;
    for (const from of cases) {
      if (Math.abs(from[0]) < 0.9) sawXBranch = true;
      else sawOtherBranch = true;
      const to = negate(from);
      const q = quatFromUnitVectors(from, to);
      expect(Math.abs(qnorm(q) - 1)).toBeLessThan(1e-15);
      expect(Math.abs(q[3])).toBeLessThan(1e-15);
      expect(Math.abs(dot([q[0], q[1], q[2]], from))).toBeLessThan(1e-15);
      expect(maxAbsDiff(quatRotateVec3(q, from), to)).toBeLessThan(1e-14);
    }
    expect(sawXBranch && sawOtherBranch).toBe(true);
  });

  it('far from antiparallel (>= 1e-4 rad) the result is exact to 1e-10', () => {
    const from = unit([0.6, 0.8, 0]);
    for (const delta of [1e-1, 1e-2, 1e-3, 1e-4]) {
      const to = mv(rodrigues(UNIT_Z, delta), negate(from));
      const q = quatFromUnitVectors(from, to);
      expect(maxAbsDiff(quatRotateVec3(q, from), to)).toBeLessThan(1e-10);
    }
  });

  // Regression (was a bug, fixed): the antiparallel threshold used to be dot < -1 + 1e-12, so vectors up to
  // ~1.41e-6 rad from antiparallel were mapped to -from (error 1.0e-6 at 1e-6 rad).
  it('near-antiparallel vectors (1e-5..1e-9 rad off) are still mapped onto `to` within 1e-7', () => {
    const from = unit([0.6, 0.8, 0]);
    for (const delta of [1e-5, 1.4e-6, 1e-6, 5e-7, 1e-7, 1e-8, 1e-9]) {
      const to = mv(rodrigues(UNIT_Z, delta), negate(from));
      const q = quatFromUnitVectors(from, to);
      expect(maxAbsDiff(quatRotateVec3(q, from), to)).toBeLessThan(1e-7);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// curves
// ---------------------------------------------------------------------------------------------

describe('curves', () => {
  const fd = (f: (x: number) => number, x: number, h = 1e-6): number => (f(x + h) - f(x - h)) / (2 * h);

  it('clamp / clamp01 / lerp', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.25, 0, 1)).toBe(0.25);
    expect(clamp(0, 0, 0)).toBe(0);
    expect(clamp(-2, -3, -1)).toBe(-2);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(-0.1)).toBe(0);
    expect(lerp(2, 6, 0.25)).toBe(3);
    expect(lerp(2, 6, 0)).toBe(2);
    expect(lerp(2, 6, 1)).toBe(6);
  });

  it('smootherstep boundary values, symmetry, monotonicity and clamping', () => {
    expect(smootherstep(0)).toBe(0);
    expect(smootherstep(1)).toBe(1);
    expect(smootherstep(0.5)).toBe(0.5);
    expect(smootherstep(-3)).toBe(0);
    expect(smootherstep(7)).toBe(1);
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000;
      const v = smootherstep(t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
      expect(Math.abs(smootherstep(1 - t) - (1 - v))).toBeLessThan(4e-15);
      // closed form 6t^5 - 15t^4 + 10t^3
      expect(Math.abs(v - (6 * t ** 5 - 15 * t ** 4 + 10 * t ** 3))).toBeLessThan(4e-15);
    }
  });

  it('smootherstepDerivative matches finite differences and vanishes (with curvature) at the ends', () => {
    for (let i = 1; i < 100; i++) {
      const t = i / 100;
      expect(Math.abs(smootherstepDerivative(t) - fd(smootherstep, t))).toBeLessThan(1e-8);
    }
    expect(smootherstepDerivative(0)).toBe(0);
    expect(smootherstepDerivative(1)).toBe(0);
    expect(smootherstepDerivative(0.5)).toBe(1.875);
    expect(smootherstepDerivative(-1)).toBe(0);
    expect(smootherstepDerivative(2)).toBe(0);
    // second derivative -> 0 at both ends (C2)
    const h = 1e-5;
    expect(Math.abs((smootherstepDerivative(h) - smootherstepDerivative(0)) / h)).toBeLessThan(1e-3);
    expect(Math.abs((smootherstepDerivative(1) - smootherstepDerivative(1 - h)) / h)).toBeLessThan(1e-3);
    // integral of the (degree-4) derivative over [0,1] = 1: 3-point Gauss-Legendre is exact to degree 5
    const g = Math.sqrt(3 / 5) / 2;
    const integral =
      (5 / 18) * smootherstepDerivative(0.5 - g) + (8 / 18) * smootherstepDerivative(0.5) + (5 / 18) * smootherstepDerivative(0.5 + g);
    expect(Math.abs(integral - 1)).toBeLessThan(1e-14);
  });

  it('windowedSmootherstep maps the window [a,b] onto [0,1]; degenerate window is a step', () => {
    expect(windowedSmootherstep(0.2, 0.2, 0.6)).toBe(0);
    expect(windowedSmootherstep(0.6, 0.2, 0.6)).toBe(1);
    expect(windowedSmootherstep(0.4, 0.2, 0.6)).toBeCloseTo(0.5, 15);
    expect(windowedSmootherstep(0.0, 0.2, 0.6)).toBe(0);
    expect(windowedSmootherstep(0.9, 0.2, 0.6)).toBe(1);
    expect(windowedSmootherstep(0.29, 0.3, 0.3)).toBe(0);
    expect(windowedSmootherstep(0.3, 0.3, 0.3)).toBe(1);
    expect(windowedSmootherstep(0.5, 0.6, 0.2)).toBe(0);
  });

  it('bump: 0 at ends, 1 at the middle, symmetric, and C2 at both ends', () => {
    expect(bump(0)).toBe(0);
    expect(bump(1)).toBe(0);
    expect(bump(0.5)).toBe(1);
    expect(bump(-1)).toBe(0);
    expect(bump(2)).toBe(0);
    let maxV = 0;
    for (let i = 0; i <= 1000; i++) {
      const t = i / 1000;
      const v = bump(t);
      maxV = Math.max(maxV, v);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(Math.abs(bump(1 - t) - v)).toBeLessThan(1e-15);
    }
    expect(maxV).toBe(1);
    // analytic derivative 192 v^2 (1 - 2x) vs finite differences
    for (let i = 1; i < 100; i++) {
      const x = i / 100;
      const vv = x * (1 - x);
      expect(Math.abs(fd(bump, x) - 192 * vv * vv * (1 - 2 * x))).toBeLessThan(1e-8);
    }
    // value, slope and curvature -> 0 at the ends: bump(h) = O(h^3)
    for (const h of [1e-2, 1e-3]) {
      expect(bump(h) / h ** 2).toBeLessThan(64 * h * 1.01);
      expect(bump(1 - h) / h ** 2).toBeLessThan(64 * h * 1.01);
    }
  });

  it('hermite: endpoint values and tangents, and exact reproduction of cubics', () => {
    const rng = createRng(50);
    for (let n = 0; n < 100; n++) {
      const [c0, c1, c2, c3] = [rng.range(-3, 3), rng.range(-3, 3), rng.range(-3, 3), rng.range(-3, 3)];
      const P = (s: number): number => c0 + c1 * s + c2 * s * s + c3 * s * s * s;
      const dP = (s: number): number => c1 + 2 * c2 * s + 3 * c3 * s * s;
      const H = (s: number): number => hermite(P(0), dP(0), P(1), dP(1), s);
      expect(H(0)).toBeCloseTo(P(0), 14);
      expect(H(1)).toBeCloseTo(P(1), 13);
      expect(Math.abs(fd(H, 0) - dP(0))).toBeLessThan(1e-7);
      expect(Math.abs(fd(H, 1) - dP(1))).toBeLessThan(1e-7);
      for (let k = 0; k <= 10; k++) expect(Math.abs(H(k / 10) - P(k / 10))).toBeLessThan(1e-13);
    }
    expect(hermite(2, 0, 5, 0, 0.5)).toBe(3.5);
  });

  it('degree conversions', () => {
    expect(deg(180)).toBe(Math.PI);
    expect(DEG * 90).toBe(Math.PI / 2);
    expect(RAD2DEG * Math.PI).toBe(180);
    expect(deg(1) * RAD2DEG).toBeCloseTo(1, 15);
  });
});

// ---------------------------------------------------------------------------------------------
// rng
// ---------------------------------------------------------------------------------------------

describe('rng (mulberry32)', () => {
  /** Independent mulberry32 in BigInt arithmetic (mod 2^32), per the reference C implementation. */
  function refMulberry32(seed: number, count: number): number[] {
    const M = 0xffffffffn;
    let state = BigInt(seed >>> 0);
    const out: number[] = [];
    for (let i = 0; i < count; i++) {
      state = (state + 0x6d2b79f5n) & M;
      let z = state;
      z = ((z ^ (z >> 15n)) * (z | 1n)) & M;
      z = (z ^ ((z + (((z ^ (z >> 7n)) * (z | 61n)) & M)) & M)) & M;
      z = (z ^ (z >> 14n)) & M;
      out.push(Number(z) / 4294967296);
    }
    return out;
  }

  it('matches an independent BigInt mulberry32 bit-for-bit', () => {
    for (const seed of [0, 1, 42, 123456789, 0xdeadbeef, 0xffffffff]) {
      const rng = createRng(seed);
      const ref = refMulberry32(seed, 2000);
      for (const r of ref) expect(rng.next()).toBe(r);
    }
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = createRng(7);
    const b = createRng(7);
    const c = createRng(8);
    const sa = Array.from({ length: 100 }, () => a.next());
    const sb = Array.from({ length: 100 }, () => b.next());
    const sc = Array.from({ length: 100 }, () => c.next());
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(new Set(sa).size).toBe(100);
  });

  it('seeds are reduced modulo 2^32', () => {
    const x = createRng(-1);
    const y = createRng(0xffffffff);
    const z0 = createRng(2 ** 32);
    const z1 = createRng(0);
    for (let i = 0; i < 20; i++) {
      expect(x.next()).toBe(y.next());
      expect(z0.next()).toBe(z1.next());
    }
  });

  it('next/range/int/pick respect their bounds', () => {
    const rng = createRng(99);
    const seenInt = new Set<number>();
    const seenPick = new Set<string>();
    const items = ['a', 'b', 'c', 'd', 'e'] as const;
    for (let i = 0; i < 20000; i++) {
      const u = rng.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      const r = rng.range(-2.5, 4);
      expect(r).toBeGreaterThanOrEqual(-2.5);
      expect(r).toBeLessThan(4);
      const k = rng.int(-3, 3);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(-3);
      expect(k).toBeLessThanOrEqual(3);
      seenInt.add(k);
      seenPick.add(rng.pick(items));
    }
    expect([...seenInt].sort((p, q) => p - q)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
    expect([...seenPick].sort()).toEqual([...items]);
    expect(rng.int(5, 5)).toBe(5);
    expect(() => rng.pick([])).toThrow();
  });

  it('distribution sanity: mean, variance, 20-bin chi-square and lag-1 correlation', () => {
    const rng = createRng(2024);
    const N = 200_000;
    const bins = new Array<number>(20).fill(0);
    let sum = 0;
    let sumSq = 0;
    let lag = 0;
    let prev = rng.next();
    for (let i = 0; i < N; i++) {
      const u = rng.next();
      sum += u;
      sumSq += u * u;
      lag += (u - 0.5) * (prev - 0.5);
      prev = u;
      bins[Math.floor(u * 20)]! += 1;
    }
    const mean = sum / N;
    const variance = sumSq / N - mean * mean;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.005); // sd of mean ~ 6.5e-4
    expect(Math.abs(variance - 1 / 12)).toBeLessThan(0.002);
    const expected = N / 20;
    const chi2 = bins.reduce((acc, o) => acc + (o - expected) ** 2 / expected, 0);
    expect(chi2).toBeLessThan(43.8); // 99.9th percentile of chi-square with 19 dof
    expect(Math.abs(lag / N / (1 / 12))).toBeLessThan(0.02);
    // int() is uniform over its range
    const counts = new Array<number>(6).fill(0);
    for (let i = 0; i < 60_000; i++) counts[rng.int(0, 5)]! += 1;
    const chi2i = counts.reduce((acc, o) => acc + (o - 10_000) ** 2 / 10_000, 0);
    expect(chi2i).toBeLessThan(20.5); // 99.9th percentile, 5 dof
  });
});
