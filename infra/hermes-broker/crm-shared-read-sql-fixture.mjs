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

// Real local PostgreSQL role/JWT-claim/RLS fixture. No signed HTTP JWT or
// PostgREST integration claim: this exercises the actual SQL under SET ROLE.
const migrationName='20261019040055_crm_shared_read_cores_v1.sql';
const migration=readFileSync('supabase/migrations/20261019034754_hermes_inherit_crm_limits_v1.sql','utf8');
const sharedSql=readFileSync(`supabase/migrations/${migrationName}`,'utf8');
const fastSql=readFileSync('supabase/migrations/20261019040111_hermes_domain_read_fast_v1.sql','utf8');
// B2 (20261020101836) replaces the admission and the shared reader; the mutation
// probe targets that last definition because it is the one that runs.
const receivablesOriginal=readFileSync('supabase/migrations/20261020101836_hermes_domain_read_fast_receivables_v1.sql','utf8');
const receivablesSql=process.env.HERMES_SHARED_SQL_MUTATION==='primary-exclusion' ? receivablesOriginal.replace("IF state->'allowed' IS DISTINCT FROM 'true'::jsonb THEN",'IF false THEN') : receivablesOriginal;
// B5c (20261020171321) replaces the shared reader and hermes_domain_read_v2 again:
// receivables rows name their building on both lanes. Applied after B2, twice.
const buildingSql=readFileSync('supabase/migrations/20261020171321_hermes_receivables_building_name_v1.sql','utf8');
// B5c step 2 (20261020173818): the reader names the building/room on customers, contracts and
// invoices; hermes_domain_read_v1/v2 follow (requires v1 to be installed first). Applied last, twice.
const buildingNameSql=readFileSync('supabase/migrations/20261020173818_hermes_domain_reads_building_name_v1.sql','utf8');
// R2a (20261020233934): every list read of v1/v2 and the reader carries `summary` over the whole filtered
// set (requires B5c step 2 live). Applied after B5c step 2, twice (idempotent).
export const SUMMARY_PATH='supabase/migrations/20261020233934_hermes_domain_summary_v1.sql';
const summarySql=readFileSync(SUMMARY_PATH,'utf8');
// R2c (20261021035022): byType entries of the income_expenses summary name their largest voucher (v2 only; requires
// R2a live). Applied after R2a, twice (idempotent).
export const LARGEST_BY_TYPE_PATH='supabase/migrations/20261021035022_hermes_domain_summary_largest_by_type_v1.sql';
const largestByTypeSql=readFileSync(LARGEST_BY_TYPE_PATH,'utf8');
// R2c part 2 (20261021044801): the reader's customers summary counts the contract status (status_v2); v1 assets
// rows carry createdAt and the summary the latest asset. Applied after R2c, twice (idempotent).
export const CUSTOMER_STATUS_PATH='supabase/migrations/20261021044801_hermes_domain_customer_status_asset_created_v1.sql';
const customerStatusSql=readFileSync(CUSTOMER_STATUS_PATH,'utf8');
// R2d (20261021063452): the reader's customers summary counts the customers without a contract in the connection's
// contract scope (withoutContract, through the DEFINER helper hermes_customers_without_contract_v1); v1 assets count
// the latest import batch (latestCount). Applied after R2c part 2, twice (idempotent).
export const WITHOUT_CONTRACT_PATH='supabase/migrations/20261021063452_hermes_domain_without_contract_latest_count_v1.sql';
const withoutContractSql=readFileSync(WITHOUT_CONTRACT_PATH,'utf8');
// Nợ thực (22/10/2026): hàm dùng chung public.invoice_effective_outstanding_v1 (20261021183549), rồi cả hai
// đường đọc công nợ (v2 + đọc nhanh) không đếm hai lần nợ đã kéo sang hoá đơn gánh (20261021185540).
// Áp sau R2d, mỗi file hai lượt (idempotent).
export const OUTSTANDING_PATH='supabase/migrations/20261021183549_invoice_effective_outstanding_v1.sql';
const outstandingSql=readFileSync(OUTSTANDING_PATH,'utf8');
export const RECEIVABLES_OUTSTANDING_PATH='supabase/migrations/20261021185540_hermes_receivables_effective_outstanding_v1.sql';
const receivablesOutstandingSql=readFileSync(RECEIVABLES_OUTSTANDING_PATH,'utf8');
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
/** initdbArgs: extra initdb switches after the fixed C-locale set, e.g. the PostgreSQL 17
 * builtin C.UTF-8 provider when a test needs Unicode lower()/upper() like production. */
