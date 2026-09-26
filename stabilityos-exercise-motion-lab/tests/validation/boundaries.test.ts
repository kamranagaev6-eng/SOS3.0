/**
 * No C0 jumps (and no C1 breaks above the declared velocity-jump tolerance) at authored
 * transitions: every phase boundary, every foot-state boundary, every seat-interval boundary and
 * blend-window edge, every heel-lift key and every body-track key of every recipe.
 *  - sample at b − ε, b, b + ε (ε = 1e-7 s): joint and site world positions differ ≤ 1e-5 m,
 *    local joint rotations ≤ 1e-5 rad;
 *  - 2 kHz scan over b ± 25 ms: second differences / h of DOF angles ≤ jointVelocityJump (rad/s),
 *    of pelvis and site positions ≤ linearVelocityJump (m/s).
 * C0: all three tiers. 2 kHz scan: stabilized (default) and baseline always; analytic (tier 1) only
 * where its own clip metrics claim it is within tolerance — on the step-up tier 1 saturates at
 * full leg reach (reported as TARGET_UNREACHABLE; that is what tier 2 exists for), which is then
 * asserted to be reported rather than silently scanned.
 * Geometric checks of synthetic fixtures, not clinical validation.
 */
import { describe, expect, it } from 'vitest';
import { analyzePlan, compileRecipe, createRigA, listRecipes, samplePose, TOLERANCES, type PoseSample, type SolverTier } from '../../src/core/engine.ts';
import type { MotionPlan } from '../../src/core/contracts/plan.ts';
import type { RigDefinition } from '../../src/core/contracts/rig.ts';
import { loadRigB, qangle, TIERS, vdist } from './support.ts';

const EPS = 1e-7;
const SCAN_HZ = 2000;
const SCAN_HALF_WINDOW = 0.025;

const rigA = createRigA();
const rigBInfo = await loadRigB();
console.info(`[boundaries] ${rigBInfo.note}`);

interface Case {
  name: string;
  plan: MotionPlan;
  rig: RigDefinition;
}

const cases: Case[] = [];
const rigs: { id: string; rig: RigDefinition }[] = [{ id: 'rig A', rig: rigA }];
if (rigBInfo.rig) rigs.push({ id: 'rig B', rig: rigBInfo.rig.rig });
for (const { id, rig } of rigs)
  for (const recipe of listRecipes()) {
    const variants: Record<string, string>[] =
      recipe.id === 'step-up-down.v1'
        ? [
            { upLeadSide: 'left', downLeadSide: 'left' },
            { upLeadSide: 'left', downLeadSide: 'right' },
            { upLeadSide: 'right', downLeadSide: 'left' },
            { upLeadSide: 'right', downLeadSide: 'right' },
          ]
        : [{}];
    for (const v of variants) {
      const r = compileRecipe(recipe.id, { ...recipe.defaults(), ...v }, rig);
      if (!r.ok) throw new Error(`test setup: ${recipe.id} ${JSON.stringify(v)} did not compile on ${id}`);
      cases.push({ name: `${recipe.id} ${Object.values(v).join('/')} on ${id}`, plan: r.plan, rig });
    }
  }

type Kind = 'phase' | 'foot-state' | 'seat' | 'heel-lift key' | 'track key';

/** All authored transition times, labelled. */
function boundaries(plan: MotionPlan): Map<number, Set<Kind>> {
  const m = new Map<number, Set<Kind>>();
  const add = (t: number, k: Kind) => {
    if (!(t >= 0 && t <= plan.duration)) return;
    const s = m.get(t) ?? new Set<Kind>();
    s.add(k);
    m.set(t, s);
  };
  for (const p of plan.phases) {
    add(p.start, 'phase');
    add(p.end, 'phase');
  }
  for (const s of [...plan.feet.left, ...plan.feet.right]) {
    add(s.start, 'foot-state');
    add(s.end, 'foot-state');
    if (s.kind === 'forefoot') for (const k of s.heelLift.keys) add(k.t, 'heel-lift key');
  }
  for (const iv of plan.seat?.intervals ?? []) {
    for (const t of [iv.start, iv.end, iv.start - iv.blendIn / 2, iv.start + iv.blendIn / 2, iv.end - iv.blendOut / 2, iv.end + iv.blendOut / 2]) add(t, 'seat');
  }
  for (const tr of Object.values(plan.pelvis)) for (const k of tr.keys) add(k.t, 'track key');
  for (const dofs of Object.values(plan.joints)) for (const tr of Object.values(dofs)) for (const k of tr.keys) add(k.t, 'track key');
  return m;
}

function c0Jump(a: PoseSample, b: PoseSample): { pos: number; rot: number; where: string } {
  let pos = 0;
  let rot = 0;
  let where = '';
  for (let j = 0; j < a.worldPos.length; j++) {
    const d = vdist(a.worldPos[j]!, b.worldPos[j]!);
    const r = qangle(a.local[j]!, b.local[j]!);
    if (d > pos) {
      pos = d;
      where = `joint #${j}`;
    }
    rot = Math.max(rot, r);
  }
  for (let s = 0; s < a.sitePos.length; s++) {
    const d = vdist(a.sitePos[s]!, b.sitePos[s]!);
    if (d > pos) {
      pos = d;
      where = `site #${s}`;
    }
  }
  return { pos, rot, where };
}

