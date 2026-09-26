import { describe, expect, it } from 'vitest';
import { COORDINATE_CONVENTION, REVIEW_NOTICE, SCHEMA } from '../../src/core/contracts/common.ts';
import { diag } from '../../src/core/contracts/diagnostics.ts';
import { HOST_RESPONSIBILITIES, exportManifestSchema } from '../../src/core/contracts/manifest.ts';
import type { ContactInterval } from '../../src/core/contracts/plan.ts';
import { planSchema } from '../../src/core/contracts/plan.ts';
import {
  VALIDATION_STATEMENT,
  buildExportManifest,
  manifestToJson,
  sha256Hex,
  sha256HexPure,
  summarizeFrameDiagnostics,
} from '../../src/core/io/manifest.ts';
import { createRng } from '../../src/core/math/rng.ts';
import type { ClipMetrics } from '../../src/core/metrics/types.ts';
import { createRigA } from '../../src/core/rig/canonical.ts';
import { getRigModel } from '../../src/core/rig/model.ts';
import { TOLERANCES } from '../../src/core/tolerances.ts';
import { createSyntheticClip } from '../../src/export/syntheticClip.ts';

const rig = createRigA();
const fixture = createSyntheticClip(rig, { seed: 11, fps: 30, duration: 1 });
const schedule: ContactInterval[] = [
  { id: 'c1', site: 'heel_L', surface: 'floor', kind: 'position', side: 'left', start: 0, end: 1, blendIn: 0, blendOut: 0 },
  { id: 'c2', site: 'foot_L', surface: 'floor', kind: 'orientation', segment: 'foot', side: 'left', start: 0, end: 1, blendIn: 0, blendOut: 0 },
];
const metrics: ClipMetrics = {
  tier: 'analytic',
  sampleRate: 30,
  samples: fixture.clip.frames.length,
  maxContactPositionError: 1e-10,
  maxPlantedDisplacement: 2e-10,
  maxContactOrientationError: 0,
  maxPenetration: 0,
  maxBoneLengthRelError: 1e-15,
  jointLimitViolations: 0,
  clampedSamples: 0,
  maxJointVelocityJump: 0.01,
  maxLinearVelocityJump: 0.001,
  rawJointVelocityJump: 0.01,
  rawLinearVelocityJump: 0.001,
  refinedCandidates: 0,
  maxStabilizationOffset: 0,
  stabilizedSamples: 0,
  nonConvergedSamples: 0,
  unreachableSamples: 0,
  kneeFlipSamples: 0,
  diagnosticsByCode: { JOINT_LIMIT_CLAMPED: 3 },
  withinTolerance: true,
  failures: [],
};

function build(over: Partial<Parameters<typeof buildExportManifest>[0]> = {}) {
  return buildExportManifest({
    clip: fixture.clip,
    metrics,
    recipe: fixture.recipe,
    recipeDoc: fixture.recipeDoc,
    animationFileName: 'x.glb',
    animationSha256: 'ab'.repeat(32),
    createdAt: '2026-09-26T00:00:00.000Z',
    contactSchedule: schedule,
    ...over,
  });
}

function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.add(k);
      allKeys(x, out);
    }
  }
  return out;
}