async function localCluster(t, { initdbArgs = [] } = {}) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const bin = candidateLocalPostgresBins().find(p => existsSync(join(p, `initdb${suffix}`)));
  assert(bin, 'PostgreSQL 16+ required: set POSTGRES_BIN; no remote fallback');
  const binary = name => join(bin, name + suffix);
  const version = run(binary('initdb'), ['--version']);
  assertSupportedLocalPostgresVersion('initdb', version); t.diagnostic(version.trim());
  // PostgreSQL 16 (CI runner) has no builtin locale provider: the libc C.UTF-8 locale
  // gives the same Unicode-aware lower()/upper() as production for these fixtures.
  const major = Number(/\b(\d+)\.\d+/.exec(version)?.[1]);
  const builtin = arg => arg.startsWith('--locale-provider=') || arg.startsWith('--builtin-locale=');
  const localeArgs = major >= 17 || !initdbArgs.some(builtin) ? initdbArgs : [...initdbArgs.filter(arg => !builtin(arg)), '--locale=C.UTF-8'];
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
    run(binary('initdb'), ['-D', root, '--auth=trust', '--username=postgres', '--encoding=UTF8', '--no-locale', ...localeArgs]);
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
const audit = `CREATE TABLE public.authorization_audit_events(id uuid PRIMARY KEY,organization_id uuid,occurred_at timestamptz,
 actor_user_id uuid,actor_membership_id uuid,event_type text,resource_type text,resource_id uuid,old_state jsonb,new_state jsonb,
 reason text,prev_hash text,event_hash text);`;
