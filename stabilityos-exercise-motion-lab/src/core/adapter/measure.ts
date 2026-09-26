import { SIDES, type Side } from '../contracts/common.ts';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import type { HumanoidProportions, LegProportions, RigDefinition } from '../contracts/rig.ts';
import { mat3FromColumns, mat3Multiply, mat3Transpose } from '../math/mat3.ts';
import {
  IDENTITY_Q,
  quatConjugate,
  quatFromAxisAngle,
  quatFromMat3,
  quatFromUnitVectors,
  quatMultiply,
  quatNormalize,
  quatRotateVec3,
  type Quat,
} from '../math/quat.ts';
import { add, cross, distance, dot, length, normalize, rejectFrom, scale, sub, type Vec3 } from '../math/vec3.ts';
import { armJoints, footSites, legJoints, PROPORTIONS_A } from '../rig/canonical.ts';
import { forwardKinematics, getRigModel } from '../rig/model.ts';
import { CANONICAL_SITE_JOINT, nearestCanonicalAncestor } from './topology.ts';

/**
 * Derives canonical proportions and per-joint binding rotations from a host skeleton's REST pose
 * (already converted to canonical axes and metres).
 *
 * Binding rotation A_j (canonical axes): the rotation that turns the host bone mapped to joint j,
 * as it sits in the host rest pose, into its orientation in the CANONICAL rest pose (standing,
 * limbs straight down, feet forward). At a canonical pose with joint world rotation W_j the host
 * bone's world rotation is W_j · A_j · H_rest. Rules:
 *  - limbs and spine: shortest-arc alignment of the bone's direction (bone origin → origin of the
 *    next mapped joint, or an explicit end site / single unmapped child) onto the canonical rest
 *    direction (−Y for legs and arms, +Y for the trunk), then the optional `boneMap.twist` (rad,
 *    right-handed about the canonical rest direction).
 *  - pelvis: frame alignment — right hip → left hip onto +X, then hips-midpoint → trunk onto +Y.
 *  - thoracic: frame alignment — spine direction onto +Y, right → left shoulder onto +X.
 *  - foot and toes: yaw-only alignment (horizontal direction onto +Z, host up kept), because the
 *    host rest pose stands on a flat floor; shortest arc would roll a toed-out foot's sole.
 *  - a mapped joint with no direction reference keeps the alignment of its nearest mapped
 *    canonical ancestor (it stays rigid relative to it, as in the host rest pose).
 *
 * Proportions are the distances between mapped joint origins (so bones are never stretched).
 * Canonical joints the host does not map are placed by rig-A ratios along the measured span;
 * contact sites without explicit data are estimated with rig-A ratios (documented per item) and
 * reported as ESTIMATED_GEOMETRY. Anything the canonical parametrisation cannot represent (e.g.
 * shoulders forward of the spine axis) is measured and reported as a residual, never hidden.
 */

const UP: Vec3 = [0, 1, 0];
const DOWN: Vec3 = [0, -1, 0];
const FWD: Vec3 = [0, 0, 1];
const LEFT: Vec3 = [1, 0, 0];
const EPS_LEN = 1e-6;

export interface MeasureInput {
  hostId: string;
  hostNames: readonly string[];
  children: readonly (readonly number[])[];
  /** Host bone rest world positions, canonical axes, metres. */
  restPos: readonly Vec3[];
  /** Canonical joint → host bone index (validated: bones exist, hierarchy consistent). */
  jointBone: ReadonlyMap<string, number>;
  /** Explicit canonical site → rest world position (canonical axes, metres). */
  sitePos: ReadonlyMap<string, Vec3>;
  twist: Readonly<Record<string, number>>;
}

export interface Measurement {
  proportions: HumanoidProportions;
  /** Binding alignment A_j for every mapped canonical joint (root: identity). */
  align: Map<string, Quat>;
  /** Canonical pelvis origin in the host rest pose (canonical world, m). */
  pelvisOrigin: Vec3;
  /** Host pelvis-bone origin relative to the canonical pelvis origin, in the canonical pelvis frame. */
  pelvisDelta: Vec3;
  /** Rest world position used for each mapped joint (pelvis → pelvisOrigin). */
  jointRestPos: Map<string, Vec3>;
  /** Canonical sites whose geometry was estimated (no explicit site data). */
  estimatedSites: string[];
}

