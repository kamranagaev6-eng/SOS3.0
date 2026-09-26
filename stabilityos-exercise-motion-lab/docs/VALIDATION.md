# Validation: what was executed and what passed

> These are **geometric / kinematic engineering checks of synthetic, unreviewed fixtures**. They are
> not clinical validation and say nothing about balance, tissue loading, muscle activation, safety or
> clinical correctness. Tolerances were fixed before evaluation (`docs/PLAN.md`,
> `src/core/tolerances.ts`) and were not loosened.

Environment for all runs below: Node 24.21.0 (V8 13.6), Linux 6.18 container, Intel Xeon @ 2.10 GHz ×
4 logical cores, 16.9 GB RAM; Chromium 141.0.7390.37 (Playwright 1.56.1) with SwiftShader software
WebGL. Final runs on 2026-09-26 on an otherwise idle machine after all parallel agents had finished.

## 1. Results at a glance

| Check | Command | Result |
|---|---|---|
| Strict typecheck | `npm run typecheck` | clean |
| Unit + property + integration + validation tests | `npm test` | **29 files, 1 168 passed**, 1 skipped (export suite's "engine not ready" placeholder, inactive by design) |
| Browser workbench tests | `npm run test:e2e` | **19 / 19 passed** on a fresh production build (1.7 min) |
| Recipe × rig × parameter sweep, 240 Hz | `npm run report:metrics` | **488 configurations**: 469 compiled, 19 rejected with explicit diagnostics; tier 2 within every tolerance for **469 / 469**; **0 feasible-but-out-of-tolerance** |
| glTF export → reimport | `npm run report:roundtrip` | **8 / 8** recipe clips (4 recipes × 30/60 fps) + 3 / 3 controls within tolerance |
| Solver benchmark | `npm run bench:solver` | `evidence/SOLVER_BENCH.md` |
| Render benchmark (browser) | `npm run bench:render` | `evidence/RENDER_BENCH.md` (software-rendered) |

## 2. Numerical sweep (`evidence/METRICS.md`)

Rigs: canonical rig A; legs ×0.9 and ×1.1; trunk ×1.12; feet ×1.15; uniform ×0.88; left leg +10 mm;
and **rig B derived by the rig adapter** from a cm / Z-up / T-pose host skeleton with different
proportions. Parameters: defaults, every leading-side combination, every single-parameter min/max
corner, and seeded random sets. Tiers 1 and 2 at 240 Hz (streamed, with two-rate continuity
refinement); baseline at 60 Hz on defaults.

| Recipe | Compiled configs | Tier 1 within tolerance | Tier 2 within tolerance |
|---|---|---|---|
| sit-to-stand.v1 | 120 | 120 | 120 |
| bilateral-squat.v1 | 128 | 128 | 128 |
| step-up-down.v1 | 133 | 14 | 133 |
| bilateral-heel-raise.v1 | 88 | 88 | 88 |

Worst values over all compiled configurations, tier 2: planted-contact displacement 0.000 mm, contact
error 0.000 mm, contact orientation 0.000°, penetration 0.000 mm, bone-length relative error 1.6e-15,
joint-limit violations 0, unreachable samples 0, knee flips 0, max pelvis correction 3.45 mm (below the
5 mm "notable" threshold). **Near the limit:** worst refined joint-velocity jump 0.4997 rad/s against a
0.5 rad/s tolerance (step-up, left-leg +10 mm rig, right-up/left-down).

Baseline (joint rotations with a frozen pelvis — the host's current behaviour) on defaults:
planted-contact displacement 46 mm (heel raise) to 646 mm (sit-to-stand), penetration up to 478 mm.

The 19 rejected configurations are all explicit and legitimate: 8 × squat depth 100° whose heel-down
ankle dorsiflexion demand reaches the rig limit minus headroom (`UNSUPPORTED_CONFIGURATION`), 11 ×
step treads shorter than the rig's foot (`UNSUPPORTED_CONFIGURATION`).

**Does tier 2 earn its complexity?** Only the step-up needs it: tier 1 passes 14 / 133 step-up
configurations (the trailing leg runs out of reach during the transfer, 9 369 unreachable samples in
the sweep); tier 2 passes 133 / 133 with a median maximum correction of 1.2 mm. For the other three
recipes tier 2 is idle and, after the optimisation below, costs ~1 µs per sample over tier 1.

## 3. Test suites (`npm test`)

| Suite | Files | Tests | Highlights |
|---|---|---|---|
| Math / Euler / contracts / rig (unit + seeded property) | 6 | 187 | independent references (Rodrigues, explicit matrix products, BigInt FNV/mulberry32, independent FK); 3 000 random poses for rigidity |
| Rig adapter (unit + property) | 2 | 36 | rig B reproduces solved positions/sites to ~2.5e-15 m; all 24 right-handed axis labellings × m/cm/mm; 24 left-handed ones rejected; rig C → actionable `MISSING_CAPABILITY` |
| IO / manifest / export / glTF round trip | 4 | 61 | 1 500-case seeded mutation fuzz of recipe JSON; forged review status rejected |
| Render / player (Node) | 2 | 22 | resource ledger returns to zero after rig/environment swaps; anchor-based clock |
| **Validation** (`tests/validation/`) | 15 | 862 | sweep property "feasible ⇒ within tolerance" on 8 rigs; determinism (bitwise-identical under shuffled/reverse/interleaved seeking; bakes at 24/30/60/120 fps agree bitwise at shared times; up to 10 h of wall-clock playback within 1e-9); C0 at every authored transition (±1e-7 s) plus 2 kHz scans; exact mirror equivariance for all recipes and leading sides, including an asymmetric rig; independent contact geometry (flat foot, forefoot pivot, heel-lift curve, seat contact); contact sequences per leading side; knee never flips; stabiliser within declared bounds and never mutates the plan; baseline exhibits the host problem; failure modes (unreachable targets, contradictory contacts, invalid geometry, missing articulation, malformed parameters, unknown or near-miss recipe ids, ≥ 500-case plan fuzz, size limits) |

Defects found by the independent test work and fixed before this report (each has a regression test):
6 in math/rig/contracts (e.g. shoulder abduction > 90° decomposed onto the wrong Euler branch), 9 in
solver/recipes/validation (e.g. a feasibility scan too coarse to see a 3 ms toe penetration; a
step-up left/right arm asymmetry; a sit-to-stand that read only the left leg), 1 unbounded-cost input
(plan size limits added), and 2 C0 jumps at step-up lift-off found by the export agent's mid-frame
checks.

## 4. Browser tests (`e2e/workbench.spec.ts`, 19 tests)

Every recipe: timeline phases, Space play/pause, scrubbing with time/phase readouts, frame and phase
stepping, speed, views, left/right inspection, overlay toggles, comparison split, invalid-parameter
errors, shortcut keys not hijacked in inputs; step-up leading-side change; squat and sit-to-stand
comparison (baseline fails tolerance, stabilised passes); reduced motion (no autoplay, static key-pose
inspection); 390 × 844 mobile layout without horizontal scroll; rig B with host bones and rig C
diagnostics; recipe JSON export → import plus malformed/forged imports; `.glb` + manifest download and
in-browser round-trip verification; GPU and owned resources not growing across recipe/rig cycles; dark
theme; keyboard help; accessible names on all controls; WebGL-unavailable state; compile failure
state; no console errors. Screenshots (real captures): `evidence/screenshots/`.

## 5. Export fidelity (`evidence/ROUNDTRIP.md`)

Worst over all recipe clips: joint position 6.1e-7 m (tolerance 5e-5 m), local rotation 2.5e-6 rad
(tolerance 1e-3 rad), bone-length relative error 5.9e-8 (tolerance 1e-5); largest key step 4.98° at
60 fps (limit 10°). The manifest SHA-256 matches the written `.glb`; `.glb` files contain no timestamp
so hashes are reproducible.

## 6. Performance

Solver (Node, shuffled-time `samplePose`, 3 000 samples per recipe and tier, after warm-up):
stabilised p50 21.6–28.3 µs, p99 ≤ 180 µs; compile p50 83–139 ms (dominated by the 240 Hz feasibility
scan); streamed 240 Hz analysis 125–163 ms per clip. An optimisation that reuses the Δ = 0 leg
solutions (verified **bitwise-identical** by a SHA-256 over every sampled field of all recipes and
tiers at 240 Hz) reduced stabilised p50 by 32–36 % and compile p50 by 16–26 %; pre-optimisation
numbers are kept in `evidence/solver-bench.before-optimisation.json`.

Browser (SwiftShader, not representative of client GPUs): engine sampling 0.1 ms p50 per frame
(0.2 ms in comparison mode), `renderer.render` CPU 0.4–0.7 ms p50, 38–102 draw calls, ~10–22 k
triangles; frame interval 33–50 ms p50, dominated by the software rasteriser.

Memory: plans and rigs are cached by identity in `WeakMap`s; analysis streams (bounded); the
workbench's resource-hygiene e2e test and the Node resource-ledger tests show no growth across
recipe/rig swaps.

## 7. Not executed / not established

* No real GPU or client device measurements (software WebGL only); no browsers other than Chromium.
* No assistive-technology (screen-reader) session; accessibility checked automatically (accessible
  names, focus/keyboard paths) and visually.
* No host integration: StabilityOS code, skeleton and renderer were not available.
* No clinical review of any recipe, parameter, phase or cue; all content remains `unreviewed-synthetic`.
* No human visual-review sign-off of motion readability beyond the author's inspection of screenshots.
