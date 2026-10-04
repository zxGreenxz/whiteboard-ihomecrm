#!/usr/bin/env node
// Real JWT/PostgREST assertions. Administrative APIs are used only for disposable TEST fixtures.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { credential, ketNoi, batBuocDichTest, psql, psqlJson, lit } from './test-env/lib.mjs';

export const migrations = ['supabase/migrations/20261004212309_personal_finance_wallets.sql', 'supabase/migrations/20261004212701_personal_finance_rpc_only.sql'];
const cred = credential(), { test } = await ketNoi(cred);
await batBuocDichTest(cred, test);
assert(cred.testPublishableKey, 'publishable key required for real actor requests');
if (process.argv.includes('--apply')) for (const file of migrations) psql(test, `BEGIN;${readFileSync(file, 'utf8')}COMMIT;`);
const url = `https://${cred.testRef}.supabase.co`, actors = [];
const ORG = 'aaaa0000-0000-4000-8000-000000000001', OTHER = 'dddd0000-0000-4000-8000-000000000001';
let checks = 0;
const check = async (name, fn) => { try { await fn(); checks++; console.log(`PASS ${name}`); } catch (cause) { throw new Error(`FAIL ${name}`, { cause }); } };
const adminHeaders = { apikey: cred.testSecretKey, Authorization: `Bearer ${cred.testSecretKey}`, 'Content-Type': 'application/json' };
async function actor(label, org, memberType = 'STAFF', superAdmin = false) {
 const email = `personal-${label}-${randomBytes(6).toString('hex')}@example.invalid`, password = randomBytes(24).toString('base64url');
 const created = await fetch(`${url}/auth/v1/admin/users`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ email, password, email_confirm: true }) });
 assert.equal(created.status, 200, 'fixture creation');
 const user = await created.json(); actors.push(user.id);
 psql(test, `BEGIN;SET LOCAL session_replication_role=replica;
 INSERT INTO public.organization_memberships(organization_id,user_id,member_type,status,valid_from) VALUES(${lit(org)},${lit(user.id)},${lit(memberType)},'ACTIVE',now()-interval '1 day');
 ${superAdmin ? `INSERT INTO public.super_admins(user_id,organization_id,note) VALUES(${lit(user.id)},${lit(org)},'temporary personal finance harness');` : ''}COMMIT;`);
 const signed = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: cred.testPublishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
 assert.equal(signed.status, 200, 'fixture JWT sign-in'); const session = await signed.json();
 return { id: user.id, jwt: session.access_token };
}
async function rest(actor, path, body, method = body === undefined ? 'GET' : 'POST') {
 const response = await fetch(`${url}/rest/v1/${path}`, { method, signal: AbortSignal.timeout(45000), headers: { apikey: cred.testPublishableKey, ...(actor ? { Authorization: `Bearer ${actor.jwt}` } : {}), 'Content-Type': 'application/json', 'Accept-Profile': 'public', 'Content-Profile': 'public' }, body: body === undefined ? undefined : JSON.stringify(body) });
 const text = await response.text();
 assert(!text || response.headers.get('content-type')?.includes('json'), `PostgREST non-JSON HTTP ${response.status}`);
 return { ok: response.ok, status: response.status, data: text ? JSON.parse(text) : null };
}
async function rpc(actor, name, args = {}) { return rest(actor, `rpc/personal_finance_${name}`, args); }
async function must(actor, name, args = {}) { const r = await rpc(actor, name, args); assert(r.ok, `${name}: HTTP ${r.status} ${r.data?.code ?? ''} ${r.data?.message ?? ''}`); return r.data; }
const mutate = (actor, payload, key = randomUUID()) => must(actor, 'mutate', { p_request_key: key, p_payload: payload });
const create = async (actor, entity, data) => (await mutate(actor, { action: `${entity}.create`, data })).entities[0];
const update = (actor, entity, row, data) => mutate(actor, { action: `${entity}.update`, id: row.id, expected_version: row.version, data });
const remove = (actor, entity, row) => mutate(actor, { action: `${entity}.delete`, id: row.id, expected_version: row.version, data: {} });
const reject = async (actor, payload, marker) => { const r = await rpc(actor, 'mutate', { p_request_key: randomUUID(), p_payload: payload }); assert(!r.ok, marker); return r; };
try {
 const owner = await actor('owner', ORG), same = await actor('same', ORG), other = await actor('other', OTHER), admin = await actor('admin', ORG, 'OWNER'), superAdmin = await actor('super', ORG, 'STAFF', true);
 assert.equal((await rest(superAdmin, 'rpc/is_super_admin', {})).data, true, 'fixture must be a real super admin');
 await must(owner, 'bootstrap'); await must(owner, 'bootstrap'); await must(other, 'bootstrap');
 let snapshot = await must(owner, 'snapshot');
 const wallet = snapshot.wallets[0], expense = snapshot.categories.find(c => c.seed_key === 'food'), income = snapshot.categories.find(c => c.seed_key === 'salary');
 const txn = { type: 'EXPENSE', amount: 12000, txn_date: '2026-10-05', wallet_id: wallet.id, category_id: expense.id, description: 'TEST personal finance' };
 await check('bootstrap: 1 zero wallet, 16 expense + 7 income, no sample money', () => {
  assert.equal(snapshot.wallets.length, 1); assert.equal(wallet.opening_balance, 0); assert.equal(wallet.balance, 0); assert.equal(wallet.name, 'Ví chính');
  assert.equal(snapshot.categories.filter(c => c.type === 'EXPENSE').length, 16); assert.equal(snapshot.categories.filter(c => c.type === 'INCOME').length, 7);
  for (const key of ['transactions', 'transfers', 'goals', 'budgets']) assert.equal(snapshot[key].length, 0);
 });
 const key = randomUUID(), payload = { action: 'transaction.batch', rows: [txn] };
 let receipt;
 await check('idempotency: concurrent same-key creates exactly one row/receipt', async () => {
  const receipts = await Promise.all(Array.from({ length: 8 }, () => mutate(owner, payload, key))); receipt = receipts[0];
  receipts.forEach(r => assert.deepEqual(r, receipt, 'idempotency receipt mismatch'));
  snapshot = await must(owner, 'snapshot'); assert.equal(snapshot.transactions.length, 1, 'idempotency duplicate transaction');
  const requests = await rest(owner, `personal_finance_requests?request_key=eq.${key}`); assert.equal(requests.data.length, 1);
 });
 await check('request key conflict and distinct keys preserve legitimate duplicates', async () => {
  const conflict = await rpc(owner, 'mutate', { p_request_key: key, p_payload: { action: 'transaction.batch', rows: [{ ...txn, amount: 123 }] } }); assert.equal(conflict.data.code, '23505');
  assert.deepEqual(await mutate(owner, payload, key), receipt, 'conflict must preserve original receipt');
  assert.deepEqual(await mutate(owner, { ...payload, rows: [{ ...txn, description: ' TEST personal finance ' }] }, key), receipt, 'normalized whitespace must replay');
  await Promise.all([mutate(owner, payload), mutate(owner, payload)]); assert.equal((await must(owner, 'snapshot')).transactions.length, 3);
 });
 await check('owner isolation: same/different org and org/super admins', async () => {
  for (const who of [same, other, admin, superAdmin]) {
   for (const table of ['personal_transactions', 'personal_wallets', 'personal_categories', 'personal_finance_requests']) {
    const r = await rest(who, `${table}?user_id=eq.${owner.id}`); assert(r.ok); assert.equal(r.data.length, 0, `owner isolation ${table}`);
   }
   const own = await must(who, 'snapshot'); assert.equal(own.owner_id, who.id); assert.equal(own.transactions.length, 0, 'owner isolation snapshot');
   await reject(who, { action: 'transaction.update', id: receipt.entities[0].id, expected_version: 1, data: { amount: 99 } }, 'owner mutation isolation');
  }
 });
 await check('anon/internal ACL and direct DML are denied', async () => {
  for (const who of [null, owner]) {
   const internal = await rpc(who, 'apply', { p_action: 'wallet.create', p_data: { name: 'forbidden' } }); assert(!internal.ok);
  }
  for (const name of ['bootstrap', 'snapshot']) assert(!(await rpc(null, name)).ok);
  for (const table of ['personal_wallets','personal_categories','personal_budget_limits','personal_goals','personal_wallet_transfers','personal_finance_requests','personal_transactions']) {
   assert(!(await rest(null, table)).ok); assert(!(await rest(owner, table, { user_id: owner.id })).ok);
  }
  const policies = psqlJson(test, "select policyname from pg_policies where schemaname='public' and tablename='personal_transactions'").map(r => r.policyname);
  assert(policies.includes('personal_txn_own')); assert(policies.some(p => p.includes('hide_sandbox'))); assert(!policies.includes('personal_transactions_org_boundary'));
 });
 await check('references: cross owner, category type, same wallet and input validation', async () => {
  const foreign = await must(other, 'snapshot');
  for (const patch of [{ wallet_id: foreign.wallets[0].id }, { category_id: foreign.categories[0].id }, { category_id: income.id }, { amount: -1 }, { amount: 1.5 }, { amount: 1.001 }, { txn_date: '2026-02-30' }, { amount: 1e12 + 1 }, { description: 'x'.repeat(501) }]) await reject(owner, { action: 'transaction.batch', rows: [{ ...txn, ...patch }] }, 'invalid transaction accepted');
  await reject(owner, { action: 'transfer.create', data: { source_wallet_id: wallet.id, target_wallet_id: wallet.id, amount: 100, txn_date: txn.txn_date } }, 'transfer same-wallet accepted');
  await reject(owner, { action: 'wallet.create', data: { name: ' ví CHÍNH ' } }, 'duplicate normalized wallet');
  await reject(owner, { action: 'category.create', data: { type: 'EXPENSE', name: ' ĂN UỐNG ' } }, 'duplicate normalized category');
 });
 await check('mixed batch rolls back every row and receipt', async () => {
  const before = (await must(owner, 'snapshot')).transactions.length;
  await reject(owner, { action: 'transaction.batch', rows: [txn, { ...txn, category_id: income.id }] }, 'mixed batch accepted');
  assert.equal((await must(owner, 'snapshot')).transactions.length, before);
  await reject(owner, { action: 'transaction.batch', rows: Array(201).fill(txn) }, 'oversized batch accepted');
  for (const rows of [undefined, null, [], {}]) await reject(owner, { action: 'transaction.batch', rows }, 'missing/invalid batch accepted');
 });
 await check('concurrent update expected-version prevents lost writes; deleted retry replays', async () => {
  const row = receipt.entities[0];
  const attempts = await Promise.all([10, 20].map(amount => rpc(owner, 'mutate', { p_request_key: randomUUID(), p_payload: { action: 'transaction.update', id: row.id, expected_version: 1, data: { amount } } })));
  assert.equal(attempts.filter(r => r.ok).length, 1); assert.equal(attempts.find(r => !r.ok).data.code, 'PT409');
  await remove(owner, 'transaction', attempts.find(r => r.ok).data.entities[0]);
  assert.deepEqual(await mutate(owner, payload, key), receipt); assert.equal((await must(owner, 'snapshot')).transactions.length, 2);
 });
 const saving = await create(owner, 'wallet', { name: 'TEST savings', kind: 'saving', opening_balance: 500 });
 await check('transfer balanced on create/update/delete, hidden wallets preserve total', async () => {
  const balances = (await must(owner, 'snapshot')).wallets;
  const total = rows => rows.reduce((s,w) => s+w.balance, 0);
  let transfer = await create(owner, 'transfer', { source_wallet_id: wallet.id, target_wallet_id: saving.id, amount: 150, txn_date: txn.txn_date });
  let next = await must(owner, 'snapshot'); assert.equal(total(next.wallets), total(balances), 'transfer conservation');
  assert.equal(next.wallets.find(w => w.id === wallet.id).balance, balances.find(w => w.id === wallet.id).balance - 150, 'transfer source debit');
  assert.equal(next.wallets.find(w => w.id === saving.id).balance, 650, 'transfer target credit');
  transfer = (await update(owner, 'transfer', transfer, { amount: 200 })).entities[0];
  assert.equal((await must(owner, 'snapshot')).wallets.find(w => w.id === saving.id).balance, 700);
  await remove(owner, 'transfer', transfer); assert.equal(total((await must(owner, 'snapshot')).wallets), total(balances));
  await update(owner, 'wallet', saving, { hidden: true }); next = await must(owner, 'snapshot'); assert.equal(total(next.wallets), total(balances));
  assert(next.wallets.find(w => w.id === saving.id).hidden);
  await reject(owner, { action: 'wallet.delete', id: saving.id, expected_version: 2, data: {} }, 'historically used wallet delete');
 });
 await check('goals start empty, contributions immutable and correct target only', async () => {
  const goal = await create(owner, 'goal', { name: 'TEST goal', target: 10000, wallet_id: saving.id });
  assert.equal((await must(owner, 'snapshot')).goals.find(g => g.id === goal.id).saved, 0);
  const contribution = await create(owner, 'transfer', { source_wallet_id: wallet.id, target_wallet_id: saving.id, amount: 300, txn_date: txn.txn_date, goal_id: goal.id });
  assert.equal((await must(owner, 'snapshot')).goals.find(g => g.id === goal.id).saved, 300);
  for (const [entity, row, op, data] of [['goal',goal,'delete',{}],['transfer',contribution,'delete',{}],['transfer',contribution,'update',{amount:400}],['goal',goal,'update',{wallet_id:wallet.id}]]) await reject(owner, { action: `${entity}.${op}`, id: row.id, expected_version: row.version, data }, 'goal invariant');
  await reject(owner, { action: 'transfer.create', data: { source_wallet_id: saving.id, target_wallet_id: wallet.id, amount: 1, txn_date: txn.txn_date, goal_id: goal.id } }, 'goal wrong target');
 });
 await check('used/default category delete blocked; hidden references retained; last visible protected', async () => {
  await reject(owner, { action: 'category.delete', id: expense.id, expected_version: 1, data: {} }, 'seed category delete');
  const custom = await create(owner, 'category', { type: 'EXPENSE', name: 'TEST custom' });
  await create(owner, 'budget', { category_id: custom.id, amount: 1000 });
  await reject(owner, { action: 'category.delete', id: custom.id, expected_version: 1, data: {} }, 'budget category delete');
  await mutate(owner, { action: 'transaction.batch', rows: [{ ...txn, category_id: custom.id }] });
  await update(owner, 'category', custom, { hidden: true }); assert.equal((await must(owner, 'snapshot')).transactions.filter(t => t.category_id === custom.id).length, 1);
  const cats = (await must(owner, 'snapshot')).categories.filter(c => c.type === 'INCOME');
  for (const c of cats.slice(0,-1)) await update(owner, 'category', c, { hidden: true });
  await reject(owner, { action: 'category.update', id: cats.at(-1).id, expected_version: 1, data: { hidden: true } }, 'last visible category');
 });
 await check('legacy mapping remains stable after rename and membership loss', async () => {
  const id = randomUUID();
  psql(test, `INSERT INTO public.personal_transactions(id,user_id,type,amount,txn_date,category,organization_id) VALUES(${lit(id)},${lit(owner.id)},'EXPENSE',7,'2026-01-01','Legacy unique',${lit(ORG)});`);
  await must(owner, 'bootstrap'); let snap = await must(owner, 'snapshot'), legacy = snap.transactions.find(t => t.id === id);
  assert.equal(legacy.wallet_id, null); assert.equal(legacy.resolved_wallet_id, wallet.id); assert(legacy.resolved_category_id);
  const category = snap.categories.find(c => c.id === legacy.resolved_category_id); await update(owner, 'category', category, { name: 'Renamed legacy' });
  psql(test, `BEGIN;SET LOCAL session_replication_role=replica;DELETE FROM public.organization_memberships WHERE user_id=${lit(owner.id)};COMMIT;`);
  await must(owner, 'bootstrap'); snap = await must(owner, 'snapshot'); legacy = snap.transactions.find(t => t.id === id);
  assert.equal(legacy.category, 'Legacy unique'); assert.equal(legacy.resolved_category_id, category.id);
  const direct = await rest(owner, `personal_transactions?id=eq.${id}`); assert.equal(direct.data.length, 1);
  await mutate(owner, { action: 'transaction.batch', rows: [txn] });
 });
 await check('historical long/blank/null labels, decimals, old dates survive bootstrap', async () => {
  const labels = ['X'.repeat(300), '   ', '', null], ids = labels.map(() => randomUUID());
  for (let i = 0; i < labels.length; i++) psql(test, `INSERT INTO public.personal_transactions(id,user_id,type,amount,txn_date,category,description) VALUES(${lit(ids[i])},${lit(owner.id)},'INCOME',12.25,'1800-01-01',${labels[i] === null ? 'NULL' : lit(labels[i])},${lit('long description '.repeat(100))});`);
  await must(owner,'bootstrap'); const first = await must(owner,'snapshot'); await must(owner,'bootstrap'); const again = await must(owner,'snapshot');
  for (let i = 0; i < labels.length; i++) {
   const row = again.transactions.find(t => t.id === ids[i]); assert.equal(row.category,labels[i]); assert.equal(row.amount,12.25); assert.equal(row.txn_date,'1800-01-01');
   assert.equal(row.resolved_category_id,first.transactions.find(t => t.id === ids[i]).resolved_category_id);
   if (labels[i] !== null) assert(row.resolved_category_id);
  }
 });
 await check('unused CRUD, stale delete, global/category budget independence and ewallet', async () => {
  const unused = await create(owner,'wallet',{name:'Unused',kind:'ewallet'});
  const updated = (await update(owner,'wallet',unused,{name:'Unused renamed'})).entities[0];
  await reject(owner,{action:'wallet.delete',id:unused.id,expected_version:1,data:{}},'stale wallet delete'); await remove(owner,'wallet',updated);
  const category = await create(owner,'category',{name:'Unused category',type:'EXPENSE'}); await remove(owner,'category',category);
  const goal = await create(owner,'goal',{name:'Unused goal',wallet_id:wallet.id,target:200}); await remove(owner,'goal',goal);
  const budget = await create(owner,'budget',{amount:10000}); assert.equal(budget.category_id,null);
  const snap = await must(owner,'snapshot'); assert.equal(snap.budgets.length,2,'global and category budget independent');
  await reject(owner,{action:'budget.create',data:{amount:10001}},'duplicate global budget');
  const changed = (await update(owner,'budget',budget,{amount:11000})).entities[0]; await remove(owner,'budget',changed);
 });
 await check('snapshot >1000 exact rows and balances (no REST cap)', async () => {
  const before = await must(owner, 'snapshot');
  for (let i = 0; i < 6; i++) await mutate(owner, { action: 'transaction.batch', rows: Array(200).fill({ ...txn, amount: 1 }) });
  const after = await must(owner, 'snapshot'); assert.equal(after.transactions.length, before.transactions.length + 1200);
  assert.equal(after.wallets.find(w => w.id === wallet.id).balance, before.wallets.find(w => w.id === wallet.id).balance - 1200);
 });
 console.log(`PERSONAL FINANCE: ${checks} checks PASS (5 real JWT actors; fixtures cleaned in finally)`);
} finally {
 if (actors.length) {
  const ids = actors.map(lit).join(',');
  psql(test, `BEGIN;SET LOCAL session_replication_role=replica;DELETE FROM public.organization_memberships WHERE user_id IN (${ids});DELETE FROM public.user_roles WHERE user_id IN (${ids});DELETE FROM public.super_admins WHERE user_id IN (${ids});COMMIT;`);
  for (const id of actors) {
   const r = await fetch(`${url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders }); assert(r.ok, `fixture cleanup HTTP ${r.status}`);
  }
  assert.equal(psqlJson(test, `select count(*)::int n from public.personal_finance_requests where user_id in (${ids})`)[0].n, 0, 'cleanup receipts');
  console.log(`CLEANUP ${actors.length} disposable accounts`);
 }
}
