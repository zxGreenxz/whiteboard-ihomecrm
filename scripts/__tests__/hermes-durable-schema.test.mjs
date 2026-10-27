import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FORWARD_FUNCTIONS, FORWARD_ACL_BLOCKS, FORWARD_SUPERSEDED, INHERITED_CRM_ACL, FORWARD_DEFAULTS } from './hermes-durable-forward-fixture.mjs';
import { splitHermesFunctionStatements as splitSqlStatements, TASK_FUNCTIONS, extractHermesFunctionDefinitions } from '../hermes-task-function-contract.mjs';
import { buildTransaction } from '../apply-reviewed-migration.mjs';

// Static, source-level contracts only. These tests neither compile PL/pgSQL nor
// prove runtime grants, MVCC/concurrency, RLS or a successful database rollout.
// Always select the latest definition: a later forward migration must be able
// to turn these tests red instead of leaving a frozen historical test green.
const directory = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const sources = readdirSync(directory).filter(name => name.endsWith('.sql')).sort()
  .map(name => ({ name, sql: readFileSync(join(directory, name), 'utf8') }))
  .filter(({ sql }) => /\bhermes_/i.test(sql));
const clean = sql => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const digest = sql => createHash('sha256').update(clean(sql)).digest('hex');
const FORWARD_BY_NAME = new Map(FORWARD_FUNCTIONS.map(spec => [spec.name, spec]));
const FORWARD_REVOKE_ROLES = new Map([
  ...FORWARD_ACL_BLOCKS.find(block => block.name === 'shared-read').targets.map(([target]) => [target.split('(')[0], 'PUBLIC,anon,authenticated,service_role']),
  ['public.vehicles_list_core_v1', 'PUBLIC,anon,authenticated,service_role'],
  ...INHERITED_CRM_ACL.map(spec => [spec.name, spec.acl.find(statement => statement.startsWith('REVOKE ALL')).split(' FROM ')[1].replace(/\s/g, '')]),
]);
// CREATE OR REPLACE inherits these existing caller ACLs. Read their actual
// historical declaration and ACL, pin the complete source statements, then
// project only the one wrapper into this scoped replay (no invented grants).
const inheritedCrmStatements = INHERITED_CRM_ACL.flatMap(spec => {
  const source = splitSqlStatements(readFileSync(join(directory, spec.sourcePath.split('/').at(-1)), 'utf8')).map(clean);
  const definition = source.find(statement => statement.startsWith(`CREATE OR REPLACE FUNCTION ${spec.name}(`));
  assert.equal(digest(definition), spec.definitionSha256, `${spec.name}: inherited declaration source`);
  const acl = source.filter(statement => /^(?:GRANT|REVOKE|ALTER FUNCTION)/.test(statement) && statement.includes(`${spec.name}(`));
  assert.deepEqual(acl, spec.acl, `${spec.name}: exact inherited ACL source`);
  return [definition, ...acl.map(statement => {
    if (statement.startsWith('ALTER FUNCTION')) return `ALTER FUNCTION ${spec.signature} OWNER TO postgres`;
    const match = /^(GRANT EXECUTE|REVOKE ALL) ON FUNCTION .+ (TO|FROM) (.+)$/.exec(statement);
    assert(match, 'inherited ACL uses reviewed explicit syntax');
    return `${match[1]} ON FUNCTION ${spec.signature} ${match[2]} ${match[3]}`;
  })];
});
// The group migration re-closes the existing worker entry's ACL. Include its
// original declaration so that replay proves that its default PUBLIC grant is
// revoked too, rather than accepting an ACL target with no known signature.
const priorWorker = splitSqlStatements(readFileSync(join(directory, '20261011052259_zalo_rpc_only_scope_va_atomic_queue.sql'), 'utf8'))
  .map(clean).find(sql => /^CREATE OR REPLACE FUNCTION public\.zalo_worker_begin_provider_v1\(/i.test(sql));
assert(priorWorker, 'existing worker entry must have a source definition');
const statements = [priorWorker, ...inheritedCrmStatements, ...sources.flatMap(({ sql }) => splitSqlStatements(sql).map(clean))];
const functions = new Map();
for (const statement of statements) {
  const head = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:app_private|public)\.\w+)\(/i.exec(statement);
  // The legacy worker's body is patched dynamically, so only its declaration
  // participates in ACL replay; the newly declared companion is checked fully.
  if (head && (/\.hermes_/.test(head[1]) || FORWARD_BY_NAME.has(head[1]) || head[1] === 'public.zalo_worker_begin_hermes_group_provider_v1')) functions.set(head[1], statement);
}
const fn = (name, registry = functions) => {
  const value = registry.get(name.startsWith('public.') ? name : `app_private.${name}`);
  assert(value, `Missing current definition: ${name}`);
  return value;
};
const all = statements.join(';\n');
const STORE = ['activate', 'read_connection', 'restrict_connection', 'renew_connection', 'revoke_connection', 'acquire_refresh',
  'dispatch_refresh', 'stage_refresh', 'publish_refresh', 'reconnect_session', 'revoke_session', 'release_refresh',
  'claim_private_command', 'dispatch_private_command', 'finish_private_command', 'fail_private_command', 'prune_private_commands',
  'prune_work_memories', 'connection_settings'];
const PUBLIC = ['hermes_set_org_policy_v1(uuid,bigint,boolean,text[],text[],uuid[])',
  'hermes_prepare_connection_v1(uuid,text[],text[],uuid[])', 'hermes_my_connections_v1(uuid)',
  'hermes_connection_context_v1(uuid)', 'hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint)',
  'hermes_zalo_binding_v1(jsonb)', 'hermes_connection_options_v1(uuid)', 'hermes_org_policy_options_v1(uuid)',
  'hermes_connection_options_v2(uuid)', 'hermes_org_policy_options_v2(uuid)', 'hermes_connection_context_v2(uuid)',
  'hermes_group_action_context_v1(uuid)', 'hermes_group_directory_v1(jsonb)', 'hermes_group_preview_decision_v1(jsonb)',
  'hermes_group_send_v1(jsonb)', 'hermes_group_send_status_v1(uuid)', 'hermes_external_group_directory_v1(jsonb)',
  'hermes_external_group_preview_decision_v1(jsonb)', 'hermes_external_group_send_v1(jsonb)', 'hermes_external_group_send_status_v1(jsonb)',
  'hermes_work_memory_capabilities_v1(uuid)', 'hermes_work_memory_status_v1(jsonb)',
  'hermes_work_memory_configure_v1(jsonb,jsonb)', 'hermes_work_memory_list_v1(jsonb,jsonb)',
  'hermes_work_memory_upsert_v1(jsonb,jsonb)', 'hermes_work_memory_forget_v1(jsonb,jsonb)',
  'hermes_room_schedule_manage_v1(jsonb)', 'hermes_room_schedule_capabilities_v1(uuid)',
  // Published sale page read for crm_available_rooms/group preview (20261016080232).
  'hermes_sale_listing_rooms_v1(uuid)',
  // Hermes-owned rooms.view building scope, no Copilot wrapper (20261017023242).
  'hermes_scope_buildings_v1(text,uuid)',
  'hermes_domain_capabilities_v1(uuid)', 'hermes_domain_read_v1(jsonb,text,jsonb)',
  // Finance read family v2 and expense action (20261015120000/20261015120100).
  'hermes_domain_capabilities_v2(uuid)', 'hermes_domain_read_v2(jsonb,text,jsonb)',
  'hermes_expense_action_v1(jsonb,text,jsonb)', 'hermes_expense_capabilities_v1(uuid)',
  'hermes_org_policy_options_v3(uuid)', 'hermes_connection_options_v3(uuid)', 'hermes_connection_context_v3(uuid)',
  'hermes_room_pass_action_v1(jsonb,text,jsonb)', 'hermes_room_pass_capabilities_v1(uuid)',
  'hermes_org_policy_options_v4(uuid)', 'hermes_connection_options_v4(uuid)', 'hermes_connection_context_v4(uuid)',
  // Package C reconciliation/manage v2 (20261015100100) and package D task follow,
  // supervised/own memory and v6 options (20261015110000–20261015110200).
  'hermes_room_schedule_manage_v2(jsonb)', 'hermes_delivery_reconcile_list_v1(uuid)', 'hermes_delivery_reconcile_resolve_v1(jsonb)',
  'hermes_task_follow_read_v1(jsonb,jsonb)', 'hermes_task_follow_action_v1(jsonb,text,jsonb)', 'hermes_task_follow_capabilities_v1(uuid)',
  'hermes_my_task_follows_v1(uuid,jsonb)', 'hermes_my_task_follow_stop_v1(uuid,jsonb)',
  'hermes_work_memory_search_v1(jsonb,jsonb)', 'hermes_my_work_memory_v1(uuid,integer)', 'hermes_my_work_memory_configure_v1(uuid,jsonb)',
  'hermes_my_work_memory_edit_v1(uuid,jsonb)', 'hermes_my_work_memory_forget_v1(uuid,jsonb)',
  'hermes_org_policy_options_v6(uuid)', 'hermes_connection_options_v6(uuid)', 'hermes_connection_context_v6(uuid)',
  // Room-pass lookup/upsert/status caller (20261015162454).
  'hermes_room_pass_upsert_v1(jsonb,text,jsonb)',
  // Customer/lead action options layer over v6 (20261015191139).
  'hermes_org_policy_options_v7(uuid)', 'hermes_connection_options_v7(uuid)', 'hermes_connection_context_v7(uuid)',
  // CRM "Gửi ảnh phòng trống" status/recipients/send/cancel/update caller (20261016111855).
  'hermes_zalo_broadcast_v1(jsonb)',
  // Full read for the asker (20261016162104): room-pass wrapper over v1 and domain family v3.
  'hermes_room_pass_upsert_v2(jsonb,text,jsonb)', 'hermes_domain_read_v3(jsonb,text,jsonb)',
  // Wave 2 foundation (20261018000000): capability state of the wave-2 read keys.
  'hermes_domain_capabilities_v3(uuid)',
  // Wave 2 INVOKER report entry (20261018000600): package reads run under the asker's RLS.
  'hermes_w2_read_v1(jsonb,text,jsonb)',
  'hermes_prepare_connection_v2(uuid,text[],text[],text,uuid[])', 'hermes_domain_read_fast_v1(jsonb,text,jsonb)',
  // B3 (20261020101453): one filtered sale-room page per bound connection; the admission helper stays private.
  'hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)',
  // B5d (20261020175803): name directories under the asker's RLS (INVOKER) and the member-only company name (DEFINER).
  'hermes_building_directory_v1(uuid,uuid[])', 'hermes_room_directory_v1(uuid,uuid[],text)', 'hermes_organization_name_v1(uuid)',
  // Thu chi Mốc 3 (20261022044120): the building directory with virtual buildings for the income/expense key (INVOKER).
  'hermes_building_directory_v2(uuid,uuid[],boolean)',
  // R2c part 2 (20261021044821): the caller's own display name for crm_auth_context, under the caller's RLS (INVOKER).
  'hermes_user_display_name_v1()',
  // Bounded sale actions (20261020183546); input helpers remain private/invoker.
  'hermes_sale_actions_v1(jsonb,text,jsonb)', 'hermes_sale_capabilities_v1(uuid)',
  'hermes_org_policy_options_v8(uuid)', 'hermes_connection_options_v8(uuid)', 'hermes_connection_context_v8(uuid)',
  'hermes_sale_policy_actions_v1(jsonb,text,jsonb)', 'hermes_sale_policy_capabilities_v1(uuid)',
  'hermes_org_policy_options_v9(uuid)', 'hermes_connection_options_v9(uuid)', 'hermes_connection_context_v9(uuid)'];
const WORKER = ['public.hermes_zalo_ingress_v1(jsonb)', 'public.hermes_zalo_private_command_v1(jsonb)',
  'public.hermes_zalo_private_reply_v1(jsonb)', 'public.zalo_worker_begin_provider_v1(uuid,uuid)',
  'public.zalo_worker_begin_hermes_group_provider_v1(uuid,uuid,jsonb)',
  'public.hermes_room_schedule_due_v1(uuid,uuid[])', 'public.hermes_room_schedule_run_v1(uuid,bigint,uuid)',
  // Package C schedule health worker ports (20261015100000).
  'public.hermes_room_schedule_run_v2(uuid,bigint,uuid)', 'public.hermes_room_schedule_probe_v1(uuid,uuid)',
  'public.hermes_room_schedule_sweep_v1(uuid,uuid[])'];
// Non-Hermes Zalo one-shot surfaces declared in the same scanned file
// (20261016101450, patched by 20261016110539). The ACL replay stays fail-closed
// for every declared signature: these are the reviewed caller-only and
// worker-only grants; their private zalo_oneshot_* helpers must end with none.
const ZALO_ONESHOT_CALLER = ['public.zalo_hen_gui_phong_trong_v1(uuid[],text,timestamptz,text,text,uuid)',
  'public.zalo_huy_hen_gui_phong_trong_v1(uuid)', 'public.zalo_ds_hen_gui_phong_trong_v1(uuid,integer)', 'public.zalo_dung_khan_cap(uuid)'];
// The only reviewed table grant in a scanned file: the worker reads the one-shot
// queue (RPC-only for callers). Exact statement; any other table grant still fails.
const REVIEWED_TABLE_GRANTS = new Set(['GRANT SELECT ON public.zalo_automation_oneshots TO service_role']);
const ZALO_ONESHOT_WORKER = ['public.zalo_worker_claim_oneshot_v1(uuid,uuid[])', 'public.zalo_worker_finish_oneshot_v1(uuid,uuid,boolean,jsonb)',
  'public.zalo_enqueue_broadcast_oneshot_v1(uuid,uuid,uuid,text,timestamptz,text,jsonb)'];
// The package D SQL-standard invoker wrapper reaches exactly these three
// private steps by bound OID (same shape as the task/customer create wrappers).
const TASK_FOLLOW_STEPS = ['app_private.hermes_task_follow_guard_v1(jsonb,text,jsonb)',
  'app_private.hermes_task_follow_apply_v1(jsonb)', 'app_private.hermes_task_follow_finish_v1(jsonb,text,jsonb,jsonb)'];
const TABLES = ['capabilities', 'assistants', 'org_policies', 'sessions', 'connections', 'connection_tokens'];

// Intentionally a small fail-closed grammar for these reviewed SQL signatures,
// not a general SQL parser. NULL defaults and these exact worker-port defaults
// (pinned by function name and full argument text) are reviewed; other
// expressions/modes fail. A function may pin several reviewed defaults.
const TYPE = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*(?:\[\])?$/;
const REVIEWED_DEFAULTS = new Map([
  ...FORWARD_DEFAULTS,
  ['public.hermes_room_schedule_due_v1', [["p_organization_ids uuid[] DEFAULT '{}'", 'p_organization_ids uuid[]']]],
  ['public.hermes_room_schedule_sweep_v1', [["p_organization_ids uuid[] DEFAULT '{}'", 'p_organization_ids uuid[]']]],
  ['app_private.hermes_task_follow_tick_v1', [['p_limit integer DEFAULT 500', 'p_limit integer']]],
  // Zalo one-shot RPCs (20261016101450). That file is scanned because it re-creates
  // the tracked worker entry zalo_worker_begin_provider_v1; every signature it
  // declares still goes through this grammar, so its literal defaults are pinned.
  ['public.zalo_hen_gui_phong_trong_v1', [["p_mode text DEFAULT 'full'", 'p_mode text'], ["p_origin text DEFAULT 'ui'", 'p_origin text']]],
  ['public.zalo_ds_hen_gui_phong_trong_v1', [['p_limit integer DEFAULT 20', 'p_limit integer']]],
  ['public.zalo_worker_finish_oneshot_v1', [["p_result jsonb DEFAULT '{}'", 'p_result jsonb']]],
  // B3 room page (20261020101453): the connector always sends all seven arguments; these defaults are reviewed literals.
  ['public.hermes_available_rooms_page_v1', [["p_building_name text DEFAULT ''", 'p_building_name text'],
    ['p_limit integer DEFAULT 50', 'p_limit integer'], ['p_offset integer DEFAULT 0', 'p_offset integer']]],
]);
function signature(name, args, named = false) {
  const reviewed = named ? REVIEWED_DEFAULTS.get(name) ?? [] : [];
  const types = args.trim() === '' ? [] : args.split(',').map(arg => {
    const argument = reviewed.find(([text]) => arg.trim() === text)?.[1] ?? arg.trim();
    const parts = (named ? argument.replace(/\s+DEFAULT NULL$/i, '') : argument).split(/\s+/);
    assert.equal(parts.length, named ? 2 : 1, 'only the reviewed argument grammar is accepted');
    if (named) assert.match(parts[0], /^[a-z_][a-z0-9_]*$/);
    const type = parts.at(-1); assert.match(type, TYPE); return type;
  });
  return `${name}(${types.join(',')})`;
}
function aclTargets(text) {
  const targets = [], next = /\s*((?:app_private|public)\.[a-z_][a-z0-9_]*)\s*\(\s*([^()]*)\s*\)\s*(?:,|$)/gy;
  let cursor = 0;
  assert(text.length > 0 && !text.trimEnd().endsWith(','), 'ACL target list is complete');
  while (cursor < text.length) {
    next.lastIndex = cursor; const match = next.exec(text);
    assert(match, 'every ACL target must parse; never ignore mixed or unknown targets');
    targets.push(signature(match[1], match[2])); cursor = next.lastIndex;
  }
  assert.equal(new Set(targets).size, targets.length, 'no duplicate ACL targets');
  return targets;
}

