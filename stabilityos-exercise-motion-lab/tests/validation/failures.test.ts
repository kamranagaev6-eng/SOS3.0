/**
 * Unsupported and infeasible inputs must produce explicit, specific diagnostics — never a silently
 * "successful" motion, never an uncaught exception from a validation entry point.
 *  - unreachable targets (independent reach oracle), stabiliser at its bound;
 *  - short-leg rigs at extreme parameters: rejected, or flagged infeasible and confirmed by metrics;
 *  - contradictory contacts / invalid plans through validatePlan;
 *  - invalid geometry through validateEnvironment and validatePlan;
 *  - missing articulation (rigs without MTP joints, rigs claiming capabilities they lack, missing seat site);
 *  - plans animating joints / DOFs the rig lacks, or joints the solver owns;
 *  - malformed recipe parameters and near-miss recipe ids;
 *  - seeded mutation fuzz of plan JSON (validatePlan never throws; accepted plans are samplable);
 *  - stabilisation bounds above 5 cm.
 */
import { describe, expect, it } from 'vitest';
import {
  analyzePlan,
  buildCanonicalRig,
  compileRecipe,
  createRigA,
  getRecipe,
  listRecipes,
  PROPORTIONS_A,
  samplePose,
  scaleProportions,
  validateEnvironment,
  validatePlan,
  type PoseSample,
} from '../../src/core/engine.ts';
import { DIAGNOSTIC_CODES, type Diagnostic } from '../../src/core/contracts/diagnostics.ts';
import type { Environment } from '../../src/core/contracts/environment.ts';
import type { MotionPlan } from '../../src/core/contracts/plan.ts';
import type { ParamRecord } from '../../src/core/contracts/recipe.ts';
import type { Capability, RigDefinition } from '../../src/core/contracts/rig.ts';
import { feasibilityScan } from '../../src/core/recipes/common.ts';
import { createRng, type Rng } from '../../src/core/math/rng.ts';
import { flatFootSites, jointIdx, siteIdx, TIERS, vdist } from './support.ts';

const rigA = createRigA();
const errs = (ds: readonly Diagnostic[]) => ds.filter((d) => d.severity === 'error');
const codes = (ds: readonly Diagnostic[]) => [...new Set(errs(ds).map((d) => d.code))].sort();
const fmt = (ds: readonly Diagnostic[]) => errs(ds).map((d) => `${d.code}${d.path ? `@${d.path}` : ''}: ${d.message}`).join(' | ');

function mustCompile(id: string, params: ParamRecord = {}, rig: RigDefinition = rigA): MotionPlan {
  const r = compileRecipe(id, params, rig);
  if (!r.ok) throw new Error(`test setup: ${id} rejected: ${fmt(r.diagnostics)}`);
  return r.plan;
}

const squat = mustCompile('bilateral-squat.v1');
const sts = mustCompile('sit-to-stand.v1');
const stepUp = mustCompile('step-up-down.v1');
const heel = mustCompile('bilateral-heel-raise.v1');

/** Mutated clone of a valid plan (plans are immutable values; never mutate a plan being sampled). */
function mutated(base: MotionPlan, f: (p: MotionPlan) => void): MotionPlan {
  const p = structuredClone(base);
  // the heel-raise recipe shares one heelLift object between sides: unshare so an edit is one-sided
  for (const side of ['left', 'right'] as const) p.feet[side] = p.feet[side].map((s) => structuredClone(s));
  f(p);
  return p;
}

function expectError(ds: readonly Diagnostic[], code: string, pathPrefix?: string, messagePart?: string): void {
  const hit = errs(ds).find((d) => d.code === code && (pathPrefix === undefined || (d.path ?? '').startsWith(pathPrefix)) && (messagePart === undefined || d.message.includes(messagePart)));
  expect(hit, `expected ${code}${pathPrefix ? ` at ${pathPrefix}` : ''}${messagePart ? ` mentioning '${messagePart}'` : ''}; got: ${fmt(ds) || '(no errors)'}`).toBeDefined();
}

// ---------------------------------------------------------------------------------------------

