import { formatZodIssues } from '../contracts/common.ts';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import { rigSchema, type RigDefinition } from '../contracts/rig.ts';

/**
 * Structural rig validation (schema refinements cover names, topological order, DOF/order
 * consistency and site attachment). Returns diagnostics; never throws.
 */
export function validateRig(input: unknown): { rig: RigDefinition | null; diagnostics: Diagnostic[] } {
  const r = rigSchema.safeParse(input);
  if (!r.success) return { rig: null, diagnostics: formatZodIssues(r.error).map((m) => diag('RIG_INVALID', 'error', `rig ${m}`)) };
  return { rig: r.data, diagnostics: [] };
}
