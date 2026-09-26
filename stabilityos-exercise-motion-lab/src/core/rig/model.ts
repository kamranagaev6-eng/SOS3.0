import type { JointSpec, RigDefinition } from '../contracts/rig.ts';
import { eulerAlternate, eulerFromMat3 } from '../math/euler.ts';
import { IDENTITY_Q, mat3FromQuat, quatCanonical, quatFromAxisAngle, quatMultiply, quatRotateVec3, type Quat } from '../math/quat.ts';
import { add, type Vec3 } from '../math/vec3.ts';

/** Pre-indexed, immutable view of a rig for fast repeated FK. Built once per rig object. */
export interface RigModel {
  readonly rig: RigDefinition;
  readonly jointCount: number;
  readonly names: readonly string[];
  readonly index: ReadonlyMap<string, number>;
  readonly parent: readonly number[];
  readonly offset: readonly Vec3[];
  readonly joints: readonly JointSpec[];
  readonly siteNames: readonly string[];
  readonly siteIndex: ReadonlyMap<string, number>;
  readonly siteJoint: readonly number[];
  readonly siteOffset: readonly Vec3[];
  readonly fingerprint: string;
}

const cache = new WeakMap<RigDefinition, RigModel>();

/** Requires joints in topological order (parents first); validateRig() in rig/validate.ts reports violations. */
export function getRigModel(rig: RigDefinition): RigModel {
  const hit = cache.get(rig);
  if (hit) return hit;
  const names = rig.joints.map((j) => j.name);
  const index = new Map(names.map((n, i) => [n, i] as const));
  const parent = rig.joints.map((j) => {
    if (j.parent === null) return -1;
    const p = index.get(j.parent);
    if (p === undefined) throw new Error(`rig ${rig.id}: joint ${j.name} has unknown parent ${j.parent}`);
    return p;
  });
  parent.forEach((p, i) => {
    if (p >= i) throw new Error(`rig ${rig.id}: joint ${names[i]} appears before its parent`);
  });
  const siteNames = rig.sites.map((s) => s.name);
  const siteIndex = new Map(siteNames.map((n, i) => [n, i] as const));
  const siteJoint = rig.sites.map((s) => {
    const j = index.get(s.joint);
    if (j === undefined) throw new Error(`rig ${rig.id}: site ${s.name} on unknown joint ${s.joint}`);
    return j;
  });
  const model: RigModel = {
    rig,
    jointCount: names.length,
    names,
    index,
    parent,
    offset: rig.joints.map((j) => [...j.offset] as Vec3),
    joints: rig.joints,
    siteNames,
    siteIndex,
    siteJoint,
    siteOffset: rig.sites.map((s) => [...s.offset] as Vec3),
    fingerprint: rigFingerprint(rig),
  };
  cache.set(rig, model);
  return model;
}

export function jointIndex(model: RigModel, name: string): number {
  const i = model.index.get(name);
  if (i === undefined) throw new Error(`rig ${model.rig.id} has no joint '${name}'`);
  return i;
}

export function siteIndexOf(model: RigModel, name: string): number {
  const i = model.siteIndex.get(name);
  if (i === undefined) throw new Error(`rig ${model.rig.id} has no site '${name}'`);
  return i;
}

const AXES: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** q = Π R(sign_i · axis_i, θ_i) in DOF order (intrinsic). */
export function composeJointRotation(joint: JointSpec, angles: readonly number[]): Quat {
  let q: Quat = IDENTITY_Q;
  for (let i = 0; i < joint.dofs.length; i++) {
    const d = joint.dofs[i]!;
    const theta = angles[i] ?? 0;
    if (theta === 0) continue;
    q = quatMultiply(q, quatFromAxisAngle(AXES[d.axis]!, d.sign * theta));
  }
  return quatCanonical(q);
}

/**
 * Inverse of composeJointRotation using the joint's full axis order. `residual` holds the angles
 * about axes that are not DOFs of this joint: a non-zero residual means the rotation is not
 * representable by the joint (e.g. twist about the shank for a 2-DOF ankle).
 */
