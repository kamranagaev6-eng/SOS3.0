import { SIDES } from '../contracts/common.ts';
import { buildCanonicalRig, footSites, PROPORTIONS_A, SEAT_SITE } from '../rig/canonical.ts';

/**
 * Canonical joint topology (independent of proportions) and the canonical sites a bone map may
 * locate explicitly. Built once from the canonical builder so it cannot drift from it.
 */
const TOPOLOGY_RIG = buildCanonicalRig('canonical-topology', 'canonical topology', PROPORTIONS_A);

export const CANONICAL_JOINTS: readonly string[] = TOPOLOGY_RIG.joints.map((j) => j.name);
export const CANONICAL_PARENT: ReadonlyMap<string, string | null> = new Map(TOPOLOGY_RIG.joints.map((j) => [j.name, j.parent] as const));
export const CANONICAL_SITE_JOINT: ReadonlyMap<string, string> = new Map(TOPOLOGY_RIG.sites.map((s) => [s.name, s.joint] as const));

/**
 * Sites a bone map may place explicitly (`boneMap.sites`, or `boneMap.joints` naming a bone whose
 * origin is the site). The remaining canonical sites (ball, heel/ball medial/lateral) follow from
 * these through the canonical foot model.
 */
export const LOCATABLE_SITES: readonly string[] = [
  ...SIDES.flatMap((s) => {
    const f = footSites(s);
    const x = s === 'left' ? '_L' : '_R';
    return [f.heel, f.toe, f.ballMedial, f.ballLateral, `hand${x}`];
  }),
  SEAT_SITE,
  'head_top',
];

/** Joints without which no leg-contact motion can be transferred. */
export const REQUIRED_JOINTS: readonly string[] = ['pelvis', 'hip_L', 'knee_L', 'ankle_L', 'hip_R', 'knee_R', 'ankle_R'];

/** Nearest canonical ancestor (strict) of `joint` satisfying `pred`, or null. */
export function nearestCanonicalAncestor(joint: string, pred: (j: string) => boolean): string | null {
  let p = CANONICAL_PARENT.get(joint) ?? null;
  while (p !== null) {
    if (pred(p)) return p;
    p = CANONICAL_PARENT.get(p) ?? null;
  }
  return null;
}

export function sideOfJoint(name: string): 'left' | 'right' | 'center' {
  return name.endsWith('_L') ? 'left' : name.endsWith('_R') ? 'right' : 'center';
}

export function otherSideName(name: string): string | null {
  if (name.endsWith('_L')) return `${name.slice(0, -2)}_R`;
  if (name.endsWith('_R')) return `${name.slice(0, -2)}_L`;
  return null;
}
