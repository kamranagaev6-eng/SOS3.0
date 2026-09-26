import { otherSide, SIDES, type Side } from '../contracts/common.ts';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import type { FootAnchor, FootState, SwingState } from '../contracts/plan.ts';
import type { ParamSpec } from '../contracts/recipe.ts';
import type { RigDefinition } from '../contracts/rig.ts';
import { deg } from '../math/curves.ts';
import type { Vec3 } from '../math/vec3.ts';
import { flatPose, footGeom, forefootPose } from '../solver/footPose.ts';
import { evaluateLegs, solveKeyPose } from '../solver/keyPose.ts';
import type { FootTarget } from '../solver/types.ts';
import {
  basePlan,
  compileWith,
  defaultsOf,
  floorEnvironment,
  fmtDeg,
  num,
  pelvisRotation,
  PhaseBuilder,
  str,
  tracksFromKeys,
  trunkLean,
  type ArmPose,
  type BodyKey,
  type Values,
} from './common.ts';
import { STANDING_KNEE } from './squat.ts';
import type { RecipeDefinition } from './types.ts';

const SPECS: readonly ParamSpec[] = [
  { key: 'stepHeight', label: 'Step height', kind: 'number', unit: 'm', min: 0.08, max: 0.22, step: 0.01, default: 0.15, description: 'Height of the step top above the floor.' },
  { key: 'stepDepth', label: 'Step tread depth', kind: 'number', unit: 'm', min: 0.3, max: 0.45, step: 0.01, default: 0.36, description: 'Tread depth along the walking direction.' },
  { key: 'upLeadSide', label: 'Leading side (up)', kind: 'enum', options: ['left', 'right'], default: 'left', description: 'Foot that steps up first.' },
  { key: 'downLeadSide', label: 'Leading side (down)', kind: 'enum', options: ['left', 'right'], default: 'left', description: 'Foot that steps down first (backward to the floor).' },
  { key: 'startDistance', label: 'Toe-to-riser distance', kind: 'number', unit: 'm', min: 0.05, max: 0.2, step: 0.01, default: 0.1, description: 'Gap between toe tips and the riser at the start.' },
  { key: 'stanceWidth', label: 'Stance width (ankle centres)', kind: 'number', unit: 'm', min: 0.16, max: 0.3, step: 0.01, default: 0.22, description: 'Distance between ankle joint centres.' },
  { key: 'tempo', label: 'Tempo scale', kind: 'number', unit: 'ratio', min: 0.7, max: 1.6, step: 0.05, default: 1, description: 'Multiplies every phase duration (1 = reference timing).' },
];

const STEP_WIDTH = 0.8;
/** Heel contact point this far onto the tread from the nosing. */
const HEEL_MARGIN = 0.05;
const TOE_OFF_LIFT = 0.07;
const LANDING_LIFT = 0.045;
/** Stance-ankle dorsiflexion cap at toe-off and at step-down touch (authoring choice, below the rig limit). */
const TOE_OFF_MAX_DORSI = deg(26);
/** Forward pelvis travel during the lead swing (m). */
const LEAD_SWING_TRAVEL = 0.1;

function swing(start: number, end: number, s: Omit<SwingState, 'kind' | 'start' | 'end'>): FootState {
  return { kind: 'swing', start, end, ...s };
}

const UP_SWING = { clearance: 0.05, horizontalDelay: 0.25, horizontalLead: 0, riseEnd: 0.5, descendStart: 0.62 };
const TRAIL_UP_SWING = { clearance: 0.06, horizontalDelay: 0.22, horizontalLead: 0, riseEnd: 0.48, descendStart: 0.62 };
const DOWN_SWING = { clearance: 0.045, horizontalDelay: 0.05, horizontalLead: 0.3, riseEnd: 0.2, descendStart: 0.6 };