/** Orthonormal frame (columns): primary, secondary made orthogonal to it, and their cross product. */
function frameMatrix(primary: Vec3, secondary: Vec3): ReturnType<typeof mat3FromColumns> | null {
  const e1 = normalize(primary, [0, 0, 0]);
  if (length(e1) === 0) return null;
  const s = rejectFrom(secondary, e1);
  if (length(s) < 1e-9) return null;
  const e2 = normalize(s);
  return mat3FromColumns(e1, e2, cross(e1, e2));
}

/** Rotation taking host frame (hp primary, hs secondary) onto canonical (cp, cs). */
function alignFrame(hp: Vec3, cp: Vec3, hs: Vec3, cs: Vec3): Quat | null {
  const fh = frameMatrix(hp, hs);
  const fc = frameMatrix(cp, cs);
  if (!fh || !fc) return null;
  return quatFromMat3(mat3Multiply(fc, mat3Transpose(fh)));
}

function withTwist(a: Quat, axis: Vec3, twist: number): Quat {
  return twist ? quatNormalize(quatMultiply(quatFromAxisAngle(axis, twist), a)) : a;
}

/** Linear chain measurement; see measureHost. `points[0]` must be present. */
function measureChain(points: readonly (Vec3 | null)[], nominal: readonly number[], fallbackScale: number) {
  const n = nominal.length;
  const lengths = new Array<number>(n).fill(0);
  const estimated = new Array<boolean>(n).fill(false);
  const next = new Array<number | null>(points.length).fill(null);
  const mappedIdx = points.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  let measured = 0;
  let nominalMeasured = 0;
  for (let k = 0; k + 1 < mappedIdx.length; k++) {
    const a = mappedIdx[k]!;
    const b = mappedIdx[k + 1]!;
    next[a] = b;
    const span = distance(points[a]!, points[b]!);
    let nom = 0;
    for (let s = a; s < b; s++) nom += nominal[s]!;
    for (let s = a; s < b; s++) {
      lengths[s] = (span * nominal[s]!) / nom;
      estimated[s] = b - a > 1;
    }
    measured += span;
    nominalMeasured += nom;
  }
  const chainScale = nominalMeasured > 0 ? measured / nominalMeasured : fallbackScale;
  const last = mappedIdx[mappedIdx.length - 1] ?? 0;
  for (let s = last; s < n; s++) {
    lengths[s] = nominal[s]! * chainScale;
    estimated[s] = true;
  }
  return { lengths, estimated, next, chainScale };
}

function angleBetweenUnit(a: Vec3, b: Vec3): number {
  return Math.atan2(length(cross(a, b)), dot(a, b));
}

