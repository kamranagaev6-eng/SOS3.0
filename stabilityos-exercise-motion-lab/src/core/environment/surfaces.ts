import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import { environmentSchema, type Environment, type SolidBox, type SupportSurface } from '../contracts/environment.ts';
import { formatZodIssues, SCHEMA } from '../contracts/common.ts';
import type { Vec3 } from '../math/vec3.ts';

/** Support surfaces are the top faces of environment objects. Surface ids: `<floorId>`, `<chairId>.seat`, `<stepId>.top`. */
export function supportSurfaces(env: Environment): SupportSurface[] {
  const out: SupportSurface[] = [];
  for (const o of env.objects) {
    if (o.kind === 'floor') out.push({ id: o.id, objectId: o.id, y: 0, bounds: null });
    else if (o.kind === 'chair')
      out.push({
        id: `${o.id}.seat`,
        objectId: o.id,
        y: o.seatHeight,
        bounds: { minX: o.centerX - o.seatWidth / 2, maxX: o.centerX + o.seatWidth / 2, minZ: o.frontZ - o.seatDepth, maxZ: o.frontZ },
      });
    else
      out.push({
        id: `${o.id}.top`,
        objectId: o.id,
        y: o.height,
        bounds: { minX: o.centerX - o.width / 2, maxX: o.centerX + o.width / 2, minZ: o.frontZ, maxZ: o.frontZ + o.depth },
      });
  }
  return out;
}

export function findSurface(env: Environment, id: string): SupportSurface | null {
  return supportSurfaces(env).find((s) => s.id === id) ?? null;
}

const BACKREST_THICKNESS = 0.03;

/** Solids for penetration checks. Chair legs are visual only and are not solids (documented limitation). */
export function solids(env: Environment): SolidBox[] {
  const out: SolidBox[] = [];
  for (const o of env.objects) {
    if (o.kind === 'chair') {
      const x0 = o.centerX - o.seatWidth / 2;
      const x1 = o.centerX + o.seatWidth / 2;
      out.push({ id: `${o.id}.seat`, min: [x0, o.seatHeight - o.seatThickness, o.frontZ - o.seatDepth], max: [x1, o.seatHeight, o.frontZ] });
      if (o.backrestHeight > 0)
        out.push({
          id: `${o.id}.backrest`,
          min: [x0, o.seatHeight, o.frontZ - o.seatDepth],
          max: [x1, o.seatHeight + o.backrestHeight, o.frontZ - o.seatDepth + BACKREST_THICKNESS],
        });
    } else if (o.kind === 'step') {
      out.push({
        id: `${o.id}.box`,
        min: [o.centerX - o.width / 2, 0, o.frontZ],
        max: [o.centerX + o.width / 2, o.height, o.frontZ + o.depth],
      });
    }
  }
  return out;
}

export function insideBounds(
  p: { x: number; z: number },
  b: SupportSurface['bounds'],
  margin = 0,
): boolean {
  if (!b) return true;
  return p.x >= b.minX - margin && p.x <= b.maxX + margin && p.z >= b.minZ - margin && p.z <= b.maxZ + margin;
}

/**
 * Penetration depth of a point: below the floor, or inside a solid (distance to the nearest face).
 * 0 when the point is free.
 */
export function penetrationDepth(p: Vec3, boxes: readonly SolidBox[]): { depth: number; solid: string | null } {
  let depth = p[1] < 0 ? -p[1] : 0;
  let solid: string | null = depth > 0 ? 'floor' : null;
  for (const b of boxes) {
    if (p[0] > b.min[0] && p[0] < b.max[0] && p[1] > b.min[1] && p[1] < b.max[1] && p[2] > b.min[2] && p[2] < b.max[2]) {
      const d = Math.min(p[0] - b.min[0], b.max[0] - p[0], p[1] - b.min[1], b.max[1] - p[1], p[2] - b.min[2], b.max[2] - p[2]);
      if (d > depth) {
        depth = d;
        solid = b.id;
      }
    }
  }
  return { depth, solid };
}

function boxesOverlap(a: SolidBox, b: SolidBox): boolean {
  return a.min.every((v, i) => v < (b.max[i] as number)) && b.min.every((v, i) => v < (a.max[i] as number));
}

/** Schema + semantic validation. Invalid geometry is reported, never repaired. */
export function validateEnvironment(input: unknown): { env: Environment | null; diagnostics: Diagnostic[] } {
  const parsed = environmentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      env: null,
      diagnostics: formatZodIssues(parsed.error).map((m) => diag('INVALID_GEOMETRY', 'error', `environment ${m}`, { path: 'environment' })),
    };
  }
  const env = parsed.data;
  const out: Diagnostic[] = [];
  if (env.schema !== SCHEMA.environment) out.push(diag('INVALID_GEOMETRY', 'error', 'unknown environment schema'));
  const ids = new Set<string>();
  for (const o of env.objects) {
    if (ids.has(o.id)) out.push(diag('INVALID_GEOMETRY', 'error', `duplicate environment object id '${o.id}'`, { subject: o.id }));
    ids.add(o.id);
    if (o.kind === 'chair') {
      if (o.seatHeight < 0.25 || o.seatHeight > 0.75)
        out.push(diag('INVALID_GEOMETRY', 'error', `chair '${o.id}' seat height ${o.seatHeight} m outside supported 0.25–0.75 m`, { subject: o.id, value: o.seatHeight }));
      if (o.seatThickness >= o.seatHeight)
        out.push(diag('INVALID_GEOMETRY', 'error', `chair '${o.id}' seat thickness must be below the seat height`, { subject: o.id }));
      for (const [k, v] of [['seatDepth', o.seatDepth], ['seatWidth', o.seatWidth]] as const)
        if (v < 0.25 || v > 1.2) out.push(diag('INVALID_GEOMETRY', 'error', `chair '${o.id}' ${k} ${v} m outside 0.25–1.2 m`, { subject: o.id, value: v }));
    }
    if (o.kind === 'step') {
      if (o.height < 0.03 || o.height > 0.4)
        out.push(diag('INVALID_GEOMETRY', 'error', `step '${o.id}' height ${o.height} m outside supported 0.03–0.40 m`, { subject: o.id, value: o.height }));
      if (o.depth < 0.15 || o.depth > 1.5)
        out.push(diag('INVALID_GEOMETRY', 'error', `step '${o.id}' depth ${o.depth} m outside 0.15–1.5 m`, { subject: o.id, value: o.depth }));
      if (o.width < 0.3 || o.width > 3)
        out.push(diag('INVALID_GEOMETRY', 'error', `step '${o.id}' width ${o.width} m outside 0.3–3 m`, { subject: o.id, value: o.width }));
    }
  }
  const floors = env.objects.filter((o) => o.kind === 'floor').length;
  if (floors !== 1) out.push(diag('INVALID_GEOMETRY', 'error', `exactly one floor is required (found ${floors})`));
  const bs = solids(env);
  for (let i = 0; i < bs.length; i++)
    for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i]!;
      const b = bs[j]!;
      if (a.id.split('.')[0] !== b.id.split('.')[0] && boxesOverlap(a, b))
        out.push(diag('INVALID_GEOMETRY', 'error', `solids '${a.id}' and '${b.id}' intersect`, { subject: `${a.id}|${b.id}` }));
    }
  return { env, diagnostics: out };
}
