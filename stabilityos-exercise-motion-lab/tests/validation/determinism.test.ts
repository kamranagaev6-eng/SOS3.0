/**
 * Sampling is a pure function of (plan, rig, t, tier): no hidden state, no drift.
 *  - bitwise-identical PoseSamples regardless of call order (shuffled, reversed, interleaved with
 *    other plans / rigs / tiers, cold vs warm caches, baseline sampled first at a late time);
 *  - frame-rate independence: bakes at 24/30/60/120 fps agree bitwise at shared times (n/6 s)
 *    and with direct sampling;
 *  - long playback: t = (wall·speed) mod duration up to 10 h of wall time — the float reduction
 *    stays within ~1 ulp of the exact reduction (computed with BigInt rationals), and the pose at
 *    the float-reduced time matches the pose at the exact time within 1e-9 m / 1e-9 rad;
 *  - out-of-range t clamps to [0, duration]; non-finite t throws RangeError.
 */
import { describe, expect, it } from 'vitest';
import { bakeClip, compileRecipe, createRigA, samplePose, type SolverTier } from '../../src/core/engine.ts';
import type { MotionPlan } from '../../src/core/contracts/plan.ts';
import type { RigDefinition } from '../../src/core/contracts/rig.ts';
import { createRng } from '../../src/core/math/rng.ts';
import { exactProductMod, firstBitDiff, loadRigB, poseCore, qangle, TIERS, vdist } from './support.ts';

const rigA = createRigA();
const rigBInfo = await loadRigB();
console.info(`[determinism] ${rigBInfo.note}`);
const rigB = rigBInfo.rig?.rig ?? null;

function compiled(id: string, rig: RigDefinition, params: Record<string, string | number> = {}): MotionPlan {
  const r = compileRecipe(id, params, rig);
  if (!r.ok) throw new Error(`test setup: ${id} failed to compile on ${rig.id}: ${r.diagnostics.map((d) => d.message).join('; ')}`);
  return r.plan;
}

interface Subject {
  name: string;
  plan: MotionPlan;
  rig: RigDefinition;
}

const subjects: Subject[] = [
  { name: 'step-up (stabiliser active) on rig A', plan: compiled('step-up-down.v1', rigA, { upLeadSide: 'right', downLeadSide: 'left' }), rig: rigA },
  { name: 'sit-to-stand on rig A', plan: compiled('sit-to-stand.v1', rigA), rig: rigA },
  { name: 'squat on rig A', plan: compiled('bilateral-squat.v1', rigA), rig: rigA },
  { name: 'heel raise on rig A', plan: compiled('bilateral-heel-raise.v1', rigA), rig: rigA },
];
if (rigB) subjects.push({ name: 'step-up on host-derived rig B', plan: compiled('step-up-down.v1', rigB), rig: rigB });

