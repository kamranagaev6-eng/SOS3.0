import { formatZodIssues, SIDES, type Side } from '../contracts/common.ts';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import { planSchema, type FootState, type MotionPlan } from '../contracts/plan.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { findSurface, insideBounds, penetrationDepth, solids, validateEnvironment } from '../environment/surfaces.ts';
import { footSites } from '../rig/canonical.ts';
import { getRigModel, rigFingerprint } from '../rig/model.ts';
import { contactPose, footGeom, footTargetAt, siteUnderTarget } from '../solver/footPose.ts';
import { TOLERANCES } from '../tolerances.ts';
import { evalTrack, validateTrackKeys } from './tracks.ts';

const EPS = 1e-9;
/** Upper bound on author-declared stabilisation: larger corrections could change the exercise itself. */
export const MAX_STABILIZATION_BOUND = 0.05;

/**
 * Validates a plan against its rig: schema, geometry, phases, cues, tracks, foot-state coverage,
 * contact consistency (contradictions), support-surface coverage and swing clearance.
 * Everything reported, nothing repaired.
 */
export function validatePlan(input: unknown, rig: RigDefinition): Diagnostic[] {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) return formatZodIssues(parsed.error).map((m) => diag('SCHEMA_INVALID', 'error', `plan ${m}`));
  const plan = parsed.data;
  const out: Diagnostic[] = [];
  out.push(...validateEnvironment(plan.environment).diagnostics);
  if (plan.rig.fingerprint !== rigFingerprint(rig))
    out.push(
      diag('RIG_INVALID', 'error', `plan was compiled for rig '${plan.rig.id}' (${plan.rig.fingerprint}), not '${rig.id}' (${rigFingerprint(rig)})`, {
        hint: 'Recompile the recipe for this rig: plans hold rig-specific absolute positions.',
      }),
    );

  // Phases: contiguous cover of [0, duration].
  let cursor = 0;
  const phaseIds = new Set<string>();
  plan.phases.forEach((p, i) => {
    if (phaseIds.has(p.id)) out.push(diag('PHASE_INVALID', 'error', `duplicate phase id '${p.id}'`, { path: `phases.${i}` }));
    phaseIds.add(p.id);
    if (Math.abs(p.start - cursor) > EPS) out.push(diag('PHASE_INVALID', 'error', `phase '${p.id}' starts at ${p.start}, expected ${cursor}`, { path: `phases.${i}` }));
    if (!(p.end > p.start)) out.push(diag('PHASE_INVALID', 'error', `phase '${p.id}' has non-positive length`, { path: `phases.${i}` }));
    cursor = p.end;
  });
  if (Math.abs(cursor - plan.duration) > EPS) out.push(diag('PHASE_INVALID', 'error', `phases end at ${cursor}, duration is ${plan.duration}`));

  plan.cues.forEach((c, i) => {
    const ph = plan.phases.find((p) => p.id === c.phaseId);
    if (!ph) out.push(diag('CUE_INVALID', 'error', `cue '${c.id}' references unknown phase '${c.phaseId}'`, { path: `cues.${i}` }));
    else if (c.t < ph.start - EPS || c.t > ph.end + EPS)
      out.push(diag('CUE_INVALID', 'error', `cue '${c.id}' at ${c.t}s lies outside phase '${c.phaseId}'`, { path: `cues.${i}` }));
  });

  const trackEntries: [string, { keys: { t: number; v: number; mode: 'stop' | 'flow' }[] }][] = [
    ...Object.entries(plan.pelvis).map(([k, tr]) => [`pelvis.${k}`, tr] as [string, typeof tr]),
    ...Object.entries(plan.joints).flatMap(([j, dofs]) => Object.entries(dofs).map(([d, tr]) => [`joints.${j}.${d}`, tr] as [string, typeof tr])),
  ];
  for (const [path, tr] of trackEntries) {
    const e = validateTrackKeys(tr, plan.duration);
    if (e) out.push(diag('SCHEMA_INVALID', 'error', `${path}: ${e}`, { path }));
  }
  const model = getRigModel(rig);
  for (const j of Object.keys(plan.joints))
    if (!model.index.has(j)) out.push(diag('MISSING_BONE', 'error', `plan animates joint '${j}' missing from rig '${rig.id}'`, { path: `joints.${j}` }));

  const b = plan.stabilization.bounds;
  if (b.some((v) => v < 0 || v > MAX_STABILIZATION_BOUND))
    out.push(
      diag('UNSUPPORTED_CONFIGURATION', 'error', `stabilisation bounds must lie in [0, ${MAX_STABILIZATION_BOUND}] m per axis`, {
        path: 'stabilization.bounds',
        hint: 'Larger corrections would let numerical stabilisation change the authored exercise.',
      }),
    );

  for (const side of SIDES) out.push(...validateFootStates(plan, rig, side));
  if (!out.some((d) => d.severity === 'error')) {
    out.push(...validateFootOverlap(plan, rig));
    out.push(...validateSwingClearance(plan, rig));
  }
  out.push(...validateSeat(plan));
  return out;
}

