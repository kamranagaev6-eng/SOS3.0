import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { Environment } from '../../src/core/contracts/environment.ts';
import type { ContactInterval } from '../../src/core/contracts/plan.ts';
import type { RigDefinition } from '../../src/core/contracts/rig.ts';
import {
  PROPORTIONS_A,
  buildCanonicalRig,
  composeJointRotation,
  createRigA,
  forwardKinematics,
  getRigModel,
  scaleProportions,
} from '../../src/core/engine.ts';
import type { Vec3 } from '../../src/core/math/vec3.ts';
import type { ContactEvaluation } from '../../src/core/solver/types.ts';
import { fitDistance, directionFromOrbit, PRESET_ORBITS } from '../../src/render/camera.ts';
import { ResourceLedger, createStageScene, type StagePose } from '../../src/render/index.ts';

const FLOOR_ONLY: Environment = { schema: 'smx.environment/1', units: 'm', objects: [{ kind: 'floor', id: 'floor' }] };
const WITH_CHAIR: Environment = {
  schema: 'smx.environment/1',
  units: 'm',
  objects: [
    { kind: 'floor', id: 'floor' },
    { kind: 'chair', id: 'chair', seatHeight: 0.46, seatDepth: 0.42, seatWidth: 0.46, seatThickness: 0.04, frontZ: 0.05, centerX: 0, backrestHeight: 0.4 },
  ],
};
const WITH_STEP: Environment = {
  schema: 'smx.environment/1',
  units: 'm',
  objects: [
    { kind: 'floor', id: 'floor' },
    { kind: 'step', id: 'step', height: 0.15, depth: 0.35, width: 0.6, frontZ: 0.25, centerX: 0 },
  ],
};

/** Hand-made pose through the real FK: some hip/knee flexion and a raised heel. */
function makePose(rig: RigDefinition, contacts: ContactEvaluation[] = [], extra: Partial<StagePose> = {}): StagePose {
  const model = getRigModel(rig);
  const local = rig.joints.map((j) => {
    const a = j.dofs.map(() => 0);
    if (j.name.startsWith('hip')) a[0] = 0.4;
    if (j.name.startsWith('knee')) a[0] = 0.7;
    if (j.name.startsWith('ankle')) a[0] = 0.2;
    if (j.name.startsWith('mtp')) a[0] = 0.3;
    return composeJointRotation(j, a);
  });
  const fk = forwardKinematics(model, [0, 0, 0], [0, 0.9, 0], local);
  return {
    tier: 'stabilized',
    worldPos: fk.worldPos,
    worldRot: fk.worldRot,
    sitePos: fk.sitePos,
    contacts,
    stabilization: { enabled: true, offset: [0, -0.01, 0.004], iterations: 3, converged: true, boundReached: false, initialViolation: 0.01, finalViolation: 0 },
    limitEvents: [],
    pelvisWorld: fk.worldPos[1]!,
    ...extra,
  };
}

function contact(site: string, side: 'left' | 'right' | 'center', state: ContactEvaluation['state'], target: Vec3, actual: Vec3, ok = true): ContactEvaluation {
  const interval: ContactInterval = { id: `c-${site}`, site, surface: 'floor', kind: 'position', side, start: 0, end: 1, blendIn: 0, blendOut: 0 };
  const err = Math.hypot(actual[0] - target[0], actual[1] - target[1], actual[2] - target[2]);
  return { interval, weight: state === 'active' ? 1 : 0.5, state, target, actual, positionError: err, orientationError: null, withinTolerance: ok };
}

function countObjects(root: THREE.Object3D): { meshes: number; lines: number; total: number } {
  let meshes = 0;
  let lines = 0;
  let total = 0;
  root.traverse((o) => {
    total++;
    if ((o as THREE.Mesh).isMesh) meshes++;
    if ((o as THREE.Line).isLine) lines++;
  });
  return { meshes, lines, total };
}

