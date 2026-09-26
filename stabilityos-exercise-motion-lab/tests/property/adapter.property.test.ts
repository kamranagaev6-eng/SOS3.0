import { describe, expect, it } from 'vitest';
import type { BoneMap, HostSkeleton } from '../../src/core/contracts/hostRig.ts';
import type { HumanoidProportions } from '../../src/core/contracts/rig.ts';
import { createRng, type Rng } from '../../src/core/math/rng.ts';
import { quatConjugate, quatMultiply, quatNormalize, quatRotateVec3, type Quat } from '../../src/core/math/quat.ts';
import { distance, sub, type Vec3 } from '../../src/core/math/vec3.ts';
import { buildCanonicalRig, PROPORTIONS_A, scaleProportions } from '../../src/core/rig/canonical.ts';
import { getRigModel } from '../../src/core/rig/model.ts';
import {
  allAxisConventions,
  createHostBasis,
  createHostRigAdapter,
  identityHostFromRig,
  poseFromAngles,
  randomJointAngles,
  reexpressHost,
  RIG_B_DESIGN_PROPORTIONS,
  standingPelvisHeight,
  SYNTHETIC_HOST_RIGS,
  type HostRigAdapter,
} from '../../src/core/adapter/index.ts';

/**
 * Seeded randomized properties of the host-rig adapter: the derived canonical rig and the
 * reconstructed motion depend only on the host's rest GEOMETRY, not on how it is encoded
 * (units, right-handed axis labels, bone rest frames, extra unmapped bones, bone order, limb twist).
 */

const rigB = SYNTHETIC_HOST_RIGS.find((r) => r.id === 'synthetic-rig-b-host')!;
const RIGHT_HANDED = allAxisConventions().filter((c) => createHostBasis({ units: 'm', ...c }).ok);

function randomQuat(rng: Rng): Quat {
  return quatNormalize([rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]);
}

/** Changes every bone's rest frame by a random rotation while keeping all world positions. */
function reframe(host: HostSkeleton, map: BoneMap, rng: Rng): void {
  const Q = new Map(host.bones.map((b) => [b.name, randomQuat(rng)] as const));
  for (const b of host.bones) {
    const qp = b.parent ? Q.get(b.parent)! : ([0, 0, 0, 1] as Quat);
    b.restRotation = quatNormalize(quatMultiply(quatMultiply(quatConjugate(qp), b.restRotation), Q.get(b.name)!));
    b.restTranslation = quatRotateVec3(quatConjugate(qp), b.restTranslation);
  }
  for (const s of Object.values(map.sites)) s.offset = quatRotateVec3(quatConjugate(Q.get(s.bone)!), s.offset);
}

/** Inserts an unmapped bone between `child` and its parent with a random rest transform (host units). */
function insertIntermediate(host: HostSkeleton, child: string, rng: Rng, name: string, unitsPerMetre: number): void {
  const c = host.bones.find((b) => b.name === child)!;
  const t: Vec3 = [rng.range(-0.1, 0.1) * unitsPerMetre, rng.range(-0.1, 0.1) * unitsPerMetre, rng.range(-0.1, 0.1) * unitsPerMetre];
  const r = randomQuat(rng);
  host.bones.push({ name, parent: c.parent, restTranslation: t, restRotation: r, translatable: false });
  c.parent = name;
  c.restTranslation = quatRotateVec3(quatConjugate(r), sub(c.restTranslation, t));
  c.restRotation = quatNormalize(quatMultiply(quatConjugate(r), c.restRotation));
}

function shuffle<T>(xs: T[], rng: Rng): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [xs[i], xs[j]] = [xs[j]!, xs[i]!];
  }
}

function maxProportionDiff(a: HumanoidProportions, b: HumanoidProportions): number {
  let m = 0;
  const walk = (x: unknown, y: unknown): void => {
    if (typeof x === 'number') m = Math.max(m, Math.abs(x - (y as number)));
    else for (const k of Object.keys(x as object)) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k]);
  };
  walk(a, b);
  return m;
}

