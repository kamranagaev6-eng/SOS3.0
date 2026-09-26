import type { Side } from '../contracts/common.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { quatRotateVec3, type Quat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';
import { getRigModel } from '../rig/model.ts';
import { reachForKneeFlexion } from './legIk.ts';
import { legIndices, solveLegChain, type LegChainSolution } from './legChain.ts';
import type { FootTarget } from './types.ts';

/**
 * Compile-time key-pose solve (authoring aid, NOT runtime stabilisation): find the pelvis position
 * components `vars` so that named leg quantities hit authored targets, e.g. "mean knee flexion =
 * 70° and mean ankle dorsiflexion = 25°" for a squat bottom. Gauss–Newton with a finite-difference
 * Jacobian. The result becomes an explicit authored key in the plan; failure is a compile error.
 */
export type LegQuantity = 'kneeFlexion' | 'ankleDorsiflexion' | 'hipFlexion';
export interface KeyPoseGoal {
  quantity: LegQuantity;
  side: Side | 'mean';
  target: number;
}

function quantity(sol: Record<Side, LegChainSolution>, q: LegQuantity, side: Side | 'mean'): number {
  const one = (s: Side): number => {
    const l = sol[s];
    if (q === 'kneeFlexion') return l.ik.kneeFlexion;
    if (q === 'ankleDorsiflexion') return l.angles.ankle[0]!;
    return l.angles.hip[0]!;
  };
  return side === 'mean' ? (one('left') + one('right')) / 2 : one(side);
}

export function evaluateLegs(rig: RigDefinition, P: Vec3, pelvisRot: Quat, targets: Record<Side, FootTarget>): Record<Side, LegChainSolution> {
  const model = getRigModel(rig);
  return {
    left: solveLegChain(model, legIndices(model, 'left'), P, pelvisRot, targets.left),
    right: solveLegChain(model, legIndices(model, 'right'), P, pelvisRot, targets.right),
  };
}

export function solveKeyPose(
  rig: RigDefinition,
  pelvisRot: Quat,
  targets: Record<Side, FootTarget>,
  init: Vec3,
  vars: readonly (0 | 1 | 2)[],
  goals: readonly KeyPoseGoal[],
): { ok: boolean; P: Vec3; residual: number; iterations: number; reachable: boolean } {
  let P: Vec3 = [...init];
  if (vars.includes(1)) {
    // Start inside leg reach (≈ 34° knee flexion) so the knee angle has a usable gradient.
    const y = reachableHeight(rig, pelvisRot, targets, P[0], P[2]);
    if (Number.isFinite(y)) P[1] = y;
  }
  // Outside leg reach the knee angle saturates at 0 (zero gradient), so candidates that leave the
  // reachable set are rejected by returning an infinite residual.
  const resid = (p: Vec3): number[] => {
    const sol = evaluateLegs(rig, p, pelvisRot, targets);
    if (!sol.left.ik.reachable || !sol.right.ik.reachable) return goals.map(() => Infinity);
    return goals.map((g) => quantity(sol, g.quantity, g.side) - g.target);
  };
  let r = resid(P);
  let it = 0;
  const h = 1e-6;
  for (; it < 60; it++) {
    const norm = Math.max(...r.map(Math.abs));
    if (norm < 1e-10) break;
    const J = goals.map(() => vars.map(() => 0));
    vars.forEach((v, c) => {
      const pp: Vec3 = [...P];
      const pm: Vec3 = [...P];
      pp[v] = pp[v]! + h;
      pm[v] = pm[v]! - h;
      const rp = resid(pp);
      const rm = resid(pm);
      goals.forEach((_, row) => {
        J[row]![c] = (rp[row]! - rm[row]!) / (2 * h);
      });
    });
    // Normal equations (n ≤ 3) with light damping.
    const n = vars.length;
    const A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J.reduce((s, row) => s + row[a]! * row[b]!, 0) + (a === b ? 1e-12 : 0)));
    const g = Array.from({ length: n }, (_, a) => J.reduce((s, row, k) => s + row[a]! * r[k]!, 0));
    const raw = solveSmall(A, g).map((x) => -x);
    const len = Math.hypot(...raw);
    const step = len > 0.1 ? raw.map((x) => (x * 0.1) / len) : raw; // trust region: 10 cm per iteration
    let scale = 1;
    let improved = false;
    for (let ls = 0; ls < 20; ls++) {
      const cand: Vec3 = [...P];
      vars.forEach((v, c) => {
        cand[v] = cand[v]! + step[c]! * scale;
      });
      const rc = resid(cand);
      if (Math.max(...rc.map(Math.abs)) < norm) {
        P = cand;
        r = rc;
        improved = true;
        break;
      }
      scale *= 0.5;
    }
    if (!improved) break;
  }
  const sol = evaluateLegs(rig, P, pelvisRot, targets);
  const residual = Math.max(...r.map(Math.abs));
  return { ok: residual < 1e-6, P, residual, iterations: it, reachable: sol.left.ik.reachable && sol.right.ik.reachable };
}

function solveSmall(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const piv = M[c]![c]!;
    if (Math.abs(piv) < 1e-300) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / piv;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => (Math.abs(row[i]!) < 1e-300 ? 0 : row[n]! / row[i]!));
}

/**
 * Highest pelvis height at (px, pz) for which BOTH legs reach their targets with at least
 * `kneeFlexion` of knee flexion — a safe initial guess (inside reach, non-zero gradient).
 */
export function reachableHeight(rig: RigDefinition, pelvisRot: Quat, targets: Record<Side, FootTarget>, px: number, pz: number, kneeFlexion = 0.6): number {
  const model = getRigModel(rig);
  let y = Infinity;
  for (const side of ['left', 'right'] as const) {
    const idx = legIndices(model, side);
    const hipOff = quatRotateVec3(pelvisRot, model.offset[idx.hip]!);
    const l1 = -model.offset[idx.knee]![1];
    const l2 = -model.offset[idx.ankle]![1];
    const d = reachForKneeFlexion(l1, l2, kneeFlexion);
    const a = targets[side].anklePos;
    const dx = px + hipOff[0] - a[0];
    const dz = pz + hipOff[2] - a[2];
    const h2 = d * d - dx * dx - dz * dz;
    if (h2 <= 0) return NaN;
    y = Math.min(y, a[1] + Math.sqrt(h2) - hipOff[1]);
  }
  return y;
}
