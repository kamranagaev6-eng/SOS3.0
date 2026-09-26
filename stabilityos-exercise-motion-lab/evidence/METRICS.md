# Geometric metrics report

> Geometric/kinematic checks of synthetic, unreviewed fixtures. Passing them is **not** clinical validation and says nothing about balance, loading, muscle activity or safety.

Generated 2026-09-26T02:24:34.696Z by `node scripts/metrics-report.ts` in 131.4 s.
Environment: Node v24.21.0, linux 6.18.44-fc-v37, Intel(R) Xeon(R) Processor @ 2.10GHz × 4.
Sampling: tiers 1 and 2 at 240 Hz (streamed), baseline at 60 Hz (defaults only).

## Summary

| Configurations | Compiled | Rejected with diagnostics | Feasible (compile scan) | Tier 1 within tolerance | Tier 2 within tolerance | Feasible but out of tolerance |
|---|---|---|---|---|---|---|
| 427 | 395 | 32 | 386 | 304 | 386 | 0 |

## Worst case per recipe (compiled configurations)

| Recipe | Tier | Planted disp. (mm) | Contact err (mm) | Orientation (°) | Penetration (mm) | Bone rel. err | Joint vel. jump (rad/s) | Linear vel. jump (m/s) | Max stabilisation (mm) | Limit violations | Unreachable samples |
|---|---|---|---|---|---|---|---|---|---|---|---|
| sit-to-stand.v1 | baseline (defaults) | 645.850 | 645.850 | 22.000 | 469.168 | 1.4e-15 | 0.254 | 0.098 | 0.000 | 0 | 0 |
| sit-to-stand.v1 | analytic | 0.000 | 0.000 | 0.000 | 0.000 | 1.4e-15 | 0.155 | 0.060 | 0.000 | 0 | 0 |
| sit-to-stand.v1 | stabilized | 0.000 | 0.000 | 0.000 | 0.000 | 1.4e-15 | 0.155 | 0.060 | 0.000 | 0 | 0 |
| bilateral-squat.v1 | baseline (defaults) | 507.463 | 507.463 | 16.500 | 0.000 | 1.9e-15 | 0.188 | 0.022 | 0.000 | 0 | 0 |
| bilateral-squat.v1 | analytic | 0.000 | 0.000 | 0.000 | 0.000 | 1.4e-15 | 0.057 | 0.006 | 0.000 | 0 | 0 |
| bilateral-squat.v1 | stabilized | 0.000 | 0.000 | 0.000 | 0.000 | 1.4e-15 | 0.057 | 0.006 | 0.000 | 0 | 0 |
| step-up-down.v1 | baseline (defaults) | 443.632 | 470.213 | 5.500 | 31.755 | 9.3e-16 | 0.586 | 0.100 | 0.000 | 0 | 0 |
| step-up-down.v1 | analytic | 15.537 | 15.537 | 4.136 | 14.146 | 1.6e-15 | 13.500 | 0.092 | 0.000 | 0 | 7449 |
| step-up-down.v1 | stabilized | 15.537 | 15.537 | 4.136 | 14.146 | 1.6e-15 | 0.500 | 0.092 | 3.452 | 0 | 0 |
| bilateral-heel-raise.v1 | baseline (defaults) | 46.321 | 46.321 | 0.000 | 40.050 | 9.3e-16 | 0.030 | 0.003 | 0.000 | 0 | 0 |
| bilateral-heel-raise.v1 | analytic | 0.000 | 0.000 | 0.000 | 0.000 | 1.1e-15 | 0.016 | 0.002 | 0.000 | 0 | 0 |
| bilateral-heel-raise.v1 | stabilized | 0.000 | 0.000 | 0.000 | 0.000 | 1.1e-15 | 0.016 | 0.002 | 0.000 | 0 | 0 |

## Tier 1 → tier 2 (does the stabiliser earn its complexity?)

