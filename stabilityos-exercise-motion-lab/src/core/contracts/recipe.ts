import { z } from 'zod';
import { ENGINE_NAME, ENGINE_VERSION, SCHEMA, identifier, reviewStatusSchema } from './common.ts';

/**
 * Explicit recipe identifiers. Exercise selection NEVER infers a recipe from a display name or
 * from joint angles: the host passes one of these ids (or gets UNKNOWN_RECIPE).
 */
export const RECIPE_IDS = ['sit-to-stand.v1', 'bilateral-squat.v1', 'step-up-down.v1', 'bilateral-heel-raise.v1'] as const;
export const recipeIdSchema = z.enum(RECIPE_IDS);
export type RecipeId = z.infer<typeof recipeIdSchema>;

export const paramValueSchema = z.union([z.number(), z.string(), z.boolean()]);
export type ParamValue = z.infer<typeof paramValueSchema>;
export type ParamRecord = Record<string, ParamValue>;

/** Portable recipe document: what gets imported/exported as JSON. */
export const recipeDocumentSchema = z.object({
  schema: z.literal(SCHEMA.recipe),
  recipeId: identifier,
  reviewStatus: reviewStatusSchema,
  params: z.record(z.string(), paramValueSchema),
  provenance: z.object({
    generator: z.string(),
    generatorVersion: z.string(),
    createdAt: z.string(),
    note: z.string().max(1000),
  }),
});
export type RecipeDocument = z.infer<typeof recipeDocumentSchema>;

export function newRecipeDocument(recipeId: RecipeId, params: ParamRecord, createdAt: string, note = ''): RecipeDocument {
  return {
    schema: SCHEMA.recipe,
    recipeId,
    reviewStatus: 'unreviewed-synthetic',
    params: { ...params },
    provenance: { generator: ENGINE_NAME, generatorVersion: ENGINE_VERSION, createdAt, note },
  };
}

/** UI/editor metadata for one recipe parameter. Numbers are in the listed unit (degrees for *Deg). */
export type ParamSpec =
  | {
      key: string;
      label: string;
      kind: 'number';
      unit: 'm' | 'deg' | 's' | 'count' | 'ratio';
      min: number;
      max: number;
      step: number;
      default: number;
      description: string;
    }
  | {
      key: string;
      label: string;
      kind: 'enum';
      options: readonly string[];
      default: string;
      description: string;
    };
