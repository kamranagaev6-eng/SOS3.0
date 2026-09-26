import type { MotionPlan } from '../../core/contracts/plan.ts';
import { seconds } from '../format.ts';

/**
 * Reduced-motion friendly inspection: key poses at every phase boundary as buttons that seek (and
 * pause). No autoplay, no animated camera.
 */
export function StaticInspection(props: { plan: MotionPlan; currentT: number; onSeek(t: number): void }) {
  const { plan } = props;
  const points: { t: number; label: string; sub: string }[] = plan.phases.map((p) => ({ t: p.start, label: `${p.label} begins`, sub: p.id }));
  const last = plan.phases[plan.phases.length - 1];
  points.push({ t: plan.duration, label: last ? `${last.label} ends (clip end)` : 'Clip end', sub: 'end' });
  return (
    <nav className="static-inspection" aria-label="Key poses at phase boundaries" data-testid="static-inspection">
      <p className="small muted">Static inspection: the motion does not autoplay. Choose a key pose, or step frames with ← / →.</p>
      <ol className="keypose-list">
        {points.map((p, i) => {
          const active = Math.abs(props.currentT - p.t) < 1e-6;
          return (
            <li key={`${p.sub}-${i}`}>
              <button
                type="button"
                className={`btn keypose ${active ? 'keypose-active' : ''}`}
                aria-pressed={active}
                onClick={() => props.onSeek(p.t)}
                data-testid="keypose-button"
                data-t={p.t}
              >
                <span className="keypose-t">{seconds(p.t)}</span>
                <span className="keypose-label">{p.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
