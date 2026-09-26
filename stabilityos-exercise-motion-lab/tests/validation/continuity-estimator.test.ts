import { describe, expect, it } from 'vitest';
import { bakeTimes, ClipAnalyzer, compileRecipe, createRigA, getRecipe, samplePose, TOLERANCES } from '../../src/core/engine.ts';
import type { PoseSample } from '../../src/core/engine.ts';

/**
 * Properties of the discontinuity estimator (ClipAnalyzer + refine), tested by injecting synthetic
 * signals into one DOF of a real, smooth clip (the squat, whose own jumps are tiny):
 *  1. a genuine velocity break ΔV is never hidden, wherever it falls between raw samples
 *     (a break splits across two raw stencils; refinement measures it across adjacent stencils);
 *  2. smooth acceleration is not reported as a break (the old estimator reported a raw 240 Hz
 *     second difference of ≈ 0.6 rad/s for a smooth ≈ 150 rad/s² swing-knee acceleration).
 */
describe('continuity estimator: breaks are never hidden, smooth acceleration is not a break', () => {
  const rig = createRigA();
  const c = compileRecipe('bilateral-squat.v1', getRecipe('bilateral-squat.v1')!.defaults(), rig);
  if (!c.ok) throw new Error('fixture compile failed');
  const plan = c.plan;
  const rate = TOLERANCES.continuityRate;
  const h = 1 / rate;
  const joint = rig.joints.findIndex((j) => j.name === 'lumbar'); // any tracked DOF works; only `angles` feed continuity

  function analyzeWith(f: (t: number) => number) {
    const mod = (s: PoseSample): PoseSample => {
      const angles = s.angles.map((a) => a.slice());
      angles[joint]![0] = angles[joint]![0]! + f(s.t);
      return { ...s, angles };
    };
    const a = new ClipAnalyzer(plan, rig, 'stabilized', rate);
    for (const t of bakeTimes(plan.duration, rate)) a.push(mod(samplePose(plan, rig, t)));
    a.refine((t) => mod(samplePose(plan, rig, t)));
    return a.finish();
  }

  const baseline = analyzeWith(() => 0);

  it('the unmodified clip is smooth and within tolerance', () => {
    expect(baseline.withinTolerance).toBe(true);
    expect(baseline.maxJointVelocityJump).toBeLessThan(0.1);
  });

  for (const dv of [0.3, 0.6, 1.2]) {
    for (const frac of [0, 0.13, 0.37, 0.5, 0.71, 0.99]) {
      it(`a ${dv} rad/s velocity break at +${frac}·h past a raw sample is reported ≥ ${dv} (never hidden)`, () => {
        const t0 = 5 + frac * h;
        const m = analyzeWith((t) => (t > t0 ? (t - t0) * dv : 0));
        expect(m.maxJointVelocityJump).toBeGreaterThanOrEqual(dv * 0.98);
        if (dv > TOLERANCES.jointVelocityJump) {
          expect(m.withinTolerance).toBe(false);
          expect(m.failures.some((x) => x.startsWith('joint velocity jump'))).toBe(true);
        } else {
          expect(m.failures.some((x) => x.startsWith('joint velocity jump'))).toBe(false);
        }
      });
    }
  }

  it('smooth acceleration of 150 rad/s² over a 0.4 s window is not reported as a break', () => {
    // C2 bump: θ(t) = A·(w/π)²·(1 − cos(π(t − t0)/w))/2-like profile via smootherstep integral would be
    // overkill; a raised-cosine displacement has bounded, smooth acceleration with peak A.
    const t0 = 5;
    const w = 0.4;
    const A = 150;
    const amp = (A * (w / (2 * Math.PI)) ** 2); // peak acceleration of amp·(2π/w)²·cos(...) equals A
    const f = (t: number) => (t < t0 || t > t0 + w ? 0 : amp * (1 - Math.cos((2 * Math.PI * (t - t0)) / w)));
    const m = analyzeWith(f);
    // raw 240 Hz second difference ≈ A·h ≈ 0.62 rad/s would have exceeded the tolerance; the refined
    // estimate is a small multiple of A·h/8 plus the conservative ×2 on unrefined samples.
    expect(A * h).toBeGreaterThan(TOLERANCES.jointVelocityJump);
    expect(m.rawJointVelocityJump).toBeGreaterThan(TOLERANCES.jointVelocityJump);
    expect(m.maxJointVelocityJump).toBeLessThan(TOLERANCES.jointVelocityJump / 2);
    expect(m.withinTolerance).toBe(true);
  });
});
