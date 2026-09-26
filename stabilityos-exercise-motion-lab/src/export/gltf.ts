import {
  AnimationClip,
  CylinderGeometry,
  InterpolateLinear,
  KeyframeTrack,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PropertyBinding,
  Quaternion,
  QuaternionKeyframeTrack,
  Scene,
  SphereGeometry,
  Vector3,
  VectorKeyframeTrack,
  type BufferGeometry,
  type Group,
  type Interpolant,
} from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { REVIEW_NOTICE, REVIEW_STATUS, SCHEMA } from '../core/contracts/common.ts';
import { diag, type Diagnostic } from '../core/contracts/diagnostics.ts';
import type { ExportManifest } from '../core/contracts/manifest.ts';
import type { ContactInterval } from '../core/contracts/plan.ts';
import { newRecipeDocument, recipeIdSchema, type RecipeDocument } from '../core/contracts/recipe.ts';
import type { RigDefinition } from '../core/contracts/rig.ts';
import {
  buildExportManifest,
  manifestToJson,
  sha256Hex,
  type ManifestRecipeInfo,
  type RoundTripSummary,
} from '../core/io/manifest.ts';
import type { Quat } from '../core/math/quat.ts';
import type { Vec3 } from '../core/math/vec3.ts';
import { analyzeClip, analyzePlan } from '../core/metrics/analyze.ts';
import type { BakedClip, ClipMetrics } from '../core/metrics/types.ts';
import { SYNTHETIC_FIXTURE_ID } from './syntheticClip.ts';
import { getRecipe } from '../core/recipes/registry.ts';
import { getRigModel, rigidLinks, type RigModel } from '../core/rig/model.ts';
import { samplePose } from '../core/solver/sample.ts';
import type { PoseSample } from '../core/solver/types.ts';
import { TOLERANCES } from '../core/tolerances.ts';

export type { ManifestRecipeInfo, RoundTripSummary } from '../core/io/manifest.ts';

/**
 * Baked-animation export to glTF 2.0 binary (.glb) + semantic manifest, reimport and numerical
 * round-trip comparison.
 *
 * Axes need no conversion: the engine convention (+Y up, +Z forward, +X subject's left, metres,
 * quaternions [x,y,z,w]) is the glTF 2.0 convention. One node per canonical joint (node name =
 * joint name, rest offset as translation); every joint gets a rotation channel, and `root` and
 * `pelvis` also get translation channels. Keyframe times are the baked frame times (LINEAR).
 *
 * Works in browsers and Node. GLTFExporter's binary path needs `FileReader`, which Node lacks:
 * Node callers (tests, scripts) must install `tests/support/fileReaderShim.ts` first.
 */

export const EXPORT_SCENE_NAME = 'smx-exercise-motion';
export const VISUAL_NODE_PREFIX = 'vis_';
const NODE_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** An export precondition failed; `diagnostics` explain what and where. */
export class ExportValidationError extends Error {
  readonly diagnostics: Diagnostic[];
  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message);
    this.name = 'ExportValidationError';
    this.diagnostics = diagnostics;
  }
}

// ---------------------------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------------------------

export interface ExportSceneOptions {
  /** Recorded in the scene extras. */
  recipeId?: string | null;
  /** Small stylised segment meshes so the file is viewable (default true). Nodes are always written. */
  includeMeshes?: boolean;
}

function assertExportableNames(rig: RigDefinition): void {
  const bad = rig.joints
    .map((j) => j.name)
    .filter(
      (n) =>
        !NODE_NAME_RE.test(n) || n.startsWith(VISUAL_NODE_PREFIX) || n === EXPORT_SCENE_NAME || PropertyBinding.sanitizeNodeName(n) !== n,
    );
  if (bad.length > 0) {
    throw new ExportValidationError(
      `Joint names not exportable as glTF animation targets: ${bad.join(', ')}`,
      bad.map((n) =>
        diag('RIG_INVALID', 'error', `Joint name '${n}' must match ${NODE_NAME_RE} and not use the '${VISUAL_NODE_PREFIX}' prefix.`, {
          subject: n,
        }),
      ),
    );
  }
}

const MATERIAL_COLORS = { left: 0x2f7fbf, right: 0xd9822b, center: 0x9aa3ad } as const;

function segmentMesh(name: string, from: Vec3, to: Vec3, radius: number, material: MeshStandardMaterial): Mesh | null {
  const a = new Vector3(...from);
  const b = new Vector3(...to);
  const len = a.distanceTo(b);
  if (!(len > 1e-4)) return null;
  const r = Math.min(radius, len * 0.35);
  const geo = new CylinderGeometry(r, r, len, 6, 1);
  geo.deleteAttribute('uv');
  geo.name = name;
  const mesh = new Mesh(geo as BufferGeometry, material);
  mesh.name = name;
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), b.clone().sub(a).normalize());
  mesh.userData = { role: 'visual' };
  return mesh;
}

