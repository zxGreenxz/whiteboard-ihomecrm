import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localCluster, setup, jwt, fast, normal, normal1, live, id, ORG, USER, MEMBER, BUILDING, ROLE, BINDING, ORG_SCOPE, BUILDING_SCOPE,
  CUSTOMER, INVOICE, INVOICE2, ROOM } from './crm-shared-read-sql-fixture.mjs';
import { domainInput, domainResult } from './domain-contract.mjs';
import { domainFastResult } from './domain-read-fast.mjs';

// 20261021170452 on real PostgreSQL 16+/17 (TEST incident 21/10/2026): a member whose role grants buildings.view on ONE
// building but whose member overrides grant tasks.view/invoices.view/income_expenses.view on the whole ORGANIZATION. The web
// filters every building-bound row by buildings.view (production policies jobs_select_rbac, invoices_select_rbac,
// buildings_select_rbac, contracts_select_rbac, income_expenses_select_rbac rebuilt verbatim), and also shows the vouchers of
// the cashbooks the asker holds in any building (income_expenses_select_fund_member). Proved here: (1) on the production bodies
// (before this file) crm_read_tasks/invoices/receivables/income_expenses, the v1 capabilities, hermes_domain_grant_v2,
// hermes_metadata_domain_grant_v1 and hermes_task_follow_buildings_v1 all reach a building the asker cannot open on the web —
// red there; (2) after the file (applied twice) every one is a subset of the asker's RLS and the vouchers equal the web's
// (cashbook branch included; outside the web buildings they name no building or room; the connector fence accepts them),
// nothing else changed (allowed/companyEnabled/orgWide, rows without a building, a key narrower than buildings.view); (3) a
// super admin and a member with buildings.view on the whole company keep the wider set the web shows them; an AREA scope and
// an expired binding count exactly as in the web resolver; (4) customers.view keeps its key scope, so the R2d withoutContract is
// null when the contract scope (narrowed to the web) does not cover a Toàn tổ chức customer set, and a number once covered;
// (5) $requires$ refuses a foreign body even when it carries the reviewed anchor text; (6) the prepared revert restores the
// exact previous bodies (md5 of production 21/10) and re-opens the leak, and the forward file closes it again. Synthetic rows.
export const WEB_SCOPE_PATH = 'supabase/migrations/20261021170452_hermes_read_web_building_scope_v1.sql';
const REVERT_PATH = 'docs/plans/hermes-crm/revert/hermes_read_web_building_scope_revert_v1.sql';
const forwardSql = () => readFileSync(WEB_SCOPE_PATH, 'utf8');
const [OUTSIDE, OUTSIDE_ROOM, JOB_IN, JOB_OUT, JOB_NONE, JOB_DONE, INVOICE_OUT] = [400, 401, 410, 411, 412, 413, 420].map(id);
const [OVERRIDE_TASKS, OVERRIDE_INVOICES, OVERRIDE_BUILDINGS, OVERRIDE_EXPENSES, OVERRIDE_CUSTOMERS, OVERRIDE_CONTRACTS] = [430, 431, 432, 433, 434, 435].map(id);
const [FUND, OTHER_ACCOUNT, V_IN, V_OUT, V_FUND_OUT, V_CHANGE_OUT, V_ROUND_OUT] = [440, 441, 450, 451, 452, 453, 454].map(id);
const [CUSTOMER_OUT, CUSTOMER_NONE, CONTRACT_OUT, LINK_OUT, AREA, AREA_SCOPE, ROLE3, BINDING3] = [460, 461, 462, 463, 470, 471, 472, 473].map(id);
const PREVIOUS_MD5 = Object.freeze({
  'public.hermes_domain_capabilities_v1(uuid)': '73ae6a7e6939694d30153de6c4647a19',
  'app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)': 'e9f287dc65d6e2f49c747d1cf6cd4d7c',
  'app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)': 'e9f287dc65d6e2f49c747d1cf6cd4d7c',
  'app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)': '52b2720a8d4a060a576968d5236f3886',
  'public.hermes_domain_read_v2(jsonb,text,jsonb)': 'a7e7b7586b4e43b562a908ce49ed1763',
});
const sorted = values => [...values].sort();
// One SQL file on its own connection: a failing file leaves no aborted transaction in the pool.
async function apply(pool, sql) {
  const client = await pool.connect();
  try { await client.query(sql); } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; } finally { client.release(); }
}
// The private helpers have no API grant: call them as their owner with the asker's claims (as their DEFINER callers do).
async function asCaller(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [USER]);
    return await work(client);
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
}
// to_regprocedure(...) is NULL when the function does not exist.
const absent = result => result.rows[0].oid === null;

