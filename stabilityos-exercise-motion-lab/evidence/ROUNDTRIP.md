# glTF export round-trip report

> UNREVIEWED SYNTHETIC ENGINEERING FIXTURE. Kinematic demonstration only: not a prescription, not a dose, not patient instruction, not validated for balance, loading, muscle activity, safety or clinical correctness. Exercise identity, approved instructions, dose, side and review authority must come from the host application.

Each row: bake (rig A) → GLTFExporter `.glb` (binary, trs, LINEAR tracks) + manifest → GLTFLoader reimport → every imported track
evaluated with its own interpolant at exactly the original frame times → world joint positions, local rotations and bone lengths
compared with the baked clip. Tolerances were fixed before evaluation (docs/PLAN.md) and are geometric only.

Generated 2026-09-26T03:34:40.027Z. Environment: node `v24.21.0`, platform `linux 6.18.44-fc-v37`, arch `x64`, cpu `Intel(R) Xeon(R) Processor @ 2.10GHz`, three `r186`, fileReader `tests/support/fileReaderShim.ts (Node only)`.

Summary: recipePass 8, recipeFail 0, recipeBlocked 0, recipeError 0, controlPass 3, controlFail 0.

## Recipes (stabilized tier, default parameters)

| Recipe | fps | Status | Frames | Max joint pos err (≤ 0.00005 m) | Max root err (m) | Max local rot err (≤ 0.001 rad) | Max bone-length rel err (≤ 0.00001) | Max key step (deg / allowed) | .glb size | SHA-256 |
|---|---|---|---|---|---|---|---|---|---|---|
| sit-to-stand.v1 | 30 | pass | 250 | 1.47e-7 | 7.82e-8 | 3.24e-7 | 5.93e-8 | 4.03 / 20 | 172.9 KB | `5eda81dc8dd5f23c…` |
| sit-to-stand.v1 | 60 | pass | 499 | 1.47e-7 | 7.96e-8 | 3.23e-7 | 5.26e-8 | 2.05 / 10 | 273.1 KB | `fee037ee5ba368a9…` |
| bilateral-squat.v1 | 30 | pass | 349 | 1.34e-7 | 5.75e-8 | 4.09e-7 | 3.66e-8 | 1.92 / 20 | 212.8 KB | `05918b5ebc974d20…` |
| bilateral-squat.v1 | 60 | pass | 697 | 1.49e-7 | 5.96e-8 | 4.54e-7 | 3.66e-8 | 0.96 / 10 | 352.8 KB | `378a31d05d42b48d…` |
| step-up-down.v1 | 30 | pass | 325 | 6.11e-7 | 1.17e-7 | 2.42e-6 | 2.93e-8 | 12.40 / 20 | 203.1 KB | `6ad4eba4cf1ae92b…` |
| step-up-down.v1 | 60 | pass | 649 | 6.14e-7 | 1.70e-7 | 2.47e-6 | 2.70e-8 | 6.26 / 10 | 333.5 KB | `d560da717658fc75…` |
| bilateral-heel-raise.v1 | 30 | pass | 331 | 4.11e-8 | 7.92e-9 | 1.18e-7 | 5.51e-10 | 0.75 / 20 | 205.3 KB | `2699b086dc36f6d6…` |
| bilateral-heel-raise.v1 | 60 | pass | 661 | 4.48e-8 | 9.23e-9 | 1.18e-7 | 5.51e-10 | 0.37 / 10 | 338.1 KB | `806e303098df3335…` |

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
| bilateral-squat.v1 | 30 | engine samplePose | 3.21e-4 | 1.56e-3 |
| bilateral-squat.v1 | 60 | engine samplePose | 8.39e-5 | 4.08e-4 |
| step-up-down.v1 | 30 | engine samplePose | 3.86e-3 | 1.77e-2 |
| step-up-down.v1 | 60 | engine samplePose | 1.09e-3 | 5.03e-3 |
| bilateral-heel-raise.v1 | 30 | engine samplePose | 3.53e-5 | 2.15e-4 |
| bilateral-heel-raise.v1 | 60 | engine samplePose | 8.95e-6 | 5.47e-5 |
| synthetic seed 1 | 30 | provided sampler | 6.79e-4 | 1.08e-3 |
| synthetic seed 2 (heading wraps 180 deg) | 60 | provided sampler | 2.87e-4 | 2.38e-4 |
| synthetic seed 3 (heading wraps 180 deg) | 24 | provided sampler | 1.27e-3 | 2.21e-3 |

## Sample outputs

- `evidence/exports/sit-to-stand.v1.glb` (273.1 KB, sha256 `fee037ee5ba368a96826cf9c430418093639fa973980e393637b947fa874ec90`) + `evidence/exports/sit-to-stand.v1.manifest.json`
- `evidence/exports/bilateral-squat.v1.glb` (352.8 KB, sha256 `378a31d05d42b48d2c121052734e9280d3956a68492f85c7b64bfb8ae647efa4`) + `evidence/exports/bilateral-squat.v1.manifest.json`
- `evidence/exports/step-up-down.v1.glb` (333.5 KB, sha256 `d560da717658fc751cead916b34676eadf4646893b1c40fb393b9b2f54a7dad5`) + `evidence/exports/step-up-down.v1.manifest.json`
- `evidence/exports/bilateral-heel-raise.v1.glb` (338.1 KB, sha256 `806e303098df333557877ecdb34f89513cee5aed20b06990f147ef6e99a9927e`) + `evidence/exports/bilateral-heel-raise.v1.manifest.json`

## Notes

- Axes: engine and glTF share +Y up, +Z forward, metres, [x,y,z,w] quaternions; no conversion is applied.
- Keyframe times and values are stored as float32 (glTF accessors); node rest offsets are JSON numbers.
- Rotation error is the geodesic angle 2·atan2(|v|,|w|) of q_import⁻¹·q_baked (robust near zero, independent of float32 norm drift).
- The manifest records `validation.kind = "geometric-only"`; passing these checks is not clinical validation.
