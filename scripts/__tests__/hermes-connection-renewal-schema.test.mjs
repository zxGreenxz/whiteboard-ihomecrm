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
  assert.match(body, /v_target:=date_trunc\('milliseconds',LEAST\(v_now\+v_ttl_ms\*interval '1 millisecond',s\.expires_at,t\.created_at\+interval '30 days'\)\)/);
  assert.match(body, /IF t\.created_at>v_now OR v_target<=v_now OR v_target<=t\.expires_at THEN RAISE EXCEPTION/);
  assert.match(body, /t\.expires_at<=v_now OR t\.expires_at<>v_expected/);
  assert.match(body, /UPDATE app_private\.hermes_connection_tokens SET expires_at=v_target WHERE token_digest=t\.token_digest/);
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
  assert.equal((body.match(/\bUPDATE\s+app_private\./g) ?? []).length, 1, 'only token expiry may change');
  assert.doesNotMatch(body, /\bINSERT\b|\bDELETE\b|SET\s+(?:token_digest|created_at|credential_ref|read_capabilities|action_capabilities|scope_ids)\s*=|\bEXECUTE\s+/i);
  assert.match(body, /SECURITY DEFINER SET search_path=pg_catalog,public,app_private/);
}
test('renewal computes a canonical bounded lease after locks using DB time and CAS', () => leaseContract(current));
test('renewal preserves current ownership, policy, revocation and session state without minting authority', () => authorityContract(current));
test('renewal execute is granted only to the dedicated store principal, never an API role', () => {
  const relevant = statements.filter(sql => /^(?:ALTER FUNCTION|REVOKE|GRANT)/.test(sql) && sql.includes(`${name}(jsonb)`));
  assert(relevant.includes(`ALTER FUNCTION ${name}(jsonb) OWNER TO postgres`));
  assert(relevant.includes(`REVOKE ALL ON FUNCTION ${name}(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor`));
  assert.equal(relevant.at(-1), `GRANT EXECUTE ON FUNCTION ${name}(jsonb) TO hermes_store_executor`);
});

for (const [label, before, after, validate] of [
  ['unbounded duration', 'IF v_ttl_ms>900000 THEN', 'IF false THEN', leaseContract],
  ['transaction clock predates lock wait', 'v_now:=clock_timestamp()', 'v_now:=now()', leaseContract],
  ['host-selected target', "v_now+v_ttl_ms*interval '1 millisecond'", "to_timestamp((p->>'targetExpiresAt')::bigint/1000.0)", leaseContract],
  ['missing session expiry cap', ',s.expires_at,t.created_at', ',t.created_at', leaseContract],
  ['resetting hard token age', "t.created_at+interval '30 days'", "v_now+interval '30 days'", leaseContract],
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
