import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import pg from 'pg';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';
import { splitHermesFunctionStatements } from '../../scripts/hermes-task-function-contract.mjs';
import { candidateLocalPostgresBins, assertSupportedLocalPostgresVersion } from '../../scripts/network-center-disposable-db.mjs';

// A real, disposable PostgreSQL cluster, bound only to loopback. No vault,
// remote URL, production row, fake lock helper, or Supabase JWT receipt is used.
const migrationName = '20261019034254_hermes_metadata_read_snapshot_v1.sql';
const migration = readFileSync(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), 'utf8');
const rpcNames = ['hermes_group_action_context_v1', ...['work_memory', 'room_schedule', 'room_pass', 'task_create',
  'task_follow', 'customer_create', 'expense'].map(n => `hermes_${n}_capabilities_v1`),
...[1, 2, 3].map(n => `hermes_domain_capabilities_v${n}`)];
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [ORG, FOREIGN, USER, MEMBER, BUILDING, OTHER_BUILDING, ROLE, BINDING, ORG_SCOPE, BUILDING_SCOPE] =
  Array.from({ length: 10 }, (_, n) => id(n + 1));

function definitions() {
  const result = new Map();
  const inputs = ['supabase/baseline/schema.sql', ...readdirSync('supabase/migrations')
    .filter(n => n.endsWith('.sql') && n < migrationName).sort().map(n => `supabase/migrations/${n}`)];
  for (const path of inputs) {
    const sql = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    const statements = path.includes('/baseline/') ? splitSqlStatements(sql) : splitHermesFunctionStatements(sql);
    for (const statement of statements) {
      const match = /(?:^|\n)CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:public|app_private)\.\w+)\s*\(/i.exec(statement);
      if (match) result.set(match[1].toLowerCase(), statement.slice(match.index).trim());
    }
  }
  return result;
}

const live = definitions();
const common = ['app_private.scope_covers_v3', 'app_private.authorized_scope_v3', 'app_private.authorized_scope_all_v3',
  'app_private.has_any_scope_v3', 'app_private.is_actor_offboarded_v1', 'public.is_super_admin', 'public.my_org_ids',
  'public.can_access_org_entity', 'public.get_authorization_context_v1', 'app_private.raise_malformed_override',
  'app_private.lock_org_for_decision_v1', 'app_private.authorize_tenant_action_v3', 'app_private.hermes_member_v1',
  'app_private.hermes_effective_org_policy_v1', 'app_private.hermes_domain_grant_v2', 'app_private.hermes_w2_read_keys_v1',
  'app_private.hermes_w2_self_keys_v1', 'app_private.hermes_w2_grant_v1'];
const originals = rpcNames.map(n => live.get(`public.${n}`));
assert(originals.every(Boolean));
const allKeys = [...new Set([...originals, ...common.map(n => live.get(n))].join('\n')
  .match(/'([a-z_]+\.[a-z_.]+)'/g).map(s => s.slice(1, -1)))];
const actionKeys = ['chat_zalo.send', 'chat_zalo.manage_automation', 'assistant.memory.write', 'sale_phong.manage_pass_listings',
  'tasks.create', 'tasks.edit', 'tasks.delete', 'customers.create', 'leads.create', 'income_expenses.create', 'income_expenses.approve'];
const lit = value => `'${value.replaceAll("'", "''")}'`;
const array = values => `ARRAY[${values.map(lit).join(',')}]::text[]`;

const schema = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE hermes_store_executor;
CREATE SCHEMA auth; CREATE SCHEMA app_private;
GRANT USAGE ON SCHEMA auth TO authenticated;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role',true) $$;
CREATE TABLE public.organizations(id uuid PRIMARY KEY,status text,authorization_version bigint DEFAULT 1,name text,is_demo boolean);
CREATE TABLE public.organization_memberships(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,user_id uuid,
  status text,valid_from timestamptz,valid_to timestamptz,revoked_at timestamptz,activated_at timestamptz,member_type text);
