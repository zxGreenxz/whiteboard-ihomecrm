#!/usr/bin/env node
// Existing writer measurement, not a UI adapter. No writer call in default mode.
// Prepared, disposable DEMO sources only. Retain created voucher IDs for reviewed cleanup.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEMO = 'dddd0000-0000-4000-8000-000000000001';
const PROJECT = 'tryymsxyyckgbrmmvozx';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const kinds = new Set(['broker', 'sale_contract', 'sale_deposit', 'refund']);
export function assertCustody(accountId, access) {
  assert.ok(Array.isArray(access), 'Cashbook access reader failed');
  assert.ok(access.some(row => row.cashbook_id === accountId && row.possession_kind === 'CUSTODIAN'), 'Account requires active CUSTODIAN for writer and ledger visibility');
}
export async function runMatrix(plan, { preflight, measure }) {
  validatePlan(plan);
  for (const c of plan.cases) await preflight(c);
  const control = plan.cases.find(c => c.expected === 'LEGACY_AUTOPAY');
  const ordered = [control, ...plan.cases.filter(c => c !== control)];
  for (const c of ordered) {
    const { row, ledger } = await measure(c);
    assertOutcome(row, ledger, c);
    if (c === control) {
      assert.ok(ledger.every(p => p.account_id === control.accountId), 'Positive control ledger must belong to the reviewed account');
    }
  }
}
export function assertOutcome(row, postings, c) {
  if (c.expected === 'CREATE_ONLY') return assertCreateOnly(row, postings, c.amount);
  assert.equal(c.expected, 'LEGACY_AUTOPAY');
  assert.equal(row.approval_status, 'APPROVED');
  assert.equal(row.posting_status, 'POSTED');
  assert.equal(Number(row.total_amount), c.amount);
  assert.ok(postings.length > 0, 'Autopay control did not produce a ledger entry');
  assert.equal(postings.reduce((sum, p) => sum + Number(p.net_cash_effect), 0), -c.amount, 'Autopay control cash delta differs');
}

export function validatePlan(plan) {
  assert.equal(plan.organizationId, DEMO, 'Only DEMO fixtures are accepted');
  assert.equal(plan.projectRef, PROJECT, 'Unexpected project');
  assert.match(plan.fixtureLabel, /^contract-settlement-money-[a-z0-9-]+$/, 'fixtureLabel must identify disposable fixtures');
  assert.ok(typeof plan.cleanupOwner === 'string' && plan.cleanupOwner.trim(), 'A cleanup owner is required');
  assert.ok(Array.isArray(plan.cases) && plan.cases.length > 0 && plan.cases.length <= 8, 'Expected 1–8 cases');
  const seen = new Set();
  for (const c of plan.cases) {
    assert.ok(kinds.has(c.kind), 'Unknown writer kind');
    assert.match(c.sourceId, UUID);
    assert.ok(!seen.has(c.sourceId), 'Each case needs a distinct source; duplicate source rejected');
    seen.add(c.sourceId);
    assert.ok(Number.isSafeInteger(c.amount) && c.amount > 0, 'Amount must be positive integer VND');
    assert.ok(c.accountId === null || UUID.test(c.accountId), 'Explicit accountId or null required');
    assert.match(c.voucherDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['CREATE_ONLY', 'LEGACY_AUTOPAY'].includes(c.expected), 'Explicit expected outcome required');
    if (c.expected === 'LEGACY_AUTOPAY') assert.ok(c.kind === 'broker' && c.accountId !== null, 'Only broker with account is an autopay control');
  }
  const controls = plan.cases.filter(c => c.expected === 'LEGACY_AUTOPAY');
  assert.equal(controls.length, 1, 'Full matrix requires one broker positive control');
  assert.equal(plan.cases.length, 5, 'Full matrix requires exactly five cases');
  const control = controls[0];
  const broker = plan.cases.filter(c => c.kind === 'broker' && c.expected === 'CREATE_ONLY' && c.accountId === null);
  assert.equal(broker.length, 1, 'Full matrix requires paired broker NULL-account case');
  assert.equal(broker[0].amount, control.amount, 'Paired broker amounts must match');
  for (const kind of ['sale_contract', 'sale_deposit', 'refund']) {
    const matches = plan.cases.filter(c => c.kind === kind && c.expected === 'CREATE_ONLY');
    assert.equal(matches.length, 1, `Full matrix requires ${kind}`);
    assert.equal(matches[0].accountId, control.accountId, 'All real accounts must match the ledger positive control');
  }
  return plan;
}

