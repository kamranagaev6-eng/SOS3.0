/**
 * Contact and kinematic constraints, checked against values computed HERE from the plan's
 * authored anchors / curves and the rig proportions — not via the engine's siteUnderTarget /
 * contactPose / findSurface helpers.
 *
 * Geometric checks of synthetic, unreviewed fixtures. Passing them is NOT clinical validation.
 */
import { describe, expect, it } from 'vitest';
import {
  analyzePlan,
  bakeClip,
  compileRecipe,
  createRigA,
  deriveContactSchedule,
  mirrorPlan,
  samplePose,
  TOLERANCES,
  validatePlan,
  type PoseSample,
} from '../../src/core/engine.ts';
import type { FootState, MotionPlan } from '../../src/core/contracts/plan.ts';
import type { RigDefinition } from '../../src/core/contracts/rig.ts';
import { rigFingerprint } from '../../src/core/rig/model.ts';
import {
  activeStateIndex,
  deepFreeze,
  evalStopTrack,
  firstBitDiff,
  flatFootSites,
  jointIdx,
  loadRigB,
  poseCore,
  qangle,
  qaxis,
  qmul,
  qrot,
  siteIdx,
  surfaceHeight,
  TIERS,
  vdist,
  vdot,
  vnorm,
  vreject,
  vsub,
  type Q,
} from './support.ts';

const DEG = Math.PI / 180;
const SIDES = ['left', 'right'] as const;
type Side = (typeof SIDES)[number];
const sfx = (s: Side) => (s === 'left' ? '_L' : '_R');

const rigA = createRigA();
const rigBInfo = await loadRigB();
console.info(`[constraints] ${rigBInfo.note}`);
const rigs: { id: string; rig: RigDefinition }[] = [{ id: 'rig A', rig: rigA }];
if (rigBInfo.rig) rigs.push({ id: 'rig B', rig: rigBInfo.rig.rig });

interface Case {
  name: string;
  recipe: string;
  params: Record<string, string | number>;
  plan: MotionPlan;
  rig: RigDefinition;
}

function mustCompile(recipe: string, params: Record<string, string | number>, rig: RigDefinition): MotionPlan {
  const r = compileRecipe(recipe, params, rig);
  if (!r.ok) throw new Error(`test setup: ${recipe} ${JSON.stringify(params)} rejected on ${rig.id}: ${r.diagnostics.map((d) => d.message).join(' | ')}`);
  return r.plan;
}

const REQUESTS: { recipe: string; params: Record<string, string | number> }[] = [
  { recipe: 'sit-to-stand.v1', params: {} },
  { recipe: 'sit-to-stand.v1', params: { chairHeight: 0.4 } },
  { recipe: 'sit-to-stand.v1', params: { chairHeight: 0.55, toeOutDeg: 20 } },
  { recipe: 'bilateral-squat.v1', params: {} },
  { recipe: 'step-up-down.v1', params: { upLeadSide: 'left', downLeadSide: 'left' } },
  { recipe: 'step-up-down.v1', params: { upLeadSide: 'left', downLeadSide: 'right' } },
  { recipe: 'step-up-down.v1', params: { upLeadSide: 'right', downLeadSide: 'left' } },
  { recipe: 'step-up-down.v1', params: { upLeadSide: 'right', downLeadSide: 'right' } },
  { recipe: 'bilateral-heel-raise.v1', params: {} },
  { recipe: 'bilateral-heel-raise.v1', params: { heelRise: 0.02, toeOutDeg: 15 } },
  { recipe: 'bilateral-heel-raise.v1', params: { heelRise: 0.1 } },
];

const cases: Case[] = rigs.flatMap(({ id, rig }) =>
  REQUESTS.map((r) => ({
    name: `${r.recipe} ${Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(',') || 'defaults'} on ${id}`,
    recipe: r.recipe,
    params: r.params,
    plan: mustCompile(r.recipe, r.params, rig),
    rig,
  })),
);
const byRecipe = (id: string) => cases.filter((c) => c.recipe === id);

function times(plan: MotionPlan, hz: number): number[] {
  const n = Math.ceil(plan.duration * hz);
  const out: number[] = [];
  for (let k = 0; k <= n; k++) out.push(Math.min(plan.duration, k / hz));
  return out;
}

const siteY = (rig: RigDefinition, s: PoseSample, name: string) => s.sitePos[siteIdx(rig, name)]![1];

