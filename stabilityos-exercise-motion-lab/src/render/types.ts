/**
 * Framework-agnostic render adapter contract. Nothing in this file refers to Three.js types, so
 * UI code (React) can drive the stage without importing three.
 */
import type { Side } from '../core/contracts/common.ts';
import type { Environment } from '../core/contracts/environment.ts';
import type { RigDefinition } from '../core/contracts/rig.ts';
import type { Vec3 } from '../core/math/vec3.ts';
import type { PoseSample } from '../core/solver/types.ts';

export type ViewPreset = 'front' | 'side-left' | 'side-right' | 'oblique' | 'top';
export const VIEW_PRESETS: readonly ViewPreset[] = ['front', 'side-left', 'side-right', 'oblique', 'top'];

export const VIEW_LABELS: Record<ViewPreset, string> = {
  front: 'Front',
  'side-left': 'Left side',
  'side-right': 'Right side',
  oblique: 'Oblique',
  top: 'Top',
};

export interface OverlayFlags {
  /** Rings at contact target positions, coloured by state (active / engaging / releasing). */
  contactTargets: boolean;
  /** Dots at the rig's actual contact-site positions. */
  contactSites: boolean;
  /** Line from each position target to the actual site. */
  residuals: boolean;
  /** Draw residual vectors (and the stabilisation arrow) magnified ×10. */
  magnifyResiduals: boolean;
  /** Whole-clip pelvis trajectory polyline plus current-position marker. */
  trajectory: boolean;
  /** Small RGB axes (X red, Y green, Z blue) at every joint. */
  jointAxes: boolean;
  /** Red markers on violating contacts / clamped joints, stabilisation offset arrow. */
  failures: boolean;
  /** Host skeleton bones reconstructed by the rig adapter (adapted rigs only). */
  hostBones: boolean;
}

export const DEFAULT_OVERLAYS: OverlayFlags = {
  contactTargets: true,
  contactSites: true,
  residuals: true,
  magnifyResiduals: false,
  trajectory: true,
  jointAxes: false,
  failures: true,
  hostBones: false,
};

export const RESIDUAL_MAGNIFICATION = 10;

/** Minimal pose data the stage needs. `PoseSample` satisfies it. */
export type StagePose = Pick<
  PoseSample,
  'tier' | 'worldPos' | 'worldRot' | 'sitePos' | 'contacts' | 'stabilization' | 'limitEvents' | 'pelvisWorld'
>;

/** Host bone transform in canonical world space (from the rig adapter). */
export interface HostBoneView {
  name: string;
  parent: string | null;
  position: Vec3;
}

export interface Bounds3 {
  min: Vec3;
  max: Vec3;
}

export type SplitLayout = 'none' | 'side-by-side' | 'stacked';

export interface StageStats {
  /** Draw calls, triangles and lines of the most recent `render()` (all viewports). */
  drawCalls: number;
  triangles: number;
  lines: number;
  points: number;
  /** Renderer-side GPU resources (renderer.info.memory) and compiled shader programs. */
  gpuGeometries: number;
  gpuTextures: number;
  programs: number;
  /** Resources currently owned (created and not yet disposed) by the stage. */
  ownedGeometries: number;
  ownedMaterials: number;
  ownedTextures: number;
  sceneObjects: number;
  split: SplitLayout;
  width: number;
  height: number;
  pixelRatio: number;
}

export interface RenderTiming {
  /** CPU time spent in renderer.render (all viewports), ms. */
  renderCpuMs: number;
  /** renderCpuMs + gl.finish() (waits for the GPU / software rasteriser), ms. */
  renderFinishMs: number;
}

export interface StageOptions {
  /** Device pixel ratio cap (default 2). */
  maxPixelRatio?: number;
  /** When true, camera changes are applied immediately (prefers-reduced-motion). */
  reducedMotion?: boolean;
  antialias?: boolean;
  /** Needed for screenshots / readPixels (default true, small cost). */
  preserveDrawingBuffer?: boolean;
  /** Called when the WebGL context is lost or restored. */
  onContextChange?: (lost: boolean) => void;
}

export interface Stage {
  /** Rebuild the humanoid(s) for a rig. `null` removes them. Disposes the previous meshes. */
  setRig(rig: RigDefinition | null): void;
  /** Rebuild the environment view. Disposes the previous meshes. */
  setEnvironment(env: Environment | null): void;
  /**
   * Primary pose (right-hand viewport in comparison mode) and optional comparison pose (the
   * frozen-pelvis baseline shown in the left-hand viewport).
   */
  setPose(primary: StagePose | null, comparison?: StagePose | null): void;
  /** Whole-clip pelvis trajectory polylines (primary tier, optional comparison tier). */
  setTrajectory(primary: readonly Vec3[] | null, comparison?: readonly Vec3[] | null): void;
  setHostBones(bones: readonly HostBoneView[] | null): void;
  /** New plan: drops the current poses and every per-sample overlay object (pooled markers, trajectories, host bones). */
  resetOverlays(): void;
  setOverlays(flags: Partial<OverlayFlags>): void;
  getOverlays(): OverlayFlags;
  /** Highlight one side's limbs and contacts (null = no highlight). */
  setInspectionSide(side: Side | null): void;
  setView(preset: ViewPreset, options?: { animate?: boolean }): void;
  getView(): ViewPreset | 'custom';
  /** Framing bounds (whole clip + environment). Camera distance is fitted per viewport. */
  setFraming(bounds: Bounds3 | null): void;
  setComparison(enabled: boolean): void;
  setReducedMotion(reduced: boolean): void;
  /** Re-read the canvas' CSS size. */
  resize(): void;
  /** True when something changed since the last render (pose, camera tween, overlays...). */
  needsRender(): boolean;
  render(): RenderTiming;
  /** Render and wait for the GPU (bench only). */
  renderAndFinish(): RenderTiming;
  getStats(): StageStats;
  getSplit(): SplitLayout;
  /** WebGL renderer / vendor strings where the browser exposes them. */
  getGpuInfo(): { renderer: string; vendor: string; webglVersion: string };
  dispose(): void;
}
