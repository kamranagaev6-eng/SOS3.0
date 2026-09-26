import * as THREE from 'three';
import type { Side } from '../core/contracts/common.ts';
import type { RigDefinition } from '../core/contracts/rig.ts';
import type { Vec3 } from '../core/math/vec3.ts';
import { PALETTE } from './palette.ts';
import type { ResourceTracker } from './resources.ts';
import { RESIDUAL_MAGNIFICATION, type HostBoneView, type OverlayFlags, type StagePose } from './types.ts';

/** Geometry and materials shared by every overlay layer of a stage (created once per stage). */
export interface OverlayShared {
  ring: THREE.BufferGeometry;
  seatRing: THREE.BufferGeometry;
  dot: THREE.BufferGeometry;
  failMarker: THREE.BufferGeometry;
  arrowShaft: THREE.BufferGeometry;
  arrowHead: THREE.BufferGeometry;
  ringMat: Record<'active' | 'engaging' | 'releasing' | 'fail', THREE.MeshBasicMaterial>;
  siteMat: THREE.MeshBasicMaterial;
  siteFailMat: THREE.MeshBasicMaterial;
  failMat: THREE.MeshBasicMaterial;
  residualMat: THREE.LineBasicMaterial;
  axesMat: THREE.LineBasicMaterial;
  trajectoryMat: THREE.LineBasicMaterial;
  trajectoryComparisonMat: THREE.LineBasicMaterial;
  markerMat: THREE.MeshBasicMaterial;
  stabMat: THREE.MeshBasicMaterial;
  hostBoneMat: THREE.LineBasicMaterial;
  hostJointMat: THREE.PointsMaterial;
}

export function createOverlayShared(tracker: ResourceTracker): OverlayShared {
  const flat = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    g.rotateX(-Math.PI / 2);
    return tracker.track(g);
  };
  const basic = (color: number, extra: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial =>
    tracker.track(new THREE.MeshBasicMaterial({ color, depthTest: true, ...extra }));
  const shaft = new THREE.CylinderGeometry(0.006, 0.006, 1, 10, 1);
  shaft.translate(0, 0.5, 0);
  const head = new THREE.ConeGeometry(0.018, 0.045, 14, 1);
  head.translate(0, -0.0225, 0);
  return {
    ring: flat(new THREE.RingGeometry(0.02, 0.03, 32)),
    seatRing: flat(new THREE.RingGeometry(0.04, 0.052, 40)),
    dot: tracker.track(new THREE.SphereGeometry(0.009, 12, 8)),
    failMarker: tracker.track(new THREE.SphereGeometry(0.028, 16, 10)),
    arrowShaft: tracker.track(shaft),
    arrowHead: tracker.track(head),
    ringMat: {
      active: basic(PALETTE.contactActive, { side: THREE.DoubleSide }),
      engaging: basic(PALETTE.contactEngaging, { side: THREE.DoubleSide }),
      releasing: basic(PALETTE.contactReleasing, { side: THREE.DoubleSide }),
      fail: basic(PALETTE.contactFail, { side: THREE.DoubleSide }),
    },
    siteMat: basic(PALETTE.site),
    siteFailMat: basic(PALETTE.contactFail),
    failMat: basic(PALETTE.contactFail, { transparent: true, opacity: 0.45, depthWrite: false }),
    residualMat: tracker.track(new THREE.LineBasicMaterial({ color: PALETTE.residual, depthTest: false, transparent: true })),
    axesMat: tracker.track(new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true })),
    trajectoryMat: tracker.track(new THREE.LineBasicMaterial({ color: PALETTE.trajectory })),
    trajectoryComparisonMat: tracker.track(new THREE.LineBasicMaterial({ color: PALETTE.trajectoryComparison })),
    markerMat: basic(PALETTE.trajectory),
    stabMat: basic(PALETTE.stabilization, { depthTest: false, transparent: true }),
    hostBoneMat: tracker.track(new THREE.LineBasicMaterial({ color: PALETTE.hostBone, depthTest: false, transparent: true })),
    hostJointMat: tracker.track(new THREE.PointsMaterial({ color: PALETTE.hostBone, size: 6, sizeAttenuation: false, depthTest: false, transparent: true })),
  };
}

const MAX_CONTACT_LINES = 32;
const AXIS_LEN = 0.07;

