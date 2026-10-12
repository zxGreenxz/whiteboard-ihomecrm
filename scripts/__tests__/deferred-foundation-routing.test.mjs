import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assignSuites, globToRegExp, trackedTestFiles } from '../check-test-matrix.mjs';
import { isDeferredGate, isDeferredTest } from '../lib/deferred-modules.mjs';
import { createGatePlan } from '../lib/gate-plan.mjs';
import { getGate } from '../lib/gate-registry.mjs';

const matrix = JSON.parse(readFileSync(new URL('../../tooling/test-matrix.json', import.meta.url), 'utf8'));
const riskMap = JSON.parse(readFileSync(new URL('../../tooling/risk-map.json', import.meta.url), 'utf8'));
// Exercise real files in the restored domains without repeatedly planning
// thousands of unrelated app tests in each routing assertion.
const testFiles = trackedTestFiles([]).filter(file =>
  /^(?:src\/copilot\/|worker\/__tests__\/|infra\/hermes-(?:broker|runtime)\/|scripts\/__tests__\/(?:check-copilot-|generate-hermes-crm-inventory\.|compare-hermes-crm-catalog\.|test-hermes-broker-authz\.|hermes-(?:refresh-auth|durable-schema|durable-store)\.|migration-target\.|measure-org-leak[.-]|apply-reviewed-migration[.-]|backup-luu-tru\.|check-migration-provenance\.|generate-migration-provenance-scope\.|provenance-bien-nhan\.))/.test(file));
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
const p2NativeTests = [
  'scripts/__tests__/hermes-refresh-auth.test.mjs',
  'scripts/__tests__/hermes-durable-schema.test.mjs',
  'scripts/__tests__/hermes-durable-store.test.mjs',
];
const p2Migrations = [
  'supabase/migrations/20261012061447_hermes_assistant_identity_policy_v1.sql',
  'supabase/migrations/20261012062043_hermes_encrypted_session_store_v1.sql',
  'supabase/migrations/20261012074002_hermes_envelope_length_guard_v1.sql',
];
function assertNativeOwner(file, testMatrix = matrix) {
  const assigned = assignSuites([file], testMatrix.suites);
  expect(assigned.orphans).toEqual([]);
  expect(assigned.deferred).toEqual([]);
  expect(assigned.bySuite.get('node-native')).toEqual([file]);
  expect(assigned.bySuite.get('app-unit')).toEqual([]);
}
function assertP2Rule(source, ruleId, expected, testMatrix = matrix) {
  const plan = planFor(source, testMatrix);
  const native = plan.suiteSelections.find(s => s.id === 'node-native');
  const shared = riskMap.scope.sharedPaths.some(pattern => globToRegExp(pattern).test(source));
  expect(plan.fullFallback).toBe(shared);
  // Broad money/schema coverage must not mask a missing dependency rule.
  expect(testMatrix.sourceSelectionRules.filter(rule => rule.sourcePaths?.some(pattern =>
    globToRegExp(pattern).test(source))).map(rule => rule.id)).toContain(ruleId);
  if (shared) expect(native.mode).toBe('all');
  else expect(native.reason.split(', ')).toContain(ruleId);
  expect(native.files).toEqual(expect.arrayContaining(expected));
  const app = plan.suiteSelections.find(s => s.id === 'app-unit')?.files ?? [];
  for (const file of p2NativeTests) expect(app).not.toContain(file);
  expect(getGate('suite:node-native', plan).args).toEqual(['--test', ...native.files]);
  for (const runner of ['scripts/test-hermes-refresh-auth.mjs', 'scripts/test-hermes-durable-store.mjs']) {
    expect(getGate('suite:node-native', plan).args).not.toContain(runner);
  }
  expect(plan.browserRequirements).toEqual([]);
  expect(plan.suiteSelections.some(s => s.runner === 'playwright')).toBe(false);
  expect(plan.gateIds).not.toContain('check-copilot-golden-eval');
}

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
    ['src/lib/roomSaleFacts.ts', 'infra/hermes-broker/room-read-projection.test.mjs'],
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

  it.each([
    'scripts/lib/migration-target.mjs',
    'scripts/apply-reviewed-migration.mjs',
    'scripts/backup-before-schema.mjs',
    'scripts/capture-production-catalog.mjs',
    'scripts/generate-migration-provenance.mjs',
    'scripts/db-query.mjs',
    'scripts/lib/vault.mjs',
    'scripts/test-env/lib.mjs',
    'scripts/test-env/lock.mjs',
  ])('routes migration target dependency %s to offline contracts and the correct runners', (source) => {
    const plan = planFor(source);
    const native = plan.suiteSelections.find(s => s.id === 'node-native').files;
    const app = plan.suiteSelections.find(s => s.id === 'app-unit').files;
    expect(native).toEqual(expect.arrayContaining([
      'scripts/__tests__/migration-target.test.mjs',
      'scripts/__tests__/apply-reviewed-migration-authorization.test.mjs',
      'scripts/__tests__/apply-reviewed-migration-transaction.test.mjs',
      'scripts/__tests__/backup-luu-tru.test.mjs',
    ]));
    expect(app).not.toContain('scripts/__tests__/migration-target.test.mjs');
    expect(app).toEqual(expect.arrayContaining([
      'scripts/__tests__/apply-reviewed-migration-preflight.test.mjs',
      'scripts/__tests__/generate-migration-provenance-scope.test.mjs',
      'scripts/__tests__/provenance-bien-nhan.test.mjs',
    ]));
    const args = getGate('suite:node-native', plan).args;
    expect(args[0]).toBe('--test');
    expect(args).not.toContain('--apply');
    expect(args).not.toContain('--env');
    expect(plan.gateIds).not.toContain('apply-reviewed-migration');
    if (source.includes('migration-') || source.includes('backup-before') || source.includes('capture-production')) {
      expect(plan.crossReview).toBe(true);
    }
  });

  it('assigns the migration-target test only to node:test, never Vitest or deferred coverage', () => {
    const file = 'scripts/__tests__/migration-target.test.mjs';
    expect(testFiles).toContain(file);
    const assigned = assignSuites([file], matrix.suites);
    expect(assigned.orphans).toEqual([]);
    expect(assigned.deferred).toEqual([]);
    expect(assigned.bySuite.get('node-native')).toEqual([file]);
    expect(assigned.bySuite.get('app-unit')).toEqual([]);
  });

  it.each(p2NativeTests)('assigns P2 test %s to its real Node runner only', (file) => {
    expect(testFiles).toContain(file);
    assertNativeOwner(file);
  });

  it.each([
    'scripts/test-hermes-refresh-auth.mjs',
    'scripts/test-hermes-broker-authz.mjs',
    'infra/hermes-broker/supabase-refresh-provider.mjs',
    'infra/hermes-broker/supabase-adapter.mjs',
  ])('selects refresh Auth safety contracts for %s without invoking Auth', (source) => {
    assertP2Rule(source, 'hermes-refresh-auth-native', [p2NativeTests[0],
      'scripts/__tests__/test-hermes-broker-authz.test.mjs',
      'infra/hermes-broker/supabase-refresh-provider.test.mjs',
      'infra/hermes-broker/supabase-adapter.test.mjs']);
  });

  it.each([
    'scripts/db-query.mjs', 'scripts/lib/vault.mjs',
    'scripts/test-env/lib.mjs', 'scripts/test-env/lock.mjs',
  ])('keeps both TEST fixture safety lanes when shared dependency %s changes', (source) => {
    assertP2Rule(source, 'hermes-refresh-auth-native', [p2NativeTests[0]]);
    assertP2Rule(source, 'hermes-durable-store-native', [p2NativeTests[2],
      'scripts/__tests__/test-hermes-broker-authz.test.mjs']);
  });

  it.each([
    ...p2Migrations, 'scripts/network-center-function-bodies.mjs',
    'scripts/apply-reviewed-migration.mjs', 'scripts/lib/migration-target.mjs',
  ])('selects durable SQL static safety contracts for %s without applying migrations', (source) => {
    assertP2Rule(source, 'hermes-durable-schema-native', [p2NativeTests[1]]);
    if (p2Migrations.includes(source)) {
      const plan = planFor(source);
      expect(plan.profiles).toContain('schema');
      expect(plan.crossReview).toBe(true);
      expect(plan.gateIds).toContain('check-no-auto-apply');
    }
  });

  it.each([
    'scripts/test-hermes-durable-store.mjs', ...p2Migrations,
    'scripts/network-center-function-bodies.mjs',
    'scripts/apply-reviewed-migration.mjs', 'scripts/backup-before-schema.mjs',
    'scripts/lib/migration-target.mjs', 'scripts/network-center-rollout-common.mjs',
    'infra/hermes-broker/broker.mjs', 'infra/hermes-broker/stores.mjs',
    'infra/hermes-broker/session-crypto.mjs',
    'infra/hermes-broker/refresh-manager.mjs',
    'infra/hermes-broker/durable-refresh-store.mjs',
    'infra/hermes-broker/durable-connection-store.mjs',
    'infra/hermes-broker/durable-authority.mjs',
    'infra/hermes-broker/supabase-durable-auth-adapter.mjs',
    'infra/hermes-broker/connection-control-plane.mjs',
    'infra/hermes-broker/certs/supabase-ca-2021.crt',
    'infra/hermes-broker/store-transport.mjs',
    'infra/hermes-broker/store-pool.mjs',
  ])('selects durable store offline safety contracts for %s', (source) => {
    assertP2Rule(source, 'hermes-durable-store-native', [p2NativeTests[2],
      'infra/hermes-broker/session-crypto.test.mjs',
      'infra/hermes-broker/refresh-manager.test.mjs',
      'infra/hermes-broker/durable-refresh-store.test.mjs',
      'infra/hermes-broker/store-transport.test.mjs',
      'infra/hermes-broker/store-pool.test.mjs']);
  });

  it('requires authorization and independent review for both live TEST runners', () => {
    for (const path of ['scripts/test-hermes-refresh-auth.mjs', 'scripts/test-hermes-durable-store.mjs']) {
      const assertTier = policy => {
        const plan = createGatePlan({ snapshot, testFiles, testMatrix: matrix, riskMap: policy,
          changes: [{ path, status: 'M', before: 'before', after: 'after' }] });
        expect(plan.profiles).toContain('money-auth');
        expect(plan.crossReview).toBe(true);
      };
      assertTier(riskMap);
      const mutant = structuredClone(riskMap);
      mutant.tiers.authorization.paths = mutant.tiers.authorization.paths.filter(p => p !== path);
      expect(() => assertTier(mutant)).toThrow();
    }
  });

  it('detects missing ownership and accidental Vitest ownership for every P2 Node test', () => {
    for (const file of p2NativeTests) {
      const missing = structuredClone(matrix);
      const native = missing.suites.find(s => s.id === 'node-native');
      native.includes = native.includes.filter(p => p !== file);
      expect(() => assertNativeOwner(file, missing)).toThrow();
      const duplicate = structuredClone(matrix);
      const app = duplicate.suites.find(s => s.id === 'app-unit');
      app.excludes = app.excludes.filter(p => p !== file);
      expect(() => assertNativeOwner(file, duplicate)).toThrow();
    }
  });

  it('detects a lost shared lease dependency even when broad safety rules still select the test', () => {
    const mutant = structuredClone(matrix);
    const rule = mutant.sourceSelectionRules.find(r => r.id === 'hermes-durable-store-native');
    rule.sourcePaths = rule.sourcePaths.filter(p => p !== 'scripts/test-env/lock.mjs');
    expect(() => assertP2Rule('scripts/test-env/lock.mjs', rule.id, [p2NativeTests[2]], mutant)).toThrow();
  });

  it.each([
    'scripts/measure-org-leak.mjs', 'scripts/lib/migration-target.mjs',
    'scripts/apply-reviewed-migration.mjs', 'scripts/db-query.mjs',
    'scripts/lib/vault.mjs', 'scripts/test-env/lib.mjs', 'scripts/test-env/lock.mjs',
  ])('routes org-leak target/guard dependency %s without executing its live measurement', (source) => {
    const nativeTest = 'scripts/__tests__/measure-org-leak-target.test.mjs';
    expect(testFiles).toContain(nativeTest);
    assertNativeOwner(nativeTest);
    assertP2Rule(source, 'org-leak-target-native', [nativeTest]);
    const plan = planFor(source);
    expect(plan.suiteSelections.find(s => s.id === 'app-unit').files)
      .toContain('scripts/__tests__/measure-org-leak.test.mjs');
    expect(getGate('suite:node-native', plan).args).not.toContain('scripts/measure-org-leak.mjs');
    expect(getGate('measure-org-leak', plan).evidenceClass).toBe('live');
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
