import { z } from 'zod';
import { REVIEW_NOTICE, SCHEMA, coordinateConventionSchema, reviewStatusSchema } from './common.ts';
import { diagnosticSchema } from './diagnostics.ts';
import { recipeDocumentSchema } from './recipe.ts';

/**
 * Export manifest that accompanies a baked animation (.glb). Animation tracks alone do not carry
 * the meaning of an exercise, so the manifest records it: recipe identity and parameters,
 * provenance, version, authoring assumptions, unsupported features, validation summary and the
 * fixed UNREVIEWED status.
 */
export const exportManifestSchema = z.object({
  schema: z.literal(SCHEMA.manifest),
  reviewStatus: reviewStatusSchema,
  reviewNotice: z.literal(REVIEW_NOTICE),
  /** Host integration boundary, restated so it travels with the file. */
  hostResponsibilities: z.array(z.string()).min(1),
  recipe: recipeDocumentSchema,
  recipeTitle: z.string(),
  recipeVersion: z.string(),
  setup: z.array(z.string()),
  phases: z.array(z.object({ id: z.string(), label: z.string(), start: z.number(), end: z.number() })),
  contactSchedule: z.array(
    z.object({ id: z.string(), site: z.string(), surface: z.string(), kind: z.string(), start: z.number(), end: z.number() }),
  ),
  cues: z.array(z.object({ id: z.string(), t: z.number(), phaseId: z.string(), label: z.string() })),
  assumptions: z.array(z.string()),
  unsupported: z.array(z.string()),
  rig: z.object({ id: z.string(), name: z.string(), fingerprint: z.string() }),
  convention: coordinateConventionSchema,
  bake: z.object({
    fps: z.number().positive(),
    frameCount: z.number().int().positive(),
    duration: z.number().positive(),
    solverTier: z.string(),
    interpolation: z.literal('LINEAR'),
  }),
  provenance: z.object({
    generator: z.string(),
    generatorVersion: z.string(),
    createdAt: z.string(),
    synthetic: z.literal(true),
    assets: z.string(),
  }),
  validation: z.object({
    kind: z.literal('geometric-only'),
    statement: z.string(),
    metrics: z.record(z.string(), z.number()),
    withinTolerance: z.boolean(),
    diagnostics: z.array(diagnosticSchema),
  }),
  files: z.object({ animation: z.string(), animationSha256: z.string() }),
});
export type ExportManifest = z.infer<typeof exportManifestSchema>;

export const HOST_RESPONSIBILITIES: readonly string[] = [
  'Exercise identity is supplied by the host by explicit recipe id; this package never infers it.',
  'Approved patient-facing instructions, dose (sets, repetitions, load, frequency) and side come from the host.',
  'Review and publication authority stay with the host clinical workflow; nothing here auto-publishes.',
  'Numerical parameters in bundled fixtures are synthetic engineering values requiring clinical review.',
];
