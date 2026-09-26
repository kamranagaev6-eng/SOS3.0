import { SCHEMA, SIDES } from '../contracts/common.ts';
import type { BoneMap, HostBone, HostSkeleton } from '../contracts/hostRig.ts';
import type { HumanoidProportions, RigDefinition } from '../contracts/rig.ts';
import { mat3FromColumns, mat3Multiply, mat3AxisRotation } from '../math/mat3.ts';
import { IDENTITY_Q, quatConjugate, quatFromMat3, quatMultiply, quatNormalize, quatRotateVec3, type Quat } from '../math/quat.ts';
import { add, cross, normalize, rejectFrom, sub, type Vec3 } from '../math/vec3.ts';
import { armJoints, footSites, legJoints } from '../rig/canonical.ts';
import { createHostBasis, type AxisConvention, type HostBasis } from './basis.ts';
import { standingPelvisHeight } from './pose.ts';

/**
 * Synthetic host skeletons used to exercise the adapter. All geometry is original and synthetic
 * (engineering fixtures, not measurements of any person or product rig).
 */

function basisOrThrow(conv: AxisConvention): HostBasis {
  const r = createHostBasis(conv);
  if (!r.ok) throw new Error(`invalid convention: ${r.message}`);
  return r.basis;
}

interface DesignBone {
  name: string;
  parent: string | null;
  /** Rest head position, canonical world (m). */
  head: Vec3;
  /** Point the bone's local +Y axis aims at (Blender-style), canonical world (m). */
  tail: Vec3;
  /** Roll reference: local +Z is this canonical direction made orthogonal to the bone axis. */
  zRef: Vec3;
  /** Extra roll about the bone's own +Y axis (rad). */
  roll?: number;
  translatable?: boolean;
}

interface DesignSite {
  site: string;
  bone: string;
  /** Canonical world position (m) in the rest pose. */
  at: Vec3;
}

/**
 * Builds a host skeleton from a world-space design: positions in canonical metres, bone frames
 * Blender-style (local +Y toward the tail, +Z toward `zRef`, plus roll), then expressed as host
 * local rest transforms in the host's units and axes. Site offsets are expressed in the host
 * bone's rest frame, host units.
 */
function hostFromDesign(
  id: string,
  name: string,
  conv: AxisConvention,
  bones: readonly DesignBone[],
  sites: readonly DesignSite[],
  frames: 'bone-aligned' | 'identity',
): { host: HostSkeleton; siteOffsets: Record<string, { bone: string; offset: Vec3 }> } {
  const basis = basisOrThrow(conv);
  const worldR = new Map<string, Quat>();
  const worldP = new Map<string, Vec3>();
  const out: HostBone[] = [];
  for (const b of bones) {
    const Ph = basis.vecToHost(b.head);
    let Rh: Quat = IDENTITY_Q;
    if (frames === 'bone-aligned') {
      const y = normalize(basis.dirToHost(sub(b.tail, b.head)));
      const z = normalize(rejectFrom(basis.dirToHost(b.zRef), y));
      const x = cross(y, z);
      const m = mat3Multiply(mat3FromColumns(x, y, z), mat3AxisRotation(1, b.roll ?? 0));
      Rh = quatFromMat3(m);
    }
    worldR.set(b.name, Rh);
    worldP.set(b.name, Ph);
    let t: Vec3 = [...Ph];
    let r: Quat = [...Rh];
    if (b.parent !== null) {
      const pr = worldR.get(b.parent)!;
      const pp = worldP.get(b.parent)!;
      t = quatRotateVec3(quatConjugate(pr), sub(Ph, pp));
      r = quatNormalize(quatMultiply(quatConjugate(pr), Rh));
    }
    out.push({ name: b.name, parent: b.parent, restTranslation: t, restRotation: r, translatable: b.translatable ?? false });
  }
  const siteOffsets: Record<string, { bone: string; offset: Vec3 }> = {};
  for (const s of sites) {
    const r = worldR.get(s.bone)!;
    const p = worldP.get(s.bone)!;
    siteOffsets[s.site] = { bone: s.bone, offset: quatRotateVec3(quatConjugate(r), sub(basis.vecToHost(s.at), p)) };
  }
  return {
    host: { schema: SCHEMA.hostSkeleton, id, name, units: conv.units, up: conv.up, forward: conv.forward, left: conv.left, bones: out },
    siteOffsets,
  };
}