// These four reviewed DO blocks are pinned in full, including loop predicates,
// cast, command order and recipients. This is an exact source adapter, not an
// interpreter for arbitrary dynamic SQL. Any changed/unknown function ACL block
// fails before replay; no name prefix or catalog query becomes an allowlist.
const CDE_ACL_BLOCKS = [
  { name: 'memory', sql: clean(`DO $acl$ DECLARE name text; sig regprocedure; BEGIN
  FOREACH name IN ARRAY ARRAY['hermes_work_memory_capabilities_v1(uuid)','hermes_work_memory_status_v1(jsonb)',
    'hermes_work_memory_configure_v1(jsonb,jsonb)','hermes_work_memory_list_v1(jsonb,jsonb)',
    'hermes_work_memory_upsert_v1(jsonb,jsonb)','hermes_work_memory_forget_v1(jsonb,jsonb)'] LOOP
    sig:=('public.'||name)::regprocedure;
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',sig);
  END LOOP;
  FOREACH name IN ARRAY ARRAY['hermes_work_memory_context_v1(jsonb,boolean)',
    'hermes_work_memory_settings_json_v1(app_private.hermes_work_memory_settings)'] LOOP
    sig:=('app_private.'||name)::regprocedure;
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',sig);
  END LOOP;
END $acl$`), targets: [
    ['public.hermes_work_memory_capabilities_v1(uuid)', 'authenticated'],
    ['public.hermes_work_memory_status_v1(jsonb)', 'authenticated'],
    ['public.hermes_work_memory_configure_v1(jsonb,jsonb)', 'authenticated'],
    ['public.hermes_work_memory_list_v1(jsonb,jsonb)', 'authenticated'],
    ['public.hermes_work_memory_upsert_v1(jsonb,jsonb)', 'authenticated'],
    ['public.hermes_work_memory_forget_v1(jsonb,jsonb)', 'authenticated'],
    ['app_private.hermes_work_memory_context_v1(jsonb,boolean)', null],
    ['app_private.hermes_work_memory_settings_json_v1(app_private.hermes_work_memory_settings)', null],
  ] },
  { name: 'schedule', sql: clean(`DO $permissions$
DECLARE signature text; name text;
BEGIN
  FOR signature,name IN SELECT p.oid::regprocedure::text,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='app_private' AND p.proname IN ('hermes_schedule_immutable_v1','hermes_schedule_settings_v1','hermes_schedule_actor_v1',
      'hermes_schedule_scope_v1','hermes_schedule_summary_v1','hermes_schedule_owner_v1','hermes_schedule_legacy_owner_v1',
      'hermes_schedule_binding_v1','hermes_schedule_current_v1'))
      OR (n.nspname='public' AND p.proname IN ('hermes_room_schedule_manage_v1','hermes_room_schedule_due_v1','hermes_room_schedule_run_v1')) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
    IF name='hermes_room_schedule_manage_v1' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',signature);
    ELSIF name IN ('hermes_room_schedule_due_v1','hermes_room_schedule_run_v1') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',signature); END IF;
  END LOOP;
END $permissions$`), targets: [
    ['app_private.hermes_schedule_immutable_v1()', null],
    ['app_private.hermes_schedule_settings_v1(jsonb,uuid)', null],
    ['app_private.hermes_schedule_actor_v1(jsonb,boolean)', null],
    ['app_private.hermes_schedule_scope_v1(uuid,jsonb,jsonb)', null],
    ['app_private.hermes_schedule_summary_v1(uuid)', null],
    ['app_private.hermes_schedule_owner_v1(uuid,uuid,jsonb)', null],
    ['app_private.hermes_schedule_legacy_owner_v1()', null],
    ['app_private.hermes_schedule_binding_v1(app_private.hermes_schedule_grants,uuid)', null],
    ['app_private.hermes_schedule_current_v1(jsonb)', null],
    ['public.hermes_room_schedule_manage_v1(jsonb)', 'authenticated'],
    ['public.hermes_room_schedule_due_v1(uuid,uuid[])', 'service_role'],
    ['public.hermes_room_schedule_run_v1(uuid,bigint,uuid)', 'service_role'],
  ] },
  { name: 'domain', sql: clean(`DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.hermes_domain_permission_v1(text)','app_private.hermes_domain_text_v1(text)',
    'app_private.hermes_domain_extend_options_v1(jsonb,text)',
    'public.hermes_domain_capabilities_v1(uuid)','public.hermes_domain_read_v1(jsonb,text,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
  END LOOP;
END $acl$`), targets: [
    ['app_private.hermes_domain_permission_v1(text)', null],
    ['app_private.hermes_domain_text_v1(text)', null],
    ['app_private.hermes_domain_extend_options_v1(jsonb,text)', null],
    ['public.hermes_domain_capabilities_v1(uuid)', null],
    ['public.hermes_domain_read_v1(jsonb,text,jsonb)', null],
  ] },
  { name: 'v3', sql: clean(`DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['public.hermes_org_policy_options_v3(uuid)','public.hermes_connection_options_v3(uuid)','public.hermes_connection_context_v3(uuid)','public.hermes_room_schedule_capabilities_v1(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',signature);
  END LOOP;
END $acl$`), targets: [
    ['public.hermes_org_policy_options_v3(uuid)', 'authenticated'],
    ['public.hermes_connection_options_v3(uuid)', 'authenticated'],
    ['public.hermes_connection_context_v3(uuid)', 'authenticated'],
    ['public.hermes_room_schedule_capabilities_v1(uuid)', 'authenticated'],
  ] },
];

// v4 is a separate exact adapter; keep the four reviewed C/D/E blocks and their
// mutation corpus unchanged. The public grants below this block replay normally.
const ROOM_PASS_OPTIONS_ACL = { name: 'room-pass-v4', sql: clean(`DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.hermes_room_pass_extend_options_v1(jsonb,text)',
    'public.hermes_org_policy_options_v4(uuid)','public.hermes_connection_options_v4(uuid)','public.hermes_connection_context_v4(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
  END LOOP;
END $acl$`), targets: [
  ['app_private.hermes_room_pass_extend_options_v1(jsonb,text)', null],
  ['public.hermes_org_policy_options_v4(uuid)', null],
  ['public.hermes_connection_options_v4(uuid)', null],
  ['public.hermes_connection_context_v4(uuid)', null],
] };
const TASK_OPTIONS_ACL = { name: 'task-v5', sql: clean(`DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.hermes_task_extend_options_v1(jsonb,text)',
    'public.hermes_org_policy_options_v5(uuid)','public.hermes_connection_options_v5(uuid)','public.hermes_connection_context_v5(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
  END LOOP;
END $acl$`), targets: [
  ['app_private.hermes_task_extend_options_v1(jsonb,text)', null],
  ['public.hermes_org_policy_options_v5(uuid)', null], ['public.hermes_connection_options_v5(uuid)', null],
  ['public.hermes_connection_context_v5(uuid)', null],
] };
const CUSTOMER_ACTION_ACL = { name: 'customer-create-v1', sql: clean(`DO $acl$ DECLARE signature text;BEGIN
 FOREACH signature IN ARRAY ARRAY['app_private.hermes_customer_guard_v1(jsonb,text,text,jsonb,boolean)','app_private.hermes_customer_insert_v1(jsonb)',
  'app_private.hermes_customer_finish_v1(jsonb,text,text,jsonb)','public.hermes_customer_create_action_v1(jsonb,text,text,jsonb)','public.hermes_customer_create_capabilities_v1(uuid)'] LOOP
  EXECUTE 'ALTER FUNCTION '||signature||' OWNER TO postgres';
  EXECUTE 'REVOKE ALL ON FUNCTION '||signature||' FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor';
  EXECUTE 'GRANT EXECUTE ON FUNCTION '||signature||' TO authenticated';
 END LOOP;
END $acl$`), targets: [
  ['app_private.hermes_customer_guard_v1(jsonb,text,text,jsonb,boolean)', 'authenticated'],
  ['app_private.hermes_customer_insert_v1(jsonb)', 'authenticated'],
  ['app_private.hermes_customer_finish_v1(jsonb,text,text,jsonb)', 'authenticated'],
  ['public.hermes_customer_create_action_v1(jsonb,text,text,jsonb)', 'authenticated'],
  ['public.hermes_customer_create_capabilities_v1(uuid)', 'authenticated'],
] };
// Package C/D forward ACL blocks (20261015100000–20261015110200), pinned in
// full like the blocks above. The two `catalog` loops select pg_proc by
// namespace and proname, so replay also refuses any extra overload. The three
// FOREACH blocks only revoke; their explicit GRANT statements replay normally.
const CD_FORWARD_ACL_BLOCKS = [
  { name: 'schedule-health', catalog: true, sql: clean(`DO $permissions$
DECLARE signature text; name text;
BEGIN
  FOR signature,name IN SELECT p.oid::regprocedure::text,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='app_private' AND p.proname IN ('hermes_schedule_incident_guard_v1','hermes_schedule_settings_v1','hermes_schedule_building_allowed_v1',
      'hermes_schedule_scope_v2','hermes_schedule_owner_state_v1','hermes_schedule_owner_v1','hermes_schedule_legacy_owner_v1',
      'hermes_schedule_policy_projection_v1','hermes_schedule_policy_body_v1','hermes_schedule_policy_snapshot_v1','hermes_schedule_current_v1',
      'hermes_schedule_diagnose_v1','hermes_schedule_incident_open_v1','hermes_schedule_incident_close_v1','hermes_schedule_observe_v1',
      'hermes_schedule_message_v1','hermes_schedule_notify_v1','hermes_schedule_close_blocked_day_v1'))
      OR (n.nspname='public' AND p.proname IN ('hermes_room_schedule_run_v1','hermes_room_schedule_run_v2','hermes_room_schedule_probe_v1',
        'hermes_room_schedule_sweep_v1')) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
    IF name IN ('hermes_room_schedule_run_v1','hermes_room_schedule_run_v2','hermes_room_schedule_probe_v1','hermes_room_schedule_sweep_v1')
      THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',signature); END IF;
  END LOOP;
END $permissions$`), targets: [
    ...['hermes_schedule_incident_guard_v1()', 'hermes_schedule_settings_v1(jsonb,uuid)',
      'hermes_schedule_building_allowed_v1(uuid,uuid,uuid,uuid[])', 'hermes_schedule_scope_v2(uuid,jsonb,jsonb,jsonb)',
      'hermes_schedule_owner_state_v1(uuid,uuid,jsonb)', 'hermes_schedule_owner_v1(uuid,uuid,jsonb)', 'hermes_schedule_legacy_owner_v1()',
      'hermes_schedule_policy_projection_v1(uuid,jsonb)', 'hermes_schedule_policy_body_v1(jsonb)',
      'hermes_schedule_policy_snapshot_v1(jsonb,app_private.hermes_schedule_grants,jsonb)', 'hermes_schedule_current_v1(jsonb)',
      'hermes_schedule_diagnose_v1(uuid)', 'hermes_schedule_incident_open_v1(uuid,text,text,jsonb)',
      'hermes_schedule_incident_close_v1(uuid,text[],text[],text)', 'hermes_schedule_observe_v1(uuid,jsonb)',
      'hermes_schedule_message_v1(text,text,jsonb,text,timestamptz)', 'hermes_schedule_notify_v1(uuid,text)',
      'hermes_schedule_close_blocked_day_v1(uuid,text)'].map(target => [`app_private.${target}`, null]),
    ['public.hermes_room_schedule_run_v1(uuid,bigint,uuid)', 'service_role'],
    ['public.hermes_room_schedule_run_v2(uuid,bigint,uuid)', 'service_role'],
    ['public.hermes_room_schedule_probe_v1(uuid,uuid)', 'service_role'],
    ['public.hermes_room_schedule_sweep_v1(uuid,uuid[])', 'service_role'],
  ] },
  { name: 'delivery-reconcile', catalog: true, sql: clean(`DO $permissions$
DECLARE signature text; name text;
BEGIN
  FOR signature,name IN SELECT p.oid::regprocedure::text,p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE (n.nspname='app_private' AND p.proname IN ('hermes_delivery_reconciliation_json_v1','hermes_delivery_reconcile_apply_v1',
      'hermes_delivery_reconcile_caller_v1','hermes_delivery_job_allowed_v1','hermes_delivery_reconcile_connector_v1','hermes_schedule_summary_v2'))
      OR (n.nspname='public' AND p.proname IN ('hermes_delivery_reconcile_list_v1','hermes_delivery_reconcile_resolve_v1','hermes_room_schedule_manage_v2')) LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
    IF name IN ('hermes_delivery_reconcile_list_v1','hermes_delivery_reconcile_resolve_v1','hermes_room_schedule_manage_v2')
      THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',signature); END IF;
  END LOOP;
END $permissions$`), targets: [
    ['app_private.hermes_delivery_reconciliation_json_v1(app_private.hermes_delivery_reconciliations)', null],
    ['app_private.hermes_delivery_reconcile_apply_v1(uuid,uuid,text,uuid,text,text,uuid,text,uuid)', null],
    ['app_private.hermes_delivery_reconcile_caller_v1(uuid)', null],
    ['app_private.hermes_delivery_job_allowed_v1(uuid,uuid,jsonb)', null],
    ['app_private.hermes_delivery_reconcile_connector_v1(app_private.hermes_connections,jsonb)', null],
    ['app_private.hermes_schedule_summary_v2(uuid)', null],
    ['public.hermes_delivery_reconcile_list_v1(uuid)', 'authenticated'],
    ['public.hermes_delivery_reconcile_resolve_v1(jsonb)', 'authenticated'],
    ['public.hermes_room_schedule_manage_v2(jsonb)', 'authenticated'],
  ] },
  { name: 'task-follow', sql: clean(`DO $acl$ DECLARE sig text; BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'app_private.hermes_task_dispatch_quota_v1()','app_private.hermes_task_follow_int_v1(jsonb,integer,integer)',
    'app_private.hermes_task_follow_text_v1(jsonb,integer,boolean)','app_private.hermes_task_follow_label_v1(text,integer)',
    'app_private.hermes_task_follow_iso_v1(timestamptz)','app_private.hermes_task_follow_member_v1(uuid,uuid)',
    'app_private.hermes_task_follow_name_v1(uuid)','app_private.hermes_task_follow_json_v1(app_private.hermes_task_follows)',
    'app_private.hermes_task_follow_connection_v1(jsonb)','app_private.hermes_task_follow_capable_v1(app_private.hermes_connections,text,text,text)',
    'app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)',
    'app_private.hermes_task_follow_building_v1(app_private.hermes_connections,text,uuid)',
    'app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)',
    'app_private.hermes_task_follow_notify_v1(uuid,uuid,text,jsonb,text,uuid)',
    'app_private.hermes_task_follow_guard_v1(jsonb,text,jsonb)','app_private.hermes_task_follow_apply_v1(jsonb)',
    'app_private.hermes_task_follow_finish_v1(jsonb,text,jsonb,jsonb)','app_private.hermes_task_follow_tick_v1(integer)',
    'public.hermes_task_follow_read_v1(jsonb,jsonb)','public.hermes_task_follow_action_v1(jsonb,text,jsonb)',
    'public.hermes_task_follow_capabilities_v1(uuid)','public.hermes_my_task_follows_v1(uuid,jsonb)',
    'public.hermes_my_task_follow_stop_v1(uuid,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',sig);
  END LOOP;
END $acl$`), targets: [
    'app_private.hermes_task_dispatch_quota_v1()', 'app_private.hermes_task_follow_int_v1(jsonb,integer,integer)',
    'app_private.hermes_task_follow_text_v1(jsonb,integer,boolean)', 'app_private.hermes_task_follow_label_v1(text,integer)',
    'app_private.hermes_task_follow_iso_v1(timestamptz)', 'app_private.hermes_task_follow_member_v1(uuid,uuid)',
    'app_private.hermes_task_follow_name_v1(uuid)', 'app_private.hermes_task_follow_json_v1(app_private.hermes_task_follows)',
    'app_private.hermes_task_follow_connection_v1(jsonb)', 'app_private.hermes_task_follow_capable_v1(app_private.hermes_connections,text,text,text)',
    'app_private.hermes_task_follow_buildings_v1(app_private.hermes_connections,text)',
    'app_private.hermes_task_follow_building_v1(app_private.hermes_connections,text,uuid)',
    'app_private.hermes_task_follow_grant_v1(app_private.hermes_task_follows)',
    'app_private.hermes_task_follow_notify_v1(uuid,uuid,text,jsonb,text,uuid)',
    'app_private.hermes_task_follow_guard_v1(jsonb,text,jsonb)', 'app_private.hermes_task_follow_apply_v1(jsonb)',
    'app_private.hermes_task_follow_finish_v1(jsonb,text,jsonb,jsonb)', 'app_private.hermes_task_follow_tick_v1(integer)',
    'public.hermes_task_follow_read_v1(jsonb,jsonb)', 'public.hermes_task_follow_action_v1(jsonb,text,jsonb)',
    'public.hermes_task_follow_capabilities_v1(uuid)', 'public.hermes_my_task_follows_v1(uuid,jsonb)',
    'public.hermes_my_task_follow_stop_v1(uuid,jsonb)'].map(target => [target, null]) },
  { name: 'memory-supervise', sql: clean(`DO $acl$ DECLARE sig text; BEGIN
  FOREACH sig IN ARRAY ARRAY['app_private.hermes_work_memory_int_v1(jsonb,integer,integer)',
    'app_private.hermes_memory_supervisor_v1(app_private.hermes_connections)','app_private.hermes_memory_shared_with_v1(text,jsonb)',
    'app_private.hermes_memory_owner_name_v1(uuid)','app_private.hermes_my_memory_owner_v1(uuid)',
    'app_private.hermes_my_memory_status_v1(uuid,uuid)','public.hermes_work_memory_configure_v1(jsonb,jsonb)',
    'public.hermes_work_memory_list_v1(jsonb,jsonb)','public.hermes_work_memory_search_v1(jsonb,jsonb)',
    'public.hermes_my_work_memory_v1(uuid,integer)','public.hermes_my_work_memory_configure_v1(uuid,jsonb)',
    'public.hermes_my_work_memory_edit_v1(uuid,jsonb)','public.hermes_my_work_memory_forget_v1(uuid,jsonb)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',sig);
  END LOOP;
END $acl$`), targets: [
    'app_private.hermes_work_memory_int_v1(jsonb,integer,integer)', 'app_private.hermes_memory_supervisor_v1(app_private.hermes_connections)',
    'app_private.hermes_memory_shared_with_v1(text,jsonb)', 'app_private.hermes_memory_owner_name_v1(uuid)',
    'app_private.hermes_my_memory_owner_v1(uuid)', 'app_private.hermes_my_memory_status_v1(uuid,uuid)',
    'public.hermes_work_memory_configure_v1(jsonb,jsonb)', 'public.hermes_work_memory_list_v1(jsonb,jsonb)',
    'public.hermes_work_memory_search_v1(jsonb,jsonb)', 'public.hermes_my_work_memory_v1(uuid,integer)',
    'public.hermes_my_work_memory_configure_v1(uuid,jsonb)', 'public.hermes_my_work_memory_edit_v1(uuid,jsonb)',
    'public.hermes_my_work_memory_forget_v1(uuid,jsonb)'].map(target => [target, null]) },
  { name: 'task-follow-v6', sql: clean(`DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.hermes_task_follow_extend_options_v1(jsonb,text)',
    'public.hermes_org_policy_options_v6(uuid)','public.hermes_connection_options_v6(uuid)','public.hermes_connection_context_v6(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
  END LOOP;
END $acl$`), targets: [
    'app_private.hermes_task_follow_extend_options_v1(jsonb,text)', 'public.hermes_org_policy_options_v6(uuid)',
    'public.hermes_connection_options_v6(uuid)', 'public.hermes_connection_context_v6(uuid)'].map(target => [target, null]) },
];
const REVIEWED_FUNCTION_ACL_BLOCKS = [...CDE_ACL_BLOCKS, ROOM_PASS_OPTIONS_ACL, TASK_OPTIONS_ACL, CUSTOMER_ACTION_ACL, ...CD_FORWARD_ACL_BLOCKS, ...FORWARD_ACL_BLOCKS];
const TASK_BY_NAME = new Map(TASK_FUNCTIONS.map(spec => [spec.name, spec]));
const CUSTOMER_INVOKER = new Set(['app_private.hermes_customer_insert_v1', 'public.hermes_customer_create_action_v1']);
// Wave 2 (20261018000600): the INVOKER report entry and the four package read functions (run under the
// asker's RLS). authenticated executes them plus the two DEFINER steps, reachable only through the entry's
// SQL-standard body (OIDs bound at creation; authenticated keeps no USAGE on app_private).
const W2_READERS = new Set(['a', 'b', 'c', 'd'].map(letter => `app_private.hermes_w2${letter}_read_v1`));
const W2_INVOKER = new Set(['public.hermes_w2_read_v1', ...W2_READERS]);
// B5d (20261020175803): the building/room directories run as the asker (RLS of buildings/rooms decides what is
// listed), so they are plpgsql STABLE INVOKER and may not name app_private; the company-name helper stays DEFINER.
const NAME_DIRECTORY_INVOKER = new Set(['public.hermes_building_directory_v1', 'public.hermes_room_directory_v1', 'public.hermes_user_display_name_v1',
  'public.hermes_building_directory_v2']);
