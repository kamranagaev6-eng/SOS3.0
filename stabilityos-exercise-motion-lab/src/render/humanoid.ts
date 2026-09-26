import * as THREE from 'three';
import type { Side } from '../core/contracts/common.ts';
import type { JointSpec, LegProportions, RigDefinition } from '../core/contracts/rig.ts';
import type { Quat } from '../core/math/quat.ts';
import type { Vec3 } from '../core/math/vec3.ts';
import { taperedBox, taperedCapsule } from './geometry.ts';
import { PALETTE } from './palette.ts';
import type { ResourceTracker } from './resources.ts';

/**
 * Original stylised synthetic humanoid built procedurally from a canonical rig definition:
 * rigid segment meshes attached to one Object3D per joint. Each node receives the solver's world
 * transform directly (`sample.worldPos/worldRot`), so there is no skinning and no hierarchy to
 * keep in sync. Segment geometry is expressed in the joint's rest frame (canonical rest frames are
 * world-aligned), from the joint origin to its child's rest offset.
 */
export interface HumanoidView {
  readonly group: THREE.Group;
  readonly nodes: readonly THREE.Object3D[];
  readonly meshCount: number;
  applyPose(worldPos: readonly Vec3[], worldRot: readonly Quat[]): void;
  setHighlight(side: Side | null): void;
}

type MaterialKey = 'body' | 'head' | 'face' | 'left' | 'right' | 'leftToe' | 'rightToe';

const BASE_COLOURS: Record<MaterialKey, number> = {
  body: PALETTE.body,
  head: PALETTE.head,
  face: PALETTE.face,
  left: PALETTE.left,
  right: PALETTE.right,
  leftToe: PALETTE.leftToe,
  rightToe: PALETTE.rightToe,
};

function roleOf(j: JointSpec): string {
  return j.name.replace(/_[LR]$/, '');
}

