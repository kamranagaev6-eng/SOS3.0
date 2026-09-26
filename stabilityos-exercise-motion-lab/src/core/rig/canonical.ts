import { COORDINATE_CONVENTION, SCHEMA, type Side } from '../contracts/common.ts';
import type {
  Capability,
  DofSpec,
  HumanoidProportions,
  JointSpec,
  LegProportions,
  RigDefinition,
  SiteSpec,
} from '../contracts/rig.ts';
import { CAPABILITIES } from '../contracts/rig.ts';
import { deg } from '../math/curves.ts';
import type { AxisIndex, EulerOrder } from '../math/euler.ts';

/**
 * Canonical joint names. Joint `j` rotates the segment that starts at `j`.
 * Left side = +X. Right-side DOF axes are mirrored (pseudovector rule: Y and Z axis signs flip),
 * so an anatomical angle means the same thing on both sides.
 */
export const JOINT = {
  root: 'root',
  pelvis: 'pelvis',
  lumbar: 'lumbar',
  thoracic: 'thoracic',
  neck: 'neck',
} as const;

export const legJoints = (side: Side) => {
  const s = side === 'left' ? '_L' : '_R';
  return { hip: `hip${s}`, knee: `knee${s}`, ankle: `ankle${s}`, mtp: `mtp${s}` } as const;
};
export const armJoints = (side: Side) => {
  const s = side === 'left' ? '_L' : '_R';
  return { shoulder: `shoulder${s}`, elbow: `elbow${s}`, wrist: `wrist${s}` } as const;
};
export const footSites = (side: Side) => {
  const s = side === 'left' ? '_L' : '_R';
  return {
    heel: `heel${s}`,
    ball: `ball${s}`,
    toe: `toe${s}`,
    heelMedial: `heel_med${s}`,
    heelLateral: `heel_lat${s}`,
    ballMedial: `ball_med${s}`,
    ballLateral: `ball_lat${s}`,
  } as const;
};
export const SEAT_SITE = 'seat';

/** Synthetic engineering joint limits (degrees). NOT normative clinical ranges of motion. */
export const SYNTHETIC_LIMITS_DEG = {
  heading: [-180, 180],
  pelvisRotation: [-45, 45],
  pelvisTilt: [-30, 60],
  pelvisObliquity: [-20, 20],
  lumbarFlexion: [-25, 50],
  lumbarLateral: [-25, 25],
  lumbarAxial: [-20, 20],
  thoracicFlexion: [-20, 40],
  thoracicLateral: [-20, 20],
  thoracicAxial: [-30, 30],
  neckFlexion: [-45, 50],
  neckLateral: [-35, 35],
  neckAxial: [-60, 60],
  shoulderFlexion: [-50, 170],
  shoulderAbduction: [-15, 160],
  shoulderInternalRotation: [-60, 70],
  elbowFlexion: [0, 145],
  wristFlexion: [-70, 80],
  wristDeviation: [-30, 20],
  hipFlexion: [-25, 125],
  hipAbduction: [-25, 45],
  hipInternalRotation: [-45, 40],
  kneeFlexion: [0, 145],
  ankleDorsiflexion: [-50, 35],
  ankleInversion: [-20, 30],
  mtpExtension: [-30, 65],
} as const satisfies Record<string, readonly [number, number]>;

type LimitKey = keyof typeof SYNTHETIC_LIMITS_DEG;

function dof(name: string, axis: AxisIndex, sign: 1 | -1, limit: LimitKey): DofSpec {
  const [lo, hi] = SYNTHETIC_LIMITS_DEG[limit];
  return { name, axis, sign, min: deg(lo), max: deg(hi) };
}

/** Mirror a left-side DOF to the right side: rotation axes are pseudovectors, so Y/Z signs flip. */
function mirrorDof(d: DofSpec): DofSpec {
  return d.axis === 0 ? { ...d } : { ...d, sign: (d.sign === 1 ? -1 : 1) as 1 | -1 };
}

function orderFor(dofs: readonly DofSpec[]): EulerOrder {
  const axes = dofs.map((d) => d.axis);
  for (const a of [0, 1, 2] as const) if (!axes.includes(a)) axes.push(a);
  return axes as EulerOrder;
}

function joint(
  name: string,
  parent: string | null,
  kind: JointSpec['kind'],
  side: JointSpec['side'],
  offset: [number, number, number],
  dofs: DofSpec[],
): JointSpec {
  return { name, parent, kind, side, offset, dofs, order: orderFor(dofs) };
}

