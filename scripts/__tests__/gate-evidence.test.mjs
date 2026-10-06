import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateReceipt, validateGateReceipt, canReuseGateReceipt, aggregateGateEvidence } from '../lib/gate-evidence.mjs';

const now = Date.parse('2026-10-06T12:00:00Z');
const gate = { id: 'check-docs', command: 'node', args: ['scripts/check-docs.mjs'], job: 'quality-gates', evidenceClass: 'static' };
const plan = { schemaVersion: 1, snapshot: { head: 'a'.repeat(40), tree: 'b'.repeat(40), source: 'commit' }, policyDigest: 'policy', runtimeDigest: 'runtime', inputDigest: 'input', gateIds: [gate.id], requiredJobs: [gate.job] };
const runtime = { node: 'v24.18.0' };
const receipt = (overrides = {}) => ({ ...createGateReceipt({ gate, plan, runId: '42:1', status: 'passed', exitCode: 0, startedAt: new Date(now - 1000).toISOString(), completedAt: new Date(now).toISOString(), runtime }), ...overrides });
const context = (overrides = {}) => ({ gate, plan, runId: '42:1', now, runtime, ...overrides });

test('receipt binds exact SHA/tree/input/policy/runtime and executed command', () => {
  assert.equal(validateGateReceipt(receipt(), context()).valid, true);
  for (const field of ['policyDigest', 'runtimeDigest', 'inputDigest', 'commandDigest']) {
    assert.equal(validateGateReceipt(receipt({ [field]: 'different' }), context()).valid, false, field);
  }
  for (const field of ['base', 'head', 'tree', 'source']) {
    assert.equal(validateGateReceipt(receipt({ snapshot: { ...plan.snapshot, [field]: 'different' } }), context()).valid, false, field);
  }
  assert.equal(validateGateReceipt(receipt({ runtime: { node: 'v22.0.0' } }), context()).valid, false);
});

test('failed, skipped, cancelled, blocked and fabricated success are never pass evidence', () => {
  for (const status of ['failed', 'skipped', 'cancelled', 'blocked', undefined]) {
    assert.equal(validateGateReceipt(receipt({ status }), context()).valid, false, status);
  }
  assert.equal(validateGateReceipt(receipt({ exitCode: 1 }), context()).valid, false);
  assert.equal(validateGateReceipt(receipt({ completedAt: 'bad' }), context()).valid, false);
  assert.equal(validateGateReceipt(receipt({ startedAt: new Date(now + 1).toISOString() }), context()).valid, false);
});

test('reuse requires static evidence, exact SHA, trusted source run and age at most 24 hours', () => {
  const reused = receipt({ runId: '41:1' });
  const reuseContext = context({ trustedRunIds: ['41:1'], allowReuse: true });
  assert.equal(canReuseGateReceipt(reused, reuseContext), true);
  assert.equal(canReuseGateReceipt(reused, context({ allowReuse: true })), false);
  assert.equal(canReuseGateReceipt(reused, { ...reuseContext, plan: { ...plan, snapshot: { ...plan.snapshot, head: 'c'.repeat(40) } } }), false);
  assert.equal(canReuseGateReceipt(reused, { ...reuseContext, now: now + 86_400_001 }), false);
  assert.equal(canReuseGateReceipt(reused, { ...reuseContext, now: now - 1 }), false);
  assert.equal(canReuseGateReceipt(receipt(), context({ now: now + 86_400_001 })), false);
  for (const evidenceClass of ['live', 'external']) {
    const liveGate = { ...gate, evidenceClass };
    const live = createGateReceipt({ gate: liveGate, plan, runId: '41:1', status: 'passed', exitCode: 0, startedAt: new Date(now - 1000).toISOString(), completedAt: new Date(now).toISOString(), runtime });
    assert.equal(canReuseGateReceipt(live, { ...reuseContext, gate: liveGate }), false);
    assert.equal(validateGateReceipt(live, { ...context(), gate: liveGate, runId: '41:1' }).valid, true);
  }
});

test('aggregate fails closed for missing plan, missing/duplicate receipt and all non-success required jobs', () => {
  const input = { plan, receipts: [receipt()], jobs: { 'quality-gates': { result: 'success' } }, registry: { [gate.id]: gate }, runId: '42:1', now, runtime };
  assert.equal(aggregateGateEvidence(input).status, 'passed');
  const manual = [{ status: 'required', paths: ['src/pages/Example.tsx'], viewports: ['affected'] }];
  const scoped = aggregateGateEvidence({ ...input, plan: { ...plan, browserRequirements: manual } });
  assert.equal(scoped.evidenceScope, 'ci-technical');
  assert.equal(scoped.manualUiValidation, 'not-attested-by-ci');
  assert.deepEqual(scoped.browserRequirements, manual);
  assert.equal(aggregateGateEvidence({ ...input, plan: undefined }).status, 'failed');
  assert.equal(aggregateGateEvidence({ ...input, receipts: [] }).status, 'failed');
  assert.equal(aggregateGateEvidence({ ...input, receipts: [receipt(), receipt()] }).status, 'failed');
  assert.equal(aggregateGateEvidence({ ...input, registry: {} }).status, 'failed');
  assert.equal(aggregateGateEvidence({ ...input, plan: { ...plan, unavailable: [{ suiteId: 'live-e2e' }] } }).status, 'failed');
  assert.equal(aggregateGateEvidence({ ...input, plan: { ...plan, executionMismatches: ['source.ts'] } }).status, 'failed');
  assert.equal(aggregateGateEvidence({ ...input, plan: { ...plan, gateIds: [] } }).status, 'failed');
  for (const result of ['skipped', 'cancelled', 'failure', 'blocked', undefined]) {
    assert.equal(aggregateGateEvidence({ ...input, jobs: { 'quality-gates': { result } } }).status, 'failed', result);
  }
  assert.equal(aggregateGateEvidence({ ...input, jobs: {} }).status, 'failed');
});
