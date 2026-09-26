# Geometric metrics report

> Geometric/kinematic checks of synthetic, unreviewed fixtures. Passing them is **not** clinical validation and says nothing about balance, loading, muscle activity or safety.

Generated 2026-09-26T03:34:17.545Z by `node scripts/metrics-report.ts` in 240.5 s.
Environment: Node v24.21.0, linux 6.18.44-fc-v37, Intel(R) Xeon(R) Processor @ 2.10GHz × 4.
Sampling: tiers 1 and 2 at 240 Hz (streamed), baseline at 60 Hz (defaults only).

## Summary

| Configurations | Compiled | Rejected with diagnostics | Feasible (compile scan) | Tier 1 within tolerance | Tier 2 within tolerance | Feasible but out of tolerance |
|---|---|---|---|---|---|---|
| 488 | 469 | 19 | 469 | 350 | 469 | 0 |

## Worst case per recipe (compiled configurations)

| Recipe | Tier | Planted disp. (mm) | Contact err (mm) | Orientation (°) | Penetration (mm) | Bone rel. err | Joint vel. jump (rad/s) | Linear vel. jump (m/s) | Max stabilisation (mm) | Limit violations | Unreachable samples |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sit-to-stand.v1 | baseline (defaults) | 646.065 | 646.065 | 22.000 | 477.701 | 1.4e-15 | 0.254 | 0.098 | 0.000 | 0 | 0 |
| sit-to-stand.v1 | analytic | 0.000 | 0.000 | 0.000 | 0.000 | 1.6e-15 | 0.155 | 0.060 | 0.000 | 0 | 0 |
| sit-to-stand.v1 | stabilized | 0.000 | 0.000 | 0.000 | 0.000 | 1.6e-15 | 0.155 | 0.060 | 0.000 | 0 | 0 |
| bilateral-squat.v1 | baseline (defaults) | 507.463 | 507.463 | 16.500 | 0.000 | 1.9e-15 | 0.189 | 0.022 | 0.000 | 0 | 0 |
| bilateral-squat.v1 | analytic | 0.000 | 0.000 | 0.000 | 0.000 | 1.6e-15 | 0.057 | 0.006 | 0.000 | 0 | 0 |
| bilateral-squat.v1 | stabilized | 0.000 | 0.000 | 0.000 | 0.000 | 1.6e-15 | 0.057 | 0.006 | 0.000 | 0 | 0 |
| step-up-down.v1 | baseline (defaults) | 443.632 | 470.213 | 5.500 | 34.351 | 9.3e-16 | 0.688 | 0.100 | 0.000 | 0 | 0 |
| step-up-down.v1 | analytic | 3.326 | 3.326 | 0.000 | 0.000 | 1.6e-15 | 13.500 | 0.100 | 0.000 | 0 | 9434 |
| step-up-down.v1 | stabilized | 0.000 | 0.000 | 0.000 | 0.000 | 1.6e-15 | 0.500 | 0.100 | 3.452 | 0 | 0 |
| bilateral-heel-raise.v1 | baseline (defaults) | 46.321 | 46.321 | 0.000 | 40.250 | 9.3e-16 | 0.030 | 0.003 | 0.000 | 0 | 0 |
| bilateral-heel-raise.v1 | analytic | 0.000 | 0.000 | 0.000 | 0.000 | 1.1e-15 | 0.016 | 0.002 | 0.000 | 0 | 0 |
| bilateral-heel-raise.v1 | stabilized | 0.000 | 0.000 | 0.000 | 0.000 | 1.1e-15 | 0.016 | 0.002 | 0.000 | 0 | 0 |

## Tier 1 → tier 2 (does the stabiliser earn its complexity?)

| Recipe | Configs | Tier 1 in tolerance | Tier 2 in tolerance | Configs where tier 2 needed a correction | Median of max correction (mm) |
|---|---|---|---|---|---|
| sit-to-stand.v1 | 120 | 120 | 120 | 0 | — |
| bilateral-squat.v1 | 128 | 128 | 128 | 0 | — |
| step-up-down.v1 | 133 | 14 | 133 | 132 | 1.196 |
| bilateral-heel-raise.v1 | 88 | 88 | 88 | 0 | — |

## Rejected configurations (explicit diagnostics, no motion produced)

| Recipe | Rig | Config | First diagnostic |
|---|---|---|---|
| bilateral-squat.v1 | synthetic-rig-a | depthKneeFlexionDeg=max | UNSUPPORTED_CONFIGURATION: bottom pose needs 35.0° ankle dorsiflexion with heels down; rig limit is 35.0° (headroom 2.0°) |
| bilateral-squat.v1 | rig-a-short-legs | depthKneeFlexionDeg=max | UNSUPPORTED_CONFIGURATION: bottom pose needs 35.0° ankle dorsiflexion with heels down; rig limit is 35.0° (headroom 2.0°) |
| bilateral-squat.v1 | rig-a-long-legs | depthKneeFlexionDeg=max | UNSUPPORTED_CONFIGURATION: bottom pose needs 35.0° ankle dorsiflexion with heels down; rig limit is 35.0° (headroom 2.0°) |
| bilateral-squat.v1 | rig-a-long-trunk | depthKneeFlexionDeg=max | UNSUPPORTED_CONFIGURATION: bottom pose needs 35.0° ankle dorsiflexion with heels down; rig limit is 35.0° (headroom 2.0°) |
| bilateral-squat.v1 | rig-a-big-feet | depthKneeFlexionDeg=max | UNSUPPORTED_CONFIGURATION: bottom pose needs 35.0° ankle dorsiflexion with heels down; rig limit is 35.0° (headroom 2.0°) |
| bilateral-squat.v1 | rig-a-small | depthKneeFlexionDeg=max | UNSUPPORTED_CONFIGURATION: bottom pose needs 35.0° ankle dorsiflexion with heels down; rig limit is 35.0° (headroom 2.0°) |
| bilateral-squat.v1 | rig-a-lld | depthKneeFlexionDeg=max | UNSUPPORTED_CONFIGURATION: bottom pose needs 35.0° ankle dorsiflexion with heels down; rig limit is 35.0° (headroom 2.0°) |
| bilateral-squat.v1 | synthetic-rig-b-host.derived | depthKneeFlexionDeg=max | UNSUPPORTED_CONFIGURATION: bottom pose needs 35.0° ankle dorsiflexion with heels down; rig limit is 35.0° (headroom 2.0°) |
| step-up-down.v1 | synthetic-rig-a | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | rig-a-short-legs | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | rig-a-long-legs | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | rig-a-long-trunk | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | rig-a-big-feet | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.353 m needed) |
| step-up-down.v1 | rig-a-big-feet | random#1 | UNSUPPORTED_CONFIGURATION: step tread 0.32 m is too shallow for the left foot (0.353 m needed) |
| step-up-down.v1 | rig-a-big-feet | random#3 | UNSUPPORTED_CONFIGURATION: step tread 0.33 m is too shallow for the left foot (0.353 m needed) |
| step-up-down.v1 | rig-a-lld | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | synthetic-rig-b-host.derived | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.341 m needed) |
| step-up-down.v1 | synthetic-rig-b-host.derived | random#1 | UNSUPPORTED_CONFIGURATION: step tread 0.32 m is too shallow for the left foot (0.341 m needed) |
| step-up-down.v1 | synthetic-rig-b-host.derived | random#3 | UNSUPPORTED_CONFIGURATION: step tread 0.33 m is too shallow for the left foot (0.341 m needed) |

## Compiled but infeasible or out of tolerance

None.
