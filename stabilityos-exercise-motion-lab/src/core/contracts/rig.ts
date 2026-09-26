import { z } from 'zod';
import { SCHEMA, coordinateConventionSchema, finite, identifier, positive, nonNegative, sideSchema, vec3Schema } from './common.ts';

/**
 * Canonical humanoid rig contract.
 *
 * Rest pose: standing, all joint frames aligned with world axes, limbs hanging straight down
 * (-Y), feet pointing +Z. Each joint rotates its child segment. A joint's rotation is composed
 * from its DOFs in the listed order as intrinsic elementary rotations about ±X/±Y/±Z:
 *   q = R(sign0·axis0, θ0) · R(sign1·axis1, θ1) · ...
 * `order` lists all three axes (DOF axes first); axes not covered by a DOF must stay at zero,
 * and any residual about them is reported as an off-axis error.
 */
export const CAPABILITIES = [
  'root-translation',
  'pelvis-rotation',
  'trunk-articulation',
  'independent-legs',
  'knee-hinge',
  'ankle-2dof',
  'forefoot-articulation',
  'independent-arms',
  'neck',
] as const;
export const capabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof capabilitySchema>;

export const axisIndexSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);

export const dofSchema = z
  .object({
    name: identifier,
    axis: axisIndexSchema,
    sign: z.union([z.literal(1), z.literal(-1)]),
    /** Engineering limit (rad). Synthetic values, not normative clinical ranges. */
    min: finite,
    max: finite,
  })
  .refine((d) => d.min <= d.max, { message: 'dof min must be <= max' });
export type DofSpec = z.infer<typeof dofSchema>;

export const jointKindSchema = z.enum(['root', 'pelvis', 'ball', 'universal', 'hinge']);
export type JointKind = z.infer<typeof jointKindSchema>;

export const jointSchema = z
  .object({
  name: identifier,
  parent: identifier.nullable(),
  kind: jointKindSchema,
  side: z.enum(['left', 'right', 'center']),
  /** Rest offset of this joint's origin in the parent segment frame (m). */
  offset: vec3Schema,
  dofs: z.array(dofSchema).max(3),
  order: z.tuple([axisIndexSchema, axisIndexSchema, axisIndexSchema]),
})
  .refine((j) => new Set(j.order).size === 3, { message: 'joint order must list three distinct axes', path: ['order'] })
  .refine((j) => j.dofs.every((d, i) => d.axis === j.order[i]), { message: 'dof i must rotate about order[i]', path: ['dofs'] })
  .refine((j) => new Set(j.dofs.map((d) => d.name)).size === j.dofs.length, { message: 'duplicate dof names', path: ['dofs'] });
export type JointSpec = z.infer<typeof jointSchema>;

export const siteSchema = z.object({
  name: identifier,
  /** Segment frame (named by the joint that rotates it) the site is rigidly attached to. */
  joint: identifier,
  offset: vec3Schema,
  role: z.enum(['contact', 'penetration', 'marker']),
});
export type SiteSpec = z.infer<typeof siteSchema>;

export const legProportionsSchema = z.object({
  thigh: positive,
  shank: positive,
  /** Ankle joint centre height above the sole. */
  ankleHeight: positive,
  /** Heel contact point behind the ankle joint (horizontal). */
  heelBack: positive,
  /** Ankle joint to MTP joint, horizontal. */
  footLength: positive,
  /** MTP joint centre height above the sole. */
  mtpHeight: positive,
  toeLength: positive,
  footWidth: positive,
});
export type LegProportions = z.infer<typeof legProportionsSchema>;

export const armProportionsSchema = z.object({ upperArm: positive, forearm: positive, hand: positive });
export type ArmProportions = z.infer<typeof armProportionsSchema>;

export const proportionsSchema = z.object({
  pelvis: z.object({
    hipHalfWidth: positive,
    /** Hip joint centres below the pelvis origin. */
    hipDrop: nonNegative,
    /** Seat (ischial) contact point below the pelvis origin. */
    seatDrop: positive,
    /** Seat contact point behind the pelvis origin. */
    seatBack: nonNegative,
    /** Lumbar joint (lumbosacral level) above the pelvis origin. */
    lumbarBaseHeight: positive,
  }),
  trunk: z.object({
    lumbar: positive,
    thoracic: positive,
    neck: positive,
    head: positive,
    shoulderHalfWidth: positive,
    /** Shoulder joints below the neck base (top of the thoracic segment). */
    shoulderDrop: nonNegative,
  }),
  left: z.object({ leg: legProportionsSchema, arm: armProportionsSchema }),
  right: z.object({ leg: legProportionsSchema, arm: armProportionsSchema }),
});
export type HumanoidProportions = z.infer<typeof proportionsSchema>;

export const rigSchema = z
  .object({
  schema: z.literal(SCHEMA.rig),
  id: identifier,
  name: z.string().min(1).max(120),
  synthetic: z.literal(true),
  convention: coordinateConventionSchema,
  proportions: proportionsSchema,
  joints: z.array(jointSchema).min(1),
  sites: z.array(siteSchema),
  capabilities: z.array(capabilitySchema),
  /** Visual radii for the stylised renderer only; never used by the solver. */
  visualRadius: z.record(z.string(), positive),
})
  .refine((r) => new Set(r.joints.map((j) => j.name)).size === r.joints.length, { message: 'duplicate joint names', path: ['joints'] })
  .refine((r) => new Set(r.sites.map((x) => x.name)).size === r.sites.length, { message: 'duplicate site names', path: ['sites'] })
  .refine(
    (r) => r.joints.every((j, i) => j.parent === null || r.joints.slice(0, i).some((p) => p.name === j.parent)),
    { message: 'every joint parent must exist and precede the joint (topological order)', path: ['joints'] },
  )
  .refine((r) => r.joints.filter((j) => j.parent === null).length === 1, { message: 'exactly one root joint required', path: ['joints'] })
  .refine((r) => r.sites.every((x) => r.joints.some((j) => j.name === x.joint)), { message: 'site attached to unknown joint', path: ['sites'] });
export type RigDefinition = z.infer<typeof rigSchema>;

export const legSideSchema = sideSchema;
