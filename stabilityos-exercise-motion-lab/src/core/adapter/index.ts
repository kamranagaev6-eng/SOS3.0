/**
 * Host-rig adapter: lets the canonical motion format drive a host application's skeleton that
 * uses other bone names, rest transforms, units and axes.
 *
 * Pipeline (createHostRigAdapter):
 *  1. validate inputs (zod schemas, then hierarchy, bone map and geometry) → diagnostics, never throws;
 *  2. build the host → canonical basis from the axis labels (right-handed only) and unit scale;
 *  3. compute the host REST pose in canonical space and measure canonical proportions from it;
 *  4. build a canonical rig with the host's OWN proportions (`adapter.canonical`). The solver must
 *     run on this rig: contacts solved for the host's limb lengths stay exact on the host, whereas
 *     replaying joint angles solved for another body would slide or sink the feet;
 *  5. assess capabilities; missing required ones are errors with host-specific instructions.
 *
 * No React, three.js or DOM dependencies.
 */
import { diag, hasErrors, type Diagnostic } from '../contracts/diagnostics.ts';
import type { BoneMap, CapabilityReport, HostSkeleton } from '../contracts/hostRig.ts';
import { rigSchema, type Capability, type RigDefinition } from '../contracts/rig.ts';
import { formatZodIssues } from '../contracts/common.ts';
import type { Quat } from '../math/quat.ts';
import type { Vec3 } from '../math/vec3.ts';
import { buildCanonicalRig } from '../rig/canonical.ts';
import type { PoseSample } from '../solver/types.ts';
import { createHostBasis, type AxisConvention } from './basis.ts';
import { assessCapabilities, capabilityHint } from './capabilities.ts';
import { buildTopology, canonicalRest } from './hierarchy.ts';
import { measureHost, restResiduals, type MeasureInput } from './measure.ts';
import { createTransfer, type HostBoneWorld, type HostPose, type SitePosition, type UnrepresentedMotion } from './transfer.ts';
import { checkSides, parseInputs, validateMapping } from './validate.ts';
import { SYNTHETIC_HOST_RIGS } from './synthetic.ts';

export type { HostPose, HostBoneWorld, SitePosition, UnrepresentedMotion } from './transfer.ts';
export type { AxisConvention, HostBasis, LengthUnit } from './basis.ts';
export { createHostBasis, allAxisConventions, isRightHandedConvention, METRES_PER_UNIT, axisVector } from './basis.ts';
export { assessCapabilities, capabilityHint, capabilityRequirements } from './capabilities.ts';
export { poseFromAngles, randomJointAngles, restPose, standingPelvisHeight, type FkPose } from './pose.ts';
export {
  SYNTHETIC_HOST_RIGS,
  RIG_B_DESIGN_PROPORTIONS,
  RIG_B_CONVENTION,
  RIG_B_TOE_OUT,
  RIG_C_CONVENTION,
  identityHostFromRig,
  reexpressHost,
} from './synthetic.ts';
export { CANONICAL_JOINTS, LOCATABLE_SITES, REQUIRED_JOINTS } from './topology.ts';

export interface HostRigAdapter {
  host: HostSkeleton;
  boneMap: BoneMap;
  /** Canonical rig DERIVED from the host rest pose (proportions measured, metres, +Y up). Solve on this rig. */
  canonical: RigDefinition;
  capabilities: CapabilityReport[];
  /** Host bone LOCAL transforms (host units, host axes, host bone order) for a canonical pose of `canonical`. */
  toHostPose(sample: Pick<PoseSample, 'local' | 'worldRot' | 'rootTranslation' | 'pelvisOffset'>): HostPose;
  /** Host FK of a host pose, expressed in canonical axes and metres (host bone order). */
  hostWorldInCanonical(pose: HostPose): HostBoneWorld[];

