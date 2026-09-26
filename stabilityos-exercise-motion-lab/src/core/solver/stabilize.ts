import type { Side } from '../contracts/common.ts';
import type { StabilizationSpec } from '../contracts/plan.ts';
import type { Quat } from '../math/quat.ts';
import { add, type Vec3 } from '../math/vec3.ts';
import type { RigModel } from '../rig/model.ts';
import { ANGULAR_LEVER, solveLegChain, type LegChainSolution, type LegJointsIdx } from './legChain.ts';
import { reachForKneeFlexion } from './legIk.ts';
import type { FootTarget, StabilizationReport } from './types.ts';

export interface StabilizeInput {
  model: RigModel;
  legs: Record<Side, LegJointsIdx>;
  /** Pelvis position before correction (authored, or seat-derived while seated). */
  base: Vec3;
  pelvisRot: Quat;
  targets: Record<Side, FootTarget>;
  /** Seat contact weight: bounds shrink by (1 - w), so a seated pelvis cannot be moved. */
  seatWeight: number;
  /** Reach-constraint weight per leg (1 in contact; fades to 0 inside a swing). */
  swingWeight?: Record<'left' | 'right', number>;
  spec: StabilizationSpec;
}

/**
 * Constraint values g_j(Δ) (> 0 = violated), all in metres-equivalent, for each constrained leg:
 *   reach:   soft target on knee openness q = 1 − cos κ (see reachTargets), driven to equality
 *   fold:    d(κ_max) - |A - H|
 *   limits:  ANGULAR_LEVER · (θ - max) and ANGULAR_LEVER · (min - θ) for hip and ankle DOFs
 */
/** C1 soft floor: identity above lo + zone, exponential approach to lo below it. */
export function softFloor(x: number, lo: number, zone: number): number {
  if (zone <= 0) return Math.max(x, lo);
  const a = lo + zone;
  return x >= a ? x : lo + zone * Math.exp((x - a) / zone);
}

/** Knee openness q = 1 − cos κ = (R² − d²)/(2 L1 L2); smooth in d, negative beyond full reach. */
function openness(d: number, l1: number, l2: number): number {
  const R = l1 + l2;
  return (R * R - d * d) / (2 * l1 * l2);
}

interface ReachTarget {
  q: number;
  l1: number;
  l2: number;
}

/**
 * Per-leg soft reach targets from the authored (Δ = 0) pose. Contact legs: q_t = softFloor(q_raw).
 * Swing legs: the floor is relaxed by (1 − w) where w fades 1 → 0 over the first and last 20 % of
 * the swing, so a leg's constraint neither appears nor vanishes abruptly at lift-off or landing.
 */
/** Leg solutions at Δ = 0 for every leg the stabiliser constrains (computed once per sample, reused). */
export type BaseSolutions = Partial<Record<'left' | 'right', LegChainSolution>>;

function baseSolutions(inp: StabilizeInput): BaseSolutions {
  const out: BaseSolutions = {};
  for (const side of ['left', 'right'] as const) {
    const w = inp.swingWeight?.[side] ?? (inp.targets[side].mode === 'swing' ? 0 : 1);
    if (w > 0) out[side] = solveLegChain(inp.model, inp.legs[side], inp.base, inp.pelvisRot, inp.targets[side]);
  }
  return out;
}

function reachTargets(inp: StabilizeInput, base: BaseSolutions = baseSolutions(inp)): Record<'left' | 'right', ReachTarget | null> {
  const out: Record<'left' | 'right', ReachTarget | null> = { left: null, right: null };
  const qFloor = 1 - Math.cos(inp.spec.kneeFlexionFloor);
  const qZone = 1 - Math.cos(inp.spec.kneeFlexionFloor + inp.spec.reachSoftZone) - qFloor;
  for (const side of ['left', 'right'] as const) {
    const w = inp.swingWeight?.[side] ?? (inp.targets[side].mode === 'swing' ? 0 : 1);
    if (w <= 0) continue;
    const idx = inp.legs[side];
    const sol = base[side] ?? solveLegChain(inp.model, idx, inp.base, inp.pelvisRot, inp.targets[side]);
    const l1 = -inp.model.offset[idx.knee]![1];
    const l2 = -inp.model.offset[idx.ankle]![1];
    const floor = qFloor - (1 - w) * 2;
    out[side] = { q: softFloor(openness(sol.ik.distance, l1, l2), floor, qZone), l1, l2 };
  }
  return out;
}

