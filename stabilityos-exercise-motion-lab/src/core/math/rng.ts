/**
 * Deterministic seeded PRNG (mulberry32) used by randomized tests and fixtures.
 * Never used by the solver itself: solving is deterministic without randomness.
 */
export interface Rng {
  next(): number;
  range(lo: number, hi: number): number;
  int(lo: number, hiInclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('pick from empty list');
      return items[Math.floor(next() * items.length)] as T;
    },
  };
}