function maxJointAndSiteError(adapter: HostRigAdapter, rng: Rng, poses: number): number {
  const rig = adapter.canonical;
  const model = getRigModel(rig);
  const h = standingPelvisHeight(rig.proportions);
  let worst = 0;
  for (let k = 0; k < poses; k++) {
    const pose = poseFromAngles(rig, [rng.range(-2, 2), 0, rng.range(-2, 2)], [rng.range(-0.2, 0.2), rng.range(0.4 * h, 1.1 * h), rng.range(-0.2, 0.2)], randomJointAngles(rig, rng));
    const hp = adapter.toHostPose(pose);
    const world = new Map(adapter.hostWorldInCanonical(hp).map((w) => [w.name, w.position] as const));
    for (const b of adapter.bindings) {
      if (b.joint === 'root' || b.joint === 'pelvis') continue;
      worst = Math.max(worst, distance(world.get(b.bone)!, pose.worldPos[model.index.get(b.joint)!]!));
    }
    for (const s of adapter.hostSitePositions(hp)) worst = Math.max(worst, distance(s.position, pose.sitePos[model.siteIndex.get(s.name)!]!));
  }
  return worst;
}

describe('adapter properties (seeded)', () => {
  it('rig B re-encoded 40 random ways derives the same body and reproduces random poses within 1e-6 m', () => {
    const rng = createRng(0x5eed_ad);
    const limbTwist = ['hip_L', 'knee_R', 'shoulder_L', 'elbow_R', 'wrist_L', 'lumbar'];
    for (let trial = 0; trial < 40; trial++) {
      const conv = { units: rng.pick(['m', 'cm', 'mm'] as const), ...rng.pick(RIGHT_HANDED) };
      const { host, boneMap } = reexpressHost(structuredClone(rigB.host), structuredClone(rigB.boneMap), conv);
      reframe(host, boneMap, rng);
      const perMetre = { m: 1, cm: 100, mm: 1000 }[conv.units];
      insertIntermediate(host, 'thigh.L', rng, 'pelvis_side.L', perMetre);
      insertIntermediate(host, 'upperarm.R', rng, 'shoulder_extra.R', perMetre);
      insertIntermediate(host, 'chest', rng, 'spine_extra', perMetre);
      shuffle(host.bones, rng);
      boneMap.twist = Object.fromEntries(limbTwist.filter(() => rng.next() < 0.5).map((j) => [j, rng.range(-0.6, 0.6)]));
      const r = createHostRigAdapter(host, boneMap);
      expect(r.ok, JSON.stringify(r.diagnostics.slice(0, 3))).toBe(true);
      if (!r.ok) continue;
      expect(r.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
      expect(maxProportionDiff(r.adapter.canonical.proportions, RIG_B_DESIGN_PROPORTIONS)).toBeLessThan(1e-9);
      expect(maxJointAndSiteError(r.adapter, rng, 15)).toBeLessThan(1e-6);
      // No stretching: every non-motion bone keeps its rest translation exactly.
      const hp = r.adapter.toHostPose(poseFromAngles(r.adapter.canonical, [0.5, 0, -0.3], [0, 0.8, 0.05], randomJointAngles(r.adapter.canonical, rng)));
      hp.bones.forEach((b, i) => {
        if (b.name !== 'hips') expect(b.translation).toEqual(host.bones[i]!.restTranslation);
      });
    }
  });

  it('identity hosts of 30 random proportion sets round-trip proportions (1e-9 m) and poses (1e-9 m in metres, 1e-8 m in cm/mm)', () => {
    const rng = createRng(1234567);
    for (let trial = 0; trial < 30; trial++) {
      const p = scaleProportions(trial % 2 ? PROPORTIONS_A : RIG_B_DESIGN_PROPORTIONS, {
        leg: rng.range(0.8, 1.2),
        trunk: rng.range(0.8, 1.2),
        foot: rng.range(0.8, 1.25),
        pelvis: rng.range(0.85, 1.2),
        arm: rng.range(0.85, 1.15),
        leftLegExtra: rng.range(-0.02, 0.02),
      });
      // Keep the neck:head ratio of rig A, the only split an identity host cannot measure.
      p.trunk.head = 2 * p.trunk.neck;
      const rig = buildCanonicalRig(`random-${trial}`, `random ${trial}`, p);
      const conv = { units: rng.pick(['m', 'cm', 'mm'] as const), ...rng.pick(RIGHT_HANDED) };
      const id = identityHostFromRig(rig);
      const { host, boneMap } = reexpressHost(id.host, id.boneMap, conv);
      const r = createHostRigAdapter(host, boneMap);
      expect(r.ok, JSON.stringify(r.diagnostics.slice(0, 3))).toBe(true);
      if (!r.ok) continue;
      expect(maxProportionDiff(r.adapter.canonical.proportions, p)).toBeLessThan(1e-9);
      expect(maxJointAndSiteError(r.adapter, rng, 10)).toBeLessThan(conv.units === 'm' ? 1e-9 : 1e-8);
    }
  });
});
