import type { BoneMap, CapabilityReport, HostSkeleton } from '../contracts/hostRig.ts';
import { CAPABILITIES, type Capability } from '../contracts/rig.ts';
import { buildTopology, isStrictAncestor, type HostTopology } from './hierarchy.ts';

/**
 * Capability model: what the host skeleton can express, judged from its hierarchy and the bone
 * map only (no geometry). A capability the host lacks is never emulated by folding the missing
 * motion into other bones; the adapter reports it.
 */
interface Ctx {
  host: HostSkeleton;
  boneMap: BoneMap;
  topo: HostTopology;
}

const q = (s: string): string => `'${s}'`;

function mapped(ctx: Ctx, joint: string): string | undefined {
  return ctx.boneMap.joints[joint];
}

/** Host bone index mapped to `joint`, or -1 when unmapped or the named bone does not exist. */
function boneOf(ctx: Ctx, joint: string): number {
  const name = mapped(ctx, joint);
  if (name === undefined) return -1;
  return ctx.topo.index.get(name) ?? -1;
}

function describeMissing(ctx: Ctx, joint: string): string {
  const name = mapped(ctx, joint);
  return name === undefined ? `no host bone is mapped to ${q(joint)}` : `${q(joint)} is mapped to ${q(name)}, which is not in the skeleton`;
}

/**
 * Checks that every joint is mapped to an existing bone and each consecutive pair is a strict
 * ancestor/descendant pair in the host. Returns the first problem or null.
 */
function chainProblem(ctx: Ctx, joints: readonly string[]): string | null {
  let prev = -1;
  let prevJoint = '';
  for (const j of joints) {
    const b = boneOf(ctx, j);
    if (b < 0) return describeMissing(ctx, j);
    if (prev >= 0 && !isStrictAncestor(ctx.topo, prev, b))
      return `${q(j)} (${q(ctx.topo.names[b]!)}) is not a descendant of ${q(prevJoint)} (${q(ctx.topo.names[prev]!)})`;
    prev = b;
    prevJoint = j;
  }
  return null;
}

function sidesIndependent(ctx: Ctx, left: readonly string[], right: readonly string[]): string | null {
  const lb = left.map((j) => boneOf(ctx, j));
  const rb = right.map((j) => boneOf(ctx, j));
  const all = [...lb, ...rb];
  if (new Set(all).size !== all.length) return 'left and right chains share a bone';
  for (const a of lb)
    for (const b of rb) {
      if (isStrictAncestor(ctx.topo, a, b))
        return `right-side bone ${q(ctx.topo.names[b]!)} is a descendant of left-side bone ${q(ctx.topo.names[a]!)}`;
      if (isStrictAncestor(ctx.topo, b, a))
        return `left-side bone ${q(ctx.topo.names[a]!)} is a descendant of right-side bone ${q(ctx.topo.names[b]!)}`;
    }
  return null;
}

