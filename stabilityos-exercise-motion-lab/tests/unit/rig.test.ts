/**
 * Canonical rig, joint rotation composition/decomposition and forward kinematics.
 *
 * FK is checked against an independent implementation written here (Rodrigues matrices, explicit
 * products, names resolved from rig.joints rather than the RigModel index).
 */
import { describe, expect, it } from 'vitest';
import { rigSchema, type JointSpec, type RigDefinition, type HumanoidProportions } from '../../src/core/contracts/rig.ts';
import {
  buildCanonicalRig,
  createRigA,
  footSites,
  legJoints,
  mirrorProportions,
  PROPORTIONS_A,
  scaleProportions,
  SEAT_SITE,
  standingHeight,
  SYNTHETIC_LIMITS_DEG,
} from '../../src/core/rig/canonical.ts';
import {
  composeJointRotation,
  decomposeJointRotation,
  fnv1a64Hex,
  forwardKinematics,
  getRigModel,
  jointIndex,
  rigFingerprint,
  rigidLinks,
  siteIndexOf,
  stableStringify,
  type FkResult,
} from '../../src/core/rig/model.ts';
import { validateRig } from '../../src/core/rig/validate.ts';
import { createRng, type Rng } from '../../src/core/math/rng.ts';
import type { Quat } from '../../src/core/math/quat.ts';
import type { Vec3 } from '../../src/core/math/vec3.ts';

// ---------------------------------------------------------------------------------------------
// Independent helpers
// ---------------------------------------------------------------------------------------------

