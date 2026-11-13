import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { splitSqlStatements } from '../network-center-function-bodies.mjs';

// Source contract only, NOT a PostgreSQL parser or concurrency/clock proof.
// Select the latest function definition so forward changes cannot leave this
// test checking an obsolete immutable migration. TEST lane owns live evidence.
const directory = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const clean = sql => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const statements = readdirSync(directory).filter(name => name.endsWith('.sql')).sort()
  .flatMap(name => splitSqlStatements(readFileSync(join(directory, name), 'utf8')).map(clean));
const name = 'app_private.hermes_store_renew_connection_v1';
const current = statements.filter(sql => sql.startsWith(`CREATE OR REPLACE FUNCTION ${name}(p jsonb)`)).at(-1);
assert(current, 'latest renewal function must exist');

function leaseContract(body) {
  assert.match(body, /hermes_request_v1\(p,ARRAY\['tokenDigest','connectionId','expectedEpoch','credentialRef','expectedRevision','expectedExpiresAt','requestedTtlMs'\]\)/);
  assert.match(body, /jsonb_typeof\(p->'tokenDigest'\) IS DISTINCT FROM 'string'/);
  assert.match(body, /v_ttl_ms:=app_private\.hermes_integer_v1\(p->'requestedTtlMs'\)/);
  assert.match(body, /IF v_ttl_ms>900000 THEN RAISE EXCEPTION/);
  assert.doesNotMatch(body, /targetExpiresAt|requestedExpiresAt|now\(\)|CURRENT_TIMESTAMP|statement_timestamp\(\)/i);
  const locks = ['FROM app_private.hermes_sessions WHERE id=v_credential FOR UPDATE',
    'FROM app_private.hermes_connections WHERE id=v_id FOR UPDATE',
    "FROM app_private.hermes_connection_tokens WHERE token_digest=p->>'tokenDigest' AND connection_id=c.id FOR UPDATE",
    'FROM app_private.hermes_assistants WHERE id=c.assistant_id FOR SHARE',
    'FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE'];
  let previous = -1;
  for (const lock of locks) { const position = body.indexOf(lock); assert(position > previous, `required lock order: ${lock}`); previous = position; }
  const clock = body.indexOf('v_now:=clock_timestamp()');
  assert(clock > previous, 'DB clock must be sampled after every lock wait');
  assert.equal((body.match(/clock_timestamp\(\)/g) ?? []).length, 1, 'one consistent live clock for this renewal');
  // No hard-age cap since 20261113131751 (owner decision 13/11/2026): a connection lives until revoked.
  assert.match(body, /v_target:=date_trunc\('milliseconds',LEAST\(v_now\+v_ttl_ms\*interval '1 millisecond',s\.expires_at\)\)/);
  assert.doesNotMatch(body, /interval '30 days'/);
  assert.match(body, /IF t\.created_at>v_now OR v_target<=v_now OR v_target<=t\.expires_at THEN RAISE EXCEPTION/);
  assert.match(body, /t\.expires_at<=v_now OR t\.expires_at<>v_expected/);
  // Other functions still test created_at+30 days, so renewal re-anchors created_at: only once it
  // is older than a day, and always into the past (readers compare it with their transaction time).
  assert.match(body, /UPDATE app_private\.hermes_connection_tokens SET expires_at=v_target, created_at=CASE WHEN created_at<v_now-interval '1 day' THEN v_now-interval '1 hour' ELSE created_at END WHERE token_digest=t\.token_digest/);
  assert.equal((body.match(/created_at\s*=/g) ?? []).length, 1, 'created_at changes only through the pinned re-anchor');
  assert.match(body, /RETURN jsonb_build_object\('ok',true,'status','renewed','expiresAt',floor\(extract\(epoch FROM v_target\)\*1000\)::bigint\)/);
}
function authorityContract(body) {
  assert.match(body, /hermes_member_v1\(c\.user_id,c\.organization_id\)/);
  assert.match(body, /hermes_validate_limits_v1\(c\.organization_id,c\.read_capabilities,c\.action_capabilities,c\.scope_ids\)/);
  for (const condition of ["s.state<>'ACTIVE'", 's.quarantine_reason IS NOT NULL', 's.expires_at<=v_now', 's.revision<>v_revision',
    "c.state<>'ACTIVE'", 'c.revoked_at IS NOT NULL', 'c.epoch<>v_epoch', 'c.credential_ref IS DISTINCT FROM s.id',
    'c.assistant_id<>s.assistant_id', 'c.organization_id<>s.organization_id', 'c.user_id<>s.user_id',
    't.revoked_at IS NOT NULL', "a.state<>'ACTIVE'", 'NOT policy.enabled',
    'NOT(c.read_capabilities<@policy.read_capabilities)', 'NOT(c.action_capabilities<@policy.action_capabilities)', 'NOT(c.scope_ids<@policy.scope_ids)']) {
    assert(body.includes(condition), `renewal must preserve ${condition}`);
  }
  assert.equal((body.match(/\bUPDATE\s+app_private\./g) ?? []).length, 1, 'one token UPDATE: its expiry and its age-window anchor');
  assert.doesNotMatch(body, /\bINSERT\b|\bDELETE\b|SET\s+(?:token_digest|created_at|credential_ref|read_capabilities|action_capabilities|scope_ids)\s*=|\bEXECUTE\s+/i);
  assert.match(body, /SECURITY DEFINER SET search_path=pg_catalog,public,app_private/);
}
test('renewal computes a canonical bounded lease after locks using DB time and CAS', () => leaseContract(current));
test('renewal preserves current ownership, policy, revocation and session state without minting authority', () => authorityContract(current));
function renewalAclContract(input = statements, name = 'app_private.hermes_store_renew_connection_v1') {
  const relevant = input.filter(sql => /^(?:ALTER FUNCTION|REVOKE|GRANT)/i.test(sql) && sql.toLowerCase().includes(`${name}(jsonb)`));
  assert(relevant.includes(`ALTER FUNCTION ${name}(jsonb) OWNER TO postgres`));
  assert(relevant.includes(`REVOKE ALL ON FUNCTION ${name}(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor`));
  const privileges = new Set(['PUBLIC']);
  for (const sql of relevant) {
    if (/^ALTER FUNCTION/i.test(sql)) {
      assert.equal(sql.toLowerCase(), `alter function ${name}(jsonb) owner to postgres`);
      continue;
    }
    const parsed = /^(GRANT EXECUTE|REVOKE ALL|REVOKE EXECUTE) ON FUNCTION (.+) (?:TO|FROM) ([a-z_, ]+)$/i.exec(sql);
    assert(parsed, 'renewal ACL must use explicit functions and roles');
    // Commas inside another function signature do not split its target.
    const targets = (parsed[2].match(/(?:app_private|public)\.\w+\([^)]*\)/gi) ?? []).map(target => target.replace(/\s+/g, '').toLowerCase());
    assert.equal(targets.join(','), parsed[2].replace(/\s+/g, '').toLowerCase(), 'unsupported ACL target syntax');
    if (!targets.includes(`${name}(jsonb)`)) continue;
    for (const role of parsed[3].split(',').map(value => value.trim() === 'PUBLIC' ? 'PUBLIC' : value.trim().toLowerCase())) {
      if (parsed[1].toUpperCase() === 'GRANT EXECUTE') {
        assert.equal(role, 'hermes_store_executor', 'API or other roles cannot receive renewal execute');
        privileges.add(role);
      } else privileges.delete(role);
    }
  }
  assert.deepEqual([...privileges], ['hermes_store_executor']);
}
test('renewal execute is granted only to the dedicated store principal, never an API role', () => renewalAclContract());

