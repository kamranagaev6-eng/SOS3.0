import { describe, expect, it } from 'vitest';
import { compileRecipe, createRigA, getRecipe, samplePose } from '../../src/core/engine.ts';
import { createPlayer, phaseIndexAt, type PhaseSpan } from '../../src/player/index.ts';

function fakeClock(start = 1000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
    set(ms: number) {
      t = ms;
    },
  };
}

const PHASES: PhaseSpan[] = [
  { id: 'a', label: 'A', start: 0, end: 1 },
  { id: 'b', label: 'B', start: 1, end: 2.5 },
  { id: 'c', label: 'C', start: 2.5, end: 4 },
];

describe('player clock', () => {
  it('computes time from the anchor, not by accumulating frame deltas', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 4, now: c.now, loop: false });
    p.play();
    // Many irregular "frames" (each querying time) must give exactly the same t as one jump to
    // the same wall-clock instant: nothing is accumulated per frame.
    let jitter = 0;
    for (let i = 1; i <= 997; i++) {
      jitter = (jitter * 7 + 3) % 11;
      c.set(1000 + i * 1.0013 + (i === 997 ? 0 : jitter * 0.1));
      p.time();
    }
    const irregular = p.time();
    const c2 = fakeClock();
    const p2 = createPlayer({ duration: 4, now: c2.now, loop: false });
    p2.play();
    c2.set(1000 + 997 * 1.0013);
    expect(irregular).toBe(p2.time());
    expect(irregular).toBeCloseTo(0.9982961, 9);
  });

  it('is paused initially and time does not move while paused', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 3, now: c.now });
    c.advance(5000);
    expect(p.time()).toBe(0);
    expect(p.snapshot().playing).toBe(false);
  });

  it('re-anchors on speed change so time is continuous', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 10, now: c.now, loop: false });
    p.play();
    c.advance(1000);
    expect(p.time()).toBeCloseTo(1, 12);
    p.setSpeed(0.25);
    expect(p.time()).toBeCloseTo(1, 12);
    c.advance(2000);
    expect(p.time()).toBeCloseTo(1.5, 12);
    p.setSpeed(2);
    c.advance(1000);
    expect(p.time()).toBeCloseTo(3.5, 12);
  });

  it('pause freezes time; play resumes from the same time', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 10, now: c.now });
    p.play();
    c.advance(1500);
    p.pause();
    c.advance(10_000);
    expect(p.time()).toBeCloseTo(1.5, 12);
    p.play();
    c.advance(500);
    expect(p.time()).toBeCloseTo(2, 12);
  });

  it('loops by wrapping t modulo duration', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 2, now: c.now, loop: true });
    p.play();
    c.advance(5300);
    expect(p.time()).toBeCloseTo(1.3, 9);
    expect(p.snapshot().playing).toBe(true);
  });

  it('stops at the end when not looping and restarts from 0 on play', () => {
    const c = fakeClock();
    const events: boolean[] = [];
    const p = createPlayer({ duration: 2, now: c.now, loop: false });
    p.subscribe((s) => events.push(s.playing));
    p.play();
    c.advance(2500);
    expect(p.time()).toBe(2);
    expect(p.snapshot()).toMatchObject({ playing: false, ended: true, t: 2 });
    c.advance(1000);
    expect(p.time()).toBe(2);
    p.play();
    expect(p.time()).toBe(0);
    expect(events).toEqual([true, false, true]);
  });

  it('seek clamps to [0, duration] and keeps playing state', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 4, now: c.now, loop: false });
    p.seek(9);
    expect(p.time()).toBe(4);
    p.seek(-1);
    expect(p.time()).toBe(0);
    p.play();
    p.seek(1);
    c.advance(250);
    expect(p.time()).toBeCloseTo(1.25, 12);
  });

  it('frame-steps forward and backward on the inspection grid and pauses', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 4, now: c.now, inspectionRate: 30 });
    p.play();
    c.advance(1000 * (10.4 / 30));
    p.stepFrames(1);
    expect(p.snapshot().playing).toBe(false);
    expect(p.time()).toBeCloseTo(11 / 30, 12);
    p.stepFrames(1);
    expect(p.time()).toBeCloseTo(12 / 30, 12);
    p.stepFrames(-3);
    expect(p.time()).toBeCloseTo(9 / 30, 12);
    p.seek(0);
    p.stepFrames(-1);
    expect(p.time()).toBe(0);
    p.seek(4);
    p.stepFrames(1);
    expect(p.time()).toBe(4);
    p.setInspectionRate(10);
    p.seek(1.05);
    p.stepFrames(-1);
    expect(p.time()).toBeCloseTo(1.0, 12);
  });

  it('jumps between phases', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 4, now: c.now });
    p.seek(0.4);
    p.jumpPhase(1, PHASES);
    expect(p.time()).toBe(1);
    p.jumpPhase(1, PHASES);
    expect(p.time()).toBe(2.5);
    p.jumpPhase(1, PHASES);
    expect(p.time()).toBe(4);
    p.seek(3);
    p.jumpPhase(-1, PHASES);
    expect(p.time()).toBe(2.5);
    p.jumpPhase(-1, PHASES);
    expect(p.time()).toBe(1);
    p.jumpPhase(-1, PHASES);
    expect(p.time()).toBe(0);
    p.jumpPhase(-1, PHASES);
    expect(p.time()).toBe(0);
  });

  it('identifies the phase at a time', () => {
    expect(phaseIndexAt(PHASES, 0)).toBe(0);
    expect(phaseIndexAt(PHASES, 0.999)).toBe(0);
    expect(phaseIndexAt(PHASES, 1)).toBe(1);
    expect(phaseIndexAt(PHASES, 3.9)).toBe(2);
    expect(phaseIndexAt(PHASES, 4)).toBe(2);
    expect(phaseIndexAt([], 1)).toBe(-1);
  });

  it('setDuration keeps time within the new duration', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 5, now: c.now });
    p.seek(4.5);
    p.setDuration(3);
    expect(p.time()).toBe(3);
    expect(p.snapshot().duration).toBe(3);
  });

  it('ignores invalid speeds and non-finite seeks', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 5, now: c.now });
    p.seek(1);
    p.setSpeed(0);
    p.setSpeed(Number.NaN);
    p.seek(Number.NaN);
    expect(p.snapshot()).toMatchObject({ speed: 1, t: 1 });
  });
});