export function measureHost(input: MeasureInput, diagnostics: Diagnostic[]): Measurement | null {
  const A = PROPORTIONS_A;
  const names = input.hostNames;
  const boneName = (j: string): string => {
    const b = input.jointBone.get(j);
    return b === undefined ? '(unmapped)' : names[b]!;
  };
  const pos = (j: string): Vec3 | null => {
    const b = input.jointBone.get(j);
    return b === undefined ? null : input.restPos[b]!;
  };
  const site = (s: string): Vec3 | null => input.sitePos.get(s) ?? null;
  const tw = (j: string): number => input.twist[j] ?? 0;
  const uniqueChildPos = (j: string): Vec3 | null => {
    const b = input.jointBone.get(j);
    if (b === undefined) return null;
    const ch = input.children[b]!;
    if (ch.length !== 1) return null;
    const c = ch[0]!;
    for (const v of input.jointBone.values()) if (v === c) return null;
    return input.restPos[c]!;
  };
  const align = new Map<string, Quat>();
  const jointRestPos = new Map<string, Vec3>();
  const estimatedSites: string[] = [];
  let failed = false;
  const fail = (subject: string, message: string, hint: string): void => {
    diagnostics.push(diag('RIG_INVALID', 'error', message, { subject, hint }));
    failed = true;
  };
  const note = (severity: 'info' | 'warning', subject: string, message: string, hint?: string): void => {
    diagnostics.push(diag('ESTIMATED_GEOMETRY', severity, message, hint ? { subject, hint } : { subject }));
  };
  const alignDir = (joint: string, hostDir: Vec3, canon: Vec3): Quat => {
    const d = normalize(hostDir);
    const ang = angleBetweenUnit(d, canon);
    if (ang > (150 * Math.PI) / 180)
      note(
        'info',
        joint,
        `binding of '${joint}' ('${boneName(joint)}') turns the rest bone by ${((ang * 180) / Math.PI).toFixed(1)}°; ` +
          'near 180° the shortest-arc twist is ambiguous',
        `Set boneMap.twist.${joint} (rad) if the host bone appears rolled about its axis.`,
      );
    return withTwist(quatFromUnitVectors(d, canon), canon, tw(joint));
  };
  for (const [j, b] of input.jointBone) jointRestPos.set(j, input.restPos[b]!);
  if (input.jointBone.has('root')) align.set('root', IDENTITY_Q);

  // ---------------------------------------------------------------- legs (hip, knee, ankle)
  const leg: Record<Side, { thigh: number; shank: number }> = { left: { thigh: 0, shank: 0 }, right: { thigh: 0, shank: 0 } };
  for (const side of SIDES) {
    const lj = legJoints(side);
    const H = pos(lj.hip);
    const K = pos(lj.knee);
    const K2 = pos(lj.ankle);
    if (!H || !K || !K2) {
      fail(lj.hip, `${side} leg joints are not all mapped`, 'Map hip, knee and ankle on both sides.');
      continue;
    }
    const thigh = distance(H, K);
    const shank = distance(K, K2);
    if (thigh < EPS_LEN || shank < EPS_LEN) {
      fail(lj.knee, `${side} thigh or shank has zero length in the host rest pose ('${boneName(lj.hip)}' → '${boneName(lj.knee)}' → '${boneName(lj.ankle)}')`, 'Hip, knee and ankle bones must have distinct rest origins.');
      continue;
    }
    if (K[1] >= H[1] || K2[1] >= K[1]) {
      const d = normalize(sub(K2, H));
      fail(
        lj.knee,
        `${side} leg does not point down after converting to canonical axes: hip → ankle direction is ` +
          `[${d.map((x) => x.toFixed(2)).join(', ')}] (canonical +Y is up; expected about [0, -1, 0])`,
        "Check the skeleton's `up`/`forward`/`left` axis labels against the data, and that the host rest pose is standing (legs below the hips).",
      );
    }
    leg[side] = { thigh, shank };
    align.set(lj.hip, alignDir(lj.hip, sub(K, H), DOWN));
    align.set(lj.knee, alignDir(lj.knee, sub(K2, K), DOWN));
  }
  if (failed) return null;
  const legScale = (leg.left.thigh + leg.left.shank + leg.right.thigh + leg.right.shank) / (2 * (A.left.leg.thigh + A.left.leg.shank));

  // ---------------------------------------------------------------- pelvis
  const HL = pos('hip_L')!;
  const HR = pos('hip_R')!;
  const lateral = sub(HL, HR);
  const hipHalfWidth = length(lateral) / 2;
  const mid = scale(add(HL, HR), 0.5);
  const SL = pos('shoulder_L');
  const SR = pos('shoulder_R');
  const shoulderMid = SL && SR ? scale(add(SL, SR), 0.5) : null;
  const trunkAnchor = pos('lumbar') ?? pos('thoracic') ?? pos('neck') ?? shoulderMid;
  const upHint = trunkAnchor ? sub(trunkAnchor, mid) : UP;
  const pelvisAlign0 = alignFrame(lateral, LEFT, upHint, UP);
  if (!pelvisAlign0 || hipHalfWidth < EPS_LEN) {
    fail('pelvis', `pelvis frame is degenerate: hips coincide or the trunk lies on the hip axis (bone '${boneName('pelvis')}')`, 'Hip bones must be apart laterally and the spine must rise from between them.');
    return null;
  }
  const xh = normalize(lateral);
  const yh = normalize(rejectFrom(upHint, xh));
  if (yh[1] <= 0) {
    fail('pelvis', `the trunk lies below the hips in canonical space (bone '${boneName('pelvis')}')`, "Check the skeleton's `up` axis label and the rest pose.");
    return null;
  }
  const pelvisAlign = withTwist(pelvisAlign0, UP, tw('pelvis'));
  align.set('pelvis', pelvisAlign);
  const Ph = pos('pelvis')!;
  const anchorHeight = trunkAnchor ? dot(sub(trunkAnchor, mid), yh) : Infinity;
  // The canonical pelvis origin lies on the hip-midline axis, at or above the hip centres and
  // below the first trunk joint (lumbarBaseHeight > 0); the host bone's offset from it is kept
  // exactly as pelvisDelta.
  const hipDrop = Math.max(0, Math.min(dot(sub(Ph, mid), yh), anchorHeight - 1e-3));
  const Pc = add(mid, scale(yh, hipDrop));
  const pelvisDelta = quatRotateVec3(pelvisAlign, sub(Ph, Pc));
  jointRestPos.set('pelvis', Pc);

  // ---------------------------------------------------------------- trunk chain pelvis → lumbar → thoracic → neck
  const trunkJ = ['lumbar', 'thoracic', 'neck'] as const;
  const tpts: (Vec3 | null)[] = [Pc, pos('lumbar'), pos('thoracic'), pos('neck')];
  const tc = measureChain(tpts, [A.pelvis.lumbarBaseHeight, A.trunk.lumbar, A.trunk.thoracic], legScale);
  const [lumbarBaseHeight, lumbar, thoracic] = tc.lengths as [number, number, number];
  const trunkScale = (lumbarBaseHeight + lumbar + thoracic) / (A.pelvis.lumbarBaseHeight + A.trunk.lumbar + A.trunk.thoracic);
  const unmappedTrunk = trunkJ.filter((j) => !input.jointBone.has(j));
  if (unmappedTrunk.length)
    note(
      'info',
      unmappedTrunk[0]!,
      `trunk joint(s) ${unmappedTrunk.map((j) => `'${j}'`).join(', ')} not mapped: their rest positions were placed along the measured spine span with rig-A ratios ` +
        '(lumbarBaseHeight : lumbar : thoracic = 0.09 : 0.18 : 0.30); their rotations cannot be shown on the host',
    );
  const trunkRot: Quat[] = [pelvisAlign, pelvisAlign, pelvisAlign, pelvisAlign];
  for (let i = 1; i <= 3; i++) {
    const j = trunkJ[i - 1]!;
    const p = tpts[i];
    if (!p) {
      trunkRot[i] = trunkRot[i - 1]!;
      continue;
    }
    let a: Quat;
    const nextIdx = tc.next[i];
    const ref = nextIdx !== null && nextIdx !== undefined ? tpts[nextIdx]! : i < 3 ? shoulderMid : null;
    if (j === 'thoracic' && ref && SL && SR) {
      const f = alignFrame(sub(ref, p), UP, sub(SL, SR), LEFT);
      a = f ? withTwist(f, UP, tw(j)) : alignDir(j, sub(ref, p), UP);
    } else if (j === 'neck') {
      a = trunkRot[i - 1]!; // set below from the head chain
    } else if (ref) {
      a = alignDir(j, sub(ref, p), UP);
    } else {
      a = withTwist(trunkRot[i - 1]!, UP, tw(j));
    }
    trunkRot[i] = a;
    if (j !== 'neck') align.set(j, a);
  }
  /** Rest-pose host frame of canonical trunk joint i (rigid with the nearest mapped joint ≤ i). */
  const trunkFrame = (i: number): { rot: Quat; origin: Vec3 } => {
    let a = i;
    while (a > 0 && !tpts[a]) a--;
    const rot = trunkRot[a]!;
    const base = tpts[a]!;
    if (a === i) return { rot, origin: base };
    let h = 0;
    for (let s = a; s < i; s++) h += tc.lengths[s]!;
    return { rot, origin: add(base, quatRotateVec3(quatConjugate(rot), [0, h, 0])) };
  };

  // ---------------------------------------------------------------- shoulders (in the thoracic frame)
  const tf = trunkFrame(2);
  const inThorax = (p: Vec3): Vec3 => quatRotateVec3(tf.rot, sub(p, tf.origin));
  let shoulderHalfWidth: number;
  let shoulderY: number;
  if (SL && SR) {
    const l = inThorax(SL);
    const r = inThorax(SR);
    shoulderHalfWidth = (l[0] - r[0]) / 2;
    shoulderY = (l[1] + r[1]) / 2;
  } else if (SL || SR) {
    const s = inThorax((SL ?? SR)!);
    shoulderHalfWidth = Math.abs(s[0]);
    shoulderY = s[1];
  } else {
    shoulderHalfWidth = A.trunk.shoulderHalfWidth * legScale;
    shoulderY = thoracic - A.trunk.shoulderDrop * trunkScale;
    note('info', 'shoulder_L', 'no shoulder bones mapped: shoulder width and height estimated from rig A scaled by leg length');
  }
  const shoulderDrop = Math.max(0, thoracic - shoulderY);
  if (!(shoulderHalfWidth > EPS_LEN)) fail('shoulder_L', `shoulders do not straddle the spine in the rest pose (half-width ${shoulderHalfWidth.toFixed(4)} m)`, 'Map shoulder_L to the left upper-arm bone and shoulder_R to the right one.');

  // ---------------------------------------------------------------- neck + head
  let neck: number;
  let head: number;
  const N = pos('neck');
  if (N) {
    const child = uniqueChildPos('neck');
    const top = site('head_top');
    const hc = measureChain([N, child, top], [A.trunk.neck, A.trunk.head], trunkScale);
    neck = hc.lengths[0]!;
    head = hc.lengths[1]!;
    const ref = child ?? top;
    const a = ref ? alignDir('neck', sub(ref, N), UP) : withTwist(trunkFrame(2).rot, UP, tw('neck'));
    align.set('neck', a);
    if (hc.estimated.some(Boolean))
      note('info', 'head_top', `neck/head lengths partly estimated (rig-A ratio neck : head = 1 : 2)${ref ? '' : '; the neck bone keeps the trunk alignment'}`, `Give the neck bone a single child head bone, or add boneMap.sites.head_top.`);
  } else {
    neck = A.trunk.neck * trunkScale;
    head = A.trunk.head * trunkScale;
  }

  // ---------------------------------------------------------------- arms
  const arm: Record<Side, { upperArm: number; forearm: number; hand: number }> = {
    left: { upperArm: 0, forearm: 0, hand: 0 },
    right: { upperArm: 0, forearm: 0, hand: 0 },
  };
  for (const side of SIDES) {
    const aj = armJoints(side);
    const sfx = side === 'left' ? '_L' : '_R';
    const S = pos(aj.shoulder);
    const E = pos(aj.elbow);
    const W = pos(aj.wrist);
    const handEnd = site(`hand${sfx}`) ?? (W ? uniqueChildPos(aj.wrist) : null);
    const nomA = [A[side].arm.upperArm, A[side].arm.forearm, A[side].arm.hand];
    const jn = [aj.shoulder, aj.elbow, aj.wrist];
    if (S) {
      const pts = [S, E, W, handEnd];
      const ac = measureChain(pts, nomA, legScale);
      arm[side] = { upperArm: ac.lengths[0]!, forearm: ac.lengths[1]!, hand: ac.lengths[2]! };
      let prev = trunkFrame(2).rot;
      for (let i = 0; i < 3; i++) {
        const p = pts[i];
        if (!p) continue;
        const nx = ac.next[i];
        const a = nx !== null && nx !== undefined ? alignDir(jn[i]!, sub(pts[nx]!, p), DOWN) : withTwist(prev, DOWN, tw(jn[i]!));
        align.set(jn[i]!, a);
        prev = a;
      }
      const est = ac.estimated.map((e, i) => (e ? (['upperArm', 'forearm', 'hand'] as const)[i] : null)).filter((x) => x !== null);
      if (est.length)
        note('info', `hand${sfx}`, `${side} arm: ${est.join(', ')} estimated (rig-A ratios along the measured arm)`, `Map the missing arm joints or add boneMap.sites.hand${sfx}.`);
    } else {
      arm[side] = { upperArm: nomA[0]! * legScale, forearm: nomA[1]! * legScale, hand: nomA[2]! * legScale };
      for (let i = 1; i < 3; i++) if (pos(jn[i]!)) align.set(jn[i]!, trunkFrame(2).rot);
      note('info', aj.shoulder, `${side} arm not mapped: arm lengths estimated from rig A scaled by leg length`);
    }
  }

  // ---------------------------------------------------------------- feet
  const feet: Record<Side, LegProportions> = { left: { ...A.left.leg }, right: { ...A.right.leg } };
  for (const side of SIDES) {
    const lj = legJoints(side);
    const fs = footSites(side);
    const Ank = pos(lj.ankle)!;
    const M = pos(lj.mtp);
    const heel = site(fs.heel);
    const toe = site(fs.toe);
    const bmed = site(fs.ballMedial);
    const blat = site(fs.ballLateral);
    const Aref = A[side].leg;
    const estimatedItems: string[] = [];
    const yaw = (v: Vec3, joint: string): Quat | null => {
      const h: Vec3 = [v[0], 0, v[2]];
      if (length(h) < 1e-3 * length(v) || length(h) < EPS_LEN) {
        fail(joint, `${side} ${joint.startsWith('mtp') ? 'toe' : 'foot'} bone ('${boneName(joint)}') points straight down in the rest pose; its forward direction is undefined`, 'The host rest pose must stand with the feet flat on the floor.');
        return null;
      }
      const hn = normalize(h);
      if (dot(hn, FWD) < 0)
        fail(joint, `${side} ${joint.startsWith('mtp') ? 'toes point' : 'foot points'} backwards in the rest pose ('${boneName(joint)}')`, "Check the skeleton's `forward` axis label and the ankle/toe mappings.");
      return quatFromUnitVectors(hn, FWD);
    };
    // Foot (ankle) alignment and foot vector.
    let aAnk: Quat;
    let footLength: number;
    let drop: number | null = null;
    let toeSplit: number | null = null;
    if (M) {
      const v = sub(M, Ank);
      const y = yaw(v, lj.ankle);
      if (!y) continue;
      const va0 = quatRotateVec3(y, v);
      aAnk = withTwist(y, normalize(va0), tw(lj.ankle));
      footLength = va0[2];
      drop = -va0[1];
    } else if (toe) {
      const v = sub(toe, Ank);
      const y = yaw(v, lj.ankle);
      if (!y) continue;
      aAnk = withTwist(y, FWD, tw(lj.ankle));
      const total = quatRotateVec3(aAnk, v)[2];
      footLength = (total * Aref.footLength) / (Aref.footLength + Aref.toeLength);
      toeSplit = total - footLength;
      estimatedItems.push('footLength/toeLength split (rig-A ratio 0.14 : 0.06 of the ankle→toe-tip distance)');
    } else {
      aAnk = withTwist(align.get(lj.knee)!, FWD, tw(lj.ankle));
      footLength = Aref.footLength * legScale;
      estimatedItems.push('footLength (rig A × leg scale; the foot keeps its rest orientation relative to the shank)');
    }
    align.set(lj.ankle, aAnk);
    const footScale = footLength / Aref.footLength;
    // Toes alignment.
    let aMtp: Quat | null = null;
    const toeRef = M ? (toe ?? uniqueChildPos(lj.mtp)) : null;
    if (M) {
      if (toeRef) {
        const y = yaw(sub(toeRef, M), lj.mtp);
        if (!y) continue;
        aMtp = withTwist(y, FWD, tw(lj.mtp));
      } else {
        aMtp = withTwist(aAnk, FWD, tw(lj.mtp));
      }
      align.set(lj.mtp, aMtp);
    }
    const inAnk = (p: Vec3): Vec3 => quatRotateVec3(aAnk, sub(p, Ank));
    const inMtp = (p: Vec3): Vec3 => quatRotateVec3(aMtp!, sub(p, M!));
    // Sole level → ankle height.
    let ankleHeight: number;
    if (heel) {
      ankleHeight = -inAnk(heel)[1];
    } else if (toe && M && drop !== null) {
      ankleHeight = drop - inMtp(toe)[1];
    } else if (toe) {
      ankleHeight = -inAnk(toe)[1];
    } else {
      const nominal = Aref.ankleHeight * footScale;
      if (Ank[1] >= 0.5 * nominal && Ank[1] <= 2 * nominal) {
        ankleHeight = Ank[1];
        estimatedItems.push('ankleHeight (ankle height above the host floor plane, host up = 0)');
      } else {
        ankleHeight = nominal;
        estimatedItems.push('ankleHeight (rig-A ratio to foot length; the host floor plane was implausible)');
      }
    }
    if (!(ankleHeight > EPS_LEN)) {
      fail(lj.ankle, `${side} ankle ('${boneName(lj.ankle)}') is not above the sole (ankle height ${ankleHeight.toFixed(4)} m)`, `Check boneMap.sites.${fs.heel} / ${fs.toe} offsets (host units, in the bone's rest frame).`);
      continue;
    }
    let mtpHeight: number;
    if (drop !== null) mtpHeight = ankleHeight - drop;
    else {
      mtpHeight = (Aref.mtpHeight / Aref.ankleHeight) * ankleHeight;
      estimatedItems.push('mtpHeight (rig-A ratio to ankle height)');
    }
    if (!(mtpHeight > EPS_LEN)) {
      fail(lj.mtp, `${side} MTP joint ('${boneName(lj.mtp)}') is at or below the sole (MTP height ${mtpHeight.toFixed(4)} m)`, `Check the heel/toe site offsets and that the host rest feet stand flat on the floor.`);
      continue;
    }
    let heelBack: number;
    if (heel) heelBack = -inAnk(heel)[2];
    else {
      heelBack = Aref.heelBack * footScale;
      estimatedItems.push('heel (heelBack = rig-A ratio to foot length, at sole level)');
      estimatedSites.push(fs.heel);
    }
    let toeLength: number;
    if (toeRef && M) toeLength = inMtp(toeRef)[2];
    else if (toeSplit !== null) toeLength = toeSplit;
    else {
      toeLength = Aref.toeLength * footScale;
      estimatedItems.push('toe tip (toeLength = rig-A ratio to foot length)');
      estimatedSites.push(fs.toe);
    }
    let footWidth: number;
    if (bmed && blat) footWidth = Math.abs((M ? inMtp(bmed)[0] - inMtp(blat)[0] : inAnk(bmed)[0] - inAnk(blat)[0]));
    else {
      footWidth = Aref.footWidth * footScale;
      estimatedItems.push('footWidth (rig-A ratio to foot length; medial/lateral heel and ball sites)');
      estimatedSites.push(fs.ballMedial, fs.ballLateral, `heel_med${side === 'left' ? '_L' : '_R'}`, `heel_lat${side === 'left' ? '_L' : '_R'}`);
    }
    for (const [label, v] of [
      ['heelBack', heelBack],
      ['toeLength', toeLength],
      ['footWidth', footWidth],
    ] as const)
      if (!(v > EPS_LEN)) fail(lj.ankle, `${side} foot ${label} measured as ${v.toFixed(4)} m (must be > 0)`, `Check boneMap.sites for the ${side} foot (host units, bone rest frame).`);
    feet[side] = {
      thigh: leg[side].thigh,
      shank: leg[side].shank,
      ankleHeight,
      heelBack,
      footLength,
      mtpHeight,
      toeLength,
      footWidth,
    };
    if (estimatedItems.length)
      note(
        'warning',
        fs.heel,
        `${side} foot geometry estimated for skeleton '${input.hostId}': ${estimatedItems.join('; ')}. Contact sites derived from it may not match the host mesh.`,
        `Add boneMap.sites.${fs.heel}, ${fs.toe}${M ? '' : ` (and map '${lj.mtp}' to a toe bone)`}, ${fs.ballMedial} and ${fs.ballLateral} ` +
          `with offsets in host units in the rest frame of '${boneName(lj.ankle)}'${M ? ` / '${boneName(lj.mtp)}'` : ''}.`,
      );
  }

  // ---------------------------------------------------------------- seat
  let seatDrop: number;
  let seatBack: number;
  const seat = site('seat');
  if (seat) {
    const s = quatRotateVec3(pelvisAlign, sub(seat, Pc));
    seatDrop = -s[1];
    seatBack = Math.max(0, -s[2]);
  } else {
    seatDrop = hipDrop + (A.pelvis.seatDrop - A.pelvis.hipDrop) * legScale;
    seatBack = A.pelvis.seatBack * legScale;
    estimatedSites.push('seat');
    note(
      'warning',
      'seat',
      `seat contact point estimated for skeleton '${input.hostId}': ${(seatDrop * 1000).toFixed(1)} mm below and ${(seatBack * 1000).toFixed(1)} mm behind the pelvis origin (rig-A offsets from the hip centres scaled by leg length)`,
      `Add boneMap.sites.seat = { bone: '${boneName('pelvis')}', offset: [...] } (host units, in that bone's rest frame) at the ischial contact point.`,
    );
  }
  if (!(seatDrop > EPS_LEN)) fail('seat', `seat site is not below the pelvis origin (seatDrop ${seatDrop.toFixed(4)} m)`, 'Check boneMap.sites.seat.');
  if (!(lumbarBaseHeight > EPS_LEN) || !(lumbar > EPS_LEN) || !(thoracic > EPS_LEN) || !(neck > EPS_LEN) || !(head > EPS_LEN))
    fail('lumbar', 'trunk segment lengths must be positive; the spine bones coincide in the rest pose', 'Spine bones need distinct rest origins above the pelvis.');
  for (const side of SIDES)
    for (const [k, v] of Object.entries(arm[side]))
      if (!(v > EPS_LEN)) fail(armJoints(side).shoulder, `${side} arm ${k} measured as ${v.toFixed(4)} m (must be > 0)`, 'Arm bones need distinct rest origins.');
  if (failed) return null;

  const proportions: HumanoidProportions = {
    pelvis: { hipHalfWidth, hipDrop, seatDrop, seatBack, lumbarBaseHeight },
    trunk: { lumbar, thoracic, neck, head, shoulderHalfWidth, shoulderDrop },
    left: { leg: feet.left, arm: arm.left },
    right: { leg: feet.right, arm: arm.right },
  };
  return { proportions, align, pelvisOrigin: Pc, pelvisDelta, jointRestPos, estimatedSites };
}

