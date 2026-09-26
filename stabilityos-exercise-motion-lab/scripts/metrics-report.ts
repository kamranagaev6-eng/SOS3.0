/**
 * Geometric metrics report: every recipe × rig variant × parameter configuration, for the
 * analytic (tier 1) and stabilised (tier 2) solvers at 240 Hz, plus the joint-rotation baseline
 * at 60 Hz for the default configuration. Writes evidence/metrics-report.json and
 * evidence/METRICS.md. Geometric checks only — not clinical validation.
 *
 * Usage: node scripts/metrics-report.ts [--quick]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { compileRecipe } from '../src/core/recipes/registry.ts';
import { analyzePlan } from '../src/core/metrics/analyze.ts';
import type { ClipMetrics } from '../src/core/metrics/types.ts';
import { TOLERANCES } from '../src/core/tolerances.ts';
import { allRecipes, paramConfigs, rigVariants } from './sweep.ts';

const quick = process.argv.includes('--quick');
const rigs = quick ? rigVariants().slice(0, 2) : rigVariants();
const rows: {
  recipe: string;
  rig: string;
  config: string;
  compiled: boolean;
  feasible: boolean | null;
  compileErrors: string[];
  analytic?: ClipMetrics;
  stabilized?: ClipMetrics;
  baseline?: ClipMetrics;
}[] = [];

const t0 = performance.now();
for (const recipe of allRecipes()) {
  for (const rv of rigs) {
    for (const cfg of paramConfigs(recipe, quick ? 1 : 4)) {
      const r = compileRecipe(recipe.id, cfg.params, rv.rig);
      const row: (typeof rows)[number] = {
        recipe: recipe.id,
        rig: rv.id,
        config: cfg.name,
        compiled: r.ok,
        feasible: r.ok ? r.feasible : null,
        compileErrors: r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`),
      };
      if (r.ok) {
        row.analytic = analyzePlan(r.plan, rv.rig, 'analytic');
        row.stabilized = analyzePlan(r.plan, rv.rig, 'stabilized');
        if (cfg.name === 'defaults') row.baseline = analyzePlan(r.plan, rv.rig, 'baseline', 60);
      }
      rows.push(row);
      process.stdout.write('.');
    }
  }
}
const seconds = (performance.now() - t0) / 1000;
process.stdout.write('\n');

const compiled = rows.filter((r) => r.compiled);
const feasible = compiled.filter((r) => r.feasible);
const pass = (tier: 'analytic' | 'stabilized') => compiled.filter((r) => r[tier]?.withinTolerance).length;
const max = (tier: 'analytic' | 'stabilized' | 'baseline', key: keyof ClipMetrics, subset = compiled) =>
  Math.max(0, ...subset.map((r) => (r[tier]?.[key] as number | undefined) ?? 0));
const silent = compiled.filter((r) => r.feasible && !r.stabilized?.withinTolerance);

const summary = {
  generatedAt: new Date().toISOString(),
  environment: { node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length },
  tolerances: TOLERANCES,
  rate: TOLERANCES.continuityRate,
  seconds,
  configs: rows.length,
  compiled: compiled.length,
  rejectedWithDiagnostics: rows.length - compiled.length,
  feasible: feasible.length,
  withinTolerance: { analytic: pass('analytic'), stabilized: pass('stabilized') },
  feasibleButOutOfTolerance: silent.map((r) => ({ recipe: r.recipe, rig: r.rig, config: r.config, failures: r.stabilized?.failures })),
};

mkdirSync('evidence', { recursive: true });
writeFileSync('evidence/metrics-report.json', JSON.stringify({ summary, rows }, null, 1));

const mm = (x: number) => (x * 1000).toFixed(3);
const deg = (x: number) => ((x * 180) / Math.PI).toFixed(3);
const lines: string[] = [];
lines.push('# Geometric metrics report');
lines.push('');
lines.push('> Geometric/kinematic checks of synthetic, unreviewed fixtures. Passing them is **not** clinical validation and says nothing about balance, loading, muscle activity or safety.');
lines.push('');
lines.push(`Generated ${summary.generatedAt} by \`node scripts/metrics-report.ts${quick ? ' --quick' : ''}\` in ${seconds.toFixed(1)} s.`);
lines.push(`Environment: Node ${summary.environment.node}, ${summary.environment.platform}, ${summary.environment.cpu} × ${summary.environment.cores}.`);
lines.push(`Sampling: tiers 1 and 2 at ${TOLERANCES.continuityRate} Hz (streamed), baseline at 60 Hz (defaults only).`);
lines.push('');
lines.push('## Summary');
lines.push('');
lines.push('| Configurations | Compiled | Rejected with diagnostics | Feasible (compile scan) | Tier 1 within tolerance | Tier 2 within tolerance | Feasible but out of tolerance |');
lines.push('|---|---|---|---|---|---|---|');
lines.push(`| ${rows.length} | ${compiled.length} | ${rows.length - compiled.length} | ${feasible.length} | ${summary.withinTolerance.analytic} | ${summary.withinTolerance.stabilized} | ${silent.length} |`);
lines.push('');
lines.push('## Worst case per recipe (compiled configurations)');
lines.push('');
lines.push('| Recipe | Tier | Planted disp. (mm) | Contact err (mm) | Orientation (°) | Penetration (mm) | Bone rel. err | Joint vel. jump (rad/s) | Linear vel. jump (m/s) | Max stabilisation (mm) | Limit violations | Unreachable samples |');
lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const recipe of allRecipes()) {
  const sub = compiled.filter((r) => r.recipe === recipe.id);
  for (const tier of ['baseline', 'analytic', 'stabilized'] as const) {
    const s = sub.filter((r) => r[tier]);
    if (!s.length) continue;
    lines.push(
      `| ${recipe.id} | ${tier}${tier === 'baseline' ? ' (defaults)' : ''} | ${mm(max(tier, 'maxPlantedDisplacement', s))} | ${mm(max(tier, 'maxContactPositionError', s))} | ${deg(max(tier, 'maxContactOrientationError', s))} | ${mm(max(tier, 'maxPenetration', s))} | ${max(tier, 'maxBoneLengthRelError', s).toExponential(1)} | ${max(tier, 'maxJointVelocityJump', s).toFixed(3)} | ${max(tier, 'maxLinearVelocityJump', s).toFixed(3)} | ${mm(max(tier, 'maxStabilizationOffset', s))} | ${s.reduce((a, r) => a + (r[tier]?.jointLimitViolations ?? 0), 0)} | ${s.reduce((a, r) => a + (r[tier]?.unreachableSamples ?? 0), 0)} |`,
    );
  }
}
lines.push('');
lines.push('## Tier 1 → tier 2 (does the stabiliser earn its complexity?)');
lines.push('');
lines.push('| Recipe | Configs | Tier 1 in tolerance | Tier 2 in tolerance | Configs where tier 2 needed a correction | Median of max correction (mm) |');
lines.push('|---|---|---|---|---|---|');
for (const recipe of allRecipes()) {
  const sub = compiled.filter((r) => r.recipe === recipe.id);
  const corr = sub.map((r) => r.stabilized?.maxStabilizationOffset ?? 0).filter((x) => x > 1e-9).sort((a, b) => a - b);
  lines.push(
    `| ${recipe.id} | ${sub.length} | ${sub.filter((r) => r.analytic?.withinTolerance).length} | ${sub.filter((r) => r.stabilized?.withinTolerance).length} | ${corr.length} | ${corr.length ? mm(corr[Math.floor(corr.length / 2)]!) : '—'} |`,
  );
}
lines.push('');
lines.push('## Rejected configurations (explicit diagnostics, no motion produced)');
lines.push('');
const rejected = rows.filter((r) => !r.compiled);
if (!rejected.length) lines.push('None.');
else {
  lines.push('| Recipe | Rig | Config | First diagnostic |');
  lines.push('|---|---|---|---|');
  for (const r of rejected) lines.push(`| ${r.recipe} | ${r.rig} | ${r.config} | ${(r.compileErrors[0] ?? '').replace(/\|/g, '/')} |`);
}
lines.push('');
lines.push('## Compiled but infeasible or out of tolerance');
lines.push('');
const bad = compiled.filter((r) => !r.feasible || !r.stabilized?.withinTolerance);
if (!bad.length) lines.push('None.');
else {
  lines.push('| Recipe | Rig | Config | Compile scan feasible | Tier 2 failures |');
  lines.push('|---|---|---|---|---|');
  for (const r of bad) lines.push(`| ${r.recipe} | ${r.rig} | ${r.config} | ${r.feasible} | ${(r.stabilized?.failures ?? []).join('; ')} |`);
}
writeFileSync('evidence/METRICS.md', `${lines.join('\n')}\n`);
console.log(JSON.stringify(summary, null, 1));
