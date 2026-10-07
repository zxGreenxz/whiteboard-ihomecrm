import test from 'node:test';
import assert from 'node:assert/strict';
import { executeGateJob, selectEventSnapshot, trustedReuseRun } from '../lib/ci-gate-execution.mjs';

test('event diff uses event base and actual checkout SHA; dispatch never invents HEAD~1', () => {
  const pick = ({ base, head, full }) => ({ base, head, full });
  assert.deepEqual(pick(selectEventSnapshot({ eventName: 'pull_request', event: { pull_request: { base: { sha: 'base' }, head: { sha: 'pr-head' } } }, checkoutSha: 'merge-sha' })), { base: 'base', head: 'merge-sha', full: false });
  assert.deepEqual(pick(selectEventSnapshot({ eventName: 'push', event: { before: 'before' }, checkoutSha: 'pushed' })), { base: 'before', head: 'pushed', full: false });
  assert.deepEqual(pick(selectEventSnapshot({ eventName: 'workflow_dispatch', event: {}, checkoutSha: 'actual' })), { base: null, head: 'actual', full: true });
  assert.equal(selectEventSnapshot({ eventName: 'push', event: { before: '0'.repeat(40) }, checkoutSha: 'actual' }).full, true);
});

test('main push plans from the production tip so evidence covers every commit promotion ships', () => {
  const main = { eventName: 'push', event: { before: 'before' }, checkoutSha: 'head', ref: 'refs/heads/main' };
  const covered = selectEventSnapshot({ ...main, productionTip: 'prod', productionIsAncestor: true });
  assert.deepEqual([covered.base, covered.full], ['prod', false]);
  assert.match(covered.reason, /production\.\.HEAD/);
  for (const [patch, why] of [
    [{ productionTip: null }, /không có origin\/production/],
    [{ productionTip: 'prod', productionIsAncestor: false }, /không phải tổ tiên/],
    [{ productionTip: 'head', productionIsAncestor: true }, /đã ở đúng HEAD/],
  ]) {
    const fallback = selectEventSnapshot({ ...main, ...patch });
    assert.deepEqual([fallback.base, fallback.full], ['before', false]);
    assert.match(fallback.reason, why);
    assert.match(fallback.reason, /event\.before/);
  }
  const full = selectEventSnapshot({ ...main, event: { before: '0'.repeat(40) }, productionTip: null });
  assert.deepEqual([full.base, full.full], [null, true]);
  assert.match(full.reason, /chạy full/);
  // Other branches keep their own push diff even when production is an ancestor.
  assert.equal(selectEventSnapshot({ ...main, ref: 'refs/heads/release/x', productionTip: 'prod', productionIsAncestor: true }).base, 'before');
});

test('cross-run trust requires exact tested SHA and successful same-repo PR into main within 24h', () => {
  const now = Date.parse('2026-10-06T12:00:00Z');
  const run = { id: 1, run_attempt: 1, path: '.github/workflows/ci-gates.yml', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: 'sha', head_repository: { full_name: 'owner/repo' }, created_at: new Date(now - 1000).toISOString(), pull_requests: [{ base: { ref: 'main', repo: { full_name: 'owner/repo' } } }] };
  assert.equal(trustedReuseRun(run, { repository: 'owner/repo', sha: 'sha', now }), true);
  for (const patch of [{ head_sha: 'other' }, { head_repository: { full_name: 'fork/repo' } }, { pull_requests: [] }, { conclusion: 'failure' }, { event: 'workflow_dispatch' }, { created_at: new Date(now - 86_400_001).toISOString() }]) {
    assert.equal(trustedReuseRun({ ...run, ...patch }, { repository: 'owner/repo', sha: 'sha', now }), false);
  }
});

test('required credentials block without executing; a failed gate does not hide other results', () => {
  const gates = [
    { id: 'live', job: 'security-gates', requires: ['PAT'], evidenceClass: 'live', command: 'node', args: ['live.mjs'] },
    { id: 'bad', job: 'security-gates', requires: [], evidenceClass: 'static', command: 'node', args: ['bad.mjs'] },
    { id: 'good', job: 'security-gates', requires: [], evidenceClass: 'static', command: 'node', args: ['good.mjs'] },
  ];
  const plan = { snapshot: { head: 'sha', tree: 'tree', source: 'commit' }, policyDigest: 'p', runtimeDigest: 'r', inputDigest: 'i', gateIds: gates.map((g) => g.id) };
  const calls = [];
  const result = executeGateJob({ plan, jobId: 'security-gates', getGate: (id) => gates.find((g) => g.id === id), runId: '1:1', env: {}, execute: (gate) => { calls.push(gate.id); return { status: gate.id === 'bad' ? 1 : 0 }; } });
  assert.deepEqual(calls, ['bad', 'good']);
  assert.deepEqual(result.receipts.map((r) => r.status), ['blocked', 'failed', 'passed']);
  assert.equal(result.exitCode, 1);
});

test('unselected job and unresolved registry entry cannot report green', () => {
  const plan = { gateIds: ['missing'] };
  assert.throws(() => executeGateJob({ plan, jobId: 'quality-gates', getGate: () => null }), /Unknown/);
  assert.throws(() => executeGateJob({ plan: { gateIds: [] }, jobId: 'quality-gates', getGate: () => null }), /No selected/);
});
