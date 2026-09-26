import { describe, expect, it } from 'vitest';
import { SCHEMA } from '../../src/core/contracts/common.ts';
import { DIAGNOSTIC_CODES } from '../../src/core/contracts/diagnostics.ts';
import { RECIPE_IDS, newRecipeDocument, type ParamSpec, type RecipeDocument } from '../../src/core/contracts/recipe.ts';
import {
  MAX_RECIPE_JSON_BYTES,
  exportRecipeJson,
  importRecipeJson,
  type RecipeImportResult,
  type RecipeParamInfo,
} from '../../src/core/io/recipeIo.ts';
import { createRng, type Rng } from '../../src/core/math/rng.ts';
import { getRecipe } from '../../src/core/recipes/registry.ts';

// A parameter-spec fixture so these tests do not depend on the (concurrently developed) registry.
const FIXTURE_SPECS: readonly ParamSpec[] = [
  { key: 'seatHeight', label: 'Seat height', kind: 'number', unit: 'm', min: 0.35, max: 0.6, step: 0.01, default: 0.45, description: '' },
  { key: 'peakKneeFlexionDeg', label: 'Peak knee flexion', kind: 'number', unit: 'deg', min: 20, max: 110, step: 1, default: 80, description: '' },
  { key: 'cycleDuration', label: 'Cycle duration', kind: 'number', unit: 's', min: 2, max: 8, step: 0.1, default: 4, description: '' },
  { key: 'cycles', label: 'Cycles', kind: 'number', unit: 'count', min: 1, max: 3, step: 1, default: 1, description: '' },
  { key: 'stanceRatio', label: 'Stance ratio', kind: 'number', unit: 'ratio', min: 0, max: 1, step: 0.05, default: 0.5, description: '' },
  { key: 'leadingSide', label: 'Leading side', kind: 'enum', options: ['left', 'right'], default: 'left', description: '' },
];
const FIXTURE: RecipeParamInfo = { id: 'fixture-recipe.v1', paramSpecs: FIXTURE_SPECS };
const resolveRecipe = (id: string): RecipeParamInfo | null => (id === FIXTURE.id ? FIXTURE : null);
const opts = { resolveRecipe };

function validDoc(): RecipeDocument {
  return {
    schema: SCHEMA.recipe,
    recipeId: FIXTURE.id,
    reviewStatus: 'unreviewed-synthetic',
    params: { seatHeight: 0.45, peakKneeFlexionDeg: 80, cycleDuration: 4, cycles: 1, stanceRatio: 0.5, leadingSide: 'left' },
    provenance: { generator: 'stabilityos-exercise-motion-lab', generatorVersion: '0.1.0', createdAt: '2026-09-26T00:00:00.000Z', note: '' },
  };
}

function expectFailure(r: RecipeImportResult, code?: string, path?: string): void {
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.diagnostics.length).toBeGreaterThan(0);
  for (const d of r.diagnostics) {
    expect(DIAGNOSTIC_CODES).toContain(d.code);
    expect(d.severity).toBe('error');
    expect(d.message).not.toMatch(/internal error/);
  }
  if (code) expect(r.diagnostics.map((d) => d.code)).toContain(code);
  if (path) expect(r.diagnostics.map((d) => d.path)).toContain(path);
}

const withText = (mutate: (o: Record<string, unknown>) => void): string => {
  const o = JSON.parse(exportRecipeJson(validDoc())) as Record<string, unknown>;
  mutate(o);
  return JSON.stringify(o);
};

