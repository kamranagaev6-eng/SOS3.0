import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import type { ParamSpec } from '../contracts/recipe.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { deg } from '../math/curves.ts';
import { legJoints } from '../rig/canonical.ts';
import { getRigModel } from '../rig/model.ts';
import { flatPose, footGeom } from '../solver/footPose.ts';
import { solveKeyPose } from '../solver/keyPose.ts';
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
import type { RecipeDefinition } from './types.ts';

const SPECS: readonly ParamSpec[] = [
  { key: 'depthKneeFlexionDeg', label: 'Depth (knee flexion at bottom)', kind: 'number', unit: 'deg', min: 30, max: 100, step: 1, default: 70, description: 'Target knee flexion at the bottom key pose.' },
  { key: 'stanceWidth', label: 'Stance width (ankle centres)', kind: 'number', unit: 'm', min: 0.18, max: 0.5, step: 0.01, default: 0.3, description: 'Distance between left and right ankle joint centres.' },
  { key: 'toeOutDeg', label: 'Toe-out per foot', kind: 'number', unit: 'deg', min: 0, max: 25, step: 1, default: 10, description: 'Heading of each foot away from straight ahead.' },
  { key: 'shankLeanRatio', label: 'Shank lean ratio', kind: 'number', unit: 'ratio', min: 0.25, max: 0.45, step: 0.01, default: 0.35, description: 'Ankle dorsiflexion at the bottom as a fraction of knee flexion (authoring heuristic).' },
  { key: 'trunkLeanDeg', label: 'Trunk inclination at bottom', kind: 'number', unit: 'deg', min: 5, max: 45, step: 1, default: 30, description: 'Total trunk inclination at the bottom, split over pelvis tilt, lumbar and thoracic.' },
  { key: 'armsForwardDeg', label: 'Arm reach at bottom', kind: 'number', unit: 'deg', min: 0, max: 90, step: 5, default: 70, description: 'Shoulder flexion at the bottom (both arms).' },
  { key: 'repetitions', label: 'Repetitions shown', kind: 'number', unit: 'count', min: 1, max: 4, step: 1, default: 2, description: 'Number of demonstration cycles in the clip (not a dose).' },
  { key: 'descentSeconds', label: 'Descent time', kind: 'number', unit: 's', min: 1, max: 5, step: 0.1, default: 2, description: 'Standing → bottom.' },
  { key: 'bottomHoldSeconds', label: 'Bottom hold', kind: 'number', unit: 's', min: 0, max: 3, step: 0.1, default: 0.5, description: 'Pause at the bottom.' },
  { key: 'ascentSeconds', label: 'Ascent time', kind: 'number', unit: 's', min: 1, max: 5, step: 0.1, default: 1.8, description: 'Bottom → standing.' },
  { key: 'standSeconds', label: 'Standing pause', kind: 'number', unit: 's', min: 0.5, max: 3, step: 0.1, default: 1, description: 'Pause standing before each cycle and at the end.' },
];

/**
 * Nominal standing knee flexion: keeps legs off the straight-knee singularity and outside the
 * stabiliser's soft reach zone (floor 2° + zone 4° = 6°), so standing poses need no correction.
 */
export const STANDING_KNEE = deg(7);
/** Required headroom below the rig's ankle dorsiflexion limit for the bottom pose. */
const ANKLE_HEADROOM = deg(2);

