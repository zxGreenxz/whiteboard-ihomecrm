import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validatePlan, assertExecution, assertCreateOnly, assertOutcome, readAll, runMatrix, assertCustody } from './test-contract-settlement-money.mjs';

const plan = () => ({
  organizationId: 'dddd0000-0000-4000-8000-000000000001',
  projectRef: 'tryymsxyyckgbrmmvozx',
  fixtureLabel: 'contract-settlement-money-20260921',
  cleanupOwner: 'fixture operator',
  cases: ['broker', 'broker', 'sale_contract', 'sale_deposit', 'refund'].map((kind, i) => ({ kind, sourceId: `${i + 1}1111111-1111-4111-8111-111111111111`, amount: 500000, accountId: i === 0 ? null : 'aaaaaaaa-1111-4111-8111-111111111111', voucherDate: '2026-09-21', expected: i === 1 ? 'LEGACY_AUTOPAY' : 'CREATE_ONLY' })),
});
test('partial matrix or broker control without real account is rejected', () => {
  assert.doesNotThrow(() => validatePlan(plan()));
  assert.throws(() => validatePlan({ ...plan(), cases: plan().cases.filter(c => c.expected !== 'LEGACY_AUTOPAY') }), /matrix|control/);
  const noControl = plan(); noControl.cases[1].expected = 'CREATE_ONLY';
  assert.throws(() => validatePlan(noControl), /positive control/);
  const p = plan(); p.cases[1].accountId = null;
  assert.throws(() => validatePlan(p), /account/);
  const missingSale = plan(); missingSale.cases = missingSale.cases.filter(c => c.kind !== 'sale_deposit');
  assert.throws(() => validatePlan(missingSale), /matrix/);
});
test('late denied account blocks every writer before the first measurement', async () => {
  let writes = 0;
  await assert.rejects(() => runMatrix(plan(), {
    preflight: async c => { if (c.kind === 'refund') assertCustody(c.accountId, []); },
    measure: async () => { writes++; return {}; },
  }), /CUSTODIAN/);
  assert.equal(writes, 0);
});
test('hidden ledger in positive control cannot allow empty-ledger create-only success', async () => {
  const measured = [];
  await assert.rejects(() => runMatrix(plan(), {
    preflight: async () => {},
    measure: async c => { measured.push(c.expected); return { row: { approval_status: 'APPROVED', posting_status: 'POSTED', total_amount: 500000 }, ledger: [] }; },
  }), /ledger/);
  assert.deepEqual(measured, ['LEGACY_AUTOPAY']);
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