describe('recipe JSON export', () => {
  it('round-trips export -> import -> export byte-identically', () => {
    const doc = validDoc();
    const text = exportRecipeJson(doc);
    const r = importRecipeJson(text, opts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc).toEqual(doc);
    expect(exportRecipeJson(r.doc)).toBe(text);
  });

  it('uses a stable key order independent of insertion order', () => {
    const a = validDoc();
    const b: RecipeDocument = {
      provenance: { note: '', createdAt: a.provenance.createdAt, generatorVersion: '0.1.0', generator: a.provenance.generator },
      params: Object.fromEntries(Object.entries(a.params).reverse()),
      reviewStatus: 'unreviewed-synthetic',
      recipeId: a.recipeId,
      schema: SCHEMA.recipe,
    };
    expect(exportRecipeJson(b)).toBe(exportRecipeJson(a));
    const text = exportRecipeJson(a);
    expect(text.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual(['schema', 'recipeId', 'reviewStatus', 'params', 'provenance']);
    expect(Object.keys((JSON.parse(text) as { params: object }).params)).toEqual([...Object.keys(a.params)].sort());
  });

  it('refuses to write a document with a forged review status or a forbidden key', () => {
    const forged = { ...validDoc(), reviewStatus: 'approved' } as unknown as RecipeDocument;
    expect(() => exportRecipeJson(forged)).toThrow(/invalid recipe document/);
    const polluted = validDoc();
    Object.defineProperty(polluted.params, '__proto__', { value: 1, enumerable: true });
    expect(() => exportRecipeJson(polluted)).toThrow(/forbidden/);
  });
});

describe('recipe JSON import: malformed input produces diagnostics, never throws', () => {
  it('invalid and truncated JSON', () => {
    expectFailure(importRecipeJson('{', opts), 'SCHEMA_INVALID');
    expectFailure(importRecipeJson('', opts), 'SCHEMA_INVALID');
    expectFailure(importRecipeJson('   \n ', opts), 'SCHEMA_INVALID');
    expectFailure(importRecipeJson('NaN', opts), 'SCHEMA_INVALID');
    expectFailure(importRecipeJson('{"seatHeight": NaN}', opts), 'SCHEMA_INVALID');
    const text = exportRecipeJson(validDoc());
    for (const cut of [1, 10, 50, Math.floor(text.length / 2), text.length - 3]) {
      const r = importRecipeJson(text.slice(0, cut), opts);
      expectFailure(r, 'SCHEMA_INVALID');
      if (!r.ok) expect(r.diagnostics[0]!.message).toMatch(/Invalid JSON/);
    }
  });

  it('non-object roots and non-string input', () => {
    for (const t of ['[]', '1', '"x"', 'null', 'true']) expectFailure(importRecipeJson(t, opts), 'SCHEMA_INVALID', '(root)');
    expectFailure(importRecipeJson(42 as unknown as string, opts), 'SCHEMA_INVALID');
    expectFailure(importRecipeJson(undefined as unknown as string, opts), 'SCHEMA_INVALID');
  });

  it('wrong schema version is rejected with a clear message', () => {
    for (const schema of ['smx.recipe/2', 'smx.recipe/0', 'smx.motion-plan/1', '', 7, null]) {
      const r = importRecipeJson(withText((o) => (o['schema'] = schema)), opts);
      expectFailure(r, 'SCHEMA_INVALID', 'schema');
      if (!r.ok) expect(r.diagnostics.find((d) => d.path === 'schema')!.message).toMatch(/Unsupported recipe document schema|only understands 'smx\.recipe\/1'/);
    }
    const missing = importRecipeJson(withText((o) => delete o['schema']), opts);
    expectFailure(missing, 'SCHEMA_INVALID', 'schema');
    if (!missing.ok) expect(missing.diagnostics[0]!.message).toMatch(/Missing 'schema'/);
  });

  it('any review status other than unreviewed-synthetic is rejected (cannot mark content reviewed)', () => {
    for (const status of ['approved', 'reviewed', 'published', 'UNREVIEWED-SYNTHETIC', '', null, true]) {
      const r = importRecipeJson(withText((o) => (o['reviewStatus'] = status)), opts);
      expectFailure(r, 'SCHEMA_INVALID', 'reviewStatus');
      if (!r.ok) expect(r.diagnostics.find((d) => d.path === 'reviewStatus')!.message).toMatch(/cannot mark content reviewed/);
    }
    expectFailure(importRecipeJson(withText((o) => delete o['reviewStatus']), opts), 'SCHEMA_INVALID', 'reviewStatus');
  });

  it('missing fields and wrong types', () => {
    for (const key of ['recipeId', 'params', 'provenance']) {
      expectFailure(importRecipeJson(withText((o) => delete o[key]), opts), 'SCHEMA_INVALID', key);
    }
    for (const key of ['generator', 'generatorVersion', 'createdAt', 'note']) {
      expectFailure(importRecipeJson(withText((o) => delete (o['provenance'] as Record<string, unknown>)[key]), opts), 'SCHEMA_INVALID');
    }
    expectFailure(importRecipeJson(withText((o) => (o['params'] = [])), opts), 'SCHEMA_INVALID', 'params');
    expectFailure(importRecipeJson(withText((o) => (o['params'] = 'x')), opts), 'SCHEMA_INVALID', 'params');
    expectFailure(importRecipeJson(withText((o) => (o['provenance'] = null)), opts), 'SCHEMA_INVALID', 'provenance');
    expectFailure(importRecipeJson(withText((o) => (o['recipeId'] = 5)), opts), 'SCHEMA_INVALID', 'recipeId');
    expectFailure(importRecipeJson(withText((o) => (o['recipeId'] = 'bad id with spaces')), opts), 'SCHEMA_INVALID', 'recipeId');
    expectFailure(
      importRecipeJson(withText((o) => ((o['provenance'] as Record<string, unknown>)['note'] = 'x'.repeat(1001))), opts),
      'SCHEMA_INVALID',
    );
  });

  it('parameter type, range, enum and unknown-key validation delegates to the recipe paramSpecs', () => {
    const setParam = (k: string, v: unknown) => withText((o) => ((o['params'] as Record<string, unknown>)[k] = v));
    expectFailure(importRecipeJson(setParam('seatHeight', 'NaN'), opts), 'SCHEMA_INVALID', 'params.seatHeight');
    expectFailure(importRecipeJson(setParam('seatHeight', '0.45'), opts), 'SCHEMA_INVALID', 'params.seatHeight');
    expectFailure(importRecipeJson(setParam('seatHeight', 'Infinity'), opts), 'SCHEMA_INVALID', 'params.seatHeight');
    expectFailure(importRecipeJson(setParam('seatHeight', true), opts), 'SCHEMA_INVALID', 'params.seatHeight');
    expectFailure(importRecipeJson(setParam('seatHeight', null), opts), 'SCHEMA_INVALID', 'params.seatHeight');
    expectFailure(importRecipeJson(setParam('seatHeight', 0.2), opts), 'PARAM_OUT_OF_RANGE', 'params.seatHeight');
    expectFailure(importRecipeJson(setParam('seatHeight', 0.61), opts), 'PARAM_OUT_OF_RANGE', 'params.seatHeight');
    expectFailure(importRecipeJson(setParam('seatHeight', 1e308), opts), 'PARAM_OUT_OF_RANGE', 'params.seatHeight');
    expectFailure(importRecipeJson(setParam('seatHeight', -1e308), opts), 'PARAM_OUT_OF_RANGE', 'params.seatHeight');
    expectFailure(importRecipeJson(setParam('cycles', 1.5), opts), 'PARAM_OUT_OF_RANGE', 'params.cycles');
    expectFailure(importRecipeJson(setParam('leadingSide', 'both'), opts), 'PARAM_OUT_OF_RANGE', 'params.leadingSide');
    expectFailure(importRecipeJson(setParam('leadingSide', 1), opts), 'SCHEMA_INVALID', 'params.leadingSide');
    expectFailure(importRecipeJson(setParam('extraKnob', 1), opts), 'SCHEMA_INVALID', 'params.extraKnob');
    expectFailure(importRecipeJson(withText((o) => delete (o['params'] as Record<string, unknown>)['stanceRatio']), opts), 'SCHEMA_INVALID', 'params.stanceRatio');
    // Huge numeric literals parse to Infinity.
    const huge = exportRecipeJson(validDoc()).replace('"seatHeight": 0.45', '"seatHeight": 1e400');
    expectFailure(importRecipeJson(huge, opts), 'PARAM_OUT_OF_RANGE', 'params.seatHeight');
    // Boundary values are accepted.
    expect(importRecipeJson(setParam('seatHeight', 0.35), opts).ok).toBe(true);
    expect(importRecipeJson(setParam('seatHeight', 0.6), opts).ok).toBe(true);
  });

  it('unknown keys at any level are rejected', () => {
    expectFailure(importRecipeJson(withText((o) => (o['dose'] = '3x10')), opts), 'SCHEMA_INVALID', 'dose');
    expectFailure(
      importRecipeJson(withText((o) => ((o['provenance'] as Record<string, unknown>)['reviewer'] = 'x')), opts),
      'SCHEMA_INVALID',
      'provenance.reviewer',
    );
  });

  it('unknown recipe id -> UNKNOWN_RECIPE (lookup at call time)', () => {
    expectFailure(importRecipeJson(withText((o) => (o['recipeId'] = 'lunge.v1')), opts), 'UNKNOWN_RECIPE', 'recipeId');
    // Default resolver is the live registry.
    const doc = { ...validDoc(), recipeId: 'definitely-not-a-recipe.v9' };
    expectFailure(importRecipeJson(JSON.stringify(doc)), 'UNKNOWN_RECIPE', 'recipeId');
  });

  it('prototype-pollution keys are rejected and do not pollute', () => {
    const base = exportRecipeJson(validDoc());
    const cases = [
      base.replace('{\n', '{\n  "__proto__": {"polluted": true},\n'),
      base.replace('"params": {\n', '"params": {\n    "__proto__": {"polluted": true},\n'),
      base.replace('"provenance": {\n', '"provenance": {\n    "__proto__": {"polluted": true},\n'),
      base.replace('"params": {\n', '"params": {\n    "constructor": {"prototype": {"polluted": true}},\n'),
      base.replace('{\n', '{\n  "prototype": 1,\n'),
    ];
    for (const text of cases) {
      expect(text).not.toBe(base);
      const r = importRecipeJson(text, opts);
      expectFailure(r, 'SCHEMA_INVALID');
      if (!r.ok) expect(r.diagnostics.some((d) => /Forbidden key/.test(d.message))).toBe(true);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('oversized input is rejected before parsing', () => {
    const doc = exportRecipeJson(validDoc());
    const padded = doc.replace('{', `{${' '.repeat(MAX_RECIPE_JSON_BYTES)}`);
    const r = importRecipeJson(padded, opts);
    expectFailure(r, 'SCHEMA_INVALID');
    if (!r.ok) expect(r.diagnostics[0]!.message).toMatch(/larger than/);
    // Multi-byte characters count as UTF-8 bytes.
    const wide = doc.replace('"note": ""', `"note": "${'€'.repeat(Math.ceil(MAX_RECIPE_JSON_BYTES / 3))}"`);
    expect(wide.length).toBeLessThan(MAX_RECIPE_JSON_BYTES);
    expectFailure(importRecipeJson(wide, opts), 'SCHEMA_INVALID');
  });

  it('deep nesting does not overflow the stack', () => {
    const deep = '['.repeat(100_000) + ']'.repeat(100_000);
    const text = exportRecipeJson(validDoc()).replace('"seatHeight": 0.45', `"seatHeight": ${deep}`);
    expect(() => importRecipeJson(text, opts)).not.toThrow();
    expectFailure(importRecipeJson(text, opts), 'SCHEMA_INVALID');
    const deepObj = '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000);
    expectFailure(importRecipeJson(deepObj, opts), 'SCHEMA_INVALID');
  });

  it('accepts a UTF-8 BOM and reports several problems in one pass', () => {
    expect(importRecipeJson(`﻿${exportRecipeJson(validDoc())}`, opts).ok).toBe(true);
    const r = importRecipeJson(
      withText((o) => {
        const p = o['params'] as Record<string, unknown>;
        p['seatHeight'] = 9;
        p['leadingSide'] = 'up';
        p['unknown'] = 1;
      }),
      opts,
    );
    expectFailure(r);
    if (!r.ok) expect(r.diagnostics.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------------------------
// Seeded mutation fuzz with an independent oracle.
// ---------------------------------------------------------------------------------------------

const ID_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;
const FORBIDDEN = ['__proto__', 'constructor', 'prototype'];

function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function hasForbidden(v: unknown, depth = 0): boolean {
  if (depth > 40 || v === null || typeof v !== 'object') return depth > 40;
  if (Array.isArray(v)) return v.some((x) => hasForbidden(x, depth + 1));
  return Object.keys(v).some((k) => FORBIDDEN.includes(k) || hasForbidden((v as Record<string, unknown>)[k], depth + 1));
}
function sameKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const k = Object.keys(o).sort();
  const e = [...keys].sort();
  return k.length === e.length && k.every((x, i) => x === e[i]);
}

/** Independent statement of validity (written separately from the importer). */
function oracleValid(text: string): boolean {
  if (new TextEncoder().encode(text).length > MAX_RECIPE_JSON_BYTES) return false;
  let v: unknown;
  try {
    v = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return false;
  }
  if (!isPlain(v) || hasForbidden(v)) return false;
  if (!sameKeys(v, ['schema', 'recipeId', 'reviewStatus', 'params', 'provenance'])) return false;
  if (v['schema'] !== 'smx.recipe/1' || v['reviewStatus'] !== 'unreviewed-synthetic') return false;
  if (typeof v['recipeId'] !== 'string' || !ID_RE.test(v['recipeId'])) return false;
  const prov = v['provenance'];
  if (!isPlain(prov) || !sameKeys(prov, ['generator', 'generatorVersion', 'createdAt', 'note'])) return false;
  if (!['generator', 'generatorVersion', 'createdAt', 'note'].every((k) => typeof prov[k] === 'string')) return false;
  if ((prov['note'] as string).length > 1000) return false;
  const recipe = resolveRecipe(v['recipeId']);
  if (!recipe) return false;
  const params = v['params'];
  if (!isPlain(params) || !sameKeys(params, recipe.paramSpecs.map((s) => s.key))) return false;
  return recipe.paramSpecs.every((s) => {
    const x = params[s.key];
    if (s.kind === 'enum') return typeof x === 'string' && s.options.includes(x);
    return typeof x === 'number' && Number.isFinite(x) && x >= s.min && x <= s.max && (s.unit !== 'count' || Number.isInteger(x));
  });
}

function randomValue(rng: Rng): unknown {
  switch (rng.int(0, 11)) {
    case 0:
      return null;
    case 1:
      return rng.next() < 0.5;
    case 2:
      return rng.range(-1e6, 1e6);
    case 3:
      return rng.pick(['NaN', 'Infinity', '-Infinity', '0.45', '', 'left', 'right', 'both', 'approved']);
    case 4:
      return [];
    case 5:
      return { a: 1 };
    case 6:
      return rng.pick([1e308, -1e308, 5e-324, 0, -0]);
    case 7:
      return rng.int(-3, 5);
    case 8:
      return rng.range(0, 1);
    case 9:
      return 'x'.repeat(rng.int(0, 1200));
    case 10:
      return rng.pick(['smx.recipe/1', 'smx.recipe/2', 'unreviewed-synthetic', FIXTURE.id, 'sit-to-stand.v1']);
    default:
      return rng.range(0.3, 0.7);
  }
}

function inRangeValue(spec: ParamSpec, rng: Rng): unknown {
  if (spec.kind === 'enum') return rng.pick(spec.options);
  return spec.unit === 'count' ? rng.int(spec.min, spec.max) : rng.range(spec.min, spec.max);
}

function mutate(rng: Rng): { text: string; kind: string } {
  const doc = JSON.parse(exportRecipeJson(validDoc())) as Record<string, unknown>;
  const params = doc['params'] as Record<string, unknown>;
  const prov = doc['provenance'] as Record<string, unknown>;
  const containers: Record<string, unknown>[] = [doc, params, prov];
  const kind = rng.int(0, 13);
  switch (kind) {
    case 0: {
      const c = rng.pick(containers);
      const keys = Object.keys(c);
      delete c[rng.pick(keys)];
      break;
    }
    case 1: {
      const c = rng.pick(containers);
      c[rng.pick(Object.keys(c))] = randomValue(rng);
      break;
    }
    case 2: {
      const spec = rng.pick(FIXTURE_SPECS);
      if (spec.kind === 'number') {
        const span = spec.max - spec.min;
        params[spec.key] = rng.pick([spec.min - rng.range(1e-9, span), spec.max + rng.range(1e-9, span), spec.min, spec.max]);
      } else params[spec.key] = rng.pick(['LEFT', 'center', ...spec.options]);
      break;
    }
    case 3: {
      const spec = rng.pick(FIXTURE_SPECS);
      params[spec.key] = inRangeValue(spec, rng); // valid mutation: must stay accepted
      break;
    }
    case 4:
      rng.pick(containers)[`k${rng.int(0, 99)}`] = randomValue(rng);
      break;
    case 5:
      doc['reviewStatus'] = rng.pick(['approved', 'reviewed', 'unreviewed-synthetic', 'Unreviewed-synthetic']);
      break;
    case 6:
      doc['schema'] = rng.pick(['smx.recipe/1', 'smx.recipe/2', 'smx.recipe', 'smx.export-manifest/1']);
      break;
    case 7:
      doc['recipeId'] = rng.pick([FIXTURE.id, 'unknown.v1', '1bad', '', 'fixture-recipe.v2', ...RECIPE_IDS]);
      break;
    case 8: {
      const text = exportRecipeJson(doc as RecipeDocument);
      return { text: text.slice(0, rng.int(0, text.lastIndexOf('}') - 1)), kind: 'truncate' };
    }
    case 9: {
      const text = JSON.stringify(doc);
      const i = rng.int(0, text.length - 1);
      const ch = rng.pick(['{', '}', '"', ',', ':', '0', '9', '.', '-', 'e', ' ', '\\', 'x', '\u0000', '€']);
      return { text: text.slice(0, i) + ch + text.slice(i + (rng.next() < 0.5 ? 1 : 0)), kind: 'byte' };
    }
    case 10: {
      const text = JSON.stringify(doc);
      const where = rng.pick(['{', '"params":{', '"provenance":{']);
      const key = rng.pick(FORBIDDEN);
      return { text: text.replace(where, `${where}"${key}":{"polluted":true},`), kind: 'proto' };
    }
    case 11: {
      let nested: unknown = 1;
      for (let d = rng.int(1, 60); d > 0; d--) nested = rng.next() < 0.5 ? [nested] : { n: nested };
      params[rng.pick(FIXTURE_SPECS).key] = nested;
      break;
    }
    case 12: {
      const text = JSON.stringify(doc);
      // Duplicate keys: JSON.parse keeps the last occurrence.
      return { text: text.replace('"reviewStatus":"unreviewed-synthetic"', `"reviewStatus":"unreviewed-synthetic","reviewStatus":"${rng.pick(['approved', 'unreviewed-synthetic'])}"`), kind: 'dup' };
    }
    default: {
      // Numeric strings in place of numbers ("NaN via strings").
      const spec = rng.pick(FIXTURE_SPECS.filter((s) => s.kind === 'number'));
      params[spec.key] = rng.pick(['NaN', String(params[spec.key]), 'Infinity', '1e999']);
      break;
    }
  }
  return { text: JSON.stringify(doc, null, rng.next() < 0.5 ? 2 : undefined), kind: `op${kind}` };
}

describe('recipe JSON import: seeded mutation fuzz', () => {
  it('never throws and agrees with an independent validity oracle on >= 1500 mutated documents', () => {
    const rng = createRng(0x5eed);
    let accepted = 0;
    let rejected = 0;
    const kinds = new Map<string, number>();
    for (let i = 0; i < 1500; i++) {
      const { text, kind } = mutate(rng);
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      let r: RecipeImportResult;
      try {
        r = importRecipeJson(text, opts);
      } catch (e) {
        throw new Error(`importRecipeJson threw on case ${i} (${kind}): ${String(e)}`);
      }
      const valid = oracleValid(text);
      if (r.ok !== valid) {
        throw new Error(`case ${i} (${kind}): importer ok=${r.ok}, oracle valid=${valid}\n${text.slice(0, 400)}`);
      }
      if (r.ok) {
        accepted++;
        // Accepted documents re-export and re-import identically.
        const again = importRecipeJson(exportRecipeJson(r.doc), opts);
        expect(again.ok).toBe(true);
        if (again.ok) expect(exportRecipeJson(again.doc)).toBe(exportRecipeJson(r.doc));
      } else {
        rejected++;
        for (const d of r.diagnostics) {
          expect(DIAGNOSTIC_CODES).toContain(d.code);
          expect(d.message).not.toMatch(/internal error/);
        }
      }
    }
    expect(accepted).toBeGreaterThan(50);
    expect(rejected).toBeGreaterThan(1000);
    expect(kinds.size).toBeGreaterThanOrEqual(14);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Real recipes (run once the registry has them).
// ---------------------------------------------------------------------------------------------

const registered = RECIPE_IDS.filter((id) => getRecipe(id) !== null);

describe.runIf(registered.length === RECIPE_IDS.length)('recipe JSON with the registered recipes', () => {
  it.each(RECIPE_IDS)('%s defaults round-trip through JSON', (id) => {
    const recipe = getRecipe(id)!;
    const doc = newRecipeDocument(id, recipe.defaults(), '2026-09-26T00:00:00.000Z', 'defaults');
    const text = exportRecipeJson(doc);
    const r = importRecipeJson(text);
    if (!r.ok) throw new Error(JSON.stringify(r.diagnostics, null, 2));
    expect(r.doc).toEqual(doc);
    expect(exportRecipeJson(r.doc)).toBe(text);
  });

  it.each(RECIPE_IDS)('%s rejects every numeric parameter just outside its range', (id) => {
    const recipe = getRecipe(id)!;
    for (const spec of recipe.paramSpecs) {
      if (spec.kind !== 'number') continue;
      for (const v of [spec.min - Math.max(1e-6, (spec.max - spec.min) * 0.01), spec.max + Math.max(1e-6, (spec.max - spec.min) * 0.01)]) {
        const doc = newRecipeDocument(id, { ...recipe.defaults(), [spec.key]: v }, '2026-09-26T00:00:00.000Z');
        const r = importRecipeJson(JSON.stringify(doc));
        expectFailure(r, 'PARAM_OUT_OF_RANGE', `params.${spec.key}`);
      }
    }
  });
});
