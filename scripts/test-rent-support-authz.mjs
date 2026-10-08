#!/usr/bin/env node
// Focused actual-JWT READ proof. Fixture provisioning/cleanup belongs to the
// existing Task7/8 integration flow; this runner never seeds or toggles writers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { signInTest, request } from './test-voucher-detail-read-authz.mjs';
import { batBuocDichTest, credential, ketNoi, lit, psqlJson, repoRoot } from './test-env/lib.mjs';
import { docVault } from './lib/vault.mjs';

const TEST_REF = 'hzulujxgonszuleqticb';
const ROLES = ['owner', 'manager', 'accountant', 'contracts_only', 'other_recipient', 'expired'];
const uuid = value => assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const digest = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
assert.equal(args.length, 2, 'Usage: node scripts/test-rent-support-authz.mjs <non-secret-fixture.json> <evidence.json>');
const fixtureBytes = readFileSync(resolve(args[0]), 'utf8');
const f = JSON.parse(fixtureBytes);
assert.equal(f.project, TEST_REF);
assert.match(f.marker, /^task(?:7|8|10)-[a-z0-9-]+$/);
assert.equal(f.source_sha, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim(), 'fixture must name the integrated source SHA');
assert.deepEqual(Object.keys(f.actors).sort(), [...ROLES].sort(), 'all six role fixtures required; no skipped roles');
for (const key of ['organization_id', 'building_id', 'contract_id', 'outside_building_id', 'outside_contract_id', 'cross_organization_id', 'cross_contract_id', 'operation_id', 'outside_cashbook_operation_id', 'account_id', 'outside_account_id']) uuid(f[key]);
assert.notEqual(f.organization_id, f.cross_organization_id);
assert.notEqual(f.building_id, f.outside_building_id);
assert.notEqual(f.operation_id, f.outside_cashbook_operation_id);
assert.notEqual(f.account_id, f.outside_account_id);
const passwordVars = new Set();
for (const role of ROLES) {
  const actor = f.actors[role];
  uuid(actor.id);
  assert.match(actor.email, /@example\.invalid$/);
  assert.match(actor.password_env, /^RENT_SUPPORT_TEST_PASS_[A-Z_]+$/);
  assert(process.env[actor.password_env], `Missing synthetic password env for ${role}`);
  passwordVars.add(actor.password_env);
  assert(!Object.hasOwn(actor, 'password') && !Object.hasOwn(actor, 'jwt'), 'manifest must not contain credentials');
}
assert.equal(passwordVars.size, ROLES.length, 'distinct role credential variables required');
assert.equal(new Set(ROLES.map(role => f.actors[role].id)).size, ROLES.length);
// credential() can generate a missing seed. Refuse that path before calling it.
assert(process.env.TEST_ENV_PASSWORD_SEED || /^TEST_ENV_PASSWORD_SEED=\S+\s*$/m.test(docVault()), 'TEST seed must already exist; this runner never changes vault');
assert(!process.env.TEST_SUPABASE_REF || process.env.TEST_SUPABASE_REF === TEST_REF);
const cred = credential();
assert.equal(cred.testRef, TEST_REF);
assert(cred.testPublishableKey, 'actual JWT requires the TEST publishable key');
const { test } = await ketNoi(cred);
assert(!test.includes('tryymsxyyckgbrmmvozx'));
// The shared guard can mark an empty DB. Require its existing marker first so
// even a wrongly routed/empty TEST connection cannot turn this into a writer.
assert.equal(psqlJson(test, `SELECT to_regclass('test_env.danh_dau') IS NOT NULL present`)[0].present, true);
assert.equal(psqlJson(test, 'SELECT ref FROM test_env.danh_dau')[0]?.ref, TEST_REF);
await batBuocDichTest(cred, test);
const ctx = { cred, test, url: `https://${TEST_REF}.supabase.co` };
const baseline = psqlJson(ctx.test, `SELECT pg_get_functiondef('app_private.rent_support_writers_enabled_v1()'::regprocedure) definition`)[0];
const truth = psqlJson(ctx.test, `SELECT c.id,c.organization_id,r.building_id,p.revision,p.payload,p.committed_total::text committed_total
 FROM public.contracts c JOIN public.rooms r ON r.id=c.room_id AND r.organization_id=c.organization_id
 JOIN public.organizations o ON o.id=c.organization_id
 JOIN app_private.contract_rent_support_plans p ON p.contract_id=c.id AND p.organization_id=c.organization_id AND p.state='ACTIVE'
 WHERE c.id IN (${[f.contract_id, f.outside_contract_id].map(lit).join(',')}) AND o.id=${lit(f.organization_id)} AND o.name=${lit(f.marker)}`);
