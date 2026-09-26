import { z } from 'zod';

/**
 * Versioned schema identifiers. A major bump means an incompatible change; readers reject
 * documents whose schema string they do not know rather than guessing.
 */
export const SCHEMA = {
  rig: 'smx.rig/1',
  environment: 'smx.environment/1',
  recipe: 'smx.recipe/1',
  plan: 'smx.motion-plan/1',
  manifest: 'smx.export-manifest/1',
  hostSkeleton: 'smx.host-skeleton/1',
  boneMap: 'smx.bone-map/1',
} as const;

export const ENGINE_NAME = 'stabilityos-exercise-motion-lab';
export const ENGINE_VERSION = '0.1.0';

/**
 * Every recipe, plan and export produced by this package carries this status. There is no
 * code path that sets anything else: review authority belongs to the host application.
 */
export const REVIEW_STATUS = 'unreviewed-synthetic' as const;
export const reviewStatusSchema = z.literal(REVIEW_STATUS);

export const REVIEW_NOTICE =
  'UNREVIEWED SYNTHETIC ENGINEERING FIXTURE. Kinematic demonstration only: not a prescription, not a dose, ' +
  'not patient instruction, not validated for balance, loading, muscle activity, safety or clinical correctness. ' +
  'Exercise identity, approved instructions, dose, side and review authority must come from the host application.';

/** Canonical coordinate convention (identical to glTF 2.0 axes). */
export const COORDINATE_CONVENTION = {
  handedness: 'right',
  up: '+Y',
  forward: '+Z',
  subjectLeft: '+X',
  lengthUnit: 'm',
  angleUnit: 'rad',
  timeUnit: 's',
  quaternionOrder: 'xyzw',
} as const;
export type CoordinateConvention = typeof COORDINATE_CONVENTION;

export const coordinateConventionSchema = z.object({
  handedness: z.literal('right'),
  up: z.literal('+Y'),
  forward: z.literal('+Z'),
  subjectLeft: z.literal('+X'),
  lengthUnit: z.literal('m'),
  angleUnit: z.literal('rad'),
  timeUnit: z.literal('s'),
  quaternionOrder: z.literal('xyzw'),
});

export const finite = z.number().refine((v) => Number.isFinite(v), { message: 'must be a finite number' });
export const positive = finite.refine((v) => v > 0, { message: 'must be > 0' });
export const nonNegative = finite.refine((v) => v >= 0, { message: 'must be >= 0' });
export const vec3Schema = z.tuple([finite, finite, finite]);
export const quatSchema = z
  .tuple([finite, finite, finite, finite])
  .refine((q) => Math.abs(Math.hypot(q[0], q[1], q[2], q[3]) - 1) < 1e-6, { message: 'quaternion must be unit length' });
export const identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/, 'identifier: letters, digits, _ . : - (max 80)');
export const sideSchema = z.enum(['left', 'right']);
export type Side = z.infer<typeof sideSchema>;
export const SIDES: readonly Side[] = ['left', 'right'];
export const sideSuffix = (side: Side): '_L' | '_R' => (side === 'left' ? '_L' : '_R');
export const otherSide = (side: Side): Side => (side === 'left' ? 'right' : 'left');

export type Result<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Formats zod issues as readable `path: message` lines. */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

export function parseWith<T>(schema: z.ZodType<T>, input: unknown): Result<T> {
  const r = schema.safeParse(input);
  return r.success ? { ok: true, value: r.data } : { ok: false, issues: formatZodIssues(r.error) };
}