CREATE TABLE public.super_admins(user_id uuid PRIMARY KEY);
CREATE TABLE public.permission_definitions(key text PRIMARY KEY,permission_domain text DEFAULT 'TENANT',is_active boolean DEFAULT true,
  scope_kinds text[] DEFAULT '{ORGANIZATION,BUILDING,AREA,CASHBOOK}',required_dimensions text[] DEFAULT '{}',
  requires_cashbook_possession boolean DEFAULT false,accepted_possession_kinds text[] DEFAULT '{}');
CREATE TABLE app_private.tenant_emergency_denies(organization_id uuid,permission_key text,active_from timestamptz,expires_at timestamptz);
CREATE TABLE public.organization_roles(id uuid PRIMARY KEY,organization_id uuid,status text);
CREATE TABLE public.role_permissions(organization_id uuid,role_id uuid,permission_key text,effect text);
CREATE TABLE public.role_bindings(id uuid PRIMARY KEY,organization_id uuid,membership_id uuid,role_id uuid,valid_from timestamptz,valid_to timestamptz);
CREATE TABLE public.authorization_scopes(id uuid PRIMARY KEY,organization_id uuid,scope_type text,area_id uuid,building_id uuid,cashbook_id uuid);
CREATE TABLE public.role_binding_scopes(organization_id uuid,role_binding_id uuid,scope_id uuid);
CREATE TABLE public.member_permission_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,membership_id uuid,
  permission_key text,effect text,scope_mode text,expires_at timestamptz,revoked_at timestamptz);