function endSphere(name: string, at: Vec3, radius: number, material: MeshStandardMaterial): Mesh {
  const geo = new SphereGeometry(radius, 8, 6);
  geo.deleteAttribute('uv');
  geo.name = name;
  const mesh = new Mesh(geo as BufferGeometry, material);
  mesh.name = name;
  mesh.position.set(...at);
  mesh.userData = { role: 'visual' };
  return mesh;
}

/**
 * Scene whose node hierarchy mirrors the rig's joints (node name = joint name, rest offset =
 * translation, identity rest rotation). Optional stylised meshes (original, generated here) are
 * separate child nodes named `vis_*` with `extras.role = 'visual'`, so they never collide with
 * animation targets.
 */
export function buildExportScene(rig: RigDefinition, opts: ExportSceneOptions = {}): Scene {
  assertExportableNames(rig);
  const model = getRigModel(rig);
  const scene = new Scene();
  scene.name = EXPORT_SCENE_NAME;
  scene.userData = {
    manifestSchema: SCHEMA.manifest,
    recipeId: opts.recipeId ?? null,
    reviewStatus: REVIEW_STATUS,
    reviewNotice: REVIEW_NOTICE,
  };
  const nodes: Object3D[] = [];
  for (let i = 0; i < model.jointCount; i++) {
    const node = new Object3D();
    node.name = model.names[i]!;
    node.position.set(...model.offset[i]!);
    const p = model.parent[i]!;
    (p < 0 ? scene : nodes[p]!).add(node);
    nodes.push(node);
  }
  if (opts.includeMeshes ?? true) {
    const materials = {
      left: new MeshStandardMaterial({ name: 'smx-left', color: MATERIAL_COLORS.left, roughness: 0.8, metalness: 0 }),
      right: new MeshStandardMaterial({ name: 'smx-right', color: MATERIAL_COLORS.right, roughness: 0.8, metalness: 0 }),
      center: new MeshStandardMaterial({ name: 'smx-center', color: MATERIAL_COLORS.center, roughness: 0.8, metalness: 0 }),
    };
    for (let i = 0; i < model.jointCount; i++) {
      const joint = model.joints[i]!;
      if (joint.kind === 'root') continue;
      const radius = (rig.visualRadius[joint.name] ?? 0.05) * 0.4;
      const mat = materials[joint.side];
      for (let c = 0; c < model.jointCount; c++) {
        if (model.parent[c] !== i || model.joints[c]!.kind === 'pelvis') continue;
        const m = segmentMesh(`${VISUAL_NODE_PREFIX}${joint.name}_${model.names[c]}`, [0, 0, 0], model.offset[c]!, radius, mat);
        if (m) nodes[i]!.add(m);
      }
      rig.sites.forEach((site, s) => {
        if (model.siteJoint[s] !== i || site.role === 'penetration') return;
        const off = model.siteOffset[s]!;
        const m = segmentMesh(`${VISUAL_NODE_PREFIX}${joint.name}_${site.name}`, [0, 0, 0], off, radius * 0.8, mat);
        if (m) nodes[i]!.add(m);
        if (site.role === 'marker') {
          const len = Math.hypot(off[0], off[1], off[2]);
          nodes[i]!.add(endSphere(`${VISUAL_NODE_PREFIX}${site.name}`, off, Math.min(0.1, Math.max(0.02, 0.3 * len)), mat));
        }
      });
    }
  }
  return scene;
}

// ---------------------------------------------------------------------------------------------
// Animation clip
// ---------------------------------------------------------------------------------------------

export interface QuaternionContinuityReport {
  /** Minimum dot product between consecutive keys after hemisphere alignment (>= 0 required). */
  minConsecutiveDot: number;
  /** Largest rotation between consecutive keys (rad). */
  maxStep: number;
  /** Allowed step: TOLERANCES.quatStepMax60fps scaled by 60 / fps. */
  maxStepAllowed: number;
  worstJoint: string | null;
  worstTime: number | null;
  /** Keys whose sign was flipped to stay in the previous key's hemisphere. */
  flipsApplied: number;
  withinTolerance: boolean;
}