const W2_CALLER = ['app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text)', 'app_private.hermes_w2_finish_v1(jsonb,jsonb,jsonb)',
  ...[...W2_READERS].map(name => `${name}(text,jsonb,jsonb)`)];
// Shared write foundation (20261021132433 name resolution, 20261021133823 guard/receipts/probe): the caller executes the two
// SQL-standard wrappers, the pure fold/room-key helpers, the status/capability readers, and only the app_private steps a
// wrapper binds (name-resolution core, guard, probe step). Receipt begin/finish and the reason map stay owner-only.
const WRITE_FOUNDATION_CALLER = ['public.hermes_name_fold_v1(text)', 'public.hermes_room_key_v1(text)',
  'app_private.hermes_write_name_resolve_core_v1(uuid,uuid[],jsonb,uuid[],boolean)', 'public.hermes_write_name_resolve_v1(uuid,uuid[],jsonb)',
  // Lượt 11 Công việc (20261023185114): loại việc trùng tên toà — helper INVOKER thuần đọc dưới RLS, lõi giải tên và lõi task gọi.
  'public.job_type_building_like_v1(uuid,text)',
  'app_private.hermes_action_guard_v1(jsonb,text)', 'app_private.hermes_action_probe_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
  'public.hermes_action_status_v1(jsonb,uuid)', 'public.hermes_action_capabilities_v1(uuid)',
  'public.hermes_action_probe_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
  // Đợt 2 Thu chi (20261022024834): vỏ expense.* gắn OID lõi giải tên (INVOKER) + bước ghi (DEFINER); ánh xạ lý do, chạy lô, định
  // dạng chỉ bước ghi gọi (owner-only).
  'app_private.hermes_expense_resolve_core_v1(uuid,uuid[],text,jsonb)', 'app_private.hermes_expense_write_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
  'public.hermes_expense_write_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
  // Thu chi Mốc 3: name resolution _v2 (virtual buildings; wrapper binds the core OID) and the expense scope step the wrapper binds
  // (guard ∩ the web writer's own authorize_income_expense_on_building, 20261022044120 / 20261022044123).
  'app_private.hermes_write_name_resolve_core_v2(uuid,uuid[],jsonb,uuid[],boolean,boolean)', 'public.hermes_write_name_resolve_v2(uuid,uuid[],jsonb,boolean)',
  'app_private.hermes_expense_scope_v1(jsonb,text)',
  // Thu chi lượt 11 (20261023210634): chọn hạng mục INVOKER mà lõi giải tên (chạy dưới vai authenticated) gọi theo tên public.
  'public.hermes_expense_category_pick_v1(uuid,text,text)',
  // Thu chi lượt 13 (20261024094809): luồng hệ thống — sql IMMUTABLE thuần chữ (không đọc bảng) mà bộ chọn hạng mục (INVOKER, dưới vai
  // authenticated) gọi theo tên public; bước ghi DEFINER cũng gọi.
  'public.hermes_expense_system_flow_v1(text,text)',
  // Đợt 3 Hoá đơn Mốc 3 (20261022075230): vỏ invoice.* gắn OID guard (đã có ở trên), tra cứu (INVOKER) và bước ghi (DEFINER; khoá hoá đơn
  // NOWAIT dưới khoá công ty của guard, rồi quyền thu của v5); ánh xạ lý do chỉ bước ghi gọi (owner-only).
  'app_private.hermes_invoice_lookup_core_v1(uuid,uuid[],text,jsonb)',
  'app_private.hermes_invoice_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)', 'public.hermes_invoice_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
  // Mốc 4 (20261022183445): vỏ chuyển invoice.meter_record sang tra cứu chỉ số (INVOKER) + bước ghi chỉ số (DEFINER); hàm số chỉ số owner-only.
  'app_private.hermes_invoice_meter_lookup_v1(uuid,uuid[],text,jsonb)', 'app_private.hermes_invoice_meter_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
  // Mốc 5 (20261023042723): vỏ chuyển điều chỉnh / xác nhận kiểm tra / huỷ / khôi phục sang tra cứu (INVOKER) + bước ghi (DEFINER; hợp đồng →
  // hoá đơn → điều chỉnh NOWAIT dưới khoá công ty của guard); ánh xạ lý do của nhánh này owner-only.
  'app_private.hermes_invoice_edit_lookup_v1(uuid,uuid[],text,jsonb)', 'app_private.hermes_invoice_edit_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
  // Lượt 8 (20261024041712): vỏ chuyển thu tiền sang tra cứu v2 (INVOKER) + bước ghi v2 (DEFINER; vẫn NOWAIT); tầng v1 giữ quyền, không còn được gọi.
  'app_private.hermes_invoice_lookup_core_v2(uuid,uuid[],text,jsonb)', 'app_private.hermes_invoice_action_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
  // Lượt 14 (20261024181440): vỏ chuyển thu tiền sang tra cứu v3 (INVOKER) + bước ghi v3 (DEFINER; vẫn NOWAIT), sửa/huỷ/khôi phục sang bước
  // ghi v2 (DEFINER; hợp đồng → hoá đơn NOWAIT); tầng cũ giữ quyền, không còn được gọi.
  'app_private.hermes_invoice_lookup_core_v3(uuid,uuid[],text,jsonb)', 'app_private.hermes_invoice_action_step_v3(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)',
  'app_private.hermes_invoice_edit_step_v2(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)'];
// Contract page write RPC (20261022022951): the caller executes the SQL-standard wrapper and the two functions it binds (the
// RLS lookup, the DEFINER step); the Vietnamese date label and the page reason map stay owner-only.
const CONTRACT_ACTION_CALLER = ['public.hermes_contract_action_lookup_v1(uuid,uuid)',
  'app_private.hermes_contract_action_step_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)',
  'public.hermes_contract_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
  // Mốc 5 (20261022074815): tra khách INVOKER mà vỏ gọi dưới vai authenticated.
  'public.hermes_contract_party_lookup_v1(uuid,uuid,uuid[],text,jsonb)',
  // Mốc 6 (20261023030305): tra lô INVOKER + bước ghi lô DEFINER mà vỏ gắn OID.
  'public.hermes_contract_batch_lookup_v1(uuid,uuid[],uuid,date)', 'app_private.hermes_contract_batch_step_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'];
// Đợt 2b Công việc (20261022031548 task.create, 20261022031600 người nhận thấy việc của mình): the caller executes the page
// wrapper, the two shared job helpers and the assignee rule, and only the app_private steps the wrapper binds (resolve core,
// building managers, prepare/write/finish). Quota and the date-text helper stay owner-only.
const TASK_ACTION_CALLER = ['public.job_deadline_v1(uuid,date,time)', 'public.job_open_duplicates_v1(uuid,uuid,uuid,uuid)',
  'app_private.hermes_task_building_managers_v1(uuid,uuid)', 'app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)',
  'app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)', 'app_private.hermes_task_action_write_v1(jsonb)',
  'app_private.hermes_task_action_finish_v1(jsonb,text,jsonb)', 'public.hermes_task_action_v1(jsonb,text,text,uuid,jsonb,jsonb,text)',
  'public.job_visible_as_assignee_v1(uuid)'];

function expandReviewedFunctionAcl(sql) {
  const declared = new Set();
  return splitSqlStatements(sql).map(clean).flatMap(statement => {
    const definition = /^CREATE (?:OR REPLACE )?FUNCTION ((?:app_private|public)\.\w+)\(([^)]*)\)/i.exec(statement);
    if (definition) declared.add(signature(definition[1], definition[2], true));
    const block = REVIEWED_FUNCTION_ACL_BLOCKS.find(candidate => candidate.sql === statement);
    if (!block) {
      if (/^DO\b/i.test(statement) && (/^DO \$acl\$/i.test(statement)
        || (/\bFUNCTION\b/i.test(statement) && /\b(?:GRANT|REVOKE|ALTER)\b/i.test(statement)))) {
        assert.fail('unreviewed function ACL DO block');
      }
      return [statement];
    }
    const targets = block.targets.map(([target]) => target);
    for (const target of targets) assert(declared.has(target), 'ACL loop targets a declared exact signature');
    if (block.name === 'schedule' || block.catalog) {
      // Unlike the other fixed signature arrays, pg_proc selects by namespace
      // and proname. Refuse additional overloads instead of silently replaying
      // a smaller set than PostgreSQL would mutate.
      const names = new Set(targets.map(target => target.split('(')[0]));
      assert.deepEqual([...declared].filter(target => names.has(target.split('(')[0])).sort(),
        [...targets].sort(), 'catalog ACL loop must resolve only the reviewed signatures');
    }
    return block.targets.flatMap(([target, role]) => [
      `ALTER FUNCTION ${target} OWNER TO postgres`,
      `REVOKE ALL ON FUNCTION ${target} FROM ${block.revokedRoles ?? 'PUBLIC,anon,authenticated,service_role,hermes_store_executor'}`,
      ...(role ? [`GRANT EXECUTE ON FUNCTION ${target} TO ${role}`] : []),
    ]);
  }).join(';\n');
}

// These private helpers use the narrower pg_catalog-only search path. Pin the
// entire definition so this exception cannot admit relation access or a new mode.
const CDE_CATALOG_HELPERS = new Map([
  ['app_private.hermes_work_memory_settings_json_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_work_memory_settings_json_v1(p app_private.hermes_work_memory_settings)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT jsonb_build_object('enabled',p.enabled,'sharing',p.sharing,'retentionDays',p.retention_days,'accessVersion',p.access_version)
$fn$`)],
  ['app_private.hermes_schedule_immutable_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_schedule_immutable_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN RAISE EXCEPTION 'hermes_schedule_evidence_immutable' USING ERRCODE='42501'; END $fn$`)],
  ['app_private.hermes_domain_permission_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_domain_permission_v1(p_domain text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT CASE p_domain WHEN 'customers' THEN 'customers.view' WHEN 'leads' THEN 'leads.view'
   WHEN 'contracts' THEN 'contracts.view' WHEN 'invoices' THEN 'invoices.view'
   WHEN 'assets' THEN 'assets.view' WHEN 'services' THEN 'services.view' WHEN 'tasks' THEN 'tasks.view'
   WHEN 'occupancy' THEN 'reports_real_estate.occupancy' END
$fn$`)],
  ['app_private.hermes_domain_text_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_domain_text_v1(p_text text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
 SELECT left(regexp_replace(translate(p_text,chr(8232)||chr(8233),'  '),'[[:cntrl:]]','','g'),200)
$fn$`)],
]);