describe('unreachable targets are reported at the times they occur (independent reach oracle)', () => {
  const raised = mutated(squat, (p) => {
    for (const k of p.pelvis.y.keys) k.v += 0.05;
  });
  const L = rigA.proportions.left.leg;
  const reach = L.thigh + L.shank;

  it('raising every pelvis key by 5 cm keeps the plan structurally valid (the problem is geometric)', () => {
    expect(errs(validatePlan(raised, rigA))).toEqual([]);
  });

  it('analytic tier: TARGET_UNREACHABLE exactly where |hip − ankle target| > thigh + shank, with contact violations', () => {
    let unreachable = 0;
    let reachable = 0;
    for (let k = 0; k <= Math.ceil(raised.duration * 30); k++) {
      const t = Math.min(raised.duration, k / 30);
      const s = samplePose(raised, rigA, t, 'analytic');
      for (const side of ['left', 'right'] as const) {
        const sfx = side === 'left' ? '_L' : '_R';
        const st = raised.feet[side][0]!;
        if (st.kind !== 'flat') throw new Error('squat feet are flat');
        const target = [st.anchor.x, rigA.proportions[side].leg.ankleHeight, st.anchor.z];
        const d = vdist(s.worldPos[jointIdx(rigA, `hip${sfx}`)]!, target);
        if (Math.abs(d - reach) < 1e-7) continue;
        const flagged = s.diagnostics.filter((x) => x.code === 'TARGET_UNREACHABLE' && x.subject === `leg_${side}`);
        if (d > reach) {
          unreachable++;
          expect(flagged, `t=${t} ${side}: ${(d - reach) * 1000} mm beyond reach but not flagged`).toHaveLength(1);
          expect(flagged[0]!.severity).toBe('error');
          expect(flagged[0]!.time).toBe(t);
          expect(flagged[0]!.value).toBeCloseTo(d, 9);
          // and the planted heel is visibly off its anchor-derived position, which is reported too
          const heelErr = vdist(s.sitePos[siteIdx(rigA, `heel${sfx}`)]!, flatFootSites(rigA, side, st.anchor, 0).heel);
          if (heelErr > 0.001)
            expect(s.diagnostics.some((x) => x.code === 'CONTACT_POSITION_VIOLATION' && x.time === t && (x.subject ?? '').includes(sfx)), `t=${t} ${side}`).toBe(true);
        } else {
          reachable++;
          expect(flagged, `t=${t} ${side}: reachable but flagged`).toHaveLength(0);
        }
      }
    }
    expect(unreachable).toBeGreaterThan(20);
    expect(reachable).toBeGreaterThan(20);
  });

  it('stabilized tier: correction pinned at the declared bound, STABILIZATION_BOUND_REACHED + SOLVER_NOT_CONVERGED + TARGET_UNREACHABLE', () => {
    const s = samplePose(raised, rigA, 0.5, 'stabilized'); // standing: 5 cm too high, y bound 3 cm
    const c = codes(s.diagnostics);
    expect(c).toEqual(expect.arrayContaining(['SOLVER_NOT_CONVERGED', 'TARGET_UNREACHABLE', 'CONTACT_POSITION_VIOLATION']));
    expect(s.diagnostics.some((d) => d.code === 'STABILIZATION_BOUND_REACHED')).toBe(true);
    expect(s.stabilization.boundReached).toBe(true);
    expect(s.stabilization.converged).toBe(false);
    expect(Math.abs(s.stabilization.offset[1] + raised.stabilization.bounds[1])).toBeLessThanOrEqual(1e-12);
    for (let i = 0; i < 3; i++) expect(Math.abs(s.stabilization.offset[i]!)).toBeLessThanOrEqual(raised.stabilization.bounds[i]! + 1e-12);
  });

  it('clip level: analyzePlan fails loudly and the compile-time feasibility scan reports errors', () => {
    const m = analyzePlan(raised, rigA, 'stabilized');
    expect(m.withinTolerance).toBe(false);
    expect(m.unreachableSamples).toBeGreaterThan(0);
    expect(m.nonConvergedSamples).toBeGreaterThan(0);
    expect(m.failures.join(' ')).toMatch(/contact position error/);
    const scan = feasibilityScan(raised, rigA);
    expect(codes(scan)).toEqual(expect.arrayContaining(['TARGET_UNREACHABLE', 'CONTACT_POSITION_VIOLATION', 'SOLVER_NOT_CONVERGED']));
    for (const d of errs(scan)) expect(Number.isFinite(d.time)).toBe(true);
  });

  it('a small excess (1.5 cm) is corrected within bounds, but the correction is reported (warning), never hidden', () => {
    const slight = mutated(squat, (p) => {
      for (const k of p.pelvis.y.keys) k.v += 0.015;
    });
    const tier1 = analyzePlan(slight, rigA, 'analytic');
    expect(tier1.unreachableSamples).toBeGreaterThan(0);
    const tier2 = analyzePlan(slight, rigA, 'stabilized');
    expect(tier2.failures).toEqual([]);
    expect(tier2.maxStabilizationOffset).toBeGreaterThan(0.005);
    expect(tier2.diagnosticsByCode['STABILIZATION_APPLIED'] ?? 0).toBeGreaterThan(0);
    const s = samplePose(slight, rigA, 0.5, 'stabilized');
    expect(s.diagnostics.some((d) => d.code === 'STABILIZATION_APPLIED' && d.severity === 'warning')).toBe(true);
  });

  it('zero stabilisation bounds on a plan that needs correction ⇒ SOLVER_NOT_CONVERGED, clip out of tolerance', () => {
    const pinned = mutated(stepUp, (p) => {
      p.stabilization.bounds = [0, 0, 0];
    });
    expect(errs(validatePlan(pinned, rigA))).toEqual([]);
    const m = analyzePlan(pinned, rigA, 'stabilized');
    expect(m.withinTolerance).toBe(false);
    expect((m.diagnosticsByCode['SOLVER_NOT_CONVERGED'] ?? 0) + (m.diagnosticsByCode['TARGET_UNREACHABLE'] ?? 0)).toBeGreaterThan(0);
    expect(m.maxStabilizationOffset).toBe(0);
  });
});

