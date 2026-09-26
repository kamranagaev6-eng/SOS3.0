/**
 * Independent tests for the intrinsic Tait–Bryan conversions in src/core/math/euler.ts.
 * Reference matrices are built here with Rodrigues' formula and explicit matrix products.
 */
import { describe, expect, it } from 'vitest';
import {
  eulerAlternate,
  eulerFromMat3,
  isValidOrder,
  mat3FromEuler,
  wrapAngle,
  type EulerOrder,
} from '../../src/core/math/euler.ts';
import type { Mat3 } from '../../src/core/math/mat3.ts';
import { createRng, type Rng } from '../../src/core/math/rng.ts';

type M3 = number[];
type V3 = [number, number, number];

const AXIS: readonly V3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function rodrigues(axis: V3, angle: number): M3 {
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

/** Intrinsic R = R_{o0}(a0) R_{o1}(a1) R_{o2}(a2) from Rodrigues matrices (independent of mat3FromEuler). */
function refEuler(order: EulerOrder, a: readonly number[]): M3 {
  return mm(mm(rodrigues(AXIS[order[0]]!, a[0]!), rodrigues(AXIS[order[1]]!, a[1]!)), rodrigues(AXIS[order[2]]!, a[2]!));
}

function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}

/** Signed difference wrapped to (-pi, pi]. */
function angDiff(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function randomRotation(rng: Rng): M3 {
  const u1 = rng.next();
  const u2 = rng.next();
  const u3 = rng.next();
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  const [x, y, z, w] = [a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2), b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3)];
  // quaternion -> matrix written out independently
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

const ORDERS: { name: string; order: EulerOrder; even: boolean }[] = [
  { name: 'XYZ', order: [0, 1, 2], even: true },
  { name: 'YZX', order: [1, 2, 0], even: true },
  { name: 'ZXY', order: [2, 0, 1], even: true },
  { name: 'XZY', order: [0, 2, 1], even: false },
  { name: 'ZYX', order: [2, 1, 0], even: false },
  { name: 'YXZ', order: [1, 0, 2], even: false },
];

describe('isValidOrder', () => {
  it('accepts exactly the six permutations of {0,1,2}', () => {
    for (const o of ORDERS) expect(isValidOrder(o.order)).toBe(true);
    for (const bad of [[0, 0, 1], [0, 1], [0, 1, 2, 0], [0, 1, 3], [], [2, 2, 2], [-1, 0, 1], [0.5, 1, 2]]) {
      expect(isValidOrder(bad)).toBe(false);
    }
  });
});

describe('mat3FromEuler', () => {
  it('equals the intrinsic product of Rodrigues matrices for all six orders', () => {
    const rng = createRng(100);
    for (const { order } of ORDERS) {
      for (let n = 0; n < 200; n++) {
        const a = [rng.range(-4, 4), rng.range(-4, 4), rng.range(-4, 4)] as const;
        expect(maxAbsDiff(mat3FromEuler(order, a), refEuler(order, a))).toBeLessThan(1e-14);
      }
    }
  });

  it('is intrinsic (first angle is the outermost factor): XYZ [pi/2, pi/2, 0] maps +Z to +X', () => {
    // Rx(90) Ry(90): Ry(90) sends Z -> X, then Rx(90) leaves X unchanged -> X.
    const m = mat3FromEuler([0, 1, 2], [Math.PI / 2, Math.PI / 2, 0]);
    const z: V3 = [m[2], m[5], m[8]]; // image of +Z = third column
    expect(maxAbsDiff(z, [1, 0, 0])).toBeLessThan(1e-15);
    // extrinsic interpretation would give Ry(90) Rx(90) Z = Ry(90) (-Y) = -Y
  });
});

