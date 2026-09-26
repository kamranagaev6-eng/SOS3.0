import { SIDES, type Side } from '../contracts/common.ts';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import type { ParamSpec } from '../contracts/recipe.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { deg, lerp } from '../math/curves.ts';
import type { Vec3 } from '../math/vec3.ts';
import { SEAT_SITE } from '../rig/canonical.ts';
import { flatPose, footGeom } from '../solver/footPose.ts';
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
  seatPlacedPelvis,
  tracksFromKeys,
  trunkLean,
  type BodyKey,
  type Values,
} from './common.ts';
import { STANDING_KNEE } from './squat.ts';
import type { RecipeDefinition } from './types.ts';

const SPECS: readonly ParamSpec[] = [
  { key: 'chairHeight', label: 'Chair seat height', kind: 'number', unit: 'm', min: 0.4, max: 0.55, step: 0.01, default: 0.46, description: 'Top of the seat above the floor.' },
  { key: 'footSetback', label: 'Foot setback', kind: 'number', unit: 'm', min: 0, max: 0.15, step: 0.01, default: 0.06, description: 'Ankle placed this far behind the seated knee position.' },
  { key: 'stanceWidth', label: 'Stance width (ankle centres)', kind: 'number', unit: 'm', min: 0.16, max: 0.4, step: 0.01, default: 0.26, description: 'Distance between ankle joint centres.' },
  { key: 'toeOutDeg', label: 'Toe-out per foot', kind: 'number', unit: 'deg', min: 0, max: 20, step: 1, default: 8, description: 'Heading of each foot away from straight ahead.' },
  { key: 'maxTrunkLeanDeg', label: 'Peak trunk inclination', kind: 'number', unit: 'deg', min: 20, max: 55, step: 1, default: 40, description: 'Trunk inclination at seat-off.' },
  { key: 'riseSeconds', label: 'Rise time', kind: 'number', unit: 's', min: 0.8, max: 3, step: 0.1, default: 1.5, description: 'Seat-off → standing.' },
  { key: 'standHoldSeconds', label: 'Standing hold', kind: 'number', unit: 's', min: 0.5, max: 3, step: 0.1, default: 1.2, description: 'Pause standing.' },
  { key: 'descentSeconds', label: 'Descent time', kind: 'number', unit: 's', min: 1, max: 4, step: 0.1, default: 2, description: 'Standing → seat contact.' },
];

const CHAIR = { seatDepth: 0.46, seatWidth: 0.46, seatThickness: 0.05, backrestHeight: 0.4, frontZ: 0 };
/** Seated knee sits this far in front of the seat's front edge (authoring convention). */
const KNEE_OVERHANG = 0.12;
const SEAT_BLEND = 0.3;
const SEATED = 1.0;
const LEAN = 1.0;
const SETTLE = 1.0;
const END = 0.6;
const MID_KNEE = deg(55);

