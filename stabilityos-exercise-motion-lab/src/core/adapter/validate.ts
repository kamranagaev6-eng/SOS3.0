import type { z } from 'zod';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import { boneMapSchema, hostSkeletonSchema, type BoneMap, type HostSkeleton } from '../contracts/hostRig.ts';
import { capabilitySchema, CAPABILITIES, type Capability } from '../contracts/rig.ts';
import type { Vec3 } from '../math/vec3.ts';
import { bonesBetween, isStrictAncestor, type HostTopology } from './hierarchy.ts';
import {
  CANONICAL_JOINTS,
  CANONICAL_PARENT,
  CANONICAL_SITE_JOINT,
  LOCATABLE_SITES,
  nearestCanonicalAncestor,
  REQUIRED_JOINTS,
  sideOfJoint,
} from './topology.ts';

/** Input validation for the host rig adapter. Every problem becomes a diagnostic; nothing throws. */

function pathString(root: string, path: readonly PropertyKey[]): string {
  return root + path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('');
}

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let v: unknown = raw;
  for (const p of path) {
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<PropertyKey, unknown>)[p as string];
  }
  return v;
}

function describeNumber(v: number): string {
  return Number.isNaN(v) ? 'NaN' : v > 0 ? 'Infinity' : '-Infinity';
}

/** Parses a JSON string input; other values pass through. */
function fromJsonLike(input: unknown, what: string, diagnostics: Diagnostic[]): { ok: boolean; value: unknown } {
  if (typeof input !== 'string') return { ok: true, value: input };
  try {
    return { ok: true, value: JSON.parse(input) as unknown };
  } catch (e) {
    diagnostics.push(
      diag('SCHEMA_INVALID', 'error', `${what} is a string but not valid JSON: ${(e as Error).message}`, {
        path: what,
        hint: `Pass the ${what} as an object or as a complete JSON document.`,
      }),
    );
    return { ok: false, value: undefined };
  }
}

function zodDiagnostics(error: z.ZodError, raw: unknown, root: 'host' | 'boneMap'): Diagnostic[] {
  return error.issues.map((issue) => {
    const path = issue.path;
    const where = pathString(root, path);
    const value = valueAt(raw, path);
    if (root === 'host' && path[0] === 'bones' && typeof path[1] === 'number') {
      const bone = valueAt(raw, ['bones', path[1]]) as { name?: unknown } | undefined;
      const boneName = typeof bone?.name === 'string' ? bone.name : `bones[${path[1]}]`;
      const field = String(path[2] ?? '');
      if (typeof value === 'number' && !Number.isFinite(value))
        return diag('RIG_INVALID', 'error', `bone '${boneName}' ${field}[${String(path[3])}] is not a finite number (${describeNumber(value)})`, {
          path: where,
          subject: boneName,
          hint: 'Replace non-finite values in the rest transform; NaN/Infinity usually come from a failed export or a division by zero.',
        });
      if (field === 'restRotation' && path.length === 3 && Array.isArray(value) && value.length === 4 && value.every((c) => typeof c === 'number' && Number.isFinite(c))) {
        const len = Math.hypot(...(value as number[]));
        return diag('RIG_INVALID', 'error', `bone '${boneName}' restRotation is not a unit quaternion (length ${len.toPrecision(6)}; must be 1 within 1e-6)`, {
          path: where,
          subject: boneName,
          value: len,
          limit: 1,
          hint: 'Normalise the quaternion [x, y, z, w]; the adapter does not guess whether a non-unit value was meant as a scale.',
        });
      }
    }
    if (root === 'boneMap' && typeof value === 'number' && !Number.isFinite(value))
      return diag('SCHEMA_INVALID', 'error', `${where} is not a finite number (${describeNumber(value)})`, { path: where, hint: 'Use finite numbers only.' });
    return diag('SCHEMA_INVALID', 'error', `${where}: ${issue.message}`, {
      path: where,
      hint: root === 'host' ? 'The host skeleton must match smx.host-skeleton/1.' : 'The bone map must match smx.bone-map/1.',
    });
  });
}

export interface ParsedInputs {
  host: HostSkeleton | null;
  boneMap: BoneMap | null;
  required: Capability[];
}