describe('extreme rigs × extreme parameters are never silent', () => {
  const scenarios: { name: string; recipe: string; params: ParamRecord; scales: number[] }[] = [
    { name: 'sit-to-stand at max chair height', recipe: 'sit-to-stand.v1', params: { chairHeight: 0.55 }, scales: [0.85, 0.8, 0.75, 0.7, 0.65, 0.6] },
    { name: 'sit-to-stand at min chair height', recipe: 'sit-to-stand.v1', params: { chairHeight: 0.4, footSetback: 0.15 }, scales: [1.1, 1.2, 1.3, 1.4] },
    { name: 'step-up at max step height', recipe: 'step-up-down.v1', params: { stepHeight: 0.22, upLeadSide: 'right' }, scales: [0.85, 0.8, 0.75, 0.7] },
    { name: 'squat at max depth-by-ratio', recipe: 'bilateral-squat.v1', params: { depthKneeFlexionDeg: 90, shankLeanRatio: 0.36 }, scales: [0.7, 1.3] },
  ];
  for (const sc of scenarios) {
    it(`${sc.name}: legs × ${sc.scales.join(', ')}`, () => {
      const outcomes: string[] = [];
      for (const f of sc.scales) {
        const rig = buildCanonicalRig(`legs-x${f}`, `legs ×${f}`, scaleProportions(PROPORTIONS_A, { leg: f }));
        const r = compileRecipe(sc.recipe, sc.params, rig);
        if (!r.ok) {
          expect(errs(r.diagnostics).length).toBeGreaterThan(0);
          expect(errs(r.diagnostics).some((d) => d.path || d.hint)).toBe(true);
          outcomes.push(`×${f}: rejected (${codes(r.diagnostics).join(',')})`);
          continue;
        }
        expect(errs(validatePlan(r.plan, rig))).toEqual([]);
        const m = analyzePlan(r.plan, rig, 'stabilized');
        if (r.feasible) expect(m.failures, `×${f} compiled feasible`).toEqual([]);
        else {
          expect(errs(r.diagnostics).length).toBeGreaterThan(0);
          expect(m.withinTolerance, `×${f}: infeasible verdict must be confirmed by the metrics`).toBe(false);
        }
        outcomes.push(`×${f}: ${r.feasible ? 'feasible' : `infeasible (${codes(r.diagnostics).join(',')})`}`);
      }
      console.info(`[extremes] ${sc.name}: ${outcomes.join('; ')}`);
      if (sc.recipe === 'sit-to-stand.v1' && sc.params['chairHeight'] === 0.55)
        expect(outcomes.some((o) => !o.includes(': feasible')), 'the shortest legs must hit the failure path').toBe(true);
    });
  }
});

