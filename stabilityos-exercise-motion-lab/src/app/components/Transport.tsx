import type { PlayerSnapshot } from '../../player/index.ts';
import { SPEEDS } from '../../player/index.ts';
import { Segmented, Toggle } from './common.tsx';

export interface TransportProps {
  snapshot: PlayerSnapshot;
  disabled: boolean;
  inspectionRate: number;
  onToggle(): void;
  onStep(frames: number): void;
  onPhase(dir: 1 | -1): void;
  onHome(): void;
  onEnd(): void;
  onSpeed(s: number): void;
  onLoop(l: boolean): void;
  onRate(r: number): void;
}

export function Transport(p: TransportProps) {
  const playing = p.snapshot.playing;
  return (
    <div className="transport" role="group" aria-label="Playback controls">
      <div className="transport-row">
        <button type="button" className="btn icon-btn" onClick={p.onHome} disabled={p.disabled} aria-label="Go to start (Home)" title="Go to start (Home)">
          <Icon d="M6 5v14M19 5l-9 7 9 7z" />
        </button>
        <button type="button" className="btn icon-btn" onClick={() => p.onPhase(-1)} disabled={p.disabled} aria-label="Previous phase (Shift+Left)" title="Previous phase (Shift+←)">
          <Icon d="M11 5l-7 7 7 7M20 5l-7 7 7 7" />
        </button>
        <button type="button" className="btn icon-btn" onClick={() => p.onStep(-1)} disabled={p.disabled} aria-label="Step back one frame (Left)" title="Step back one frame (←)">
          <Icon d="M15 5l-7 7 7 7" />
        </button>
        <button
          type="button"
          className="btn btn-primary play-btn"
          onClick={p.onToggle}
          disabled={p.disabled}
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          data-testid="play-toggle"
          data-playing={playing ? 'true' : 'false'}
        >
          {playing ? <Icon d="M8 5v14M16 5v14" /> : <Icon d="M7 5l12 7-12 7z" fill />}
          <span>{playing ? 'Pause' : 'Play'}</span>
        </button>
        <button type="button" className="btn icon-btn" onClick={() => p.onStep(1)} disabled={p.disabled} aria-label="Step forward one frame (Right)" title="Step forward one frame (→)">
          <Icon d="M9 5l7 7-7 7" />
        </button>
        <button type="button" className="btn icon-btn" onClick={() => p.onPhase(1)} disabled={p.disabled} aria-label="Next phase (Shift+Right)" title="Next phase (Shift+→)">
          <Icon d="M4 5l7 7-7 7M13 5l7 7-7 7" />
        </button>
        <button type="button" className="btn icon-btn" onClick={p.onEnd} disabled={p.disabled} aria-label="Go to end (End)" title="Go to end (End)">
          <Icon d="M18 5v14M5 5l9 7-9 7z" />
        </button>
      </div>
      <div className="transport-row transport-options">
        <Segmented
          label="Speed"
          name="speed"
          value={p.snapshot.speed}
          options={SPEEDS.map((s) => ({ value: s, label: `${s}×` }))}
          onChange={p.onSpeed}
          testId="speed"
        />
        <Segmented
          label="Frame step"
          name="rate"
          value={p.inspectionRate}
          options={[
            { value: 30, label: '1/30 s' },
            { value: 60, label: '1/60 s' },
          ]}
          onChange={p.onRate}
        />
        <Toggle label="Loop" checked={p.snapshot.loop} onChange={p.onLoop} />
      </div>
    </div>
  );
}

function Icon(props: { d: string; fill?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={props.d} fill={props.fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