function build(v: Values, rig: RigDefinition) {
  const diagnostics: Diagnostic[] = [];
  if (!rig.sites.some((x) => x.name === SEAT_SITE))
    return {
      plan: null,
      diagnostics: [
        diag('MISSING_BONE', 'error', `rig '${rig.id}' has no '${SEAT_SITE}' contact site; sit-to-stand needs the pelvis seat contact point`, {
          subject: SEAT_SITE,
          hint: 'Provide the seat site in the bone map (sites.seat) or let the adapter estimate it.',
        }),
      ],
    };
  const H = num(v, 'chairHeight');
  const p = rig.proportions;
  // Seated geometry from the mean of both legs, so the compiler is mirror-equivariant for
  // asymmetric rigs (a right-long-leg subject gets the mirror image of a left-long-leg one).
  const mean = (k: 'thigh' | 'shank' | 'ankleHeight') => (p.left.leg[k] + p.right.leg[k]) / 2;
  const L = { thigh: mean('thigh'), shank: mean('shank'), ankleHeight: mean('ankleHeight') };
  const hipY = H + p.pelvis.seatDrop - p.pelvis.hipDrop;
  const kneeY = L.ankleHeight + L.shank;
  const drop = hipY - kneeY;
  if (Math.abs(drop) >= L.thigh * 0.9) {
    diagnostics.push(
      diag('UNSUPPORTED_CONFIGURATION', 'error', `chair height ${H} m is incompatible with this rig's thigh/shank lengths (seated hip ${hipY.toFixed(3)} m vs knee ${kneeY.toFixed(3)} m)`, {
        path: 'params.chairHeight',
      }),
    );
    return { plan: null, diagnostics };
  }
  const thighHoriz = Math.sqrt(L.thigh * L.thigh - drop * drop);
  const hipZ = CHAIR.frontZ + KNEE_OVERHANG - thighHoriz;
  const seatTarget: Vec3 = [0, H, hipZ - p.pelvis.seatBack];
  if (seatTarget[2] < CHAIR.frontZ - CHAIR.seatDepth + 0.03 || seatTarget[2] > CHAIR.frontZ - 0.03) {
    diagnostics.push(
      diag('UNSUPPORTED_CONFIGURATION', 'error', `seat contact would fall ${seatTarget[2].toFixed(3)} m, outside the ${CHAIR.seatDepth} m seat`, {
        path: 'params.chairHeight',
        hint: 'Rig thigh length does not fit the synthetic chair depth.',
      }),
    );
    return { plan: null, diagnostics };
  }
  const anchors = bilateralAnchors(num(v, 'stanceWidth'), CHAIR.frontZ + KNEE_OVERHANG - num(v, 'footSetback'), deg(num(v, 'toeOutDeg')));
  const targets = Object.fromEntries(SIDES.map((s) => [s, flatPose(s, anchors[s], 0, 'floor', footGeom(rig, s))])) as Record<Side, ReturnType<typeof flatPose>>;

  const maxLean = deg(num(v, 'maxTrunkLeanDeg'));
  const seated = seatPlacedPelvis(rig, seatTarget, pelvisRotation(rig, 0, 0, 0));
  const seatOff = seatPlacedPelvis(rig, seatTarget, pelvisRotation(rig, 0, trunkLean(maxLean).tilt, 0));
  const touchLean = 0.8 * maxLean;
  const touch = seatPlacedPelvis(rig, seatTarget, pelvisRotation(rig, 0, trunkLean(touchLean).tilt, 0));
  // Seated legs must reach the floor with the knee off full extension.
  const seatedLegs = evaluateLegs(rig, seated, pelvisRotation(rig, 0, 0, 0), targets);
  for (const s of SIDES)
    if (!seatedLegs[s].ik.reachable || seatedLegs[s].ik.kneeFlexion < deg(30))
      diagnostics.push(
        diag('UNSUPPORTED_CONFIGURATION', 'error', `seated ${s} foot cannot be placed flat on the floor (chair ${H} m too high for this rig)`, {
          path: 'params.chairHeight',
          hint: 'Lower the chair height.',
        }),
      );
  if (diagnostics.length) return { plan: null, diagnostics };

  const init = L.ankleHeight + 0.93 * (L.thigh + L.shank);
  const standZ = anchors.left.z + 0.02;
  const stand = solveKeyPose(rig, pelvisRotation(rig, 0, 0, 0), targets, [0, init, standZ], [1], [{ quantity: 'kneeFlexion', side: 'min', target: STANDING_KNEE }]);
  const midRiseLean = 0.75 * maxLean;
  const midRise = solveKeyPose(rig, pelvisRotation(rig, 0, trunkLean(midRiseLean).tilt, 0), targets, [0, lerp(seatOff[1], init, 0.5), lerp(seatOff[2], standZ, 0.75)], [1], [
    { quantity: 'kneeFlexion', side: 'mean', target: MID_KNEE },
  ]);
  const midDescLean = 0.75 * maxLean;
  const midDesc = solveKeyPose(rig, pelvisRotation(rig, 0, trunkLean(midDescLean).tilt, 0), targets, [0, lerp(touch[1], init, 0.5), lerp(standZ, touch[2], 0.35)], [1], [
    { quantity: 'kneeFlexion', side: 'mean', target: MID_KNEE },
  ]);
  for (const [name, r] of [['standing', stand], ['mid-rise', midRise], ['mid-descent', midDesc]] as const)
    if (!r.ok || !r.reachable) diagnostics.push(diag('KEYPOSE_UNSOLVED', 'error', `could not solve the ${name} key pose`, { hint: 'Parameters are inconsistent for this rig.' }));
  if (diagnostics.length) return { plan: null, diagnostics };

  const key = (t: number, mode: BodyKey['mode'], P: Vec3, lean: number, sh: number, el: number): BodyKey => ({
    t,
    mode,
    pelvis: P,
    rotation: 0,
    obliquity: 0,
    ...trunkLean(lean),
    arms: armsBoth(deg(sh), deg(el)),
  });

  const pb = new PhaseBuilder();
  const keys: BodyKey[] = [key(0, 'stop', seated, 0, 15, 70)];
  pb.add('seated', 'Seated', SEATED, 'Seated upright; seat and both feet in contact.', 'Phase marker: start (seated)');
  keys.push(key(pb.t, 'stop', seated, 0, 15, 70));
  pb.add('forward-lean', 'Forward lean', LEAN, 'Trunk inclines forward by pelvis tilt about the seat contact; seat contact held.', 'Phase marker: forward lean');
  const tOff = pb.t;
  keys.push(key(pb.t, 'stop', seatOff, maxLean, 75, 15));
  const rise = num(v, 'riseSeconds');
  pb.add('rise', 'Rise', rise, 'Seat contact released (blended); pelvis travels up and forward over the feet; trunk returns upright.', 'Phase marker: seat-off');
  keys.splice(keys.length, 0, key(tOff + rise * 0.45, 'flow', midRise.P, midRiseLean, 60, 15));
  keys.push(key(pb.t, 'stop', stand.P, 0, 5, 10));
  pb.add('stand', 'Stand', num(v, 'standHoldSeconds'), 'Standing; both feet flat.', 'Phase marker: standing');
  const tDescStart = pb.t;
  keys.push(key(pb.t, 'stop', stand.P, 0, 5, 10));
  const desc = num(v, 'descentSeconds');
  pb.add('descent', 'Descent', desc, 'Pelvis travels back and down toward the seat with trunk inclination; seat contact re-established (blended) at the end.', 'Phase marker: descent');
  keys.push(key(tDescStart + desc * 0.55, 'flow', midDesc.P, midDescLean, 55, 15));
  const tTouch = pb.t;
  keys.push(key(pb.t, 'stop', touch, touchLean, 70, 15));
  pb.add('settle', 'Settle', SETTLE, 'Seated; trunk returns upright by pelvis tilt about the seat contact.', 'Phase marker: seat contact');
  keys.push(key(pb.t, 'stop', seated, 0, 15, 70));
  pb.add('seated-end', 'Seated', END, 'Seated upright.');
  keys.push(key(pb.t, 'stop', seated, 0, 15, 70));

  const { pelvis, joints } = tracksFromKeys(keys, rig);
  const duration = pb.t;
  const plan = basePlan({
    duration,
    phases: pb.phases,
    cues: pb.cues,
    environment: floorEnvironment([
      { kind: 'chair', id: 'chair', seatHeight: H, seatDepth: CHAIR.seatDepth, seatWidth: CHAIR.seatWidth, seatThickness: CHAIR.seatThickness, frontZ: CHAIR.frontZ, centerX: 0, backrestHeight: CHAIR.backrestHeight },
    ]),
    pelvis,
    joints,
    feet: {
      left: [{ kind: 'flat', start: 0, end: duration, surface: 'floor', anchor: anchors.left }],
      right: [{ kind: 'flat', start: 0, end: duration, surface: 'floor', anchor: anchors.right }],
    },
    seat: {
      surface: 'chair.seat',
      target: seatTarget,
      // Release window [tOff, tOff + blend]; engage window [tTouch - blend, tTouch]: the seat
      // constraint is exact (weight 1) up to seat-off and from touch-down on.
      intervals: [
        { start: 0, end: tOff + SEAT_BLEND / 2, blendIn: 0, blendOut: SEAT_BLEND },
        { start: tTouch - SEAT_BLEND / 2, end: duration, blendIn: SEAT_BLEND, blendOut: 0 },
      ],
    },
    assumptions: [
      `Seated pose: seat site on the seat ${seatTarget[2].toFixed(3)} m from the front edge; knees ${KNEE_OVERHANG} m in front of the edge (authoring convention).`,
      'While seated the pelvis position is derived from the seat contact and pelvis tilt (rotation about the ischial contact point; no rolling).',
      `Seat contact is released over ${SEAT_BLEND} s after seat-off and re-engaged over ${SEAT_BLEND} s before touch-down (smootherstep blend).`,
      `Mid-rise and mid-descent keys solved for ${fmtDeg(MID_KNEE)} mean knee flexion; standing for ${fmtDeg(STANDING_KNEE)}.`,
      'Trunk inclination split: pelvis 55 %, lumbar 25 %, thoracic 20 %; neck counter-flexes 45 %.',
      'Arms reach forward during the transfer (authoring choice); no arm-rest or hand support.',
      'Kinematic demonstration only: no momentum, balance, load or muscle model.',
    ],
  });
  return { plan, diagnostics };
}

