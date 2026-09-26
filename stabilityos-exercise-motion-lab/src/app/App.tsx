import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Side } from '../core/contracts/common.ts';
import { REVIEW_NOTICE } from '../core/contracts/common.ts';
import type { Diagnostic } from '../core/contracts/diagnostics.ts';
import { RECIPE_IDS, type ParamRecord, type RecipeDocument } from '../core/contracts/recipe.ts';
import { compileRecipe, getRecipe, listRecipes } from '../core/engine.ts';
import type { CompileResult } from '../core/recipes/types.ts';
import type { SolverTier } from '../core/solver/types.ts';
import { DEFAULT_INSPECTION_RATE } from '../player/index.ts';
import { DEFAULT_OVERLAYS, VIEW_LABELS, type OverlayFlags, type ViewPreset } from '../render/index.ts';
import { clipFraming, runAnalysis, type AnalysisState } from './analysis.ts';
import { DiagnosticList, Panel, SyntheticTag, Toggle } from './components/common.tsx';
import { OverlayControls, ViewControls } from './components/Controls.tsx';
import { ClipMetricsSummary, LiveDiagnostics } from './components/Diagnostics.tsx';
import { ImportExport } from './components/ImportExport.tsx';
import { KeyboardHelp } from './components/KeyboardHelp.tsx';
import { ParamEditor } from './components/ParamEditor.tsx';
import { RecipeInfo } from './components/RecipeInfo.tsx';
import { StageView } from './components/StageView.tsx';
import { StaticInspection } from './components/StaticInspection.tsx';
import { Timeline } from './components/Timeline.tsx';
import { Transport } from './components/Transport.tsx';
import { useMediaQuery } from './hooks.ts';
import { loadAdapterModule, moduleAvailability, type AdapterModule } from './optionalModules.ts';
import { paramErrorsFromDiagnostics, rawFromRecord, validateParams, type RawParams } from './params.ts';
import { resolveRig, RIG_A_ID, rigOptions } from './rigs.ts';
import { installTestHook, shouldInstallTestHook } from './testHooks.ts';
import { ViewerController, type LiveReadout } from './viewer.ts';

const VIEW_BY_KEY: Record<string, ViewPreset> = { '1': 'front', '2': 'side-left', '3': 'side-right', '4': 'oblique', '5': 'top' };
const TEXT_INPUT_TYPES = new Set(['text', 'number', 'search', 'email', 'password', 'url', 'tel', 'date', 'time', 'datetime-local', 'month', 'week']);

function initialRecipeId(): string {
  const registered = new Set(listRecipes().map((r) => r.id));
  try {
    const q = new URLSearchParams(location.search).get('recipe');
    if (q && registered.has(q as (typeof RECIPE_IDS)[number])) return q;
  } catch {
    // ignore malformed URLs
  }
  return RECIPE_IDS.find((id) => registered.has(id)) ?? RECIPE_IDS[0];
}

function sameParams(a: ParamRecord, b: ParamRecord): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

