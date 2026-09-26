# stabilityos-exercise-motion-lab

Exercise-motion authoring and playback engine with **explicit contact constraints**, a browser
workbench that exercises the real engine, and numerical verification. Built as a standalone project
for later, selective adaptation into StabilityOS.

> **Synthetic, unreviewed engineering fixtures.** Nothing here is a prescription, a dose, a patient
> instruction, a patient-specific safe range, or clinical validation. Geometric checks passing does
> not establish balance, tissue loading, muscle activation, safety or clinical correctness. Exercise
> identity, approved instructions, dose, side and review authority stay with the host application.

## What it does

* Four complete reference recipes, selected by explicit id:
  `sit-to-stand.v1` (chair contact → standing → chair), `bilateral-squat.v1` (both feet planted),
  `step-up-down.v1` (explicit up/down leading sides, heel-off/toe-off, toe-first landing),
  `bilateral-heel-raise.v1` (forefoot contact preserved while heels and body rise).
* A versioned motion format (`smx.motion-plan/1`) with independent left/right limbs, pelvis/root
  trajectories, environment geometry, contact schedule and cue timing; runtime-validated with zod.
* A solver with a transparent baseline and measured complexity: joint-rotation baseline (the current
  host behaviour, for comparison) → closed-form analytic tier → bounded pelvis stabiliser.
  Every residual, clamp and correction is reported; nothing is stretched or silently corrected.
* A rig adapter (bone map, rest transforms, units/axes, capability checks) demonstrated on a second
  synthetic rig in cm / Z-up / T-pose with different proportions, and on a legacy limb-only rig that
  is rejected with actionable diagnostics.
* glTF (.glb) export of baked animation + semantic manifest, reimport and pose comparison.

## Setup

Requires **Node 24** (see `.nvmrc`; `engines` pins `>=24 <25`).

```bash
npm ci                    # installs the exact versions in package-lock.json
npm run dev               # workbench at http://localhost:5173
npm run build             # typecheck + production build (dist/)
```

## Verification commands

| Command | What it runs | Output |
|---|---|---|
| `npm run typecheck` | strict TypeScript over src, tests, scripts | — |
| `npm test` | Vitest: unit, property (seeded), integration and validation suites | console |
| `npm run report:metrics` | recipes × rig variants × parameter configs × tiers at 240 Hz | `evidence/METRICS.md`, `evidence/metrics-report.json` |
| `npm run report:roundtrip` | glTF export → reimport → pose comparison, all recipes | `evidence/ROUNDTRIP.md`, `evidence/exports/*` |
| `npm run bench:solver` | solver cost distributions (Node) | `evidence/SOLVER_BENCH.md` |
| `npm run test:e2e` | Playwright workbench tests (builds + serves `dist/`) | `evidence/e2e-results.json`, `evidence/screenshots/` |
| `npm run bench:render` | in-browser render vs sampling cost (Playwright) | `evidence/render-bench.json` |
| `node scripts/recipes-doc.ts` | regenerates `docs/RECIPES.md` from the registry | `docs/RECIPES.md` |

Playwright uses the Chromium at `PLAYWRIGHT_BROWSERS_PATH` (1.56.1 ↔ Chromium 141); do not run
`playwright install` in the provided container.

## Documentation

* `docs/PLAN.md` — architecture and acceptance plan, tolerances fixed before evaluation
* `docs/ARCHITECTURE.md` — layers, contracts, numerical methods, determinism, limitations
* `docs/EXTRACTION_GUIDE.md` — reusable parts, minimum host rig capabilities, evidence levels
* `docs/RECIPES.md` — generated recipe reference (setup, phases, contacts, parameters, unsupported)
* `docs/VALIDATION.md` — what was executed and what passed, with numbers
* `docs/PROGRESS.md` — milestone record

## Layout

```
src/core/      pure TS engine (contracts, math, rig, environment, plan, solver, recipes, metrics, io, adapter)
src/render/    Three.js adapter        src/player/  playback clock        src/app/  React workbench
src/export/    glTF export/reimport    tests/       unit, property, integration, validation
e2e/           Playwright              scripts/, bench/  reports and benchmarks      evidence/  generated evidence
```

All assets (humanoid, chair, step) are procedurally generated original geometry.
