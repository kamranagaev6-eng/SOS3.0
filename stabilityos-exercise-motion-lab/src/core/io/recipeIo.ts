import { REVIEW_STATUS, SCHEMA } from '../contracts/common.ts';
import { diag, type Diagnostic } from '../contracts/diagnostics.ts';
import { recipeDocumentSchema, type ParamSpec, type ParamValue, type RecipeDocument } from '../contracts/recipe.ts';
import { getRecipe } from '../recipes/registry.ts';
import type { RecipeDefinition } from '../recipes/types.ts';

/**
 * Recipe document JSON import/export (pure; no DOM, no three.js).
 *
 * The importer treats its input as untrusted: it never throws, never evaluates anything, rejects
 * prototype-pollution keys before any object is rebuilt, and returns explicit diagnostics for every
 * problem it finds. It never marks content reviewed: only `reviewStatus: 'unreviewed-synthetic'` is
 * accepted, because review authority belongs to the host application.
 */

/** Maximum accepted document size (UTF-8 bytes). Real documents are < 4 KB. */
export const MAX_RECIPE_JSON_BYTES = 256 * 1024;
/** Maximum nesting depth scanned; a valid document has depth 3. */
const MAX_DEPTH = 32;
/** Keys that can alter prototypes when an object is rebuilt by assignment. Never valid here. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

const TOP_LEVEL_KEYS = ['schema', 'recipeId', 'reviewStatus', 'params', 'provenance'] as const;
const PROVENANCE_KEYS = ['generator', 'generatorVersion', 'createdAt', 'note'] as const;

export type RecipeImportResult = { ok: true; doc: RecipeDocument } | { ok: false; diagnostics: Diagnostic[] };

/** What the importer needs from a recipe (a `RecipeDefinition` satisfies it). */
export type RecipeParamInfo = Pick<RecipeDefinition, 'paramSpecs'> & { id: string };

export interface RecipeImportOptions {
  /** Recipe lookup by explicit id. Defaults to the registry's `getRecipe` (evaluated at call time). */
  resolveRecipe?: (id: string) => RecipeParamInfo | null;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

function orderedDocument(doc: RecipeDocument): RecipeDocument {
  // Object.fromEntries defines data properties, so even a hostile key could not reach a prototype.
  const params: Record<string, ParamValue> = Object.fromEntries(
    Object.keys(doc.params)
      .sort()
      .map((key) => [key, doc.params[key]!] as const),
  );
  return {
    schema: doc.schema,
    recipeId: doc.recipeId,
    reviewStatus: doc.reviewStatus,
    params,
    provenance: {
      generator: doc.provenance.generator,
      generatorVersion: doc.provenance.generatorVersion,
      createdAt: doc.provenance.createdAt,
      note: doc.provenance.note,
    },
  };
}

/**
 * Serialises a recipe document as pretty JSON with a stable key order (fixed top-level order,
 * params sorted by key) and a trailing newline. Throws only on a programming error: a document
 * that does not satisfy the schema (e.g. a forged review status) is never written.
 */
export function exportRecipeJson(doc: RecipeDocument): string {
  const parsed = recipeDocumentSchema.safeParse(doc);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`exportRecipeJson: refusing to write an invalid recipe document (${issues})`);
  }
  for (const key of Object.keys(doc.params)) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error(`exportRecipeJson: forbidden parameter key '${key}'`);
  }
  return `${JSON.stringify(orderedDocument(parsed.data), null, 2)}\n`;
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return typeof v;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function pathOf(parts: readonly (string | number)[]): string {
  return parts.length === 0 ? '(root)' : parts.map(String).join('.');
}

/**
 * Iterative scan (no recursion, so deeply nested input cannot overflow the stack) for forbidden
 * keys and excessive nesting.
 */
function scanStructure(root: unknown, out: Diagnostic[]): void {
  const stack: { value: unknown; path: (string | number)[] }[] = [{ value: root, path: [] }];
  let reportedDepth = false;
  while (stack.length > 0) {
    const { value, path } = stack.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (path.length > MAX_DEPTH) {
      if (!reportedDepth) {
        out.push(diag('SCHEMA_INVALID', 'error', `Nesting deeper than ${MAX_DEPTH} levels is not allowed.`, { path: pathOf(path) }));
        reportedDepth = true;
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) stack.push({ value: value[i] as unknown, path: [...path, i] });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        out.push(
          diag('SCHEMA_INVALID', 'error', `Forbidden key '${key}' (prototype-pollution guard).`, {
            path: pathOf([...path, key]),
            hint: 'Remove the key; it is never part of a recipe document.',
          }),
        );
        continue;
      }
      stack.push({ value: (value as Record<string, unknown>)[key], path: [...path, key] });
    }
  }
}

function checkUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], base: string[], out: Diagnostic[]): void {
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(key)) continue; // already reported by scanStructure
    if (!allowed.includes(key)) {
      out.push(
        diag('SCHEMA_INVALID', 'error', `Unknown field '${key}'.`, {
          path: pathOf([...base, key]),
          hint: `Allowed fields: ${allowed.join(', ')}.`,
        }),
      );
    }
  }
}

function checkParam(spec: ParamSpec, value: unknown, out: Diagnostic[]): void {
  const path = `params.${spec.key}`;
  if (spec.kind === 'number') {
    if (typeof value !== 'number') {
      out.push(
        diag('SCHEMA_INVALID', 'error', `Parameter '${spec.key}' must be a number (${spec.unit}), got ${describe(value)}.`, {
          path,
          hint: `Use a JSON number between ${spec.min} and ${spec.max}. Numeric strings are not converted.`,
        }),
      );
      return;
    }
    if (!Number.isFinite(value)) {
      out.push(diag('PARAM_OUT_OF_RANGE', 'error', `Parameter '${spec.key}' must be finite.`, { path, limit: spec.max }));
      return;
    }
    if (value < spec.min) {
      out.push(
        diag('PARAM_OUT_OF_RANGE', 'error', `Parameter '${spec.key}' = ${value} ${spec.unit} is below the supported minimum ${spec.min}.`, {
          path,
          value,
          limit: spec.min,
        }),
      );
    } else if (value > spec.max) {
      out.push(
        diag('PARAM_OUT_OF_RANGE', 'error', `Parameter '${spec.key}' = ${value} ${spec.unit} is above the supported maximum ${spec.max}.`, {
          path,
          value,
          limit: spec.max,
        }),
      );
    }
    if (spec.unit === 'count' && !Number.isInteger(value)) {
      out.push(diag('PARAM_OUT_OF_RANGE', 'error', `Parameter '${spec.key}' is a count and must be an integer.`, { path, value }));
    }
    return;
  }
  // enum
  if (typeof value !== 'string') {
    out.push(
      diag('SCHEMA_INVALID', 'error', `Parameter '${spec.key}' must be a string option, got ${describe(value)}.`, {
        path,
        hint: `One of: ${spec.options.join(', ')}.`,
      }),
    );
    return;
  }
  if (!spec.options.includes(value)) {
    out.push(
      diag('PARAM_OUT_OF_RANGE', 'error', `Parameter '${spec.key}' = '${value.slice(0, 80)}' is not a supported option.`, {
        path,
        hint: `One of: ${spec.options.join(', ')}.`,
      }),
    );
  }
}