test('20261021170452: Hermes building scopes never exceed the asker\'s web RLS (buildings.view, cashbooks); R2d, revert and $requires$ hold', { timeout: 240000 }, async t => {
  const { pool, cleanup } = await localCluster(t); t.after(async () => { await pool.end(); cleanup(); });
  await setup(pool);
  for (const name of ['app_private.buildings_for_v3', 'public.has_full_building_scope', 'public.accessible_building_ids', 'public.accessible_room_ids',
    'app_private.my_possessed_cashbook_ids_v1', 'public.accessible_account_ids', 'public.can_view_restricted_ie', 'app_private.hermes_task_follow_buildings_v1']) {
    assert(live.has(name), name); await pool.query(live.get(name));
  }
  // The incident's shape: role (buildings.view and the fixture keys + tasks.view, income_expenses.view) on ONE building; member
  // overrides tasks.view, invoices.view and income_expenses.view on the whole organization; a second live building with a
  // task, an open debt, vouchers and a customer's contract; the asker holds one cashbook (custodian binding).
  await pool.query(`INSERT INTO public.permission_definitions(key) VALUES('tasks.view'),('income_expenses.view') ON CONFLICT DO NOTHING;
  INSERT INTO app_private.hermes_capabilities VALUES('tasks.view','read',true),('income_expenses.view','read',true) ON CONFLICT DO NOTHING;
  INSERT INTO public.role_permissions VALUES('${ORG}','${ROLE}','tasks.view','ALLOW'),('${ORG}','${ROLE}','income_expenses.view','ALLOW');
  INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES('${BUILDING_SCOPE}','${ORG}','BUILDING','${BUILDING}');
  UPDATE public.role_binding_scopes SET scope_id='${BUILDING_SCOPE}' WHERE role_binding_id='${BINDING}';
  INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect) VALUES
   ('${OVERRIDE_TASKS}','${ORG}','${MEMBER}','tasks.view','ALLOW'),('${OVERRIDE_INVOICES}','${ORG}','${MEMBER}','invoices.view','ALLOW'),
   ('${OVERRIDE_EXPENSES}','${ORG}','${MEMBER}','income_expenses.view','ALLOW');
  INSERT INTO public.member_override_scopes VALUES('${ORG}','${OVERRIDE_TASKS}','${ORG_SCOPE}'),('${ORG}','${OVERRIDE_INVOICES}','${ORG_SCOPE}'),
   ('${ORG}','${OVERRIDE_EXPENSES}','${ORG_SCOPE}');
  INSERT INTO public.buildings(id,organization_id,user_id,name,name_sort,code) VALUES('${OUTSIDE}','${ORG}','${USER}','Outside building','outside','OUT');
  INSERT INTO public.rooms VALUES('${OUTSIDE_ROOM}','${ORG}','${OUTSIDE}','P901','p901',null);
  INSERT INTO public.invoices(id,organization_id,user_id,building_id,room_id,invoice_number,billing_month,due_date,status,total_amount,paid_amount,created_at) VALUES
   ('${INVOICE_OUT}','${ORG}','${USER}','${OUTSIDE}','${OUTSIDE_ROOM}','HDON900','2026-10','2026-10-20','APPROVED',500,0,now());
  CREATE TABLE public.jobs(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,assignee_id uuid,title text,code text,status text,
   building_id uuid,room_id uuid,deadline timestamptz);
  INSERT INTO public.jobs VALUES('${JOB_IN}','${ORG}','${USER}',null,'Sửa vòi nước','CV1','IN_PROGRESS','${BUILDING}',null,'2026-12-01'),
   ('${JOB_OUT}','${ORG}','${USER}',null,'Việc toà ngoài phạm vi','CV2','IN_PROGRESS','${OUTSIDE}','${OUTSIDE_ROOM}','2026-12-01'),
   ('${JOB_NONE}','${ORG}','${USER}',null,'Việc chung công ty','CV3','IN_PROGRESS',null,null,null),
   ('${JOB_DONE}','${ORG}','${USER}',null,'Việc đã xong','CV4','COMPLETED','${BUILDING}',null,null);
  ALTER TABLE public.accounts ADD COLUMN user_id uuid;
  INSERT INTO public.accounts(id,organization_id) VALUES('${FUND}','${ORG}'),('${OTHER_ACCOUNT}','${ORG}');
  INSERT INTO public.cashbook_possession_bindings VALUES('${ORG}','${MEMBER}','${FUND}','CUSTODIAN',now()-interval '1 day',null);
  CREATE TABLE public.income_expenses(id uuid PRIMARY KEY,organization_id uuid NOT NULL,user_id uuid,code text,
   type text NOT NULL CHECK(type IN('INCOME','EXPENSE')),name text NOT NULL,building_id uuid NOT NULL,room_id uuid,voucher_date date NOT NULL,
   total_amount numeric(15,2) NOT NULL DEFAULT 0 CHECK(total_amount>=0),approval_status text NOT NULL DEFAULT 'APPROVED',
   has_restricted_item boolean NOT NULL DEFAULT false,salary_staff_id uuid,shareholder_id uuid,profit_manager_id uuid,
   account_id uuid,change_account_id uuid,rounding_account_id uuid,deleted_at timestamptz);
  INSERT INTO public.income_expenses(id,organization_id,user_id,code,type,name,building_id,room_id,voucher_date,total_amount,account_id,change_account_id,rounding_account_id) VALUES
   ('${V_IN}','${ORG}','${USER}','PT01','INCOME','Thu tiền phòng','${BUILDING}','${ROOM}','2026-10-01',6000000,'${OTHER_ACCOUNT}',null,null),
   ('${V_OUT}','${ORG}','${USER}','PC01','EXPENSE','Chi toà ngoài','${OUTSIDE}',null,'2026-10-02',4500000,'${OTHER_ACCOUNT}',null,null),
   ('${V_FUND_OUT}','${ORG}','${USER}','PC02','EXPENSE','Chi sổ quỹ giữ','${OUTSIDE}','${OUTSIDE_ROOM}','2026-10-03',1200000,'${FUND}',null,null),
   ('${V_CHANGE_OUT}','${ORG}','${USER}','PT02','INCOME','Thu tiền thối vào sổ giữ','${OUTSIDE}',null,'2026-10-04',800000,'${OTHER_ACCOUNT}','${FUND}',null),
   ('${V_ROUND_OUT}','${ORG}','${USER}','PT03','INCOME','Thu làm tròn vào sổ giữ','${OUTSIDE}',null,'2026-10-05',700000,'${OTHER_ACCOUNT}',null,'${FUND}');
  -- Production SELECT policies (pg_policies, TEST 21/10/2026).
  DROP POLICY fixture_crm ON public.buildings;
  CREATE POLICY buildings_select_rbac ON public.buildings FOR SELECT TO authenticated USING ((SELECT public.has_full_building_scope())
   OR (id IN (SELECT public.accessible_building_ids())));
  DROP POLICY fixture_crm ON public.invoices;
  CREATE POLICY invoices_select_rbac ON public.invoices FOR SELECT TO authenticated USING ((SELECT public.has_full_building_scope())
   OR (building_id IN (SELECT public.accessible_building_ids())));
  DROP POLICY fixture_crm ON public.contracts;
  CREATE POLICY contracts_select_rbac ON public.contracts FOR SELECT TO authenticated USING ((SELECT public.is_super_admin()) OR (SELECT public.is_admin())
   OR ((room_id IS NOT NULL) AND ((SELECT public.has_full_building_scope()) OR (room_id IN (SELECT public.accessible_room_ids())))));
  ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
  CREATE POLICY jobs_select_rbac ON public.jobs FOR SELECT TO authenticated USING ((SELECT public.is_super_admin()) OR (SELECT public.is_admin())
   OR ((building_id IS NOT NULL) AND ((SELECT public.has_full_building_scope()) OR (building_id IN (SELECT public.accessible_building_ids()))))
   OR ((building_id IS NULL) AND (SELECT public.can_access_org_entity('tasks','view'))));
  ALTER TABLE public.income_expenses ENABLE ROW LEVEL SECURITY;
  CREATE POLICY income_expenses_select_rbac ON public.income_expenses FOR SELECT TO authenticated USING ((SELECT public.is_super_admin()) OR (SELECT public.is_admin())
   OR ((building_id IS NOT NULL) AND ((SELECT public.has_full_building_scope()) OR (building_id IN (SELECT public.accessible_building_ids())))));
  CREATE POLICY income_expenses_select_fund_member ON public.income_expenses FOR SELECT TO authenticated USING ((deleted_at IS NULL)
   AND ((account_id IN (SELECT public.accessible_account_ids())) OR (change_account_id IN (SELECT public.accessible_account_ids()))
    OR (rounding_account_id IN (SELECT public.accessible_account_ids()))));
  CREATE POLICY income_expenses_restricted_select ON public.income_expenses AS RESTRICTIVE FOR SELECT TO authenticated USING ((has_restricted_item = false)
   OR (user_id = (SELECT auth.uid())) OR (SELECT public.can_view_restricted_ie()));
  GRANT SELECT ON public.jobs,public.income_expenses TO authenticated;`);
  const prepared = await jwt(pool, async c => (await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value", [ORG])).rows[0].value);
  const tokenDigest = 'd'.repeat(64);
  await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb)', [JSON.stringify({ connectionId: prepared.id, expectedEpoch: 1, operationId: id(450),
    intentSecret: prepared.intentSecret, userId: USER, providerSessionId: id(32), credentialRef: id(451), tokenDigest, tokenExpiresAt: Date.now() + 600000,
    sessionExpiresAt: Date.now() + 3600000, sessionEnvelope: { v: 1, algorithm: 'A256GCM', keyVersion: 'fixture', nonce: 'a'.repeat(16), tag: 'a'.repeat(22), ciphertext: 'abcd' } })]);
  const bind4 = { connectionId: prepared.id, tokenDigest, expectedEpoch: 2, expectedSessionRevision: 1 };
  const bind7 = { ...bind4, expectedPolicyVersion: 0, expectedMembershipId: MEMBER, expectedAuthorizationVersion: 1 };
  const who = scopes => ({ row: { id: prepared.id, userId: USER, organizationId: ORG }, scopesByPermission: scopes });

  // Everything Hermes and the web give the same asker.
  const observe = async () => {
    const caps = await jwt(pool, async c => (await c.query('SELECT public.hermes_domain_capabilities_v1($1) value', [ORG])).rows[0].value);
    const caps2 = await jwt(pool, async c => (await c.query('SELECT public.hermes_domain_capabilities_v2($1) value', [ORG])).rows[0].value);
    const helpers = await asCaller(pool, async c => {
      const grant = key => c.query('SELECT app_private.hermes_domain_grant_v2($1,$2,true,public.get_authorization_context_v1($1)) value', [ORG, key]);
      const meta = key => c.query('SELECT app_private.hermes_metadata_domain_grant_v1($1,$2,true,public.get_authorization_context_v1($1)) value', [ORG, key]);
      return { grantTasks: (await grant('tasks.view')).rows[0].value, grantContracts: (await grant('contracts.view')).rows[0].value,
        grantCustomers: (await grant('customers.view')).rows[0].value, grantExpenses: (await grant('income_expenses.view')).rows[0].value,
        metaInvoices: (await meta('invoices.view')).rows[0].value, metaCustomers: (await meta('customers.view')).rows[0].value,
        follow: (await c.query("SELECT app_private.hermes_task_follow_buildings_v1(c,'tasks.view') value FROM app_private.hermes_connections c WHERE c.id=$1",
          [prepared.id])).rows[0].value };
    });
    const web = await jwt(pool, async c => ({ buildings: (await c.query('SELECT id FROM public.buildings')).rows.map(r => r.id),
      jobs: (await c.query('SELECT id FROM public.jobs')).rows.map(r => r.id), invoices: (await c.query('SELECT id FROM public.invoices')).rows.map(r => r.id),
      // The vouchers crm_read_income_expenses covers (its categories), as the web shows them.
      vouchers: (await c.query(`SELECT id FROM public.income_expenses WHERE organization_id=$1 AND deleted_at IS NULL AND type IN ('INCOME','EXPENSE')
        AND NOT has_restricted_item AND salary_staff_id IS NULL AND shareholder_id IS NULL AND profit_manager_id IS NULL`, [ORG])).rows.map(r => r.id) }));
    const fastReceivables = await fast(pool, bind4, 'receivables');
    return { caps, caps2, ...helpers, web, fastReceivables, tasks: await normal1(pool, bind7, 'tasks'), open: await normal1(pool, bind7, 'tasks', { status: 'IN_PROGRESS' }),
      invoices: await normal1(pool, bind7, 'invoices'), receivables: await normal(pool, bind7, 'receivables'), expenses: await normal(pool, bind7, 'income_expenses') };
  };
  // Every Hermes building scope/row outside the asker's RLS, labelled (customers.view / income_expenses.view grants keep the
  // key scope by design: their readers apply the web filter, checked through the rows).
  const leaks = o => [
    ...o.tasks.items.filter(r => !o.web.jobs.includes(r.id)).map(r => `tasks:${r.id}`),
    ...o.open.items.filter(r => !o.web.jobs.includes(r.id)).map(r => `open:${r.id}`),
    ...o.invoices.items.filter(r => !o.web.invoices.includes(r.id)).map(r => `invoices:${r.id}`),
    ...o.receivables.items.filter(r => !o.web.invoices.includes(r.id)).map(r => `receivables:${r.id}`),
    ...o.expenses.items.filter(r => !o.web.vouchers.includes(r.id)).map(r => `expenses:${r.id}`),
    ...Object.entries(o.caps.permissions).flatMap(([key, cap]) => cap.buildingIds.filter(b => !o.web.buildings.includes(b)).map(b => `caps.${key}:${b}`)),
    ...o.grantTasks.buildingIds.filter(b => !o.web.buildings.includes(b)).map(b => `grant_v2:${b}`),
    ...o.metaInvoices.buildingIds.filter(b => !o.web.buildings.includes(b)).map(b => `metadata_grant:${b}`),
    ...o.follow.filter(b => !o.web.buildings.includes(b)).map(b => `task_follow:${b}`),
    ...o.fastReceivables.authority.buildingIds.filter(b => !o.web.buildings.includes(b)).map(b => `fast_scope:${b}`)];
  // Vouchers the web shows that crm_read_income_expenses misses (the cashbook branch).
  const missing = o => o.web.vouchers.filter(v => !o.expenses.items.some(r => r.id === v)).map(v => `missing:${v}`);
  const withoutBuildings = caps => Object.fromEntries(Object.entries(caps.permissions).map(([key, cap]) => [key, { ...cap, buildingIds: null }]));

  // (1) Production bodies: the incident reproduces (RED before the file).
  const before = await observe();
  assert.deepEqual(sorted(before.web.buildings), [BUILDING], 'control: the RLS sees exactly the role building (claims are complete)');
  assert.deepEqual(sorted(before.web.jobs), sorted([JOB_IN, JOB_NONE, JOB_DONE]), 'control: the web hides the outside task only');
  assert.deepEqual(sorted(before.web.vouchers), sorted([V_IN, V_FUND_OUT, V_CHANGE_OUT, V_ROUND_OUT]), 'control: the cashbook policy shows the held vouchers');
  assert.deepEqual(sorted(before.open.items.map(r => r.id)), sorted([JOB_IN, JOB_OUT, JOB_NONE]), 'the reported question: open tasks include the outside building');
  assert.deepEqual(sorted(leaks(before)), sorted([`tasks:${JOB_OUT}`, `open:${JOB_OUT}`, `invoices:${INVOICE_OUT}`, `receivables:${INVOICE_OUT}`,
    `expenses:${V_OUT}`, `caps.tasks.view:${OUTSIDE}`, `caps.invoices.view:${OUTSIDE}`, `grant_v2:${OUTSIDE}`, `metadata_grant:${OUTSIDE}`,
    `task_follow:${OUTSIDE}`, `fast_scope:${OUTSIDE}`]), 'every per-key helper reached the building the web hides');
  assert.equal(absent(await pool.query("SELECT to_regprocedure('app_private.hermes_web_building_ids_v1(uuid)') oid")), true);

  // (2) The file, twice (idempotent): no leak, the vouchers equal the web's, nothing else changed.
  await apply(pool, forwardSql()); await apply(pool, forwardSql());
  const after = await observe();
  assert.deepEqual(leaks(after), [], 'no Hermes scope or row outside the asker\'s RLS');
  assert.deepEqual(missing(after), [], 'every voucher the web shows (cashbook branch included)');
  assert.deepEqual(sorted(after.tasks.items.map(r => r.id)), sorted([JOB_IN, JOB_NONE, JOB_DONE]), 'tasks = the web\'s tasks (the one without a building kept)');
  assert.deepEqual(sorted(after.open.items.map(r => r.id)), sorted([JOB_IN, JOB_NONE]));
  assert.deepEqual([after.tasks.summary.count, after.open.summary.count, after.open.summary.byStatus], [3, 2, { IN_PROGRESS: 2 }], 'summary follows the rows');
  assert.deepEqual(sorted(after.invoices.items.map(r => r.id)), sorted([INVOICE, INVOICE2]));
  assert.deepEqual(after.receivables.items.map(r => r.id), [INVOICE]);
  // Outside the web buildings a voucher names neither its building nor its room (the web embeds them under RLS).
  const named = Object.fromEntries(after.expenses.items.map(r => [r.id, [r.buildingId, r.buildingName, r.roomId, r.roomName]]));
  assert.deepEqual(named, { [V_IN]: [BUILDING, 'Fixture building', ROOM, 'P101'], [V_FUND_OUT]: [OUTSIDE, '', null, null],
    [V_CHANGE_OUT]: [OUTSIDE, '', null, null], [V_ROUND_OUT]: [OUTSIDE, '', null, null] }, 'outside the web buildings no building or room name');
  assert.deepEqual([after.expenses.summary.count, after.expenses.summary.sum.totalAmount], [4, '8700000.00'], 'summary of the same voucher set');
  assert.deepEqual(sorted((await normal(pool, bind7, 'income_expenses', { buildingId: OUTSIDE })).items.map(r => r.id)), sorted([V_FUND_OUT, V_CHANGE_OUT, V_ROUND_OUT]),
    'filtered to a building outside the web set: only the held cashbook\'s vouchers');
  // The connector fence (capabilities v2) keeps the key scope of income_expenses.view, so it accepts the cashbook rows.
  assert.deepEqual(after.caps2.permissions['income_expenses.view'].buildingIds, sorted([BUILDING, OUTSIDE]), 'capabilities v2 fence keeps the key scope');
  assert.doesNotThrow(() => domainResult('income_expenses', after.expenses, who({ 'income_expenses.view': { buildingIds: after.caps2.permissions['income_expenses.view'].buildingIds,
    cashbookIds: [] } }), domainInput('income_expenses', {})));
  for (const key of ['tasks.view', 'invoices.view', 'contracts.view', 'customers.view'])
    assert.deepEqual(after.caps.permissions[key].buildingIds, [BUILDING], `capabilities v1 ${key}: every key narrowed`);
  assert.deepEqual(withoutBuildings(after.caps), withoutBuildings(before.caps), 'allowed/companyEnabled unchanged for every v1 key');
  assert.deepEqual(before.caps.permissions['contracts.view'].buildingIds, [BUILDING], 'a key no wider than buildings.view was already exact');
  assert.deepEqual({ ...after.grantTasks, buildingIds: null }, { ...before.grantTasks, buildingIds: null }, 'grant_v2: allowed/orgWide unchanged');
  assert.equal(after.grantTasks.orgWide, true, 'the ORGANIZATION override still opens rows without a building (web: can_access_org_entity)');
  assert.deepEqual([after.grantTasks.buildingIds, after.grantContracts, after.metaInvoices.buildingIds, after.follow],
    [[BUILDING], before.grantContracts, [BUILDING], [BUILDING]]);
  // v3 reads customers through grant_v2 (this fixture has no v3): checked here; the fast reader's grant (metadata) is
  // checked by its behaviour in (4).
  assert.deepEqual([after.grantExpenses, after.grantCustomers], [before.grantExpenses, before.grantCustomers],
    'the two keys with a non-building web branch keep their key scope in grant_v2');
  assert.deepEqual(after.fastReceivables.result.items, before.fastReceivables.result.items, 'the fast lane already read under RLS: same rows');
  const acl = (await pool.query(`SELECT has_function_privilege('authenticated','app_private.hermes_web_building_ids_v1(uuid)','EXECUTE') caller,
    has_function_privilege('authenticated','public.hermes_domain_capabilities_v1(uuid)','EXECUTE') caps,
    has_function_privilege('authenticated','public.hermes_domain_read_v2(jsonb,text,jsonb)','EXECUTE') v2`)).rows[0];
  assert.deepEqual(acl, { caller: false, caps: true, v2: true }, 'helper private, entry points still callable');

  // (3) Whoever the web shows the outside building keeps it: a super admin (has_full_building_scope) and a member with
  // buildings.view on the whole company. A key narrower than buildings.view stays narrower. An AREA scope and an expired
  // binding count exactly as in the web resolver.
  await pool.query(`INSERT INTO public.super_admins VALUES('${USER}')`);
  const superAdmin = await observe();
  assert.deepEqual([leaks(superAdmin), missing(superAdmin)], [[], []]);
  assert(superAdmin.open.items.some(r => r.id === JOB_OUT) && superAdmin.web.jobs.includes(JOB_OUT), 'super admin: web and Hermes both show it');
  assert.deepEqual(superAdmin.caps.permissions['tasks.view'].buildingIds, sorted([BUILDING, OUTSIDE]));
  await pool.query(`DELETE FROM public.super_admins WHERE user_id='${USER}'`);
  await pool.query(`INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect)
    VALUES('${OVERRIDE_BUILDINGS}','${ORG}','${MEMBER}','buildings.view','ALLOW');
    INSERT INTO public.member_override_scopes VALUES('${ORG}','${OVERRIDE_BUILDINGS}','${ORG_SCOPE}');`);
  const companyWide = await observe();
  assert.deepEqual([leaks(companyWide), missing(companyWide)], [[], []]);
  assert.deepEqual(sorted(companyWide.open.items.map(r => r.id)), sorted([JOB_IN, JOB_OUT, JOB_NONE]), 'buildings.view everywhere: the outside task is the web\'s too');
  assert.deepEqual(sorted(companyWide.expenses.items.map(r => r.id)), sorted([V_IN, V_OUT, V_FUND_OUT, V_CHANGE_OUT, V_ROUND_OUT]));
  assert.deepEqual(companyWide.caps.permissions['contracts.view'].buildingIds, [BUILDING], 'contracts.view (role, one building) stays narrower');
  await pool.query(`UPDATE public.member_permission_overrides SET revoked_at=now() WHERE id='${OVERRIDE_BUILDINGS}'`);
  assert.deepEqual(leaks(await observe()), []);
  const webSet = () => asCaller(pool, async c => (await c.query('SELECT app_private.hermes_web_building_ids_v1($1) value', [ORG])).rows[0].value);
  const rlsBuildings = async () => sorted(await jwt(pool, async c => (await c.query('SELECT id FROM public.buildings')).rows.map(r => r.id)));
  await pool.query(`INSERT INTO public.areas(id,organization_id) VALUES('${AREA}','${ORG}');
    INSERT INTO public.area_buildings VALUES('${ORG}','${AREA}','${OUTSIDE}');
    INSERT INTO public.authorization_scopes(id,organization_id,scope_type,area_id) VALUES('${AREA_SCOPE}','${ORG}','AREA','${AREA}');
    INSERT INTO public.organization_roles VALUES('${ROLE3}','${ORG}','ACTIVE');
    INSERT INTO public.role_permissions VALUES('${ORG}','${ROLE3}','buildings.view','ALLOW');
    INSERT INTO public.role_bindings VALUES('${BINDING3}','${ORG}','${MEMBER}','${ROLE3}',now()-interval '1 day',null);
    INSERT INTO public.role_binding_scopes VALUES('${ORG}','${BINDING3}','${AREA_SCOPE}');`);
  assert.deepEqual([await webSet(), await rlsBuildings()], [sorted([BUILDING, OUTSIDE]), sorted([BUILDING, OUTSIDE])], 'AREA scope: web and Hermes alike');
  await pool.query(`UPDATE public.role_bindings SET valid_to=now()-interval '1 minute' WHERE id='${BINDING3}'`);
  assert.deepEqual([await webSet(), await rlsBuildings()], [[BUILDING], [BUILDING]], 'expired binding: neither counts it');
  await pool.query(`DELETE FROM public.role_binding_scopes WHERE role_binding_id='${BINDING3}';DELETE FROM public.role_bindings WHERE id='${BINDING3}';
    DELETE FROM public.role_permissions WHERE role_id='${ROLE3}';DELETE FROM public.organization_roles WHERE id='${ROLE3}';`);

  // (4) R2d withoutContract (fast reader): customers.view keeps its key scope. Customers Toàn tổ chức with the contract scope
  // narrowed to the web: a customer whose only contract is in the outside building cannot be classified ⇒ null, never a count.
  await pool.query(`INSERT INTO public.customers(id,organization_id,user_id,full_name,phone,created_at) VALUES
    ('${CUSTOMER_OUT}','${ORG}','${USER}','Khách toà ngoài','0920000000','2026-10-19'),('${CUSTOMER_NONE}','${ORG}','${USER}','Khách chưa có hợp đồng','0930000000','2026-10-19');
    INSERT INTO public.contracts(id,organization_id,user_id,room_id,status,contract_number,start_date,end_date,created_at) VALUES
    ('${CONTRACT_OUT}','${ORG}','${USER}','${OUTSIDE_ROOM}','ACTIVE','HD900','2026-01-01','2027-01-01','2026-10-19');
    INSERT INTO public.contract_customers VALUES('${LINK_OUT}','${ORG}','${CONTRACT_OUT}','${CUSTOMER_OUT}',true,'2026-01-01');
    INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect) VALUES
     ('${OVERRIDE_CUSTOMERS}','${ORG}','${MEMBER}','customers.view','ALLOW'),('${OVERRIDE_CONTRACTS}','${ORG}','${MEMBER}','contracts.view','ALLOW');
    INSERT INTO public.member_override_scopes VALUES('${ORG}','${OVERRIDE_CUSTOMERS}','${ORG_SCOPE}'),('${ORG}','${OVERRIDE_CONTRACTS}','${ORG_SCOPE}');`);
  const customers = async (input = {}) => fast(pool, bind4, 'customers', input);
  const whole = await customers();
  assert.deepEqual([whole.authority.buildingIds, whole.result.summary.withoutContract], [sorted([BUILDING, OUTSIDE]), null],
    'Toàn tổ chức, contract scope narrowed to the web: uncovered ⇒ null (not the customer of the outside contract counted as without one)');
  assert.equal(domainFastResult('customers', whole, who({}), domainInput('customers', {})).summary.withoutContract, null, 'the connector accepts it');
  const filtered = await customers({ buildingId: BUILDING });
  assert.equal(filtered.result.summary.withoutContract, 0, 'filtered to a web building: covered, a number again (both of its customers hold a contract)');
  assert.ok(whole.result.items.every(row => row.buildingId === null || row.buildingId === BUILDING), 'no contract building outside the web on any row');
  // v3 (reserve lane, not in this fixture) reads both scopes through grant_v2: customers keep the key scope, contracts are
  // narrowed, so its R2d check (buildings <@ v_contract_scope) is uncovered too ⇒ null.
  const v3Scopes = await asCaller(pool, async c => (await c.query(`SELECT app_private.hermes_domain_grant_v2($1,'customers.view',true,public.get_authorization_context_v1($1))->'buildingIds' customers,
    app_private.hermes_domain_grant_v2($1,'contracts.view',true,public.get_authorization_context_v1($1))->'buildingIds' contracts`, [ORG])).rows[0]);
  assert.deepEqual([v3Scopes.customers, v3Scopes.contracts], [sorted([BUILDING, OUTSIDE]), [BUILDING]], 'v3: customers keep the key scope (R2d coverage), contracts narrowed');
  await pool.query(`UPDATE public.member_permission_overrides SET revoked_at=now() WHERE id IN ('${OVERRIDE_CUSTOMERS}','${OVERRIDE_CONTRACTS}')`);

  // (5) $requires$ refuses a foreign body even when it carries the reviewed anchor text (md5 pin, not a substring).
  const saved = (await pool.query("SELECT pg_get_functiondef('app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)'::regprocedure) def")).rows[0].def;
  await pool.query(`CREATE OR REPLACE FUNCTION app_private.hermes_domain_grant_v2(p_org uuid,p_key text,p_enabled boolean,p_context jsonb)
    RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
    BEGIN
      -- names app_private.authorized_scope_v3(p_key,p_org) and app_private.hermes_web_building_ids_v1(p_org) like the reviewed body
      RETURN jsonb_build_object('allowed',true,'companyEnabled',true,'buildingIds','[]'::jsonb,'orgWide',true);
    END $fn$`);
  await assert.rejects(apply(pool, forwardSql()), /hermes_web_building_scope_requires_reviewed_body: app_private\.hermes_domain_grant_v2/);
  await pool.query(saved);
  assert.deepEqual([leaks(await observe()), missing(await observe())], [[], []], 'restored: the rejected run changed nothing');

  // (6) Prepared revert: the exact previous bodies (production md5 of 21/10), the helper dropped, the leak back; twice.
  const revert = readFileSync(REVERT_PATH, 'utf8');
  await apply(pool, revert); await apply(pool, revert);
  const digests = (await pool.query(`SELECT x.sig,md5(replace(p.prosrc,chr(13),'')) md5 FROM unnest($1::text[]) x(sig) JOIN pg_proc p ON p.oid=to_regprocedure(x.sig)`,
    [Object.keys(PREVIOUS_MD5)])).rows;
  assert.deepEqual(Object.fromEntries(digests.map(r => [r.sig, r.md5])), PREVIOUS_MD5);
  assert.equal(absent(await pool.query("SELECT to_regprocedure('app_private.hermes_web_building_ids_v1(uuid)') oid")), true);
  const reverted = await observe();
  assert(leaks(reverted).includes(`tasks:${JOB_OUT}`) && leaks(reverted).includes(`expenses:${V_OUT}`), 'revert re-opens exactly the previous behaviour');
  await apply(pool, forwardSql());
  assert.deepEqual([leaks(await observe()), missing(await observe())], [[], []], 'forward again after the revert');
});
