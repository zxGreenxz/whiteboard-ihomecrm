#!/usr/bin/env node
// Disposable loopback database only. Fixture setup/cleanup is privileged; all writer calls use authenticated JWT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
const db = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:55488/settlement_t7' });
const org = randomUUID(), foreignOrg = randomUUID(), building = randomUUID(), hiddenBuilding = randomUUID();
const category = randomUUID();
const actors = Object.fromEntries(['editor', 'approver', 'none', 'outsider'].map(name => [name, randomUUID()]));
const members = {}, vouchers = [], overrides = [], scopes = [], addedPermissions = [];
const expected = { payerName: 'Recipient', bankName: 'ACB', bankAccount: '00123', approvalVersion: 3, postingVersion: 4, reviewVersion: 5 };
const fixture = async fn => { await db.query('BEGIN'); try { await db.query('SET LOCAL session_replication_role=replica'); await fn(); await db.query('COMMIT'); } catch (error) { await db.query('ROLLBACK'); throw error; } };
function jwt(actor) {
  const secret = fs.readFileSync('.superpowers/sdd/2026-09-20-hop-dong-quyet-toan/postgrest-t7.conf', 'utf8').match(/jwt-secret = "([^"]+)"/)[1];
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ role: 'authenticated', sub: actor, exp: Math.floor(Date.now() / 1000) + 600 });
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}
async function rpc(id, patch, actor = actors.editor, extra = {}) {
  const response = await fetch('http://127.0.0.1:55490/rpc/update_income_expense_recipient_v1', { method: 'POST', headers: { Authorization: 'Bearer ' + jwt(actor), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_organization_id: org, p_voucher_id: id, p_expected: expected, p_patch: patch, ...extra }) });
  return { status: response.status, body: await response.json() };
}
async function voucher({ approval = 'UNAPPROVED', scope = building, flow = null } = {}) {
  const id = randomUUID(); vouchers.push(id);
  await fixture(async () => {
    await db.query(`INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,type,name,code,voucher_date,total_amount,kqkd_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,payer_name,receive_bank_name,receive_bank_account)
      VALUES($1,$2,$3,$4,'EXPENSE','Recipient fixture',$5,current_date,2640000,2640000,$6,'CASHBOOK','UNPOSTED','CHANGES_REQUESTED',5,3,4,'Recipient','ACB','00123')`, [id, actors.none, org, scope, 'T5-' + id, approval]);
    if (flow) await db.query(`INSERT INTO app_private.income_expense_flow_ownership(income_expense_id,organization_id,flow_kind,writer_operation,payload_hash_value,maker_user_id,claimed_by_user_id) VALUES($1,$2,$3,'T5_FIXTURE',md5('test'),$4,$4)`, [id, org, flow, actors.none]);
    await db.query(`INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,quantity,unit_price,accounting_class,description)
      VALUES($1,$2,1,1000000,'PNL','Line A'),($1,$2,2,820000,'PNL','Line B')`, [id, category]);
  }); return id;
}
await db.connect();
try {
  if (process.argv.includes('--apply-migration')) { await db.query(fs.readFileSync('supabase/migrations/20260920235823_shared_voucher_recipient_sparse_update.sql', 'utf8')); await db.query("NOTIFY pgrst, 'reload schema'"); await new Promise(resolve => setTimeout(resolve, 1000)); }
  await fixture(async () => {
    for (const id of [org, foreignOrg]) await db.query("INSERT INTO public.organizations(id,slug,name,status) VALUES($1,$2,'T5 disposable','ACTIVE')", [id, 't5-' + id]);
    for (const [name, actor] of Object.entries(actors)) {
      await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, 't5-' + actor + '@example.invalid']);
      members[name] = randomUUID(); await db.query("INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status) VALUES($1,$2,$3,'STAFF','ACTIVE')", [members[name], name === 'outsider' ? foreignOrg : org, actor]);
    }
    for (const id of [building, hiddenBuilding]) await db.query("INSERT INTO public.buildings(id,user_id,organization_id,name,province,district,ward) VALUES($1,$2,$3,'T5 local','','','')", [id, actors.none, org]);
    await db.query("INSERT INTO public.income_expense_types(id,user_id,organization_id,name,type) VALUES($1,$2,$3,'T5 category','expense')", [category, actors.none, org]);
    const scope = randomUUID(); scopes.push(scope); await db.query("INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,'BUILDING',$3)", [scope, org, building]);
    for (const key of ['buildings.view', 'income_expenses.edit', 'income_expenses.approve']) {
      const [resource, action] = key.split('.');
      const added = await db.query("INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES($1,$2,$3,$4,'TENANT',ARRAY['ORGANIZATION','AREA','BUILDING','CASHBOOK'],true) ON CONFLICT(key) DO NOTHING RETURNING key", [key, resource, action, action === 'view' ? 'VIEW' : 'ELEVATED']);
      if (added.rowCount) addedPermissions.push(key);
    }
    for (const name of ['editor', 'approver']) for (const key of ['buildings.view', name === 'editor' ? 'income_expenses.edit' : 'income_expenses.approve']) {
      const id = randomUUID(); overrides.push(id); await db.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,$4,'ALLOW','T5 local',$5,'SCOPED')", [id, org, members[name], key, actors.none]);
      await db.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)', [org, id, scope]);
    }
  });
  const id = await voucher();
  const before = (await db.query('SELECT to_jsonb(v) value FROM public.income_expenses v WHERE id=$1', [id])).rows[0].value;
  const itemsBefore = (await db.query('SELECT to_jsonb(i) value FROM public.income_expense_items i WHERE income_expense_id=$1 ORDER BY id', [id])).rows;
  const updated = await rpc(id, { payerName: 'New recipient' });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body, { voucherId: id, organizationId: org, recipient: { payerName: 'New recipient', bankName: 'ACB', bankAccount: '00123' } });
  const after = (await db.query('SELECT to_jsonb(v) value FROM public.income_expenses v WHERE id=$1', [id])).rows[0].value;
  assert.equal(after.birth_operation_id, id, 'existing legacy birth bridge remains in shared writer');
  assert.ok(after.source_payload_hash && after.birth_txid);
  for (const key of ['payer_name', 'updated_at', 'birth_operation_id', 'birth_txid', 'source_payload_hash']) { delete before[key]; delete after[key]; }
  assert.deepEqual(after, before, 'sparse recipient must preserve amount, source, account, review and untouched bank fields');
  assert.equal(itemsBefore.length, 2);
  assert.deepEqual((await db.query('SELECT to_jsonb(i) value FROM public.income_expense_items i WHERE income_expense_id=$1 ORDER BY id', [id])).rows, itemsBefore, 'item identities and full content preserved');
  assert.equal((await rpc(id, { payerName: 'Lost update' })).body.code, '40001', 'stale expected recipient must reject');
  for (const key of ['approvalVersion', 'postingVersion', 'reviewVersion']) assert.equal((await rpc(await voucher(), { payerName: 'Stale version' }, actors.editor,
    { p_expected: { ...expected, [key]: expected[key] - 1 } })).body.code, '40001', key + ' alone must reject');
  for (const actor of [actors.approver, actors.none, actors.outsider]) assert.equal((await rpc(await voucher(), { payerName: 'Denied' }, actor)).status, 403);
  assert.equal((await rpc(await voucher({ scope: hiddenBuilding }), { payerName: 'Denied' })).status, 403);
  assert.equal((await rpc(await voucher(), { payerName: 'Denied' }, actors.editor, { p_organization_id: foreignOrg })).status, 403);
  assert.equal((await rpc(await voucher(), { total_amount: 1 })).status, 400);
  assert.equal((await rpc(await voucher(), {})).status, 400);
  assert.equal((await rpc(await voucher({ approval: 'APPROVED' }), { payerName: 'Denied' })).body.code, '55000');
  for (const flow of ['CANONICAL_INCOME_EXPENSE', 'TERMINATION_REFUND']) assert.equal((await rpc(await voucher({ flow }), { payerName: 'Denied' })).body.code, '55000');
  const concurrent = await voucher();
  const race = await Promise.all([rpc(concurrent, { bankAccount: '111' }), rpc(concurrent, { bankAccount: '222' })]);
  assert.deepEqual(race.map(x => x.status === 200 ? 'success' : x.body.code).sort(), ['40001', 'success'], 'one CAS winner');
  const logs = await db.query("SELECT count(*)::int n FROM app_private.finance_v2_semantic_event_log WHERE organization_id=$1 AND event_kind='COMPAT_UPDATE'", [org]);
  assert.equal(logs.rows[0].n, 2, 'only confirmed sparse writes emit shared audit');
  console.log('T5 authenticated JWT sparse recipient, preservation, CAS/concurrency, role/scope/freeze denial PASS');
} finally {
  await fixture(async () => {
    await db.query('DELETE FROM app_private.finance_v2_semantic_event_log WHERE organization_id=ANY($1::uuid[])', [[org, foreignOrg]]);
    await db.query('DELETE FROM app_private.canonical_write_operations WHERE organization_id=ANY($1::uuid[])', [[org, foreignOrg]]);
    await db.query('DELETE FROM app_private.income_expense_change_log WHERE income_expense_id=ANY($1::uuid[])', [vouchers]);
    await db.query('DELETE FROM app_private.income_expense_flow_ownership WHERE income_expense_id=ANY($1::uuid[])', [vouchers]);
    await db.query('DELETE FROM public.income_expense_items WHERE income_expense_id=ANY($1::uuid[])', [vouchers]);
    await db.query('DELETE FROM public.income_expenses WHERE id=ANY($1::uuid[])', [vouchers]);
    await db.query('DELETE FROM public.income_expense_types WHERE id=$1', [category]);
    await db.query('DELETE FROM public.member_override_scopes WHERE override_id=ANY($1::uuid[])', [overrides]);
    await db.query('DELETE FROM public.member_permission_overrides WHERE id=ANY($1::uuid[])', [overrides]);
    await db.query('DELETE FROM public.authorization_scopes WHERE id=ANY($1::uuid[])', [scopes]);
    await db.query('DELETE FROM public.buildings WHERE id=ANY($1::uuid[])', [[building, hiddenBuilding]]);
    await db.query('DELETE FROM public.organization_memberships WHERE id=ANY($1::uuid[])', [Object.values(members)]);
    await db.query('DELETE FROM public.organizations WHERE id=ANY($1::uuid[])', [[org, foreignOrg]]);
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [Object.values(actors)]);
    await db.query('DELETE FROM public.permission_definitions WHERE key=ANY($1::text[])', [addedPermissions]);
  });
  await db.end();
}