describe('contradictory contacts and invalid plans (validatePlan)', () => {
  const cases: { name: string; base: MotionPlan; mutate: (p: MotionPlan) => void; code: string; path?: string; msg?: string }[] = [
    { name: 'overlapping foot states', base: stepUp, mutate: (p) => void (p.feet.left[1]!.start -= 0.1), code: 'CONTRADICTORY_CONTACTS', path: 'feet.left.1' },
    { name: 'gap between foot states', base: stepUp, mutate: (p) => void (p.feet.left[1]!.start += 0.1), code: 'CONTRADICTORY_CONTACTS', path: 'feet.left.1' },
    {
      name: 'anchor jump between planted states without a swing',
      base: heel,
      mutate: (p) => {
        const s = p.feet.left[2]!;
        if (s.kind === 'swing') throw new Error('setup');
        s.anchor = { ...s.anchor, x: s.anchor.x + 0.05 };
      },
      code: 'CONTRADICTORY_CONTACTS',
      path: 'feet.left.2',
      msg: 'without a swing',
    },
    {
      name: 'heel lifted (last key) when a flat state begins',
      base: heel,
      mutate: (p) => {
        const s = p.feet.left[1]!;
        if (s.kind !== 'forefoot') throw new Error('setup');
        s.heelLift.keys.at(-1)!.v = 0.02;
      },
      code: 'CONTRADICTORY_CONTACTS',
      path: 'feet.left.2',
    },
    {
      name: 'heel still up at the boundary although the last key (after the state end) is 0',
      base: heel,
      mutate: (p) => {
        const s = p.feet.left[1]!;
        if (s.kind !== 'forefoot') throw new Error('setup');
        const k = s.heelLift.keys;
        s.heelLift = { keys: [k[0]!, k[1]!, { t: s.end, v: 0.06, mode: 'stop' }, { t: s.end + 0.5, v: 0, mode: 'stop' }] };
      },
      code: 'CONTRADICTORY_CONTACTS',
      path: 'feet.left.2',
    },
    {
      name: 'forefoot state not starting at 0 heel lift after a flat state',
      base: heel,
      mutate: (p) => {
        const s = p.feet.left[1]!;
        if (s.kind !== 'forefoot') throw new Error('setup');
        s.heelLift.keys[0]!.v = 0.02;
      },
      code: 'CONTRADICTORY_CONTACTS',
      path: 'feet.left.1',
    },
    {
      name: 'swing as the first state',
      base: stepUp,
      mutate: (p) => {
        const s = p.feet.left[0]!;
        p.feet.left[0] = { kind: 'swing', start: s.start, end: s.end, clearance: 0.05, horizontalDelay: 0.2, horizontalLead: 0, riseEnd: 0.5, descendStart: 0.6 };
      },
      code: 'CONTRADICTORY_CONTACTS',
      path: 'feet.left.0',
    },
    {
      name: 'swing as the last state',
      base: stepUp,
      mutate: (p) => {
        const n = p.feet.right.length - 1;
        const s = p.feet.right[n]!;
        p.feet.right[n] = { kind: 'swing', start: s.start, end: s.end, clearance: 0.05, horizontalDelay: 0.2, horizontalLead: 0, riseEnd: 0.5, descendStart: 0.6 };
      },
      code: 'CONTRADICTORY_CONTACTS',
      path: `feet.right.${stepUp.feet.right.length - 1}`,
    },
    { name: 'foot states end before the clip', base: squat, mutate: (p) => void (p.feet.left[0]!.end = p.duration - 1), code: 'CONTRADICTORY_CONTACTS' },
    {
      name: 'overlapping seat intervals',
      base: sts,
      mutate: (p) => void (p.seat!.intervals[1]!.start = p.seat!.intervals[0]!.end - 0.5),
      code: 'CONTRADICTORY_CONTACTS',
      path: 'seat.intervals.1',
    },
    { name: 'seat interval beyond the clip', base: sts, mutate: (p) => void (p.seat!.intervals[1]!.end = p.duration + 1), code: 'CONTRADICTORY_CONTACTS', path: 'seat.intervals.1' },
    { name: 'seat target in front of the seat', base: sts, mutate: (p) => void (p.seat!.target = [0, p.seat!.target[1], 0.3]), code: 'CONTACT_OFF_SURFACE', path: 'seat.target' },
    { name: 'seat target above the seat', base: sts, mutate: (p) => void (p.seat!.target = [0, p.seat!.target[1] + 0.05, p.seat!.target[2]]), code: 'CONTACT_OFF_SURFACE', path: 'seat.target' },
    {
      name: 'feet overlapping each other',
      base: squat,
      mutate: (p) => {
        const l = p.feet.left[0]!;
        const r = p.feet.right[0]!;
        if (l.kind === 'swing' || r.kind === 'swing') throw new Error('setup');
        l.anchor = { ...l.anchor, x: r.anchor.x + 0.03 };
      },
      code: 'CONTRADICTORY_CONTACTS',
      msg: 'overlap',
    },
    {
      name: 'planted foot hanging off the step tread',
      base: stepUp,
      mutate: (p) => {
        const s = p.feet.left[2]!;
        if (s.kind !== 'flat' || s.surface !== 'step.top') throw new Error('setup');
        s.anchor = { ...s.anchor, z: s.anchor.z + 0.25 };
      },
      code: 'CONTACT_OFF_SURFACE',
      path: 'feet.left.2',
    },
    {
      name: 'swing path through the step (no clearance, no lift-first delay)',
      base: stepUp,
      mutate: (p) => {
        const s = p.feet.left[1]!;
        if (s.kind !== 'swing') throw new Error('setup');
        Object.assign(s, { clearance: 0, horizontalDelay: 0, horizontalLead: 0, riseEnd: 0.95, descendStart: 0.95 });
      },
      code: 'SWING_COLLISION',
    },
    { name: 'phase gap', base: squat, mutate: (p) => void (p.phases[1]!.start += 0.2), code: 'PHASE_INVALID', path: 'phases.1' },
    { name: 'duplicate phase id', base: squat, mutate: (p) => void (p.phases[1]!.id = p.phases[0]!.id), code: 'PHASE_INVALID', path: 'phases.1' },
    { name: 'cue outside its phase', base: squat, mutate: (p) => void (p.cues[0]!.t = p.duration), code: 'CUE_INVALID', path: 'cues.0' },
    { name: 'cue referencing an unknown phase', base: squat, mutate: (p) => void (p.cues[0]!.phaseId = 'nope'), code: 'CUE_INVALID', path: 'cues.0' },
    {
      name: 'track keys not strictly increasing',
      base: squat,
      mutate: (p) => void (p.pelvis.y.keys[2]!.t = p.pelvis.y.keys[1]!.t),
      code: 'SCHEMA_INVALID',
      path: 'pelvis.y',
    },
    {
      name: 'heel lift above 0.2 m',
      base: heel,
      mutate: (p) => {
        const s = p.feet.left[1]!;
        if (s.kind !== 'forefoot') throw new Error('setup');
        s.heelLift.keys[1]!.v = 0.25;
        s.heelLift.keys[2]!.v = 0.25;
      },
      code: 'UNSUPPORTED_CONFIGURATION',
      path: 'feet.left.1',
    },
    {
      name: 'swing riseEnd after descendStart',
      base: stepUp,
      mutate: (p) => {
        const s = p.feet.left[1]!;
        if (s.kind !== 'swing') throw new Error('setup');
        s.riseEnd = 0.9;
        s.descendStart = 0.3;
      },
      code: 'SCHEMA_INVALID',
      path: 'feet.left.1',
    },
    { name: 'plan compiled for another rig (fingerprint)', base: squat, mutate: (p) => void (p.rig = { ...p.rig, fingerprint: '0000000000000000' }), code: 'RIG_INVALID' },
    { name: 'NaN in a foot anchor', base: squat, mutate: (p) => void ((p.feet.left[0] as { anchor: { x: number } }).anchor.x = Number.NaN), code: 'SCHEMA_INVALID' },
  ];
  for (const c of cases)
    it(`${c.name} ⇒ ${c.code}${c.path ? ` at ${c.path}` : ''}`, () => {
      const p = mutated(c.base, c.mutate);
      let ds: Diagnostic[] = [];
      expect(() => {
        ds = validatePlan(p, rigA);
      }).not.toThrow();
      expectError(ds, c.code, c.path, c.msg);
    });

  it('the unmutated recipe plans are valid (the cases above fail for the stated reason only)', () => {
    for (const p of [squat, sts, stepUp, heel]) expect(errs(validatePlan(p, rigA))).toEqual([]);
  });
});