describe('player clock: reverse playback', () => {
  it('plays backwards from mid-clip: t = t0 - elapsed * |speed|', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 4, now: c.now, loop: false });
    p.seek(3);
    p.setSpeed(-1);
    expect(p.snapshot()).toMatchObject({ speed: -1, direction: -1, playing: false });
    p.play();
    c.advance(500);
    expect(p.time()).toBeCloseTo(2.5, 12);
    // Half speed in reverse, re-anchored without a jump.
    p.setSpeed(-0.5);
    expect(p.time()).toBeCloseTo(2.5, 12);
    c.advance(1000);
    expect(p.time()).toBeCloseTo(2, 12);
    // Direction flips keep |speed| and continue from the same t.
    p.setDirection(1);
    expect(p.snapshot()).toMatchObject({ speed: 0.5, direction: 1 });
    c.advance(1000);
    expect(p.time()).toBeCloseTo(2.5, 12);
    p.setDirection(-1);
    expect(p.snapshot().speed).toBe(-0.5);
  });

  it('stops at t = 0 without loop and marks the playback ended', () => {
    const c = fakeClock();
    const events: boolean[] = [];
    const p = createPlayer({ duration: 4, now: c.now, loop: false });
    p.seek(1);
    p.setSpeed(-2);
    p.subscribe((s) => events.push(s.playing));
    p.play();
    c.advance(400);
    expect(p.time()).toBeCloseTo(0.2, 12);
    c.advance(400);
    expect(p.time()).toBe(0);
    expect(p.snapshot()).toMatchObject({ playing: false, ended: true, t: 0 });
    c.advance(1000);
    expect(p.time()).toBe(0);
    expect(events).toEqual([true, false]);
  });

  it('play at t = 0 in reverse (no loop) starts from the end, as forward play at the end restarts', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 4, now: c.now, loop: false });
    p.setSpeed(-1);
    p.play();
    expect(p.time()).toBe(4);
    c.advance(250);
    expect(p.time()).toBeCloseTo(3.75, 12);
    // Run into t = 0, then press play again: restarts from the end.
    c.advance(5000);
    expect(p.time()).toBe(0);
    p.play();
    expect(p.time()).toBe(4);
    expect(p.snapshot().ended).toBe(false);
  });

  it('wraps below zero when looping', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 2, now: c.now, loop: true });
    p.seek(0.5);
    p.setSpeed(-1);
    p.play();
    c.advance(1000);
    expect(p.time()).toBeCloseTo(1.5, 12);
    expect(p.snapshot().playing).toBe(true);
    c.advance(3300); // 1.5 - 3.3 = -1.8 -> 0.2
    expect(p.time()).toBeCloseTo(0.2, 9);
    // Looping reverse from t = 0 simply wraps to the end.
    p.pause();
    p.seek(0);
    p.play();
    c.advance(100);
    expect(p.time()).toBeCloseTo(1.9, 12);
  });

  it('rejects zero and non-finite speeds but accepts negative ones', () => {
    const c = fakeClock();
    const p = createPlayer({ duration: 5, now: c.now });
    p.setSpeed(-0.25);
    p.setSpeed(0);
    p.setSpeed(Number.NEGATIVE_INFINITY);
    expect(p.snapshot()).toMatchObject({ speed: -0.25, direction: -1 });
    expect(createPlayer({ duration: 1, now: c.now, speed: 0 }).snapshot().speed).toBe(1);
  });

  it('t is computed, never accumulated: reverse after irregular frames equals one jump, and gives the same pose as forward', () => {
    // Reverse with irregular frame queries lands exactly where a single jump does.
    const c = fakeClock();
    const p = createPlayer({ duration: 6, now: c.now, loop: false });
    p.seek(3);
    p.setSpeed(-1);
    p.play();
    let jitter = 0;
    for (let i = 1; i <= 750; i++) {
      jitter = (jitter * 7 + 3) % 11;
      c.set(1000 + i * 2 + (i === 750 ? 0 : jitter * 0.1));
      p.time();
    }
    const reverse = p.time();
    expect(reverse).toBe(3 - 1.5);

    // Forward to the same instant: bitwise the same t, hence the same (pure) engine sample.
    const c2 = fakeClock();
    const f = createPlayer({ duration: 6, now: c2.now, loop: false });
    f.play();
    for (let i = 1; i <= 375; i++) {
      c2.set(1000 + i * 4 - (i % 3) * 0.7);
      f.time();
    }
    c2.set(2500);
    const forward = f.time();
    expect(forward).toBe(reverse);

    const rig = createRigA();
    const recipe = getRecipe('bilateral-heel-raise.v1')!;
    const res = compileRecipe(recipe.id, recipe.defaults(), rig);
    if (!res.ok) throw new Error('heel raise did not compile');
    expect(samplePose(res.plan, rig, reverse, 'stabilized')).toEqual(samplePose(res.plan, rig, forward, 'stabilized'));
  });
});

