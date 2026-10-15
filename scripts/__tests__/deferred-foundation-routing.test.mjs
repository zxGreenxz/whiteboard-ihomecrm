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
  file === 'scripts/test-hermes-product-runtime.test.mjs' ||
  file === 'scripts/__tests__/hermes-private-flow.test.mjs' ||
  file === 'scripts/__tests__/hermes-cde-live.test.mjs' ||
  file === 'src/hermes/connectionClient.test.ts' ||
  file === 'src/hermes/zaloBindingClient.test.ts' ||
  file === 'src/hermes/orgPolicyClient.test.ts' ||
  file === 'src/hermes/HermesOrgPolicySettings.test.tsx' ||
  file === 'src/pages/settings/HermesConnectionsPage.test.tsx' ||
  /^infra\/hermes-zalo-router\//.test(file) ||
  /^infra\/hermes-zalo-native\//.test(file) ||
  /^worker\/deploy\//.test(file) ||
  /^(?:src\/copilot\/|worker\/__tests__\/|infra\/hermes-(?:broker|runtime)\/|scripts\/__tests__\/(?:check-copilot-|generate-hermes-crm-inventory\.|compare-hermes-crm-catalog\.|test-hermes-broker-authz\.|hermes-(?:refresh-auth|durable-schema|durable-store|connection-renewal-schema|room-scope-schema|public-conflict-schema)\.|migration-target\.|measure-org-leak[.-]|apply-reviewed-migration[.-]|backup-luu-tru\.|check-migration-provenance\.|generate-migration-provenance-scope\.|provenance-bien-nhan\.))/.test(file));
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
  'scripts/__tests__/hermes-connection-renewal-schema.test.mjs',
  'scripts/__tests__/hermes-room-scope-schema.test.mjs',
  'scripts/__tests__/hermes-public-conflict-schema.test.mjs',
];
const p2Migrations = [
  'supabase/migrations/20261012061447_hermes_assistant_identity_policy_v1.sql',
  'supabase/migrations/20261012062043_hermes_encrypted_session_store_v1.sql',
  'supabase/migrations/20261012074002_hermes_envelope_length_guard_v1.sql',
  'supabase/migrations/20261012083555_hermes_connection_renewal_v1.sql',
  'supabase/migrations/20261012083047_hermes_room_scope_read_v1.sql',
  'supabase/migrations/20261012165809_hermes_public_conflict_http_v1.sql',
];
function assertNativeOwner(file, testMatrix = matrix) {
  const assigned = assignSuites([file], testMatrix.suites);
  expect(assigned.orphans).toEqual([]);
  expect(assigned.deferred).toEqual([]);
  expect(assigned.bySuite.get('node-native')).toEqual([file]);
  expect(assigned.bySuite.get('app-unit')).toEqual([]);
}
function assertP2Rule(source, ruleId, expected, testMatrix = matrix, files = testFiles) {
  const plan = planFor(source, testMatrix, files);
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
  return plan;
}

