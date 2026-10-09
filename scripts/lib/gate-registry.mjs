import { isDeferredGate, isDeferredTest } from './deferred-modules.mjs';
import { DANH_SACH_VIEW } from '../generate-docs-views.mjs';
import { selectionDigest } from './selected-vitest.mjs';

// Commands have one owner. Selection belongs to gate-plan, execution to the runners.
const broadInputs = ['src/**', 'scripts/**', 'tooling/**', 'contracts/**', 'supabase/**', 'package*.json', 'tsconfig*.json', '*baseline*.json', 'vite.config.ts'];
const docsInputs = [...broadInputs, '*.md', 'docs/**', 'docs-site/**', '.github/**', 'infra/**'];
const gates = {};
function nodeGate(id, job = 'quality-gates', options = {}) {
  gates[id] = { id, command: 'node', args: [`scripts/${id}.mjs`], job, local: true,
    evidenceClass: 'static', inputs: broadInputs, requires: [], ...options };
}

for (const id of [
  'check-agent-contract', 'check-runtime-matrix', 'check-known-gaps',
  'check-capability-surfaces', 'check-route-permission-drift', 'check-capability-docs',
  'check-baseline-doc', 'check-route-guards', 'check-test-matrix', 'check-workflow-paths',
  'check-raw-rpc-callers', 'check-realtime-query-keys', 'check-evidence-store',
  'check-test-only-exports', 'check-unknown-review', 'check-ts-suppressions',
  'check-rpc-cast-ratchet', 'check-rpc-in-view-ratchet', 'check-error-swallow-ratchet',
  'check-money-table-dml', 'check-migration-provenance', 'check-no-auto-apply',
  'check-management-api-writes', 'check-promote-readiness', 'check-migration-test-liveness',
  'check-doc-counts', 'check-new-modules-strict', 'check-ts-baseline', 'check-eslint-baseline',
  'check-docs', 'check-rpc-arg-names', 'check-rpc-name-literal', 'check-rpc-layer',
  'check-realtime-key-ownership', 'check-vault-access',
]) nodeGate(id);
for (const id of ['check-agent-contract', 'check-capability-docs', 'check-baseline-doc', 'check-doc-counts', 'check-docs', 'check-test-matrix', 'check-workflow-paths']) gates[id].inputs = docsInputs;
nodeGate('normalize-supabase-types', 'quality-gates', { args: ['scripts/normalize-supabase-types.mjs', '--check'] });
nodeGate('generate-docs-views', 'quality-gates', { args: ['scripts/generate-docs-views.mjs', '--check'], inputs: docsInputs });
nodeGate('check-dependency-audit', 'quality-gates', { local: false, evidenceClass: 'external' });
gates['check-known-gaps'].evidenceClass = 'external';
nodeGate('check-strict-islands', 'strict-islands-gate');
nodeGate('check-timezone', 'timezone-gate', { args: ['scripts/check-timezone-stability.mjs'], local: false, evidenceClass: 'external' });
nodeGate('check-realtime-descriptors', 'realtime-gates', { local: false, evidenceClass: 'live', requires: ['SUPABASE_PAT'] });
nodeGate('app-build', 'quality-gates', { command: 'npm', args: ['run', 'build'], local: false });
nodeGate('bundle-inventory', 'quality-gates', { args: ['scripts/generate-bundle-inventory.mjs'], local: false });
nodeGate('docs-build', 'quality-gates', { command: 'npm', args: ['--prefix', 'docs-site', 'run', 'build'], local: false, inputs: ['docs/**', 'docs-site/**', 'scripts/**', 'tooling/**'] });

for (const id of ['check-definer-acl', 'check-definer-body-authz', 'check-view-invoker', 'check-approver-provenance',
  'check-permission-catalog', 'check-migration-ledger-frozen', 'check-residence-dossier-rls',
  'check-forward-migration-idempotent', 'check-rpc-surface', 'check-edge-surface',
  'check-realtime-surface', 'check-stable-fn-locks', 'build-org-boundary-inventory', 'measure-org-leak']) {
  nodeGate(id, 'security-gates', { local: false, evidenceClass: 'live', requires: ['SUPABASE_PAT'] });
}
gates['build-org-boundary-inventory'].args.push('--check');
nodeGate('test-cross-tenant', 'cross-tenant-isolation', { local: false, evidenceClass: 'live', requires: ['SUPABASE_PAT'] });
nodeGate('reconcile-money', 'reconcile-money', { local: false, evidenceClass: 'live', requires: ['SUPABASE_PAT', 'SUPABASE_TEST_EMAIL', 'SUPABASE_TEST_PASSWORD'] });
nodeGate('reconcile-money-v2', 'reconcile-money', { local: false, evidenceClass: 'live', requires: ['SUPABASE_PAT'] });
nodeGate('generated-types-drift', 'generated-types-drift', { args: ['scripts/ci-generated-types-drift.mjs'], local: false, evidenceClass: 'live', requires: ['SUPABASE_ACCESS_TOKEN'] });
nodeGate('secret-scan', 'secret-scan', { args: ['scripts/ci-secret-scan.mjs'], local: false });