function build(v: Values, rig: RigDefinition) {
  const diagnostics: Diagnostic[] = [];
  const H = num(v, 'stepHeight');
  const Dp = num(v, 'stepDepth');
  const A = str(v, 'upLeadSide') as Side;
  const B = otherSide(A);
  const D = str(v, 'downLeadSide') as Side;
  const S = otherSide(D);
  const w = num(v, 'stanceWidth');
  const k = num(v, 'tempo');
  const legs = rig.proportions;
  for (const side of SIDES) {
    const L = legs[side].leg;
    const toeTip = HEEL_MARGIN + L.heelBack + L.footLength + L.toeLength;
    if (toeTip > Dp - 0.01)
      diagnostics.push(
        diag('UNSUPPORTED_CONFIGURATION', 'error', `step tread ${Dp} m is too shallow for the ${side} foot (${(toeTip + 0.01).toFixed(3)} m needed)`, {
          path: 'params.stepDepth',
          hint: 'Increase tread depth; feet must be fully supported by the step.',
        }),
      );
  }
  if (diagnostics.length) return { plan: null, diagnostics };

  const x = (side: Side): number => (side === 'left' ? w / 2 : -w / 2);
  const floorAnchor = (side: Side): FootAnchor => {
    const L = legs[side].leg;
    return { x: x(side), z: -num(v, 'startDistance') - (L.footLength + L.toeLength), yaw: 0 };
  };
  const stepAnchor = (side: Side): FootAnchor => ({ x: x(side), z: HEEL_MARGIN + legs[side].leg.heelBack, yaw: 0 });
  const g = { left: footGeom(rig, 'left'), right: footGeom(rig, 'right') };
  const flatF = (side: Side): FootTarget => flatPose(side, floorAnchor(side), 0, 'floor', g[side]);
  const flatS = (side: Side): FootTarget => flatPose(side, stepAnchor(side), H, 'step.top', g[side]);
  const foreF = (side: Side, h: number): FootTarget => forefootPose(side, floorAnchor(side), 0, 'floor', g[side], h);
  const pair = (a: Side, ta: FootTarget, tb: FootTarget): Record<Side, FootTarget> =>
    (a === 'left' ? { left: ta, right: tb } : { left: tb, right: ta }) as Record<Side, FootTarget>;

  const Lr = legs.left.leg;
  const yInit = Lr.ankleHeight + 0.93 * (Lr.thigh + Lr.shank);
  const rot = (lean: number) => pelvisRotation(rig, 0, trunkLean(lean).tilt, 0);
  const solve = (name: string, targets: Record<Side, FootTarget>, px: number, pz: number, y0: number, lean: number, side: Side | 'mean' | 'min', knee: number): Vec3 => {
    const r = solveKeyPose(rig, rot(lean), targets, [px, y0, pz], [1], [{ quantity: 'kneeFlexion', side, target: knee }]);
    if (!r.ok || !r.reachable)
      diagnostics.push(
        diag('KEYPOSE_UNSOLVED', 'error', `could not solve the '${name}' key pose (residual ${r.residual.toExponential(2)})`, {
          hint: 'Step height / distances are geometrically inconsistent for this rig.',
        }),
      );
    return r.P;
  };
  const zFloor = (floorAnchor('left').z + floorAnchor('right').z) / 2;
  const zStep = (stepAnchor('left').z + stepAnchor('right').z) / 2;
  const floorBoth = { left: flatF('left'), right: flatF('right') };
  const stepBoth = { left: flatS('left'), right: flatS('right') };

  const P_stand = solve('stand-floor', floorBoth, 0, zFloor + 0.02, yInit, 0, 'min', STANDING_KNEE);
  const P_shift = solve('weight-shift', floorBoth, 0.5 * x(B), zFloor + 0.02, yInit, 0, A, STANDING_KNEE);
  // During the lead swing the pelvis travels forward over the trailing foot's forefoot so the
  // leading shank is not steeply inclined when the foot lands on the step.
  const P_leadLand = solve('lead-landing', pair(A, flatS(A), flatF(B)), 0.35 * x(B), zFloor + 0.02 + LEAD_SWING_TRAVEL, yInit, deg(4), B, deg(8));
  const riseLean = deg(10);
  let P_toeOff = solve('toe-off', pair(A, flatS(A), foreF(B, TOE_OFF_LIFT)), 0.6 * x(A), stepAnchor(A).z - 0.08, yInit + H * 0.5, riseLean, B, deg(8));
  {
    // If the leading ankle would need more than TOE_OFF_MAX_DORSI with the default pelvis placement,
    // move the pelvis back and down (solve y, z) so it needs exactly that — explicit, at compile time.
    const toeOffTargets = pair(A, flatS(A), foreF(B, TOE_OFF_LIFT));
    const legsAt = evaluateLegs(rig, P_toeOff, rot(riseLean), toeOffTargets);
    if (legsAt[A].angles.ankle[0]! > TOE_OFF_MAX_DORSI) {
      const r = solveKeyPose(rig, rot(riseLean), toeOffTargets, P_toeOff, [1, 2], [
        { quantity: 'kneeFlexion', side: B, target: deg(8) },
        { quantity: 'ankleDorsiflexion', side: A, target: TOE_OFF_MAX_DORSI },
      ]);
      if (!r.ok || !r.reachable)
        diagnostics.push(
          diag('UNSUPPORTED_CONFIGURATION', 'error', `toe-off pose needs more than ${fmtDeg(TOE_OFF_MAX_DORSI)} ${A} ankle dorsiflexion while the ${B} forefoot is still on the floor`, {
            path: 'params.stepHeight',
            hint: 'Lower the step or reduce the toe-to-riser distance for this rig.',
          }),
        );
      else P_toeOff = r.P;
    }
  }
  const P_top = solve('stand-step', stepBoth, 0, zStep + 0.02, yInit + H, 0, 'min', STANDING_KNEE);
  const P_lowShift = solve('lower-shift', stepBoth, 0.5 * x(S), zStep + 0.02, yInit + H, 0, D, STANDING_KNEE);
  const lowerLean = deg(8);
  let P_touch = solve('down-touch', pair(D, foreF(D, LANDING_LIFT), flatS(S)), 0.6 * x(S), stepAnchor(S).z - 0.1, yInit, lowerLean, D, deg(10));
  {
    // Same compile-time rule as toe-off: if the stance ankle on the step would exceed the cap while
    // the lowering foot reaches the floor, move the pelvis back and down so it needs exactly the cap.
    const touchTargets = pair(D, foreF(D, LANDING_LIFT), flatS(S));
    const legsAt = evaluateLegs(rig, P_touch, rot(lowerLean), touchTargets);
    if (legsAt[S].angles.ankle[0]! > TOE_OFF_MAX_DORSI) {
      const r = solveKeyPose(rig, rot(lowerLean), touchTargets, P_touch, [1, 2], [
        { quantity: 'kneeFlexion', side: D, target: deg(10) },
        { quantity: 'ankleDorsiflexion', side: S, target: TOE_OFF_MAX_DORSI },
      ]);
      if (!r.ok || !r.reachable)
        diagnostics.push(
          diag('UNSUPPORTED_CONFIGURATION', 'error', `controlled lowering needs more than ${fmtDeg(TOE_OFF_MAX_DORSI)} ${S} ankle dorsiflexion on the step for the ${D} foot to reach the floor`, {
            path: 'params.stepHeight',
            hint: 'Lower the step or reduce the toe-to-riser distance for this rig.',
          }),
        );
      else P_touch = r.P;
    }
  }
  const P_accept = solve('weight-accept', pair(D, flatF(D), flatS(S)), 0.2 * x(S), (stepAnchor(S).z + floorAnchor(D).z) / 2, yInit, deg(4), D, deg(15));
  const P_transfer = solve('transfer-back', pair(D, flatF(D), flatS(S)), 0.5 * x(D), floorAnchor(D).z + 0.05, yInit, 0, D, STANDING_KNEE);
  const P_end = solve('stand-floor-end', floorBoth, 0, zFloor + 0.02, yInit, 0, 'min', STANDING_KNEE);
  if (diagnostics.length) return { plan: null, diagnostics };

  const armsSwing = (forward: Side, amount: number): Record<Side, ArmPose> => {
    const f: ArmPose = { shoulder: [deg(amount), deg(8), 0], elbow: deg(15) };
    const b: ArmPose = { shoulder: [deg(-amount / 2), deg(8), 0], elbow: deg(10) };
    return (forward === 'left' ? { left: f, right: b } : { left: b, right: f }) as Record<Side, ArmPose>;
  };
  const neutralArms = armsSwing('left', 0);
  const key = (t: number, P: Vec3, lean: number, arms: Record<Side, ArmPose>, mode: BodyKey['mode'] = 'stop'): BodyKey => ({
    t,
    mode,
    pelvis: P,
    rotation: 0,
    obliquity: 0,
    ...trunkLean(lean),
    arms,
  });

  const pb = new PhaseBuilder();
  const keys: BodyKey[] = [key(0, P_stand, 0, neutralArms)];
  const feet: Record<Side, FootState[]> = { left: [], right: [] };

  pb.add('stand', 'Stand', 1.0 * k, 'Standing on the floor behind the step.', 'Phase marker: start');
  keys.push(key(pb.t, P_stand, 0, neutralArms));
  pb.add('weight-shift', 'Weight shift', 0.6 * k, `Pelvis shifts toward the ${B} (trailing) foot.`);
  keys.push(key(pb.t, P_shift, 0, neutralArms));
  const tLiftA = pb.t;
  pb.add('lead-swing', `Lead swing (${A})`, 0.9 * k, `${A} foot lifts and is placed flat on the step.`, `Phase marker: ${A} foot up`);
  const tLandA = pb.t;
  keys.push(key(pb.t, P_leadLand, deg(4), armsSwing(B, 12)));
  pb.add('rise', 'Rise', 1.3 * k, `Pelvis moves forward and up over the ${A} foot; ${B} heel lifts, then ${B} toes leave the floor.`, 'Phase marker: rise');
  const tToeOff = pb.t;
  const tHeelOffB = tLandA + 0.15 * (tToeOff - tLandA);
  keys.push(key(pb.t, P_toeOff, riseLean, armsSwing(B, 18)));
  pb.add('trail-swing', `Trail swing (${B})`, 1.0 * k, `${B} foot swings up and is placed flat beside the ${A} foot; body rises to standing.`, `Phase marker: ${B} foot up`);
  const tLandB = pb.t;
  keys.push(key(pb.t, P_top, 0, neutralArms));
  pb.add('top', 'Stand on step', 1.0 * k, 'Standing on the step, both feet flat.', 'Phase marker: on step');
  keys.push(key(pb.t, P_top, 0, neutralArms));
  pb.add('lower-shift', 'Weight shift', 0.6 * k, `Pelvis shifts toward the ${S} (stance) foot.`);
  keys.push(key(pb.t, P_lowShift, 0, neutralArms));
  const tLiftD = pb.t;
  pb.add('lower', `Controlled lowering (${D})`, 1.4 * k, `${S} knee flexes to lower the body while the ${D} foot moves back and down, landing toes first.`, `Phase marker: ${D} foot down`);
  const tTouchD = pb.t;
  keys.push(key(pb.t, P_touch, lowerLean, armsSwing(S, 12)));
  pb.add('weight-accept', 'Heel down', 0.7 * k, `${D} heel lowers to the floor; pelvis moves back between the feet.`);
  const tFlatD = pb.t;
  keys.push(key(pb.t, P_accept, deg(4), armsSwing(S, 6), 'flow'));
  pb.add('transfer-back', 'Transfer back', 0.6 * k, `Pelvis moves over the ${D} foot.`);
  const tLiftS = pb.t;
  keys.push(key(pb.t, P_transfer, 0, neutralArms));
  pb.add('trail-down', `Trail down (${S})`, 0.9 * k, `${S} foot steps down beside the ${D} foot.`, `Phase marker: ${S} foot down`);
  const tLandS = pb.t;
  keys.push(key(pb.t, P_end, 0, neutralArms));
  pb.add('stand-end', 'Stand', 0.8 * k, 'Standing on the floor.');
  const T = pb.t;
  keys.push(key(T, P_end, 0, neutralArms));

  // Foot state sequences (explicit contact changes).
  feet[A].push({ kind: 'flat', start: 0, end: tLiftA, surface: 'floor', anchor: floorAnchor(A) });
  feet[A].push(swing(tLiftA, tLandA, UP_SWING));
  feet[B].push({ kind: 'flat', start: 0, end: tHeelOffB, surface: 'floor', anchor: floorAnchor(B) });
  feet[B].push({
    kind: 'forefoot',
    start: tHeelOffB,
    end: tToeOff,
    surface: 'floor',
    anchor: floorAnchor(B),
    heelLift: { keys: [{ t: tHeelOffB, v: 0, mode: 'stop' }, { t: tToeOff, v: TOE_OFF_LIFT, mode: 'stop' }] },
  });
  feet[B].push(swing(tToeOff, tLandB, TRAIL_UP_SWING));
  // Up-lead foot is on the step from tLandA; trailing foot from tLandB. Both stay until their down swing.
  const onStep = (side: Side, from: number, until: number) => feet[side].push({ kind: 'flat', start: from, end: until, surface: 'step.top', anchor: stepAnchor(side) });
  const downSwingStart = (side: Side) => (side === D ? tLiftD : tLiftS);
  onStep(A, tLandA, downSwingStart(A));
  onStep(B, tLandB, downSwingStart(B));
  feet[D].push(swing(tLiftD, tTouchD, DOWN_SWING));
  feet[D].push({
    kind: 'forefoot',
    start: tTouchD,
    end: tFlatD,
    surface: 'floor',
    anchor: floorAnchor(D),
    heelLift: { keys: [{ t: tTouchD, v: LANDING_LIFT, mode: 'stop' }, { t: tFlatD, v: 0, mode: 'stop' }] },
  });
  feet[D].push({ kind: 'flat', start: tFlatD, end: T, surface: 'floor', anchor: floorAnchor(D) });
  feet[S].push(swing(tLiftS, tLandS, DOWN_SWING));
  feet[S].push({ kind: 'flat', start: tLandS, end: T, surface: 'floor', anchor: floorAnchor(S) });

  const { pelvis, joints } = tracksFromKeys(keys);
  const plan = basePlan({
    duration: T,
    phases: pb.phases,
    cues: pb.cues,
    environment: floorEnvironment([{ kind: 'step', id: 'step', height: H, depth: Dp, width: STEP_WIDTH, frontZ: 0, centerX: 0 }]),
    pelvis,
    joints,
    feet,
    seat: null,
    assumptions: [
      `Up-leading side ${A}; down-leading side ${D} (explicit parameters, never inferred).`,
      `Feet on the tread: heel ${HEEL_MARGIN} m onto the tread from the nosing; start with toes ${num(v, 'startDistance')} m from the riser.`,
      `Trailing heel lifts to ${TOE_OFF_LIFT} m before toe-off; the lowering foot lands toes first with the heel ${LANDING_LIFT} m up, then lowers.`,
      `Key poses: toe-off solved for 8° trailing knee flexion; step-down touch solved for 10° knee flexion of the lowering leg; standing keys for ${fmtDeg(STANDING_KNEE)}.`,
      'Swing paths lift first, then travel, then settle (C2 windows); clearance is checked against the step geometry at compile time.',
      'Arm swing is a small authored counter-swing, not a gait model. Kinematic only: no balance, load or muscle model.',
    ],
  });
  return { plan, diagnostics };
}

