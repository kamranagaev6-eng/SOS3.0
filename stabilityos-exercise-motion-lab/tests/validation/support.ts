/**
 * Shared helpers for the validation suite (tests/validation). Not a test file.
 *
 * Everything that serves as an ORACLE here (quaternion algebra, joint-angle composition, foot
 * geometry, surface heights, heel-lift curve evaluation, exact modular time reduction, mirror
 * maps) is implemented independently of the engine, from the documented contracts, so a test
 * does not pass merely because it agrees with the code it checks.
 *
 * Geometric checks of synthetic, unreviewed fixtures only. Passing them is NOT clinical validation.
 */
import { describe, expect, it } from 'vitest';
import type { CompileResult, PoseSample, RecipeDefinition, SolverTier } from '../../src/core/engine.ts';
import { analyzePlan, compileRecipe, getRecipe, samplePose, validatePlan } from '../../src/core/engine.ts';
import type { Environment } from '../../src/core/contracts/environment.ts';
import type { Track } from '../../src/core/contracts/plan.ts';
import type { ParamRecord } from '../../src/core/contracts/recipe.ts';
import type { RigDefinition } from '../../src/core/contracts/rig.ts';
import { createRng } from '../../src/core/math/rng.ts';
import { rigVariants } from '../../scripts/sweep.ts';

export type V3 = [number, number, number];
export type Q = [number, number, number, number];

export const TIERS: readonly SolverTier[] = ['baseline', 'analytic', 'stabilized'];
export const SOLVED_TIERS: readonly SolverTier[] = ['analytic', 'stabilized'];

// ---------------------------------------------------------------------------------------------
// Independent vector / quaternion algebra ([x, y, z, w], Hamilton product).
// ---------------------------------------------------------------------------------------------

export const vsub = (a: readonly number[], b: readonly number[]): V3 => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
export const vadd = (a: readonly number[], b: readonly number[]): V3 => [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
export const vscale = (a: readonly number[], s: number): V3 => [a[0]! * s, a[1]! * s, a[2]! * s];
export const vdot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const vlen = (a: readonly number[]): number => Math.sqrt(vdot(a, a));
export const vdist = (a: readonly number[], b: readonly number[]): number => vlen(vsub(a, b));
export const vnorm = (a: readonly number[]): V3 => vscale(a, 1 / vlen(a));
export const vreject = (a: readonly number[], unit: readonly number[]): V3 => vsub(a, vscale(unit, vdot(a, unit)));

export function qmul(a: readonly number[], b: readonly number[]): Q {
  const [ax, ay, az, aw] = a as Q;
  const [bx, by, bz, bw] = b as Q;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function qaxis(axis: 0 | 1 | 2, angle: number): Q {
  const s = Math.sin(angle / 2);
  const q: Q = [0, 0, 0, Math.cos(angle / 2)];
  q[axis] = s;
  return q;
}

/** Rotation matrix (row-major 3×3) of a unit quaternion. */
export function qmat(q: readonly number[]): number[] {
  const [x, y, z, w] = q as Q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

export function qrot(q: readonly number[], v: readonly number[]): V3 {
  const m = qmat(q);
  return [m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!, m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!, m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!];
}

/** Geodesic angle between two rotations (sign-invariant, accurate for tiny angles). */
export function qangle(a: readonly number[], b: readonly number[]): number {
  const conj: Q = [-a[0]!, -a[1]!, -a[2]!, a[3]!];
  const d = qmul(conj, b);
  return 2 * Math.atan2(Math.hypot(d[0], d[1], d[2]), Math.abs(d[3]));
}

/** M R M with M = diag(-1, 1, 1): the mirror image of a rotation across the sagittal (YZ) plane. */
export function mirrorMat(m: readonly number[]): number[] {
  const s = [-1, 1, 1];
  return m.map((v, i) => v * s[Math.floor(i / 3)]! * s[i % 3]!);
}

export const maxAbsDiff = (a: readonly number[], b: readonly number[]): number => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!));
  return m;
};

