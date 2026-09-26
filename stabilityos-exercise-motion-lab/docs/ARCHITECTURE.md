# Architecture

> Synthetic, unreviewed engineering prototype. Nothing here is a prescription, dose, patient
> instruction or clinical validation. See `REVIEW_NOTICE` in `src/core/contracts/common.ts`.

## 1. What problem the engine solves

A joint-rotation rig that turns limbs around a stationary body cannot show a sit-to-stand, a squat,
a step-up or a heel raise correctly: the pelvis must translate and tilt, the trunk must lean, left
and right limbs differ, and feet (and the pelvis on a chair) must stay on their supports. This engine
makes those supports explicit **contact constraints**, solves the body around them, and measures and
reports every residual instead of hiding it.

## 2. Layers

```
src/app/      React workbench (UI state, panels, keyboard, a11y)        ─┐
src/player/   framework-agnostic playback clock (t is computed, never accumulated)
src/render/   Three.js adapter behind a small interface (scene, overlays, split comparison)
src/export/   Three.js glTF export / reimport / round-trip comparison
src/core/     pure TypeScript: no React, no Three.js, no DOM              ◄─ everything depends on this
  contracts/  zod schemas, versioned `smx.<name>/<major>`; TS types are inferred from them
  math/       vec3, quat, mat3, Tait–Bryan (all 6 orders, both branches), curves, seeded RNG
  rig/        canonical humanoid builder, compiled rig model, FK, fingerprint, validateRig
  environment/ floor / chair / step → support surfaces + solids, validation, penetration
  plan/       keyframe tracks, contact schedule, plan validation, mirroring
  solver/     leg IK, foot/forefoot/swing targets, stabiliser, sampler (3 tiers), key-pose solve
  recipes/    4 recipes + registry (explicit id lookup only) + shared compile pipeline
  metrics/    bake (exact frame times), streamed independent analysis (ClipAnalyzer)
  io/         recipe JSON import/export, export manifest, SHA-256
  adapter/    host-skeleton adapter: bone map, rest transforms, units/axes, capabilities
  engine.ts   public facade
```

## 3. Contracts (runtime-validated, versioned)

| Schema id | File | Holds |
|---|---|---|
| `smx.rig/1` | `contracts/rig.ts` | canonical humanoid: proportions (per side), joints (parent, rest offset, DOFs with axis/sign/limits, Euler order), sites (contact/penetration/marker), capabilities |
| `smx.environment/1` | `contracts/environment.ts` | floor, chair (seat height/depth/width, backrest), step (height, depth, width, riser z) — horizontal surfaces only |
| `smx.recipe/1` | `contracts/recipe.ts` | portable recipe document: explicit `recipeId`, params, provenance, fixed `unreviewed-synthetic` status |
| `smx.motion-plan/1` | `contracts/plan.ts` | the **motion format**: phases, cues, pelvis tracks, spine/arm DOF tracks (independent L/R), foot states per side (flat / forefoot / swing), seat contact, stabilisation bounds, assumptions |
| `smx.host-skeleton/1`, `smx.bone-map/1` | `contracts/hostRig.ts` | a host skeleton in its own units/axes/names + explicit bone mapping |
| `smx.export-manifest/1` | `contracts/manifest.ts` | semantics that travel with a baked `.glb` |
| diagnostics | `contracts/diagnostics.ts` | `{code, severity, message, path?, time?, subject?, value?, limit?, hint?}` |

Conventions (`COORDINATE_CONVENTION`): right-handed, **+Y up, +Z forward (subject faces +Z), +X =
subject's left**, metres, seconds, radians, quaternions `[x, y, z, w]` — identical to glTF 2.0.
Right-side DOF axes are the mirror (pseudovector rule) of the left, so an anatomical angle means the
same on both sides.

## 4. From recipe to pose

```
recipeId + params ──compileRecipe(rig)──► MotionPlan ──samplePose(plan, rig, t, tier)──► PoseSample
      (explicit id)   validate params         (authored intent only)      pure function of t
                      check rig capabilities
                      solve key poses (compile-time)
                      validatePlan (geometry, contacts, swing clearance)
                      30 Hz feasibility scan → feasible / diagnostics
```

`samplePose` steps (src/core/solver/sample.ts):

1. Evaluate authored channels at t: pelvis orientation (clamped to declared bounds), pelvis position,
   spine/neck/arm DOFs, foot targets from the foot state active at t.
2. **Seat contact**: while seated, the pelvis position is derived from the seat target and current
   pelvis tilt (`P = S − R·seatOffset`), blended with the authored position by a C2 weight during
   release/engage windows (placed so the constraint is exact whenever its weight is 1).
