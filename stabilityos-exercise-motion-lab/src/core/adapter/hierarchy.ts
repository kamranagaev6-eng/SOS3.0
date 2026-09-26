import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import type { HostSkeleton } from '../contracts/hostRig.ts';
import { quatMultiply, quatNormalize, quatRotateVec3, type Quat } from '../math/quat.ts';
import { add, type Vec3 } from '../math/vec3.ts';
import type { HostBasis } from './basis.ts';

/**
 * Best-effort index of a host skeleton's hierarchy. Problems (duplicate names, unknown parents,
 * cycles) are returned as diagnostics; the index stays usable for capability assessment:
 * duplicates keep the first bone, unknown parents are treated as roots and bones on a cycle are
 * left out of `order`.
 */
export interface HostTopology {
  readonly names: readonly string[];
  /** First bone index for each name. */
  readonly index: ReadonlyMap<string, number>;
  /** Parent bone index, -1 for roots (and for bones whose parent is unknown). */
  readonly parent: readonly number[];
  readonly children: readonly (readonly number[])[];
  /** Topological order (parents before children). Bones on a cycle are absent. */
  readonly order: readonly number[];
}

export function buildTopology(host: HostSkeleton): { topology: HostTopology; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const names = host.bones.map((b) => b.name);
  const index = new Map<string, number>();
  names.forEach((n, i) => {
    const prev = index.get(n);
    if (prev === undefined) index.set(n, i);
    else
      diagnostics.push(
        diag('RIG_INVALID', 'error', `host skeleton has two bones named '${n}' (bones[${prev}] and bones[${i}])`, {
          path: `host.bones[${i}].name`,
          subject: n,
          hint: 'Bone names must be unique; rename one of them and update the bone map.',
        }),
      );
  });
  const parent = host.bones.map((b, i) => {
    if (b.parent === null) return -1;
    const p = index.get(b.parent);
    if (p === undefined) {
      diagnostics.push(
        diag('RIG_INVALID', 'error', `bone '${b.name}' names parent '${b.parent}', which is not in the skeleton`, {
          path: `host.bones[${i}].parent`,
          subject: b.name,
          hint: `Add bone '${b.parent}' or set the parent of '${b.name}' to an existing bone (or null for a root).`,
        }),
      );
      return -1;
    }
    return p;
  });
  const n = names.length;
  const children: number[][] = names.map(() => []);
  parent.forEach((p, i) => {
    if (p >= 0 && index.get(names[i]!) === i) children[p]!.push(i);
  });
  // Iterative DFS from roots (first occurrence of each name only).
  const order: number[] = [];
  const reached = new Uint8Array(n);
  for (let r = 0; r < n; r++) {
    if (parent[r] !== -1 || index.get(names[r]!) !== r) continue;
    const stack = [r];
    while (stack.length) {
      const i = stack.pop()!;
      if (reached[i]) continue;
      reached[i] = 1;
      order.push(i);
      const ch = children[i]!;
      for (let k = ch.length - 1; k >= 0; k--) stack.push(ch[k]!);
    }
  }
  // Anything not reached (and not a duplicate) sits on or below a parent cycle.
  const reported = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (reached[i] || index.get(names[i]!) !== i || reported.has(i)) continue;
    // Walk up until a bone repeats: that bone is on the cycle.
    const seen = new Map<number, number>();
    const walk: number[] = [];
    let k = i;
    while (k >= 0 && !seen.has(k)) {
      seen.set(k, walk.length);
      walk.push(k);
      k = parent[k]!;
    }
    if (k < 0) continue; // defensive: reaches a root, cannot happen for unreached bones
    const cycle = walk.slice(seen.get(k)!);
    if (cycle.some((c) => reported.has(c))) {
      reported.add(i);
      continue;
    }
    cycle.forEach((c) => reported.add(c));
    reported.add(i);
    const loop = [...cycle, cycle[0]!].map((c) => `'${names[c]}'`).reverse();
    diagnostics.push(
      diag('RIG_INVALID', 'error', `bone parent chain forms a cycle: ${loop.join(' → ')}`, {
        path: `host.bones[${cycle[0]}].parent`,
        subject: names[cycle[0]!],
        hint: 'A skeleton must be a tree: give one bone of the cycle a real parent (or null for the root).',
      }),
    );
  }
  return { topology: { names, index, parent, children, order }, diagnostics };
}

/** True when `a` is a strict ancestor of `b`. */
export function isStrictAncestor(t: HostTopology, a: number, b: number): boolean {
  let k = t.parent[b] ?? -1;
  for (let guard = 0; k >= 0 && guard <= t.names.length; guard++) {
    if (k === a) return true;
    k = t.parent[k] ?? -1;
  }
  return false;
}

/** Bones strictly between ancestor `a` and descendant `b`, top-down. Empty when b is a direct child. */
export function bonesBetween(t: HostTopology, a: number, b: number): number[] {
  const out: number[] = [];
  let k = t.parent[b] ?? -1;
  for (let guard = 0; k >= 0 && k !== a && guard <= t.names.length; guard++) {
    out.push(k);
    k = t.parent[k] ?? -1;
  }
  return out.reverse();
}

/** Host rest transforms expressed in CANONICAL axes and metres. */
export interface CanonicalRest {
  /** Rest local translation (m, canonical axes, in the parent bone frame). */
  readonly localT: readonly Vec3[];
  /** Rest local rotation (canonical axes). */
  readonly localR: readonly Quat[];
  readonly worldP: readonly Vec3[];
  readonly worldR: readonly Quat[];
}

export function canonicalRest(host: HostSkeleton, t: HostTopology, basis: HostBasis): CanonicalRest {
  const localT = host.bones.map((b) => basis.vecToCanonical(b.restTranslation));
  const localR = host.bones.map((b) => quatNormalize(basis.quatToCanonical(b.restRotation)));
  const worldP: Vec3[] = localT.map((v) => [...v] as Vec3);
  const worldR: Quat[] = localR.map((q) => [...q] as Quat);
  for (const i of t.order) {
    const p = t.parent[i]!;
    if (p < 0) continue;
    worldP[i] = add(worldP[p]!, quatRotateVec3(worldR[p]!, localT[i]!));
    worldR[i] = quatNormalize(quatMultiply(worldR[p]!, localR[i]!));
  }
  return { localT, localR, worldP, worldR };
}
