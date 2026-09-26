import { z } from 'zod';
import { SCHEMA, finite, identifier, quatSchema, vec3Schema } from './common.ts';
import { capabilitySchema } from './rig.ts';

/**
 * A host application's skeleton, described in ITS OWN conventions (units, axes, bone names,
 * rest transforms). The rig adapter converts between this and the canonical rig.
 */
export const axisLabelSchema = z.enum(['+X', '-X', '+Y', '-Y', '+Z', '-Z']);
export type AxisLabel = z.infer<typeof axisLabelSchema>;

export const hostBoneSchema = z.object({
  name: z.string().min(1).max(120),
  parent: z.string().min(1).max(120).nullable(),
  /** Rest local translation in host units / host axes. */
  restTranslation: vec3Schema,
  /** Rest local rotation (xyzw) in host axes. */
  restRotation: quatSchema,
  /** Whether the host allows animating translation on this bone (root motion). */
  translatable: z.boolean().default(false),
});
export type HostBone = z.infer<typeof hostBoneSchema>;

export const hostSkeletonSchema = z.object({
  schema: z.literal(SCHEMA.hostSkeleton),
  id: identifier,
  name: z.string().min(1).max(120),
  units: z.enum(['m', 'cm', 'mm']),
  /** Host axis that points up / toward the subject's front / toward the subject's left. */
  up: axisLabelSchema,
  forward: axisLabelSchema,
  left: axisLabelSchema,
  bones: z.array(hostBoneSchema).min(1),
});
export type HostSkeleton = z.infer<typeof hostSkeletonSchema>;

/** Canonical joint or site name -> host bone name. Explicit; never guessed from names. */
export const boneMapSchema = z.object({
  schema: z.literal(SCHEMA.boneMap),
  hostSkeletonId: identifier,
  joints: z.record(z.string(), z.string()),
  /**
   * Optional explicit contact-site positions (host units, in the host bone's rest frame) for
   * sites a host skeleton has no bone for (heel, toe tip, seat). Missing ones are estimated
   * with a reported ESTIMATED_GEOMETRY diagnostic.
   */
  sites: z
    .record(z.string(), z.object({ bone: z.string(), offset: vec3Schema }))
    .default({}),
  /** Optional twist (rad) about the bone axis applied after aligning rest directions. */
  twist: z.record(z.string(), finite).default({}),
});
export type BoneMap = z.infer<typeof boneMapSchema>;

export const capabilityReportSchema = z.object({
  capability: capabilitySchema,
  available: z.boolean(),
  reason: z.string(),
});
export type CapabilityReport = z.infer<typeof capabilityReportSchema>;