// ---------------------------------------------------------------------------------------------

describe('flat and forefoot contacts sit exactly where the anchors and proportions say (independent geometry)', () => {
  for (const c of cases) {
    it(c.name, () => {
      let worstPos = 0;
      let worstRot = 0;
      let checked = 0;
      const bad: string[] = [];
      for (const tier of ['stabilized', 'analytic'] as const) {
        const tier1 = tier === 'analytic' ? analyzePlan(c.plan, c.rig, 'analytic') : null;
        if (tier1 && !tier1.withinTolerance) continue; // tier 1 out of tolerance is reported (checked in the sweep); only the claimed-good tier is held to it
        for (const t of times(c.plan, 50)) {
          const s = samplePose(c.plan, c.rig, t, tier);
          for (const side of SIDES) {
            const states = c.plan.feet[side];
            const st = states[activeStateIndex(states, t)]!;
            if (st.kind === 'swing') continue;
            const y = surfaceHeight(c.plan.environment, st.surface);
            const exp = flatFootSites(c.rig, side, st.anchor, y);
            const heading: Q = qaxis(1, st.anchor.yaw);
            const pos = (name: 'heel' | 'ball' | 'toe') => s.sitePos[siteIdx(c.rig, `${name}${sfx(side)}`)]!;
            const errs: [string, number][] = [
              [`ball${sfx(side)}`, vdist(pos('ball'), exp.ball)],
              [`toe${sfx(side)}`, vdist(pos('toe'), exp.toe)],
            ];
            // toes segment stays flat in both flat and forefoot states
            const toesRot = qangle(s.worldRot[jointIdx(c.rig, `mtp${sfx(side)}`)]!, heading);
            let rotErr = toesRot;
            if (st.kind === 'flat') {
              errs.push([`heel${sfx(side)}`, vdist(pos('heel'), exp.heel)]);
              rotErr = Math.max(rotErr, qangle(s.worldRot[jointIdx(c.rig, `ankle${sfx(side)}`)]!, heading));
            } else {
              // forefoot: heel height above the surface follows the authored heel-lift curve
              const lift = evalStopTrack(st.heelLift, t);
              errs.push([`heel${sfx(side)} height`, Math.abs(pos('heel')[1] - (y + lift))]);
            }
            for (const [what, e] of errs) {
              worstPos = Math.max(worstPos, e);
              if (e > TOLERANCES.contactPosition) bad.push(`${tier} t=${t.toFixed(3)} ${st.kind} ${what}: ${(e * 1000).toFixed(3)} mm`);
            }
            worstRot = Math.max(worstRot, rotErr);
            if (rotErr > TOLERANCES.contactOrientation) bad.push(`${tier} t=${t.toFixed(3)} ${side} ${st.kind} segment orientation off by ${(rotErr / DEG).toFixed(3)}°`);
            checked++;
          }
        }
      }
      console.info(`[contacts] ${c.name}: ${checked} foot-contacts checked, worst position ${(worstPos * 1000).toExponential(2)} mm, worst orientation ${(worstRot / DEG).toExponential(2)}°`);
      expect(checked).toBeGreaterThan(100);
      expect(bad.slice(0, 6)).toEqual([]);
    });
  }
});

