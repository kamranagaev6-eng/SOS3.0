import type { MotionPlan } from '../../core/contracts/plan.ts';
import type { RecipeDefinition } from '../../core/recipes/types.ts';
import { seconds } from '../format.ts';

export function RecipeInfo(props: { recipe: RecipeDefinition; plan: MotionPlan | null }) {
  const { recipe, plan } = props;
  const planAssumptions = plan ? plan.assumptions.filter((a) => !recipe.assumptions.includes(a)) : [];
  return (
    <div className="recipe-info" data-testid="recipe-info">
      <p className="notice small">
        Synthetic, unreviewed engineering fixture: neutral kinematic description for inspection only — not a prescription, dose or patient instruction.
      </p>
      <dl className="kv">
        <div>
          <dt>Recipe id</dt>
          <dd>
            <code>{recipe.id}</code>
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{recipe.version}</dd>
        </div>
        <div>
          <dt>Required rig capabilities</dt>
          <dd className="small">{recipe.requiredCapabilities.join(', ')}</dd>
        </div>
      </dl>
      <p className="small">{recipe.summary}</p>
      <h3>Setup</h3>
      <ul className="plain-list small">
        {recipe.setup.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <h3>Phases</h3>
      <ol className="plain-list small phase-list">
        {(plan?.phases ?? recipe.phaseOutline.map((p) => ({ ...p, start: NaN, end: NaN }))).map((p) => (
          <li key={p.id}>
            <strong>{p.label}</strong> <code className="muted">{p.id}</code>
            {Number.isFinite(p.start) ? (
              <span className="muted">
                {' '}
                {seconds(p.start)} – {seconds(p.end)}
              </span>
            ) : null}
            {p.description ? <div className="muted">{p.description}</div> : null}
          </li>
        ))}
      </ol>
      {plan && plan.cues.length > 0 ? (
        <>
          <h3>Cue markers (timing only)</h3>
          <ul className="plain-list small">
            {plan.cues.map((c) => (
              <li key={c.id}>
                {seconds(c.t)} — {c.label} <code className="muted">{c.phaseId}</code>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h3>Contact changes</h3>
      <ul className="plain-list small">
        {recipe.contactChanges.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <h3>Unsupported configurations</h3>
      <ul className="plain-list small">
        {recipe.unsupported.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <h3>Assumptions</h3>
      <ul className="plain-list small">
        {recipe.assumptions.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
        {planAssumptions.map((s, i) => (
          <li key={`p${i}`}>{s}</li>
        ))}
      </ul>
    </div>
  );
}
