import { useRef, useState } from 'react';
import type { Diagnostic } from '../../core/contracts/diagnostics.ts';
import type { MotionPlan } from '../../core/contracts/plan.ts';
import { newRecipeDocument, recipeIdSchema, type ParamRecord, type RecipeDocument } from '../../core/contracts/recipe.ts';
import type { RigDefinition } from '../../core/contracts/rig.ts';
import { bakeClip } from '../../core/engine.ts';
import { TOLERANCES } from '../../core/tolerances.ts';
import { degFromRad, mm } from '../format.ts';
import { downloadBlob } from '../hooks.ts';
import { loadGltfModule, loadRecipeIoModule, moduleAvailability } from '../optionalModules.ts';
import { DiagnosticList } from './common.tsx';

export const EXPORT_FPS = 30;

/** ExportValidationError carries a `.diagnostics` array; show it when present. */
function diagnosticsOf(e: unknown): Diagnostic[] {
  const d = (e as { diagnostics?: unknown } | null)?.diagnostics;
  return Array.isArray(d) ? (d as Diagnostic[]) : [];
}

interface VerifySummary {
  frames: number;
  maxPositionError: number;
  maxRotationError: number;
  maxBoneLengthRelError: number;
  withinTolerance: boolean;
  issues: string[];
  midFrame: string | null;
}