// Package C/D private helpers outside the common DEFINER + app_private path rule:
// pg_catalog-only formatters/validators (DEFINER, or INVOKER with no mode) and
// two DEFINER readers with pg_catalog,public that read one fixed relation each.
// Pin every definition in full so no exception can admit another relation,
// statement, mode or path.
const CD_NARROW_PATH_HELPERS = new Map([
  ['app_private.hermes_schedule_incident_guard_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_schedule_incident_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.schedule_id IS DISTINCT FROM OLD.schedule_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
    OR NEW.occurrences<OLD.occurrences
    OR (OLD.closed_at IS NOT NULL AND (NEW.closed_at IS DISTINCT FROM OLD.closed_at OR NEW.close_reason IS DISTINCT FROM OLD.close_reason
      OR NEW.detail IS DISTINCT FROM OLD.detail OR NEW.occurrences IS DISTINCT FROM OLD.occurrences OR NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at))
    OR (OLD.notified_at IS NOT NULL AND (NEW.notified_at IS DISTINCT FROM OLD.notified_at OR NEW.notify_result IS DISTINCT FROM OLD.notify_result))
    OR (OLD.closed_notified_at IS NOT NULL AND NEW.closed_notified_at IS DISTINCT FROM OLD.closed_notified_at)
  THEN RAISE EXCEPTION 'hermes_schedule_incident_immutable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $fn$`)],
  ['app_private.hermes_schedule_policy_body_v1', clean(String.raw`CREATE OR REPLACE FUNCTION app_private.hermes_schedule_policy_body_v1(p jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
  SELECT 'CẬP NHẬT CHÍNH SÁCH SALE'
    ||COALESCE(E'\n'||(SELECT string_agg(v,E'\n' ORDER BY ord) FROM jsonb_array_elements_text(p->'commonPolicies') WITH ORDINALITY x(v,ord)),'')
    ||COALESCE(E'\nChính sách riêng từng phòng:\n'||(SELECT string_agg(ord::text||'. '||(f->>'buildingLabel')||' · '||(f->>'roomLabel')||': '||(f->>'note'),E'\n' ORDER BY ord)
      FROM jsonb_array_elements(p->'roomNotes') WITH ORDINALITY x(f,ord)),'')
    ||CASE WHEN jsonb_array_length(p->'commonPolicies')=0 AND jsonb_array_length(p->'roomNotes')=0
      THEN E'\nHiện không còn chính sách sale công khai trong phạm vi tòa đã chọn.' ELSE '' END
$fn$`)],
  ['app_private.hermes_schedule_message_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_schedule_message_v1(p_reason text,p_phase text,p_detail jsonb,p_label text,p_expires timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
  SELECT CASE WHEN p_phase='recovered' THEN jsonb_build_object('title','Lịch Hermes đã chạy lại',
      'body',p_label||' không còn lỗi đã báo; lịch tiếp tục theo nhịp đã đặt. Kết quả từng tin xem trong danh sách lịch.')
    ELSE jsonb_build_object('title',CASE p_reason WHEN 'grant_expiring' THEN 'Lịch Hermes sắp hết hạn' WHEN 'grant_expired' THEN 'Lịch Hermes đã hết hạn'
        WHEN 'delivery_unknown' THEN 'Tin của lịch Hermes chưa rõ kết quả' WHEN 'delivery_failed' THEN 'Tin của lịch Hermes chưa gửi được'
        ELSE 'Lịch Hermes đang bị chặn' END,
      'body',p_label||': '||CASE p_reason
        WHEN 'user_permission_revoked' THEN 'tài khoản không còn quyền CRM cần cho lịch ('||COALESCE(p_detail->>'permission','')||'). Nhờ quản trị cấp lại quyền hoặc thu hồi lịch.'
        WHEN 'hermes_overlay_revoked' THEN 'kết nối Hermes đã tắt quyền cần cho lịch ('||COALESCE(p_detail->>'capability','')||'). Tạo kết nối mới có đủ quyền rồi tạo lại lịch.'
        WHEN 'company_policy_revoked' THEN 'chính sách Hermes của công ty không còn cho phép quyền lịch đang dùng. Quản trị công ty cần bật lại; lịch tạm dừng đến khi đó.'
        WHEN 'company_policy_disabled' THEN 'công ty đang tắt Hermes. Lịch tạm dừng đến khi quản trị bật lại.'
        WHEN 'capability_disabled' THEN 'tính năng này đang tắt trên hệ thống. Lịch tạm dừng đến khi được bật lại.'
        WHEN 'template_disabled' THEN 'chế độ lịch này đang tắt trên hệ thống. Lịch tạm dừng đến khi được bật lại.'
        WHEN 'connection_revoked' THEN 'kết nối Hermes của lịch đã bị thu hồi. Kết nối lại Hermes và tạo lại lịch nếu vẫn cần.'
        WHEN 'connection_token_expired' THEN 'mã kết nối Hermes của lịch đã hết hạn. Kết nối lại Hermes và tạo lại lịch nếu vẫn cần.'
        WHEN 'session_expired' THEN 'phiên CRM của kết nối Hermes đã hết hạn. Kết nối lại Hermes và tạo lại lịch nếu vẫn cần.'
        WHEN 'membership_inactive' THEN 'tài khoản không còn là thành viên đang hoạt động của công ty.'
        WHEN 'scope_narrowed' THEN 'phạm vi tòa nhà của bạn hoặc của kết nối đã bị thu hẹp. Sửa lịch bỏ tòa không còn quyền, hoặc nhờ cấp lại phạm vi.'
        WHEN 'target_denied' THEN 'một số nhóm nhận không còn trong phạm vi được gửi. Các nhóm còn quyền vẫn chạy; sửa lịch để bỏ nhóm này.'
        WHEN 'timezone_changed' THEN 'múi giờ công ty đã đổi. Sửa lịch theo múi giờ mới.'
        WHEN 'zalo_binding_changed' THEN 'liên kết Zalo của Hermes đã đổi. Liên kết lại Zalo rồi tạo lại lịch.'
        WHEN 'zalo_sender_unavailable' THEN 'nick Zalo gửi hoặc worker Zalo chưa sẵn sàng. Kiểm tra kết nối Zalo trong CRM.'
        WHEN 'zalo_directory_too_large' THEN 'nick Zalo gửi có quá nhiều nhóm để kiểm phạm vi an toàn.'
        WHEN 'legacy_owner_active' THEN 'tự động hóa cũ đang gửi phòng trống cho cùng nhóm. Tắt tự động hóa cũ cho nhóm này hoặc bỏ nhóm khỏi lịch.'
        WHEN 'blocked_by_unknown_delivery' THEN 'còn tin trước đó chưa rõ đã tới nhóm hay chưa. Kiểm tra trên Zalo rồi xác nhận ở mục Đối soát trong Trợ lý Hermes; hệ thống không gửi lại tự động.'
        WHEN 'other_owner_delivery_pending' THEN 'tin của lịch khác cho cùng nhóm vẫn đang chờ gửi quá lâu. Kiểm tra hàng chờ Zalo.'
        WHEN 'owner_conflict' THEN 'đã có lịch khác cùng nghiệp vụ cho nhóm và tòa này. Thu hồi một trong hai lịch.'
        WHEN 'queue_capacity' THEN 'hàng chờ gửi Zalo của công ty đang đầy. Lịch sẽ thử lại trong khung giờ cho phép.'
        WHEN 'room_limit' THEN 'số phòng vượt giới hạn của lịch nên chưa gửi, không cắt bớt. Tăng giới hạn phòng hoặc thu hẹp tòa.'
        WHEN 'daily_limit' THEN 'đã chạm trần số tin mỗi ngày của lịch.'
        WHEN 'message_too_large' THEN 'nội dung vượt giới hạn một tin nên chưa gửi, không cắt bớt. Thu hẹp phạm vi lịch.'
        WHEN 'missed_window' THEN 'lịch hôm nay đã quá 180 phút sau giờ hẹn mà chưa xếp hàng được cho mọi nhóm; không gửi bù. Kiểm tra worker Zalo và các báo lỗi khác của lịch.'
        WHEN 'membership_ambiguous' THEN 'tài khoản đang thuộc nhiều công ty nên Hermes tạm dừng truy cập CRM. Nhờ quản trị kiểm tra tư cách thành viên.'
        WHEN 'no_sale_page' THEN 'công ty chưa có trang Sale phòng/link chia sẻ còn hiệu lực nên không có danh sách phòng đang đăng để gửi (không phải hết phòng). Tạo lại hoặc bật lại link chia sẻ ở trang Sale phòng.'
        WHEN 'room_data_changed' THEN 'dữ liệu phòng công khai chưa hợp lệ để lập bản tin. Kiểm tra tên tòa, mã phòng và trạng thái phòng.'
        WHEN 'context_changed' THEN 'quyền hoặc kết nối thay đổi liên tục trong lúc chạy.'
        WHEN 'delivery_failed' THEN 'một tin của lịch chưa gửi được ('||COALESCE(p_detail->>'errorCode','không rõ mã')||'). Không gửi lại tự động; lượt sau chạy theo nhịp.'
        WHEN 'delivery_unknown' THEN 'một tin của lịch chưa rõ đã tới nhóm hay chưa. Kiểm tra trên Zalo rồi xác nhận ở mục Đối soát trong Trợ lý Hermes; hệ thống không gửi lại tự động.'
        WHEN 'grant_expiring' THEN 'ủy quyền lịch hết hạn lúc '||to_char(p_expires AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI DD/MM')||'. Sửa lịch để gia hạn nếu vẫn cần.'
        WHEN 'grant_expired' THEN 'ủy quyền lịch đã hết hạn nên lịch đã dừng. Tạo hoặc sửa lịch nếu muốn tiếp tục.'
        ELSE 'lịch không chạy được (mã '||p_reason||'). Kiểm tra lại cấu hình lịch.' END)
    END
$fn$`)],
  ['app_private.hermes_delivery_reconciliation_json_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_delivery_reconciliation_json_v1(r app_private.hermes_delivery_reconciliations)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
  SELECT jsonb_build_object('id',r.id,'kind',r.target_kind,'targetId',COALESCE(r.job_id,r.command_id),'decision',r.decision,
    'note',r.note,'via',r.via,'createdAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
$fn$`)],
  ['app_private.hermes_task_follow_int_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_int_v1(p jsonb,p_min integer,p_max integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'number' OR (p#>>'{}') !~ '^[0-9]{1,6}$' OR (p#>>'{}')::integer NOT BETWEEN p_min AND p_max
    THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  RETURN (p#>>'{}')::integer;
END $fn$`)],
  ['app_private.hermes_task_follow_text_v1', clean(String.raw`CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_text_v1(p jsonb,p_max integer,p_multiline boolean)
RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v text;
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'string' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v:=p#>>'{}';
  IF char_length(btrim(v,E' \n'))<1 OR char_length(v)>p_max OR btrim(v,E' \n')<>v
    OR (CASE WHEN p_multiline THEN replace(v,E'\n','') ELSE v END) ~ '[\x01-\x1F\x7F-\x9F]'
    OR position(chr(8232) IN v)>0 OR position(chr(8233) IN v)>0
    OR v ~ '(hc_[A-Za-z0-9_-]{43}|hzn_[A-Za-z0-9_-]{20,}|sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)'
    THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  RETURN v;
END $fn$`)],
  ['app_private.hermes_task_follow_label_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_label_v1(p text,p_max integer)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT NULLIF(left(btrim(regexp_replace(translate(COALESCE(p,''),chr(8232)||chr(8233),'  '),'[[:cntrl:]]',' ','g')),p_max),'')
$fn$`)],
  ['app_private.hermes_task_follow_iso_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_iso_v1(p timestamptz)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT CASE WHEN p IS NULL THEN NULL ELSE to_char(p AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END
$fn$`)],
  // Latest definition: 20261015130000_hermes_review_fixes_v1 (company ACTIVE too).
  ['app_private.hermes_task_follow_member_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_member_v1(p_org uuid,p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT p_org IS NOT NULL AND p_user IS NOT NULL AND EXISTS(SELECT 1 FROM public.organization_memberships m
    JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=p_user AND m.organization_id=p_org AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND (m.valid_from IS NULL OR m.valid_from<=clock_timestamp()) AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
$fn$`)],
  ['app_private.hermes_work_memory_int_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_work_memory_int_v1(p jsonb,p_min integer,p_max integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p IS NULL OR jsonb_typeof(p)<>'number' OR (p#>>'{}') !~ '^[0-9]{1,6}$' OR (p#>>'{}')::integer NOT BETWEEN p_min AND p_max
    THEN RAISE EXCEPTION 'hermes_memory_invalid' USING ERRCODE='22023'; END IF;
  RETURN (p#>>'{}')::integer;
END $fn$`)],
  ['app_private.hermes_memory_shared_with_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_memory_shared_with_v1(p_sharing text,p_member jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
  SELECT p_sharing='managers' OR (p_sharing='superadmin' AND p_member->'isSuperadmin'='true'::jsonb)
$fn$`)],
  ['app_private.hermes_memory_owner_name_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_memory_owner_name_v1(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT NULLIF(left(btrim(regexp_replace(translate(COALESCE(p.full_name,''),chr(8232)||chr(8233),'  '),'[[:cntrl:]]',' ','g')),120),'')
    FROM public.profiles p WHERE p.id=p_user
$fn$`)],
]);

// Package D invoker pair: the private apply step writes canonical jobs under the
// caller's RLS; the SQL-standard public wrapper binds the three private steps by
// OID. The step header and whole wrapper are exact here; the wrapper bytes are
// also pinned by the source extractor (externalStandard sha256).
const TASK_FOLLOW_APPLY_HEADER = 'CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_apply_v1(p_step jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public';
const TASK_FOLLOW_ACTION = clean(`CREATE OR REPLACE FUNCTION public.hermes_task_follow_action_v1(p_binding jsonb,p_operation text,p_input jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
 SELECT app_private.hermes_task_follow_finish_v1(p_binding,p_operation,p_input,
  app_private.hermes_task_follow_apply_v1(app_private.hermes_task_follow_guard_v1(p_binding,p_operation,p_input)));
END`);
const TASK_FOLLOW_PATH = 'supabase/migrations/20261015110000_hermes_task_follow_v1.sql';

// This is not a pure formatter: it reads one canonical listing's tuple revision
// and uses extensions.digest. Pin its entire reviewed definition, including
// relation, predicate, SECURITY DEFINER and search path; do not widen the common
// search-path rule or admit arbitrary helpers with an extensions schema.
const ROOM_PASS_REVISION_HELPER = clean(`CREATE OR REPLACE FUNCTION app_private.hermes_room_pass_revision_v1(p_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,extensions AS $fn$
 SELECT encode(extensions.digest(convert_to(l.updated_at::text||':'||l.xmin::text||':'||l.ctid::text,'UTF8'),'sha256'),'hex')
 FROM public.room_pass_listings l WHERE l.id=p_id
$fn$`);

function formatterContract(definition) {
  assert.match(definition, /^CREATE OR REPLACE FUNCTION app_private\.hermes_group_number_vi_v1\(p numeric\) RETURNS text LANGUAGE sql IMMUTABLE (?:SECURITY INVOKER )?SET search_path=pg_catalog AS \$fn\$/i);
  // This sole invoker exception is a pure pg_catalog numeric formatter. An
  // added relation read, call, statement or privilege mode must require review.
  assert.equal(definition.split('$fn$')[1].trim(), "SELECT CASE WHEN p IS NULL THEN 'chưa công bố' ELSE replace(replace(replace(to_char(round(p,2),'FM999,999,999,999,999,990.00'),',','#'),'.',','),'#','.') END");
  assert.equal(definition.split('$fn$').length, 3);
  assert.equal(definition.split('$fn$')[2].trim(), '', 'no trailing privilege or function options');
}

function forwardDefinitionContract(name, definition) {
  assert.equal(digest(definition), FORWARD_BY_NAME.get(name).sha256, `${name}: exact reviewed forward definition`);
}

// Exact input-only INVOKER helpers, not a generic exception to DEFINER/path rules.
// They run inside the caller-owned definer and must never gain direct API grants.
const SALE_INPUT_HELPERS = new Map([
  ['app_private.hermes_sale_keys_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_sale_keys_v1(p_operation text,p_input jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
 SELECT CASE
 WHEN p_operation='patch' THEN CASE WHEN p_input ? 'images' AND NOT EXISTS(
  SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('requestId','roomId','expectedRevision','images'))
  THEN ARRAY['rooms.edit','sale_phong.edit','sale_phong.manage_images'] ELSE ARRAY['rooms.edit','sale_phong.edit'] END
 WHEN p_operation='lock' THEN ARRAY['sale_phong.lock_room']
 WHEN p_operation='release' THEN ARRAY['sale_phong.lock_room','deposits.create']
 WHEN p_operation IN ('reservation_create','reservation_topup') THEN ARRAY['deposits.create']
 WHEN p_operation IN ('reservation_update','reservation_assign') THEN ARRAY['deposits.edit']
 WHEN p_operation='options' THEN ARRAY[p_input->>'action']
 WHEN p_operation='observe' THEN ARRAY['rooms.edit','sale_phong.edit','sale_phong.manage_images']
 ELSE ARRAY['rooms.edit','sale_phong.edit','sale_phong.manage_images','sale_phong.lock_room','deposits.create','deposits.edit'] END
$fn$`)],
  ['app_private.hermes_sale_receipt_input_v1', clean(`CREATE OR REPLACE FUNCTION app_private.hermes_sale_receipt_input_v1(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
 PERFORM app_private.hermes_request_v1(p_input,ARRAY['amount','accountId','voucherDate','name','description']);
 IF jsonb_typeof(p_input->'amount') IS DISTINCT FROM 'number' OR (p_input->>'amount') !~ '^[1-9][0-9]{0,12}$'
  OR (p_input->'name'<>'null'::jsonb AND (jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string' OR char_length(p_input->>'name') NOT BETWEEN 1 AND 200))
  OR (p_input->'description'<>'null'::jsonb AND (jsonb_typeof(p_input->'description') IS DISTINCT FROM 'string' OR char_length(p_input->>'description')>1000))
  THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
 IF p_input->'accountId'<>'null'::jsonb THEN PERFORM app_private.hermes_uuid_v1(p_input->'accountId'); END IF;
 IF app_private.hermes_domain_date_v2(p_input->'voucherDate') IS NULL THEN RAISE EXCEPTION 'hermes_sale_invalid' USING ERRCODE='22023'; END IF;
 RETURN jsonb_build_object('amount',p_input->'amount','account_id',p_input->'accountId','voucher_date',p_input->'voucherDate',
  'name',p_input->'name','description',p_input->'description','attachments','[]'::jsonb);
END $fn$`)],
]);

function securityContract(sql = all, registry = functions) {
  sql = expandReviewedFunctionAcl(sql);
  const normalizedAclSql = sql.replace(/,\s+/g, ',');
  assert.match(sql, /CREATE ROLE hermes_store_executor NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT/i);
  assert.match(sql, /pg_auth_members WHERE member='hermes_store_executor'::regrole/i);
  for (const role of ['anon', 'authenticated', 'service_role']) assert(sql.includes(`pg_has_role('${role}','hermes_store_executor','MEMBER')`));
  assert.match(sql, /GRANT USAGE ON SCHEMA app_private TO hermes_store_executor/i);
  assert.match(sql, /REVOKE CREATE ON SCHEMA app_private, public FROM hermes_store_executor/i);
  assert.match(sql, /has_schema_privilege\('hermes_store_executor','app_private','CREATE'\)/);
  assert.match(sql, /has_schema_privilege\('hermes_store_executor','public','CREATE'\)/);
  for (const name of TABLES) {
    assert.match(sql, new RegExp(`ALTER TABLE app_private.hermes_${name} ENABLE ROW LEVEL SECURITY`, 'i'));
    assert.match(sql, new RegExp(`ALTER TABLE app_private.hermes_${name} OWNER TO postgres`, 'i'));
  }
  const tableRevoke = /REVOKE ALL ON app_private\.hermes_capabilities[^;]*?FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor/i.exec(sql)?.[0];
  assert(tableRevoke, 'private tables must revoke every API/runtime role');
  for (const name of TABLES) assert(tableRevoke.includes(`app_private.hermes_${name}`));
  for (const [name, definition] of registry) {
    const header = definition.split(/\b(?:AS\s+\$|BEGIN ATOMIC)/i)[0].trim();
    if (FORWARD_BY_NAME.has(name) && !W2_READERS.has(name)) {
      forwardDefinitionContract(name, definition);
    } else if (TASK_BY_NAME.has(name)) {
      const spec = TASK_BY_NAME.get(name);
      assert.equal(header, spec.header, 'exact task signature/security/search path');
      if (spec.standard) assert.equal(definition, clean(spec.statement), 'exact task SQL-standard body');
    } else if (name === 'app_private.hermes_group_number_vi_v1') formatterContract(definition);
    else if (CDE_CATALOG_HELPERS.has(name)) assert.equal(definition, CDE_CATALOG_HELPERS.get(name), `${name}: exact private pg_catalog helper`);
    else if (name === 'app_private.hermes_room_pass_revision_v1') assert.equal(definition, ROOM_PASS_REVISION_HELPER, 'exact private room-pass revision helper');
    else if (CD_NARROW_PATH_HELPERS.has(name)) assert.equal(definition, CD_NARROW_PATH_HELPERS.get(name), `${name}: exact private narrow-path helper`);
    else if (SALE_INPUT_HELPERS.has(name)) assert.equal(definition, SALE_INPUT_HELPERS.get(name), `${name}: exact private sale input helper`);
    else if (name === 'app_private.hermes_task_follow_apply_v1') assert.equal(header, TASK_FOLLOW_APPLY_HEADER, 'exact task-follow invoker step');
    else if (name === 'public.hermes_task_follow_action_v1') assert.equal(definition, TASK_FOLLOW_ACTION, 'exact task-follow SQL-standard wrapper');
    else if (CUSTOMER_INVOKER.has(name)) assert.match(header, /SECURITY INVOKER SET search_path=pg_catalog,public/i, name);
    else if (NAME_DIRECTORY_INVOKER.has(name)) {
      assert.match(header, /LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public$/i, name);
      assert.doesNotMatch(definition.split(/\bAS\s+\$/i).slice(1).join(''), /\bapp_private\./i, `${name}: invoker directory names app_private`);
    }
    else if (W2_INVOKER.has(name)) {
      assert.match(header, /LANGUAGE (?:plpgsql|sql) (?:VOLATILE|STABLE) SECURITY INVOKER SET search_path=pg_catalog,public$/i, name);
      // A plpgsql body resolves names as the asker, who has no USAGE on app_private: it may not name it.
      if (/\bAS\s+\$/i.test(definition)) assert.doesNotMatch(definition.split(/\bAS\s+\$/i).slice(1).join(''), /\bapp_private\./i, `${name}: plpgsql invoker names app_private`);
    }
    else assert.match(header, /SECURITY DEFINER SET search_path=pg_catalog,(?:public,)?app_private/i, name);
    assert.match(sql, new RegExp(`ALTER FUNCTION ${name.replace('.', '\\.')}\\([^;]*?\\) OWNER TO postgres`, 'i'), name);
    const revokedRoles = FORWARD_REVOKE_ROLES.get(name) ?? 'PUBLIC,anon,authenticated,service_role,hermes_store_executor';
    assert.match(normalizedAclSql, new RegExp(`REVOKE ALL ON FUNCTION [^;]*?${name.replace('.', '\\.')}\\([^;]*?FROM ${revokedRoles}(?:;|$)`, 'i'), `${name}: revoke default/API execute explicitly`);
    assert.doesNotMatch(definition, /\bEXECUTE\s+(?!ON\b)|\bSET\s+ROLE\b/i, name);
    // This reviewed audit bridge temporarily attributes its owner-bound audit
    // event and restores both prior claims. Its entire body is pinned above;
    // no other function receives a JWT mutation exception.
    if (name !== 'app_private.hermes_audit_connection_change_v2')
      assert.doesNotMatch(definition, /set_config\s*\(\s*'request\.jwt/i, name);
    if (FORWARD_BY_NAME.has(name)) forwardDefinitionContract(name, definition);
  }
  // Forward migrations may grant one new function or replace/revoke/regrant an
  // existing subset. Replay ACL statements in order, rather than requiring each
  // historical GRANT to contain the entire future surface (or unioning grants
  // that a later REVOKE actually removed). CREATE OR REPLACE keeps its old ACL.
  const acl = new Map();
  const allowed = new Map([
    ['authenticated', new Set([...PUBLIC.map(name => `public.${name}`), ...TASK_FUNCTIONS.filter(spec => spec.authenticated).map(spec => spec.signature),
      ...CUSTOMER_ACTION_ACL.targets.filter(([, role]) => role === 'authenticated').map(([target]) => target), ...TASK_FOLLOW_STEPS,
      ...ZALO_ONESHOT_CALLER, ...W2_CALLER, ...INHERITED_CRM_ACL.map(spec => spec.signature),
      ...FORWARD_ACL_BLOCKS.find(block => block.name === 'shared-read').targets.map(([target]) => target),
      'public.vehicles_list_core_v1(uuid,uuid[],uuid[],boolean,text,text,uuid,uuid,integer,integer,boolean)',
      'app_private.hermes_domain_read_scope_fast_v1(jsonb,text,jsonb,text)',
      // R2d (20261021063452): the fast reader's DEFINER count, reachable only through its bound OID (no app_private USAGE).
      'app_private.hermes_customers_without_contract_v1(uuid,uuid[],uuid[])',
      // Shared write foundation: SQL-standard INVOKER wrappers bind these app_private OIDs at creation (no app_private USAGE).
      ...WRITE_FOUNDATION_CALLER, ...CONTRACT_ACTION_CALLER, ...TASK_ACTION_CALLER])],
    ['hermes_store_executor', new Set([...STORE.map(name => `app_private.hermes_store_${name}_v1(jsonb)`),
      ...['hermes_zalo_provisioning_v1', 'hermes_zalo_provisioning_work_v1', 'hermes_zalo_provisioning_ack_v1'].map(name => `app_private.${name}(jsonb)`)])],
    ['service_role', new Set([...WORKER, ...ZALO_ONESHOT_WORKER])],
  ]);
  for (const statement of splitSqlStatements(sql).map(clean)) {
    const definition = /^CREATE (?:OR REPLACE )?FUNCTION ((?:app_private|public)\.\w+)\(([^)]*)\)/i.exec(statement);
    if (definition) {
      const key = signature(definition[1], definition[2], true);
      if (!acl.has(key)) acl.set(key, new Set(['PUBLIC']));
    }
    if (/^GRANT USAGE ON SCHEMA app_private TO hermes_store_executor$/i.test(statement)) continue;
    if (!/^(?:GRANT|REVOKE)\b/i.test(statement) || !/\bON FUNCTION\b/i.test(statement)) {
      if (/^GRANT\b/i.test(statement) && !REVIEWED_TABLE_GRANTS.has(statement)) assert.fail(`Unexpected grant: ${statement}`);
      continue;
    }
    if (/^GRANT\b/i.test(statement)) {
      const parsed = /^GRANT EXECUTE ON FUNCTION (.+) TO (authenticated|hermes_store_executor|service_role)$/i.exec(statement);
      assert(parsed, 'grant has explicit function targets and one supported recipient');
      const names = aclTargets(parsed[1]), role = parsed[2];
      assert(allowed.has(role), 'only exact caller, store executor or worker ingress grants may receive execute');
      for (const name of names) {
        assert(allowed.get(role).has(name), `${role} cannot execute ${name}`);
        assert(acl.has(name), 'grant refers to an existing fixed function');
        acl.get(name).add(role);
      }
    } else {
      const parsed = /^REVOKE (?:ALL|EXECUTE) ON FUNCTION (.+) FROM ([A-Za-z_, ]+)$/i.exec(statement);
      assert(parsed, 'revoke has explicit function targets and recipients');
      const names = aclTargets(parsed[1]), roles = parsed[2].split(',').map(s => s.trim());
      for (const role of roles) assert(['PUBLIC', 'anon', 'authenticated', 'service_role', 'hermes_store_executor'].includes(role));
      for (const name of names) {
        assert(acl.has(name), 'revoke targets a known signature');
        for (const role of roles) acl.get(name).delete(role);
      }
    }
  }
  for (const [name, privileges] of acl) {
    const expected = [...allowed].filter(([, names]) => names.has(name)).map(([role]) => role);
    assert.deepEqual([...privileges].sort(), expected.sort(), `${name}: current effective execute ACL`);
  }
  for (const names of allowed.values()) for (const name of names) assert(acl.has(name), `Missing allowed function ${name}`);
  assert.doesNotMatch(sql, /GRANT\s+(?:ALL|SELECT|INSERT|UPDATE|DELETE|CREATE)\b[^;\n]*\bTO\s+[^;\n]*hermes_store_executor/i);
  assert.doesNotMatch(sql, /ALTER TABLE app_private\.hermes_\w+ DISABLE ROW LEVEL SECURITY|DROP (?:TABLE|FUNCTION).*hermes_/i);
}

function membershipContract(registry = functions) {
  const body = fn('hermes_member_v1', registry);
  for (const pattern of [/m\.revoked_at IS NULL/g, /m\.status='ACTIVE'/g, /o\.status='ACTIVE'/g,
    /m\.valid_to>v_now/g, /COALESCE\(m\.valid_from,'-infinity'::timestamptz\)<=v_now/g]) {
    assert.equal([...body.matchAll(pattern)].length, 2, `selected and ordinary memberships require ${pattern}`);
  }
  assert.match(body, /IF v_count<>1 THEN RAISE EXCEPTION/);
  assert.match(body, /FROM public\.super_admins WHERE user_id=p_user/);
  assert.match(body, /IF NOT v_super THEN .*count\(DISTINCT m\.organization_id\).*IF v_org_count<>1 THEN RAISE EXCEPTION/);
  assert.doesNotMatch(body, /auth\.uid\(\)|request\.jwt/, 'private principal must use bound identity, not forged GUC claims');
}

function activationContract(registry = functions) {
  const body = fn('hermes_store_activate_v1', registry);
  assert.match(body, /c\.user_id<>v_user OR c\.intent_digest<>encode\(extensions\.digest\(p->>'intentSecret','sha256'\),'hex'\)/);
  assert.match(body, /v_hash:=encode\(extensions\.digest\(p::text,'sha256'\),'hex'\)/);
  assert.match(body, /IF c\.activation_operation_id=v_operation THEN IF c\.activation_hash<>v_hash OR c\.state<>'ACTIVE'/);
  assert.match(body, /c\.state<>'PENDING' OR c\.epoch<>v_epoch OR c\.intent_expires_at<=clock_timestamp\(\)/);
  assert.match(body, /v_token_exp>clock_timestamp\(\)\+interval '15 minutes'/);
  assert.match(body, /v_token_exp>v_session_exp/);
  assert(body.indexOf('INSERT INTO app_private.hermes_sessions') < body.indexOf('INSERT INTO app_private.hermes_connection_tokens'));
  assert(body.indexOf('INSERT INTO app_private.hermes_connection_tokens') < body.indexOf('UPDATE app_private.hermes_connections'));
  assert.doesNotMatch(body, /DELETE FROM|ON CONFLICT/, 'activation must not overwrite a previous identity/session owner');
}

function envelopeContract(registry = functions) {
  const body = fn('hermes_envelope_v1', registry);
  // PostgreSQL's regex repetition bounds are limited to 255. Inspect the
  // current helper, not immutable historical migrations containing the bug.
  for (const [, pattern] of body.matchAll(/(?:!~|~)\s*'((?:''|[^'])*)'/g)) {
    for (const [, lower, upper] of pattern.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) {
      assert(Number(lower) <= 255 && (upper === undefined || upper === '' || Number(upper) <= 255),
        'PostgreSQL regex repetition bound exceeds 255');
    }
  }
  assert.match(body, /jsonb_typeof\(p->'ciphertext'\)<>'string'/);
  assert.match(body, /OR char_length\(p->>'ciphertext'\) NOT BETWEEN 1 AND 87382/);
  assert(body.includes("OR (p->>'ciphertext') !~ '^[A-Za-z0-9_-]+$' THEN"),
    'ciphertext must retain the anchored base64url character set');
}