/** Geodesic angle between rotations, robust near zero (atan2 form, invariant to quaternion scale). */
export function rotationAngle(a: Quat | readonly number[], b: Quat | readonly number[]): number {
  const [ax, ay, az, aw] = a as Quat;
  const [bx, by, bz, bw] = b as Quat;
  // r = conj(a) * b
  const rx = aw * bx - ax * bw - ay * bz + az * by;
  const ry = aw * by + ax * bz - ay * bw - az * bx;
  const rz = aw * bz - ax * by + ay * bx - az * bw;
  const rw = aw * bw + ax * bx + ay * by + az * bz;
  return 2 * Math.atan2(Math.hypot(rx, ry, rz), Math.abs(rw));
}

function checkTimes(clip: BakedClip): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!(clip.fps > 0) || !Number.isFinite(clip.fps)) out.push(diag('EXPORT_MISMATCH', 'error', `Invalid fps ${clip.fps}.`));
  if (clip.times.length === 0) out.push(diag('EXPORT_MISMATCH', 'error', 'Clip has no frames.'));
  if (clip.times.length !== clip.frames.length) {
    out.push(diag('EXPORT_MISMATCH', 'error', `times (${clip.times.length}) and frames (${clip.frames.length}) differ in length.`));
  }
  for (let k = 0; k < clip.times.length; k++) {
    const t = clip.times[k]!;
    if (!Number.isFinite(t) || t < 0) {
      out.push(diag('EXPORT_MISMATCH', 'error', `Frame time ${t} is not a finite non-negative number.`, { time: t }));
      break;
    }
    if (k > 0 && !(Math.fround(t) > Math.fround(clip.times[k - 1]!))) {
      out.push(
        diag('EXPORT_MISMATCH', 'error', 'Frame times must be strictly increasing after float32 quantisation (glTF sampler input).', {
          time: t,
        }),
      );
      break;
    }
    if (clip.frames[k] && clip.frames[k]!.t !== t) {
      out.push(diag('EXPORT_MISMATCH', 'error', `frames[${k}].t (${clip.frames[k]!.t}) differs from times[${k}] (${t}).`, { time: t }));
      break;
    }
  }
  return out;
}

/**
 * Per-joint local rotation keys with hemisphere continuity enforced (q and -q are the same
 * rotation; each key takes the sign closest to the previous key) and unit-normalised.
 */
export function alignedRotationKeys(clip: BakedClip): { keys: Float64Array[]; report: QuaternionContinuityReport } {
  const model = getRigModel(clip.rig);
  const n = clip.frames.length;
  const maxStepAllowed = TOLERANCES.quatStepMax60fps * (60 / clip.fps);
  const report: QuaternionContinuityReport = {
    minConsecutiveDot: 1,
    maxStep: 0,
    maxStepAllowed,
    worstJoint: null,
    worstTime: null,
    flipsApplied: 0,
    withinTolerance: true,
  };
  const keys: Float64Array[] = [];
  for (let j = 0; j < model.jointCount; j++) {
    const out = new Float64Array(n * 4);
    for (let k = 0; k < n; k++) {
      const q = clip.frames[k]!.local[j];
      if (!q || q.length !== 4 || !q.every(Number.isFinite)) {
        throw new ExportValidationError(`Non-finite or missing rotation for joint ${model.names[j]} at t=${clip.times[k]}`, [
          diag('EXPORT_MISMATCH', 'error', 'Non-finite or missing local rotation.', { subject: model.names[j], time: clip.times[k] }),
        ]);
      }
      const len = Math.hypot(q[0], q[1], q[2], q[3]);
      if (!(len > 0.5)) {
        throw new ExportValidationError(`Degenerate quaternion for joint ${model.names[j]}`, [
          diag('EXPORT_MISMATCH', 'error', 'Degenerate local rotation quaternion.', { subject: model.names[j], time: clip.times[k] }),
        ]);
      }
      let x = q[0] / len;
      let y = q[1] / len;
      let z = q[2] / len;
      let w = q[3] / len;
      if (k > 0) {
        const o = (k - 1) * 4;
        let d = out[o]! * x + out[o + 1]! * y + out[o + 2]! * z + out[o + 3]! * w;
        if (d < 0) {
          x = -x;
          y = -y;
          z = -z;
          w = -w;
          d = -d;
          report.flipsApplied++;
        }
        const step = rotationAngle([out[o]!, out[o + 1]!, out[o + 2]!, out[o + 3]!], [x, y, z, w]);
        if (d < report.minConsecutiveDot) report.minConsecutiveDot = d;
        if (step > report.maxStep) {
          report.maxStep = step;
          report.worstJoint = model.names[j]!;
          report.worstTime = clip.times[k]!;
        }
      }
      out.set([x, y, z, w], k * 4);
    }
    keys.push(out);
  }
  report.withinTolerance = report.minConsecutiveDot >= 0 && report.maxStep <= maxStepAllowed;
  return { keys, report };
}