function secondDiff(a: PoseSample, b: PoseSample, c: PoseSample, h: number): { joint: number; linear: number } {
  let joint = 0;
  for (let j = 0; j < a.angles.length; j++)
    for (let k = 0; k < a.angles[j]!.length; k++) joint = Math.max(joint, Math.abs(c.angles[j]![k]! - 2 * b.angles[j]![k]! + a.angles[j]![k]!) / h);
  const lin = (p: readonly number[], q: readonly number[], r: readonly number[]) => Math.hypot(r[0]! - 2 * q[0]! + p[0]!, r[1]! - 2 * q[1]! + p[1]!, r[2]! - 2 * q[2]! + p[2]!) / h;
  let linear = lin(a.pelvisWorld, b.pelvisWorld, c.pelvisWorld);
  for (let s = 0; s < a.sitePos.length; s++) linear = Math.max(linear, lin(a.sitePos[s]!, b.sitePos[s]!, c.sitePos[s]!));
  return { joint, linear };
}

describe('C0 at authored transitions: sample b − 1e-7, b, b + 1e-7', () => {
  for (const cs of cases) {
    it(cs.name, () => {
      const bs = boundaries(cs.plan);
      expect(bs.size).toBeGreaterThan(cs.plan.phases.length);
      const bad: string[] = [];
      let worstPos = 0;
      let worstRot = 0;
      for (const [b, kinds] of bs)
        for (const tier of TIERS) {
          const [m, z, p] = [b - EPS, b, b + EPS].map((t) => samplePose(cs.plan, cs.rig, t, tier)) as [PoseSample, PoseSample, PoseSample];
          for (const [label, x, y] of [['b−ε→b', m, z], ['b→b+ε', z, p]] as const) {
            const j = c0Jump(x, y);
            worstPos = Math.max(worstPos, j.pos);
            worstRot = Math.max(worstRot, j.rot);
            if (j.pos > 1e-5 || j.rot > 1e-5)
              bad.push(`${tier} ${[...kinds].join('+')} boundary t=${b} (${label}): Δpos ${j.pos.toExponential(2)} m at ${j.where}, Δrot ${j.rot.toExponential(2)} rad`);
          }
        }
      console.info(`[C0] ${cs.name}: ${bs.size} boundaries × 3 tiers, max Δpos ${worstPos.toExponential(2)} m, max Δrot ${worstRot.toExponential(2)} rad`);
      expect(bad.slice(0, 8)).toEqual([]);
    });
  }
});

describe('2 kHz scan around every transition: no per-step jumps (second differences within the velocity-jump tolerances)', () => {
  const h = 1 / SCAN_HZ;
  const n = Math.round(SCAN_HALF_WINDOW * SCAN_HZ);
  for (const cs of cases) {
    it(cs.name, () => {
      const bad: string[] = [];
      let worstJ = 0;
      let worstL = 0;
      // only phase / foot-state / seat transitions (track keys are covered by the C0 test and the clip metrics)
      const bs = [...boundaries(cs.plan)].filter(([, k]) => k.has('phase') || k.has('foot-state') || k.has('seat')).map(([b]) => b);
      const tier1 = analyzePlan(cs.plan, cs.rig, 'analytic');
      const tiers: SolverTier[] = tier1.withinTolerance ? ['baseline', 'analytic', 'stabilized'] : ['baseline', 'stabilized'];
      if (!tier1.withinTolerance) {
        // tier 1 is out of tolerance here: that must be explicit, never silent
        expect(tier1.failures.length).toBeGreaterThan(0);
        expect(tier1.unreachableSamples + tier1.nonConvergedSamples + Object.keys(tier1.diagnosticsByCode).length).toBeGreaterThan(0);
        console.info(`[2 kHz] ${cs.name}: analytic tier excluded (reported out of tolerance: ${tier1.failures.join('; ')})`);
      }
      for (const b of bs)
        for (const tier of tiers) {
          const ts: number[] = [];
          for (let k = -n; k <= n; k++) {
            const t = b + k * h;
            if (t >= 0 && t <= cs.plan.duration) ts.push(t);
          }
          const ss = ts.map((t) => samplePose(cs.plan, cs.rig, t, tier));
          for (let k = 1; k + 1 < ss.length; k++) {
            // non-uniform spacing only where the window was cut at 0 / duration: skip those triples
            if (Math.abs(ts[k + 1]! - ts[k]! - h) > 1e-12 || Math.abs(ts[k]! - ts[k - 1]! - h) > 1e-12) continue;
            const r = secondDiff(ss[k - 1]!, ss[k]!, ss[k + 1]!, h);
            worstJ = Math.max(worstJ, r.joint);
            worstL = Math.max(worstL, r.linear);
            if (r.joint > TOLERANCES.jointVelocityJump || r.linear > TOLERANCES.linearVelocityJump)
              bad.push(`${tier} near boundary ${b} at t=${ts[k]}: joint ${r.joint.toFixed(3)} rad/s, linear ${r.linear.toFixed(4)} m/s`);
          }
        }
      console.info(`[2 kHz] ${cs.name}: ${bs.length} transitions × ${tiers.length} tiers, max joint jump ${worstJ.toFixed(4)} rad/s, max linear jump ${worstL.toFixed(5)} m/s`);
      expect(bad.slice(0, 8)).toEqual([]);
    });
  }
});
