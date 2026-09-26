import type { MotionPlan } from '../../core/contracts/plan.ts';
import type { ClipMetrics } from '../../core/metrics/types.ts';
import type { PoseSample, SolverTier } from '../../core/solver/types.ts';
import { TOLERANCES } from '../../core/tolerances.ts';
import type { AnalysisState } from '../analysis.ts';
import { ANALYSIS_TIERS, METRICS_RATE } from '../analysis.ts';
import { degFromRad, mm, RAD2DEG } from '../format.ts';
import { DiagnosticList } from './common.tsx';

function contactStatus(c: PoseSample['contacts'][number]): { label: string; cls: string } {
  if (c.weight < 1) return { label: c.state === 'engaging' ? 'engaging' : 'releasing', cls: 'st-transition' };
  return c.withinTolerance ? { label: 'OK', cls: 'st-ok' } : { label: 'VIOLATION', cls: 'st-fail' };
}

export function LiveDiagnostics(props: { sample: PoseSample | null; plan: MotionPlan | null; t: number; phaseIndex: number; tier: SolverTier; error: string | null }) {
  const s = props.sample;
  const phase = props.plan?.phases[props.phaseIndex];
  if (props.error) {
    return (
      <div className="live-diag" data-testid="live-diagnostics">
        <p className="error-text" role="alert">Sampling failed at t = {props.t.toFixed(3)} s: {props.error}</p>
      </div>
    );
  }
  if (!s) {
    return (
      <div className="live-diag" data-testid="live-diagnostics">
        <p className="muted">No motion to inspect.</p>
      </div>
    );
  }
  const st = s.stabilization;
  const offMag = Math.hypot(st.offset[0], st.offset[1], st.offset[2]);
  const byPos = s.contacts.filter((c) => c.interval.kind === 'position');
  const byOri = s.contacts.filter((c) => c.interval.kind === 'orientation');
  return (
    <div className="live-diag" data-testid="live-diagnostics">
      <dl className="kv">
        <div>
          <dt>Time</dt>
          <dd data-testid="diag-time">{s.t.toFixed(3)} s</dd>
        </div>
        <div>
          <dt>Phase</dt>
          <dd data-testid="diag-phase">{phase ? `${phase.label} (${phase.id})` : s.phaseId}</dd>
        </div>
        <div>
          <dt>Tier</dt>
          <dd>{s.tier}</dd>
        </div>
      </dl>
      <h3>Active contacts ({s.contacts.length})</h3>
      {s.contacts.length === 0 ? (
        <p className="muted small">No contacts at this time.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table" data-testid="contact-table">
            <thead>
              <tr>
                <th scope="col">Site</th>
                <th scope="col">Surface</th>
                <th scope="col">State</th>
                <th scope="col" className="num">Residual</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {byPos.map((c) => {
                const stt = contactStatus(c);
                return (
                  <tr key={c.interval.id} className={`side-${c.interval.side}`}>
                    <td>
                      <span className={`side-dot side-${c.interval.side}`} aria-hidden="true" />
                      {c.interval.site}
                    </td>
                    <td>{c.interval.surface}</td>
                    <td>
                      {c.state}
                      {c.weight < 1 ? <span className="muted small"> w={c.weight.toFixed(2)}</span> : null}
                    </td>
                    <td className="num">{mm(c.positionError, 3)}</td>
                    <td className={stt.cls}>{stt.label}</td>
                  </tr>
                );
              })}
              {byOri.map((c) => {
                const stt = contactStatus(c);
                return (
                  <tr key={c.interval.id} className={`side-${c.interval.side}`}>
                    <td>
                      <span className={`side-dot side-${c.interval.side}`} aria-hidden="true" />
                      {c.interval.site} <span className="muted small">({c.interval.segment ?? 'orientation'})</span>
                    </td>
                    <td>{c.interval.surface}</td>
                    <td>
                      {c.state}
                      {c.weight < 1 ? <span className="muted small"> w={c.weight.toFixed(2)}</span> : null}
                    </td>
                    <td className="num">{degFromRad(c.orientationError, 3)}</td>
                    <td className={stt.cls}>{stt.label}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">
        Tolerances (fully active contacts): position ≤ {mm(TOLERANCES.contactPosition, 1)}, orientation ≤ {degFromRad(TOLERANCES.contactOrientation, 1)}. Engaging/releasing contacts are reported, not judged.
      </p>
      <h3>Stabilisation</h3>
      <dl className="kv" data-testid="stabilization">
        <div>
          <dt>Offset</dt>
          <dd>
            {mm(offMag, 2)}{' '}
            <span className="muted small">
              (x {mm(st.offset[0], 2)}, y {mm(st.offset[1], 2)}, z {mm(st.offset[2], 2)})
            </span>
          </dd>
        </div>
        <div>
          <dt>Iterations</dt>
          <dd>{st.iterations}</dd>
        </div>
        <div>
          <dt>Converged</dt>
          <dd className={st.converged ? 'st-ok' : 'st-fail'}>{st.converged ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt>Bound reached</dt>
          <dd className={st.boundReached ? 'st-fail' : ''}>{st.boundReached ? 'yes' : 'no'}</dd>
        </div>
        <div>
          <dt>Enabled</dt>
          <dd>{st.enabled ? 'yes' : 'no'}</dd>
        </div>
      </dl>
      <h3>Joint clamps ({s.limitEvents.length})</h3>
      {s.limitEvents.length === 0 ? (
        <p className="muted small">No joint limits reached.</p>
      ) : (
        <ul className="plain-list small" data-testid="joint-clamps">
          {s.limitEvents.map((e, i) => (
            <li key={i}>
              <code>{e.joint}.{e.dof}</code>: requested {(e.requested * RAD2DEG).toFixed(1)}°, applied {(e.applied * RAD2DEG).toFixed(1)}°
            </li>
          ))}
        </ul>
      )}
      <h3>Legs</h3>
      <ul className="plain-list small">
        {s.legs.map((l) => (
          <li key={l.side}>
            <span className={`side-dot side-${l.side}`} aria-hidden="true" />
            {l.side}: reach {(l.hipToAnkle * 100).toFixed(1)} / {(l.maxReach * 100).toFixed(1)} cm{l.reachable ? '' : ' (unreachable)'}, knee {(l.kneeFlexion * RAD2DEG).toFixed(1)}°
            {l.kneeForwardDot <= 0 ? <strong className="st-fail"> knee flip</strong> : null}
          </li>
        ))}
      </ul>
      <h3>Sample diagnostics ({s.diagnostics.length})</h3>
      <DiagnosticList diagnostics={s.diagnostics} empty="None at this time." max={8} />
    </div>
  );
}

interface MetricRow {
  label: string;
  unit: string;
  get: (m: ClipMetrics) => number;
  fmt: (v: number) => string;
  tol?: number;
}

const f2 = (v: number): string => v.toFixed(2);
const f3 = (v: number): string => v.toFixed(3);
const intf = (v: number): string => String(v);
const toMm = (fmt: (v: number) => string) => (v: number): string => fmt(v * 1000);
const toDeg = (fmt: (v: number) => string) => (v: number): string => fmt(v * RAD2DEG);

const ROWS: MetricRow[] = [
  { label: 'Planted-contact displacement', unit: 'mm', get: (m) => m.maxPlantedDisplacement, fmt: toMm(f2), tol: TOLERANCES.plantedDisplacement },
  { label: 'Contact position residual', unit: 'mm', get: (m) => m.maxContactPositionError, fmt: toMm(f3), tol: TOLERANCES.contactPosition },
  { label: 'Contact orientation residual', unit: '°', get: (m) => m.maxContactOrientationError, fmt: toDeg(f2), tol: TOLERANCES.contactOrientation },
  { label: 'Surface penetration', unit: 'mm', get: (m) => m.maxPenetration, fmt: toMm(f2), tol: TOLERANCES.penetration },
  { label: 'Stabilisation offset', unit: 'mm', get: (m) => m.maxStabilizationOffset, fmt: toMm(f2) },
  { label: 'Joint velocity jump', unit: 'rad/s', get: (m) => m.maxJointVelocityJump, fmt: f3, tol: TOLERANCES.jointVelocityJump },
  { label: 'Linear velocity jump', unit: 'm/s', get: (m) => m.maxLinearVelocityJump, fmt: f3, tol: TOLERANCES.linearVelocityJump },
  { label: 'Clamped samples', unit: 'n', get: (m) => m.clampedSamples, fmt: intf },
  { label: 'Unreachable samples', unit: 'n', get: (m) => m.unreachableSamples, fmt: intf, tol: 0 },
  { label: 'Stabilised samples', unit: 'n', get: (m) => m.stabilizedSamples, fmt: intf },
  { label: 'Non-converged samples', unit: 'n', get: (m) => m.nonConvergedSamples, fmt: intf, tol: 0 },
  { label: 'Knee-flip samples', unit: 'n', get: (m) => m.kneeFlipSamples, fmt: intf, tol: 0 },
];

const TIER_SHORT: Record<SolverTier, string> = { baseline: 'Base', analytic: 'Anal.', stabilized: 'Stab.' };

export function ClipMetricsSummary(props: { analysis: AnalysisState; selectedTier: SolverTier }) {
  const { analysis } = props;
  const tiers = [...ANALYSIS_TIERS].reverse(); // baseline, analytic, stabilized
  const sel = analysis.results[props.selectedTier];
  return (
    <div className="metrics" data-testid="clip-metrics" data-status={analysis.status}>
      <p className="small muted">
        Maxima over the whole clip, sampled at {METRICS_RATE} Hz per solver tier by the engine&apos;s own analyser. Geometric only: says nothing about balance, loading, safety or clinical correctness.
      </p>
      <p className="small" aria-live="polite" data-testid="metrics-status">
        {analysis.status === 'running' ? 'Computing whole-clip metrics…' : analysis.status === 'done' ? 'Whole-clip metrics ready.' : 'Metrics not computed.'}
      </p>
      <div className="table-wrap">
        <table className="data-table metrics-table">
          <caption className="sr-only">Whole-clip metrics per solver tier (baseline, analytic, stabilized) with tolerances</caption>
          <thead>
            <tr>
              <th scope="col">Metric (unit)</th>
              {tiers.map((t) => (
                <th scope="col" key={t} className={`num ${t === props.selectedTier ? 'col-selected' : ''}`}>
                  <abbr title={t}>{TIER_SHORT[t]}</abbr>
                </th>
              ))}
              <th scope="col" className="num">
                Tol.
              </th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.label}>
                <th scope="row">
                  {r.label} <span className="muted">({r.unit})</span>
                </th>
                {tiers.map((t) => {
                  const res = analysis.results[t];
                  const v = res?.metrics ? r.get(res.metrics) : null;
                  const bad = v !== null && r.tol !== undefined && v > r.tol + 1e-12;
                  return (
                    <td key={t} className={`num ${bad ? 'st-fail' : ''} ${t === props.selectedTier ? 'col-selected' : ''}`}>
                      {res?.error ? <span title={res.error}>error</span> : v === null ? '…' : r.fmt(v)}
                    </td>
                  );
                })}
                <td className="num muted">{r.tol !== undefined ? r.fmt(r.tol) : '—'}</td>
              </tr>
            ))}
            <tr className="row-verdict">
              <th scope="row">Within tolerance</th>
              {tiers.map((t) => {
                const m = analysis.results[t]?.metrics;
                return (
                  <td key={t} className={`num ${m ? (m.withinTolerance ? 'st-ok' : 'st-fail') : ''} ${t === props.selectedTier ? 'col-selected' : ''}`} data-testid={`within-${t}`}>
                    {m ? (m.withinTolerance ? 'yes' : 'no') : '…'}
                  </td>
                );
              })}
              <td />
            </tr>
          </tbody>
        </table>
      </div>
      <p className="small muted">Baseline is expected to fail: it is the joint-rotation-only behaviour this engine replaces (feet slide, lift or penetrate).</p>
      {sel?.metrics && sel.metrics.failures.length > 0 ? (
        <details className="failures">
          <summary>
            {sel.metrics.failures.length} tolerance failure{sel.metrics.failures.length === 1 ? '' : 's'} in the {props.selectedTier} tier
          </summary>
          <ul className="plain-list small">
            {sel.metrics.failures.slice(0, 20).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {sel ? (
        <p className="small muted">
          {props.selectedTier}: {sel.metrics?.samples ?? 0} samples analysed in {sel.analyzeMs.toFixed(0)} ms ({sel.where}).
        </p>
      ) : null}
    </div>
  );
}