const rotY = (v: Vec3, a: number): Vec3 => [Math.cos(a) * v[0] + Math.sin(a) * v[2], v[1], -Math.sin(a) * v[0] + Math.cos(a) * v[2]];
const UPV: Vec3 = [0, 1, 0];
const FWDV: Vec3 = [0, 0, 1];

// ------------------------------------------------------------------------------------------ rig B

/**
 * Rig B design proportions (canonical metres). Versus rig A: legs ≈ 8 % longer
 * (thigh + shank 0.94 vs 0.87 m), trunk shorter (pelvis→neck 0.51 vs 0.57 m), feet larger
 * (foot length 0.155 vs 0.14 m, width 0.10 vs 0.09 m), hips wider (half-width 0.105 vs 0.09 m).
 */
export const RIG_B_DESIGN_PROPORTIONS: HumanoidProportions = (() => {
  const leg = { thigh: 0.475, shank: 0.465, ankleHeight: 0.085, heelBack: 0.06, footLength: 0.155, mtpHeight: 0.024, toeLength: 0.066, footWidth: 0.1 };
  const arm = { upperArm: 0.31, forearm: 0.27, hand: 0.19 };
  return {
    pelvis: { hipHalfWidth: 0.105, hipDrop: 0.03, seatDrop: 0.115, seatBack: 0.04, lumbarBaseHeight: 0.08 },
    trunk: { lumbar: 0.16, thoracic: 0.27, neck: 0.09, head: 0.21, shoulderHalfWidth: 0.19, shoulderDrop: 0.045 },
    left: { leg: { ...leg }, arm: { ...arm } },
    right: { leg: { ...leg }, arm: { ...arm } },
  };
})();

/** Rest toe-out of rig B's feet (rad, each foot turned outward). */
export const RIG_B_TOE_OUT = (7 * Math.PI) / 180;

/**
 * Rig B convention (Blender-like, right-handed): units cm, up = +Z, subject faces −Y
 * (forward = −Y), subject's left = +X. Check: left × up = X × Z = −Y = forward.
 */
export const RIG_B_CONVENTION: AxisConvention = { units: 'cm', up: '+Z', forward: '-Y', left: '+X' };

