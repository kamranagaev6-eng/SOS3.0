import type { Vec3 } from './vec3.ts';

/**
 * Row-major 3x3 matrix: m[r * 3 + c]. For rotation matrices the COLUMNS are the
 * rotated basis vectors (x-axis, y-axis, z-axis of the local frame in world coordinates).
 */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3FromColumns(x: Vec3, y: Vec3, z: Vec3): Mat3 {
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

export function mat3Column(m: Mat3, c: 0 | 1 | 2): Vec3 {
  return [m[c] as number, m[3 + c] as number, m[6 + c] as number];
}

export function mat3Get(m: Mat3, r: number, c: number): number {
  return m[r * 3 + c] as number;
}

export function mat3Multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        (a[r * 3] as number) * (b[c] as number) +
        (a[r * 3 + 1] as number) * (b[3 + c] as number) +
        (a[r * 3 + 2] as number) * (b[6 + c] as number);
    }
  }
  return out as unknown as Mat3;
}

export function mat3Transpose(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mat3MulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function mat3Determinant(m: Mat3): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

/** Elementary rotation about a principal axis (0 = X, 1 = Y, 2 = Z). */
export function mat3AxisRotation(axis: 0 | 1 | 2, angle: number): Mat3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  switch (axis) {
    case 0:
      return [1, 0, 0, 0, c, -s, 0, s, c];
    case 1:
      return [c, 0, s, 0, 1, 0, -s, 0, c];
    case 2:
      return [c, -s, 0, s, c, 0, 0, 0, 1];
  }
}