describe('invalid geometry (validateEnvironment, and inside a plan via validatePlan)', () => {
  const env = (objects: unknown[]): Environment => ({ schema: 'smx.environment/1', units: 'm', objects }) as Environment;
  const floor = { kind: 'floor', id: 'floor' };
  const chair = { kind: 'chair', id: 'chair', seatHeight: 0.46, seatDepth: 0.46, seatWidth: 0.46, seatThickness: 0.05, frontZ: 0, centerX: 0, backrestHeight: 0.4 };
  const step = { kind: 'step', id: 'step', height: 0.15, depth: 0.36, width: 0.8, frontZ: 0.3, centerX: 0 };
  const cases: { name: string; e: Environment; msg?: string }[] = [
    { name: 'NaN seat height', e: env([floor, { ...chair, seatHeight: Number.NaN }]) },
    { name: 'Infinity step width', e: env([floor, { ...step, width: Number.POSITIVE_INFINITY }]) },
    { name: 'negative step depth', e: env([floor, { ...step, depth: -0.36 }]) },
    { name: 'zero seat width', e: env([floor, { ...chair, seatWidth: 0 }]) },
    { name: 'string chair height', e: env([floor, { ...chair, seatHeight: '0.46' }]) },
    { name: 'step 0.5 m high', e: env([floor, { ...step, height: 0.5 }]), msg: 'outside supported' },
    { name: 'chair seat 1 m high', e: env([floor, { ...chair, seatHeight: 1.0 }]), msg: 'outside supported' },
    { name: 'seat thicker than its height', e: env([floor, { ...chair, seatHeight: 0.3, seatThickness: 0.35 }]) },
    { name: 'chair seat intersecting the step', e: env([floor, { ...chair, seatHeight: 0.3 }, { ...step, height: 0.3, frontZ: -0.2 }]), msg: 'intersect' },
    { name: 'duplicate object ids', e: env([floor, chair, { ...step, id: 'chair', frontZ: 1 }]), msg: 'duplicate' },
    { name: 'no floor', e: env([chair]), msg: 'floor' },
    { name: 'two floors', e: env([floor, { kind: 'floor', id: 'floor2' }]), msg: 'floor' },
    { name: 'empty object list', e: env([]) },
    { name: 'unknown object kind', e: env([floor, { kind: 'ramp', id: 'ramp', height: 0.1 }]) },
    { name: 'wrong units', e: { ...env([floor]), units: 'cm' } as unknown as Environment },
  ];
  for (const c of cases)
    it(`${c.name} ⇒ INVALID_GEOMETRY`, () => {
      let r: ReturnType<typeof validateEnvironment> | undefined;
      expect(() => {
        r = validateEnvironment(c.e);
      }).not.toThrow();
      expectError(r!.diagnostics, 'INVALID_GEOMETRY', undefined, c.msg);
      // inside a plan the same problem is an error too (schema or geometry)
      const p = mutated(sts, (q) => void (q.environment = c.e));
      const ds = validatePlan(p, rigA);
      expect(codes(ds).some((x) => x === 'INVALID_GEOMETRY' || x === 'SCHEMA_INVALID'), fmt(ds)).toBe(true);
    });

  it('foot state on an unknown surface id ⇒ INVALID_GEOMETRY at its path', () => {
    const p = mutated(squat, (q) => {
      const s = q.feet.left[0]!;
      if (s.kind === 'swing') throw new Error('setup');
      s.surface = 'step.top';
    });
    expectError(validatePlan(p, rigA), 'INVALID_GEOMETRY', 'feet.left.0');
  });

  it('seat contact on an unknown surface id ⇒ INVALID_GEOMETRY', () => {
    expectError(validatePlan(mutated(sts, (q) => void (q.seat!.surface = 'sofa.seat')), rigA), 'INVALID_GEOMETRY');
  });

  it('a step whose tread cannot hold the foot is rejected at compile time with a path', () => {
    const r = compileRecipe('step-up-down.v1', { stepDepth: 0.3 }, buildCanonicalRig('big-feet', 'big feet', scaleProportions(PROPORTIONS_A, { foot: 1.15 })));
    expect(r.ok).toBe(false);
    expectError(r.diagnostics, 'UNSUPPORTED_CONFIGURATION', 'params.stepDepth');
  });
});

