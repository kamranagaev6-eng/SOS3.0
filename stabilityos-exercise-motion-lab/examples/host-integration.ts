/**
 * End-to-end host integration example — the path a host application (e.g. StabilityOS) would follow.
 * Synthetic and unreviewed: the "host record" below is a made-up fixture, not an approved exercise.
 *
 *   node examples/host-integration.ts
 *
 * 1. Describe the host skeleton in ITS OWN conventions (here synthetic rig B: cm, Z-up, T-pose arms,
 *    extra unmapped spine bone) plus an explicit bone map.
 * 2. Adapt it: capability checks, and a canonical rig carrying the host's own proportions.
 * 3. Compile the exercise the host names by EXPLICIT recipe id, with parameters from the host record.
 * 4. Per frame: samplePose → adapter.toHostPose → host bone local transforms (host units and axes).
 * 5. Verify THROUGH THE HOST SKELETON (host FK, not the engine's FK): planted sites stay planted, host
 *    bones are not stretched, nothing the motion needs is dropped.
 * 6. A host rig lacking the required articulation (legacy rig C) is rejected with actionable
 *    diagnostics — there is no silent fallback.
 */
import { pathToFileURL } from 'node:url';
import { REVIEW_NOTICE } from '../src/core/contracts/common.ts';
import type { Diagnostic } from '../src/core/contracts/diagnostics.ts';
import type { ParamRecord } from '../src/core/contracts/recipe.ts';
import {
  capabilityRequirements,
  compileRecipe,
  createHostRigAdapter,
  getRecipe,
  getSyntheticHostRig,
  listRecipes,
  samplePose,
  TOLERANCES,
} from '../src/core/engine.ts';
import { distance, type Vec3 } from '../src/core/math/vec3.ts';

export interface HostIntegrationReport {
  recipeId: string;
  host: { id: string; units: string; up: string; forward: string; motionBone: string | null };
  frames: number;
  /** Max displacement of an actively planted site, measured through the host skeleton (m). */
  maxPlantedDisplacementViaHost: number;
  /** Max distance between host-located sites and the engine's sites (m). */
  maxHostVsEngineSiteError: number;
  /** Host bones whose local translation differs from rest (only the motion bone may). */
  stretchedBones: string[];
  /** Largest motion the host could not represent (should be ~0 for a capable rig). */
  maxUnrepresented: number;
  legacyRigDiagnostics: Diagnostic[];
  ok: boolean;
}

