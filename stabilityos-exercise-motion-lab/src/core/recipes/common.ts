import { REVIEW_STATUS, SCHEMA, SIDES, type Side } from '../contracts/common.ts';
import { diag, hasErrors, type Diagnostic } from '../contracts/diagnostics.ts';
import type { Environment } from '../contracts/environment.ts';
import type { Cue, FootAnchor, MotionPlan, PelvisChannels, Phase, StabilizationSpec, Track } from '../contracts/plan.ts';
import type { ParamRecord, ParamSpec } from '../contracts/recipe.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { deg, RAD2DEG } from '../math/curves.ts';
import { quatRotateVec3, type Quat } from '../math/quat.ts';
import { sub, type Vec3 } from '../math/vec3.ts';
import { validatePlan } from '../plan/validate.ts';
import { armJoints, SEAT_SITE } from '../rig/canonical.ts';
import { composeJointRotation, getRigModel, rigFingerprint } from '../rig/model.ts';
import { validateRig } from '../rig/validate.ts';
import { samplePose } from '../solver/sample.ts';
import type { CompileResult, RecipeDefinition } from './types.ts';

export type Values = Record<string, number | string>;

/** Type/range/enum checks against the recipe's ParamSpecs. Unknown keys are rejected, missing ones take defaults. */
export function validateParams(specs: readonly ParamSpec[], params: ParamRecord): { values: Values; diagnostics: Diagnostic[] } {
  const out: Diagnostic[] = [];
  const values: Values = {};
  const known = new Set(specs.map((s) => s.key));
  for (const k of Object.keys(params))
    if (!known.has(k)) out.push(diag('SCHEMA_INVALID', 'error', `unknown parameter '${k}'`, { path: `params.${k}`, hint: `Known: ${[...known].join(', ')}` }));
  for (const s of specs) {
    const raw = Object.prototype.hasOwnProperty.call(params, s.key) ? params[s.key] : undefined;
    const v = raw === undefined ? s.default : raw;
    if (s.kind === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        out.push(diag('SCHEMA_INVALID', 'error', `${s.label} must be a finite number`, { path: `params.${s.key}` }));
        continue;
      }
      if (v < s.min - 1e-12 || v > s.max + 1e-12)
        out.push(
          diag('PARAM_OUT_OF_RANGE', 'error', `${s.label} = ${v} ${s.unit} is outside the supported range ${s.min}–${s.max} ${s.unit}`, {
            path: `params.${s.key}`,
            value: v,
            hint: `Supported range: ${s.min}–${s.max} ${s.unit}.`,
          }),
        );
      if (s.unit === 'count' && !Number.isInteger(v)) out.push(diag('SCHEMA_INVALID', 'error', `${s.label} must be an integer`, { path: `params.${s.key}` }));
      values[s.key] = v;
    } else {
      if (typeof v !== 'string' || !s.options.includes(v)) {
        out.push(diag('PARAM_OUT_OF_RANGE', 'error', `${s.label} must be one of ${s.options.join(', ')}`, { path: `params.${s.key}` }));
        continue;
      }
      values[s.key] = v;
    }
  }
  return { values, diagnostics: out };
}

export function defaultsOf(specs: readonly ParamSpec[]): ParamRecord {
  return Object.fromEntries(specs.map((s) => [s.key, s.default]));
}

export const num = (v: Values, k: string): number => v[k] as number;
export const str = (v: Values, k: string): string => v[k] as string;

export type Triple = [number, number, number];
export interface ArmPose {
  shoulder: Triple;
  elbow: number;
}
/** One authored whole-body key. Angles in radians; pelvis position in world metres. */
export interface BodyKey {
  t: number;
  mode: 'stop' | 'flow';
  pelvis: Vec3;
  rotation: number;
  tilt: number;
  obliquity: number;
  lumbar: Triple;
  thoracic: Triple;
  neck: Triple;
  arms: Record<Side, ArmPose>;
}

export const SPINE_DOFS = ['flexion', 'lateralFlexion', 'axialRotation'] as const;
export const SHOULDER_DOFS = ['flexion', 'abduction', 'internalRotation'] as const;

