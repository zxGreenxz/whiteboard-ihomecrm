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
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { permissionShape, connectionPermissionSettings } from './connection-permissions.mjs';

// Real local PostgreSQL role/JWT-claim/RLS fixture. No signed HTTP JWT or
// PostgREST integration claim: this exercises the actual SQL under SET ROLE.
const migrationName = '20261019034754_hermes_inherit_crm_limits_v1.sql';
const originalMigration = readFileSync(new URL(`../../supabase/migrations/${migrationName}`, import.meta.url), 'utf8');
const legacyCompatibilityMigration = readFileSync(new URL('../../supabase/migrations/20261019061954_hermes_legacy_connection_json_compat_v1.sql', import.meta.url), 'utf8');
// Negative-control invocation changes SQL only in this disposable fixture;
// repository SQL is never edited while other agents/gates may read it.
const mutation = process.env.HERMES_TG2_SQL_MUTATION;
assert(!mutation || ['drop-exclusion', 'restore-blanket-policy'].includes(mutation));
const migration = mutation === 'drop-exclusion'
  ? originalMigration.replace('AND NOT(capability=ANY(NEW.excluded_read))', '')
  : mutation === 'restore-blanket-policy'
    ? originalMigration.replaceAll("c.permission_mode='legacy_allowlist' AND (NOT(c.read_capabilities", "(NOT(c.read_capabilities")
    : originalMigration;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [ORG, FOREIGN, USER, MEMBER, BUILDING, OTHER_BUILDING, ROLE, BINDING, ORG_SCOPE, BUILDING_SCOPE] = Array.from({length:10},(_,n)=>id(n+1));
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
const lit = value => `'${value.replaceAll("'", "''")}'`;
const array = values => `ARRAY[${values.map(lit).join(',')}]::text[]`;
const schema = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE hermes_store_executor;
CREATE SCHEMA auth; CREATE SCHEMA app_private; CREATE SCHEMA extensions; CREATE EXTENSION pgcrypto WITH SCHEMA extensions; CREATE TABLE auth.users(id uuid PRIMARY KEY);
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


function originalTables() {
 const source=readFileSync('supabase/migrations/20261012061447_hermes_assistant_identity_policy_v1.sql','utf8');
 return ['hermes_capabilities','hermes_assistants','hermes_org_policies','hermes_sessions','hermes_connections','hermes_connection_tokens']
 .map(name=>{const start=source.indexOf(`CREATE TABLE IF NOT EXISTS app_private.${name} (`);return source.slice(start,source.indexOf('\n);',start)+4);}).join('\n');
}
const common = ['app_private.scope_covers_v3','app_private.authorized_scope_v3','app_private.authorized_scope_all_v3',
 'app_private.has_any_scope_v3','public.is_super_admin','public.my_org_ids','public.can_access_org_entity',
 'public.get_authorization_context_v1','app_private.raise_malformed_override','app_private.authorize_tenant_action_v3',
 'app_private.hermes_session_gate_v1','app_private.hermes_store_read_connection_v1','app_private.hermes_member_v1','app_private.hermes_effective_org_policy_v1',
 'app_private.hermes_validate_limits_v1','app_private.lock_org_for_decision_v1','app_private.is_actor_offboarded_v1',
 'app_private.hermes_uuid_v1','app_private.hermes_integer_v1','app_private.hermes_request_v1',
 'app_private.hermes_envelope_v1','app_private.hermes_session_json_v1','app_private.append_authz_audit_v1'];
common.push('public.hermes_prepare_connection_v1');
const audit = `CREATE TABLE public.authorization_audit_events(id uuid PRIMARY KEY,organization_id uuid,occurred_at timestamptz,
 actor_user_id uuid,actor_membership_id uuid,event_type text,resource_type text,resource_id uuid,old_state jsonb,new_state jsonb,
 reason text,prev_hash text,event_hash text);`;