export function buildHumanoid(rig: RigDefinition, tracker: ResourceTracker, name = 'humanoid'): HumanoidView {
  const group = new THREE.Group();
  group.name = name;
  const materials = {} as Record<MaterialKey, THREE.MeshStandardMaterial>;
  for (const key of Object.keys(BASE_COLOURS) as MaterialKey[]) {
    materials[key] = tracker.track(
      new THREE.MeshStandardMaterial({ color: BASE_COLOURS[key], roughness: key === 'face' ? 0.4 : 0.62, metalness: 0 }),
    );
    materials[key].name = `${name}:${key}`;
  }
  const byName = new Map(rig.joints.map((j, i) => [j.name, i] as const));
  const children = rig.joints.map(() => [] as number[]);
  rig.joints.forEach((j, i) => {
    if (j.parent !== null) {
      const p = byName.get(j.parent);
      if (p !== undefined) children[p]!.push(i);
    }
  });
  const vr = (jointName: string, fallback: number): number => rig.visualRadius[jointName] ?? fallback;
  const P = rig.proportions;
  let meshCount = 0;

  const nodes: THREE.Object3D[] = rig.joints.map((j) => {
    const node = new THREE.Object3D();
    node.name = `${name}:${j.name}`;
    node.matrixAutoUpdate = true;
    group.add(node);
    return node;
  });

  const add = (jointIndex: number, geometry: THREE.BufferGeometry, mat: MaterialKey, label: string): void => {
    const mesh = new THREE.Mesh(tracker.track(geometry), materials[mat]);
    mesh.name = `${name}:${label}`;
    nodes[jointIndex]!.add(mesh);
    meshCount++;
  };

  const childOffset = (i: number, childRole: string): Vec3 | null => {
    for (const c of children[i]!) {
      if (roleOf(rig.joints[c]!) === childRole) return rig.joints[c]!.offset as Vec3;
    }
    return null;
  };
  const sideMat = (j: JointSpec): MaterialKey => (j.side === 'left' ? 'left' : j.side === 'right' ? 'right' : 'body');
  const legOf = (j: JointSpec): LegProportions | null =>
    j.side === 'left' ? P.left.leg : j.side === 'right' ? P.right.leg : null;

  rig.joints.forEach((j, i) => {
    const role = roleOf(j);
    switch (role) {
      case 'root':
        return;
      case 'pelvis': {
        const hw = P.pelvis.hipHalfWidth;
        const r = vr('pelvis', 0.12) * 0.72;
        add(i, taperedCapsule([-hw, -0.012, -0.005], [hw, -0.012, -0.005], r, r, [1, 0.85]), 'body', 'pelvis');
        const lumbarBase = childOffset(i, 'lumbar');
        if (lumbarBase) add(i, taperedCapsule([0, 0, -0.01], [0, lumbarBase[1] * 0.9, -0.01], r * 1.05, vr('lumbar', 0.11) * 0.9, [1.25, 0.8]), 'body', 'pelvis-upper');
        return;
      }
      case 'lumbar': {
        const top = childOffset(i, 'thoracic') ?? [0, P.trunk.lumbar, 0];
        add(i, taperedCapsule([0, 0, 0], top, vr('lumbar', 0.11) * 0.92, vr('lumbar', 0.11) * 0.98, [1.15, 0.75]), 'body', 'lumbar');
        return;
      }
      case 'thoracic': {
        const neck = childOffset(i, 'neck') ?? [0, P.trunk.thoracic, 0];
        const chestR = vr('thoracic', 0.14);
        add(i, taperedCapsule([0, 0.03, 0], [0, neck[1] - P.trunk.shoulderDrop - 0.02, 0], chestR * 0.8, chestR * 0.92, [1.22, 0.7]), 'body', 'chest');
        const sl = childOffset(i, 'shoulder');
        const shL = rig.joints.find((x) => x.name === 'shoulder_L')?.offset;
        const shR = rig.joints.find((x) => x.name === 'shoulder_R')?.offset;
        if (sl && shL && shR) add(i, taperedCapsule(shR as Vec3, shL as Vec3, 0.052, 0.052, [1, 0.9]), 'body', 'shoulders');
        return;
      }
      case 'neck': {
        const neckLen = P.trunk.neck;
        const head = P.trunk.head;
        add(i, taperedCapsule([0, 0, 0], [0, neckLen, 0.005], 0.045, 0.042), 'body', 'neck');
        const hg = new THREE.SphereGeometry(head * 0.5, 24, 16);
        hg.scale(0.82, 1.02, 0.95);
        hg.translate(0, neckLen + head * 0.5, 0.012);
        add(i, hg, 'head', 'head');
        // Visor on the face (+Z) so the facing direction is readable from any view.
        const visor = taperedBox({
          z0: head * 0.5 * 0.95 - 0.028,
          z1: head * 0.5 * 0.95 + 0.012,
          bottomY: neckLen + head * 0.5 - 0.005,
          topAt0: neckLen + head * 0.5 + 0.03,
          topAt1: neckLen + head * 0.5 + 0.024,
          w0: head * 0.62,
          w1: head * 0.5,
        });
        add(i, visor, 'face', 'visor');
        return;
      }
      case 'shoulder': {
        const elbow = childOffset(i, 'elbow');
        if (elbow) add(i, taperedCapsule([0, 0, 0], elbow, vr(j.name, 0.045) * 1.05, vr(j.name.replace('shoulder', 'elbow'), 0.038)), sideMat(j), 'upper-arm');
        return;
      }
      case 'elbow': {
        const wrist = childOffset(i, 'wrist');
        if (wrist) add(i, taperedCapsule([0, 0, 0], wrist, vr(j.name, 0.038) * 0.95, vr(j.name.replace('elbow', 'wrist'), 0.032) * 0.95), sideMat(j), 'forearm');
        return;
      }
      case 'wrist': {
        const arm = j.side === 'right' ? P.right.arm : P.left.arm;
        add(i, taperedCapsule([0, -0.01, 0], [0, -arm.hand * 0.82, 0.004], 0.034, 0.028, [0.55, 1]), sideMat(j), 'hand');
        return;
      }
      case 'hip': {
        const knee = childOffset(i, 'knee');
        if (knee) add(i, taperedCapsule([0, 0, 0], knee, vr(j.name, 0.07), vr(j.name.replace('hip', 'knee'), 0.052)), sideMat(j), 'thigh');
        return;
      }
      case 'knee': {
        const ankle = childOffset(i, 'ankle');
        if (ankle) add(i, taperedCapsule([0, 0, 0], ankle, vr(j.name, 0.052) * 0.98, vr(j.name.replace('knee', 'ankle'), 0.042) * 0.9), sideMat(j), 'shank');
        return;
      }
      case 'ankle': {
        const L = legOf(j);
        if (!L) return;
        const mtp = childOffset(i, 'mtp') ?? [0, -(L.ankleHeight - L.mtpHeight), L.footLength];
        const sole = -L.ankleHeight;
        add(
          i,
          taperedBox({
            z0: -L.heelBack,
            z1: mtp[2] - 0.004,
            bottomY: sole,
            topAt0: sole + L.ankleHeight * 1.05,
            topAt1: sole + L.mtpHeight * 2.05,
            w0: L.footWidth * 0.72,
            w1: L.footWidth,
            centerX: mtp[0],
          }),
          sideMat(j),
          'foot',
        );
        return;
      }
      case 'mtp': {
        const L = legOf(j);
        if (!L) return;
        add(
          i,
          taperedBox({
            z0: 0.003,
            z1: L.toeLength,
            bottomY: -L.mtpHeight,
            topAt0: L.mtpHeight * 0.95,
            topAt1: L.mtpHeight * 0.35,
            w0: L.footWidth * 0.97,
            w1: L.footWidth * 0.78,
          }),
          j.side === 'right' ? 'rightToe' : 'leftToe',
          'toes',
        );
        return;
      }
      default: {
        // Unknown joint: draw a plain link to each child so nothing silently disappears.
        for (const c of children[i]!) {
          const off = rig.joints[c]!.offset as Vec3;
          add(i, taperedCapsule([0, 0, 0], off, 0.03, 0.03), sideMat(j), `link-${rig.joints[c]!.name}`);
        }
      }
    }
  });

  let highlight: Side | null = null;
  const applyHighlight = (): void => {
    const tint = new THREE.Color();
    for (const key of Object.keys(materials) as MaterialKey[]) {
      const m = materials[key];
      const side: Side | null = key.startsWith('left') ? 'left' : key.startsWith('right') ? 'right' : null;
      m.color.setHex(BASE_COLOURS[key]);
      m.emissive.setHex(0x000000);
      if (highlight && side) {
        if (side === highlight) {
          m.emissive.setHex(BASE_COLOURS[key]).multiplyScalar(0.28);
        } else {
          tint.setHex(PALETTE.dimmed);
          m.color.lerp(tint, 0.6);
        }
      } else if (highlight && key !== 'face') {
        tint.setHex(PALETTE.dimmed);
        m.color.lerp(tint, 0.25);
      }
      m.needsUpdate = false;
    }
  };

  return {
    group,
    nodes,
    meshCount,
    applyPose(worldPos, worldRot) {
      for (let i = 0; i < nodes.length; i++) {
        const p = worldPos[i];
        const q = worldRot[i];
        const node = nodes[i]!;
        if (p) node.position.set(p[0], p[1], p[2]);
        if (q) node.quaternion.set(q[0], q[1], q[2], q[3]);
      }
    },
    setHighlight(side) {
      if (side === highlight) return;
      highlight = side;
      applyHighlight();
    },
  };
}