assert.equal(truth.length, 2, 'two exact marked synthetic contracts with active plans required');
const primary = truth.find(row => row.id === f.contract_id);
assert.equal(primary.building_id, f.building_id);
assert.equal(truth.find(row => row.id === f.outside_contract_id).building_id, f.outside_building_id);
const cross = psqlJson(ctx.test, `SELECT c.id FROM public.contracts c JOIN public.organizations o ON o.id=c.organization_id
 WHERE c.id=${lit(f.cross_contract_id)} AND o.id=${lit(f.cross_organization_id)} AND o.name=${lit(f.marker + '-cross')}`);
assert.equal(cross.length, 1, 'cross-tenant fixture must physically exist with exact synthetic marker');
const payee = psqlJson(ctx.test, `SELECT profile_id FROM app_private.rent_support_parties
 WHERE organization_id=${lit(f.organization_id)} AND id=${lit(primary.payload.sale_party_id)}`);
assert.equal(payee.length, 1, 'the fixture must identify a real registered Sale payee');
assert(payee[0].profile_id && payee[0].profile_id !== f.actors.other_recipient.id, 'other-recipient actor must differ from actual funding payee');
const operations = psqlJson(ctx.test, `SELECT id,contract_id,state,result FROM app_private.rent_support_funding_operations
 WHERE organization_id=${lit(f.organization_id)} AND id IN (${[f.operation_id, f.outside_cashbook_operation_id].map(lit).join(',')})`);
assert.equal(operations.length, 2);
for (const operation of operations) {
  assert.equal(operation.contract_id, f.contract_id, 'cashbook denial isolates cashbook scope within the same authorized building');
  assert.equal(operation.state, 'COMPLETED');
  assert(operation.result?.sources?.some(source => source.voucher_id), 'receipt must contain a real nonzero voucher; net-zero cannot prove cashbook isolation');
  const voucherIds = operation.result.sources.filter(source => source.voucher_id).map(source => source.voucher_id);
  voucherIds.forEach(uuid);
  const vouchers = psqlJson(ctx.test, `SELECT id,account_id,building_id FROM public.income_expenses
   WHERE organization_id=${lit(f.organization_id)} AND id IN (${voucherIds.map(lit).join(',')})`);
  assert.equal(vouchers.length, voucherIds.length);
  for (const voucher of vouchers) {
    assert.equal(voucher.building_id, f.building_id);
    assert.equal(voucher.account_id, operation.id === f.operation_id ? f.account_id : f.outside_account_id);
  }
}
const memberships = psqlJson(ctx.test, `SELECT user_id,status,valid_to,revoked_at FROM public.organization_memberships
 WHERE organization_id=${lit(f.organization_id)} AND user_id IN (${ROLES.map(role => lit(f.actors[role].id)).join(',')})`);