export function ImportExport(props: {
  recipeId: string;
  params: ParamRecord | null;
  plan: MotionPlan | null;
  rig: RigDefinition | null;
  onImport(doc: RecipeDocument): void;
  announce(msg: string): void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [importDiags, setImportDiags] = useState<Diagnostic[] | null>(null);
  const [importOk, setImportOk] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'export' | 'verify'>(null);
  const [exportInfo, setExportInfo] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportDiags, setExportDiags] = useState<Diagnostic[]>([]);
  const [verify, setVerify] = useState<VerifySummary | null>(null);

  const exportRecipe = async (): Promise<void> => {
    const io = await loadRecipeIoModule();
    const id = recipeIdSchema.safeParse(props.recipeId);
    if (!io || !id.success || !props.params) {
      props.announce(!io ? 'Recipe export is not available yet in this build.' : 'Fix parameter errors before exporting.');
      return;
    }
    const doc = newRecipeDocument(id.data, props.params, new Date().toISOString(), 'Exported from the motion-lab workbench (synthetic, unreviewed).');
    const text = io.exportRecipeJson(doc);
    downloadBlob(text, `${props.recipeId}.recipe.json`, 'application/json');
    props.announce(`Exported recipe JSON for ${props.recipeId}.`);
  };

  const importFile = async (file: File): Promise<void> => {
    setImportDiags(null);
    setImportOk(null);
    const io = await loadRecipeIoModule();
    if (!io) {
      setImportDiags([{ code: 'SCHEMA_INVALID', severity: 'error', message: 'Recipe import is not available yet in this build.' }]);
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (e) {
      setImportDiags([{ code: 'SCHEMA_INVALID', severity: 'error', message: `Could not read the file: ${e instanceof Error ? e.message : String(e)}` }]);
      return;
    }
    const res = io.importRecipeJson(text);
    if (!res.ok) {
      setImportDiags(res.diagnostics);
      props.announce(`Import failed: ${res.diagnostics.length} problem${res.diagnostics.length === 1 ? '' : 's'} found.`);
      return;
    }
    props.onImport(res.doc);
    const msg = `Imported ${res.doc.recipeId} with ${Object.keys(res.doc.params).length} parameters from ${file.name}.`;
    setImportOk(msg);
    props.announce(msg);
  };

  const bake = (): ReturnType<typeof bakeClip> | null => {
    if (!props.plan || !props.rig) return null;
    return bakeClip(props.plan, props.rig, EXPORT_FPS, 'stabilized');
  };

  const exportGlb = async (): Promise<void> => {
    setBusy('export');
    setExportError(null);
    setExportDiags([]);
    setExportInfo(null);
    try {
      const gltf = await loadGltfModule();
      if (!gltf) throw new Error('glTF export is not available yet in this build.');
      const clip = bake();
      if (!clip) throw new Error('No compiled motion to export.');
      const res = await gltf.exportBakedClipToGlb(clip);
      downloadBlob(res.glb, res.animationFileName, 'model/gltf-binary');
      await new Promise((r) => setTimeout(r, 250));
      downloadBlob(res.manifestJson, res.manifestFileName, 'application/json');
      const info = `Exported ${res.animationFileName} (${(res.glb.byteLength / 1024).toFixed(1)} KB, sha256 ${res.sha256.slice(0, 12)}…) and ${res.manifestFileName}.`;
      setExportInfo(info);
      props.announce(info);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExportError(msg);
      setExportDiags(diagnosticsOf(e));
      props.announce(`Export failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const verifyExport = async (): Promise<void> => {
    setBusy('verify');
    setExportError(null);
    setExportDiags([]);
    setVerify(null);
    try {
      const gltf = await loadGltfModule();
      if (!gltf) throw new Error('glTF export is not available yet in this build.');
      const clip = bake();
      if (!clip) throw new Error('No compiled motion to export.');
      const res = await gltf.verifyRoundTrip(clip);
      const r = res.report;
      const summary: VerifySummary = {
        frames: r.framesCompared,
        maxPositionError: r.maxPositionError,
        maxRotationError: r.maxRotationError,
        maxBoneLengthRelError: r.maxBoneLengthRelError,
        withinTolerance: r.withinTolerance,
        issues: r.issues,
        midFrame: r.midFrame.available
          ? `Mid-frame resampling (informational): ${mm(r.midFrame.maxPositionError, 3)}, ${degFromRad(r.midFrame.maxRotationError, 3)} over ${r.midFrame.framesCompared} frames.`
          : null,
      };
      setVerify(summary);
      props.announce(`Round-trip ${summary.withinTolerance ? 'within' : 'OUTSIDE'} tolerance: max position error ${mm(summary.maxPositionError, 4)}, max rotation error ${summary.maxRotationError.toExponential(2)} rad.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setExportError(msg);
      setExportDiags(diagnosticsOf(e));
      props.announce(`Round-trip verification failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  };

  const noMotion = !props.plan || !props.rig;
  return (
    <div className="import-export">
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => void exportRecipe()} disabled={!props.params || !moduleAvailability.recipeIo} data-testid="export-recipe">
          Export recipe JSON
        </button>
        <button type="button" className="btn" onClick={() => fileRef.current?.click()} disabled={!moduleAvailability.recipeIo} data-testid="import-recipe">
          Import recipe JSON…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="sr-only"
          tabIndex={-1}
          aria-label="Recipe JSON file"
          data-testid="import-file"
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (f) void importFile(f);
          }}
        />
      </div>
      {!moduleAvailability.recipeIo ? <p className="small muted">Recipe import/export module not available yet.</p> : null}
      {importOk ? (
        <p className="small st-ok" data-testid="import-ok">
          {importOk}
        </p>
      ) : null}
      {importDiags ? (
        <div role="alert" data-testid="import-errors" className="import-errors">
          <p className="error-text">The file was not imported:</p>
          <DiagnosticList diagnostics={importDiags} />
        </div>
      ) : null}
      <div className="btn-row">
        <button type="button" className="btn" onClick={() => void exportGlb()} disabled={noMotion || busy !== null || !moduleAvailability.gltf} data-testid="export-glb">
          {busy === 'export' ? 'Exporting…' : 'Export animation (.glb + manifest)'}
        </button>
        <button type="button" className="btn" onClick={() => void verifyExport()} disabled={noMotion || busy !== null || !moduleAvailability.gltf} data-testid="verify-roundtrip">
          {busy === 'verify' ? 'Verifying…' : 'Verify export round-trip'}
        </button>
      </div>
      <p className="small muted">Exports the stabilized tier baked at {EXPORT_FPS} fps. The manifest carries recipe semantics, provenance, assumptions and the UNREVIEWED status.</p>
      {!moduleAvailability.gltf ? <p className="small muted">glTF export module not available yet.</p> : null}
      {exportInfo ? <p className="small st-ok" data-testid="export-info">{exportInfo}</p> : null}
      {exportError ? (
        <div role="alert" data-testid="export-error">
          <p className="small error-text">{exportError}</p>
          <DiagnosticList diagnostics={exportDiags} />
        </div>
      ) : null}
      {verify ? (
        <div className="verify-report" data-testid="roundtrip-report" data-within={verify.withinTolerance ? 'true' : 'false'}>
          <p className={verify.withinTolerance ? 'st-ok' : 'st-fail'}>
            <strong>{verify.withinTolerance ? 'Round trip within tolerance' : 'Round trip OUTSIDE tolerance'}</strong> ({verify.frames} frames compared)
          </p>
          <dl className="kv">
            <div>
              <dt>Max joint position difference</dt>
              <dd>
                {mm(verify.maxPositionError, 4)} <span className="muted small">(tol {mm(TOLERANCES.exportPosition, 3)})</span>
              </dd>
            </div>
            <div>
              <dt>Max joint rotation difference</dt>
              <dd>
                {verify.maxRotationError.toExponential(2)} rad <span className="muted small">(tol {TOLERANCES.exportRotation.toExponential(0)} rad)</span>
              </dd>
            </div>
            <div>
              <dt>Max bone-length relative error</dt>
              <dd>
                {verify.maxBoneLengthRelError.toExponential(2)} <span className="muted small">(tol {TOLERANCES.boneLengthRelExported.toExponential(0)})</span>
              </dd>
            </div>
          </dl>
          {verify.midFrame ? <p className="small muted">{verify.midFrame}</p> : null}
          {verify.issues.length > 0 ? (
            <ul className="plain-list small">
              {verify.issues.slice(0, 10).map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
