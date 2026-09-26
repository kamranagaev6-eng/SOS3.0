import { mkdirSync, readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import type { MotionLabState } from '../src/app/testHooks.ts';

/**
 * Workbench end-to-end tests against the REAL engine (vite preview build). Screenshots written to
 * evidence/screenshots are real captures of the rendered page (WebGL via Chromium's SwiftShader
 * software rasteriser in this container).
 */

const RECIPES = [
  { id: 'sit-to-stand.v1', showcase: 'rise' },
  { id: 'bilateral-squat.v1', showcase: 'bottom-1' },
  { id: 'step-up-down.v1', showcase: null },
  { id: 'bilateral-heel-raise.v1', showcase: 'top-1' },
] as const;

const SHOTS = 'evidence/screenshots';
mkdirSync(SHOTS, { recursive: true });

function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function state(page: Page): Promise<MotionLabState> {
  return page.evaluate(() => window.__motionLab!.getState());
}

async function ready(page: Page, recipeId?: string): Promise<MotionLabState> {
  await page.waitForFunction(
    (id) => {
      const s = window.__motionLab?.getState();
      return !!s && s.planOk && (!id || s.recipeId === id);
    },
    recipeId ?? null,
    { timeout: 30_000 },
  );
  return state(page);
}

async function selectRecipe(page: Page, id: string): Promise<MotionLabState> {
  await page.getByTestId('recipe-select').selectOption(id);
  return ready(page, id);
}

/** Keyboard focus on a neutral element so global shortcuts apply. */
async function focusNeutral(page: Page): Promise<void> {
  await page.locator('.app-footer').click({ position: { x: 5, y: 5 } });
}

function phaseAt(s: MotionLabState, t: number): { id: string; label: string } {
  let cur = s.phases[0]!;
  for (const p of s.phases) if (t >= p.start - 1e-9) cur = p;
  return cur;
}

async function waitRendered(page: Page): Promise<void> {
  // Two animation frames: pose sampled, stage rendered.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

test.describe('workbench', () => {
  test('loads with the persistent synthetic badge and a working WebGL stage', async ({ page }) => {
    const errors = trackConsole(page);
    await page.goto('/');
    const s = await ready(page);
    await expect(page.getByTestId('synthetic-badge')).toContainText('Synthetic · unreviewed engineering fixture');
    await expect(page.getByTestId('synthetic-badge')).toContainText('not clinical guidance');
    expect(s.webgl).toBe(true);
    expect(s.stats?.drawCalls ?? 0).toBeGreaterThan(10);
    // Badge stays visible after scrolling (sticky header).
    await page.mouse.wheel(0, 1500);
    await expect(page.getByTestId('synthetic-badge')).toBeInViewport();
    // Autoplay without reduced motion.
    await expect.poll(async () => (await state(page)).t, { timeout: 5000 }).toBeGreaterThan(0.05);
    expect(errors).toEqual([]);
  });

  for (const r of RECIPES) {
    test(`recipe ${r.id}: timeline, keyboard, scrubbing, speed, views, overlays, comparison, params`, async ({ page }) => {
      const errors = trackConsole(page);
      await page.goto('/');
      await ready(page);
      let s = await selectRecipe(page, r.id);
      await expect(page.getByTestId('recipe-id')).toHaveText(r.id);
      await expect(page.getByTestId('recipe-title')).not.toBeEmpty();

      // Timeline: one segment per plan phase, labelled; cue markers rendered.
      expect(s.phases.length).toBeGreaterThan(1);
      await expect(page.getByTestId('phase-segment')).toHaveCount(s.phases.length);
      for (const p of s.phases) await expect(page.locator(`[data-testid="phase-segment"][data-phase-id="${p.id}"]`)).toContainText(p.label);

      // Play / pause via keyboard (Space).
      await focusNeutral(page);
      const wasPlaying = (await state(page)).playing;
      await page.keyboard.press('Space');
      await expect.poll(async () => (await state(page)).playing).toBe(!wasPlaying);
      await page.keyboard.press('Space');
      await expect.poll(async () => (await state(page)).playing).toBe(wasPlaying);
      if (!wasPlaying) {
        await page.keyboard.press('Space');
      }
      // Now playing: time advances; pause and time freezes.
      const t0 = (await state(page)).t;
      await page.waitForTimeout(400);
      await page.keyboard.press('Space');
      await expect.poll(async () => (await state(page)).playing).toBe(false);
      const tp = (await state(page)).t;
      expect(tp).not.toBe(t0);
      await page.waitForTimeout(300);
      expect((await state(page)).t).toBe(tp);

      // Scrub (range input) to specific times; displayed time and phase follow.
      for (const frac of [0.15, 0.5, 0.82]) {
        const t = Math.round(s.phases[s.phases.length - 1]!.end * frac * 100) / 100;
        await page.getByTestId('scrubber').fill(String(t));
        await expect(page.getByTestId('time-readout')).toHaveText(`${t.toFixed(2)} s`);
        await expect(page.getByTestId('phase-readout')).toContainText(phaseAt(s, t).label);
        await expect(page.getByTestId('diag-time')).toHaveText(`${t.toFixed(3)} s`);
      }
      // Click on the timeline track seeks too.
      const box = (await page.getByTestId('timeline-track').boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.25, box.y + 10);
      s = await state(page);
      expect(Math.abs(s.t - 0.25 * s.duration)).toBeLessThan(0.03 * s.duration);

      // Frame stepping and phase jumps from the keyboard.
      await focusNeutral(page);
      await page.keyboard.press('Home');
      await expect.poll(async () => (await state(page)).t).toBe(0);
      await page.keyboard.press('ArrowRight');
      await expect.poll(async () => (await state(page)).t).toBeCloseTo(1 / 30, 6);
      await page.keyboard.press('ArrowLeft');
      await expect.poll(async () => (await state(page)).t).toBe(0);
      await page.keyboard.press('Shift+ArrowRight');
      await expect.poll(async () => (await state(page)).t).toBeCloseTo(s.phases[1]!.start, 9);
      await expect(page.getByTestId('phase-readout')).toContainText(s.phases[1]!.label);
      await page.keyboard.press('End');
      await expect.poll(async () => (await state(page)).t).toBeCloseTo(s.duration, 9);

      // Speed.
      await page.getByRole('radio', { name: '2×' }).check();
      await expect.poll(async () => (await state(page)).speed).toBe(2);
      await page.getByRole('radio', { name: '0.25×' }).check();
      await expect.poll(async () => (await state(page)).speed).toBe(0.25);
      await page.getByRole('radio', { name: '1×', exact: true }).check();

      // Views: keys 1-4 and the buttons.
      await focusNeutral(page);
      for (const [key, view] of [['1', 'front'], ['2', 'side-left'], ['3', 'side-right'], ['4', 'oblique']] as const) {
        await page.keyboard.press(key);
        await expect.poll(async () => (await state(page)).view).toBe(view);
      }
      await page.getByTestId('view-presets').getByText('Front', { exact: true }).click();
      await expect.poll(async () => (await state(page)).view).toBe('front');
      // Left/right inspection (L / R): side view from that side.
      await focusNeutral(page);
      await page.keyboard.press('l');
      await expect.poll(async () => (await state(page)).view).toBe('side-left');
      expect((await state(page)).inspectSide).toBe('left');
      await page.keyboard.press('r');
      await expect.poll(async () => (await state(page)).inspectSide).toBe('right');
      expect((await state(page)).view).toBe('side-right');
      await page.keyboard.press('r');
      await expect.poll(async () => (await state(page)).inspectSide).toBe(null);

      // Overlays: toggles change what is drawn (line count from renderer.info).
      await page.getByTestId('scrubber').fill(String((s.phases[1]!.start + s.phases[1]!.end) / 2));
      await waitRendered(page);
      const linesBefore = (await state(page)).stats!.lines;
      await page.getByTestId('overlay-jointAxes').check();
      await expect.poll(async () => (await state(page)).stats!.lines).toBeGreaterThan(linesBefore);
      await page.getByTestId('overlay-jointAxes').uncheck();
      for (const key of ['contactTargets', 'contactSites', 'residuals', 'trajectory', 'failures'] as const) {
        const cb = page.getByTestId(`overlay-${key}`);
        await cb.uncheck();
        await expect.poll(async () => (await state(page)).overlays[key]).toBe(false);
        await cb.check();
        await expect.poll(async () => (await state(page)).overlays[key]).toBe(true);
      }
      await page.getByTestId('overlay-magnifyResiduals').check();
      await expect(page.locator('.lg-mag')).toContainText('magnified');
      await page.getByTestId('overlay-magnifyResiduals').uncheck();

      // Comparison (C): split view, baseline beside the solved pose, labelled.
      await focusNeutral(page);
      const callsSingle = (await state(page)).stats!.drawCalls;
      await page.keyboard.press('c');
      await expect.poll(async () => (await state(page)).comparison).toBe(true);
      await expect(page.getByTestId('comparison-label-baseline')).toContainText('frozen pelvis');
      await expect(page.getByTestId('comparison-label-primary')).toContainText('Stabilized');
      await expect.poll(async () => (await state(page)).split).toBe('side-by-side');
      await expect.poll(async () => (await state(page)).stats!.drawCalls).toBeGreaterThan(callsSingle * 1.5);
      await page.keyboard.press('c');
      await expect.poll(async () => (await state(page)).comparison).toBe(false);

      // Parameter out of range: inline error, then reset to defaults clears it.
      const firstNumber = page.locator('[data-testid="param-editor"] input[type="number"]').first();
      const key = (await firstNumber.getAttribute('name'))!;
      const max = Number(await firstNumber.getAttribute('max'));
      await firstNumber.fill(String(max * 10 + 1));
      await expect(page.getByTestId(`param-error-${key}`)).toContainText('Must be between');
      await expect(firstNumber).toHaveAttribute('aria-invalid', 'true');
      await expect(page.getByTestId('param-banner')).toBeVisible();
      // Keys typed into the number field are not hijacked by shortcuts.
      await firstNumber.focus();
      await page.keyboard.press('c');
      expect((await state(page)).comparison).toBe(false);
      await page.getByTestId('reset-params').click();
      await expect(page.getByTestId(`param-error-${key}`)).toHaveCount(0);

      // Representative screenshot with overlays at a key phase.
      const showcase = s.phases.find((p) => p.id === r.showcase) ?? s.phases[Math.floor(s.phases.length / 2)]!;
      await page.getByTestId('overlay-magnifyResiduals').check();
      await page.getByTestId('view-presets').getByText('Oblique', { exact: true }).click();
      await page.evaluate((t) => window.__motionLab!.seek(t), (showcase.start + showcase.end) / 2);
      await expect(page.getByTestId('metrics-status')).toHaveText('Whole-clip metrics ready.', { timeout: 30_000 });
      await waitRendered(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/recipe-${r.id}.png` });

      expect(errors).toEqual([]);
    });
  }

  test('step-up/down: changing the leading side recompiles the plan', async ({ page }) => {
    const errors = trackConsole(page);
    await page.goto('/?recipe=step-up-down.v1');
    await ready(page, 'step-up-down.v1');
    const firstSwing = async (lane: number): Promise<number> => {
      const title = await page.locator('.contact-lane').nth(lane).locator('.foot-swing').first().getAttribute('title');
      return Number(/swing ([\d.]+) s/.exec(title ?? '')?.[1]);
    };
    const leftFirst = await firstSwing(0);
    const rightFirst = await firstSwing(1);
    expect(leftFirst).toBeLessThan(rightFirst); // default: left leads up
    await page.getByTestId('param-upLeadSide').selectOption('right');
    await expect.poll(async () => (await firstSwing(1)) < (await firstSwing(0)), { timeout: 10_000 }).toBe(true);
    await page.getByTestId('param-downLeadSide').selectOption('right');
    await expect(page.getByTestId('param-editor')).toContainText('Parameters valid.');
    const s = await state(page);
    const up = s.phases.find((p) => /up/i.test(p.id)) ?? s.phases[1]!;
    await page.evaluate((t) => window.__motionLab!.seek(t), (up.start + up.end) / 2);
    await expect(page.getByTestId('metrics-status')).toHaveText('Whole-clip metrics ready.', { timeout: 30_000 });
    await waitRendered(page);
    await page.screenshot({ path: `${SHOTS}/step-up-right-lead.png` });
    expect(errors).toEqual([]);
  });

  for (const [id, phaseMatch] of [
    ['bilateral-squat.v1', /bottom/],
    ['sit-to-stand.v1', /rise/],
  ] as const) {
    test(`comparison view: ${id} baseline vs stabilized`, async ({ page }) => {
      const errors = trackConsole(page);
      await page.goto(`/?recipe=${id}`);
      const s = await ready(page, id);
      await page.getByTestId('comparison-toggle').check();
      await expect.poll(async () => (await state(page)).comparison).toBe(true);
      await page.getByTestId('view-presets').getByText('Left side', { exact: true }).click();
      const p = s.phases.find((x) => phaseMatch.test(x.id)) ?? s.phases[1]!;
      await page.evaluate((t) => window.__motionLab!.seek(t), p.end - 0.05 * (p.end - p.start));
      await expect(page.getByTestId('metrics-status')).toHaveText('Whole-clip metrics ready.', { timeout: 30_000 });
      // Baseline must show the failure the engine replaces; the stabilized tier must not.
      await expect(page.getByTestId('within-baseline')).toHaveText('no');
      await expect(page.getByTestId('within-stabilized')).toHaveText('yes');
      await waitRendered(page);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/comparison-${id}.png` });
      expect(errors).toEqual([]);
    });
  }

  test('reduced motion: static inspection, no autoplay, key poses seek', async ({ page }) => {
    const errors = trackConsole(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?recipe=bilateral-squat.v1');
    const s = await ready(page, 'bilateral-squat.v1');
    await expect(page.getByTestId('static-inspection')).toBeVisible();
    await page.waitForTimeout(1200);
    const after = await state(page);
    expect(after.playing).toBe(false);
    expect(after.t).toBe(0);
    expect(after.staticMode).toBe(true);
    const buttons = page.getByTestId('keypose-button');
    await expect(buttons).toHaveCount(s.phases.length + 1);
    await buttons.nth(2).click();
    await expect.poll(async () => (await state(page)).t).toBeCloseTo(s.phases[2]!.start, 9);
    await expect(page.getByTestId('phase-readout')).toContainText(s.phases[2]!.label);
    await expect(buttons.nth(2)).toHaveAttribute('aria-pressed', 'true');
    // View changes are immediate (no tween) — a view switch leaves nothing animating.
    await focusNeutral(page);
    await page.keyboard.press('2');
    await expect.poll(async () => (await state(page)).view).toBe('side-left');
    await waitRendered(page);
    await page.screenshot({ path: `${SHOTS}/reduced-motion-static-inspection.png` });
    expect(errors).toEqual([]);
  });

  test('mobile 390×844: stacked layout without horizontal scroll', async ({ page }) => {
    const errors = trackConsole(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await ready(page);
    const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
    expect(overflow.sw).toBeLessThanOrEqual(overflow.cw);
    expect(overflow.bw).toBeLessThanOrEqual(overflow.cw);
    await expect(page.getByTestId('synthetic-badge')).toBeVisible();
    await expect(page.getByTestId('stage-canvas')).toBeVisible();
    const canvas = (await page.getByTestId('stage-canvas').boundingBox())!;
    expect(canvas.width).toBeLessThanOrEqual(390);
    await page.screenshot({ path: `${SHOTS}/mobile-390x844.png` });
    await page.getByTestId('stage-canvas').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/mobile-390x844-stage.png` });
    // Comparison stacks vertically on a narrow stage.
    await page.getByTestId('comparison-toggle').check();
    await expect.poll(async () => (await state(page)).split).toBe('stacked');
    const overflow2 = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(overflow2).toBe(true);
    expect(errors).toEqual([]);
  });

  test('rig B (adapted host skeleton) plays; rig C shows actionable incompatibility diagnostics', async ({ page }) => {
    const errors = trackConsole(page);
    await page.goto('/?recipe=bilateral-squat.v1');
    await ready(page, 'bilateral-squat.v1');
    const rigSelect = page.getByTestId('rig-select');
    const options = await rigSelect.locator('option').allTextContents();
    const rigB = options.find((o) => o.startsWith('Rig B'));
    const rigC = options.find((o) => o.startsWith('Rig C'));
    expect(rigB, `rig options: ${options.join(' | ')}`).toBeDefined();
    expect(rigC).toBeDefined();

    await rigSelect.selectOption({ label: rigB! });
    await expect.poll(async () => (await state(page)).planOk, { timeout: 20_000 }).toBe(true);
    await page.getByTestId('overlay-hostBones').check();
    await page.evaluate(() => window.__motionLab!.seek(3));
    await waitRendered(page);
    const sB = await state(page);
    expect(sB.stats!.points).toBeGreaterThan(0);
    await page.screenshot({ path: `${SHOTS}/rig-b-host-bones.png` });

    await rigSelect.selectOption({ label: rigC! });
    const blocker = page.getByTestId('rig-incompatible');
    await expect(blocker).toBeVisible();
    await expect(blocker).toContainText('not compatible');
    await expect(blocker).toContainText('MISSING_CAPABILITY');
    await expect(blocker.locator('.diag-hint').first()).toBeVisible();
    expect((await state(page)).planOk).toBe(false);
    await expect(page.getByTestId('play-toggle')).toBeDisabled();
    await page.screenshot({ path: `${SHOTS}/rig-c-incompatible.png` });
    expect(errors).toEqual([]);
  });

  test('recipe JSON export → import round trip; malformed import shows readable errors', async ({ page }, testInfo) => {
    const errors = trackConsole(page);
    await page.goto('/?recipe=bilateral-squat.v1');
    await ready(page, 'bilateral-squat.v1');
    const depth = page.getByTestId('param-depthKneeFlexionDeg');
    await depth.fill('82');
    await expect(page.getByTestId('param-editor')).toContainText('Parameters valid.');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-recipe').click()]);
    expect(download.suggestedFilename()).toBe('bilateral-squat.v1.recipe.json');
    const file = testInfo.outputPath('exported.recipe.json');
    await download.saveAs(file);
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    expect(doc.recipeId).toBe('bilateral-squat.v1');
    expect(doc.reviewStatus).toBe('unreviewed-synthetic');
    expect(doc.params.depthKneeFlexionDeg).toBe(82);

    // Change the recipe and parameter, then import the file through the file chooser.
    await page.getByTestId('reset-params').click();
    await selectRecipe(page, 'sit-to-stand.v1');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('import-recipe').click()]);
    await chooser.setFiles(file);
    await expect(page.getByTestId('import-ok')).toContainText('bilateral-squat.v1');
    await ready(page, 'bilateral-squat.v1');
    await expect(page.getByTestId('param-depthKneeFlexionDeg')).toHaveValue('82');

    // Malformed JSON and a forged review status are rejected with diagnostics.
    await page.getByTestId('import-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"schema": "smx.recipe/1", "recipeId": ') });
    await expect(page.getByTestId('import-errors')).toBeVisible();
    await expect(page.getByTestId('import-errors')).toContainText('SCHEMA_INVALID');
    const forged = { ...doc, reviewStatus: 'approved' };
    await page.getByTestId('import-file').setInputFiles({ name: 'forged.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(forged)) });
    await expect(page.getByTestId('import-errors')).toBeVisible();
    await expect(page.getByTestId('import-errors').locator('.diag').first()).toBeVisible();
    expect((await state(page)).recipeId).toBe('bilateral-squat.v1');
    expect(errors).toEqual([]);
  });

  test('glb export downloads animation + manifest; round-trip verify is within tolerance', async ({ page }, testInfo) => {
    test.setTimeout(180_000);
    const errors = trackConsole(page);
    await page.goto('/?recipe=bilateral-heel-raise.v1');
    await ready(page, 'bilateral-heel-raise.v1');
    const downloads: Download[] = [];
    page.on('download', (d) => downloads.push(d));
    await page.getByTestId('export-glb').click();
    await expect.poll(() => downloads.length, { timeout: 60_000 }).toBe(2);
    const names = downloads.map((d) => d.suggestedFilename()).sort();
    const glbName = names.find((n) => n.endsWith('.glb'))!;
    const manifestName = names.find((n) => n.endsWith('.manifest.json'))!;
    expect(glbName).toBeDefined();
    expect(manifestName).toBeDefined();
    const glbPath = testInfo.outputPath(glbName);
    const manPath = testInfo.outputPath(manifestName);
    await downloads.find((d) => d.suggestedFilename() === glbName)!.saveAs(glbPath);
    await downloads.find((d) => d.suggestedFilename() === manifestName)!.saveAs(manPath);
    const glb = readFileSync(glbPath);
    expect(glb.subarray(0, 4).toString('ascii')).toBe('glTF');
    const manifest = JSON.parse(readFileSync(manPath, 'utf8'));
    expect(manifest.reviewStatus).toBe('unreviewed-synthetic');
    expect(manifest.recipe.recipeId).toBe('bilateral-heel-raise.v1');
    await expect(page.getByTestId('export-info')).toContainText('.glb');

    await page.getByTestId('verify-roundtrip').click();
    const report = page.getByTestId('roundtrip-report');
    await expect(report).toBeVisible({ timeout: 90_000 });
    await expect(report).toHaveAttribute('data-within', 'true');
    await expect(report).toContainText('Round trip within tolerance');
    await report.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/export-roundtrip-verified.png` });
    expect(errors).toEqual([]);
  });

  test('keyboard help popover documents shortcuts and closes with Escape', async ({ page }) => {
    const errors = trackConsole(page);
    await page.goto('/');
    await ready(page);
    await page.getByTestId('keyboard-help-button').click();
    const help = page.getByTestId('keyboard-help');
    await expect(help).toBeVisible();
    for (const k of ['Space', 'Shift + ← / →', 'Home / End', 'L / R', 'C']) await expect(help).toContainText(k);
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
    await expect(page.getByTestId('keyboard-help-button')).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('all interactive controls have accessible names', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    const unnamed = await page.evaluate(() => {
      const out: string[] = [];
      const els = document.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
      els.forEach((el) => {
        const aria = el.getAttribute('aria-label') ?? '';
        const labelledby = el.getAttribute('aria-labelledby');
        const labels = (el as HTMLInputElement).labels;
        const text = el.textContent?.trim() ?? '';
        const named = aria.trim() || (labelledby && document.getElementById(labelledby)?.textContent?.trim()) || (labels && labels.length > 0 && labels[0]!.textContent?.trim()) || (el.tagName === 'BUTTON' && text);
        if (!named) out.push(el.outerHTML.slice(0, 120));
      });
      return out;
    });
    expect(unnamed).toEqual([]);
  });

  test('WebGL unavailable: readable error, numerical panels keep working', async ({ page }) => {
    await page.addInitScript(() => {
      const orig = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === 'webgl2' || type === 'webgl') return null;
        return (orig as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof orig;
    });
    await page.goto('/?recipe=bilateral-squat.v1');
    await ready(page, 'bilateral-squat.v1');
    await expect(page.getByTestId('webgl-unavailable')).toContainText('3D view unavailable');
    expect((await state(page)).webgl).toBe(false);
    await page.evaluate(() => window.__motionLab!.seek(3.2));
    await expect(page.getByTestId('diag-time')).toHaveText('3.200 s');
    await expect(page.getByTestId('contact-table')).toBeVisible();
    await expect(page.getByTestId('metrics-status')).toHaveText('Whole-clip metrics ready.', { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/webgl-unavailable-state.png` });
  });

  test('compile failures and infeasible plans are shown with diagnostics, never as a silent motion', async ({ page }) => {
    const errors = trackConsole(page);
    await page.goto('/?recipe=bilateral-squat.v1');
    await ready(page, 'bilateral-squat.v1');
    // In range for the editor, but the engine rejects (or flags) this depth for rig A.
    await page.getByTestId('param-depthKneeFlexionDeg').fill('100');
    const readable = page.getByTestId('compile-errors').or(page.getByTestId('infeasible-banner'));
    await expect(readable.first()).toBeVisible({ timeout: 10_000 });
    await expect(readable.first().locator('.diag').first()).toBeVisible();
    if (await page.getByTestId('compile-errors').count()) {
      expect((await state(page)).planOk).toBe(false);
      await expect(page.getByTestId('play-toggle')).toBeDisabled();
    }
    await page.screenshot({ path: `${SHOTS}/compile-error-state.png` });

    await selectRecipe(page, 'step-up-down.v1');
    await page.getByTestId('param-stepHeight').fill('0.22');
    await expect(readable.first()).toBeVisible({ timeout: 10_000 });
    expect(errors).toEqual([]);
  });
});
