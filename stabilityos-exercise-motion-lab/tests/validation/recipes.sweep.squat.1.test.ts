/**
 * Recipe sweep, bilateral-squat.v1, rig group 1 (rig A, short legs, long legs, long trunk) × parameter configurations (defaults, enum
 * combinations, single-parameter min/max corners of every numeric parameter, two seeded random sets).
 * Properties:
 *  (a) compile never throws; (b) rejected ⇒ actionable error diagnostics;
 *  (c) compiled & feasible ⇒ analyzePlan(stabilized, 240 Hz) within every tolerance (no silent failures);
 *  (d) compiled & infeasible ⇒ time-stamped error diagnostics, confirmed by the clip metrics;
 *  (e) validatePlan(plan, rig) has no errors; (f) rigidity and joint limits hold in every tier.
 * Split in two files by rig group so vitest can run them in parallel.
 * Geometric checks of synthetic, unreviewed fixtures, not clinical validation.
 */
import { TOLERANCES } from '../../src/core/engine.ts';
import { defineRecipeSweep } from './support.ts';

await defineRecipeSweep('bilateral-squat.v1', { boneLengthRel: TOLERANCES.boneLengthRel, jointLimit: TOLERANCES.jointLimit }, 1);