describe('missing articulation and capability mismatches', () => {
  const ALLOWED = ['MISSING_CAPABILITY', 'MISSING_BONE', 'RIG_INVALID'];
  const withoutMtp = (claimsForefoot: boolean): RigDefinition => {
    const r = structuredClone(rigA);
    r.id = claimsForefoot ? 'no-mtp-claims-forefoot' : 'no-mtp';
    r.joints = r.joints.filter((j) => !j.name.startsWith('mtp'));
    r.sites = r.sites.filter((s) => !s.joint.startsWith('mtp'));
    if (!claimsForefoot) r.capabilities = r.capabilities.filter((c) => c !== 'forefoot-articulation');
    return r;
  };
  const expectRejectedFor = (rig: RigDefinition, recipeId: string, mention: RegExp) => {
    let r: ReturnType<typeof compileRecipe> | undefined;
    expect(() => {
      r = compileRecipe(recipeId, {}, rig);
    }).not.toThrow();
    expect(r!.ok, `${recipeId} on ${rig.id} must be rejected`).toBe(false);
    const e = errs(r!.diagnostics);
    expect(e.length).toBeGreaterThan(0);
    for (const d of e) expect(ALLOWED, `${d.code}: ${d.message}`).toContain(d.code);
    expect(e.some((d) => mention.test(`${d.message} ${d.subject ?? ''}`)), fmt(e)).toBe(true);
    expect(e.some((d) => d.message.includes('recipe build failed')), 'must not be the exception catch-all').toBe(false);
  };

  for (const id of ['bilateral-heel-raise.v1', 'step-up-down.v1'])
    it(`${id}: rig without MTP joints / toe sites (capability not claimed) ⇒ rejected with a missing-joint/capability diagnostic`, () => {
      expectRejectedFor(withoutMtp(false), id, /mtp|forefoot/i);
    });
  for (const id of ['bilateral-heel-raise.v1', 'step-up-down.v1'])
    it(`${id}: rig that CLAIMS forefoot-articulation but lacks MTP joints ⇒ rejected (the claim is checked)`, () => {
      expectRejectedFor(withoutMtp(true), id, /mtp/i);
    });
  for (const id of ['bilateral-squat.v1', 'sit-to-stand.v1'])
    it(`${id}: rig without MTP joints ⇒ rejected with MISSING_BONE-class diagnostics, not an exception message`, () => {
      expectRejectedFor(withoutMtp(false), id, /mtp/i);
    });

  it('a rig that lacks a declared capability ⇒ MISSING_CAPABILITY naming it, for every recipe requiring it', () => {
    const rig = structuredClone(rigA);
    rig.id = 'no-knee-hinge-claim';
    rig.capabilities = rig.capabilities.filter((c) => c !== 'knee-hinge');
    for (const recipe of listRecipes()) {
      expect(recipe.requiredCapabilities).toContain('knee-hinge' as Capability);
      const r = compileRecipe(recipe.id, {}, rig);
      expect(r.ok).toBe(false);
      expect(errs(r.diagnostics).some((d) => (d.code === 'MISSING_CAPABILITY' && d.subject === 'knee-hinge') || d.code === 'RIG_INVALID'), fmt(r.diagnostics)).toBe(true);
    }
  });

  it('sit-to-stand on a rig without a seat site ⇒ rejected naming the seat', () => {
    const rig = structuredClone(rigA);
    rig.id = 'no-seat-site';
    rig.sites = rig.sites.filter((s) => s.name !== 'seat');
    expectRejectedFor(rig, 'sit-to-stand.v1', /seat/i);
  });

  it('a rig without trunk/arm joints: recipes needing them are refused; others either compile to a valid, in-tolerance plan or are refused explicitly', () => {
    const rig = structuredClone(rigA);
    rig.id = 'no-trunk';
    const drop = new Set(['lumbar', 'thoracic', 'neck', 'shoulder_L', 'elbow_L', 'wrist_L', 'shoulder_R', 'elbow_R', 'wrist_R']);
    rig.joints = rig.joints.filter((j) => !drop.has(j.name));
    rig.sites = rig.sites.filter((s) => !drop.has(s.joint));
    rig.capabilities = rig.capabilities.filter((c) => !['trunk-articulation', 'independent-arms', 'neck'].includes(c));
    for (const recipe of listRecipes()) {
      let r: ReturnType<typeof compileRecipe> | undefined;
      expect(() => {
        r = compileRecipe(recipe.id, {}, rig);
      }).not.toThrow();
      if (recipe.requiredCapabilities.includes('trunk-articulation')) {
        expect(r!.ok).toBe(false);
        expectError(r!.diagnostics, 'MISSING_CAPABILITY');
      } else if (r!.ok) {
        expect(errs(validatePlan(r!.plan, rig))).toEqual([]);
        if (r!.feasible) expect(analyzePlan(r!.plan, rig, 'stabilized').failures).toEqual([]);
      } else {
        for (const d of errs(r!.diagnostics)) expect(ALLOWED).toContain(d.code);
      }
    }
  });
});

describe('plans animating joints / DOFs the rig lacks or the solver owns', () => {
  it("unknown joint ⇒ MISSING_BONE at joints.<name>; sampling it fails loudly instead of ignoring the track", () => {
    const p = mutated(squat, (q) => void (q.joints['tail'] = { flexion: { keys: [{ t: 0, v: 0.1, mode: 'stop' }] } }));
    expectError(validatePlan(p, rigA), 'MISSING_BONE', 'joints.tail');
    expect(() => samplePose(p, rigA, 1, 'stabilized')).toThrow(/tail/);
  });

  it('plan compiled for rig A validated against a rig without MTP joints ⇒ errors (fingerprint and/or missing bones)', () => {
    const r = structuredClone(rigA);
    r.id = 'no-mtp';
    r.joints = r.joints.filter((j) => !j.name.startsWith('mtp'));
    r.sites = r.sites.filter((s) => !s.joint.startsWith('mtp'));
    let ds: Diagnostic[] = [];
    expect(() => {
      ds = validatePlan(heel, r);
    }).not.toThrow();
    expect(errs(ds).length).toBeGreaterThan(0);
  });

  it('unknown DOF on an existing joint ⇒ validation error at joints.<joint>.<dof> (a validated plan must be samplable)', () => {
    const p = mutated(squat, (q) => void (q.joints['lumbar']!['twist'] = { keys: [{ t: 0, v: 0.1, mode: 'stop' }] }));
    const ds = validatePlan(p, rigA);
    expect(errs(ds).some((d) => (d.path ?? '').startsWith('joints.lumbar') && ['MISSING_BONE', 'SCHEMA_INVALID'].includes(d.code)), fmt(ds) || '(validatePlan accepted it)').toBe(true);
  });

  for (const [joint, dof] of [
    ['root', 'heading'],
    ['pelvis', 'tilt'],
    ['hip_L', 'flexion'],
    ['knee_L', 'flexion'],
    ['ankle_R', 'dorsiflexion'],
    ['mtp_L', 'extension'],
  ] as const)
    it(`a joints track on solver-owned '${joint}' is rejected (it would override the solved / authored rotation)`, () => {
      const p = mutated(squat, (q) => void (q.joints[joint] = { [dof]: { keys: [{ t: 0, v: 0.3, mode: 'stop' }] } }));
      const ds = validatePlan(p, rigA);
      expect(errs(ds).some((d) => (d.path ?? '').startsWith(`joints.${joint}`)), fmt(ds) || '(validatePlan accepted it)').toBe(true);
      // whatever validation says, the metrics must not call it clean
      expect(analyzePlan(p, rigA, 'stabilized', 30).withinTolerance).toBe(false);
    });
});