async function jwt(pool, work, user=USER) {
 const client=await pool.connect();try { await client.query('BEGIN');
 await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[user]);
 await client.query('SET LOCAL ROLE authenticated'); const result=await work(client);await client.query('COMMIT');return result;
 } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function setup(pool) {
 await pool.query(schema+originalTables()+audit);
 await pool.query("CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$");
 for(const name of common) {assert(live.has(name),name);await pool.query(live.get(name));}
 await pool.query(`INSERT INTO auth.users VALUES('${USER}');
 INSERT INTO organizations(id,status,authorization_version) VALUES('${ORG}','ACTIVE',1),('${FOREIGN}','ACTIVE',1);
 INSERT INTO organization_memberships(id,organization_id,user_id,status) VALUES('${MEMBER}','${ORG}','${USER}','ACTIVE');
 INSERT INTO authorization_scopes(id,organization_id,scope_type) VALUES('${ORG_SCOPE}','${ORG}','ORGANIZATION');
 INSERT INTO app_private.hermes_capabilities VALUES('assistant.context.read','read',true),('rooms.view','read',true),
 ('customers.view','read',true),('tasks.create','action',true),('not.ready','read',false);`);
 await pool.query('SET check_function_bodies=off');
 await pool.query(migration);await pool.query(migration); // Idempotency, same candidate.
 await pool.query(legacyCompatibilityMigration);await pool.query(legacyCompatibilityMigration);
 await pool.query('SET check_function_bodies=on');
 await pool.query(`GRANT USAGE ON SCHEMA app_private TO authenticated;
 CREATE TABLE public.hermes_fixture_rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid);
 ALTER TABLE public.hermes_fixture_rooms ENABLE ROW LEVEL SECURITY;
 CREATE POLICY crm_rooms ON public.hermes_fixture_rooms FOR SELECT TO authenticated USING (
  EXISTS(SELECT 1 FROM app_private.authorized_scope_v3('rooms.view',organization_id) a
   WHERE a.org_wide OR building_id=ANY(a.building_ids)));
 GRANT SELECT ON public.hermes_fixture_rooms TO authenticated;
 INSERT INTO public.buildings(id,organization_id) VALUES('${BUILDING}','${ORG}'),('${OTHER_BUILDING}','${FOREIGN}');
 INSERT INTO public.hermes_fixture_rooms VALUES('${BUILDING}','${ORG}','${BUILDING}'),('${OTHER_BUILDING}','${FOREIGN}','${OTHER_BUILDING}');
 INSERT INTO public.permission_definitions(key) VALUES('rooms.view'),('customers.view'),('tasks.create');
 INSERT INTO public.organization_roles VALUES('${ROLE}','${ORG}','ACTIVE');
 INSERT INTO public.role_bindings VALUES('${BINDING}','${ORG}','${MEMBER}','${ROLE}',now()-interval '1 day',null);
 INSERT INTO public.role_permissions VALUES('${ORG}','${ROLE}','rooms.view','ALLOW');
 INSERT INTO public.role_binding_scopes VALUES('${ORG}','${BINDING}','${ORG_SCOPE}');`);
}