export function constraintValues(inp: StabilizeInput, delta: Vec3, reach = reachTargets(inp), atBase?: BaseSolutions): number[] {
  const P = add(inp.base, delta);
  // At Δ = 0 the pose equals the base pose bit-for-bit, so precomputed base solutions are reused.
  const reuse = atBase !== undefined && delta[0] === 0 && delta[1] === 0 && delta[2] === 0;
  const out: number[] = [];
  for (const side of ['left', 'right'] as const) {
    const rt = reach[side];
    if (!rt) continue;
    const idx = inp.legs[side];
    const sol = (reuse ? atBase[side] : undefined) ?? solveLegChain(inp.model, idx, P, inp.pelvisRot, inp.targets[side]);
    const kneeDof = inp.model.joints[idx.knee]!.dofs[0]!;
    // Soft reach, in metres-equivalent (dd/dq ≈ L1 L2 / R): driven to equality, never clipped.
    out.push((rt.q - openness(sol.ik.distance, rt.l1, rt.l2)) * ((rt.l1 * rt.l2) / (rt.l1 + rt.l2)));
    out.push(reachForKneeFlexion(rt.l1, rt.l2, kneeDof.max) - sol.ik.distance);
    // Swing legs contribute reach only; their joint limits are handled by the swing soft limit.
    // Knee limits are not listed: reach (soft floor) and fold rows already bound knee flexion, and
    // the κ ≥ 0 row would be non-differentiable exactly at full extension.
    if (inp.targets[side].mode === 'swing') {
      out.push(-1, -1, -1, -1, -1, -1, -1, -1, -1, -1);
      continue;
    }
    for (const [jointIdx, angles] of [
      [idx.hip, sol.angles.hip],
      [idx.ankle, sol.angles.ankle],
    ] as const) {
      const j = inp.model.joints[jointIdx]!;
      for (let i = 0; i < j.dofs.length; i++) {
        const d = j.dofs[i]!;
        const a = angles[i] ?? 0;
        out.push(ANGULAR_LEVER * (a - d.max));
        out.push(ANGULAR_LEVER * (d.min - a));
      }
    }
  }
  return out;
}

function maxViolation(g: readonly number[]): number {
  let m = 0;
  for (const v of g) if (v > m) m = v;
  return m;
}

function sumViolation(g: readonly number[]): number {
  let s = 0;
  for (const v of g) if (v > 0) s += v;
  return s;
}

/** Solve the 3x3 system A x = b (Gaussian elimination with partial pivoting). */
function solve3(A: number[][], b: number[]): Vec3 {
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]!;
    if (Math.abs(piv) < 1e-300) continue;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / piv;
      for (let k = c; k < 4; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return [0, 1, 2].map((i) => (Math.abs(M[i]![i]!) < 1e-300 ? 0 : M[i]![3]! / M[i]![i]!)) as Vec3;
}

const MARGIN = 1e-5;
/** Constraints per leg: [reach, fold, ...limit pairs]. Reach is driven to equality (no margin). */
const isReach = (i: number, perLeg: number): boolean => i % perLeg === 0;

/**
 * Bounded pelvis stabiliser (tier 2).
 *
 * Minimum-norm damped Gauss–Newton on the ACTIVE constraints, starting from Δ = 0 every time
 * (no warm start → the result depends only on the sample time). Steps are projected onto the
 * author-declared box |Δ_i| ≤ bounds_i · (1 − seatWeight). Uses (JᵀJ + μI)⁻¹Jᵀ = Jᵀ(JJᵀ + μI)⁻¹,
 * so the 3×3 normal equations give the minimum-norm correction. Targets g_j ≤ −MARGIN so the
 * converged pose sits just inside the feasible set. Backtracking halves a step that does not
 * reduce total violation. Returns the best iterate and whether all constraints are satisfied.
 */
export function stabilizePelvis(inp: StabilizeInput): StabilizationReport {
  return stabilizePelvisWithBase(inp).report;
}

/** As stabilizePelvis, also returning the Δ = 0 leg solutions so callers can reuse them when Δ stays 0. */
export function stabilizePelvisWithBase(inp: StabilizeInput): { report: StabilizationReport; base: BaseSolutions } {
  const base = baseSolutions(inp);
  return { report: stabilizeCore(inp, base), base };
}

