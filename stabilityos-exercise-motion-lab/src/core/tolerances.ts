/**
 * Engineering tolerances, fixed before evaluation (see docs/PLAN.md). Geometric only: passing
 * them says nothing about balance, loading, muscle activity, safety or clinical correctness.
 */
export const TOLERANCES = {
  contactPosition: 0.001,
  plantedDisplacement: 0.001,
  contactOrientation: (1 * Math.PI) / 180,
  penetration: 0.001,
  boneLengthRel: 1e-9,
  boneLengthRelExported: 1e-5,
  jointLimit: 1e-9,
  jointVelocityJump: 0.5,
  linearVelocityJump: 0.1,
  quatStepMax60fps: (10 * Math.PI) / 180,
  exportPosition: 0.00005,
  exportRotation: 1e-3,
  stabilizerResidual: 1e-6,
  notableStabilization: 0.005,
  /** Sampling rate used for discontinuity detection. */
  continuityRate: 240,
} as const;
export type Tolerances = typeof TOLERANCES;
