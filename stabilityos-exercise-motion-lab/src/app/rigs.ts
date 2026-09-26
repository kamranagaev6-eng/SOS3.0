import type { Diagnostic } from '../core/contracts/diagnostics.ts';
import type { Capability, RigDefinition } from '../core/contracts/rig.ts';
import { capabilityRequirements, createHostRigAdapter, createRigA, listRecipes, SYNTHETIC_HOST_RIGS } from '../core/engine.ts';
import type { PoseSample } from '../core/solver/types.ts';
import type { HostBoneView } from '../render/index.ts';

export const RIG_A_ID = 'rig-a';

export interface RigOption {
  id: string;
  label: string;
  description: string;
  available: boolean;
}

export interface ResolvedRig {
  id: string;
  label: string;
  status: 'ready' | 'incompatible' | 'unavailable';
  rig: RigDefinition | null;
  diagnostics: Diagnostic[];
  /** Host skeleton bones (canonical space) for the host-bone overlay; adapted rigs only. */
  hostBones: ((s: PoseSample) => HostBoneView[]) | null;
  adapted: boolean;
}

let rigA: RigDefinition | null = null;
export function getRigA(): RigDefinition {
  rigA ??= createRigA();
  return rigA;
}

export function rigOptions(): RigOption[] {
  return [
    { id: RIG_A_ID, label: 'Rig A — canonical synthetic humanoid', description: 'Canonical rig built by the engine (metres, +Y up, +Z forward).', available: true },
    ...SYNTHETIC_HOST_RIGS.map((r) => ({ id: r.id, label: r.label, description: r.description, available: true })),
  ];
}

// Adapter results are cached per (rig, capability set) so the canonical RigDefinition object is
// stable across renders (the stage rebuilds meshes only when the rig object changes).
const cache = new Map<string, ResolvedRig>();

export function resolveRig(id: string, required: readonly Capability[]): ResolvedRig {
  if (id === RIG_A_ID) {
    return { id, label: 'Rig A — canonical synthetic humanoid', status: 'ready', rig: getRigA(), diagnostics: [], hostBones: null, adapted: false };
  }
  const key = `${id}|${[...required].sort().join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const host = SYNTHETIC_HOST_RIGS.find((r) => r.id === id);
  let out: ResolvedRig;
  if (!host) {
    out = { id, label: id, status: 'unavailable', rig: null, diagnostics: [{ code: 'RIG_INVALID', severity: 'error', message: `Unknown host rig '${id}'.` }], hostBones: null, adapted: true };
  } else {
    try {
      // requiredBy lets MISSING_CAPABILITY hints name the recipes that need a capability.
      const { requiredBy } = capabilityRequirements(listRecipes());
      const res = createHostRigAdapter(host.host, host.boneMap, required, { requiredBy });
      if (res.ok) {
        const adapter = res.adapter;
        out = {
          id,
          label: host.label,
          status: 'ready',
          rig: adapter.canonical,
          diagnostics: res.diagnostics,
          hostBones: (s) =>
            adapter.hostWorldInCanonical(adapter.toHostPose(s)).map((b) => ({ name: b.name, parent: b.parent, position: b.position })),
          adapted: true,
        };
      } else {
        out = { id, label: host.label, status: 'incompatible', rig: null, diagnostics: res.diagnostics, hostBones: null, adapted: true };
      }
    } catch (e) {
      out = {
        id,
        label: host.label,
        status: 'incompatible',
        rig: null,
        diagnostics: [{ code: 'RIG_INVALID', severity: 'error', message: `Adapter failed: ${e instanceof Error ? e.message : String(e)}` }],
        hostBones: null,
        adapted: true,
      };
    }
  }
  cache.set(key, out);
  return out;
}
