/** Tests the actual review RPCs as authenticated JWT actors on the disposable loopback runtime. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
const root = '.superpowers/sdd/2026-09-20-hop-dong-quyet-toan';
const db = new pg.Client({ connectionString: 'postgresql://postgres@127.0.0.1:55488/postgres' });
const org = randomUUID(), otherOrg = randomUUID(), building = randomUUID(), otherBuilding = randomUUID(), account = randomUUID();
const actors = Object.fromEntries(['owner', 'maker', 'editor', 'approver', 'viewer', 'outsider'].map(key => [key, randomUUID()]));
const memberships = {}, overrides = [], seededPermissions = [], vouchers = [], itemSnapshots = new Map();
const token = actor => {
  const secret = fs.readFileSync(root + '/postgrest.conf', 'utf8').match(/jwt-secret = "([^"]+)"/)[1];
  const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ role: 'authenticated', sub: actor, exp: Math.floor(Date.now() / 1000) + 600 });
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
};
async function rpc(name, args, actor = actors.editor) {
  const response = await fetch('http://127.0.0.1:55489/rpc/' + name, { method: 'POST', headers: { Authorization: 'Bearer ' + token(actor), 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  return { status: response.status, body: await response.json() };
}
const submit = (id, version, actor = actors.editor, key = randomUUID(), patch = {}) => rpc('resubmit_income_expense_v2', { p_voucher: id, p_expected_review_version: version, p_patch: patch, p_idempotency_key: key }, actor);
const request = (id, version, actor = actors.approver, key = randomUUID()) => rpc('request_income_expense_changes_v2', { p_voucher: id, p_expected_review_version: version, p_reason: 'Kiểm tra chứng từ người nhận', p_field_mask: ['receive_bank_account'], p_idempotency_key: key }, actor);
async function fixtureWrite(fn) { await db.query('BEGIN'); try { await db.query('SET LOCAL session_replication_role=replica'); const result = await fn(); await db.query('COMMIT'); return result; } catch (error) { await db.query('ROLLBACK'); throw error; } }
async function voucher({ maker = null, flow = null, source = null, kind = null, state = 'CHANGES_REQUESTED', buildingId = building, restricted = false, approval = 'UNAPPROVED', posting = 'UNPOSTED', noncash = false, existingBirth = false, activePosting = null } = {}) {
  const id = randomUUID(); vouchers.push(id);
  await fixtureWrite(async () => {
    await db.query(`INSERT INTO public.income_expenses(id,user_id,organization_id,building_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state,review_version,approval_version,posting_version,maker_user_id,change_field_mask,account_id,system_source,commission_kind,has_restricted_item)
      VALUES($1,$2,$3,$4,'EXPENSE','T3 review',$5,current_date,2640000,$6,'CASHBOOK',$7,$8,1,3,4,$9,'["notes"]',$10,$11,$12,$13)`, [id, actors.owner, org, buildingId, 'T3-' + id, approval, posting, state, maker, account, source, kind, restricted]);
    if (flow) await db.query(`INSERT INTO app_private.income_expense_flow_ownership(income_expense_id,organization_id,flow_kind,writer_operation,payload_hash_value,maker_user_id,claimed_by_user_id)
      VALUES($1,$2,$3,'T3_FIXTURE',md5('t3'),$4,$4)`, [id, org, flow, maker ?? actors.owner]);
    // Fixture-only historical item; generated FK identity is never used outside this disposable test org.
    await db.query(`INSERT INTO public.income_expense_items(income_expense_id,income_expense_type_id,organization_id,description,quantity,unit_price,accounting_class)
      VALUES($1,$2,$3,'Source item must not change',1,2640000,'PNL')`, [id, randomUUID(), org]);
    if (noncash) await db.query("UPDATE public.income_expenses SET posting_mode='NON_CASH',posting_status='NOT_APPLICABLE' WHERE id=$1", [id]);
    if (existingBirth) await db.query("UPDATE public.income_expenses SET birth_operation_id=id,birth_txid=pg_current_xact_id(),source_payload_hash=md5('original source') WHERE id=$1", [id]);
    if (activePosting) await db.query('UPDATE public.income_expenses SET active_posting_id_v2=$2 WHERE id=$1', [id, activePosting]);
  });
  itemSnapshots.set(id, (await db.query('SELECT to_jsonb(i) value FROM public.income_expense_items i WHERE income_expense_id=$1 ORDER BY id', [id])).rows);
  return id;
}
async function unchangedMoney(id, before) {
  const after = (await db.query("SELECT to_jsonb(v)-ARRAY['review_state','review_reason','review_version','change_field_mask','updated_at'] value FROM public.income_expenses v WHERE id=$1", [id])).rows[0].value;
  assert.deepEqual(after, before, 'review must preserve identity, amount, source, approval, posting and maker');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.income_expense_postings WHERE voucher_id=$1', [id])).rows[0].n, 0);
  assert.deepEqual((await db.query('SELECT to_jsonb(i) value FROM public.income_expense_items i WHERE income_expense_id=$1 ORDER BY id', [id])).rows, itemSnapshots.get(id), 'review must preserve source items');
}
const snapshot = async id => (await db.query("SELECT to_jsonb(v)-ARRAY['review_state','review_reason','review_version','change_field_mask','updated_at'] value FROM public.income_expenses v WHERE id=$1", [id])).rows[0].value;
function ok(result, state) { assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.reviewState, state); }
function denied(result, code = '42501') { assert.notEqual(result.status, 200, 'denial must not succeed'); assert.equal(result.body.code, code, JSON.stringify(result.body)); }
async function authenticatedSql(query, args = [], actor = actors.editor) {
  await db.query('BEGIN');
  try {
    await db.query('SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: 'authenticated', sub: actor })]);
    return await db.query(query, args);
  } finally { await db.query('ROLLBACK'); }
}

await db.connect();
try {
  if (process.argv.includes('--apply-review-migration')) {
    await db.query(fs.readFileSync('supabase/migrations/20260920182530_shared_income_expense_review_transitions.sql', 'utf8'));
  }
  await fixtureWrite(async () => {
    for (const id of [org, otherOrg]) await db.query("INSERT INTO public.organizations(id,slug,name,status) VALUES($1,$2,'T3 disposable review','ACTIVE')", [id, 't3-' + id]);
    for (const [name, actor] of Object.entries(actors)) {
      await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [actor, 't3-' + actor + '@example.invalid']);
      const membership = randomUUID(); memberships[name] = membership;
      await db.query("INSERT INTO public.organization_memberships(id,organization_id,user_id,member_type,status) VALUES($1,$2,$3,'STAFF','ACTIVE')", [membership, name === 'outsider' ? otherOrg : org, actor]);
    }
    for (const id of [building, otherBuilding]) await db.query("INSERT INTO public.buildings(id,user_id,organization_id,name,province,district,ward) VALUES($1,$2,$3,'T3 local','','','')", [id, actors.owner, org]);
    await db.query("INSERT INTO public.accounts(id,user_id,organization_id,name,code,initial_amount) VALUES($1,$2,$3,'T3 cashbook',$4,9000000)", [account, actors.owner, org, 'T3-' + account]);
    for (const key of ['buildings.view', 'income_expenses.edit', 'income_expenses.approve']) {
      const [resource, action] = key.split('.');
      const inserted = await db.query("INSERT INTO public.permission_definitions(key,resource,action,sensitivity,permission_domain,scope_kinds,is_active) VALUES($1,$2,$3,$4,'TENANT',ARRAY['ORGANIZATION','AREA','BUILDING','CASHBOOK'],true) ON CONFLICT(key) DO NOTHING RETURNING key", [key, resource, action, action === 'view' ? 'VIEW' : action === 'edit' ? 'MANAGE' : 'ELEVATED']);
      if (inserted.rowCount) seededPermissions.push(key);
    }
    const scope = randomUUID(); await db.query("INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES($1,$2,'BUILDING',$3)", [scope, org, building]);
    for (const name of ['maker', 'editor', 'approver', 'viewer']) for (const key of ['buildings.view', ...(name === 'editor' ? ['income_expenses.edit'] : name === 'approver' ? ['income_expenses.approve'] : [])]) {
      const id = randomUUID(); overrides.push({ id, name, key });
      await db.query("INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect,reason,created_by,scope_mode) VALUES($1,$2,$3,$4,'ALLOW','T3 local',$5,'SCOPED')", [id, org, memberships[name], key, actors.owner]);
      await db.query('INSERT INTO public.member_override_scopes(organization_id,override_id,scope_id) VALUES($1,$2,$3)', [org, id, scope]);
    }
  });
  // Break caught: maker-NULL legacy vouchers stay stuck at 403 despite scoped edit authority.
  const legacy = await voucher({ source: 'contract.commission', kind: 'broker' }); const original = await snapshot(legacy); const key = randomUUID();
  const first = await submit(legacy, 1, actors.editor, key); ok(first, 'PENDING'); assert.equal(first.body.reviewVersion, 2); await unchangedMoney(legacy, original);
  assert.deepEqual((await submit(legacy, 1, actors.editor, key)).body, first.body);
  denied(await submit(legacy, 1, actors.editor, key, { total_amount: 1 }), '22023');
  const editOverride = overrides.find(row => row.key === 'income_expenses.edit').id;
  await fixtureWrite(() => db.query("UPDATE public.member_permission_overrides SET effect='DENY' WHERE id=$1", [editOverride]));
  denied(await submit(legacy, 1, actors.editor, key)); // replay cannot outlive revoked authority
  await fixtureWrite(() => db.query("UPDATE public.member_permission_overrides SET effect='ALLOW' WHERE id=$1", [editOverride]));
  denied(await request(legacy, 2, actors.editor)); ok(await request(legacy, 2), 'CHANGES_REQUESTED'); ok(await submit(legacy, 3), 'PENDING'); await unchangedMoney(legacy, original);
  const requestKey = randomUUID(); const requestResult = await request(legacy, 4, actors.approver, requestKey); ok(requestResult, 'CHANGES_REQUESTED');
  assert.deepEqual((await request(legacy, 4, actors.approver, requestKey)).body, requestResult.body);
  const approveOverride = overrides.find(row => row.key === 'income_expenses.approve').id;
  await fixtureWrite(() => db.query("UPDATE public.member_permission_overrides SET effect='DENY' WHERE id=$1", [approveOverride]));
  denied(await request(legacy, 4, actors.approver, requestKey));
  await fixtureWrite(() => db.query("UPDATE public.member_permission_overrides SET effect='ALLOW' WHERE id=$1", [approveOverride]));
  await unchangedMoney(legacy, original);

  // Break caught: canonical ownership's freeze rejects clearing change_field_mask.
  for (const flow of [null, 'CANONICAL_INCOME_EXPENSE']) {
    const id = await voucher({ maker: actors.maker, flow }); const before = await snapshot(id);
    denied(await submit(id, 1, actors.editor)); ok(await submit(id, 1, actors.maker), 'PENDING');
    ok(await request(id, 2), 'CHANGES_REQUESTED'); ok(await submit(id, 3, actors.maker), 'PENDING'); await unchangedMoney(id, before);
  }
  for (const [source, kind] of [['termination.refund', null], ['contract.commission', 'sale']]) {
    const id = await voucher({ source, kind }); const before = await snapshot(id); ok(await submit(id, 1), 'PENDING'); await unchangedMoney(id, before);
  }
  for (const properties of [{ noncash: true }, { existingBirth: true, flow: 'CANONICAL_INCOME_EXPENSE' }]) {
    const id = await voucher(properties); const before = await snapshot(id); ok(await submit(id, 1), 'PENDING'); ok(await request(id, 2), 'CHANGES_REQUESTED'); await unchangedMoney(id, before);
  }
  const pending = await voucher({ state: 'PENDING' }); denied(await submit(pending, 1), '55000');
  const target = await voucher();
  // Isolate the unchanged INSERT branch of the real birth trigger. Direct base-table
  // INSERT has an unrelated invoker profit-lock ACL; it is not the app's create RPC.
  await db.query('CREATE TEMP TABLE t3_birth_probe (LIKE public.income_expenses INCLUDING DEFAULTS)');
  await db.query('CREATE TRIGGER t3_birth BEFORE INSERT ON t3_birth_probe FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_birth_provenance_bridge()');
  await db.query('GRANT INSERT,SELECT ON t3_birth_probe TO authenticated');
  const birthProbe = await authenticatedSql(`INSERT INTO pg_temp.t3_birth_probe(id,user_id,organization_id,building_id,type,name,code,voucher_date,total_amount,approval_status,posting_mode,posting_status,review_state)
    VALUES($1,$2,$3,$4,'EXPENSE','T3 birth rollback',$5,current_date,0,'UNAPPROVED','CASHBOOK','UNPOSTED','PENDING')
    RETURNING birth_operation_id,birth_txid,source_payload_hash`, [randomUUID(), actors.editor, org, building, 'T3-BIRTH-' + randomUUID()]);
  assert.ok(birthProbe.rows[0].birth_operation_id && birthProbe.rows[0].birth_txid && birthProbe.rows[0].source_payload_hash, 'normal INSERT still registers birth');
  // A caller cannot manufacture the private authority used by either trigger.
  for (const [query, args] of [
    ['SELECT app_private.is_income_expense_review_operation_v1($1,$2)', [org, target]],
    ["INSERT INTO app_private.ie_transition_authorization(income_expense_id,xid,purpose) VALUES($1,pg_current_xact_id(),'FINANCE_V2_LIFECYCLE')", [target]],
    ["INSERT INTO app_private.canonical_write_operations(organization_id,operation,subject_scope,actor_id,idempotency_key,payload_hash,transaction_id) VALUES($1,'income_expense.resubmit.v2',$2,$3,'forged','forged',pg_current_xact_id())", [org, target, actors.editor]],
  ]) await assert.rejects(authenticatedSql(query, args), error => error.code === '42501');
  const canonical = await voucher({ flow: 'CANONICAL_INCOME_EXPENSE' });
  const canonicalBefore = await snapshot(canonical);
  const rawUpdate = await authenticatedSql('UPDATE public.income_expenses SET total_amount=1 WHERE id=$1 RETURNING id', [canonical]).catch(error => ({ code: error.code }));
  assert.ok(rawUpdate.code === '42501' || rawUpdate.code === '55000' || rawUpdate.rowCount === 0, 'direct authenticated money mutation must not bypass guards');
  await unchangedMoney(canonical, canonicalBefore);
  for (const actor of [actors.viewer, actors.approver, actors.outsider, randomUUID()]) denied(await submit(target, 1, actor));
  denied(await submit(target, null), '22023'); denied(await submit(target, 0), '40001');
  denied(await request(target, null), '22023'); denied(await request(target, 0), '40001');
  denied(await submit(target, 1, actors.editor, randomUUID(), []), '22023');
  denied(await submit(await voucher({ activePosting: randomUUID() }), 1), '55000');
  denied(await submit(await voucher({ buildingId: otherBuilding }), 1));
  denied(await submit(await voucher({ restricted: true }), 1));
  for (const flow of ['INVOICE_REFUND', 'TERMINATION_REFUND']) denied(await submit(await voucher({ flow }), 1));
  denied(await submit(await voucher({ source: 'reservation.refund' }), 1));
  for (const properties of [{ approval: 'APPROVED' }, { approval: 'CANCELLED' }, { posting: 'POSTED' }]) denied(await submit(await voucher(properties), 1), '55000');
  await fixtureWrite(() => db.query("UPDATE public.organization_memberships SET status='SUSPENDED' WHERE id=$1", [memberships.editor])); denied(await submit(target, 1));
  await fixtureWrite(() => db.query("UPDATE public.organization_memberships SET status='ACTIVE' WHERE id=$1", [memberships.editor]));
  await fixtureWrite(() => db.query("UPDATE public.organizations SET status='SUSPENDED' WHERE id=$1", [org])); denied(await submit(target, 1));
  await fixtureWrite(() => db.query("UPDATE public.organizations SET status='ACTIVE' WHERE id=$1", [org]));
  const concurrent = await voucher({ maker: actors.maker, flow: 'CANONICAL_INCOME_EXPENSE' });
  const outcomes = await Promise.all([submit(concurrent, 1, actors.maker), submit(concurrent, 1, actors.maker)]);
  assert.equal(outcomes.filter(row => row.status === 200).length, 1); assert.equal(outcomes.filter(row => row.body.code === '40001').length, 1);
  assert.equal((await db.query('SELECT initial_amount FROM public.accounts WHERE id=$1', [account])).rows[0].initial_amount, '9000000.00');
  assert.equal((await db.query('SELECT count(*)::int n FROM public.income_expense_postings WHERE organization_id=$1', [org])).rows[0].n, 0);
  const audit = (await db.query("SELECT count(*)::int n FROM app_private.canonical_write_operations WHERE organization_id=$1 AND completed_at IS NOT NULL AND outcome_kind IN ('RESUBMITTED','REQUEST_CHANGES')", [org])).rows[0].n;
  assert.ok(audit >= 11, 'review transitions must retain their canonical audit');
  assert.equal((await db.query("SELECT count(*)::int n FROM app_private.canonical_write_operations WHERE organization_id=$1 AND operation NOT IN ('income_expense.resubmit.v2','income_expense.request_changes.v2')", [org])).rows[0].n, 0, 'review must not create a new birth or financial operation');
  console.log('PASS: real authenticated JWT review loop; NULL-maker scoped editor; original-maker/canonical freeze; same ID/code/amount/source/maker/approval/posting; no cash; CAS concurrency/replay; revoked permission/org/building/restricted/source guard denial.');
} finally {
  await db.query('ROLLBACK');
  await fixtureWrite(async () => {
    await db.query('DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id=ANY($1)', [vouchers]);
    for (const table of ['app_private.canonical_write_operations', 'app_private.income_expense_flow_ownership', 'app_private.finance_v2_semantic_event_log', 'public.approval_requests', 'public.income_expense_items', 'public.income_expenses', 'public.accounts', 'public.member_override_scopes', 'public.member_permission_overrides', 'public.authorization_scopes', 'public.organization_memberships', 'public.buildings']) await db.query(`DELETE FROM ${table} WHERE organization_id=ANY($1)`, [[org, otherOrg]]);
    await db.query('DELETE FROM public.organizations WHERE id=ANY($1)', [[org, otherOrg]]);
    await db.query('DELETE FROM auth.users WHERE id=ANY($1)', [Object.values(actors)]);
    if (seededPermissions.length) await db.query('DELETE FROM public.permission_definitions WHERE key=ANY($1)', [seededPermissions]);
  });
  await db.end();
}