| Recipe | Configs | Tier 1 in tolerance | Tier 2 in tolerance | Configs where tier 2 needed a correction | Median of max correction (mm) |
|---|---|---|---|---|---|
| sit-to-stand.v1 | 105 | 105 | 105 | 0 | — |
| bilateral-squat.v1 | 112 | 112 | 112 | 0 | — |
| step-up-down.v1 | 101 | 10 | 92 | 101 | 1.196 |
| bilateral-heel-raise.v1 | 77 | 77 | 77 | 0 | — |

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
| step-up-down.v1 | synthetic-rig-a | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | rig-a-short-legs | stepHeight=min | KEYPOSE_UNSOLVED: could not solve the 'transfer-back' key pose (residual 1.40e-1) |
| step-up-down.v1 | rig-a-short-legs | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | rig-a-long-legs | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | rig-a-long-trunk | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | rig-a-big-feet | stepHeight=min | KEYPOSE_UNSOLVED: could not solve the 'transfer-back' key pose (residual 2.55e-1) |
| step-up-down.v1 | rig-a-big-feet | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.353 m needed) |
| step-up-down.v1 | rig-a-big-feet | startDistance=max | KEYPOSE_UNSOLVED: could not solve the 'transfer-back' key pose (residual 9.49e-2) |
| step-up-down.v1 | rig-a-big-feet | random#1 | UNSUPPORTED_CONFIGURATION: step tread 0.32 m is too shallow for the left foot (0.353 m needed) |
| step-up-down.v1 | rig-a-big-feet | random#3 | UNSUPPORTED_CONFIGURATION: step tread 0.33 m is too shallow for the left foot (0.353 m needed) |
| step-up-down.v1 | rig-a-lld | defaults | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | upLeadSide=left,downLeadSide=right | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | upLeadSide=right,downLeadSide=left | KEYPOSE_UNSOLVED: could not solve the 'lower-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | stepHeight=min | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | stepHeight=max | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | stepDepth=min | UNSUPPORTED_CONFIGURATION: step tread 0.3 m is too shallow for the left foot (0.315 m needed) |
| step-up-down.v1 | rig-a-lld | stepDepth=max | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | startDistance=min | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | startDistance=max | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | stanceWidth=min | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.93e-1) |
| step-up-down.v1 | rig-a-lld | tempo=min | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | tempo=max | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.39e-1) |
| step-up-down.v1 | rig-a-lld | random#0 | KEYPOSE_UNSOLVED: could not solve the 'lower-shift' key pose (residual 1.80e-1) |
| step-up-down.v1 | rig-a-lld | random#1 | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 9.09e-2) |
| step-up-down.v1 | rig-a-lld | random#3 | KEYPOSE_UNSOLVED: could not solve the 'weight-shift' key pose (residual 1.62e-1) |

## Compiled but infeasible or out of tolerance

| Recipe | Rig | Config | Compile scan feasible | Tier 2 failures |
|---|---|---|---|---|
| step-up-down.v1 | synthetic-rig-a | random#3 | false | contact position error 8.634 mm > 1.000 mm; planted displacement 8.634 mm > 1.000 mm; contact orientation error 2.298° > 1°; penetration 7.927 mm > 1.000 mm; 158 non-converged samples |
| step-up-down.v1 | rig-a-short-legs | stepHeight=max | false | contact position error 4.893 mm > 1.000 mm; planted displacement 4.893 mm > 1.000 mm; contact orientation error 1.302° > 1°; penetration 4.507 mm > 1.000 mm; 132 non-converged samples |
| step-up-down.v1 | rig-a-short-legs | random#3 | false | contact position error 15.537 mm > 1.000 mm; planted displacement 15.537 mm > 1.000 mm; contact orientation error 4.136° > 1°; penetration 14.146 mm > 1.000 mm; 206 non-converged samples |
| step-up-down.v1 | rig-a-long-legs | random#3 | false | contact position error 2.260 mm > 1.000 mm; planted displacement 2.260 mm > 1.000 mm; penetration 2.089 mm > 1.000 mm; 81 non-converged samples |
| step-up-down.v1 | rig-a-long-trunk | random#3 | false | contact position error 8.634 mm > 1.000 mm; planted displacement 8.634 mm > 1.000 mm; contact orientation error 2.298° > 1°; penetration 7.927 mm > 1.000 mm; 158 non-converged samples |
| step-up-down.v1 | rig-a-big-feet | stepHeight=max | false | contact position error 4.470 mm > 1.000 mm; planted displacement 4.470 mm > 1.000 mm; contact orientation error 1.034° > 1°; penetration 6.653 mm > 1.000 mm; 109 non-converged samples |
| step-up-down.v1 | rig-a-big-feet | random#0 | false | penetration 1.551 mm > 1.000 mm |
| step-up-down.v1 | rig-a-small | stepHeight=max | false | contact position error 2.676 mm > 1.000 mm; planted displacement 2.676 mm > 1.000 mm; penetration 2.473 mm > 1.000 mm; 113 non-converged samples |
| step-up-down.v1 | rig-a-small | random#3 | false | contact position error 11.208 mm > 1.000 mm; planted displacement 11.208 mm > 1.000 mm; contact orientation error 3.390° > 1°; penetration 10.251 mm > 1.000 mm; 196 non-converged samples |
