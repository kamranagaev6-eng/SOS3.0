import * as THREE from 'three';

type V3 = readonly [number, number, number];

/**
 * Tapered capsule from `from` (radius r0) to `to` (radius r1), built as a lathe so a limb is a
 * single draw call. `radialScale` squashes the cross-section ([x, z] before orientation), used for
 * the flattened trunk and hands.
 */
export function taperedCapsule(
  from: V3,
  to: V3,
  r0: number,
  r1: number,
  radialScale: readonly [number, number] = [1, 1],
  radialSegments = 18,
): THREE.BufferGeometry {
  const dir = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const len = Math.max(dir.length(), 1e-6);
  const pts: THREE.Vector2[] = [];
  const capSteps = 6;
  for (let i = 0; i <= capSteps; i++) {
    const a = -Math.PI / 2 + (i / capSteps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(r0 * Math.cos(a), i === 0 ? 0 : 1e-5), r0 * Math.sin(a)));
  }
  for (let i = 0; i <= capSteps; i++) {
    const a = (i / capSteps) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(r1 * Math.cos(a), i === capSteps ? 0 : 1e-5), len + r1 * Math.sin(a)));
  }
  const g = new THREE.LatheGeometry(pts, radialSegments);
  if (radialScale[0] !== 1 || radialScale[1] !== 1) g.scale(radialScale[0], 1, radialScale[1]);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  g.translate(from[0], from[1], from[2]);
  // Lathe normals are analytic; applyMatrix4 (scale / rotate / translate) transforms them correctly.
  return g;
}

/**
 * Box whose cross-section varies linearly along Z (the foot and toe shapes). Bottom face is flat
 * at `bottomY`; the top rises from `topAt0` at z0 to `topAt1` at z1; width from w0 to w1.
 */
export function taperedBox(opts: {
  z0: number;
  z1: number;
  bottomY: number;
  topAt0: number;
  topAt1: number;
  w0: number;
  w1: number;
  centerX?: number;
}): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1, 1, 1, 2);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const cx = opts.centerX ?? 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const f = z + 0.5;
    const w = opts.w0 + (opts.w1 - opts.w0) * f;
    const top = opts.topAt0 + (opts.topAt1 - opts.topAt0) * f;
    pos.setXYZ(i, cx + x * w, y < 0 ? opts.bottomY : top, opts.z0 + (opts.z1 - opts.z0) * f);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