function buildRigB(): { host: HostSkeleton; boneMap: BoneMap } {
  const p = RIG_B_DESIGN_PROPORTIONS;
  const L = p.left.leg;
  const pelvisY = standingPelvisHeight(p);
  const hipY = pelvisY - p.pelvis.hipDrop;
  const pelvis: Vec3 = [0, pelvisY, 0];
  const spine01: Vec3 = [0, pelvisY + p.pelvis.lumbarBaseHeight, 0];
  const spine02: Vec3 = [0, spine01[1] + 0.075, 0.018]; // unmapped: lumbar lordosis bump
  const chest: Vec3 = [0, spine01[1] + p.trunk.lumbar, 0];
  const neck01: Vec3 = [0, chest[1] + p.trunk.thoracic, 0];
  const headB: Vec3 = [0, neck01[1] + p.trunk.neck, 0];
  const headTop: Vec3 = [0, headB[1] + p.trunk.head, 0];
  const bones: DesignBone[] = [
    { name: 'hips', parent: null, head: pelvis, tail: spine01, zRef: FWDV, translatable: true },
    { name: 'spine_01', parent: 'hips', head: spine01, tail: spine02, zRef: FWDV },
    { name: 'spine_02', parent: 'spine_01', head: spine02, tail: chest, zRef: FWDV, roll: 0.1 },
    { name: 'chest', parent: 'spine_02', head: chest, tail: neck01, zRef: FWDV },
    { name: 'neck_01', parent: 'chest', head: neck01, tail: headB, zRef: FWDV },
    { name: 'head', parent: 'neck_01', head: headB, tail: headTop, zRef: FWDV },
  ];
  const sites: DesignSite[] = [
    { site: 'head_top', bone: 'head', at: headTop },
    { site: 'seat', bone: 'hips', at: [0, pelvisY - p.pelvis.seatDrop, -p.pelvis.seatBack] },
  ];
  const map: Record<string, string> = { pelvis: 'hips', lumbar: 'spine_01', thoracic: 'chest', neck: 'neck_01' };
  const rolls: Record<string, number> = { 'shin.L': 0.2, 'upperarm.L': -0.35, 'forearm.R': 0.5, 'foot.R': -0.15, 'toes.L': 0.25 };
  for (const side of SIDES) {
    const sx = side === 'left' ? 1 : -1;
    const s = side === 'left' ? 'L' : 'R';
    const A = p[side].arm;
    const shoulder: Vec3 = [sx * p.trunk.shoulderHalfWidth, chest[1] + p.trunk.thoracic - p.trunk.shoulderDrop, 0];
    const clav: Vec3 = [sx * 0.03, chest[1] + 0.2, 0.03];
    const elbow: Vec3 = [shoulder[0] + sx * A.upperArm, shoulder[1], 0]; // T-pose: arms horizontal
    const wrist: Vec3 = [elbow[0] + sx * A.forearm, shoulder[1], 0];
    const handEnd: Vec3 = [wrist[0] + sx * A.hand, shoulder[1], 0];
    const hip: Vec3 = [sx * p.pelvis.hipHalfWidth, hipY, 0];
    const knee: Vec3 = [hip[0], hipY - L.thigh, 0];
    const ankle: Vec3 = [hip[0], knee[1] - L.shank, 0];
    const psi = sx * RIG_B_TOE_OUT; // left foot turns toward +X, right toward −X
    const mtp = add(ankle, rotY([0, -(L.ankleHeight - L.mtpHeight), L.footLength], psi));
    const toe = add(mtp, rotY([0, -L.mtpHeight, L.toeLength], psi));
    const heel = add(ankle, rotY([0, -L.ankleHeight, -L.heelBack], psi));
    const medial = -sx;
    const ballMed = add(mtp, rotY([medial * L.footWidth * 0.5, -L.mtpHeight, 0], psi));
    const ballLat = add(mtp, rotY([-medial * L.footWidth * 0.5, -L.mtpHeight, 0], psi));
    const n = (b: string): string => `${b}.${s}`;
    bones.push(
      { name: n('clavicle'), parent: 'chest', head: clav, tail: shoulder, zRef: UPV },
      { name: n('upperarm'), parent: n('clavicle'), head: shoulder, tail: elbow, zRef: UPV, roll: rolls[n('upperarm')] ?? 0 },
      { name: n('forearm'), parent: n('upperarm'), head: elbow, tail: wrist, zRef: UPV, roll: rolls[n('forearm')] ?? 0 },
      { name: n('hand'), parent: n('forearm'), head: wrist, tail: handEnd, zRef: UPV },
      { name: n('thigh'), parent: 'hips', head: hip, tail: knee, zRef: FWDV },
      { name: n('shin'), parent: n('thigh'), head: knee, tail: ankle, zRef: FWDV, roll: rolls[n('shin')] ?? 0 },
      { name: n('foot'), parent: n('shin'), head: ankle, tail: mtp, zRef: UPV, roll: rolls[n('foot')] ?? 0 },
      { name: n('toes'), parent: n('foot'), head: mtp, tail: toe, zRef: UPV, roll: rolls[n('toes')] ?? 0 },
    );
    const lj = legJoints(side);
    const aj = armJoints(side);
    const fs = footSites(side);
    Object.assign(map, {
      [aj.shoulder]: n('upperarm'),
      [aj.elbow]: n('forearm'),
      [aj.wrist]: n('hand'),
      [lj.hip]: n('thigh'),
      [lj.knee]: n('shin'),
      [lj.ankle]: n('foot'),
      [lj.mtp]: n('toes'),
    });
    sites.push(
      { site: fs.heel, bone: n('foot'), at: heel },
      { site: fs.toe, bone: n('toes'), at: toe },
      { site: fs.ballMedial, bone: n('toes'), at: ballMed },
      { site: fs.ballLateral, bone: n('toes'), at: ballLat },
      { site: `hand_${s}`, bone: n('hand'), at: handEnd },
    );
  }
  const { host, siteOffsets } = hostFromDesign('synthetic-rig-b-host', 'Synthetic rig B (host export: cm, Z-up, T-pose)', RIG_B_CONVENTION, bones, sites, 'bone-aligned');
  return { host, boneMap: { schema: SCHEMA.boneMap, hostSkeletonId: host.id, joints: map, sites: siteOffsets, twist: {} } };
}

