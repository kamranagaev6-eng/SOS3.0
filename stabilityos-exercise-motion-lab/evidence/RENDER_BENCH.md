# Render benchmark (browser)

> Engine sampling and rendering are measured separately per rAF-paced frame. Render timings include renderer.render CPU time and, separately, render + gl.finish(). WebGL ran on a SOFTWARE rasteriser (SwiftShader) in a headless container: render numbers are software-rendered and NOT representative of client GPUs.

Generated 2026-09-26T03:40:08.288Z by `npm run bench:render` (Playwright, project `bench`). Browser: chromium 141.0.7390.37; WebGL renderer: ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver); host CPU: Intel(R) Xeon(R) Processor @ 2.10GHz, 4 threads; viewport 1280×800.

Method: framesPerRun: 600; warmupFrames: 10; timeStep: 1/60 s, wrapping at the clip duration; solverTier: stabilized (plus baseline in comparison mode); overlays: workbench defaults (contact targets, sites, residuals, trajectory, failures); pacing: requestAnimationFrame (one measured frame per callback); clock: performance.now(); Chromium clamps it (see timerResolutionMs per run), so sub-resolution values read as 0.

Values in milliseconds as p50 / p95 / p99 / max over the measured frames. Engine sampling and rendering are timed separately.

| Recipe | Mode | Frames | Draw calls | Triangles | Engine sampling | Stage update | renderer.render CPU | render + gl.finish | Whole frame work | rAF interval |
|---|---|---|---|---|---|---|---|---|---|---|
| sit-to-stand.v1 | normal (stabilized) | 600 | 49 | 10190 | 0.1 / 0.2 / 0.3 / 7.6 | 0.1 / 0.1 / 0.2 / 0.9 | 0.5 / 1.4 / 4.4 / 6.1 | 0.5 / 1.7 / 4.5 / 6.1 | 0.8 / 2.6 / 4.9 / 8.3 | 33.4 / 50.1 / 66.7 / 66.8 |
| sit-to-stand.v1 | comparison (baseline + stabilized, split viewport) | 600 | 102 | 21940 | 0.2 / 0.3 / 0.6 / 3.1 | 0.1 / 0.2 / 0.2 / 3.3 | 0.7 / 3.0 / 4.4 / 93.1 | 0.7 / 3.0 / 4.4 / 93.1 | 1.1 / 3.5 / 4.9 / 94.0 | 50.0 / 66.7 / 83.4 / 100.0 |
| bilateral-squat.v1 | normal (stabilized) | 600 | 40 | 10038 | 0.1 / 0.2 / 0.3 / 4.1 | 0.0 / 0.1 / 0.1 / 1.9 | 0.4 / 0.8 / 3.8 / 6.1 | 0.4 / 1.1 / 4.2 / 6.2 | 0.6 / 2.0 / 4.6 / 6.5 | 33.4 / 50.1 / 66.7 / 66.7 |
| bilateral-squat.v1 | comparison (baseline + stabilized, split viewport) | 600 | 84 | 21636 | 0.2 / 0.3 / 0.4 / 3.9 | 0.1 / 0.1 / 0.2 / 0.9 | 0.6 / 1.2 / 2.7 / 4.8 | 0.6 / 1.3 / 3.5 / 7.3 | 0.9 / 1.8 / 4.2 / 7.6 | 50.0 / 66.7 / 83.4 / 100.0 |
| step-up-down.v1 | normal (stabilized) | 600 | 39 | 9858 | 0.1 / 0.3 / 0.4 / 4.5 | 0.0 / 0.1 / 0.2 / 0.2 | 0.4 / 0.8 / 4.0 / 4.7 | 0.4 / 0.9 / 4.1 / 5.2 | 0.6 / 1.4 / 4.4 / 5.4 | 33.4 / 50.1 / 66.7 / 116.6 |
| step-up-down.v1 | comparison (baseline + stabilized, split viewport) | 600 | 76 | 19548 | 0.2 / 0.5 / 2.3 / 3.5 | 0.1 / 0.2 / 0.2 / 1.3 | 0.6 / 1.4 / 4.7 / 6.4 | 0.6 / 1.7 / 4.8 / 8.3 | 1.0 / 3.2 / 5.2 / 8.6 | 50.0 / 66.7 / 83.4 / 100.1 |
| bilateral-heel-raise.v1 | normal (stabilized) | 600 | 38 | 9910 | 0.1 / 0.2 / 0.3 / 4.6 | 0.0 / 0.1 / 0.1 / 0.5 | 0.4 / 0.6 / 5.0 / 5.6 | 0.4 / 0.7 / 5.0 / 5.6 | 0.6 / 1.1 / 5.2 / 5.9 | 33.4 / 50.1 / 66.6 / 100.0 |
| bilateral-heel-raise.v1 | comparison (baseline + stabilized, split viewport) | 600 | 74 | 19652 | 0.2 / 0.3 / 1.6 / 8.1 | 0.1 / 0.2 / 0.2 / 2.4 | 0.6 / 1.2 / 4.0 / 6.4 | 0.6 / 1.2 / 4.0 / 6.4 | 1.0 / 1.8 / 4.8 / 9.0 | 50.0 / 66.8 / 83.4 / 100.0 |

Reading: per-frame engine work (sampling, twice in comparison mode) is ~0.1–0.3 ms at p50; CPU-side render submission is sub-millisecond at p50. The rAF interval (≈33–50 ms) is dominated by the software rasteriser in the GPU process, which this container substitutes for a GPU; it says nothing about client devices.
