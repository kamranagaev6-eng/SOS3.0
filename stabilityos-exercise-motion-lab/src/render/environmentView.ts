import * as THREE from 'three';
import type { ChairObject, Environment, StepObject } from '../core/contracts/environment.ts';
import { PALETTE } from './palette.ts';
import type { ResourceTracker } from './resources.ts';

export interface EnvironmentView {
  readonly group: THREE.Group;
  /** World-space bounds of the furniture (floor excluded). null when there is none. */
  readonly furnitureBounds: THREE.Box3 | null;
  setDark(dark: boolean): void;
}

const FLOOR_SIZE = 6;

/**
 * Builds floor (with a subtle 10 cm grid), chair and step meshes from environment objects.
 * Geometry follows the contract exactly: chair seat top at `seatHeight`, extending `seatDepth`
 * toward -Z from `frontZ`; step riser at `frontZ`, tread `depth` toward +Z.
 */
export function buildEnvironment(env: Environment, tracker: ResourceTracker, dark = false): EnvironmentView {
  const group = new THREE.Group();
  group.name = 'environment';
  const floorMat = tracker.track(new THREE.MeshStandardMaterial({ color: dark ? PALETTE.floorDark : PALETTE.floor, roughness: 0.95 }));
  const furnitureMat = tracker.track(new THREE.MeshStandardMaterial({ color: PALETTE.furniture, roughness: 0.8 }));
  const stepMat = tracker.track(new THREE.MeshStandardMaterial({ color: PALETTE.step, roughness: 0.85 }));
  const furnitureEdge = tracker.track(new THREE.LineBasicMaterial({ color: PALETTE.furnitureEdge }));
  const stepEdge = tracker.track(new THREE.LineBasicMaterial({ color: PALETTE.stepEdge }));
  const gridMat = tracker.track(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false }));
  const furnitureBounds = new THREE.Box3();
  let hasFurniture = false;

  const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, edge: THREE.LineBasicMaterial | null, name: string): void => {
    const g = tracker.track(new THREE.BoxGeometry(w, h, d));
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(x, y, z);
    mesh.name = name;
    group.add(mesh);
    if (edge) {
      const eg = tracker.track(new THREE.EdgesGeometry(g));
      const lines = new THREE.LineSegments(eg, edge);
      lines.position.copy(mesh.position);
      lines.name = `${name}:edges`;
      group.add(lines);
    }
    furnitureBounds.expandByPoint(new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2));
    furnitureBounds.expandByPoint(new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2));
    hasFurniture = true;
  };

  for (const obj of env.objects) {
    if (obj.kind === 'floor') {
      const fg = tracker.track(new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE));
      fg.rotateX(-Math.PI / 2);
      const floor = new THREE.Mesh(fg, floorMat);
      floor.name = `floor:${obj.id}`;
      floor.renderOrder = -2;
      group.add(floor);
      const grid = new THREE.LineSegments(tracker.track(gridGeometry(FLOOR_SIZE, 0.1, dark)), gridMat);
      grid.position.y = 0.0006;
      grid.name = 'floor:grid';
      grid.renderOrder = -1;
      group.add(grid);
    } else if (obj.kind === 'chair') {
      addChair(obj, box, furnitureMat, furnitureEdge);
    } else if (obj.kind === 'step') {
      addStep(obj, box, stepMat, stepEdge);
    }
  }

  return {
    group,
    furnitureBounds: hasFurniture ? furnitureBounds : null,
    setDark(isDark) {
      floorMat.color.setHex(isDark ? PALETTE.floorDark : PALETTE.floor);
      const grid = group.getObjectByName('floor:grid') as THREE.LineSegments | undefined;
      if (grid) recolourGrid(grid.geometry, isDark);
    },
  };
}

type BoxFn = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, edge: THREE.LineBasicMaterial | null, name: string) => void;

function addChair(c: ChairObject, box: BoxFn, mat: THREE.Material, edge: THREE.LineBasicMaterial): void {
  const seatCz = c.frontZ - c.seatDepth / 2;
  box(c.seatWidth, c.seatThickness, c.seatDepth, c.centerX, c.seatHeight - c.seatThickness / 2, seatCz, mat, edge, `chair:${c.id}:seat`);
  const legH = c.seatHeight - c.seatThickness;
  const leg = 0.032;
  const inset = 0.03;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = c.centerX + sx * (c.seatWidth / 2 - inset);
      const z = seatCz + sz * (c.seatDepth / 2 - inset);
      box(leg, legH, leg, x, legH / 2, z, mat, null, `chair:${c.id}:leg`);
    }
  }
  if (c.backrestHeight > 0) {
    const t = 0.03;
    box(c.seatWidth, c.backrestHeight, t, c.centerX, c.seatHeight + c.backrestHeight / 2, c.frontZ - c.seatDepth + t / 2, mat, edge, `chair:${c.id}:backrest`);
  }
}

function addStep(s: StepObject, box: BoxFn, mat: THREE.Material, edge: THREE.LineBasicMaterial): void {
  box(s.width, s.height, s.depth, s.centerX, s.height / 2, s.frontZ + s.depth / 2, mat, edge, `step:${s.id}`);
}

function gridGeometry(size: number, cell: number, dark: boolean): THREE.BufferGeometry {
  const half = size / 2;
  const n = Math.round(size / cell);
  const positions: number[] = [];
  for (let i = 0; i <= n; i++) {
    const v = -half + i * cell;
    positions.push(-half, 0, v, half, 0, v, v, 0, -half, v, 0, half);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(positions.length), 3));
  g.userData.cells = n;
  recolourGrid(g, dark);
  return g;
}

function recolourGrid(g: THREE.BufferGeometry, dark: boolean): void {
  const col = g.getAttribute('color') as THREE.BufferAttribute;
  const major = new THREE.Color(dark ? PALETTE.gridMajorDark : PALETTE.gridMajor);
  const minor = new THREE.Color(dark ? PALETTE.gridMinorDark : PALETTE.gridMinor);
  const n = g.userData.cells as number;
  for (let i = 0; i <= n; i++) {
    const c = (i - n / 2) % 5 === 0 ? major : minor;
    for (let k = 0; k < 4; k++) col.setXYZ(i * 4 + k, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}