function rootAndPelvis(model: RigModel): { root: number; pelvis: number } {
  const roots = model.parent.flatMap((p, i) => (p < 0 ? [i] : []));
  if (roots.length !== 1) {
    throw new ExportValidationError(`Rig must have exactly one root joint (found ${roots.length}).`, [
      diag('RIG_INVALID', 'error', `Rig must have exactly one root joint (found ${roots.length}).`),
    ]);
  }
  return { root: roots[0]!, pelvis: model.joints.findIndex((j) => j.kind === 'pelvis') };
}

/**
 * Converts a baked clip into a three.js AnimationClip: `<joint>.quaternion` for every joint,
 * `root.position` (rest offset + root translation) and `pelvis.position` (rest offset + pelvis
 * offset), key times exactly `clip.times`. Throws ExportValidationError if times are not strictly
 * increasing (after float32 quantisation) or any quaternion step exceeds the continuity tolerance.
 */
export function bakedClipToAnimationClip(clip: BakedClip): AnimationClip {
  const timeIssues = checkTimes(clip);
  if (timeIssues.length > 0) throw new ExportValidationError(`Clip cannot be exported: ${timeIssues[0]!.message}`, timeIssues);
  const model = getRigModel(clip.rig);
  assertExportableNames(clip.rig);
  const { keys, report } = alignedRotationKeys(clip);
  if (!report.withinTolerance) {
    const msg =
      `Quaternion continuity violated: step ${((report.maxStep * 180) / Math.PI).toFixed(2)} deg at ${report.worstJoint} ` +
      `t=${report.worstTime} exceeds ${((report.maxStepAllowed * 180) / Math.PI).toFixed(2)} deg at ${clip.fps} fps`;
    throw new ExportValidationError(msg, [
      diag('EXPORT_MISMATCH', 'error', msg, {
        subject: report.worstJoint ?? undefined,
        time: report.worstTime ?? undefined,
        value: report.maxStep,
        limit: report.maxStepAllowed,
      }),
    ]);
  }
  const times = Float32Array.from(clip.times);
  const tracks: KeyframeTrack[] = [];
  for (let j = 0; j < model.jointCount; j++) {
    tracks.push(new QuaternionKeyframeTrack(`${model.names[j]}.quaternion`, times, Float32Array.from(keys[j]!), InterpolateLinear));
  }
  const { root, pelvis } = rootAndPelvis(model);
  const positionTrack = (joint: number, extra: (f: PoseSample) => Vec3): VectorKeyframeTrack => {
    const off = model.offset[joint]!;
    const values = new Float32Array(clip.frames.length * 3);
    clip.frames.forEach((f, k) => {
      const e = extra(f);
      values[k * 3] = off[0] + e[0];
      values[k * 3 + 1] = off[1] + e[1];
      values[k * 3 + 2] = off[2] + e[2];
    });
    return new VectorKeyframeTrack(`${model.names[joint]}.position`, times, values, InterpolateLinear);
  };
  tracks.push(positionTrack(root, (f) => f.rootTranslation));
  if (pelvis >= 0) tracks.push(positionTrack(pelvis, (f) => f.pelvisOffset));
  const last = clip.times[clip.times.length - 1]!;
  const anim = new AnimationClip(`${clip.plan.recipe.id} (${clip.tier}, ${clip.fps} fps)`, last, tracks);
  anim.userData = {
    recipeId: clip.plan.recipe.id,
    solverTier: clip.tier,
    fps: clip.fps,
    frameCount: clip.frames.length,
    interpolation: 'LINEAR',
    reviewStatus: REVIEW_STATUS,
  };
  return anim;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export interface ExportOptions {
  /** Recipe semantics for the manifest; defaults to the registry entry for `clip.plan.recipe.id`. */
  recipe?: ManifestRecipeInfo;
  /** Defaults to a document built from the plan's compiled parameters. */
  recipeDoc?: RecipeDocument;
  /** Defaults to `analyzeClip(clip)`; `null` records that metrics were not computed. */
  metrics?: ClipMetrics | null;
  contactSchedule?: readonly ContactInterval[];
  /** ISO timestamp for the manifest only (the .glb itself contains no timestamp, so its hash is reproducible). */
  createdAt?: string;
  fileBaseName?: string;
  includeMeshes?: boolean;
  /** Round-trip evidence to fold into the manifest (used by verifyRoundTrip). */
  roundTrip?: RoundTripSummary;
}

export interface ExportResult {
  glb: ArrayBuffer;
  manifest: ExportManifest;
  manifestJson: string;
  fileBaseName: string;
  animationFileName: string;
  manifestFileName: string;
  sha256: string;
  continuity: QuaternionContinuityReport;
}

function safeBaseName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+/, '').slice(0, 120) || 'export';
}

