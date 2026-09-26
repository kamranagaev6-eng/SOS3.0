import type { Mat3 } from './mat3.ts';
import type { Vec3 } from './vec3.ts';

/** Unit quaternion `[x, y, z, w]` (same component order as glTF and Three.js). */
export type Quat = [number, number, number, number];

export const IDENTITY_Q: Quat = [0, 0, 0, 1];

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const h = angle / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

/** Hamilton product a * b (rotation b applied first, then a). */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

export function quatDot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

export function quatNormalize(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!(l > 0)) return IDENTITY_Q;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export function quatNegate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], -q[3]];
}

/** Canonical hemisphere (w >= 0). q and -q are the same rotation. */
export function quatCanonical(q: Quat): Quat {
  return q[3] < 0 ? quatNegate(q) : q;
}

/** Choose the sign of `q` closest to `reference` (for continuous animation tracks). */
export function quatAlignHemisphere(q: Quat, reference: Quat): Quat {
  return quatDot(q, reference) < 0 ? quatNegate(q) : q;
}

export function quatRotateVec3(q: Quat, v: Vec3): Vec3 {
  // v' = v + 2w (u x v) + 2 u x (u x v)
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * v[2] - qz * v[1]);
  const ty = 2 * (qz * v[0] - qx * v[2]);
  const tz = 2 * (qx * v[1] - qy * v[0]);
  return [
    v[0] + qw * tx + (qy * tz - qz * ty),
    v[1] + qw * ty + (qz * tx - qx * tz),
    v[2] + qw * tz + (qx * ty - qy * tx),
  ];
}

/** Geodesic angle between two rotations, in [0, pi]. */
export function quatAngleBetween(a: Quat, b: Quat): number {
  const d = Math.min(1, Math.abs(quatDot(a, b)));
  return 2 * Math.acos(d);
}

export function mat3FromQuat(q: Quat): Mat3 {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy),
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx),
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy),
  ];
}

/** Shepperd's method; robust for all rotation matrices. Result has w >= 0. */
export function quatFromMat3(m: Mat3): Quat {
  const m00 = m[0], m01 = m[1], m02 = m[2];
  const m10 = m[3], m11 = m[4], m12 = m[5];
  const m20 = m[6], m21 = m[7], m22 = m[8];
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return quatCanonical(quatNormalize(q));
}

/** Shortest-path spherical interpolation. */
export function quatSlerp(a: Quat, b0: Quat, t: number): Quat {
  let b = b0;
  let cosHalf = quatDot(a, b);
  if (cosHalf < 0) {
    b = quatNegate(b);
    cosHalf = -cosHalf;
  }
  if (cosHalf > 0.9999995) {
    return quatNormalize([
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
      a[3] + (b[3] - a[3]) * t,
    ]);
  }
  const half = Math.acos(cosHalf);
  const sinHalf = Math.sqrt(1 - cosHalf * cosHalf);
  const ra = Math.sin((1 - t) * half) / sinHalf;
  const rb = Math.sin(t * half) / sinHalf;
  return [a[0] * ra + b[0] * rb, a[1] * ra + b[1] * rb, a[2] * ra + b[2] * rb, a[3] * ra + b[3] * rb];
}

/** Rotation taking unit vector `from` to unit vector `to` along the shortest arc. */
export function quatFromUnitVectors(from: Vec3, to: Vec3): Quat {
  const d = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
  if (d < -1 + 1e-12) {
    // 180 degrees: pick any axis orthogonal to `from`.
    const axis: Vec3 = Math.abs(from[0]) < 0.9 ? [0, -from[2], from[1]] : [-from[2], 0, from[0]];
    const l = Math.hypot(axis[0], axis[1], axis[2]);
    return [axis[0] / l, axis[1] / l, axis[2] / l, 0];
  }
  const c: Vec3 = [from[1] * to[2] - from[2] * to[1], from[2] * to[0] - from[0] * to[2], from[0] * to[1] - from[1] * to[0]];
  return quatNormalize([c[0], c[1], c[2], 1 + d]);
}

export function isFiniteQuat(q: Quat): boolean {
  return Number.isFinite(q[0]) && Number.isFinite(q[1]) && Number.isFinite(q[2]) && Number.isFinite(q[3]);
}
