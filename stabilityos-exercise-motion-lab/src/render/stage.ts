import * as THREE from 'three';
import { OrbitController, PRESET_ORBITS, directionFromOrbit, fitDistance } from './camera.ts';
import { PALETTE } from './palette.ts';
import type { ResourceLedger } from './resources.ts';
import { createStageScene, type StageScene } from './scene.ts';
import type { Bounds3, RenderTiming, SplitLayout, Stage, StageOptions, StageStats, ViewPreset } from './types.ts';

/** Thrown when a WebGL renderer cannot be created (no WebGL, blocked GPU, lost context...). */
export class StageUnavailableError extends Error {
  override readonly name = 'StageUnavailableError';
  readonly detail: string;
  constructor(detail: string) {
    super(`3D view unavailable: ${detail}`);
    this.detail = detail;
  }
}

export interface StageInternals {
  /** Exposed for tests / benchmarks only. */
  readonly sceneGraph: StageScene;
}

const FOV_Y = 30;

/**
 * Creates the Three.js stage on a canvas. All three.js usage stays behind this function; callers
 * see only the `Stage` interface from ./types.ts.
 */
export function createStage(canvas: HTMLCanvasElement, options: StageOptions & { ledger?: ResourceLedger } = {}): Stage & StageInternals {
  let renderer: THREE.WebGLRenderer;
  try {
    // three.js (r163+) requires WebGL 2. Probing first gives a readable reason instead of a
    // console error from inside the renderer.
    const probe = canvas.getContext('webgl2', {
      antialias: options.antialias ?? true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
      powerPreference: 'high-performance',
    });
    if (!probe) throw new Error('this browser returned no WebGL 2 context (WebGL disabled, unsupported or blocked)');
    renderer = new THREE.WebGLRenderer({
      canvas,
      context: probe,
      antialias: options.antialias ?? true,
      preserveDrawingBuffer: options.preserveDrawingBuffer ?? true,
      powerPreference: 'high-performance',
    });
  } catch (e) {
    throw new StageUnavailableError(e instanceof Error ? e.message : String(e));
  }
  renderer.info.autoReset = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const maxPr = options.maxPixelRatio ?? 2;
  let dark = false;
  const sg = createStageScene({ ledger: options.ledger ?? null, dark });
  const camera = new THREE.PerspectiveCamera(FOV_Y, 1, 0.03, 60);
  const orbit = new OrbitController();
  let reducedMotion = options.reducedMotion ?? false;
  let framing: Bounds3 | null = null;
  let renderedVersion = -1;
  let cameraDirty = true;
  let width = 1;
  let height = 1;
  let split: SplitLayout = 'none';
  let lastStats = { calls: 0, triangles: 0, lines: 0, points: 0 };
  let disposed = false;
  let contextLost = false;

  const setClear = (): void => {
    renderer.setClearColor(dark ? PALETTE.backgroundDark : PALETTE.background, 1);
  };
  setClear();

  // ---- pointer orbit / wheel zoom (no keyboard handling here: the app owns keys) ----
  let drag: { id: number; x: number; y: number } | null = null;
  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent): void => {
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    drag.x = e.clientX;
    drag.y = e.clientY;
    orbit.orbitBy(-dx * 0.008, dy * 0.006);
    cameraDirty = true;
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (drag?.id === e.pointerId) drag = null;
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    orbit.zoomBy(e.deltaY > 0 ? 1.08 : 1 / 1.08);
    cameraDirty = true;
  };
  const onLost = (e: Event): void => {
    e.preventDefault();
    contextLost = true;
    options.onContextChange?.(true);
  };
  const onRestored = (): void => {
    contextLost = false;
    cameraDirty = true;
    options.onContextChange?.(false);
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);

  const placeCamera = (aspect: number): void => {
    const dir = directionFromOrbit(orbit.current);
    const bounds = framing ?? sg.defaultBounds();
    const fit = fitDistance(bounds, dir, THREE.MathUtils.degToRad(FOV_Y), aspect);
    const dist = fit.distance * orbit.current.zoom;
    camera.aspect = aspect;
    camera.position.copy(fit.target).addScaledVector(dir, dist);
    camera.up.set(0, 1, 0);
    if (Math.abs(dir.y) > 0.99) camera.up.set(0, 0, -1);
    camera.lookAt(fit.target);
    camera.near = Math.max(0.02, dist / 200);
    camera.far = dist * 6 + 10;
    camera.updateProjectionMatrix();
  };

  const doRender = (finish: boolean): RenderTiming => {
    if (disposed || contextLost) return { renderCpuMs: 0, renderFinishMs: 0 };
    orbit.update(performance.now());
    renderer.info.reset();
    const primary = sg.layers[0].group;
    const comp = sg.layers[1].group;
    let cpu = 0;
    if (!sg.comparison) {
      split = 'none';
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, width, height);
      placeCamera(width / Math.max(height, 1));
      primary.visible = true;
      comp.visible = false;
      sg.hostBones.visible = sg.getOverlays().hostBones;
      const r0 = performance.now();
      renderer.render(sg.scene, camera);
      cpu += performance.now() - r0;
    } else {
      split = width / Math.max(height, 1) >= 1.1 ? 'side-by-side' : 'stacked';
      const rects: [number, number, number, number][] =
        split === 'side-by-side'
          ? [
              [0, 0, Math.floor(width / 2), height],
              [Math.floor(width / 2), 0, width - Math.floor(width / 2), height],
            ]
          : [
              [0, Math.floor(height / 2), width, height - Math.floor(height / 2)],
              [0, 0, width, Math.floor(height / 2)],
            ];
      renderer.setScissorTest(true);
      rects.forEach(([x, y, w, h], i) => {
        renderer.setViewport(x, y, w, h);
        renderer.setScissor(x, y, w, h);
        placeCamera(w / Math.max(h, 1));
        // viewport 0 (left / top) = comparison (baseline), viewport 1 = primary tier
        comp.visible = i === 0;
        primary.visible = i === 1;
        sg.hostBones.visible = i === 1 && sg.getOverlays().hostBones;
        const r0 = performance.now();
        renderer.render(sg.scene, camera);
        cpu += performance.now() - r0;
      });
      renderer.setScissorTest(false);
      comp.visible = true;
      primary.visible = true;
    }
    let finishMs = cpu;
    if (finish) {
      const gl = renderer.getContext();
      const f0 = performance.now();
      gl.finish();
      finishMs = cpu + (performance.now() - f0);
    }
    lastStats = { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, lines: renderer.info.render.lines, points: renderer.info.render.points };
    renderedVersion = sg.version;
    cameraDirty = false;
    return { renderCpuMs: cpu, renderFinishMs: finishMs };
  };

  const stage: Stage & StageInternals = {
    sceneGraph: sg,
    setRig: (rig) => sg.setRig(rig),
    setEnvironment: (env) => sg.setEnvironment(env),
    setPose: (p, c) => sg.setPose(p, c ?? null),
    setTrajectory: (p, c) => sg.setTrajectory(p, c ?? null),
    setHostBones: (b) => sg.setHostBones(b),
    setOverlays: (f) => sg.setOverlays(f),
    getOverlays: () => sg.getOverlays(),
    setInspectionSide: (s) => sg.setInspectionSide(s),
    setComparison: (on) => {
      sg.setComparison(on);
      cameraDirty = true;
    },
    setView(preset: ViewPreset, opts) {
      const target = PRESET_ORBITS[preset];
      const animate = (opts?.animate ?? true) && !reducedMotion;
      if (animate) orbit.animateTo(target, performance.now());
      else orbit.jump(target);
      orbit.preset = preset;
      cameraDirty = true;
    },
    getView: () => orbit.preset,
    setFraming(b) {
      framing = b;
      cameraDirty = true;
    },
    setReducedMotion(r) {
      reducedMotion = r;
      if (r && orbit.animating) orbit.jump(PRESET_ORBITS[orbit.preset === 'custom' ? 'front' : orbit.preset]);
      cameraDirty = true;
    },
    resize() {
      const pr = Math.min(window.devicePixelRatio || 1, maxPr);
      const w = Math.max(1, Math.floor(canvas.clientWidth));
      const h = Math.max(1, Math.floor(canvas.clientHeight));
      renderer.setPixelRatio(pr);
      renderer.setSize(w, h, false);
      // setViewport/setScissor take CSS pixels and multiply by the pixel ratio internally.
      width = w;
      height = h;
      cameraDirty = true;
    },
    needsRender: () => !disposed && (cameraDirty || orbit.animating || renderedVersion !== sg.version),
    render: () => doRender(false),
    renderAndFinish: () => doRender(true),
    getStats(): StageStats {
      const owned = sg.ownedCounts();
      let objects = 0;
      sg.scene.traverse(() => {
        objects++;
      });
      return {
        drawCalls: lastStats.calls,
        triangles: lastStats.triangles,
        lines: lastStats.lines,
        points: lastStats.points,
        gpuGeometries: renderer.info.memory.geometries,
        gpuTextures: renderer.info.memory.textures,
        programs: renderer.info.programs?.length ?? 0,
        ownedGeometries: owned.geometries,
        ownedMaterials: owned.materials,
        ownedTextures: owned.textures,
        sceneObjects: objects,
        split,
        width,
        height,
        pixelRatio: renderer.getPixelRatio(),
      };
    },
    getSplit: () => (sg.comparison ? (width / Math.max(height, 1) >= 1.1 ? 'side-by-side' : 'stacked') : 'none'),
    getGpuInfo() {
      const gl = renderer.getContext();
      let rendererName = String(gl.getParameter(gl.RENDERER));
      let vendor = String(gl.getParameter(gl.VENDOR));
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        rendererName = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
        vendor = String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL));
      }
      const webglVersion = String(gl.getParameter(gl.VERSION));
      return { renderer: rendererName, vendor, webglVersion };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      sg.dispose();
      renderer.renderLists.dispose();
      renderer.dispose();
    },
  };
  // Dark theme follows the page (prefers-color-scheme), read once at creation and on change.
  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const applyTheme = (): void => {
    dark = mq?.matches ?? false;
    sg.setDark(dark);
    setClear();
  };
  applyTheme();
  mq?.addEventListener?.('change', applyTheme);
  const baseDispose = stage.dispose;
  stage.dispose = () => {
    mq?.removeEventListener?.('change', applyTheme);
    baseDispose();
  };
  return stage;
}