async function jwt(pool, work, user=USER) {
 const client=await pool.connect();try { await client.query('BEGIN');
 await client.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true)",[user]);
 await client.query('SET LOCAL ROLE authenticated'); const result=await work(client);await client.query('COMMIT');return result;
 } catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function setupBase(pool) {
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

const [ROOM,CUSTOMER,CUSTOMER2,HIDDEN,CONTRACT,CONTRACT2,INVOICE,INVOICE2]=Array.from({length:8},(_,i)=>id(i+100));
async function setup(pool) {
 await setupBase(pool);
 await pool.query(`ALTER TABLE auth.users ADD COLUMN email text;
 ALTER TABLE public.buildings ADD COLUMN user_id uuid,ADD COLUMN name text,ADD COLUMN name_sort text,ADD COLUMN code text,
 ADD COLUMN default_account_id_tt uuid,ADD COLUMN default_account_id_tk uuid;
 CREATE TYPE public.invoice_status AS ENUM('DRAFT','APPROVED','PARTIAL_PAID','PAID','OVERDUE','CANCELLED');
 CREATE TYPE public.payment_method AS ENUM('TM','TK','TT','CT');
 CREATE TABLE public.rooms(id uuid PRIMARY KEY,organization_id uuid,building_id uuid,name text,name_sort text,deleted_at timestamptz);
 CREATE TABLE public.customers(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,full_name text,phone text,email text,id_number text,
 customer_type text DEFAULT 'INDIVIDUAL',is_foreign boolean DEFAULT false,status_v2 text DEFAULT 'WALK_IN',created_at timestamptz,deleted_at timestamptz);
 CREATE TABLE public.contracts(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,room_id uuid,status text,contract_number text,
 start_date date,end_date date,actual_end_date date,expected_move_out_date date,parent_contract_id uuid,created_at timestamptz,deleted_at timestamptz,
 public_code text,start_billing_date date);
 CREATE TABLE public.contract_customers(id uuid PRIMARY KEY,organization_id uuid,contract_id uuid,customer_id uuid,is_representative boolean,created_at timestamptz);
 CREATE TABLE app_private.customer_residence_events(organization_id uuid,customer_id uuid,building_id uuid,room_id uuid);
 CREATE TABLE public.contract_exit_cases(contract_id uuid);
 CREATE TABLE public.contract_extensions(contract_id uuid,new_contract_id uuid,extension_type text,status text);
 CREATE TABLE public.invoices(id uuid PRIMARY KEY,organization_id uuid,user_id uuid,contract_id uuid,building_id uuid,room_id uuid,
 invoice_number text,billing_month text,issue_date date,due_date date,status public.invoice_status,total_amount numeric,paid_amount numeric,
 remaining_amount numeric GENERATED ALWAYS AS(total_amount-paid_amount) STORED,adjustment_review_status text,created_at timestamptz,deleted_at timestamptz,
 previous_debt numeric DEFAULT 0,previous_debt_sources jsonb NOT NULL DEFAULT '[]'::jsonb);
 CREATE TABLE public.invoice_items(id uuid,invoice_id uuid,type text,accounting_class text,description text,unit_price numeric,quantity numeric,coefficient numeric,amount numeric,
 service_id uuid,previous_reading numeric,current_reading numeric,from_date date,to_date date,sort_order integer);
 CREATE TABLE public.payments(id uuid,invoice_id uuid,amount numeric,payment_date date,payment_method public.payment_method,notes text,receipt_image_url text,collection_id uuid,reversed_at timestamptz);
 CREATE TABLE public.invoice_adjustments(id uuid,organization_id uuid,invoice_id uuid,revision bigint,idempotency_key text,reason text,before_snapshot jsonb,after_snapshot jsonb,before_total numeric,
 after_total numeric,delta numeric,adjusted_by uuid,adjusted_at timestamptz,review_status text,checked_by uuid,checked_at timestamptz);
 CREATE TABLE public.active_payment_receipts(organization_id uuid,invoice_id uuid,payment_method public.payment_method,collected_amount numeric);
 CREATE FUNCTION public.org_today_v1(uuid DEFAULT NULL) RETURNS date LANGUAGE sql STABLE AS $$ SELECT date '2026-10-19' $$;
 CREATE TABLE public.organization_timezones(organization_id uuid PRIMARY KEY,timezone text NOT NULL);
 CREATE TABLE public.areas(id uuid,organization_id uuid,deleted_at timestamptz);
 `);
 const support=['app_private.can_v3','public.is_admin','public.current_visible_owner_ids','public.sandbox_org_ids','public.demo_user_ids','public.can_access_building','public.can_do_on_building',
 'app_private.assert_residence_reader_v1','app_private.residence_contract_current_v2','app_private.residence_scope_v1',
 'public.customer_search_patterns_v1','public.customer_location_ids_v1','public.customer_list_v1','public.contract_display_status_v1','public.contract_display_label_v1',
 'public.contract_list_v1','public.invoice_scope_building_ids_v1','public.invoice_receipt_methods_v1','public.invoice_list_v1'];
 for(const name of support){assert(live.has(name),name);await pool.query(live.get(name));}
 for(const name of ['app_private.hermes_domain_grant_v2','app_private.hermes_w2_read_keys_v1','app_private.hermes_w2_self_keys_v1','app_private.hermes_w2_grant_v1',
 'public.hermes_group_action_context_v1',...['work_memory','room_schedule','room_pass','task_create','task_follow','customer_create','expense'].map(n=>`public.hermes_${n}_capabilities_v1`),
 ...[1,2,3].map(n=>`public.hermes_domain_capabilities_v${n}`)]) {assert(live.has(name),name);await pool.query(live.get(name));}
 for(const name of ['hermes_group_action_context_v1',...['work_memory','room_schedule','room_pass','task_create','task_follow','customer_create','expense'].map(n=>`hermes_${n}_capabilities_v1`),...[1,2,3].map(n=>`hermes_domain_capabilities_v${n}`)])
 await pool.query(`REVOKE ALL ON FUNCTION public.${name}(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;GRANT EXECUTE ON FUNCTION public.${name}(uuid) TO authenticated;`);
 // Family v2 reader (normal lane) and the date helper the B2 admission depends on,
 // so receivables can be compared normal-vs-fast on the same data and JWT.
 for(const name of ['app_private.hermes_domain_text_v1','app_private.hermes_domain_date_v2','app_private.hermes_private_command_connection_v1','public.hermes_domain_read_v2',
  // The company's business time zone (baseline): v1 dates the asset rows with it (R2c part 2).
  'app_private.org_timezone_v1',
  // Family v1 reader (normal lane of contracts/invoices) so the B5c step-2 migration can require it and the
  // fast rows can be compared with it on the same data and JWT.
  'app_private.hermes_domain_permission_v1','public.hermes_domain_read_v1'])
 {assert(live.has(name),name);await pool.query(live.get(name));}
 await pool.query(readFileSync('supabase/migrations/20261019034254_hermes_metadata_read_snapshot_v1.sql','utf8'));
 await pool.query(`INSERT INTO public.permission_definitions(key) VALUES('buildings.view'),('contracts.view'),('invoices.view') ON CONFLICT DO NOTHING;
 INSERT INTO public.role_permissions SELECT '${ORG}','${ROLE}',key,'ALLOW' FROM public.permission_definitions WHERE key IN('buildings.view','customers.view','contracts.view','invoices.view');
 UPDATE public.buildings SET user_id='${USER}',name='Fixture building',name_sort='fixture';
 INSERT INTO public.rooms VALUES('${ROOM}','${ORG}','${BUILDING}','P101','p101',null);
 INSERT INTO public.customers(id,organization_id,user_id,full_name,phone,created_at) VALUES
 ('${CUSTOMER}','${ORG}','${USER}','Nguyễn An','0900000000','2026-10-18'),('${CUSTOMER2}','${ORG}','${USER}','Bình','0910000000','2026-10-19'),
 ('${HIDDEN}','${ORG}','${id(999)}','Hidden Owner','0999000000','2026-10-20'),('${id(998)}','${FOREIGN}','${USER}','Foreign customer','0990000000','2026-10-20');
 INSERT INTO public.contracts(id,organization_id,user_id,room_id,status,contract_number,start_date,end_date,created_at) VALUES
 ('${CONTRACT}','${ORG}','${USER}','${ROOM}','ACTIVE','HD001','2026-01-01','2027-01-01','2026-10-18'),
 ('${CONTRACT2}','${ORG}','${USER}','${ROOM}','TERMINATED','HD002','2025-01-01','2026-01-01','2026-10-19');
 INSERT INTO public.contract_customers VALUES('${id(201)}','${ORG}','${CONTRACT}','${CUSTOMER}',true,'2026-01-01'),
 ('${id(202)}','${ORG}','${CONTRACT2}','${CUSTOMER2}',true,'2026-01-01');
 INSERT INTO public.invoices(id,organization_id,user_id,contract_id,building_id,room_id,invoice_number,billing_month,status,total_amount,paid_amount,created_at) VALUES
 ('${INVOICE}','${ORG}','${USER}','${CONTRACT}','${BUILDING}','${ROOM}','HDON001','2026-09','APPROVED',123456.75,456.50,'2026-10-18'),
 ('${INVOICE2}','${ORG}','${USER}','${CONTRACT2}','${BUILDING}','${ROOM}','HDON002','2026-10','CANCELLED',999.25,100,'2026-10-19');
 INSERT INTO app_private.hermes_capabilities VALUES('contracts.view','read',true),('invoices.view','read',true) ON CONFLICT DO NOTHING;
 `);
 // Real RLS plus the canonical CRM scope resolver and owner-membership helper.
 // These fixture policies deliberately name their limited scope; they are not
 // claimed as a restore of every production/demo policy.
 for(const [table,key,building] of [['buildings','buildings.view','id'],['rooms','buildings.view','building_id'],['invoices','invoices.view','building_id']]){
 await pool.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;
 CREATE POLICY fixture_crm ON public.${table} FOR SELECT TO authenticated USING(organization_id=ANY(public.my_org_ids()) AND EXISTS(
 SELECT 1 FROM app_private.authorized_scope_v3('${key}',organization_id) s WHERE s.org_wide OR ${building}=ANY(s.building_ids)));`);
 }
 await pool.query(`ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
 CREATE POLICY fixture_crm ON public.customers FOR SELECT TO authenticated USING(organization_id=ANY(public.my_org_ids()) AND user_id=ANY(public.current_visible_owner_ids())
 AND public.can_access_org_entity('customers','view'));
 ALTER TABLE public.contracts ENABLE ROW LEVEL SECURITY;
 CREATE POLICY fixture_crm ON public.contracts FOR SELECT TO authenticated USING(organization_id=ANY(public.my_org_ids()) AND (public.is_super_admin() OR EXISTS(
 SELECT 1 FROM public.rooms r WHERE r.id=room_id AND EXISTS(SELECT 1 FROM app_private.authorized_scope_v3('contracts.view',organization_id) s WHERE s.org_wide OR r.building_id=ANY(s.building_ids)))));
 ALTER TABLE public.contract_customers ENABLE ROW LEVEL SECURITY;
 CREATE POLICY fixture_crm ON public.contract_customers FOR SELECT TO authenticated USING(EXISTS(SELECT 1 FROM public.contracts c WHERE c.id=contract_id));
 GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
 `);
 const before={};for(const fn of ['customer_list_v1','contract_list_v1','invoice_list_v1'])before[fn]=await web(pool,fn);
 await pool.query(sharedSql);await pool.query(sharedSql);await pool.query(fastSql);
 await pool.query(receivablesSql);await pool.query(receivablesSql); // Idempotency, same candidate.
 await pool.query(buildingSql);await pool.query(buildingSql); // B5c after B2, twice.
 await pool.query(buildingNameSql);await pool.query(buildingNameSql); // B5c step 2 after B5c, twice.
 await pool.query(summarySql);await pool.query(summarySql); // R2a summary after B5c step 2, twice (idempotent).
 await pool.query(largestByTypeSql);await pool.query(largestByTypeSql); // R2c after R2a, twice (idempotent).
 await pool.query(customerStatusSql);await pool.query(customerStatusSql); // R2c part 2 after R2c, twice (idempotent).
 await pool.query(withoutContractSql);await pool.query(withoutContractSql); // R2d after R2c part 2, twice (idempotent).
 await pool.query(outstandingSql);await pool.query(outstandingSql); // Nợ thực: hàm dùng chung, twice (idempotent).
 await pool.query(receivablesOutstandingSql);await pool.query(receivablesOutstandingSql); // Nợ thực ở hai đường công nợ, twice.
 const after={};for(const fn of ['customer_list_v1','contract_list_v1','invoice_list_v1'])after[fn]=await web(pool,fn);
 assert.deepEqual(after,before,'All old web RPC rows, order, totals and embeds must remain byte-for-byte equivalent');
 return {before,after};
}
async function web(pool,fn,extra=''){
 return jwt(pool,async c=>(await c.query(`SELECT public.${fn}(${fn==='customer_list_v1'?`'${ORG}'::uuid`:''}${extra}) value`)).rows[0].value);
}
// Family v2 domains (receivables, income_expenses) send the seven-key input; v1/v3 keep five keys.
const domainInputOf=(domain,input)=>({query:'',limit:20,cursor:null,buildingId:null,status:null,...(['receivables','income_expenses'].includes(domain)?{fromDate:null,toDate:null}:{}),...input});
async function fast(pool,binding,domain,input={},actor={}) {
 return jwt(pool,async c=>{await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor.user??USER,session_id:actor.session??id(32)})]);
 return (await c.query('SELECT public.hermes_domain_read_fast_v1($1::jsonb,$2,$3::jsonb) value',[JSON.stringify(binding),domain,JSON.stringify(domainInputOf(domain,input))])).rows[0].value;},actor.user??USER);
}
// Normal lane of family v2 (hermes_domain_read_v2, seven-key binding) on the same JWT claims.
async function normal(pool,binding,domain,input={},actor={}) {
 return jwt(pool,async c=>{await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor.user??USER,session_id:actor.session??id(32)})]);
 return (await c.query('SELECT public.hermes_domain_read_v2($1::jsonb,$2,$3::jsonb) value',[JSON.stringify(binding),domain,JSON.stringify(domainInputOf(domain,input))])).rows[0].value;},actor.user??USER);
}
// Normal lane of family v1 (hermes_domain_read_v1, seven-key binding, five-key input) on the same JWT claims.
async function normal1(pool,binding,domain,input={},actor={}) {
 return jwt(pool,async c=>{await c.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:actor.user??USER,session_id:actor.session??id(32)})]);
 return (await c.query('SELECT public.hermes_domain_read_v1($1::jsonb,$2,$3::jsonb) value',[JSON.stringify(binding),domain,JSON.stringify(domainInputOf(domain,input))])).rows[0].value;},actor.user??USER);
}

export {settings,localCluster,setup,jwt,fast,normal,normal1,web,live,id,ORG,FOREIGN,USER,MEMBER,BUILDING,OTHER_BUILDING,ROLE,BINDING,ORG_SCOPE,BUILDING_SCOPE,ROOM,CUSTOMER,CUSTOMER2,HIDDEN,CONTRACT,CONTRACT2,INVOICE,INVOICE2};
