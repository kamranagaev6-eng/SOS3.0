import type { Diagnostic } from '../contracts/diagnostics.ts';
import type { MotionPlan } from '../contracts/plan.ts';
import type { ParamRecord, ParamSpec, RecipeId } from '../contracts/recipe.ts';
import type { Capability, RigDefinition } from '../contracts/rig.ts';

/**
 * ok=false: no plan (invalid input, unsupported configuration, missing capability, invalid plan).
 * ok=true: a plan exists. `feasible` reports the compile-time feasibility scan (sampled with the
 * stabilised solver): false means some samples violate constraints; the plan is still returned so
 * the failure can be inspected, and `diagnostics` summarises where.
 */
export type CompileResult =
  | { ok: true; plan: MotionPlan; diagnostics: Diagnostic[]; feasible: boolean }
  | { ok: false; plan: null; diagnostics: Diagnostic[] };

/**
 * A recipe turns explicit, validated parameters into a motion plan for one rig.
 * All text here is neutral engineering description, not patient instruction.
 */
export interface RecipeDefinition {
  id: RecipeId;
  version: string;
  title: string;
  summary: string;
  paramSpecs: readonly ParamSpec[];
  requiredCapabilities: readonly Capability[];
  setup: readonly string[];
  phaseOutline: readonly { id: string; label: string; description: string }[];
  contactChanges: readonly string[];
  unsupported: readonly string[];
  assumptions: readonly string[];
  defaults(): ParamRecord;
  compile(params: ParamRecord, rig: RigDefinition): CompileResult;
}
