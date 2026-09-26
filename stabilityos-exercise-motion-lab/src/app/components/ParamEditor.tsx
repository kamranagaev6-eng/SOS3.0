import type { ParamSpec } from '../../core/contracts/recipe.ts';
import { unitLabel, unitWord } from '../format.ts';
import type { RawParams } from '../params.ts';

export function ParamEditor(props: {
  recipeId: string;
  specs: readonly ParamSpec[];
  raw: RawParams;
  errors: Record<string, string>;
  compileErrors: Record<string, string>;
  onChange(key: string, value: string): void;
  onReset(): void;
  isDefault: boolean;
  pending: boolean;
}) {
  const hasErrors = Object.keys(props.errors).length > 0;
  return (
    <form className="param-editor" onSubmit={(e) => e.preventDefault()} aria-describedby="param-status" data-testid="param-editor">
      <div className="param-grid">
        {props.specs.map((s) => {
          const id = `p-${props.recipeId}-${s.key}`;
          const err = props.errors[s.key] ?? props.compileErrors[s.key];
          const errId = `${id}-err`;
          const hintId = `${id}-hint`;
          return (
            <div key={s.key} className={`param ${err ? 'param-invalid' : ''}`} data-param={s.key}>
              <label htmlFor={id} className="param-label">
                {s.label}
                {s.kind === 'number' && unitLabel(s) ? <span className="unit"> ({unitLabel(s)})</span> : null}
              </label>
              {s.kind === 'number' ? (
                <input
                  id={id}
                  name={s.key}
                  type="number"
                  inputMode="decimal"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={props.raw[s.key] ?? ''}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={`${hintId}${err ? ` ${errId}` : ''}`}
                  onChange={(e) => props.onChange(s.key, e.currentTarget.value)}
                  data-testid={`param-${s.key}`}
                />
              ) : (
                <select
                  id={id}
                  name={s.key}
                  value={props.raw[s.key] ?? s.default}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={`${hintId}${err ? ` ${errId}` : ''}`}
                  onChange={(e) => props.onChange(s.key, e.currentTarget.value)}
                  data-testid={`param-${s.key}`}
                >
                  {s.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              )}
              <span id={hintId} className="param-hint">
                {s.kind === 'number' ? `${s.min}–${s.max} ${unitWord(s)} · default ${s.default}` : `default ${s.default}`}
                {s.description ? <span className="sr-only">. {s.description}</span> : null}
              </span>
              {err ? (
                <span id={errId} className="param-error" role="alert" data-testid={`param-error-${s.key}`}>
                  {err}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="param-actions">
        <button type="button" className="btn" onClick={props.onReset} disabled={props.isDefault} data-testid="reset-params">
          Reset to defaults
        </button>
        <span id="param-status" className="small muted" aria-live="polite">
          {hasErrors ? 'Fix the highlighted values — the view keeps the last valid parameters.' : props.pending ? 'Recompiling…' : 'Parameters valid.'}
        </span>
      </div>
    </form>
  );
}
