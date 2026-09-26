import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_NOTICE, SCHEMA } from '../../src/core/contracts/common.ts';
import { HOST_RESPONSIBILITIES, exportManifestSchema } from '../../src/core/contracts/manifest.ts';
import { RECIPE_IDS } from '../../src/core/contracts/recipe.ts';
import { sha256Hex } from '../../src/core/io/manifest.ts';
import { analyzeClip } from '../../src/core/metrics/analyze.ts';
import { bakeClip } from '../../src/core/metrics/bake.ts';
import { deriveContactSchedule } from '../../src/core/plan/contactSchedule.ts';
import { compileRecipe, getRecipe } from '../../src/core/recipes/registry.ts';
import { createRigA } from '../../src/core/rig/canonical.ts';
import { getRigModel } from '../../src/core/rig/model.ts';
import { samplePose } from '../../src/core/solver/sample.ts';
import { TOLERANCES } from '../../src/core/tolerances.ts';
import { EXPORT_SCENE_NAME, compareImportedToClip, exportBakedClipToGlb, importGlb, verifyRoundTrip } from '../../src/export/gltf.ts';
import { createSyntheticClip, type SyntheticClip } from '../../src/export/syntheticClip.ts';
import { installFileReaderShim } from '../support/fileReaderShim.ts';

beforeAll(() => {
  installFileReaderShim();
});

const rig = createRigA();
const model = getRigModel(rig);
const CREATED_AT = '2026-09-26T00:00:00.000Z';

function syntheticOpts(s: SyntheticClip) {
  return { recipe: s.recipe, recipeDoc: s.recipeDoc, metrics: null, contactSchedule: s.contactSchedule, createdAt: CREATED_AT };
}

interface GlbChunks {
  magic: string;
  version: number;
  length: number;
  json: Record<string, unknown>;
  binLength: number;
}

function parseGlbContainer(glb: ArrayBuffer): GlbChunks {
  const dv = new DataView(glb);
  const magic = new TextDecoder().decode(new Uint8Array(glb, 0, 4));
  const jsonLen = dv.getUint32(12, true);
  expect(dv.getUint32(16, true)).toBe(0x4e4f534a); // 'JSON'
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLen))) as Record<string, unknown>;
  const binOffset = 20 + jsonLen;
  expect(dv.getUint32(binOffset + 4, true)).toBe(0x004e4942); // 'BIN\0'
  return { magic, version: dv.getUint32(4, true), length: dv.getUint32(8, true), json, binLength: dv.getUint32(binOffset, true) };
}

