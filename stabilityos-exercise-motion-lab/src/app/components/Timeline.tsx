import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { FootState, MotionPlan } from '../../core/contracts/plan.ts';
import { seconds } from '../format.ts';
import type { ViewerController } from '../viewer.ts';

const PHASE_HUES = [212, 168, 32, 280, 350, 128, 196, 48, 250, 12];

function phaseColor(id: string, index: number): string {
  const base = id.replace(/-\d+$/, '');
  let h = 0;
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
  const hue = PHASE_HUES[h % PHASE_HUES.length] ?? PHASE_HUES[index % PHASE_HUES.length]!;
  return `hsl(${hue} 55% var(--phase-l))`;
}

function footLabel(s: FootState): string {
  if (s.kind === 'flat') return `flat on ${s.surface}`;
  if (s.kind === 'forefoot') return `forefoot on ${s.surface}`;
  return 'swing';
}

export function Timeline(props: { plan: MotionPlan; controller: ViewerController; phaseIndex: number; disabled?: boolean }) {
  const { plan, controller } = props;
  const d = plan.duration;
  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const draggingRef = useRef(false);

  useEffect(
    () =>
      controller.addFrameListener((t, duration) => {
        const pct = `${(Math.min(Math.max(t / duration, 0), 1) * 100).toFixed(3)}%`;
        if (playheadRef.current) playheadRef.current.style.left = pct;
        if (rangeRef.current && document.activeElement !== rangeRef.current) rangeRef.current.value = String(t);
        if (rangeRef.current) rangeRef.current.setAttribute('aria-valuetext', `${t.toFixed(2)} seconds`);
        if (timeRef.current) timeRef.current.textContent = `${t.toFixed(2)} s`;
      }),
    [controller],
  );
  useEffect(() => {
    // Keep the scrubber in sync after a plan change even when the frame loop is idle.
    if (rangeRef.current) rangeRef.current.value = String(controller.player.time());
  }, [controller, plan]);

  const seekFromPointer = (clientX: number): void => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const f = Math.min(Math.max((clientX - r.left) / Math.max(r.width, 1), 0), 1);
    controller.player.pause();
    controller.player.seek(f * d);
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (props.disabled) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekFromPointer(e.clientX);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (draggingRef.current) seekFromPointer(e.clientX);
  };
  const onUp = (): void => {
    draggingRef.current = false;
  };

  const pct = (t: number): string => `${((t / d) * 100).toFixed(4)}%`;
  const current = plan.phases[props.phaseIndex];
  const lanes: { key: string; label: string; states: FootState[] }[] = [
    { key: 'left', label: 'L foot', states: plan.feet.left },
    { key: 'right', label: 'R foot', states: plan.feet.right },
  ];

  return (
    <div className={`timeline ${props.disabled ? 'timeline-disabled' : ''}`} data-testid="timeline">
      <div className="timeline-head">
        <span className="time-readout" aria-label="Current time">
          <span ref={timeRef} data-testid="time-readout">0.00 s</span>
          <span className="muted"> / {seconds(d)}</span>
        </span>
        <span className="phase-readout" data-testid="phase-readout" aria-label="Current phase">
          {current ? (
            <>
              <i className="phase-dot" style={{ background: phaseColor(current.id, props.phaseIndex) }} aria-hidden="true" />
              {current.label}
              <span className="muted small"> ({current.id})</span>
            </>
          ) : (
            '—'
          )}
        </span>
      </div>
      <div className="timeline-body">
        <div className="lane-labels" aria-hidden="true">
          <span>Phases</span>
          {lanes.map((l) => (
            <span key={l.key}>{l.label}</span>
          ))}
          {plan.seat ? <span>Seat</span> : null}
        </div>
        <div
          className="timeline-tracks"
          ref={trackRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          data-testid="timeline-track"
          title="Click or drag to seek"
        >
          <div className="phase-track">
            {plan.phases.map((p, i) => (
              <div
                key={p.id}
                className={`phase-seg ${i === props.phaseIndex ? 'phase-seg-current' : ''}`}
                style={{ left: pct(p.start), width: pct(p.end - p.start), background: phaseColor(p.id, i) }}
                title={`${p.label}: ${seconds(p.start)} – ${seconds(p.end)}${p.description ? ` — ${p.description}` : ''}`}
                data-testid="phase-segment"
                data-phase-id={p.id}
              >
                <span className="phase-seg-label">{p.label}</span>
              </div>
            ))}
            {plan.cues.map((c) => (
              <div key={c.id} className="cue-marker" style={{ left: pct(c.t) }} title={`Cue marker (${seconds(c.t)}): ${c.label}`} data-testid="cue-marker" />
            ))}
          </div>
          {lanes.map((l) => (
            <div className="contact-lane" key={l.key}>
              {l.states.map((s, i) => (
                <div
                  key={i}
                  className={`foot-seg foot-${s.kind} foot-${l.key}`}
                  style={{ left: pct(s.start), width: pct(Math.max(s.end - s.start, 0)) }}
                  title={`${l.label}: ${footLabel(s)} ${seconds(s.start)} – ${seconds(s.end)}`}
                />
              ))}
            </div>
          ))}
          {plan.seat ? (
            <div className="contact-lane">
              {plan.seat.intervals.map((iv, i) => (
                <div
                  key={i}
                  className="foot-seg foot-seat"
                  style={{ left: pct(iv.start), width: pct(Math.max(iv.end - iv.start, 0)) }}
                  title={`Seat contact ${seconds(iv.start)} – ${seconds(iv.end)} (blend in ${iv.blendIn}s / out ${iv.blendOut}s)`}
                />
              ))}
            </div>
          ) : null}
          <div className="playhead" ref={playheadRef} aria-hidden="true" />
        </div>
      </div>
      <div className="timeline-legend small muted" aria-hidden="true">
        <span><i className="lg-foot foot-flat" /> flat</span>
        <span><i className="lg-foot foot-forefoot" /> forefoot (heel raised)</span>
        <span><i className="lg-foot foot-swing" /> swing</span>
        {plan.seat ? <span><i className="lg-foot foot-seat" /> seat contact</span> : null}
        <span><i className="lg-cue" /> cue marker</span>
      </div>
      <label className="scrubber">
        <span className="sr-only">Time scrubber</span>
        <input
          ref={rangeRef}
          type="range"
          min={0}
          max={d}
          step={0.001}
          defaultValue={0}
          disabled={props.disabled}
          aria-label="Time scrubber"
          data-testid="scrubber"
          onInput={(e) => {
            controller.player.pause();
            controller.player.seek(Number(e.currentTarget.value));
          }}
        />
      </label>
    </div>
  );
}