/** Convert whole-body keys to plan channels. Keys must have strictly increasing times. */
export function tracksFromKeys(keys: readonly BodyKey[]): { pelvis: PelvisChannels; joints: MotionPlan['joints'] } {
  const tr = (f: (k: BodyKey) => number): Track => ({ keys: keys.map((k) => ({ t: k.t, v: f(k), mode: k.mode })) });
  const joints: MotionPlan['joints'] = {};
  for (const [name, get] of [
    ['lumbar', (k: BodyKey) => k.lumbar],
    ['thoracic', (k: BodyKey) => k.thoracic],
    ['neck', (k: BodyKey) => k.neck],
  ] as const) {
    joints[name] = Object.fromEntries(SPINE_DOFS.map((d, i) => [d, tr((k) => get(k)[i]!)]));
  }
  for (const side of SIDES) {
    const aj = armJoints(side);
    joints[aj.shoulder] = Object.fromEntries(SHOULDER_DOFS.map((d, i) => [d, tr((k) => k.arms[side].shoulder[i]!)]));
    joints[aj.elbow] = { flexion: tr((k) => k.arms[side].elbow) };
  }
  return {
    pelvis: {
      x: tr((k) => k.pelvis[0]),
      y: tr((k) => k.pelvis[1]),
      z: tr((k) => k.pelvis[2]),
      rotation: tr((k) => k.rotation),
      tilt: tr((k) => k.tilt),
      obliquity: tr((k) => k.obliquity),
    },
    joints,
  };
}

/**
 * Synthetic trunk-lean distribution (authoring convention, not a measured coordination pattern):
 * pelvis tilt 55 %, lumbar 25 %, thoracic 20 % of the trunk inclination; neck counter-flexes 45 %
 * so the head stays roughly level.
 */
export function trunkLean(lean: number): Pick<BodyKey, 'tilt' | 'lumbar' | 'thoracic' | 'neck'> {
  return { tilt: 0.55 * lean, lumbar: [0.25 * lean, 0, 0], thoracic: [0.2 * lean, 0, 0], neck: [-0.45 * lean, 0, 0] };
}

export function armsBoth(shoulderFlexion: number, elbow: number, abduction = deg(8)): Record<Side, ArmPose> {
  return {
    left: { shoulder: [shoulderFlexion, abduction, 0], elbow },
    right: { shoulder: [shoulderFlexion, abduction, 0], elbow },
  };
}

export function pelvisRotation(rig: RigDefinition, rotation: number, tilt: number, obliquity: number): Quat {
  const m = getRigModel(rig);
  return composeJointRotation(m.joints[m.index.get('pelvis')!]!, [rotation, tilt, obliquity]);
}

/** Pelvis origin that puts the rig's seat site exactly on `target` for the given pelvis orientation. */
export function seatPlacedPelvis(rig: RigDefinition, target: Vec3, rot: Quat): Vec3 {
  const m = getRigModel(rig);
  const si = m.siteIndex.get(SEAT_SITE);
  if (si === undefined) throw new Error('rig has no seat site');
  return sub(target, quatRotateVec3(rot, m.siteOffset[si]!));
}

export function bilateralAnchors(stanceWidth: number, z: number, toeOut: number): Record<Side, FootAnchor> {
  return { left: { x: stanceWidth / 2, z, yaw: toeOut }, right: { x: -stanceWidth / 2, z, yaw: -toeOut } };
}

export function floorEnvironment(extra: Environment['objects'] = []): Environment {
  return { schema: SCHEMA.environment, units: 'm', objects: [{ kind: 'floor', id: 'floor' }, ...extra] };
}

export function standardStabilization(): StabilizationSpec {
  return { enabled: true, bounds: [0.02, 0.03, 0.02], notableOffset: 0.005, maxIterations: 30, tolerance: 1e-6, kneeFlexionFloor: deg(2), reachSoftZone: deg(4) };
}

/** Sequential phase builder. */
export class PhaseBuilder {
  phases: Phase[] = [];
  cues: Cue[] = [];
  t = 0;
  add(id: string, label: string, seconds: number, description: string, cue?: string): Phase {
    // Round to microseconds so accumulated float error does not leak into phase boundaries.
    const end = Math.round((this.t + seconds) * 1e6) / 1e6;
    const p: Phase = { id, label, start: this.t, end, description };
    this.phases.push(p);
    if (cue) this.cues.push({ id: `cue-${id}`, t: p.start, phaseId: id, label: cue });
    this.t = p.end;
    return p;
  }
}

export interface BuildOutput {
  plan: MotionPlan | null;
  diagnostics: Diagnostic[];
}