function stabilizeCore(inp: StabilizeInput, base: BaseSolutions): StabilizationReport {
  const b: Vec3 = [
    inp.spec.bounds[0] * (1 - inp.seatWeight),
    inp.spec.bounds[1] * (1 - inp.seatWeight),
    inp.spec.bounds[2] * (1 - inp.seatWeight),
  ];
  let delta: Vec3 = [0, 0, 0];
  const reach = reachTargets(inp, base);
  const cv = (d: Vec3) => constraintValues(inp, d, reach, base);
  let g = cv(delta);
  const legsConstrained = (['left', 'right'] as const).filter((s) => reach[s] !== null).length;
  const perLeg = legsConstrained > 0 ? g.length / legsConstrained : 1;
  const margin = (i: number) => (isReach(i, perLeg) ? 0 : MARGIN);
  const initialViolation = sumViolation(g);
  const tol = inp.spec.tolerance;
  // Activate and terminate at the SAME threshold: activating only above `tol` but solving down to
  // tol·1e-3 made the correction jump from 0 to its solved value at activation (a ~1e-6 m-equivalent
  // step, i.e. ~1e-4 rad of knee angle near full extension, where κ is hypersensitive to reach).
  const solveTarget = tol * 1e-3;
  if (maxViolation(g) <= solveTarget) {
    return { enabled: true, offset: delta, iterations: 0, converged: true, boundReached: false, initialViolation, finalViolation: initialViolation };
  }
  let iterations = 0;
  let boundReached = false;
  const h = 1e-6;
  const clampBox = (d: Vec3): Vec3 => [
    Math.max(-b[0], Math.min(b[0], d[0])),
    Math.max(-b[1], Math.min(b[1], d[1])),
    Math.max(-b[2], Math.min(b[2], d[2])),
  ];
  // Iterate well past the acceptance tolerance so the converged offset is a smooth function of t.
  for (; iterations < inp.spec.maxIterations; iterations++) {
    if (maxViolation(g) <= solveTarget) break;
    const active: number[] = [];
    g.forEach((v, i) => {
      if (v + margin(i) > 1e-15) active.push(i);
    });
    const r = active.map((i) => g[i]! + margin(i));
    // Central-difference Jacobian of active constraints (|active| x 3).
    const J: number[][] = active.map(() => [0, 0, 0]);
    for (let c = 0; c < 3; c++) {
      const dp: Vec3 = [...delta];
      const dm: Vec3 = [...delta];
      dp[c] = dp[c]! + h;
      dm[c] = dm[c]! - h;
      const gp = cv(dp);
      const gm = cv(dm);
      active.forEach((i, row) => {
        J[row]![c] = (gp[i]! - gm[i]!) / (2 * h);
      });
    }
    const JtJ = [0, 1, 2].map((a) => [0, 1, 2].map((c) => J.reduce((s, row) => s + row[a]! * row[c]!, 0)));
    const trace = JtJ[0]![0]! + JtJ[1]![1]! + JtJ[2]![2]!;
    const mu = 1e-9 * Math.max(trace, 1e-12);
    for (let a = 0; a < 3; a++) JtJ[a]![a]! += mu;
    const Jtr = [0, 1, 2].map((a) => J.reduce((s, row, k) => s + row[a]! * r[k]!, 0));
    const gnStep = solve3(JtJ, Jtr).map((v) => -v) as Vec3;
    // Fallback direction: steepest descent of ½|r|², scaled to the GN step length.
    const gnLen = Math.hypot(...gnStep);
    const gradLen = Math.hypot(...Jtr);
    const sdStep = (gradLen > 0 ? Jtr.map((v) => (-v / gradLen) * Math.max(gnLen, 1e-4)) : [0, 0, 0]) as Vec3;
    const before = sumViolation(g);
    let accepted = false;
    for (const step of [gnStep, sdStep]) {
      let scaleF = 1;
      for (let ls = 0; ls < 12 && !accepted; ls++) {
        const cand = clampBox([delta[0] + step[0] * scaleF, delta[1] + step[1] * scaleF, delta[2] + step[2] * scaleF]);
        const gc = cv(cand);
        if (sumViolation(gc) < before) {
          const moved = Math.hypot(cand[0] - delta[0], cand[1] - delta[1], cand[2] - delta[2]);
          delta = cand;
          g = gc;
          accepted = moved > 0;
        }
        scaleF *= 0.5;
      }
      if (accepted) break;
    }
    if (!accepted) break;
  }
  boundReached = [0, 1, 2].some((i) => b[i]! > 0 && Math.abs(delta[i]!) >= b[i]! - 1e-12);
  const finalViolation = sumViolation(g);
  return {
    enabled: true,
    offset: delta,
    iterations,
    converged: maxViolation(g) <= tol,
    boundReached,
    initialViolation,
    finalViolation,
  };
}
