import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assignSuites, trackedTestFiles } from '../check-test-matrix.mjs';
import { isDeferredGate, isDeferredTest } from '../lib/deferred-modules.mjs';
import { createGatePlan } from '../lib/gate-plan.mjs';
import { getGate } from '../lib/gate-registry.mjs';

const matrix = JSON.parse(readFileSync(new URL('../../tooling/test-matrix.json', import.meta.url), 'utf8'));
// Exercise real files in the restored domains without repeatedly planning
// thousands of unrelated app tests in each routing assertion.
const testFiles = trackedTestFiles([]).filter(file =>
  /^(?:src\/copilot\/|worker\/__tests__\/|infra\/hermes-(?:broker|runtime)\/|scripts\/__tests__\/(?:check-copilot-|generate-hermes-crm-inventory\.|compare-hermes-crm-catalog\.|test-hermes-broker-authz\.))/.test(file));
const snapshot = { base: 'base', head: 'head', tree: 'tree', source: 'fixture' };
const planFor = (path, testMatrix = matrix, files = testFiles) => createGatePlan({
  snapshot, changes: [{ path, status: 'M', before: 'before', after: 'after' }],
  testFiles: files, testMatrix,
});
const coreTests = [
  'src/copilot/__tests__/toolOrgScope.test.ts',
  'src/copilot/__tests__/confirmationRace.test.ts',
  'src/copilot/__tests__/memory.test.ts',
  'src/copilot/plan/__tests__/actionCatalog.test.ts',
  'src/copilot/plan/__tests__/planClient.test.ts',
];
const verifierTests = [
  'scripts/__tests__/check-copilot-tool-inventory.test.mjs',
  'scripts/__tests__/check-copilot-docs-manifest.test.mjs',
  'scripts/__tests__/check-copilot-forbidden-actions.test.mjs',
];
const staticGates = [
  'check-copilot-tool-inventory', 'check-copilot-docs-manifest',
  'check-copilot-forbidden-actions', 'generate-copilot-guide-corpus',
];