/** Standard synthetic adult proportions ("rig A"). Metres. Original values, not from any dataset. */
export const PROPORTIONS_A: HumanoidProportions = (() => {
  const leg: LegProportions = {
    thigh: 0.44,
    shank: 0.43,
    ankleHeight: 0.08,
    heelBack: 0.055,
    footLength: 0.14,
    mtpHeight: 0.022,
    toeLength: 0.06,
    footWidth: 0.09,
  };
  const arm = { upperArm: 0.3, forearm: 0.26, hand: 0.18 };
  return {
    pelvis: { hipHalfWidth: 0.09, hipDrop: 0, seatDrop: 0.105, seatBack: 0.035, lumbarBaseHeight: 0.09 },
    trunk: { lumbar: 0.18, thoracic: 0.3, neck: 0.1, head: 0.2, shoulderHalfWidth: 0.18, shoulderDrop: 0.05 },
    left: { leg: { ...leg }, arm: { ...arm } },
    right: { leg: { ...leg }, arm: { ...arm } },
  };
})();

export function buildCanonicalRig(id: string, name: string, p: HumanoidProportions): RigDefinition {
  const joints: JointSpec[] = [];
  const sites: SiteSpec[] = [];
  joints.push(joint('root', null, 'root', 'center', [0, 0, 0], [dof('heading', 1, 1, 'heading')]));
  joints.push(
    joint('pelvis', 'root', 'pelvis', 'center', [0, 0, 0], [
      dof('rotation', 1, 1, 'pelvisRotation'),
      dof('tilt', 0, 1, 'pelvisTilt'),
      dof('obliquity', 2, 1, 'pelvisObliquity'),
    ]),
  );
  joints.push(
    joint('lumbar', 'pelvis', 'ball', 'center', [0, p.pelvis.lumbarBaseHeight, 0], [
      dof('flexion', 0, 1, 'lumbarFlexion'),
      dof('lateralFlexion', 2, -1, 'lumbarLateral'),
      dof('axialRotation', 1, 1, 'lumbarAxial'),
    ]),
  );
  joints.push(
    joint('thoracic', 'lumbar', 'ball', 'center', [0, p.trunk.lumbar, 0], [
      dof('flexion', 0, 1, 'thoracicFlexion'),
      dof('lateralFlexion', 2, -1, 'thoracicLateral'),
      dof('axialRotation', 1, 1, 'thoracicAxial'),
    ]),
  );
  joints.push(
    joint('neck', 'thoracic', 'ball', 'center', [0, p.trunk.thoracic, 0], [
      dof('flexion', 0, 1, 'neckFlexion'),
      dof('lateralFlexion', 2, -1, 'neckLateral'),
      dof('axialRotation', 1, 1, 'neckAxial'),
    ]),
  );
  sites.push({ name: 'head_top', joint: 'neck', offset: [0, p.trunk.neck + p.trunk.head, 0], role: 'marker' });
  sites.push({ name: SEAT_SITE, joint: 'pelvis', offset: [0, -p.pelvis.seatDrop, -p.pelvis.seatBack], role: 'contact' });

  for (const side of ['left', 'right'] as const) {
    const sx = side === 'left' ? 1 : -1;
    const m = side === 'left' ? (d: DofSpec) => d : mirrorDof;
    const L = p[side].leg;
    const A = p[side].arm;
    const lj = legJoints(side);
    const aj = armJoints(side);
    const fs = footSites(side);
    joints.push(
      joint(aj.shoulder, 'thoracic', 'ball', side, [sx * p.trunk.shoulderHalfWidth, p.trunk.thoracic - p.trunk.shoulderDrop, 0], [
        m(dof('flexion', 0, -1, 'shoulderFlexion')),
        m(dof('abduction', 2, 1, 'shoulderAbduction')),
        m(dof('internalRotation', 1, -1, 'shoulderInternalRotation')),
      ]),
    );
    joints.push(joint(aj.elbow, aj.shoulder, 'hinge', side, [0, -A.upperArm, 0], [m(dof('flexion', 0, -1, 'elbowFlexion'))]));
    joints.push(
      joint(aj.wrist, aj.elbow, 'universal', side, [0, -A.forearm, 0], [
        m(dof('flexion', 2, -1, 'wristFlexion')),
        m(dof('deviation', 0, -1, 'wristDeviation')),
      ]),
    );
    sites.push({ name: `hand${side === 'left' ? '_L' : '_R'}`, joint: aj.wrist, offset: [0, -A.hand, 0], role: 'marker' });

    joints.push(
      joint(lj.hip, 'pelvis', 'ball', side, [sx * p.pelvis.hipHalfWidth, -p.pelvis.hipDrop, 0], [
        m(dof('flexion', 0, -1, 'hipFlexion')),
        m(dof('abduction', 2, 1, 'hipAbduction')),
        m(dof('internalRotation', 1, -1, 'hipInternalRotation')),
      ]),
    );
    joints.push(joint(lj.knee, lj.hip, 'hinge', side, [0, -L.thigh, 0], [m(dof('flexion', 0, 1, 'kneeFlexion'))]));
    joints.push(
      joint(lj.ankle, lj.knee, 'universal', side, [0, -L.shank, 0], [
        m(dof('dorsiflexion', 0, -1, 'ankleDorsiflexion')),
        m(dof('inversion', 2, -1, 'ankleInversion')),
      ]),
    );
    joints.push(
      joint(lj.mtp, lj.ankle, 'hinge', side, [0, -(L.ankleHeight - L.mtpHeight), L.footLength], [
        m(dof('extension', 0, -1, 'mtpExtension')),
      ]),
    );
    const medial = -sx;
    sites.push({ name: fs.heel, joint: lj.ankle, offset: [0, -L.ankleHeight, -L.heelBack], role: 'contact' });
    sites.push({ name: fs.ball, joint: lj.mtp, offset: [0, -L.mtpHeight, 0], role: 'contact' });
    sites.push({ name: fs.toe, joint: lj.mtp, offset: [0, -L.mtpHeight, L.toeLength], role: 'contact' });
    sites.push({
      name: fs.heelMedial,
      joint: lj.ankle,
      offset: [medial * L.footWidth * 0.35, -L.ankleHeight, -L.heelBack + 0.02],
      role: 'penetration',
    });
    sites.push({
      name: fs.heelLateral,
      joint: lj.ankle,
      offset: [-medial * L.footWidth * 0.35, -L.ankleHeight, -L.heelBack + 0.02],
      role: 'penetration',
    });
    sites.push({ name: fs.ballMedial, joint: lj.mtp, offset: [medial * L.footWidth * 0.5, -L.mtpHeight, 0], role: 'penetration' });
    sites.push({ name: fs.ballLateral, joint: lj.mtp, offset: [-medial * L.footWidth * 0.5, -L.mtpHeight, 0], role: 'penetration' });
  }

  const visualRadius: Record<string, number> = {
    pelvis: 0.12,
    lumbar: 0.11,
    thoracic: 0.14,
    neck: 0.1,
  };
  for (const s of ['_L', '_R']) {
    visualRadius[`hip${s}`] = 0.07;
    visualRadius[`knee${s}`] = 0.052;
    visualRadius[`ankle${s}`] = 0.042;
    visualRadius[`mtp${s}`] = 0.035;
    visualRadius[`shoulder${s}`] = 0.045;
    visualRadius[`elbow${s}`] = 0.038;
    visualRadius[`wrist${s}`] = 0.032;
  }

  return {
    schema: SCHEMA.rig,
    id,
    name,
    synthetic: true,
    convention: { ...COORDINATE_CONVENTION },
    proportions: structuredClone(p),
    joints,
    sites,
    capabilities: [...CAPABILITIES] as Capability[],
    visualRadius,
  };
}