CREATE TABLE public.member_override_scopes(organization_id uuid,override_id uuid,scope_id uuid);
CREATE TABLE public.area_buildings(organization_id uuid,area_id uuid,building_id uuid);
CREATE TABLE public.cashbook_possession_bindings(organization_id uuid,membership_id uuid,cashbook_id uuid,possession_kind text,valid_from timestamptz,valid_to timestamptz);
CREATE TABLE public.buildings(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
CREATE TABLE public.accounts(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
CREATE TABLE app_private.hermes_capabilities(capability text PRIMARY KEY,mode text,enabled boolean);
CREATE TABLE app_private.hermes_org_policies(organization_id uuid PRIMARY KEY,enabled boolean,version bigint,
  read_capabilities text[],action_capabilities text[],scope_ids uuid[]);
`;
const seed = `
INSERT INTO public.organizations(id,status,name) VALUES('${ORG}','ACTIVE','Fixture A'),('${FOREIGN}','ACTIVE','Fixture B');
INSERT INTO public.organization_memberships(id,organization_id,user_id,status,valid_from,member_type)
  VALUES('${MEMBER}','${ORG}','${USER}','ACTIVE',now()-interval '1 day','STAFF');
INSERT INTO public.buildings(id,organization_id) VALUES('${BUILDING}','${ORG}'),('${OTHER_BUILDING}','${ORG}');
INSERT INTO public.permission_definitions(key) SELECT unnest(${array(allKeys)});
UPDATE public.permission_definitions SET scope_kinds='{ORGANIZATION}' WHERE key LIKE 'chat_zalo.%';
INSERT INTO public.organization_roles VALUES('${ROLE}','${ORG}','ACTIVE');
INSERT INTO public.role_bindings VALUES('${BINDING}','${ORG}','${MEMBER}','${ROLE}',now()-interval '1 day',null);
INSERT INTO public.role_permissions SELECT '${ORG}','${ROLE}',key,'ALLOW' FROM public.permission_definitions;
INSERT INTO public.authorization_scopes VALUES('${ORG_SCOPE}','${ORG}','ORGANIZATION',null,null,null),
  ('${BUILDING_SCOPE}','${ORG}','BUILDING',null,'${BUILDING}',null);
INSERT INTO public.role_binding_scopes VALUES('${ORG}','${BINDING}','${ORG_SCOPE}');
INSERT INTO app_private.hermes_capabilities SELECT key,CASE WHEN key=ANY(${array(actionKeys)}) THEN 'action' ELSE 'read' END,true
  FROM public.permission_definitions;
INSERT INTO app_private.hermes_org_policies VALUES('${ORG}',true,1,${array(allKeys.filter(k => !actionKeys.includes(k)))},${array(actionKeys)},ARRAY['${ORG_SCOPE}']::uuid[]);
`;

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 30000, windowsHide: true, ...options });
  assert.equal(result.status, 0, `${binary}: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
async function localCluster(t) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const bin = candidateLocalPostgresBins().find(p => existsSync(join(p, `initdb${suffix}`)));
  assert(bin, 'PostgreSQL 16+ required: set POSTGRES_BIN; no remote fallback');
  const binary = name => join(bin, name + suffix);
  const version = run(binary('initdb'), ['--version']);
  assertSupportedLocalPostgresVersion('initdb', version); t.diagnostic(version.trim());
  const root = mkdtempSync(join(tmpdir(), 'hermes-metadata-pg-'));
  const server = createServer();
  await new Promise((ok, bad) => server.once('error', bad).listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  await new Promise(ok => server.close(ok));
  let started = false;
  const cleanup = () => {
    if (started) run(binary('pg_ctl'), ['-D', root, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
    const target = resolve(root), temp = resolve(tmpdir()) + sep;
    assert(target.startsWith(temp) && target.slice(temp.length).startsWith('hermes-metadata-pg-'));
    rmSync(target, { recursive: true });
  };
  try {
    run(binary('initdb'), ['-D', root, '--auth=trust', '--username=postgres', '--encoding=UTF8', '--no-locale']);
    const sockets = process.platform !== 'win32' ? " -k ''" : '';
    run(binary('pg_ctl'), ['-D', root, '-l', join(root, 'postgres.log'), '-o', `-p ${port} -h 127.0.0.1${sockets}`, '-w', 'start'], { stdio: 'ignore' });
    started = true;
    const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 6,
      connectionTimeoutMillis: 5000, options: '-c statement_timeout=10000' });
    return { pool, cleanup };
  } catch (error) { cleanup(); throw error; }
}

async function actor(client, work, org = ORG) {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [USER]);
    await client.query('SET LOCAL ROLE authenticated');
    return await work(org);
  } finally { await client.query('ROLLBACK'); }
}
async function snapshot(client, change = '', org = ORG, readOnly = false) {
  await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
  try {
    if (change) await client.query(change);
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [USER]);
    await client.query('SET LOCAL ROLE authenticated');
    const result = {};
    for (const fn of rpcNames) {
      await client.query('SAVEPOINT one_rpc');
      try { result[fn] = (await client.query(`SELECT public.${fn}($1::uuid) value`, [org])).rows[0].value; }
      catch (error) { result[fn] = { error: error.code }; await client.query('ROLLBACK TO SAVEPOINT one_rpc'); }
    }
    return result;
  } finally { await client.query('ROLLBACK'); }
}