class MeshPool {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private used = 0;
  constructor(name: string) {
    this.group.name = name;
  }
  begin(): void {
    this.used = 0;
  }
  next(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    let m = this.meshes[this.used];
    if (!m) {
      m = new THREE.Mesh(geometry, material);
      m.renderOrder = 3;
      this.meshes.push(m);
      this.group.add(m);
    }
    m.geometry = geometry;
    m.material = material;
    m.visible = true;
    m.scale.setScalar(1);
    m.quaternion.identity();
    this.used++;
    return m;
  }
  end(): void {
    for (let i = this.used; i < this.meshes.length; i++) this.meshes[i]!.visible = false;
  }
  /** Removes all pooled objects (pool meshes share geometry/material, so nothing to dispose). */
  clear(): void {
    for (const m of this.meshes) this.group.remove(m);
    this.meshes.length = 0;
    this.used = 0;
  }
  visibleCount(): number {
    return this.meshes.filter((m) => m.visible).length;
  }
}

export interface PoseOverlay {
  readonly group: THREE.Group;
  setRig(rig: RigDefinition | null): void;
  setTrajectory(points: readonly Vec3[] | null): void;
  update(pose: StagePose | null, flags: OverlayFlags, highlight: Side | null): void;
  /** Hide every per-sample overlay object and drop pooled objects (new plan / rig). */
  clear(): void;
  /** Number of visible overlay objects (tests). */
  visibleCounts(): { targets: number; sites: number; failures: number; residualSegments: number; axes: boolean; arrow: boolean; trajectoryPoints: number };
}

const V = new THREE.Vector3();
const Q = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const AXIS_DIRS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const AXIS_COLS = [new THREE.Color(0xd9412b), new THREE.Color(0x2f9e44), new THREE.Color(0x1c6fd6)];

function sideOfSite(name: string): Side | null {
  if (name.endsWith('_L')) return 'left';
  if (name.endsWith('_R')) return 'right';
  return null;
}

