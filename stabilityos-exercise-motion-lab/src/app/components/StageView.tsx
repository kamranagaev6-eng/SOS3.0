import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Side } from '../../core/contracts/common.ts';
import type { SolverTier } from '../../core/solver/types.ts';
import { CONTACT_STATE_CSS, createStage, RESIDUAL_MAGNIFICATION, StageUnavailableError, type OverlayFlags, type SplitLayout, type Stage, type ViewPreset } from '../../render/index.ts';
import type { ViewerController } from '../viewer.ts';

const TIER_LABEL: Record<SolverTier, string> = {
  baseline: 'Baseline — joint rotations, frozen pelvis',
  analytic: 'Analytic — tier 1',
  stabilized: 'Stabilized — tier 2',
};

export interface StageViewProps {
  controller: ViewerController;
  overlays: OverlayFlags;
  view: ViewPreset;
  inspectSide: Side | null;
  comparison: boolean;
  primaryTier: SolverTier;
  reducedMotion: boolean;
  /** Replaces the motion with a readable state (compile failure, incompatible rig...). */
  blocker: ReactNode | null;
  sampleError: string | null;
  onAvailability: (available: boolean, detail: string | null) => void;
}

export function StageView(props: StageViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);
  const [aspect, setAspect] = useState(16 / 9);
  // Same rule as the stage's viewport split (render/stage.ts), derived from props so labels never lag.
  const split: SplitLayout = props.comparison ? (aspect >= 1.1 ? 'side-by-side' : 'stacked') : 'none';
  const { controller, onAvailability } = props;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let s: Stage | null = null;
    try {
      s = createStage(canvas, { reducedMotion: props.reducedMotion, onContextChange: setContextLost });
    } catch (e) {
      const detail = e instanceof StageUnavailableError ? e.detail : e instanceof Error ? e.message : String(e);
      setUnavailable(detail);
      onAvailability(false, detail);
      return;
    }
    s.resize();
    controller.attachStage(s);
    setStage(s);
    onAvailability(true, null);
    const measure = (): void => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w > 0 && h > 0) setAspect(w / h);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => {
      s?.resize();
      measure();
    }) : null;
    ro?.observe(canvas);
    return () => {
      ro?.disconnect();
      controller.attachStage(null);
      s?.dispose();
      setStage(null);
    };
    // Stage lifetime = component lifetime; option changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller]);

  useEffect(() => {
    stage?.setOverlays(props.overlays);
  }, [stage, props.overlays]);
  useEffect(() => {
    stage?.setReducedMotion(props.reducedMotion);
  }, [stage, props.reducedMotion]);
  useEffect(() => {
    stage?.setView(props.view, { animate: !props.reducedMotion });
  }, [stage, props.view, props.reducedMotion]);
  useEffect(() => {
    stage?.setInspectionSide(props.inspectSide);
  }, [stage, props.inspectSide]);

  const showComparisonLabels = props.comparison && !unavailable && !props.blocker;
  return (
    <div className="stage-wrap" ref={wrapRef} data-split={split}>
      <canvas
        ref={canvasRef}
        className="stage-canvas"
        data-testid="stage-canvas"
        role="img"
        aria-label={`3D view of the synthetic humanoid${props.comparison ? ' — comparison: baseline (frozen pelvis) versus ' + props.primaryTier : ''}. Drag to orbit, scroll to zoom.`}
      />
      {showComparisonLabels ? (
        <>
          <div className={`stage-label stage-label-a split-${split}`} data-testid="comparison-label-baseline">
            {TIER_LABEL.baseline}
            <small>host platform's current behaviour</small>
          </div>
          <div className={`stage-label stage-label-b split-${split}`} data-testid="comparison-label-primary">
            {TIER_LABEL[props.primaryTier]}
          </div>
        </>
      ) : (
        !unavailable && !props.blocker && <div className="stage-label stage-label-single">{TIER_LABEL[props.primaryTier]}</div>
      )}
      {!unavailable && !props.blocker ? (
        <div className="stage-legend" aria-hidden="true">
          <span><i className="lg lg-left" />left</span>
          <span><i className="lg lg-right" />right</span>
          {props.overlays.contactTargets ? (
            <>
              <span><i className="lg lg-ring" style={{ borderColor: CONTACT_STATE_CSS.active }} />active</span>
              <span><i className="lg lg-ring" style={{ borderColor: CONTACT_STATE_CSS.engaging }} />engaging</span>
              <span><i className="lg lg-ring" style={{ borderColor: CONTACT_STATE_CSS.releasing }} />releasing</span>
            </>
          ) : null}
          {props.overlays.failures ? <span><i className="lg lg-fail" />violation</span> : null}
          {props.overlays.residuals && props.overlays.magnifyResiduals ? (
            <span className="lg-mag">residuals &amp; offset ×{RESIDUAL_MAGNIFICATION} (magnified)</span>
          ) : null}
        </div>
      ) : null}
      {unavailable ? (
        <div className="stage-message stage-error" role="alert" data-testid="webgl-unavailable">
          <strong>3D view unavailable.</strong>
          <span>{unavailable}</span>
          <span>Timeline, diagnostics and metrics below still use the real engine.</span>
        </div>
      ) : null}
      {contextLost ? (
        <div className="stage-message stage-error" role="alert">
          <strong>The WebGL context was lost.</strong>
          <span>The browser may restore it; numerical panels keep working.</span>
        </div>
      ) : null}
      {props.blocker ? <div className="stage-message stage-blocker">{props.blocker}</div> : null}
      {props.sampleError && !props.blocker ? (
        <div className="stage-message stage-error" role="alert" data-testid="sample-error">
          <strong>Sampling failed.</strong>
          <span>{props.sampleError}</span>
        </div>
      ) : null}
    </div>
  );
}
