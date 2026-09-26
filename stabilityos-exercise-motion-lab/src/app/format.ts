import type { ParamSpec } from '../core/contracts/recipe.ts';

export const RAD2DEG = 180 / Math.PI;

export function mm(m: number | null | undefined, digits = 2): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  return `${(m * 1000).toFixed(digits)} mm`;
}

export function degFromRad(r: number | null | undefined, digits = 2): string {
  if (r === null || r === undefined || !Number.isFinite(r)) return '—';
  return `${(r * RAD2DEG).toFixed(digits)}°`;
}

export function seconds(t: number, digits = 2): string {
  return `${t.toFixed(digits)} s`;
}

export function unitLabel(spec: ParamSpec): string {
  if (spec.kind !== 'number') return '';
  switch (spec.unit) {
    case 'deg':
      return '°';
    case 'count':
      return '×';
    case 'ratio':
      return '';
    default:
      return spec.unit;
  }
}

export function unitWord(spec: ParamSpec): string {
  if (spec.kind !== 'number') return '';
  switch (spec.unit) {
    case 'deg':
      return 'degrees';
    case 'm':
      return 'metres';
    case 's':
      return 'seconds';
    case 'count':
      return 'count';
    case 'ratio':
      return 'ratio';
  }
}

export function sci(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v === 0) return '0';
  return Math.abs(v) < 1e-3 ? v.toExponential(1) : v.toFixed(4);
}
