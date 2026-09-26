import { describe, expect, it } from 'vitest';
import type { Diagnostic } from '../../src/core/contracts/diagnostics.ts';
import type { BoneMap, HostSkeleton } from '../../src/core/contracts/hostRig.ts';
import { CAPABILITIES, type Capability, type HumanoidProportions } from '../../src/core/contracts/rig.ts';
import { createRng, type Rng } from '../../src/core/math/rng.ts';
import { quatAngleBetween, quatConjugate, quatFromAxisAngle, quatMultiply, quatRotateVec3, type Quat } from '../../src/core/math/quat.ts';
import { add, cross, distance, dot, length, normalize, sub, type Vec3 } from '../../src/core/math/vec3.ts';
import { deg } from '../../src/core/math/curves.ts';
import { createRigA, PROPORTIONS_A } from '../../src/core/rig/canonical.ts';
import { getRigModel } from '../../src/core/rig/model.ts';
import {
  allAxisConventions,
  assessCapabilities,
  capabilityRequirements,
  createHostBasis,
  createHostRigAdapter,
  identityHostFromRig,
  poseFromAngles,
  randomJointAngles,
  reexpressHost,
  RIG_B_CONVENTION,
  RIG_B_DESIGN_PROPORTIONS,
  standingPelvisHeight,
  SYNTHETIC_HOST_RIGS,
  type FkPose,
  type HostRigAdapter,
} from '../../src/core/adapter/index.ts';

// ------------------------------------------------------------------------------ helpers

const rigB = SYNTHETIC_HOST_RIGS.find((r) => r.id === 'synthetic-rig-b-host')!;
const rigC = SYNTHETIC_HOST_RIGS.find((r) => r.id === 'legacy-limb-rig-c')!;
const clone = <T>(x: T): T => structuredClone(x);

function mustAdapter(host: unknown, boneMap: unknown, req?: readonly Capability[]): HostRigAdapter {
  const r = createHostRigAdapter(host, boneMap, req);
  if (!r.ok) throw new Error(`adapter failed: ${JSON.stringify(r.diagnostics, null, 1)}`);
  return r.adapter;
}

function errors(ds: readonly Diagnostic[]): Diagnostic[] {
  return ds.filter((d) => d.severity === 'error');
}

function randomPose(adapter: HostRigAdapter, rng: Rng, fraction = 1): FkPose {
  const rig = adapter.canonical;
  const h = standingPelvisHeight(rig.proportions);
  return poseFromAngles(
    rig,
    [rng.range(-1, 1), 0, rng.range(-1, 1)],
    [rng.range(-0.15, 0.15), rng.range(0.45 * h, 1.05 * h), rng.range(-0.15, 0.15)],
    randomJointAngles(rig, rng, fraction),
  );
}

/** Max position / segment-direction / frame-rotation / site errors of the host reconstruction. */
function transferErrors(adapter: HostRigAdapter, pose: FkPose, opts: { pelvis?: boolean } = {}) {
  const model = getRigModel(adapter.canonical);
  const hp = adapter.toHostPose(pose);
  const world = new Map(adapter.hostWorldInCanonical(hp).map((w) => [w.name, w] as const));
  const boneOf = new Map(adapter.bindings.map((b) => [b.joint, b] as const));
  let pos = 0;
  let dir = 0;
  let rot = 0;
  for (const b of adapter.bindings) {
    if (b.joint === 'root') continue;
    const j = model.index.get(b.joint)!;
    const w = world.get(b.bone)!;
    if (b.joint !== 'pelvis' || opts.pelvis !== false) pos = Math.max(pos, distance(w.position, pose.worldPos[j]!));
    rot = Math.max(rot, quatAngleBetween(w.rotation, quatMultiply(pose.worldRot[j]!, b.bind)));
    for (let c = 0; c < model.jointCount; c++) {
      if (model.parent[c] !== j || b.joint === 'pelvis') continue;
      const cb = boneOf.get(model.names[c]!);
      if (!cb) continue;
      const hd = normalize(sub(world.get(cb.bone)!.position, w.position));
      const cd = normalize(sub(pose.worldPos[c]!, pose.worldPos[j]!));
      dir = Math.max(dir, Math.atan2(length(cross(hd, cd)), dot(hd, cd)));
    }
  }
  let site = 0;
  for (const s of adapter.hostSitePositions(hp)) site = Math.max(site, distance(s.position, pose.sitePos[model.siteIndex.get(s.name)!]!));
  return { pos, dir, rot, site, hostPose: hp };
}

