import { SIDES, type Side } from '../contracts/common.ts';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import type { FootState, Track } from '../contracts/plan.ts';
import type { ParamSpec } from '../contracts/recipe.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { deg } from '../math/curves.ts';
import { legJoints } from '../rig/canonical.ts';
import { getRigModel } from '../rig/model.ts';
import { flatPose, footGeom, forefootPose, mtpAngleForHeelLift } from '../solver/footPose.ts';
import { evaluateLegs, solveKeyPose } from '../solver/keyPose.ts';
import {
  armsBoth,
  basePlan,
  bilateralAnchors,
  compileWith,
  defaultsOf,
  floorEnvironment,
  fmtDeg,
  num,
  pelvisRotation,
  PhaseBuilder,
  tracksFromKeys,
  trunkLean,
  type BodyKey,
  type Values,
} from './common.ts';
import { STANDING_KNEE } from './squat.ts';
import type { RecipeDefinition } from './types.ts';

const SPECS: readonly ParamSpec[] = [
  { key: 'heelRise', label: 'Heel rise height', kind: 'number', unit: 'm', min: 0.02, max: 0.1, step: 0.005, default: 0.06, description: 'Height of the heel contact point above the floor at the top.' },
  { key: 'stanceWidth', label: 'Stance width (ankle centres)', kind: 'number', unit: 'm', min: 0.14, max: 0.35, step: 0.01, default: 0.2, description: 'Distance between ankle joint centres.' },
  { key: 'toeOutDeg', label: 'Toe-out per foot', kind: 'number', unit: 'deg', min: 0, max: 15, step: 1, default: 5, description: 'Heading of each foot away from straight ahead.' },
  { key: 'repetitions', label: 'Repetitions shown', kind: 'number', unit: 'count', min: 1, max: 4, step: 1, default: 2, description: 'Number of demonstration cycles in the clip (not a dose).' },
  { key: 'riseSeconds', label: 'Rise time', kind: 'number', unit: 's', min: 0.6, max: 3, step: 0.1, default: 1.2, description: 'Heels lift from flat to the top.' },
  { key: 'topHoldSeconds', label: 'Top hold', kind: 'number', unit: 's', min: 0, max: 3, step: 0.1, default: 1, description: 'Pause at the top.' },
  { key: 'lowerSeconds', label: 'Lowering time', kind: 'number', unit: 's', min: 0.8, max: 4, step: 0.1, default: 1.8, description: 'Heels return to the floor.' },
  { key: 'restSeconds', label: 'Rest between cycles', kind: 'number', unit: 's', min: 0.5, max: 3, step: 0.1, default: 1, description: 'Standing flat before each cycle and at the end.' },
];

const MTP_HEADROOM = deg(5);

function heelTrack(points: readonly (readonly [number, number])[]): Track {
  return { keys: points.map(([t, v]) => ({ t, v, mode: 'stop' as const })) };
}

