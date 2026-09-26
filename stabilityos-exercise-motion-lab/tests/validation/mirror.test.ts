/**
 * Left/right mirror symmetry. The mirror of a pose across the sagittal (YZ) plane is derived here
 * independently of the engine's mirrorPlan:
 *   positions  p → M p            (x → −x), joint and site names swap _L ↔ _R
 *   rotations  R → M R M          (M = diag(−1, 1, 1)), compared as matrices
 *   DOF angles  L/R joints keep their values on the swapped joint (right-side Y/Z DOF axes are
 *              already sign-mirrored); centre joints negate their Y- and Z-axis DOFs.
 * Checks: (1) step-up with right leading sides is the exact mirror of left leading sides;
 * (2) mirrorPlan(plan, fingerprint(mirrored rig)) on an asymmetric rig (left leg +10 mm), sampled
 * on the mirrored rig, is the exact mirror of the original, and compiling the mirrored request on
 * the mirrored rig gives the same result (compiler equivariance); (3) bilateral recipes on rig A
 * are self-symmetric. Tolerance 1e-9 (m, matrix entries, rad).
 */
import { describe, expect, it } from 'vitest';
import {
  buildCanonicalRig,
  compileRecipe,
  createRigA,
  listRecipes,
  mirrorPlan,
  mirrorProportions,
  PROPORTIONS_A,
  samplePose,
  scaleProportions,
  validatePlan,
  type PoseSample,
} from '../../src/core/engine.ts';
import type { MotionPlan } from '../../src/core/contracts/plan.ts';
import type { RigDefinition } from '../../src/core/contracts/rig.ts';
import { rigFingerprint } from '../../src/core/rig/model.ts';
import { maxAbsDiff, mirrorMat, qmat, swapSide, TIERS } from './support.ts';

const TOL = 1e-9;
const rigA = createRigA();
const lldProps = scaleProportions(PROPORTIONS_A, { leftLegExtra: 0.01 });
const rigLld = buildCanonicalRig('validation-lld', 'Rig A, left leg +10 mm', lldProps);
const rigLldM = buildCanonicalRig('validation-lld-mirrored', 'Rig A, right leg +10 mm', mirrorProportions(lldProps));