test('renewal ACL replay rejects grouped API grants and a later store revoke', () => {
  for (const sql of [`GRANT EXECUTE ON FUNCTION public.example_v1(jsonb,text),${name}(jsonb) TO authenticated`,
    `grant execute on function ${name}(jsonb) to authenticated`,
    `GRANT EXECUTE ON FUNCTION ${name}(jsonb),public.example_v1(jsonb,text) TO PUBLIC`,
    `REVOKE EXECUTE ON FUNCTION public.example_v1(jsonb,text),${name}(jsonb) FROM hermes_store_executor`]) {
    assert.throws(() => renewalAclContract([...statements, sql]));
  }
});

for (const [label, before, after, validate] of [
  ['unbounded duration', 'IF v_ttl_ms>900000 THEN', 'IF false THEN', leaseContract],
  ['transaction clock predates lock wait', 'v_now:=clock_timestamp()', 'v_now:=now()', leaseContract],
  ['host-selected target', "v_now+v_ttl_ms*interval '1 millisecond'", "to_timestamp((p->>'targetExpiresAt')::bigint/1000.0)", leaseContract],
  ['missing session expiry cap', "interval '1 millisecond',s.expires_at))", "interval '1 millisecond'))", leaseContract],
  ['hard-age cap restored', "interval '1 millisecond',s.expires_at))", "interval '1 millisecond',s.expires_at,t.created_at+interval '30 days'))", leaseContract],
  ['age anchor in the future', "THEN v_now-interval '1 hour'", "THEN v_now+interval '1 hour'", leaseContract],
  ['age anchor rewritten on every renewal', "CASE WHEN created_at<v_now-interval '1 day' THEN", 'CASE WHEN true THEN', leaseContract],
  ['second created_at write', 'WHERE token_digest=t.token_digest', 'WHERE token_digest=t.token_digest; UPDATE app_private.hermes_connection_tokens SET created_at=v_now WHERE token_digest=t.token_digest', leaseContract],
  ['noncanonical acknowledgement', "date_trunc('milliseconds',LEAST(", "date_trunc('second',LEAST(", leaseContract],
  ['lost expiry CAS', 't.expires_at<>v_expected', 'false', leaseContract],
  ['renewing expired token', 't.expires_at<=v_now', 'false', leaseContract],
  ['session fence skipped', 's.revision<>v_revision', 'false', authorityContract],
  ['connection fence skipped', 'c.epoch<>v_epoch', 'false', authorityContract],
  ['revoked token accepted', 't.revoked_at IS NOT NULL', 'false', authorityContract],
  ['membership bypass', 'PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id)', 'PERFORM 1', authorityContract],
  ['scope ceiling bypass', 'NOT(c.scope_ids<@policy.scope_ids)', 'false', authorityContract],
]) {
  test(`mutation rejected: ${label}`, () => {
    assert(current.includes(before), 'mutation must change latest source');
    assert.throws(() => validate(current.replace(before, after)));
  });
}
test('mutation rejected: DB clock sampled before the session lock', () => {
  const changed = current.replace('v_now:=clock_timestamp();', '').replace('SELECT * INTO s FROM', 'v_now:=clock_timestamp(); SELECT * INTO s FROM');
  assert.notEqual(changed, current); assert.throws(() => leaseContract(changed));
});

