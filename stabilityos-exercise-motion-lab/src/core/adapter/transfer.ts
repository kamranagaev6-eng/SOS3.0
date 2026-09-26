import type { HostSkeleton } from '../contracts/hostRig.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import {
  IDENTITY_Q,
  quatCanonical,
  quatConjugate,
  quatMultiply,
  quatNormalize,
  quatRotateVec3,
  type Quat,
} from '../math/quat.ts';
import { add, sub, type Vec3 } from '../math/vec3.ts';
import { forwardKinematics, getRigModel } from '../rig/model.ts';
import type { PoseSample } from '../solver/types.ts';
import type { HostBasis } from './basis.ts';
import { bonesBetween, type CanonicalRest, type HostTopology } from './hierarchy.ts';
import type { Measurement } from './measure.ts';
import { nearestCanonicalAncestor } from './topology.ts';

/**
 * Pose transfer canonical → host.
 *
 * For a host bone b mapped to canonical joint j:   H_b = Ŵ_j · A_j · H_b,rest   (world, canonical axes)
 * where Ŵ_j is the canonical world rotation of j computed with the rotations of UNMAPPED canonical
 * joints left out (they are dropped and reported by `unrepresentedMotion`, never folded into
 * other bones), and A_j is the binding alignment (see measure.ts). Its local rotation is
 * H_parent⁻¹ · H_b, so unmapped host bones in between (extra spine bones, clavicles) simply keep
 * their rest local transform. The canonical root has no anatomical segment: its heading and
 * translation are always carried by the host bones below/at it.
 *
 * Translations: every host bone keeps its REST local translation (no stretching), except
 *  - the root-motion bone (nearest translatable bone at or above the pelvis bone), whose
 *    translation is solved so the pelvis bone lands on the canonical pelvis origin (+ the rest
 *    offset between host pelvis bone and canonical pelvis origin), and
 *  - a translatable bone mapped to canonical 'root' (above the root-motion bone), which follows
 *    the canonical ground-projection root.
 *
 * Because the canonical rig is derived from the host's own rest geometry, a pose solved on it
 * reproduces joint positions (and therefore contacts) on the host exactly. Retargeting a motion
 * solved for a different body instead would keep joint angles but move the feet: with other
 * limb lengths the same angles put the soles elsewhere, which shows as sliding/penetrating feet.
 */

export interface HostPose {
  bones: { name: string; translation: Vec3; rotation: Quat }[];
}

export interface HostBoneWorld {
  name: string;
  parent: string | null;
  /** Canonical axes, metres. */
  position: Vec3;
  /** World rotation of the host bone frame, expressed in canonical axes. */
  rotation: Quat;
}

export interface UnrepresentedMotion {
  /** Canonical joint (rotation) or 'pelvis' (translation). */
  subject: string;
  kind: 'rotation' | 'translation';
  /** rad for rotations, m for translations. */
  magnitude: number;
  reason: string;
}

export interface SitePosition {
  name: string;
  position: Vec3;
  /** True when the site comes from estimated geometry rather than explicit boneMap data. */
  estimated: boolean;
}

export type TransferSample = Pick<PoseSample, 'local' | 'worldRot' | 'rootTranslation' | 'pelvisOffset'>;

export interface TransferSetup {
  host: HostSkeleton;
  basis: HostBasis;
  topo: HostTopology;
  rest: CanonicalRest;
  rig: RigDefinition;
  jointBone: ReadonlyMap<string, number>;
  measurement: Measurement;
  /** Explicit sites: host bone + offset in host units/axes (bone rest frame). */
  siteDefs: ReadonlyMap<string, { bone: number; offset: Vec3 }>;
}