export function App() {
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const recipes = listRecipes();
  const [recipeId, setRecipeId] = useState(initialRecipeId);
  const recipe = getRecipe(recipeId);
  const specs = useMemo(() => recipe?.paramSpecs ?? [], [recipe]);

  // ---------------- parameters ----------------
  const [rawByRecipe, setRawByRecipe] = useState<Record<string, RawParams>>({});
  const defaultsRaw = useMemo(() => (recipe ? rawFromRecord(specs, recipe.defaults()) : {}), [recipe, specs]);
  const raw = rawByRecipe[recipeId] ?? defaultsRaw;
  const validation = useMemo(() => validateParams(specs, raw), [specs, raw]);
  const [committed, setCommitted] = useState<{ recipeId: string; values: ParamRecord } | null>(() => {
    const r = getRecipe(initialRecipeId());
    return r ? { recipeId: r.id, values: r.defaults() } : null;
  });
  useEffect(() => {
    if (!validation.valid) return;
    if (!committed || committed.recipeId !== recipeId) {
      setCommitted({ recipeId, values: validation.values });
      return;
    }
    if (sameParams(committed.values, validation.values)) return;
    const h = setTimeout(() => setCommitted({ recipeId, values: validation.values }), 160);
    return () => clearTimeout(h);
  }, [recipeId, validation, committed]);
  const effective: ParamRecord | null = committed?.recipeId === recipeId ? committed.values : validation.valid ? validation.values : (recipe?.defaults() ?? null);
  const effectiveKey = effective ? JSON.stringify(effective) : '';
  const pending = validation.valid && !!committed && committed.recipeId === recipeId && !sameParams(committed.values, validation.values);

  // ---------------- rig ----------------
  const [rigId, setRigId] = useState(RIG_A_ID);
  const [adapterMod, setAdapterMod] = useState<AdapterModule | null>(null);
  const [adapterLoading, setAdapterLoading] = useState(moduleAvailability.adapter);
  useEffect(() => {
    if (!moduleAvailability.adapter) return;
    let alive = true;
    loadAdapterModule()
      .then((m) => {
        if (alive) setAdapterMod(m);
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setAdapterLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  const resolved = useMemo(() => resolveRig(rigId, adapterMod, recipe?.requiredCapabilities ?? []), [rigId, adapterMod, recipe]);
  const rig = resolved.status === 'ready' ? resolved.rig : null;

  // ---------------- compile ----------------
  const compile: CompileResult | null = useMemo(() => {
    if (!recipe || !rig || !effective) return null;
    try {
      return compileRecipe(recipe.id, effective, rig);
    } catch (e) {
      return {
        ok: false,
        plan: null,
        diagnostics: [{ code: 'KEYPOSE_UNSOLVED', severity: 'error', message: `Internal compile error: ${e instanceof Error ? e.message : String(e)}`, hint: 'Report this; try default parameters.' }],
      };
    }
    // effectiveKey captures the parameter values
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipe, rig, effectiveKey]);
  const plan = compile?.ok ? compile.plan : null;
  const compileParamErrors = useMemo(() => (compile && !compile.ok ? paramErrorsFromDiagnostics(compile.diagnostics) : {}), [compile]);

  // ---------------- view state ----------------
  const [tier, setTier] = useState<SolverTier>('stabilized');
  const [comparison, setComparison] = useState(false);
  const [overlays, setOverlays] = useState<OverlayFlags>(DEFAULT_OVERLAYS);
  const [view, setView] = useState<ViewPreset>('oblique');
  const [inspectSide, setInspectSide] = useState<Side | null>(null);
  const [staticMode, setStaticMode] = useState(reducedMotion);
  const [stageAvailable, setStageAvailable] = useState<boolean | null>(null);
  const [helpSignal, setHelpSignal] = useState(0);
  const [status, setStatus] = useState('');
  const announce = useCallback((msg: string) => setStatus(msg), []);

  // ---------------- controller / player ----------------
  const [readout, setReadout] = useState<LiveReadout>({ t: 0, duration: 1, phaseIndex: -1, sample: null, comparisonSample: null, error: null });
  const [controller] = useState(() => new ViewerController((r) => setReadout(r)));
  const [snap, setSnap] = useState(() => controller.player.snapshot());
  const [inspectionRate, setInspectionRate] = useState(DEFAULT_INSPECTION_RATE);
  useEffect(() => controller.player.subscribe(setSnap), [controller]);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  useEffect(() => {
    controller.player.setInspectionRate(inspectionRate);
  }, [controller, inspectionRate]);

  useEffect(() => {
    const framing = plan && rig ? clipFraming(plan, rig) : null;
    controller.setContent(plan, rig, framing);
  }, [controller, plan, rig]);
  useEffect(() => controller.setTier(tier), [controller, tier]);
  useEffect(() => controller.setComparison(comparison), [controller, comparison]);
  useEffect(() => {
    controller.setHostBoneProvider(overlays.hostBones && resolved.hostBones ? resolved.hostBones : null);
  }, [controller, overlays.hostBones, resolved]);

  // Autoplay once, unless reduced motion / static inspection is active.
  const autoplayed = useRef(false);
  useEffect(() => {
    if (autoplayed.current || !plan) return;
    autoplayed.current = true;
    if (!reducedMotion && !staticMode) controller.player.play();
  }, [plan, reducedMotion, staticMode, controller]);
  useEffect(() => {
    if (reducedMotion) {
      setStaticMode(true);
      controller.player.pause();
    }
  }, [reducedMotion, controller]);

  // ---------------- whole-clip analysis (deferred) ----------------
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: 'idle', key: 0, results: {} });
  const analysisKey = useRef(0);
  useEffect(() => {
    const key = ++analysisKey.current;
    if (!plan || !rig) {
      setAnalysis({ status: 'idle', key, results: {} });
      return;
    }
    setAnalysis({ status: 'running', key, results: {} });
    const job = runAnalysis(plan, rig, (t, result, done) =>
      setAnalysis((prev) => (prev.key !== key ? prev : { status: done ? 'done' : 'running', key, results: { ...prev.results, [t]: result } })),
    );
    return () => job.cancel();
  }, [plan, rig]);
  const primaryTier: SolverTier = comparison && tier === 'baseline' ? 'stabilized' : tier;
  useEffect(() => {
    const p = analysis.results[primaryTier]?.trajectory ?? null;
    const c = comparison ? (analysis.results.baseline?.trajectory ?? null) : null;
    controller.setTrajectories(p, c);
  }, [controller, analysis, primaryTier, comparison]);

  // ---------------- actions ----------------
  const selectRecipe = (id: string): void => {
    const r = getRecipe(id);
    if (!r) return;
    setRecipeId(id);
    announce(`Selected ${r.title} (${r.id}).`);
  };
  const setParam = (key: string, value: string): void => {
    setRawByRecipe((prev) => ({ ...prev, [recipeId]: { ...(prev[recipeId] ?? defaultsRaw), [key]: value } }));
  };
  const resetParams = (): void => {
    setRawByRecipe((prev) => {
      const next = { ...prev };
      delete next[recipeId];
      return next;
    });
    announce('Parameters reset to defaults.');
  };
  const onImport = (doc: RecipeDocument): void => {
    const r = getRecipe(doc.recipeId);
    if (!r) return;
    setRecipeId(r.id);
    setRawByRecipe((prev) => ({ ...prev, [r.id]: rawFromRecord(r.paramSpecs, { ...r.defaults(), ...doc.params }) }));
  };
  const chooseView = (v: ViewPreset): void => {
    setView(v);
    announce(`${VIEW_LABELS[v]} view.`);
  };
  const chooseSide = (s: Side | null): void => {
    setInspectSide(s);
    if (s) setView(s === 'left' ? 'side-left' : 'side-right');
    announce(s ? `Inspecting the ${s} side.` : 'Inspecting both sides.');
  };
  const toggleComparison = (on: boolean): void => {
    setComparison(on);
    announce(on ? 'Comparison on: baseline (frozen pelvis) beside the solved pose.' : 'Comparison off.');
  };
  const seekTo = useCallback(
    (t: number) => {
      controller.player.pause();
      controller.player.seek(t);
    },
    [controller],
  );

  const disabled = !plan;
  const latest = useRef({ plan, snap, recipeId, rigId, view, comparison, tier, inspectSide, disabled, staticMode, overlays });
  latest.current = { plan, snap, recipeId, rigId, view, comparison, tier, inspectSide, disabled, staticMode, overlays };

  // ---------------- keyboard ----------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target instanceof HTMLElement ? e.target : null;
      const tag = el?.tagName ?? '';
      if (tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (tag === 'INPUT' && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)) return;
      if (el?.closest('[role="dialog"]') && e.key !== '?') return;
      const nativeKeys = tag === 'INPUT' || tag === 'BUTTON' || tag === 'SUMMARY' || tag === 'A';
      const L = latest.current;
      const p = controller.player;
      const k = e.key;
      if (k === ' ' || k === 'Spacebar') {
        if (nativeKeys || L.disabled) return;
        e.preventDefault();
        p.toggle();
        return;
      }
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Home' || k === 'End') {
        if (tag === 'INPUT' || L.disabled || !L.plan) return;
        e.preventDefault();
        const dir = k === 'ArrowLeft' ? -1 : 1;
        if (k === 'Home') seekTo(0);
        else if (k === 'End') seekTo(L.plan.duration);
        else if (e.shiftKey) p.jumpPhase(dir, L.plan.phases);
        else p.stepFrames(dir);
        return;
      }
      if (e.shiftKey && k !== '?') return;
      const view = VIEW_BY_KEY[k];
      if (view) {
        e.preventDefault();
        chooseView(view);
        return;
      }
      switch (k.toLowerCase()) {
        case 'l':
          e.preventDefault();
          chooseSide(L.inspectSide === 'left' ? null : 'left');
          return;
        case 'r':
          e.preventDefault();
          chooseSide(L.inspectSide === 'right' ? null : 'right');
          return;
        case 'c':
          e.preventDefault();
          if (!L.disabled) toggleComparison(!L.comparison);
          return;
        case '?':
          e.preventDefault();
          setHelpSignal((n) => n + 1);
          return;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Handlers read the latest state through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, seekTo]);

  // Announce play/pause/speed changes.
  const prevSnap = useRef(snap);
  useEffect(() => {
    const a = prevSnap.current;
    if (a.playing !== snap.playing) announce(snap.playing ? `Playing at ${snap.speed}×.` : snap.ended ? 'Reached the end.' : `Paused at ${snap.t.toFixed(2)} s.`);
    else if (a.speed !== snap.speed) announce(`Speed ${snap.speed}×.`);
    prevSnap.current = snap;
  }, [snap, announce]);

  // ---------------- test hook ----------------
  useEffect(() => {
    if (!shouldInstallTestHook()) return;
    return installTestHook(controller, () => {
      const L = latest.current;
      const r = controller.getReadout();
      const ph = L.plan?.phases[r.phaseIndex];
      return {
        recipeId: L.recipeId,
        rigId: L.rigId,
        phaseId: ph?.id ?? null,
        phaseLabel: ph?.label ?? null,
        view: L.view,
        comparison: L.comparison,
        tier: L.tier,
        webgl: controller.getStage() !== null,
        planOk: L.plan !== null,
        phases: (L.plan?.phases ?? []).map((p) => ({ id: p.id, label: p.label, start: p.start, end: p.end })),
        overlays: { ...L.overlays },
        inspectSide: L.inspectSide,
        staticMode: L.staticMode,
      };
    });
  }, [controller]);

  // ---------------- blockers ----------------
  let blocker: React.ReactNode = null;
  if (!recipe) {
    blocker = <BlockerMessage title="Recipe not available" diagnostics={[{ code: 'UNKNOWN_RECIPE', severity: 'error', message: `Recipe '${recipeId}' is not registered in this build.`, hint: 'Choose another recipe.' }]} testId="recipe-missing" />;
  } else if (resolved.status === 'loading' || (resolved.status === 'unavailable' && adapterLoading)) {
    blocker = <p className="muted">Loading rig adapter…</p>;
  } else if (resolved.status !== 'ready') {
    blocker = (
      <BlockerMessage
        title={resolved.status === 'incompatible' ? `${resolved.label} is not compatible with ${recipe.title}` : `${resolved.label} is not available`}
        lead="No motion is shown for this rig. The adapter reported:"
        diagnostics={resolved.diagnostics}
        testId="rig-incompatible"
      />
    );
  } else if (compile && !compile.ok) {
    blocker = <BlockerMessage title="This configuration did not compile" lead="No motion is shown. Diagnostics:" diagnostics={compile.diagnostics} testId="compile-errors" />;
  }
  const infeasible = compile?.ok && compile.feasible === false;
  const phaseLabel = plan?.phases[readout.phaseIndex]?.label ?? null;
  const rigOpts = rigOptions(adapterMod, adapterLoading);

  return (
    <div className="app">
      <a className="skip-link" href="#stage-section">
        Skip to the 3D stage
      </a>
      <header className="app-header">
        <div className="brand">
          <svg className="brand-mark" width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
            <circle cx="14" cy="6" r="3.2" fill="currentColor" />
            <path d="M14 10v8M14 18l-4 7M14 18l4 7M9 13h10" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" fill="none" />
          </svg>
          <div>
            <h1>Exercise Motion Lab</h1>
            <p className="subtitle">Contact-constrained motion authoring &amp; playback workbench</p>
          </div>
        </div>
        <div className="badge-synthetic" role="note" data-testid="synthetic-badge">
          <strong>Synthetic · unreviewed engineering fixture</strong> — not clinical guidance
        </div>
        <KeyboardHelp openSignal={helpSignal} />
      </header>

      <main className="workbench">
        <div className="area-select">
          <Panel id="exercise" title="Exercise">
            <label className="field">
              <span className="field-label">Recipe (explicit id)</span>
              <select value={recipeId} onChange={(e) => selectRecipe(e.currentTarget.value)} aria-label="Exercise recipe" data-testid="recipe-select">
                {RECIPE_IDS.map((id) => {
                  const r = recipes.find((x) => x.id === id);
                  return (
                    <option key={id} value={id} disabled={!r}>
                      {r ? `${r.title} — ${id}` : `${id} (not available)`}
                    </option>
                  );
                })}
              </select>
            </label>
            {recipe ? (
              <div className="recipe-heading">
                <h3 data-testid="recipe-title">{recipe.title}</h3>
                <code data-testid="recipe-id">{recipe.id}</code> <span className="muted small">v{recipe.version}</span>
              </div>
            ) : null}
            <label className="field">
              <span className="field-label">Rig</span>
              <select value={rigId} onChange={(e) => setRigId(e.currentTarget.value)} aria-label="Rig" data-testid="rig-select">
                {rigOpts.map((o) => (
                  <option key={o.id} value={o.id} disabled={!o.available}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="small muted">{rigOpts.find((o) => o.id === rigId)?.description}</p>
            {resolved.status === 'ready' && resolved.diagnostics.length > 0 ? (
              <details className="rig-diags">
                <summary>
                  Adapter notes ({resolved.diagnostics.length})
                </summary>
                <DiagnosticList diagnostics={resolved.diagnostics} />
              </details>
            ) : null}
          </Panel>
        </div>

        <section className="area-center" id="stage-section" aria-label="Stage and playback" tabIndex={-1}>
          {infeasible ? (
            <div className="banner banner-warn" role="status" data-testid="infeasible-banner">
              <strong>Feasibility scan found constraint violations.</strong> The plan is shown so the failures can be inspected (red markers, live diagnostics).
              <details>
                <summary>Compile diagnostics ({compile.diagnostics.length})</summary>
                <DiagnosticList diagnostics={compile.diagnostics} />
              </details>
            </div>
          ) : null}
          {!validation.valid ? (
            <div className="banner banner-error" role="status" data-testid="param-banner">
              Parameter errors — the view keeps the last valid parameters until they are fixed.
            </div>
          ) : null}
          <div className="stage-card">
            <StageView
              controller={controller}
              overlays={overlays}
              view={view}
              inspectSide={inspectSide}
              comparison={comparison}
              primaryTier={primaryTier}
              reducedMotion={reducedMotion || staticMode}
              blocker={blocker}
              sampleError={readout.error}
              onAvailability={(ok) => setStageAvailable(ok)}
            />
          </div>
          {plan ? <Timeline plan={plan} controller={controller} phaseIndex={readout.phaseIndex} disabled={disabled} /> : null}
          <Transport
            snapshot={snap}
            disabled={disabled}
            inspectionRate={inspectionRate}
            onToggle={() => controller.player.toggle()}
            onStep={(n) => controller.player.stepFrames(n)}
            onPhase={(d) => plan && controller.player.jumpPhase(d, plan.phases)}
            onHome={() => seekTo(0)}
            onEnd={() => plan && seekTo(plan.duration)}
            onSpeed={(s) => controller.player.setSpeed(s)}
            onLoop={(l) => controller.player.setLoop(l)}
            onRate={setInspectionRate}
          />
          <div className="status-line" aria-live="polite" role="status" data-testid="status">
            {status}
          </div>
          <div className="controls-grid">
            <ViewControls
              view={view}
              onView={chooseView}
              side={inspectSide}
              onSide={chooseSide}
              comparison={comparison}
              onComparison={toggleComparison}
              tier={tier}
              onTier={(t) => {
                setTier(t);
                announce(`Solver tier: ${t}.`);
              }}
              disabled={disabled}
            />
            <OverlayControls flags={overlays} onChange={(f) => setOverlays((o) => ({ ...o, ...f }))} hostBonesAvailable={!!resolved.hostBones} />
          </div>
          <div className="static-row">
            <Toggle
              label="Static inspection mode"
              checked={staticMode}
              onChange={(v) => {
                setStaticMode(v);
                if (v) controller.player.pause();
                announce(v ? 'Static inspection mode on.' : 'Static inspection mode off.');
              }}
              testId="static-toggle"
              hint="Key poses at each phase boundary; no autoplay; no camera animation"
            />
            {reducedMotion ? <span className="small muted">Reduced motion requested by your system: autoplay and camera animation are off.</span> : null}
          </div>
          {staticMode && plan ? <StaticInspection plan={plan} currentT={readout.t} onSeek={seekTo} /> : null}
          {stageAvailable === false ? <p className="small muted">3D view unavailable — the numerical panels still use the real engine.</p> : null}
        </section>

        <div className="area-edit">
          <Panel id="parameters" title="Parameters" badge={<SyntheticTag />}>
            {recipe ? (
              <ParamEditor
                recipeId={recipeId}
                specs={specs}
                raw={raw}
                errors={validation.errors}
                compileErrors={compileParamErrors}
                onChange={setParam}
                onReset={resetParams}
                isDefault={!rawByRecipe[recipeId]}
                pending={pending}
              />
            ) : (
              <p className="muted">No recipe selected.</p>
            )}
          </Panel>
          <Panel id="io" title="Import / export">
            <ImportExport recipeId={recipeId} params={validation.valid ? validation.values : null} plan={plan} rig={rig} onImport={onImport} announce={announce} />
          </Panel>
        </div>

        <div className="area-right">
          <Panel id="live" title="Live diagnostics" badge={phaseLabel ? <span className="tag">{phaseLabel}</span> : null}>
            <LiveDiagnostics sample={readout.sample} plan={plan} t={readout.t} phaseIndex={readout.phaseIndex} tier={primaryTier} error={readout.error} />
          </Panel>
          <Panel id="metrics" title="Whole-clip metrics" collapsible>
            <ClipMetricsSummary analysis={analysis} selectedTier={primaryTier} />
          </Panel>
          {recipe ? (
            <Panel id="recipe-meta" title="Recipe metadata" badge={<SyntheticTag />} collapsible defaultOpen={false}>
              <RecipeInfo recipe={recipe} plan={plan} />
            </Panel>
          ) : null}
          {compile && compile.ok && compile.diagnostics.length > 0 && !infeasible ? (
            <Panel id="compile" title="Compile notes" collapsible defaultOpen={false}>
              <DiagnosticList diagnostics={compile.diagnostics} />
            </Panel>
          ) : null}
        </div>
      </main>
      <footer className="app-footer">
        <p className="small">{REVIEW_NOTICE}</p>
      </footer>
    </div>
  );
}

const SEVERITY_ORDER: Record<Diagnostic['severity'], number> = { error: 0, warning: 1, info: 2 };

function BlockerMessage(props: { title: string; lead?: string; diagnostics: readonly Diagnostic[]; testId: string }) {
  // Errors first: they are why nothing is shown; notes follow.
  const sorted = [...props.diagnostics].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return (
    <div className="blocker" role="alert" data-testid={props.testId}>
      <h3>{props.title}</h3>
      {props.lead ? <p>{props.lead}</p> : null}
      <DiagnosticList diagnostics={sorted} />
    </div>
  );
}