function validateFootStates(plan: MotionPlan, rig: RigDefinition, side: Side): Diagnostic[] {
  const out: Diagnostic[] = [];
  const states = plan.feet[side];
  const g = footGeom(rig, side);
  let cursor = 0;
  states.forEach((s, i) => {
    const path = `feet.${side}.${i}`;
    if (Math.abs(s.start - cursor) > EPS)
      out.push(
        diag('CONTRADICTORY_CONTACTS', 'error', `${side} foot state ${i} starts at ${s.start}s but the previous one ends at ${cursor}s (gap or overlap)`, { path }),
      );
    if (!(s.end > s.start)) out.push(diag('CONTRADICTORY_CONTACTS', 'error', `${side} foot state ${i} has non-positive duration`, { path }));
    cursor = s.end;
    if (s.kind === 'swing') {
      const prev = states[i - 1];
      const next = states[i + 1];
      if (!prev || !next || prev.kind === 'swing' || next.kind === 'swing')
        out.push(diag('CONTRADICTORY_CONTACTS', 'error', `${side} swing state ${i} must be between two contact states`, { path }));
      if (s.riseEnd > s.descendStart) out.push(diag('SCHEMA_INVALID', 'error', `${side} swing ${i}: riseEnd must be <= descendStart`, { path }));
      return;
    }
    const surf = findSurface(plan.environment, s.surface);
    if (!surf) {
      out.push(diag('INVALID_GEOMETRY', 'error', `${side} foot state ${i} references unknown surface '${s.surface}'`, { path }));
      return;
    }
    if (s.kind === 'forefoot') {
      const e = validateTrackKeys(s.heelLift, plan.duration);
      if (e) out.push(diag('SCHEMA_INVALID', 'error', `${path}.heelLift: ${e}`, { path }));
      if (s.heelLift.keys.some((k) => k.v < 0 || k.v > 0.2))
        out.push(diag('UNSUPPORTED_CONFIGURATION', 'error', `${side} heel lift must stay within [0, 0.2] m`, { path }));
    }
    // Whole sole must be supported by the surface (no hanging off a step edge).
    const pose = contactPose(plan.environment, side, s, s.start, g);
    const fs = footSites(side);
    const sites = rig.sites.filter((x) => [fs.heel, fs.toe, fs.heelMedial, fs.heelLateral, fs.ballMedial, fs.ballLateral].includes(x.name as never));
    for (const site of sites) {
      const seg = site.joint.startsWith('mtp') ? 'toes' : 'foot';
      const flat = contactPose(plan.environment, side, { ...s, kind: 'flat' } as FootState, s.start, g);
      const p = siteUnderTarget(seg === 'toes' || s.kind === 'flat' ? flat : pose, g, seg, [...site.offset]);
      if (!insideBounds({ x: p[0], z: p[2] }, surf.bounds, 0.002))
        out.push(
          diag('CONTACT_OFF_SURFACE', 'error', `${side} ${site.name} would be off surface '${s.surface}' (x=${p[0].toFixed(3)}, z=${p[2].toFixed(3)})`, {
            path,
            subject: site.name,
            hint: 'Move the foot anchor or enlarge the support surface.',
          }),
        );
    }
    // A forefoot state must pivot about the same planted forefoot as an adjacent flat state.
    const prev = states[i - 1];
    if (prev && prev.kind !== 'swing') {
      const same = prev.surface === s.surface && prev.anchor.x === s.anchor.x && prev.anchor.z === s.anchor.z && prev.anchor.yaw === s.anchor.yaw;
      if (!same)
        out.push(
          diag('CONTRADICTORY_CONTACTS', 'error', `${side} foot jumps between planted positions at t=${s.start}s without a swing`, {
            path,
            hint: 'Insert a swing state between contacts at different locations.',
          }),
        );
      // Evaluate the heel-lift CURVE at the boundary (not a key value): the heel must be down exactly
      // where a flat contact begins or ends, otherwise the heel would jump.
      if (prev.kind === 'forefoot' && s.kind === 'flat') {
        const lift = evalTrack(prev.heelLift, s.start);
        if (Math.abs(lift) > 1e-9)
          out.push(diag('CONTRADICTORY_CONTACTS', 'error', `${side} heel is ${lift.toFixed(4)} m up when a flat contact begins at ${s.start}s`, { path }));
      }
      if (prev.kind === 'flat' && s.kind === 'forefoot') {
        const lift = evalTrack(s.heelLift, s.start);
        if (Math.abs(lift) > 1e-9)
          out.push(diag('CONTRADICTORY_CONTACTS', 'error', `${side} heel must start at 0 lift when leaving a flat contact (t=${s.start}s; lift ${lift.toFixed(4)} m)`, { path }));
      }
    }
  });
  if (Math.abs(cursor - plan.duration) > EPS)
    out.push(diag('CONTRADICTORY_CONTACTS', 'error', `${side} foot states end at ${cursor}s, duration is ${plan.duration}s`));
  return out;
}