describe('eulerFromMat3', () => {
  for (const { name, order, even } of ORDERS) {
    it(`${name} (${even ? 'even' : 'odd'}): single-axis rotations land in the right slot with the right sign`, () => {
      for (let slot = 0; slot < 3; slot++) {
        for (const ang of [-1.2, -0.3, 0.4, 1.1]) {
          const m = rodrigues(AXIS[order[slot]!]!, ang);
          const e = eulerFromMat3(order, m as Mat3);
          const expected = [0, 0, 0];
          expected[slot] = ang;
          expect(maxAbsDiff(e, expected)).toBeLessThan(1e-14);
        }
      }
    });

    it(`${name}: seeded random angles (middle in (-pi/2, pi/2)) round trip exactly`, () => {
      const rng = createRng(200 + order[0] * 9 + order[1] * 3 + order[2]);
      for (let n = 0; n < 2000; n++) {
        const a: [number, number, number] = [
          rng.range(-Math.PI + 1e-9, Math.PI - 1e-9),
          rng.range(-Math.PI / 2 + 1e-4, Math.PI / 2 - 1e-4),
          rng.range(-Math.PI + 1e-9, Math.PI - 1e-9),
        ];
        const m = refEuler(order, a);
        const e = eulerFromMat3(order, m as Mat3);
        expect(Math.abs(angDiff(e[0], a[0]))).toBeLessThan(1e-10);
        expect(Math.abs(e[1] - a[1])).toBeLessThan(1e-10);
        expect(Math.abs(angDiff(e[2], a[2]))).toBeLessThan(1e-10);
        expect(maxAbsDiff(refEuler(order, e), m)).toBeLessThan(1e-14);
      }
    });

    it(`${name}: arbitrary rotation matrices decompose into a valid triple that recomposes`, () => {
      const rng = createRng(300 + order[0] * 9 + order[1] * 3 + order[2]);
      for (let n = 0; n < 2000; n++) {
        const m = randomRotation(rng);
        const e = eulerFromMat3(order, m as Mat3);
        expect(e[1]).toBeGreaterThanOrEqual(-Math.PI / 2);
        expect(e[1]).toBeLessThanOrEqual(Math.PI / 2);
        for (const x of e) {
          expect(Number.isFinite(x)).toBe(true);
          expect(Math.abs(x)).toBeLessThanOrEqual(Math.PI);
        }
        expect(maxAbsDiff(refEuler(order, e), m)).toBeLessThan(1e-14);
      }
    });

    it(`${name}: exact gimbal lock (middle = +-pi/2) reproduces the same matrix`, () => {
      const rng = createRng(400 + order[0] * 9 + order[1] * 3 + order[2]);
      for (const sgn of [1, -1]) {
        for (let n = 0; n < 200; n++) {
          const a = [rng.range(-Math.PI, Math.PI), (sgn * Math.PI) / 2, rng.range(-Math.PI, Math.PI)];
          // clean the cos(pi/2) = 6e-17 residue so the input is an exactly-locked rotation matrix
          const m = refEuler(order, a).map((v) => (Math.abs(v) < 1e-15 ? 0 : v));
          const e = eulerFromMat3(order, m as Mat3);
          expect(Math.abs(e[1] - a[1]!)).toBeLessThan(1e-15);
          expect(maxAbsDiff(refEuler(order, e), m)).toBeLessThan(1e-14);
        }
      }
    });

    // Regression (was a bug, fixed): the gimbal branch used to trigger for |sin(mid)| >= 1 - 1e-12, i.e.
    // cos(mid) <= 1.41e-6, and set the last angle to 0, giving reconstruction errors up to 1.6e-6.
    it(`${name}: near gimbal lock (middle within 1e-5..1e-12 of +-pi/2) still reproduces the matrix`, () => {
      const rng = createRng(500 + order[0] * 9 + order[1] * 3 + order[2]);
      for (const delta of [1e-5, 3e-6, 1.4e-6, 1e-6, 3e-7, 1e-7, 1e-8, 1e-9, 1e-10, 1e-12]) {
        for (const sgn of [1, -1]) {
          for (let n = 0; n < 20; n++) {
            const a = [rng.range(-Math.PI, Math.PI), sgn * (Math.PI / 2 - delta), rng.range(-Math.PI, Math.PI)];
            const m = refEuler(order, a);
            const e = eulerFromMat3(order, m as Mat3);
            expect(maxAbsDiff(refEuler(order, e), m)).toBeLessThan(1e-13);
          }
        }
      }
    });
  }

  it('exactly locked XYZ matrix: first angle is 0 by convention and c carries a+c', () => {
    // Rx(a) Ry(pi/2) Rz(c) = [[0,0,1],[sin(a+c), cos(a+c), 0],[-cos(a+c), sin(a+c), 0]]
    const th = 0.8;
    const m = [0, 0, 1, Math.sin(th), Math.cos(th), 0, -Math.cos(th), Math.sin(th), 0];
    const e = eulerFromMat3([0, 1, 2], m as Mat3);
    expect(Math.abs(e[0])).toBe(0);
    expect(e[1]).toBe(Math.PI / 2);
    expect(e[2]).toBeCloseTo(th, 15);
  });
});

describe('eulerAlternate / wrapAngle', () => {
  it('wrapAngle maps into (-pi, pi] and is 2pi-periodic', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBe(Math.PI);
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
    expect(wrapAngle(1)).toBe(1);
    expect(wrapAngle(-1)).toBe(-1);
    const rng = createRng(600);
    for (let n = 0; n < 1000; n++) {
      const x = rng.range(-Math.PI, Math.PI);
      const k = rng.int(-5, 5);
      const w = wrapAngle(x + 2 * Math.PI * k);
      expect(w).toBeGreaterThan(-Math.PI);
      expect(w).toBeLessThanOrEqual(Math.PI);
      expect(Math.abs(angDiff(w, x))).toBeLessThan(1e-13);
    }
  });

  it('the alternate branch describes the same rotation with |middle| >= pi/2', () => {
    const rng = createRng(601);
    for (const { order } of ORDERS) {
      for (let n = 0; n < 500; n++) {
        const m = randomRotation(rng);
        const e = eulerFromMat3(order, m as Mat3);
        const alt = eulerAlternate(e);
        expect(Math.abs(alt[1])).toBeGreaterThanOrEqual(Math.PI / 2 - 1e-15);
        for (const x of alt) {
          expect(x).toBeGreaterThan(-Math.PI);
          expect(x).toBeLessThanOrEqual(Math.PI);
        }
        expect(maxAbsDiff(refEuler(order, alt), m)).toBeLessThan(1e-14);
        // applying it twice returns to the canonical triple
        expect(maxAbsDiff(eulerAlternate(alt).map((v, i) => angDiff(v, e[i]!)), [0, 0, 0])).toBeLessThan(1e-14);
      }
    }
  });

  it('recovers a middle angle beyond 90 deg (e.g. 120 deg shoulder abduction) from the alternate branch', () => {
    const order: EulerOrder = [0, 2, 1];
    const a = [0.3, (120 * Math.PI) / 180, 0.2];
    const e = eulerFromMat3(order, refEuler(order, a) as Mat3);
    expect(Math.abs(e[1])).toBeLessThanOrEqual(Math.PI / 2);
    const alt = eulerAlternate(e);
    expect(maxAbsDiff(alt.map((v, i) => angDiff(v, a[i]!)), [0, 0, 0])).toBeLessThan(1e-12);
  });
});