assert.equal(memberships.length, 6);
const expired = memberships.find(row => row.user_id === f.actors.expired.id);
assert(expired.revoked_at || expired.status !== 'ACTIVE' || (expired.valid_to && Date.parse(expired.valid_to) < Date.now()), 'expired actor must be physically expired/revoked');
const cases = [];
let completed = false;
try {
  for (const role of ROLES) {
    const actor = f.actors[role];
    const session = await signInTest(ctx, actor.email, process.env[actor.password_env]);
    assert.equal(session.user.id, actor.id);
    const claims = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url').toString('utf8'));
    assert.equal(claims.role, 'authenticated');
    assert.equal(claims.sub, actor.id);
    const call = (rpc, body) => request(ctx, session.access_token, `rpc/${rpc}`, body);
    const denied = async (name, rpc, body) => {
      const result = await call(rpc, body);
      assert.equal(result.status, 403, `${role}/${name}: authorization denial must be HTTP403`);
      assert.equal(result.json?.code, '42501', `${role}/${name}: routing/validation failures are not authorization proof`);
      cases.push({ role, name, status: result.status, code: result.json.code });
    };
    const readArgs = (org, contract) => ({ p_organization_id: org, p_contract_ids: [contract], p_building_ids: null, p_offset: 0, p_limit: 1 });
    const quoteArgs = { p_organization_id: f.organization_id, p_contract_id: f.contract_id, p_draft_id: null, p_payload: primary.payload, p_invoice_context: null, p_payout_context: null };
    const receiptArgs = operation => ({ p_organization_id: f.organization_id, p_operation_id: operation });
    if (role === 'expired') {
      await denied('customer-read', 'read_contract_rent_support_v1', readArgs(f.organization_id, f.contract_id));
    } else {
      const read = await call('read_contract_rent_support_v1', readArgs(f.organization_id, f.contract_id));
      assert.equal(read.status, 200);
      assert.equal(read.json.total, 1);
      assert.equal(read.json.rows.length, 1, 'empty read is never an allowed-role proof');
      const row = read.json.rows[0];
      assert.equal(row.contract_id, f.contract_id);
      assert.equal(row.kind, 'V2');
      assert.equal(row.revision, primary.revision);
      const finance = ['owner', 'manager', 'accountant'].includes(role);
      assert.equal(Object.hasOwn(row, 'financial'), finance);
      if (finance) assert.deepEqual(row.financial.payload, primary.payload);
      for (const key of ['payer', 'sale_party_id', 'deduction_policy', 'collection_mode']) assert(!Object.hasOwn(row.schedule, key));
      assert.equal(row.months.length, 12);
      assert.deepEqual(row.months.map(month => [month.billing_month, month.agreed_amount]), Array.from({ length: 12 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 8 + index, 1));
        return [date.toISOString().slice(0, 7), index < 3 ? '300000' : '100000'];
      }));
      cases.push({ role, name: 'customer-read', status: read.status, financial: finance });
    }
    if (['owner', 'manager', 'accountant'].includes(role)) {
      const quote = await call('quote_contract_rent_support_v1', quoteArgs);
      assert.equal(quote.status, 200);
      assert.match(quote.json.quote_hash, /^[a-f0-9]+$/i);
      assert.equal(quote.json.committed_total, '1800000');
      const receipt = await call('read_contract_payout_operation_v1', receiptArgs(f.operation_id));
      assert.equal(receipt.status, 200);
      assert.deepEqual(receipt.json, operations.find(operation => operation.id === f.operation_id).result);
      cases.push({ role, name: 'financial-quote-and-receipt', status: 200 });
    } else {
      await denied('financial-quote', 'quote_contract_rent_support_v1', quoteArgs);
      await denied('financial-receipt', 'read_contract_payout_operation_v1', receiptArgs(f.operation_id));
    }
    await denied('cross-tenant', 'read_contract_rent_support_v1', readArgs(f.cross_organization_id, f.cross_contract_id));
    if (role === 'manager') await denied('outside-building', 'read_contract_rent_support_v1', readArgs(f.organization_id, f.outside_contract_id));
    if (role === 'accountant') {
      // Voucher READ follows the existing building authority; cashbook row and
      // balance access are separate. Do not infer book isolation for vouchers.
      const outside = operations.find(operation => operation.id === f.outside_cashbook_operation_id);
      const receipt = await call('read_contract_payout_operation_v1', receiptArgs(outside.id));
      assert.equal(receipt.status, 200);
      assert.deepEqual(receipt.json, outside.result);
      const ids = outside.result.sources.filter(source => source.voucher_id).map(source => source.voucher_id);
      const detail = await call('read_income_expense_details_v1', { p_organization_id: f.organization_id, p_voucher_ids: ids });
      assert.equal(detail.status, 200);
      assert.deepEqual(detail.json.rows.map(row => row.header.id).sort(), [...ids].sort(), 'same JWT canonical voucher and receipt must share authority');
      const accounts = await request(ctx, session.access_token, `accounts_with_balance?select=id&id=in.(${f.account_id},${f.outside_account_id})`);
      assert.equal(accounts.status, 200);
      assert.deepEqual(accounts.json.map(row => row.id), [f.account_id], 'cashbook RLS must allow primary account and hide outside account');
      const visibility = await call('list_cashbook_visibility_v2', {});
      assert.equal(visibility.status, 200);
      for (const account of [f.account_id, f.outside_account_id]) {
        const row = visibility.json.find(row => row.cashbook_id === account);
        assert(row, 'canonical visibility must explicitly identify the scoped book');
        assert.equal(row.balance_visible, false, 'KNOWER is not a custodian balance permission');
      }
      cases.push({ role, name: 'canonical-voucher-and-receipt-same-building-allowed', status: 200 });
      cases.push({ role, name: 'cashbook-primary-row-allowed-outside-row-hidden', status: 200, primary_id: f.account_id, outside_id: f.outside_account_id, balance_visible: false });
    }
    console.log(`PASS actual JWT read matrix: ${role}`);
  }
  completed = true;
} finally {
  const finalFlag = psqlJson(ctx.test, `SELECT pg_get_functiondef('app_private.rent_support_writers_enabled_v1()'::regprocedure) definition`)[0];
  const writerUnchanged = digest(finalFlag.definition) === digest(baseline.definition);
  writeFileSync(resolve(args[1]), JSON.stringify({ project: TEST_REF, source_sha: f.source_sha, fixture_sha256: digest(fixtureBytes), writer_definition_sha256: digest(finalFlag.definition), writer_unchanged: writerUnchanged, completed: completed && writerUnchanged, cases, at: new Date().toISOString(), limits: ['READ RPC/JWT proof only; no financial writer authorization claim.', 'Voucher/receipt reads follow canonical building scope; only cashbook rows/balance have separate account restrictions.', 'Fixtures are owned by Task10 using original Task8 provisioning and cleanup.'] }, null, 2));
  assert(writerUnchanged, 'runner must leave writer definition unchanged');
}
assert(completed);