// Recovery (20261113131751). A lapsed lease used to be final, so every network outage longer than
// a few minutes cost the owner a new connection. The store principal may now revive it for five
// minutes, long enough for one provider refresh; nothing revives a lease that lapsed seven days ago.
const recoveryName = 'app_private.hermes_store_recover_connection_v1';
const recovery = statements.filter(sql => sql.startsWith(`CREATE OR REPLACE FUNCTION ${recoveryName}(p jsonb)`)).at(-1);
assert(recovery, 'latest recovery function must exist');

function recoveryContract(body) {
  assert.match(body, /RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private/);
  assert.match(body, /hermes_request_v1\(p,ARRAY\['tokenDigest'\]\)/);
  assert.match(body, /jsonb_typeof\(p->'tokenDigest'\) IS DISTINCT FROM 'string' OR \(p->>'tokenDigest'\) !~ '\^\[0-9a-f\]\{64\}\$'/);
  const locks = ['FROM app_private.hermes_sessions WHERE id=c.credential_ref FOR UPDATE',
    'FROM app_private.hermes_connections WHERE id=t.connection_id FOR UPDATE',
    "FROM app_private.hermes_connection_tokens WHERE token_digest=p->>'tokenDigest' AND connection_id=c.id FOR UPDATE",
    'FROM app_private.hermes_assistants WHERE id=c.assistant_id FOR SHARE',
    'FROM app_private.hermes_org_policies WHERE organization_id=c.organization_id FOR SHARE'];
  let previous = -1;
  for (const lock of locks) { const position = body.indexOf(lock); assert(position > previous, `required lock order: ${lock}`); previous = position; }
  const clock = body.indexOf('v_now:=clock_timestamp()');
  assert(clock > previous, 'DB clock must be sampled after every lock wait');
  assert.equal((body.match(/clock_timestamp\(\)/g) ?? []).length, 1, 'one consistent live clock for this recovery');
  assert.doesNotMatch(body, /\bnow\(\)|CURRENT_TIMESTAMP|statement_timestamp\(\)/i);
  // Live authority, judged as a renewal judges it; only an authority refusal becomes "unavailable".
  assert.match(body, /BEGIN PERFORM app_private\.hermes_member_v1\(c\.user_id,c\.organization_id\); PERFORM app_private\.hermes_validate_limits_v1\(c\.organization_id,c\.read_capabilities,c\.action_capabilities,c\.scope_ids\); EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value THEN RETURN c_unavailable; END;/);
  for (const condition of ["s.state NOT IN ('ACTIVE','RESERVED')", 's.quarantine_reason IS NOT NULL', "c.state<>'ACTIVE'", 'c.revoked_at IS NOT NULL',
    'c.credential_ref IS DISTINCT FROM s.id', 'c.assistant_id<>s.assistant_id', 'c.organization_id<>s.organization_id', 'c.user_id<>s.user_id',
    't.revoked_at IS NOT NULL', 't.created_at>v_now', "a.state<>'ACTIVE'", 'NOT policy.enabled',
    'NOT(c.read_capabilities<@policy.read_capabilities)', 'NOT(c.action_capabilities<@policy.action_capabilities)', 'NOT(c.scope_ids<@policy.scope_ids)',
    // Dead-man switch on both clocks: recovery itself moves the token expiry, only a published refresh moves the session's.
    "t.expires_at<=v_now-interval '7 days'", "s.expires_at<=v_now-interval '7 days'"]) {
    assert(body.includes(condition), `recovery must refuse when ${condition}`);
  }
  const guard = body.indexOf("t.expires_at<=v_now-interval '7 days' OR s.expires_at<=v_now-interval '7 days' THEN RETURN c_unavailable; END IF;"), write = body.indexOf('UPDATE app_private.');
  assert(guard > clock && write > guard, 'every refusal is judged after the clock and before the only write');
  assert.match(body, /c_unavailable CONSTANT jsonb:=jsonb_build_object\('status','unavailable'\);/);
  // "live" writes nothing; "recovered" grants exactly five minutes from the DB clock.
  assert.match(body, /v_ready:=s\.state='ACTIVE' AND s\.expires_at>v_now;/);
  assert.match(body, /IF t\.expires_at>v_now AND \(v_ready OR t\.expires_at>v_now\+interval '5 minutes'\) THEN v_status:='live'; v_expires:=t\.expires_at; ELSE v_status:='recovered'; v_expires:=date_trunc\('milliseconds',v_now\+interval '5 minutes'\); UPDATE/);
  assert.match(body, /UPDATE app_private\.hermes_connection_tokens SET expires_at=v_expires, created_at=CASE WHEN created_at<v_now-interval '1 day' THEN v_now-interval '1 hour' ELSE created_at END WHERE token_digest=t\.token_digest; END IF;/);
  assert.equal((body.match(/\bUPDATE\s+app_private\./g) ?? []).length, 1, 'recovery writes one token row and nothing else');
  assert.equal((body.match(/created_at\s*=/g) ?? []).length, 1, 'created_at changes only through the pinned re-anchor');
  // No credential material, no session mutation, no minting.
  assert.doesNotMatch(body, /\bINSERT\b|\bDELETE\b|\bEXECUTE\s+|envelope|hermes_session_json_v1|revision|WHEN OTHERS|SET\s+(?:token_digest|revoked_at|credential_ref|state)\s*=/i);
  assert.match(body, /RETURN jsonb_build_object\('status',v_status,'connectionId',c\.id,'credentialRef',s\.id, 'binding',jsonb_build_object\('assistantId',s\.assistant_id,'userId',s\.user_id,'organizationId',s\.organization_id,'sessionId',s\.provider_session_id\), 'sessionReady',v_ready,'sessionExpiresAt',floor\(extract\(epoch FROM s\.expires_at\)\*1000\)::bigint, 'expiresAt',floor\(extract\(epoch FROM v_expires\)\*1000\)::bigint\); END \$fn\$$/);
}
test('recovery revives a lapsed lease only within the dead-man window, after locks, with live authority', () => recoveryContract(recovery));
test('recovery execute is granted only to the dedicated store principal, never an API role', () => renewalAclContract(statements, recoveryName));
test('recovery ACL replay rejects an API grant', () => {
  for (const sql of [`GRANT EXECUTE ON FUNCTION ${recoveryName}(jsonb) TO authenticated`, `GRANT EXECUTE ON FUNCTION ${recoveryName}(jsonb) TO service_role`,
    `REVOKE EXECUTE ON FUNCTION ${recoveryName}(jsonb) FROM hermes_store_executor`]) {
    assert.throws(() => renewalAclContract([...statements, sql], recoveryName));
  }
});
for (const [label, before, after] of [
  ['token dead-man switch removed', "OR t.expires_at<=v_now-interval '7 days' OR s.expires_at", 'OR s.expires_at'],
  ['session dead-man switch removed', " OR s.expires_at<=v_now-interval '7 days' THEN", ' THEN'],
  ['longer token dead-man window', "t.expires_at<=v_now-interval '7 days'", "t.expires_at<=v_now-interval '70 days'"],
  ['longer session dead-man window', "s.expires_at<=v_now-interval '7 days'", "s.expires_at<=v_now-interval '70 days'"],
  ['quarantined session revived', 's.quarantine_reason IS NOT NULL', 'false'],
  ['ambiguous provider refresh revived', "s.state NOT IN ('ACTIVE','RESERVED')", "s.state NOT IN ('ACTIVE','RESERVED','DISPATCHED','STAGED')"],
  ['revoked token revived', 't.revoked_at IS NOT NULL', 'false'],
  ['revoked connection revived', 'c.revoked_at IS NOT NULL', 'false'],
  ['membership bypass', 'PERFORM app_private.hermes_member_v1(c.user_id,c.organization_id)', 'PERFORM 1'],
  ['company policy bypass', 'NOT policy.enabled', 'false'],
  ['swallowing every error as unavailable', 'WHEN insufficient_privilege OR invalid_parameter_value THEN', 'WHEN OTHERS THEN'],
  ['long recovery window', "v_expires:=date_trunc('milliseconds',v_now+interval '5 minutes')", "v_expires:=date_trunc('milliseconds',v_now+interval '5 days')"],
  ['host-selected expiry', "v_now+interval '5 minutes');", "to_timestamp((p->>'expiresAt')::bigint/1000.0));"],
  ['live lease rewritten', "IF t.expires_at>v_now AND (v_ready OR t.expires_at>v_now+interval '5 minutes') THEN", 'IF false THEN'],
  ['credential leaked', "'sessionReady',v_ready", "'sessionReady',v_ready,'envelope',s.envelope"],
  ['session mutated', 'WHERE token_digest=t.token_digest; END IF;', "WHERE token_digest=t.token_digest; UPDATE app_private.hermes_sessions SET state='ACTIVE' WHERE id=s.id; END IF;"],
]) {
  test(`recovery mutation rejected: ${label}`, () => {
    assert(recovery.includes(before), 'mutation must change latest source');
    assert.throws(() => recoveryContract(recovery.replace(before, after)));
  });
}
test('recovery mutation rejected: DB clock sampled before the locks', () => {
  const changed = recovery.replace('v_now:=clock_timestamp();', '').replace('SELECT * INTO t FROM', 'v_now:=clock_timestamp(); SELECT * INTO t FROM');
  assert.notEqual(changed, recovery); assert.throws(() => recoveryContract(changed));
});