function readContract(registry = functions) {
  const body = fn('hermes_store_read_connection_v1', registry);
  assert.match(body, /token_digest=p->>'tokenDigest' AND revoked_at IS NULL AND expires_at>clock_timestamp\(\)/);
  assert.match(body, /FROM app_private\.hermes_sessions WHERE id=c\.credential_ref AND state='ACTIVE' AND quarantine_reason IS NULL AND expires_at>clock_timestamp\(\) FOR SHARE/);
  assert.match(body, /NOT app_private\.hermes_session_gate_v1\(s\)/);
  assert.match(body, /id=t\.connection_id AND state='ACTIVE' AND credential_ref=s\.id FOR SHARE/);
  assert.match(body, /hermes_member_v1\(c\.user_id,c\.organization_id\)/);
  assert.match(body, /PERFORM 1 FROM app_private\.hermes_org_policies WHERE organization_id=c\.organization_id FOR SHARE; SELECT \* INTO policy FROM app_private\.hermes_effective_org_policy_v1\(c\.organization_id,c\.read_capabilities,c\.action_capabilities,c\.scope_ids\) WHERE enabled; IF NOT FOUND THEN RETURN jsonb_build_object\('status','unavailable'\); END IF;/);
  effectivePolicyContract(registry);
  assert(body.indexOf('expires_at>clock_timestamp() FOR SHARE') < body.indexOf('credential_ref=s.id FOR SHARE'));
}

function effectivePolicyContract(registry = functions) {
  const body = fn('hermes_effective_org_policy_v1', registry);
  assert.match(body, /LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public,app_private/);
  assert.match(body, /SELECT \* INTO v_policy FROM app_private\.hermes_org_policies WHERE organization_id=p_org; IF FOUND THEN RETURN v_policy; END IF;/,
    'every persisted policy, including disabled or empty ceilings, wins over neutral fallback');
  assert.match(body, /v_policy\.organization_id:=p_org; v_policy\.enabled:=true; v_policy\.version:=0;/);
  for (const [mode, bound] of [['read', 'p_read'], ['action', 'p_action']]) {
    assert(body.includes(`FROM app_private.hermes_capabilities WHERE mode='${mode}' AND enabled AND (${bound} IS NULL OR capability=ANY(${bound}))`));
  }
  assert.match(body, /FROM public\.authorization_scopes WHERE organization_id=p_org AND \(p_scope_ids IS NULL OR id=ANY\(p_scope_ids\)\)/);
  assert.doesNotMatch(body, /\b(?:INSERT|UPDATE|DELETE|EXECUTE)\b/i);
}

function refreshContract(registry = functions) {
  const acquire = fn('hermes_store_acquire_refresh_v1', registry);
  assert.match(acquire, /WHERE id=v_id FOR UPDATE/);
  assert.match(acquire, /hermes_binding_matches_v1\(s,p->'binding'\)/);
  assert.match(acquire, /s\.state IN \('RESERVED','DISPATCHED','STAGED'\) AND s\.lease_until>clock_timestamp\(\)/);
  assert.match(acquire, /IF s\.state IN \('DISPATCHED','STAGED'\) THEN UPDATE .*state='RECONNECT_REQUIRED'.*envelope=NULL/);
  assert.match(acquire, /state='RESERVED',fence=fence\+1,lease_owner=v_owner, lease_until=clock_timestamp\(\)\+v_ms\*interval '1 millisecond'/);
  const claim = fn('hermes_claim_v1', registry);
  assert.match(claim, /WHERE id=v_id FOR UPDATE/);
  assert.match(claim, /s\.lease_owner IS DISTINCT FROM v_owner OR s\.fence<>v_fence OR s\.revision NOT IN \(v_revision,v_revision\+1\)/);
  for (const operation of ['dispatch', 'stage', 'publish']) {
    const body = fn(`hermes_store_${operation}_refresh_v1`, registry);
    assert.match(body, /s:=app_private\.hermes_claim_v1\(p\)/);
    assert.match(body, /s\.lease_until<=clock_timestamp\(\)/);
    assert.match(body, /NOT app_private\.hermes_session_gate_v1\(s\)/);
  }
  const stage = fn('hermes_store_stage_refresh_v1', registry);
  assert.match(stage, /s\.state='STAGED'.*s\.staged_envelope=p->'envelope' AND s\.staged_expires_at=v_exp/);
  assert.match(stage, /s\.state<>'DISPATCHED'/);
  assert.match(stage, /SET state='STAGED',envelope=NULL,staged_envelope=p->'envelope',staged_expires_at=v_exp/);
  const publish = fn('hermes_store_publish_refresh_v1', registry);
  assert.match(publish, /s\.state='ACTIVE' AND s\.published_fence=v_fence AND s\.revision=v_revision\+1 AND s\.expires_at>clock_timestamp\(\)/);
  assert.match(publish, /s\.state<>'STAGED' OR s\.revision<>v_revision/);
  assert.match(publish, /SET state='ACTIVE',envelope=staged_envelope,expires_at=staged_expires_at, staged_envelope=NULL,staged_expires_at=NULL,revision=revision\+1,published_fence=fence/);
  const release = fn('hermes_store_release_refresh_v1', registry);
  assert.match(release, /s\.state<>'RESERVED' OR s\.revision<>app_private\.hermes_integer_v1\(p->'revision'\)/);
}

function revokeContract(registry = functions) {
  const connection = fn('hermes_store_revoke_connection_v1', registry);
  assert.match(connection, /state='PENDING' AND credential_ref IS NULL AND epoch=v_epoch/);
  assert.match(connection, /IF c\.epoch<>v_epoch THEN RAISE EXCEPTION/);
  assert.match(connection, /UPDATE app_private\.hermes_connection_tokens SET revoked_at=clock_timestamp\(\)/);
  assert.doesNotMatch(connection, /UPDATE app_private\.hermes_sessions|DELETE FROM/);
  for (const operation of ['revoke', 'restrict']) {
    const body = fn(`hermes_store_${operation}_connection_v1`, registry);
    const sessionLock = body.indexOf('PERFORM 1 FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR UPDATE');
    const connectionLock = body.indexOf('FROM app_private.hermes_connections WHERE id=v_id FOR UPDATE');
    assert(sessionLock >= 0 && sessionLock < connectionLock, `${operation}: session must lock before existing connection`);
  }
  const session = fn('hermes_store_revoke_session_v1', registry);
  assert.match(session, /state='REVOKED',quarantine_reason='session_revoked',envelope=NULL, staged_envelope=NULL,staged_expires_at=NULL,revision=revision\+1,fence=fence\+1,lease_owner=NULL,lease_until=NULL/);
  const reconnect = fn('hermes_store_reconnect_session_v1', registry);
  assert.match(reconnect, /hermes_claim_v1\(p\)/);
  assert.match(reconnect, /state='RECONNECT_REQUIRED',quarantine_reason='refresh_uncertain', envelope=NULL,staged_envelope=NULL,staged_expires_at=NULL,revision=revision\+1/);
}

test('private owner, capability role, table RLS and exact execute grants stay closed', () => securityContract());

