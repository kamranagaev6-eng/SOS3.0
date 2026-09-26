import type { ReactNode } from 'react';
import type { Diagnostic } from '../../core/contracts/diagnostics.ts';

export function Panel(props: { id?: string; title: string; badge?: ReactNode; children: ReactNode; collapsible?: boolean; defaultOpen?: boolean; className?: string }) {
  const headingId = props.id ? `${props.id}-heading` : undefined;
  if (props.collapsible) {
    return (
      <section className={`panel ${props.className ?? ''}`} aria-labelledby={headingId} id={props.id}>
        <details open={props.defaultOpen ?? true}>
          <summary>
            <h2 id={headingId}>{props.title}</h2>
            {props.badge}
          </summary>
          <div className="panel-body">{props.children}</div>
        </details>
      </section>
    );
  }
  return (
    <section className={`panel ${props.className ?? ''}`} aria-labelledby={headingId} id={props.id}>
      <header className="panel-head">
        <h2 id={headingId}>{props.title}</h2>
        {props.badge}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  );
}

export function SyntheticTag() {
  return <span className="tag tag-synthetic">synthetic · unreviewed</span>;
}

export function DiagnosticList(props: { diagnostics: readonly Diagnostic[]; empty?: string; testId?: string; max?: number }) {
  const list = props.max ? props.diagnostics.slice(0, props.max) : props.diagnostics;
  if (list.length === 0) return props.empty ? <p className="muted small">{props.empty}</p> : null;
  return (
    <ul className="diag-list" data-testid={props.testId}>
      {list.map((d, i) => (
        <li key={`${d.code}-${i}`} className={`diag diag-${d.severity}`}>
          <span className={`sev sev-${d.severity}`}>{d.severity}</span>
          <code className="diag-code">{d.code}</code>
          <span className="diag-msg">{d.message}</span>
          {d.path ? <span className="diag-meta">at {d.path}</span> : null}
          {d.subject ? <span className="diag-meta">subject {d.subject}</span> : null}
          {d.hint ? <span className="diag-hint">Hint: {d.hint}</span> : null}
        </li>
      ))}
      {props.max && props.diagnostics.length > props.max ? (
        <li className="muted small">… {props.diagnostics.length - props.max} more</li>
      ) : null}
    </ul>
  );
}

export function Segmented<T extends string | number>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; title?: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  name: string;
  testId?: string;
}) {
  return (
    <fieldset className="segmented" data-testid={props.testId}>
      <legend>{props.label}</legend>
      <div className="segmented-row">
        {props.options.map((o) => (
          <label key={String(o.value)} className={`seg ${o.value === props.value ? 'seg-on' : ''} ${o.disabled ? 'seg-disabled' : ''}`} title={o.title}>
            <input
              type="radio"
              name={props.name}
              value={String(o.value)}
              checked={o.value === props.value}
              disabled={o.disabled}
              onChange={() => props.onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string; testId?: string; disabled?: boolean; swatch?: string }) {
  return (
    <label className={`toggle ${props.disabled ? 'toggle-disabled' : ''}`} title={props.hint}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.currentTarget.checked)} data-testid={props.testId} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      {props.swatch ? <span className="swatch" style={{ background: props.swatch }} aria-hidden="true" /> : null}
      <span className="toggle-label">{props.label}</span>
    </label>
  );
}