function build(v: Values, rig: RigDefinition) {
  const diagnostics: Diagnostic[] = [];
  const depth = deg(num(v, 'depthKneeFlexionDeg'));
  const dorsi = num(v, 'shankLeanRatio') * depth;
  const model = getRigModel(rig);
  const ankleLimit = Math.min(
    ...(['left', 'right'] as const).map((s) => model.joints[model.index.get(legJoints(s).ankle)!]!.dofs[0]!.max),
  );
  if (dorsi > ankleLimit - ANKLE_HEADROOM) {
    diagnostics.push(
      diag('UNSUPPORTED_CONFIGURATION', 'error', `bottom pose needs ${fmtDeg(dorsi)} ankle dorsiflexion with heels down; rig limit is ${fmtDeg(ankleLimit)} (headroom ${fmtDeg(ANKLE_HEADROOM)})`, {
        path: 'params.shankLeanRatio',
        value: dorsi,
        limit: ankleLimit - ANKLE_HEADROOM,
        hint: 'Reduce depth or shank lean ratio. Heel-lift squats are not supported by this recipe.',
      }),
    );
    return { plan: null, diagnostics };
  }
  const anchors = bilateralAnchors(num(v, 'stanceWidth'), 0, deg(num(v, 'toeOutDeg')));
  const targets = {
    left: flatPose('left', anchors.left, 0, 'floor', footGeom(rig, 'left')),
    right: flatPose('right', anchors.right, 0, 'floor', footGeom(rig, 'right')),
  };
  const L = rig.proportions.left.leg;
  // Initial guesses must lie strictly inside leg reach: beyond it the knee angle is flat (zero gradient).
  const legLen = L.ankleHeight + 0.93 * (L.thigh + L.shank);

  const stand = solveKeyPose(rig, pelvisRotation(rig, 0, 0, 0), targets, [0, legLen, 0.03], [1], [{ quantity: 'kneeFlexion', side: 'min', target: STANDING_KNEE }]);
  const lean = deg(num(v, 'trunkLeanDeg'));
  const tl = trunkLean(lean);
  const bottom = solveKeyPose(rig, pelvisRotation(rig, 0, tl.tilt, 0), targets, [0, legLen * 0.7, -0.1], [1, 2], [
    { quantity: 'kneeFlexion', side: 'mean', target: depth },
    { quantity: 'ankleDorsiflexion', side: 'mean', target: dorsi },
  ]);
  for (const [name, r] of [['standing', stand], ['bottom', bottom]] as const)
    if (!r.ok || !r.reachable)
      diagnostics.push(diag('KEYPOSE_UNSOLVED', 'error', `could not solve the ${name} key pose (residual ${r.residual.toExponential(2)})`, { hint: 'Parameters are geometrically inconsistent for this rig.' }));
  if (diagnostics.length) return { plan: null, diagnostics };

  const standKey = (t: number): BodyKey => ({
    t,
    mode: 'stop',
    pelvis: stand.P,
    rotation: 0,
    obliquity: 0,
    ...trunkLean(0),
    arms: armsBoth(deg(5), deg(10)),
  });
  const bottomKey = (t: number): BodyKey => ({
    t,
    mode: 'stop',
    pelvis: bottom.P,
    rotation: 0,
    obliquity: 0,
    ...tl,
    arms: armsBoth(deg(num(v, 'armsForwardDeg')), deg(5)),
  });

  const pb = new PhaseBuilder();
  const keys: BodyKey[] = [standKey(0)];
  pb.add('stand-start', 'Stand', num(v, 'standSeconds'), 'Standing, both feet flat, knees near-straight.', 'Phase marker: start');
  keys.push(standKey(pb.t));
  const reps = num(v, 'repetitions');
  for (let r = 1; r <= reps; r++) {
    pb.add(`descent-${r}`, `Descent ${r}`, num(v, 'descentSeconds'), 'Hips move back and down, knees track over the feet, trunk inclines; feet stay planted.', `Phase marker: descent ${r}`);
    keys.push(bottomKey(pb.t));
    if (num(v, 'bottomHoldSeconds') > 0) {
      pb.add(`bottom-${r}`, `Bottom ${r}`, num(v, 'bottomHoldSeconds'), 'Hold at the bottom key pose.', `Phase marker: bottom ${r}`);
      keys.push(bottomKey(pb.t));
    }
    pb.add(`ascent-${r}`, `Ascent ${r}`, num(v, 'ascentSeconds'), 'Return to standing; feet stay planted.', `Phase marker: ascent ${r}`);
    keys.push(standKey(pb.t));
    pb.add(`stand-${r}`, `Stand ${r}`, num(v, 'standSeconds'), 'Standing pause.');
    keys.push(standKey(pb.t));
  }
  const { pelvis, joints } = tracksFromKeys(keys);
  const duration = pb.t;
  const plan = basePlan({
    duration,
    phases: pb.phases,
    cues: pb.cues,
    environment: floorEnvironment(),
    pelvis,
    joints,
    feet: {
      left: [{ kind: 'flat', start: 0, end: duration, surface: 'floor', anchor: anchors.left }],
      right: [{ kind: 'flat', start: 0, end: duration, surface: 'floor', anchor: anchors.right }],
    },
    seat: null,
    assumptions: [
      `Standing key pose solved for ${fmtDeg(STANDING_KNEE)} knee flexion of the straighter leg (avoids the straight-knee singularity).`,
      `Bottom key pose solved for ${fmtDeg(depth)} mean knee flexion and ${fmtDeg(dorsi)} mean ankle dorsiflexion (shank-lean heuristic).`,
      'Trunk inclination split: pelvis 55 %, lumbar 25 %, thoracic 20 %; neck counter-flexes 45 %.',
      'Both feet remain flat on the floor for the whole clip; no heel lift is modelled.',
      'Kinematic demonstration only: no centre-of-mass, balance, load or muscle model.',
    ],
  });
  return { plan, diagnostics };
}

export const squatRecipe: RecipeDefinition = {
  id: 'bilateral-squat.v1',
  version: '1.0.0',
  title: 'Bilateral squat (synthetic fixture)',
  summary: 'Both feet planted flat; pelvis translates down and back with trunk inclination; repeated cycles.',
  paramSpecs: SPECS,
  requiredCapabilities: ['root-translation', 'pelvis-rotation', 'trunk-articulation', 'independent-legs', 'knee-hinge', 'ankle-2dof'],
  setup: ['Level floor only.', 'Feet placed symmetric about the midline at the stance width, turned out by the toe-out angle.', 'Start and end standing.'],
  phaseOutline: [
    { id: 'stand', label: 'Stand', description: 'Standing, feet flat.' },
    { id: 'descent', label: 'Descent', description: 'Pelvis moves down and back; knees flex over the feet.' },
    { id: 'bottom', label: 'Bottom', description: 'Hold at target knee flexion (optional).' },
    { id: 'ascent', label: 'Ascent', description: 'Return to standing.' },
  ],
  contactChanges: ['None: heel, ball and toe of both feet stay in position and orientation contact with the floor throughout.'],
  unsupported: [
    'Heel-elevated or heel-lift squats (heels must stay down).',
    'Single-leg, split or asymmetric-depth squats.',
    'Depth beyond 100° knee flexion, or any depth whose ankle dorsiflexion demand exceeds the rig limit minus 2°.',
    'External load, bar or hand support.',
    'Uneven or sloped floors.',
  ],
  assumptions: ['Synthetic engineering fixture requiring clinical review; not a prescription or instruction.'],
  defaults: () => defaultsOf(SPECS),
  compile(params, rig) {
    return compileWith(this, params, rig, build);
  },
};
