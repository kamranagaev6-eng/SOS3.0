import type { Diagnostic } from '../contracts/diagnostics.ts';
import type { MotionPlan } from '../contracts/plan.ts';
import type { ParamRecord, ParamSpec, RecipeId } from '../contracts/recipe.ts';
import type { Capability, RigDefinition } from '../contracts/rig.ts';

export type CompileResult =
  | { ok: true; plan: MotionPlan; diagnostics: Diagnostic[] }
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
