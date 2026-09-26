/**
 * Runtime contract (zod schema) tests: every numeric field must reject NaN / Infinity / strings,
 * lengths must be positive, quaternions unit, identifiers well-formed, DOF limits ordered, and the
 * canonical rig must validate. Error paths must be readable.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  COORDINATE_CONVENTION,
  coordinateConventionSchema,
  finite,
  formatZodIssues,
  identifier,
  nonNegative,
  otherSide,
  parseWith,
  positive,
  quatSchema,
  REVIEW_STATUS,
  SCHEMA,
  sideSuffix,
  vec3Schema,
} from '../../src/core/contracts/common.ts';
import { diag, hasErrors } from '../../src/core/contracts/diagnostics.ts';
import { environmentSchema } from '../../src/core/contracts/environment.ts';
import { boneMapSchema, hostBoneSchema, hostSkeletonSchema } from '../../src/core/contracts/hostRig.ts';
import { footStateSchema, scalarKeySchema, stabilizationSchema, swingStateSchema } from '../../src/core/contracts/plan.ts';
import { newRecipeDocument, recipeDocumentSchema, recipeIdSchema, RECIPE_IDS } from '../../src/core/contracts/recipe.ts';
import {
  dofSchema,
  jointSchema,
  legProportionsSchema,
  proportionsSchema,
  rigSchema,
  siteSchema,
  type RigDefinition,
} from '../../src/core/contracts/rig.ts';
import { createRigA, PROPORTIONS_A } from '../../src/core/rig/canonical.ts';

const BAD_NUMBERS: unknown[] = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '1', '0.44', null, undefined, true, [], {}];

function issuesOf(schema: z.ZodType, input: unknown): string[] {
  const r = schema.safeParse(input);
  expect(r.success).toBe(false);
  return r.success ? [] : formatZodIssues(r.error);
}

function jointIndexOf(rig: RigDefinition, name: string): number {
  const i = rig.joints.findIndex((j) => j.name === name);
  expect(i).toBeGreaterThanOrEqual(0);
  return i;
}

describe('numeric primitives', () => {
  it('finite rejects NaN, +-Infinity and non-numbers; accepts ordinary numbers', () => {
    for (const v of BAD_NUMBERS) expect(finite.safeParse(v).success).toBe(false);
    for (const v of [0, -0, -1.5, 1e300, -1e-300, Number.MAX_VALUE]) expect(finite.safeParse(v).success).toBe(true);
  });

  it('positive rejects 0 and negatives; nonNegative accepts 0 but rejects negatives', () => {
    for (const v of [0, -0, -1e-12, -5, ...BAD_NUMBERS]) expect(positive.safeParse(v).success).toBe(false);
    for (const v of [1e-12, 0.44, 1e6]) expect(positive.safeParse(v).success).toBe(true);
    for (const v of [-1e-12, -5, ...BAD_NUMBERS]) expect(nonNegative.safeParse(v).success).toBe(false);
    for (const v of [0, 1e-12, 3]) expect(nonNegative.safeParse(v).success).toBe(true);
  });

  it('vec3Schema requires exactly three finite numbers', () => {
    expect(vec3Schema.safeParse([0, 1.5, -2]).success).toBe(true);
    for (const v of [[0, 0], [0, 0, 0, 0], [0, Number.NaN, 0], ['0', 0, 0], [0, 0, Number.POSITIVE_INFINITY], 'abc', null]) {
      expect(vec3Schema.safeParse(v).success).toBe(false);
    }
  });

  it('quatSchema requires a finite unit quaternion (|q| within 1e-6 of 1)', () => {
    const s = Math.SQRT1_2;
    for (const q of [[0, 0, 0, 1], [0, 0, 0, -1], [s, 0, 0, s], [0.5, 0.5, 0.5, 0.5], [0, 0, 0, 1 + 5e-7]]) {
      expect(quatSchema.safeParse(q).success).toBe(true);
    }
    for (const q of [[0, 0, 0, 0], [0, 0, 0, 1.001], [1, 1, 0, 0], [0, 0, 0, 1 + 2e-6], [0, 0, Number.NaN, 1], [0, 0, 0], ['0', 0, 0, 1]]) {
      expect(quatSchema.safeParse(q).success).toBe(false);
    }
    expect(issuesOf(quatSchema, [0, 0, 0, 2])).toEqual(['(root): quaternion must be unit length']);
  });

  it('identifier: letter first, then [A-Za-z0-9_.:-], at most 80 characters', () => {
    for (const id of ['a', 'hip_L', 'sit-to-stand.v1', 'smx:rig', 'A' + 'x'.repeat(79)]) expect(identifier.safeParse(id).success).toBe(true);
    for (const id of ['', '1a', '_a', '-a', 'a b', 'a/b', 'a'.repeat(81), 'é', 'hip\n', ' hip', 'hip ', 5, null]) {
      expect(identifier.safeParse(id).success).toBe(false);
    }
  });
});

describe('rig contract', () => {
  it('accepts the canonical rig A and returns an equal object', () => {
    const rig = createRigA();
    const parsed = rigSchema.parse(rig);
    expect(parsed).toEqual(rig);
    expect(proportionsSchema.parse(PROPORTIONS_A)).toEqual(PROPORTIONS_A);
    expect(rig.schema).toBe(SCHEMA.rig);
    expect(coordinateConventionSchema.parse(rig.convention)).toEqual(COORDINATE_CONVENTION);
  });

  it('dofSchema rejects min > max (min == max is allowed), bad axes, signs and names', () => {
    const ok = { name: 'flexion', axis: 0, sign: 1, min: -0.5, max: 1 };
    expect(dofSchema.safeParse(ok).success).toBe(true);
    expect(dofSchema.safeParse({ ...ok, min: 0.3, max: 0.3 }).success).toBe(true);
    expect(issuesOf(dofSchema, { ...ok, min: 1.2, max: 1 })).toEqual(['(root): dof min must be <= max']);
    for (const bad of [{ axis: 3 }, { axis: -1 }, { axis: 1.5 }, { sign: 0 }, { sign: 2 }, { name: '9x' }, { min: Number.NaN }, { max: '1' }]) {
      expect(dofSchema.safeParse({ ...ok, ...bad }).success).toBe(false);
    }
  });

  it('jointSchema rejects > 3 DOFs, unknown kinds/sides, non-finite offsets and bad parents', () => {
    const rig = createRigA();
    const hip = rig.joints[jointIndexOf(rig, 'hip_L')]!;
    expect(jointSchema.safeParse(hip).success).toBe(true);
    const d = hip.dofs[0]!;
    expect(jointSchema.safeParse({ ...hip, dofs: [...hip.dofs, { ...d, name: 'extra' }] }).success).toBe(false);
    expect(jointSchema.safeParse({ ...hip, kind: 'slider' }).success).toBe(false);
    expect(jointSchema.safeParse({ ...hip, side: 'middle' }).success).toBe(false);
    expect(jointSchema.safeParse({ ...hip, offset: [0, Number.NaN, 0] }).success).toBe(false);
    expect(jointSchema.safeParse({ ...hip, parent: 'bad parent' }).success).toBe(false);
    expect(jointSchema.safeParse({ ...hip, order: [0, 1, 3] }).success).toBe(false);
  });

  // Regression tests for the contract gap reported to main (order/DOF consistency was unchecked).
  it('jointSchema requires `order` to be a permutation of the three axes', () => {
    const rig = createRigA();
    const knee = rig.joints[jointIndexOf(rig, 'knee_L')]!;
    for (const order of [[0, 0, 0], [0, 0, 1], [1, 2, 1]]) {
      expect(issuesOf(jointSchema, { ...knee, order })).toContain('order: joint order must list three distinct axes');
    }
  });

  it('jointSchema requires dofs[i].axis === order[i] and unique DOF names', () => {
    const rig = createRigA();
    const knee = rig.joints[jointIndexOf(rig, 'knee_L')]!;
    expect(issuesOf(jointSchema, { ...knee, order: [1, 0, 2] })).toContain('dofs: dof i must rotate about order[i]');
    const hip = rig.joints[jointIndexOf(rig, 'hip_L')]!;
    const dupName = { ...hip, dofs: hip.dofs.map((d) => ({ ...d, name: 'flexion' })) };
    expect(issuesOf(jointSchema, dupName)).toContain('dofs: duplicate dof names');
  });

  it('rigSchema rejects duplicate joint or site names, missing/late parents, multiple roots and dangling sites', () => {
    const base = createRigA();
    const dupJoint = structuredClone(base);
    dupJoint.joints.push(structuredClone(dupJoint.joints[jointIndexOf(base, 'knee_L')]!));
    expect(issuesOf(rigSchema, dupJoint)).toContain('joints: duplicate joint names');

    const dupSite = structuredClone(base);
    dupSite.sites.push(structuredClone(dupSite.sites[0]!));
    expect(issuesOf(rigSchema, dupSite)).toContain('sites: duplicate site names');

    const unknownParent = structuredClone(base);
    unknownParent.joints[jointIndexOf(base, 'knee_L')]!.parent = 'femur_L';
    expect(issuesOf(rigSchema, unknownParent).some((m) => m.startsWith('joints: every joint parent must exist'))).toBe(true);

    const outOfOrder = structuredClone(base);
    const k = jointIndexOf(base, 'knee_L');
    const a = jointIndexOf(base, 'ankle_L');
    [outOfOrder.joints[k], outOfOrder.joints[a]] = [outOfOrder.joints[a]!, outOfOrder.joints[k]!];
    expect(issuesOf(rigSchema, outOfOrder).some((m) => m.includes('topological order'))).toBe(true);

    const twoRoots = structuredClone(base);
    twoRoots.joints[jointIndexOf(base, 'neck')]!.parent = null;
    expect(issuesOf(rigSchema, twoRoots)).toContain('joints: exactly one root joint required');

    const dangling = structuredClone(base);
    dangling.sites[0]!.joint = 'nowhere';
    expect(issuesOf(rigSchema, dangling)).toContain('sites: site attached to unknown joint');
  });

  it('rigSchema rejects NaN / Infinity / strings / negative or zero lengths in proportions, with readable paths', () => {
    const cases: { mutate: (r: RigDefinition) => void; path: string }[] = [
      { mutate: (r) => void (r.proportions.left.leg.thigh = -0.44), path: 'proportions.left.leg.thigh' },
      { mutate: (r) => void (r.proportions.right.leg.shank = 0), path: 'proportions.right.leg.shank' },
      { mutate: (r) => void (r.proportions.pelvis.hipHalfWidth = Number.NaN), path: 'proportions.pelvis.hipHalfWidth' },
      { mutate: (r) => void (r.proportions.trunk.head = Number.POSITIVE_INFINITY), path: 'proportions.trunk.head' },
      { mutate: (r) => void ((r.proportions.left.arm as Record<string, unknown>).forearm = '0.26'), path: 'proportions.left.arm.forearm' },
      { mutate: (r) => void (r.proportions.pelvis.hipDrop = -0.01), path: 'proportions.pelvis.hipDrop' },
    ];
    for (const c of cases) {
      const rig = structuredClone(createRigA());
      c.mutate(rig);
      const issues = issuesOf(rigSchema, rig);
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((m) => m.startsWith(`${c.path}: `))).toBe(true);
    }
    const negThigh = structuredClone(createRigA());
    negThigh.proportions.left.leg.thigh = -1;
    expect(issuesOf(rigSchema, negThigh)).toEqual(['proportions.left.leg.thigh: must be > 0']);
  });

  it('rigSchema paths for nested joint / site problems include array indices', () => {
    const rig = structuredClone(createRigA());
    const hip = jointIndexOf(rig, 'hip_R');
    const d = rig.joints[hip]!.dofs[1]!;
    [d.min, d.max] = [d.max, d.min];
    expect(issuesOf(rigSchema, rig)).toEqual([`joints.${hip}.dofs.1: dof min must be <= max`]);

    const rig2 = structuredClone(createRigA());
    rig2.sites[3]!.offset[1] = Number.NaN;
    const issues2 = issuesOf(rigSchema, rig2);
    expect(issues2.length).toBe(1);
    expect(issues2[0]!.startsWith('sites.3.offset.1: ')).toBe(true);

    const rig3 = structuredClone(createRigA());
    rig3.joints[2]!.name = 'bad name';
    expect(issuesOf(rigSchema, rig3).some((m) => m.startsWith('joints.2.name: identifier'))).toBe(true);
  });

  it('rigSchema rejects wrong schema version, non-synthetic rigs, foreign conventions and bad capability/visual data', () => {
    const variants: ((r: Record<string, unknown>) => void)[] = [
      (r) => void (r.schema = 'smx.rig/2'),
      (r) => void (r.synthetic = false),
      (r) => void ((r.convention as Record<string, unknown>).up = '+Z'),
      (r) => void ((r.convention as Record<string, unknown>).lengthUnit = 'cm'),
      (r) => void (r.capabilities = ['teleport']),
      (r) => void ((r.visualRadius as Record<string, unknown>).pelvis = -0.1),
      (r) => void (r.joints = []),
      (r) => void (r.name = ''),
      (r) => void (r.id = '1rig'),
    ];
    for (const v of variants) {
      const rig = structuredClone(createRigA()) as unknown as Record<string, unknown>;
      v(rig);
      expect(rigSchema.safeParse(rig).success).toBe(false);
    }
  });

  it('siteSchema and legProportionsSchema reject bad roles and negative lengths', () => {
    expect(siteSchema.safeParse({ name: 'heel_L', joint: 'ankle_L', offset: [0, -0.08, -0.05], role: 'contact' }).success).toBe(true);
    expect(siteSchema.safeParse({ name: 'heel_L', joint: 'ankle_L', offset: [0, -0.08, -0.05], role: 'handle' }).success).toBe(false);
    const leg = PROPORTIONS_A.left.leg;
    expect(legProportionsSchema.safeParse(leg).success).toBe(true);
    for (const key of Object.keys(leg) as (keyof typeof leg)[]) {
      expect(legProportionsSchema.safeParse({ ...leg, [key]: -leg[key] }).success).toBe(false);
      expect(legProportionsSchema.safeParse({ ...leg, [key]: String(leg[key]) }).success).toBe(false);
    }
  });
});

describe('formatZodIssues / parseWith', () => {
  it('formats root-level issues as (root) and returns ok/value on success', () => {
    const bad = parseWith(rigSchema, 42);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.length).toBe(1);
      expect(bad.issues[0]!.startsWith('(root): ')).toBe(true);
    }
    const rig = createRigA();
    const good = parseWith(rigSchema, rig);
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value).toEqual(rig);
  });

  it('lists every problem once, each as "dotted.path: message"', () => {
    const rig = structuredClone(createRigA());
    rig.proportions.left.leg.thigh = -1;
    rig.proportions.right.leg.toeLength = Number.NaN;
    const r = parseWith(rigSchema, rig);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.issues.length).toBe(2);
      for (const line of r.issues) expect(line).toMatch(/^[A-Za-z0-9_.]+: \S/);
      expect(r.issues.some((l) => l.startsWith('proportions.left.leg.thigh: '))).toBe(true);
      expect(r.issues.some((l) => l.startsWith('proportions.right.leg.toeLength: '))).toBe(true);
    }
  });
});

describe('other contracts', () => {
  it('environment: accepts floor + chair + step, rejects bad geometry and unknown kinds', () => {
    const env = {
      schema: SCHEMA.environment,
      units: 'm',
      objects: [
        { kind: 'floor', id: 'floor' },
        { kind: 'chair', id: 'chair', seatHeight: 0.45, seatDepth: 0.4, seatWidth: 0.45, seatThickness: 0.04, frontZ: 0.1, centerX: 0, backrestHeight: 0 },
        { kind: 'step', id: 'step', height: 0.15, depth: 0.3, width: 0.6, frontZ: 0.3, centerX: 0 },
      ],
    };
    expect(environmentSchema.safeParse(env).success).toBe(true);
    const mut = (f: (e: typeof env) => void) => {
      const e = structuredClone(env);
      f(e);
      return environmentSchema.safeParse(e).success;
    };
    expect(mut((e) => void ((e.objects[1] as Record<string, unknown>).seatHeight = 0))).toBe(false);
    expect(mut((e) => void ((e.objects[1] as Record<string, unknown>).seatHeight = -0.45))).toBe(false);
    expect(mut((e) => void ((e.objects[1] as Record<string, unknown>).backrestHeight = -0.1))).toBe(false);
    expect(mut((e) => void ((e.objects[2] as Record<string, unknown>).height = Number.NaN))).toBe(false);
    expect(mut((e) => void ((e.objects[2] as Record<string, unknown>).frontZ = '0.3'))).toBe(false);
    expect(mut((e) => void ((e.objects[0] as Record<string, unknown>).kind = 'ramp'))).toBe(false);
    expect(mut((e) => void (e.objects = []))).toBe(false);
    expect(mut((e) => void (e.units = 'cm'))).toBe(false);
  });

  it('host skeleton: rest rotations must be unit quaternions; translatable defaults to false', () => {
    const bone = { name: 'Hips', parent: null, restTranslation: [0, 95, 0], restRotation: [0, 0, 0, 1] };
    const parsed = hostBoneSchema.parse(bone);
    expect(parsed.translatable).toBe(false);
    expect(hostBoneSchema.safeParse({ ...bone, restRotation: [0, 0, 0, 0.5] }).success).toBe(false);
    expect(hostBoneSchema.safeParse({ ...bone, restRotation: [0, 0, 0, Number.NaN] }).success).toBe(false);
    expect(hostBoneSchema.safeParse({ ...bone, restTranslation: [0, Number.POSITIVE_INFINITY, 0] }).success).toBe(false);
    const skel = { schema: SCHEMA.hostSkeleton, id: 'host-a', name: 'Host', units: 'cm', up: '+Z', forward: '-Y', left: '+X', bones: [bone] };
    expect(hostSkeletonSchema.safeParse(skel).success).toBe(true);
    expect(hostSkeletonSchema.safeParse({ ...skel, units: 'inch' }).success).toBe(false);
    expect(hostSkeletonSchema.safeParse({ ...skel, up: 'Z' }).success).toBe(false);
    expect(hostSkeletonSchema.safeParse({ ...skel, bones: [] }).success).toBe(false);
    const map = boneMapSchema.parse({ schema: SCHEMA.boneMap, hostSkeletonId: 'host-a', joints: { hip_L: 'LeftUpLeg' } });
    expect(map.sites).toEqual({});
    expect(map.twist).toEqual({});
    expect(boneMapSchema.safeParse({ schema: SCHEMA.boneMap, hostSkeletonId: 'host-a', joints: {}, twist: { hip_L: Number.NaN } }).success).toBe(false);
  });

  it('plan pieces: keys, swing fractions, stabilisation bounds, discriminated foot states', () => {
    expect(scalarKeySchema.safeParse({ t: 0, v: 1, mode: 'stop' }).success).toBe(true);
    expect(scalarKeySchema.safeParse({ t: -0.1, v: 1, mode: 'stop' }).success).toBe(false);
    expect(scalarKeySchema.safeParse({ t: 0, v: Number.NaN, mode: 'stop' }).success).toBe(false);
    expect(scalarKeySchema.safeParse({ t: 0, v: 1, mode: 'linear' }).success).toBe(false);
    const swing = { kind: 'swing', start: 0, end: 1, clearance: 0.05, horizontalDelay: 0.2, horizontalLead: 0.2, riseEnd: 0.3, descendStart: 0.7 };
    expect(swingStateSchema.safeParse(swing).success).toBe(true);
    expect(swingStateSchema.safeParse({ ...swing, horizontalDelay: 0.61 }).success).toBe(false);
    expect(swingStateSchema.safeParse({ ...swing, clearance: -0.01 }).success).toBe(false);
    expect(footStateSchema.safeParse({ ...swing, kind: 'hop' }).success).toBe(false);
    expect(footStateSchema.safeParse({ kind: 'flat', start: 0, end: 1, surface: 'floor', anchor: { x: 0.1, z: 0, yaw: 0 } }).success).toBe(true);
    expect(footStateSchema.safeParse({ kind: 'flat', start: 0, end: 1, surface: 'floor', anchor: { x: Number.NaN, z: 0, yaw: 0 } }).success).toBe(false);
    const stab = { enabled: true, bounds: [0.03, 0.03, 0.03], notableOffset: 0.005, maxIterations: 20, tolerance: 1e-6, kneeFlexionFloor: 0.05, reachSoftZone: 0.07 };
    expect(stabilizationSchema.safeParse(stab).success).toBe(true);
    for (const bad of [{ maxIterations: 0 }, { maxIterations: 201 }, { maxIterations: 2.5 }, { tolerance: 0 }, { notableOffset: -1 }, { bounds: [0, 0] }]) {
      expect(stabilizationSchema.safeParse({ ...stab, ...bad }).success).toBe(false);
    }
  });

  it('recipe documents carry the fixed unreviewed status and an explicit known recipe id', () => {
    for (const id of RECIPE_IDS) expect(recipeIdSchema.safeParse(id).success).toBe(true);
    expect(recipeIdSchema.safeParse('squat').success).toBe(false);
    const doc = newRecipeDocument('bilateral-squat.v1', { depth: 0.3 }, '2026-01-01T00:00:00Z');
    expect(recipeDocumentSchema.parse(doc)).toEqual(doc);
    expect(doc.reviewStatus).toBe(REVIEW_STATUS);
    expect(recipeDocumentSchema.safeParse({ ...doc, reviewStatus: 'reviewed' }).success).toBe(false);
    expect(recipeDocumentSchema.safeParse({ ...doc, params: { depth: [1] } }).success).toBe(false);
  });

  it('schema identifiers follow smx.<name>/<major>; helpers behave', () => {
    for (const s of Object.values(SCHEMA)) expect(s).toMatch(/^smx\.[a-z-]+\/\d+$/);
    expect(sideSuffix('left')).toBe('_L');
    expect(sideSuffix('right')).toBe('_R');
    expect(otherSide('left')).toBe('right');
    expect(otherSide('right')).toBe('left');
    const ds = [diag('JOINT_LIMIT_CLAMPED', 'warning', 'clamped', { subject: 'knee_L', value: 2.6, limit: 2.53 })];
    expect(ds[0]).toEqual({ code: 'JOINT_LIMIT_CLAMPED', severity: 'warning', message: 'clamped', subject: 'knee_L', value: 2.6, limit: 2.53 });
    expect(hasErrors(ds)).toBe(false);
    expect(hasErrors([...ds, diag('RIG_INVALID', 'error', 'x')])).toBe(true);
  });
});
