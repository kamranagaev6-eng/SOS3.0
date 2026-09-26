import type { Diagnostic } from '../core/contracts/diagnostics.ts';
import type { Capability, RigDefinition } from '../core/contracts/rig.ts';
import { createRigA, listRecipes } from '../core/engine.ts';
import type { HostBoneView } from '../render/index.ts';
import type { PoseSample } from '../core/solver/types.ts';
import type { AdapterModule, SyntheticHostRig } from './optionalModules.ts';

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
  status: 'ready' | 'incompatible' | 'unavailable' | 'loading';
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

export function rigOptions(mod: AdapterModule | null, loading: boolean): RigOption[] {
  const out: RigOption[] = [
    { id: RIG_A_ID, label: 'Rig A — canonical synthetic humanoid', description: 'Canonical rig built by the engine (metres, +Y up, +Z forward).', available: true },
  ];
  if (mod) {
    for (const r of mod.SYNTHETIC_HOST_RIGS) out.push({ id: r.id, label: r.label, description: r.description, available: true });
  } else {
    const note = loading ? 'loading…' : 'adapter not available yet';
    out.push({ id: 'host-b', label: `Rig B — adapted host skeleton (${note})`, description: 'Requires the host-rig adapter module.', available: false });
    out.push({ id: 'host-c', label: `Rig C — legacy limb-only host rig (${note})`, description: 'Requires the host-rig adapter module.', available: false });
  }
  return out;
}

// Adapter results are cached per (rig, capability set) so the canonical RigDefinition object is
// stable across renders (the stage rebuilds meshes only when the rig object changes).
const cache = new Map<string, ResolvedRig>();

export function resolveRig(id: string, mod: AdapterModule | null, required: readonly Capability[]): ResolvedRig {
  if (id === RIG_A_ID) {
    return { id, label: 'Rig A — canonical synthetic humanoid', status: 'ready', rig: getRigA(), diagnostics: [], hostBones: null, adapted: false };
  }
  if (!mod) {
    return {
      id,
      label: id,
      status: 'unavailable',
      rig: null,
      diagnostics: [{ code: 'MISSING_CAPABILITY', severity: 'error', message: 'The host-rig adapter module is not available in this build.', hint: 'Select rig A.' }],
      hostBones: null,
      adapted: true,
    };
  }
  const key = `${id}|${[...required].sort().join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const host: SyntheticHostRig | undefined = mod.SYNTHETIC_HOST_RIGS.find((r) => r.id === id);
  let out: ResolvedRig;
  if (!host) {
    out = { id, label: id, status: 'unavailable', rig: null, diagnostics: [{ code: 'RIG_INVALID', severity: 'error', message: `Unknown host rig '${id}'.` }], hostBones: null, adapted: true };
  } else {
    try {
      // requiredBy lets MISSING_CAPABILITY hints name the recipes that need a capability.
      const { requiredBy } = mod.capabilityRequirements(listRecipes());
      const res = mod.createHostRigAdapter(host.host, host.boneMap, required, { requiredBy });
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