// ------------------------------------------------------------------------------------------ rig C

/** Rig C convention: metres, +Y up, +Z forward, +X left (glTF-like), identity rest rotations. */
export const RIG_C_CONVENTION: AxisConvention = { units: 'm', up: '+Y', forward: '+Z', left: '+X' };

function buildRigC(): { host: HostSkeleton; boneMap: BoneMap } {
  const body: Vec3 = [0, 0.95, 0];
  const bones: DesignBone[] = [
    { name: 'Body', parent: null, head: body, tail: [0, 1.5, 0], zRef: FWDV },
    { name: 'Head', parent: 'Body', head: [0, 1.52, 0], tail: [0, 1.75, 0], zRef: FWDV },
  ];
  const map: Record<string, string> = { pelvis: 'Body', neck: 'Head' };
  for (const side of SIDES) {
    const sx = side === 'left' ? 1 : -1;
    const s = side === 'left' ? 'L' : 'R';
    const n = (b: string): string => `${b}_${s}`;
    bones.push(
      { name: n('UpperArm'), parent: 'Body', head: [sx * 0.18, 1.44, 0], tail: [sx * 0.18, 1.15, 0], zRef: FWDV },
      { name: n('LowerArm'), parent: n('UpperArm'), head: [sx * 0.18, 1.15, 0], tail: [sx * 0.18, 0.89, 0], zRef: FWDV },
      { name: n('Hand'), parent: n('LowerArm'), head: [sx * 0.18, 0.89, 0], tail: [sx * 0.18, 0.72, 0], zRef: FWDV },
      { name: n('UpperLeg'), parent: 'Body', head: [sx * 0.09, 0.93, 0], tail: [sx * 0.09, 0.5, 0], zRef: FWDV },
      { name: n('LowerLeg'), parent: n('UpperLeg'), head: [sx * 0.09, 0.5, 0], tail: [sx * 0.09, 0.08, 0], zRef: FWDV },
      { name: n('Foot'), parent: n('LowerLeg'), head: [sx * 0.09, 0.08, 0], tail: [sx * 0.09, 0.02, 0.14], zRef: UPV },
    );
    Object.assign(map, {
      [armJoints(side).shoulder]: n('UpperArm'),
      [armJoints(side).elbow]: n('LowerArm'),
      [armJoints(side).wrist]: n('Hand'),
      [legJoints(side).hip]: n('UpperLeg'),
      [legJoints(side).knee]: n('LowerLeg'),
      [legJoints(side).ankle]: n('Foot'),
    });
  }
  const { host } = hostFromDesign('legacy-limb-rig-c', 'Legacy limb rig C (rigid body, no root motion, no toes)', RIG_C_CONVENTION, bones, [], 'identity');
  return { host, boneMap: { schema: SCHEMA.boneMap, hostSkeletonId: host.id, joints: map, sites: {}, twist: {} } };
}

// ------------------------------------------------------------------------------------------ identity host

/**
 * Exports a canonical rig as a host skeleton in canonical conventions (metres, +Y up, +Z forward,
 * +X left), one bone per canonical joint with identity rest rotations, standing on the floor,
 * root and pelvis translatable, and every locatable site given explicitly. The adapter must
 * round-trip it exactly (derived proportions equal the rig's).
 */
