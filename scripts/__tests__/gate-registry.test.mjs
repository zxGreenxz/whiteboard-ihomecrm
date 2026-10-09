import { describe, expect, it } from 'vitest';
import { GATE_REGISTRY, GENERATOR_REGISTRY, getGate } from '../lib/gate-registry.mjs';
import { selectLocalGates, summarizeGatePlan } from '../kiem-nhanh-truoc-push.mjs';

describe('command registry boundaries', () => {
  it('preview keeps commands and selected counts without dumping the whole repository into context', () => {
    const p = { gateIds: ['check-docs'], suiteSelections: [{ id: 'example', files: Array(2000).fill('src/large.test.ts') }], inputPaths: Array(5000).fill('src/large.ts') };
    const preview = summarizeGatePlan(p);
    expect(preview.gates[0].args).toEqual(['scripts/check-docs.mjs']);
    expect(preview.suites[0].testFileCount).toBe(2000);
    expect(JSON.stringify(preview)).not.toContain('src/large');
    expect(JSON.stringify(preview).length).toBeLessThan(2000);
  });
  it('rejects absent, empty or deferred test selections', () => {
    expect(() => getGate('suite:app-unit', { suiteSelections: [] })).toThrow('Missing selected tests');
    expect(() => getGate('suite:app-unit', { suiteSelections: [{ id: 'app-unit', files: ['src/copilot/model.test.ts'] }] })).toThrow('DEFERRED');
    expect(() => getGate('check-copilot-routes', {})).toThrow('DEFERRED');
    expect(() => getGate('not-a-gate', {})).toThrow('Unknown gate');
  });
  it('keeps required checks despite legacy skip switches and delegates full app tests to CI', () => {
    const plan = { gateIds: ['check-ts-baseline', 'app-build', 'suite:app-unit'], suiteSelections: [{ id: 'app-unit', files: ['src/lib/example.test.ts'], mode: 'all' }] };
    expect(selectLocalGates(plan, { boDaoStrict: true }).map((g) => g.id)).toEqual(['check-ts-baseline']);
    expect(selectLocalGates(plan, { full: true }).map((g) => g.id)).toEqual(['check-ts-baseline', 'suite:app-unit']);
    expect(getGate('suite:app-unit', { suiteSelections: [{ ...plan.suiteSelections[0], mode: 'targeted' }] }).local).toBe(true);
  });
  it('does not turn a full run into browser access to live product data', () => {
    expect(() => getGate('suite:e2e-fleet', { suiteSelections: [{ id: 'e2e-fleet', files: ['.e2e-fleet/specs/voucher-detail-read-scope.spec.ts'] }] })).toThrow('approved offline');
    expect(() => getGate('suite:e2e-fleet', { suiteSelections: [{ id: 'e2e-fleet', files: ['.e2e-fleet/specs/personal-finance-demo.spec.ts'] }] })).toThrow('approved offline');
    expect(getGate('suite:e2e-personal-finance-demo', { suiteSelections: [{ id: 'e2e-personal-finance-demo', files: ['.e2e-fleet/specs/personal-finance-demo.spec.ts'] }] }).job).toBe('quality-gates');
  });
  it('preserves build lifecycle, normalizer mode and generated ownership', () => {
    expect(getGate('app-build', {})).toMatchObject({ command: 'npm', args: ['run', 'build'] });
    expect(getGate('normalize-supabase-types', {}).args).toContain('--check');
    expect(GENERATOR_REGISTRY['normalize-supabase-types'].args).toContain('--write');
    expect(GENERATOR_REGISTRY['generate-docs-views'].owns).toContain('docs/generated/capability-matrix.md');
    expect(Object.values(GENERATOR_REGISTRY).some((g) => g.owns.includes('docs/generated/schema-change-evidence/'))).toBe(false);
  });
  it('declares both money checks and refuses a migration check with no verified base', () => {
    expect(GATE_REGISTRY['check-realtime-descriptors']).toMatchObject({ local: false, evidenceClass: 'live', requires: ['SUPABASE_PAT'] });
    expect(GATE_REGISTRY['reconcile-money-v2'].evidenceClass).toBe('live');
    expect(GATE_REGISTRY['reconcile-money'].evidenceClass).toBe('live');
    expect(() => getGate('check-forward-migration-idempotent', { snapshot: {} })).toThrow('verified diff base');
  });
});
