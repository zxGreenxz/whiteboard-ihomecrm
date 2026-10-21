import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localCluster, setup, jwt, fast, normal, normal1, live, id, ORG, USER, MEMBER, BUILDING, ROLE, BINDING, ORG_SCOPE, BUILDING_SCOPE, INVOICE, INVOICE2 }
  from './crm-shared-read-sql-fixture.mjs';

// 20261021170452 on real PostgreSQL 16+/17 (TEST incident 21/10/2026): a member whose role grants buildings.view on ONE
// building but whose member overrides grant tasks.view/invoices.view on the whole ORGANIZATION. The web filters every
// building-bound row by buildings.view (production policies jobs_select_rbac / invoices_select_rbac: has_full_building_scope()
// OR building_id IN accessible_building_ids(), rebuilt here verbatim); the SECURITY DEFINER Hermes helpers took the key's own
// building set. Proved here: (1) on the production bodies (before this file) crm_read_tasks/invoices/receivables, the v1
// capabilities, hermes_domain_grant_v2, hermes_metadata_domain_grant_v1 and hermes_task_follow_buildings_v1 all reach a
// building the asker cannot open on the web — the test is red there; (2) after the file (applied twice) every one of them is
// a subset of the asker's RLS, and nothing else changed (allowed/companyEnabled/orgWide, rows without a building, a key
// narrower than buildings.view); (3) a super admin and a member with buildings.view on the whole company keep the wider set
// the web shows them; (4) $requires$ refuses an unexpected predecessor; (5) the prepared revert restores the exact previous
// bodies (md5 of production 21/10) and re-opens the leak, and the forward file closes it again. Synthetic rows only.
export const WEB_SCOPE_PATH = 'supabase/migrations/20261021170452_hermes_read_web_building_scope_v1.sql';
const REVERT_PATH = 'docs/plans/hermes-crm/revert/hermes_read_web_building_scope_revert_v1.sql';
const forwardSql = () => readFileSync(WEB_SCOPE_PATH, 'utf8');
const [OUTSIDE, OUTSIDE_ROOM, JOB_IN, JOB_OUT, JOB_NONE, JOB_DONE, INVOICE_OUT, OVERRIDE_TASKS, OVERRIDE_INVOICES, OVERRIDE_BUILDINGS] =
  [400, 401, 410, 411, 412, 413, 420, 430, 431, 432].map(id);