function assessOne(ctx: Ctx, cap: Capability): { available: boolean; reason: string } {
  const pb = boneOf(ctx, 'pelvis');
  const pbName = pb >= 0 ? ctx.topo.names[pb]! : '';
  switch (cap) {
    case 'root-translation': {
      if (pb < 0) return { available: false, reason: describeMissing(ctx, 'pelvis') };
      let k = pb;
      for (let guard = 0; k >= 0 && guard <= ctx.topo.names.length; guard++) {
        if (ctx.host.bones[k]!.translatable) {
          const where = k === pb ? 'the pelvis bone' : `a root-motion bone above the pelvis bone ${q(pbName)}`;
          return { available: true, reason: `${q(ctx.topo.names[k]!)} (${where}) is translatable; root and pelvis translation are written there` };
        }
        k = ctx.topo.parent[k] ?? -1;
      }
      return {
        available: false,
        reason: `no bone at or above the pelvis bone ${q(pbName)} is translatable, so the body cannot translate (no root motion); pelvis translation would be dropped`,
      };
    }
    case 'pelvis-rotation': {
      if (pb < 0) return { available: false, reason: describeMissing(ctx, 'pelvis') };
      const trunk = assessOne(ctx, 'trunk-articulation');
      return {
        available: true,
        reason: trunk.available
          ? `pelvis rotation drives ${q(pbName)}`
          : `pelvis rotation drives ${q(pbName)}, which also carries the trunk rigidly (no separate spine bone)`,
      };
    }
    case 'trunk-articulation': {
      if (pb < 0) return { available: false, reason: describeMissing(ctx, 'pelvis') };
      const upper = ['neck', 'shoulder_L', 'shoulder_R'].map((j) => boneOf(ctx, j)).filter((b) => b >= 0);
      const problems: string[] = [];
      for (const j of ['lumbar', 'thoracic']) {
        const b = boneOf(ctx, j);
        if (b < 0) continue;
        if (b === pb || !isStrictAncestor(ctx.topo, pb, b)) {
          problems.push(`${q(j)} (${q(ctx.topo.names[b]!)}) is not a descendant of the pelvis bone ${q(pbName)}`);
          continue;
        }
        const notCarried = upper.filter((u) => !isStrictAncestor(ctx.topo, b, u));
        if (notCarried.length) {
          problems.push(`${q(j)} (${q(ctx.topo.names[b]!)}) does not carry ${notCarried.map((u) => q(ctx.topo.names[u]!)).join(', ')}`);
          continue;
        }
        return { available: true, reason: `${q(j)} is mapped to spine bone ${q(ctx.topo.names[b]!)} between the pelvis and the upper body` };
      }
      return {
        available: false,
        reason:
          (problems.length ? `${problems.join('; ')}. ` : `no bone is mapped to 'lumbar' or 'thoracic' between the pelvis bone ${q(pbName)} and the upper body. `) +
          'Trunk flexion, lateral flexion and axial rotation relative to the pelvis cannot be transferred; they are reported as dropped, never folded into other bones',
      };
    }
    case 'independent-legs': {
      const l = ['hip_L', 'knee_L', 'ankle_L'];
      const r = ['hip_R', 'knee_R', 'ankle_R'];
      const p = chainProblem(ctx, ['pelvis', ...l]) ?? chainProblem(ctx, ['pelvis', ...r]) ?? sidesIndependent(ctx, l, r);
      return p ? { available: false, reason: p } : { available: true, reason: 'left and right hip/knee/ankle chains are separate bones branching from the pelvis' };
    }
    case 'knee-hinge': {
      const p = chainProblem(ctx, ['hip_L', 'knee_L', 'ankle_L']) ?? chainProblem(ctx, ['hip_R', 'knee_R', 'ankle_R']);
      return p ? { available: false, reason: p } : { available: true, reason: 'knee bones sit between the thigh and foot bones on both sides' };
    }
    case 'ankle-2dof': {
      const p = chainProblem(ctx, ['knee_L', 'ankle_L']) ?? chainProblem(ctx, ['knee_R', 'ankle_R']);
      return p ? { available: false, reason: p } : { available: true, reason: 'foot bones are mapped below the knees on both sides' };
    }
    case 'forefoot-articulation': {
      const p = chainProblem(ctx, ['ankle_L', 'mtp_L']) ?? chainProblem(ctx, ['ankle_R', 'mtp_R']);
      return p
        ? { available: false, reason: `${p}; heel raises and forefoot contact need a toe segment that rotates about the MTP joint` }
        : { available: true, reason: 'toe bones are mapped below the foot bones on both sides' };
    }
    case 'independent-arms': {
      const l = ['shoulder_L', 'elbow_L', 'wrist_L'];
      const r = ['shoulder_R', 'elbow_R', 'wrist_R'];
      const p = chainProblem(ctx, l) ?? chainProblem(ctx, r) ?? sidesIndependent(ctx, l, r);
      return p ? { available: false, reason: p } : { available: true, reason: 'left and right shoulder/elbow/wrist chains are separate bones' };
    }
    case 'neck': {
      const p = chainProblem(ctx, ['pelvis', 'neck']);
      return p ? { available: false, reason: p } : { available: true, reason: `'neck' is mapped to ${q(ctx.topo.names[boneOf(ctx, 'neck')]!)}` };
    }
  }
}

function contextFor(host: HostSkeleton, boneMap: BoneMap): Ctx {
  return { host, boneMap, topo: buildTopology(host).topology };
}

export function assessCapabilities(host: HostSkeleton, boneMap: BoneMap): CapabilityReport[] {
  const ctx = contextFor(host, boneMap);
  return CAPABILITIES.map((capability) => ({ capability, ...assessOne(ctx, capability) }));
}