3. **Foot targets** (closed form, `solver/footPose.ts`): flat = anchor + yaw; forefoot = rotation about
   the MTP axis by φ(h) = δ + asin((h − m)/R) so ball and toes stay put while the heel rises to h;
   swing = C2 windows for lift, travel and settle between the neighbouring contact poses.
4. **Tier 2 stabiliser** (optional, `solver/stabilize.ts`), see §5.
5. **Leg IK** (`solver/legIk.ts`): closed-form two-bone IK; knee plane spanned by hip→ankle and the
   foot's forward axis, knee always on the pole side ⇒ no knee flips; unreachable targets are not
   stretched to, they are reported.
6. **Clamp every DOF** to its limit, recompose rotations, run FK from clamped angles (rigid bones by
   construction), then measure contacts, penetration, knee direction and emit diagnostics.

## 5. Numerical approach and why each piece exists

| Tier | What | Evidence |
|---|---|---|
| baseline | solved joint angles replayed with the pelvis frozen at its t = 0 transform — the host's current behaviour | planted-foot displacement 46–646 mm, penetration up to 478 mm (`evidence/METRICS.md`) |
| 1 analytic | authored pelvis + closed-form IK + closed-form foot poses | within tolerance in 350 / 469 compiled sweep configs; all failures in the step-up (14 / 133 pass) |
| 2 stabilised | tier 1 + bounded pelvis-translation correction | within tolerance in 469 / 469 (step-up 133 / 133); median max correction 1.2 mm |

The stabiliser adds complexity only where it is measured to help (the step-up transfer phases, where
the trailing leg runs out of reach). Design:

* **Variables**: a 3-vector pelvis offset Δ, box-bounded by the plan's author-declared
  `stabilization.bounds` (default 2/3/2 cm, hard cap 5 cm), shrunk by (1 − seat weight).
* **Constraints** for legs in contact: soft reach, fold (max flexion), hip and ankle limits
  (angles × 0.1 m/rad lever). Swing legs contribute a reach term that fades out after lift-off and in
  before landing, so no constraint appears or vanishes abruptly.
* **Soft reach**: near full extension the knee angle is hypersensitive to hip–ankle distance
  (≈ 0.7 mm between 5° and 2° knee flexion), so a hard projection kinks knee velocity. Reach is
  expressed on knee openness q = 1 − cos κ = (R² − d²)/(2 L1 L2) (smooth, extends past full reach) and
  mapped C1 onto the 2° floor inside a 4° zone; standing keys are authored at 7° so they sit outside it.
* **Solver**: minimum-norm damped Gauss–Newton on active constraints ((JᵀJ + μI)⁻¹Jᵀ, 3×3), central
  differences, backtracking with a steepest-descent fallback, projection onto the box. Always starts
  from Δ = 0 ⇒ no sequential state.
* **Separation of authoring and stabilisation**: Δ is reported per sample (`stabilization.offset`,
  `STABILIZATION_APPLIED` info/warning above 0.5 mm / 5 mm, `STABILIZATION_BOUND_REACHED`,
  `SOLVER_NOT_CONVERGED`) and never written back to the plan; phase timing, contacts and parameters
  cannot change. Compile-time key poses (e.g. "squat bottom at 70° knee flexion and 24.5° ankle
  dorsiflexion") are solved once by `solveKeyPose` and stored as explicit authored keys.
* **Swing feet** are not contacts: when the authored swing orientation would push the ankle past its
  range the angle saturates smoothly (C1, weighted to zero at lift-off/landing) and is reported as
  `JOINT_LIMIT_CLAMPED` info (`~swing`). Contact legs are hard-clamped and any resulting contact error
  is reported as a violation.

## 6. Determinism, seeking, frame rates

Every sample is an independent function of `(plan, rig, t, tier)`; the stabiliser has no warm start.
Seeking, pausing, reverse stepping and playback at any rate therefore cannot drift. Plans and rigs are
treated as immutable values (per-plan caches are keyed by object identity). `bakeClip` samples exact
times `k / fps` plus the exact end time. Cost of statelessness: every sample re-solves; measured cost
is in `evidence/SOLVER_BENCH.md`.

## 7. Independent verification (`metrics/analyze.ts`)

`ClipAnalyzer` recomputes, from FK output and environment geometry only: planted-site displacement
since contact onset, contact height vs support surface, sole tilt vs world up, penetration of every
sole/seat site, bone and site rigidity, joint limits by re-decomposing local rotations, knee flips,
and continuity. Continuity uses second differences at 240 Hz, then **refines** every raw value above
¼ of the tolerance at h/8 by measuring the velocity change across adjacent stencils, and counts
unrefined values twice. A velocity break ΔV splits across at most two raw stencils (each ≥ ΔV/2), so
a break at or above tolerance can never be reported as passing, while smooth acceleration a
contributes only ≈ 2a·h/8 instead of a·h (tested by injecting breaks at six sub-sample alignments and
pure acceleration: `tests/validation/continuity-estimator.test.ts`; the previous estimator failed 14
of those 20 cases). `analyzePlan` streams at 240 Hz (bounded memory).

## 8. Rig adapter (`core/adapter`)

Converts a host skeleton (any right-handed axis labelling, m/cm/mm, arbitrary rest rotations,
T-pose arms, extra unmapped bones) via an explicit bone map into a **derived canonical rig with the
host's own proportions**. Recipes are compiled on that derived rig (a motion solved for another body
would slide feet), and solved poses are mapped back with per-bone binding rotations; host bone
translations stay at rest except the declared root-motion bone. Capability checks produce actionable
diagnostics (see the extraction guide). Rig B (cm, Z-up, forward −Y, T-pose, +8 % legs) runs all four
recipes; rig C (the legacy limb-only rig) is rejected with named missing bones.