describe('malformed recipe parameters ⇒ specific codes with paths; compile never throws', () => {
  const compileSafe = (id: string, params: unknown) => {
    let r: ReturnType<typeof compileRecipe> | undefined;
    expect(() => {
      r = compileRecipe(id, params as ParamRecord, rigA);
    }).not.toThrow();
    expect(r!.ok).toBe(false);
    return r!.diagnostics;
  };
  for (const recipe of listRecipes()) {
    const num = recipe.paramSpecs.find((s) => s.kind === 'number');
    if (!num || num.kind !== 'number') continue;
    const k = num.key;
    it(`${recipe.id}: wrong types, non-finite numbers and out-of-range values of '${k}'`, () => {
      for (const bad of ['70', '', true, null, {}, [], Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
        expectError(compileSafe(recipe.id, { [k]: bad }), 'SCHEMA_INVALID', `params.${k}`);
      for (const v of [num.min - num.step, num.max + num.step, -1e9, 1e9])
        expectError(compileSafe(recipe.id, { [k]: v }), 'PARAM_OUT_OF_RANGE', `params.${k}`);
    });
    it(`${recipe.id}: unknown and near-miss keys are rejected (no fuzzy matching)`, () => {
      expectError(compileSafe(recipe.id, { bogus: 1 }), 'SCHEMA_INVALID', 'params.bogus');
      expectError(compileSafe(recipe.id, { [k.toLowerCase() === k ? k.toUpperCase() : k.toLowerCase()]: num.default }), 'SCHEMA_INVALID', 'params.');
      expectError(compileSafe(recipe.id, { [`${k} `]: num.default }), 'SCHEMA_INVALID', 'params.');
      // several problems reported in one pass
      const ds = compileSafe(recipe.id, { bogus: 1, [k]: 'x' });
      expectError(ds, 'SCHEMA_INVALID', 'params.bogus');
      expectError(ds, 'SCHEMA_INVALID', `params.${k}`);
    });
    it(`${recipe.id}: a params value that is not an object ⇒ SCHEMA_INVALID at 'params'`, () => {
      for (const bad of [null, undefined, [], 42, 'abc', true]) expectError(compileSafe(recipe.id, bad), 'SCHEMA_INVALID', 'params');
    });
    const count = recipe.paramSpecs.find((s) => s.kind === 'number' && s.unit === 'count');
    if (count)
      it(`${recipe.id}: fractional '${count.key}' ⇒ SCHEMA_INVALID`, () => {
        for (const v of [1.5, 2.0000001, 3.9]) expectError(compileSafe(recipe.id, { [count.key]: v }), 'SCHEMA_INVALID', `params.${count.key}`);
      });
  }
  it('step-up: invalid leading sides ⇒ PARAM_OUT_OF_RANGE at params.upLeadSide / params.downLeadSide', () => {
    for (const bad of ['LEFT', 'l', 'Left ', '', 1, null, true]) {
      expectError(compileSafe('step-up-down.v1', { upLeadSide: bad }), 'PARAM_OUT_OF_RANGE', 'params.upLeadSide');
      expectError(compileSafe('step-up-down.v1', { downLeadSide: bad }), 'PARAM_OUT_OF_RANGE', 'params.downLeadSide');
    }
  });
});

describe('unknown and near-miss recipe ids ⇒ UNKNOWN_RECIPE (no fuzzy matching)', () => {
  const ids = ['squat', 'Bilateral Squat', 'bilateral-squat', 'bilateral-squat.v2', 'BILATERAL-SQUAT.V1', ' bilateral-squat.v1', 'bilateral-squat.v1 ', 'bilateral_squat.v1', 'sit-to-stand', 'step-up-down', 'heel-raise.v1', '', '*'];
  for (const id of ids)
    it(`'${id}'`, () => {
      expect(getRecipe(id)).toBeNull();
      const r = compileRecipe(id, {}, rigA);
      expect(r.ok).toBe(false);
      expect(codes(r.diagnostics)).toEqual(['UNKNOWN_RECIPE']);
      expect(errs(r.diagnostics)[0]!.hint).toMatch(/bilateral-squat\.v1/);
    });
});

describe('stabilisation bounds above 5 cm are unsupported', () => {
  for (const b of [
    [0.051, 0.03, 0.02],
    [0.02, 0.2, 0.02],
    [0.02, 0.03, 1],
    [-0.01, 0.03, 0.02],
  ] as [number, number, number][])
    it(`bounds ${JSON.stringify(b)} ⇒ UNSUPPORTED_CONFIGURATION at stabilization.bounds`, () => {
      expectError(validatePlan(mutated(squat, (p) => void (p.stabilization.bounds = b)), rigA), 'UNSUPPORTED_CONFIGURATION', 'stabilization.bounds');
    });
  it('bounds of exactly 5 cm per axis are accepted', () => {
    const ds = validatePlan(mutated(squat, (p) => void (p.stabilization.bounds = [0.05, 0.05, 0.05])), rigA);
    expect(errs(ds)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Seeded mutation fuzz.
// ---------------------------------------------------------------------------------------------

type Json = unknown;
type Container = Record<string, Json> | Json[];

function containers(root: Json): { parent: Container; key: string | number }[] {
  const out: { parent: Container; key: string | number }[] = [];
  const walk = (node: Json) => {
    if (Array.isArray(node)) node.forEach((v, i) => (out.push({ parent: node, key: i }), walk(v)));
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) (out.push({ parent: node as Record<string, Json>, key: k }), walk(v));
  };
  walk(root);
  return out;
}

const STRINGS = ['', 'flat', 'forefoot', 'swing', 'floor', 'step.top', 'chair.seat', 'nope', 'left', 'stop', 'flow', 'smx.motion-plan/2', 'x'.repeat(200)];
const NUMBERS = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 1e9, -1e-9, 1e-300, 0.2, 3.2, 100];
const KEYS = ['twist', 'tail', 'knee_L', 'root', 'pelvis', '__proto__', 'constructor', 'kind', 'start', 'end'];

function mutateOnce(rng: Rng, root: Json): string {
  const cs = containers(root);
  const { parent, key } = rng.pick(cs);
  const get = () => (parent as Record<string | number, Json>)[key];
  const set = (v: Json) => ((parent as Record<string | number, Json>)[key] = v);
  const v = get();
  const op = rng.int(0, 9);
  if (typeof v === 'number') {
    if (op < 4) set(rng.pick(NUMBERS));
    else if (op < 7) set(v * (1 + rng.range(-0.3, 0.3)));
    else if (op < 8) set(v + rng.range(-0.5, 0.5));
    else set(rng.pick([String(v), null, true, -v]));
    return `num ${String(key)}`;
  }
  if (typeof v === 'string') {
    set(op < 7 ? rng.pick(STRINGS) : rng.pick([42, null, false]));
    return `str ${String(key)}`;
  }
  if (typeof v === 'boolean') {
    set(op < 6 ? !v : rng.pick([0, 'true', null]));
    return `bool ${String(key)}`;
  }
  if (Array.isArray(v)) {
    if (v.length && op < 3) v.splice(rng.int(0, v.length - 1), 1);
    else if (v.length && op < 5) v.splice(rng.int(0, v.length), 0, structuredClone(rng.pick(v)));
    else if (v.length > 1 && op < 7) {
      const i = rng.int(0, v.length - 1);
      const j = rng.int(0, v.length - 1);
      [v[i], v[j]] = [v[j], v[i]];
    } else if (op < 8) v.reverse();
    else if (op < 9) set([]);
    else set(rng.pick([null, {}, 'x']));
    return `arr ${String(key)}`;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, Json>;
    const ks = Object.keys(o);
    if (ks.length && op < 4) delete o[rng.pick(ks)];
    else if (ks.length && op < 7) {
      const from = rng.pick(ks);
      const to = rng.pick(KEYS);
      if (to !== '__proto__') o[to] = o[from];
      delete o[from];
    } else if (op < 8) o[rng.pick(KEYS)] = structuredClone(rng.pick(Object.values(o).length ? Object.values(o) : [1]));
    else set(rng.pick([null, [], 'x', 0]));
    return `obj ${String(key)}`;
  }
  set(rng.pick([0, 'x', {}, []]));
  return `null ${String(key)}`;
}

describe('seeded mutation fuzz of plan JSON through validatePlan', () => {
  const bases: [string, MotionPlan][] = [
    ['step-up', stepUp],
    ['sit-to-stand', sts],
    ['heel-raise', heel],
    ['squat', squat],
  ];
  const CASES = 640;
  it(`${CASES} mutated plans: validatePlan never throws, returns well-formed diagnostics; accepted mutants are samplable`, () => {
    const rng = createRng(0xf022);
    let accepted = 0;
    let rejected = 0;
    const problems: string[] = [];
    for (let i = 0; i < CASES; i++) {
      const [name, base] = bases[i % bases.length]!;
      const doc: Json = JSON.parse(JSON.stringify(base));
      const ops: string[] = [];
      const n = rng.int(1, 3);
      for (let m = 0; m < n; m++) ops.push(mutateOnce(rng, doc));
      let ds: Diagnostic[] | undefined;
      const t0 = performance.now();
      try {
        ds = validatePlan(doc, rigA);
      } catch (e) {
        problems.push(`#${i} ${name} [${ops.join('; ')}]: validatePlan threw ${(e as Error).message}`);
        continue;
      }
      const ms = performance.now() - t0;
      if (ms > 2000) problems.push(`#${i} ${name} [${ops.join('; ')}]: validatePlan took ${ms.toFixed(0)} ms`);
      if (!Array.isArray(ds)) {
        problems.push(`#${i}: not an array`);
        continue;
      }
      for (const d of ds)
        if (!DIAGNOSTIC_CODES.includes(d.code) || !['info', 'warning', 'error'].includes(d.severity) || typeof d.message !== 'string' || !d.message)
          problems.push(`#${i}: malformed diagnostic ${JSON.stringify(d)}`);
      if (errs(ds).length) {
        rejected++;
        continue;
      }
      accepted++;
      // Oracle: a plan validatePlan accepts must be samplable in every tier without throwing.
      const plan = doc as MotionPlan;
      for (const tier of TIERS)
        for (const f of [0, 0.31, 0.67, 1]) {
          try {
            const s: PoseSample = samplePose(plan, rigA, plan.duration * f, tier);
            if (!s.worldPos.every((p) => p.every(Number.isFinite))) problems.push(`#${i} ${name} [${ops.join('; ')}]: non-finite pose (${tier}, f=${f})`);
          } catch (e) {
            problems.push(`#${i} ${name} [${ops.join('; ')}]: accepted by validatePlan but samplePose threw: ${(e as Error).message}`);
          }
        }
    }
    console.info(`[fuzz] ${CASES} mutants: ${rejected} rejected with errors, ${accepted} accepted (and sampled); ${problems.length} problems`);
    expect(problems.slice(0, 10)).toEqual([]);
    expect(rejected).toBeGreaterThan(CASES / 2);
  });

  it('non-object inputs never throw', () => {
    for (const bad of [null, undefined, 42, 'plan', [], {}, { schema: 'smx.motion-plan/1' }, JSON.parse('{"__proto__": {"x": 1}}')])
      expect(() => validatePlan(bad, rigA)).not.toThrow();
    for (const bad of [null, undefined, 42, 'plan', []]) expectError(validatePlan(bad, rigA), 'SCHEMA_INVALID');
  });
});