function mustCompile(id: string, params: Record<string, string | number>, rig: RigDefinition): MotionPlan {
  const r = compileRecipe(id, params, rig);
  if (!r.ok) throw new Error(`${id} ${JSON.stringify(params)} rejected on ${rig.id}: ${r.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code}: ${d.message}`).join(' | ')}`);
  return r.plan;
}

/** Worst deviation of `b` (on rigB) from the independently derived mirror image of `a` (on rigA), per quantity. */
function mirrorError(a: PoseSample, rigAIn: RigDefinition, b: PoseSample, rigBIn: RigDefinition): { worst: number; where: string } {
  let worst = 0;
  let where = '';
  const note = (v: number, w: string) => {
    if (v > worst) {
      worst = v;
      where = w;
    }
  };
  rigAIn.joints.forEach((jt, j) => {
    const k = rigBIn.joints.findIndex((x) => x.name === swapSide(jt.name));
    if (k < 0) throw new Error(`mirrored rig lacks ${swapSide(jt.name)}`);
    const p = a.worldPos[j]!;
    note(maxAbsDiff([-p[0], p[1], p[2]], b.worldPos[k]!), `${jt.name} position`);
    note(maxAbsDiff(mirrorMat(qmat(a.worldRot[j]!)), qmat(b.worldRot[k]!)), `${jt.name} world rotation`);
    note(maxAbsDiff(mirrorMat(qmat(a.local[j]!)), qmat(b.local[k]!)), `${jt.name} local rotation`);
    const centre = swapSide(jt.name) === jt.name;
    const expected = jt.dofs.map((d, i) => (centre && d.axis !== 0 ? -a.angles[j]![i]! : a.angles[j]![i]!));
    note(maxAbsDiff(expected, b.angles[k]!), `${jt.name} DOF angles`);
  });
  rigAIn.sites.forEach((st, s) => {
    const k = rigBIn.sites.findIndex((x) => x.name === swapSide(st.name));
    const p = a.sitePos[s]!;
    note(maxAbsDiff([-p[0], p[1], p[2]], b.sitePos[k]!), `site ${st.name}`);
  });
  const r = a.rootTranslation;
  note(maxAbsDiff([-r[0], r[1], r[2]], b.rootTranslation), 'root translation');
  const o = a.stabilization.offset;
  note(maxAbsDiff([-o[0], o[1], o[2]], b.stabilization.offset), 'stabiliser offset');
  return { worst, where };
}

function sampleTimes(plan: MotionPlan, n = 240): number[] {
  const ts = new Set<number>();
  for (let k = 0; k <= n; k++) ts.add((plan.duration * k) / n);
  for (const p of plan.phases) ts.add(p.end);
  for (const s of [...plan.feet.left, ...plan.feet.right]) ts.add(s.start);
  return [...ts].sort((x, y) => x - y);
}

function assertMirrored(label: string, pa: MotionPlan, ra: RigDefinition, pb: MotionPlan, rb: RigDefinition): void {
  expect(pb.duration).toBe(pa.duration);
  let worst = 0;
  let where = '';
  for (const tier of TIERS)
    for (const t of sampleTimes(pa)) {
      const e = mirrorError(samplePose(pa, ra, t, tier), ra, samplePose(pb, rb, t, tier), rb);
      if (e.worst > worst) {
        worst = e.worst;
        where = `${tier} t=${t.toFixed(4)} ${e.where}`;
      }
    }
  console.info(`[mirror] ${label}: worst deviation ${worst.toExponential(2)} (${where || 'none'})`);
  expect(worst, `${label}: worst at ${where}`).toBeLessThanOrEqual(TOL);
}

describe('mirror oracle sanity', () => {
  it('M R M of a Y rotation is the inverse Y rotation; X rotations are unchanged', () => {
    const ry = [0, Math.sin(0.2), 0, Math.cos(0.2)];
    const ryInv = [0, -Math.sin(0.2), 0, Math.cos(0.2)];
    const rx = [Math.sin(0.3), 0, 0, Math.cos(0.3)];
    expect(maxAbsDiff(mirrorMat(qmat(ry)), qmat(ryInv))).toBeLessThan(1e-15);
    expect(maxAbsDiff(mirrorMat(qmat(rx)), qmat(rx))).toBeLessThan(1e-15);
  });
  it('the comparison has teeth: an un-mirrored step-up differs from its mirror by centimetres', () => {
    const p = mustCompile('step-up-down.v1', { upLeadSide: 'left', downLeadSide: 'left' }, rigA);
    const e = mirrorError(samplePose(p, rigA, 2.0), rigA, samplePose(p, rigA, 2.0), rigA);
    expect(e.worst).toBeGreaterThan(0.01);
  });
});

describe('step-up: right leading sides are the exact mirror of left leading sides (rig A)', () => {
  const pairs = [
    [{ upLeadSide: 'left', downLeadSide: 'left' }, { upLeadSide: 'right', downLeadSide: 'right' }],
    [{ upLeadSide: 'left', downLeadSide: 'right' }, { upLeadSide: 'right', downLeadSide: 'left' }],
  ] as const;
  for (const [l, r] of pairs) {
    const name = `${l.upLeadSide}/${l.downLeadSide} ↔ ${r.upLeadSide}/${r.downLeadSide}`;
    it(`${name}: whole-body pose (legs, pelvis, trunk, arms, sites), all tiers`, () => {
      assertMirrored(`step-up ${name}`, mustCompile('step-up-down.v1', l, rigA), rigA, mustCompile('step-up-down.v1', r, rigA), rigA);
    });
    it(`${name}: foot-state schedules are mirror images (sides swapped, anchor x and yaw negated, same times)`, () => {
      const a = mustCompile('step-up-down.v1', l, rigA);
      const b = mustCompile('step-up-down.v1', r, rigA);
      for (const [sa, sb] of [
        ['left', 'right'],
        ['right', 'left'],
      ] as const) {
        const fa = a.feet[sa];
        const fb = b.feet[sb];
        expect(fb.map((s) => [s.kind, s.start, s.end])).toEqual(fa.map((s) => [s.kind, s.start, s.end]));
        fa.forEach((s, i) => {
          const m = fb[i]!;
          if (s.kind === 'swing' || m.kind === 'swing') return;
          expect(m.surface).toBe(s.surface);
          expect(Math.abs(m.anchor.x + s.anchor.x)).toBeLessThanOrEqual(1e-12);
          expect(Math.abs(m.anchor.z - s.anchor.z)).toBeLessThanOrEqual(1e-12);
          expect(Math.abs(m.anchor.yaw + s.anchor.yaw)).toBeLessThanOrEqual(1e-12);
        });
      }
    });
  }
});

describe('mirrorPlan on an asymmetric rig (left leg +10 mm) sampled on the mirrored rig', () => {
  const fpM = rigFingerprint(rigLldM);
  const cases: { name: string; id: string; params: Record<string, string>; mirroredParams: Record<string, string> }[] = [];
  for (const recipe of listRecipes()) {
    if (recipe.id === 'step-up-down.v1')
      for (const up of ['left', 'right'])
        for (const down of ['left', 'right'])
          cases.push({
            name: `${recipe.id} ${up}/${down}`,
            id: recipe.id,
            params: { upLeadSide: up, downLeadSide: down },
            mirroredParams: { upLeadSide: up === 'left' ? 'right' : 'left', downLeadSide: down === 'left' ? 'right' : 'left' },
          });
    else cases.push({ name: recipe.id, id: recipe.id, params: {}, mirroredParams: {} });
  }
  for (const c of cases) {
    it(`${c.name}: mirrorPlan validates on the mirrored rig and samples as the exact mirror`, () => {
      const plan = mustCompile(c.id, c.params, rigLld);
      const before = JSON.stringify(plan);
      const mirrored = mirrorPlan(plan, fpM);
      expect(JSON.stringify(plan), 'mirrorPlan must not mutate its input').toBe(before);
      expect(validatePlan(mirrored, rigLldM).filter((d) => d.severity === 'error')).toEqual([]);
      expect(mirrored.recipe.params).toEqual({ ...plan.recipe.params, ...c.mirroredParams });
      assertMirrored(`mirrorPlan ${c.name} (lld → lld mirrored)`, plan, rigLld, mirrored, rigLldM);
    });
    it(`${c.name}: compiling the mirrored request on the mirrored rig equals the mirror (compiler equivariance)`, () => {
      const plan = mustCompile(c.id, c.params, rigLld);
      const direct = mustCompile(c.id, c.mirroredParams, rigLldM);
      assertMirrored(`compile-mirrored ${c.name}`, plan, rigLld, direct, rigLldM);
    });
  }
});

describe('bilateral recipes are left/right self-symmetric on rig A', () => {
  for (const recipe of listRecipes().filter((r) => r.id !== 'step-up-down.v1')) {
    it(`${recipe.id}: pose equals its own mirror image at every sampled time, all tiers`, () => {
      const plan = mustCompile(recipe.id, {}, rigA);
      assertMirrored(`${recipe.id} self-symmetry`, plan, rigA, plan, rigA);
    });
  }
});