## 9. Export (`src/export`, `core/io`)

`GLTFExporter.parseAsync(scene, { binary: true, animations, trs: true, onlyVisible: false })` per the
exporter's JSDoc (threejs.org was blocked by the session's network policy; the docs page is
generated from that JSDoc in the pinned three@0.186.1 source). Node joints named as canonical joints;
per-joint quaternion tracks + root/pelvis translation, keyed at exact bake times, with hemisphere
continuity. A manifest (`smx.export-manifest/1`) carries recipe document, phases, contact schedule,
cues, assumptions, unsupported features, rig fingerprint, bake info, geometric validation summary
(240 Hz analysis), SHA-256 of the `.glb`, and the fixed UNREVIEWED status. Reimport + comparison:
worst joint-position error 5.2e-7 m vs 5e-5 m tolerance (`evidence/ROUNDTRIP.md`).

## 10. Rendering and workbench

* **Render adapter** (`src/render/`): `createStage(canvas, opts) → Stage` hides Three.js entirely
  (React never imports three). Methods: `setRig`, `setEnvironment`, `setPose(primary, comparison?)`,
  `setTrajectory`, `setHostBones`, `resetOverlays` (on every new plan, so no stale constraints survive),
  `setOverlays`, `setInspectionSide`, `setView`, `setFraming`, `setComparison` (scissor split: baseline
  vs selected tier over the same environment), `setReducedMotion`, `resize`, `render`, `getStats`,
  `dispose`. A `ResourceLedger` tracks every geometry/material the stage creates; tests assert it returns
  to zero. WebGL-2 unavailability throws `StageUnavailableError`, shown as a readable state while the
  numerical panels keep working.
* **Humanoid**: rigid segment meshes on per-joint `Object3D`s placed from `sample.worldPos/worldRot`
  (no skinning); left limbs teal, right amber, separate toe segments, a visor showing facing.
* **Player** (`src/player/`): `t = anchorTime + (now − anchorWall) · speed`, re-anchored on
  play/pause/seek/speed; never accumulates frame deltas. Samples once per frame (twice in comparison).
* **Workbench** (`src/app/`): recipe selection by explicit id, rig A / B / C, phase timeline with
  per-foot contact lanes and cue markers, scrubber, speed, views, left/right inspection, parameter
  editor generated from `paramSpecs`, overlays, tier selector, live per-contact residuals, whole-clip
  metrics from `analyzePlan` in a Web Worker, recipe/metadata panel, import/export and round-trip
  verification, keyboard shortcuts, reduced-motion static inspection, responsive layout.
  Measured costs: `evidence/RENDER_BENCH.md`; test coverage: `docs/VALIDATION.md` §4.

## 11. Known limitations

* Kinematic only: no centre-of-mass, balance, momentum, contact force, tissue load or muscle model.
* Horizontal support surfaces and axis-aligned boxes only; no slopes, soft surfaces, rotated furniture.
* Collision checks cover sole and seat sites against floor and solids, not limb volumes (a thigh can
  visually touch the seat front; hands can pass through the chair back).
* Root heading is fixed (no turning recipes); pelvis obliquity is not used to absorb leg-length
  differences (the longer leg flexes more instead).
* Rigid-segment rendering, no skinning; the adapter's twist about bone axes is shortest-arc unless a
  twist override is given.