export function parseInputs(hostIn: unknown, boneMapIn: unknown, requiredIn: unknown, diagnostics: Diagnostic[]): ParsedInputs {
  const out: ParsedInputs = { host: null, boneMap: null, required: [] };
  const h = fromJsonLike(hostIn, 'host', diagnostics);
  if (h.ok) {
    const r = hostSkeletonSchema.safeParse(h.value);
    if (r.success) out.host = r.data;
    else diagnostics.push(...zodDiagnostics(r.error, h.value, 'host'));
  }
  const m = fromJsonLike(boneMapIn, 'boneMap', diagnostics);
  if (m.ok) {
    const r = boneMapSchema.safeParse(m.value);
    if (r.success) out.boneMap = r.data;
    else diagnostics.push(...zodDiagnostics(r.error, m.value, 'boneMap'));
  }
  if (requiredIn !== undefined) {
    if (!Array.isArray(requiredIn))
      diagnostics.push(diag('SCHEMA_INVALID', 'error', 'requiredCapabilities must be an array of capability names', { path: 'requiredCapabilities', hint: `Known capabilities: ${CAPABILITIES.join(', ')}` }));
    else
      requiredIn.forEach((c, i) => {
        const r = capabilitySchema.safeParse(c);
        if (r.success) {
          if (!out.required.includes(r.data)) out.required.push(r.data);
        } else
          diagnostics.push(
            diag('SCHEMA_INVALID', 'error', `requiredCapabilities[${i}] = ${JSON.stringify(c) ?? String(c)} is not a known capability`, {
              path: `requiredCapabilities[${i}]`,
              hint: `Known capabilities: ${CAPABILITIES.join(', ')}`,
            }),
          );
      });
  }
  return out;
}

export interface MappingResult {
  /** Canonical joint → host bone index (only entries whose bone exists). */
  jointBone: Map<string, number>;
  /** Canonical site → host bone index + offset (host units, host axes, bone rest frame). */
  siteDefs: Map<string, { bone: number; offset: Vec3 }>;
}

const JOINT_WORDS: Record<string, string> = {
  pelvis: 'pelvis origin (the bone that parents both thigh bones)',
  hip: 'hip joint centre',
  knee: 'knee joint centre',
  ankle: 'ankle joint centre',
};

function jointDescription(j: string): string {
  const base = j.replace(/_[LR]$/, '');
  const side = sideOfJoint(j);
  const word = JOINT_WORDS[base] ?? `${base} joint`;
  return side === 'center' ? word : `${side} ${word}`;
}

