/**
 * Shared sweep definition: recipes × rig variants × parameter configurations. Deterministic
 * (seeded). Used by the metrics report and by the validation tests.
 */
import type { ParamRecord, ParamSpec } from '../src/core/contracts/recipe.ts';
import type { RigDefinition } from '../src/core/contracts/rig.ts';
import { createRng } from '../src/core/math/rng.ts';
import { buildCanonicalRig, createRigA, PROPORTIONS_A, scaleProportions } from '../src/core/rig/canonical.ts';
import { listRecipes } from '../src/core/recipes/registry.ts';
import { capabilityRequirements, createHostRigAdapter, getSyntheticHostRig } from '../src/core/adapter/index.ts';
import type { RecipeDefinition } from '../src/core/recipes/types.ts';

export interface RigVariant {
  id: string;
  label: string;
  rig: RigDefinition;
}

export function rigVariants(): RigVariant[] {
  const v = (id: string, label: string, f: Parameters<typeof scaleProportions>[1]): RigVariant => ({
    id,
    label,
    rig: buildCanonicalRig(id, label, scaleProportions(PROPORTIONS_A, f)),
  });
  return [
    { id: 'synthetic-rig-a', label: 'Rig A (canonical)', rig: createRigA() },
    v('rig-a-short-legs', 'Rig A, legs ×0.9', { leg: 0.9 }),
    v('rig-a-long-legs', 'Rig A, legs ×1.1', { leg: 1.1 }),
    v('rig-a-long-trunk', 'Rig A, trunk ×1.12', { trunk: 1.12 }),
    v('rig-a-big-feet', 'Rig A, feet ×1.15', { foot: 1.15 }),
    v('rig-a-small', 'Rig A, uniform ×0.88', { leg: 0.88, trunk: 0.88, foot: 0.88, pelvis: 0.88, arm: 0.88 }),
    v('rig-a-lld', 'Rig A, left leg +10 mm', { leftLegExtra: 0.01 }),
    ...hostDerived('synthetic-rig-b-host', 'Rig B (host skeleton via adapter)'),
  ];
}

/** Canonical rig derived by the rig adapter from a synthetic host skeleton (cm, Z-up, T-pose). */
function hostDerived(id: string, label: string): RigVariant[] {
  const h = getSyntheticHostRig(id);
  if (!h) return [];
  // No hard requirements: each recipe checks the derived rig's capabilities itself at compile time.
  const r = createHostRigAdapter(h.host, h.boneMap, undefined, { requiredBy: capabilityRequirements(listRecipes()).requiredBy });
  return r.ok ? [{ id: r.adapter.canonical.id, label, rig: r.adapter.canonical }] : [];
}

export interface Config {
  recipe: RecipeDefinition;
  name: string;
  params: ParamRecord;
}

function corner(spec: ParamSpec, which: 'min' | 'max'): number | string {
  return spec.kind === 'number' ? spec[which] : spec.default;
}

/** Defaults, every leading-side combination, single-parameter extremes, and seeded random sets. */
export function paramConfigs(recipe: RecipeDefinition, randomCount = 4, seed = 1234): Config[] {
  const d = recipe.defaults();
  const out: Config[] = [{ recipe, name: 'defaults', params: d }];
  const enums = recipe.paramSpecs.filter((s) => s.kind === 'enum');
  if (enums.length) {
    const combos: ParamRecord[] = [{}];
    for (const e of enums) {
      const next: ParamRecord[] = [];
      for (const c of combos) for (const o of e.kind === 'enum' ? e.options : []) next.push({ ...c, [e.key]: o });
      combos.splice(0, combos.length, ...next);
    }
    for (const c of combos) {
      const name = Object.entries(c).map(([k, v]) => `${k}=${v}`).join(',');
      if (Object.entries(c).every(([k, v]) => d[k] === v)) continue;
      out.push({ recipe, name, params: { ...d, ...c } });
    }
  }
  for (const s of recipe.paramSpecs) {
    if (s.kind !== 'number' || s.unit === 's' || s.unit === 'count') continue;
    for (const w of ['min', 'max'] as const) out.push({ recipe, name: `${s.key}=${w}`, params: { ...d, [s.key]: corner(s, w) } });
  }
  const rng = createRng(seed ^ recipe.id.length);
  for (let i = 0; i < randomCount; i++) {
    const p: ParamRecord = {};
    for (const s of recipe.paramSpecs) {
      if (s.kind === 'enum') p[s.key] = rng.pick(s.options);
      else {
        const raw = rng.range(s.min, s.max);
        p[s.key] = s.unit === 'count' ? Math.round(raw) : Math.round(raw / s.step) * s.step;
        p[s.key] = Math.min(s.max, Math.max(s.min, p[s.key] as number));
      }
    }
    out.push({ recipe, name: `random#${i}`, params: p });
  }
  return out;
}

export function allRecipes(): readonly RecipeDefinition[] {
  return listRecipes();
}
