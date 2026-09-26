import { z } from 'zod';
import { SCHEMA, finite, identifier, nonNegative, positive, reviewStatusSchema, vec3Schema } from './common.ts';
import { environmentSchema } from './environment.ts';

/**
 * Compiled motion plan ("motion format"). A plan is a recipe compiled against one rig and one
 * environment. It contains only AUTHORED intent (key poses, foot states, contact schedule, cues)
 * plus explicitly declared stabilisation bounds. Solved poses are never stored here: they are
 * reproduced by sampling the plan at any time t.
 */

/**
 * Size limits: validation and the compile-time scan cost grow with duration and key counts, so
 * imported plans are bounded (no recipe needs more than ~20 s; limits leave wide headroom).
 */
export const PLAN_LIMITS = { maxDuration: 600, maxKeys: 10_000, maxPhases: 256, maxCues: 256, maxFootStates: 512, maxSeatIntervals: 64 } as const;

/** 'stop' keys have zero tangent (motion eases in/out); 'flow' keys pass through with a monotone tangent. */
export const scalarKeySchema = z.object({ t: nonNegative, v: finite, mode: z.enum(['stop', 'flow']) });
export type ScalarKey = z.infer<typeof scalarKeySchema>;
export const trackSchema = z.object({ keys: z.array(scalarKeySchema).min(1).max(PLAN_LIMITS.maxKeys) });
export type Track = z.infer<typeof trackSchema>;

export const phaseSchema = z.object({
  id: identifier,
  label: z.string().min(1).max(80),
  start: nonNegative,
  end: nonNegative,
  description: z.string().max(400),
});
export type Phase = z.infer<typeof phaseSchema>;

/**
 * Cue timing markers. `label` is a neutral phase marker for inspection. It is NOT patient-facing
 * instruction text: approved instructions come from the host application.
 */
export const cueSchema = z.object({
  id: identifier,
  t: nonNegative,
  phaseId: identifier,
  label: z.string().min(1).max(120),
});
export type Cue = z.infer<typeof cueSchema>;

export const pelvisChannelsSchema = z.object({
  /** World position of the pelvis origin (m). */
  x: trackSchema,
  y: trackSchema,
  z: trackSchema,
  /** Pelvis orientation relative to the root (rad): rotation (Y) · tilt (X) · obliquity (Z). */
  rotation: trackSchema,
  tilt: trackSchema,
  obliquity: trackSchema,
});
export type PelvisChannels = z.infer<typeof pelvisChannelsSchema>;

/** Ground anchor of a planted foot: ankle ground projection and heading (rad, + = toes toward +X). */
export const footAnchorSchema = z.object({ x: finite, z: finite, yaw: finite });
export type FootAnchor = z.infer<typeof footAnchorSchema>;

export const flatStateSchema = z.object({
  kind: z.literal('flat'),
  start: nonNegative,
  end: nonNegative,
  surface: identifier,
  anchor: footAnchorSchema,
});
export const forefootStateSchema = z.object({
  kind: z.literal('forefoot'),
  start: nonNegative,
  end: nonNegative,
  surface: identifier,
  /** Anchor of the flat pose this forefoot pivots from: ball and toe stay where they are in that pose. */
  anchor: footAnchorSchema,
  /** Heel height above the surface (m) over time. */
  heelLift: trackSchema,
});
export const swingStateSchema = z.object({
  kind: z.literal('swing'),
  start: nonNegative,
  end: nonNegative,
  /** Extra height above the higher of the two end points at mid-swing (m). */
  clearance: nonNegative,
  /** Fraction of the swing before horizontal motion starts (lift first). */
  horizontalDelay: z.number().min(0).max(0.6),
  /** Fraction of the swing reserved at the end for vertical settling (horizontal done early). */
  horizontalLead: z.number().min(0).max(0.6),
  /** Vertical profile: rise to the peak over [0, riseEnd], hold, descend over [descendStart, 1]. */
  riseEnd: z.number().min(0.05).max(0.95),
  descendStart: z.number().min(0.05).max(0.95),
});
export const footStateSchema = z.discriminatedUnion('kind', [flatStateSchema, forefootStateSchema, swingStateSchema]);
export type FootState = z.infer<typeof footStateSchema>;
export type FlatState = z.infer<typeof flatStateSchema>;
export type ForefootState = z.infer<typeof forefootStateSchema>;
export type SwingState = z.infer<typeof swingStateSchema>;