  // ---- extensions (additive; not required by consumers of the core contract) ----
  /** Host convention and metres per host unit. */
  convention: Readonly<AxisConvention> & { metresPerUnit: number };
  /** Per mapped joint: host bone and its world rotation at the canonical rest pose (canonical axes). */
  bindings: readonly { joint: string; bone: string; bind: Quat }[];
  /** Canonical joints (other than the root) with no host bone: their rotations are dropped, not folded. */
  unmappedJoints: readonly string[];
  /** Bone that receives root/pelvis translation, or null when the host has none. */
  motionBone: string | null;
  /** Canonical pelvis origin in the host rest pose (canonical world, m). */
  restPelvisOrigin: Vec3;
  /** Canonical sites whose geometry was estimated (ESTIMATED_GEOMETRY). */
  estimatedSites: readonly string[];
  /** All canonical sites located through the host skeleton for a host pose (canonical axes, m). */
  hostSitePositions(pose: HostPose): SitePosition[];
  /** Motion in a canonical pose that the host cannot show (dropped rotations / translation). */
  unrepresentedMotion(sample: Pick<PoseSample, 'local' | 'worldRot' | 'rootTranslation' | 'pelvisOffset'>): UnrepresentedMotion[];
}

export type AdapterResult = { ok: true; adapter: HostRigAdapter; diagnostics: Diagnostic[] } | { ok: false; diagnostics: Diagnostic[] };

export interface AdapterOptions {
  /** Recipe ids per capability, used to say who needs a missing capability (see capabilityRequirements). */
  requiredBy?: Partial<Record<Capability, readonly string[]>>;
}

/** Residuals (m) above this are reported; above the contact tolerance (1 mm) as warnings. */
const RESIDUAL_REPORT = 1e-6;
const RESIDUAL_WARN = 1e-3;

function derivedRigId(hostId: string): string {
  return `${hostId.slice(0, 70)}.derived`;
}