// ---------------------------------------------------------------------------------------------
// Rig-level independent helpers.
// ---------------------------------------------------------------------------------------------

export function jointIdx(rig: RigDefinition, name: string): number {
  const i = rig.joints.findIndex((j) => j.name === name);
  if (i < 0) throw new Error(`test setup: rig ${rig.id} has no joint ${name}`);
  return i;
}

export function siteIdx(rig: RigDefinition, name: string): number {
  const i = rig.sites.findIndex((s) => s.name === name);
  if (i < 0) throw new Error(`test setup: rig ${rig.id} has no site ${name}`);
  return i;
}

/** Joint rotation from DOF angles, per the rig contract: q = Π R(sign_i · axis_i, θ_i) in DOF order. */
export function composeFromContract(rig: RigDefinition, j: number, angles: readonly number[]): Q {
  let q: Q = [0, 0, 0, 1];
  rig.joints[j]!.dofs.forEach((d, i) => {
    q = qmul(q, qaxis(d.axis, d.sign * (angles[i] ?? 0)));
  });
  return q;
}

export const swapSide = (name: string): string =>
  name.endsWith('_L') ? `${name.slice(0, -2)}_R` : name.endsWith('_R') ? `${name.slice(0, -2)}_L` : name;

/**
 * Independent rigidity + joint-limit check of one sample.
 *  - every parent→child link (except the pelvis translation DOF) and joint→site link keeps its rest length (rel. ≤ tol);
 *  - reported DOF angles lie within limits ± jointLimit, and composing them per the contract reproduces `local`.
 * Returns human-readable problems (empty = pass).
 */
const rigIndexCache = new WeakMap<RigDefinition, { parent: number[]; siteJoint: number[] }>();
function rigIndex(rig: RigDefinition): { parent: number[]; siteJoint: number[] } {
  let hit = rigIndexCache.get(rig);
  if (!hit) {
    hit = {
      parent: rig.joints.map((jt) => (jt.parent === null ? -1 : rig.joints.findIndex((x) => x.name === jt.parent))),
      siteJoint: rig.sites.map((st) => jointIdx(rig, st.joint)),
    };
    rigIndexCache.set(rig, hit);
  }
  return hit;
}

