import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { splitSqlStatements } from '../network-center-function-bodies.mjs';
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
const statements = sources.flatMap(({ sql }) => splitSqlStatements(sql).map(clean));
const functions = new Map();
for (const statement of statements) {
  const head = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:app_private|public)\.hermes_\w+)\(/i.exec(statement);
  if (head) functions.set(head[1], statement);
}
const fn = (name, registry = functions) => {
  const value = registry.get(name.startsWith('public.') ? name : `app_private.${name}`);
  assert(value, `Missing current definition: ${name}`);
  return value;
};
const all = statements.join(';\n');
const STORE = ['activate', 'read_connection', 'restrict_connection', 'renew_connection', 'revoke_connection', 'acquire_refresh',
  'dispatch_refresh', 'stage_refresh', 'publish_refresh', 'reconnect_session', 'revoke_session', 'release_refresh',
  'claim_private_command', 'dispatch_private_command', 'finish_private_command', 'fail_private_command', 'prune_private_commands'];
const PUBLIC = ['hermes_set_org_policy_v1(uuid,bigint,boolean,text[],text[],uuid[])',
  'hermes_prepare_connection_v1(uuid,text[],text[],uuid[])', 'hermes_my_connections_v1(uuid)',
  'hermes_connection_context_v1(uuid)', 'hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint)',
  'hermes_zalo_binding_v1(jsonb)', 'hermes_connection_options_v1(uuid)', 'hermes_org_policy_options_v1(uuid)'];
const TABLES = ['capabilities', 'assistants', 'org_policies', 'sessions', 'connections', 'connection_tokens'];

// Intentionally a small fail-closed grammar for these reviewed SQL signatures,
// not a general SQL parser. A new type/default/mode requires explicit review.
const TYPE = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*(?:\[\])?$/;
function signature(name, args, named = false) {
  const types = args.trim() === '' ? [] : args.split(',').map(arg => {
    const parts = arg.trim().split(/\s+/);
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

function securityContract(sql = all, registry = functions) {
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
    const header = definition.split(/\bAS\s+\$/i)[0];
    assert.match(header, /SECURITY DEFINER SET search_path=pg_catalog,(?:public,)?app_private/i, name);
    assert.match(sql, new RegExp(`ALTER FUNCTION ${name.replace('.', '\\.')}\\([^;]*?\\) OWNER TO postgres`, 'i'), name);
    assert.match(sql, new RegExp(`REVOKE ALL ON FUNCTION [^;]*?${name.replace('.', '\\.')}\\([^;]*?FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor`, 'i'), `${name}: revoke default/API execute explicitly`);
    assert.doesNotMatch(definition, /\bEXECUTE\s+(?!ON\b)|set_config\s*\(\s*'request\.jwt|\bSET\s+ROLE\b/i, name);
  }
  // Forward migrations may grant one new function or replace/revoke/regrant an
  // existing subset. Replay ACL statements in order, rather than requiring each
  // historical GRANT to contain the entire future surface (or unioning grants
  // that a later REVOKE actually removed). CREATE OR REPLACE keeps its old ACL.
  const acl = new Map();
  const allowed = new Map([
    ['authenticated', new Set(PUBLIC.map(name => `public.${name}`))],
    ['hermes_store_executor', new Set(STORE.map(name => `app_private.hermes_store_${name}_v1(jsonb)`))],
    ['service_role', new Set(['public.hermes_zalo_ingress_v1(jsonb)', 'public.hermes_zalo_private_command_v1(jsonb)', 'public.hermes_zalo_private_reply_v1(jsonb)'])],
  ]);
  for (const statement of splitSqlStatements(sql).map(clean)) {
    const definition = /^CREATE (?:OR REPLACE )?FUNCTION ((?:app_private|public)\.hermes_\w+)\(([^)]*)\)/i.exec(statement);
    if (definition) {
      const key = signature(definition[1], definition[2], true);
      if (!acl.has(key)) acl.set(key, new Set(['PUBLIC']));
    }
    if (/^GRANT USAGE ON SCHEMA app_private TO hermes_store_executor$/i.test(statement)) continue;
    if (!/^(?:GRANT|REVOKE)\b/i.test(statement) || !/\bON FUNCTION\b/i.test(statement)) {
      if (/^GRANT\b/i.test(statement)) assert.fail(`Unexpected grant: ${statement}`);
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
  assert.match(body, /organization_id=c\.organization_id AND enabled FOR SHARE/);
  assert(body.indexOf('expires_at>clock_timestamp() FOR SHARE') < body.indexOf('credential_ref=s.id FOR SHARE'));
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
  assert.match(context, /v_buildings:=public\.copilot_org_scope_buildings_v1\('rooms.view',v_c\.organization_id\)/);
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
