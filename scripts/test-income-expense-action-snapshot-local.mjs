#!/usr/bin/env node
// Disposable loopback only. Setup/cleanup use postgres; every capability call uses authenticated JWT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
const db = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:55488/postgres' });
const org = randomUUID(), otherOrg = randomUUID(), building = randomUUID(), otherBuilding = randomUUID();
const profitId = randomUUID(), shareholderId = randomUUID();
const capabilityRoom = randomUUID(), capabilityContract = randomUUID();
const actors = Object.fromEntries(['owner', 'approver', 'custodian', 'salary', 'profit', 'shareholder', 'outsider'].map(key => [key, randomUUID()]));
const members = {}, vouchers = [], accounts = [], scopes = [], overrides = [], bindings = [], seededPermissions = [];
const fixture = async fn => { await db.query('BEGIN'); try { await db.query('SET LOCAL session_replication_role=replica'); await fn(); await db.query('COMMIT'); } catch (error) { await db.query('ROLLBACK'); throw error; } };
function jwt(actor) {
  const secret = fs.readFileSync('.superpowers/sdd/2026-09-20-hop-dong-quyet-toan/postgrest.conf', 'utf8').match(/jwt-secret = "([^"]+)"/)[1];
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ role: 'authenticated', sub: actor, exp: Math.floor(Date.now() / 1000) + 600 });
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}
async function rpc(name, args, actor = actors.approver) {
  const response = await fetch('http://127.0.0.1:55489/rpc/' + name, { method: 'POST', headers: { Authorization: 'Bearer ' + jwt(actor), 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  return { status: response.status, body: await response.json() };
}
const read = (ids, actor = actors.approver, organizationId = org) => rpc('read_income_expense_action_snapshots_v1', { p_organization_id: organizationId, p_voucher_ids: ids }, actor);
function ok(result) { assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; }
async function account({ future = false, finite = false, expired = false } = {}) {
  const id = randomUUID(), binding = randomUUID(); accounts.push(id); bindings.push(binding);
  await fixture(async () => {
    await db.query("INSERT INTO public.accounts(id,user_id,organization_id,name,code,initial_amount,is_virtual) VALUES($1,$2,$3,'T4A book',$4,0,false)", [id, actors.owner, org, 'T4A-' + id]);
    await db.query(`INSERT INTO public.cashbook_possession_bindings(id,organization_id,cashbook_id,membership_id,possession_kind,valid_from,valid_to)
      VALUES($1,$2,$3,$4,'CUSTODIAN',now()+$5::interval,CASE WHEN $6::interval IS NULL THEN NULL ELSE now()+$6::interval END)`, [binding, org, id, members.custodian, future ? '1 day' : '-1 day', finite ? '1 day' : expired ? '-1 hour' : null]);
  }); return id;
}
async function voucher({ actor = actors.owner, accountId = null, buildingId = building, salary = null, profit = null, shareholder = null, flow = null, restricted = false } = {}) {
  const id = randomUUID(); vouchers.push(id);
  await fixture(async () => {
    await db.query(`INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,account_id,salary_staff_id,profit_manager_id,shareholder_id,has_restricted_item)
      VALUES($1,$2,$3,$4,'EXPENSE','T4A snapshot',$5,current_date,2640000,'UNAPPROVED','CASHBOOK','UNPOSTED','PENDING',5,3,4,$6,$7,$8,$9,$10)`, [id, actor, org, buildingId, 'T4A-' + id, accountId, salary, profit, shareholder, restricted]);
    if (flow) await db.query(`INSERT INTO app_private.income_expense_flow_ownership(income_expense_id,organization_id,flow_kind,writer_operation,payload_hash_value,maker_user_id,claimed_by_user_id) VALUES($1,$2,$3,'T4A_FIXTURE',md5('test'),$4,$4)`, [id, org, flow, actor]);
  }); return id;
}
async function authSql(sql, actor = actors.approver) {
  await db.query('BEGIN'); try { await db.query('SET LOCAL SESSION AUTHORIZATION authenticated'); await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'authenticated', sub: actor })]); return await db.query(sql); } finally { await db.query('ROLLBACK'); }
}
await db.connect();
try {
  if (process.argv.includes('--apply-migration')) await db.query(fs.readFileSync('supabase/migrations/20260920192452_shared_income_expense_action_snapshot.sql', 'utf8'));
  await fixture(async () => {
    for (const id of [org, otherOrg]) await db.query("INSERT INTO public.organizations(id,slug,name,status) VALUES($1,$2,'T4A disposable','ACTIVE')", [id, 't4a-' + id]);
    for (const [name, actor] of Object.entries(actors)) {
      await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, 't4a-' + actor + '@example.invalid']);
      members[name] = randomUUID(); await db.query("INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status) VALUES($1,$2,$3,'STAFF','ACTIVE')", [members[name], name === 'outsider' ? otherOrg : org, actor]);
    }
    for (const id of [building, otherBuilding]) await db.query("INSERT INTO public.buildings(id,user_id,organization_id,name,province,district,ward) VALUES($1,$2,$3,'T4A local','','','')", [id, actors.owner, org]);
    await db.query("INSERT INTO public.profit_managers(id,user_id,organization_id,auth_user_id,name) VALUES($1,$2,$3,$4,'T4A profit')", [profitId, actors.owner, org, actors.profit]);
    await db.query("INSERT INTO public.shareholders(id,user_id,organization_id,auth_user_id,name) VALUES($1,$2,$3,$4,'T4A shareholder')", [shareholderId, actors.owner, org, actors.shareholder]);
    const scope = randomUUID(); scopes.push(scope); await db.query("INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,'BUILDING',$3)", [scope, org, building]);
    for (const key of ['buildings.view', 'income_expenses.approve', 'income_expenses.reverse']) {
      const [resource, action] = key.split('.');
      const added = await db.query("INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES($1,$2,$3,$4,'TENANT',ARRAY['ORGANIZATION','AREA','BUILDING','CASHBOOK'],true) ON CONFLICT(key) DO NOTHING RETURNING key", [key, resource, action, action === 'view' ? 'VIEW' : 'ELEVATED']);
      if (added.rowCount) seededPermissions.push(key);
    }
    for (const key of ['buildings.view', 'income_expenses.approve']) {
      const id = randomUUID(); overrides.push(id); await db.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,$4,'ALLOW','T4A local',$5,'SCOPED')", [id, org, members.approver, key, actors.owner]);
      await db.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)', [org, id, scope]);
    }
  });
  const validBook = await account(), futureBook = await account({ future: true }), finiteBook = await account({ finite: true }), expiredBook = await account({ expired: true });
  const books = ok(await rpc('list_cashbooks_for_expense_v2', {}, actors.custodian)).map(row => row.id);
  assert.ok(books.includes(validBook)); assert.ok(books.includes(finiteBook), 'currently active finite custody is usable');
  assert.ok(!books.includes(futureBook), 'future custody must not authorize posting'); assert.ok(!books.includes(expiredBook));
  const visible = await voucher({ flow: 'CANONICAL_INCOME_EXPENSE' }), hidden = await voucher({ buildingId: otherBuilding });
  const before = (await db.query('SELECT to_jsonb(v) value FROM public.income_expenses v WHERE id=$1', [visible])).rows[0].value;
  const result = ok(await read([visible, hidden, randomUUID()])); assert.deepEqual(result.rows.map(row => row.id), [visible], 'snapshot must preserve authenticated RLS visibility');
  assert.equal(result.actorId, actors.approver); assert.equal(result.organizationId, org); assert.equal(result.rows[0].flowKind, 'CANONICAL_INCOME_EXPENSE');
  assert.equal(result.rows[0].approvalVersion, 3); assert.equal(result.rows[0].postingVersion, 4); assert.equal(result.rows[0].reviewVersion, 5);
  if (process.argv.includes('--capabilities')) {
    assert.equal(result.rows[0].capabilities.forfeitPair, false);
    assert.equal(result.rows[0].capabilities.birthPrior, false);
    assert.equal(result.rows[0].capabilities.manual, true);
    assert.equal(result.rows[0].capabilities.legacyCancelAllowed, false);
    assert.equal(result.rows[0].capabilities.compatCancelOwner, false);
    await assert.rejects(authSql(`SELECT app_private.income_expense_action_capabilities_v1('${visible}','${org}')`), error => error.code === '42501');
  }
  assert.equal(result.rows[0].permissions.approve, true); assert.equal(result.rows[0].birthState, 'MISSING');
  assert.deepEqual((await db.query('SELECT to_jsonb(v) value FROM public.income_expenses v WHERE id=$1', [visible])).rows[0].value, before, 'snapshot cannot stamp birth or mutate voucher');
  const custodyVoucher = await voucher({ accountId: validBook, buildingId: otherBuilding });
  assert.deepEqual(ok(await read([custodyVoucher], actors.custodian)).rows.map(row => row.id), [custodyVoucher], 'RLS custody read does not require building scope');
  const salaryVoucher = await voucher({ salary: actors.salary, buildingId: otherBuilding });
  assert.deepEqual(ok(await read([salaryVoucher], actors.salary)).rows.map(row => row.id), [salaryVoucher]);
  const profitVoucher = await voucher({ profit: profitId, buildingId: otherBuilding });
  const shareholderVoucher = await voucher({ shareholder: shareholderId, buildingId: otherBuilding });
  assert.deepEqual(ok(await read([profitVoucher], actors.profit)).rows.map(row => row.id), [profitVoucher]);
  assert.deepEqual(ok(await read([shareholderVoucher], actors.shareholder)).rows.map(row => row.id), [shareholderVoucher]);
  // Compare the complete requested-ID result with the real base-table RLS, rather than a duplicated policy fixture.
  for (const actor of [actors.approver, actors.custodian, actors.salary, actors.profit, actors.shareholder]) {
    const direct = await authSql(`SELECT id FROM public.income_expenses WHERE organization_id='${org}' ORDER BY id`, actor);
    assert.deepEqual(ok(await read(vouchers, actor)).rows.map(row => row.id), direct.rows.map(row => row.id));
  }
  const restricted = await voucher({ restricted: true }); assert.equal(ok(await read([restricted])).rows.length, 0);
  assert.equal((await read([visible], actors.outsider)).status, 403);
  assert.equal((await read([visible], actors.approver, otherOrg)).status, 403);
  assert.equal((await read(Array.from({ length: 201 }, randomUUID))).status, 400);
  const committed = await voucher({ flow: 'CANONICAL_INCOME_EXPENSE' });
  await fixture(async () => {
    await db.query("UPDATE public.income_expenses SET birth_operation_id=id,birth_txid=pg_current_xact_id(),source_payload_hash=md5('T4A birth') WHERE id=$1", [committed]);
    await db.query(`INSERT INTO app_private.canonical_write_operations(organization_id,operation,subject_scope,actor_id,idempotency_key,payload_hash,subject_id,completed_at,transaction_id,response_payload)
      VALUES($1,'income_expense.create.v2',$2::uuid::text,$3,$4,md5('T4A birth'),$2::uuid,now(),pg_current_xact_id(),'{}')`, [org, committed, actors.owner, randomUUID()]);
  });
  assert.equal(ok(await read([committed])).rows[0].birthState, 'COMMITTED');
  if (process.argv.includes('--capabilities')) {
    assert.equal(ok(await read([committed])).rows[0].capabilities.birthPrior, true);
    const own = await voucher({ actor: actors.approver });
    assert.equal(ok(await read([own])).rows[0].capabilities.compatCancelOwner, true, 'actual legacy creator authority');
    const reservation = await voucher();
    await fixture(() => db.query("UPDATE public.income_expenses SET system_source='reservation.refund' WHERE id=$1", [reservation]));
    const reservationCaps = ok(await read([reservation])).rows[0].capabilities;
    assert.equal(reservationCaps.reservationMoneyBlocked, true); assert.equal(reservationCaps.reservationRefundReverseAllowed, false, 'source label alone cannot authorize refund reverse');
    const offset = await voucher({ flow: 'TERMINATION_FORFEIT' });
    await fixture(async () => {
      await db.query("INSERT INTO public.rooms(id,organization_id,building_id,name,rent_price,deposit_amount) VALUES($1,$2,$3,'T4B capability',1,1)", [capabilityRoom, org, building]);
      await db.query("INSERT INTO public.contracts(id,user_id,organization_id,room_id,signed_date,start_date,end_date,rent_price,public_code) VALUES($1,$2,$3,$4,current_date,current_date,current_date+30,1,$5)", [capabilityContract, actors.owner, org, capabilityRoom, 'T4B-' + capabilityContract]);
      await db.query("INSERT INTO app_private.termination_forfeit_authorizations(revenue_voucher_id,offset_voucher_id,organization_id,contract_id,invoice_id,account_id,amount,voucher_date,authorization_source) VALUES($1,$2,$3,$4,$5,$6,1,current_date,'TERMINATION_WRITER')", [visible, offset, org, capabilityContract, randomUUID(), validBook]);
    });
    let pairCaps = ok(await read([visible])).rows[0].capabilities;
    assert.equal(pairCaps.forfeitPair, true); assert.equal(pairCaps.forfeitAllowed, true); assert.equal(pairCaps.engineBlocked, false);
    await fixture(() => db.query("UPDATE public.rooms SET building_id=$1 WHERE id=$2", [otherBuilding, capabilityRoom]));
    assert.equal(ok(await read([visible])).rows[0].capabilities.forfeitAllowed, false, 'pair writer uses contract room, not voucher building');
    await fixture(async () => {
      await db.query("UPDATE public.rooms SET building_id=$1 WHERE id=$2", [building, capabilityRoom]);
      await db.query("INSERT INTO public.approval_requests(organization_id,subject_type,subject_id,state,maker_membership_id,maker_user_id,rule_set_id,rule_set_version,matched_rule_id,rule_effect,payload_snapshot,payload_hash,amount) VALUES($1,'FINANCIAL_VOUCHER',$2,'PENDING_APPROVAL',$3,$4,$5,1,$6,'REQUIRE_APPROVAL','{}',md5('T4B'),1)", [org, offset, members.owner, actors.owner, randomUUID(), randomUUID()]);
    });
    pairCaps = ok(await read([visible])).rows[0].capabilities;
    assert.equal(pairCaps.engineBlocked, true, 'engine lock on either leg blocks shared pair actions');
    console.log('PASS T4B JWT capabilities: creator authority, actual forfeit contract scope, opposite-leg engine lock, birth preservation and reservation source guard');
  }
  await fixture(() => db.query("UPDATE app_private.canonical_write_operations SET payload_hash=md5('wrong') WHERE subject_id=$1", [committed]));
  assert.equal(ok(await read([committed])).rows[0].birthState, 'INVALID');
  await fixture(() => db.query("UPDATE public.organizations SET status='SUSPENDED' WHERE id=$1", [org]));
  assert.equal((await read([visible])).status, 403);
  assert.equal(ok(await rpc('list_cashbooks_for_expense_v2', {}, actors.custodian)).length, 0);
  await fixture(() => db.query("UPDATE public.organizations SET status='ACTIVE' WHERE id=$1", [org]));
  await fixture(() => db.query("UPDATE public.organization_memberships SET valid_from=now()+interval '1 day' WHERE id=$1", [members.approver]));
  assert.equal((await read([visible])).status, 403);
  await fixture(() => db.query("UPDATE public.organization_memberships SET valid_from=now()-interval '1 day' WHERE id=$1", [members.approver]));
  await fixture(() => db.query("UPDATE public.member_permission_overrides SET effect='DENY' WHERE id=$1", [overrides[1]]));
  assert.equal(ok(await read([visible])).rows[0].permissions.approve, false, 'revoked/denied approval is reflected on next read');
  await fixture(async () => {
    const scope = randomUUID(), override = randomUUID(); scopes.push(scope); overrides.push(override);
    await db.query("INSERT INTO public.authorization_scopes(id,organization_id,scope_type,cashbook_id) VALUES($1,$2,'CASHBOOK',$3)", [scope, org, validBook]);
    await db.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,'income_expenses.reverse','DENY','T4A deny',$4,'SCOPED')", [override, org, members.custodian, actors.owner]);
    await db.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)', [org, override, scope]);
  });
  assert.ok(!ok(await rpc('list_cashbooks_for_expense_v2', {}, actors.custodian)).some(row => row.id === validBook), 'covering DENY wins over custody');
  await fixture(() => db.query("UPDATE public.organization_memberships SET valid_from=now()-interval '1 day',valid_to=now()-interval '1 minute' WHERE id=$1", [members.custodian]));
  assert.equal(ok(await rpc('list_cashbooks_for_expense_v2', {}, actors.custodian)).length, 0);
  await assert.rejects(authSql('SET ROLE ie_action_snapshot_reader'), error => error.code === '42501');
  await assert.rejects(authSql('SELECT flow_kind FROM app_private.income_expense_flow_ownership'), error => error.code === '42501');
  await assert.rejects(authSql(`SELECT app_private.income_expense_action_scope_v1('${org}')`), error => error.code === '42501');
  console.log('PASS T4A JWT: exact RLS scope, active org/member/custody, private owner, actual CAS, no mutation, denials and ACL');
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  await fixture(async () => {
    await db.query('DELETE FROM public.approval_requests WHERE organization_id=$1', [org]);
    await db.query('DELETE FROM app_private.termination_forfeit_authorizations WHERE organization_id=$1', [org]);
    await db.query('DELETE FROM public.contracts WHERE id=$1', [capabilityContract]);
    await db.query('DELETE FROM public.rooms WHERE id=$1', [capabilityRoom]);
    await db.query('DELETE FROM app_private.income_expense_flow_ownership WHERE organization_id=$1', [org]);
    await db.query('DELETE FROM app_private.canonical_write_operations WHERE organization_id=$1', [org]);
    await db.query('DELETE FROM public.income_expenses WHERE id=ANY($1::uuid[])', [vouchers]);
    await db.query('DELETE FROM public.cashbook_possession_bindings WHERE id=ANY($1::uuid[])', [bindings]);
    await db.query('DELETE FROM public.accounts WHERE id=ANY($1::uuid[])', [accounts]);
    await db.query('DELETE FROM public.member_override_scopes WHERE organization_id=$1', [org]);
    await db.query('DELETE FROM public.member_permission_overrides WHERE id=ANY($1::uuid[])', [overrides]);
    await db.query('DELETE FROM public.authorization_scopes WHERE id=ANY($1::uuid[])', [scopes]);
    await db.query('DELETE FROM public.buildings WHERE id=ANY($1::uuid[])', [[building, otherBuilding]]);
    await db.query('DELETE FROM public.profit_managers WHERE id=$1', [profitId]);
    await db.query('DELETE FROM public.shareholders WHERE id=$1', [shareholderId]);
    await db.query('DELETE FROM public.organization_memberships WHERE id=ANY($1::uuid[])', [Object.values(members)]);
    await db.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [Object.values(actors)]);
    await db.query('DELETE FROM public.organizations WHERE id=ANY($1::uuid[])', [[org, otherOrg]]);
    await db.query('DELETE FROM public.permission_definitions WHERE key=ANY($1::text[])', [seededPermissions]);
  }); await db.end();
}
