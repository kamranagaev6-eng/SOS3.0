import * as THREE from 'three';
import type { Side } from '../core/contracts/common.ts';
import type { Environment } from '../core/contracts/environment.ts';
import type { RigDefinition } from '../core/contracts/rig.ts';
import type { Vec3 } from '../core/math/vec3.ts';
import { buildEnvironment, type EnvironmentView } from './environmentView.ts';
import { buildHumanoid, type HumanoidView } from './humanoid.ts';
import { createHostBoneOverlay, createOverlayShared, createPoseOverlay, type PoseOverlay } from './overlays.ts';
import { ResourceTracker, type ResourceLedger } from './resources.ts';
import { DEFAULT_OVERLAYS, type Bounds3, type HostBoneView, type OverlayFlags, type StagePose } from './types.ts';

export interface PoseLayer {
  readonly name: 'primary' | 'comparison';
  readonly group: THREE.Group;
  humanoid: HumanoidView | null;
  readonly overlay: PoseOverlay;
  pose: StagePose | null;
}

/**
 * Scene graph of the stage, independent of any WebGL renderer so it can be built and checked in
 * Node (unit tests assert that every geometry/material is disposed on rig / environment / plan
 * changes). `createStage` adds the renderer, camera and viewports on top of this.
 */
export interface StageScene {
  readonly scene: THREE.Scene;
  readonly layers: readonly [PoseLayer, PoseLayer];
  readonly hostBones: THREE.Group;
  setRig(rig: RigDefinition | null): void;
  setEnvironment(env: Environment | null): void;
  setPose(primary: StagePose | null, comparison?: StagePose | null): void;
  setTrajectory(primary: readonly Vec3[] | null, comparison?: readonly Vec3[] | null): void;
  setHostBones(bones: readonly HostBoneView[] | null): void;
  /** Drops the current poses, pooled per-sample overlay objects, trajectories and host bones (new plan). */
  resetOverlays(): void;
  setOverlays(flags: Partial<OverlayFlags>): void;
  getOverlays(): OverlayFlags;
  setInspectionSide(side: Side | null): void;
  setComparison(enabled: boolean): void;
  readonly comparison: boolean;
  setDark(dark: boolean): void;
  /** Bounds of environment furniture plus a standing-height envelope (fallback framing). */
  defaultBounds(): Bounds3;
  ownedCounts(): { geometries: number; materials: number; textures: number };
  /** Increments on every change that affects the image. */
  readonly version: number;
  dispose(): void;
}

