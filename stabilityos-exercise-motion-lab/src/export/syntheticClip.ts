import { REVIEW_STATUS, SCHEMA, ENGINE_NAME, ENGINE_VERSION } from '../core/contracts/common.ts';
import type { MotionPlan, ContactInterval } from '../core/contracts/plan.ts';
import type { RecipeDocument } from '../core/contracts/recipe.ts';
import type { RigDefinition } from '../core/contracts/rig.ts';
import { createRng } from '../core/math/rng.ts';
import type { Quat } from '../core/math/quat.ts';
import type { Vec3 } from '../core/math/vec3.ts';
import type { BakedClip } from '../core/metrics/types.ts';
import { composeJointRotation, forwardKinematics, getRigModel } from '../core/rig/model.ts';
import type { FootTarget, PoseSample, SolverTier } from '../core/solver/types.ts';
import type { ManifestRecipeInfo } from '../core/io/manifest.ts';

/**
 * Export-path self-test fixture: a smooth, seeded joint-angle sweep for any rig, baked into a
 * `BakedClip` WITHOUT the solver. It exercises the exporter (every joint rotates, root and pelvis
 * translate, optional root heading that crosses +-180 deg to force quaternion sign flips) and
 * provides an exact `sample(t)` for mid-frame resampling checks.
 *
 * It is NOT an exercise, NOT solver output and carries no contacts. Its manifest says so.
 */

export const SYNTHETIC_FIXTURE_ID = 'export-selftest.synthetic-angles';

export const SYNTHETIC_FIXTURE_RECIPE: ManifestRecipeInfo = {
  id: SYNTHETIC_FIXTURE_ID,
  version: '1',
  title: 'Synthetic joint-angle sweep (export self-test; not an exercise, not solver output)',
  setup: ['No environment interaction: every contact is absent. Used only to verify the export path.'],
  assumptions: [
    'Joint angles are seeded smooth sinusoids inside the rig\'s synthetic joint limits (heading may wrap through +-180 deg).',
    'Root and pelvis translation are smooth synthetic curves; no contact, balance or feasibility is implied.',
  ],
  unsupported: ['Contacts', 'Solver tiers (angles are generated directly)', 'Any exercise semantics'],
};

export interface SyntheticClipOptions {
  seed: number;
  fps: number;
  /** Seconds (default 2). */
  duration?: number;
  tier?: SolverTier;
  /** Root heading sweeps across +-180 deg (wrapped into the heading limit), forcing canonical-quaternion sign flips. */
  headingWrap?: boolean;
  /** Max amplitude per DOF (rad, default 0.6); also bounded by 45% of each DOF's limit range. */
  maxAmplitude?: number;
}

export interface SyntheticClip {
  clip: BakedClip;
  /** Exact pose at any time (for mid-frame resampling comparisons). */
  sample(t: number): PoseSample;
  recipe: ManifestRecipeInfo;
  recipeDoc: RecipeDocument;
  contactSchedule: ContactInterval[];
}

interface DofCurve {
  c: number;
  a1: number;
  f1: number;
  p1: number;
  a2: number;
  f2: number;
  p2: number;
}

function wrapAngle(x: number): number {
  const twoPi = 2 * Math.PI;
  let y = ((x + Math.PI) % twoPi + twoPi) % twoPi - Math.PI;
  if (y <= -Math.PI) y += twoPi;
  return y;
}

