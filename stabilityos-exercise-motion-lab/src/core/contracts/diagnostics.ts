import { z } from 'zod';

export const DIAGNOSTIC_CODES = [
  // input / contract level
  'SCHEMA_INVALID',
  'UNKNOWN_RECIPE',
  'PARAM_OUT_OF_RANGE',
  'UNSUPPORTED_CONFIGURATION',
  'INVALID_GEOMETRY',
  'PHASE_INVALID',
  'CUE_INVALID',
  'CONTRADICTORY_CONTACTS',
  'CONTACT_OFF_SURFACE',
  'SWING_COLLISION',
  'KEYPOSE_UNSOLVED',
  // rig / adapter level
  'RIG_INVALID',
  'MISSING_CAPABILITY',
  'MISSING_BONE',
  'RIG_HIERARCHY_MISMATCH',
  'ESTIMATED_GEOMETRY',
  // per-sample solver level
  'TARGET_UNREACHABLE',
  'JOINT_LIMIT_CLAMPED',
  'CONTACT_POSITION_VIOLATION',
  'CONTACT_ORIENTATION_VIOLATION',
  'SURFACE_PENETRATION',
  'STABILIZATION_APPLIED',
  'STABILIZATION_BOUND_REACHED',
  'SOLVER_NOT_CONVERGED',
  'KNEE_PLANE_DEGENERATE',
  // export level
  'EXPORT_MISMATCH',
] as const;

export const diagnosticCodeSchema = z.enum(DIAGNOSTIC_CODES);
export type DiagnosticCode = z.infer<typeof diagnosticCodeSchema>;
export const severitySchema = z.enum(['info', 'warning', 'error']);
export type Severity = z.infer<typeof severitySchema>;

export const diagnosticSchema = z.object({
  code: diagnosticCodeSchema,
  severity: severitySchema,
  message: z.string(),
  /** JSON-path-like location for input problems, e.g. `params.chairHeight`. */
  path: z.string().optional(),
  /** Sample time (s) for per-sample problems. */
  time: z.number().optional(),
  /** Joint, site, contact or bone the diagnostic is about. */
  subject: z.string().optional(),
  value: z.number().optional(),
  limit: z.number().optional(),
  /** What a person can do about it. */
  hint: z.string().optional(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

export function diag(
  code: DiagnosticCode,
  severity: Severity,
  message: string,
  extra: Omit<Diagnostic, 'code' | 'severity' | 'message'> = {},
): Diagnostic {
  return { code, severity, message, ...extra };
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}
