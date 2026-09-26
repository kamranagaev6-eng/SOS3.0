import { formatZodIssues, SIDES } from '../contracts/common.ts';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import { rigSchema, type Capability, type RigDefinition } from '../contracts/rig.ts';
import { armJoints, footSites, legJoints } from './canonical.ts';

/** Joints and sites the solver needs on every rig (the leg chain always solves hip → knee → ankle → MTP). */
export function solverRequirements(): { joints: string[]; sites: string[] } {
  const joints = ['root', 'pelvis'];
  const sites: string[] = [];
  for (const side of SIDES) {
    const l = legJoints(side);
    joints.push(l.hip, l.knee, l.ankle, l.mtp);
    const f = footSites(side);
    sites.push(f.heel, f.ball, f.toe);
  }
  return { joints, sites };
}

/** Joints a rig must have to legitimately claim each capability. `anyOf` groups need one member. */
export function capabilityJoints(c: Capability): { allOf: string[]; anyOf?: string[] } {
  switch (c) {
    case 'root-translation':
      return { allOf: ['root'] };
    case 'pelvis-rotation':
      return { allOf: ['pelvis'] };
    case 'trunk-articulation':
      return { allOf: [], anyOf: ['lumbar', 'thoracic'] };
    case 'independent-legs':
      return { allOf: SIDES.flatMap((s) => [legJoints(s).hip, legJoints(s).knee, legJoints(s).ankle]) };
    case 'knee-hinge':
      return { allOf: SIDES.map((s) => legJoints(s).knee) };
    case 'ankle-2dof':
      return { allOf: SIDES.map((s) => legJoints(s).ankle) };
    case 'forefoot-articulation':
      return { allOf: SIDES.map((s) => legJoints(s).mtp) };
    case 'independent-arms':
      return { allOf: SIDES.flatMap((s) => [armJoints(s).shoulder, armJoints(s).elbow]) };
    case 'neck':
      return { allOf: ['neck'] };
  }
}

/**
 * Rig validation: schema refinements (names, topological order, DOF/order consistency, site
 * attachment), then semantic checks — joints and sites the solver needs, and joints behind every
 * claimed capability (a rig may not claim articulation it does not have). Never throws.
 */
export function validateRig(input: unknown): { rig: RigDefinition | null; diagnostics: Diagnostic[] } {
  const r = rigSchema.safeParse(input);
  if (!r.success) return { rig: null, diagnostics: formatZodIssues(r.error).map((m) => diag('RIG_INVALID', 'error', `rig ${m}`)) };
  const rig = r.data;
  const out: Diagnostic[] = [];
  const joints = new Set(rig.joints.map((j) => j.name));
  const sites = new Set(rig.sites.map((s) => s.name));
  const req = solverRequirements();
  for (const j of req.joints)
    if (!joints.has(j))
      out.push(
        diag('MISSING_BONE', 'error', `rig '${rig.id}' lacks joint '${j}', which the solver needs for every recipe`, {
          subject: j,
          hint: j.startsWith('mtp')
            ? 'Add a toe/forefoot joint at the metatarsophalangeal joint (the rig adapter derives one from a toe bone).'
            : 'Map this joint in the bone map or add the bone to the host skeleton.',
        }),
      );
  for (const s of req.sites)
    if (!sites.has(s)) out.push(diag('MISSING_BONE', 'error', `rig '${rig.id}' lacks contact site '${s}'`, { subject: s, hint: 'Provide the site explicitly (bone map `sites`) or let the adapter estimate it.' }));
  for (const c of rig.capabilities) {
    const need = capabilityJoints(c);
    const missing = need.allOf.filter((j) => !joints.has(j));
    const anyMissing = need.anyOf && !need.anyOf.some((j) => joints.has(j));
    if (missing.length || anyMissing)
      out.push(
        diag('RIG_INVALID', 'error', `rig '${rig.id}' claims capability '${c}' but lacks ${[...missing, ...(anyMissing ? [`one of ${need.anyOf!.join('/')}`] : [])].join(', ')}`, {
          subject: c,
          hint: 'Remove the capability claim or add the joints.',
        }),
      );
  }
  return { rig, diagnostics: out };
}