export function createSyntheticClip(rig: RigDefinition, opts: SyntheticClipOptions): SyntheticClip {
  const model = getRigModel(rig);
  const rng = createRng(opts.seed);
  const duration = opts.duration ?? 2;
  const tier = opts.tier ?? 'analytic';
  const maxAmp = opts.maxAmplitude ?? 0.6;
  if (!(opts.fps > 0) || !(duration > 0)) throw new Error('createSyntheticClip: fps and duration must be > 0');

  const curves: DofCurve[][] = model.joints.map((j) =>
    j.dofs.map((d) => {
      const range = d.max - d.min;
      const amp = Math.min(maxAmp, 0.45 * range);
      const split = rng.range(0.55, 0.85);
      return {
        c: (d.min + d.max) / 2,
        a1: amp * split,
        f1: rng.range(0.15, 0.5),
        p1: rng.range(0, 2 * Math.PI),
        a2: amp * (1 - split),
        f2: rng.range(0.3, 0.7),
        p2: rng.range(0, 2 * Math.PI),
      };
    }),
  );
  const tr = {
    x: [rng.range(0.02, 0.1), rng.range(0.1, 0.4), rng.range(0, 6.28)] as const,
    z: [rng.range(0.1, 0.4), rng.range(0.1, 0.4), rng.range(0, 6.28)] as const,
    py: [rng.range(0.9, 0.95), rng.range(0.02, 0.06), rng.range(0.2, 0.6), rng.range(0, 6.28)] as const,
    px: [rng.range(0.005, 0.03), rng.range(0.2, 0.6), rng.range(0, 6.28)] as const,
    pz: [rng.range(0.005, 0.03), rng.range(0.2, 0.6), rng.range(0, 6.28)] as const,
  };
  const headingStart = Math.PI * rng.range(0.75, 0.85);
  const headingSpan = Math.PI * rng.range(0.25, 0.4);
  const rootIdx = model.parent.findIndex((p) => p < 0);

  const idx = (name: string): number => model.index.get(name) ?? -1;
  const sides = ['left', 'right'] as const;

  function sample(t: number): PoseSample {
    const w = 2 * Math.PI;
    const angles = curves.map((dofs) =>
      dofs.map((c) => c.c + c.a1 * Math.sin(w * c.f1 * t + c.p1) + c.a2 * Math.sin(w * c.f2 * t + c.p2)),
    );
    if (opts.headingWrap && rootIdx >= 0 && angles[rootIdx]!.length > 0) {
      angles[rootIdx]![0] = wrapAngle(headingStart + (headingSpan * t) / duration);
    }
    const local: Quat[] = model.joints.map((j, i) => composeJointRotation(j, angles[i]!));
    const rootTranslation: Vec3 = [
      tr.x[0] * Math.sin(w * tr.x[1] * t + tr.x[2]),
      0,
      tr.z[0] * (t / duration) + 0.03 * Math.sin(w * tr.z[1] * t + tr.z[2]),
    ];
    const pelvisOffset: Vec3 = [
      tr.px[0] * Math.sin(w * tr.px[1] * t + tr.px[2]),
      tr.py[0] + tr.py[1] * Math.sin(w * tr.py[2] * t + tr.py[3]),
      tr.pz[0] * Math.sin(w * tr.pz[1] * t + tr.pz[2]),
    ];
    const fk = forwardKinematics(model, rootTranslation, pelvisOffset, local);
    const pelvisIdx = model.joints.findIndex((j) => j.kind === 'pelvis');
    const footTargets = Object.fromEntries(
      sides.map((side) => {
        const s = side === 'left' ? '_L' : '_R';
        const a = idx(`ankle${s}`);
        const m = idx(`mtp${s}`);
        const target: FootTarget = {
          side,
          mode: 'swing',
          anklePos: a >= 0 ? fk.worldPos[a]! : [0, 0, 0],
          footRot: a >= 0 ? fk.worldRot[a]! : [0, 0, 0, 1],
          toesRot: m >= 0 ? fk.worldRot[m]! : [0, 0, 0, 1],
          mtpExtension: 0,
          surface: null,
        };
        return [side, target];
      }),
    ) as Record<'left' | 'right', FootTarget>;
    return {
      t,
      tier,
      phaseIndex: 0,
      phaseId: 'sweep',
      rootTranslation,
      pelvisOffset,
      pelvisWorld: pelvisIdx >= 0 ? fk.worldPos[pelvisIdx]! : [0, 0, 0],
      angles,
      local,
      worldPos: fk.worldPos,
      worldRot: fk.worldRot,
      sitePos: fk.sitePos,
      footTargets,
      contacts: [],
      stabilization: {
        enabled: false,
        offset: [0, 0, 0],
        iterations: 0,
        converged: true,
        boundReached: false,
        initialViolation: 0,
        finalViolation: 0,
      },
      limitEvents: [],
      legs: [],
      diagnostics: [],
    };
  }

  const params = { seed: opts.seed, headingWrap: opts.headingWrap === true };
  const plan: MotionPlan = {
    schema: SCHEMA.plan,
    reviewStatus: REVIEW_STATUS,
    recipe: { id: SYNTHETIC_FIXTURE_ID, version: '1', params },
    rig: { id: rig.id, fingerprint: model.fingerprint },
    environment: { schema: SCHEMA.environment, units: 'm', objects: [{ kind: 'floor', id: 'floor' }] },
    duration,
    phases: [{ id: 'sweep', label: 'Synthetic sweep', start: 0, end: duration, description: 'Export self-test joint-angle sweep.' }],
    cues: [{ id: 'sweep-start', t: 0, phaseId: 'sweep', label: 'Sweep start (timing marker only)' }],
    pelvis: {
      x: { keys: [{ t: 0, v: 0, mode: 'stop' }] },
      y: { keys: [{ t: 0, v: 0, mode: 'stop' }] },
      z: { keys: [{ t: 0, v: 0, mode: 'stop' }] },
      rotation: { keys: [{ t: 0, v: 0, mode: 'stop' }] },
      tilt: { keys: [{ t: 0, v: 0, mode: 'stop' }] },
      obliquity: { keys: [{ t: 0, v: 0, mode: 'stop' }] },
    },
    joints: {},
    feet: {
      left: [{ kind: 'swing', start: 0, end: duration, clearance: 0, horizontalDelay: 0, horizontalLead: 0, riseEnd: 0.5, descendStart: 0.5 }],
      right: [{ kind: 'swing', start: 0, end: duration, clearance: 0, horizontalDelay: 0, horizontalLead: 0, riseEnd: 0.5, descendStart: 0.5 }],
    },
    seat: null,
    stabilization: { enabled: false, bounds: [0, 0, 0], notableOffset: 0.005, maxIterations: 1, tolerance: 1e-6, kneeFlexionFloor: 0, reachSoftZone: 0 },
    assumptions: ['Synthetic export self-test: angles are generated directly, not solved; no contacts.'],
  };

  // Bake contract (same as bakeClip): frame k at t = min(k / fps, duration); last frame at t = duration.
  const times: number[] = [];
  for (let k = 0; ; k++) {
    const t = Math.min(k / opts.fps, duration);
    times.push(t);
    if (t >= duration) break;
  }
  const frames = times.map(sample);
  const recipeDoc: RecipeDocument = {
    schema: SCHEMA.recipe,
    recipeId: SYNTHETIC_FIXTURE_ID,
    reviewStatus: REVIEW_STATUS,
    params: { ...params },
    provenance: { generator: ENGINE_NAME, generatorVersion: ENGINE_VERSION, createdAt: '1970-01-01T00:00:00.000Z', note: 'export self-test fixture' },
  };
  return {
    clip: { plan, rig, tier, fps: opts.fps, times, frames },
    sample,
    recipe: SYNTHETIC_FIXTURE_RECIPE,
    recipeDoc,
    contactSchedule: [],
  };
}
