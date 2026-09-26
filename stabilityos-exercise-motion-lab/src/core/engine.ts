/**
 * Public engine facade. Everything here is pure TypeScript with no React / Three.js / DOM
 * dependency, so it can be extracted into a host application unchanged.
 */
export { TOLERANCES } from './tolerances.ts';
export { createRigA, buildCanonicalRig, PROPORTIONS_A, scaleProportions, mirrorProportions } from './rig/canonical.ts';
export { getRigModel, forwardKinematics, composeJointRotation, decomposeJointRotation, rigidLinks } from './rig/model.ts';
export { listRecipes, getRecipe, compileRecipe } from './recipes/registry.ts';
export { samplePose } from './solver/sample.ts';
export { deriveContactSchedule } from './plan/contactSchedule.ts';
export { bakeClip } from './metrics/bake.ts';
export { analyzeClip, analyzePlan, ClipAnalyzer } from './metrics/analyze.ts';
export { bakeTimes } from './metrics/bake.ts';
export { validatePlan } from './plan/validate.ts';
export { mirrorPlan } from './plan/mirror.ts';
export { validateEnvironment, supportSurfaces, solids } from './environment/surfaces.ts';
export { validateRig } from './rig/validate.ts';
export { standingHeight } from './rig/canonical.ts';
export type { PoseSample, SolverTier, ContactEvaluation, FootTarget, LegReport, LimitEvent, StabilizationReport } from './solver/types.ts';
export type { BakedClip, ClipMetrics } from './metrics/types.ts';
export type { RecipeDefinition, CompileResult } from './recipes/types.ts';
export {
  createHostRigAdapter,
  assessCapabilities,
  capabilityRequirements,
  SYNTHETIC_HOST_RIGS,
  getSyntheticHostRig,
  type HostRigAdapter,
  type AdapterResult,
  type HostPose,
} from './adapter/index.ts';