type M3 = number[];
const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const AX: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

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
function mv(m: M3, v: readonly number[]): Vec3 {
  return [
    m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
    m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
    m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
  ];
}
function vadd(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
}
function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}
function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}
function quatToMat(q: Quat): M3 {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}
function mirror(v: readonly number[]): Vec3 {
  return [-v[0]!, v[1]!, v[2]!];
}
function partnerName(name: string): string {
  if (name.endsWith('_L')) return `${name.slice(0, -2)}_R`;
  if (name.endsWith('_R')) return `${name.slice(0, -2)}_L`;
  return name;
}
function angleWrap(d: number): number {
  let x = d % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/** Independent local rotation matrix: Π Rodrigues(sign_i * axis_i, θ_i). */
function refLocal(joint: JointSpec, angles: readonly number[]): M3 {
  let m = I3;
  joint.dofs.forEach((d, k) => {
    const a = AX[d.axis]!;
    m = mm(m, rodrigues([a[0] * d.sign, a[1] * d.sign, a[2] * d.sign], angles[k] ?? 0));
  });
  return m;
}

interface Pose {
  rootT: Vec3;
  pelvisOff: Vec3;
  angles: number[][];
}

/** Independent FK resolving parents by name. */
function refFK(rig: RigDefinition, pose: Pose): { pos: Map<string, Vec3>; rot: Map<string, M3>; site: Map<string, Vec3> } {
  const pos = new Map<string, Vec3>();
  const rot = new Map<string, M3>();
  rig.joints.forEach((j, i) => {
    const L = refLocal(j, pose.angles[i]!);
    if (j.parent === null) {
      pos.set(j.name, vadd(j.offset, pose.rootT));
      rot.set(j.name, L);
    } else {
      const pp = pos.get(j.parent)!;
      const pr = rot.get(j.parent)!;
      const off = j.kind === 'pelvis' ? vadd(j.offset, pose.pelvisOff) : j.offset;
      pos.set(j.name, vadd(pp, mv(pr, off)));
      rot.set(j.name, mm(pr, L));
    }
  });
  const site = new Map<string, Vec3>();
  for (const s of rig.sites) site.set(s.name, vadd(pos.get(s.joint)!, mv(rot.get(s.joint)!, s.offset)));
  return { pos, rot, site };
}

function zeroAngles(rig: RigDefinition): number[][] {
  return rig.joints.map((j) => j.dofs.map(() => 0));
}
function jIdx(rig: RigDefinition, name: string): number {
  const i = rig.joints.findIndex((j) => j.name === name);
  if (i < 0) throw new Error(`no joint ${name}`);
  return i;
}
function setDof(rig: RigDefinition, angles: number[][], joint: string, dof: string, v: number): void {
  const i = jIdx(rig, joint);
  const k = rig.joints[i]!.dofs.findIndex((d) => d.name === dof);
  if (k < 0) throw new Error(`no dof ${joint}.${dof}`);
  angles[i]![k] = v;
}
function locals(rig: RigDefinition, angles: number[][]): Quat[] {
  return rig.joints.map((j, i) => composeJointRotation(j, angles[i]!));
}
function fk(rig: RigDefinition, pose: Pose): FkResult {
  return forwardKinematics(getRigModel(rig), pose.rootT, pose.pelvisOff, locals(rig, pose.angles));
}
function jp(rig: RigDefinition, r: FkResult, name: string): Vec3 {
  return r.worldPos[jointIndex(getRigModel(rig), name)]!;
}
function sp(rig: RigDefinition, r: FkResult, name: string): Vec3 {
  return r.sitePos[siteIndexOf(getRigModel(rig), name)]!;
}
function standingPelvisY(p: HumanoidProportions, side: 'left' | 'right' = 'left'): number {
  const L = p[side].leg;
  return L.thigh + L.shank + L.ankleHeight + p.pelvis.hipDrop;
}
function standPose(rig: RigDefinition, angles = zeroAngles(rig)): Pose {
  return { rootT: [0, standingPelvisY(rig.proportions), 0], pelvisOff: [0, 0, 0], angles };
}
function randomPose(rig: RigDefinition, rng: Rng, withinLimits: boolean): Pose {
  return {
    rootT: [rng.range(-1, 1), rng.range(0.3, 1.2), rng.range(-1, 1)],
    pelvisOff: [rng.range(-0.1, 0.1), rng.range(-0.1, 0.1), rng.range(-0.1, 0.1)],
    angles: rig.joints.map((j) => j.dofs.map((d) => (withinLimits ? rng.range(d.min, d.max) : rng.range(-Math.PI, Math.PI)))),
  };
}

const EXPECTED_JOINTS = [
  'root', 'pelvis', 'lumbar', 'thoracic', 'neck',
  ...['_L', '_R'].flatMap((s) => ['shoulder', 'elbow', 'wrist', 'hip', 'knee', 'ankle', 'mtp'].map((n) => `${n}${s}`)),
];
const EXPECTED_SITES = [
  'head_top', 'seat',
  ...['_L', '_R'].flatMap((s) => ['hand', 'heel', 'ball', 'toe', 'heel_med', 'heel_lat', 'ball_med', 'ball_lat'].map((n) => `${n}${s}`)),
];

// ---------------------------------------------------------------------------------------------
// Rig definition
// ---------------------------------------------------------------------------------------------

describe('canonical rig A: definition', () => {
  const rig = createRigA();

  it('validates against the rig contract and via validateRig()', () => {
    expect(() => rigSchema.parse(rig)).not.toThrow();
    const v = validateRig(rig);
    expect(v.diagnostics).toEqual([]);
    expect(v.rig).toEqual(rig);
  });

  it('validateRig reports RIG_INVALID diagnostics instead of throwing', () => {
    const bad = structuredClone(rig);
    bad.proportions.left.leg.thigh = -1;
    bad.joints[jIdx(bad, 'knee_L')]!.order = [0, 0, 0];
    const v = validateRig(bad);
    expect(v.rig).toBeNull();
    expect(v.diagnostics.length).toBeGreaterThanOrEqual(1);
    for (const d of v.diagnostics) {
      expect(d.code).toBe('RIG_INVALID');
      expect(d.severity).toBe('error');
    }
    for (const garbage of [42, null, 'rig', { schema: 'smx.rig/1' }]) {
      expect(() => validateRig(garbage)).not.toThrow();
      expect(validateRig(garbage).rig).toBeNull();
    }
  });

  it('has exactly the expected joints and sites', () => {
    expect([...rig.joints.map((j) => j.name)].sort()).toEqual([...EXPECTED_JOINTS].sort());
    expect([...rig.sites.map((s) => s.name)].sort()).toEqual([...EXPECTED_SITES].sort());
    expect(rig.sites.find((s) => s.name === SEAT_SITE)?.joint).toBe('pelvis');
    expect(Object.values(footSites('left')).every((n) => EXPECTED_SITES.includes(n))).toBe(true);
    expect(legJoints('right')).toEqual({ hip: 'hip_R', knee: 'knee_R', ankle: 'ankle_R', mtp: 'mtp_R' });
  });

  it('joints are topologically ordered with a single root first', () => {
    expect(rig.joints[0]!.name).toBe('root');
    expect(rig.joints.filter((j) => j.parent === null).length).toBe(1);
    rig.joints.forEach((j, i) => {
      if (j.parent === null) return;
      const p = rig.joints.findIndex((q) => q.name === j.parent);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(i);
    });
  });

  it('every DOF axis equals order[i]; order is a permutation; DOF count matches joint kind', () => {
    const count: Record<string, number> = { root: 1, pelvis: 3, ball: 3, universal: 2, hinge: 1 };
    for (const j of rig.joints) {
      expect([...j.order].sort()).toEqual([0, 1, 2]);
      j.dofs.forEach((d, i) => expect(d.axis).toBe(j.order[i]));
      expect(j.dofs.length).toBe(count[j.kind]);
      expect(new Set(j.dofs.map((d) => d.name)).size).toBe(j.dofs.length);
      for (const d of j.dofs) expect(d.min).toBeLessThan(d.max);
    }
  });

  it('DOF limits are the synthetic limits in radians', () => {
    const lim = (joint: string, dof: string) => rig.joints[jIdx(rig, joint)]!.dofs.find((d) => d.name === dof)!;
    const deg = (x: number) => (x * Math.PI) / 180;
    const check = (joint: string, dof: string, key: keyof typeof SYNTHETIC_LIMITS_DEG) => {
      const d = lim(joint, dof);
      expect(d.min).toBeCloseTo(deg(SYNTHETIC_LIMITS_DEG[key][0]), 14);
      expect(d.max).toBeCloseTo(deg(SYNTHETIC_LIMITS_DEG[key][1]), 14);
    };
    for (const s of ['_L', '_R']) {
      check(`knee${s}`, 'flexion', 'kneeFlexion');
      check(`hip${s}`, 'flexion', 'hipFlexion');
      check(`hip${s}`, 'abduction', 'hipAbduction');
      check(`ankle${s}`, 'dorsiflexion', 'ankleDorsiflexion');
      check(`mtp${s}`, 'extension', 'mtpExtension');
      check(`shoulder${s}`, 'abduction', 'shoulderAbduction');
    }
    check('lumbar', 'flexion', 'lumbarFlexion');
    check('root', 'heading', 'heading');
  });

  it('right-side joints mirror the left: X-axis DOF signs equal, Y/Z signs flipped, offsets and sites mirrored in x', () => {
    for (const l of rig.joints.filter((j) => j.side === 'left')) {
      const r = rig.joints[jIdx(rig, partnerName(l.name))]!;
      expect(r.side).toBe('right');
      expect(r.kind).toBe(l.kind);
      expect(r.parent).toBe(partnerName(l.parent!));
      expect(r.order).toEqual(l.order);
      expect(maxAbsDiff(r.offset, mirror(l.offset))).toBe(0);
      expect(r.dofs.length).toBe(l.dofs.length);
      l.dofs.forEach((dl, k) => {
        const dr = r.dofs[k]!;
        expect(dr.name).toBe(dl.name);
        expect(dr.axis).toBe(dl.axis);
        expect(dr.min).toBe(dl.min);
        expect(dr.max).toBe(dl.max);
        expect(dr.sign).toBe(dl.axis === 0 ? dl.sign : -dl.sign);
      });
    }
    for (const s of rig.sites.filter((x) => x.name.endsWith('_L'))) {
      const r = rig.sites.find((x) => x.name === partnerName(s.name))!;
      expect(r.joint).toBe(partnerName(s.joint));
      expect(r.role).toBe(s.role);
      expect(maxAbsDiff(r.offset, mirror(s.offset))).toBe(0);
    }
  });

  it('medial foot sites lie toward the midline on both sides', () => {
    for (const side of ['left', 'right'] as const) {
      const fs = footSites(side);
      const off = (n: string) => rig.sites.find((s) => s.name === n)!.offset;
      const medialSign = side === 'left' ? -1 : 1; // midline is -X for the left foot, +X for the right
      expect(Math.sign(off(fs.heelMedial)[0])).toBe(medialSign);
      expect(Math.sign(off(fs.ballMedial)[0])).toBe(medialSign);
      expect(Math.sign(off(fs.heelLateral)[0])).toBe(-medialSign);
      expect(Math.sign(off(fs.ballLateral)[0])).toBe(-medialSign);
    }
  });

  it('rigid links: one per non-pelvis child joint, lengths equal |rest offset| computed independently', () => {
    const model = getRigModel(rig);
    const links = rigidLinks(model);
    expect(links.length).toBe(rig.joints.length - 2); // root has no parent; root->pelvis is a translation DOF
    const L = PROPORTIONS_A.left.leg;
    const expected: Record<string, number> = {
      'hip_L->knee_L': L.thigh,
      'knee_R->ankle_R': L.shank,
      'ankle_L->mtp_L': Math.hypot(L.ankleHeight - L.mtpHeight, L.footLength),
      'pelvis->hip_R': PROPORTIONS_A.pelvis.hipHalfWidth,
      'pelvis->lumbar': PROPORTIONS_A.pelvis.lumbarBaseHeight,
      'lumbar->thoracic': PROPORTIONS_A.trunk.lumbar,
      'thoracic->neck': PROPORTIONS_A.trunk.thoracic,
      'thoracic->shoulder_L': Math.hypot(PROPORTIONS_A.trunk.shoulderHalfWidth, PROPORTIONS_A.trunk.thoracic - PROPORTIONS_A.trunk.shoulderDrop),
      'shoulder_R->elbow_R': PROPORTIONS_A.right.arm.upperArm,
      'elbow_L->wrist_L': PROPORTIONS_A.left.arm.forearm,
    };
    for (const [name, len] of Object.entries(expected)) {
      const link = links.find((k) => k.name === name);
      expect(link, name).toBeDefined();
      expect(Math.abs(link!.length - len)).toBeLessThan(1e-15);
    }
    for (const link of links) {
      const child = rig.joints[link.b]!;
      expect(rig.joints[link.a]!.name).toBe(child.parent);
      expect(link.length).toBeCloseTo(Math.hypot(...child.offset), 15);
      expect(child.kind).not.toBe('pelvis');
    }
  });
});

describe('getRigModel', () => {
  it('indexes joints and sites consistently and is cached per rig object', () => {
    const rig = createRigA();
    const m = getRigModel(rig);
    expect(getRigModel(rig)).toBe(m);
    expect(m.jointCount).toBe(rig.joints.length);
    expect(m.names).toEqual(rig.joints.map((j) => j.name));
    rig.joints.forEach((j, i) => {
      expect(jointIndex(m, j.name)).toBe(i);
      expect(m.parent[i]).toBe(j.parent === null ? -1 : rig.joints.findIndex((q) => q.name === j.parent));
    });
    rig.sites.forEach((s, i) => {
      expect(siteIndexOf(m, s.name)).toBe(i);
      expect(m.names[m.siteJoint[i]!]).toBe(s.joint);
    });
    expect(() => jointIndex(m, 'tail')).toThrow(/no joint 'tail'/);
    expect(() => siteIndexOf(m, 'nose')).toThrow(/no site 'nose'/);
    const clone = structuredClone(rig);
    const m2 = getRigModel(clone);
    expect(m2).not.toBe(m);
    expect(m2.fingerprint).toBe(m.fingerprint);
  });

  it('throws on structurally broken rigs (unknown parent, parent after child, site on unknown joint)', () => {
    const base = createRigA();
    const a = structuredClone(base);
    a.joints[jIdx(a, 'knee_L')]!.parent = 'femur_L';
    expect(() => getRigModel(a)).toThrow(/unknown parent/);
    const b = structuredClone(base);
    const k = jIdx(b, 'knee_L');
    const n = jIdx(b, 'ankle_L');
    [b.joints[k], b.joints[n]] = [b.joints[n]!, b.joints[k]!];
    expect(() => getRigModel(b)).toThrow(/before its parent/);
    const c = structuredClone(base);
    c.sites[0]!.joint = 'nowhere';
    expect(() => getRigModel(c)).toThrow(/unknown joint/);
  });
});

// ---------------------------------------------------------------------------------------------
// Joint rotation composition / decomposition
// ---------------------------------------------------------------------------------------------

describe('composeJointRotation / decomposeJointRotation', () => {
  const rig = createRigA();

  it('compose equals the product of Rodrigues rotations about sign*axis, is unit and canonical (w >= 0)', () => {
    const rng = createRng(700);
    for (const j of rig.joints) {
      expect(composeJointRotation(j, j.dofs.map(() => 0))).toEqual([0, 0, 0, 1]);
      for (let n = 0; n < 100; n++) {
        const ang = j.dofs.map(() => rng.range(-Math.PI, Math.PI));
        const q = composeJointRotation(j, ang);
        expect(Math.abs(Math.hypot(...q) - 1)).toBeLessThan(1e-15);
        expect(q[3]).toBeGreaterThanOrEqual(0);
        expect(maxAbsDiff(quatToMat(q), refLocal(j, ang))).toBeLessThan(1e-14);
      }
    }
  });

  it('round-trips seeded random angles within limits for every joint (both sides, all DOFs)', () => {
    const rng = createRng(701);
    for (const j of rig.joints) {
      for (let n = 0; n < 400; n++) {
        const ang = j.dofs.map((d) => rng.range(d.min + 1e-9, d.max - 1e-9));
        const q = composeJointRotation(j, ang);
        const { angles, residual } = decomposeJointRotation(j, q);
        expect(angles.length).toBe(j.dofs.length);
        expect(residual.length).toBe(3 - j.dofs.length);
        angles.forEach((a, k) => {
          expect(Math.abs(angleWrap(a - ang[k]!)), `${j.name}.${j.dofs[k]!.name}`).toBeLessThan(1e-9);
          expect(a).toBeGreaterThanOrEqual(j.dofs[k]!.min - 1e-9);
          expect(a).toBeLessThanOrEqual(j.dofs[k]!.max + 1e-9);
        });
        for (const r of residual) expect(Math.abs(r)).toBeLessThan(1e-12);
        // negated quaternion is the same rotation
        const neg = decomposeJointRotation(j, [-q[0], -q[1], -q[2], -q[3]]);
        expect(maxAbsDiff(neg.angles, angles)).toBeLessThan(1e-12);
      }
    }
  });

  // Regression (was a bug, fixed): shoulder abduction is the MIDDLE Euler angle of X-Z-Y with limit
  // [-15, 160] deg; the canonical branch returned (-162.8, 60, -168.5) deg for (17.2, 120, 11.5) deg.
  it('shoulder abduction beyond 90 deg decomposes back to the in-limit branch', () => {
    for (const name of ['shoulder_L', 'shoulder_R']) {
      const j = rig.joints[jIdx(rig, name)]!;
      const ang = [0.3, (120 * Math.PI) / 180, 0.2];
      const { angles } = decomposeJointRotation(j, composeJointRotation(j, ang));
      expect(maxAbsDiff(angles, ang)).toBeLessThan(1e-12);
      const rng = createRng(702);
      for (let n = 0; n < 300; n++) {
        const a = [rng.range(j.dofs[0]!.min, j.dofs[0]!.max), rng.range((95 * Math.PI) / 180, j.dofs[1]!.max), rng.range(j.dofs[2]!.min, j.dofs[2]!.max)];
        const got = decomposeJointRotation(j, composeJointRotation(j, a)).angles;
        expect(maxAbsDiff(got.map((g, k) => angleWrap(g - a[k]!)), [0, 0, 0])).toBeLessThan(1e-10);
      }
    }
  });

  it('rotations about non-DOF axes are reported as residuals (exact values, both parities)', () => {
    const q = (axis: 0 | 1 | 2, ang: number): M3 => rodrigues(AX[axis]!, ang);
    const toQuat = (m: M3): Quat => {
      // Independent matrix -> quaternion for well-conditioned (trace > 0) inputs.
      const w = Math.sqrt(1 + m[0]! + m[4]! + m[8]!) / 2;
      return [(m[7]! - m[5]!) / (4 * w), (m[2]! - m[6]!) / (4 * w), (m[3]! - m[1]!) / (4 * w), w];
    };
    const J = (n: string) => rig.joints[jIdx(rig, n)]!;
    const cases: { joint: string; m: M3; angles: number[]; residual: number[] }[] = [
      // knee: order XYZ, flexion = +X
      { joint: 'knee_L', m: q(1, 0.3), angles: [0], residual: [0.3, 0] },
      { joint: 'knee_L', m: mm(q(0, 0.5), q(1, 0.2)), angles: [0.5], residual: [0.2, 0] },
      { joint: 'knee_R', m: mm(q(0, 0.5), q(2, -0.15)), angles: [0.5], residual: [0, -0.15] },
      // ankle: order XZY (odd), dorsiflexion = -X, inversion = -Z (left)
      { joint: 'ankle_L', m: mm(mm(q(0, -0.3), q(2, -0.1)), q(1, 0.25)), angles: [0.3, 0.1], residual: [0.25] },
      // right ankle: inversion axis sign flipped
      { joint: 'ankle_R', m: mm(mm(q(0, -0.3), q(2, 0.1)), q(1, -0.2)), angles: [0.3, 0.1], residual: [-0.2] },
      // mtp: order XYZ, extension = -X
      { joint: 'mtp_R', m: q(2, 0.2), angles: [0], residual: [0, 0.2] },
      { joint: 'mtp_L', m: mm(q(0, -0.4), q(1, 0.1)), angles: [0.4], residual: [0.1, 0] },
      // wrist: order ZXY (even), flexion = -Z, deviation = -X (left)
      { joint: 'wrist_L', m: mm(mm(q(2, -0.2), q(0, -0.1)), q(1, 0.15)), angles: [0.2, 0.1], residual: [0.15] },
    ];
    for (const c of cases) {
      const d = decomposeJointRotation(J(c.joint), toQuat(c.m));
      expect(maxAbsDiff(d.angles, c.angles), c.joint).toBeLessThan(1e-14);
      expect(maxAbsDiff(d.residual, c.residual), c.joint).toBeLessThan(1e-14);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Forward kinematics
// ---------------------------------------------------------------------------------------------

describe('forwardKinematics', () => {
  const rig = createRigA();
  const P = rig.proportions;

  it('matches an independent Rodrigues-matrix FK for random poses (positions, rotations, sites)', () => {
    const rng = createRng(800);
    const model = getRigModel(rig);
    for (let n = 0; n < 300; n++) {
      const pose = randomPose(rig, rng, n % 2 === 0);
      const got = fk(rig, pose);
      const ref = refFK(rig, pose);
      rig.joints.forEach((j, i) => {
        expect(maxAbsDiff(got.worldPos[i]!, ref.pos.get(j.name)!)).toBeLessThan(1e-13);
        expect(maxAbsDiff(quatToMat(got.worldRot[i]!), ref.rot.get(j.name)!)).toBeLessThan(1e-13);
      });
      rig.sites.forEach((s, i) => expect(maxAbsDiff(got.sitePos[i]!, ref.site.get(s.name)!)).toBeLessThan(1e-13));
      expect(got.worldPos.length).toBe(model.jointCount);
    }
  });

  it('missing local rotations default to identity', () => {
    const model = getRigModel(rig);
    const a = forwardKinematics(model, [0, 1, 0], [0, 0, 0], []);
    const b = forwardKinematics(model, [0, 1, 0], [0, 0, 0], rig.joints.map(() => [0, 0, 0, 1] as Quat));
    expect(a).toEqual(b);
  });

  it('rest standing pose: ankles at ankleHeight, soles on the floor, hip width, standing height', () => {
    const r = fk(rig, standPose(rig));
    for (const q of r.worldRot) expect(q).toEqual([0, 0, 0, 1]);
    for (const side of ['left', 'right'] as const) {
      const L = P[side].leg;
      const lj = legJoints(side);
      const fs = footSites(side);
      const sx = side === 'left' ? 1 : -1;
      expect(jp(rig, r, lj.hip)[1]).toBeCloseTo(L.thigh + L.shank + L.ankleHeight, 14);
      expect(jp(rig, r, lj.knee)[1]).toBeCloseTo(L.shank + L.ankleHeight, 14);
      expect(jp(rig, r, lj.ankle)[1]).toBeCloseTo(L.ankleHeight, 14);
      expect(jp(rig, r, lj.mtp)[1]).toBeCloseTo(L.mtpHeight, 14);
      expect(jp(rig, r, lj.mtp)[2]).toBeCloseTo(L.footLength, 14);
      for (const s of Object.values(fs)) expect(Math.abs(sp(rig, r, s)[1])).toBeLessThan(1e-14);
      expect(sp(rig, r, fs.heel)[2]).toBeCloseTo(-L.heelBack, 14);
      expect(sp(rig, r, fs.ball)[2]).toBeCloseTo(L.footLength, 14);
      expect(sp(rig, r, fs.toe)[2]).toBeCloseTo(L.footLength + L.toeLength, 14);
      // ball directly under the MTP joint centre
      expect(maxAbsDiff(sp(rig, r, fs.ball), vadd(jp(rig, r, lj.mtp), [0, -L.mtpHeight, 0]))).toBeLessThan(1e-15);
      expect(jp(rig, r, lj.hip)[0]).toBeCloseTo(sx * P.pelvis.hipHalfWidth, 15);
      expect(sp(rig, r, `hand${side === 'left' ? '_L' : '_R'}`)[0]).toBeCloseTo(sx * P.trunk.shoulderHalfWidth, 15);
    }
    expect(jp(rig, r, 'hip_L')[0] - jp(rig, r, 'hip_R')[0]).toBeCloseTo(2 * P.pelvis.hipHalfWidth, 15);
    const H = standingPelvisY(P);
    expect(H).toBeCloseTo(0.95, 15);
    const headTop = P.pelvis.lumbarBaseHeight + P.trunk.lumbar + P.trunk.thoracic + P.trunk.neck + P.trunk.head + H;
    expect(sp(rig, r, 'head_top')[1]).toBeCloseTo(headTop, 14);
    expect(sp(rig, r, 'head_top')[1]).toBeCloseTo(1.82, 14);
    expect(standingHeight(P)).toBeCloseTo(sp(rig, r, 'head_top')[1], 14);
    expect(jp(rig, r, 'neck')[1]).toBeCloseTo(H + P.pelvis.lumbarBaseHeight + P.trunk.lumbar + P.trunk.thoracic, 14);
    const shoulderY = H + P.pelvis.lumbarBaseHeight + P.trunk.lumbar + P.trunk.thoracic - P.trunk.shoulderDrop;
    expect(jp(rig, r, 'shoulder_L')[1]).toBeCloseTo(shoulderY, 14);
    const A = P.left.arm;
    expect(sp(rig, r, 'hand_L')[1]).toBeCloseTo(shoulderY - A.upperArm - A.forearm - A.hand, 14);
    expect(maxAbsDiff(sp(rig, r, SEAT_SITE), [0, H - P.pelvis.seatDrop, -P.pelvis.seatBack])).toBeLessThan(1e-15);
  });

  // Regression (was a bug, fixed): rig A used to be labelled "1.73 m" while its FK height is 1.82 m.
  it('the rig name states the FK standing height', () => {
    const r = fk(rig, standPose(rig));
    const m = /(\d+\.\d+) m/.exec(rig.name);
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m![1]) - sp(rig, r, 'head_top')[1])).toBeLessThan(0.005);
  });

  it('root translation moves everything; heading rotates the body (and the pelvis offset) about the root', () => {
    const base = fk(rig, standPose(rig));
    const t: Vec3 = [0.3, 0.2, -0.4];
    const shifted = fk(rig, { ...standPose(rig), rootT: vadd(standPose(rig).rootT, t) });
    base.worldPos.forEach((p, i) => expect(maxAbsDiff(shifted.worldPos[i]!, vadd(p, t))).toBeLessThan(1e-15));
    // heading +90 deg: forward (+Z) turns to +X
    const ang = zeroAngles(rig);
    setDof(rig, ang, 'root', 'heading', Math.PI / 2);
    const turned = fk(rig, { rootT: [0, 0.95, 0], pelvisOff: [0, 0, 0.1], angles: ang });
    const toe = sp(rig, turned, 'toe_L');
    const heel = sp(rig, turned, 'heel_L');
    expect(toe[0] - heel[0]).toBeCloseTo(P.left.leg.heelBack + P.left.leg.footLength + P.left.leg.toeLength, 14);
    expect(Math.abs(toe[2] - heel[2])).toBeLessThan(1e-15);
    // pelvis offset [0,0,0.1] is expressed in the root frame -> ends up along +X
    expect(maxAbsDiff(jp(rig, turned, 'pelvis'), [0.1, 0.95, 0])).toBeLessThan(1e-15);
  });

  it('bone lengths from FK world positions equal the rigid-link lengths for random poses', () => {
    const rng = createRng(801);
    const links = rigidLinks(getRigModel(rig));
    let worst = 0;
    for (let n = 0; n < 500; n++) {
      const r = fk(rig, randomPose(rig, rng, n % 3 !== 0));
      for (const l of links) worst = Math.max(worst, Math.abs(dist(r.worldPos[l.a]!, r.worldPos[l.b]!) - l.length) / l.length);
      rig.sites.forEach((s, i) => {
        const j = rig.joints.findIndex((q) => q.name === s.joint);
        const len = Math.hypot(...s.offset);
        worst = Math.max(worst, Math.abs(dist(r.sitePos[i]!, r.worldPos[j]!) - len) / len);
      });
    }
    expect(worst).toBeLessThan(1e-12);
  });
});

describe('forwardKinematics: anatomical sign conventions', () => {
  const rig = createRigA();
  const rest = fk(rig, standPose(rig));
  const posed = (joint: string, dof: string, v: number, extra?: (a: number[][]) => void): FkResult => {
    const a = zeroAngles(rig);
    setDof(rig, a, joint, dof, v);
    extra?.(a);
    return fk(rig, standPose(rig, a));
  };

  for (const s of ['_L', '_R']) {
    it(`hip${s} flexion moves the knee forward (+Z) and up`, () => {
      const r = posed(`hip${s}`, 'flexion', 0.6);
      expect(jp(rig, r, `knee${s}`)[2] - jp(rig, r, `hip${s}`)[2]).toBeGreaterThan(0.2);
      expect(jp(rig, r, `knee${s}`)[1]).toBeGreaterThan(jp(rig, rest, `knee${s}`)[1]);
      // exact: thigh direction (0, -cos, sin)
      expect(jp(rig, r, `knee${s}`)[2] - jp(rig, r, `hip${s}`)[2]).toBeCloseTo(0.44 * Math.sin(0.6), 14);
    });

    it(`knee${s} flexion moves the ankle backward (-Z) relative to the knee`, () => {
      const r = posed(`knee${s}`, 'flexion', 0.7);
      expect(jp(rig, r, `ankle${s}`)[2] - jp(rig, r, `knee${s}`)[2]).toBeCloseTo(-0.43 * Math.sin(0.7), 14);
    });

    it(`ankle${s} dorsiflexion raises the toe; plantarflexion lowers it`, () => {
      expect(sp(rig, posed(`ankle${s}`, 'dorsiflexion', 0.3), `toe${s}`)[1]).toBeGreaterThan(0.03);
      expect(sp(rig, posed(`ankle${s}`, 'dorsiflexion', -0.3), `toe${s}`)[1]).toBeLessThan(-0.03);
    });

    it(`mtp${s} extension raises the toe tip relative to the ball`, () => {
      const r = posed(`mtp${s}`, 'extension', 0.5);
      expect(sp(rig, r, `toe${s}`)[1] - sp(rig, r, `ball${s}`)[1]).toBeCloseTo(0.06 * Math.sin(0.5), 14);
      const f = posed(`mtp${s}`, 'extension', -0.3);
      expect(sp(rig, f, `toe${s}`)[1] - sp(rig, f, `ball${s}`)[1]).toBeLessThan(0);
    });

    it(`hip${s} abduction moves the knee laterally; internal rotation turns the toes medially`, () => {
      const lateral = s === '_L' ? 1 : -1;
      const ab = posed(`hip${s}`, 'abduction', 0.3);
      expect(lateral * (jp(rig, ab, `knee${s}`)[0] - jp(rig, ab, `hip${s}`)[0])).toBeCloseTo(0.44 * Math.sin(0.3), 14);
      const ir = posed(`hip${s}`, 'internalRotation', 0.3);
      expect(lateral * (sp(rig, ir, `toe${s}`)[0] - sp(rig, rest, `toe${s}`)[0])).toBeLessThan(-0.03);
      // with the knee flexed 90 deg, internal rotation swings the ankle laterally
      const ir90 = posed(`hip${s}`, 'internalRotation', 0.3, (a) => setDof(rig, a, `knee${s}`, 'flexion', Math.PI / 2));
      const kn90 = posed(`knee${s}`, 'flexion', Math.PI / 2);
      expect(lateral * (jp(rig, ir90, `ankle${s}`)[0] - jp(rig, kn90, `ankle${s}`)[0])).toBeGreaterThan(0.1);
    });

    it(`ankle${s} inversion turns the sole to face medially`, () => {
      const r = posed(`ankle${s}`, 'inversion', 0.25);
      const q = r.worldRot[jointIndex(getRigModel(rig), `ankle${s}`)]!;
      const soleNormal = mv(quatToMat(q), [0, -1, 0]);
      const medial = s === '_L' ? -1 : 1;
      expect(medial * soleNormal[0]).toBeCloseTo(Math.sin(0.25), 14);
    });

    it(`shoulder${s} flexion raises the hand forward; abduction moves it laterally; elbow flexion brings the hand forward`, () => {
      const lateral = s === '_L' ? 1 : -1;
      const fl = posed(`shoulder${s}`, 'flexion', 1.0);
      expect(sp(rig, fl, `hand${s}`)[2] - jp(rig, fl, `shoulder${s}`)[2]).toBeGreaterThan(0.5);
      const ab = posed(`shoulder${s}`, 'abduction', 1.0);
      expect(lateral * (sp(rig, ab, `hand${s}`)[0] - jp(rig, ab, `shoulder${s}`)[0])).toBeGreaterThan(0.5);
      const el = posed(`elbow${s}`, 'flexion', 1.2);
      expect(sp(rig, el, `hand${s}`)[2] - jp(rig, el, `elbow${s}`)[2]).toBeGreaterThan(0.3);
    });
  }

  it('lumbar, thoracic and neck flexion and anterior pelvic tilt move the head forward (+Z)', () => {
    for (const [joint, dof] of [['lumbar', 'flexion'], ['thoracic', 'flexion'], ['neck', 'flexion'], ['pelvis', 'tilt']] as const) {
      const r = posed(joint, dof, 0.4);
      expect(sp(rig, r, 'head_top')[2], joint).toBeGreaterThan(0.1);
      expect(sp(rig, r, 'head_top')[1], joint).toBeLessThan(sp(rig, rest, 'head_top')[1]);
    }
    const ext = posed('lumbar', 'flexion', -0.3);
    expect(sp(rig, ext, 'head_top')[2]).toBeLessThan(-0.1);
  });
});

describe('forwardKinematics: left/right mirror symmetry', () => {
  /** Mirror a pose: swap side joints; for centre joints negate DOFs about Y and Z (pseudovector rule). */
  function mirrorPose(rig: RigDefinition, pose: Pose): Pose {
    const angles = rig.joints.map((j) => {
      const src = jIdx(rig, partnerName(j.name));
      const a = pose.angles[src]!;
      return j.side === 'center' ? a.map((v, k) => (j.dofs[k]!.axis === 0 ? v : -v)) : [...a];
    });
    return { rootT: mirror(pose.rootT), pelvisOff: mirror(pose.pelvisOff), angles };
  }

  function expectMirrored(rigA: RigDefinition, a: FkResult, rigB: RigDefinition, b: FkResult): void {
    rigA.joints.forEach((j, i) => {
      const k = jIdx(rigB, partnerName(j.name));
      expect(maxAbsDiff(b.worldPos[k]!, mirror(a.worldPos[i]!)), j.name).toBeLessThan(1e-13);
      const [x, y, z, w] = a.worldRot[i]!;
      const expected: Quat = [x, -y, -z, w];
      const got = b.worldRot[k]!;
      const d = Math.min(maxAbsDiff(got, expected), maxAbsDiff(got, expected.map((v) => -v)));
      expect(d, j.name).toBeLessThan(1e-13);
    });
    rigA.sites.forEach((s, i) => {
      const k = rigB.sites.findIndex((t) => t.name === partnerName(s.name));
      expect(maxAbsDiff(b.sitePos[k]!, mirror(a.sitePos[i]!)), s.name).toBeLessThan(1e-13);
    });
  }

  it('symmetric pose on rig A: right side is the x-mirror of the left, centre joints stay on x = 0', () => {
    const rig = createRigA();
    const rng = createRng(900);
    for (let n = 0; n < 100; n++) {
      const angles = zeroAngles(rig);
      rig.joints.forEach((j, i) => {
        j.dofs.forEach((d, k) => {
          if (j.side === 'left') {
            const v = rng.range(d.min, d.max);
            angles[i]![k] = v;
            angles[jIdx(rig, partnerName(j.name))]![k] = v;
          } else if (j.side === 'center' && d.axis === 0) {
            angles[i]![k] = rng.range(d.min, d.max);
          }
        });
      });
      const r = fk(rig, { rootT: [0, rng.range(0.5, 1), rng.range(-1, 1)], pelvisOff: [0, rng.range(-0.1, 0.1), rng.range(-0.1, 0.1)], angles });
      for (const j of rig.joints) {
        const p = jp(rig, r, j.name);
        if (j.side === 'center') expect(Math.abs(p[0])).toBeLessThan(1e-15);
        if (j.side === 'left') expect(maxAbsDiff(jp(rig, r, partnerName(j.name)), mirror(p))).toBeLessThan(1e-14);
      }
      for (const s of rig.sites.filter((x) => x.name.endsWith('_L'))) {
        expect(maxAbsDiff(sp(rig, r, partnerName(s.name)), mirror(sp(rig, r, s.name)))).toBeLessThan(1e-14);
      }
    }
  });

  it('general poses: FK(mirrored pose) = mirror(FK(pose)) for positions, rotations and sites', () => {
    const rig = createRigA();
    const rng = createRng(901);
    for (let n = 0; n < 200; n++) {
      const pose = randomPose(rig, rng, n % 2 === 0);
      expectMirrored(rig, fk(rig, pose), rig, fk(rig, mirrorPose(rig, pose)));
    }
  });

  it('asymmetric rig: FK on the rig built from mirrorProportions(p) with the mirrored pose mirrors the original', () => {
    const p = scaleProportions(PROPORTIONS_A, { leftLegExtra: 0.04 });
    p.right.leg.footLength *= 1.1;
    p.left.arm.forearm *= 0.9;
    const rigA = buildCanonicalRig('asym', 'Asymmetric', p);
    const rigB = buildCanonicalRig('asym-m', 'Asymmetric mirrored', mirrorProportions(p));
    const rng = createRng(902);
    for (let n = 0; n < 100; n++) {
      const pose = randomPose(rigA, rng, true);
      expectMirrored(rigA, fk(rigA, pose), rigB, fk(rigB, mirrorPose(rigA, pose)));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Fingerprints, hashing, proportions
// ---------------------------------------------------------------------------------------------

describe('stableStringify / fnv1a64Hex / rigFingerprint', () => {
  /** Independent FNV-1a-style 32-bit pass in BigInt arithmetic. */
  function fnvRef(text: string, basis: bigint, prime: bigint): string {
    let h = basis;
    for (let i = 0; i < text.length; i++) h = ((h ^ BigInt(text.charCodeAt(i))) * prime) & 0xffffffffn;
    return h.toString(16).padStart(8, '0');
  }

  it('fnv1a64Hex: first half is standard FNV-1a 32; second half matches its documented parameters', () => {
    // Published FNV-1a 32-bit test vectors
    expect(fnv1a64Hex('').slice(0, 8)).toBe('811c9dc5');
    expect(fnv1a64Hex('a').slice(0, 8)).toBe('e40c292c');
    expect(fnv1a64Hex('foobar').slice(0, 8)).toBe('bf9cf968');
    for (const s of ['', 'a', 'foobar', 'smx.rig/1', '{"a":[1,2,3]}', 'ünïcødé ✓']) {
      const h = fnv1a64Hex(s);
      expect(h).toMatch(/^[0-9a-f]{16}$/);
      expect(h.slice(0, 8)).toBe(fnvRef(s, 0x811c9dc5n, 0x01000193n));
      expect(h.slice(8)).toBe(fnvRef(s, BigInt(0x01000193 ^ 0x5bd1e995), 0x01000195n));
    }
    expect(fnv1a64Hex('ab')).not.toBe(fnv1a64Hex('ba'));
  });

  it('stableStringify is key-order independent, skips undefined properties and round-trips plain JSON data', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 0, y: 'x' }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":"x","z":0}]},"b":1}');
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ a: 1, u: undefined })).toBe('{"a":1}');
    expect(stableStringify('x"y')).toBe('"x\\"y"');
    expect(stableStringify(-0)).toBe('0');
    const rig = createRigA();
    expect(JSON.parse(stableStringify(rig))).toEqual(JSON.parse(JSON.stringify(rig)));
  });

  // Regression (was a bug, fixed): [1, undefined] used to serialise as "[1,]" and [undefined] collided with [].
  it('stableStringify serialises undefined array elements and top-level undefined as null', () => {
    expect(stableStringify([1, undefined])).toBe('[1,null]');
    expect(stableStringify([undefined])).not.toBe(stableStringify([]));
    expect(stableStringify(undefined)).toBe('null');
    expect(() => JSON.parse(stableStringify([1, undefined, 3]))).not.toThrow();
  });

  it('rig fingerprints are stable, 16 hex chars, and change when geometry or limits change', () => {
    const a = createRigA();
    const fp = rigFingerprint(a);
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(rigFingerprint(createRigA())).toBe(fp);
    expect(rigFingerprint(structuredClone(a))).toBe(fp);
    expect(getRigModel(a).fingerprint).toBe(fp);
    // key order of the proportions object does not matter
    const reordered = buildCanonicalRig(a.id, a.name, JSON.parse(stableStringify(PROPORTIONS_A)) as HumanoidProportions);
    expect(rigFingerprint(reordered)).toBe(fp);
    // identity/label only: not part of the geometric fingerprint
    expect(rigFingerprint({ ...a, id: 'other', name: 'Other' })).toBe(fp);

    const longer = buildCanonicalRig(a.id, a.name, scaleProportions(PROPORTIONS_A, { leg: 1.001 }));
    expect(rigFingerprint(longer)).not.toBe(fp);
    const limits = structuredClone(a);
    limits.joints[jIdx(limits, 'knee_L')]!.dofs[0]!.max -= 1e-6;
    expect(rigFingerprint(limits)).not.toBe(fp);
    const site = structuredClone(a);
    site.sites[0]!.offset[2] += 1e-9;
    expect(rigFingerprint(site)).not.toBe(fp);
    // symmetric proportions: mirroring is a no-op; asymmetric: it is not
    expect(rigFingerprint(buildCanonicalRig(a.id, a.name, mirrorProportions(PROPORTIONS_A)))).toBe(fp);
    const asym = scaleProportions(PROPORTIONS_A, { leftLegExtra: 0.02 });
    expect(rigFingerprint(buildCanonicalRig('x', 'x', asym))).not.toBe(rigFingerprint(buildCanonicalRig('x', 'x', mirrorProportions(asym))));
  });
});

describe('scaleProportions / mirrorProportions / standingHeight', () => {
  const snapshot = JSON.stringify(PROPORTIONS_A);

  it('identity factors return an equal deep copy and never mutate the input', () => {
    const out = scaleProportions(PROPORTIONS_A, {});
    expect(out).toEqual(PROPORTIONS_A);
    expect(out).not.toBe(PROPORTIONS_A);
    expect(out.left).not.toBe(PROPORTIONS_A.left);
    out.left.leg.thigh = 99;
    scaleProportions(PROPORTIONS_A, { leg: 2, trunk: 3, foot: 0.5, pelvis: 1.5, arm: 0.7, leftLegExtra: 0.1 });
    mirrorProportions(PROPORTIONS_A);
    expect(JSON.stringify(PROPORTIONS_A)).toBe(snapshot);
  });

  it('each factor scales exactly its documented fields', () => {
    const f = { leg: 1.1, trunk: 1.2, foot: 0.9, pelvis: 1.3, arm: 0.8 };
    const out = scaleProportions(PROPORTIONS_A, f);
    const p = PROPORTIONS_A;
    const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-15);
    for (const side of ['left', 'right'] as const) {
      near(out[side].leg.thigh, p[side].leg.thigh * f.leg);
      near(out[side].leg.shank, p[side].leg.shank * f.leg);
      for (const k of ['ankleHeight', 'heelBack', 'footLength', 'mtpHeight', 'toeLength', 'footWidth'] as const) {
        near(out[side].leg[k], p[side].leg[k] * f.foot);
      }
      for (const k of ['upperArm', 'forearm', 'hand'] as const) near(out[side].arm[k], p[side].arm[k] * f.arm);
    }
    for (const k of ['hipHalfWidth', 'seatDrop', 'seatBack', 'hipDrop'] as const) near(out.pelvis[k], p.pelvis[k] * f.pelvis);
    near(out.pelvis.lumbarBaseHeight, p.pelvis.lumbarBaseHeight * f.trunk);
    for (const k of ['lumbar', 'thoracic', 'neck', 'head'] as const) near(out.trunk[k], p.trunk[k] * f.trunk);
    near(out.trunk.shoulderHalfWidth, p.trunk.shoulderHalfWidth * f.pelvis); // widths follow the pelvis factor
    near(out.trunk.shoulderDrop, p.trunk.shoulderDrop);
    expect(() => rigSchema.parse(buildCanonicalRig('scaled', 'Scaled', out))).not.toThrow();
  });

  it('leftLegExtra lengthens only the left leg (split evenly between thigh and shank)', () => {
    const out = scaleProportions(PROPORTIONS_A, { leftLegExtra: 0.04 });
    expect(out.left.leg.thigh).toBeCloseTo(PROPORTIONS_A.left.leg.thigh + 0.02, 15);
    expect(out.left.leg.shank).toBeCloseTo(PROPORTIONS_A.left.leg.shank + 0.02, 15);
    expect(out.right).toEqual(PROPORTIONS_A.right);
    // standing on the left sole, the right sole hangs exactly `extra` above the floor
    const rig = buildCanonicalRig('ll', 'Long left', out);
    const r = fk(rig, standPose(rig));
    expect(Math.abs(sp(rig, r, 'heel_L')[1])).toBeLessThan(1e-15);
    expect(sp(rig, r, 'heel_R')[1]).toBeCloseTo(0.04, 14);
  });

  it('mirrorProportions swaps sides, is an involution and leaves centre proportions alone', () => {
    const asym = scaleProportions(PROPORTIONS_A, { leftLegExtra: 0.03 });
    asym.right.arm.hand = 0.2;
    const m = mirrorProportions(asym);
    expect(m.left).toEqual(asym.right);
    expect(m.right).toEqual(asym.left);
    expect(m.pelvis).toEqual(asym.pelvis);
    expect(m.trunk).toEqual(asym.trunk);
    expect(mirrorProportions(m)).toEqual(asym);
    expect(m.left).not.toBe(asym.right);
  });

  it('standingHeight equals the FK head_top height for scaled rigs and scales linearly', () => {
    for (const s of [0.8, 1, 1.15]) {
      const p = scaleProportions(PROPORTIONS_A, { leg: s, trunk: s, foot: s, pelvis: s, arm: s });
      const rig = buildCanonicalRig('s', 'S', p);
      const r = fk(rig, standPose(rig));
      expect(standingHeight(p)).toBeCloseTo(sp(rig, r, 'head_top')[1], 14);
      expect(standingHeight(p)).toBeCloseTo(1.82 * s, 14);
      for (const side of ['left', 'right'] as const) {
        for (const n of Object.values(footSites(side))) expect(Math.abs(sp(rig, r, n)[1])).toBeLessThan(1e-14);
      }
    }
  });
});