describe('heel raise: forefoot planted, heel follows the authored curve, body rises', () => {
  for (const c of byRecipe('bilateral-heel-raise.v1')) {
    it(c.name, () => {
      const s0 = samplePose(c.plan, c.rig, 0);
      const h = c.plan.recipe.params['heelRise'] as number;
      let ballToeDrift = 0;
      let heelErr = 0;
      let maxHeel = 0;
      for (const t of times(c.plan, 100)) {
        const s = samplePose(c.plan, c.rig, t);
        for (const side of SIDES) {
          for (const n of ['ball', 'toe']) {
            const i = siteIdx(c.rig, `${n}${sfx(side)}`);
            ballToeDrift = Math.max(ballToeDrift, vdist(s.sitePos[i]!, s0.sitePos[i]!));
          }
          const states = c.plan.feet[side];
          const st = states[activeStateIndex(states, t)]!;
          const lift = st.kind === 'forefoot' ? evalStopTrack(st.heelLift, t) : 0;
          const hy = siteY(c.rig, s, `heel${sfx(side)}`);
          heelErr = Math.max(heelErr, Math.abs(hy - lift));
          maxHeel = Math.max(maxHeel, hy);
        }
      }
      expect(ballToeDrift, 'ball/toe displacement over the clip').toBeLessThanOrEqual(TOLERANCES.plantedDisplacement);
      expect(heelErr, 'heel height vs authored heel-lift curve').toBeLessThanOrEqual(TOLERANCES.contactPosition);
      expect(Math.abs(maxHeel - h), 'peak heel height = heelRise').toBeLessThanOrEqual(TOLERANCES.contactPosition);
      // body rises with the ankles at every top hold / rise end
      for (const top of c.plan.phases.filter((p) => p.id.startsWith('rise-'))) {
        const s = samplePose(c.plan, c.rig, top.end);
        const dPelvis = s.pelvisWorld[1] - s0.pelvisWorld[1];
        const dAnkle = (['_L', '_R'] as const).map((x) => s.worldPos[jointIdx(c.rig, `ankle${x}`)]![1] - s0.worldPos[jointIdx(c.rig, `ankle${x}`)]![1]);
        const meanAnkle = (dAnkle[0]! + dAnkle[1]!) / 2;
        expect(meanAnkle, 'ankle joints rise').toBeGreaterThan(0.3 * h);
        expect(Math.abs(dPelvis - meanAnkle), `pelvis rise ${dPelvis} vs ankle rise ${meanAnkle}`).toBeLessThanOrEqual(0.001);
        // monotone rise over the rise phase
        let prev = -Infinity;
        for (let k = 0; k <= 20; k++) {
          const y = samplePose(c.plan, c.rig, top.start + ((top.end - top.start) * k) / 20).pelvisWorld[1];
          expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = y;
        }
      }
      console.info(`[heel raise] ${c.name}: ball/toe drift ${(ballToeDrift * 1000).toExponential(2)} mm, heel-curve error ${(heelErr * 1000).toExponential(2)} mm, peak heel ${(maxHeel * 1000).toFixed(2)} mm`);
    });
  }
});

describe('sit-to-stand: seat contact held while engaged, released after seat-off, re-engaged at touch-down', () => {
  for (const c of byRecipe('sit-to-stand.v1')) {
    it(c.name, () => {
      const seat = c.plan.seat;
      expect(seat).not.toBeNull();
      if (!seat) return;
      const chair = c.plan.environment.objects.find((o) => o.kind === 'chair');
      if (!chair || chair.kind !== 'chair') throw new Error('no chair');
      const H = chair.seatHeight;
      // target lies on the seat top, inside its footprint
      expect(Math.abs(seat.target[1] - H)).toBeLessThanOrEqual(1e-9);
      expect(seat.target[2]).toBeLessThan(chair.frontZ);
      expect(seat.target[2]).toBeGreaterThan(chair.frontZ - chair.seatDepth);
      expect(seat.intervals).toHaveLength(2);
      const [iv0, iv1] = seat.intervals as [(typeof seat.intervals)[number], (typeof seat.intervals)[number]];
      const heldUntil = iv0.end - iv0.blendOut / 2; // weight 1 up to here (seat-off)
      const freeFrom = iv0.end + iv0.blendOut / 2;
      const freeUntil = iv1.start - iv1.blendIn / 2;
      const heldFrom = iv1.start + iv1.blendIn / 2; // weight 1 again from touch-down
      expect(heldUntil).toBeLessThan(freeFrom);
      expect(freeUntil).toBeLessThan(heldFrom);
      const seatSite = siteIdx(c.rig, 'seat');
      let onErr = 0;
      let maxFree = -Infinity;
      let minFree = Infinity;
      for (const t of times(c.plan, 100)) {
        const s = samplePose(c.plan, c.rig, t);
        const p = s.sitePos[seatSite]!;
        if (t <= heldUntil || t >= heldFrom) onErr = Math.max(onErr, vdist(p, seat.target));
        if (t > freeFrom && t < freeUntil) {
          maxFree = Math.max(maxFree, p[1]);
          minFree = Math.min(minFree, p[1]);
        }
      }
      expect(onErr, 'seat site vs seat target while fully engaged').toBeLessThanOrEqual(TOLERANCES.contactPosition);
      expect(maxFree - H, 'seat site rises clear of the seat once released').toBeGreaterThan(0.1);
      expect(H - minFree, 'no seat penetration while free').toBeLessThanOrEqual(TOLERANCES.penetration);
      // seat-off really happens after the forward lean, i.e. the seat is still loaded at the lean's end
      const lean = c.plan.phases.find((p) => p.id === 'forward-lean')!;
      expect(vdist(samplePose(c.plan, c.rig, lean.end).sitePos[seatSite]!, seat.target)).toBeLessThanOrEqual(TOLERANCES.contactPosition);
      const stand = c.plan.phases.find((p) => p.id === 'stand')!;
      expect(samplePose(c.plan, c.rig, (stand.start + stand.end) / 2).sitePos[seatSite]![1] - H).toBeGreaterThan(0.1);
      console.info(`[sit-to-stand] ${c.name}: engaged error ${(onErr * 1000).toExponential(2)} mm, free seat height ${(minFree - H).toFixed(4)}…${(maxFree - H).toFixed(4)} m above the seat`);
    });
  }
});

