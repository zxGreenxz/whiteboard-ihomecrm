import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validatePlan, assertExecution, assertCreateOnly, assertOutcome, readAll } from './test-contract-settlement-money.mjs';

const plan = () => ({
  organizationId: 'dddd0000-0000-4000-8000-000000000001',
  projectRef: 'tryymsxyyckgbrmmvozx',
  fixtureLabel: 'contract-settlement-money-20260921',
  cleanupOwner: 'fixture operator',
  cases: [{ kind: 'broker', sourceId: '11111111-1111-4111-8111-111111111111', amount: 500000, accountId: null, voucherDate: '2026-09-21', expected: 'CREATE_ONLY' }],
});
test('refuses real organization and unreviewed fixture changes before writes', () => {
  assert.throws(() => validatePlan({ ...plan(), organizationId: 'aaaa0000-0000-4000-8000-000000000001' }), /DEMO/);
  assert.throws(() => validatePlan({ ...plan(), projectRef: 'another-project' }), /project/);
  const bytes = JSON.stringify(plan());
  assert.throws(() => assertExecution(bytes, 'wrong'), /digest/);
  assert.doesNotThrow(() => assertExecution(bytes, createHash('sha256').update(bytes).digest('hex')));
});
test('refuses unknown writer kinds, missing cleanup owner and duplicate source cases', () => {
  assert.throws(() => validatePlan({ ...plan(), cases: [{ ...plan().cases[0], kind: 'post' }] }), /kind/);
  assert.throws(() => validatePlan({ ...plan(), cleanupOwner: '' }), /cleanup/);
  assert.throws(() => validatePlan({ ...plan(), cases: [plan().cases[0], plan().cases[0]] }), /duplicate/);
});
test('create-only fails on automatic approval, hidden state, amount drift or ledger entry', () => {
  const row = { approval_status: 'UNAPPROVED', review_state: 'PENDING', posting_status: 'UNPOSTED', total_amount: '500000', posting_id: null, active_posting_id_v2: null };
  assert.doesNotThrow(() => assertCreateOnly(row, [], 500000));
  assert.throws(() => assertCreateOnly({ ...row, approval_status: 'APPROVED' }, [], 500000));
  assert.throws(() => assertCreateOnly({ ...row, review_state: null }, [], 500000));
  assert.throws(() => assertCreateOnly({ ...row, total_amount: '500001' }, [], 500000));
  assert.throws(() => assertCreateOnly(row, [{ id: 'posting' }], 500000));
});
test('pagination continues through server cap rather than accepting first 1000 rows', async () => {
  const values = Array.from({ length: 1105 }, (_, id) => ({ id }));
  const rows = await readAll(async (offset, limit) => values.slice(offset, offset + Math.min(limit, 1000)));
  assert.equal(rows.length, 1105);
  assert.equal(rows.at(-1).id, 1104);
});
test('legacy autopay control requires actual expense ledger and cannot accept create-only result', () => {
  const row = { approval_status: 'APPROVED', posting_status: 'POSTED', total_amount: '500000' };
  assert.doesNotThrow(() => assertOutcome(row, [{ net_cash_effect: '-500000' }], { expected: 'LEGACY_AUTOPAY', amount: 500000 }));
  assert.throws(() => assertOutcome(row, [], { expected: 'LEGACY_AUTOPAY', amount: 500000 }));
  assert.throws(() => assertOutcome(row, [{ net_cash_effect: '500000' }], { expected: 'LEGACY_AUTOPAY', amount: 500000 }));
});