describe('P0 shared CRM foundation routing', () => {
  it('requires the Linux upstream workflow when native transport or its CI runner changes', () => {
    const required = { workflow: '.github/workflows/hermes-runtime.yml', jobs: ['native-upstream'], suiteIds: ['node-native'] };
    for (const source of ['infra/hermes-zalo-native/adapter.py', 'infra/hermes-zalo-native/upstream.test.mjs',
      'worker/lib/hermes-native-bridge.js', 'worker/deploy/zalo-worker.sh',
      'worker/deploy/native-preflight.mjs', 'worker/Dockerfile', 'worker/.dockerignore',
      'scripts/test-hermes-native-ci.mjs', '.github/workflows/hermes-runtime.yml']) {
      const plan = planFor(source);
      expect(plan.crossReview).toBe(true);
      expect(plan.requiredExternalWorkflows).toContainEqual(required);
    }
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== 'hermes-native-zalo-linux-upstream');
    expect(planFor('infra/hermes-zalo-native/adapter.py', mutant).requiredExternalWorkflows).not.toContainEqual(required);
    expect(planFor('worker/deploy/zalo-worker.sh', mutant).requiredExternalWorkflows).not.toContainEqual(required);
    assertNativeOwner('worker/deploy/native-deployment.test.mjs');
  });

  it('routes native deployment and its validator dependencies to preflight behavior checks', () => {
    const file = 'worker/deploy/native-deployment.test.mjs';
    for (const source of ['worker/deploy/zalo-worker.sh', 'worker/deploy/native-preflight.mjs',
      'worker/Dockerfile', 'worker/.dockerignore', 'worker/lib/hermes-native-config.js',
      'worker/lib/hermes-native-files.js', 'infra/hermes-zalo-native/operator.mjs',
      'scripts/test-hermes-native-ci.mjs']) {
      assertP2Rule(source, 'hermes-native-deployment', [file]);
    }
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== 'hermes-native-deployment');
    expect(() => assertP2Rule('worker/deploy/zalo-worker.sh', 'hermes-native-deployment', [file], mutant)).toThrow();
  });

  it('routes native Zalo plugin and worker sources to transport and real inbound caller tests', () => {
    const native = ['infra/hermes-zalo-native/bridge.test.mjs', 'infra/hermes-zalo-native/journal.test.mjs',
      'infra/hermes-zalo-native/upstream.test.mjs'];
    for (const file of native) { expect(testFiles).toContain(file); assertNativeOwner(file); }
    const caller = 'worker/__tests__/hermes-native-inbound.test.js';
    const files = testFiles.filter(file => [...native, ...p2NativeTests, caller].includes(file));
    for (const source of ['infra/hermes-zalo-native/adapter.py', 'worker/lib/hermes-native-bridge.js',
      'worker/lib/hermes-native-config.js', 'worker/lib/hermes-native-files.js', 'worker/lib/hermes-native-journal.js',
      'worker/lib/hermes-link.js', 'worker/lib/inbound.js', 'worker/lib/session-lifecycle.js', 'worker/index.js']) {
      const plan = assertP2Rule(source, 'hermes-native-zalo-transport', native, matrix, files);
      expect(plan.crossReview).toBe(true);
      const app = plan.suiteSelections.find(s => s.id === 'app-unit');
      expect(app.reason.split(', ')).toContain('hermes-native-zalo-caller');
      expect(app.files).toContain(caller);
      native.forEach(file => expect(app.files).not.toContain(file));
    }
    const broken = structuredClone(matrix);
    broken.sourceSelectionRules = broken.sourceSelectionRules.filter(rule => rule.id !== 'hermes-native-zalo-transport');
    expect(() => assertP2Rule('infra/hermes-zalo-native/adapter.py', 'hermes-native-zalo-transport', native, broken, files)).toThrow();
  });

  it('routes standalone connector and external/neutral-policy SQL to actual composition tests', () => {
    const cases = [
      ['infra/hermes-runtime/hermes-connector.service', 'hermes-independent-connector',
        ['infra/hermes-broker/connector-maintenance.test.mjs', 'infra/hermes-runtime/host-service.test.mjs', 'infra/hermes-broker/server.test.mjs']],
      ['supabase/migrations/20261014000538_hermes_external_group_connector_v1.sql', 'hermes-external-groups',
        ['infra/hermes-broker/external-group-composition.test.mjs', 'infra/hermes-broker/mcp-http.test.mjs']],
      ['supabase/migrations/20261014000503_hermes_optional_org_policy_v1.sql', 'hermes-optional-policy-native',
        ['infra/hermes-broker/optional-org-policy-sql.test.mjs', 'infra/hermes-broker/external-group-composition.test.mjs']],
    ];
    for (const [source, rule, expected] of cases) {
      for (const file of expected) { expect(testFiles).toContain(file); assertNativeOwner(file); }
      assertP2Rule(source, rule, expected);
      const broken = structuredClone(matrix);
      broken.sourceSelectionRules = broken.sourceSelectionRules.filter(item => item.id !== rule);
      expect(() => assertP2Rule(source, rule, expected, broken)).toThrow();
    }
  });

  it('routes deployed Hermes proxy entries through native HTTP contracts and browser clients with authorization review', () => {
    const proxyTest = 'infra/hermes-broker/frontend-proxy.test.mjs';
    expect(testFiles).toContain(proxyTest);
    assertNativeOwner(proxyTest);
    const assertProxyRule = (source, candidate = matrix) => {
      const plan = planFor(source, candidate);
      expect(plan.fullFallback).toBe(false);
      expect(plan.crossReview).toBe(true);
      expect(plan.profiles).toContain('money-auth');
      const native = plan.suiteSelections.find(s => s.id === 'node-native');
      expect(native.reason.split(', ')).toContain('hermes-frontend-proxy');
      expect(native.files).toEqual(expect.arrayContaining([proxyTest,
        'infra/hermes-broker/connection-http.test.mjs', 'infra/hermes-zalo-router/binding-http.test.mjs']));
      expect(getGate('suite:node-native', plan).args).toContain(proxyTest);
      const app = plan.suiteSelections.find(s => s.id === 'app-unit');
      expect(app.files).toEqual(expect.arrayContaining(['src/hermes/connectionClient.test.ts', 'src/hermes/zaloBindingClient.test.ts']));
      expect(app.files).not.toContain(proxyTest);
    };
    for (const source of ['api/hermes/connections/[operation].js', 'api/hermes/zalo/[operation].js',
      'infra/hermes-broker/frontend-proxy.mjs']) assertProxyRule(source);
    const withoutRule = structuredClone(matrix);
    withoutRule.sourceSelectionRules = withoutRule.sourceSelectionRules.filter(rule => rule.id !== 'hermes-frontend-proxy');
    expect(() => assertProxyRule('api/hermes/connections/[operation].js', withoutRule)).toThrow();
  });

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

  it('keeps Zalo binding policy tests on node and worker integration on Vitest', () => {
    const bindingTest = 'infra/hermes-zalo-router/binding-service.test.mjs';
    const privateTests = ['infra/hermes-zalo-router/privacy-schema.test.mjs', 'infra/hermes-zalo-router/privacy-sql.test.mjs',
      'infra/hermes-zalo-router/private-command-sql.test.mjs', 'infra/hermes-zalo-router/private-dispatch-sql.test.mjs', 'infra/hermes-zalo-router/private-reply-sql.test.mjs'];
    for (const file of [bindingTest, ...privateTests]) assertNativeOwner(file);
    const callerTests = ['worker/__tests__/hermes-link.test.js', 'worker/__tests__/hermes-command.test.js',
      'worker/__tests__/hermes-inbound.test.js', 'worker/__tests__/hermes-reply.test.js'];
    const files = testFiles.filter(file => [bindingTest, ...privateTests, ...callerTests].includes(file));
    for (const source of ['infra/hermes-zalo-router/binding-service.mjs', 'worker/lib/hermes-link.js', 'worker/lib/hermes-command.js',
      'worker/lib/inbound.js', 'worker/lib/login.js', 'worker/lib/session-lifecycle.js', 'worker/lib/hermes-reply.js', 'worker/lib/watchdog.js',
      'supabase/migrations/20261012165523_hermes_zalo_binding_v1.sql', 'supabase/migrations/20261013055055_hermes_zalo_private_command_v1.sql',
      'supabase/migrations/20261013084000_hermes_private_command_dispatch_v1.sql', 'supabase/migrations/20261013095000_hermes_zalo_private_reply_v1.sql', 'infra/hermes-zalo-router/private-command-fixture.mjs']) {
      const plan = planFor(source, matrix, files);
      expect(matrix.sourceSelectionRules.filter(rule => rule.sourcePaths?.some(pattern => globToRegExp(pattern).test(source))).map(rule => rule.id))
        .toContain('hermes-zalo-binding-native');
      expect(plan.suiteSelections.find(s => s.id === 'node-native').files).toEqual(expect.arrayContaining([bindingTest, ...privateTests]));
      expect(plan.suiteSelections.find(s => s.id === 'app-unit')?.files ?? []).not.toContain(bindingTest);
      if (source.startsWith('worker/')) expect(plan.suiteSelections.find(s => s.id === 'app-unit').files)
        .toEqual(expect.arrayContaining(callerTests));
      if (!source.startsWith('supabase/')) expect(riskMap.tiers.authorization.paths.some(pattern => globToRegExp(pattern).test(source))).toBe(true);
    }
  });

  it('requires private command authorization review even when its own tests are selected', () => {
    const source = 'worker/lib/hermes-command.js';
    const plan = planFor(source);
    expect(plan.profiles).toContain('money-auth');
    expect(plan.crossReview).toBe(true);
    expect(plan.suiteSelections.find(s => s.id === 'app-unit').files)
      .toContain('worker/__tests__/hermes-command.test.js');
    const policy = structuredClone(riskMap);
    policy.tiers.authorization.paths = policy.tiers.authorization.paths.filter(path => path !== source);
    const withoutAuthorization = createGatePlan({ snapshot, testFiles, testMatrix: matrix, riskMap: policy,
      changes: [{ path: source, status: 'M', before: 'before', after: 'after' }] });
    expect(withoutAuthorization.profiles).not.toContain('money-auth');
    expect(withoutAuthorization.crossReview).toBe(false);
    const mutant = structuredClone(matrix);
    const rule = mutant.sourceSelectionRules.find(rule => rule.id === 'hermes-zalo-binding-native');
    rule.sourcePaths = rule.sourcePaths.filter(path => path !== source);
    expect(planFor(source, mutant).suiteSelections.find(s => s.id === 'node-native')?.files ?? [])
      .not.toContain('infra/hermes-zalo-router/privacy-sql.test.mjs');
  });

  it('routes the product process and private reply through authorization review and their actual runners', () => {
    for (const [source, suite, file] of [
      ['infra/hermes-runtime/agent-process.py', 'node-native', 'infra/hermes-runtime/agent-process.test.mjs'],
      ['worker/lib/hermes-reply.js', 'app-unit', 'worker/__tests__/hermes-reply.test.js'],
      ['supabase/migrations/20261013095000_hermes_zalo_private_reply_v1.sql', 'node-native', 'infra/hermes-zalo-router/private-reply-sql.test.mjs'],
    ]) {
      const plan = planFor(source);
      expect(plan.crossReview).toBe(true);
      expect(plan.suiteSelections.find(selection => selection.id === suite).files).toContain(file);
    }
  });

  it('product gateway and container changes require authorization review plus backend/runtime composition tests', () => {
    const required = ['infra/hermes-broker/server.test.mjs', 'infra/hermes-broker/runtime-model-service.test.mjs',
      'infra/hermes-broker/dependency-drain.test.mjs', 'infra/hermes-runtime/runtime-gateway.test.mjs',
      'infra/hermes-runtime/gateway-relay.test.mjs', 'infra/hermes-runtime/gateway-transport.test.mjs',
      'infra/hermes-runtime/container-driver.test.mjs', 'infra/hermes-runtime/runtime-orchestrator.test.mjs',
      'infra/hermes-runtime/profile-homes.test.mjs', 'infra/hermes-runtime/connection-supervisor.test.mjs',
      'infra/hermes-broker/private-command-runner.test.mjs'];
    const files = [...new Set([...testFiles, ...required])];
    for (const source of ['runtime-gateway', 'gateway-relay', 'gateway-transport', 'container-driver', 'container-contract',
      'runtime-orchestrator', 'profile-homes', 'connection-supervisor']) {
      const path = `infra/hermes-runtime/${source}.mjs`, plan = planFor(path, matrix, files);
      expect(plan.crossReview).toBe(true); expect(plan.profiles).toContain('money-auth');
      expect(plan.suiteSelections.find(selection => selection.id === 'node-native').files).toEqual(expect.arrayContaining(required));
      expect(riskMap.tiers.authorization.paths).toContain(path);
    }
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== 'hermes-private-runtime-composition');
    expect(planFor('infra/hermes-runtime/runtime-gateway.mjs', mutant, files).suiteSelections.find(selection => selection.id === 'node-native').files)
      .not.toContain('infra/hermes-broker/runtime-model-service.test.mjs');
    expect(planFor('infra/hermes-broker/private-command-runner.mjs', matrix, files).suiteSelections.find(selection => selection.id === 'node-native').files)
      .toEqual(expect.arrayContaining(required));
  });

  it('maintenance and refresh changes include backend/runtime integration and authorization review', () => {
    const required = ['infra/hermes-broker/connection-maintenance.test.mjs', 'infra/hermes-broker/connection-renewal.test.mjs',
      'infra/hermes-broker/server.test.mjs', 'infra/hermes-broker/refresh-manager.test.mjs',
      'infra/hermes-runtime/connection-supervisor.test.mjs', 'infra/hermes-runtime/runtime-orchestrator.test.mjs'];
    const files = [...new Set([...testFiles, ...required])];
    for (const source of ['connection-maintenance', 'connection-renewal', 'refresh-manager', 'supabase-refresh-provider', 'durable-refresh-store']) {
      const path = 'infra/hermes-broker/' + source + '.mjs', plan = planFor(path, matrix, files);
      expect(plan.crossReview).toBe(true); expect(plan.profiles).toContain('money-auth');
      expect(plan.suiteSelections.find(selection => selection.id === 'node-native').files).toEqual(expect.arrayContaining(required));
    }
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== 'hermes-private-runtime-composition');
    expect(planFor('infra/hermes-broker/connection-maintenance.mjs', mutant, files).suiteSelections.find(selection => selection.id === 'node-native')?.files ?? [])
      .not.toContain('infra/hermes-runtime/connection-supervisor.test.mjs');
  });

  it('durable handoff and reconciliation select owner, crypto and backend integration with authorization review', () => {
    const required = ['infra/hermes-broker/connection-handoff.test.mjs', 'infra/hermes-broker/connection-control-plane.test.mjs',
      'infra/hermes-broker/server.test.mjs', 'infra/hermes-runtime/handoff-reconciler.test.mjs', 'infra/hermes-runtime/runtime-orchestrator.test.mjs'];
    const files = [...new Set([...testFiles, ...required])];
    for (const path of ['infra/hermes-broker/connection-handoff.mjs', 'infra/hermes-broker/connection-control-plane.mjs',
      'infra/hermes-runtime/handoff-reconciler.mjs']) {
      const plan = planFor(path,matrix,files);
      expect(plan.crossReview).toBe(true); expect(plan.profiles).toContain('money-auth');
      expect(plan.suiteSelections.find(selection=>selection.id==='node-native').files).toEqual(expect.arrayContaining(required));
    }
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule=>rule.id!=='hermes-private-runtime-composition');
    expect(planFor('infra/hermes-runtime/handoff-reconciler.mjs',mutant,files).suiteSelections.find(selection=>selection.id==='node-native')?.files ?? [])
      .not.toContain('infra/hermes-broker/server.test.mjs');
  });

  it('host service/config/ownership and executable deployment require authorization and composed runtime checks', () => {
    const required = ['infra/hermes-runtime/host-service.test.mjs', 'infra/hermes-runtime/host-config.test.mjs',
      'infra/hermes-runtime/host-ownership.test.mjs', 'infra/hermes-runtime/host-cli.test.mjs', 'infra/hermes-broker/server.test.mjs'];
    const files = [...new Set([...testFiles, ...required])];
    for (const name of ['host-service.mjs', 'host-config.mjs', 'host-ownership.mjs', 'host-cli.mjs', 'host-config.example.json', 'hermes-host.service']) {
      const plan = planFor(`infra/hermes-runtime/${name}`, matrix, files);
      expect(plan.crossReview).toBe(true); expect(plan.profiles).toContain('money-auth');
      expect(plan.suiteSelections.find(selection => selection.id === 'node-native').files).toEqual(expect.arrayContaining(required));
    }
  });

  it('product runtime harness owns its native test and selects it with the real Node runner', () => {
    const source = 'scripts/test-hermes-product-runtime.mjs', file = 'scripts/test-hermes-product-runtime.test.mjs';
    expect(testFiles).toContain(file); assertNativeOwner(file);
    for (const changed of [source, 'infra/hermes-runtime/container-driver.mjs', 'infra/hermes-runtime/gateway-transport.mjs', 'infra/hermes-broker/server.mjs']) {
      const plan = planFor(changed), native = plan.suiteSelections.find(selection => selection.id === 'node-native');
      expect(native.files).toContain(file);
      expect(getGate('suite:node-native', plan).args).toEqual(['--test', ...native.files]);
      expect(getGate('suite:node-native', plan).args).not.toContain(source);
    }
    const onlyTest = planFor(file), gate = getGate('suite:node-native', onlyTest);
    expect(gate.args).toEqual(['--test', file]);
    const assertRuntimeRule = candidate => {
      const rule = candidate.sourceSelectionRules.find(item => item.id === 'hermes-private-runtime-composition');
      expect(rule.suiteId).toBe('node-native');
      expect(rule.sourcePaths.some(pattern => globToRegExp(pattern).test(source))).toBe(true);
      expect(rule.testPatterns.some(pattern => globToRegExp(pattern).test(file))).toBe(true);
    };
    assertRuntimeRule(matrix);
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules.find(rule => rule.id === 'hermes-private-runtime-composition').testPatterns =
      mutant.sourceSelectionRules.find(rule => rule.id === 'hermes-private-runtime-composition').testPatterns.filter(pattern => pattern !== file);
    expect(() => assertRuntimeRule(mutant)).toThrow();
    // Room-pass composition independently needs this same test. Losing one
    // required rule must be detected even while the other still selects it.
    expect(planFor(source, mutant).suiteSelections.find(selection => selection.id === 'node-native').files).toContain(file);
    const unowned = structuredClone(matrix);
    for (const rule of unowned.sourceSelectionRules.filter(rule => rule.sourcePaths?.some(pattern => globToRegExp(pattern).test(source)))) {
      rule.testPatterns = rule.testPatterns.filter(pattern => !globToRegExp(pattern).test(file));
    }
    expect(planFor(source, unowned).suiteSelections.find(selection => selection.id === 'node-native')?.files ?? []).not.toContain(file);
  });

  it('private TEST runner selects offline helper tests with review and never schedules its live command', () => {
    const runner = 'scripts/test-hermes-private-flow.mjs', testFile = 'scripts/__tests__/hermes-private-flow.test.mjs';
    const cdeTest = 'scripts/__tests__/hermes-cde-live.test.mjs';
    expect(testFiles).toContain(testFile); assertNativeOwner(testFile);
    expect(testFiles).toContain(cdeTest); assertNativeOwner(cdeTest);
    const assertRule = (source, testMatrix = matrix) => {
      expect(testMatrix.sourceSelectionRules.filter(rule => rule.sourcePaths?.some(pattern =>
        globToRegExp(pattern).test(source))).map(rule => rule.id)).toContain('hermes-private-flow-native');
      const plan = planFor(source, testMatrix);
      const selected = plan.suiteSelections.find(item => item.id === 'node-native');
      expect(selected.files).toContain(testFile);
      expect(selected.files).toContain(cdeTest);
      expect(selected.files).not.toContain(runner);
      expect(getGate('suite:node-native', plan).args).toEqual(['--test', ...selected.files]);
      expect(plan.suiteSelections.find(item => item.id === 'app-unit')?.files ?? []).not.toContain(testFile);
      expect(plan.suiteSelections.find(item => item.id === 'app-unit')?.files ?? []).not.toContain(cdeTest);
      expect(getGate('suite:node-native', plan).args).not.toContain('--run');
      return plan;
    };
    for (const source of [runner, 'scripts/test-hermes-cde-live.mjs', 'scripts/test-env/lock.mjs', 'scripts/test-hermes-durable-store.mjs',
      'scripts/network-center-rollout-common.mjs',
      'infra/hermes-broker/durable-connection-store.mjs', 'supabase/migrations/20261013095000_hermes_zalo_private_reply_v1.sql',
      'supabase/migrations/20261013115741_hermes_org_policy_options_v1.sql']) assertRule(source);
    const plan = assertRule(runner);
    expect(plan.crossReview).toBe(true); expect(plan.profiles).toContain('money-auth');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['test:hermes-private-flow']).toBe('node scripts/test-hermes-private-flow.mjs');
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== 'hermes-private-flow-native');
    expect(() => assertRule(runner, mutant)).toThrow();
  });

  it('room-pass actions and v4 metadata select actual caller, SQL and UI contracts', () => {
    const nativeFiles = ['room-pass-core', 'room-pass-composition', 'room-pass-metadata'].map(name => `infra/hermes-broker/${name}.test.mjs`);
    nativeFiles.forEach(file => { expect(testFiles).toContain(file); assertNativeOwner(file); });
    const assertMapped = (source, candidate = matrix) => {
      const plan = planFor(source, candidate);
      expect(plan.crossReview).toBe(true);
      const selected = plan.suiteSelections.find(item => item.id === 'node-native');
      expect(selected.reason.split(', ')).toContain('hermes-room-pass-actions');
      expect(selected.files).toEqual(expect.arrayContaining(nativeFiles));
      expect(getGate('suite:node-native', plan).args).toEqual(['--test', ...selected.files]);
      return plan;
    };
    assertMapped('infra/hermes-broker/room-pass-adapter.mjs');
    const migration = 'supabase/migrations/20261014090957_hermes_assistant_capabilities_v4.sql';
    const plan = assertMapped(migration);
    expect(plan.profiles).toContain('schema');
    const app = plan.suiteSelections.find(item => item.id === 'app-unit');
    expect(app.reason.split(', ')).toContain('hermes-assistant-capabilities-ui');
    expect(app.files).toEqual(expect.arrayContaining(['src/hermes/connectionClient.test.ts', 'src/hermes/orgPolicyClient.test.ts', 'src/pages/settings/HermesConnectionsPage.test.tsx']));
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== 'hermes-room-pass-actions');
    expect(() => assertMapped(migration, mutant)).toThrow();
  });

  it('connection options SQL and API select their actual native contracts and browser client contracts', () => {
    const migration = 'supabase/migrations/20261013183000_hermes_connection_options_v1.sql';
    const nativeFiles = ['connection-options', 'connection-options-sql', 'connection-control-plane',
      'connection-management', 'connection-http', 'server'].map(name => `infra/hermes-broker/${name}.test.mjs`);
    const appFiles = ['src/hermes/connectionClient.test.ts', 'src/pages/settings/HermesConnectionsPage.test.tsx'];
    nativeFiles.forEach(file => { expect(testFiles).toContain(file); assertNativeOwner(file); });
    for (const path of [migration, 'infra/hermes-broker/connection-options.mjs',
      'infra/hermes-broker/connection-control-plane.mjs', 'infra/hermes-broker/connection-management.mjs',
      'infra/hermes-broker/connection-http.mjs']) {
      const plan = planFor(path), native = plan.suiteSelections.find(selection => selection.id === 'node-native');
      expect(plan.fullFallback).toBe(false); expect(plan.crossReview).toBe(true);
      expect(native.files).toEqual(expect.arrayContaining(nativeFiles));
      expect(getGate('suite:node-native', plan).args).toEqual(['--test', ...native.files]);
      expect(plan.suiteSelections.find(selection => selection.id === 'app-unit').files).toEqual(expect.arrayContaining(appFiles));
      expect(getGate('suite:node-native', plan).args).not.toContain(migration);
    }
    expect(planFor(migration).profiles).toContain('schema');
    expect(planFor(migration).gateIds).toContain('check-no-auto-apply');
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== 'hermes-connection-options-native');
    expect(planFor(migration, mutant).suiteSelections.find(selection => selection.id === 'node-native')?.files ?? [])
      .not.toContain('infra/hermes-broker/connection-options-sql.test.mjs');
  });

  it('additive Hermes action options select native authorization and current browser clients', () => {
    const source = 'supabase/migrations/20261013164116_hermes_group_capability_options_v2.sql';
    const expectedNative = 'infra/hermes-broker/group-options-sql.test.mjs';
    const expectedApp = ['src/hermes/orgPolicyClient.test.ts', 'src/pages/settings/HermesConnectionsPage.test.tsx'];
    expect(testFiles).toContain(expectedNative); assertNativeOwner(expectedNative);
    const assertMapped = (candidate = matrix) => {
      const plan = planFor(source, candidate);
      expect(plan.crossReview).toBe(true); expect(plan.profiles).toContain('schema');
      const native = plan.suiteSelections.find(item => item.id === 'node-native');
      expect(native.reason.split(', ')).toContain('hermes-group-capability-v2-native');
      expect(native.files).toContain(expectedNative);
      const app = plan.suiteSelections.find(item => item.id === 'app-unit');
      expect(app.reason.split(', ')).toContain('hermes-group-capability-v2-ui');
      expect(app.files).toEqual(expect.arrayContaining(expectedApp));
      expect(native.files).not.toEqual(expect.arrayContaining(expectedApp));
    };
    assertMapped();
    for (const missing of ['hermes-group-capability-v2-native', 'hermes-group-capability-v2-ui']) {
      const mutant = structuredClone(matrix);
      mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== missing);
      expect(() => assertMapped(mutant)).toThrow();
    }
  });

  it('Hermes direct queue SQL selects the actual SQL authority and provider worker behavior', () => {
    const source = 'supabase/migrations/20261013170125_hermes_group_authorized_queue_v1.sql';
    const actualSql = 'infra/hermes-zalo-router/group-send-sql.test.mjs';
    expect(testFiles).toContain(actualSql); assertNativeOwner(actualSql);
    const assertMapped = (candidate = matrix) => {
      const plan = planFor(source, candidate);
      expect(plan.crossReview).toBe(true); expect(plan.profiles).toContain('schema');
      const native = plan.suiteSelections.find(item => item.id === 'node-native');
      expect(native.reason.split(', ')).toContain('hermes-group-authorized-queue-native');
      expect(native.files).toContain(actualSql);
      const app = plan.suiteSelections.find(item => item.id === 'app-unit');
      expect(app.reason.split(', ')).toContain('hermes-group-authorized-queue-worker');
      expect(app.files).toContain('worker/__tests__/queue-delivery.test.js');
      expect(app.files).not.toContain(actualSql);
    };
    assertMapped();
    for (const missing of ['hermes-group-authorized-queue-native', 'hermes-group-authorized-queue-worker']) {
      const mutant = structuredClone(matrix);
      mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== missing);
      expect(() => assertMapped(mutant)).toThrow();
    }
  });

  it('organization policy selects its SQL ACL and mounted UI behavior under authorization review', () => {
    const migration = 'supabase/migrations/20261013115741_hermes_org_policy_options_v1.sql';
    const nativeFiles = ['infra/hermes-broker/org-policy-sql.test.mjs', 'scripts/__tests__/hermes-durable-schema.test.mjs'];
    const appFiles = ['src/hermes/orgPolicyClient.test.ts', 'src/hermes/HermesOrgPolicySettings.test.tsx',
      'src/pages/settings/HermesConnectionsPage.test.tsx'];
    nativeFiles.forEach(file => { expect(testFiles).toContain(file); assertNativeOwner(file); });
    const assertSelection = (source, plan, suite, rule, expected) => {
      expect(plan.crossReview).toBe(true);
      expect(plan.profiles).toContain(source.endsWith('.sql') ? 'schema' : 'money-auth');
      const selection = plan.suiteSelections.find(item => item.id === suite);
      expect(selection.reason.split(', ')).toContain(rule);
      expect(selection.files).toEqual(expect.arrayContaining(expected));
    };
    // Inspect both suites from one plan per unchanged input. Mutated matrices
    // below still receive their own plans so a removed rule cannot be cached away.
    const nativePlans = new Map();
    for (const source of [migration, 'supabase/migrations/20261012061447_hermes_assistant_identity_policy_v1.sql',
      'supabase/migrations/20261012165809_hermes_public_conflict_http_v1.sql']) {
      const plan = planFor(source);
      nativePlans.set(source, plan);
      assertSelection(source, plan, 'node-native', 'hermes-org-policy-native', nativeFiles);
    }
    for (const source of [migration, 'src/hermes/orgPolicyClient.ts', 'src/hermes/HermesOrgPolicySettings.tsx',
      'src/hermes/useHermesConnections.ts', 'src/pages/settings/HermesConnectionsPage.tsx',
      'src/components/authorization/PermissionPicker.tsx', 'src/components/authorization/ScopePicker.tsx']) {
      const plan = nativePlans.get(source) ?? planFor(source);
      assertSelection(source, plan, 'app-unit', 'hermes-org-policy-ui', appFiles);
      const selectedNative = plan.suiteSelections.find(item => item.id === 'node-native')?.files ?? [];
      appFiles.forEach(file => expect(selectedNative).not.toContain(file));
    }
    expect(nativePlans.get(migration).profiles).toContain('schema');
    for (const [suite, rule, expected] of [['node-native', 'hermes-org-policy-native', nativeFiles], ['app-unit', 'hermes-org-policy-ui', appFiles]]) {
      const mutant = structuredClone(matrix);
      mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(item => item.id !== rule);
      const plan = planFor(migration, mutant);
      expect(() => assertSelection(migration, plan, suite, rule, expected)).toThrow();
    }
  });

  it('Hermes permission fields and shared pickers select role-aware page/client tests with authorization review', () => {
    const expected = ['src/hermes/connectionClient.test.ts', 'src/pages/settings/HermesConnectionsPage.test.tsx'];
    const assertUiRule = (path, testMatrix = matrix) => {
      const selection = planFor(path, testMatrix).suiteSelections.find(item => item.id === 'app-unit');
      expect(selection.reason.split(', ')).toContain('hermes-connection-permissions-ui');
      expect(selection.files).toEqual(expect.arrayContaining(expected));
    };
    for (const path of ['src/hermes/connectionClient.ts', 'src/hermes/useHermesConnections.ts',
      'src/hermes/HermesPermissionFields.tsx', 'src/pages/settings/HermesConnectionsPage.tsx',
      'src/components/authorization/PermissionPicker.tsx', 'src/components/authorization/ScopePicker.tsx']) {
      const plan = planFor(path);
      expect(plan.fullFallback).toBe(false); expect(plan.crossReview).toBe(true);
      expect(plan.profiles).toContain('money-auth');
      assertUiRule(path);
      expect(plan.suiteSelections.find(selection => selection.id === 'node-native')?.files ?? [])
        .not.toEqual(expect.arrayContaining(expected));
    }
    const mutant = structuredClone(matrix);
    mutant.sourceSelectionRules = mutant.sourceSelectionRules.filter(rule => rule.id !== 'hermes-connection-permissions-ui');
    // The broad money-auth rule is a safety net; it must not hide a missing
    // explicit UI dependency mapping in this contract.
    expect(() => assertUiRule('src/hermes/HermesPermissionFields.tsx', mutant)).toThrow();
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
    ['infra/hermes-runtime/connection-supervisor.mjs', 'infra/hermes-runtime/connection-supervisor.test.mjs'],
    ['scripts/test-hermes-runtime-isolation.mjs', 'infra/hermes-runtime/fixture-server.test.mjs'],
  ])('routes P1 %s to offline contracts without executing its live harness', (source, testFile) => {
    const plan = planFor(source);
    expect(plan.suiteSelections.find(s => s.id === 'node-native').files).toContain(testFile);
    expect(plan.suiteSelections.find(s => s.id === 'app-unit')?.files ?? []).not.toContain(testFile);
    const args = getGate('suite:node-native', plan).args;
    expect(args[0]).toBe('--test');
    expect(args).not.toContain('--env');
    expect(args).not.toContain('--run');
    if (source.includes('broker') || source.includes('connection-supervisor')) expect(plan.profiles).toContain('money-auth');
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
    assertP2Rule(source, 'hermes-durable-schema-native', [p2NativeTests[1], ...p2NativeTests.slice(3)]);
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
    'infra/hermes-broker/room-read-service.mjs',
    'infra/hermes-broker/room-read-projection.mjs',
    'src/lib/roomSaleFacts.ts',
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
