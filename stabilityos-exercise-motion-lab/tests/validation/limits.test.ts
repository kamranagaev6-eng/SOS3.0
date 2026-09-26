import { describe, expect, it } from 'vitest';
import { PLAN_LIMITS } from '../../src/core/contracts/plan.ts';
import { compileRecipe, createRigA, getRecipe, validatePlan } from '../../src/core/engine.ts';

// D10: validation cost grows with duration and key counts, so imported plans are size-bounded.
describe('plan size limits (bounded validation cost for imported plans)', () => {
  const rig = createRigA();
  const r = compileRecipe('bilateral-squat.v1', getRecipe('bilateral-squat.v1')!.defaults(), rig);
  if (!r.ok) throw new Error('fixture compile failed');

  it('rejects durations above the limit quickly and with a path', () => {
    for (const f of [60, 1e5, 1e9]) {
      const p = structuredClone(r.plan);
      p.duration *= f;
      const t0 = performance.now();
      const d = validatePlan(p, rig).filter((x) => x.severity === 'error');
      expect(performance.now() - t0).toBeLessThan(200);
      expect(d.some((x) => x.message.includes(`≤ ${PLAN_LIMITS.maxDuration} s`))).toBe(true);
    }
  });

  it('rejects oversized key arrays', () => {
    const p = structuredClone(r.plan);
    p.pelvis.y = { keys: Array.from({ length: PLAN_LIMITS.maxKeys + 1 }, (_, i) => ({ t: (i * r.plan.duration) / (PLAN_LIMITS.maxKeys + 1), v: 0.9, mode: 'stop' as const })) };
    expect(validatePlan(p, rig).some((x) => x.severity === 'error' && x.code === 'SCHEMA_INVALID')).toBe(true);
  });

  it('compiled recipe plans are well inside the limits', () => {
    expect(r.plan.duration).toBeLessThan(PLAN_LIMITS.maxDuration);
    expect(validatePlan(r.plan, rig).filter((x) => x.severity === 'error')).toEqual([]);
  });
});