describe('step-up: explicit contact sequence per side matches the leading-side parameters (from FK)', () => {
  for (const c of byRecipe('step-up-down.v1')) {
    it(c.name, () => {
      const A = c.params['upLeadSide'] as Side;
      const D = c.params['downLeadSide'] as Side;
      const B: Side = A === 'left' ? 'right' : 'left';
      const S: Side = D === 'left' ? 'right' : 'left';
      const step = c.plan.environment.objects.find((o) => o.kind === 'step');
      if (!step || step.kind !== 'step') throw new Error('no step');
      const H = step.height;
      const ys = (s: PoseSample, side: Side) => ({
        heel: siteY(c.rig, s, `heel${sfx(side)}`),
        ball: siteY(c.rig, s, `ball${sfx(side)}`),
        toe: siteY(c.rig, s, `toe${sfx(side)}`),
      });
      const ts = times(c.plan, 200);
      const samples = ts.map((t) => samplePose(c.plan, c.rig, t));
      const airborne = (side: Side, level: number) => (i: number) => {
        const y = ys(samples[i]!, side);
        return Math.min(y.heel, y.ball, y.toe) > level + 0.005;
      };
      const firstIdx = (pred: (i: number) => boolean, from = 0) => {
        for (let i = from; i < samples.length; i++) if (pred(i)) return i;
        return -1;
      };
      // Up: the leading foot is the first to leave the floor.
      const offA = firstIdx(airborne(A, 0));
      const offB = firstIdx(airborne(B, 0));
      expect(offA).toBeGreaterThan(0);
      expect(offB, `${A} (up-lead) must leave the floor before ${B}`).toBeGreaterThan(offA);
      // Trailing foot goes through a forefoot state (heel up, ball/toe on the floor) before toe-off.
      const heelOffB = firstIdx((i) => {
        const y = ys(samples[i]!, B);
        return y.heel > 0.005 && y.ball < 0.001 && y.toe < 0.001;
      });
      expect(heelOffB, `${B} heel-off before toe-off`).toBeGreaterThan(offA);
      expect(heelOffB).toBeLessThan(offB);
      // Both end up flat on the step top.
      const top = c.plan.phases.find((p) => p.id === 'top')!;
      const iTop = ts.findIndex((t) => t >= (top.start + top.end) / 2);
      for (const side of SIDES) for (const v of Object.values(ys(samples[iTop]!, side))) expect(Math.abs(v - H)).toBeLessThanOrEqual(TOLERANCES.contactPosition);
      // Down: the down-leading foot is the first to leave the step.
      const leaveD = firstIdx(airborne(D, H), iTop);
      const leaveS = firstIdx(airborne(S, H), iTop);
      expect(leaveD).toBeGreaterThan(iTop);
      expect(leaveS, `${D} (down-lead) must leave the step before ${S}`).toBeGreaterThan(leaveD);
      // The lowering foot lands forefoot-first (ball/toe touch with the heel up), then becomes flat.
      const touch = firstIdx((i) => {
        const y = ys(samples[i]!, D);
        return y.ball <= 0.001 && y.toe <= 0.001;
      }, leaveD);
      expect(touch).toBeGreaterThan(leaveD);
      expect(ys(samples[touch]!, D).heel, `${D} heel at first floor touch`).toBeGreaterThan(0.005);
      const flat = firstIdx((i) => ys(samples[i]!, D).heel <= 0.001, touch);
      expect(flat).toBeGreaterThan(touch);
      for (let i = flat; i < samples.length; i++) for (const v of Object.values(ys(samples[i]!, D))) expect(v).toBeLessThanOrEqual(TOLERANCES.contactPosition);
      // Plan-level contact sequence (explicit, per side).
      const kinds = (side: Side) => c.plan.feet[side].map((s: FootState) => (s.kind === 'swing' ? 'swing' : `${s.kind}@${s.surface}`));
      expect(kinds(A).slice(0, 3)).toEqual(['flat@floor', 'swing', 'flat@step.top']);
      expect(kinds(B).slice(0, 4)).toEqual(['flat@floor', 'forefoot@floor', 'swing', 'flat@step.top']);
      expect(kinds(D).slice(-3)).toEqual(['swing', 'forefoot@floor', 'flat@floor']);
      expect(kinds(S).slice(-2)).toEqual(['swing', 'flat@floor']);
      // Root trajectory: forward onto the step and back.
      const p0 = samples[0]!.pelvisWorld;
      const pEnd = samples.at(-1)!.pelvisWorld;
      const pTop = samples[iTop]!.pelvisWorld;
      expect(p0[2]).toBeLessThan(step.frontZ);
      expect(pTop[2], 'pelvis over the step at the top').toBeGreaterThan(step.frontZ);
      expect(pTop[1] - p0[1], 'pelvis raised by about the step height').toBeGreaterThan(0.8 * H);
      expect(pTop[1] - p0[1]).toBeLessThan(1.2 * H);
      expect(vdist(pEnd, p0), 'ends where it started').toBeLessThanOrEqual(0.001);
      expect(samples[iTop]!.rootTranslation[2] - samples[0]!.rootTranslation[2]).toBeGreaterThan(0.2);
    });
  }
});