export const seatContactSchema = z.object({
  surface: identifier,
  /** World target of the rig's `seat` site while in contact. */
  target: vec3Schema,
  intervals: z
    .array(z.object({ start: nonNegative, end: nonNegative, blendIn: nonNegative, blendOut: nonNegative }))
    .max(PLAN_LIMITS.maxSeatIntervals),
});
export type SeatContact = z.infer<typeof seatContactSchema>;

export const stabilizationSchema = z.object({
  enabled: z.boolean(),
  /** Max |offset| per axis of the pelvis translation correction (m). Author-declared. */
  bounds: vec3Schema,
  /** Offsets above this magnitude are reported as warnings (m). */
  notableOffset: positive,
  maxIterations: z.number().int().min(1).max(200),
  /** Constraint tolerance for convergence (m or rad). */
  tolerance: positive,
  /** Knee flexion floor used as the reach constraint, avoiding the straight-knee singularity (rad). */
  kneeFlexionFloor: nonNegative,
  /**
   * Soft reach zone (rad of knee flexion above the floor). The authored knee "openness"
   * q = 1 − cos κ (extended smoothly beyond full reach) is mapped C1 onto the floor inside this
   * zone, so corrections ramp in instead of clipping (clipping kinks knee velocity near full
   * extension, where knee angle is hypersensitive to hip–ankle distance).
   */
  reachSoftZone: nonNegative,
});
export type StabilizationSpec = z.infer<typeof stabilizationSchema>;

export const planSchema = z.object({
  schema: z.literal(SCHEMA.plan),
  reviewStatus: reviewStatusSchema,
  recipe: z.object({
    id: identifier,
    version: z.string(),
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
  }),
  rig: z.object({ id: identifier, fingerprint: z.string() }),
  environment: environmentSchema,
  duration: positive.refine((v) => v <= PLAN_LIMITS.maxDuration, { message: `duration must be ≤ ${PLAN_LIMITS.maxDuration} s` }),
  phases: z.array(phaseSchema).min(1).max(PLAN_LIMITS.maxPhases),
  cues: z.array(cueSchema).max(PLAN_LIMITS.maxCues),
  pelvis: pelvisChannelsSchema,
  /** Spine, neck and arm DOF tracks: joints[jointName][dofName]. */
  joints: z.record(z.string(), z.record(z.string(), trackSchema)),
  feet: z.object({
    left: z.array(footStateSchema).min(1).max(PLAN_LIMITS.maxFootStates),
    right: z.array(footStateSchema).min(1).max(PLAN_LIMITS.maxFootStates),
  }),
  seat: seatContactSchema.nullable(),
  stabilization: stabilizationSchema,
  assumptions: z.array(z.string()),
});
export type MotionPlan = z.infer<typeof planSchema>;

/** Explicit contact interval, derived from foot states + seat contact (see plan/contactSchedule.ts). */
export interface ContactInterval {
  id: string;
  /** Rig site name, e.g. `heel_L`, `ball_R`, `seat`. */
  site: string;
  surface: string;
  /** Position constraints pin a site; orientation constraints align a segment with the surface. */
  kind: 'position' | 'orientation';
  /** For orientation constraints: the constrained segment (`foot` or `toes`). */
  segment?: 'foot' | 'toes';
  side: 'left' | 'right' | 'center';
  start: number;
  end: number;
  blendIn: number;
  blendOut: number;
}
