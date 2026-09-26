import type { Side } from '../contracts/common.ts';
import type { StabilizationSpec } from '../contracts/plan.ts';
import type { Quat } from '../math/quat.ts';
import { add, type Vec3 } from '../math/vec3.ts';
import type { RigModel } from '../rig/model.ts';
import { ANGULAR_LEVER, solveLegChain, type LegJointsIdx } from './legChain.ts';
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
  spec: StabilizationSpec;
}

/**
 * Constraint values g_j(Δ) (> 0 = violated), all in metres-equivalent, for each leg in contact:
 *   reach:   |A - H| - d(κ_floor)      (leg must keep ≥ κ_floor knee flexion; avoids the straight-knee singularity)
 *   fold:    d(κ_max) - |A - H|
 *   limits:  ANGULAR_LEVER · (θ - max) and ANGULAR_LEVER · (min - θ) for hip, knee and ankle DOFs
 */
export function constraintValues(inp: StabilizeInput, delta: Vec3): number[] {
  const P = add(inp.base, delta);
  const out: number[] = [];
  for (const side of ['left', 'right'] as const) {
    // Only legs whose foot is in contact constrain the pelvis: a swing foot target is not a
    // contact, and its joint limits are handled by the swing soft limit instead.
    if (inp.targets[side].mode === 'swing') continue;
    const idx = inp.legs[side];
    const sol = solveLegChain(inp.model, idx, P, inp.pelvisRot, inp.targets[side]);
    const l1 = -inp.model.offset[idx.knee]![1];
    const l2 = -inp.model.offset[idx.ankle]![1];
    const kneeDof = inp.model.joints[idx.knee]!.dofs[0]!;
    out.push(sol.ik.distance - reachForKneeFlexion(l1, l2, inp.spec.kneeFlexionFloor));
    out.push(reachForKneeFlexion(l1, l2, kneeDof.max) - sol.ik.distance);
    for (const [jointIdx, angles] of [
      [idx.hip, sol.angles.hip],
      [idx.knee, [sol.ik.kneeFlexion]],
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
  const b: Vec3 = [
    inp.spec.bounds[0] * (1 - inp.seatWeight),
    inp.spec.bounds[1] * (1 - inp.seatWeight),
    inp.spec.bounds[2] * (1 - inp.seatWeight),
  ];
  let delta: Vec3 = [0, 0, 0];
  let g = constraintValues(inp, delta);
  const initialViolation = sumViolation(g);
  const tol = inp.spec.tolerance;
  if (maxViolation(g) <= tol) {
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
  for (; iterations < inp.spec.maxIterations; iterations++) {
    if (maxViolation(g) <= tol) break;
    const active: number[] = [];
    g.forEach((v, i) => {
      if (v + MARGIN > 0) active.push(i);
    });
    const r = active.map((i) => g[i]! + MARGIN);
    // Central-difference Jacobian of active constraints (|active| x 3).
    const J: number[][] = active.map(() => [0, 0, 0]);
    for (let c = 0; c < 3; c++) {
      const dp: Vec3 = [...delta];
      const dm: Vec3 = [...delta];
      dp[c] = dp[c]! + h;
      dm[c] = dm[c]! - h;
      const gp = constraintValues(inp, dp);
      const gm = constraintValues(inp, dm);
      active.forEach((i, row) => {
        J[row]![c] = (gp[i]! - gm[i]!) / (2 * h);
      });
    }
    const JtJ = [0, 1, 2].map((a) => [0, 1, 2].map((c) => J.reduce((s, row) => s + row[a]! * row[c]!, 0)));
    const trace = JtJ[0]![0]! + JtJ[1]![1]! + JtJ[2]![2]!;
    const mu = 1e-9 * Math.max(trace, 1e-12);
    for (let a = 0; a < 3; a++) JtJ[a]![a]! += mu;
    const Jtr = [0, 1, 2].map((a) => J.reduce((s, row, k) => s + row[a]! * r[k]!, 0));
    const step = solve3(JtJ, Jtr).map((v) => -v) as Vec3;
    const before = sumViolation(g);
    let accepted = false;
    let scaleF = 1;
    for (let ls = 0; ls < 8; ls++) {
      const cand = clampBox([delta[0] + step[0] * scaleF, delta[1] + step[1] * scaleF, delta[2] + step[2] * scaleF]);
      const gc = constraintValues(inp, cand);
      if (sumViolation(gc) < before) {
        const moved = Math.hypot(cand[0] - delta[0], cand[1] - delta[1], cand[2] - delta[2]);
        delta = cand;
        g = gc;
        accepted = moved > 0;
        break;
      }
      scaleF *= 0.5;
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
