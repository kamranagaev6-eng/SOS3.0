# Architecture and acceptance plan

Written before implementation. Everything in this project is a **synthetic, unreviewed engineering
fixture**. Nothing here is a prescription, a dose, a patient instruction or a clinical validation.

## Problem being solved

The host platform's current demonstration rig rotates limb joints about a mostly stationary body.
That cannot show movements that need coordinated pelvis/trunk motion, whole-body translation,
independent left/right limbs, or maintained contact with a floor, chair or step. This project builds
an engine where contacts are explicit, solved for and measured.

## Layering (dependency direction is strictly downward)

```
app/ (React workbench)  ──►  player/ (clock, framework-agnostic)  ──►  render/ (Three.js adapter)
          │                                                              │
          └──────────────────────────►  core/  ◄─────────────────────────┘
core/  (no React, no Three.js, no DOM)
  math/        vec3, quat, mat3, Euler decomposition (all 6 Tait-Bryan orders), curves, seeded RNG
  contracts/   zod runtime schemas, versioned ("smx.<name>/<major>")
  rig/         canonical humanoid builder, forward kinematics, capability model
  environment/ floor / chair / step geometry, support surfaces, validation
  plan/        keyframe tracks, foot-state tracks, contact schedule, plan validation, mirroring
  solver/      analytic leg IK, foot/forefoot pose, bounded pelvis stabiliser, pose sampler (3 tiers)
  recipes/     4 recipes, looked up by explicit recipe id only
  metrics/     baking + independent clip metrics
  io/          recipe import/export, manifest, hashing
  adapter/     host-rig adapter (bone map, rest transforms, units/axes, capability checks)
```

## Numerical approach (baseline first, then justified complexity)

* **Tier 0 – joint-rotation baseline**: the solved joint angles replayed with the pelvis frozen at its
  t=0 transform. This reproduces the host's current behaviour and is only used for comparison.
* **Tier 1 – analytic**: authored pelvis/trunk trajectory; each leg solved by closed-form two-bone IK
  (law of cosines) with the knee plane fixed by the foot's forward axis (no knee flips); foot and
  forefoot poses computed in closed form from the contact state (flat / forefoot / swing).
  Seat contact places the pelvis from the seat target (weighted blend while engaging/releasing).
* **Tier 2 – bounded stabiliser**: a 3-variable pelvis translation offset, solved by projected
  Gauss–Newton with box bounds taken from the plan's explicit `stabilization.bounds`. It only
  activates when tier 1 violates reach or joint-limit constraints. The offset is reported per sample
  and never alters authored parameters, phases or contacts. Always started from zero offset, so each
  sample depends only on `t` (no sequential state, no drift).
* Joint limits are enforced on the final pose by per-DOF clamping; FK is recomputed from clamped
  angles, and any resulting contact error is **measured and reported**, never hidden.
* Tier 2 must earn its place: the metrics report compares tier 1 vs tier 2 violation counts.

## Conventions

Right-handed, **+Y up, +Z forward (subject faces +Z), +X = subject's left**, metres, seconds,
radians internally (degrees only at UI/recipe-parameter boundaries, suffixed `Deg`).
Same as glTF 2.0 (+Y up, asset front faces +Z). Quaternions are `[x, y, z, w]`.

## Engineering tolerances (fixed before evaluation)

| Quantity | Tolerance | Rationale |
|---|---|---|
| Active planted contact position residual | ≤ 1.0 mm | Visually invisible at demo scale; analytic IK should reach ~1e-9 m, leaving headroom for float32 export. |
| Planted-contact displacement over an interval | ≤ 1.0 mm | "Feet do not slide" criterion. |
| Contact orientation residual (sole / toe-segment normal, heading) | ≤ 1.0° | Visible foot rocking threshold. |
| Surface penetration of any sole or seat site | ≤ 1.0 mm | Same scale as contact tolerance. |
| Bone-length relative error, solver output | ≤ 1e-9 | Rigid FK; anything larger means stretching. |
| Bone-length relative error after glTF round trip | ≤ 1e-5 | float32 storage. |
| Joint angles after clamping | within limits ± 1e-9 rad | Limits are enforced, not advisory. |
| Transition discontinuity (velocity jump from 2nd differences at 240 Hz) | ≤ 0.5 rad/s joints, ≤ 0.10 m/s pelvis & sites | Smooth C1 curves give ≈0.04 rad/s here; a C0/C1 break shows its full size. |
| Baked quaternion continuity | consecutive dot ≥ 0, step ≤ 10° at 60 fps | No sign flips in tracks. |
| Export → reimport pose difference at key times | ≤ 0.05 mm joint position, ≤ 1e-3 rad rotation | float32 quantisation. |
| Stabiliser | converged residual ≤ 1e-6, offset within declared bounds; > 5 mm = warning | Offset is a correction, it must stay small and visible. |
| Deterministic re-sampling | bitwise-identical poses for identical (plan, rig, t) | No hidden state. |

These tolerances are geometric. Passing them says nothing about balance, tissue loading, muscle
activation, safety or clinical correctness.

## Acceptance criteria

1. Four recipes (`sit-to-stand.v1`, `bilateral-squat.v1`, `step-up-down.v1`,
   `bilateral-heel-raise.v1`) compile and play on rig A (canonical) and rig B (adapted host skeleton,
   cm / Z-up / T-pose, different proportions), within tolerances across supported parameter grids,
   both leading sides and mirrored configurations.
2. Unsupported / infeasible inputs produce explicit diagnostics (unreachable targets, contradictory
   contacts, invalid geometry, missing bones, malformed JSON), never a silently "successful" motion.
3. Sampling is a pure function of time: seek order, frame rate and long playback do not change poses.
4. glTF export → reimport reproduces sampled poses within tolerance; a manifest carries recipe
   semantics, provenance, version, assumptions, unsupported features and `UNREVIEWED` status.
5. The workbench exercises the real engine: selection, timeline, scrub, speed, views, left/right
   inspection, parameters, overlays, baseline comparison, keyboard, reduced motion, error states.
6. Benchmarks for solver and rendering reported separately with the real execution environment.
7. Extraction guide identifies reusable parts and the minimum host rig capabilities.
