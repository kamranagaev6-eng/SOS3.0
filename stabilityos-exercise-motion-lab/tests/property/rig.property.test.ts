/**
 * Seeded property tests for rig FK: over thousands of random poses on several rig proportions,
 * bones stay rigid, quaternions stay unit, joint rotations decompose back to their angles, and FK
 * agrees with an independent matrix implementation.
 */
import { describe, expect, it } from 'vitest';
import type { JointSpec, RigDefinition } from '../../src/core/contracts/rig.ts';
import { buildCanonicalRig, createRigA, PROPORTIONS_A, scaleProportions } from '../../src/core/rig/canonical.ts';
import { composeJointRotation, decomposeJointRotation, forwardKinematics, getRigModel, rigidLinks } from '../../src/core/rig/model.ts';
import { createRng, type Rng } from '../../src/core/math/rng.ts';
import type { Quat } from '../../src/core/math/quat.ts';
import type { Vec3 } from '../../src/core/math/vec3.ts';

const POSES_PER_RIG = 1000;

type M3 = number[];
const AX: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
function rodrigues(axis: readonly number[], angle: number): M3 {
  const [x, y, z] = [axis[0]!, axis[1]!, axis[2]!];
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
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o.push(a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!);
  return o;
}
function mv(m: M3, v: readonly number[]): Vec3 {
  return [
    m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!,
    m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!,
    m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!,
  ];
}
function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}
function maxAbsDiff(a: readonly number[], b: readonly number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
}
function refLocal(j: JointSpec, ang: readonly number[]): M3 {
  let m: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  j.dofs.forEach((d, k) => (m = mm(m, rodrigues(AX[d.axis]!.map((c) => c * d.sign), ang[k]!))));
  return m;
}
function wrap(d: number): number {
  return Math.abs(Math.atan2(Math.sin(d), Math.cos(d)));
}

function rigs(): { label: string; rig: RigDefinition }[] {
  return [
    { label: 'rig A', rig: createRigA() },
    { label: 'short/wide', rig: buildCanonicalRig('p1', 'P1', scaleProportions(PROPORTIONS_A, { leg: 0.85, trunk: 0.9, foot: 0.9, pelvis: 1.25, arm: 0.9 })) },
    { label: 'tall asymmetric', rig: buildCanonicalRig('p2', 'P2', scaleProportions(PROPORTIONS_A, { leg: 1.12, trunk: 1.08, foot: 1.1, arm: 1.1, leftLegExtra: 0.03 })) },
  ];
}

function randomAngles(rig: RigDefinition, rng: Rng, withinLimits: boolean): number[][] {
  return rig.joints.map((j) => j.dofs.map((d) => (withinLimits ? rng.range(d.min + 1e-9, d.max - 1e-9) : rng.range(-2 * Math.PI, 2 * Math.PI))));
}