describe('glTF round trip: synthetic joint-angle clips (solver-independent)', () => {
  const cases: { seed: number; fps: number; headingWrap: boolean }[] = [];
  for (const seed of [1, 2, 3]) for (const fps of [24, 30, 60]) cases.push({ seed, fps, headingWrap: (seed + fps) % 2 === 1 });

  it.each(cases)('seed $seed @ $fps fps (heading wrap: $headingWrap) is within export tolerance', async ({ seed, fps, headingWrap }) => {
    const s = createSyntheticClip(rig, { seed, fps, duration: 2, headingWrap });
    const { report, exported } = await verifyRoundTrip(s.clip, { ...syntheticOpts(s), sampler: s.sample });
    expect(report.issues).toEqual([]);
    expect(report.framesCompared).toBe(s.clip.frames.length);
    expect(report.maxPositionError).toBeLessThanOrEqual(TOLERANCES.exportPosition);
    expect(report.maxRootError).toBeLessThanOrEqual(TOLERANCES.exportPosition);
    expect(report.maxRotationError).toBeLessThanOrEqual(TOLERANCES.exportRotation);
    expect(report.maxBoneLengthRelError).toBeLessThanOrEqual(TOLERANCES.boneLengthRelExported);
    expect(report.importedMinConsecutiveDot).toBeGreaterThanOrEqual(0);
    expect(report.withinTolerance).toBe(true);
    expect(report.tolerances).toEqual({
      position: TOLERANCES.exportPosition,
      rotation: TOLERANCES.exportRotation,
      boneLengthRel: TOLERANCES.boneLengthRelExported,
    });
    expect(Object.keys(report.perJointMax).sort()).toEqual([...model.names].sort());
    expect(exported.continuity.withinTolerance).toBe(true);
    if (headingWrap) expect(exported.continuity.flipsApplied).toBeGreaterThan(0);
    // Informational mid-frame resampling is reported separately and labelled as such.
    expect(report.midFrame.label).toMatch(/not a pass criterion/);
    expect(report.midFrame.available).toBe(true);
    expect(report.midFrame.source).toBe('provided sampler');
    expect(report.midFrame.framesCompared).toBe(s.clip.frames.length - 1);
    expect(Number.isFinite(report.midFrame.maxPositionError)).toBe(true);
  });

  it('manifest validates, carries UNREVIEWED status and semantics, and hashes the exact .glb bytes', async () => {
    const s = createSyntheticClip(rig, { seed: 4, fps: 30, duration: 1 });
    const out = await exportBakedClipToGlb(s.clip, syntheticOpts(s));
    const m = out.manifest;
    expect(exportManifestSchema.safeParse(JSON.parse(out.manifestJson)).success).toBe(true);
    expect(m.reviewStatus).toBe('unreviewed-synthetic');
    expect(m.reviewNotice).toBe(REVIEW_NOTICE);
    expect(out.manifestJson).toContain('UNREVIEWED SYNTHETIC ENGINEERING FIXTURE');
    expect(m.hostResponsibilities).toEqual([...HOST_RESPONSIBILITIES]);
    expect(m.assumptions.length).toBeGreaterThan(0);
    expect(m.unsupported.length).toBeGreaterThan(0);
    expect(m.validation.kind).toBe('geometric-only');
    expect(m.validation.withinTolerance).toBe(false); // metrics were not computed for this fixture: reported, not hidden
    const independent = createHash('sha256').update(new Uint8Array(out.glb)).digest('hex');
    expect(m.files.animationSha256).toBe(independent);
    expect(out.sha256).toBe(independent);
    expect(await sha256Hex(out.glb)).toBe(independent);
    expect(m.files.animation).toBe(out.animationFileName);
    expect(out.animationFileName).toBe(`${out.fileBaseName}.glb`);
    // Tampering is detectable.
    const tampered = new Uint8Array(out.glb.slice(0));
    tampered[tampered.length - 5]! ^= 0xff;
    expect(createHash('sha256').update(tampered).digest('hex')).not.toBe(m.files.animationSha256);
  });

  it('writes a well-formed GLB whose nodes are the joints and whose channels target them', async () => {
    const s = createSyntheticClip(rig, { seed: 6, fps: 30, duration: 1 });
    const out = await exportBakedClipToGlb(s.clip, syntheticOpts(s));
    const glb = parseGlbContainer(out.glb);
    expect(glb.magic).toBe('glTF');
    expect(glb.version).toBe(2);
    expect(glb.length).toBe(out.glb.byteLength);
    const json = glb.json as {
      asset: { version: string };
      nodes: { name?: string; translation?: number[]; rotation?: number[] }[];
      scenes: { name?: string; extras?: Record<string, unknown> }[];
      animations: { channels: { target: { node: number; path: string } }[]; samplers: { input: number; interpolation: string }[] }[];
      accessors: { count: number; min?: number[]; max?: number[]; componentType: number }[];
    };
    expect(json.asset.version).toBe('2.0');
    const names = json.nodes.map((n) => n.name);
    for (let i = 0; i < model.jointCount; i++) {
      const node = json.nodes.find((n) => n.name === model.names[i])!;
      expect(node).toBeDefined();
      // Rest offsets travel as JSON numbers (exact), rest rotation is identity (omitted).
      const off = model.offset[i]!;
      expect(node.translation ?? [0, 0, 0]).toEqual(off.map((v) => v + 0));
      expect(node.rotation).toBeUndefined();
    }
    expect(names.filter((n) => n && !n.startsWith('vis_')).sort()).toEqual([...model.names].sort());
    expect(json.scenes[0]!.name).toBe(EXPORT_SCENE_NAME);
    expect(json.scenes[0]!.extras).toEqual({
      manifestSchema: SCHEMA.manifest,
      recipeId: s.clip.plan.recipe.id,
      reviewStatus: 'unreviewed-synthetic',
      reviewNotice: REVIEW_NOTICE,
    });
    expect(json.animations).toHaveLength(1);
    const anim = json.animations[0]!;
    expect(anim.channels).toHaveLength(model.jointCount + 2);
    const targets = anim.channels.map((c) => `${json.nodes[c.target.node]!.name}.${c.target.path}`).sort();
    expect(targets).toEqual([...model.names.map((n) => `${n}.rotation`), 'root.translation', 'pelvis.translation'].sort());
    for (const sampler of anim.samplers) {
      expect(sampler.interpolation).toBe('LINEAR');
      const input = json.accessors[sampler.input]!;
      expect(input.componentType).toBe(5126); // FLOAT
      expect(input.count).toBe(s.clip.times.length);
      expect(input.min![0]).toBe(Math.fround(s.clip.times[0]!));
      expect(input.max![0]).toBe(Math.fround(s.clip.times[s.clip.times.length - 1]!));
    }
  });

  it('reimport exposes the joints by name and the scene extras', async () => {
    const s = createSyntheticClip(rig, { seed: 8, fps: 24, duration: 1 });
    const out = await exportBakedClipToGlb(s.clip, syntheticOpts(s));
    const imported = await importGlb(out.glb);
    expect([...imported.jointNodes.keys()].sort()).toEqual([...model.names].sort());
    for (let i = 0; i < model.jointCount; i++) {
      const p = model.parent[i]!;
      const node = imported.jointNodes.get(model.names[i]!)!;
      expect(node.parent!.name).toBe(p < 0 ? EXPORT_SCENE_NAME : model.names[p]);
    }
    expect(imported.userData['reviewStatus']).toBe('unreviewed-synthetic');
    expect(imported.userData['reviewNotice']).toBe(REVIEW_NOTICE);
    expect(imported.clip.userData['reviewStatus']).toBe('unreviewed-synthetic');
    expect(imported.clip.tracks).toHaveLength(model.jointCount + 2);
  });

  it('export is deterministic: identical clips give byte-identical .glb files', async () => {
    const a = createSyntheticClip(rig, { seed: 12, fps: 30, duration: 1 });
    const b = createSyntheticClip(rig, { seed: 12, fps: 30, duration: 1 });
    const [x, y] = await Promise.all([exportBakedClipToGlb(a.clip, syntheticOpts(a)), exportBakedClipToGlb(b.clip, syntheticOpts(b))]);
    expect(x.sha256).toBe(y.sha256);
  });

  it('the comparison has teeth: a perturbed imported key or a missing track fails', async () => {
    const s = createSyntheticClip(rig, { seed: 10, fps: 30, duration: 1 });
    const out = await exportBakedClipToGlb(s.clip, syntheticOpts(s));
    const imported = await importGlb(out.glb);
    const knee = imported.clip.tracks.find((t) => t.name === 'knee_L.quaternion')!;
    const k = 10;
    // Rotate key k by ~2 mrad about x (above the 1 mrad tolerance).
    const q = Array.from(knee.values.slice(k * 4, k * 4 + 4));
    const h = 0.001;
    const [x, y, z, w] = q as [number, number, number, number];
    knee.values.set([w * Math.sin(h) + x * Math.cos(h), y * Math.cos(h) + z * Math.sin(h), z * Math.cos(h) - y * Math.sin(h), w * Math.cos(h) - x * Math.sin(h)], k * 4);
    const bad = compareImportedToClip(imported, s.clip, { sampler: s.sample });
    expect(bad.withinTolerance).toBe(false);
    expect(bad.perJointMax['knee_L']!.rotation).toBeGreaterThan(TOLERANCES.exportRotation);
    expect(bad.maxPositionError).toBeGreaterThan(TOLERANCES.exportPosition);

    const again = await importGlb(out.glb);
    again.clip.tracks = again.clip.tracks.filter((t) => t.name !== 'pelvis.position');
    const missing = compareImportedToClip(again, s.clip);
    expect(missing.withinTolerance).toBe(false);
    expect(missing.issues).toContain("missing track 'pelvis.position'");
  });
});