/** Sole rectangle overlap between left and right feet at sampled times (separating-axis test). */
function validateFootOverlap(plan: MotionPlan, rig: RigDefinition): Diagnostic[] {
  const N = Math.max(20, Math.ceil(plan.duration * 10));
  for (let k = 0; k <= N; k++) {
    const t = (plan.duration * k) / N;
    const polys = SIDES.map((side) => {
      const g = footGeom(rig, side);
      const tg = footTargetAt(plan, rig, side, t);
      const w = rig.proportions[side].leg.footWidth / 2;
      return [
        siteUnderTarget(tg, g, 'foot', [w, -g.ankleHeight, -g.heelBack]),
        siteUnderTarget(tg, g, 'foot', [-w, -g.ankleHeight, -g.heelBack]),
        siteUnderTarget(tg, g, 'toes', [-w, -g.mtpHeight, g.toeLength]),
        siteUnderTarget(tg, g, 'toes', [w, -g.mtpHeight, g.toeLength]),
      ].map((p) => [p[0], p[2]] as const);
    });
    if (polygonsOverlap(polys[0]!, polys[1]!))
      return [
        diag('CONTRADICTORY_CONTACTS', 'error', `left and right feet overlap at t=${t.toFixed(2)}s`, {
          time: t,
          hint: 'Increase stance width or change foot placement.',
        }),
      ];
  }
  return [];
}

function polygonsOverlap(a: readonly (readonly [number, number])[], b: readonly (readonly [number, number])[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const nx = q[1] - p[1];
      const nz = -(q[0] - p[0]);
      const proj = (pts: readonly (readonly [number, number])[]) => pts.map((v) => v[0] * nx + v[1] * nz);
      const pa = proj(a);
      const pb = proj(b);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
  }
  return true;
}

/** Sample every swing path and check sole points against floor and solids. */
function validateSwingClearance(plan: MotionPlan, rig: RigDefinition): Diagnostic[] {
  const out: Diagnostic[] = [];
  const boxes = solids(plan.environment);
  for (const side of SIDES) {
    const g = footGeom(rig, side);
    const fs = footSites(side);
    const sites = rig.sites.filter((x) => Object.values(fs).includes(x.name as never));
    for (const s of plan.feet[side]) {
      if (s.kind !== 'swing') continue;
      let worst = 0;
      let worstT = s.start;
      let worstSite = '';
      for (let k = 0; k <= 60; k++) {
        const t = s.start + ((s.end - s.start) * k) / 60;
        const tg = footTargetAt(plan, rig, side, t);
        for (const site of sites) {
          const p = siteUnderTarget(tg, g, site.joint.startsWith('mtp') ? 'toes' : 'foot', [...site.offset]);
          const d = penetrationDepth(p, boxes).depth;
          if (d > worst) {
            worst = d;
            worstT = t;
            worstSite = site.name;
          }
        }
      }
      if (worst > TOLERANCES.penetration)
        out.push(
          diag('SWING_COLLISION', 'error', `${side} swing path puts ${worstSite} ${(worst * 1000).toFixed(1)} mm into geometry at t=${worstT.toFixed(2)}s`, {
            time: worstT,
            subject: worstSite,
            value: worst,
            hint: 'Increase swing clearance or change the swing timing windows.',
          }),
        );
    }
  }
  return out;
}

function validateSeat(plan: MotionPlan): Diagnostic[] {
  if (!plan.seat) return [];
  const out: Diagnostic[] = [];
  const s = findSurface(plan.environment, plan.seat.surface);
  if (!s) return [diag('INVALID_GEOMETRY', 'error', `seat contact references unknown surface '${plan.seat.surface}'`)];
  const tgt = plan.seat.target;
  if (Math.abs(tgt[1] - s.y) > 1e-6 || !insideBounds({ x: tgt[0], z: tgt[2] }, s.bounds, -0.02))
    out.push(
      diag('CONTACT_OFF_SURFACE', 'error', `seat target (${tgt.map((v) => v.toFixed(3)).join(', ')}) is not on '${plan.seat.surface}' (≥2 cm inside its edges)`, {
        path: 'seat.target',
      }),
    );
  let prevEnd = -Infinity;
  plan.seat.intervals.forEach((iv, i) => {
    if (!(iv.end > iv.start) || iv.start < prevEnd || iv.end > plan.duration + EPS)
      out.push(diag('CONTRADICTORY_CONTACTS', 'error', `seat interval ${i} overlaps, is empty, or exceeds the clip`, { path: `seat.intervals.${i}` }));
    prevEnd = iv.end;
  });
  return out;
}