describe('knee: never flips, flexion within [0, limit], DOF angle equals the geometric angle', () => {
  for (const c of cases) {
    it(c.name, () => {
      let minDot = Infinity;
      let maxFlex = 0;
      const bad: string[] = [];
      for (const tier of TIERS)
        for (const t of times(c.plan, 60)) {
          const s = samplePose(c.plan, c.rig, t, tier);
          for (const side of SIDES) {
            const hip = s.worldPos[jointIdx(c.rig, `hip${sfx(side)}`)]!;
            const knee = s.worldPos[jointIdx(c.rig, `knee${sfx(side)}`)]!;
            const ankleJ = jointIdx(c.rig, `ankle${sfx(side)}`);
            const ankle = s.worldPos[ankleJ]!;
            const flex = Math.acos(Math.min(1, Math.max(-1, vdot(vnorm(vsub(knee, hip)), vnorm(vsub(ankle, knee))))));
            const kj = jointIdx(c.rig, `knee${sfx(side)}`);
            const dof = c.rig.joints[kj]!.dofs[0]!;
            const a = s.angles[kj]![0]!;
            if (a < -TOLERANCES.jointLimit || a > dof.max + TOLERANCES.jointLimit) bad.push(`${tier} t=${t} ${side} knee DOF ${a}`);
            if (Math.abs(Math.abs(a) - flex) > 1e-6) bad.push(`${tier} t=${t} ${side} knee DOF ${a} vs geometric ${flex}`);
            maxFlex = Math.max(maxFlex, flex);
            if (flex > 5 * DEG) {
              const axis = vnorm(vsub(ankle, hip));
              const off = vreject(vsub(knee, hip), axis);
              const fwd = vreject(qrot(s.worldRot[ankleJ]!, [0, 0, 1]), axis);
              const dot = vdot(vnorm(off), vnorm(fwd));
              minDot = Math.min(minDot, dot);
              if (!(dot > 0)) bad.push(`${tier} t=${t} ${side} knee flipped (dot ${dot.toFixed(3)} at ${(flex / DEG).toFixed(1)}°)`);
            }
          }
        }
      console.info(`[knee] ${c.name}: min knee-forward·foot-forward ${minDot.toFixed(4)}, max flexion ${(maxFlex / DEG).toFixed(1)}°`);
      expect(bad.slice(0, 6)).toEqual([]);
    });
  }
});