export function createStageScene(options: { ledger?: ResourceLedger | null; dark?: boolean } = {}): StageScene {
  const ledger = options.ledger ?? null;
  const scene = new THREE.Scene();
  scene.name = 'motion-lab-stage';
  let dark = options.dark ?? false;

  const hemi = new THREE.HemisphereLight(0xf4f7fb, 0x9c968c, 1.9);
  hemi.position.set(0, 4, 0);
  const key = new THREE.DirectionalLight(0xffffff, 1.9);
  key.position.set(2.2, 4.5, 3.4);
  const rim = new THREE.DirectionalLight(0xe8eef8, 0.7);
  rim.position.set(-3, 2.5, -2.5);
  scene.add(hemi, key, rim);

  const sharedTracker = new ResourceTracker(ledger);
  const shared = createOverlayShared(sharedTracker);
  const envTracker = new ResourceTracker(ledger);
  const hostTracker = new ResourceTracker(ledger);
  const hostOverlay = createHostBoneOverlay(shared, hostTracker);
  scene.add(hostOverlay.group);

  const layerTrackers = { primary: new ResourceTracker(ledger), comparison: new ResourceTracker(ledger) };
  const overlayTrackers = { primary: new ResourceTracker(ledger), comparison: new ResourceTracker(ledger) };
  const makeLayer = (name: 'primary' | 'comparison'): PoseLayer => {
    const group = new THREE.Group();
    group.name = `layer:${name}`;
    const overlay = createPoseOverlay(shared, overlayTrackers[name], name, name === 'comparison');
    group.add(overlay.group);
    scene.add(group);
    return { name, group, humanoid: null, overlay, pose: null };
  };
  const layers = [makeLayer('primary'), makeLayer('comparison')] as const;

  let env: EnvironmentView | null = null;
  let rig: RigDefinition | null = null;
  let flags: OverlayFlags = { ...DEFAULT_OVERLAYS };
  let side: Side | null = null;
  let comparison = false;
  let version = 0;
  let disposed = false;
  const bump = (): void => {
    version++;
  };

  const refreshLayer = (layer: PoseLayer): void => {
    if (layer.humanoid) {
      layer.humanoid.group.visible = layer.pose !== null;
      if (layer.pose) layer.humanoid.applyPose(layer.pose.worldPos, layer.pose.worldRot);
      layer.humanoid.setHighlight(side);
    }
    layer.overlay.update(layer.pose, flags, side);
  };

  const api: StageScene = {
    scene,
    layers,
    hostBones: hostOverlay.group,
    get comparison() {
      return comparison;
    },
    get version() {
      return version;
    },
    setRig(next) {
      if (disposed) return;
      rig = next;
      for (const layer of layers) {
        if (layer.humanoid) layer.group.remove(layer.humanoid.group);
        layerTrackers[layer.name].disposeAll();
        layer.humanoid = null;
        layer.pose = null;
        layer.overlay.setRig(next);
        layer.overlay.setTrajectory(null);
        if (next) {
          layer.humanoid = buildHumanoid(next, layerTrackers[layer.name], layer.name);
          layer.humanoid.group.visible = false;
          layer.group.add(layer.humanoid.group);
        }
        refreshLayer(layer);
      }
      hostOverlay.set(null);
      bump();
    },
    setEnvironment(next) {
      if (disposed) return;
      if (env) scene.remove(env.group);
      envTracker.disposeAll();
      env = next ? buildEnvironment(next, envTracker, dark) : null;
      if (env) scene.add(env.group);
      bump();
    },
    setPose(primary, comp = null) {
      if (disposed) return;
      layers[0].pose = primary;
      layers[1].pose = comp;
      refreshLayer(layers[0]);
      refreshLayer(layers[1]);
      bump();
    },
    setTrajectory(primary, comp = null) {
      if (disposed) return;
      layers[0].overlay.setTrajectory(primary);
      layers[1].overlay.setTrajectory(comp);
      refreshLayer(layers[0]);
      refreshLayer(layers[1]);
      bump();
    },
    setHostBones(bones) {
      if (disposed) return;
      hostOverlay.set(bones);
      hostOverlay.setVisible(flags.hostBones);
      bump();
    },
    resetOverlays() {
      if (disposed) return;
      for (const layer of layers) {
        // The old plan's pose goes too; the next setPose (next frame) shows the new plan.
        layer.pose = null;
        layer.overlay.clear();
        layer.overlay.setTrajectory(null);
        refreshLayer(layer);
      }
      hostOverlay.set(null);
      bump();
    },
    setOverlays(partial) {
      flags = { ...flags, ...partial };
      hostOverlay.setVisible(flags.hostBones);
      refreshLayer(layers[0]);
      refreshLayer(layers[1]);
      bump();
    },
    getOverlays() {
      return { ...flags };
    },
    setInspectionSide(s) {
      side = s;
      refreshLayer(layers[0]);
      refreshLayer(layers[1]);
      bump();
    },
    setComparison(enabled) {
      comparison = enabled;
      layers[1].group.visible = enabled;
      bump();
    },
    setDark(d) {
      dark = d;
      env?.setDark(d);
      bump();
    },
    defaultBounds() {
      const b = new THREE.Box3(new THREE.Vector3(-0.45, 0, -0.45), new THREE.Vector3(0.45, rigHeight(rig), 0.5));
      if (env?.furnitureBounds) b.union(env.furnitureBounds);
      return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
    },
    ownedCounts() {
      const all = [sharedTracker, envTracker, hostTracker, layerTrackers.primary, layerTrackers.comparison, overlayTrackers.primary, overlayTrackers.comparison];
      const out = { geometries: 0, materials: 0, textures: 0 };
      for (const t of all) {
        const c = t.counts();
        out.geometries += c.geometries;
        out.materials += c.materials;
        out.textures += c.textures;
      }
      return out;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const layer of layers) {
        layer.overlay.clear();
        layer.overlay.setTrajectory(null);
        layer.overlay.setRig(null);
        layer.humanoid = null;
        layer.pose = null;
      }
      hostOverlay.set(null);
      for (const t of [layerTrackers.primary, layerTrackers.comparison, overlayTrackers.primary, overlayTrackers.comparison, envTracker, hostTracker, sharedTracker]) {
        t.disposeAll();
      }
      scene.clear();
      env = null;
    },
  };
  layers[1].group.visible = false;
  return api;
}

function rigHeight(rig: RigDefinition | null): number {
  if (!rig) return 1.8;
  const p = rig.proportions;
  const leg = Math.max(p.left.leg.thigh + p.left.leg.shank + p.left.leg.ankleHeight, p.right.leg.thigh + p.right.leg.shank + p.right.leg.ankleHeight);
  return leg + p.pelvis.hipDrop + p.pelvis.lumbarBaseHeight + p.trunk.lumbar + p.trunk.thoracic + p.trunk.neck + p.trunk.head + 0.02;
}