// ---------------------------------------------------------------------------------------------
// Real recipes. Gated only on the engine's "not implemented" stubs, so any real engine error
// still fails here.
// ---------------------------------------------------------------------------------------------

function engineStatus(): { ready: boolean; reason: string } {
  const missing = RECIPE_IDS.filter((id) => !getRecipe(id));
  if (missing.length > 0) return { ready: false, reason: `recipes not registered: ${missing.join(', ')}` };
  try {
    const r = compileRecipe('sit-to-stand.v1', getRecipe('sit-to-stand.v1')!.defaults(), createRigA());
    if (!r.ok) return { ready: true, reason: '' };
    samplePose(r.plan, createRigA(), 0, 'stabilized');
    deriveContactSchedule(r.plan);
    const clip = bakeClip(r.plan, createRigA(), 5, 'stabilized');
    analyzeClip(clip);
  } catch (e) {
    if (/not implemented/i.test(String(e))) return { ready: false, reason: String(e) };
  }
  return { ready: true, reason: '' };
}

const status = engineStatus();

describe.runIf(status.ready)('glTF round trip: real recipe clips (rig A, 60 fps, stabilized)', () => {
  it.each(RECIPE_IDS)('%s default clip round-trips within tolerance with a complete manifest', async (id) => {
    const rigA = createRigA();
    const compiled = compileRecipe(id, getRecipe(id)!.defaults(), rigA);
    if (!compiled.ok) throw new Error(`${id} failed to compile: ${JSON.stringify(compiled.diagnostics)}`);
    const clip = bakeClip(compiled.plan, rigA, 60, 'stabilized');
    const { report, manifest, exported } = await verifyRoundTrip(clip, { createdAt: CREATED_AT });
    expect(report.issues).toEqual([]);
    expect(report.framesCompared).toBe(clip.frames.length);
    expect(report.maxPositionError).toBeLessThanOrEqual(TOLERANCES.exportPosition);
    expect(report.maxRootError).toBeLessThanOrEqual(TOLERANCES.exportPosition);
    expect(report.maxRotationError).toBeLessThanOrEqual(TOLERANCES.exportRotation);
    expect(report.maxBoneLengthRelError).toBeLessThanOrEqual(TOLERANCES.boneLengthRelExported);
    expect(report.withinTolerance).toBe(true);
    expect(exported.continuity.withinTolerance).toBe(true);
    expect(report.midFrame.source).toBe('engine samplePose');
    expect(exportManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.recipe.recipeId).toBe(id);
    expect(manifest.recipe.reviewStatus).toBe('unreviewed-synthetic');
    expect(manifest.contactSchedule.length).toBeGreaterThan(0);
    expect(manifest.phases.length).toBeGreaterThan(0);
    expect(manifest.assumptions.length).toBeGreaterThan(0);
    expect(manifest.unsupported.length).toBeGreaterThan(0);
    expect(manifest.validation.metrics['roundTrip.maxPositionError']).toBe(report.maxPositionError);
    expect(manifest.files.animationSha256).toBe(createHash('sha256').update(new Uint8Array(exported.glb)).digest('hex'));
  });
});

describe.runIf(!status.ready)('glTF round trip: real recipe clips', () => {
  it.skip(`blocked: engine not ready (${status.reason.slice(0, 120)})`, () => {});
});