describe('rig FK properties (seeded, >= 2000 random poses)', () => {
  for (const { label, rig } of rigs()) {
    it(`${label}: FK is rigid and all quaternions stay unit over ${POSES_PER_RIG} poses`, () => {
      const model = getRigModel(rig);
      const links = rigidLinks(model);
      const rng = createRng(0x51de + rig.id.length);
      let worstBone = 0;
      let worstSite = 0;
      let worstLocalNorm = 0;
      let worstWorldNorm = 0;
      for (let n = 0; n < POSES_PER_RIG; n++) {
        const angles = randomAngles(rig, rng, n % 2 === 0);
        const local = rig.joints.map((j, i) => composeJointRotation(j, angles[i]!));
        const rootT: Vec3 = [rng.range(-2, 2), rng.range(-1, 2), rng.range(-2, 2)];
        const pelvisOff: Vec3 = [rng.range(-0.2, 0.2), rng.range(-0.2, 0.2), rng.range(-0.2, 0.2)];
        const r = forwardKinematics(model, rootT, pelvisOff, local);
        for (const q of local) worstLocalNorm = Math.max(worstLocalNorm, Math.abs(Math.hypot(...q) - 1));
        for (const q of r.worldRot) worstWorldNorm = Math.max(worstWorldNorm, Math.abs(Math.hypot(...q) - 1));
        for (const l of links) {
          // independent: expected length straight from the rig definition
          const expected = Math.hypot(...rig.joints[l.b]!.offset);
          worstBone = Math.max(worstBone, Math.abs(dist(r.worldPos[l.a]!, r.worldPos[l.b]!) - expected) / expected);
        }
        rig.sites.forEach((s, i) => {
          const len = Math.hypot(...s.offset);
          worstSite = Math.max(worstSite, Math.abs(dist(r.sitePos[i]!, r.worldPos[model.index.get(s.joint)!]!) - len) / len);
        });
        // the pelvis is placed at root + R_root (rest + pelvisOffset): the only non-rigid "link"
        const pel = model.index.get('pelvis')!;
        const rootR = rodrigues([0, 1, 0], angles[0]![0]!);
        expect(maxAbsDiff(r.worldPos[pel]!, mv(rootR, pelvisOff).map((v, k) => v + rootT[k]!))).toBeLessThan(1e-13);
      }
      expect(worstBone).toBeLessThan(1e-12);
      expect(worstSite).toBeLessThan(1e-12);
      expect(worstLocalNorm).toBeLessThan(1e-14);
      expect(worstWorldNorm).toBeLessThan(1e-13);
    });

    it(`${label}: every joint rotation within limits decomposes back to its angles`, () => {
      const rng = createRng(0xdec0 + rig.id.length);
      for (let n = 0; n < POSES_PER_RIG; n++) {
        const angles = randomAngles(rig, rng, true);
        rig.joints.forEach((j, i) => {
          const d = decomposeJointRotation(j, composeJointRotation(j, angles[i]!));
          d.angles.forEach((a, k) => expect(wrap(a - angles[i]![k]!), `n=${n} ${j.name}.${j.dofs[k]!.name}`).toBeLessThan(1e-9));
          for (const res of d.residual) expect(Math.abs(res), `n=${n} ${j.name}`).toBeLessThan(1e-12);
        });
      }
    });

    it(`${label}: FK agrees with an independent Rodrigues-matrix FK`, () => {
      const model = getRigModel(rig);
      const rng = createRng(0xf1c + rig.id.length);
      for (let n = 0; n < 200; n++) {
        const angles = randomAngles(rig, rng, n % 2 === 0);
        const rootT: Vec3 = [rng.range(-1, 1), rng.range(0, 1.5), rng.range(-1, 1)];
        const pelvisOff: Vec3 = [rng.range(-0.1, 0.1), rng.range(-0.1, 0.1), rng.range(-0.1, 0.1)];
        const local: Quat[] = rig.joints.map((j, i) => composeJointRotation(j, angles[i]!));
        const r = forwardKinematics(model, rootT, pelvisOff, local);
        const pos = new Map<string, Vec3>();
        const rot = new Map<string, M3>();
        rig.joints.forEach((j, i) => {
          const L = refLocal(j, angles[i]!);
          if (j.parent === null) {
            pos.set(j.name, [j.offset[0] + rootT[0], j.offset[1] + rootT[1], j.offset[2] + rootT[2]]);
            rot.set(j.name, L);
          } else {
            const off = j.kind === 'pelvis' ? j.offset.map((v, k) => v + pelvisOff[k]!) : j.offset;
            const p = pos.get(j.parent)!;
            const w = mv(rot.get(j.parent)!, off);
            pos.set(j.name, [p[0] + w[0], p[1] + w[1], p[2] + w[2]]);
            rot.set(j.name, mm(rot.get(j.parent)!, L));
          }
          expect(maxAbsDiff(r.worldPos[i]!, pos.get(j.name)!), `n=${n} ${j.name}`).toBeLessThan(1e-13);
        });
        rig.sites.forEach((s, i) => {
          const p = pos.get(s.joint)!;
          const w = mv(rot.get(s.joint)!, s.offset);
          expect(maxAbsDiff(r.sitePos[i]!, [p[0] + w[0], p[1] + w[1], p[2] + w[2]]), `n=${n} ${s.name}`).toBeLessThan(1e-13);
        });
      }
    });
  }
});