interface ResolvedManifestInputs {
  recipe: ManifestRecipeInfo;
  recipeDoc: RecipeDocument;
  metrics: ClipMetrics | null;
  metricsError?: string;
  contactSchedule?: readonly ContactInterval[];
  createdAt: string;
  fileBaseName: string;
}

function resolveManifestInputs(clip: BakedClip, opts: ExportOptions): ResolvedManifestInputs {
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const recipe: ManifestRecipeInfo | null = opts.recipe ?? getRecipe(clip.plan.recipe.id);
  if (!recipe) {
    throw new ExportValidationError(`Unknown recipe id '${clip.plan.recipe.id}'`, [
      diag('UNKNOWN_RECIPE', 'error', `Unknown recipe id '${clip.plan.recipe.id}'; the manifest needs the recipe definition.`),
    ]);
  }
  let recipeDoc = opts.recipeDoc;
  if (!recipeDoc) {
    const id = recipeIdSchema.safeParse(recipe.id);
    if (!id.success) {
      throw new ExportValidationError(`No recipe document for '${recipe.id}'`, [
        diag('UNKNOWN_RECIPE', 'error', `Recipe '${recipe.id}' is not a registered id; pass opts.recipeDoc explicitly.`),
      ]);
    }
    recipeDoc = newRecipeDocument(id.data, clip.plan.recipe.params, createdAt, 'Exported with a baked animation.');
  }
  let metrics: ClipMetrics | null;
  let metricsError: string | undefined;
  if (opts.metrics !== undefined) metrics = opts.metrics;
  else {
    try {
      // Engine-produced clips are re-analysed from the plan at the 240 Hz continuity rate (streamed,
      // bounded memory), so continuity checks apply regardless of the export frame rate. Export
      // self-test clips (not produced by the solver) are analysed from their own frames.
      metrics = clip.plan.recipe.id === SYNTHETIC_FIXTURE_ID ? analyzeClip(clip) : analyzePlan(clip.plan, clip.rig, clip.tier);
    } catch (e) {
      metrics = null;
      metricsError = e instanceof Error ? e.message : String(e);
    }
  }
  const fileBaseName = safeBaseName(opts.fileBaseName ?? `${recipe.id}.${clip.rig.id}.${clip.tier}.${clip.fps}fps`);
  return { recipe, recipeDoc, metrics, metricsError, contactSchedule: opts.contactSchedule, createdAt, fileBaseName };
}

function isArrayBufferLike(v: unknown): v is ArrayBuffer {
  return Object.prototype.toString.call(v) === '[object ArrayBuffer]';
}

async function exportResolved(clip: BakedClip, r: ResolvedManifestInputs, opts: ExportOptions): Promise<ExportResult> {
  if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
    throw new Error(
      'GLTFExporter binary output needs FileReader. Browsers provide it; in Node install the test/script shim ' +
        '(tests/support/fileReaderShim.ts: installFileReaderShim()) first.',
    );
  }
  const anim = bakedClipToAnimationClip(clip);
  const continuity = alignedRotationKeys(clip).report;
  const scene = buildExportScene(clip.rig, { recipeId: clip.plan.recipe.id, includeMeshes: opts.includeMeshes });
  const out = await new GLTFExporter().parseAsync(scene, { binary: true, animations: [anim], trs: true, onlyVisible: false });
  if (!isArrayBufferLike(out)) throw new Error('GLTFExporter did not return binary output');
  const glb = out;
  const sha256 = await sha256Hex(glb);
  const animationFileName = `${r.fileBaseName}.glb`;
  const manifest = buildExportManifest({
    clip,
    metrics: r.metrics,
    metricsError: r.metricsError,
    recipe: r.recipe,
    recipeDoc: r.recipeDoc,
    animationFileName,
    animationSha256: sha256,
    createdAt: r.createdAt,
    contactSchedule: r.contactSchedule,
    roundTrip: opts.roundTrip,
  });
  return {
    glb,
    manifest,
    manifestJson: manifestToJson(manifest),
    fileBaseName: r.fileBaseName,
    animationFileName,
    manifestFileName: `${r.fileBaseName}.manifest.json`,
    sha256,
    continuity,
  };
}

/**
 * Exports a baked clip as .glb (GLTFExporter: binary, trs, onlyVisible=false, one animation) plus
 * its manifest. The manifest records the .glb's SHA-256.
 */
