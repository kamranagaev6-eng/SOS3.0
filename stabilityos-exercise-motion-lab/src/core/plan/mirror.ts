import type { Environment } from '../contracts/environment.ts';
import type { FootState, MotionPlan, Track } from '../contracts/plan.ts';

const negate = (tr: Track): Track => ({ keys: tr.keys.map((k) => ({ ...k, v: -k.v })) });

function swapSideName(name: string): string {
  if (name.endsWith('_L')) return `${name.slice(0, -2)}_R`;
  if (name.endsWith('_R')) return `${name.slice(0, -2)}_L`;
  return name;
}

function mirrorFoot(s: FootState): FootState {
  if (s.kind === 'swing') return { ...s };
  return { ...s, anchor: { x: -s.anchor.x, z: s.anchor.z, yaw: -s.anchor.yaw } };
}

function mirrorEnvironment(env: Environment): Environment {
  return {
    ...env,
    objects: env.objects.map((o) => (o.kind === 'floor' ? { ...o } : { ...o, centerX: -o.centerX })),
  };
}

/**
 * Mirror a plan across the sagittal (YZ) plane: left and right swap, x → -x, and rotations about
 * Y and Z change sign (rotation axes are pseudovectors). Limb DOF values keep their meaning
 * because the rig's right-side axes are already mirrored. Used to verify left/right symmetry:
 * sampling mirror(plan) on a mirrored rig must equal the mirror image of sampling plan.
 */
export function mirrorPlan(plan: MotionPlan, mirroredRigFingerprint: string): MotionPlan {
  const joints: MotionPlan['joints'] = {};
  for (const [name, dofs] of Object.entries(plan.joints)) {
    const target = swapSideName(name);
    const center = target === name;
    const out: Record<string, Track> = {};
    for (const [dof, tr] of Object.entries(dofs)) {
      const flips = center && (dof === 'lateralFlexion' || dof === 'axialRotation');
      out[dof] = flips ? negate(tr) : structuredClone(tr);
    }
    joints[target] = out;
  }
  const params = { ...plan.recipe.params };
  for (const [k, v] of Object.entries(params)) if (v === 'left' || v === 'right') params[k] = v === 'left' ? 'right' : 'left';
  return {
    ...structuredClone(plan),
    recipe: { ...plan.recipe, params },
    rig: { ...plan.rig, fingerprint: mirroredRigFingerprint },
    environment: mirrorEnvironment(plan.environment),
    pelvis: {
      x: negate(plan.pelvis.x),
      y: structuredClone(plan.pelvis.y),
      z: structuredClone(plan.pelvis.z),
      rotation: negate(plan.pelvis.rotation),
      tilt: structuredClone(plan.pelvis.tilt),
      obliquity: negate(plan.pelvis.obliquity),
    },
    joints,
    feet: { left: plan.feet.right.map(mirrorFoot), right: plan.feet.left.map(mirrorFoot) },
    seat: plan.seat ? { ...structuredClone(plan.seat), target: [-plan.seat.target[0], plan.seat.target[1], plan.seat.target[2]] } : null,
  };
}
