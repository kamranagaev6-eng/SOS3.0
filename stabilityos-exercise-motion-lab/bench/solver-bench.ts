/**
 * Solver benchmark (Node, no rendering). Measures, per recipe on rig A with default parameters:
 *   - compile time (recipe → validated plan, incl. the 30 Hz feasibility scan)
 *   - samplePose cost per call for each tier, sampled at shuffled times (seek-like access)
 *   - stabiliser iteration distribution
 *   - bake (60 fps) and streamed 240 Hz analysis wall time, and heap growth of each
 * Writes evidence/solver-bench.json and evidence/SOLVER_BENCH.md with the real environment.
 *
 * Usage: node --expose-gc bench/solver-bench.ts [--quick]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem } from 'node:os';
import { createRigA } from '../src/core/rig/canonical.ts';
import { compileRecipe, listRecipes } from '../src/core/recipes/registry.ts';
import { samplePose } from '../src/core/solver/sample.ts';
import type { SolverTier } from '../src/core/solver/types.ts';
import { bakeClip } from '../src/core/metrics/bake.ts';
import { analyzePlan } from '../src/core/metrics/analyze.ts';
import { createRng } from '../src/core/math/rng.ts';

const quick = process.argv.includes('--quick');
const gc = (globalThis as { gc?: () => void }).gc;

function stats(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0]!, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: s.at(-1)!, mean };
}

const rig = createRigA();
const results: Record<string, unknown>[] = [];
for (const recipe of listRecipes()) {
  const compileMs: number[] = [];
  let plan = null;
  for (let i = 0; i < (quick ? 3 : 15); i++) {
    const t0 = performance.now();
    const r = compileRecipe(recipe.id, recipe.defaults(), rig);
    compileMs.push(performance.now() - t0);
    if (!r.ok) throw new Error(`${recipe.id} failed to compile`);
    plan = r.plan;
  }
  if (!plan) throw new Error('no plan');
  const rng = createRng(42);
  const N = quick ? 400 : 3000;
  const times = Array.from({ length: N }, () => rng.range(0, plan.duration));
  const perTier: Record<string, unknown> = {};
  for (const tier of ['analytic', 'stabilized', 'baseline'] as SolverTier[]) {
    for (let i = 0; i < 200; i++) samplePose(plan, rig, times[i % N]!, tier); // warm-up (JIT)
    const us: number[] = [];
    const iters: number[] = [];
    for (const t of times) {
      const t0 = performance.now();
      const s = samplePose(plan, rig, t, tier);
      us.push((performance.now() - t0) * 1000);
      iters.push(s.stabilization.iterations);
    }
    perTier[tier] = {
      microsecondsPerSample: stats(us),
      stabilizerIterations: stats(iters),
      samplesWithIterations: iters.filter((x) => x > 0).length,
    };
  }
  gc?.();
  const h0 = process.memoryUsage().heapUsed;
  let t0 = performance.now();
  const clip = bakeClip(plan, rig, 60, 'stabilized');
  const bakeMs = performance.now() - t0;
  const bakeHeapMB = (process.memoryUsage().heapUsed - h0) / 1e6;
  void clip.frames.length;
  gc?.();
  const h1 = process.memoryUsage().heapUsed;
  t0 = performance.now();
  const m = analyzePlan(plan, rig, 'stabilized');
  const analyzeMs = performance.now() - t0;
  const analyzeHeapMB = (process.memoryUsage().heapUsed - h1) / 1e6;
  results.push({
    recipe: recipe.id,
    duration: plan.duration,
    compileMs: stats(compileMs),
    perTier,
    bake60fps: { frames: clip.frames.length, ms: bakeMs, heapGrowthMB: bakeHeapMB },
    analyze240Hz: { samples: m.samples, ms: analyzeMs, heapGrowthMBAfterReturn: analyzeHeapMB, withinTolerance: m.withinTolerance },
  });
  process.stdout.write('.');
}
process.stdout.write('\n');

const env = {
  node: process.version,
  v8: process.versions.v8,
  platform: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model ?? 'unknown',
  logicalCores: cpus().length,
  totalMemGB: +(totalmem() / 1e9).toFixed(1),
  gcExposed: Boolean(gc),
  note: 'Shared cloud container; single-threaded measurements; timings include JIT warm-up of 200 calls per tier.',
};
mkdirSync('evidence', { recursive: true });
writeFileSync('evidence/solver-bench.json', JSON.stringify({ generatedAt: new Date().toISOString(), env, results }, null, 1));

const f = (x: number) => x.toFixed(1);
const lines = [
  '# Solver benchmark',
  '',
  `Generated ${new Date().toISOString()} by \`node --expose-gc bench/solver-bench.ts${quick ? ' --quick' : ''}\`.`,
  '',
  `Environment: Node ${env.node} (V8 ${env.v8}), ${env.platform}, ${env.cpu}, ${env.logicalCores} logical cores, ${env.totalMemGB} GB RAM. ${env.note}`,
  '',
  '## samplePose cost per call (µs), shuffled times (seek-like access)',
  '',
  '| Recipe | Tier | n | min | p50 | p95 | p99 | max | mean | samples needing stabiliser iterations | max iterations |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
];
for (const r of results) {
  for (const [tier, v] of Object.entries(r.perTier as Record<string, { microsecondsPerSample: ReturnType<typeof stats>; stabilizerIterations: ReturnType<typeof stats>; samplesWithIterations: number }>)) {
    const s = v.microsecondsPerSample;
    lines.push(`| ${r.recipe} | ${tier} | ${s.n} | ${f(s.min)} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.p99)} | ${f(s.max)} | ${f(s.mean)} | ${v.samplesWithIterations} | ${v.stabilizerIterations.max} |`);
  }
}
lines.push('', '## Compile, bake and analysis', '', '| Recipe | Clip (s) | Compile p50 (ms) | Compile max (ms) | Bake 60 fps (frames / ms / heap MB) | Analyse 240 Hz streamed (samples / ms / heap MB after) |', '|---|---|---|---|---|---|');
for (const r of results) {
  const c = r.compileMs as ReturnType<typeof stats>;
  const b = r.bake60fps as { frames: number; ms: number; heapGrowthMB: number };
  const a = r.analyze240Hz as { samples: number; ms: number; heapGrowthMBAfterReturn: number };
  lines.push(`| ${r.recipe} | ${(r.duration as number).toFixed(1)} | ${f(c.p50)} | ${f(c.max)} | ${b.frames} / ${f(b.ms)} / ${b.heapGrowthMB.toFixed(1)} | ${a.samples} / ${f(a.ms)} / ${a.heapGrowthMBAfterReturn.toFixed(1)} |`);
}
lines.push('', 'Rendering cost is measured separately in the browser (see RENDER_BENCH / evidence/render-bench.json).');
writeFileSync('evidence/SOLVER_BENCH.md', `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