export function rigidityAndLimitProblems(rig: RigDefinition, s: PoseSample, boneRelTol: number, limitTol: number): string[] {
  const out: string[] = [];
  const ix = rigIndex(rig);
  rig.joints.forEach((jt, j) => {
    if (jt.parent !== null && jt.kind !== 'pelvis') {
      const p = ix.parent[j]!;
      const rest = vlen(jt.offset);
      if (rest > 0) {
        const rel = Math.abs(vdist(s.worldPos[j]!, s.worldPos[p]!) - rest) / rest;
        if (!(rel <= boneRelTol)) out.push(`t=${s.t} ${s.tier}: link ${jt.parent}->${jt.name} rel length error ${rel.toExponential(2)}`);
      }
    }
    const a = s.angles[j]!;
    jt.dofs.forEach((d, i) => {
      const v = a[i]!;
      if (!(v >= d.min - limitTol && v <= d.max + limitTol))
        out.push(`t=${s.t} ${s.tier}: ${jt.name}.${d.name} = ${v} outside [${d.min}, ${d.max}]`);
    });
    const recomposed = composeFromContract(rig, j, a);
    const err = qangle(recomposed, s.local[j]!);
    if (!(err <= 1e-9)) out.push(`t=${s.t} ${s.tier}: ${jt.name} local rotation differs from its DOF angles by ${err.toExponential(2)} rad`);
  });
  rig.sites.forEach((st, i) => {
    const rest = vlen(st.offset);
    if (rest === 0) return;
    const j = ix.siteJoint[i]!;
    const rel = Math.abs(vdist(s.sitePos[i]!, s.worldPos[j]!) - rest) / rest;
    if (!(rel <= boneRelTol)) out.push(`t=${s.t} ${s.tier}: site ${st.name} rel distance error ${rel.toExponential(2)}`);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Environment / plan helpers computed from the raw documents (not via engine lookups).
// ---------------------------------------------------------------------------------------------

/** Height of a support surface from the environment objects: floor → 0, `<chair>.seat` → seatHeight, `<step>.top` → height. */
export function surfaceHeight(env: Environment, id: string): number {
  for (const o of env.objects) {
    if (o.kind === 'floor' && o.id === id) return 0;
    if (o.kind === 'chair' && `${o.id}.seat` === id) return o.seatHeight;
    if (o.kind === 'step' && `${o.id}.top` === id) return o.height;
  }
  throw new Error(`test setup: unknown surface ${id}`);
}

/** Active foot state at t, per the documented half-open convention [start, end) with the last state closed. */
export function activeStateIndex(states: readonly { start: number; end: number }[], t: number): number {
  for (let i = 0; i < states.length; i++) if (t < states[i]!.end) return i;
  return states.length - 1;
}

/**
 * Independent evaluation of a track made only of 'stop' keys (zero tangents): cubic Hermite with
 * m0 = m1 = 0, i.e. v0 + (v1 − v0)(3s² − 2s³). Holds end values outside the key range.
 */
export function evalStopTrack(tr: Track, t: number): number {
  const k = tr.keys;
  if (k.some((x) => x.mode !== 'stop')) throw new Error('test oracle only supports stop keys');
  if (t <= k[0]!.t) return k[0]!.v;
  if (t >= k[k.length - 1]!.t) return k[k.length - 1]!.v;
  let i = 0;
  while (k[i + 1]!.t <= t) i++;
  const a = k[i]!;
  const b = k[i + 1]!;
  const s = (t - a.t) / (b.t - a.t);
  return a.v + (b.v - a.v) * (3 * s * s - 2 * s * s * s);
}

/**
 * Expected world positions of the heel / ball / toe contact points of a FLAT foot, from the anchor
 * (ankle ground projection + heading) and rig proportions: heel = anchor − heelBack·f,
 * ball = anchor + footLength·f, toe = anchor + (footLength + toeLength)·f, all at surface height,
 * with f = (sin yaw, 0, cos yaw) (+yaw turns the toes toward +X).
 */
export function flatFootSites(rig: RigDefinition, side: 'left' | 'right', anchor: { x: number; z: number; yaw: number }, y: number): Record<'heel' | 'ball' | 'toe', V3> {
  const L = rig.proportions[side].leg;
  const f: V3 = [Math.sin(anchor.yaw), 0, Math.cos(anchor.yaw)];
  const at = (d: number): V3 => [anchor.x + f[0] * d, y, anchor.z + f[2] * d];
  return { heel: at(-L.heelBack), ball: at(L.footLength), toe: at(L.footLength + L.toeLength) };
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/**
 * First bit-level difference between two values (numbers compared with Object.is, so +0/−0 differ),
 * or null when identical. Recurses through arrays and plain objects (keys sorted).
 */
export function firstBitDiff(a: unknown, b: unknown, path = '$'): string | null {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
  if (a === b) return null;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return `${path}: array shape differs`;
    for (let i = 0; i < a.length; i++) {
      const d = firstBitDiff(a[i], b[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.join('|') !== kb.join('|')) return `${path}: keys differ (${ka.join(',')} vs ${kb.join(',')})`;
    for (const k of ka) {
      const d = firstBitDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return `${path}: ${String(a)} vs ${String(b)}`;
}

/** The kinematic content of a pose sample (what a renderer or exporter consumes). */
export function poseCore(s: PoseSample): Record<string, unknown> {
  return {
    worldPos: s.worldPos,
    worldRot: s.worldRot,
    local: s.local,
    angles: s.angles,
    sitePos: s.sitePos,
    rootTranslation: s.rootTranslation,
    pelvisOffset: s.pelvisOffset,
    pelvisWorld: s.pelvisWorld,
    stabilizationOffset: s.stabilization.offset,
  };
}

// ---------------------------------------------------------------------------------------------
// Exact modular time reduction (BigInt rationals) for long-playback checks.
// ---------------------------------------------------------------------------------------------

/** Exact dyadic representation of a finite double: value = m · 2^e with integer m. */
function dyadic(x: number): { m: bigint; e: number } {
  if (!Number.isFinite(x)) throw new RangeError('finite only');
  if (x === 0) return { m: 0n, e: 0 };
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0);
  const sign = bits >> 63n ? -1n : 1n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  const m = expBits === 0 ? frac : frac | (1n << 52n);
  const e = (expBits === 0 ? 1 : expBits) - 1075;
  return { m: sign * m, e };
}

/** (a · b) mod d computed exactly on the doubles' true values, then rounded once to a double. */
export function exactProductMod(a: number, b: number, d: number): number {
  const A = dyadic(a);
  const B = dyadic(b);
  const D = dyadic(d);
  const pe = A.e + B.e;
  const E = Math.min(pe, D.e);
  const P = (A.m * B.m) << BigInt(pe - E);
  const M = D.m << BigInt(D.e - E);
  const r = ((P % M) + M) % M;
  // r · 2^E: convert with a single rounding (Number(bigint) rounds to nearest), E ≤ 0 here.
  return Number(r) * 2 ** E;
}

// ---------------------------------------------------------------------------------------------
// Rig variants (from scripts/sweep.ts) and the host-derived rig B.
// ---------------------------------------------------------------------------------------------

export interface NamedRig {
  id: string;
  rig: RigDefinition;
}

const REQUIRED_VARIANTS = ['synthetic-rig-a', 'rig-a-short-legs', 'rig-a-long-legs', 'rig-a-long-trunk', 'rig-a-big-feet', 'rig-a-small', 'rig-a-lld'];

/** Canonical rig variants from scripts/sweep.ts (the host-derived rig is loaded separately). */
export function canonicalVariants(): NamedRig[] {
  const all = rigVariants();
  return REQUIRED_VARIANTS.map((id) => {
    const v = all.find((x) => x.id === id);
    if (!v) throw new Error(`scripts/sweep.ts no longer provides rig variant ${id}`);
    return { id: v.id, rig: v.rig };
  });
}

/**
 * Rig B: canonical rig derived by the host-rig adapter from the synthetic host skeleton (cm, Z-up,
 * T-pose). Returns null (with a note that callers log) when the adapter module is missing or the
 * adapter refuses the skeleton.
 */
export async function loadRigB(): Promise<{ rig: NamedRig | null; note: string }> {
  try {
    const mod = await import('../../src/core/adapter/index.ts');
    const h = mod.getSyntheticHostRig('synthetic-rig-b-host');
    if (!h) return { rig: null, note: 'rig B skipped: synthetic host skeleton "synthetic-rig-b-host" not found' };
    const r = mod.createHostRigAdapter(h.host, h.boneMap);
    if (!r.ok)
      return { rig: null, note: `rig B skipped: adapter rejected the host skeleton: ${r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code).join(', ')}` };
    return { rig: { id: r.adapter.canonical.id, rig: r.adapter.canonical }, note: `rig B = ${r.adapter.canonical.id} (host-derived via createHostRigAdapter)` };
  } catch (e) {
    return { rig: null, note: `rig B skipped: adapter module unavailable (${(e as Error).message})` };
  }
}

// ---------------------------------------------------------------------------------------------
// Parameter configurations.
// ---------------------------------------------------------------------------------------------

export interface Config {
  name: string;
  params: ParamRecord;
}

/**
 * Defaults; every combination of enum parameters (e.g. both leading sides of the step-up);
 * single-parameter min and max corners for every numeric parameter (timing-only parameters —
 * unit 's' or 'count' — can be excluded, see defineRecipeSweep); two seeded random sets snapped to
 * the parameter steps (these always vary every parameter, timing included).
 */
export function sweepConfigs(recipe: RecipeDefinition, opts: { timingCorners?: boolean; randomCount?: number; seed?: number } = {}): Config[] {
  const { timingCorners = true, randomCount = 2, seed = 0x5eed2026 } = opts;
  const d = recipe.defaults();
  const out: Config[] = [{ name: 'defaults', params: { ...d } }];
  let combos: ParamRecord[] = [{}];
  for (const s of recipe.paramSpecs) if (s.kind === 'enum') combos = combos.flatMap((c) => s.options.map((o) => ({ ...c, [s.key]: o })));
  if (combos.length > 1)
    for (const c of combos) out.push({ name: Object.entries(c).map(([k, v]) => `${k}=${String(v)}`).join(','), params: { ...d, ...c } });
  for (const s of recipe.paramSpecs) {
    if (s.kind !== 'number') continue;
    if (!timingCorners && (s.unit === 's' || s.unit === 'count')) continue;
    out.push({ name: `${s.key}=min(${s.min})`, params: { ...d, [s.key]: s.min } });
    out.push({ name: `${s.key}=max(${s.max})`, params: { ...d, [s.key]: s.max } });
  }
  const rng = createRng(seed ^ (recipe.id.length * 7919));
  for (let i = 0; i < randomCount; i++) {
    const p: ParamRecord = {};
    for (const s of recipe.paramSpecs) {
      if (s.kind === 'enum') p[s.key] = rng.pick(s.options);
      else {
        const raw = rng.range(s.min, s.max);
        const snapped = s.unit === 'count' ? Math.round(raw) : Math.round((raw - s.min) / s.step) * s.step + s.min;
        p[s.key] = Math.min(s.max, Math.max(s.min, Number(snapped.toFixed(6))));
      }
    }
    out.push({ name: `random#${i}(${Object.values(p).join(',')})`, params: p });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Recipe sweep (shared by the recipes.sweep.*.test.ts files).
// ---------------------------------------------------------------------------------------------

const errorsOf = <D extends { severity: string }>(r: { diagnostics: D[] }): D[] => r.diagnostics.filter((d) => d.severity === 'error');

/** Rigidity / limit spot check rate (Hz) for every tier of every compiled plan. */
const RIGIDITY_RATE = 20;

export function checkSweepConfig(recipeId: string, rig: RigDefinition, params: ParamRecord, tol: { boneLengthRel: number; jointLimit: number }): void {
  let res: CompileResult | undefined;
  let thrown: unknown;
  try {
    res = compileRecipe(recipeId, params, rig);
  } catch (e) {
    thrown = e;
  }
  // (a) compile never throws
  expect(thrown, `compileRecipe threw: ${String(thrown)}`).toBeUndefined();
  if (!res) return;
  const errors = errorsOf(res);
  if (!res.ok) {
    // (b) rejected ⇒ at least one error diagnostic with an actionable message
    expect(errors.length, 'rejected without an error diagnostic').toBeGreaterThan(0);
    for (const d of errors) expect(d.message.trim().length, `empty message for ${d.code}`).toBeGreaterThan(10);
    expect(
      errors.some((d) => (d.hint ?? '').trim().length > 0 || (d.path ?? '').trim().length > 0),
      `no error carries a hint or a path: ${errors.map((d) => `${d.code}: ${d.message}`).join(' | ')}`,
    ).toBe(true);
    return;
  }
  const plan = res.plan;
  // (e) every compiled plan validates against its rig
  const vp = errorsOf({ diagnostics: validatePlan(plan, rig) });
  expect(vp.map((d) => `${d.code} ${d.path ?? ''}: ${d.message}`)).toEqual([]);
  // (f) rigidity and joint limits hold in every tier, feasible or not
  const problems: string[] = [];
  const n = Math.ceil(plan.duration * RIGIDITY_RATE);
  for (const tier of TIERS)
    for (let k = 0; k <= n && problems.length < 5; k++)
      problems.push(...rigidityAndLimitProblems(rig, samplePose(plan, rig, Math.min(plan.duration, k / RIGIDITY_RATE), tier), tol.boneLengthRel, tol.jointLimit));
  expect(problems.slice(0, 5)).toEqual([]);
  const m = analyzePlan(plan, rig, 'stabilized');
  if (res.feasible) {
    // (c) feasible ⇒ within every tolerance at 240 Hz. No silent failures.
    expect(m.failures, `compile scan said feasible, clip metrics disagree`).toEqual([]);
    expect(m.withinTolerance).toBe(true);
  } else {
    // (d) infeasible ⇒ explicit, time-stamped error diagnostics, confirmed by the clip metrics
    expect(errors.length, 'infeasible plan without error diagnostics').toBeGreaterThan(0);
    for (const d of errors) {
      expect(d.message.trim().length).toBeGreaterThan(10);
      expect(Number.isFinite(d.time ?? NaN), `${d.code} has no time`).toBe(true);
    }
    expect(m.withinTolerance, `compile said infeasible (${errors.map((d) => d.code).join(',')}) but 240 Hz clip metrics pass`).toBe(false);
  }
}

/**
 * Rig groups for splitting a recipe sweep across two test files (vitest runs files in parallel):
 * group 1 = rig A + short legs + long legs + long trunk; group 2 = big feet + small + left leg
 * +10 mm + host-derived rig B (when the adapter provides it).
 */
const RIG_GROUPS: Record<1 | 2, readonly string[]> = {
  1: ['synthetic-rig-a', 'rig-a-short-legs', 'rig-a-long-legs', 'rig-a-long-trunk'],
  2: ['rig-a-big-feet', 'rig-a-small', 'rig-a-lld', 'rig-b'],
};

export async function defineRecipeSweep(recipeId: string, tol: { boneLengthRel: number; jointLimit: number }, group: 1 | 2): Promise<void> {
  const recipe = getRecipe(recipeId);
  if (!recipe) throw new Error(`recipe ${recipeId} missing from the registry`);
  const wanted = RIG_GROUPS[group];
  const rigs = canonicalVariants().filter((r) => wanted.includes(r.id));
  if (wanted.includes('rig-b')) {
    const b = await loadRigB();
    console.info(`[${recipeId} sweep] ${b.note}`);
    if (b.rig) rigs.push(b.rig);
  }
  // Timing-only corners (durations, repetition counts) rescale time without changing geometry and
  // give the longest clips: they run on the two acceptance rigs (A and host-derived B); every
  // geometric corner and both random sets run on every rig variant.
  const timingRigs = new Set(['synthetic-rig-a', ...(rigs.some((r) => !REQUIRED_VARIANTS.includes(r.id)) ? [rigs.at(-1)!.id] : [])]);
  const full = sweepConfigs(recipe, { timingCorners: true });
  const geometric = sweepConfigs(recipe, { timingCorners: false });
  const configsFor = (rigId: string) => (timingRigs.has(rigId) ? full : geometric);
  const configs = full;
  describe(`${recipeId} (rig group ${group}): rig variants × parameter configurations (compile → validate → 240 Hz metrics)`, () => {
    it(`covers the group's rig variants from scripts/sweep.ts${group === 2 ? ' and (when available) host-derived rig B' : ''}, and every parameter corner`, () => {
      expect(rigs.map((r) => r.id)).toEqual(expect.arrayContaining(wanted.filter((id) => id !== 'rig-b')));
      expect(configs.length).toBeGreaterThanOrEqual(1 + 2 * recipe.paramSpecs.filter((s) => s.kind === 'number').length + 2);
    });
    for (const rv of rigs)
      describe(rv.id, () => {
        for (const cfg of configsFor(rv.id)) it(cfg.name, () => checkSweepConfig(recipeId, rv.rig, cfg.params, tol));
      });
  });
}
