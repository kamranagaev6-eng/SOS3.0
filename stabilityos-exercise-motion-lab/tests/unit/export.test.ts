import { Mesh, Object3D, QuaternionKeyframeTrack, VectorKeyframeTrack } from 'three';
import { describe, expect, it } from 'vitest';
import { REVIEW_NOTICE, SCHEMA } from '../../src/core/contracts/common.ts';
import { quatDot, quatFromAxisAngle, quatMultiply, type Quat } from '../../src/core/math/quat.ts';
import type { BakedClip } from '../../src/core/metrics/types.ts';
import { buildCanonicalRig, createRigA, PROPORTIONS_A } from '../../src/core/rig/canonical.ts';
import { getRigModel } from '../../src/core/rig/model.ts';
import { TOLERANCES } from '../../src/core/tolerances.ts';
import {
  EXPORT_SCENE_NAME,
  ExportValidationError,
  VISUAL_NODE_PREFIX,
  alignedRotationKeys,
  bakedClipToAnimationClip,
  buildExportScene,
  exportBakedClipToGlb,
  rotationAngle,
} from '../../src/export/gltf.ts';
import { createSyntheticClip } from '../../src/export/syntheticClip.ts';

const rig = createRigA();
const model = getRigModel(rig);

function withJointRotation(clip: BakedClip, joint: string, rot: (k: number) => Quat): BakedClip {
  const c = structuredClone(clip);
  const j = model.index.get(joint)!;
  c.frames.forEach((f, k) => (f.local[j] = rot(k)));
  return c;
}

describe('buildExportScene', () => {
  it('mirrors the joint hierarchy with rest offsets and identity rest rotations', () => {
    const scene = buildExportScene(rig, { recipeId: 'sit-to-stand.v1' });
    expect(scene.name).toBe(EXPORT_SCENE_NAME);
    for (let i = 0; i < model.jointCount; i++) {
      const node = scene.getObjectByName(model.names[i]!)!;
      expect(node).toBeInstanceOf(Object3D);
      expect((node as Mesh).isMesh).toBeFalsy();
      expect(node.position.toArray()).toEqual(model.offset[i]);
      expect(node.quaternion.toArray()).toEqual([0, 0, 0, 1]);
      const p = model.parent[i]!;
      expect(node.parent!.name).toBe(p < 0 ? EXPORT_SCENE_NAME : model.names[p]);
    }
    expect(scene.userData).toEqual({
      manifestSchema: SCHEMA.manifest,
      recipeId: 'sit-to-stand.v1',
      reviewStatus: 'unreviewed-synthetic',
      reviewNotice: REVIEW_NOTICE,
    });
  });

  it('adds only prefixed visual meshes, which can be omitted', () => {
    const scene = buildExportScene(rig);
    const meshes: Mesh[] = [];
    scene.traverse((o) => {
      if ((o as Mesh).isMesh) meshes.push(o as Mesh);
    });
    expect(meshes.length).toBeGreaterThan(model.jointCount);
    for (const m of meshes) {
      expect(m.name.startsWith(VISUAL_NODE_PREFIX)).toBe(true);
      expect(m.userData).toEqual({ role: 'visual' });
      expect(model.index.has(m.name)).toBe(false);
    }
    const bare = buildExportScene(rig, { includeMeshes: false });
    let count = 0;
    bare.traverse((o) => {
      if ((o as Mesh).isMesh) count++;
    });
    expect(count).toBe(0);
    expect(bare.userData['recipeId']).toBeNull();
  });

  it('rejects joint names that cannot be glTF animation targets', () => {
    const bad = buildCanonicalRig('bad-rig', 'bad', PROPORTIONS_A);
    bad.joints = bad.joints.map((j) => (j.name === 'neck' ? { ...j, name: 'neck.base' } : j));
    expect(() => buildExportScene(bad)).toThrow(ExportValidationError);
    try {
      buildExportScene(bad);
    } catch (e) {
      expect((e as ExportValidationError).diagnostics[0]!.code).toBe('RIG_INVALID');
    }
  });
});