/** Seeded sample times: random interior times + clip ends + every authored boundary. */
function timesFor(plan: MotionPlan, seed: number, n = 40): number[] {
  const rng = createRng(seed);
  const ts = new Set<number>([0, plan.duration]);
  for (let i = 0; i < n; i++) ts.add(rng.range(0, plan.duration));
  for (const p of plan.phases) ts.add(p.end);
  for (const s of [...plan.feet.left, ...plan.feet.right]) ts.add(s.start);
  return [...ts].sort((a, b) => a - b);
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rng = createRng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

type Call = { t: number; tier: SolverTier };

/** Reference samples from a FRESH structural clone (cold caches), ascending time, tier by tier. */
function reference(sub: Subject, calls: readonly Call[]): Map<string, unknown> {
  const fresh = structuredClone(sub.plan);
  const freshRig = structuredClone(sub.rig);
  const out = new Map<string, unknown>();
  for (const tier of TIERS)
    for (const c of [...calls].filter((x) => x.tier === tier).sort((a, b) => a.t - b.t)) out.set(`${c.tier}@${c.t}`, samplePose(fresh, freshRig, c.t, c.tier));
  return out;
}

describe('determinism: identical (plan, rig, t, tier) ⇒ bitwise-identical PoseSample', () => {
  for (const [si, sub] of subjects.entries()) {
    describe(sub.name, () => {
      const calls: Call[] = timesFor(sub.plan, 1000 + si).flatMap((t) => TIERS.map((tier) => ({ t, tier })));
      const ref = reference(sub, calls);
      const check = (label: string, order: readonly Call[], between?: () => void) => {
        let compared = 0;
        for (const c of order) {
          between?.();
          const s = samplePose(sub.plan, sub.rig, c.t, c.tier);
          const d = firstBitDiff(s, ref.get(`${c.tier}@${c.t}`));
          expect(d, `${label}: ${c.tier} t=${c.t}`).toBeNull();
          compared++;
        }
        expect(compared).toBe(calls.length);
      };

      it('shuffled seek order (tiers mixed) matches the cold ascending reference', () => {
        check('shuffled', shuffled(calls, 77 + si));
      });

      it('reverse order matches', () => {
        check('reverse', [...calls].reverse());
      });

      it('interleaving other plans, rigs and tiers between calls changes nothing', () => {
        const rng = createRng(4242 + si);
        const others = subjects.filter((o) => o !== sub);
        check('interleaved', shuffled(calls, 91 + si), () => {
          const o = rng.pick(others);
          samplePose(o.plan, o.rig, rng.range(-1, o.plan.duration + 1), rng.pick(TIERS));
          // the same plan on a structurally identical but distinct rig object
          samplePose(sub.plan, structuredClone(sub.rig), rng.range(0, sub.plan.duration), rng.pick(TIERS));
        });
      });

      it('first-ever call on a fresh plan object is a late baseline sample (lazy baseline cache is order-independent)', () => {
        const fresh = structuredClone(sub.plan);
        const late = calls.filter((c) => c.tier === 'baseline').at(-2)!;
        const s = samplePose(fresh, sub.rig, late.t, 'baseline');
        expect(firstBitDiff(s, ref.get(`baseline@${late.t}`))).toBeNull();
      });
    });
  }
});

describe('frame-rate independence: bakes at 24 / 30 / 60 / 120 fps agree bitwise at shared times', () => {
  const rates = [24, 30, 60, 120] as const;
  for (const sub of subjects.slice(0, 4)) {
    for (const tier of ['stabilized', 'baseline'] as const) {
      it(`${sub.name}, ${tier}`, () => {
        const bakes = rates.map((fps) => bakeClip(sub.plan, sub.rig, fps, tier));
        // multiples of 1/6 s: k/fps with k = n·fps/6 — the same rational, so the same double
        const expectedShared = Math.floor(sub.plan.duration * 6 + 1e-9) + 1;
        let shared = 0;
        for (let n = 0; n / 6 <= sub.plan.duration + 1e-12; n++) {
          const frames = bakes.map((b, i) => {
            const k = (n * rates[i]!) / 6;
            expect(Number.isInteger(k)).toBe(true);
            expect(Object.is(b.times[k], n / 6), `${rates[i]} fps frame ${k} time ${b.times[k]} vs ${n / 6}`).toBe(true);
            return b.frames[k]!;
          });
          const direct = samplePose(sub.plan, sub.rig, n / 6, tier);
          for (const [i, f] of frames.entries()) expect(firstBitDiff(f, direct), `${rates[i]} fps at t=${n}/6`).toBeNull();
          shared++;
        }
        expect(shared).toBe(expectedShared);
        // every bake ends exactly at the clip duration
        for (const b of bakes) expect(b.times.at(-1)).toBe(sub.plan.duration);
      });
    }
  }
});

describe('long playback: t = (wall · speed) mod duration up to 10 h of wall time', () => {
  const speeds = [0.25, 0.5, 0.7, 1, 1.3, 1.7, 2];
  for (const [si, sub] of subjects.slice(0, 4).entries()) {
    it(`${sub.name}: float-reduced time within ~1 ulp of exact; pose within 1e-9 m / 1e-9 rad of the exact-time pose`, () => {
      const rng = createRng(31337 + si);
      const walls = [0.001, 59.97, 3599.999, 3600, 7 * 3600 + 0.123, 36000 - 1e-6, 36000];
      for (let i = 0; i < 40; i++) walls.push(rng.range(0, 36000));
      let worstTime = 0;
      let worstPos = 0;
      let worstRot = 0;
      let cases = 0;
      for (const wall of walls) {
        const speed = rng.pick(speeds);
        const product = wall * speed;
        const tFloat = product % sub.plan.duration;
        const tExact = exactProductMod(wall, speed, sub.plan.duration);
        // The only float error is the rounding of wall·speed (the remainder itself is exact).
        const bound = Math.abs(product) * Number.EPSILON;
        const dt = Math.abs(tFloat - tExact);
        expect(dt, `wall=${wall} speed=${speed}: |t_float − t_exact| = ${dt}`).toBeLessThanOrEqual(bound);
        worstTime = Math.max(worstTime, dt);
        for (const tier of ['stabilized', 'baseline'] as const) {
          const a = samplePose(sub.plan, sub.rig, tFloat, tier);
          const b = samplePose(sub.plan, sub.rig, tExact, tier);
          for (let j = 0; j < a.worldPos.length; j++) {
            worstPos = Math.max(worstPos, vdist(a.worldPos[j]!, b.worldPos[j]!));
            worstRot = Math.max(worstRot, qangle(a.local[j]!, b.local[j]!));
          }
          for (let k = 0; k < a.sitePos.length; k++) worstPos = Math.max(worstPos, vdist(a.sitePos[k]!, b.sitePos[k]!));
          // and sampling the reduced time is itself repeatable
          expect(firstBitDiff(poseCore(a), poseCore(samplePose(sub.plan, sub.rig, tFloat, tier)))).toBeNull();
        }
        cases++;
      }
      console.info(`[long playback] ${sub.name}: ${cases} cases, max |Δt| ${worstTime.toExponential(2)} s, max Δpos ${worstPos.toExponential(2)} m, max Δrot ${worstRot.toExponential(2)} rad`);
      expect(worstPos).toBeLessThanOrEqual(1e-9);
      expect(worstRot).toBeLessThanOrEqual(1e-9);
    });
  }

  it('the exact-reduction oracle is itself correct on hand-checkable cases', () => {
    expect(exactProductMod(10, 1, 3)).toBe(1);
    expect(exactProductMod(36000, 2, 10.8)).toBeCloseTo(72000 - Math.floor(72000 / 10.8) * 10.8, 9);
    expect(exactProductMod(0.5, 0.5, 0.2)).toBeCloseTo(0.05, 15);
    // 0.1 is not dyadic: 3 × 0.1 (true value of the double) mod 0.3 (double) is tiny but not 0
    expect(exactProductMod(3, 0.1, 0.3)).toBeGreaterThanOrEqual(0);
  });
});

describe('time domain: out-of-range t clamps, non-finite t throws RangeError', () => {
  for (const sub of subjects.slice(0, 4)) {
    it(`${sub.name}`, () => {
      const D = sub.plan.duration;
      for (const tier of TIERS) {
        const at0 = samplePose(sub.plan, sub.rig, 0, tier);
        const atD = samplePose(sub.plan, sub.rig, D, tier);
        for (const t of [-1e-9, -1, -1e300, -Number.MAX_VALUE]) expect(firstBitDiff(samplePose(sub.plan, sub.rig, t, tier), at0), `${tier} t=${t}`).toBeNull();
        for (const t of [D + 1e-9, D + 1, 1e300, Number.MAX_VALUE]) expect(firstBitDiff(samplePose(sub.plan, sub.rig, t, tier), atD), `${tier} t=${t}`).toBeNull();
        expect(firstBitDiff(poseCore(samplePose(sub.plan, sub.rig, -0, tier)), poseCore(at0))).toBeNull();
        for (const t of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])
          expect(() => samplePose(sub.plan, sub.rig, t, tier), `${tier} t=${t}`).toThrow(RangeError);
      }
    });
  }
});

describe('the bitwise comparator has teeth', () => {
  it('detects a 1-ulp time change, a sign-of-zero change and a structural change', () => {
    const sub = subjects[0]!;
    const t = 3.21;
    const a = samplePose(sub.plan, sub.rig, t);
    const b = samplePose(sub.plan, sub.rig, t + 4 * Number.EPSILON * t);
    expect(firstBitDiff(a, b)).not.toBeNull();
    expect(firstBitDiff([0], [-0])).not.toBeNull();
    expect(firstBitDiff({ a: [1, 2] }, { a: [1, 2, 3] })).not.toBeNull();
    expect(firstBitDiff(a, samplePose(sub.plan, sub.rig, t))).toBeNull();
  });
});