for (const [id, job, command, args] of [
  ['app-unit', 'vitest-tests', 'node', ['node_modules/vitest/vitest.mjs', 'run']],
  ['node-native', 'quality-gates', 'node', ['--test']],
  ['organization-backup-envelope', 'quality-gates', 'node', ['--test']],
  ['bank-event-gateway', 'quality-gates', 'node', ['--test']],
  ['edge-deno-bank-events', 'quality-gates', 'deno', ['test', '--config', 'supabase/functions/bank-event-ingest/deno.json']],
  ['edge-deno-llm-proxy', 'quality-gates', 'deno', ['test', '--config', 'supabase/functions/llm-proxy/deno.json']],
  ['edge-deno-quick-entry', 'quality-gates', 'deno', ['test', '--config', 'supabase/functions/quick-entry/deno.json']],
  ['e2e-fleet', 'quality-gates', 'node', ['node_modules/@playwright/test/cli.js', 'test', '--config', '.e2e-fleet/playwright.config.ts']],
  ['e2e-personal-finance-demo', 'quality-gates', 'node', ['node_modules/@playwright/test/cli.js', 'test', '--config', '.e2e-fleet/playwright.config.ts']],
  ['e2e-personal-finance-product', 'quality-gates', 'node', ['node_modules/@playwright/test/cli.js', 'test', '--config', '.e2e-fleet/playwright.config.ts']],
  ['e2e-bank-events', 'quality-gates', 'node', ['node_modules/@playwright/test/cli.js', 'test', '--config', '.e2e-fleet/playwright.config.ts']],
]) {
  gates[`suite:${id}`] = { id: `suite:${id}`, command, args, job, local: command !== 'deno', evidenceClass: 'static', inputs: broadInputs, requires: [] };
}

export const GATE_REGISTRY = Object.freeze(gates);
// Exact suite/file pairs only. Real TEST/preview specs remain outside default CI.
export function isOfflineBrowserSelection(suiteId, files) {
  const approved = {
    'e2e-personal-finance-demo': '.e2e-fleet/specs/personal-finance-demo.spec.ts',
    'e2e-personal-finance-product': '.e2e-fleet/specs/personal-finance-product.spec.ts',
    'e2e-bank-events': '.e2e-fleet/specs/bank-events.spec.ts',
  };
  return Array.isArray(files) && files.length === 1 && approved[suiteId] === files[0];
}
export const GENERATOR_REGISTRY = Object.freeze({
  'gen-supabase-types': { id: 'gen-supabase-types', command: 'node', args: ['scripts/gen-supabase-types.mjs'], requires: ['SUPABASE_ACCESS_TOKEN'], owns: ['src/integrations/supabase/types.ts'], external: true },
  'normalize-supabase-types': { id: 'normalize-supabase-types', command: 'node', args: ['scripts/normalize-supabase-types.mjs', '--write'], owns: ['src/integrations/supabase/types.ts'] },
  'generate-rpc-surface': { id: 'generate-rpc-surface', command: 'node', args: ['scripts/generate-rpc-surface.mjs'], requires: ['SUPABASE_PAT'], owns: ['contracts/surfaces/rpc-surface.json'], external: true },
  'generate-edge-surface': { id: 'generate-edge-surface', command: 'node', args: ['scripts/generate-edge-surface.mjs'], requires: ['SUPABASE_PAT'], owns: ['contracts/surfaces/edge-function-surface.json'], external: true },
  'generate-realtime-surface': { id: 'generate-realtime-surface', command: 'node', args: ['scripts/generate-realtime-surface.mjs'], requires: ['SUPABASE_PAT'], owns: ['contracts/surfaces/realtime-surface.json'], external: true },
  'generate-repository-inventory': { id: 'generate-repository-inventory', command: 'node', args: ['scripts/generate-repository-inventory.mjs', '--write'], owns: ['docs/generated/repository-inventory.json'] },
  'generate-docs-views': { id: 'generate-docs-views', command: 'node', args: ['scripts/generate-docs-views.mjs'], owns: DANH_SACH_VIEW },
  'check-doc-counts': { id: 'check-doc-counts', command: 'node', args: ['scripts/check-doc-counts.mjs', '--fix'], owns: [], patch: true },
  'check-baseline-doc': { id: 'check-baseline-doc', command: 'node', args: ['scripts/check-baseline-doc.mjs', '--fix'], owns: [], patch: true },
});

export function getGate(id, plan) {
  if (isDeferredGate(id)) throw new Error(`DEFERRED gate cannot execute: ${id}`);
  const original = GATE_REGISTRY[id];
  if (!original) throw new Error(`Unknown gate: ${id}`);
  const gate = { ...original, args: [...original.args] };
  if (id === 'check-forward-migration-idempotent') {
    if (!plan?.snapshot?.base) throw new Error('Migration check requires a verified diff base');
    gate.args.push('--tu-moc', plan.snapshot.base);
  }
  if (id.startsWith('suite:')) {
    const suiteId = id.slice(6);
    const selection = plan?.suiteSelections?.find((s) => s.id === suiteId);
    if (!selection || !selection.files?.length) throw new Error(`Missing selected tests: ${suiteId}`);
    if (selection.files.some(isDeferredTest)) throw new Error(`DEFERRED test selected: ${suiteId}`);
    if (suiteId.startsWith('e2e-') && !isOfflineBrowserSelection(suiteId, selection.files)) {
      throw new Error('Only explicitly approved offline browser suites may run through the default browser gate');
    }
    if (suiteId === 'app-unit') {
      gate.args = ['scripts/run-selected-vitest.mjs', '--plan', plan.environment === 'ci' ? '.gate-evidence/plan.json' : '.cache/gate-receipts/plan.json', '--selection-digest', selectionDigest(selection.files)];
    } else gate.args.push(...selection.files);
    if (gate.command === 'deno') gate.args.push('--allow-env');
    if (suiteId.startsWith('e2e-')) gate.args.push('--workers=1', '--reporter=list');
    // Broad CI owns the full app suite; targeted local feedback remains available.
    if (suiteId === 'app-unit' && selection.mode === 'all') gate.local = false;
  }
  return gate;
}
