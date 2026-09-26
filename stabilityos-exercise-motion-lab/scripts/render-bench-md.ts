/** Renders evidence/render-bench.json (written by `npm run bench:render`) as evidence/RENDER_BENCH.md. */
import { readFileSync, writeFileSync } from 'node:fs';

interface Dist { n: number; min: number; p50: number; p95: number; p99: number; max: number; mean: number }
const d = JSON.parse(readFileSync('evidence/render-bench.json', 'utf8')) as {
  generatedAt: string;
  statement: string;
  environment: { browser: string; webglRenderer: string; hardwareConcurrency: number; viewport: { width: number; height: number }; host: { cpus: string } };
  method: Record<string, string | number>;
  results: { recipeId: string; mode: string; frames: number; drawCallsPerFrame: number; trianglesPerFrame: number; ms: Record<string, Dist> }[];
};
const f = (x: number) => x.toFixed(1);
const row = (s: Dist) => `${f(s.p50)} / ${f(s.p95)} / ${f(s.p99)} / ${f(s.max)}`;
const lines = [
  '# Render benchmark (browser)',
  '',
  `> ${d.statement}`,
  '',
  `Generated ${d.generatedAt} by \`npm run bench:render\` (Playwright, project \`bench\`). Browser: ${d.environment.browser}; WebGL renderer: ${d.environment.webglRenderer}; host CPU: ${d.environment.host.cpus}, ${d.environment.hardwareConcurrency} threads; viewport ${d.environment.viewport.width}×${d.environment.viewport.height}.`,
  '',
  `Method: ${Object.entries(d.method).map(([k, v]) => `${k}: ${v}`).join('; ')}.`,
  '',
  'Values in milliseconds as p50 / p95 / p99 / max over the measured frames. Engine sampling and rendering are timed separately.',
  '',
  '| Recipe | Mode | Frames | Draw calls | Triangles | Engine sampling | Stage update | renderer.render CPU | render + gl.finish | Whole frame work | rAF interval |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...d.results.map(
    (r) =>
      `| ${r.recipeId} | ${r.mode} | ${r.frames} | ${r.drawCallsPerFrame} | ${r.trianglesPerFrame} | ${row(r.ms.engineSampling!)} | ${row(r.ms.stageUpdate!)} | ${row(r.ms.renderCpu!)} | ${row(r.ms.renderPlusGlFinish!)} | ${row(r.ms.wholeFrame!)} | ${row(r.ms.rafInterval!)} |`,
  ),
  '',
  'Reading: per-frame engine work (sampling, twice in comparison mode) is ~0.1–0.3 ms at p50; CPU-side render submission is sub-millisecond at p50. The rAF interval (≈33–50 ms) is dominated by the software rasteriser in the GPU process, which this container substitutes for a GPU; it says nothing about client devices.',
];
writeFileSync('evidence/RENDER_BENCH.md', `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