describe('bakedClipToAnimationClip', () => {
  const { clip } = createSyntheticClip(rig, { seed: 3, fps: 30, duration: 1.5 });

  it('writes a rotation track per joint plus root and pelvis translation, keyed at the baked times', () => {
    const anim = bakedClipToAnimationClip(clip);
    expect(anim.tracks).toHaveLength(model.jointCount + 2);
    expect(anim.duration).toBe(1.5);
    const times = Float32Array.from(clip.times);
    for (const t of anim.tracks) expect(Array.from(t.times)).toEqual(Array.from(times));
    for (let j = 0; j < model.jointCount; j++) {
      const track = anim.tracks.find((t) => t.name === `${model.names[j]}.quaternion`)!;
      expect(track).toBeInstanceOf(QuaternionKeyframeTrack);
      clip.frames.forEach((f, k) => {
        const v = Array.from(track.values.slice(k * 4, k * 4 + 4)) as Quat;
        expect(Math.abs(quatDot(v, f.local[j]!))).toBeGreaterThan(1 - 1e-6);
      });
    }
    const rootT = anim.tracks.find((t) => t.name === 'root.position')!;
    const pelvisT = anim.tracks.find((t) => t.name === 'pelvis.position')!;
    expect(rootT).toBeInstanceOf(VectorKeyframeTrack);
    const pelvisRest = model.offset[model.index.get('pelvis')!]!;
    clip.frames.forEach((f, k) => {
      for (let a = 0; a < 3; a++) {
        expect(rootT.values[k * 3 + a]).toBe(Math.fround(model.offset[0]![a]! + f.rootTranslation[a]!));
        expect(pelvisT.values[k * 3 + a]).toBe(Math.fround(pelvisRest[a]! + f.pelvisOffset[a]!));
      }
    });
    expect(anim.userData['reviewStatus']).toBe('unreviewed-synthetic');
  });

  it('enforces quaternion hemisphere continuity (q and -q are the same rotation)', () => {
    const wrap = createSyntheticClip(rig, { seed: 5, fps: 60, headingWrap: true }).clip;
    const rootIdx = model.index.get('root')!;
    const raw = wrap.frames.map((f) => f.local[rootIdx]!);
    const rawMinDot = Math.min(...raw.slice(1).map((q, k) => quatDot(raw[k]!, q)));
    expect(rawMinDot).toBeLessThan(0); // canonical (w >= 0) input flips sign when heading crosses 180 deg
    const { report } = alignedRotationKeys(wrap);
    expect(report.flipsApplied).toBeGreaterThan(0);
    expect(report.minConsecutiveDot).toBeGreaterThanOrEqual(0);
    const anim = bakedClipToAnimationClip(wrap);
    for (const track of anim.tracks.filter((t) => t.name.endsWith('.quaternion'))) {
      const v = track.values;
      for (let k = 4; k < v.length; k += 4) {
        const d = v[k - 4]! * v[k]! + v[k - 3]! * v[k + 1]! + v[k - 2]! * v[k + 2]! + v[k - 1]! * v[k + 3]!;
        expect(d).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('asserts the per-frame rotation step limit scaled to the frame rate', () => {
    const at60 = createSyntheticClip(rig, { seed: 9, fps: 60, duration: 0.5 }).clip;
    const at24 = createSyntheticClip(rig, { seed: 9, fps: 24, duration: 0.5 }).clip;
    const axis: [number, number, number] = [1, 0, 0];
    // 15 deg per frame: over the 10 deg limit at 60 fps, under the 25 deg limit at 24 fps.
    const step = (15 * Math.PI) / 180;
    const fast60 = withJointRotation(at60, 'knee_L', (k) => quatFromAxisAngle(axis, step * k));
    const fast24 = withJointRotation(at24, 'knee_L', (k) => quatFromAxisAngle(axis, step * k));
    expect(() => bakedClipToAnimationClip(fast60)).toThrow(/continuity violated/);
    try {
      bakedClipToAnimationClip(fast60);
    } catch (e) {
      const d = (e as ExportValidationError).diagnostics[0]!;
      expect(d.code).toBe('EXPORT_MISMATCH');
      expect(d.subject).toBe('knee_L');
      expect(d.limit).toBeCloseTo(TOLERANCES.quatStepMax60fps, 12);
    }
    expect(() => bakedClipToAnimationClip(fast24)).not.toThrow();
    expect(alignedRotationKeys(fast24).report.maxStepAllowed).toBeCloseTo(TOLERANCES.quatStepMax60fps * 2.5, 12);
  });

  it('rejects times that are not strictly increasing after float32 quantisation, and bad frames', () => {
    const c = structuredClone(clip);
    c.times[5] = c.times[4]! + 1e-12;
    c.frames[5]!.t = c.times[5]!;
    expect(() => bakedClipToAnimationClip(c)).toThrow(/strictly increasing/);
    const short = structuredClone(clip);
    short.frames.pop();
    expect(() => bakedClipToAnimationClip(short)).toThrow(ExportValidationError);
    const nan = withJointRotation(clip, 'hip_R', () => [NaN, 0, 0, 1]);
    expect(() => bakedClipToAnimationClip(nan)).toThrow(/Non-finite/);
  });
});

describe('rotationAngle', () => {
  it('is accurate for tiny angles and invariant to quaternion scale and sign', () => {
    const a = quatFromAxisAngle([0.6, 0, 0.8], 0.7);
    for (const eps of [1e-9, 1e-7, 1e-4, 0.3]) {
      const b = quatMultiply(a, quatFromAxisAngle([0, 1, 0], eps));
      expect(Math.abs(rotationAngle(a, b) - eps)).toBeLessThan(1e-12 + eps * 1e-9);
      const scaled: Quat = [-b[0] * 1.0000002, -b[1] * 1.0000002, -b[2] * 1.0000002, -b[3] * 1.0000002];
      expect(Math.abs(rotationAngle(a, scaled) - eps)).toBeLessThan(1e-12 + eps * 1e-6);
    }
  });
});

describe('exportBakedClipToGlb environment', () => {
  it('explains the missing FileReader instead of failing obscurely in Node without the shim', async () => {
    const g = globalThis as { FileReader?: unknown };
    const saved = g.FileReader;
    delete g.FileReader;
    try {
      const s = createSyntheticClip(rig, { seed: 1, fps: 10, duration: 0.3 });
      await expect(
        exportBakedClipToGlb(s.clip, { recipe: s.recipe, recipeDoc: s.recipeDoc, metrics: null, contactSchedule: [] }),
      ).rejects.toThrow(/needs FileReader/);
    } finally {
      if (saved !== undefined) g.FileReader = saved;
    }
  });
});