function create(hostIn: unknown, boneMapIn: unknown, requiredIn: unknown, options: AdapterOptions): AdapterResult {
  const diagnostics: Diagnostic[] = [];
  const parsed = parseInputs(hostIn, boneMapIn, requiredIn, diagnostics);
  const { host, boneMap, required } = parsed;
  if (!host || !boneMap) return { ok: false, diagnostics };

  const conv: AxisConvention = { units: host.units, up: host.up, forward: host.forward, left: host.left };
  const basisR = createHostBasis(conv);
  if (!basisR.ok) diagnostics.push(diag('RIG_INVALID', 'error', `host skeleton '${host.id}': ${basisR.message}`, { path: 'host.up', hint: basisR.hint }));
  const { topology: topo, diagnostics: topoDiags } = buildTopology(host);
  diagnostics.push(...topoDiags);
  const mapping = validateMapping(host, boneMap, topo, diagnostics);

  // Capability assessment needs only hierarchy + bone map.
  const capabilities = assessCapabilities(host, boneMap);
  const requiredSet = new Set(required);
  const capabilityDiags: Diagnostic[] = [];
  for (const r of capabilities) {
    if (r.available) continue;
    const isRequired = requiredSet.has(r.capability);
    capabilityDiags.push(
      diag(
        'MISSING_CAPABILITY',
        isRequired ? 'error' : 'warning',
        `host skeleton '${host.id}' lacks capability '${r.capability}': ${r.reason}` + (isRequired ? '' : ' (not required by the requested motion; affected motion is reported as unrepresented)'),
        { subject: r.capability, hint: capabilityHint(host, boneMap, r.capability, options.requiredBy?.[r.capability]) },
      ),
    );
  }
  if (!basisR.ok || hasErrors(diagnostics)) return { ok: false, diagnostics: [...diagnostics, ...capabilityDiags.filter((d) => d.severity === 'error')] };
  const basis = basisR.basis;

  const rest = canonicalRest(host, topo, basis);
  checkSides(host, topo, mapping.jointBone, rest.worldP, diagnostics);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics: [...diagnostics, ...capabilityDiags.filter((d) => d.severity === 'error')] };

  const sitePos = new Map<string, Vec3>();
  for (const [s, d] of mapping.siteDefs) {
    const off = basis.vecToCanonical(d.offset);
    const p = rest.worldP[d.bone]!;
    const r = rest.worldR[d.bone]!;
    // world = P + R · offset
    const [qx, qy, qz, qw] = r;
    const tx = 2 * (qy * off[2] - qz * off[1]);
    const ty = 2 * (qz * off[0] - qx * off[2]);
    const tz = 2 * (qx * off[1] - qy * off[0]);
    sitePos.set(s, [
      p[0] + off[0] + qw * tx + (qy * tz - qz * ty),
      p[1] + off[1] + qw * ty + (qz * tx - qx * tz),
      p[2] + off[2] + qw * tz + (qx * ty - qy * tx),
    ]);
  }
  const measureInput: MeasureInput = {
    hostId: host.id,
    hostNames: topo.names,
    children: topo.children,
    restPos: rest.worldP,
    jointBone: mapping.jointBone,
    sitePos,
    twist: boneMap.twist,
  };
  const measurement = measureHost(measureInput, diagnostics);
  if (!measurement || hasErrors(diagnostics)) return { ok: false, diagnostics: [...diagnostics, ...capabilityDiags.filter((d) => d.severity === 'error')] };

  const built = buildCanonicalRig(derivedRigId(host.id), `Derived canonical rig for ${host.name}`.slice(0, 120), measurement.proportions);
  built.capabilities = capabilities.filter((c) => c.available).map((c) => c.capability);
  const check = rigSchema.safeParse(built);
  if (!check.success) {
    diagnostics.push(
      ...formatZodIssues(check.error).map((m) =>
        diag('RIG_INVALID', 'error', `derived canonical rig is invalid: ${m}`, { hint: 'The host rest geometry produced invalid proportions; see the other diagnostics.' }),
      ),
    );
    return { ok: false, diagnostics };
  }
  const canonical = built;

  for (const r of restResiduals(canonical, measurement, measureInput)) {
    if (!(r.residual > RESIDUAL_REPORT)) continue;
    diagnostics.push(
      diag(
        'ESTIMATED_GEOMETRY',
        r.residual > RESIDUAL_WARN ? 'warning' : 'info',
        `host rest geometry at '${r.subject}' (bone '${r.bone}') is not representable by the canonical rig: ${(r.residual * 1000).toFixed(3)} mm off; ` +
          'on the host this point deviates from the solved canonical pose by about that much',
        {
          subject: r.subject,
          value: r.residual,
          limit: RESIDUAL_WARN,
          hint: 'Canonical segments are straight and symmetric in the rest pose (hips/shoulders level and centred, trunk above the hip midpoint, sites at sole level). Move the host bone/site or accept the reported deviation.',
        },
      ),
    );
  }
  diagnostics.push(...capabilityDiags);
  if (hasErrors(diagnostics)) return { ok: false, diagnostics };

  const transfer = createTransfer({ host, basis, topo, rest, rig: canonical, jointBone: mapping.jointBone, measurement, siteDefs: mapping.siteDefs });
  const adapter: HostRigAdapter = {
    host,
    boneMap,
    canonical,
    capabilities,
    toHostPose: transfer.toHostPose,
    hostWorldInCanonical: transfer.hostWorldInCanonical,
    convention: { ...conv, metresPerUnit: basis.scale },
    bindings: transfer.bindings,
    unmappedJoints: transfer.unmappedJoints,
    motionBone: transfer.motionBone,
    restPelvisOrigin: measurement.pelvisOrigin,
    estimatedSites: measurement.estimatedSites,
    hostSitePositions: transfer.hostSitePositions,
    unrepresentedMotion: transfer.unrepresentedMotion,
  };
  return { ok: true, adapter, diagnostics };
}

/**
 * Validates a host skeleton + bone map and builds an adapter. Accepts objects or JSON strings.
 * `requiredCapabilities` (e.g. a recipe's requirements) turns missing capabilities into errors;
 * without it availability is only reported (warnings). Never throws.
 */
export function createHostRigAdapter(
  host: unknown,
  boneMap: unknown,
  requiredCapabilities?: readonly Capability[],
  options: AdapterOptions = {},
): AdapterResult {
  try {
    return create(host, boneMap, requiredCapabilities, options);
  } catch (e) {
    // Defensive: validation above is meant to catch every bad input; an exception here is a bug.
    return {
      ok: false,
      diagnostics: [diag('RIG_INVALID', 'error', `host rig adapter failed unexpectedly: ${(e as Error)?.message ?? String(e)}`, { hint: 'Please report this input; it should have produced a specific diagnostic.' })],
    };
  }
}

/** Convenience: a synthetic host rig by id. */
export function getSyntheticHostRig(id: string): (typeof SYNTHETIC_HOST_RIGS)[number] | null {
  return SYNTHETIC_HOST_RIGS.find((r) => r.id === id) ?? null;
}
