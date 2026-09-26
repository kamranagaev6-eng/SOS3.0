/**
 * Recipe sweep, sit-to-stand.v1: rig variants (rig A, scripts/sweep.ts variants, host-derived rig B when the
 * adapter provides it) × parameter configurations (defaults, enum combinations, single-parameter
 * min/max corners, two seeded random sets). Properties:
 *  (a) compile never throws; (b) rejected ⇒ actionable error diagnostics;
 *  (c) compiled & feasible ⇒ analyzePlan(stabilized, 240 Hz) within every tolerance (no silent failures);
 *  (d) compiled & infeasible ⇒ time-stamped error diagnostics, confirmed by the clip metrics;
 *  (e) validatePlan(plan, rig) has no errors; (f) rigidity and joint limits hold in every tier.
 * Geometric checks of synthetic, unreviewed fixtures, not clinical validation.
 */
import { TOLERANCES } from '../../src/core/engine.ts';
import { defineRecipeSweep } from './support.ts';

await defineRecipeSweep('sit-to-stand.v1', { boneLengthRel: TOLERANCES.boneLengthRel, jointLimit: TOLERANCES.jointLimit });