export const sitToStandRecipe: RecipeDefinition = {
  id: 'sit-to-stand.v1',
  version: '1.0.0',
  title: 'Sit-to-stand and return (synthetic fixture)',
  summary: 'Seated → forward lean with seat contact → seat-off → standing → controlled descent → seat contact → seated.',
  paramSpecs: SPECS,
  requiredCapabilities: ['root-translation', 'pelvis-rotation', 'trunk-articulation', 'independent-legs', 'knee-hinge', 'ankle-2dof'],
  setup: [
    `Synthetic chair: seat ${CHAIR.seatDepth} m deep × ${CHAIR.seatWidth} m wide, front edge at z = 0, backrest ${CHAIR.backrestHeight} m (visual/penetration only), no armrests.`,
    'Feet flat on the floor, symmetric about the midline, set back behind the knees by the foot setback.',
    'Start and end seated upright.',
  ],
  phaseOutline: [
    { id: 'seated', label: 'Seated', description: 'Seat + both feet in contact.' },
    { id: 'forward-lean', label: 'Forward lean', description: 'Trunk inclines; seat contact held.' },
    { id: 'rise', label: 'Rise', description: 'Seat-off; pelvis up and forward.' },
    { id: 'stand', label: 'Stand', description: 'Standing hold.' },
    { id: 'descent', label: 'Descent', description: 'Pelvis back and down; seat contact re-established.' },
    { id: 'settle', label: 'Settle', description: 'Trunk returns upright on the seat.' },
  ],
  contactChanges: [
    'Seat-off (end of forward lean): seat position contact releases over a 0.3 s blend while both feet stay planted.',
    'Touch-down (end of descent): seat position contact engages over a 0.3 s blend.',
    'Both feet: heel, ball and toe position contacts and foot-orientation contacts are held for the whole clip.',
  ],
  unsupported: [
    'Arm-rest or hand push-off, assistance, or walking aids.',
    'Split-stance or single-leg sit-to-stand; feet moving during the transfer.',
    'Chair heights outside 0.40–0.55 m, or heights this rig cannot reach with feet flat.',
    'Reclined backrests, soft or sloped seats, rocking chairs.',
    'Momentum or balance modelling (kinematic only).',
  ],
  assumptions: ['Synthetic engineering fixture requiring clinical review; not a prescription or instruction.'],
  defaults: () => defaultsOf(SPECS),
  compile(params, rig) {
    return compileWith(this, params, rig, build);
  },
};
