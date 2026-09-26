import type { Side } from '../../core/contracts/common.ts';
import type { SolverTier } from '../../core/solver/types.ts';
import { CONTACT_STATE_CSS, VIEW_LABELS, type OverlayFlags, type ViewPreset } from '../../render/index.ts';
import { Segmented, Toggle } from './common.tsx';

const VIEW_KEYS: Record<ViewPreset, string> = { front: '1', 'side-left': '2', 'side-right': '3', oblique: '4', top: '5' };

export function ViewControls(props: {
  view: ViewPreset;
  onView(v: ViewPreset): void;
  side: Side | null;
  onSide(s: Side | null): void;
  comparison: boolean;
  onComparison(c: boolean): void;
  tier: SolverTier;
  onTier(t: SolverTier): void;
  disabled: boolean;
}) {
  return (
    <div className="view-controls">
      <Segmented
        label="View"
        name="view"
        value={props.view}
        testId="view-presets"
        options={(['front', 'side-left', 'side-right', 'oblique', 'top'] as const).map((v) => ({ value: v, label: VIEW_LABELS[v], title: `${VIEW_LABELS[v]} view (key ${VIEW_KEYS[v]})` }))}
        onChange={props.onView}
      />
      <Segmented
        label="Inspect side"
        name="side"
        value={props.side ?? 'none'}
        testId="inspect-side"
        options={[
          { value: 'none', label: 'Both' },
          { value: 'left', label: 'Left (L)', title: 'Highlight the left limbs and contacts, view from the left' },
          { value: 'right', label: 'Right (R)', title: 'Highlight the right limbs and contacts, view from the right' },
        ]}
        onChange={(v) => props.onSide(v === 'none' ? null : (v as Side))}
      />
      <Segmented
        label="Solver tier"
        name="tier"
        value={props.tier}
        testId="tier"
        options={[
          { value: 'baseline', label: 'Baseline', title: 'Tier 0: solved joint rotations replayed with the pelvis frozen at t=0 (host platform’s current behaviour)' },
          { value: 'analytic', label: 'Analytic', title: 'Tier 1: authored pelvis + closed-form leg IK' },
          { value: 'stabilized', label: 'Stabilized', title: 'Tier 2: tier 1 + bounded pelvis stabiliser' },
        ]}
        onChange={props.onTier}
      />
      <Toggle
        label="Compare with baseline (C)"
        checked={props.comparison}
        onChange={props.onComparison}
        testId="comparison-toggle"
        disabled={props.disabled}
        hint="Split view: frozen-pelvis baseline beside the solved pose"
      />
    </div>
  );
}

export function OverlayControls(props: { flags: OverlayFlags; onChange(f: Partial<OverlayFlags>): void; hostBonesAvailable: boolean }) {
  const f = props.flags;
  return (
    <fieldset className="overlay-controls" data-testid="overlay-controls">
      <legend>Overlays</legend>
      <Toggle label="Contact targets" checked={f.contactTargets} onChange={(v) => props.onChange({ contactTargets: v })} swatch={CONTACT_STATE_CSS.active} testId="overlay-contactTargets" />
      <Toggle label="Contact sites" checked={f.contactSites} onChange={(v) => props.onChange({ contactSites: v })} swatch="#1d2733" testId="overlay-contactSites" />
      <Toggle label="Residual vectors" checked={f.residuals} onChange={(v) => props.onChange({ residuals: v })} swatch="#d6336c" testId="overlay-residuals" />
      <Toggle label="Magnify residuals ×10" checked={f.magnifyResiduals} onChange={(v) => props.onChange({ magnifyResiduals: v })} testId="overlay-magnifyResiduals" hint="Residual vectors and the stabilisation arrow are drawn 10× longer (labelled in the view)" />
      <Toggle label="Pelvis trajectory" checked={f.trajectory} onChange={(v) => props.onChange({ trajectory: v })} swatch="#51617a" testId="overlay-trajectory" />
      <Toggle label="Joint axes" checked={f.jointAxes} onChange={(v) => props.onChange({ jointAxes: v })} testId="overlay-jointAxes" hint="X red, Y green, Z blue" />
      <Toggle label="Solver failures" checked={f.failures} onChange={(v) => props.onChange({ failures: v })} swatch={CONTACT_STATE_CSS.fail} testId="overlay-failures" hint="Red markers on violating contacts / clamped joints; orange stabilisation offset arrow" />
      <Toggle
        label="Host bones (adapter)"
        checked={f.hostBones}
        onChange={(v) => props.onChange({ hostBones: v })}
        disabled={!props.hostBonesAvailable}
        testId="overlay-hostBones"
        hint={props.hostBonesAvailable ? 'Host skeleton reconstructed by the rig adapter' : 'Only for adapted host rigs'}
        swatch="#0b7285"
      />
    </fieldset>
  );
}