/** Bone-map semantics against the host hierarchy (no geometry). */
export function validateMapping(host: HostSkeleton, boneMap: BoneMap, topo: HostTopology, diagnostics: Diagnostic[]): MappingResult {
  const jointBone = new Map<string, number>();
  const siteDefs = new Map<string, { bone: number; offset: Vec3 }>();
  const knownJoints = new Set(CANONICAL_JOINTS);
  const knownSites = new Set(LOCATABLE_SITES);
  if (boneMap.hostSkeletonId !== host.id)
    diagnostics.push(
      diag('RIG_INVALID', 'error', `bone map is written for skeleton '${boneMap.hostSkeletonId}', but the host skeleton is '${host.id}'`, {
        path: 'boneMap.hostSkeletonId',
        hint: 'Use the bone map that belongs to this skeleton (or update hostSkeletonId after checking every mapping).',
      }),
    );
  const missingBone = (key: string, bone: string, path: string, kind: 'joint' | 'site'): void => {
    diagnostics.push(
      diag('MISSING_BONE', 'error', `canonical ${kind} '${key}' is mapped to host bone '${bone}', which is not in skeleton '${host.id}'`, {
        path,
        subject: key,
        hint: `Add a bone named '${bone}' to the skeleton, or change ${path} to an existing bone name (names are case-sensitive and never guessed).`,
      }),
    );
  };
  for (const [key, bone] of Object.entries(boneMap.joints)) {
    const path = `boneMap.joints.${key}`;
    if (knownJoints.has(key)) {
      const b = topo.index.get(bone);
      if (b === undefined) missingBone(key, bone, path, 'joint');
      else jointBone.set(key, b);
    } else if (knownSites.has(key)) {
      const b = topo.index.get(bone);
      if (boneMap.sites[key])
        diagnostics.push(diag('SCHEMA_INVALID', 'error', `site '${key}' is given both in boneMap.joints and boneMap.sites`, { path, subject: key, hint: 'Keep one of them.' }));
      else if (b === undefined) missingBone(key, bone, path, 'site');
      else siteDefs.set(key, { bone: b, offset: [0, 0, 0] });
    } else {
      diagnostics.push(
        diag('SCHEMA_INVALID', 'error', `boneMap.joints has unknown canonical name '${key}'`, {
          path,
          subject: key,
          hint: `Canonical joints: ${CANONICAL_JOINTS.join(', ')}; locatable sites: ${LOCATABLE_SITES.join(', ')}.`,
        }),
      );
    }
  }
  for (const [key, s] of Object.entries(boneMap.sites)) {
    const path = `boneMap.sites.${key}`;
    if (!knownSites.has(key)) {
      diagnostics.push(
        diag('SCHEMA_INVALID', 'error', `boneMap.sites has unknown or derived site '${key}'`, {
          path,
          subject: key,
          hint: `Locatable sites: ${LOCATABLE_SITES.join(', ')} (ball, heel_med and heel_lat follow from the foot model).`,
        }),
      );
      continue;
    }
    const b = topo.index.get(s.bone);
    if (b === undefined) missingBone(key, s.bone, `${path}.bone`, 'site');
    else siteDefs.set(key, { bone: b, offset: [...s.offset] as Vec3 });
  }
  for (const key of Object.keys(boneMap.twist)) {
    if (!knownJoints.has(key) || boneMap.joints[key] === undefined)
      diagnostics.push(
        diag('SCHEMA_INVALID', 'error', `boneMap.twist.${key} names a joint that is not mapped`, {
          path: `boneMap.twist.${key}`,
          subject: key,
          hint: 'Twist applies to mapped canonical joints only; map the joint or remove the twist entry.',
        }),
      );
  }
  for (const j of REQUIRED_JOINTS) {
    if (boneMap.joints[j] !== undefined) continue;
    const parent = CANONICAL_PARENT.get(j) ?? null;
    const pb = parent ? jointBone.get(parent) : undefined;
    const candidates = pb !== undefined ? topo.children[pb]!.map((c) => `'${topo.names[c]}'`) : [];
    diagnostics.push(
      diag('MISSING_BONE', 'error', `canonical joint '${j}' has no host bone mapped (boneMap.joints.${j} is missing); leg contacts cannot be transferred without it`, {
        path: `boneMap.joints.${j}`,
        subject: j,
        hint:
          `Set boneMap.joints.${j} to the host bone whose origin is at the ${jointDescription(j)}` +
          (pb !== undefined ? ` (a child of '${topo.names[pb]}'${candidates.length ? `; its children are ${candidates.join(', ')}` : ''}).` : '.'),
      }),
    );
  }
  // One bone per canonical joint.
  const byBone = new Map<number, string[]>();
  for (const [j, b] of jointBone) byBone.set(b, [...(byBone.get(b) ?? []), j]);
  for (const [b, js] of byBone) {
    if (js.length < 2) continue;
    const sides = new Set(js.map(sideOfJoint));
    diagnostics.push(
      diag('RIG_HIERARCHY_MISMATCH', 'error', `host bone '${topo.names[b]}' is mapped to several canonical joints: ${js.map((j) => `'${j}'`).join(', ')}`, {
        path: `boneMap.joints.${js[1]}`,
        subject: js[1],
        hint:
          sides.has('left') && sides.has('right')
            ? 'Left and right limbs must use separate bones; shared bones cannot move independently.'
            : "Each canonical joint needs its own bone (map only 'pelvis' when the hips bone is also the skeleton root: the root's heading and translation are carried by it).",
      }),
    );
    for (const j of js.slice(1)) jointBone.delete(j);
  }
  // Hierarchy consistency: each mapped joint descends from its nearest mapped canonical ancestor,
  // through bones that are not mapped to anything else.
  const boneJoint = new Map<number, string>();
  for (const [j, b] of jointBone) boneJoint.set(b, j);
  for (const j of CANONICAL_JOINTS) {
    const b = jointBone.get(j);
    if (b === undefined) continue;
    const a = nearestCanonicalAncestor(j, (x) => jointBone.has(x));
    if (!a) continue;
    const ba = jointBone.get(a)!;
    if (!isStrictAncestor(topo, ba, b)) {
      diagnostics.push(
        diag(
          'RIG_HIERARCHY_MISMATCH',
          'error',
          `'${j}' is mapped to '${topo.names[b]}', which is not a descendant of '${topo.names[ba]}' (mapped to '${a}'); in the canonical rig '${j}' is below '${a}'`,
          { path: `boneMap.joints.${j}`, subject: j, hint: `Check the mappings of '${j}' and '${a}' (swapped joints, wrong side, or a bone from another chain).` },
        ),
      );
      continue;
    }
    const between = bonesBetween(topo, ba, b).filter((k) => boneJoint.has(k));
    if (between.length) {
      const k = between[0]!;
      diagnostics.push(
        diag(
          'RIG_HIERARCHY_MISMATCH',
          'error',
          `the host chain from '${topo.names[ba]}' ('${a}') to '${topo.names[b]}' ('${j}') passes through '${topo.names[k]}', which is mapped to '${boneJoint.get(k)}'; '${j}' would move with '${boneJoint.get(k)}'`,
          { path: `boneMap.joints.${j}`, subject: j, hint: `In the canonical rig '${boneJoint.get(k)}' is not an ancestor of '${j}'; fix one of the two mappings.` },
        ),
      );
    }
  }
  // Sites must move rigidly with the bone of their canonical joint.
  for (const [s, def] of siteDefs) {
    const k = CANONICAL_SITE_JOINT.get(s);
    if (!k) continue;
    const a = jointBone.has(k) && k !== 'root' ? k : nearestCanonicalAncestor(k, (x) => x !== 'root' && jointBone.has(x));
    if (!a) continue;
    const ba = jointBone.get(a)!;
    const rigid = def.bone === ba || (isStrictAncestor(topo, ba, def.bone) && ![...bonesBetween(topo, ba, def.bone), def.bone].some((x) => boneJoint.has(x)));
    if (!rigid)
      diagnostics.push(
        diag('RIG_HIERARCHY_MISMATCH', 'error', `site '${s}' is attached to '${topo.names[def.bone]}', which does not move rigidly with '${topo.names[ba]}' (mapped to '${a}')`, {
          path: `boneMap.sites.${s}`,
          subject: s,
          hint: `Attach '${s}' to '${topo.names[ba]}' (offset in host units in that bone's rest frame).`,
        }),
      );
  }
  return { jointBone, siteDefs };
}

