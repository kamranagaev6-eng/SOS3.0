import { mat3AxisRotation, mat3Multiply, type Mat3, IDENTITY3 } from './mat3.ts';

/**
 * Intrinsic Tait–Bryan angles for any of the six orders of distinct principal axes.
 *
 * R = R_{order[0]}(a0) * R_{order[1]}(a1) * R_{order[2]}(a2)
 *
 * Decomposition reduces every order to XYZ by conjugating with the axis permutation P:
 *   even permutation (proper P):   P R Pᵀ = Rx(a0) Ry(a1) Rz(a2)
 *   odd permutation (improper P):  P R Pᵀ = Rx(-a0) Ry(-a1) Rz(-a2)
 * because conjugating by a reflection negates rotation angles (axes are pseudovectors).
 * The middle angle lies in [-pi/2, pi/2]; at gimbal lock the first angle is 0 by convention.
 * The other solution branch is (a0 + π, π − a1, a2 + π) (mod 2π); see eulerAlternate().
 */
export type AxisIndex = 0 | 1 | 2;
export type EulerOrder = [AxisIndex, AxisIndex, AxisIndex];

export function isValidOrder(order: readonly number[]): order is EulerOrder {
  return (
    order.length === 3 &&
    order.every((a) => a === 0 || a === 1 || a === 2) &&
    new Set(order).size === 3
  );
}

function isEven(order: EulerOrder): boolean {
  return (order[1] - order[0] + 3) % 3 === 1;
}

export function mat3FromEuler(order: EulerOrder, angles: readonly [number, number, number]): Mat3 {
  let m: Mat3 = IDENTITY3;
  for (let i = 0; i < 3; i++) {
    m = mat3Multiply(m, mat3AxisRotation(order[i] as AxisIndex, angles[i] as number));
  }
  return m;
}

export function eulerFromMat3(order: EulerOrder, r: Mat3): [number, number, number] {
  const p = order;
  const g = (row: number, col: number): number => r[(p[row] as number) * 3 + (p[col] as number)] as number;
  // M[m][n] = R[p[m]][p[n]] = Rx(a) Ry(b) Rz(c). Extraction that is exact everywhere, including
  // at and near gimbal lock: a from row/col 2, b via atan2 with hypot, then c from Rx(a)ᵀ M.
  const a = Math.atan2(-g(1, 2), g(2, 2));
  const b = Math.atan2(g(0, 2), Math.hypot(g(0, 0), g(0, 1)));
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const c = Math.atan2(ca * g(1, 0) + sa * g(2, 0), ca * g(1, 1) + sa * g(2, 1));
  return isEven(order) ? [a, b, c] : [-a, -b, -c];
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  else if (x > Math.PI) x -= 2 * Math.PI;
  return x;
}

/** The second Tait–Bryan solution (same rotation, middle angle outside [-π/2, π/2]). */
export function eulerAlternate(e: readonly [number, number, number]): [number, number, number] {
  return [wrapAngle(e[0] + Math.PI), wrapAngle(Math.PI - e[1]), wrapAngle(e[2] + Math.PI)];
}
