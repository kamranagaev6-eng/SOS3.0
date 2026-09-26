# Progress record

Short, dated record of milestones (all times 2026-09-26, UTC). Each milestone left a working,
committed tree.

| # | Milestone | Commit (branch `claude/stabilityos-motion-authoring-0eks2x`) |
|---|---|---|
| 1 | Environment: Node 24.21.0 (checksum-verified download; image had Node 22), pinned deps + lockfile, architecture & acceptance plan with tolerances fixed **before** implementation (`docs/PLAN.md`) | `5904895` |
| 2 | Math, contracts, canonical rig, FK, engine API surface | `5904895` |
| 3 | Solver tiers (analytic IK, bounded stabiliser, baseline), plan validation, four recipes | `77259f7` |
| 4 | Soft-reach stabiliser (C1), independent metrics, glTF export path, core tests | `aad76f0` |
| 5 | Rig adapter (rigs B/C), two-rate continuity analysis, sweep + solver-bench scripts | `183c66d` |
| 6 | Validation suite (862 tests) and fixes for the 10 defects it found; rig adapter; export path | `fc40499` |
| 7 | Workbench + render adapter + Playwright (19 tests) + render bench | `b754bbe` |
| 8 | Final sweep (488 configs, 0 silent failures), solver optimisation (bitwise-identical, −32–36 % sample cost), benchmarks, validation write-up | `7a6b3df` |
| 9 | Improvement round: split-safe continuity estimator, continuous stabiliser activation, GitHub Actions CI, runnable host-integration example, evidence index, README tour, CI fix (preview bound to 127.0.0.1); reverse playback in the player clock (tested; no UI control yet). **Not done yet:** contact shadows in the renderer (pure geometry module `src/render/contactShadowMath.ts` added, not wired or tested), off-main-thread compile, keyboard-operable timeline | `f46ba7b` and later (see `git log`) |

## Work organisation

Core contracts, solver and recipes were written by the main session. Parallel subagents (in disjoint
directories of the same tree) built: independent math/rig/contract tests (found 6 real defects, all
fixed with regression tests), the rig adapter and synthetic rigs B/C, the export path, the React
workbench + render adapter + Playwright tests, and the recipe validation suite.

## Notable engineering decisions (with the measurement that drove them)

* Stabiliser restricted to legs in contact; swing-foot ankle limits handled by a reported C1 soft
  limit — the first step-up sweep showed every clamp was on a swing foot.
* Trailing heel-off moved to 15 % of the rise: reduced the step-up's needed correction from 10.2 mm to
  0.45 mm (fix by authoring, not by hiding corrections).
* Reach constraint reformulated on knee openness q = 1 − cos κ with a 4° soft zone and standing keys at
  7°: removed a 0.96 rad/s knee-velocity kink caused by hard projection near full extension (distance
  between 5° and 2° knee flexion is only ~0.7 mm).
* Standing keys target the straighter knee (`min`) instead of the mean: the mean was unsatisfiable
  for a 10 mm leg-length difference.
* Redundant, non-differentiable κ ≥ 0 rows removed from the stabiliser (a single sample at exactly
  full extension failed to converge on the big-feet rig).
* Continuity metric refined at h/4 around candidates: distinguishes true C1 breaks from smooth
  acceleration at faster tempos.
* Compile-time feasibility now runs at the 240 Hz metric rate through the independent analyser (a
  30 Hz scan missed a 3 ms toe penetration): "feasible" implies "within tolerance" by construction, at
  the cost of ~0.1–0.2 s compile time.
* The stabilised tier reuses its Δ = 0 leg solutions (was solving each leg up to 3× per sample):
  output verified bitwise-identical; sample cost −32–36 %, compile −16–26 %.
* Continuity estimator corrected: the step-up's reported "0.4997 rad/s near-limit jump" scaled
  exactly with the sampling step (0.62 → 0.157 → 0.039 rad/s at 240/960/3 840 Hz), i.e. smooth
  ≈ 150 rad/s² swing-knee acceleration, not a break. Worse, injected tests showed the old estimator
  could hide real breaks up to ~2× tolerance when they fell between samples (14 of 20 cases failed).
  The new estimator refines every value above ¼ tolerance by measuring the velocity change across
  adjacent stencils at h/8 and counts unrefined values twice, so failing breaks cannot hide.
* Stabiliser activation now uses the same threshold it solves to: activating only above 1e-6 but
  solving to 1e-9 produced a ~1e-4 rad knee step at activation (visible only at 15 kHz sampling as a
  0.81 rad/s spike; the spike vanished after the fix and remaining maxima scale as pure acceleration).

## Budget

No usage/spend telemetry was available inside this session, so actual expenditure against the $100
ceiling could not be observed; no estimate is given. No paid external services were used. Work was
kept to the four recipes and their validation.

## Environment notes

* `threejs.org` is blocked by the session's network policy; the GLTFExporter docs page is generated
  from the JSDoc in the pinned `three@0.186.1` source, which was used instead.
* Chromium 141 (pre-installed, Playwright 1.56.1) with SwiftShader software WebGL for browser tests;
  rendering numbers are therefore not representative of client GPUs.