/** Rig A: the default synthetic humanoid. */
export function createRigA(): RigDefinition {
  return buildCanonicalRig('synthetic-rig-a', 'Synthetic rig A (canonical, 1.73 m)', PROPORTIONS_A);
}

/** Uniformly/anisotropically scaled proportions for proportion sweeps in tests and demos. */
export function scaleProportions(
  p: HumanoidProportions,
  f: { leg?: number; trunk?: number; foot?: number; pelvis?: number; arm?: number; leftLegExtra?: number },
): HumanoidProportions {
  const leg = f.leg ?? 1;
  const trunk = f.trunk ?? 1;
  const foot = f.foot ?? 1;
  const pel = f.pelvis ?? 1;
  const arm = f.arm ?? 1;
  const out = structuredClone(p);
  out.pelvis.hipHalfWidth *= pel;
  out.pelvis.seatDrop *= pel;
  out.pelvis.seatBack *= pel;
  out.pelvis.hipDrop *= pel;
  out.pelvis.lumbarBaseHeight *= trunk;
  out.trunk.lumbar *= trunk;
  out.trunk.thoracic *= trunk;
  out.trunk.neck *= trunk;
  out.trunk.head *= trunk;
  out.trunk.shoulderHalfWidth *= pel;
  for (const side of ['left', 'right'] as const) {
    const L = out[side].leg;
    L.thigh *= leg;
    L.shank *= leg;
    L.ankleHeight *= foot;
    L.heelBack *= foot;
    L.footLength *= foot;
    L.mtpHeight *= foot;
    L.toeLength *= foot;
    L.footWidth *= foot;
    const A = out[side].arm;
    A.upperArm *= arm;
    A.forearm *= arm;
    A.hand *= arm;
  }
  if (f.leftLegExtra) {
    out.left.leg.thigh += f.leftLegExtra / 2;
    out.left.leg.shank += f.leftLegExtra / 2;
  }
  return out;
}

/** Swap left/right proportions (used to mirror an asymmetric rig). */
export function mirrorProportions(p: HumanoidProportions): HumanoidProportions {
  const out = structuredClone(p);
  out.left = structuredClone(p.right);
  out.right = structuredClone(p.left);
  return out;
}