const PREVIOUS_MD5 = Object.freeze({
  'public.hermes_domain_capabilities_v1(uuid)': '73ae6a7e6939694d30153de6c4647a19',
  'app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)': 'e9f287dc65d6e2f49c747d1cf6cd4d7c',
  'app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)': 'e9f287dc65d6e2f49c747d1cf6cd4d7c',
  'app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)': '52b2720a8d4a060a576968d5236f3886',
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

test('20261021170452: Hermes building scopes never exceed the asker\'s web RLS (buildings.view); revert and $requires$ hold', { timeout: 240000 }, async t => {
  const { pool, cleanup } = await localCluster(t); t.after(async () => { await pool.end(); cleanup(); });
  await setup(pool);
  for (const name of ['app_private.buildings_for_v3', 'public.has_full_building_scope', 'public.accessible_building_ids', 'app_private.hermes_task_follow_buildings_v1']) {
    assert(live.has(name), name); await pool.query(live.get(name));
  }
  // The incident's shape: role (buildings.view and the fixture keys + tasks.view) on ONE building; member overrides
  // tasks.view and invoices.view on the whole organization; a second live building with a task and an open debt.
  await pool.query(`INSERT INTO public.permission_definitions(key) VALUES('tasks.view') ON CONFLICT DO NOTHING;
  INSERT INTO app_private.hermes_capabilities VALUES('tasks.view','read',true) ON CONFLICT DO NOTHING;
  INSERT INTO public.role_permissions VALUES('${ORG}','${ROLE}','tasks.view','ALLOW');
  INSERT INTO public.authorization_scopes(id,organization_id,scope_type,building_id) VALUES('${BUILDING_SCOPE}','${ORG}','BUILDING','${BUILDING}');
  UPDATE public.role_binding_scopes SET scope_id='${BUILDING_SCOPE}' WHERE role_binding_id='${BINDING}';
  INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect) VALUES
   ('${OVERRIDE_TASKS}','${ORG}','${MEMBER}','tasks.view','ALLOW'),('${OVERRIDE_INVOICES}','${ORG}','${MEMBER}','invoices.view','ALLOW');
  INSERT INTO public.member_override_scopes VALUES('${ORG}','${OVERRIDE_TASKS}','${ORG_SCOPE}'),('${ORG}','${OVERRIDE_INVOICES}','${ORG_SCOPE}');
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
  -- Production SELECT policies (pg_policies, TEST 21/10/2026): jobs_select_rbac, invoices_select_rbac, buildings_select_rbac.
  DROP POLICY fixture_crm ON public.buildings;
  CREATE POLICY buildings_select_rbac ON public.buildings FOR SELECT TO authenticated USING ((SELECT public.has_full_building_scope())
   OR (id IN (SELECT public.accessible_building_ids())));
  ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
  CREATE POLICY jobs_select_rbac ON public.jobs FOR SELECT TO authenticated USING ((SELECT public.is_super_admin()) OR (SELECT public.is_admin())
   OR ((building_id IS NOT NULL) AND ((SELECT public.has_full_building_scope()) OR (building_id IN (SELECT public.accessible_building_ids()))))
   OR ((building_id IS NULL) AND (SELECT public.can_access_org_entity('tasks','view'))));
  GRANT SELECT ON public.jobs TO authenticated;
  DROP POLICY fixture_crm ON public.invoices;
  CREATE POLICY invoices_select_rbac ON public.invoices FOR SELECT TO authenticated USING ((SELECT public.has_full_building_scope())
   OR (building_id IN (SELECT public.accessible_building_ids())));`);
  const prepared = await jwt(pool, async c => (await c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}') value", [ORG])).rows[0].value);
  const tokenDigest = 'd'.repeat(64);
  await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb)', [JSON.stringify({ connectionId: prepared.id, expectedEpoch: 1, operationId: id(450),
    intentSecret: prepared.intentSecret, userId: USER, providerSessionId: id(32), credentialRef: id(451), tokenDigest, tokenExpiresAt: Date.now() + 600000,
    sessionExpiresAt: Date.now() + 3600000, sessionEnvelope: { v: 1, algorithm: 'A256GCM', keyVersion: 'fixture', nonce: 'a'.repeat(16), tag: 'a'.repeat(22), ciphertext: 'abcd' } })]);
  const bind4 = { connectionId: prepared.id, tokenDigest, expectedEpoch: 2, expectedSessionRevision: 1 };
  const bind7 = { ...bind4, expectedPolicyVersion: 0, expectedMembershipId: MEMBER, expectedAuthorizationVersion: 1 };

  // Everything Hermes and the web give the same asker.
  const observe = async () => {
    const caps = await jwt(pool, async c => (await c.query('SELECT public.hermes_domain_capabilities_v1($1) value', [ORG])).rows[0].value);
    const helpers = await asCaller(pool, async c => {
      const grant = key => c.query('SELECT app_private.hermes_domain_grant_v2($1,$2,true,public.get_authorization_context_v1($1)) value', [ORG, key]);
      const meta = key => c.query('SELECT app_private.hermes_metadata_domain_grant_v1($1,$2,true,public.get_authorization_context_v1($1)) value', [ORG, key]);
      return { grantTasks: (await grant('tasks.view')).rows[0].value, grantContracts: (await grant('contracts.view')).rows[0].value,
        metaInvoices: (await meta('invoices.view')).rows[0].value,
        follow: (await c.query("SELECT app_private.hermes_task_follow_buildings_v1(c,'tasks.view') value FROM app_private.hermes_connections c WHERE c.id=$1",
          [prepared.id])).rows[0].value };
    });
    const web = await jwt(pool, async c => ({ buildings: (await c.query('SELECT id FROM public.buildings')).rows.map(r => r.id),
      jobs: (await c.query('SELECT id FROM public.jobs')).rows.map(r => r.id), invoices: (await c.query('SELECT id FROM public.invoices')).rows.map(r => r.id) }));
    const fastReceivables = await fast(pool, bind4, 'receivables');
    return { caps, ...helpers, web, fastReceivables, tasks: await normal1(pool, bind7, 'tasks'), open: await normal1(pool, bind7, 'tasks', { status: 'IN_PROGRESS' }),
      invoices: await normal1(pool, bind7, 'invoices'), receivables: await normal(pool, bind7, 'receivables') };
  };
  // Every Hermes building scope/row outside the asker's RLS, labelled.
  const leaks = o => [
    ...o.tasks.items.filter(r => !o.web.jobs.includes(r.id)).map(r => `tasks:${r.id}`),
    ...o.open.items.filter(r => !o.web.jobs.includes(r.id)).map(r => `open:${r.id}`),
    ...o.invoices.items.filter(r => !o.web.invoices.includes(r.id)).map(r => `invoices:${r.id}`),
    ...o.receivables.items.filter(r => !o.web.invoices.includes(r.id)).map(r => `receivables:${r.id}`),
    ...Object.entries(o.caps.permissions).flatMap(([key, cap]) => cap.buildingIds.filter(b => !o.web.buildings.includes(b)).map(b => `caps.${key}:${b}`)),
    ...o.grantTasks.buildingIds.filter(b => !o.web.buildings.includes(b)).map(b => `grant_v2:${b}`),
    ...o.metaInvoices.buildingIds.filter(b => !o.web.buildings.includes(b)).map(b => `metadata_grant:${b}`),
    ...o.follow.filter(b => !o.web.buildings.includes(b)).map(b => `task_follow:${b}`),
    ...o.fastReceivables.authority.buildingIds.filter(b => !o.web.buildings.includes(b)).map(b => `fast_scope:${b}`)];
  const withoutBuildings = caps => Object.fromEntries(Object.entries(caps.permissions).map(([key, cap]) => [key, { ...cap, buildingIds: null }]));

  // (1) Production bodies: the incident reproduces (RED before the file).
  const before = await observe();
  assert.deepEqual(sorted(before.web.buildings), [BUILDING], 'control: the RLS sees exactly the role building (claims are complete)');
  assert.deepEqual(sorted(before.web.jobs), sorted([JOB_IN, JOB_NONE, JOB_DONE]), 'control: the web hides the outside task only');
  assert.deepEqual(sorted(before.open.items.map(r => r.id)), sorted([JOB_IN, JOB_OUT, JOB_NONE]), 'the reported question: open tasks include the outside building');
  assert.deepEqual(sorted(leaks(before)), sorted([`tasks:${JOB_OUT}`, `open:${JOB_OUT}`, `invoices:${INVOICE_OUT}`, `receivables:${INVOICE_OUT}`,
    `caps.tasks.view:${OUTSIDE}`, `caps.invoices.view:${OUTSIDE}`, `grant_v2:${OUTSIDE}`, `metadata_grant:${OUTSIDE}`, `task_follow:${OUTSIDE}`, `fast_scope:${OUTSIDE}`]),
    'every per-key helper reached the building the web hides');
  assert.equal(absent(await pool.query("SELECT to_regprocedure('app_private.hermes_web_building_ids_v1(uuid)') oid")), true);

  // (2) The file, twice (idempotent): no leak, nothing else changed.
  await apply(pool, forwardSql()); await apply(pool, forwardSql());
  const after = await observe();
  assert.deepEqual(leaks(after), [], 'no Hermes scope or row outside the asker\'s RLS');
  assert.deepEqual(sorted(after.tasks.items.map(r => r.id)), sorted([JOB_IN, JOB_NONE, JOB_DONE]), 'tasks = the web\'s tasks (the one without a building kept)');
  assert.deepEqual(sorted(after.open.items.map(r => r.id)), sorted([JOB_IN, JOB_NONE]));
  assert.deepEqual([after.tasks.summary.count, after.open.summary.count, after.open.summary.byStatus], [3, 2, { IN_PROGRESS: 2 }], 'summary follows the rows');
  assert.deepEqual(sorted(after.invoices.items.map(r => r.id)), sorted([INVOICE, INVOICE2]));
  assert.deepEqual(after.receivables.items.map(r => r.id), [INVOICE]);
  for (const key of ['tasks.view', 'invoices.view', 'contracts.view', 'customers.view'])
    assert.deepEqual(after.caps.permissions[key].buildingIds, [BUILDING], key);
  assert.deepEqual(withoutBuildings(after.caps), withoutBuildings(before.caps), 'allowed/companyEnabled unchanged for every v1 key');
  assert.deepEqual(before.caps.permissions['contracts.view'].buildingIds, [BUILDING], 'a key no wider than buildings.view was already exact');
  assert.deepEqual({ ...after.grantTasks, buildingIds: null }, { ...before.grantTasks, buildingIds: null }, 'grant_v2: allowed/orgWide unchanged');
  assert.equal(after.grantTasks.orgWide, true, 'the ORGANIZATION override still opens rows without a building (web: can_access_org_entity)');
  assert.deepEqual([after.grantTasks.buildingIds, after.grantContracts, after.metaInvoices.buildingIds, after.follow],
    [[BUILDING], before.grantContracts, [BUILDING], [BUILDING]]);
  assert.deepEqual(after.fastReceivables.result.items, before.fastReceivables.result.items, 'the fast lane already read under RLS: same rows');
  const acl = (await pool.query(`SELECT has_function_privilege('authenticated','app_private.hermes_web_building_ids_v1(uuid)','EXECUTE') caller,
    has_function_privilege('authenticated','public.hermes_domain_capabilities_v1(uuid)','EXECUTE') caps`)).rows[0];
  assert.deepEqual(acl, { caller: false, caps: true }, 'helper private, capabilities still callable');

  // (3) Whoever the web shows the outside building keeps it: a super admin (has_full_building_scope) and a member with
  // buildings.view on the whole company. A key narrower than buildings.view stays narrower.
  await pool.query(`INSERT INTO public.super_admins VALUES('${USER}')`);
  const superAdmin = await observe();
  assert.deepEqual(leaks(superAdmin), []);
  assert(superAdmin.open.items.some(r => r.id === JOB_OUT) && superAdmin.web.jobs.includes(JOB_OUT), 'super admin: web and Hermes both show it');
  assert.deepEqual(superAdmin.caps.permissions['tasks.view'].buildingIds, sorted([BUILDING, OUTSIDE]));
  await pool.query(`DELETE FROM public.super_admins WHERE user_id='${USER}'`);
  await pool.query(`INSERT INTO public.member_permission_overrides(id,organization_id,membership_id,permission_key,effect)
    VALUES('${OVERRIDE_BUILDINGS}','${ORG}','${MEMBER}','buildings.view','ALLOW');
    INSERT INTO public.member_override_scopes VALUES('${ORG}','${OVERRIDE_BUILDINGS}','${ORG_SCOPE}');`);
  const companyWide = await observe();
  assert.deepEqual(leaks(companyWide), []);
  assert.deepEqual(sorted(companyWide.open.items.map(r => r.id)), sorted([JOB_IN, JOB_OUT, JOB_NONE]), 'buildings.view everywhere: the outside task is the web\'s too');
  assert.deepEqual(companyWide.caps.permissions['contracts.view'].buildingIds, [BUILDING], 'contracts.view (role, one building) stays narrower');
  await pool.query(`UPDATE public.member_permission_overrides SET revoked_at=now() WHERE id='${OVERRIDE_BUILDINGS}'`);
  assert.deepEqual(leaks(await observe()), []);

  // (4) $requires$ refuses an unexpected predecessor (a body that does not resolve the key scope).
  const saved = (await pool.query("SELECT pg_get_functiondef('app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)'::regprocedure) def")).rows[0].def;
  await pool.query(`CREATE OR REPLACE FUNCTION app_private.hermes_domain_grant_v2(p_org uuid,p_key text,p_enabled boolean,p_context jsonb)
    RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$ BEGIN RETURN NULL; END $fn$`);
  await assert.rejects(apply(pool, forwardSql()), /hermes_web_building_scope_requires_reviewed_helper: app_private\.hermes_domain_grant_v2/);
  await pool.query(saved);
  assert.deepEqual(leaks(await observe()), [], 'restored: the rejected run changed nothing');

  // (5) Prepared revert: the exact previous bodies (production md5 of 21/10), the helper dropped, the leak back; twice.
  const revert = readFileSync(REVERT_PATH, 'utf8');
  await apply(pool, revert); await apply(pool, revert);
  const digests = (await pool.query(`SELECT x.sig,md5(p.prosrc) md5 FROM unnest($1::text[]) x(sig) JOIN pg_proc p ON p.oid=to_regprocedure(x.sig)`,
    [Object.keys(PREVIOUS_MD5)])).rows;
  assert.deepEqual(Object.fromEntries(digests.map(r => [r.sig, r.md5])), PREVIOUS_MD5);
  assert.equal(absent(await pool.query("SELECT to_regprocedure('app_private.hermes_web_building_ids_v1(uuid)') oid")), true);
  assert(leaks(await observe()).includes(`tasks:${JOB_OUT}`), 'revert re-opens exactly the previous behaviour');
  await apply(pool, forwardSql());
  assert.deepEqual(leaks(await observe()), [], 'forward again after the revert');
});
// to_regprocedure(...) is NULL when the function does not exist.
function absent(result) { return result.rows[0].oid === null; }