describe('sha256Hex', () => {
  it('matches the FIPS 180-2 test vectors', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex(new ArrayBuffer(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const big = new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq');
    expect(await sha256Hex(big.buffer)).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    // A view into a larger buffer hashes only its own bytes.
    const padded = new Uint8Array(10);
    padded.set(new TextEncoder().encode('abc'), 4);
    expect(await sha256Hex(padded.subarray(4, 7))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('pure fallback (no crypto.subtle) matches the vectors and Web Crypto on seeded random inputs', async () => {
    expect(sha256HexPure(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexPure(new Uint8Array(0))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const rng = createRng(99);
    // Lengths around the 55/56/64-byte padding boundaries plus larger buffers.
    for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 1000, 65_537]) {
      const buf = new Uint8Array(n);
      for (let i = 0; i < n; i++) buf[i] = rng.int(0, 255);
      expect(sha256HexPure(buf)).toBe(await sha256Hex(buf));
    }
    const g = globalThis as { crypto?: unknown };
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
    try {
      expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    } finally {
      if (saved) Object.defineProperty(globalThis, 'crypto', saved);
    }
    expect(typeof (g.crypto as Crypto).subtle.digest).toBe('function');
  });
});

describe('buildExportManifest', () => {
  it('fixture plan is a valid motion plan', () => {
    expect(planSchema.safeParse(fixture.clip.plan).success).toBe(true);
  });

  it('validates against the manifest schema and carries status, notice, responsibilities and semantics', () => {
    const m = build();
    expect(exportManifestSchema.safeParse(m).success).toBe(true);
    expect(m.schema).toBe(SCHEMA.manifest);
    expect(m.reviewStatus).toBe('unreviewed-synthetic');
    expect(m.reviewNotice).toBe(REVIEW_NOTICE);
    expect(m.reviewNotice).toMatch(/^UNREVIEWED/);
    expect(m.hostResponsibilities).toEqual([...HOST_RESPONSIBILITIES]);
    expect(m.recipe).toEqual(fixture.recipeDoc);
    expect(m.recipeTitle).toBe(fixture.recipe.title);
    expect(m.assumptions).toEqual(expect.arrayContaining([...fixture.recipe.assumptions, ...fixture.clip.plan.assumptions]));
    expect(m.unsupported).toEqual([...fixture.recipe.unsupported]);
    expect(m.setup).toEqual([...fixture.recipe.setup]);
    expect(m.phases).toEqual([{ id: 'sweep', label: 'Synthetic sweep', start: 0, end: 1 }]);
    expect(m.cues).toHaveLength(1);
    expect(m.contactSchedule).toEqual([
      { id: 'c1', site: 'heel_L', surface: 'floor', kind: 'position', start: 0, end: 1 },
      { id: 'c2', site: 'foot_L', surface: 'floor', kind: 'orientation', start: 0, end: 1 },
    ]);
    expect(m.rig).toEqual({ id: rig.id, name: rig.name, fingerprint: getRigModel(rig).fingerprint });
    expect(m.convention).toEqual(COORDINATE_CONVENTION);
    expect(m.bake).toEqual({ fps: 30, frameCount: 31, duration: 1, solverTier: 'analytic', interpolation: 'LINEAR' });
    expect(m.provenance.synthetic).toBe(true);
    expect(m.files).toEqual({ animation: 'x.glb', animationSha256: 'ab'.repeat(32) });
  });

  it('validation block is geometric-only, states it is not clinical validation, and records tolerances', () => {
    const m = build();
    expect(m.validation.kind).toBe('geometric-only');
    expect(m.validation.statement).toBe(VALIDATION_STATEMENT);
    expect(m.validation.statement).toMatch(/NOT clinical validation/);
    expect(m.validation.withinTolerance).toBe(true);
    expect(m.validation.metrics['maxContactPositionError']).toBe(1e-10);
    expect(m.validation.metrics['diagnostics.JOINT_LIMIT_CLAMPED']).toBe(3);
    expect(m.validation.metrics['tolerance.exportPosition']).toBe(TOLERANCES.exportPosition);
    expect(m.validation.metrics['tolerance.contactPosition']).toBe(TOLERANCES.contactPosition);
  });

  it('creates no prescription or dose fields', () => {
    const keys = allKeys(build());
    for (const forbidden of ['sets', 'reps', 'repetitions', 'dose', 'dosage', 'frequency', 'load', 'prescription', 'approved', 'reviewer']) {
      expect(keys.has(forbidden)).toBe(false);
    }
    expect(manifestToJson(build())).not.toMatch(/"reviewStatus": "(approved|reviewed)"/);
  });

  it('missing metrics are reported (never hidden) and fail the validation flag', () => {
    const m = build({ metrics: null, metricsError: 'analyzeClip: not implemented yet' });
    expect(m.validation.withinTolerance).toBe(false);
    expect(m.validation.diagnostics[0]!.message).toMatch(/not computed: analyzeClip: not implemented yet/);
    expect(m.validation.metrics['tolerance.exportRotation']).toBe(TOLERANCES.exportRotation);
    expect(exportManifestSchema.safeParse(m).success).toBe(true);
  });

  it('metric failures and round-trip failures are surfaced as error diagnostics', () => {
    const failing = build({
      metrics: { ...metrics, withinTolerance: false, failures: ['penetration 2.000 mm > 1.000 mm', '3 non-converged samples', 'bone length error 1e-3 > 1e-9'] },
    });
    expect(failing.validation.withinTolerance).toBe(false);
    const byMsg = (re: RegExp) => failing.validation.diagnostics.find((d) => re.test(d.message))!;
    expect(byMsg(/penetration 2\.000 mm/).code).toBe('SURFACE_PENETRATION');
    expect(byMsg(/non-converged/).code).toBe('SOLVER_NOT_CONVERGED');
    expect(byMsg(/bone length/).code).toBe('TOLERANCE_EXCEEDED');
    expect(byMsg(/penetration/).severity).toBe('error');
    const rt = build({
      roundTrip: {
        framesCompared: 31,
        maxPositionError: 1e-3,
        maxRotationError: 0,
        maxBoneLengthRelError: 0,
        maxRootError: 0,
        withinTolerance: false,
        issues: ['missing track x'],
      },
    });
    expect(rt.validation.withinTolerance).toBe(false);
    expect(rt.validation.metrics['roundTrip.maxPositionError']).toBe(1e-3);
    expect(rt.validation.diagnostics.filter((d) => d.code === 'EXPORT_MISMATCH')).toHaveLength(2);
  });

  it('refuses mismatched recipe identity or parameters', () => {
    expect(() => build({ recipe: { ...fixture.recipe, id: 'other' } })).toThrow(/identity mismatch/);
    expect(() => build({ recipeDoc: { ...fixture.recipeDoc, params: { ...fixture.recipeDoc.params, seed: 12 } } })).toThrow(/differs/);
    expect(() => build({ recipeDoc: { ...fixture.recipeDoc, reviewStatus: 'approved' as 'unreviewed-synthetic' } })).toThrow(/violates/);
  });

  it('collapses per-sample diagnostics by code and subject', () => {
    const clip = structuredClone(fixture.clip);
    clip.frames.forEach((f, k) => {
      f.diagnostics = [diag('JOINT_LIMIT_CLAMPED', 'warning', 'knee clamped', { subject: 'knee_L', time: f.t })];
      if (k === 5) f.diagnostics.push(diag('TARGET_UNREACHABLE', 'error', 'unreachable', { subject: 'ankle_R' }));
    });
    const s = summarizeFrameDiagnostics(clip);
    expect(s).toHaveLength(2);
    expect(s[0]!.code).toBe('TARGET_UNREACHABLE');
    expect(s[0]!.time).toBe(clip.frames[5]!.t);
    expect(s[1]!.message).toMatch(/31 samples; first at t=0\.0000/);
  });
});