function expectProportionsClose(a: HumanoidProportions, b: HumanoidProportions, tol: number): void {
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (typeof x === 'number') {
      expect(Math.abs(x - (y as number)), path).toBeLessThanOrEqual(tol);
      return;
    }
    for (const k of Object.keys(x as object)) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`);
  };
  walk(a, b, 'proportions');
}

/** Independent host FK in HOST coordinates and units (no adapter code). */
function hostRestWorld(host: HostSkeleton): Map<string, { p: Vec3; r: Quat }> {
  const out = new Map<string, { p: Vec3; r: Quat }>();
  const pending = [...host.bones];
  while (pending.length) {
    const i = pending.findIndex((b) => b.parent === null || out.has(b.parent));
    const b = pending.splice(i, 1)[0]!;
    const par = b.parent ? out.get(b.parent)! : { p: [0, 0, 0] as Vec3, r: [0, 0, 0, 1] as Quat };
    out.set(b.name, { p: add(par.p, quatRotateVec3(par.r, b.restTranslation)), r: quatMultiply(par.r, b.restRotation) });
  }
  return out;
}

/** Copy of the recipes' requiredCapabilities (inlined so these tests do not import the solver). */
const RECIPE_REQUIREMENTS = [
  { id: 'sit-to-stand.v1', requiredCapabilities: ['root-translation', 'pelvis-rotation', 'trunk-articulation', 'independent-legs', 'knee-hinge', 'ankle-2dof'] },
  { id: 'bilateral-squat.v1', requiredCapabilities: ['root-translation', 'pelvis-rotation', 'trunk-articulation', 'independent-legs', 'knee-hinge', 'ankle-2dof'] },
  { id: 'step-up-down.v1', requiredCapabilities: ['root-translation', 'pelvis-rotation', 'trunk-articulation', 'independent-legs', 'knee-hinge', 'ankle-2dof', 'forefoot-articulation'] },
  { id: 'bilateral-heel-raise.v1', requiredCapabilities: ['root-translation', 'pelvis-rotation', 'independent-legs', 'knee-hinge', 'ankle-2dof', 'forefoot-articulation'] },
] as const satisfies readonly { id: string; requiredCapabilities: readonly Capability[] }[];

// ------------------------------------------------------------------------------ (a) identity host

describe('adapter (a): canonical rig exported as an identity host', () => {
  const rigA = createRigA();
  const { host, boneMap } = identityHostFromRig(rigA);
  const res = createHostRigAdapter(host, boneMap, CAPABILITIES);

  it('builds with every capability, no warnings, and proportions equal to rig A', () => {
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(res.adapter.capabilities.every((c) => c.available)).toBe(true);
    expect(res.adapter.canonical.capabilities).toEqual([...CAPABILITIES]);
    expectProportionsClose(res.adapter.canonical.proportions, PROPORTIONS_A, 1e-12);
    expect(res.adapter.unmappedJoints).toEqual([]);
    expect(res.adapter.motionBone).toBe('pelvis');
  });

  it('round-trips random poses exactly (host world positions == canonical FK within 1e-9 m)', () => {
    if (!res.ok) throw new Error('adapter');
    const rng = createRng(0xa11ce);
    let worst = { pos: 0, dir: 0, rot: 0, site: 0 };
    for (let k = 0; k < 200; k++) {
      const pose = randomPose(res.adapter, rng);
      const e = transferErrors(res.adapter, pose);
      worst = { pos: Math.max(worst.pos, e.pos), dir: Math.max(worst.dir, e.dir), rot: Math.max(worst.rot, e.rot), site: Math.max(worst.site, e.site) };
      // Identity host: host local rotations are the canonical local rotations.
      const model = getRigModel(res.adapter.canonical);
      for (const b of e.hostPose.bones) expect(quatAngleBetween(b.rotation, pose.local[model.index.get(b.name)!]!)).toBeLessThan(1e-9);
      const byName = new Map(e.hostPose.bones.map((b) => [b.name, b] as const));
      expect(distance(byName.get('root')!.translation, pose.rootTranslation)).toBeLessThan(1e-12);
      expect(distance(byName.get('pelvis')!.translation, pose.pelvisOffset)).toBeLessThan(1e-12);
    }
    expect(worst.pos).toBeLessThan(1e-9);
    expect(worst.dir).toBeLessThan(1e-9);
    expect(worst.rot).toBeLessThan(1e-9);
    expect(worst.site).toBeLessThan(1e-9);
  });
});

// ------------------------------------------------------------------------------ (b) rig B

describe('adapter (b): synthetic rig B (cm, Z-up, T-pose, different proportions)', () => {
  const res = createHostRigAdapter(rigB.host, rigB.boneMap, CAPABILITIES);
  const adapter = res.ok ? res.adapter : (null as unknown as HostRigAdapter);

  it('is fully capable with no warnings', () => {
    expect(res.ok).toBe(true);
    expect(res.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(adapter.capabilities.map((c) => c.available)).toEqual(CAPABILITIES.map(() => true));
    expect(adapter.motionBone).toBe('hips');
    expect(adapter.host.units).toBe('cm');
    expect([adapter.host.up, adapter.host.forward, adapter.host.left]).toEqual(['+Z', '-Y', '+X']);
    expect(adapter.canonical.id).toBe('synthetic-rig-b-host.derived');
  });

  it('derives proportions equal to independent host rest measurements (and the design values)', () => {
    const w = hostRestWorld(rigB.host);
    const P = (n: string): Vec3 => w.get(n)!.p;
    const cm = 0.01;
    const site = (s: string): Vec3 => {
      const d = rigB.boneMap.sites[s]!;
      const b = w.get(d.bone)!;
      return add(b.p, quatRotateVec3(b.r, d.offset));
    };
    const pr = adapter.canonical.proportions;
    const close = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(1e-9);
    for (const [s, x] of [['left', 'L'], ['right', 'R']] as const) {
      close(pr[s].leg.thigh, distance(P(`thigh.${x}`), P(`shin.${x}`)) * cm);
      close(pr[s].leg.shank, distance(P(`shin.${x}`), P(`foot.${x}`)) * cm);
      const f = sub(P(`toes.${x}`), P(`foot.${x}`)); // host Z is up
      close(pr[s].leg.footLength, Math.hypot(f[0], f[1]) * cm);
      close(pr[s].leg.ankleHeight, (P(`foot.${x}`)[2] - site(`heel_${x}`)[2]) * cm);
      close(pr[s].leg.mtpHeight, (P(`toes.${x}`)[2] - site(`toe_${x}`)[2]) * cm);
      close(pr[s].arm.upperArm, distance(P(`upperarm.${x}`), P(`forearm.${x}`)) * cm);
      close(pr[s].arm.forearm, distance(P(`forearm.${x}`), P(`hand.${x}`)) * cm);
    }
    close(pr.pelvis.hipHalfWidth, (distance(P('thigh.L'), P('thigh.R')) / 2) * cm);
    close(pr.pelvis.hipDrop, (P('hips')[2] - P('thigh.L')[2]) * cm);
    close(pr.pelvis.lumbarBaseHeight, distance(P('hips'), P('spine_01')) * cm);
    close(pr.trunk.lumbar, distance(P('spine_01'), P('chest')) * cm);
    close(pr.trunk.thoracic, distance(P('chest'), P('neck_01')) * cm);
    close(pr.trunk.neck, distance(P('neck_01'), P('head')) * cm);
    close(pr.trunk.shoulderHalfWidth, (distance(P('upperarm.L'), P('upperarm.R')) / 2) * cm);
    expectProportionsClose(pr, RIG_B_DESIGN_PROPORTIONS, 1e-9);
    // Noticeably different from rig A.
    const legB = pr.left.leg.thigh + pr.left.leg.shank;
    const legA = PROPORTIONS_A.left.leg.thigh + PROPORTIONS_A.left.leg.shank;
    expect(legB / legA).toBeGreaterThan(1.07);
    expect(pr.trunk.lumbar + pr.trunk.thoracic).toBeLessThan(PROPORTIONS_A.trunk.lumbar + PROPORTIONS_A.trunk.thoracic);
    expect(pr.left.leg.footLength).toBeGreaterThan(PROPORTIONS_A.left.leg.footLength);
    expect(pr.pelvis.hipHalfWidth).toBeGreaterThan(PROPORTIONS_A.pelvis.hipHalfWidth);
  });

  it('has non-identity rest rotations and T-pose arms in the host data', () => {
    const w = hostRestWorld(rigB.host);
    const nonIdentity = rigB.host.bones.filter((b) => Math.abs(b.restRotation[3]) < 1 - 1e-9).length;
    expect(nonIdentity).toBeGreaterThan(rigB.host.bones.length / 2);
    // Upper arm → forearm is horizontal (host Z constant) in the rest pose.
    expect(Math.abs(w.get('upperarm.L')!.p[2] - w.get('forearm.L')!.p[2])).toBeLessThan(1e-9);
    expect(rigB.host.bones.find((b) => b.name === 'hips')!.translatable).toBe(true);
    expect(rigB.boneMap.joints).not.toHaveProperty('spine_02');
  });

  it('reproduces random canonical poses on the host (positions ≤ 1e-6 m, directions and frames ≤ 1e-6 rad)', () => {
    const rng = createRng(20260926);
    let worst = { pos: 0, dir: 0, rot: 0, site: 0 };
    for (let k = 0; k < 300; k++) {
      const e = transferErrors(adapter, randomPose(adapter, rng));
      worst = { pos: Math.max(worst.pos, e.pos), dir: Math.max(worst.dir, e.dir), rot: Math.max(worst.rot, e.rot), site: Math.max(worst.site, e.site) };
    }
    expect(worst.pos).toBeLessThan(1e-6);
    expect(worst.dir).toBeLessThan(1e-6);
    expect(worst.rot).toBeLessThan(1e-6);
    // Heel/toe/ball/seat/hand sites located through the host bones match the canonical sites.
    expect(worst.site).toBeLessThan(1e-6);
  });

  it('keeps every host bone translation at rest except the root-motion bone (no stretching)', () => {
    const rng = createRng(7);
    for (let k = 0; k < 20; k++) {
      const hp = adapter.toHostPose(randomPose(adapter, rng));
      expect(hp.bones.map((b) => b.name)).toEqual(rigB.host.bones.map((b) => b.name));
      hp.bones.forEach((b, i) => {
        if (b.name === 'hips') return;
        expect(b.translation).toEqual(rigB.host.bones[i]!.restTranslation);
      });
      // Unmapped bones keep their rest local rotation exactly.
      for (const name of ['spine_02', 'head', 'clavicle.L', 'clavicle.R']) {
        const i = rigB.host.bones.findIndex((b) => b.name === name);
        expect(hp.bones[i]!.rotation).toEqual(rigB.host.bones[i]!.restRotation);
      }
    }
  });

  it('writes root motion to hips in host units and axes (cm, Z up, forward −Y)', () => {
    const h = standingPelvisHeight(adapter.canonical.proportions);
    const pose = poseFromAngles(adapter.canonical, [0.2, 0, 0.3], [0.01, h - 0.1, -0.02]);
    const hips = adapter.toHostPose(pose).bones.find((b) => b.name === 'hips')!;
    // canonical pelvis origin (0.21, h-0.1, 0.28) m → host (X = left, Y = −forward, Z = up) cm
    const expected: Vec3 = [21, -28, (h - 0.1) * 100];
    expect(distance(hips.translation, expected)).toBeLessThan(1e-9);
  });

  it('turns the T-pose rest into canonical arms-down; 90° abduction restores the host T-pose', () => {
    const h = standingPelvisHeight(adapter.canonical.proportions);
    const rest = adapter.hostWorldInCanonical(adapter.toHostPose(poseFromAngles(adapter.canonical, [0, 0, 0], [0, h, 0])));
    const W = new Map(rest.map((b) => [b.name, b.position] as const));
    const armDir = normalize(sub(W.get('forearm.L')!, W.get('upperarm.L')!));
    expect(distance(armDir, [0, -1, 0])).toBeLessThan(1e-9);
    // Shoulder DOFs: [flexion, abduction, internalRotation].
    const tpose = poseFromAngles(adapter.canonical, [0, 0, 0], [0, h, 0], { shoulder_L: [0, deg(90), 0], shoulder_R: [0, deg(90), 0] });
    const hp = adapter.toHostPose(tpose);
    for (const name of ['upperarm.L', 'forearm.L', 'hand.L', 'upperarm.R', 'forearm.R', 'hand.R']) {
      const i = rigB.host.bones.findIndex((b) => b.name === name);
      expect(quatAngleBetween(hp.bones[i]!.rotation, rigB.host.bones[i]!.restRotation)).toBeLessThan(1e-9);
    }
  });

  it('applies boneMap.twist about the segment axis without moving joints', () => {
    const map = clone(rigB.boneMap);
    map.twist = { knee_L: 0.4 };
    const tw = mustAdapter(rigB.host, map);
    const b0 = adapter.bindings.find((b) => b.joint === 'knee_L')!.bind;
    const b1 = tw.bindings.find((b) => b.joint === 'knee_L')!.bind;
    expect(quatAngleBetween(b1, quatMultiply(quatFromAxisAngle([0, -1, 0], 0.4), b0))).toBeLessThan(1e-12);
    const rng = createRng(99);
    for (let k = 0; k < 20; k++) {
      const pose = randomPose(tw, rng);
      expect(transferErrors(tw, pose).pos).toBeLessThan(1e-6);
    }
  });

  /** Rig B with an extra root bone at the floor (rest rotation −90° about host X) above 'hips'. */
  function withRootBone(opts: { rootTranslatable: boolean; hipsTranslatable: boolean; mapRoot: boolean }): { host: HostSkeleton; boneMap: BoneMap } {
    const host = clone(rigB.host);
    const map = clone(rigB.boneMap);
    const rootR = quatFromAxisAngle([1, 0, 0], -Math.PI / 2);
    const rootT: Vec3 = [3, -4, 0]; // host cm, on the floor, slightly off the body origin
    const hips = host.bones.find((b) => b.name === 'hips')!;
    hips.parent = 'root';
    hips.translatable = opts.hipsTranslatable;
    hips.restTranslation = quatRotateVec3(quatConjugate(rootR), sub(hips.restTranslation, rootT));
    hips.restRotation = quatMultiply(quatConjugate(rootR), hips.restRotation);
    host.bones.unshift({ name: 'root', parent: null, restTranslation: rootT, restRotation: rootR, translatable: opts.rootTranslatable });
    if (opts.mapRoot) map.joints.root = 'root';
    return { host, boneMap: map };
  }

  it('solves root motion on a translatable root bone above a non-translatable hips bone', () => {
    const { host, boneMap } = withRootBone({ rootTranslatable: true, hipsTranslatable: false, mapRoot: false });
    const a = mustAdapter(host, boneMap);
    expect(a.motionBone).toBe('root');
    const rng = createRng(31);
    for (let k = 0; k < 50; k++) {
      const pose = randomPose(a, rng);
      const e = transferErrors(a, pose);
      expect(e.pos).toBeLessThan(1e-6);
      expect(e.site).toBeLessThan(1e-6);
      const hipsIdx = host.bones.findIndex((b) => b.name === 'hips');
      expect(e.hostPose.bones[hipsIdx]!.translation).toEqual(host.bones[hipsIdx]!.restTranslation);
    }
  });

  it('puts a translatable bone mapped to canonical root on the ground projection', () => {
    const { host, boneMap } = withRootBone({ rootTranslatable: true, hipsTranslatable: true, mapRoot: true });
    const a = mustAdapter(host, boneMap);
    expect(a.motionBone).toBe('hips');
    const rng = createRng(32);
    const model = getRigModel(a.canonical);
    for (let k = 0; k < 50; k++) {
      const pose = randomPose(a, rng);
      const e = transferErrors(a, pose);
      expect(e.pos).toBeLessThan(1e-6);
      const root = a.hostWorldInCanonical(e.hostPose).find((b) => b.name === 'root')!;
      expect(distance(root.position, pose.rootTranslation)).toBeLessThan(1e-9);
      const bind = a.bindings.find((b) => b.joint === 'root')!.bind;
      expect(quatAngleBetween(root.rotation, quatMultiply(pose.worldRot[model.index.get('root')!]!, bind))).toBeLessThan(1e-9);
    }
  });

  it('handles a host pelvis bone whose origin is off the hip midline (exact via root motion)', () => {
    // Move the hips bone origin 2 cm forward and 3 cm up without moving any other bone or site.
    const host = clone(rigB.host);
    const map = clone(rigB.boneMap);
    const hips = host.bones.find((b) => b.name === 'hips')!;
    const d: Vec3 = [0, -2, 3]; // host cm: −Y is forward, +Z is up
    hips.restTranslation = add(hips.restTranslation, d);
    const inv = quatConjugate(hips.restRotation);
    const dl = quatRotateVec3(inv, d);
    for (const b of host.bones) if (b.parent === 'hips') b.restTranslation = sub(b.restTranslation, dl);
    map.sites.seat!.offset = sub(map.sites.seat!.offset, dl);
    const moved = mustAdapter(host, map);
    // Origin projects onto the hip midline: 3 cm higher → hipDrop + 0.03, lumbarBaseHeight − 0.03.
    expect(moved.canonical.proportions.pelvis.hipDrop).toBeCloseTo(RIG_B_DESIGN_PROPORTIONS.pelvis.hipDrop + 0.03, 12);
    expect(moved.canonical.proportions.pelvis.lumbarBaseHeight).toBeCloseTo(RIG_B_DESIGN_PROPORTIONS.pelvis.lumbarBaseHeight - 0.03, 12);
    const rng = createRng(5);
    for (let k = 0; k < 50; k++) {
      const e = transferErrors(moved, randomPose(moved, rng), { pelvis: false });
      expect(e.pos).toBeLessThan(1e-6);
      expect(e.site).toBeLessThan(1e-6);
    }
  });
});

// ------------------------------------------------------------------------------ (c) units and axes

describe('adapter (c): unit and axis conversion', () => {
  it('has exactly 24 right-handed labellings out of 48', () => {
    const all = allAxisConventions();
    expect(all).toHaveLength(48);
    expect(all.filter((c) => createHostBasis({ units: 'm', ...c }).ok)).toHaveLength(24);
  });

  it('converts vectors and rotations exactly for rig B (cm, Z-up, forward −Y)', () => {
    const b = createHostBasis(RIG_B_CONVENTION);
    if (!b.ok) throw new Error(b.message);
    expect(b.basis.vecToHost([1, 2, 3])).toEqual([100, -300, 200]);
    expect(b.basis.vecToCanonical([100, -300, 200])).toEqual([1, 2, 3]);
    const s = Math.sin(0.35);
    const c = Math.cos(0.35);
    expect(b.basis.quatToHost([0, s, 0, c])).toEqual([0, 0, s, c]); // canonical yaw about +Y = host about +Z
    expect(b.basis.quatToHost([0, 0, s, c])).toEqual([0, -s, 0, c]); // canonical +Z (forward) = host −Y
    expect(b.basis.quatToHost([s, 0, 0, c])).toEqual([s, 0, 0, c]); // canonical +X (left) = host +X
  });

  it('converts metres, centimetres and millimetres', () => {
    for (const [units, f] of [['m', 1], ['cm', 100], ['mm', 1000]] as const) {
      const b = createHostBasis({ units, up: '+Y', forward: '+Z', left: '+X' });
      if (!b.ok) throw new Error(b.message);
      const v = b.basis.vecToHost([0.25, 1.5, -0.125]);
      expect(Math.abs(v[0] - 0.25 * f) + Math.abs(v[1] - 1.5 * f) + Math.abs(v[2] + 0.125 * f)).toBeLessThan(1e-9);
      expect(b.basis.scale * f).toBeCloseTo(1, 15);
    }
  });

  it('gives the same body and the same motion for all 24 right-handed conventions × 3 units', () => {
    const rng = createRng(4242);
    const ref = mustAdapter(rigB.host, rigB.boneMap);
    const poses = Array.from({ length: 3 }, () => randomPose(ref, rng));
    const refWorld = poses.map((p) => ref.hostWorldInCanonical(ref.toHostPose(p)));
    let count = 0;
    for (const lab of allAxisConventions()) {
      if (!createHostBasis({ units: 'm', ...lab }).ok) continue;
      for (const units of ['m', 'cm', 'mm'] as const) {
        const conv = { units, ...lab };
        const { host, boneMap } = reexpressHost(rigB.host, rigB.boneMap, conv);
        const a = mustAdapter(host, boneMap);
        expectProportionsClose(a.canonical.proportions, RIG_B_DESIGN_PROPORTIONS, 1e-9);
        poses.forEach((p, k) => {
          const hp = a.toHostPose(p);
          const world = a.hostWorldInCanonical(hp);
          world.forEach((w, i) => expect(distance(w.position, refWorld[k]![i]!.position)).toBeLessThan(1e-6));
          // The root-motion translation, converted back by hand, equals the canonical pelvis origin.
          const b = createHostBasis(conv);
          if (!b.ok) throw new Error('basis');
          const hips = hp.bones.find((x) => x.name === 'hips')!;
          const pelvisJ = getRigModel(a.canonical).index.get('pelvis')!;
          expect(distance(b.basis.vecToCanonical(hips.translation), p.worldPos[pelvisJ]!)).toBeLessThan(1e-6);
        });
        count++;
      }
    }
    expect(count).toBe(72);
  });

  it('rejects every left-handed labelling with an actionable RIG_INVALID', () => {
    let rejected = 0;
    for (const lab of allAxisConventions()) {
      if (createHostBasis({ units: 'm', ...lab }).ok) continue;
      const host = { ...clone(rigB.host), ...lab };
      const r = createHostRigAdapter(host, rigB.boneMap);
      expect(r.ok).toBe(false);
      const d = r.diagnostics.find((x) => x.code === 'RIG_INVALID' && x.message.includes('left-handed'));
      expect(d, JSON.stringify(lab)).toBeDefined();
      expect(d!.hint).toMatch(/right-handed/);
      rejected++;
    }
    expect(rejected).toBe(24);
    // Unity-style (Y up, Z forward, X right) is left-handed.
    const unity = createHostRigAdapter({ ...clone(rigB.host), up: '+Y', forward: '+Z', left: '-X' }, rigB.boneMap);
    expect(unity.ok).toBe(false);
  });

  it('rejects labels that reuse an axis', () => {
    const r = createHostRigAdapter({ ...clone(rigB.host), up: '+Z', forward: '-Z', left: '+X' }, rigB.boneMap);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 'RIG_INVALID' && /distinct axes/.test(d.message))).toBe(true);
  });

  it('detects a wrong up label from the geometry (legs must point down)', () => {
    const r = createHostRigAdapter({ ...clone(rigB.host), up: '+Y', forward: '+Z', left: '+X' }, rigB.boneMap);
    expect(r.ok).toBe(false);
    expect(errors(r.diagnostics).length).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------------------------------ (d) rig C

describe('adapter (d): legacy rig C incompatibility', () => {
  const req = capabilityRequirements(RECIPE_REQUIREMENTS);

  it('refuses the recipes with actionable MISSING_CAPABILITY errors', () => {
    const r = createHostRigAdapter(rigC.host, rigC.boneMap, req.capabilities, { requiredBy: req.requiredBy });
    expect(r.ok).toBe(false);
    const missing = r.diagnostics.filter((d) => d.code === 'MISSING_CAPABILITY' && d.severity === 'error');
    expect(missing.map((d) => d.subject).sort()).toEqual(['forefoot-articulation', 'root-translation', 'trunk-articulation']);
    const by = (c: string): Diagnostic => missing.find((d) => d.subject === c)!;
    expect(by('root-translation').hint).toMatch(/"translatable": true on 'Body'/);
    expect(by('root-translation').hint).toMatch(/sit-to-stand\.v1/);
    expect(by('trunk-articulation').hint).toMatch(/child of 'Body'/);
    expect(by('trunk-articulation').hint).toMatch(/'lumbar'/);
    expect(by('trunk-articulation').hint).toMatch(/sit-to-stand\.v1, bilateral-squat\.v1 and step-up-down\.v1 \(trunk lean/);
    expect(by('forefoot-articulation').hint).toContain("Add a child bone of 'Foot_L' at the metatarsophalangeal joint and map it to 'mtp_L'");
    expect(by('forefoot-articulation').hint).toContain("'Foot_R'");
    expect(by('forefoot-articulation').hint).toMatch(/step-up-down\.v1 and bilateral-heel-raise\.v1 \(forefoot contact\)/);
    for (const d of missing) expect(d.message).toContain("'legacy-limb-rig-c'");
  });

  it('assesses capabilities from the hierarchy alone', () => {
    const caps = new Map(assessCapabilities(rigC.host, rigC.boneMap).map((c) => [c.capability, c] as const));
    expect(caps.get('root-translation')!.available).toBe(false);
    expect(caps.get('trunk-articulation')!.available).toBe(false);
    expect(caps.get('forefoot-articulation')!.available).toBe(false);
    expect(caps.get('pelvis-rotation')!.available).toBe(true);
    expect(caps.get('pelvis-rotation')!.reason).toMatch(/rigidly/);
    for (const c of ['independent-legs', 'knee-hinge', 'ankle-2dof', 'independent-arms', 'neck'] as const) expect(caps.get(c)!.available).toBe(true);
  });

  it('without requirements reports availability only, and never folds missing DOFs into other bones', () => {
    const r = createHostRigAdapter(rigC.host, rigC.boneMap);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.adapter;
    expect(r.diagnostics.filter((d) => d.code === 'MISSING_CAPABILITY').every((d) => d.severity === 'warning')).toBe(true);
    expect(r.diagnostics.some((d) => d.code === 'ESTIMATED_GEOMETRY' && d.subject === 'seat' && d.severity === 'warning')).toBe(true);
    expect(r.diagnostics.some((d) => d.code === 'ESTIMATED_GEOMETRY' && d.subject === 'heel_L' && d.severity === 'warning')).toBe(true);
    expect(a.canonical.capabilities).not.toContain('root-translation');
    expect(a.canonical.capabilities).not.toContain('forefoot-articulation');
    expect([...a.unmappedJoints].sort()).toEqual(['lumbar', 'mtp_L', 'mtp_R', 'thoracic']);
    expect(a.motionBone).toBeNull();
    expect(a.estimatedSites).toContain('seat');
    const h = standingPelvisHeight(a.canonical.proportions);
    const pose = poseFromAngles(a.canonical, [0.3, 0, 0], [0, h - 0.2, 0], { lumbar: [deg(30), 0, 0], mtp_L: [deg(40)] });
    const hp = a.toHostPose(pose);
    const idx = (n: string): number => rigC.host.bones.findIndex((b) => b.name === n);
    // Trunk flexion is dropped: arms and head keep their rest relation to Body, Body keeps rest.
    for (const n of ['Body', 'UpperArm_L', 'UpperArm_R', 'Head']) expect(quatAngleBetween(hp.bones[idx(n)]!.rotation, rigC.host.bones[idx(n)]!.restRotation)).toBeLessThan(1e-12);
    for (const b of hp.bones) expect(b.translation).toEqual(rigC.host.bones[idx(b.name)]!.restTranslation);
    const un = a.unrepresentedMotion(pose);
    expect(un.find((u) => u.subject === 'lumbar')!.magnitude).toBeCloseTo(deg(30), 12);
    expect(un.find((u) => u.subject === 'mtp_L')!.magnitude).toBeCloseTo(deg(40), 12);
    expect(un.find((u) => u.subject === 'pelvis' && u.kind === 'translation')!.magnitude).toBeGreaterThan(0.2);
  });
});

// ------------------------------------------------------------------------------ (e) invalid inputs

describe('adapter (e): invalid inputs produce specific diagnostics, never exceptions', () => {
  const run = (host: unknown, map: unknown, req?: unknown) => {
    let r: ReturnType<typeof createHostRigAdapter> | undefined;
    expect(() => {
      r = createHostRigAdapter(host, map, req as readonly Capability[] | undefined);
    }).not.toThrow();
    return r!;
  };
  const hostB = (): HostSkeleton => clone(rigB.host);
  const mapB = (): BoneMap => clone(rigB.boneMap);
  const expectCode = (r: ReturnType<typeof createHostRigAdapter>, code: string, re?: RegExp, subject?: string): Diagnostic => {
    expect(r.ok).toBe(false);
    const d = r.diagnostics.find((x) => x.code === code && x.severity === 'error' && (!re || re.test(x.message)) && (!subject || x.subject === subject));
    expect(d, JSON.stringify(r.diagnostics, null, 1)).toBeDefined();
    return d!;
  };

  it('mapped bone missing → MISSING_BONE naming the canonical joint and the expected host bone', () => {
    const m = mapB();
    m.joints.knee_L = 'shin.X';
    const d = expectCode(run(hostB(), m), 'MISSING_BONE', /'knee_L'.*'shin\.X'/, 'knee_L');
    expect(d.path).toBe('boneMap.joints.knee_L');
  });

  it('required joint unmapped → MISSING_BONE with candidate child bones', () => {
    const m = mapB();
    delete m.joints.knee_L;
    const d = expectCode(run(hostB(), m), 'MISSING_BONE', /knee_L/, 'knee_L');
    expect(d.hint).toContain("child of 'thigh.L'");
    expect(d.hint).toContain("'shin.L'");
  });

  it('cycle → RIG_INVALID naming the loop', () => {
    const h = hostB();
    h.bones.find((b) => b.name === 'spine_01')!.parent = 'chest';
    expectCode(run(h, mapB()), 'RIG_INVALID', /cycle/);
  });

  it('duplicate bone names → RIG_INVALID', () => {
    const h = hostB();
    h.bones.push({ ...clone(h.bones.find((b) => b.name === 'thigh.L')!) });
    expectCode(run(h, mapB()), 'RIG_INVALID', /two bones named 'thigh\.L'/);
  });

  it('unknown parent → RIG_INVALID', () => {
    const h = hostB();
    h.bones.find((b) => b.name === 'head')!.parent = 'skull';
    expectCode(run(h, mapB()), 'RIG_INVALID', /'skull'/, 'head');
  });

  it('NaN / Infinity in rest transforms → RIG_INVALID naming the bone', () => {
    const h = hostB();
    h.bones.find((b) => b.name === 'shin.L')!.restTranslation[1] = Number.NaN;
    const d = expectCode(run(h, mapB()), 'RIG_INVALID', /not a finite number \(NaN\)/, 'shin.L');
    expect(d.path).toMatch(/restTranslation\[1\]$/);
    const h2 = hostB();
    h2.bones.find((b) => b.name === 'foot.R')!.restRotation[0] = Number.POSITIVE_INFINITY;
    expectCode(run(h2, mapB()), 'RIG_INVALID', /not a finite number/, 'foot.R');
  });

  it('non-unit quaternion → RIG_INVALID with its length', () => {
    const h = hostB();
    h.bones.find((b) => b.name === 'chest')!.restRotation = [0, 0, 0, 2];
    const d = expectCode(run(h, mapB()), 'RIG_INVALID', /not a unit quaternion/, 'chest');
    expect(d.value).toBeCloseTo(2, 12);
  });

  it('left/right swapped mapping → RIG_HIERARCHY_MISMATCH', () => {
    const m = mapB();
    const swapped: Record<string, string> = {};
    for (const [k, v] of Object.entries(m.joints)) {
      const kk = k.endsWith('_L') ? `${k.slice(0, -2)}_R` : k.endsWith('_R') ? `${k.slice(0, -2)}_L` : k;
      swapped[kk] = v;
    }
    m.joints = swapped;
    const s2: typeof m.sites = {};
    for (const [k, v] of Object.entries(m.sites)) s2[k.endsWith('_L') ? `${k.slice(0, -2)}_R` : k.endsWith('_R') ? `${k.slice(0, -2)}_L` : k] = v;
    m.sites = s2;
    const d = expectCode(run(hostB(), m), 'RIG_HIERARCHY_MISMATCH', /swapped/);
    expect(d.hint).toMatch(/Swap the _L and _R/);
    // Legs swapped but sites left as they were: the swap is reported first (root cause).
    const m2 = mapB();
    for (const j of ['hip', 'knee', 'ankle', 'mtp']) [m2.joints[`${j}_L`], m2.joints[`${j}_R`]] = [m2.joints[`${j}_R`]!, m2.joints[`${j}_L`]!];
    const r2 = run(hostB(), m2);
    expect(r2.ok).toBe(false);
    expect(r2.diagnostics[0]!.code).toBe('RIG_HIERARCHY_MISMATCH');
    expect(r2.diagnostics[0]!.message).toMatch(/left\/right appear swapped: 'hip_L' is mapped to 'thigh\.R'/);
  });

  it('knee not below its hip, shared leg bones, chains through other joints → RIG_HIERARCHY_MISMATCH', () => {
    const m1 = mapB();
    m1.joints.knee_L = 'shin.R';
    expectCode(run(hostB(), m1), 'RIG_HIERARCHY_MISMATCH', /not a descendant of 'thigh\.L'/);
    const m2 = mapB();
    m2.joints.knee_R = 'shin.L';
    expectCode(run(hostB(), m2), 'RIG_HIERARCHY_MISMATCH', /several canonical joints/);
    const h3 = hostB();
    h3.bones.find((b) => b.name === 'thigh.R')!.parent = 'thigh.L';
    expectCode(run(h3, mapB()), 'RIG_HIERARCHY_MISMATCH', /passes through 'thigh\.L'/);
    const m4 = mapB();
    m4.sites.toe_L = { bone: 'shin.L', offset: [0, 0, 0] };
    expectCode(run(hostB(), m4), 'RIG_HIERARCHY_MISMATCH', /site 'toe_L'/);
  });

  it('bone map for another skeleton, unknown names, bad requirements → specific errors', () => {
    const m = mapB();
    m.hostSkeletonId = 'someone-else';
    expectCode(run(hostB(), m), 'RIG_INVALID', /written for skeleton 'someone-else'/);
    const m2 = mapB();
    m2.joints.kne_L = 'shin.L';
    expectCode(run(hostB(), m2), 'SCHEMA_INVALID', /unknown canonical name 'kne_L'/);
    const m3 = mapB();
    m3.twist = { spine_02: 0.1 };
    expectCode(run(hostB(), m3), 'SCHEMA_INVALID', /twist/);
    expectCode(run(hostB(), mapB(), ['teleport']), 'SCHEMA_INVALID', /teleport/);
  });

  it('malformed JSON-like inputs → SCHEMA_INVALID, never exceptions', () => {
    const bad: unknown[] = [null, undefined, 42, 'not json {', '{"schema":1}', [], {}, { bones: 'x' }, { ...hostB(), bones: [] }, { ...hostB(), units: 'ft' }];
    for (const h of bad) {
      const r = run(h, mapB());
      expect(r.ok).toBe(false);
      expect(errors(r.diagnostics).length).toBeGreaterThan(0);
      expect(r.diagnostics.every((d) => ['SCHEMA_INVALID', 'RIG_INVALID'].includes(d.code))).toBe(true);
    }
    for (const m of [null, 'x', { joints: 5 }, { ...mapB(), sites: { heel_L: { bone: 'foot.L', offset: [0, 'a', 0] } } }]) {
      const r = run(hostB(), m);
      expect(r.ok).toBe(false);
      expect(r.diagnostics.some((d) => d.code === 'SCHEMA_INVALID')).toBe(true);
    }
    // A throwing getter is still turned into a diagnostic.
    const hostile = Object.defineProperty({}, 'schema', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const r = run(hostile, mapB());
    expect(r.ok).toBe(false);
    // Valid JSON strings are accepted.
    expect(run(JSON.stringify(rigB.host), JSON.stringify(rigB.boneMap)).ok).toBe(true);
  });
});
