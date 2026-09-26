import { z } from 'zod';
import { SCHEMA, finite, identifier, positive, nonNegative } from './common.ts';

/**
 * Environment geometry. Only horizontal support surfaces and axis-aligned boxes are supported
 * in schema version 1 (no slopes, no rotated furniture, no soft surfaces).
 */
export const floorSchema = z.object({ kind: z.literal('floor'), id: identifier });

export const chairSchema = z.object({
  kind: z.literal('chair'),
  id: identifier,
  /** Height of the top of the seat above the floor (m). */
  seatHeight: positive,
  seatDepth: positive,
  seatWidth: positive,
  seatThickness: positive,
  /** z of the seat's front edge (the seat extends toward -Z from here). */
  frontZ: finite,
  centerX: finite,
  /** Backrest height above the seat; 0 = no backrest. Visual + penetration only. */
  backrestHeight: nonNegative,
});

export const stepSchema = z.object({
  kind: z.literal('step'),
  id: identifier,
  height: positive,
  /** Tread depth along +Z. */
  depth: positive,
  width: positive,
  /** z of the riser (front face the subject approaches from -Z). */
  frontZ: finite,
  centerX: finite,
});

export const environmentObjectSchema = z.discriminatedUnion('kind', [floorSchema, chairSchema, stepSchema]);
export type EnvironmentObject = z.infer<typeof environmentObjectSchema>;
export type ChairObject = z.infer<typeof chairSchema>;
export type StepObject = z.infer<typeof stepSchema>;

export const environmentSchema = z.object({
  schema: z.literal(SCHEMA.environment),
  units: z.literal('m'),
  objects: z.array(environmentObjectSchema).min(1),
});
export type Environment = z.infer<typeof environmentSchema>;

/** A horizontal support surface derived from the environment (top face of an object). */
export interface SupportSurface {
  id: string;
  objectId: string;
  y: number;
  /** Axis-aligned footprint; null = unbounded (floor). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

/** Axis-aligned solid used for penetration checks. */
export interface SolidBox {
  id: string;
  min: [number, number, number];
  max: [number, number, number];
}