describe('P0 shared CRM foundation routing', () => {
  it('restores real core files to their actual Vitest and node:test owners', () => {
    for (const file of [...coreTests, ...verifierTests]) {
      expect(testFiles, file).toContain(file);
      expect(isDeferredTest(file), file).toBe(false);
    }
    const assigned = assignSuites([...coreTests, ...verifierTests], matrix.suites);
    expect(assigned.orphans).toEqual([]);
    expect(assigned.deferred).toEqual([]);
    expect(assigned.bySuite.get('app-unit')).toEqual(coreTests);
    expect(assigned.bySuite.get('node-native')).toEqual(verifierTests);
  });

  it('selects core coverage and static contracts for a registry change without full fallback', () => {
    const plan = planFor('src/copilot/tools/registry.ts');
    expect(plan.fullFallback).toBe(false);
    expect(plan.unavailable).toEqual([]);
    expect(plan.suiteSelections.find(s => s.id === 'app-unit')).toMatchObject({
      mode: 'targeted', files: expect.arrayContaining(coreTests),
    });
    const native = plan.suiteSelections.find(s => s.id === 'node-native');
    expect(native.files).toEqual([...verifierTests, 'scripts/__tests__/generate-hermes-crm-inventory.test.mjs'].sort());
    expect(getGate('suite:node-native', plan).args).toEqual(['--test', ...native.files]);
    expect(getGate('suite:app-unit', plan).args[0]).toBe('scripts/run-selected-vitest.mjs');
    for (const id of staticGates) {
      expect(isDeferredGate(id)).toBe(false);
      expect(plan.gateIds).toContain(id);
      expect(getGate(id, plan).evidenceClass).toBe('static');
    }
    expect(getGate('generate-copilot-guide-corpus', plan).args).toEqual([
      'scripts/generate-copilot-guide-corpus.mjs', '--check',
    ]);
  });

  it('routes Zalo inbound and delivery changes to real offline worker tests', () => {
    for (const source of ['worker/lib/inbound.js', 'worker/lib/queue.js', 'worker/index.js']) {
      const plan = planFor(source);
      expect(plan.fullFallback).toBe(false);
      expect(plan.suiteSelections.find(s => s.id === 'app-unit').files).toEqual(expect.arrayContaining([
        'worker/__tests__/inbound-echo.test.js',
        'worker/__tests__/queue-delivery.test.js',
        'worker/__tests__/scope-guard.test.js',
      ]));
      expect(plan.browserRequirements).toEqual([]);
    }
  });

  it('routes inventory drift and generator edits to a check command and native test', () => {
    for (const source of ['scripts/generate-hermes-crm-inventory.mjs', 'tooling/hermes-crm-inventory.generated.json']) {
      const plan = planFor(source);
      expect(plan.gateIds).toContain('generate-hermes-crm-inventory');
      expect(plan.suiteSelections.find(s => s.id === 'node-native').files)
        .toContain('scripts/__tests__/generate-hermes-crm-inventory.test.mjs');
      expect(plan.suiteSelections.find(s => s.id === 'app-unit')?.files ?? [])
        .not.toContain('scripts/__tests__/generate-hermes-crm-inventory.test.mjs');
      expect(getGate('generate-hermes-crm-inventory', plan).args)
        .toEqual(['scripts/generate-hermes-crm-inventory.mjs', '--check']);
      expect(plan.generatorIds).not.toContain('generate-hermes-crm-inventory');
    }
  });

  it.each([
    'src/copilot/safeControls.ts', 'src/copilot/memoryClient.ts',
    'src/pages/rooms/NewSafeControlPage.tsx',
  ])('routes expanded inventory input %s including a newly added marker file', (source) => {
    const plan = planFor(source);
    expect(plan.gateIds).toContain('generate-hermes-crm-inventory');
    expect(plan.suiteSelections.find(s => s.id === 'node-native').files)
      .toContain('scripts/__tests__/generate-hermes-crm-inventory.test.mjs');
  });

  it.each([
    'scripts/compare-hermes-crm-catalog.mjs', 'tooling/hermes-crm/catalog-test.sql',
  ])('routes catalog observation %s to offline verifier tests without querying DB', (source) => {
    const plan = planFor(source);
    expect(plan.suiteSelections.find(s => s.id === 'node-native').files)
      .toContain('scripts/__tests__/compare-hermes-crm-catalog.test.mjs');
    expect(plan.suiteSelections.find(s => s.id === 'app-unit')?.files ?? [])
      .not.toContain('scripts/__tests__/compare-hermes-crm-catalog.test.mjs');
    expect(plan.gateIds).not.toContain('compare-hermes-crm-catalog');
  });

  it.each([
    ['infra/hermes-broker/broker.mjs', 'infra/hermes-broker/broker.test.mjs'],
    ['scripts/test-hermes-broker-authz.mjs', 'scripts/__tests__/test-hermes-broker-authz.test.mjs'],
    ['infra/hermes-runtime/runtime-probe.py', 'infra/hermes-runtime/runtime-contract.test.mjs'],
    ['scripts/test-hermes-runtime-isolation.mjs', 'infra/hermes-runtime/fixture-server.test.mjs'],
  ])('routes P1 %s to offline contracts without executing its live harness', (source, testFile) => {
    const plan = planFor(source);
    expect(plan.suiteSelections.find(s => s.id === 'node-native').files).toContain(testFile);
    expect(plan.suiteSelections.find(s => s.id === 'app-unit')?.files ?? []).not.toContain(testFile);
    const args = getGate('suite:node-native', plan).args;
    expect(args[0]).toBe('--test');
    expect(args).not.toContain('--env');
    expect(args).not.toContain('--run');
    if (source.includes('broker')) expect(plan.profiles).toContain('money-auth');
  });

  it.each([
    'docs/he-thong/manifest.json',
    'docs/he-thong/25-bien-dong-so-du.md',
    'docs/ai-copilot/README.md',
    'docs/huong-dan-su-dung/01-tong-quan/index.md',
  ])('routes corpus documentation %s without starting app or live lanes', (source) => {
    const plan = planFor(source);
    expect(plan.fullFallback).toBe(false);
    expect(plan.profiles).toEqual(['docs-only']);
    expect(plan.gateIds).toEqual(expect.arrayContaining([
      'check-copilot-docs-manifest', 'generate-copilot-guide-corpus', 'check-copilot-tool-inventory',
    ]));
    expect(plan.suiteSelections.find(s => s.id === 'node-native').files).toEqual(expect.arrayContaining([
      'scripts/__tests__/check-copilot-docs-manifest.test.mjs',
      'scripts/__tests__/check-copilot-tool-inventory.test.mjs',
    ]));
    expect(plan.gateIds).not.toContain('app-build');
    expect(plan.gateIds).not.toContain('check-copilot-negative-proofs');
    expect(plan.gateIds).not.toContain('check-copilot-golden-eval');
    expect(plan.browserRequirements).toEqual([]);
  });

  it('a public-to-internal capability change selects corpus checks as well as inventory', () => {
    const plan = createGatePlan({ snapshot, testFiles, testMatrix: matrix, changes: [{
      path: 'src/app/capabilities/registry.ts', status: 'M',
      before: 'export const page = { visibility: "public" };',
      after: 'export const page = { visibility: "internal" };',
    }] });
    expect(plan.fullFallback).toBe(false);
    expect(plan.gateIds).toEqual(expect.arrayContaining([
      'check-copilot-docs-manifest', 'generate-copilot-guide-corpus',
      'check-copilot-tool-inventory', 'generate-hermes-crm-inventory',
    ]));
  });

  it('keeps ordinary documentation outside corpus routing even when it mentions Copilot', () => {
    for (const source of ['docs/README.md', 'docs/plans/hermes-crm/PLAN.md', 'infra/network-center-worker/README.md']) {
      const plan = planFor(source);
      expect(plan.fullFallback).toBe(false);
      expect(plan.gateIds).not.toContain('check-copilot-docs-manifest');
      expect(plan.gateIds).not.toContain('generate-copilot-guide-corpus');
      expect(plan.gateIds).not.toContain('check-copilot-tool-inventory');
      expect(plan.suiteSelections).toEqual([]);
    }
  });

  it('does not activate browser, model or production-evidence lanes', () => {
    for (const file of [
      'src/copilot/__tests__/llmClient.test.ts',
      'src/copilot/__tests__/ChatPanel.test.tsx',
      '.e2e-fleet/specs/copilot-confirmation.spec.ts',
      '.e2e-fleet/specs/chat-zalo.spec.ts',
      '.e2e-fleet/controlled/golden-provider-stop.test.mjs',
      'scripts/__tests__/copilot-room-pass-live-acceptance.test.mjs',
    ]) expect(isDeferredTest(file), file).toBe(true);
    for (const id of ['check-copilot-golden-eval', 'check-copilot-negative-proofs']) {
      expect(isDeferredGate(id)).toBe(true);
      expect(() => getGate(id, {})).toThrow('DEFERRED');
    }
    const plan = planFor('src/copilot/tools/registry.ts');
    expect(plan.suiteSelections.some(s => s.runner === 'playwright')).toBe(false);
    expect(plan.gateIds).not.toContain('check-copilot-negative-proofs');
  });

  it('rejects a mutated unknown domain gate rather than silently dropping it', () => {
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules.find(r => r.id === 'copilot-shared-core').gates.push('missing-foundation-gate');
    expect(() => planFor('src/copilot/tools/registry.ts', mutant)).toThrow('unknown command: missing-foundation-gate');
  });

  it('reports zero-test mapping as unavailable and refuses an empty runner', () => {
    const plan = planFor('src/copilot/tools/registry.ts', matrix, []);
    expect(plan.unavailable).toEqual(expect.arrayContaining([
      { suiteId: 'app-unit', reason: 'Selected mapping has no owned active tests' },
      { suiteId: 'node-native', reason: 'Selected mapping has no owned active tests' },
    ]));
    expect(() => getGate('suite:app-unit', plan)).toThrow('Missing selected tests');
    expect(() => getGate('suite:node-native', plan)).toThrow('Missing selected tests');
  });
});
