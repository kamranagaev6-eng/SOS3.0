import { describe, expect, it } from 'vitest';
import { runHostIntegrationExample } from '../../examples/host-integration.ts';

// Keeps examples/host-integration.ts (the documented host integration path) working.
describe('examples/host-integration.ts', () => {
  it('drives the adapted host skeleton with planted contacts intact and refuses the legacy rig', () => {
    const r = runHostIntegrationExample(30);
    expect(r.frames).toBeGreaterThan(100);
    expect(r.host.units).toBe('cm');
    expect(r.maxPlantedDisplacementViaHost).toBeLessThanOrEqual(0.001);
    expect(r.maxHostVsEngineSiteError).toBeLessThan(1e-6);
    expect(r.stretchedBones).toEqual([]);
    expect(r.maxUnrepresented).toBeLessThanOrEqual(1e-9);
    const codes = r.legacyRigDiagnostics.map((d) => d.code);
    expect(codes.filter((c) => c === 'MISSING_CAPABILITY').length).toBeGreaterThanOrEqual(3);
    expect(r.legacyRigDiagnostics.every((d) => typeof d.hint === 'string' && d.hint.length > 20)).toBe(true);
    expect(r.ok).toBe(true);
  });
});
