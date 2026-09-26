import type { Diagnostic } from '../core/contracts/diagnostics.ts';
import type { ParamRecord, ParamSpec } from '../core/contracts/recipe.ts';

/** Raw editor values: numbers are kept as the typed text so partial input is not lost. */
export type RawParams = Record<string, string>;

export function rawFromRecord(specs: readonly ParamSpec[], values: ParamRecord): RawParams {
  const raw: RawParams = {};
  for (const s of specs) {
    const v = values[s.key] ?? s.default;
    raw[s.key] = String(v);
  }
  return raw;
}

export interface ParamValidation {
  values: ParamRecord;
  errors: Record<string, string>;
  valid: boolean;
}

/** Validates editor input against the recipe's param specs (range, finiteness, enum membership). */
export function validateParams(specs: readonly ParamSpec[], raw: RawParams): ParamValidation {
  const values: ParamRecord = {};
  const errors: Record<string, string> = {};
  for (const s of specs) {
    const text = (raw[s.key] ?? '').trim();
    if (s.kind === 'number') {
      if (text === '') {
        errors[s.key] = 'Enter a number.';
        continue;
      }
      const v = Number(text);
      if (!Number.isFinite(v)) {
        errors[s.key] = `“${text}” is not a number.`;
        continue;
      }
      if (v < s.min || v > s.max) {
        errors[s.key] = `Must be between ${s.min} and ${s.max}${s.unit === 'deg' ? '°' : s.unit === 'count' || s.unit === 'ratio' ? '' : ` ${s.unit}`}.`;
        continue;
      }
      if (s.unit === 'count' && !Number.isInteger(v)) {
        errors[s.key] = 'Must be a whole number.';
        continue;
      }
      values[s.key] = v;
    } else {
      if (!s.options.includes(text)) {
        errors[s.key] = `Choose one of: ${s.options.join(', ')}.`;
        continue;
      }
      values[s.key] = text;
    }
  }
  return { values, errors, valid: Object.keys(errors).length === 0 };
}

/** Maps compile diagnostics with a `params.<key>` path onto editor fields. */
export function paramErrorsFromDiagnostics(diagnostics: readonly Diagnostic[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of diagnostics) {
    if (d.severity !== 'error' || !d.path) continue;
    const m = /^params\.([A-Za-z0-9_]+)/.exec(d.path);
    if (m && m[1] && !out[m[1]]) out[m[1]] = d.hint ? `${d.message} ${d.hint}` : d.message;
  }
  return out;
}