/** Actionable, host-specific instruction for obtaining a capability. */
export function capabilityHint(host: HostSkeleton, boneMap: BoneMap, cap: Capability, requiredBy?: readonly string[]): string {
  const ctx = contextFor(host, boneMap);
  const name = (j: string, fallback: string): string => {
    const b = boneOf(ctx, j);
    return b >= 0 ? ctx.topo.names[b]! : fallback;
  };
  const pelvis = name('pelvis', '<hips bone>');
  const units = host.units;
  let hint: string;
  switch (cap) {
    case 'root-translation':
      hint =
        boneOf(ctx, 'pelvis') < 0
          ? `Map 'pelvis' to the hips bone (parent of both thigh bones) and set "translatable": true on it (or on a root bone above it)`
          : `Set "translatable": true on ${q(pelvis)} (or add a translatable root bone above it) so it can receive root motion; the adapter writes the pelvis trajectory there in ${units} along the host axes (up ${host.up}, forward ${host.forward})`;
      break;
    case 'pelvis-rotation':
      hint = `Map 'pelvis' (boneMap.joints.pelvis) to the host bone that is the parent of both thigh bones`;
      break;
    case 'trunk-articulation': {
      const upper = ['neck', 'shoulder_L', 'shoulder_R'].map((j) => boneOf(ctx, j)).filter((b) => b >= 0);
      const upperNames = upper.map((b) => q(ctx.topo.names[b]!));
      hint =
        `Add a spine bone as a child of ${q(pelvis)} that parents the upper body${upperNames.length ? ` (${upperNames.join(', ')})` : ''}, ` +
        `and map it to 'lumbar' (optionally a chest bone above it to 'thoracic')`;
      break;
    }
    case 'independent-legs':
      hint = `Map hip_L/knee_L/ankle_L and hip_R/knee_R/ankle_R to two separate bone chains that both branch from ${q(pelvis)}`;
      break;
    case 'knee-hinge':
      hint = `Map 'knee_L' and 'knee_R' to the lower-leg bones (children of ${q(name('hip_L', '<left thigh>'))} and ${q(name('hip_R', '<right thigh>'))})`;
      break;
    case 'ankle-2dof':
      hint = `Map 'ankle_L' and 'ankle_R' to the foot bones (children of ${q(name('knee_L', '<left lower leg>'))} and ${q(name('knee_R', '<right lower leg>'))})`;
      break;
    case 'forefoot-articulation':
      hint =
        `Add a child bone of ${q(name('ankle_L', '<left foot>'))} at the metatarsophalangeal joint and map it to 'mtp_L', ` +
        `and a child bone of ${q(name('ankle_R', '<right foot>'))} mapped to 'mtp_R'`;
      break;
    case 'independent-arms':
      hint = `Map shoulder/elbow/wrist on both sides to separate bone chains (upper arm, forearm, hand)`;
      break;
    case 'neck':
      hint = `Map 'neck' to a neck bone that descends from ${q(pelvis)} through the spine`;
      break;
  }
  const by = requiredBy && requiredBy.length ? requiredBy.join(' and ') : null;
  const why: Partial<Record<Capability, string>> = {
    'forefoot-articulation': 'forefoot contact',
    'root-translation': 'whole-body translation',
    'trunk-articulation': 'trunk lean relative to the pelvis',
  };
  const reason = why[cap] ? ` (${why[cap]})` : '';
  return by ? `${hint}; required by ${by}${reason}.` : `${hint}; required by the requested motion${reason}.`;
}

/**
 * Collects capability requirements from recipe definitions (anything with `id` and
 * `requiredCapabilities`) so MISSING_CAPABILITY hints can name the recipes that need them.
 */
export function capabilityRequirements(recipes: readonly { id: string; requiredCapabilities: readonly Capability[] }[]): {
  capabilities: Capability[];
  requiredBy: Partial<Record<Capability, string[]>>;
} {
  const requiredBy: Partial<Record<Capability, string[]>> = {};
  for (const r of recipes)
    for (const c of r.requiredCapabilities) {
      const list = (requiredBy[c] ??= []);
      if (!list.includes(r.id)) list.push(r.id);
    }
  const capabilities = CAPABILITIES.filter((c) => requiredBy[c] !== undefined);
  return { capabilities, requiredBy };
}