function build(v: Values, rig: RigDefinition) {
  const diagnostics: Diagnostic[] = [];
  const h = num(v, 'heelRise');
  const model = getRigModel(rig);
  for (const side of SIDES) {
    const phi = mtpAngleForHeelLift(footGeom(rig, side), h);
    const lim = model.joints[model.index.get(legJoints(side).mtp)!]!.dofs[0]!.max;
    if (phi > lim - MTP_HEADROOM)
      diagnostics.push(
        diag('UNSUPPORTED_CONFIGURATION', 'error', `heel rise ${h} m needs ${fmtDeg(phi)} ${side} MTP extension; rig limit ${fmtDeg(lim)} minus ${fmtDeg(MTP_HEADROOM)} headroom`, {
          path: 'params.heelRise',
          value: phi,
          limit: lim - MTP_HEADROOM,
          hint: 'Reduce heel rise height.',
        }),
      );
  }
  if (diagnostics.length) return { plan: null, diagnostics };

  const anchors = bilateralAnchors(num(v, 'stanceWidth'), 0, deg(num(v, 'toeOutDeg')));
  const flat = Object.fromEntries(SIDES.map((s) => [s, flatPose(s, anchors[s], 0, 'floor', footGeom(rig, s))])) as Record<Side, ReturnType<typeof flatPose>>;
  const top = Object.fromEntries(SIDES.map((s) => [s, forefootPose(s, anchors[s], 0, 'floor', footGeom(rig, s), h)])) as Record<Side, ReturnType<typeof forefootPose>>;
  const L = rig.proportions.left.leg;
  const init = L.ankleHeight + 0.93 * (L.thigh + L.shank);
  const rot0 = pelvisRotation(rig, 0, 0, 0);
  const stand = solveKeyPose(rig, rot0, flat, [0, init, 0.02], [1], [{ quantity: 'kneeFlexion', side: 'min', target: STANDING_KNEE }]);
  // At the top the pelvis follows the ankles forward so the legs keep their standing inclination.
  const dz = (top.left.anklePos[2] - flat.left.anklePos[2] + top.right.anklePos[2] - flat.right.anklePos[2]) / 2;
  const up = solveKeyPose(rig, rot0, top, [0, init + h, 0.02 + dz], [1], [{ quantity: 'kneeFlexion', side: 'min', target: STANDING_KNEE }]);
  for (const [name, r] of [['standing', stand], ['top', up]] as const)
    if (!r.ok || !r.reachable) diagnostics.push(diag('KEYPOSE_UNSOLVED', 'error', `could not solve the ${name} key pose`));
  if (diagnostics.length) return { plan: null, diagnostics };
  // Ankle plantarflexion demand at the top must be within the rig's limits.
  const legsTop = evaluateLegs(rig, up.P, rot0, top);
  for (const side of SIDES) {
    const a = legsTop[side].angles.ankle[0]!;
    const lim = model.joints[model.index.get(legJoints(side).ankle)!]!.dofs[0]!;
    if (a < lim.min)
      diagnostics.push(diag('UNSUPPORTED_CONFIGURATION', 'error', `${side} ankle would need ${fmtDeg(-a)} plantarflexion (limit ${fmtDeg(-lim.min)})`, { path: 'params.heelRise' }));
  }
  if (diagnostics.length) return { plan: null, diagnostics };

  const key = (t: number, P: typeof stand.P): BodyKey => ({ t, mode: 'stop', pelvis: P, rotation: 0, obliquity: 0, ...trunkLean(0), arms: armsBoth(deg(3), deg(8)) });
  const pb = new PhaseBuilder();
  const keys: BodyKey[] = [key(0, stand.P)];
  const feet: Record<Side, FootState[]> = { left: [], right: [] };
  let flatStart = 0;
  pb.add('stand-start', 'Stand', num(v, 'restSeconds'), 'Standing, feet flat.', 'Phase marker: start');
  keys.push(key(pb.t, stand.P));
  for (let r = 1; r <= num(v, 'repetitions'); r++) {
    const riseStart = pb.t;
    for (const s of SIDES) feet[s].push({ kind: 'flat', start: flatStart, end: riseStart, surface: 'floor', anchor: anchors[s] });
    pb.add(`rise-${r}`, `Rise ${r}`, num(v, 'riseSeconds'), 'Heels lift; ball and toes stay planted; body rises with the ankles.', `Phase marker: rise ${r}`);
    const riseEnd = pb.t;
    keys.push(key(pb.t, up.P));
    let holdEnd = riseEnd;
    if (num(v, 'topHoldSeconds') > 0) {
      pb.add(`top-${r}`, `Top ${r}`, num(v, 'topHoldSeconds'), 'Hold on the forefoot.', `Phase marker: top ${r}`);
      holdEnd = pb.t;
      keys.push(key(pb.t, up.P));
    }
    pb.add(`lower-${r}`, `Lower ${r}`, num(v, 'lowerSeconds'), 'Heels return to the floor; forefoot stays planted.', `Phase marker: lower ${r}`);
    const lowerEnd = pb.t;
    keys.push(key(pb.t, stand.P));
    const lift = heelTrack(
      holdEnd > riseEnd ? [[riseStart, 0], [riseEnd, h], [holdEnd, h], [lowerEnd, 0]] : [[riseStart, 0], [riseEnd, h], [lowerEnd, 0]],
    );
    for (const s of SIDES) feet[s].push({ kind: 'forefoot', start: riseStart, end: lowerEnd, surface: 'floor', anchor: anchors[s], heelLift: lift });
    pb.add(`rest-${r}`, `Rest ${r}`, num(v, 'restSeconds'), 'Standing, feet flat.');
    keys.push(key(pb.t, stand.P));
    flatStart = lowerEnd;
  }
  for (const s of SIDES) feet[s].push({ kind: 'flat', start: flatStart, end: pb.t, surface: 'floor', anchor: anchors[s] });
  const { pelvis, joints } = tracksFromKeys(keys);
  const plan = basePlan({
    duration: pb.t,
    phases: pb.phases,
    cues: pb.cues,
    environment: floorEnvironment(),
    pelvis,
    joints,
    feet,
    seat: null,
    assumptions: [
      `Heel lift follows the authored curve; the foot pivots about the MTP axis (ball/toes stay flat): φ = ${fmtDeg(mtpAngleForHeelLift(footGeom(rig, 'left'), h))} at the top (left).`,
      `Pelvis keys solved for ${fmtDeg(STANDING_KNEE)} mean knee flexion flat and at the top; pelvis moves forward with the ankles (${(dz * 1000).toFixed(1)} mm).`,
      'Pelvis and heel-lift curves share key times and easing; the small nonlinearity is absorbed by knee flexion (reported per sample).',
      'Kinematic demonstration only: no balance, calf loading or muscle model.',
    ],
  });
  return { plan, diagnostics };
}

