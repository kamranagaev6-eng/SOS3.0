import * as THREE from 'three';
import type { Bounds3, ViewPreset } from './types.ts';

/**
 * Orbit camera state. Azimuth is measured around +Y from +Z toward +X, so azimuth 0 puts the
 * camera in front of the subject (who faces +Z) and +90° puts it on the subject's LEFT (+X).
 */
export interface OrbitState {
  azimuth: number;
  elevation: number;
  /** Multiplier on the fitted distance (1 = exact fit). */
  zoom: number;
}

const D = Math.PI / 180;

export const PRESET_ORBITS: Record<ViewPreset, OrbitState> = {
  front: { azimuth: 0, elevation: 6 * D, zoom: 1 },
  'side-left': { azimuth: 90 * D, elevation: 4 * D, zoom: 1 },
  'side-right': { azimuth: -90 * D, elevation: 4 * D, zoom: 1 },
  oblique: { azimuth: 38 * D, elevation: 16 * D, zoom: 1 },
  top: { azimuth: 0, elevation: 84 * D, zoom: 1 },
};

export function directionFromOrbit(o: OrbitState, out = new THREE.Vector3()): THREE.Vector3 {
  const ce = Math.cos(o.elevation);
  return out.set(Math.sin(o.azimuth) * ce, Math.sin(o.elevation), Math.cos(o.azimuth) * ce);
}

/**
 * Smallest camera distance (along `dir`, from the box centre) that keeps all 8 corners of the box
 * inside a perspective frustum with vertical FOV `fovY` (rad) and `aspect`, with a margin.
 */
export function fitDistance(bounds: Bounds3, dir: THREE.Vector3, fovY: number, aspect: number, margin = 1.04): { target: THREE.Vector3; distance: number } {
  const c = new THREE.Vector3(
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  );
  const f = dir.clone().normalize(); // from target toward camera
  const worldUp = Math.abs(f.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(worldUp, f).normalize();
  const up = new THREE.Vector3().crossVectors(f, right).normalize();
  const tanV = Math.tan(fovY / 2);
  const tanH = tanV * Math.max(aspect, 1e-3);
  let dist = 0.5;
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    p.set(i & 1 ? bounds.max[0] : bounds.min[0], i & 2 ? bounds.max[1] : bounds.min[1], i & 4 ? bounds.max[2] : bounds.min[2]).sub(c);
    const x = Math.abs(p.dot(right));
    const y = Math.abs(p.dot(up));
    const z = p.dot(f);
    dist = Math.max(dist, z + x / tanH, z + y / tanV);
  }
  return { target: c, distance: dist * margin };
}

function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Camera controller: preset orbits, optional short eased transition, pointer orbit / wheel zoom. */
export class OrbitController {
  current: OrbitState = { ...PRESET_ORBITS.front };
  private from: OrbitState = { ...PRESET_ORBITS.front };
  private to: OrbitState = { ...PRESET_ORBITS.front };
  private tweenStart = 0;
  private tweenMs = 0;
  preset: ViewPreset | 'custom' = 'front';

  jump(o: OrbitState): void {
    this.current = { ...o };
    this.to = { ...o };
    this.tweenMs = 0;
  }

  animateTo(o: OrbitState, now: number, ms = 420): void {
    this.from = { ...this.current };
    this.to = { azimuth: this.current.azimuth + shortestAngle(this.current.azimuth, o.azimuth), elevation: o.elevation, zoom: o.zoom };
    this.tweenStart = now;
    this.tweenMs = ms;
  }

  /** Advances the tween; returns true while animating. */
  update(now: number): boolean {
    if (this.tweenMs <= 0) return false;
    const s = Math.min(1, (now - this.tweenStart) / this.tweenMs);
    const e = s < 0.5 ? 4 * s * s * s : 1 - Math.pow(-2 * s + 2, 3) / 2;
    this.current = {
      azimuth: this.from.azimuth + (this.to.azimuth - this.from.azimuth) * e,
      elevation: this.from.elevation + (this.to.elevation - this.from.elevation) * e,
      zoom: this.from.zoom + (this.to.zoom - this.from.zoom) * e,
    };
    if (s >= 1) {
      this.tweenMs = 0;
      return false;
    }
    return true;
  }

  get animating(): boolean {
    return this.tweenMs > 0;
  }

  orbitBy(dAz: number, dEl: number): void {
    this.tweenMs = 0;
    this.current = {
      azimuth: this.current.azimuth + dAz,
      elevation: Math.max(-10 * D, Math.min(88 * D, this.current.elevation + dEl)),
      zoom: this.current.zoom,
    };
    this.preset = 'custom';
  }

  zoomBy(f: number): void {
    this.tweenMs = 0;
    this.current = { ...this.current, zoom: Math.max(0.35, Math.min(3, this.current.zoom * f)) };
    this.preset = 'custom';
  }
}