export function assertExecution(reviewedBytes, digest) {
  assert.equal(digest, createHash('sha256').update(reviewedBytes).digest('hex'), 'Reviewed digest does not match harness + fixture plan');
}

export function assertCreateOnly(row, postings, amount) {
  assert.equal(row.approval_status, 'UNAPPROVED', 'Writer approved the voucher');
  assert.equal(row.review_state, 'PENDING', 'Writer did not produce known pending review state');
  assert.equal(row.posting_status, 'UNPOSTED', 'Writer posted or returned unknown posting state');
  assert.equal(row.posting_id, null);
  assert.equal(row.active_posting_id_v2, null);
  assert.equal(Number(row.total_amount), amount, 'Writer changed amount');
  assert.equal(postings.length, 0, 'Writer created ledger entries');
}

export async function readAll(readPage) {
  const rows = [];
  for (let offset = 0; ; ) {
    const page = await readPage(offset, 1000);
    assert.ok(Array.isArray(page), 'Reader must return an array');
    if (!page.length) return rows;
    rows.push(...page);
    offset += page.length;
    assert.ok(offset <= 100000, 'Fixture snapshot unexpectedly large');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  if (!args.includes('--fixture')) {
    console.log('DRY RUN — no network or writes. Usage: --fixture <prepared-DEMO-plan.json> [--execute --reviewed-sha256 <digest>].');
    console.log('Plan requires organizationId, projectRef, fixtureLabel, cleanupOwner, cases[{kind,sourceId,amount,accountId,voucherDate,expected}]. expected=CREATE_ONLY|LEGACY_AUTOPAY.');
    console.log('Required five cases: broker NULL CREATE_ONLY + broker real-account LEGACY_AUTOPAY + sale_contract/sale_deposit/refund CREATE_ONLY. All share one building and real account with active CUSTODIAN. No partial pass. Review harness and cleanup before execution.');
    return;
  }
  const bytes = readFileSync(value('--fixture'), 'utf8');
  const plan = validatePlan(JSON.parse(bytes));
  const reviewedBytes = readFileSync(fileURLToPath(import.meta.url), 'utf8') + '\n' + bytes;
  const digest = createHash('sha256').update(reviewedBytes).digest('hex');
  console.log(JSON.stringify({ mode: args.includes('--execute') ? 'EXECUTE' : 'DRY_RUN', digest, cases: plan.cases.map(c => ({ kind: c.kind, sourceId: c.sourceId, accountProvided: c.accountId !== null })), cleanupOwner: plan.cleanupOwner }));
  if (!args.includes('--execute')) return;
  assertExecution(reviewedBytes, value('--reviewed-sha256'));
  const token = process.env.SETTLEMENT_ACCESS_TOKEN;
  const apiKey = process.env.SUPABASE_ANON_KEY;
  assert.ok(token && apiKey, 'SETTLEMENT_ACCESS_TOKEN and SUPABASE_ANON_KEY are required');
  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.equal(claims.role, 'authenticated', 'Use a real authenticated user, never service_role');
  const origin = `https://${PROJECT}.supabase.co`;
  const headers = { apikey: apiKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const request = async (path, body) => {
    const response = await fetch(origin + path, { headers, method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) throw new Error(`PostgREST/Auth ${response.status} (${data.code ?? 'unknown'}); response body withheld`);
    return data;
  };
  const user = await request('/auth/v1/user');
  assert.equal(user.id, claims.sub, 'JWT user could not be verified');
  const single = async (table, id) => {
    const rows = await request(`/rest/v1/${table}?id=eq.${id}&organization_id=eq.${DEMO}&select=*`);
    assert.equal(rows.length, 1, `Missing/RLS-hidden DEMO ${table} fixture`);
    assert.equal(rows[0].organization_id, DEMO);
    return rows[0];
  };
  const vouchers = () => readAll((offset, limit) => request(`/rest/v1/income_expenses?organization_id=eq.${DEMO}&select=id&order=id&offset=${offset}&limit=${limit}`));
  const postings = id => readAll((offset, limit) => request(`/rest/v1/income_expense_postings?organization_id=eq.${DEMO}&voucher_id=eq.${id}&select=id,account_id,net_cash_effect&order=id&offset=${offset}&limit=${limit}`));
  const access = await request('/rest/v1/rpc/list_my_cashbook_access_v2', {});
  let fixtureBuildingId;
  // Validate every source before the first writer, including labels and all account scopes.
  const preflight = async c => {
    const source = await single(c.kind === 'refund' ? 'termination_refund_obligations' : c.kind === 'sale_deposit' ? 'income_expenses' : 'contracts', c.sourceId);
    const labelSource = c.kind === 'refund' ? await single('contracts', source.contract_id) : source;
    assert.ok(String(labelSource.contract_number ?? labelSource.name ?? '').includes(plan.fixtureLabel), 'Source is not explicitly labelled disposable fixture');
    assert.match(labelSource.room_id, UUID, 'Fixture must have stable room linkage');
    const room = await single('rooms', labelSource.room_id);
    const building = await single('buildings', room.building_id);
    assert.equal(room.deleted_at, null);
    assert.equal(building.deleted_at, null);
    fixtureBuildingId ??= building.id;
    assert.equal(building.id, fixtureBuildingId, 'All fixtures must share the positive-control building scope');
    assert.equal(await request('/rest/v1/rpc/can_access_building', { _building_id: building.id }), true, 'Actor cannot access fixture building');
    if (labelSource.building_id) assert.equal(labelSource.building_id, building.id);
    if (c.kind === 'refund') {
      assert.equal(source.voucher_id, null, 'Refund fixture already has a voucher');
      assert.equal(Number(source.requested_amount), c.amount);
      const termination = await single('contract_terminations', source.termination_id);
      assert.ok(['APPROVED', 'COMPLETED'].includes(termination.status), 'Termination is not approved');
      assert.equal(source.obligation_status, 'OK', 'Harness does not force refund obligations');
    }
    if (c.kind === 'sale_contract') {
      const status = await request('/rest/v1/rpc/sale_bonus_status_v1', { p_contract_id: c.sourceId });
      assert.equal(status.alreadyPaid, false, 'Sale fixture already has a live bonus');
    }
    if (c.accountId) {
      assertCustody(c.accountId, access);
      const account = await single('accounts', c.accountId);
      assert.equal(account.deleted_at, null);
      assert.equal(account.is_virtual, false);
    }
  };
  const flags = await request('/rest/v1/rpc/get_finance_v2_client_flags_v1', {});
  const route = flags.find(row => row.organization_id === DEMO);
  assert.equal(route?.workflow_route, 'CANONICAL');
  assert.equal(route?.posting_route, 'CANONICAL');
  const measure = async c => {
    const before = new Set((await vouchers()).map(row => row.id));
    const rpc = c.kind === 'refund' ? 'create_termination_refund_voucher_v1' : c.kind === 'sale_deposit' ? 'create_sale_bonus_from_deposit_v1' : 'create_commission_voucher';
    const payload = c.kind === 'refund' ? { p_obligation_id: c.sourceId, p_account_id: c.accountId, p_force: false, p_force_reason: null }
      : c.kind === 'sale_deposit' ? { p_deposit_voucher_id: c.sourceId, p_amount: c.amount, p_account_id: c.accountId, p_voucher_date: c.voucherDate, p_recipient: 'DEMO fixture recipient', p_bank: 'DEMO bank', p_account_number: '0000000000', p_attachments: [] }
      : { p_contract_id: c.sourceId, p_kind: c.kind === 'broker' ? 'broker' : 'sale', p_amount: c.amount, p_voucher_date: c.voucherDate, p_account_id: c.accountId, p_payer_name: 'DEMO fixture payer', p_recipient_name: 'DEMO fixture recipient', p_recipient_bank: 'DEMO bank', p_recipient_account: '0000000000', p_item_description: plan.fixtureLabel, p_attachments: [] };
    // Deliberately no retry: these legacy writers do not all have idempotency keys.
    const result = await request(`/rest/v1/rpc/${rpc}`, payload);
    const id = result.voucherId ?? result.id;
    assert.match(id, UUID);
    // Emit recovery ID immediately, before any assertion that may fail.
    console.log(JSON.stringify({ kind: c.kind, createdVoucherId: id, cleanupRequired: true }));
    assert.ok(!before.has(id), 'Writer returned existing voucher; invalid create fixture');
    const row = await single('income_expenses', id);
    const ledger = await postings(id);
    console.log(JSON.stringify({ kind: c.kind, approval: row.approval_status, review: row.review_state, posting: row.posting_status, ledgerEntries: ledger.length }));
    return { row, ledger };
  };
  await runMatrix(plan, { preflight, measure });
  console.log('Declared outcomes passed for executed cases. LEGACY_AUTOPAY is an unsafe-for-create-only control. This does not prove concurrency, ACL denial, cleanup, or browser integration.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
