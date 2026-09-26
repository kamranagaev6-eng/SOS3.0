# Solver benchmark

Generated 2026-09-26T03:36:13.972Z by `node --expose-gc bench/solver-bench.ts`.

Environment: Node v24.21.0 (V8 13.6.233.17-node.53), linux 6.18.44-fc-v37, Intel(R) Xeon(R) Processor @ 2.10GHz, 4 logical cores, 16.9 GB RAM. Shared cloud container; single-threaded measurements; timings include JIT warm-up of 200 calls per tier.

## samplePose cost per call (µs), shuffled times (seek-like access)

| Recipe | Tier | n | min | p50 | p95 | p99 | max | mean | samples needing stabiliser iterations | max iterations |
|---|---|---|---|---|---|---|---|---|---|---|
| sit-to-stand.v1 | analytic | 3000 | 18.4 | 20.8 | 30.2 | 56.2 | 366.2 | 23.4 | 0 | 0 |
| sit-to-stand.v1 | stabilized | 3000 | 19.6 | 21.6 | 30.8 | 57.8 | 310.8 | 24.0 | 0 | 0 |
| sit-to-stand.v1 | baseline | 3000 | 27.1 | 34.6 | 58.9 | 105.7 | 399.9 | 38.9 | 0 | 0 |
| bilateral-squat.v1 | analytic | 3000 | 19.3 | 23.0 | 39.4 | 59.2 | 335.1 | 26.1 | 0 | 0 |
| bilateral-squat.v1 | stabilized | 3000 | 20.9 | 24.3 | 37.2 | 59.8 | 424.4 | 27.3 | 0 | 0 |
| bilateral-squat.v1 | baseline | 3000 | 29.1 | 35.6 | 59.2 | 85.4 | 852.3 | 40.4 | 0 | 0 |
| step-up-down.v1 | analytic | 3000 | 22.8 | 27.1 | 40.9 | 61.0 | 616.7 | 29.8 | 0 | 0 |
| step-up-down.v1 | stabilized | 3000 | 23.5 | 28.3 | 69.6 | 180.1 | 583.4 | 36.8 | 134 | 2 |
| step-up-down.v1 | baseline | 3000 | 33.0 | 41.1 | 100.6 | 207.9 | 607.0 | 51.1 | 0 | 0 |
| bilateral-heel-raise.v1 | analytic | 3000 | 21.8 | 25.5 | 44.7 | 67.0 | 1964.6 | 29.7 | 0 | 0 |
| bilateral-heel-raise.v1 | stabilized | 3000 | 23.2 | 26.7 | 40.8 | 63.6 | 420.9 | 29.7 | 0 | 0 |
| bilateral-heel-raise.v1 | baseline | 3000 | 32.0 | 42.1 | 83.3 | 117.5 | 2057.3 | 52.8 | 0 | 0 |

## Compile, bake and analysis

| Recipe | Clip (s) | Compile p50 (ms) | Compile max (ms) | Bake 60 fps (frames / ms / heap MB) | Analyse 240 Hz streamed (samples / ms / heap MB after) |
|---|---|---|---|---|---|
| sit-to-stand.v1 | 8.3 | 83.0 | 225.3 | 499 / 19.3 / 20.6 | 1993 / 125.0 / 19.5 |
| bilateral-squat.v1 | 11.6 | 117.3 | 130.5 | 697 / 26.3 / 11.1 | 2785 / 145.1 / 25.3 |
| step-up-down.v1 | 10.8 | 138.7 | 199.1 | 649 / 27.9 / 15.1 | 2593 / 163.2 / 20.4 |
| bilateral-heel-raise.v1 | 11.0 | 113.8 | 165.6 | 661 / 19.3 / 64.6 | 2641 / 140.6 / 38.5 |

Rendering cost is measured separately in the browser (see RENDER_BENCH / evidence/render-bench.json).