function fullyLoaded(rig: RigDefinition, env: Environment, ledger: ResourceLedger) {
  const sg = createStageScene({ ledger });
  sg.setRig(rig);
  sg.setEnvironment(env);
  sg.setOverlays({ contactTargets: true, contactSites: true, residuals: true, trajectory: true, jointAxes: true, failures: true, hostBones: true });
  const pose = makePose(rig, [contact('heel_L', 'left', 'active', [0.09, 0, -0.05], [0.0905, 0.0002, -0.05])]);
  sg.setPose(pose, makePose(rig));
  sg.setTrajectory([pose.pelvisWorld, [0, 0.95, 0.1]], [pose.pelvisWorld]);
  sg.setHostBones([
    { name: 'a', parent: null, position: [0, 1, 0] },
    { name: 'b', parent: 'a', position: [0, 0.5, 0] },
  ]);
  sg.setComparison(true);
  return sg;
}

describe('render adapter scene graph', () => {
  it('builds a humanoid whose joint nodes follow the solver world transforms, with a visible toe segment', () => {
    const rig = createRigA();
    const sg = createStageScene();
    sg.setRig(rig);
    const pose = makePose(rig);
    sg.setPose(pose);
    const h = sg.layers[0].humanoid!;
    expect(h.group.visible).toBe(true);
    const iAnkle = rig.joints.findIndex((j) => j.name === 'ankle_L');
    const iMtp = rig.joints.findIndex((j) => j.name === 'mtp_L');
    const node = h.nodes[iAnkle]!;
    expect(node.position.toArray()).toEqual(pose.worldPos[iAnkle]);
    expect(node.quaternion.toArray()).toEqual(pose.worldRot[iAnkle]);
    const toes = h.nodes[iMtp]!.children.find((c) => c.name.endsWith(':toes'));
    expect(toes).toBeDefined();
    const foot = node.children.find((c) => c.name.endsWith(':foot')) as THREE.Mesh;
    foot.geometry.computeBoundingBox();
    // Foot sole sits at the rig's ankle height below the ankle joint.
    expect(foot.geometry.boundingBox!.min.y).toBeCloseTo(-PROPORTIONS_A.left.leg.ankleHeight, 6);
    // Left limbs and right limbs use different materials.
    const thighL = h.nodes[rig.joints.findIndex((j) => j.name === 'hip_L')]!.children[0] as THREE.Mesh;
    const thighR = h.nodes[rig.joints.findIndex((j) => j.name === 'hip_R')]!.children[0] as THREE.Mesh;
    expect((thighL.material as THREE.MeshStandardMaterial).color.getHex()).not.toBe((thighR.material as THREE.MeshStandardMaterial).color.getHex());
    sg.dispose();
  });

  it('hides the humanoid when there is no pose (no collapsed figure at the origin)', () => {
    const sg = createStageScene();
    sg.setRig(createRigA());
    expect(sg.layers[0].humanoid!.group.visible).toBe(false);
    sg.dispose();
  });

  it('disposes every geometry/material on repeated rig changes (no growth)', () => {
    const ledger = new ResourceLedger();
    const rigA = createRigA();
    const sg = fullyLoaded(rigA, WITH_CHAIR, ledger);
    const baseline = sg.ownedCounts();
    const baseLive = ledger.liveCount();
    expect(baseline.geometries).toBeGreaterThan(20);
    expect(baseline.materials).toBeGreaterThan(10);
    expect(baseLive.geometries).toBe(baseline.geometries);
    expect(baseLive.materials).toBe(baseline.materials);
    const objectsBefore = countObjects(sg.scene).meshes;

    for (let k = 0; k < 10; k++) {
      const rig = buildCanonicalRig(`rig-${k}`, `scaled ${k}`, scaleProportions(PROPORTIONS_A, { leg: 0.9 + k * 0.02, trunk: 1.05 }));
      sg.setRig(rig);
      sg.setPose(makePose(rig, [contact('ball_R', 'right', 'engaging', [-0.09, 0, 0.14], [-0.09, 0, 0.14])]), makePose(rig));
      sg.setTrajectory([[0, 0.9, 0]]);
    }
    sg.setRig(rigA);
    sg.setPose(makePose(rigA, [contact('heel_L', 'left', 'active', [0.09, 0, -0.05], [0.0905, 0.0002, -0.05])]), makePose(rigA));
    sg.setTrajectory([[0, 0.9, 0], [0, 0.95, 0.1]], [[0, 0.9, 0]]);
    sg.setHostBones([
      { name: 'a', parent: null, position: [0, 1, 0] },
      { name: 'b', parent: 'a', position: [0, 0.5, 0] },
    ]);

    expect(sg.ownedCounts()).toEqual(baseline);
    expect(ledger.liveCount()).toEqual(baseLive);
    expect(ledger.disposed.geometries).toBeGreaterThan(200);
    expect(ledger.created.geometries - ledger.disposed.geometries).toBe(baseLive.geometries);
    expect(countObjects(sg.scene).meshes).toBe(objectsBefore);

    sg.dispose();
    expect(ledger.liveCount().total).toBe(0);
    expect(sg.ownedCounts()).toEqual({ geometries: 0, materials: 0, textures: 0 });
    expect(sg.scene.children.length).toBe(0);
  });

  it('disposes environment meshes when the environment changes', () => {
    const ledger = new ResourceLedger();
    const sg = createStageScene({ ledger });
    sg.setEnvironment(WITH_CHAIR);
    const chair = sg.ownedCounts();
    sg.setEnvironment(WITH_STEP);
    const step = sg.ownedCounts();
    expect(step.geometries).toBeLessThan(chair.geometries);
    sg.setEnvironment(FLOOR_ONLY);
    sg.setEnvironment(null);
    const none = sg.ownedCounts();
    sg.setEnvironment(WITH_CHAIR);
    expect(sg.ownedCounts()).toEqual(chair);
    expect(sg.scene.getObjectsByProperty('name', 'environment').length).toBe(1);
    sg.setEnvironment(null);
    expect(sg.ownedCounts()).toEqual(none);
    expect(ledger.liveCount().geometries).toBe(none.geometries);
    sg.dispose();
    expect(ledger.liveCount().total).toBe(0);
  });

  it('builds chair and step at the contract positions', () => {
    const sg = createStageScene();
    sg.setEnvironment(WITH_CHAIR);
    const seat = sg.scene.getObjectByName('chair:chair:seat') as THREE.Mesh;
    const box = new THREE.Box3().setFromObject(seat);
    expect(box.max.y).toBeCloseTo(0.46, 6);
    expect(box.max.z).toBeCloseTo(0.05, 6);
    expect(box.min.z).toBeCloseTo(0.05 - 0.42, 6);
    sg.setEnvironment(WITH_STEP);
    const step = sg.scene.getObjectByName('step:step') as THREE.Mesh;
    const sb = new THREE.Box3().setFromObject(step);
    expect(sb.min.z).toBeCloseTo(0.25, 6);
    expect(sb.max.z).toBeCloseTo(0.6, 6);
    expect(sb.max.y).toBeCloseTo(0.15, 6);
    sg.dispose();
  });

  it('does not keep stale per-sample overlay objects between poses or plans', () => {
    const rig = createRigA();
    const sg = createStageScene();
    sg.setRig(rig);
    sg.setOverlays({ contactTargets: true, residuals: true, failures: true, contactSites: true });
    const four = [
      contact('heel_L', 'left', 'active', [0.09, 0, -0.05], [0.09, 0, -0.05]),
      contact('ball_L', 'left', 'active', [0.09, 0, 0.14], [0.09, 0, 0.14]),
      contact('heel_R', 'right', 'releasing', [-0.09, 0, -0.05], [-0.09, 0.01, -0.05]),
      contact('ball_R', 'right', 'active', [-0.09, 0, 0.14], [-0.09, 0.004, 0.14], false),
    ];
    sg.setPose(makePose(rig, four, { limitEvents: [{ joint: 'knee_L', dof: 'flexion', requested: 2.6, applied: 2.53 }] }));
    let c = sg.layers[0].overlay.visibleCounts();
    expect(c.targets).toBe(4);
    expect(c.residualSegments).toBe(4);
    expect(c.failures).toBe(2); // failing ball_R contact + clamped knee
    expect(c.sites).toBe(7); // heel/ball/toe per foot + seat
    expect(c.arrow).toBe(true);

    sg.setPose(makePose(rig, []));
    c = sg.layers[0].overlay.visibleCounts();
    expect(c).toMatchObject({ targets: 0, residualSegments: 0, failures: 0 });

    sg.setOverlays({ contactTargets: false, residuals: false, failures: false, contactSites: false });
    sg.setPose(makePose(rig, four));
    c = sg.layers[0].overlay.visibleCounts();
    expect(c).toMatchObject({ targets: 0, residualSegments: 0, failures: 0, sites: 0, arrow: false });

    // A new plan (rig re-set) drops pooled objects entirely.
    sg.setOverlays({ contactTargets: true });
    sg.setPose(makePose(rig, four));
    sg.setRig(rig);
    const pooled = countObjects(sg.layers[0].overlay.group);
    sg.setPose(null);
    expect(sg.layers[0].overlay.visibleCounts().targets).toBe(0);
    expect(countObjects(sg.layers[0].overlay.group).total).toBe(pooled.total);

    // A new plan with the same rig: resetOverlays drops pooled objects and the trajectory.
    const empty = countObjects(sg.layers[0].overlay.group).total;
    sg.setTrajectory([[0, 1, 0], [0, 1.1, 0.1]]);
    sg.setPose(makePose(rig, four));
    expect(countObjects(sg.layers[0].overlay.group).total).toBeGreaterThan(empty);
    const owned = sg.ownedCounts().geometries;
    sg.resetOverlays();
    expect(countObjects(sg.layers[0].overlay.group).total).toBe(empty);
    expect(sg.layers[0].overlay.visibleCounts().trajectoryPoints).toBe(0);
    expect(sg.ownedCounts().geometries).toBe(owned - 1); // trajectory geometry disposed
    expect(sg.layers[0].humanoid!.group.visible).toBe(false); // old plan's pose is gone
    sg.dispose();
  });

  it('magnifies residual vectors ×10 only when requested', () => {
    const rig = createRigA();
    const sg = createStageScene();
    sg.setRig(rig);
    const ev = contact('heel_L', 'left', 'active', [0.1, 0, 0], [0.101, 0, 0]);
    sg.setOverlays({ residuals: true, magnifyResiduals: false });
    sg.setPose(makePose(rig, [ev]));
    const line = sg.scene.getObjectByName('primary:residuals') as THREE.LineSegments;
    const pos = line.geometry.getAttribute('position');
    expect(pos.getX(1) - pos.getX(0)).toBeCloseTo(0.001, 6);
    sg.setOverlays({ magnifyResiduals: true });
    expect(pos.getX(1) - pos.getX(0)).toBeCloseTo(0.01, 6);
    sg.dispose();
  });

  it('comparison layer is only visible in comparison mode', () => {
    const sg = createStageScene();
    sg.setRig(createRigA());
    expect(sg.layers[1].group.visible).toBe(false);
    sg.setComparison(true);
    expect(sg.layers[1].group.visible).toBe(true);
    sg.setComparison(false);
    expect(sg.layers[1].group.visible).toBe(false);
    sg.dispose();
  });

  it('bumps the version on every visual change', () => {
    const sg = createStageScene();
    const v0 = sg.version;
    sg.setRig(createRigA());
    sg.setOverlays({ jointAxes: true });
    sg.setInspectionSide('left');
    expect(sg.version).toBe(v0 + 3);
    sg.dispose();
  });
});

describe('camera framing', () => {
  it('fits all bounds corners inside the frustum for every preset and aspect', () => {
    const bounds = { min: [-0.5, 0, -0.6] as Vec3, max: [0.5, 1.8, 0.7] as Vec3 };
    const fov = (30 * Math.PI) / 180;
    for (const preset of Object.values(PRESET_ORBITS)) {
      for (const aspect of [0.45, 1, 1.8]) {
        const dir = directionFromOrbit(preset);
        const { target, distance } = fitDistance(bounds, dir, fov, aspect);
        const cam = new THREE.PerspectiveCamera(30, aspect, 0.01, 100);
        cam.position.copy(target).addScaledVector(dir, distance);
        if (Math.abs(dir.y) > 0.99) cam.up.set(0, 0, -1);
        cam.lookAt(target);
        cam.updateMatrixWorld();
        cam.updateProjectionMatrix();
        for (let i = 0; i < 8; i++) {
          const p = new THREE.Vector3(i & 1 ? 0.5 : -0.5, i & 2 ? 1.8 : 0, i & 4 ? 0.7 : -0.6).project(cam);
          expect(Math.abs(p.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(p.y)).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
