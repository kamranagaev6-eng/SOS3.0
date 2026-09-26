# glTF export round-trip report

> UNREVIEWED SYNTHETIC ENGINEERING FIXTURE. Kinematic demonstration only: not a prescription, not a dose, not patient instruction, not validated for balance, loading, muscle activity, safety or clinical correctness. Exercise identity, approved instructions, dose, side and review authority must come from the host application.

Each row: bake (rig A) → GLTFExporter `.glb` (binary, trs, LINEAR tracks) + manifest → GLTFLoader reimport → every imported track
evaluated with its own interpolant at exactly the original frame times → world joint positions, local rotations and bone lengths
compared with the baked clip. Tolerances were fixed before evaluation (docs/PLAN.md) and are geometric only.

Generated 2026-09-26T02:11:53.762Z. Environment: node `v24.21.0`, platform `linux 6.18.44-fc-v37`, arch `x64`, cpu `Intel(R) Xeon(R) Processor @ 2.10GHz`, three `r186`, fileReader `tests/support/fileReaderShim.ts (Node only)`.

Summary: recipePass 8, recipeFail 0, recipeBlocked 0, recipeError 0, controlPass 3, controlFail 0.

## Recipes (stabilized tier, default parameters)

| Recipe | fps | Status | Frames | Max joint pos err (≤ 0.00005 m) | Max root err (m) | Max local rot err (≤ 0.001 rad) | Max bone-length rel err (≤ 0.00001) | Max key step (deg / allowed) | .glb size | SHA-256 |
|---|---|---|---|---|---|---|---|---|---|---|
| sit-to-stand.v1 | 30 | pass | 250 | 1.39e-7 | 7.82e-8 | 3.24e-7 | 7.77e-8 | 4.03 / 20 | 172.9 KB | `11c55fd73775b67b…` |
| sit-to-stand.v1 | 60 | pass | 499 | 1.38e-7 | 7.96e-8 | 3.23e-7 | 5.26e-8 | 2.05 / 10 | 273.1 KB | `2bf3846a193845e7…` |
| bilateral-squat.v1 | 30 | pass | 349 | 1.32e-7 | 5.75e-8 | 4.02e-7 | 3.66e-8 | 2.00 / 20 | 212.8 KB | `f2d01bff7c05274b…` |
| bilateral-squat.v1 | 60 | pass | 697 | 1.38e-7 | 5.96e-8 | 4.62e-7 | 3.66e-8 | 1.00 / 10 | 352.9 KB | `dec9ba0124472750…` |
| step-up-down.v1 | 30 | pass | 325 | 5.23e-7 | 1.18e-7 | 1.86e-6 | 2.90e-8 | 9.95 / 20 | 203.2 KB | `9065d00296340374…` |
| step-up-down.v1 | 60 | pass | 649 | 5.19e-7 | 1.75e-7 | 1.92e-6 | 2.86e-8 | 4.98 / 10 | 333.6 KB | `7515bb1687e1ab86…` |
| bilateral-heel-raise.v1 | 30 | pass | 331 | 3.81e-8 | 9.40e-9 | 1.18e-7 | 5.51e-10 | 0.74 / 20 | 205.2 KB | `134d95e853f0a641…` |
| bilateral-heel-raise.v1 | 60 | pass | 661 | 3.98e-8 | 9.41e-9 | 1.18e-7 | 5.51e-10 | 0.37 / 10 | 338.0 KB | `562f13a666fffc91…` |

## Control: synthetic joint-angle sweeps (solver-independent export self-test)

Seeded smooth angles inside the synthetic joint limits for every DOF, moving root and pelvis; no contacts, not an exercise.

| Clip | fps | Status | Frames | Max joint pos err (m) | Max local rot err (rad) | Max bone-length rel err | Hemisphere flips applied | .glb size |
|---|---|---|---|---|---|---|---|---|
| synthetic seed 1 | 30 | pass | 61 | 1.05e-7 | 1.55e-7 | 5.69e-8 | 0 | 97.5 KB |
| synthetic seed 2 (heading wraps 180 deg) | 60 | pass | 121 | 1.65e-7 | 1.64e-7 | 5.27e-8 | 39 | 121.7 KB |
| synthetic seed 3 (heading wraps 180 deg) | 24 | pass | 49 | 1.28e-7 | 1.52e-7 | 9.63e-8 | 12 | 92.7 KB |

## Mid-frame resampling (informational, NOT a pass criterion)

Imported tracks evaluated halfway between baked frames (LINEAR / slerp) vs a fresh sample at the same time. This measures bake
resolution, not export fidelity.

| Clip | fps | Source | Max joint pos diff (m) | Max local rot diff (rad) |
|---|---|---|---|---|
| sit-to-stand.v1 | 30 | engine samplePose | 1.13e-3 | 2.40e-3 |
| sit-to-stand.v1 | 60 | engine samplePose | 2.82e-4 | 5.98e-4 |
| bilateral-squat.v1 | 30 | engine samplePose | 2.97e-4 | 1.43e-3 |
| bilateral-squat.v1 | 60 | engine samplePose | 8.37e-5 | 4.02e-4 |
| step-up-down.v1 | 30 | engine samplePose | 6.00e-3 | 1.55e-2 |
| step-up-down.v1 | 60 | engine samplePose | 6.04e-3 | 1.56e-2 |
| bilateral-heel-raise.v1 | 30 | engine samplePose | 3.02e-5 | 1.97e-4 |
| bilateral-heel-raise.v1 | 60 | engine samplePose | 7.68e-6 | 4.99e-5 |
| synthetic seed 1 | 30 | provided sampler | 6.79e-4 | 1.08e-3 |
| synthetic seed 2 (heading wraps 180 deg) | 60 | provided sampler | 2.87e-4 | 2.38e-4 |
| synthetic seed 3 (heading wraps 180 deg) | 24 | provided sampler | 1.27e-3 | 2.21e-3 |

## Sample outputs

- `evidence/exports/sit-to-stand.v1.glb` (273.1 KB, sha256 `2bf3846a193845e785dd2a78e8a47cbfcd30114d80dfce7678c991b6a16a0158`) + `evidence/exports/sit-to-stand.v1.manifest.json`
- `evidence/exports/bilateral-squat.v1.glb` (352.9 KB, sha256 `dec9ba0124472750453b590ffede50dec7e8a20852c67b4efb654f80c3d9df28`) + `evidence/exports/bilateral-squat.v1.manifest.json`
- `evidence/exports/step-up-down.v1.glb` (333.6 KB, sha256 `7515bb1687e1ab864828eae3de5876324d2e3f108bd81c1bad1c6e8f9ee1a254`) + `evidence/exports/step-up-down.v1.manifest.json`
- `evidence/exports/bilateral-heel-raise.v1.glb` (338.0 KB, sha256 `562f13a666fffc9172bf2260ccd19f0e2e40dc5d3f61d59688e040214316e3b0`) + `evidence/exports/bilateral-heel-raise.v1.manifest.json`

## Notes

- Axes: engine and glTF share +Y up, +Z forward, metres, [x,y,z,w] quaternions; no conversion is applied.
- Keyframe times and values are stored as float32 (glTF accessors); node rest offsets are JSON numbers.
- Rotation error is the geodesic angle 2·atan2(|v|,|w|) of q_import⁻¹·q_baked (robust near zero, independent of float32 norm drift).
- The manifest records `validation.kind = "geometric-only"`; passing these checks is not clinical validation.