function importUnchecked(text: unknown, options: RecipeImportOptions): RecipeImportResult {
  const fail = (d: Diagnostic[]): RecipeImportResult => ({ ok: false, diagnostics: d });

  if (typeof text !== 'string') {
    return fail([diag('SCHEMA_INVALID', 'error', `Recipe JSON must be text, got ${describe(text)}.`)]);
  }
  // Every UTF-16 unit is at least one UTF-8 byte, so the length check bounds the byte count cheaply.
  if (text.length > MAX_RECIPE_JSON_BYTES || utf8ByteLength(text) > MAX_RECIPE_JSON_BYTES) {
    return fail([
      diag('SCHEMA_INVALID', 'error', `Recipe JSON is larger than ${MAX_RECIPE_JSON_BYTES} bytes and was not parsed.`, {
        limit: MAX_RECIPE_JSON_BYTES,
        hint: 'Recipe documents are small (a few KB); check that the right file was selected.',
      }),
    ]);
  }
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim().length === 0) return fail([diag('SCHEMA_INVALID', 'error', 'Recipe JSON is empty.')]);

  let raw: unknown;
  try {
    raw = JSON.parse(body) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail([
      diag('SCHEMA_INVALID', 'error', `Invalid JSON: ${msg.slice(0, 200)}`, {
        hint: 'The file may be truncated or not a recipe document.',
      }),
    ]);
  }

  if (!isPlainObject(raw)) {
    return fail([diag('SCHEMA_INVALID', 'error', `A recipe document must be a JSON object, got ${describe(raw)}.`, { path: '(root)' })]);
  }

  const diagnostics: Diagnostic[] = [];
  scanStructure(raw, diagnostics);

  // Schema version: decided first, with a precise message, because nothing else can be trusted
  // in a document of an unknown version.
  const schema = raw['schema'];
  if (schema === undefined) {
    return fail([
      ...diagnostics,
      diag('SCHEMA_INVALID', 'error', `Missing 'schema' field; expected '${SCHEMA.recipe}'.`, { path: 'schema' }),
    ]);
  }
  if (schema !== SCHEMA.recipe) {
    const shown = typeof schema === 'string' ? `'${schema.slice(0, 80)}'` : describe(schema);
    const newer = typeof schema === 'string' && /^smx\.recipe\/\d+$/.test(schema);
    return fail([
      ...diagnostics,
      diag(
        'SCHEMA_INVALID',
        'error',
        `Unsupported recipe document schema ${shown}; this reader only understands '${SCHEMA.recipe}'.`,
        {
          path: 'schema',
          hint: newer
            ? 'The document was written for a different major version of the recipe format and is not read by guessing.'
            : 'This does not look like a recipe document exported by this package.',
        },
      ),
    ]);
  }

  const reviewStatus = raw['reviewStatus'];
  if (reviewStatus !== REVIEW_STATUS) {
    const shown = typeof reviewStatus === 'string' ? `'${reviewStatus.slice(0, 80)}'` : describe(reviewStatus);
    diagnostics.push(
      diag(
        'SCHEMA_INVALID',
        'error',
        `reviewStatus ${shown} is not accepted: this package cannot mark content reviewed, only '${REVIEW_STATUS}' is allowed.`,
        { path: 'reviewStatus', hint: 'Review and publication authority belong to the host application.' },
      ),
    );
  }

  checkUnknownKeys(raw, TOP_LEVEL_KEYS, [], diagnostics);
  const provenance = raw['provenance'];
  if (isPlainObject(provenance)) checkUnknownKeys(provenance, PROVENANCE_KEYS, ['provenance'], diagnostics);

  const parsed = recipeDocumentSchema.safeParse(raw);

  // Recipe identity and parameters are checked whenever the relevant fields are well formed, so a
  // single pass reports as many problems as possible.
  const recipeId = raw['recipeId'];
  const params = raw['params'];
  if (typeof recipeId === 'string' && recipeDocumentSchema.shape.recipeId.safeParse(recipeId).success) {
    const resolve = options.resolveRecipe ?? getRecipe;
    const recipe = resolve(recipeId);
    if (!recipe) {
      diagnostics.push(
        diag('UNKNOWN_RECIPE', 'error', `Unknown recipe id '${recipeId}'. Recipes are selected by explicit id only.`, {
          path: 'recipeId',
        }),
      );
    } else if (isPlainObject(params)) {
      const specKeys = recipe.paramSpecs.map((s) => s.key);
      for (const key of Object.keys(params)) {
        if (FORBIDDEN_KEYS.has(key)) continue;
        if (!specKeys.includes(key)) {
          diagnostics.push(
            diag('SCHEMA_INVALID', 'error', `Unknown parameter '${key.slice(0, 80)}' for recipe '${recipe.id}'.`, {
              path: `params.${key.slice(0, 80)}`,
              hint: `Parameters of ${recipe.id}: ${specKeys.join(', ')}.`,
            }),
          );
        }
      }
      for (const spec of recipe.paramSpecs) {
        if (!Object.prototype.hasOwnProperty.call(params, spec.key)) {
          diagnostics.push(
            diag('SCHEMA_INVALID', 'error', `Missing parameter '${spec.key}' for recipe '${recipe.id}'.`, {
              path: `params.${spec.key}`,
              hint: 'Exported recipe documents list every parameter explicitly; defaults are not filled in silently.',
            }),
          );
          continue;
        }
        checkParam(spec, params[spec.key], diagnostics);
      }
    }
  }

  if (!parsed.success) {
    // Generic schema issues, skipping paths already reported with a more specific message.
    const covered = new Set(diagnostics.map((d) => d.path).filter((p): p is string => p !== undefined));
    for (const issue of parsed.error.issues) {
      const path = pathOf(issue.path.map((p) => (typeof p === 'symbol' ? String(p) : p)));
      if (covered.has(path)) continue;
      if (issue.path.length > 0 && FORBIDDEN_KEYS.has(String(issue.path[issue.path.length - 1]))) continue;
      covered.add(path);
      diagnostics.push(diag('SCHEMA_INVALID', 'error', `${path}: ${issue.message}`, { path }));
    }
  }

  if (diagnostics.length > 0 || !parsed.success) {
    if (diagnostics.length === 0) diagnostics.push(diag('SCHEMA_INVALID', 'error', 'Recipe document does not match the schema.'));
    return fail(diagnostics);
  }
  // Rebuild from the validated data with a fixed key order (Object.fromEntries-style data
  // properties only; forbidden keys were rejected above).
  return { ok: true, doc: orderedDocument(parsed.data) };
}

/**
 * Parses and validates a recipe document. Never throws: every problem, including internal
 * errors, comes back as diagnostics.
 */
export function importRecipeJson(text: string, options: RecipeImportOptions = {}): RecipeImportResult {
  try {
    return importUnchecked(text, options);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      diagnostics: [diag('SCHEMA_INVALID', 'error', `Recipe document could not be read (internal error: ${msg.slice(0, 200)}).`)],
    };
  }
}