export async function exportBakedClipToGlb(clip: BakedClip, opts: ExportOptions = {}): Promise<ExportResult> {
  return exportResolved(clip, resolveManifestInputs(clip, opts), opts);
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export interface ImportedGlb {
  gltf: GLTF;
  scene: Group;
  /** The first animation (the export writes exactly one). */
  clip: AnimationClip;
  animations: AnimationClip[];
  /** Scene extras (manifestSchema, recipeId, reviewStatus, reviewNotice). */
  userData: Record<string, unknown>;
  /** Named non-visual nodes by name (the joints). */
  jointNodes: Map<string, Object3D>;
}

export async function importGlb(glb: ArrayBuffer): Promise<ImportedGlb> {
  const loader = new GLTFLoader();
  const gltf = await new Promise<GLTF>((resolve, reject) => {
    loader.parse(glb, '', resolve, (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
  });
  const clip = gltf.animations[0];
  if (!clip) throw new Error('importGlb: the file contains no animation');
  const jointNodes = new Map<string, Object3D>();
  gltf.scene.traverse((o) => {
    if (o === gltf.scene || (o as Mesh).isMesh || o.userData['role'] === 'visual' || o.name === '') return;
    jointNodes.set(o.name, o);
  });
  return { gltf, scene: gltf.scene, clip, animations: gltf.animations, userData: { ...gltf.scene.userData }, jointNodes };
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

export interface MidFrameResampling {
  /** Not a pass criterion: measures bake resolution (LINEAR/slerp between frames vs a fresh sample). */
  label: 'mid-frame resampling (informational, not a pass criterion)';
  available: boolean;
  source: 'engine samplePose' | 'provided sampler' | 'unavailable';
  reason?: string;
  framesCompared: number;
  maxPositionError: number;
  maxRotationError: number;
  worstJoint: string | null;
  worstTime: number | null;
}

export interface RoundTripReport {
  framesCompared: number;
  /** Max world joint position error at the original frame times (m). */
  maxPositionError: number;
  /** Max local joint rotation error at the original frame times (rad). */
  maxRotationError: number;
  /** Max world joint rotation error (rad); informational. */
  maxWorldRotationError: number;
  maxBoneLengthRelError: number;
  /** Max root joint world position error (m). */
  maxRootError: number;
  perJointMax: Record<string, { position: number; rotation: number }>;
  /** Minimum consecutive dot product of the imported rotation keys (hemisphere continuity survived). */
  importedMinConsecutiveDot: number;
  withinTolerance: boolean;
  tolerances: { position: number; rotation: number; boneLengthRel: number };
  issues: string[];
  midFrame: MidFrameResampling;
}

export interface CompareOptions {
  /**
   * Fresh sampler for mid-frame resampling. Default: the engine's `samplePose(plan, rig, t, tier)`
   * when it is available.
   */
  sampler?: (t: number) => PoseSample;
}

interface TrackEval {
  interpolant: Interpolant;
  node: Object3D;
  target: 'quaternion' | 'position';
}

function findTrack(clip: AnimationClip, name: string): KeyframeTrack | undefined {
  return clip.tracks.find((t) => t.name === name);
}

/**
 * The track's own interpolant (whatever interpolation the loader configured), writing into a
 * float64 result buffer as AnimationMixer does. `createInterpolant` is set at runtime by
 * `setInterpolation` and is missing from the type declarations.
 */
function trackInterpolant(track: KeyframeTrack, size: number): Interpolant {
  const t = track as KeyframeTrack & { createInterpolant(result?: Float64Array): Interpolant };
  return t.createInterpolant(new Float64Array(size));
}

function minConsecutiveDot(track: KeyframeTrack): number {
  let min = 1;
  const v = track.values;
  for (let k = 4; k + 3 < v.length; k += 4) {
    const d = v[k - 4]! * v[k]! + v[k - 3]! * v[k + 1]! + v[k - 2]! * v[k + 2]! + v[k - 1]! * v[k + 3]!;
    const na = Math.hypot(v[k - 4]!, v[k - 3]!, v[k - 2]!, v[k - 1]!);
    const nb = Math.hypot(v[k]!, v[k + 1]!, v[k + 2]!, v[k + 3]!);
    min = Math.min(min, d / (na * nb));
  }
  return min;
}

/**
 * Compares an imported .glb against the baked clip it came from: each imported track is evaluated
 * with its own interpolant at exactly the original frame times, node transforms are set, world
 * matrices updated, and world joint positions / local rotations / bone lengths are compared with
 * the clip's FK output. Mid-frame resampling (t between frames vs a fresh sample) is reported
 * separately and is not a pass criterion.
 */
export function compareImportedToClip(imported: ImportedGlb, clip: BakedClip, opts: CompareOptions = {}): RoundTripReport {
  const model = getRigModel(clip.rig);
  const links = rigidLinks(model);
  const issues: string[] = [];
  const evals: TrackEval[] = [];
  const nodes: (Object3D | undefined)[] = model.names.map((n) => imported.jointNodes.get(n));
  let importedMinDot = 1;

  const { root, pelvis } = rootAndPelvis(model);
  for (let j = 0; j < model.jointCount; j++) {
    const name = model.names[j]!;
    const node = nodes[j];
    if (!node) {
      issues.push(`missing node '${name}'`);
      continue;
    }
    const q = findTrack(imported.clip, `${name}.quaternion`);
    if (!q) issues.push(`missing track '${name}.quaternion'`);
    else {
      evals.push({ interpolant: trackInterpolant(q, 4), node, target: 'quaternion' });
      if (q.getInterpolation() !== InterpolateLinear) issues.push(`track '${q.name}' is not LINEAR`);
      importedMinDot = Math.min(importedMinDot, minConsecutiveDot(q));
      if (q.times.length !== clip.times.length) issues.push(`track '${q.name}' has ${q.times.length} keys, expected ${clip.times.length}`);
    }
    if (j === root || j === pelvis) {
      const p = findTrack(imported.clip, `${name}.position`);
      if (!p) issues.push(`missing track '${name}.position'`);
      else {
        evals.push({ interpolant: trackInterpolant(p, 3), node, target: 'position' });
        if (p.getInterpolation() !== InterpolateLinear) issues.push(`track '${p.name}' is not LINEAR`);
      }
    }
  }
  const unexpected = [...imported.jointNodes.keys()].filter((n) => !model.index.has(n));
  if (unexpected.length > 0) issues.push(`unexpected non-visual nodes: ${unexpected.join(', ')}`);

  const perJointMax: Record<string, { position: number; rotation: number }> = Object.fromEntries(
    model.names.map((n) => [n, { position: 0, rotation: 0 }] as const),
  );
  const wp = new Vector3();
  const wq = new Quaternion();

  const applyAt = (t: number): void => {
    for (const e of evals) {
      const r = e.interpolant.evaluate(t);
      if (e.target === 'quaternion') e.node.quaternion.set(r[0]!, r[1]!, r[2]!, r[3]!);
      else e.node.position.set(r[0]!, r[1]!, r[2]!);
    }
    imported.scene.updateMatrixWorld(true);
  };
  const readWorld = (j: number): { pos: Vec3; rot: Quat } | null => {
    const node = nodes[j];
    if (!node) return null;
    node.getWorldPosition(wp);
    node.getWorldQuaternion(wq);
    return { pos: [wp.x, wp.y, wp.z], rot: [wq.x, wq.y, wq.z, wq.w] };
  };

  let maxPos = 0;
  let maxRot = 0;
  let maxWorldRot = 0;
  let maxBone = 0;
  let maxRoot = 0;
  let framesCompared = 0;
  const worldPos: (Vec3 | null)[] = new Array(model.jointCount).fill(null);

  if (issues.length === 0) {
    for (let k = 0; k < clip.frames.length; k++) {
      const frame = clip.frames[k]!;
      applyAt(clip.times[k]!);
      for (let j = 0; j < model.jointCount; j++) {
        const w = readWorld(j)!;
        worldPos[j] = w.pos;
        const ref = frame.worldPos[j]!;
        const dp = Math.hypot(w.pos[0] - ref[0], w.pos[1] - ref[1], w.pos[2] - ref[2]);
        const n = nodes[j]!;
        const dr = rotationAngle([n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w], frame.local[j]!);
        const dwr = rotationAngle(w.rot, frame.worldRot[j]!);
        const pj = perJointMax[model.names[j]!]!;
        pj.position = Math.max(pj.position, dp);
        pj.rotation = Math.max(pj.rotation, dr);
        maxPos = Math.max(maxPos, dp);
        maxRot = Math.max(maxRot, dr);
        maxWorldRot = Math.max(maxWorldRot, dwr);
        if (j === root) maxRoot = Math.max(maxRoot, dp);
      }
      for (const l of links) {
        const a = worldPos[l.a]!;
        const b = worldPos[l.b]!;
        if (!(l.length > 0)) continue;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        maxBone = Math.max(maxBone, Math.abs(len - l.length) / l.length);
      }
      framesCompared++;
    }
  }

  // Mid-frame resampling (informational).
  const midFrame: MidFrameResampling = {
    label: 'mid-frame resampling (informational, not a pass criterion)',
    available: false,
    source: 'unavailable',
    framesCompared: 0,
    maxPositionError: 0,
    maxRotationError: 0,
    worstJoint: null,
    worstTime: null,
  };
  if (issues.length === 0 && clip.times.length > 1) {
    let sampler = opts.sampler;
    let source: MidFrameResampling['source'] = 'provided sampler';
    if (!sampler) {
      source = 'engine samplePose';
      sampler = (t: number) => samplePose(clip.plan, clip.rig, t, clip.tier);
    }
    try {
      for (let k = 0; k + 1 < clip.times.length; k++) {
        const t = (clip.times[k]! + clip.times[k + 1]!) / 2;
        const fresh = sampler(t);
        applyAt(t);
        for (let j = 0; j < model.jointCount; j++) {
          const w = readWorld(j)!;
          const ref = fresh.worldPos[j]!;
          const dp = Math.hypot(w.pos[0] - ref[0], w.pos[1] - ref[1], w.pos[2] - ref[2]);
          const n = nodes[j]!;
          const dr = rotationAngle([n.quaternion.x, n.quaternion.y, n.quaternion.z, n.quaternion.w], fresh.local[j]!);
          if (dp > midFrame.maxPositionError) {
            midFrame.maxPositionError = dp;
            midFrame.worstJoint = model.names[j]!;
            midFrame.worstTime = t;
          }
          midFrame.maxRotationError = Math.max(midFrame.maxRotationError, dr);
        }
        midFrame.framesCompared++;
      }
      midFrame.available = true;
      midFrame.source = source;
    } catch (e) {
      midFrame.available = false;
      midFrame.source = 'unavailable';
      midFrame.reason = e instanceof Error ? e.message : String(e);
      midFrame.framesCompared = 0;
      midFrame.maxPositionError = 0;
      midFrame.maxRotationError = 0;
      midFrame.worstJoint = null;
      midFrame.worstTime = null;
    }
  }

  if (framesCompared !== clip.frames.length) issues.push(`compared ${framesCompared} of ${clip.frames.length} frames`);
  if (importedMinDot < 0) issues.push(`imported rotation track has a hemisphere flip (min consecutive dot ${importedMinDot})`);
  const tolerances = {
    position: TOLERANCES.exportPosition,
    rotation: TOLERANCES.exportRotation,
    boneLengthRel: TOLERANCES.boneLengthRelExported,
  };
  const withinTolerance =
    issues.length === 0 &&
    maxPos <= tolerances.position &&
    maxRoot <= tolerances.position &&
    maxRot <= tolerances.rotation &&
    maxBone <= tolerances.boneLengthRel;
  return {
    framesCompared,
    maxPositionError: maxPos,
    maxRotationError: maxRot,
    maxWorldRotationError: maxWorldRot,
    maxBoneLengthRelError: maxBone,
    maxRootError: maxRoot,
    perJointMax,
    importedMinConsecutiveDot: importedMinDot,
    withinTolerance,
    tolerances,
    issues,
    midFrame,
  };
}

export function roundTripSummary(report: RoundTripReport): RoundTripSummary {
  return {
    framesCompared: report.framesCompared,
    maxPositionError: report.maxPositionError,
    maxRotationError: report.maxRotationError,
    maxBoneLengthRelError: report.maxBoneLengthRelError,
    maxRootError: report.maxRootError,
    withinTolerance: report.withinTolerance,
    issues: report.issues,
  };
}

export interface VerifyResult {
  exported: ExportResult;
  imported: ImportedGlb;
  report: RoundTripReport;
  /** Manifest of the same .glb with the round-trip evidence folded into `validation`. */
  manifest: ExportManifest;
  manifestJson: string;
}

/** Export -> reimport -> compare. The returned manifest includes the round-trip result. */
export async function verifyRoundTrip(clip: BakedClip, opts: ExportOptions & CompareOptions = {}): Promise<VerifyResult> {
  const resolved = resolveManifestInputs(clip, opts);
  const exported = await exportResolved(clip, resolved, opts);
  const imported = await importGlb(exported.glb);
  const report = compareImportedToClip(imported, clip, { sampler: opts.sampler });
  const manifest = buildExportManifest({
    clip,
    metrics: resolved.metrics,
    metricsError: resolved.metricsError,
    recipe: resolved.recipe,
    recipeDoc: resolved.recipeDoc,
    animationFileName: exported.animationFileName,
    animationSha256: exported.sha256,
    createdAt: resolved.createdAt,
    contactSchedule: resolved.contactSchedule,
    roundTrip: roundTripSummary(report),
  });
  return { exported, imported, report, manifest, manifestJson: manifestToJson(manifest) };
}