async function settings(pool, connection, exclusions={read:[],action:[]}, scopeMode='unrestricted',scopeIds=[]) {
 return (await pool.query('SELECT app_private.hermes_store_connection_settings_v1($1::jsonb) value',[
 JSON.stringify({connectionId:connection.id,expectedEpoch:connection.epoch,permissionMode:'inherit_crm',exclusions,scopeMode,scopeIds})])).rows[0].value.connection;
}
test('TG2 actual PostgreSQL: legacy preserved, inheritance projections/exclusions survive registry/scope changes; atomic audit and cross-org', {timeout:120000},async t=>{
 const {pool,cleanup}=await localCluster(t);t.after(async()=>{await pool.end();cleanup();});await setup(pool);
 const prepared=await jwt(pool,async c=>(await c.query("SELECT public.hermes_prepare_connection_v2($1,'{customers.view}','{tasks.create}','unrestricted','{}') value",[ORG])).rows[0].value);
 assert.equal(prepared.permissionMode,'inherit_crm');assert.deepEqual(prepared.exclusions,{read:['customers.view'],action:['tasks.create']});
 assert.deepEqual(prepared.restrictions,{read:['assistant.context.read','rooms.view'],action:[]});assert.deepEqual(prepared.scopeIds,[ORG_SCOPE]);
 await assert.rejects(jwt(pool,c=>c.query("SELECT public.hermes_prepare_connection_v2($1,'{}','{}','unrestricted','{}')",[FOREIGN])),{code:'42501'});
 await assert.rejects(jwt(pool,c=>c.query('SELECT * FROM app_private.hermes_connections')),{code:'42501'});
 // A live encrypted-session shape and opaque digest stay byte-identical across
 // settings edits. No provider call/token replacement is needed.
 const credential=id(31),provider=id(32),operation=id(33),digest='a'.repeat(64);
 await pool.query("INSERT INTO app_private.hermes_org_policies(organization_id,enabled,version,read_capabilities,action_capabilities,scope_ids,updated_by) VALUES($1,true,1,'{}','{}','{}',$2)",[ORG,USER]);
 const lease=Date.now()+600000, sessionExpiry=Date.now()+3600000;
 const activated=(await pool.query('SELECT app_private.hermes_store_activate_v1($1::jsonb) value',[JSON.stringify({connectionId:prepared.id,
 expectedEpoch:1,operationId:operation,intentSecret:prepared.intentSecret,userId:USER,providerSessionId:provider,credentialRef:credential,
 tokenDigest:digest,tokenExpiresAt:lease,sessionExpiresAt:sessionExpiry,sessionEnvelope:{v:1,algorithm:'A256GCM',keyVersion:'fixture',nonce:'a'.repeat(16),tag:'a'.repeat(22),ciphertext:'abcd'}})])).rows[0].value;
 assert.equal(activated.status,'activated');
 // An explicit empty policy cannot turn inherited metadata into CRM authority;
 // activation remains possible and runtime intersection can safely be empty.
 let row=(await pool.query('SELECT app_private.hermes_connection_json_v1(c) value FROM app_private.hermes_connections c WHERE id=$1',[prepared.id])).rows[0].value;
 const originalToken=(await pool.query('SELECT * FROM app_private.hermes_connection_tokens')).rows[0];
 const allowedRows=await jwt(pool,c=>c.query('SELECT id FROM public.hermes_fixture_rooms ORDER BY id'));
 assert.deepEqual(allowedRows.rows.map(r=>r.id),[BUILDING]);
 await pool.query("UPDATE public.role_permissions SET effect='DENY' WHERE permission_key='rooms.view'");
 assert.deepEqual((await jwt(pool,c=>c.query('SELECT id FROM public.hermes_fixture_rooms'))).rows,[]);
 await pool.query("UPDATE public.role_permissions SET effect='ALLOW' WHERE permission_key='rooms.view'");
 assert.deepEqual((await jwt(pool,c=>c.query('SELECT id FROM public.hermes_fixture_rooms'))).rows.map(r=>r.id),[BUILDING]);
 await assert.rejects(jwt(pool,c=>c.query('SELECT app_private.hermes_store_connection_settings_v1($1::jsonb)',[JSON.stringify({})])),{code:'42501'});

 row=await settings(pool,row,{read:['customers.view'],action:['tasks.create']});
 assert.equal(row.epoch,3);assert.deepEqual(row.exclusions,prepared.exclusions);
 const joined=(await pool.query('SELECT app_private.hermes_store_read_connection_v1($1::jsonb) value',[JSON.stringify({tokenDigest:digest})])).rows[0].value;
 assert.equal(joined.status,'active');assert.equal(joined.connection.epoch,3);assert.deepEqual(joined.policy.read,[]);

 await pool.query("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability='customers.view'; UPDATE app_private.hermes_capabilities SET enabled=true WHERE capability='customers.view'; INSERT INTO app_private.hermes_capabilities VALUES('new.view','read',true)");
 row=(await pool.query('SELECT app_private.hermes_connection_json_v1(c) value FROM app_private.hermes_connections c WHERE id=$1',[row.id])).rows[0].value;
 assert.equal(row.epoch,3);assert(row.restrictions.read.includes('new.view'));assert(!row.restrictions.read.includes('customers.view'));assert(!row.restrictions.read.includes('not.ready'));
 await pool.query("INSERT INTO authorization_scopes(id,organization_id,scope_type) VALUES($1,$2,'BUILDING'),($3,$4,'BUILDING')",[BUILDING_SCOPE,ORG,id(34),FOREIGN]);
 row=(await pool.query('SELECT app_private.hermes_connection_json_v1(c) value FROM app_private.hermes_connections c WHERE id=$1',[row.id])).rows[0].value;
 assert.deepEqual(row.scopeIds,[ORG_SCOPE,BUILDING_SCOPE].sort());assert.equal(row.epoch,3);
 await pool.query('UPDATE authorization_scopes SET organization_id=$1 WHERE id=$2',[FOREIGN,BUILDING_SCOPE]);
 assert.deepEqual((await pool.query('SELECT scope_ids FROM app_private.hermes_connections WHERE id=$1',[row.id])).rows[0].scope_ids,[ORG_SCOPE]);
 await pool.query('UPDATE authorization_scopes SET organization_id=$1 WHERE id=$2',[ORG,BUILDING_SCOPE]);
 // A registry writer waiting on the connection cannot lose a concurrent
 // explicit exclusion: projection recomputes after the lock is released.
 const owner=await pool.connect(), registry=await pool.connect();
 try {
  await owner.query('BEGIN');await owner.query('SELECT id FROM app_private.hermes_connections WHERE id=$1 FOR UPDATE',[row.id]);
  const registryPid=(await registry.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  let finished=false;const pending=registry.query("INSERT INTO app_private.hermes_capabilities VALUES('concurrent.view','read',true)").then(()=>{finished=true;});
  let blocked=false;
  for(let attempt=0;attempt<100;attempt++) {
   blocked=(await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 value',[registryPid])).rows[0].value;
   if(blocked) break;
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert(blocked,'Registry projection must actually wait on the connection row before the competing edit');
  await owner.query("UPDATE app_private.hermes_connections SET excluded_read=array_append(excluded_read,'rooms.view') WHERE id=$1",[row.id]);
  assert.equal(finished,false);await owner.query('COMMIT');await pending;
  const projected=(await pool.query('SELECT * FROM app_private.hermes_connections WHERE id=$1',[row.id])).rows[0];
  assert(projected.read_capabilities.includes('concurrent.view'));assert(!projected.read_capabilities.includes('rooms.view'));
  assert.equal(Number(projected.epoch),3);
 } finally {await owner.query('ROLLBACK');owner.release();registry.release();}

 // Explicit re-enable is allowed on the same connection; limits cannot supply
 // CRM authority (the runtime and canonical RLS are exercised separately).
 row=await settings(pool,row);assert(row.restrictions.read.includes('customers.view'));assert(row.restrictions.action.includes('tasks.create'));
 assert.deepEqual((await pool.query('SELECT * FROM app_private.hermes_connection_tokens')).rows[0],originalToken);
 assert.equal((await pool.query('SELECT credential_ref FROM app_private.hermes_connections WHERE id=$1',[row.id])).rows[0].credential_ref,credential);
 const events=(await pool.query("SELECT * FROM authorization_audit_events WHERE event_type='HERMES_CONNECTION_SETTINGS_CHANGED' ORDER BY occurred_at")).rows;
 assert.equal(events.length,2);assert.equal(events[0].actor_user_id,USER);assert.equal(events[0].old_state.epoch,2);assert.equal(events[0].new_state.epoch,3);assert.equal(events[1].prev_hash,events[0].event_hash);
 assert(!JSON.stringify(events).includes(digest));assert(!JSON.stringify(events).includes('envelope'));
 assert.equal((await pool.query("SELECT nullif(current_setting('request.jwt.claim.sub',true),'') value")).rows[0].value,null);
 const stale={...row,epoch:row.epoch-1};await assert.rejects(settings(pool,stale),{code:'40001'});
 await assert.rejects(settings(pool,row,{read:['unknown.key'],action:[]}),{code:'22023'});
 // Deliberate audit rejection proves the settings write is rolled back.
 await pool.query("ALTER TABLE authorization_audit_events ADD CONSTRAINT reject_settings CHECK(event_type<>'HERMES_CONNECTION_SETTINGS_CHANGED') NOT VALID");
 await assert.rejects(settings(pool,row,{read:['rooms.view'],action:[]}),{code:'23514'});
 assert.equal((await pool.query('SELECT epoch FROM app_private.hermes_connections WHERE id=$1',[row.id])).rows[0].epoch,String(row.epoch));
 await pool.query('ALTER TABLE authorization_audit_events DROP CONSTRAINT reject_settings');
 // Legacy[] remains an explicit deny-all allowlist. Registry changes do not
 // infer either historical exclusions or inheritance for that row.
 await pool.query(`INSERT INTO app_private.hermes_connections(assistant_id,organization_id,user_id,intent_digest,intent_expires_at)
 VALUES($1,$2,$3,$4,now()+interval '5 minutes')`,[row.assistantId,ORG,USER,'b'.repeat(64)]);
 await pool.query("INSERT INTO app_private.hermes_capabilities VALUES('future.view','read',true)");
 const legacy=(await pool.query("SELECT app_private.hermes_connection_json_v1(c) value FROM app_private.hermes_connections c WHERE state='PENDING'")).rows[0].value;
 const v1Keys=['id','assistantId','organizationId','userId','state','epoch','restrictions','scopeIds'];
 // This is the exact v1 adapter key boundary, not a reproduction of its full
 // authorization logic. The deployed old adapter is independently reproduced
 // with synthetic data; current callers below consume actual PostgreSQL output.
 const v1Accepts=(value,keys=v1Keys)=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
 assert.deepEqual(Object.keys(legacy).sort(),[...v1Keys].sort());assert(v1Accepts(legacy));
 const historical=await pool.connect();try {
  await historical.query('BEGIN');
  await historical.query(live.get('app_private.hermes_connection_json_v1'));
  const original=(await historical.query('SELECT app_private.hermes_connection_json_v1(c) value FROM app_private.hermes_connections c WHERE id=$1',[legacy.id])).rows[0].value;
  assert.deepEqual(legacy,original,'Legacy JSON must equal the actual pre-TG2 PostgreSQL projection');
 } finally {await historical.query('ROLLBACK');historical.release();}
 assert.deepEqual(legacy.restrictions,{read:[],action:[]});assert.deepEqual(legacy.scopeIds,[]);
 assert(permissionShape(legacy,v1Keys));
 assert.deepEqual(connectionPermissionSettings(legacy,()=>assert.fail('legacy has no exclusions to parse'),()=>assert.fail('legacy rejected')),{});
 const inherited=await pool.query('SELECT app_private.hermes_connection_json_v1(c) value FROM app_private.hermes_connections c WHERE id=$1',[row.id]);
 assert(!v1Accepts(inherited.rows[0].value));assert.equal(inherited.rows[0].value.permissionMode,'inherit_crm');
 assert.deepEqual(inherited.rows[0].value.exclusions,{read:[],action:[]});
 assert.equal(Object.keys(inherited.rows[0].value).length,v1Keys.length+3);
 const renewal=(await pool.query('SELECT app_private.hermes_store_renew_connection_v1($1::jsonb) value',[JSON.stringify({tokenDigest:digest,
 connectionId:row.id,expectedEpoch:row.epoch,credentialRef:credential,expectedRevision:1,expectedExpiresAt:lease,requestedTtlMs:900000})])).rows[0].value;
 assert.equal(renewal.status,'renewed');assert(renewal.expiresAt>lease);
 await pool.query('SELECT app_private.hermes_store_revoke_connection_v1($1::jsonb)',[JSON.stringify({connectionId:row.id,expectedEpoch:row.epoch})]);
 const revoked=(await pool.query("SELECT * FROM authorization_audit_events WHERE event_type='HERMES_CONNECTION_REVOKED'")).rows[0];
 assert.equal(revoked.actor_user_id,USER);assert.equal(revoked.new_state.state,'revoked');

 await t.test('forward projection: current adapter prepare/activate/read/restrict/renew/revoke accepts legacy without v2 fields',async()=>{
  const preparedLegacy=await jwt(pool,async c=>(await c.query("SELECT public.hermes_prepare_connection_v1($1,'{}','{}','{}') value",[ORG])).rows[0].value);
  assert(v1Accepts(preparedLegacy,[...v1Keys,'intentSecret','intentExpiresAt']));
  const operations={activate:'activate',readConnection:'read_connection',restrictConnection:'restrict_connection',renewConnection:'renew_connection',revokeConnection:'revoke_connection'};
  const store=createDurableConnectionStore({transport:{call:async(operation,payload)=>{
   assert(Object.hasOwn(operations,operation));
   return (await pool.query(`SELECT app_private.hermes_store_${operations[operation]}_v1($1::jsonb) value`,[JSON.stringify(payload)])).rows[0].value;
  }}});
  const options={signal:AbortSignal.timeout(10000)},legacyCredential=id(41),legacyProvider=id(42),legacyDigest='c'.repeat(64),legacyLease=Date.now()+600000;
  const activation=await store.activate({prepared:preparedLegacy,operationId:id(43),credentialRef:legacyCredential,
   binding:{assistantId:preparedLegacy.assistantId,userId:USER,organizationId:ORG,sessionId:legacyProvider},tokenDigest:legacyDigest,
   tokenExpiresAt:legacyLease,sessionExpiresAt:Date.now()+3600000,sessionEnvelope:{v:1,algorithm:'A256GCM',keyVersion:'fixture',
    nonce:Buffer.alloc(12,1).toString('base64url'),tag:Buffer.alloc(16,1).toString('base64url'),ciphertext:Buffer.from('synthetic').toString('base64url')}},options);
  assert(v1Accepts(activation.connection));
  let snapshot=await store.readConnection({tokenDigest:legacyDigest},options);assert.equal(snapshot.status,'active');
  assert(v1Accepts(snapshot.connection,[...v1Keys,'tokenDigest','credentialRef','expiresAt']));
  assert.equal(snapshot.connection.permissionMode,undefined);
  const narrowed=await store.restrictConnection({connection:snapshot.connection,restrictions:{read:[],action:[]},scopeIds:[]},options);
  assert(v1Accepts(narrowed.connection));snapshot=await store.readConnection({tokenDigest:legacyDigest},options);
  const renewed=await store.renewConnection({tokenDigest:legacyDigest,connectionId:snapshot.connection.id,expectedEpoch:snapshot.connection.epoch,
   credentialRef:legacyCredential,expectedRevision:snapshot.session.revision,expectedExpiresAt:snapshot.connection.expiresAt,requestedTtlMs:900000},options);
  assert.equal(renewed.status,'renewed');assert(renewed.expiresAt>legacyLease);
  assert.equal((await store.revokeConnection({connectionId:snapshot.connection.id,expectedEpoch:snapshot.connection.epoch},options)).status,'revoked');
  assert.equal(await store.readConnection({tokenDigest:legacyDigest},options),null);
 });
});
