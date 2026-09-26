import type { Side } from '../contracts/common.ts';
import type { Diagnostic } from '../contracts/diagnostics.ts';
import type { ContactInterval } from '../contracts/plan.ts';
import type { Quat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';

/**
 * baseline   – the solved joint angles replayed with the pelvis frozen at its t=0 transform
 *              (what a joint-rotation-only rig shows). Comparison only.
 * analytic   – authored pelvis + closed-form leg IK + closed-form foot poses (tier 1).
 * stabilized – tier 1 + bounded pelvis-offset correction for reach / joint-limit constraints (tier 2).
 */
export type SolverTier = 'baseline' | 'analytic' | 'stabilized';
export const SOLVER_TIERS: readonly SolverTier[] = ['baseline', 'analytic', 'stabilized'];

export interface ContactEvaluation {
  interval: ContactInterval;
  /** 1 = fully active (tolerance applies); (0,1) = engaging/releasing (reported, not judged). */
  weight: number;
  state: 'active' | 'engaging' | 'releasing';
  /** Position constraints: world target and actual site position. */
  target: Vec3 | null;
  actual: Vec3 | null;
  positionError: number | null;
  /** Orientation constraints: angle between segment frame and target frame (rad). */
  orientationError: number | null;
  withinTolerance: boolean;
}

export interface StabilizationReport {
  enabled: boolean;
  /** Pelvis translation correction added on top of the authored trajectory (m). */
  offset: Vec3;
  iterations: number;
  converged: boolean;
  boundReached: boolean;
  /** Sum of constraint violations before / after (m-equivalent). */
  initialViolation: number;
  finalViolation: number;
}

export interface LimitEvent {
  joint: string;
  dof: string;
  requested: number;
  applied: number;
}

export interface LegReport {
  side: Side;
  hipToAnkle: number;
  maxReach: number;
  reachable: boolean;
  /** Knee flexion from IK before clamping (rad). */
  kneeFlexion: number;
  /** cos(angle) between knee-forward direction and foot-forward direction; > 0 means no knee flip. */
  kneeForwardDot: number;
}

export interface FootTarget {
  side: Side;
  mode: 'flat' | 'forefoot' | 'swing';
  /** Target world transform of the foot segment (ankle joint frame). */
  anklePos: Vec3;
  footRot: Quat;
  /** Target world rotation of the toes segment (mtp frame). */
  toesRot: Quat;
  /** Target MTP extension implied by the target (rad). */
  mtpExtension: number;
  surface: string | null;
}

export interface PoseSample {
  t: number;
  tier: SolverTier;
  phaseIndex: number;
  phaseId: string;
  rootTranslation: Vec3;
  /** Pelvis local translation relative to the root. */
  pelvisOffset: Vec3;
  /** Final pelvis origin in world space. */
  pelvisWorld: Vec3;
  /** Per joint index: DOF values after limit clamping (rad). */
  angles: number[][];
  local: Quat[];
  worldPos: Vec3[];
  worldRot: Quat[];
  sitePos: Vec3[];
  footTargets: Record<Side, FootTarget>;
  contacts: ContactEvaluation[];
  stabilization: StabilizationReport;
  limitEvents: LimitEvent[];
  legs: LegReport[];
  diagnostics: Diagnostic[];
}