export function createTransfer(s: TransferSetup) {
  const { host, basis, topo, rest, rig, jointBone, measurement } = s;
  const model = getRigModel(rig);
  const nJ = model.jointCount;
  const nB = host.bones.length;
  const rootJ = model.index.get('root')!;
  const pelvisJ = model.index.get('pelvis')!;
  const boneJoint = new Array<number>(nB).fill(-1);
  for (const [j, b] of jointBone) boneJoint[b] = model.index.get(j)!;
  const bind: Quat[] = host.bones.map((_, b) => {
    const j = boneJoint[b]!;
    if (j < 0) return IDENTITY_Q;
    const a = measurement.align.get(model.names[j]!) ?? IDENTITY_Q;
    return quatNormalize(quatMultiply(a, rest.worldR[b]!));
  });
  const represented = model.names.map((n) => n === 'root' || jointBone.has(n));
  const chainRep: boolean[] = [];
  for (let j = 0; j < nJ; j++) {
    const p = model.parent[j]!;
    chainRep[j] = represented[j]! && (p < 0 || chainRep[p]!);
  }
  const pelvisBone = jointBone.get('pelvis')!;
  let motionBone = -1;
  for (let k = pelvisBone, guard = 0; k >= 0 && guard <= nB; k = topo.parent[k]!, guard++) {
    if (host.bones[k]!.translatable) {
      motionBone = k;
      break;
    }
  }
  const rootBone = jointBone.get('root') ?? -1;
  const rootMotionBone = rootBone >= 0 && host.bones[rootBone]!.translatable && rootBone !== motionBone ? rootBone : -1;
  const pathToPelvis = motionBone >= 0 && motionBone !== pelvisBone ? [...bonesBetween(topo, motionBone, pelvisBone), pelvisBone] : [];
  const siteDefsC = new Map([...s.siteDefs].map(([k, d]) => [k, { bone: d.bone, offset: basis.vecToCanonical(d.offset) }] as const));
  // Canonical rest geometry of the derived rig (pelvis at origin), for estimated sites.
  const restFk = forwardKinematics(model, [0, 0, 0], [0, 0, 0], []);
  const mappedJ = (j: string): boolean => j !== 'root' && jointBone.has(j);

  function checkSample(sample: TransferSample): void {
    if (sample.local.length !== nJ || sample.worldRot.length !== nJ)
      throw new Error(`pose has ${sample.local.length} joints but the derived rig '${rig.id}' has ${nJ}; sample poses on adapter.canonical`);
  }

  function effectiveWorld(sample: TransferSample): Quat[] {
    const W: Quat[] = new Array<Quat>(nJ);
    for (let j = 0; j < nJ; j++) {
      if (chainRep[j]) {
        W[j] = sample.worldRot[j]!;
        continue;
      }
      const l = represented[j] ? sample.local[j]! : IDENTITY_Q;
      const p = model.parent[j]!;
      W[j] = p < 0 ? l : quatMultiply(W[p]!, l);
    }
    return W;
  }

  function solve(sample: TransferSample) {
    checkSample(sample);
    const W = effectiveWorld(sample);
    const Hw: Quat[] = new Array<Quat>(nB);
    const outR: Quat[] = new Array<Quat>(nB);
    for (const b of topo.order) {
      const p = topo.parent[b]!;
      const j = boneJoint[b]!;
      if (j >= 0) {
        Hw[b] = quatNormalize(quatMultiply(W[j]!, bind[b]!));
        const lc = p < 0 ? Hw[b] : quatMultiply(quatConjugate(Hw[p]!), Hw[b]);
        outR[b] = quatCanonical(quatNormalize(basis.quatToHost(lc)));
      } else {
        Hw[b] = p < 0 ? rest.localR[b]! : quatNormalize(quatMultiply(Hw[p]!, rest.localR[b]!));
        outR[b] = [...host.bones[b]!.restRotation] as Quat;
      }
    }
    const rootWorld = add(model.offset[rootJ]!, sample.rootTranslation);
    const pelvisWorld = add(rootWorld, quatRotateVec3(sample.worldRot[rootJ]!, add(model.offset[pelvisJ]!, sample.pelvisOffset)));
    const target = add(pelvisWorld, quatRotateVec3(W[pelvisJ]!, measurement.pelvisDelta));
    const P: Vec3[] = new Array<Vec3>(nB);
    const outT: Vec3[] = new Array<Vec3>(nB);
    const localOf = (b: number): Vec3 => {
      const p = topo.parent[b]!;
      return p < 0 ? P[b]! : quatRotateVec3(quatConjugate(Hw[p]!), sub(P[b]!, P[p]!));
    };
    for (const b of topo.order) {
      const p = topo.parent[b]!;
      if (b === motionBone) {
        let rel: Vec3 = [0, 0, 0];
        for (const k of pathToPelvis) rel = add(rel, quatRotateVec3(Hw[topo.parent[k]!]!, rest.localT[k]!));
        P[b] = sub(target, rel);
        outT[b] = basis.vecToHost(localOf(b));
      } else if (b === rootMotionBone) {
        P[b] = rootWorld;
        outT[b] = basis.vecToHost(localOf(b));
      } else {
        P[b] = p < 0 ? rest.localT[b]! : add(P[p]!, quatRotateVec3(Hw[p]!, rest.localT[b]!));
        outT[b] = [...host.bones[b]!.restTranslation] as Vec3;
      }
    }
    return { W, Hw, P, outR, outT, target };
  }

  function toHostPose(sample: TransferSample): HostPose {
    const r = solve(sample);
    return { bones: host.bones.map((bone, i) => ({ name: bone.name, translation: r.outT[i]!, rotation: r.outR[i]! })) };
  }

  function hostFk(pose: HostPose): { P: Vec3[]; R: Quat[] } {
    const byName = new Map(pose.bones.map((b) => [b.name, b] as const));
    const P: Vec3[] = new Array<Vec3>(nB);
    const R: Quat[] = new Array<Quat>(nB);
    for (const b of topo.order) {
      const pb = byName.get(host.bones[b]!.name);
      const t = pb ? basis.vecToCanonical(pb.translation) : rest.localT[b]!;
      const r = pb ? quatNormalize(basis.quatToCanonical(pb.rotation)) : rest.localR[b]!;
      const p = topo.parent[b]!;
      if (p < 0) {
        P[b] = t;
        R[b] = r;
      } else {
        P[b] = add(P[p]!, quatRotateVec3(R[p]!, t));
        R[b] = quatMultiply(R[p]!, r);
      }
    }
    return { P, R };
  }

  function hostWorldInCanonical(pose: HostPose): HostBoneWorld[] {
    const { P, R } = hostFk(pose);
    return host.bones.map((bone, i) => ({ name: bone.name, parent: bone.parent, position: P[i]!, rotation: quatCanonical(quatNormalize(R[i]!)) }));
  }

  /** Canonical sites located through the HOST skeleton (explicit site data or bound estimates). */
  function hostSitePositions(pose: HostPose): SitePosition[] {
    const { P, R } = hostFk(pose);
    return model.siteNames.map((name, si) => {
      const def = siteDefsC.get(name);
      if (def) return { name, position: add(P[def.bone]!, quatRotateVec3(R[def.bone]!, def.offset)), estimated: false };
      const k = model.names[model.siteJoint[si]!]!;
      const a = mappedJ(k) ? k : nearestCanonicalAncestor(k, mappedJ)!;
      const b = jointBone.get(a)!;
      const ja = model.index.get(a)!;
      const Wa = quatMultiply(R[b]!, quatConjugate(bind[b]!));
      const origin = a === 'pelvis' ? sub(P[b]!, quatRotateVec3(Wa, measurement.pelvisDelta)) : P[b]!;
      const relRest = sub(restFk.sitePos[si]!, restFk.worldPos[ja]!);
      return { name, position: add(origin, quatRotateVec3(Wa, relRest)), estimated: measurement.estimatedSites.includes(name) };
    });
  }

  function unrepresentedMotion(sample: TransferSample): UnrepresentedMotion[] {
    const out: UnrepresentedMotion[] = [];
    for (let j = 0; j < nJ; j++) {
      if (represented[j]) continue;
      const q = sample.local[j]!;
      const angle = 2 * Math.atan2(Math.hypot(q[0], q[1], q[2]), Math.abs(q[3]));
      if (angle > 1e-9)
        out.push({ subject: model.names[j]!, kind: 'rotation', magnitude: angle, reason: `no host bone is mapped to '${model.names[j]}'; its rotation is dropped` });
    }
    const r = solve(sample);
    const miss = Math.hypot(...sub(r.P[pelvisBone]!, r.target));
    if (miss > 1e-9)
      out.push({
        subject: 'pelvis',
        kind: 'translation',
        magnitude: miss,
        reason: motionBone < 0 ? 'no translatable bone at or above the pelvis bone; root/pelvis translation is dropped' : 'pelvis translation not reproduced',
      });
    return out;
  }

  const bindings = [...jointBone].map(([joint, b]) => ({ joint, bone: host.bones[b]!.name, bind: bind[b]! }));
  return {
    toHostPose,
    hostWorldInCanonical,
    hostSitePositions,
    unrepresentedMotion,
    bindings,
    motionBone: motionBone >= 0 ? host.bones[motionBone]!.name : null,
    unmappedJoints: model.names.filter((n, j) => !represented[j] && n !== 'root'),
  };
}