export const heelRaiseRecipe: RecipeDefinition = {
  id: 'bilateral-heel-raise.v1',
  version: '1.0.0',
  title: 'Bilateral heel raise (synthetic fixture)',
  summary: 'Both heels lift while ball and toes stay planted; the body rises with the ankles; repeated cycles.',
  paramSpecs: SPECS,
  requiredCapabilities: ['root-translation', 'pelvis-rotation', 'independent-legs', 'knee-hinge', 'ankle-2dof', 'forefoot-articulation'],
  setup: ['Level floor only.', 'Feet placed symmetric about the midline at the stance width.', 'Start and end standing with feet flat.'],
  phaseOutline: [
    { id: 'stand', label: 'Stand', description: 'Feet flat.' },
    { id: 'rise', label: 'Rise', description: 'Heels lift about the MTP axis; ball and toes stay planted.' },
    { id: 'top', label: 'Top', description: 'Hold on the forefoot (optional).' },
    { id: 'lower', label: 'Lower', description: 'Heels return to the floor.' },
    { id: 'rest', label: 'Rest', description: 'Feet flat.' },
  ],
  contactChanges: [
    'Rise start: heel position contact and foot-orientation contact end; ball and toe position contacts continue; toes-segment orientation contact begins (forefoot state).',
    'Lower end: heel position contact and foot-orientation contact resume (flat state).',
  ],
  unsupported: [
    'Single-leg heel raises.',
    'Heel raises off a step edge (heels below the support surface).',
    'Hand support or external load.',
    'Bent-knee variant.',
    'Heel rise heights whose MTP extension exceeds the rig limit minus 5°.',
  ],
  assumptions: ['Synthetic engineering fixture requiring clinical review; not a prescription or instruction.'],
  defaults: () => defaultsOf(SPECS),
  compile(params, rig) {
    return compileWith(this, params, rig, build);
  },
};