export function identityHostFromRig(rig: RigDefinition, id = `${rig.id.slice(0, 70)}-host`): { host: HostSkeleton; boneMap: BoneMap } {
  const pelvisH = standingPelvisHeight(rig.proportions);
  const bones: HostBone[] = rig.joints.map((j) => ({
    name: j.name,
    parent: j.parent,
    restTranslation: j.kind === 'pelvis' ? add(j.offset as Vec3, [0, pelvisH, 0]) : ([...j.offset] as Vec3),
    restRotation: [...IDENTITY_Q] as Quat,
    translatable: j.kind === 'root' || j.kind === 'pelvis',
  }));
  const joints: Record<string, string> = Object.fromEntries(rig.joints.map((j) => [j.name, j.name]));
  const siteNames = new Set<string>(['seat', 'head_top', 'hand_L', 'hand_R', ...SIDES.flatMap((s) => [footSites(s).heel, footSites(s).toe, footSites(s).ballMedial, footSites(s).ballLateral])]);
  const sites: Record<string, { bone: string; offset: Vec3 }> = {};
  for (const s of rig.sites) if (siteNames.has(s.name)) sites[s.name] = { bone: s.joint, offset: [...s.offset] as Vec3 };
  return {
    host: { schema: SCHEMA.hostSkeleton, id, name: `${rig.name.slice(0, 100)} (host export)`, units: 'm', up: '+Y', forward: '+Z', left: '+X', bones },
    boneMap: { schema: SCHEMA.boneMap, hostSkeletonId: id, joints, sites, twist: {} },
  };
}

/**
 * Re-expresses a host skeleton (and its bone map's site offsets) in another unit/axis convention.
 * The skeleton describes the same body; only the numbers change. Throws on an invalid convention
 * (this is a fixture helper; the adapter itself reports invalid conventions as diagnostics).
 */
export function reexpressHost(host: HostSkeleton, boneMap: BoneMap, target: AxisConvention): { host: HostSkeleton; boneMap: BoneMap } {
  const src = basisOrThrow({ units: host.units, up: host.up, forward: host.forward, left: host.left });
  const dst = basisOrThrow(target);
  const vec = (v: readonly number[]): Vec3 => dst.vecToHost(src.vecToCanonical(v));
  const rot = (q: readonly number[]): Quat => dst.quatToHost(src.quatToCanonical(q));
  return {
    host: {
      ...host,
      units: target.units,
      up: target.up,
      forward: target.forward,
      left: target.left,
      bones: host.bones.map((b) => ({ ...b, restTranslation: vec(b.restTranslation), restRotation: rot(b.restRotation) })),
    },
    boneMap: {
      ...boneMap,
      joints: { ...boneMap.joints },
      twist: { ...boneMap.twist },
      sites: Object.fromEntries(Object.entries(boneMap.sites).map(([k, s]) => [k, { bone: s.bone, offset: vec(s.offset) }])),
    },
  };
}

const RIG_B = buildRigB();
const RIG_C = buildRigC();

export const SYNTHETIC_HOST_RIGS: { id: string; label: string; description: string; host: HostSkeleton; boneMap: BoneMap }[] = [
  {
    id: RIG_B.host.id,
    label: 'Rig B — adapted host skeleton (cm, Z-up, T-pose)',
    description:
      'Synthetic Blender-style host export: centimetres, +Z up, subject faces −Y, subject left +X (right-handed). ' +
      'Bones: hips (translatable root-motion bone), spine_01 → lumbar, spine_02 (extra, unmapped), chest → thoracic, neck_01 → neck, head (unmapped), ' +
      'clavicle.L/R (unmapped), upperarm/forearm/hand, thigh/shin/foot/toes (.L/.R). Rest pose: T-pose arms, feet toed out 7°, ' +
      'every bone frame Blender-style (+Y along the bone, with roll). Proportions differ from rig A: legs ≈ 8 % longer, shorter trunk, ' +
      'larger feet, wider hips. Heel, toe, ball, seat, hand and head-top sites are given explicitly. Supports every capability.',
    host: RIG_B.host,
    boneMap: RIG_B.boneMap,
  },
  {
    id: RIG_C.host.id,
    label: 'Rig C — legacy limb rig (rigid body, no root motion)',
    description:
      'Synthetic stand-in for the host platform\'s current demonstration rig: metres, +Y up, +Z forward, +X left, identity rest rotations. ' +
      'One rigid Body bone (mapped to the pelvis; no spine articulation), Head, UpperArm/LowerArm/Hand and UpperLeg/LowerLeg/Foot per side, ' +
      'no toe bones and no translatable bone. Missing: root-translation, trunk-articulation, forefoot-articulation; the adapter refuses ' +
      'recipes that require them and says which bones to add. Foot, seat and hand geometry are estimated.',
    host: RIG_C.host,
    boneMap: RIG_C.boneMap,
  },
];