test('all sixty-eight reviewed forward migrations and their 138 latest definitions remain covered, including CRM wrappers and superseded bodies', () => {
  // A reviewed file stays under review after every body it declared was replaced
  // (B5c 20261020171321; B5c step 2 20261020173818 after R2a 20261020233934; every
  // R2a body after R2c 20261021035022 and R2c part 2 20261021044801; R2c part 2 after
  // R2d 20261021063452; the 20261019034254 capabilities v1 and metadata grant and the R2c
  // 20261021035022 v2 reader after the web building scope 20261021170452; that v2 body and
  // the R2d reader after the receivables effective outstanding 20261021185540, which keeps
  // the 20261021170452 body and changes only its receivables branch; the contract page lookup and
  // step of 20261022022951 after the contract return 20261022061813; that step and the 20261022022951 wrapper after the
  // occupants + drafts 20261022074815): its statements are
  // then only superseded pins. 20261021172540 replaces the two task-input steps of
  // 20261014094913 (a task-catalog file, not a forward one: TASK_FUNCTIONS pins its bodies,
  // the rows step through spec.successors).
  const paths = [...new Set([...FORWARD_FUNCTIONS, ...FORWARD_SUPERSEDED].map(spec => spec.sourcePath))].sort();
  // C1 (#309 = #304 Công việc + #305 Thu chi lượt 11): 48 file / 130 hàm. Hợp đồng lượt 11 (#308): lõi giải tên v1 (dựng trên thân
  // 185114) và v2 ở 20261024040001, bước ghi Hợp đồng ở 20261024040002 (+2 file; thân cũ thành ghim superseded). Hoá đơn lượt 8 (#312):
  // tra cứu + bước ghi thu tiền _v2 và vỏ trang ở 20261024041712 (+1 file, +2 hàm; vỏ 042723 thành ghim superseded). Công việc lượt 12
  // (#318): lõi giải tên + bước chuẩn bị của task dựng lại ở 20261024091500 (+1 file, cùng tên; thân 185116 thành ghim superseded).
  // Thu chi lượt 13 (#319): luồng hệ thống 20261024094809 (+1 file, +2 tên: hàm phân loại luồng mới, kiểm lại hạng mục; chọn hạng mục +
  // bước ghi dựng lại, thân 210634 thành ghim superseded). Thu chi lượt 14 (#319): chọn hạng mục + bước ghi + lõi giải tên dựng lại ở
  // 20261024120211 (+1 file, cùng tên; thân 094809 / 210634 thành ghim superseded).
  // Hợp đồng lượt 12: bước ghi Hợp đồng dựng lại ở 20261024160001, hàm đọc gói A ở 20261024160002 (+2 file, cùng tên; thân 040002 / 051620
  // thành ghim superseded).
  // Hoá đơn lượt 14: tra cứu + bước ghi thu tiền _v3, bước ghi sửa/huỷ/khôi phục _v2 và vỏ trang ở 20261024181440 (+1 file, +3 tên; vỏ 041712
  // thành ghim superseded).
  // Thu chi lượt 15: bộ đọc miền v2 dựng lại + bản đọc kết nối không khoá (MỚI) ở 20261024193001, bộ phân luồng thêm khoản THU ở
  // 20261024193002 (+2 file, +1 tên; thân v2 185540 / bộ phân luồng 094809 thành ghim superseded).
  // Thu chi lượt 16: lõi giải dựng lại ở 20261024210500 (+1 file, cùng tên; thân 120211 thành ghim superseded).
  // Công việc lượt 16 (C3k): lõi giải task dựng lại ở 20261026014500 (+1 file, cùng tên; thân 003100 thành ghim superseded).
  // Hoá đơn C07: bước ghi thu tiền _v3 dựng lại ở 20261026234255 (ép kiểm hoãn trong khối con; +1 file, cùng tên; thân 181440 thành ghim
  // superseded).
  // Thu chi lượt 19 (J06): lõi giải dựng lại ở 20261027074419 (+1 file, cùng tên; thân 210500 thành ghim superseded).
  // Hoá đơn E03: bước ghi chỉ số dựng lại ở 20261027093517 (+1 file, cùng tên; thân 183445 thành ghim superseded).
  // Hoá đơn H03 + F06: bảng báo cáo + hàm đọc gói A dựng lại ở 20261027131639 (+1 file, cùng tên; bảng 051620 / hàm đọc 160002 thành ghim
  // superseded).
  // Thu chi lượt 20 (G02): lõi giải dựng lại ở 20261027140949 (+1 file, cùng tên; thân 074419 thành ghim superseded).
  assert.equal(paths.length, 68);
  assert.equal(FORWARD_FUNCTIONS.length, 138);
  assert.equal(FORWARD_BY_NAME.size, 138, 'one live definition per reviewed name');
  const version = path => path.slice('supabase/migrations/'.length, 'supabase/migrations/'.length + 14);
  for (const item of FORWARD_SUPERSEDED) {
    const live = FORWARD_BY_NAME.get(item.name);
    assert(live && live.sourcePath !== item.sourcePath && version(live.sourcePath) > version(item.sourcePath), `${item.name}: superseded pin must name an earlier reviewed file`);
    assert(paths.includes(item.sourcePath), `${item.name}: superseded file is a reviewed forward migration`);
  }
  const actualNames = [], superseded = [];
  for (const path of paths) {
    const source = splitSqlStatements(readFileSync(join(directory, path.split('/').at(-1)), 'utf8')).map(clean);
    for (const statement of source) {
      const match = /^CREATE OR REPLACE FUNCTION ((?:public|app_private)\.\w+)\(/.exec(statement);
      if (!match) continue;
      const spec = FORWARD_BY_NAME.get(match[1]);
      assert(spec, `${match[1]}: new forward function requires review`);
      if (spec.sourcePath !== path) {
        // A later forward migration replaced this reviewed body (CREATE OR
        // REPLACE). Pin the historical statement too; no other shadow is ignored.
        const pin = FORWARD_SUPERSEDED.find(item => item.name === match[1] && item.sourcePath === path);
        assert(pin, `${match[1]}: superseded body in ${path} requires a pinned historical digest`);
        assert.equal(digest(statement), pin.sha256, `${match[1]}: exact superseded body in ${path}`);
        superseded.push(pin);
        continue;
      }
      actualNames.push(match[1]);
      assert.equal(spec.sourcePath, path);
      forwardDefinitionContract(match[1], statement);
      assert.equal(functions.get(match[1]), statement, `${match[1]}: inspect the actual latest definition`);
    }
  }
  assert.deepEqual(actualNames.sort(), [...FORWARD_BY_NAME.keys()].sort());
  assert.equal(superseded.length, FORWARD_SUPERSEDED.length, 'every superseded pin still matches one historical statement');
});

test('every forward definition rejects body, privilege mode and search-path mutants', () => {
  for (const { name } of FORWARD_FUNCTIONS) {
    const current = functions.get(name);
    for (const [label, changed] of [
      ['body', current.replace(/(AS \$\w*\$|BEGIN ATOMIC)/, '$1 SELECT 1;')],
      ['mode', current.replace(/SECURITY (DEFINER|INVOKER)/, (_, mode) => `SECURITY ${mode === 'DEFINER' ? 'INVOKER' : 'DEFINER'}`)],
      ['path', current.replace(/SET search_path\s*=\s*/, '$&untrusted,')],
    ]) {
      assert.notEqual(changed, current, `${name}: ${label} mutation applies`);
      assert.throws(() => forwardDefinitionContract(name, changed), /exact reviewed forward definition/, `${name}: ${label}`);
    }
  }
});

test('forward ACL adapters retain the real recipients, catalog signatures and omitted executor revoke', () => {
  for (const block of FORWARD_ACL_BLOCKS) {
    assert(all.includes(block.sql));
    const expanded = expandReviewedFunctionAcl(all);
    for (const [target] of block.targets) assert(expanded.includes(`REVOKE ALL ON FUNCTION ${target} FROM ${block.revokedRoles}`));
    for (const [before, after] of [['FROM PUBLIC,anon', 'FROM anon'], ['OWNER TO postgres', 'OWNER TO authenticated'],
      ["n.nspname='app_private'", "n.nspname IN ('app_private','public')"]]) {
      const changed = block.sql.replace(before, after); assert.notEqual(changed, block.sql);
      assert.throws(() => expandReviewedFunctionAcl(all.replace(block.sql, () => changed)), /unreviewed function ACL DO block/);
    }
    const target = block.targets[0][0], name = target.split('(')[0];
    const overload = functions.get(name).replace(/\([^)]*\)/, '(p_unreviewed text)');
    assert.throws(() => expandReviewedFunctionAcl(all.replace(block.sql, () => `${overload}; ${block.sql}`)), /catalog ACL loop must resolve only the reviewed signatures/);
  }
  const core = FORWARD_ACL_BLOCKS.find(block => block.name === 'shared-read');
  assert.equal(core.revokedRoles, 'PUBLIC,anon,authenticated,service_role');
  const expanded = expandReviewedFunctionAcl(all);
  for (const [target] of core.targets)
    assert(!expanded.includes(`REVOKE ALL ON FUNCTION ${target} FROM ${core.revokedRoles},hermes_store_executor`), 'adapter must never invent an executor revoke');
  assert.throws(() => expandReviewedFunctionAcl(all.replace(core.sql, () => core.sql.replace('TO authenticated', 'TO service_role'))), /unreviewed function ACL DO block/);
});

test('new caller/store ports and inherited CRM grants cannot be widened or dropped', () => {
  const ports = [
    ['public.hermes_prepare_connection_v2(uuid,text[],text[],text,uuid[])', 'authenticated'],
    ['public.hermes_domain_read_fast_v1(jsonb,text,jsonb)', 'authenticated'],
    ['app_private.hermes_domain_read_rows_fast_v1(jsonb)', 'authenticated'],
    ['app_private.hermes_customers_without_contract_v1(uuid,uuid[],uuid[])', 'authenticated'],
    ...WRITE_FOUNDATION_CALLER.map(target => [target, 'authenticated']),
    ...CONTRACT_ACTION_CALLER.map(target => [target, 'authenticated']),
    ...TASK_ACTION_CALLER.map(target => [target, 'authenticated']),
    ['app_private.hermes_store_connection_settings_v1(jsonb)', 'hermes_store_executor'],
    ...['hermes_zalo_provisioning_v1', 'hermes_zalo_provisioning_work_v1', 'hermes_zalo_provisioning_ack_v1'].map(name => [`app_private.${name}(jsonb)`, 'hermes_store_executor']),
    ...INHERITED_CRM_ACL.map(spec => [spec.signature, 'authenticated']),
  ];
  for (const [target, role] of ports) {
    assert.throws(() => securityContract(`${all}; GRANT EXECUTE ON FUNCTION ${target} TO service_role`), /cannot execute/, target);
    assert.throws(() => securityContract(`${all}; REVOKE EXECUTE ON FUNCTION ${target} FROM ${role}`), /effective execute ACL/, target);
  }
  // Only DEFINER steps check bindings, write receipts and map reasons; the caller never reaches them (or the settle trigger) directly.
  for (const target of ['app_private.hermes_action_receipt_begin_v1(jsonb,text,uuid,jsonb)',
    'app_private.hermes_action_receipt_finish_v1(jsonb,text,uuid,jsonb,text,text)', 'app_private.hermes_action_reason_v1(text,text,text)',
    'app_private.hermes_action_binding_v1(jsonb)', 'app_private.hermes_action_receipt_settled_v1()',
    'app_private.hermes_contract_reason_v1(text,text,text)', 'app_private.hermes_contract_date_label_v1(date,date)'])
    assert.throws(() => securityContract(`${all}; GRANT EXECUTE ON FUNCTION ${target} TO authenticated`), /cannot execute/, target);
  for (const spec of INHERITED_CRM_ACL) {
    const grant = `GRANT EXECUTE ON FUNCTION ${spec.signature} TO authenticated`;
    assert(all.includes(grant));
    assert.throws(() => securityContract(all.replace(grant, '')), /effective execute ACL/, `${spec.name}: replacement must inherit actual historical caller grant`);
  }
});

test('reviewed CRM defaults are exact and the audit attribution/restore cannot change', () => {
  for (const [name, defaults] of FORWARD_DEFAULTS) for (const [argument] of defaults) {
    assert.doesNotThrow(() => signature(name, argument, true));
    assert.throws(() => signature(name, argument.replace(' DEFAULT ', ' DEFAULT unreviewed_'), true), /reviewed argument grammar/);
  }
  const name = 'app_private.hermes_audit_connection_change_v2', current = functions.get(name);
  for (const [before, after] of [['c.user_id::text', "'other-user'"], ["COALESCE(previous_sub,'')", "c.user_id::text"],
    ["COALESCE(previous_claims,'')", "'{}'"], ['app_private.append_authz_audit_v1', 'app_private.other_function']]) {
    const changed = current.replace(before, after); assert.notEqual(changed, current);
    assert.throws(() => forwardDefinitionContract(name, changed), /exact reviewed forward definition/);
  }
});

test('room-pass v1 and v4 retain exact caller-only signatures and private helpers', () => {
  const caller = ['public.hermes_room_pass_action_v1(jsonb,text,jsonb)', 'public.hermes_room_pass_capabilities_v1(uuid)',
    'public.hermes_org_policy_options_v4(uuid)', 'public.hermes_connection_options_v4(uuid)', 'public.hermes_connection_context_v4(uuid)'];
  const helpers = ['app_private.hermes_room_pass_revision_v1(uuid)', 'app_private.hermes_room_pass_extend_options_v1(jsonb,text)'];
  for (const target of [...caller, ...helpers]) {
    for (const role of ['authenticated', 'service_role', 'hermes_store_executor'].filter(role => !(caller.includes(target) && role === 'authenticated'))) {
      assert.throws(() => securityContract(`${all}; GRANT EXECUTE ON FUNCTION ${target} TO ${role}`), /cannot execute/);
    }
    if (caller.includes(target)) assert.throws(() => securityContract(`${all}; REVOKE EXECUTE ON FUNCTION ${target} FROM authenticated`), /effective execute ACL/);
  }
});