/**
 * Left/right sanity check in canonical space: the bone mapped to a `_L` joint must lie on the
 * host's declared `left` side of its `_R` counterpart (hips always; shoulders when mapped).
 */
export function checkSides(host: HostSkeleton, topo: HostTopology, jointBone: ReadonlyMap<string, number>, restPos: readonly Vec3[], diagnostics: Diagnostic[]): void {
  for (const base of ['hip', 'shoulder']) {
    const l = jointBone.get(`${base}_L`);
    const r = jointBone.get(`${base}_R`);
    if (l === undefined || r === undefined) continue;
    const dx = restPos[l]![0] - restPos[r]![0];
    if (dx > 1e-6) continue;
    if (dx < -1e-6)
      diagnostics.push(
        diag(
          'RIG_HIERARCHY_MISMATCH',
          'error',
          `left/right appear swapped: '${base}_L' is mapped to '${topo.names[l]}', which lies ${(-dx * 1000).toFixed(1)} mm toward the subject's RIGHT of '${topo.names[r]}' ('${base}_R') along the declared left axis ${host.left}`,
          {
            path: `boneMap.joints.${base}_L`,
            subject: `${base}_L`,
            value: dx,
            hint: `Swap the _L and _R mappings, or correct the skeleton's axis labels (with up ${host.up} and forward ${host.forward}, left must be the subject's left).`,
          },
        ),
      );
    else
      diagnostics.push(
        diag('RIG_INVALID', 'error', `'${base}_L' ('${topo.names[l]}') and '${base}_R' ('${topo.names[r]}') are not separated along the left axis ${host.left}`, {
          path: `boneMap.joints.${base}_L`,
          subject: `${base}_L`,
          hint: 'Check the axis labels and that left and right bones are distinct in the rest pose.',
        }),
      );
  }
}