export function decomposeJointRotation(joint: JointSpec, q: Quat): { angles: number[]; residual: number[] } {
  // Two Tait–Bryan branches describe the same rotation. The canonical branch keeps the middle
  // angle in [-π/2, π/2], which cannot express e.g. 120° shoulder abduction (middle DOF of X-Z-Y).
  // Pick the branch with the smallest (limit excess + off-axis residual); ties keep the canonical one.
  const e0 = eulerFromMat3(joint.order, mat3FromQuat(q));
  const e1 = eulerAlternate(e0);
  const split = (e: readonly number[]) => {
    const angles: number[] = [];
    const residual: number[] = [];
    let cost = 0;
    for (let i = 0; i < 3; i++) {
      const d = joint.dofs[i];
      if (d) {
        const a = d.sign * e[i]!;
        angles.push(a);
        cost += a > d.max ? a - d.max : a < d.min ? d.min - a : 0;
      } else {
        residual.push(e[i]!);
        cost += Math.abs(e[i]!);
      }
    }
    return { angles, residual, cost };
  };
  const b0 = split(e0);
  const b1 = split(e1);
  const pick = b1.cost < b0.cost - 1e-12 ? b1 : b0;
  return { angles: pick.angles, residual: pick.residual };
}

export interface FkResult {
  worldPos: Vec3[];
  worldRot: Quat[];
  sitePos: Vec3[];
}

/**
 * Forward kinematics. Joint world position depends on the PARENT's world rotation and the rest
 * offset; bones are rigid by construction (no scale, no stretch). The root joint takes
 * `rootTranslation`; the pelvis joint adds `pelvisOffset` to its rest offset.
 */
export function forwardKinematics(
  model: RigModel,
  rootTranslation: Vec3,
  pelvisOffset: Vec3,
  local: readonly Quat[],
): FkResult {
  const n = model.jointCount;
  const worldPos: Vec3[] = new Array(n);
  const worldRot: Quat[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = model.parent[i]!;
    const lq = local[i] ?? IDENTITY_Q;
    const kind = model.joints[i]!.kind;
    if (p < 0) {
      worldPos[i] = add(model.offset[i]!, rootTranslation);
      worldRot[i] = lq;
    } else {
      const off = kind === 'pelvis' ? add(model.offset[i]!, pelvisOffset) : model.offset[i]!;
      worldPos[i] = add(worldPos[p]!, quatRotateVec3(worldRot[p]!, off));
      worldRot[i] = quatMultiply(worldRot[p]!, lq);
    }
  }
  const sitePos: Vec3[] = model.siteJoint.map((j, s) => add(worldPos[j]!, quatRotateVec3(worldRot[j]!, model.siteOffset[s]!)));
  return { worldPos, worldRot, sitePos };
}

/** Deterministic key-order-independent JSON used for fingerprints and hashes. */
export function stableStringify(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

/** Two independent FNV-1a 32-bit passes -> 16 hex chars. Identity fingerprint, not a security hash. */
export function fnv1a64Hex(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 + 2) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function rigFingerprint(rig: RigDefinition): string {
  return fnv1a64Hex(stableStringify({ proportions: rig.proportions, joints: rig.joints, sites: rig.sites }));
}

/** Rigid links used for bone-length preservation checks (parent joint -> child joint). */
export function rigidLinks(model: RigModel): { a: number; b: number; length: number; name: string }[] {
  const links: { a: number; b: number; length: number; name: string }[] = [];
  for (let i = 0; i < model.jointCount; i++) {
    const p = model.parent[i]!;
    const kind = model.joints[i]!.kind;
    if (p < 0 || kind === 'pelvis') continue; // pelvis translation is a DOF, not a bone
    const o = model.offset[i]!;
    links.push({ a: p, b: i, length: Math.hypot(o[0], o[1], o[2]), name: `${model.names[p]}->${model.names[i]}` });
  }
  return links;
}
