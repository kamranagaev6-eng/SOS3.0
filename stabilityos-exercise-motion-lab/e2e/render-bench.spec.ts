import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { expect, test } from '@playwright/test';
import type { RenderBenchRun } from '../src/app/testHooks.ts';

/**
 * In-browser benchmark of the workbench's per-frame work, measured SEPARATELY:
 *   (a) engine sampling (samplePose ×1, or ×2 in comparison mode),
 *   (b) stage update (pose → Object3D transforms and overlays),
 *   (c) render: CPU time inside renderer.render (all viewports), and render + gl.finish().
 * ≥600 frames per recipe and mode, after a 10-frame warm-up. Results go to evidence/render-bench.json.
 * In this container WebGL runs on SwiftShader (CPU rasteriser): render numbers are software-rendered
 * and NOT representative of client GPUs.
 */

const RECIPES = ['sit-to-stand.v1', 'bilateral-squat.v1', 'step-up-down.v1', 'bilateral-heel-raise.v1'];
const FRAMES = 600;

interface Dist {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

function dist(values: number[]): Dist {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number): number => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))]!;
  const r = (x: number): number => Math.round(x * 10000) / 10000;
  return { n: v.length, min: r(v[0]!), p50: r(q(0.5)), p95: r(q(0.95)), p99: r(q(0.99)), max: r(v[v.length - 1]!), mean: r(v.reduce((a, b) => a + b, 0) / v.length) };
}

test('render benchmark: engine sampling vs rendering, normal and comparison modes', async ({ page, browser }) => {
  test.setTimeout(1_200_000);
  await page.goto('/');
  await page.waitForFunction(() => window.__motionLab?.getState().planOk === true, null, { timeout: 30_000 });
  const results: Record<string, unknown>[] = [];
  let gpu: RenderBenchRun['gpu'] = null;
  for (const id of RECIPES) {
    await page.getByTestId('recipe-select').selectOption(id);
    await page.waitForFunction((rid) => {
      const s = window.__motionLab?.getState();
      return !!s && s.planOk && s.recipeId === rid;
    }, id);
    await page.evaluate(() => window.__motionLab!.pause());
    for (const comparison of [false, true]) {
      const run = await page.evaluate((o) => window.__motionLab!.runRenderBench(o), { frames: FRAMES, comparison, finish: true, fps: 60 });
      expect(run.frames).toBe(FRAMES);
      expect(run.sampleMs.length).toBe(FRAMES);
      gpu ??= run.gpu;
      results.push({
        recipeId: id,
        mode: comparison ? 'comparison (baseline + stabilized, split viewport)' : 'normal (stabilized)',
        frames: run.frames,
        samplePoseCallsPerFrame: run.samplesPerFrame,
        canvasCssPx: run.canvas,
        drawCallsPerFrame: run.stats?.drawCalls ?? null,
        trianglesPerFrame: run.stats?.triangles ?? null,
        ms: {
          engineSampling: dist(run.sampleMs),
          stageUpdate: dist(run.updateMs),
          renderCpu: dist(run.renderCpuMs),
          renderPlusGlFinish: dist(run.renderFinishMs),
          wholeFrame: dist(run.frameMs),
        },
      });
    }
  }
  const renderer = gpu?.renderer ?? 'unknown';
  const software = /swiftshader|llvmpipe|software/i.test(renderer);
  const report = {
    generatedAt: new Date().toISOString(),
    kind: 'workbench render benchmark (in-browser, Playwright)',
    statement:
      'Engine sampling and rendering are measured separately per frame. Render timings include renderer.render CPU time and, separately, render + gl.finish(). ' +
      (software
        ? 'WebGL ran on a SOFTWARE rasteriser (SwiftShader) in a headless container: render numbers are software-rendered and NOT representative of client GPUs.'
        : 'WebGL renderer as reported below.'),
    softwareRendered: software,
    environment: {
      browser: `${browser.browserType().name()} ${browser.version()}`,
      userAgent: await page.evaluate(() => navigator.userAgent),
      webglRenderer: renderer,
      webglVendor: gpu?.vendor ?? 'unknown',
      webglVersion: gpu?.webglVersion ?? 'unknown',
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
      viewport: page.viewportSize(),
      host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus()[0]?.model ?? 'unknown', cpuCount: os.cpus().length, node: process.version },
    },
    method: {
      framesPerRun: FRAMES,
      warmupFrames: 10,
      timeStep: '1/60 s, wrapping at the clip duration',
      solverTier: 'stabilized (plus baseline in comparison mode)',
      overlays: 'workbench defaults (contact targets, sites, residuals, trajectory, failures)',
      clock: 'performance.now() (browser-clamped resolution)',
    },
    results,
  };
  mkdirSync('evidence', { recursive: true });
  writeFileSync('evidence/render-bench.json', `${JSON.stringify(report, null, 2)}\n`);
  console.log(`render bench: ${results.length} runs, renderer: ${renderer}${software ? ' (software)' : ''}`);
});