/** Standard compile pipeline shared by all recipes. */
export function compileWith(
  def: Pick<RecipeDefinition, 'id' | 'version' | 'paramSpecs' | 'requiredCapabilities'>,
  params: ParamRecord,
  rigInput: RigDefinition,
  build: (v: Values, rig: RigDefinition) => BuildOutput,
): CompileResult {
  const rv = validateRig(rigInput);
  if (!rv.rig) return { ok: false, plan: null, diagnostics: rv.diagnostics };
  const rig = rigInput;
  const missing = def.requiredCapabilities.filter((c) => !rig.capabilities.includes(c));
  if (missing.length)
    return {
      ok: false,
      plan: null,
      diagnostics: missing.map((c) =>
        diag('MISSING_CAPABILITY', 'error', `rig '${rig.id}' lacks capability '${c}' required by ${def.id}`, {
          subject: c,
          hint: 'Use the rig adapter capability report for the specific bones to add.',
        }),
      ),
    };
  const pv = validateParams(def.paramSpecs, params);
  if (hasErrors(pv.diagnostics)) return { ok: false, plan: null, diagnostics: pv.diagnostics };
  let built: BuildOutput;
  try {
    built = build(pv.values, rig);
  } catch (e) {
    return { ok: false, plan: null, diagnostics: [diag('UNSUPPORTED_CONFIGURATION', 'error', `recipe build failed: ${(e as Error).message}`)] };
  }
  const diagnostics = [...pv.diagnostics, ...built.diagnostics];
  if (!built.plan || hasErrors(diagnostics)) return { ok: false, plan: null, diagnostics };
  const plan = built.plan;
  plan.rig = { id: rig.id, fingerprint: rigFingerprint(rig) };
  plan.recipe = { id: def.id, version: def.version, params: { ...pv.values } };
  const pd = validatePlan(plan, rig);
  diagnostics.push(...pd);
  if (hasErrors(pd)) return { ok: false, plan: null, diagnostics };
  const scan = feasibilityScan(plan, rig);
  diagnostics.push(...scan);
  return { ok: true, plan, diagnostics, feasible: !hasErrors(scan) };
}

/**
 * Samples the plan at 30 Hz (plus the end) with the stabilised solver and summarises per-sample
 * errors into one diagnostic per (code, subject) with the time range and worst value.
 */
export function feasibilityScan(plan: MotionPlan, rig: RigDefinition, rate = 30): Diagnostic[] {
  const n = Math.ceil(plan.duration * rate);
  const groups = new Map<string, { d: Diagnostic; first: number; last: number; count: number; worst: number }>();
  for (let k = 0; k <= n; k++) {
    const t = Math.min(plan.duration, k / rate);
    const s = samplePose(plan, rig, t, 'stabilized');
    for (const d of s.diagnostics) {
      if (d.severity !== 'error') continue;
      const key = `${d.code}|${d.subject ?? ''}`;
      const g = groups.get(key);
      const v = d.value ?? 0;
      if (!g) groups.set(key, { d, first: t, last: t, count: 1, worst: v });
      else {
        g.last = t;
        g.count++;
        if (v > g.worst) {
          g.worst = v;
          g.d = d;
        }
      }
    }
  }
  return [...groups.values()].map((g) =>
    diag(g.d.code, 'error', `${g.d.message} (worst; ${g.count} of ${n + 1} scan samples, t=${g.first.toFixed(2)}–${g.last.toFixed(2)} s)`, {
      subject: g.d.subject,
      time: g.d.time,
      value: g.worst,
      limit: g.d.limit,
      hint: g.d.hint ?? 'The authored motion is not kinematically feasible for this rig and parameters.',
    }),
  );
}

export function basePlan(args: {
  duration: number;
  phases: Phase[];
  cues: Cue[];
  environment: Environment;
  pelvis: PelvisChannels;
  joints: MotionPlan['joints'];
  feet: MotionPlan['feet'];
  seat: MotionPlan['seat'];
  assumptions: string[];
}): MotionPlan {
  return {
    schema: SCHEMA.plan,
    reviewStatus: REVIEW_STATUS,
    recipe: { id: 'pending', version: '0', params: {} },
    rig: { id: 'pending', fingerprint: '' },
    environment: args.environment,
    duration: args.duration,
    phases: args.phases,
    cues: args.cues,
    pelvis: args.pelvis,
    joints: args.joints,
    feet: args.feet,
    seat: args.seat,
    stabilization: standardStabilization(),
    assumptions: args.assumptions,
  };
}

export function fmtDeg(r: number): string {
  return `${(r * RAD2DEG).toFixed(1)}°`;
}
