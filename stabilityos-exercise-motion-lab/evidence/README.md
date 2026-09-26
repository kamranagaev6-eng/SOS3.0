# Evidence index

Everything in this folder is **generated** by a command in this repository from the synthetic,
unreviewed fixtures. It is geometric / engineering evidence only — not clinical validation. Each
file records its own generation time and environment; regenerate rather than edit.

| File | What it shows | Regenerate with |
|---|---|---|
| `METRICS.md`, `metrics-report.json` | Sweep of every recipe × 8 rig variants × parameter configurations at 240 Hz: compile outcome, feasibility, tier 1 vs tier 2 vs baseline metrics against the fixed tolerances | `npm run report:metrics` |
| `ROUNDTRIP.md`, `roundtrip-report.json` | glTF export → reimport → pose comparison for all recipes at 30/60 fps, plus synthetic control clips | `npm run report:roundtrip` |
| `exports/*.glb`, `exports/*.manifest.json` | Sample baked animations (stabilised tier, 60 fps) and their semantic manifests (recipe document, phases, contact schedule, assumptions, unsupported features, `unreviewed-synthetic` status, SHA-256 of the `.glb`) | `npm run report:roundtrip` |
| `SOLVER_BENCH.md`, `solver-bench.json` | Solver cost distributions (Node): per-sample cost by tier, compile, bake and streamed analysis, with the execution environment | `npm run bench:solver` |
| `solver-bench.before-optimisation.json` | Solver numbers before the Δ = 0 leg-solution reuse (output verified bitwise-identical), kept for comparison | historical |
| `RENDER_BENCH.md`, `render-bench.json` | In-browser engine sampling vs render cost per frame, normal and comparison modes (software WebGL — not representative of client GPUs) | `npm run bench:render` then `node scripts/render-bench-md.ts` |
| `vitest-results.json` | Per-test results of the Node test suites (unit, property, integration, validation) | `npx vitest run --reporter=json --outputFile=evidence/vitest-results.json` |
| `e2e-results.json` | Playwright workbench test results | `npm run test:e2e` |
| `screenshots/*.png` | Real captures of the workbench taken by the Playwright suite (never edited) | `npm run test:e2e` |
| `playwright-output/` | Traces/artefacts of failed Playwright runs (git-ignored) | — |

How to read the numbers, what was and was not executed, and the tolerances: `../docs/VALIDATION.md`
and `../docs/PLAN.md`.