export function createPoseOverlay(shared: OverlayShared, tracker: ResourceTracker, name: string, comparison: boolean): PoseOverlay {
  const group = new THREE.Group();
  group.name = `${name}:overlays`;
  const targets = new MeshPool(`${name}:targets`);
  const sites = new MeshPool(`${name}:sites`);
  const failures = new MeshPool(`${name}:failures`);
  group.add(targets.group, sites.group, failures.group);

  const residualGeom = tracker.track(new THREE.BufferGeometry());
  residualGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_CONTACT_LINES * 2 * 3), 3));
  residualGeom.setDrawRange(0, 0);
  const residuals = new THREE.LineSegments(residualGeom, shared.residualMat);
  residuals.name = `${name}:residuals`;
  residuals.frustumCulled = false;
  residuals.renderOrder = 4;
  group.add(residuals);

  let axesGeom: THREE.BufferGeometry | null = null;
  let axes: THREE.LineSegments | null = null;

  const arrow = new THREE.Group();
  arrow.name = `${name}:stabilization-arrow`;
  const arrowShaft = new THREE.Mesh(shared.arrowShaft, shared.stabMat);
  const arrowHead = new THREE.Mesh(shared.arrowHead, shared.stabMat);
  arrowShaft.renderOrder = 5;
  arrowHead.renderOrder = 5;
  arrow.add(arrowShaft, arrowHead);
  arrow.visible = false;
  group.add(arrow);

  let trajGeom: THREE.BufferGeometry | null = null;
  let traj: THREE.Line | null = null;
  const marker = new THREE.Mesh(shared.dot, shared.markerMat);
  marker.scale.setScalar(1.6);
  marker.visible = false;
  marker.name = `${name}:pelvis-marker`;
  group.add(marker);

  let jointIndex = new Map<string, number>();
  let contactSiteIdx: number[] = [];
  let contactSiteSide: (Side | null)[] = [];
  let contactSiteName: string[] = [];

  const dropAxes = (): void => {
    if (axes) group.remove(axes);
    tracker.release(axesGeom);
    axes = null;
    axesGeom = null;
  };

  return {
    group,
    setRig(rig) {
      this.clear();
      dropAxes();
      jointIndex = new Map();
      contactSiteIdx = [];
      contactSiteSide = [];
      contactSiteName = [];
      if (!rig) return;
      rig.joints.forEach((j, i) => jointIndex.set(j.name, i));
      rig.sites.forEach((s, i) => {
        if (s.role === 'contact') {
          contactSiteIdx.push(i);
          contactSiteSide.push(sideOfSite(s.name));
          contactSiteName.push(s.name);
        }
      });
      const n = rig.joints.length;
      axesGeom = tracker.track(new THREE.BufferGeometry());
      axesGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 6 * 3), 3));
      const col = new Float32Array(n * 6 * 3);
      for (let j = 0; j < n; j++) {
        for (let a = 0; a < 3; a++) {
          const c = AXIS_COLS[a]!;
          for (let k = 0; k < 2; k++) col.set([c.r, c.g, c.b], (j * 6 + a * 2 + k) * 3);
        }
      }
      axesGeom.setAttribute('color', new THREE.BufferAttribute(col, 3));
      axes = new THREE.LineSegments(axesGeom, shared.axesMat);
      axes.name = `${name}:joint-axes`;
      axes.frustumCulled = false;
      axes.renderOrder = 6;
      axes.visible = false;
      group.add(axes);
    },
    setTrajectory(points) {
      if (traj) group.remove(traj);
      tracker.release(trajGeom);
      traj = null;
      trajGeom = null;
      if (!points || points.length < 1) return;
      const arr = new Float32Array(points.length * 3);
      points.forEach((p, i) => arr.set([p[0], p[1], p[2]], i * 3));
      trajGeom = tracker.track(new THREE.BufferGeometry());
      trajGeom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
      traj = new THREE.Line(trajGeom, comparison ? shared.trajectoryComparisonMat : shared.trajectoryMat);
      traj.name = `${name}:trajectory`;
      traj.frustumCulled = false;
      group.add(traj);
    },
    update(pose, flags, highlight) {
      targets.begin();
      sites.begin();
      failures.begin();
      let seg = 0;
      arrow.visible = false;
      marker.visible = false;
      if (axes) axes.visible = false;
      if (traj) traj.visible = flags.trajectory;
      if (pose) {
        const mag = flags.magnifyResiduals ? RESIDUAL_MAGNIFICATION : 1;
        const rpos = residualGeom.getAttribute('position') as THREE.BufferAttribute;
        for (const ev of pose.contacts) {
          const failed = ev.weight >= 1 && !ev.withinTolerance;
          const side = ev.interval.side === 'center' ? null : ev.interval.side;
          const emphasis = highlight && side === highlight ? 1.35 : highlight && side && side !== highlight ? 0.75 : 1;
          if (ev.target && flags.contactTargets) {
            const isSeat = ev.interval.site === 'seat';
            const m = targets.next(isSeat ? shared.seatRing : shared.ring, shared.ringMat[failed ? 'fail' : ev.state]);
            m.position.set(ev.target[0], ev.target[1] + 0.0015, ev.target[2]);
            m.scale.setScalar(emphasis);
          }
          if (ev.target && ev.actual && flags.residuals && seg < MAX_CONTACT_LINES) {
            const t = ev.target;
            const a = ev.actual;
            rpos.setXYZ(seg * 2, t[0], t[1], t[2]);
            rpos.setXYZ(seg * 2 + 1, t[0] + (a[0] - t[0]) * mag, t[1] + (a[1] - t[1]) * mag, t[2] + (a[2] - t[2]) * mag);
            seg++;
          }
          if (failed && flags.failures) {
            const p = ev.actual ?? ev.target;
            if (p) failures.next(shared.failMarker, shared.failMat).position.set(p[0], p[1], p[2]);
          }
        }
        rpos.needsUpdate = seg > 0;
        if (flags.contactSites) {
          const failingSites = new Set(pose.contacts.filter((c) => c.weight >= 1 && !c.withinTolerance).map((c) => c.interval.site));
          contactSiteIdx.forEach((si, k) => {
            const p = pose.sitePos[si];
            if (!p) return;
            const side = contactSiteSide[k] ?? null;
            const failing = failingSites.has(contactSiteName[k] ?? '');
            const m = sites.next(shared.dot, failing ? shared.siteFailMat : shared.siteMat);
            m.position.set(p[0], p[1], p[2]);
            m.scale.setScalar(highlight && side === highlight ? 1.4 : 1);
          });
        }
        if (flags.failures) {
          for (const ev of pose.limitEvents) {
            const ji = jointIndex.get(ev.joint);
            const p = ji === undefined ? undefined : pose.worldPos[ji];
            if (p) failures.next(shared.failMarker, shared.failMat).position.set(p[0], p[1], p[2]);
          }
          const st = pose.stabilization;
          const off = st.offset;
          const offLen = Math.hypot(off[0], off[1], off[2]);
          if (st.enabled && offLen > 1e-5) {
            const len = offLen * mag;
            const pw = pose.pelvisWorld;
            V.set(off[0], off[1], off[2]).normalize();
            Q.setFromUnitVectors(UP, V);
            arrow.position.set(pw[0] - V.x * len, pw[1] - V.y * len, pw[2] - V.z * len);
            arrow.quaternion.copy(Q);
            arrowShaft.scale.set(1, Math.max(len - 0.045, 0.001), 1);
            arrowHead.position.set(0, len, 0);
            arrow.visible = true;
          }
          if (!st.converged || st.boundReached) {
            const pw = pose.pelvisWorld;
            failures.next(shared.failMarker, shared.failMat).position.set(pw[0], pw[1], pw[2]);
          }
        }
        if (flags.jointAxes && axes && axesGeom) {
          const apos = axesGeom.getAttribute('position') as THREE.BufferAttribute;
          const n = Math.min(pose.worldPos.length, apos.count / 6);
          for (let j = 0; j < n; j++) {
            const p = pose.worldPos[j]!;
            const q = pose.worldRot[j]!;
            Q.set(q[0], q[1], q[2], q[3]);
            for (let a = 0; a < 3; a++) {
              V.copy(AXIS_DIRS[a]!).applyQuaternion(Q).multiplyScalar(AXIS_LEN);
              apos.setXYZ(j * 6 + a * 2, p[0], p[1], p[2]);
              apos.setXYZ(j * 6 + a * 2 + 1, p[0] + V.x, p[1] + V.y, p[2] + V.z);
            }
          }
          apos.needsUpdate = true;
          axes.visible = true;
        }
        if (flags.trajectory && traj) {
          const pw = pose.pelvisWorld;
          marker.position.set(pw[0], pw[1], pw[2]);
          marker.visible = true;
        }
      }
      residualGeom.setDrawRange(0, seg * 2);
      residuals.visible = seg > 0;
      targets.end();
      sites.end();
      failures.end();
    },
    clear() {
      targets.clear();
      sites.clear();
      failures.clear();
      residualGeom.setDrawRange(0, 0);
      residuals.visible = false;
      arrow.visible = false;
      marker.visible = false;
      if (axes) axes.visible = false;
    },
    visibleCounts() {
      return {
        targets: targets.visibleCount(),
        sites: sites.visibleCount(),
        failures: failures.visibleCount(),
        residualSegments: residuals.visible ? residualGeom.drawRange.count / 2 : 0,
        axes: axes?.visible ?? false,
        arrow: arrow.visible,
        trajectoryPoints: traj ? (trajGeom?.getAttribute('position')?.count ?? 0) : 0,
      };
    },
  };
}