test('room-pass receipt table remains private with RLS and capability starts disabled', () => {
  assert.match(all, /ALTER TABLE app_private\.hermes_room_pass_receipts OWNER TO postgres/);
  assert.match(all, /ALTER TABLE app_private\.hermes_room_pass_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(all, /REVOKE ALL ON TABLE app_private\.hermes_room_pass_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor/);
  assert.match(all, /INSERT INTO app_private\.hermes_capabilities\(capability,mode,enabled\) VALUES\('sale_phong\.manage_pass_listings','action',false\) ON CONFLICT\(capability\) DO NOTHING/);
});

for (const [label, before, after] of [
  ['private helper omitted', "'app_private.hermes_room_pass_extend_options_v1(jsonb,text)', ", ''],
  ['PUBLIC revoke omitted', 'FROM PUBLIC,anon,authenticated', 'FROM anon,authenticated'],
  ['owner changed', 'OWNER TO postgres', 'OWNER TO authenticated'],
]) test(`room-pass v4 ACL mutation rejected: ${label}`, () => {
  assert(all.includes(ROOM_PASS_OPTIONS_ACL.sql));
  const changed = ROOM_PASS_OPTIONS_ACL.sql.replace(before, after); assert.notEqual(changed, ROOM_PASS_OPTIONS_ACL.sql);
  assert.throws(() => securityContract(all.replace(ROOM_PASS_OPTIONS_ACL.sql, () => changed)), /unreviewed function ACL DO block/);
});

test('room-pass revision exception rejects relation, predicate, digest, privilege and path changes', () => {
  const name = 'app_private.hermes_room_pass_revision_v1', current = fn('hermes_room_pass_revision_v1');
  assert.equal(current, ROOM_PASS_REVISION_HELPER);
  for (const [before, after] of [['public.room_pass_listings', 'public.rooms'], ['WHERE l.id=p_id', 'WHERE true'],
    ['l.xmin::text', "'constant'"], ['SECURITY DEFINER', 'SECURITY INVOKER'],
    ['search_path=pg_catalog,public,extensions', 'search_path=public,extensions,pg_catalog']]) {
    const changed = current.replace(before, after); assert.notEqual(changed, current);
    const registry = new Map(functions); registry.set(name, changed);
    assert.throws(() => securityContract(all, registry), /exact private room-pass revision helper/);
  }
});

test('C/D/E signatures preserve exact caller, worker, retention and private-helper boundaries', () => {
  const targets = [...new Set(CDE_ACL_BLOCKS.flatMap(block => block.targets.map(([target]) => target))),
    'app_private.hermes_store_prune_work_memories_v1(jsonb)'];
  for (const target of targets) {
    const expected = target === 'app_private.hermes_store_prune_work_memories_v1(jsonb)' ? 'hermes_store_executor'
      : WORKER.includes(target) ? 'service_role' : PUBLIC.includes(target.replace(/^public\./, '')) ? 'authenticated' : null;
    for (const role of ['authenticated', 'service_role', 'hermes_store_executor'].filter(role => role !== expected)) {
      assert.throws(() => securityContract(`${all}; GRANT EXECUTE ON FUNCTION ${target} TO ${role}`), /cannot execute/);
    }
    if (expected) assert.throws(() => securityContract(`${all}; REVOKE EXECUTE ON FUNCTION ${target} FROM ${expected}`), /effective execute ACL/);
  }
});

for (const [label, blockName, before, after] of [
  ['memory owner changes', 'memory', 'OWNER TO postgres', 'OWNER TO authenticated'],
  ['memory PUBLIC execute survives', 'memory', 'FROM PUBLIC,anon,authenticated', 'FROM anon,authenticated'],
  ['memory helper schema changes', 'memory', "('app_private.'||name)::regprocedure", "('public.'||name)::regprocedure"],
  ['memory user port gains worker execute', 'memory', 'TO authenticated', 'TO service_role'],
  ['schedule catalog namespace broadens', 'schedule', "n.nspname='app_private'", "n.nspname IN ('app_private','public')"],
  ['schedule helper gains caller execute', 'schedule', "IF name='hermes_room_schedule_manage_v1'", 'IF true'],
  ['schedule worker port gains caller execute', 'schedule', 'TO service_role', 'TO authenticated'],
  ['domain helper retains executor execute', 'domain', 'FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor', 'FROM PUBLIC,anon,authenticated,service_role'],
  ['v3 fixed signature is omitted', 'v3', ",'public.hermes_room_schedule_capabilities_v1(uuid)'", ''],
  ['v3 caller grant is omitted', 'v3', "EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',signature);", ''],
]) test(`C/D/E ACL mutation rejected: ${label}`, () => {
  const block = CDE_ACL_BLOCKS.find(candidate => candidate.name === blockName);
  assert(all.includes(block.sql), 'mutation targets the current reviewed ACL block');
  const changed = block.sql.replace(before, after); assert.notEqual(changed, block.sql);
  assert.throws(() => securityContract(all.replace(block.sql, () => changed)), /unreviewed function ACL DO block/);
});

test('C/D/E ACL mutation rejects an extra overload selected by the schedule catalog loop', () => {
  const block = CDE_ACL_BLOCKS.find(candidate => candidate.name === 'schedule');
  const current = fn('public.hermes_room_schedule_run_v1');
  const overload = current.replace('p_schedule_id uuid', 'p_schedule_id text');
  assert.notEqual(overload, current); assert(all.includes(block.sql));
  assert.throws(() => securityContract(all.replace(block.sql, () => `${overload}; ${block.sql}`)),
    /catalog ACL loop must resolve only the reviewed signatures/);
});

test('C/D/E ACL mutation rejects an unknown dynamic grant block', () => {
  assert.throws(() => securityContract(`${all}; DO $unreviewed$ BEGIN
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role','public.hermes_domain_read_v1(jsonb,text,jsonb)');
    END $unreviewed$`), /unreviewed function ACL DO block/);
});

test('C/D/E pg_catalog helper exceptions reject mode, path and body changes', () => {
  for (const [name, current] of CDE_CATALOG_HELPERS) {
    for (const [before, after] of [['SECURITY DEFINER', 'SECURITY INVOKER'],
      ['search_path=pg_catalog', 'search_path=pg_catalog,public'], ['$fn$', '$fn$ SELECT * FROM public.rooms;']]) {
      const changed = current.replace(before, after); assert.notEqual(changed, current);
      const registry = new Map(functions); registry.set(name, changed);
      assert.throws(() => securityContract(all, registry), /exact private pg_catalog helper/);
    }
  }
});

test('current numeric formatter stays pure invoker-only and cannot gain an API execute grant', () => {
  const name = 'app_private.hermes_group_number_vi_v1', current = functions.get(name);
  formatterContract(current);
  for (const [from, to] of [
    ['IMMUTABLE SET', 'IMMUTABLE SECURITY DEFINER SET'],
    [' END $fn$', ' END $fn$ SECURITY DEFINER'],
    ['search_path=pg_catalog', 'search_path=pg_catalog,public'],
    ["p IS NULL", "(SELECT count(*) FROM public.rooms)=0"],
  ]) {
    const changed = current.replace(from, to); assert.notEqual(changed, current);
    const registry = new Map(functions); registry.set(name, changed);
    assert.throws(() => securityContract(all, registry));
  }
  for (const role of ['authenticated', 'service_role', 'hermes_store_executor']) {
    assert.throws(() => securityContract(all + `; GRANT EXECUTE ON FUNCTION ${name}(numeric) TO ${role};`), /cannot execute/);
  }
});

test('sale input helpers keep exact invoker bodies and cannot gain an API execute grant', () => {
  for (const [name, current] of SALE_INPUT_HELPERS) {
    assert.equal(functions.get(name), current, `${name}: latest definition is reviewed`);
    for (const [before, after] of [
      ['IMMUTABLE SET', 'IMMUTABLE SECURITY DEFINER SET'],
      ['search_path=pg_catalog', 'search_path=pg_catalog,untrusted'],
      ['AS $fn$', 'AS $fn$ SELECT * FROM public.rooms;'],
    ]) {
      const changed = current.replace(before, after); assert.notEqual(changed, current);
      const registry = new Map(functions); registry.set(name, changed);
      assert.throws(() => securityContract(all, registry), /exact private sale input helper/);
    }
    const target = `${name}(${name.endsWith('keys_v1') ? 'text,jsonb' : 'jsonb'})`;
    for (const role of ['authenticated', 'service_role', 'hermes_store_executor']) {
      assert.throws(() => securityContract(`${all}; GRANT EXECUTE ON FUNCTION ${target} TO ${role};`), /cannot execute/);
    }
    assert.throws(() => securityContract(`${all}; GRANT EXECUTE ON FUNCTION ${target} TO PUBLIC;`), /supported recipient/);
  }
});

test('sale action, policy and v8/v9 option RPC grants remain authenticated-only', () => {
  const ports = PUBLIC.filter(name => /^(?:hermes_sale_(?:policy_)?(?:actions|capabilities)_v1|hermes_(?:org_policy_options|connection_options|connection_context)_v[89])\(/.test(name));
  assert.equal(ports.length, 10);
  for (const port of ports) {
    const target = `public.${port}`;
    for (const role of ['service_role', 'hermes_store_executor']) {
      assert.throws(() => securityContract(`${all}; GRANT EXECUTE ON FUNCTION ${target} TO ${role};`), /cannot execute/);
    }
    assert.throws(() => securityContract(`${all}; REVOKE EXECUTE ON FUNCTION ${target} FROM authenticated;`), /effective execute ACL/);
  }
});

test('current group and V2 public signatures remain caller-only and worker provider entries stay service-only', () => {
  for (const target of PUBLIC.filter(name => /(?:group_|_v2\()/.test(name)).map(name => `public.${name}`)) {
    for (const role of ['service_role', 'hermes_store_executor']) {
      assert.throws(() => securityContract(all + `; GRANT EXECUTE ON FUNCTION ${target} TO ${role};`), /cannot execute/);
    }
    assert.throws(() => securityContract(all + `; REVOKE EXECUTE ON FUNCTION ${target} FROM authenticated;`), /effective execute ACL/);
  }
  for (const target of WORKER.filter(name => name.startsWith('public.zalo_worker_'))) {
    assert.throws(() => securityContract(all + `; GRANT EXECUTE ON FUNCTION ${target} TO authenticated;`), /cannot execute/);
    assert.throws(() => securityContract(all + `; REVOKE EXECUTE ON FUNCTION ${target} FROM service_role;`), /effective execute ACL/);
  }
});

test('signature grammar accepts reviewed NULL defaults but rejects expressions or argument modes', () => {
  assert.equal(signature('helper', 'p_org uuid,p_read text[] DEFAULT NULL', true), 'helper(uuid,text[])');
  for (const args of ["p_read text[] DEFAULT '{}'", 'p_read text[] DEFAULT NULL extra', 'IN p_org uuid']) {
    assert.throws(() => signature('helper', args, true), /reviewed argument grammar/);
  }
});

test('Zalo one-shot surfaces: exact reviewed defaults, caller/worker split and the single table grant stay fail-closed', () => {
  const hen = 'public.zalo_hen_gui_phong_trong_v1';
  assert.equal(signature(hen, "p_recipients uuid[],p_mode text DEFAULT 'full',p_run_at timestamptz DEFAULT NULL,p_request_id text DEFAULT NULL,p_origin text DEFAULT 'ui',p_organization_id uuid DEFAULT NULL", true),
    `${hen}(uuid[],text,timestamptz,text,text,uuid)`);
  assert.equal(signature('public.zalo_ds_hen_gui_phong_trong_v1', 'p_organization_id uuid DEFAULT NULL,p_limit integer DEFAULT 20', true), 'public.zalo_ds_hen_gui_phong_trong_v1(uuid,integer)');
  for (const [name, args] of [[hen, "p_mode text DEFAULT 'compact'"], [hen, "p_origin text DEFAULT 'hermes'"], [hen, "p_mode varchar DEFAULT 'full'"],
    ['public.zalo_ds_hen_gui_phong_trong_v1', 'p_limit integer DEFAULT 100'], ['public.zalo_worker_finish_oneshot_v1', "p_result jsonb DEFAULT '{\"ok\":true}'"],
    ['public.zalo_huy_hen_gui_phong_trong_v1', "p_mode text DEFAULT 'full'"]]) assert.throws(() => signature(name, args, true), /reviewed argument grammar/, `${name}(${args})`);
  securityContract();
  for (const extra of ['GRANT SELECT ON public.zalo_automation_oneshots TO authenticated', 'GRANT INSERT ON public.zalo_automation_oneshots TO service_role'])
    assert.throws(() => securityContract(all + `; ${extra};`), /Unexpected grant/, extra);
  assert.throws(() => securityContract(all + '; GRANT EXECUTE ON FUNCTION public.zalo_worker_claim_oneshot_v1(uuid,uuid[]) TO authenticated;'), /cannot execute/);
  assert.throws(() => securityContract(all + '; GRANT EXECUTE ON FUNCTION public.zalo_hen_gui_phong_trong_v1(uuid[],text,timestamptz,text,text,uuid) TO service_role;'), /cannot execute/);
  assert.throws(() => securityContract(all + '; GRANT EXECUTE ON FUNCTION app_private.zalo_oneshot_khung_gio_v1(jsonb,timestamptz) TO authenticated;'), /cannot execute/);
  assert.throws(() => securityContract(all + '; REVOKE EXECUTE ON FUNCTION public.zalo_ds_hen_gui_phong_trong_v1(uuid,integer) FROM authenticated;'), /effective execute ACL/);
});

test('signature grammar accepts only the exact schedule due empty-list default', () => {
  const name = 'public.hermes_room_schedule_due_v1';
  assert.equal(signature(name, "p_instance_id uuid,p_organization_ids uuid[] DEFAULT '{}'", true), `${name}(uuid,uuid[])`);
  for (const args of ["p_organization_ids uuid[] DEFAULT '{}'::uuid[]", "p_other uuid[] DEFAULT '{}'",
    "p_organization_ids text[] DEFAULT '{}'", "p_organization_ids uuid[] DEFAULT '{00000000-0000-0000-0000-000000000000}'"]) {
    assert.throws(() => signature(name, args, true), /reviewed argument grammar/);
  }
  assert.throws(() => signature('public.other', "p_organization_ids uuid[] DEFAULT '{}'", true), /reviewed argument grammar/);
});

for (const name of ['hermes_connection_options_v1', 'hermes_org_policy_options_v1']) test(`${name} choices are caller-only and cannot be opened to worker or executor`, () => {
  const target = `public.${name}(uuid)`;
  for (const role of ['anon', 'service_role', 'hermes_store_executor']) {
    assert.throws(() => securityContract(all + `; GRANT EXECUTE ON FUNCTION ${target} TO ${role};`),
      role === 'anon' ? /supported recipient/ : /cannot execute/);
  }
  assert.throws(() => securityContract(all + `; REVOKE EXECUTE ON FUNCTION ${target} FROM authenticated;`), /effective execute ACL/);
});

test('Zalo worker can execute only link ingress and private intake, while linking stays on the authenticated caller', () => {
  for (const [role, target] of [
    ['authenticated', 'public.hermes_zalo_ingress_v1(jsonb)'],
    ['hermes_store_executor', 'public.hermes_zalo_ingress_v1(jsonb)'],
    ['authenticated', 'public.hermes_zalo_private_command_v1(jsonb)'],
    ['hermes_store_executor', 'public.hermes_zalo_private_command_v1(jsonb)'],
    ['authenticated', 'public.hermes_zalo_private_reply_v1(jsonb)'],
    ['hermes_store_executor', 'public.hermes_zalo_private_reply_v1(jsonb)'],
    ['service_role', 'public.hermes_zalo_binding_v1(jsonb)'],
    ['service_role', 'app_private.hermes_store_read_connection_v1(jsonb)'],
  ]) assert.throws(() => securityContract(all + `; GRANT EXECUTE ON FUNCTION ${target} TO ${role};`), /cannot execute/);
  assert.throws(() => securityContract(all + '; REVOKE EXECUTE ON FUNCTION public.hermes_zalo_ingress_v1(jsonb) FROM service_role;'), /effective execute ACL/);
  assert.throws(() => securityContract(all + '; REVOKE EXECUTE ON FUNCTION public.hermes_zalo_private_command_v1(jsonb) FROM service_role;'), /effective execute ACL/);
  assert.throws(() => securityContract(all + '; REVOKE EXECUTE ON FUNCTION public.hermes_zalo_private_reply_v1(jsonb) FROM service_role;'), /effective execute ACL/);
  for (const statement of [
    'ALTER TABLE app_private.hermes_zalo_private_commands ENABLE ROW LEVEL SECURITY',
    'ALTER TABLE app_private.hermes_zalo_private_commands OWNER TO postgres',
    'REVOKE ALL ON app_private.hermes_zalo_private_commands FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',
  ]) assert(all.includes(statement), statement);
});
test('private ledger consumer remains executor-only, with no helper or table access', () => {
  for (const operation of ['claim', 'dispatch', 'finish', 'fail']) {
    const target = `app_private.hermes_store_${operation}_private_command_v1(jsonb)`;
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.throws(() => securityContract(all + `; GRANT EXECUTE ON FUNCTION ${target} TO ${role};`), role === 'anon' ? /supported recipient/ : /cannot execute/);
    }
    assert.throws(() => securityContract(all + `; REVOKE EXECUTE ON FUNCTION ${target} FROM hermes_store_executor;`), /effective execute ACL/);
  }
  for (const target of ['app_private.hermes_private_command_connection_v1(text)',
    'app_private.hermes_private_command_lock_v1(app_private.hermes_connections,uuid,text)']) {
    assert.throws(() => securityContract(all + `; GRANT EXECUTE ON FUNCTION ${target} TO hermes_store_executor;`), /cannot execute/);
  }
  assert.throws(() => securityContract(all + '; GRANT SELECT ON app_private.hermes_zalo_private_commands TO hermes_store_executor;'), /Unexpected grant/);
});
test('current membership is bounded by revocation/time and ordinary one-company rule', () => membershipContract());
test('stable assistant and session ownership are enforced by composite identity constraints', () => {
  assert.match(all, /UNIQUE\(organization_id,user_id\), UNIQUE\(id,organization_id,user_id\)/);
  assert.match(all, /provider_session_id uuid NOT NULL UNIQUE/);
  assert.match(all, /FOREIGN KEY\(credential_ref,assistant_id,organization_id,user_id\) REFERENCES app_private\.hermes_sessions\(id,assistant_id,organization_id,user_id\)/);
  assert.match(all, /CHECK \(state NOT IN \('ACTIVE','RESERVED','DISPATCHED'\) OR envelope IS NOT NULL\)/);
  assert.match(all, /CHECK \(\(state='STAGED'\) = \(staged_envelope IS NOT NULL AND staged_expires_at IS NOT NULL\)\)/);
  assert.match(all, /ON app_private\.hermes_connection_tokens\(connection_id\) WHERE revoked_at IS NULL/);
});
test('human policy writes reuse CRM permission and CAS; preparation cannot exceed that ceiling', () => {
  const policy = fn('public.hermes_set_org_policy_v1');
  assert.match(policy, /require_perm_v1\(p_org,'users.edit'/);
  assert.match(policy, /WHERE hermes_org_policies\.version=p_expected_version RETURNING \* INTO v_new; IF NOT FOUND THEN RAISE EXCEPTION/);
  assert.match(policy, /append_authz_audit_v1/);
  const prepare = fn('public.hermes_prepare_connection_v1');
  assert.match(prepare, /v_actor uuid:=auth.uid\(\)/);
  assert.match(prepare, /hermes_member_v1\(v_actor,p_org\)/);
  assert.match(prepare, /NOT \(p_read<@v_policy\.read_capabilities\).*NOT \(p_action<@v_policy\.action_capabilities\).*NOT \(p_scope_ids<@v_policy\.scope_ids\)/);
  assert.match(prepare, /extensions\.gen_random_bytes\(32\)/);
  assert.match(prepare, /extensions\.digest\(v_secret,'sha256'\)/);
  const restrict = fn('hermes_store_restrict_connection_v1');
  assert.match(restrict, /NOT\(r<@c\.read_capabilities\) OR NOT\(a<@c\.action_capabilities\) OR NOT\(scopes<@c\.scope_ids\)/);
});
test('atomic activation binds intent, verified user, original payload, session and expiring opaque digest', () => activationContract());
test('current envelope uses explicit ciphertext length and a PostgreSQL-compatible base64url regex', () => envelopeContract());
test('joined read requires current active token, connection, session, membership and company policy', () => readContract());
test('refresh uses durable lease/fence, hidden staging, publication receipt and no post-dispatch release', () => refreshContract());
test('connection revocation serializes publication but does not revoke another connection session', () => revokeContract());
function publicContextContract(registry = functions) {
  for (const name of ['hermes_connection_json_v1', 'public.hermes_my_connections_v1', 'public.hermes_connection_context_v1']) {
    assert.doesNotMatch(fn(name, registry), /'envelope'|'tokenDigest'|'intentSecret'|'refreshToken'|'accessToken'/);
  }
  const context = fn('public.hermes_connection_context_v1', registry);
  assert.match(context, /user_id=auth.uid\(\)/);
  assert.match(context, /cap\.mode='read' AND cap\.enabled/);
  assert.match(context, /cap\.capability=ANY\(v_c\.read_capabilities\) AND cap\.capability=ANY\(v_p\.read_capabilities\)/);
  assert.match(context, /v_buildings:=public\.hermes_scope_buildings_v1\('rooms.view',v_c\.organization_id\)/);
  assert.match(context, /cap\.capability='assistant.context.read' OR \(cap\.capability='rooms.view' AND v_auth->'permissions'->'rooms.view'='true'::jsonb AND cardinality\(v_buildings\)>0\)/);
  assert.match(context, /'action','\[\]'::jsonb/);
}
test('public self-context includes no encrypted/session material and only current bounded read capabilities', () => publicContextContract());
test('private inputs have exact keys and JSON null cannot bypass envelope algorithm validation', () => {
  assert.match(fn('hermes_request_v1'), /count\(\*\) FROM jsonb_object_keys\(p\).*cardinality\(p_keys\) OR NOT \(p \?& p_keys\)/);
  assert.match(fn('hermes_envelope_v1'), /p->'v' IS DISTINCT FROM '1'::jsonb OR p->>'algorithm' IS DISTINCT FROM 'A256GCM'/);
  for (const operation of STORE) assert.match(fn(`hermes_store_${operation}_v1`), /hermes_request_v1\(p,ARRAY\[/);
});
test('every Hermes source fits the reviewed rollback wrapper, including double-run idempotency probe', () => {
  for (const { sql } of sources) {
    const probe = buildTransaction(sql, { rollback: true, lanChay: 2 });
    const parts = splitSqlStatements(probe).map(clean);
    assert.equal(parts.filter(p => /^BEGIN$/i.test(p)).length, 1);
    assert.equal(parts.filter(p => /^(?:COMMIT|ROLLBACK)$/i.test(p)).length, 1);
    assert.equal(parts.at(-1), 'ROLLBACK');
  }
});

// Mutation witnesses: these are regressions the static contracts must reject.
// They are deliberately not a simulated database/state machine.
for (const [label, name, before, after, check] of [
  ['revoked membership', 'hermes_member_v1', 'm.revoked_at IS NULL', 'true', membershipContract],
  ['ordinary multi-company', 'hermes_member_v1', 'v_org_count<>1', 'v_org_count<1', membershipContract],
  ['activation payload mismatch', 'hermes_store_activate_v1', 'c.activation_hash<>v_hash', 'false', activationContract],
  ['ciphertext loses size bound', 'hermes_envelope_v1', "OR char_length(p->>'ciphertext') NOT BETWEEN 1 AND 87382", '', envelopeContract],
  ['staged session disclosure', 'hermes_store_read_connection_v1', "id=c.credential_ref AND state='ACTIVE'", "id=c.credential_ref AND state IN ('ACTIVE','STAGED')", readContract],
  ['read skips explicit policy lock', 'hermes_store_read_connection_v1', 'organization_id=c.organization_id FOR SHARE', 'organization_id=c.organization_id', readContract],
  ['read accepts disabled effective policy', 'hermes_store_read_connection_v1', 'c.scope_ids) WHERE enabled', 'c.scope_ids)', readContract],
  ['read loses connection-bounded neutral policy', 'hermes_store_read_connection_v1', 'c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids', 'c.organization_id,NULL,NULL,NULL', readContract],
  ['disabled explicit policy becomes neutral', 'hermes_effective_org_policy_v1', 'IF FOUND THEN RETURN v_policy', 'IF FOUND AND v_policy.enabled THEN RETURN v_policy', effectivePolicyContract],
  ['neutral policy collides with first explicit version', 'hermes_effective_org_policy_v1', 'v_policy.version:=0', 'v_policy.version:=1', effectivePolicyContract],
  ['neutral scope crosses organization', 'hermes_effective_org_policy_v1', 'organization_id=p_org AND (p_scope_ids', '(p_scope_ids', effectivePolicyContract],
  ['claim stale fence', 'hermes_claim_v1', 's.fence<>v_fence', 'false', refreshContract],
  ['expired lease', 'hermes_store_dispatch_refresh_v1', 's.lease_until<=clock_timestamp()', 'false', refreshContract],
  ['published receipt revision', 'hermes_store_publish_refresh_v1', 's.revision=v_revision+1', 's.revision=v_revision', refreshContract],
  ['revocation loses fence', 'hermes_store_revoke_session_v1', 'fence=fence+1', 'fence=fence', revokeContract],
  ['connection revoke skips session lock', 'hermes_store_revoke_connection_v1', 'PERFORM 1 FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR UPDATE', 'PERFORM 1', revokeContract],
]) {
  test(`mutation is rejected: ${label}`, () => {
    const registry = new Map(functions);
    const current = fn(name);
    assert(current.includes(before), 'mutation actually changes the current source');
    registry.set(`app_private.${name}`, current.replace(before, after));
    assert.throws(() => check(registry));
  });
}
test('mutation is rejected: restoring oversized PostgreSQL regex repetition in place of length guard', () => {
  const registry = new Map(functions);
  const current = fn('hermes_envelope_v1');
  const changed = current.replace("OR char_length(p->>'ciphertext') NOT BETWEEN 1 AND 87382 ", '')
    .replace("'^[A-Za-z0-9_-]+$'", "'^[A-Za-z0-9_-]{1,87382}$'");
  assert.notEqual(changed, current, 'mutation actually changes the current source');
  assert(!changed.includes('char_length'));
  assert(changed.includes('{1,87382}'));
  registry.set('app_private.hermes_envelope_v1', changed);
  assert.throws(() => envelopeContract(registry), /PostgreSQL regex repetition bound exceeds 255/);
});
test('mutation is rejected: granting encrypted store to an API role', () => {
  assert.throws(() => securityContract(`${all};\nGRANT EXECUTE ON FUNCTION app_private.hermes_store_read_connection_v1(jsonb) TO authenticated`));
});
test('mutation is rejected: giving the executor table access', () => {
  assert.throws(() => securityContract(`${all};\nGRANT SELECT ON app_private.hermes_sessions TO hermes_store_executor`));
});
test('mutation is rejected: forward migration revokes a required execute grant', () => {
  assert.throws(() => securityContract(`${all};\nREVOKE ALL ON FUNCTION app_private.hermes_store_renew_connection_v1(jsonb) FROM hermes_store_executor`));
});
test('mutation is rejected: granting a private helper outside the fixed executor surface', () => {
  assert.throws(() => securityContract(`${all};\nGRANT EXECUTE ON FUNCTION app_private.hermes_integer_v1(jsonb) TO hermes_store_executor`));
});
test('mutation is rejected: a mixed function grant cannot hide an unrelated target', () => {
  assert.throws(() => securityContract(`${all};\nGRANT EXECUTE ON FUNCTION public.hermes_my_connections_v1(uuid), public.non_hermes_function(uuid) TO authenticated`));
});
test('mutation is rejected: a new overload cannot inherit an older signature ACL in the verifier', () => {
  const overload = fn('public.hermes_my_connections_v1').replace('(p_org uuid)', '(p_org text)');
  assert.notEqual(overload, fn('public.hermes_my_connections_v1'));
  assert.throws(() => securityContract(`${all};\n${overload}`));
});
for (const [label, before] of [['CRM room permission', "v_auth->'permissions'->'rooms.view'='true'::jsonb"],
  ['nonempty room scope', 'cardinality(v_buildings)>0']]) {
  test(`mutation is rejected: public context skips ${label}`, () => {
    const registry = new Map(functions), name = 'public.hermes_connection_context_v1', body = fn(name);
    assert(body.includes(before)); registry.set(name, body.replace(before, 'true'));
    assert.throws(() => publicContextContract(registry));
  });
}
test('mutation is rejected: leaving default PUBLIC execute on a helper', () => {
  const changed = all.replace(/REVOKE ALL ON FUNCTION app_private\.hermes_request_v1[^;]*;/, '');
  assert.notEqual(changed, all);
  assert.throws(() => securityContract(changed));
});

test('task exact signatures retain caller ACL and no worker/service/helper widening', () => {
  securityContract();
  for (const spec of TASK_FUNCTIONS) {
    for (const role of ['hermes_store_executor', 'service_role', ...(spec.authenticated ? [] : ['authenticated'])]) {
      assert.throws(() => securityContract(all + '; GRANT EXECUTE ON FUNCTION ' + spec.signature + ' TO ' + role), /cannot execute/);
    }
    if (spec.authenticated) assert.throws(() => securityContract(all + '; REVOKE EXECUTE ON FUNCTION ' + spec.signature + ' FROM authenticated'), /effective execute ACL/);
    const registry = new Map(functions), original = registry.get(spec.name);
    registry.set(spec.name, original.replace(spec.definer ? 'SECURITY DEFINER' : 'SECURITY INVOKER', spec.definer ? 'SECURITY INVOKER' : 'SECURITY DEFINER'));
    assert.throws(() => securityContract(all, registry), FORWARD_BY_NAME.has(spec.name) ? /exact reviewed forward definition/ : /exact task signature/);
  }
});
test('task-v5 exact dynamic ACL adapter rejects changed recipient or helper namespace', () => {
  for (const changed of [TASK_OPTIONS_ACL.sql.replace('FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor', 'FROM PUBLIC,anon,authenticated,hermes_store_executor'),
    TASK_OPTIONS_ACL.sql.replace('app_private.hermes_task_extend_options_v1', 'public.hermes_task_extend_options_v1')]) {
    assert.throws(() => securityContract(all.replace(TASK_OPTIONS_ACL.sql, () => changed)), /unreviewed function ACL DO block/);
  }
});
test('task SQL-standard source never silently drops or accepts a changed callee/body', () => {
  for (const spec of TASK_FUNCTIONS.filter(item => item.standard)) {
    const body = functions.get(spec.name);
    assert.throws(() => splitSqlStatements(body.replace('BEGIN ATOMIC', 'BEGIN ATOMIC SELECT 1;')), /task_sql_standard_source_mismatch/);
  }
});
test('task receipt stays private, owned and RLS enabled', () => {
  assert.match(all, /ALTER TABLE app_private.hermes_task_create_receipts OWNER TO postgres/);
  assert.match(all, /ALTER TABLE app_private.hermes_task_create_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(all, /REVOKE ALL ON TABLE app_private.hermes_task_create_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor/);
});
test('expense receipt stays private, owned and RLS enabled; finance helpers have no API execute', () => {
  assert.match(all, /ALTER TABLE app_private.hermes_expense_create_receipts OWNER TO postgres/);
  assert.match(all, /ALTER TABLE app_private.hermes_expense_create_receipts ENABLE ROW LEVEL SECURITY/);
  assert.match(all, /REVOKE ALL ON TABLE app_private.hermes_expense_create_receipts FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor/);
  for (const helper of ['app_private.hermes_domain_date_v2(jsonb)', 'app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)',
    'app_private.hermes_expense_category_ok_v1(uuid,uuid)', 'app_private.hermes_expense_cashbook_ok_v1(uuid,uuid,uuid)',
    'app_private.hermes_finance_extend_options_v1(jsonb,text)']) {
    assert.throws(() => securityContract(all + `; GRANT EXECUTE ON FUNCTION ${helper} TO authenticated;`), /cannot execute/, helper);
  }
  for (const target of ['public.hermes_expense_action_v1(jsonb,text,jsonb)', 'public.hermes_expense_capabilities_v1(uuid)']) {
    assert.throws(() => securityContract(all + `; GRANT EXECUTE ON FUNCTION ${target} TO service_role;`), /cannot execute/);
    assert.throws(() => securityContract(all + `; REVOKE EXECUTE ON FUNCTION ${target} FROM authenticated;`), /effective execute ACL/);
  }
});

// Package C/D (20261015100000–20261015110200) forward ACL witnesses.
test('package C/D ACL adapters replay exactly the signatures, names and recipients written in their pinned SQL', () => {
  const quoted = text => [...text.matchAll(/'([a-z0-9_]+)'/g)].map(match => match[1]);
  for (const block of CD_FORWARD_ACL_BLOCKS) {
    assert(all.includes(block.sql), `${block.name}: current reviewed ACL block`);
    const targets = block.targets.map(([target]) => target);
    if (block.catalog) {
      const selected = ['app_private', 'public'].flatMap(schema =>
        quoted(new RegExp(`n\\.nspname='${schema}' AND p\\.proname IN \\(([^)]*)\\)`).exec(block.sql)[1]).map(name => `${schema}.${name}`));
      assert.deepEqual(selected.sort(), targets.map(target => target.split('(')[0]).sort(), `${block.name}: catalog names`);
      const grant = /IF name IN \(([^)]*)\) THEN EXECUTE format\('GRANT EXECUTE ON FUNCTION %s TO (\w+)',signature\); END IF;/.exec(block.sql);
      assert.deepEqual(quoted(grant[1]).map(name => `public.${name}`).sort(),
        block.targets.filter(([, role]) => role).map(([target]) => target.split('(')[0]).sort(), `${block.name}: granted names`);
      assert(block.targets.every(([, role]) => role === null || role === grant[2]), `${block.name}: one recipient`);
    } else {
      assert.doesNotMatch(block.sql, /\bGRANT\b/, `${block.name}: revoke-only loop`);
      assert.deepEqual([...block.sql.matchAll(/'((?:app_private|public)\.[a-z0-9_]+\([^']*\))'/g)].map(match => match[1]), targets);
      assert(block.targets.every(([, role]) => role === null));
    }
  }
});

test('package C/D caller, worker and private-step ports keep exact execute; private helpers stay closed', () => {
  const targets = [...new Set(CD_FORWARD_ACL_BLOCKS.flatMap(block => block.targets.map(([target]) => target)))];
  for (const target of targets) {
    const expected = WORKER.includes(target) ? 'service_role'
      : TASK_FOLLOW_STEPS.includes(target) || PUBLIC.includes(target.replace(/^public\./, '')) ? 'authenticated' : null;
    const wrong = expected === 'authenticated' ? 'service_role' : 'authenticated';
    assert.throws(() => securityContract(`${all}; GRANT EXECUTE ON FUNCTION ${target} TO ${wrong}`), /cannot execute/, `${target} to ${wrong}`);
    if (expected) assert.throws(() => securityContract(`${all}; REVOKE EXECUTE ON FUNCTION ${target} FROM ${expected}`), /effective execute ACL/, target);
  }
});

for (const [label, blockName, before, after] of [
  ['health PUBLIC execute survives', 'schedule-health', 'FROM PUBLIC,anon,authenticated', 'FROM anon,authenticated'],
  ['health worker port gains caller execute', 'schedule-health', 'TO service_role', 'TO authenticated'],
  ['health catalog namespace broadens', 'schedule-health', "n.nspname='app_private'", "n.nspname IN ('app_private','public')"],
  ['reconcile caller port gains worker execute', 'delivery-reconcile', 'TO authenticated', 'TO service_role'],
  ['reconcile private helper gains caller execute', 'delivery-reconcile', "IF name IN ('hermes_delivery_reconcile_list_v1'",
    "IF name IN ('hermes_delivery_reconcile_apply_v1','hermes_delivery_reconcile_list_v1'"],
  ['reconcile owner changes', 'delivery-reconcile', 'OWNER TO postgres', 'OWNER TO authenticated'],
  ['task-follow PUBLIC execute survives', 'task-follow', 'FROM PUBLIC,anon,authenticated', 'FROM anon,authenticated'],
  ['task-follow cron tick omitted', 'task-follow', ",'app_private.hermes_task_follow_tick_v1(integer)'", ''],
  ['memory supervisor helper omitted', 'memory-supervise', "'app_private.hermes_memory_supervisor_v1(app_private.hermes_connections)',", ''],
  ['memory executor execute survives', 'memory-supervise', 'service_role,hermes_store_executor', 'service_role'],
  ['v6 options helper omitted', 'task-follow-v6', "'app_private.hermes_task_follow_extend_options_v1(jsonb,text)',", ''],
  ['v6 PUBLIC execute survives', 'task-follow-v6', 'FROM PUBLIC,anon,authenticated', 'FROM anon,authenticated'],
]) test(`package C/D ACL mutation rejected: ${label}`, () => {
  const block = CD_FORWARD_ACL_BLOCKS.find(candidate => candidate.name === blockName);
  assert(all.includes(block.sql), 'mutation targets the current reviewed ACL block');
  const changed = block.sql.replace(before, after); assert.notEqual(changed, block.sql);
  assert.throws(() => securityContract(all.replace(block.sql, () => changed)), /unreviewed function ACL DO block/);
});

for (const [blockName, name, before, after] of [
  ['schedule-health', 'public.hermes_room_schedule_sweep_v1', 'p_instance_id uuid', 'p_instance_id text'],
  ['delivery-reconcile', 'public.hermes_room_schedule_manage_v2', '(p jsonb)', '(p text)'],
]) test(`package C/D ACL mutation rejects an extra ${name} overload selected by the ${blockName} catalog loop`, () => {
  const block = CD_FORWARD_ACL_BLOCKS.find(candidate => candidate.name === blockName);
  const current = fn(name), overload = current.replace(before, after);
  assert.notEqual(overload, current); assert(all.includes(block.sql));
  assert.throws(() => securityContract(all.replace(block.sql, () => `${overload}; ${block.sql}`)),
    /catalog ACL loop must resolve only the reviewed signatures/);
});

test('package D explicit grants: a widened private-step grant or a dropped caller grant is rejected', () => {
  const statement = prefix => statements.find(sql => sql.startsWith(prefix));
  const steps = statement('GRANT EXECUTE ON FUNCTION app_private.hermes_task_follow_guard_v1(');
  const memory = statement('GRANT EXECUTE ON FUNCTION public.hermes_work_memory_configure_v1(jsonb,jsonb),public.hermes_work_memory_list_v1(');
  const v6 = statement('GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v6(');
  assert(steps && memory && v6);
  for (const [current, changed, message] of [
    [steps, steps.replace('app_private.hermes_task_follow_apply_v1(jsonb),', 'app_private.hermes_task_follow_apply_v1(jsonb),app_private.hermes_task_follow_tick_v1(integer),'), /cannot execute/],
    [steps, steps.replace('TO authenticated', 'TO service_role'), /cannot execute/],
    [memory, memory.replace('public.hermes_work_memory_search_v1(jsonb,jsonb),', ''), /effective execute ACL/],
    [v6, v6.replace('public.hermes_org_policy_options_v6(uuid),', ''), /effective execute ACL/],
  ]) {
    assert.notEqual(changed, current); assert(all.includes(current));
    assert.throws(() => securityContract(all.replace(current, () => changed)), message);
  }
});

test('package C/D narrow-path helper exceptions reject mode, path, relation and body changes', () => {
  for (const [name, current] of CD_NARROW_PATH_HELPERS) {
    assert.equal(functions.get(name), current, `${name}: the current source is the pinned helper`);
    const mode = current.includes(' SECURITY DEFINER ') ? ['SECURITY DEFINER', 'SECURITY INVOKER'] : [' SET search_path', ' SECURITY DEFINER SET search_path'];
    for (const [before, after] of [mode, ['search_path=pg_catalog', 'search_path=pg_catalog,app_private'],
      ['AS $fn$', 'AS $fn$ SELECT * FROM public.rooms;']]) {
      const changed = current.replace(before, after); assert.notEqual(changed, current);
      const registry = new Map(functions); registry.set(name, changed);
      assert.throws(() => securityContract(all, registry), /exact private narrow-path helper/);
    }
  }
});

test('task-follow invoker pair keeps the exact INVOKER step, wrapper body and extractor byte pin', () => {
  const source = readFileSync(join(directory, '20261015110000_hermes_task_follow_v1.sql'), 'utf8');
  const action = extractHermesFunctionDefinitions(source, TASK_FOLLOW_PATH).find(item => item.qualifiedName === 'public.hermes_task_follow_action_v1');
  assert.equal(action?.bodyKind, 'sql-standard');
  assert.throws(() => extractHermesFunctionDefinitions(source, 'migration.sql'), /task_sql_standard_source_mismatch/);
  assert.throws(() => extractHermesFunctionDefinitions(source.replace('app_private.hermes_task_follow_apply_v1(app_private',
    'app_private.hermes_task_follow_finish_v1(app_private'), TASK_FOLLOW_PATH), /task_sql_standard_source_mismatch/);
  for (const [name, before, after, message] of [
    ['app_private.hermes_task_follow_apply_v1', 'SECURITY INVOKER', 'SECURITY DEFINER', /exact task-follow invoker step/],
    ['app_private.hermes_task_follow_apply_v1', 'search_path=pg_catalog,public', 'search_path=pg_catalog,public,app_private', /exact task-follow invoker step/],
    ['public.hermes_task_follow_action_v1', 'SECURITY INVOKER', 'SECURITY DEFINER', /exact task-follow SQL-standard wrapper/],
    ['public.hermes_task_follow_action_v1', 'app_private.hermes_task_follow_apply_v1(', 'app_private.hermes_task_follow_tick_v1(', /exact task-follow SQL-standard wrapper/],
  ]) {
    const current = functions.get(name), changed = current.replace(before, after); assert.notEqual(changed, current);
    const registry = new Map(functions); registry.set(name, changed);
    assert.throws(() => securityContract(all, registry), message);
  }
});

test('signature grammar accepts only the exact sweep empty-list and tick limit defaults', () => {
  assert.equal(signature('public.hermes_room_schedule_sweep_v1', "p_instance_id uuid,p_organization_ids uuid[] DEFAULT '{}'", true),
    'public.hermes_room_schedule_sweep_v1(uuid,uuid[])');
  assert.equal(signature('app_private.hermes_task_follow_tick_v1', 'p_limit integer DEFAULT 500', true), 'app_private.hermes_task_follow_tick_v1(integer)');
  for (const [name, args] of [
    ['public.hermes_room_schedule_sweep_v1', "p_organization_ids uuid[] DEFAULT '{}'::uuid[]"],
    ['public.hermes_room_schedule_sweep_v1', "p_instance_id uuid DEFAULT '{}'"],
    ['public.hermes_room_schedule_sweep_v1', 'p_limit integer DEFAULT 500'],
    ['app_private.hermes_task_follow_tick_v1', 'p_limit integer DEFAULT 5000'],
    ['app_private.hermes_task_follow_tick_v1', 'p_limit bigint DEFAULT 500'],
    ['app_private.hermes_task_follow_tick_v1', 'p_other integer DEFAULT 500'],
    ['app_private.hermes_task_follow_tick_v1', "p_organization_ids uuid[] DEFAULT '{}'"],
    ['public.hermes_room_schedule_run_v2', 'p_limit integer DEFAULT 500'],
  ]) assert.throws(() => signature(name, args, true), /reviewed argument grammar/, `${name}(${args})`);
});

test('wave-2 INVOKER entry and package reads stay INVOKER, keep pg_catalog,public, never name app_private in plpgsql and keep the exact caller grant', () => {
  for (const name of ['public.hermes_w2_read_v1', 'hermes_w2a_read_v1']) {
    const registry = new Map(functions), key = name.startsWith('public.') ? name : `app_private.${name}`;
    registry.set(key, fn(name).replace('SECURITY INVOKER', 'SECURITY DEFINER'));
    assert.throws(() => securityContract(all, registry), undefined, `${name}: DEFINER`);
  }
  const registry = new Map(functions);
  registry.set('app_private.hermes_w2b_read_v1', fn('hermes_w2b_read_v1').replace('RETURN jsonb_build_object(',
    'PERFORM app_private.hermes_w2_param_names_v1(); RETURN jsonb_build_object('));
  assert.throws(() => securityContract(all, registry), /plpgsql invoker names app_private/);
  for (const target of ['app_private.hermes_w2_catalog_v1(text)', 'app_private.hermes_w2_gate_v1(jsonb,text,jsonb)'])
    assert.throws(() => securityContract(`${all};\nGRANT EXECUTE ON FUNCTION ${target} TO authenticated`), /cannot execute/, target);
});
