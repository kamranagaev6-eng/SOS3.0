/**
 * The comparison baseline must actually demonstrate the host problem it stands for: the SAME
 * solved joint angles replayed on a body whose pelvis is frozen at its t=0 transform (a
 * joint-rotation-only rig). For every recipe's defaults:
 *  - the baseline is a fair replay (every joint below the pelvis has bitwise the solved local
 *    rotation; root/pelvis equal the solved t=0 pose), so the comparison is not rigged;
 *  - planted-foot displacement or penetration exceeds 20 mm (squat, sit-to-stand, step-up) /
 *    10 mm (heel raise), both from the engine's clip metrics and from an independent measure
 *    (sole points vs their anchor-derived planted positions);
 *  - the stabilized tier on the same plan is within every tolerance.
 * Geometric comparison of synthetic fixtures, not clinical validation.
 */
import { describe, expect, it } from 'vitest';
import { analyzePlan, compileRecipe, createRigA, listRecipes, samplePose } from '../../src/core/engine.ts';
import type { RigDefinition } from '../../src/core/contracts/rig.ts';
import { activeStateIndex, firstBitDiff, flatFootSites, jointIdx, loadRigB, siteIdx, surfaceHeight, vdist } from './support.ts';

const THRESHOLD: Record<string, number> = {
  'sit-to-stand.v1': 0.02,
  'bilateral-squat.v1': 0.02,
  'step-up-down.v1': 0.02,
  'bilateral-heel-raise.v1': 0.01,
};

const rigA = createRigA();
const rigBInfo = await loadRigB();
console.info(`[baseline] ${rigBInfo.note}`);
const rigs: { id: string; rig: RigDefinition }[] = [{ id: 'rig A', rig: rigA }];
if (rigBInfo.rig) rigs.push({ id: 'rig B', rig: rigBInfo.rig.rig });

describe('baseline (pelvis frozen at t=0) demonstrates the host problem; stabilized solves it', () => {
  for (const { id, rig } of rigs)
    for (const recipe of listRecipes()) {
      const thr = THRESHOLD[recipe.id]!;
      it(`${recipe.id} defaults on ${id}: baseline planted displacement or penetration > ${thr * 1000} mm, stabilized within tolerance`, () => {
        const r = compileRecipe(recipe.id, {}, rig);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const plan = r.plan;

        // Fairness: the baseline is exactly the solved angles with the pelvis frozen.
        const rootJ = jointIdx(rig, 'root');
        const pelvisJ = jointIdx(rig, 'pelvis');
        const s0 = samplePose(plan, rig, 0, 'stabilized');
        for (const t of [0, plan.duration * 0.37, plan.duration * 0.61, plan.duration]) {
          const b = samplePose(plan, rig, t, 'baseline');
          const s = samplePose(plan, rig, t, 'stabilized');
          for (let j = 0; j < rig.joints.length; j++) {
            const ref = j === rootJ || j === pelvisJ ? s0 : s;
            expect(firstBitDiff(b.local[j], ref.local[j]), `${rig.joints[j]!.name} at t=${t}`).toBeNull();
          }
          expect(firstBitDiff(b.rootTranslation, s0.rootTranslation)).toBeNull();
          expect(firstBitDiff(b.pelvisOffset, s0.pelvisOffset)).toBeNull();
        }

        // Engine clip metrics.
        const base = analyzePlan(plan, rig, 'baseline');
        const stab = analyzePlan(plan, rig, 'stabilized');
        const engineWorst = Math.max(base.maxPlantedDisplacement, base.maxPenetration);

        // Independent measure: sole contact points vs where the plan says they are planted.
        let independent = 0;
        let where = '';
        for (let k = 0; k <= Math.ceil(plan.duration * 60); k++) {
          const t = Math.min(plan.duration, k / 60);
          const s = samplePose(plan, rig, t, 'baseline');
          for (const side of ['left', 'right'] as const) {
            const states = plan.feet[side];
            const st = states[activeStateIndex(states, t)]!;
            if (st.kind === 'swing') continue;
            const exp = flatFootSites(rig, side, st.anchor, surfaceHeight(plan.environment, st.surface));
            const sfx = side === 'left' ? '_L' : '_R';
            for (const n of st.kind === 'flat' ? (['heel', 'ball', 'toe'] as const) : (['ball', 'toe'] as const)) {
              const d = vdist(s.sitePos[siteIdx(rig, `${n}${sfx}`)]!, exp[n]);
              if (d > independent) {
                independent = d;
                where = `${n}${sfx} at t=${t.toFixed(2)} s`;
              }
            }
          }
        }
        console.info(
          `[baseline] ${recipe.id} on ${id}: baseline planted displacement ${(base.maxPlantedDisplacement * 1000).toFixed(1)} mm, ` +
            `penetration ${(base.maxPenetration * 1000).toFixed(1)} mm, independent sole-point error ${(independent * 1000).toFixed(1)} mm (${where}); ` +
            `stabilized: displacement ${(stab.maxPlantedDisplacement * 1000).toExponential(2)} mm, penetration ${(stab.maxPenetration * 1000).toExponential(2)} mm, within tolerance ${stab.withinTolerance}`,
        );
        expect(engineWorst, 'baseline must visibly break contacts (engine metrics)').toBeGreaterThan(thr);
        expect(independent, 'baseline must visibly break contacts (independent measure)').toBeGreaterThan(thr);
        expect(base.withinTolerance).toBe(false);
        expect(base.failures.some((f) => f.includes('planted displacement') || f.includes('penetration'))).toBe(true);
        expect(stab.failures).toEqual([]);
        expect(stab.withinTolerance).toBe(true);
      });
    }
});
