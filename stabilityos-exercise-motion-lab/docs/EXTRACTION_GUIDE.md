# Extraction guide (for later selective adaptation into StabilityOS)

This project was built without access to StabilityOS. It is a standalone engine and workbench over
synthetic data. Everything below describes **what can be lifted** and **what the host must still
provide**. No content here is clinically reviewed.

## 1. Reusable components

| Component | Path | Dependencies | Lift as-is? |
|---|---|---|---|
| Motion contracts (schemas + types) | `src/core/contracts/` | zod | Yes — the versioned contract between authoring, solver, export and host |
| Math | `src/core/math/` | none | Yes |
| Canonical rig + FK | `src/core/rig/` | contracts, math | Yes |
| Environment geometry | `src/core/environment/` | contracts | Yes |
| Motion plan tooling | `src/core/plan/` | contracts, math | Yes |
| **Solver** (IK, foot poses, stabiliser, sampler) | `src/core/solver/` | rig, plan, environment | Yes — pure functions of `(plan, rig, t, tier)` |
| Recipes | `src/core/recipes/` | solver | As **templates**; parameters/values need clinical review before any use |
| Metrics / independent checks | `src/core/metrics/` | solver | Yes (useful as CI checks for new recipes) |
| **Rig adapter** | `src/core/adapter/` | rig, contracts | Yes — this is the integration seam for the host skeleton |
| Recipe/manifest IO | `src/core/io/` | contracts | Yes |
| Player clock | `src/player/` | none | Yes (framework-agnostic) |
| Render adapter | `src/render/` | three | Optional — the host player may keep its own renderer and only consume poses |
| glTF export/reimport | `src/export/` | three | Optional (offline baking / QA tooling) |
| Workbench | `src/app/` | React | No — an internal inspection tool, not a patient-facing player |

Public entry point: `src/core/engine.ts`.

## 2. Host responsibilities (unchanged by this package)

* **Exercise identity** is passed by explicit recipe id (`sit-to-stand.v1`, …). Nothing infers an
  exercise from a name or from joint angles; unknown ids fail with `UNKNOWN_RECIPE`.
* **Approved patient-facing instructions, dose (sets/reps/load/frequency) and side** come from the
  host's clinician-approved programme. Cue labels in plans are neutral phase markers, not instructions.
  "Repetitions shown" in a recipe is a demonstration length, not a dose.
* **Review authority**: every recipe, plan and manifest carries `reviewStatus: 'unreviewed-synthetic'`;
  there is no code path that sets anything else, and import rejects any other value. Nothing here
  publishes into a patient programme.
* **Patient-specific ranges** are never inferred. Joint limits here are synthetic engineering limits
  of a synthetic rig.

## 3. Minimum rig capabilities

A host rig that **lacks pelvis/trunk articulation or root motion must be extended** before these
recipes can be demonstrated correctly — the adapter refuses it rather than folding the missing motion
into other bones. Minimum capabilities (`CAPABILITIES` in `contracts/rig.ts`):

| Capability | What the host skeleton needs | Needed by |
|---|---|---|
| `root-translation` | a translatable root/hips bone (vertical **and** horizontal translation) | all four recipes |
| `pelvis-rotation` | a pelvis/hips bone that rotates independently of the legs (tilt at least) | all four |
| `trunk-articulation` | ≥ 1 spine bone between pelvis and chest/shoulders, mapped to `lumbar` or `thoracic` | sit-to-stand, squat, step-up |
| `independent-legs` | separate left/right hip, knee, ankle chains | all four |
| `knee-hinge` | a knee bone per side | all four |
| `ankle-2dof` | a foot bone per side (dorsi/plantar-flexion + inversion/eversion) | all four |
| `forefoot-articulation` | a toe/forefoot bone per side at the metatarsophalangeal joint | heel raise, step-up (forefoot contact) |
| `independent-arms`, `neck` | optional, cosmetic for these recipes | — |

The legacy-style synthetic rig C (one rigid `Body`, no spine, no toes, no translatable bone) is the
worked example: the adapter returns `MISSING_CAPABILITY` errors naming the bones to add, e.g.
"Add a child bone of 'Foot_L' at the metatarsophalangeal joint and map it to 'mtp_L' …".

## 4. Integration sketch

```ts
import { createHostRigAdapter, compileRecipe, samplePose, capabilityRequirements, listRecipes } from './core/engine.ts';

// once per host skeleton
const res = createHostRigAdapter(hostSkeleton, boneMap, recipe.requiredCapabilities,
  { requiredBy: capabilityRequirements(listRecipes()).requiredBy });
if (!res.ok) showDiagnostics(res.diagnostics);           // actionable, never a silent fallback

// per approved exercise (id and parameters come from the host record)
const c = compileRecipe(hostRecord.recipeId, hostRecord.demoParams, res.adapter.canonical);
if (!c.ok || !c.feasible) showDiagnostics(c.diagnostics); // do not display an infeasible motion as valid

// per frame, at any time t (seek/pause/reverse safe)
const pose = samplePose(c.plan, res.adapter.canonical, t);
applyToHostSkeleton(res.adapter.toHostPose(pose));        // local transforms in host units/axes
```

Offline alternative: `bakeClip` → `exportBakedClipToGlb` → ship `.glb` **plus** its manifest (the
manifest is what preserves exercise meaning, provenance and review status).

## 5. Four different kinds of evidence — do not conflate them

| Level | What it establishes | Where | Status here |
|---|---|---|---|
| **Mathematical verification** | contacts, penetration, rigidity, limits, continuity, determinism, export fidelity within stated engineering tolerances | `npm test`, `npm run report:metrics`, `npm run report:roundtrip` | Done; see `docs/VALIDATION.md` |
| **Visual inspection** | a human judges readability and plausibility of the movement | workbench, `evidence/screenshots/` | Tooling done; no reviewer sign-off |
| **Host integration** | works on the real StabilityOS skeleton, renderer, devices, performance budget, data flow | host repo | **Not done** (no access) |
| **Clinical review** | movements, parameters, phases and cues are appropriate demonstrations | clinicians | **Not done**; all content `unreviewed-synthetic` |

Passing the first level does not imply any of the others. Kinematic plausibility says nothing about
balance, tissue loading, muscle activation, safety or clinical correctness.

## 6. Suggested extraction order

1. Contracts + math + rig + solver + metrics (pure TS) behind the host's module boundary; run the
   validation suite in host CI.
2. Describe the host skeleton as `smx.host-skeleton/1` + `smx.bone-map/1`; fix every adapter
   diagnostic (usually: add root motion, a spine bone, toe bones).
3. Drive the existing host player from `samplePose` → `toHostPose`; keep the host renderer.
4. Only then consider recipes, each going through clinical review with the host's approval workflow.