export function runHostIntegrationExample(fps = 30): HostIntegrationReport {
  // The host supplies identity + parameters; the engine never infers the exercise.
  const hostRecord: { recipeId: string; demoParams: ParamRecord } = {
    recipeId: 'step-up-down.v1',
    demoParams: { ...getRecipe('step-up-down.v1')!.defaults(), upLeadSide: 'right', downLeadSide: 'right' },
  };
  const recipe = getRecipe(hostRecord.recipeId);
  if (!recipe) throw new Error(`unknown recipe id ${hostRecord.recipeId}`);
  const requiredBy = capabilityRequirements(listRecipes()).requiredBy;

  const b = getSyntheticHostRig('synthetic-rig-b-host');
  if (!b) throw new Error('synthetic rig B missing');
  const adapted = createHostRigAdapter(b.host, b.boneMap, recipe.requiredCapabilities, { requiredBy });
  if (!adapted.ok) throw new Error(`rig B rejected: ${adapted.diagnostics.map((d) => d.message).join('; ')}`);
  const adapter = adapted.adapter;

  // Solve on the canonical rig DERIVED from the host (its own proportions), never on another body.
  const compiled = compileRecipe(recipe.id, hostRecord.demoParams, adapter.canonical);
  if (!compiled.ok || !compiled.feasible)
    throw new Error(`compile failed: ${compiled.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('; ')}`);
  const plan = compiled.plan;

  const rest = new Map(b.host.bones.map((x) => [x.name, x.restTranslation] as const));
  const stretched = new Set<string>();
  const onset = new Map<string, Vec3>();
  let planted = 0;
  let siteError = 0;
  let unrepresented = 0;
  let frames = 0;
  for (let k = 0; k * (1 / fps) <= plan.duration + 1e-9; k++) {
    const t = Math.min(plan.duration, k / fps);
    const sample = samplePose(plan, adapter.canonical, t);
    const hostPose = adapter.toHostPose(sample); // ← what the host applies to its skeleton
    frames++;
    for (const bone of hostPose.bones) {
      if (bone.name === adapter.motionBone) continue;
      const r = rest.get(bone.name)!;
      if (Math.hypot(bone.translation[0] - r[0], bone.translation[1] - r[1], bone.translation[2] - r[2]) > 1e-9) stretched.add(bone.name);
    }
    const hostSites = new Map(adapter.hostSitePositions(hostPose).map((s) => [s.name, s.position] as const));
    for (const c of sample.contacts) {
      if (c.interval.kind !== 'position' || !c.actual) continue;
      const viaHost = hostSites.get(c.interval.site);
      if (!viaHost) continue;
      siteError = Math.max(siteError, distance(viaHost, c.actual));
      if (c.state !== 'active') {
        onset.delete(c.interval.id);
        continue;
      }
      const first = onset.get(c.interval.id);
      if (!first) onset.set(c.interval.id, viaHost);
      else planted = Math.max(planted, distance(first, viaHost));
    }
    for (const u of adapter.unrepresentedMotion(sample)) unrepresented = Math.max(unrepresented, u.magnitude);
  }

  // A legacy limb-only rig must be refused with actionable reasons, not quietly degraded.
  const legacy = getSyntheticHostRig('legacy-limb-rig-c');
  const legacyResult = legacy ? createHostRigAdapter(legacy.host, legacy.boneMap, recipe.requiredCapabilities, { requiredBy }) : null;
  const legacyRigDiagnostics = legacyResult && !legacyResult.ok ? legacyResult.diagnostics.filter((d) => d.severity === 'error') : [];

  const ok =
    planted <= TOLERANCES.plantedDisplacement &&
    siteError <= 1e-6 &&
    stretched.size === 0 &&
    unrepresented <= 1e-9 &&
    legacyResult !== null &&
    !legacyResult.ok;
  return {
    recipeId: recipe.id,
    host: { id: b.host.id, units: b.host.units, up: b.host.up, forward: b.host.forward, motionBone: adapter.motionBone },
    frames,
    maxPlantedDisplacementViaHost: planted,
    maxHostVsEngineSiteError: siteError,
    stretchedBones: [...stretched],
    maxUnrepresented: unrepresented,
    legacyRigDiagnostics,
    ok,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = runHostIntegrationExample();
  console.log(REVIEW_NOTICE, '\n');
  console.log(`recipe ${r.recipeId} on host '${r.host.id}' (${r.host.units}, up ${r.host.up}, forward ${r.host.forward}); root motion on '${r.host.motionBone}'`);
  console.log(`frames checked: ${r.frames}`);
  console.log(`max planted-site displacement measured through the host skeleton: ${(r.maxPlantedDisplacementViaHost * 1000).toFixed(4)} mm (tolerance ${TOLERANCES.plantedDisplacement * 1000} mm)`);
  console.log(`max host-located vs engine site difference: ${r.maxHostVsEngineSiteError.toExponential(2)} m`);
  console.log(`host bones stretched: ${r.stretchedBones.length ? r.stretchedBones.join(', ') : 'none'}; unrepresented motion: ${r.maxUnrepresented.toExponential(2)}`);
  console.log(`legacy rig C refused with ${r.legacyRigDiagnostics.length} actionable error(s):`);
  for (const d of r.legacyRigDiagnostics) console.log(`  - ${d.code}: ${d.message}${d.hint ? `\n    hint: ${d.hint}` : ''}`);
  console.log(r.ok ? '\nOK' : '\nFAILED');
  process.exit(r.ok ? 0 : 1);
}
