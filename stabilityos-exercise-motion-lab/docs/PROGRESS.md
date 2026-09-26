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
| 6 | Workbench + render adapter, validation suite, benchmarks, docs, evidence | see `git log` |

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

## Budget

No usage/spend telemetry was available inside this session, so actual expenditure against the $100
ceiling could not be observed; no estimate is given. No paid external services were used. Work was
kept to the four recipes and their validation.

## Environment notes

* `threejs.org` is blocked by the session's network policy; the GLTFExporter docs page is generated
  from the JSDoc in the pinned `three@0.186.1` source, which was used instead.
* Chromium 141 (pre-installed, Playwright 1.56.1) with SwiftShader software WebGL for browser tests;
  rendering numbers are therefore not representative of client GPUs.