/** Host-skeleton bones reconstructed by the rig adapter, drawn as thin lines (stage-level). */
export interface HostBoneOverlay {
  readonly group: THREE.Group;
  set(bones: readonly HostBoneView[] | null): void;
  setVisible(v: boolean): void;
}

export function createHostBoneOverlay(shared: OverlayShared, tracker: ResourceTracker): HostBoneOverlay {
  const group = new THREE.Group();
  group.name = 'host-bones';
  let lineGeom: THREE.BufferGeometry | null = null;
  let pointGeom: THREE.BufferGeometry | null = null;
  let visible = false;
  let has = false;
  const clear = (): void => {
    group.clear();
    tracker.release(lineGeom);
    tracker.release(pointGeom);
    lineGeom = null;
    pointGeom = null;
    has = false;
  };
  return {
    group,
    set(bones) {
      if (!bones || bones.length === 0) {
        clear();
        group.visible = false;
        return;
      }
      const byName = new Map(bones.map((b) => [b.name, b] as const));
      const seg: number[] = [];
      for (const b of bones) {
        const p = b.parent ? byName.get(b.parent) : undefined;
        if (p) seg.push(p.position[0], p.position[1], p.position[2], b.position[0], b.position[1], b.position[2]);
      }
      const pts = bones.flatMap((b) => [b.position[0], b.position[1], b.position[2]]);
      // Update in place when the bone count is unchanged (called every frame).
      if (has && lineGeom && pointGeom && (lineGeom.getAttribute('position') as THREE.BufferAttribute).array.length === seg.length && (pointGeom.getAttribute('position') as THREE.BufferAttribute).array.length === pts.length) {
        const la = lineGeom.getAttribute('position') as THREE.BufferAttribute;
        (la.array as Float32Array).set(seg);
        la.needsUpdate = true;
        const pa = pointGeom.getAttribute('position') as THREE.BufferAttribute;
        (pa.array as Float32Array).set(pts);
        pa.needsUpdate = true;
      } else {
        clear();
        lineGeom = tracker.track(new THREE.BufferGeometry());
        lineGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
        pointGeom = tracker.track(new THREE.BufferGeometry());
        pointGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
        const lines = new THREE.LineSegments(lineGeom, shared.hostBoneMat);
        const points = new THREE.Points(pointGeom, shared.hostJointMat);
        lines.frustumCulled = false;
        points.frustumCulled = false;
        lines.renderOrder = 7;
        points.renderOrder = 7;
        group.add(lines, points);
        has = true;
      }
      group.visible = visible;
    },
    setVisible(v) {
      visible = v;
      group.visible = v && has;
    },
  };
}