/**
 * Compares the host rest geometry, bound into the canonical rest pose, with the derived rig.
 * Returns per-joint / per-site residuals (m). Everything is exact for representable hosts; a
 * residual means the host segment's shape is outside the canonical parametrisation.
 */
export function restResiduals(rig: RigDefinition, m: Measurement, input: MeasureInput): { subject: string; bone: string; residual: number }[] {
  const model = getRigModel(rig);
  const fk = forwardKinematics(model, [0, 0, 0], [0, 0, 0], []);
  const out: { subject: string; bone: string; residual: number }[] = [];
  const mappedJ = (j: string): boolean => j !== 'root' && input.jointBone.has(j);
  const canonPos = (j: string): Vec3 => fk.worldPos[model.index.get(j)!]!;
  for (const j of model.names) {
    if (j === 'root' || j === 'pelvis' || !input.jointBone.has(j)) continue;
    const a = nearestCanonicalAncestor(j, mappedJ);
    if (!a) continue;
    const expected = sub(canonPos(j), canonPos(a));
    const actual = quatRotateVec3(m.align.get(a)!, sub(m.jointRestPos.get(j)!, m.jointRestPos.get(a)!));
    out.push({ subject: j, bone: input.hostNames[input.jointBone.get(j)!]!, residual: distance(expected, actual) });
  }
  for (const [s, p] of input.sitePos) {
    const k = CANONICAL_SITE_JOINT.get(s);
    const si = model.siteIndex.get(s);
    if (!k || si === undefined) continue;
    const a = mappedJ(k) ? k : nearestCanonicalAncestor(k, mappedJ);
    if (!a) continue;
    const expected = sub(fk.sitePos[si]!, canonPos(a));
    const actual = quatRotateVec3(m.align.get(a)!, sub(p, m.jointRestPos.get(a)!));
    out.push({ subject: s, bone: input.hostNames[input.jointBone.get(a)!]!, residual: distance(expected, actual) });
  }
  return out;
}