test('TG-L: eleven metadata RPCs preserve CRM/ceilings/scope and use one lock-free snapshot on real PostgreSQL', { timeout: 120000 }, async t => {
  const { pool, cleanup } = await localCluster(t);
  const client = await pool.connect(); t.after(async () => { client.release(); await pool.end(); cleanup(); });
  await client.query(schema);
  for (const name of common) { assert(live.has(name), name); await client.query(live.get(name) + ';'); }
  for (const sql of originals) await client.query(sql + ';');
  await client.query(rpcNames.map(n => `REVOKE ALL ON FUNCTION public.${n}(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION public.${n}(uuid) TO authenticated;`).join('\n'));
  await client.query(seed);
  const scenarios = [
    ['granted', ''],
    ['policy disabled', 'UPDATE app_private.hermes_org_policies SET enabled=false'],
    ['explicit empty policy', "UPDATE app_private.hermes_org_policies SET read_capabilities='{}',action_capabilities='{}'"],
    ['missing neutral policy', 'DELETE FROM app_private.hermes_org_policies'],
    ['registry disabled', 'UPDATE app_private.hermes_capabilities SET enabled=false'],
    ['one building CRM scope', `UPDATE public.role_binding_scopes SET scope_id='${BUILDING_SCOPE}'`],
    ['CRM org deny', "UPDATE public.role_permissions SET effect='DENY'"],
    ['emergency deny', `INSERT INTO app_private.tenant_emergency_denies VALUES('${ORG}',null,now()-interval '1 hour',null)`],
    ['expired membership', "UPDATE public.organization_memberships SET valid_to=now()-interval '1 hour'"],
    ['revoked membership', 'UPDATE public.organization_memberships SET revoked_at=now()'],
    ['offboarded', "UPDATE public.organization_memberships SET status='SUSPENDED'"],
    ['multiple ordinary orgs', `INSERT INTO public.organization_memberships(organization_id,user_id,status) VALUES('${FOREIGN}','${USER}','ACTIVE')`],
    ['superadmin multiple orgs', `INSERT INTO public.super_admins VALUES('${USER}'); INSERT INTO public.organization_memberships(organization_id,user_id,status) VALUES('${FOREIGN}','${USER}','ACTIVE')`],
    ['cross tenant', '', FOREIGN],
    ['malformed zero-edge override', `INSERT INTO public.member_permission_overrides(organization_id,membership_id,permission_key,effect)
      SELECT '${ORG}','${MEMBER}',key,'DENY' FROM public.permission_definitions WHERE key LIKE 'chat_zalo.%'`],
    ['scoped deny follows CRM read semantics', `INSERT INTO public.member_permission_overrides(organization_id,membership_id,permission_key,effect)
      SELECT '${ORG}','${MEMBER}',key,'DENY' FROM public.permission_definitions WHERE key LIKE 'chat_zalo.%';
      INSERT INTO public.member_override_scopes SELECT '${ORG}',id,'${BUILDING_SCOPE}' FROM public.member_permission_overrides`],
  ];
  const before = new Map();
  for (const [name, sql, org] of scenarios) before.set(name, await snapshot(client, sql, org));
  assert.equal(before.get('granted').hermes_group_action_context_v1.allowed, true);
  assert.equal(before.get('granted').hermes_room_schedule_capabilities_v1.allowed, true);
  assert.deepEqual(before.get('one building CRM scope').hermes_domain_capabilities_v1.permissions['customers.view'].buildingIds, [BUILDING]);
  await t.test('legacy baseline: all eleven metadata reads wait behind the writer org lock', async () => {
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN'); await writer.query('SELECT app_private.lock_org_for_decision_v1($1)', [ORG]);
      await client.query("SET lock_timeout='100ms'");
      const baseline = await snapshot(client);
      assert.equal(Object.keys(baseline).length, 11);
      for (const value of Object.values(baseline)) assert.equal(value.error, '55P03');
    } finally { await client.query('SET lock_timeout=0'); await writer.query('ROLLBACK'); writer.release(); }
  });
  const unchanged = (await client.query(`SELECT p.oid::regprocedure::text signature,prosrc,provolatile,proacl::text FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1::text[]) ORDER BY signature`, [common])).rows;
  await client.query(migration); await client.query(migration);
  for (const [name, sql, org] of scenarios) await t.test(name, async () => {
    const expected = structuredClone(before.get(name));
    if (name === 'revoked membership' || name === 'scoped deny follows CRM read semantics') {
      // Deliberate correction to CRM read parity: the old writer evaluator did
      // not filter revoked_at while authorized_scope_v3 does. Keep the evidence
      // of that old grant instead of presenting this case as unchanged.
      assert.equal(expected.hermes_group_action_context_v1.allowed, true);
      assert.equal(expected.hermes_group_action_context_v1.readAllowed, true);
      expected.hermes_group_action_context_v1.allowed = false;
      expected.hermes_group_action_context_v1.readAllowed = false;
      if (name === 'scoped deny follows CRM read semantics') {
        // The writer's NULL target did not match a building DENY. CRM read
        // org_wide is false when any part of that org is explicitly denied.
        assert.equal(expected.hermes_room_schedule_capabilities_v1.allowed, true);
        expected.hermes_room_schedule_capabilities_v1.allowed = false;
      }
    }
    assert.deepEqual(await snapshot(client, sql, org), expected);
  });
  assert.deepEqual((await client.query(`SELECT p.oid::regprocedure::text signature,prosrc,provolatile,proacl::text FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname||'.'||p.proname=ANY($1::text[]) ORDER BY signature`, [common])).rows, unchanged, 'shared writer/read helpers remain byte-identical');
  await t.test('real SQL role ACL and catalog', async () => {
    for (const name of rpcNames) {
      const row = (await client.query(`SELECT provolatile,prosecdef,pg_get_userbyid(proowner) owner,proconfig FROM pg_proc WHERE oid=$1::regprocedure`, [`public.${name}(uuid)`])).rows[0];
      assert.equal(row.provolatile, 's'); assert.equal(row.prosecdef, true); assert.equal(row.owner, 'postgres');
      assert.deepEqual(row.proconfig, ['search_path=pg_catalog, public, app_private']);
      for (const role of ['anon', 'service_role', 'hermes_store_executor']) assert.equal((await client.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, `public.${name}(uuid)`])).rows[0].allowed, false);
    }
  });
  await t.test('all eleven metadata paths work in a real READ ONLY transaction', async () => {
    assert.deepEqual(await snapshot(client, '', ORG, true), before.get('granted'));
  });
  await t.test('held reader transactions permit readers in the same/different org and an org writer', async () => {
    const reader = await pool.connect(), writer = await pool.connect();
    try {
      await reader.query('BEGIN');
      await reader.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)", [USER]);
      await reader.query('SET LOCAL ROLE authenticated');
      await reader.query('SELECT public.hermes_group_action_context_v1($1)', [ORG]);
      await client.query("SET lock_timeout='150ms'");
      assert.equal((await snapshot(client)).hermes_group_action_context_v1.allowed, true);
      const foreign = await snapshot(client, `INSERT INTO public.super_admins VALUES('${USER}');
        INSERT INTO public.organization_memberships(organization_id,user_id,status) VALUES('${FOREIGN}','${USER}','ACTIVE')`, FOREIGN);
      assert.equal(foreign.hermes_group_action_context_v1.error, undefined);
      await writer.query('BEGIN'); await writer.query("SET LOCAL lock_timeout='150ms'");
      await writer.query('SELECT app_private.lock_org_for_decision_v1($1)', [ORG]);
      await writer.query('UPDATE public.organizations SET authorization_version=authorization_version+1 WHERE id=$1', [ORG]);
    } finally {
      await client.query('SET lock_timeout=0'); await reader.query('ROLLBACK'); await writer.query('ROLLBACK'); reader.release(); writer.release();
    }
  });
  await t.test('metadata completes while a writer holds the real org lock', async () => {
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('SELECT app_private.lock_org_for_decision_v1($1)', [ORG]);
      await client.query("SET statement_timeout='1500ms'");
      const result = await snapshot(client);
      for (const value of Object.values(result)) assert.equal(value.error, undefined);
      const otherWriter = await pool.connect();
      try {
        await otherWriter.query('BEGIN');
        await otherWriter.query("SET LOCAL lock_timeout='150ms'");
        await assert.rejects(otherWriter.query('SELECT app_private.lock_org_for_decision_v1($1)', [ORG]), { code: '55P03' });
      } finally { await otherWriter.query('ROLLBACK'); otherWriter.release(); }
      await writer.query('UPDATE public.organizations SET authorization_version=authorization_version+1 WHERE id=$1', [ORG]);
      await writer.query('COMMIT');
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });
  await t.test('permissions change between statements; each in-flight statement keeps its initial snapshot', async () => {
    const changer = await pool.connect();
    try {
      const query = actor(client, () => client.query(`SELECT public.hermes_group_action_context_v1($1) AS first_result,
        pg_sleep(1),public.hermes_room_schedule_capabilities_v1($1) AS second_result`, [ORG]));
      // Attach a rejection handler immediately so a SQL failure is attributed
      // to this subtest while the other connection performs its update.
      query.catch(() => {});
      let sleeping = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        sleeping = (await changer.query("SELECT wait_event='PgSleep' AS sleeping FROM pg_stat_activity WHERE pid=$1", [client.processID])).rows[0]?.sleeping;
        if (sleeping) break;
        await new Promise(ok => setTimeout(ok, 10));
      }
      assert(sleeping, 'the first capability completed and the same SQL statement is still in flight');
      await changer.query("UPDATE public.role_permissions SET effect='DENY' WHERE permission_key LIKE 'chat_zalo.%'");
      const row = (await query).rows[0];
      assert.equal(row.first_result.allowed, true); assert.equal(row.second_result.allowed, true);
      const next = await snapshot(client);
      assert.equal(next.hermes_group_action_context_v1.allowed, false);
      assert.equal(next.hermes_room_schedule_capabilities_v1.allowed, false);
    } finally { await changer.query("UPDATE public.role_permissions SET effect='ALLOW'"); changer.release(); }
  });
  await t.test('mutations prove policy ceiling and lock-free READ ONLY checks detect regressions', async () => {
    const candidate = new Map();
    for (const statement of splitHermesFunctionStatements(migration)) {
      const match = /CREATE OR REPLACE FUNCTION (public\.\w+)\(/i.exec(statement);
      if (match) candidate.set(match[1], statement.slice(match.index) + ';');
    }
    const memory = candidate.get('public.hermes_work_memory_capabilities_v1');
    await client.query(memory.replace('r:=policy.enabled AND', 'r:=true OR policy.enabled AND'));
    try {
      const result = await snapshot(client, 'UPDATE app_private.hermes_org_policies SET enabled=false');
      assert.equal(result.hermes_work_memory_capabilities_v1.readAllowed, true, 'mutation bypasses policy and is observable');
      assert.notDeepEqual(result, before.get('policy disabled'));
    } finally { await client.query(memory); }
    const group = candidate.get('public.hermes_group_action_context_v1');
    await client.query(group.replace('STABLE', 'VOLATILE').replace('BEGIN', 'BEGIN\nPERFORM app_private.lock_org_for_decision_v1(p_organization_id);'));
    try { assert.equal((await snapshot(client, '', ORG, true)).hermes_group_action_context_v1.error, '25006'); }
    finally { await client.query(group); }
  });
  await t.test('read dependency and ACL drift stop replay instead of silently accepting a changed catalog', async () => {
    await client.query('ALTER FUNCTION public.is_super_admin() VOLATILE');
    try { await assert.rejects(client.query(migration), /hermes_metadata_read_dependency_drift/); }
    finally { await client.query('ROLLBACK'); await client.query('ALTER FUNCTION public.is_super_admin() STABLE'); }
    await client.query('GRANT EXECUTE ON FUNCTION public.hermes_work_memory_capabilities_v1(uuid) TO service_role');
    try { await assert.rejects(client.query(migration), /hermes_metadata_catalog_drift/); }
    finally { await client.query('ROLLBACK'); await client.query('REVOKE EXECUTE ON FUNCTION public.hermes_work_memory_capabilities_v1(uuid) FROM service_role'); }
  });
  await t.test('catalog drift fails before overwrite', async () => {
    await client.query("CREATE OR REPLACE FUNCTION public.hermes_work_memory_capabilities_v1(p_organization_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER AS $$ BEGIN RETURN '{}'::jsonb; END $$");
    await assert.rejects(client.query(migration), /hermes_metadata_catalog_drift/);
    await client.query('ROLLBACK');
  });
});
