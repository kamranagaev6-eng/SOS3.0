/**
 * glTF export round-trip evidence (`npm run report:roundtrip`).
 *
 * For every recipe x fps {30, 60} on rig A (stabilized tier): bake -> export .glb + manifest ->
 * reimport with GLTFLoader -> compare against the baked clip at the original frame times.
 * Writes evidence/roundtrip-report.json, evidence/ROUNDTRIP.md and, for the 60 fps default clips,
 * evidence/exports/<recipe>.glb + <recipe>.manifest.json.
 *
 * Solver-independent synthetic joint-angle sweeps are exported as a labelled control so the export
 * path is evidenced even when the engine is incomplete. Exit code is non-zero if any recipe row
 * fails, errors or is blocked, or if any control row fails.
 *
 * All content is synthetic and UNREVIEWED; errors here are geometric export fidelity only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REVISION } from 'three';
import { REVIEW_NOTICE, REVIEW_STATUS } from '../src/core/contracts/common.ts';
import { RECIPE_IDS, type RecipeId } from '../src/core/contracts/recipe.ts';
import { bakeClip } from '../src/core/metrics/bake.ts';
import type { BakedClip } from '../src/core/metrics/types.ts';
import { compileRecipe, getRecipe } from '../src/core/recipes/registry.ts';
import { createRigA } from '../src/core/rig/canonical.ts';
import type { SolverTier } from '../src/core/solver/types.ts';
import { TOLERANCES } from '../src/core/tolerances.ts';
import { verifyRoundTrip, type ExportOptions, type CompareOptions } from '../src/export/gltf.ts';
import { createSyntheticClip } from '../src/export/syntheticClip.ts';
import { installFileReaderShim } from '../tests/support/fileReaderShim.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE = path.join(ROOT, 'evidence');
const EXPORTS = path.join(EVIDENCE, 'exports');
const FPS_LIST = [30, 60] as const;
const TIER: SolverTier = 'stabilized';

type Status = 'pass' | 'fail' | 'blocked' | 'error';

interface Row {
  kind: 'recipe' | 'control';
  id: string;
  fps: number;
  tier: string;
  status: Status;
  reason?: string;
  frames?: number;
  duration?: number;
  glbBytes?: number;
  manifestBytes?: number;
  sha256?: string;
  maxPositionError?: number;
  maxRootError?: number;
  maxRotationError?: number;
  maxWorldRotationError?: number;
  maxBoneLengthRelError?: number;
  importedMinConsecutiveDot?: number;
  withinTolerance?: boolean;
  issues?: string[];
  continuity?: { maxStepDeg: number; maxStepAllowedDeg: number; minConsecutiveDot: number; flipsApplied: number };
  midFrame?: { available: boolean; source: string; maxPositionError: number; maxRotationError: number; reason?: string };
  manifestValidationWithinTolerance?: boolean;
  metricsAvailable?: boolean;
  exportMs?: number;
  sampleFiles?: { glb: string; manifest: string };
}

const deg = (r: number) => (r * 180) / Math.PI;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function run(
  clip: BakedClip,
  row: Row,
  opts: ExportOptions & CompareOptions,
  sampleName: string | null,
): Promise<Row> {
  const t0 = performance.now();
  const { report, exported, manifest, manifestJson } = await verifyRoundTrip(clip, opts);
  const exportMs = performance.now() - t0;
  const out: Row = {
    ...row,
    status: report.withinTolerance && exported.continuity.withinTolerance ? 'pass' : 'fail',
    frames: clip.frames.length,
    duration: clip.times[clip.times.length - 1],
    glbBytes: exported.glb.byteLength,
    manifestBytes: Buffer.byteLength(manifestJson),
    sha256: exported.sha256,
    maxPositionError: report.maxPositionError,
    maxRootError: report.maxRootError,
    maxRotationError: report.maxRotationError,
    maxWorldRotationError: report.maxWorldRotationError,
    maxBoneLengthRelError: report.maxBoneLengthRelError,
    importedMinConsecutiveDot: report.importedMinConsecutiveDot,
    withinTolerance: report.withinTolerance,
    issues: report.issues,
    continuity: {
      maxStepDeg: deg(exported.continuity.maxStep),
      maxStepAllowedDeg: deg(exported.continuity.maxStepAllowed),
      minConsecutiveDot: exported.continuity.minConsecutiveDot,
      flipsApplied: exported.continuity.flipsApplied,
    },
    midFrame: {
      available: report.midFrame.available,
      source: report.midFrame.source,
      maxPositionError: report.midFrame.maxPositionError,
      maxRotationError: report.midFrame.maxRotationError,
      ...(report.midFrame.reason ? { reason: report.midFrame.reason } : {}),
    },
    manifestValidationWithinTolerance: manifest.validation.withinTolerance,
    metricsAvailable: !manifest.validation.diagnostics.some((d) => /metrics were not computed/.test(d.message)),
    exportMs,
  };
  if (sampleName) {
    mkdirSync(EXPORTS, { recursive: true });
    const glbPath = path.join(EXPORTS, `${sampleName}.glb`);
    const manPath = path.join(EXPORTS, `${sampleName}.manifest.json`);
    if (manifest.files.animation !== `${sampleName}.glb`) throw new Error(`manifest names ${manifest.files.animation}`);
    // The manifest names the file it sits next to; its sha256 is of these exact bytes.
    writeFileSync(glbPath, new Uint8Array(exported.glb));
    writeFileSync(manPath, manifestJson);
    out.sampleFiles = { glb: path.relative(ROOT, glbPath), manifest: path.relative(ROOT, manPath) };
  }
  return out;
}

async function recipeRow(id: RecipeId, fps: number): Promise<Row> {
  const base: Row = { kind: 'recipe', id, fps, tier: TIER, status: 'error' };
  const recipe = getRecipe(id);
  if (!recipe) return { ...base, status: 'blocked', reason: `recipe '${id}' is not registered yet` };
  const rig = createRigA();
  let clip: BakedClip;
  try {
    const compiled = compileRecipe(id, recipe.defaults(), rig);
    if (!compiled.ok) {
      return { ...base, status: 'fail', reason: `compile failed: ${compiled.diagnostics.map((d) => `${d.code}: ${d.message}`).join('; ')}` };
    }
    clip = bakeClip(compiled.plan, rig, fps, TIER);
  } catch (e) {
    const msg = errMsg(e);
    return { ...base, status: /not implemented/i.test(msg) ? 'blocked' : 'error', reason: msg };
  }
  try {
    const sample = fps === 60 ? id : null;
    return await run(clip, base, sample ? { fileBaseName: sample } : {}, sample);
  } catch (e) {
    const msg = errMsg(e);
    return { ...base, status: /not implemented/i.test(msg) ? 'blocked' : 'error', reason: msg };
  }
}

async function controlRow(seed: number, fps: number, headingWrap: boolean): Promise<Row> {
  const s = createSyntheticClip(createRigA(), { seed, fps, duration: 2, headingWrap });
  const base: Row = { kind: 'control', id: `synthetic seed ${seed}${headingWrap ? ' (heading wraps 180 deg)' : ''}`, fps, tier: 'n/a (angles generated directly)', status: 'error' };
  try {
    return await run(
      s.clip,
      base,
      { recipe: s.recipe, recipeDoc: s.recipeDoc, metrics: null, contactSchedule: s.contactSchedule, sampler: s.sample },
      null,
    );
  } catch (e) {
    return { ...base, reason: errMsg(e) };
  }
}

const fmt = (v: number | undefined, digits = 3) => (v === undefined ? '—' : v === 0 ? '0' : v.toExponential(digits - 1));
const kb = (b: number | undefined) => (b === undefined ? '—' : `${(b / 1024).toFixed(1)} KB`);

function markdown(report: { generatedAt: string; environment: Record<string, unknown>; rows: Row[]; summary: Record<string, number> }): string {
  const T = TOLERANCES;
  const lines: string[] = [];
  lines.push('# glTF export round-trip report', '');
  lines.push(`> ${REVIEW_NOTICE}`, '');
  lines.push(
    'Each row: bake (rig A) → GLTFExporter `.glb` (binary, trs, LINEAR tracks) + manifest → GLTFLoader reimport → every imported track',
    'evaluated with its own interpolant at exactly the original frame times → world joint positions, local rotations and bone lengths',
    'compared with the baked clip. Tolerances were fixed before evaluation (docs/PLAN.md) and are geometric only.',
    '',
  );
  lines.push(`Generated ${report.generatedAt}. Environment: ${Object.entries(report.environment).map(([k, v]) => `${k} \`${String(v)}\``).join(', ')}.`, '');
  lines.push(
    `Summary: ${Object.entries(report.summary)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}.`,
    '',
  );
  lines.push('## Recipes (stabilized tier, default parameters)', '');
  lines.push(
    `| Recipe | fps | Status | Frames | Max joint pos err (≤ ${T.exportPosition} m) | Max root err (m) | Max local rot err (≤ ${T.exportRotation} rad) | Max bone-length rel err (≤ ${T.boneLengthRelExported}) | Max key step (deg / allowed) | .glb size | SHA-256 |`,
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of report.rows.filter((x) => x.kind === 'recipe')) {
    if (r.status === 'blocked' || r.status === 'error' || r.frames === undefined) {
      lines.push(`| ${r.id} | ${r.fps} | **${r.status.toUpperCase()}** | — | — | — | — | — | — | — | ${(r.reason ?? '').replace(/\|/g, '\\|').slice(0, 160)} |`);
      continue;
    }
    lines.push(
      `| ${r.id} | ${r.fps} | ${r.status === 'pass' ? 'pass' : '**FAIL**'} | ${r.frames} | ${fmt(r.maxPositionError)} | ${fmt(r.maxRootError)} | ${fmt(r.maxRotationError)} | ${fmt(r.maxBoneLengthRelError)} | ${r.continuity!.maxStepDeg.toFixed(2)} / ${r.continuity!.maxStepAllowedDeg.toFixed(0)} | ${kb(r.glbBytes)} | \`${r.sha256!.slice(0, 16)}…\` |`,
    );
  }
  lines.push('', '## Control: synthetic joint-angle sweeps (solver-independent export self-test)', '');
  lines.push('Seeded smooth angles inside the synthetic joint limits for every DOF, moving root and pelvis; no contacts, not an exercise.', '');
  lines.push('| Clip | fps | Status | Frames | Max joint pos err (m) | Max local rot err (rad) | Max bone-length rel err | Hemisphere flips applied | .glb size |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of report.rows.filter((x) => x.kind === 'control')) {
    if (r.frames === undefined) {
      lines.push(`| ${r.id} | ${r.fps} | **${r.status.toUpperCase()}** | — | — | — | — | — | ${r.reason ?? ''} |`);
      continue;
    }
    lines.push(
      `| ${r.id} | ${r.fps} | ${r.status === 'pass' ? 'pass' : '**FAIL**'} | ${r.frames} | ${fmt(r.maxPositionError)} | ${fmt(r.maxRotationError)} | ${fmt(r.maxBoneLengthRelError)} | ${r.continuity!.flipsApplied} | ${kb(r.glbBytes)} |`,
    );
  }
  lines.push('', '## Mid-frame resampling (informational, NOT a pass criterion)', '');
  lines.push(
    'Imported tracks evaluated halfway between baked frames (LINEAR / slerp) vs a fresh sample at the same time. This measures bake',
    'resolution, not export fidelity.',
    '',
  );
  lines.push('| Clip | fps | Source | Max joint pos diff (m) | Max local rot diff (rad) |');
  lines.push('|---|---|---|---|---|');
  for (const r of report.rows) {
    if (!r.midFrame) continue;
    lines.push(
      `| ${r.id} | ${r.fps} | ${r.midFrame.available ? r.midFrame.source : `unavailable (${(r.midFrame.reason ?? '').slice(0, 80)})`} | ${r.midFrame.available ? fmt(r.midFrame.maxPositionError) : '—'} | ${r.midFrame.available ? fmt(r.midFrame.maxRotationError) : '—'} |`,
    );
  }
  const samples = report.rows.filter((r) => r.sampleFiles);
  lines.push('', '## Sample outputs', '');
  if (samples.length === 0) lines.push('None written (no recipe clip could be exported).');
  for (const r of samples) {
    lines.push(`- \`${r.sampleFiles!.glb}\` (${kb(r.glbBytes)}, sha256 \`${r.sha256}\`) + \`${r.sampleFiles!.manifest}\``);
  }
  lines.push(
    '',
    '## Notes',
    '',
    '- Axes: engine and glTF share +Y up, +Z forward, metres, [x,y,z,w] quaternions; no conversion is applied.',
    '- Keyframe times and values are stored as float32 (glTF accessors); node rest offsets are JSON numbers.',
    '- Rotation error is the geodesic angle 2·atan2(|v|,|w|) of q_import⁻¹·q_baked (robust near zero, independent of float32 norm drift).',
    '- The manifest records `validation.kind = "geometric-only"`; passing these checks is not clinical validation.',
    '',
  );
  return lines.join('\n');
}

async function main(): Promise<number> {
  installFileReaderShim();
  const rows: Row[] = [];
  for (const id of RECIPE_IDS) for (const fps of FPS_LIST) rows.push(await recipeRow(id, fps));
  for (const [seed, fps, wrap] of [
    [1, 30, false],
    [2, 60, true],
    [3, 24, true],
  ] as const) {
    rows.push(await controlRow(seed, fps, wrap));
  }

  const count = (kind: Row['kind'], s: Status) => rows.filter((r) => r.kind === kind && r.status === s).length;
  const summary = {
    recipePass: count('recipe', 'pass'),
    recipeFail: count('recipe', 'fail'),
    recipeBlocked: count('recipe', 'blocked'),
    recipeError: count('recipe', 'error'),
    controlPass: count('control', 'pass'),
    controlFail: count('control', 'fail') + count('control', 'error'),
  };
  const report = {
    generatedAt: new Date().toISOString(),
    reviewStatus: REVIEW_STATUS,
    reviewNotice: REVIEW_NOTICE,
    environment: {
      node: process.version,
      platform: `${process.platform} ${os.release()}`,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      three: `r${REVISION}`,
      fileReader: 'tests/support/fileReaderShim.ts (Node only)',
    },
    tolerances: {
      exportPosition: TOLERANCES.exportPosition,
      exportRotation: TOLERANCES.exportRotation,
      boneLengthRelExported: TOLERANCES.boneLengthRelExported,
      quatStepMax60fps: TOLERANCES.quatStepMax60fps,
    },
    summary,
    rows,
  };
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(path.join(EVIDENCE, 'roundtrip-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(EVIDENCE, 'ROUNDTRIP.md'), markdown(report));

  console.log('glTF export round trip (rig A) — synthetic, UNREVIEWED; geometric export fidelity only');
  for (const r of rows) {
    const head = `${r.status.toUpperCase().padEnd(7)} ${r.kind.padEnd(7)} ${r.id.padEnd(40)} ${String(r.fps).padStart(2)} fps`;
    if (r.frames === undefined) console.log(`${head}  ${r.reason ?? ''}`);
    else {
      console.log(
        `${head}  frames ${String(r.frames).padStart(4)}  pos ${fmt(r.maxPositionError)} m  rot ${fmt(r.maxRotationError)} rad  bone ${fmt(r.maxBoneLengthRelError)}  ${kb(r.glbBytes)}`,
      );
    }
  }
  console.log(`summary: ${JSON.stringify(summary)}`);
  console.log(`wrote ${path.relative(ROOT, path.join(EVIDENCE, 'roundtrip-report.json'))}, ${path.relative(ROOT, path.join(EVIDENCE, 'ROUNDTRIP.md'))}`);
  const ok = summary.recipePass === RECIPE_IDS.length * FPS_LIST.length && summary.controlFail === 0;
  if (!ok) console.error('ROUND TRIP REPORT: FAILURES OR BLOCKED ROWS (see above)');
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(2);
  },
);
