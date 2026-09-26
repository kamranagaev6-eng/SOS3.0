/**
 * Render adapter public surface. UI code imports from here only; three.js stays inside src/render.
 */
export { createStage, StageUnavailableError } from './stage.ts';
export { createStageScene } from './scene.ts';
export { ResourceLedger, ResourceTracker } from './resources.ts';
export { CONTACT_STATE_CSS } from './palette.ts';
export {
  DEFAULT_OVERLAYS,
  RESIDUAL_MAGNIFICATION,
  VIEW_LABELS,
  VIEW_PRESETS,
  type Bounds3,
  type HostBoneView,
  type OverlayFlags,
  type RenderTiming,
  type SplitLayout,
  type Stage,
  type StageOptions,
  type StagePose,
  type StageStats,
  type ViewPreset,
} from './types.ts';