describe('baked quaternion tracks can be made hemisphere-continuous with ≤ 10° per 60 fps frame', () => {
  for (const c of cases) {
    it(c.name, () => {
      let worst = 0;
      let where = '';
      for (const tier of ['stabilized', 'baseline'] as const) {
        const clip = bakeClip(c.plan, c.rig, 60, tier);
        for (let j = 0; j < c.rig.joints.length; j++) {
          let prev = clip.frames[0]!.local[j]!;
          for (let f = 1; f < clip.frames.length; f++) {
            let q = clip.frames[f]!.local[j]!;
            if (vdot(prev.slice(0, 3), q.slice(0, 3)) + prev[3] * q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]];
            const d = prev[0] * q[0] + prev[1] * q[1] + prev[2] * q[2] + prev[3] * q[3];
            expect(d).toBeGreaterThanOrEqual(0);
            const step = 2 * Math.acos(Math.min(1, d));
            if (step > worst) {
              worst = step;
              where = `${tier} ${c.rig.joints[j]!.name} @ ${clip.times[f]!.toFixed(3)} s`;
            }
            prev = q;
          }
        }
      }
      console.info(`[quat] ${c.name}: max 60 fps step ${(worst / DEG).toFixed(3)}° (${where})`);
      expect(worst, where).toBeLessThanOrEqual(TOLERANCES.quatStepMax60fps);
    });
  }
});

describe('stabiliser offset stays within the declared bounds (and is zero while fully seated)', () => {
  for (const c of cases) {
    it(c.name, () => {
      const b = c.plan.stabilization.bounds;
      let max: [number, number, number] = [0, 0, 0];
      for (const t of times(c.plan, 60)) {
        const s = samplePose(c.plan, c.rig, t, 'stabilized');
        expect(s.stabilization.enabled).toBe(true);
        const o = s.stabilization.offset;
        for (let i = 0; i < 3; i++) {
          expect(Math.abs(o[i]!), `axis ${i} at t=${t}`).toBeLessThanOrEqual(b[i]! + 1e-12);
          max[i] = Math.max(max[i]!, Math.abs(o[i]!));
        }
        if (c.plan.seat) {
          const [iv0, iv1] = c.plan.seat.intervals;
          const seated = (iv0 && t <= iv0.end - iv0.blendOut / 2) || (iv1 && t >= iv1.start + iv1.blendIn / 2);
          if (seated) expect(Math.hypot(...o), `seated at t=${t}`).toBe(0);
        }
        // the correction never leaks into other tiers
        expect(samplePose(c.plan, c.rig, t, 'analytic').stabilization.offset).toEqual([0, 0, 0]);
      }
      max = max.map((v) => Number(v.toExponential(3))) as [number, number, number];
      console.info(`[stabiliser] ${c.name}: max |offset| per axis ${JSON.stringify(max)} m (bounds ${JSON.stringify(b)})`);
    });
  }
});

describe('plans are immutable values: sampling / analysis never mutates them', () => {
  for (const c of cases.filter((x) => x.rig === rigA)) {
    it(`${c.name}: JSON unchanged after heavy use; a deep-frozen copy samples identically`, () => {
      const plan = structuredClone(c.plan);
      const before = JSON.stringify(plan);
      const rigBefore = JSON.stringify(c.rig);
      const ts = times(plan, 7);
      for (const tier of TIERS) for (const t of ts) samplePose(plan, c.rig, t, tier);
      analyzePlan(plan, c.rig, 'stabilized', 60);
      bakeClip(plan, c.rig, 24, 'baseline');
      validatePlan(plan, c.rig);
      deriveContactSchedule(plan);
      mirrorPlan(plan, rigFingerprint(c.rig));
      expect(JSON.stringify(plan)).toBe(before);
      expect(JSON.stringify(c.rig)).toBe(rigBefore);

      const frozen = deepFreeze(structuredClone(c.plan));
      const frozenRig = deepFreeze(structuredClone(c.rig));
      for (const tier of TIERS)
        for (const t of ts) {
          let s: PoseSample | undefined;
          expect(() => {
            s = samplePose(frozen, frozenRig, t, tier);
          }).not.toThrow();
          expect(firstBitDiff(s, samplePose(plan, c.rig, t, tier)), `${tier} t=${t}`).toBeNull();
        }
      expect(() => analyzePlan(frozen, frozenRig, 'stabilized', 30)).not.toThrow();
      expect(() => validatePlan(frozen, frozenRig)).not.toThrow();
      expect(() => mirrorPlan(frozen, rigFingerprint(frozenRig))).not.toThrow();
    });
  }
});