export const stepUpDownRecipe: RecipeDefinition = {
  id: 'step-up-down.v1',
  version: '1.0.0',
  title: 'Step-up and controlled step-down (synthetic fixture)',
  summary: 'Forward step-up with an explicit leading side, standing on the step, controlled backward step-down with an explicit leading side.',
  paramSpecs: SPECS,
  requiredCapabilities: ['root-translation', 'pelvis-rotation', 'trunk-articulation', 'independent-legs', 'knee-hinge', 'ankle-2dof', 'forefoot-articulation'],
  setup: [
    `Synthetic step box ${STEP_WIDTH} m wide, riser at z = 0, tread extending toward +Z by the tread depth.`,
    'Start standing on the floor behind the step, toes at the toe-to-riser distance.',
    'Both feet are placed fully on the tread (heel 5 cm onto it); end standing back at the start position.',
  ],
  phaseOutline: [
    { id: 'stand', label: 'Stand', description: 'Floor.' },
    { id: 'weight-shift', label: 'Weight shift', description: 'Toward trailing foot.' },
    { id: 'lead-swing', label: 'Lead swing', description: 'Leading foot onto the step.' },
    { id: 'rise', label: 'Rise', description: 'Body over the leading foot; trailing heel-off then toe-off.' },
    { id: 'trail-swing', label: 'Trail swing', description: 'Trailing foot onto the step.' },
    { id: 'top', label: 'Stand on step', description: 'Both feet on the step.' },
    { id: 'lower-shift', label: 'Weight shift', description: 'Toward the stance foot.' },
    { id: 'lower', label: 'Controlled lowering', description: 'Stance knee flexes; lowering foot moves back and down, toes first.' },
    { id: 'weight-accept', label: 'Heel down', description: 'Lowering foot becomes flat.' },
    { id: 'transfer-back', label: 'Transfer back', description: 'Pelvis over the floor foot.' },
    { id: 'trail-down', label: 'Trail down', description: 'Other foot steps down.' },
    { id: 'stand-end', label: 'Stand', description: 'Floor.' },
  ],
  contactChanges: [
    'Lead lift: leading foot floor contacts end; swing; flat contacts with the step top begin on landing.',
    'Trailing heel-off during the rise: heel contact ends, ball/toe stay on the floor (forefoot), toe-off ends them.',
    'Trailing landing: flat contacts with the step top.',
    'Controlled lowering: lowering foot leaves the step, lands on the floor ball/toe first (forefoot), then heel (flat).',
    'Trail down: remaining foot leaves the step and lands flat on the floor.',
  ],
  unsupported: [
    'Step heights outside 0.08–0.22 m, or heights this rig cannot lower from with the stance foot flat.',
    'Treads too shallow for full-foot support; stepping onto the nosing.',
    'Lateral or crossover step-ups, step-throughs, stairs with multiple steps, continuous alternating repetitions.',
    'Hand rails, hand support, walking aids.',
    'Toe-out on this recipe (feet point straight ahead).',
  ],
  assumptions: ['Synthetic engineering fixture requiring clinical review; not a prescription or instruction.'],
  defaults: () => defaultsOf(SPECS),
  compile(params, rig) {
    return compileWith(this, params, rig, build);
  },
};
