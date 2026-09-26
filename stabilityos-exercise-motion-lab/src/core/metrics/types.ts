import type { MotionPlan } from '../contracts/plan.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import type { PoseSample, SolverTier } from '../solver/types.ts';

/** Deterministic bake: frame k is sampled at exactly t = min(k / fps, duration); last frame is t = duration. */
export interface BakedClip {
  plan: MotionPlan;
  rig: RigDefinition;
  tier: SolverTier;
  fps: number;
  times: number[];
  frames: PoseSample[];
}

/** Clip-level geometric metrics, computed independently of the solver from FK output. */
export interface ClipMetrics {
  tier: SolverTier;
  sampleRate: number;
  samples: number;
  /** Max position residual of fully active position contacts (m). */
  maxContactPositionError: number;
  /** Max displacement of a contact site from its position at the start of its active interval (m). */
  maxPlantedDisplacement: number;
  /** Max orientation residual of fully active orientation contacts (rad). */
  maxContactOrientationError: number;
  /** Max depth of any sole / seat site below a support surface or inside a solid (m). */
  maxPenetration: number;
  /** Max relative bone-length error measured from world joint positions. */
  maxBoneLengthRelError: number;
  /** Samples whose final (post-clamp) angles are outside limits. Must be 0. */
  jointLimitViolations: number;
  /** Samples where the solver had to clamp a joint. */
  clampedSamples: number;
  /** Max velocity jump estimated from second differences (rad/s for joint DOFs). */
  maxJointVelocityJump: number;
  /** Max velocity jump for pelvis and contact sites (m/s). */
  maxLinearVelocityJump: number;
  /**
   * Raw values at `sampleRate` before refinement. A true C1 break gives a rate-independent value;
   * smooth acceleration gives |θ''|·h. Where the raw value exceeds tolerance, analyzePlan re-samples
   * the neighbourhood at h/4: the reported max*VelocityJump uses the refined value there.
   */
  rawJointVelocityJump: number;
  rawLinearVelocityJump: number;
  refinedCandidates: number;
  maxStabilizationOffset: number;
  stabilizedSamples: number;
  nonConvergedSamples: number;
  unreachableSamples: number;
  kneeFlipSamples: number;
  diagnosticsByCode: Record<string, number>;
  withinTolerance: boolean;
  failures: string[];
}