describe("disabling plan.stabilization.enabled (on a clone) makes 'stabilized' identical to 'analytic'", () => {
  for (const c of cases) {
    it(c.name, () => {
      const off = structuredClone(c.plan);
      off.stabilization.enabled = false;
      let differedOnOriginal = false;
      for (const t of times(c.plan, 30)) {
        const s = samplePose(off, c.rig, t, 'stabilized');
        expect(s.stabilization.enabled).toBe(false);
        expect(firstBitDiff(poseCore(s), poseCore(samplePose(off, c.rig, t, 'analytic'))), `t=${t}`).toBeNull();
        if (firstBitDiff(poseCore(samplePose(c.plan, c.rig, t, 'stabilized')), poseCore(samplePose(c.plan, c.rig, t, 'analytic')))) differedOnOriginal = true;
      }
      // teeth: where the stabiliser is active, the enabled plan really differs between tiers
      if (c.recipe === 'step-up-down.v1') expect(differedOnOriginal).toBe(true);
    });
  }
});

describe('squat bottom achieves the requested knee flexion and shank-lean ankle dorsiflexion (within 0.5°)', () => {
  const configs: Record<string, number>[] = [
    {},
    { depthKneeFlexionDeg: 30 },
    { depthKneeFlexionDeg: 50 },
    { depthKneeFlexionDeg: 90 },
    { shankLeanRatio: 0.25 },
    { shankLeanRatio: 0.45 },
    { trunkLeanDeg: 5 },
    { trunkLeanDeg: 45 },
    { stanceWidth: 0.18, toeOutDeg: 25 },
    { stanceWidth: 0.5, toeOutDeg: 0 },
  ];
  for (const { id, rig } of rigs)
    for (const cfg of configs) {
      it(`${JSON.stringify(cfg)} on ${id}`, () => {
        const plan = mustCompile('bilateral-squat.v1', cfg, rig);
        const depth = plan.recipe.params['depthKneeFlexionDeg'] as number;
        const ratio = plan.recipe.params['shankLeanRatio'] as number;
        const bottoms = plan.phases.filter((p) => p.id.startsWith('bottom-'));
        expect(bottoms.length).toBe(plan.recipe.params['repetitions']);
        for (const ph of bottoms)
          for (const t of [ph.start, (ph.start + ph.end) / 2, ph.end]) {
            const s = samplePose(plan, rig, t);
            const per = SIDES.map((side) => {
              const hip = s.worldPos[jointIdx(rig, `hip${sfx(side)}`)]!;
              const knee = s.worldPos[jointIdx(rig, `knee${sfx(side)}`)]!;
              const aj = jointIdx(rig, `ankle${sfx(side)}`);
              const ankle = s.worldPos[aj]!;
              const flex = Math.acos(vdot(vnorm(vsub(knee, hip)), vnorm(vsub(ankle, knee))));
              // dorsiflexion = forward tilt of the shank in the foot's frame: sin θ = (knee − ankle)̂ · foot forward
              const dorsi = Math.asin(vdot(vnorm(vsub(knee, ankle)), qrot(s.worldRot[aj]!, [0, 0, 1])));
              return { flex: flex / DEG, dorsi: dorsi / DEG };
            });
            const meanFlex = (per[0]!.flex + per[1]!.flex) / 2;
            const meanDorsi = (per[0]!.dorsi + per[1]!.dorsi) / 2;
            expect(Math.abs(meanFlex - depth), `t=${t} knee ${meanFlex.toFixed(3)}° vs ${depth}°`).toBeLessThanOrEqual(0.5);
            expect(Math.abs(meanDorsi - ratio * depth), `t=${t} ankle ${meanDorsi.toFixed(3)}° vs ${(ratio * depth).toFixed(3)}°`).toBeLessThanOrEqual(0.5);
            for (const p of per) {
              expect(Math.abs(p.flex - depth)).toBeLessThanOrEqual(0.5);
              expect(Math.abs(p.dorsi - ratio * depth)).toBeLessThanOrEqual(0.5);
            }
          }
      });
    }
  it('the dorsiflexion oracle agrees with the joint-angle contract on a synthetic pose', () => {
    // foot yawed by 0.3 rad, shank tilted forward by 0.2 rad in the foot's sagittal plane
    const foot = qaxis(1, 0.3);
    const shank = qmul(foot, qaxis(0, 0.2));
    const up = qrot(shank, [0, 1, 0]);
    expect(Math.asin(vdot(up, qrot(foot, [0, 0, 1])))).toBeCloseTo(0.2, 12);
  });
});
