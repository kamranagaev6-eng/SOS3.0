import type { AxisLabel } from '../contracts/hostRig.ts';
import type { Mat3 } from '../math/mat3.ts';
import type { Quat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';

/**
 * Host → canonical coordinate conversion.
 *
 * A host declares which of ITS axes points up, toward the subject's front and toward the subject's
 * left. Canonical space is right-handed with left = +X, up = +Y, forward = +Z (glTF axes, metres).
 *
 * The basis matrix B maps a host vector to canonical axes; its rows are the host's left, up and
 * forward unit vectors:  canonical = B · host,  host = Bᵀ · canonical.
 * B is a signed permutation, so every conversion here is exact (component shuffles and sign
 * flips, no rounding) apart from the unit scale.
 *
 * Handedness: canonical requires left × up = forward. A host whose labels give
 * left × up = −forward describes a mirrored (left-handed) subject; converting it would need a
 * reflection, which cannot be expressed as rotations, so it is rejected rather than silently
 * mirrored.
 *
 * Rotations convert by conjugation, R_c = B R_h Bᵀ. For a proper rotation B this maps the
 * quaternion (v, w) to (B·v, w) exactly: conjugating by a rotation rotates the rotation axis.
 */
export type LengthUnit = 'm' | 'cm' | 'mm';

/** Metres per host unit. */
export const METRES_PER_UNIT: Readonly<Record<LengthUnit, number>> = { m: 1, cm: 0.01, mm: 0.001 };

export interface AxisConvention {
  units: LengthUnit;
  up: AxisLabel;
  forward: AxisLabel;
  left: AxisLabel;
}

interface SignedAxis {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
}

function parseAxis(label: AxisLabel): SignedAxis {
  const sign = label[0] === '-' ? -1 : 1;
  const axis = label[1] === 'X' ? 0 : label[1] === 'Y' ? 1 : 2;
  return { axis, sign };
}

export function axisVector(label: AxisLabel): Vec3 {
  const { axis, sign } = parseAxis(label);
  const v: Vec3 = [0, 0, 0];
  v[axis] = sign;
  return v;
}

export interface HostBasis {
  readonly convention: Readonly<AxisConvention>;
  /** Metres per host unit. */
  readonly scale: number;
  /** Row-major host → canonical rotation matrix (rows: host left, up, forward). det = +1. */
  readonly matrix: Mat3;
  /** Host direction → canonical direction (no unit scale). */
  dirToCanonical(v: readonly number[]): Vec3;
  /** Canonical direction → host direction (no unit scale). */
  dirToHost(v: readonly number[]): Vec3;
  /** Host position/translation (host units) → canonical metres. */
  vecToCanonical(v: readonly number[]): Vec3;
  /** Canonical metres → host units. */
  vecToHost(v: readonly number[]): Vec3;
  /** Host-axes rotation → canonical-axes rotation (conjugation by B). */
  quatToCanonical(q: readonly number[]): Quat;
  /** Canonical-axes rotation → host-axes rotation (conjugation by Bᵀ). */
  quatToHost(q: readonly number[]): Quat;
}

export type BasisResult =
  | { ok: true; basis: HostBasis }
  | { ok: false; problem: 'degenerate' | 'left-handed'; message: string; hint: string };

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** True when the labels use three distinct axes and satisfy left × up = forward. */
export function isRightHandedConvention(c: Pick<AxisConvention, 'up' | 'forward' | 'left'>): boolean {
  const r = createHostBasis({ units: 'm', ...c });
  return r.ok;
}

export function createHostBasis(conv: AxisConvention): BasisResult {
  const L = parseAxis(conv.left);
  const U = parseAxis(conv.up);
  const F = parseAxis(conv.forward);
  if (new Set([L.axis, U.axis, F.axis]).size !== 3) {
    return {
      ok: false,
      problem: 'degenerate',
      message: `axis labels up=${conv.up}, forward=${conv.forward}, left=${conv.left} do not name three distinct axes`,
      hint: 'up, forward and left must each use a different host axis (X, Y, Z).',
    };
  }
  const l = axisVector(conv.left);
  const u = axisVector(conv.up);
  const f = axisVector(conv.forward);
  const c = cross(l, u);
  const handed = c[0] * f[0] + c[1] * f[1] + c[2] * f[2];
  if (handed < 0) {
    const flipped = (conv.left[0] === '-' ? '+' : '-') + conv.left[1];
    return {
      ok: false,
      problem: 'left-handed',
      message:
        `axis labels up=${conv.up}, forward=${conv.forward}, left=${conv.left} describe a left-handed (mirrored) frame: ` +
        `left × up = −forward. Converting it would require a reflection, which rotations cannot express.`,
      hint:
        `Export the skeleton in a right-handed frame (e.g. glTF: up +Y, forward +Z, left +X), or check the labels: ` +
        `with up=${conv.up} and forward=${conv.forward} the subject's left is ${flipped}.`,
    };
  }
  const s = METRES_PER_UNIT[conv.units];
  const matrix: Mat3 = [l[0], l[1], l[2], u[0], u[1], u[2], f[0], f[1], f[2]];
  // `+ 0` turns −0 into +0 so sign flips of zero components never leak into output data.
  const toC = (v: readonly number[]): Vec3 => [L.sign * (v[L.axis] ?? 0) + 0, U.sign * (v[U.axis] ?? 0) + 0, F.sign * (v[F.axis] ?? 0) + 0];
  const toH = (v: readonly number[]): Vec3 => {
    const out: Vec3 = [0, 0, 0];
    out[L.axis] = L.sign * (v[0] ?? 0) + 0;
    out[U.axis] = U.sign * (v[1] ?? 0) + 0;
    out[F.axis] = F.sign * (v[2] ?? 0) + 0;
    return out;
  };
  const basis: HostBasis = {
    convention: { ...conv },
    scale: s,
    matrix,
    dirToCanonical: toC,
    dirToHost: toH,
    vecToCanonical: (v) => {
      const d = toC(v);
      return s === 1 ? d : [d[0] * s, d[1] * s, d[2] * s];
    },
    vecToHost: (v) => {
      const d = toH(v);
      return s === 1 ? d : [d[0] / s, d[1] / s, d[2] / s];
    },
    quatToCanonical: (q) => {
      const v = toC(q);
      return [v[0], v[1], v[2], q[3] ?? 1];
    },
    quatToHost: (q) => {
      const v = toH(q);
      return [v[0], v[1], v[2], q[3] ?? 1];
    },
  };
  return { ok: true, basis };
}

/** All 48 signed axis labellings (up, forward, left) — 24 right-handed, 24 left-handed. */
export function allAxisConventions(): { up: AxisLabel; forward: AxisLabel; left: AxisLabel }[] {
  const labels: AxisLabel[] = ['+X', '-X', '+Y', '-Y', '+Z', '-Z'];
  const out: { up: AxisLabel; forward: AxisLabel; left: AxisLabel }[] = [];
  for (const up of labels)
    for (const forward of labels)
      for (const left of labels) {
        if (new Set([up[1], forward[1], left[1]]).size === 3) out.push({ up, forward, left });
      }
  return out;
}
