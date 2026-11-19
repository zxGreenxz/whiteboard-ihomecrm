import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';

// Hermes connection recovery (20261113131751), EXECUTED. app_private.hermes_store_recover_connection_v1 and the renewal
// body the same migration replaces run in an in-memory PostgreSQL (PGlite): no network, no real database, no file written.
//
// Shipped text, read from disk at test time and never copied into this file: both CREATE OR REPLACE FUNCTION statements with
// their OWNER/REVOKE/GRANT lines, and the three input validators from the migration that defines them. Stubs (STUBS below)
// stand only for what those statements do not define: bare tables, three authority helpers and four roles.
//
// NOT claimed by this file:
//  - Authorisation. No resolve, session-gate, read or write function is loaded, so "a live token next to an expired session
//    is refused everywhere" is not tested here.
//  - Concurrency. PGlite has one connection: lock order and the re-read guard `c.credential_ref IS DISTINCT FROM s.id` (a
//    connection re-pointed between the lock-free read and the locked one) cannot be staged. Static mismatches run instead.
//  - The migration's requires/check blocks (md5 pins, catalog shape) and the production table constraints.
//  - Sub-millisecond flooring of the recovered expiry: the PGlite clock ticks in whole milliseconds. The floor is observed
//    where the bound is a stored value carrying microseconds (sessionExpiresAt, a live expiresAt, a renewal capped by the
//    session).
// Every timestamp is the database clock plus or minus an interval, so nothing here ages.
const MIGRATION = '20261113131751_hermes_connection_recovery_v1.sql';
const VALIDATORS = '20261012062043_hermes_encrypted_session_store_v1.sql';
const RECOVER = 'hermes_store_recover_connection_v1', RENEW = 'hermes_store_renew_connection_v1';
const statementsOf = file => splitSqlStatements(readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n'))
  .map(statement => statement.replace(/^(?:\s*--[^\n]*\n)*\s*/, ''));
// Exact extractor: one complete dollar-quoted definition per signature, or this file does not load.
function definition(statements, file, signature) {
  const found = statements.filter(statement => statement.startsWith(`CREATE OR REPLACE FUNCTION app_private.${signature}\n`));
  assert.equal(found.length, 1, `${file}: expected exactly one CREATE OR REPLACE FUNCTION app_private.${signature}, found ${found.length}`);
  assert.match(found[0], /\nAS \$fn\$\n[\s\S]+\nEND\n\$fn\$$/, `${file}: app_private.${signature} is not one complete $fn$ body`);
  return found[0];
}
const shipped = statementsOf(MIGRATION), validators = statementsOf(VALIDATORS);
const SHIPPED = { renew: definition(shipped, MIGRATION, `${RENEW}(p jsonb)`), recover: definition(shipped, MIGRATION, `${RECOVER}(p jsonb)`) };
const VALIDATOR_SQL = ['hermes_request_v1(p jsonb,p_keys text[])', 'hermes_uuid_v1(p jsonb)', 'hermes_integer_v1(p jsonb)']
  .map(signature => definition(validators, VALIDATORS, signature));
const ACL = shipped.filter(statement => /^(?:ALTER FUNCTION|REVOKE|GRANT)\b/.test(statement) && /hermes_store_(?:renew|recover)_connection_v1\(jsonb\)/.test(statement));
for (const name of [RENEW, RECOVER]) {
  assert(ACL.includes(`GRANT EXECUTE ON FUNCTION app_private.${name}(jsonb) TO hermes_store_executor`), `${MIGRATION}: store grant for ${name} not found`);
}

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const [ORG, USER, ASSISTANT, SESSION, CONNECTION, PROVIDER_SESSION, SCOPE, OTHER] = Array.from({ length: 8 }, (_, n) => id(n + 1));
const DIGEST = 'a'.repeat(64), UNKNOWN_DIGEST = 'b'.repeat(64), STORE = 'hermes_store_executor';
// STUBS. Nothing below is defined by the migration under test.
//  - Roles: the four names its REVOKE/GRANT lines mention. All get USAGE on the schema, so a refusal is the function ACL.
//  - Tables: shipped names, column names and types, limited to the columns the two bodies read or write plus the session
//    envelope (to show it never leaves). No constraints, so each term of a predicate can be broken alone; production CHECKs
//    tie some of them together (RECONNECT_REQUIRED/REVOKED always carry a quarantine_reason, for instance).
//  - hermes_member_v1 / hermes_validate_limits_v1: same signatures and the same refusals the bodies react to (42501
//    hermes_membership_required, 22023 hermes_limits_invalid), decided from the arguments the body passes: the (user,
//    organization) pair must be a fixture member, every capability must be registered. fixture_faults makes either raise any
//    other SQLSTATE.
//  - hermes_effective_org_policy_v1: returns the stored policy row, as the shipped helper does when one exists. It is
//    declared SETOF so that a missing row yields NO row and the body's NOT FOUND guard runs; the shipped helper returns one
//    composite and synthesises an enabled policy instead, so "no row => unavailable" is that guard, not what an
//    organisation without a policy row gets in production.
const STUBS = `
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE hermes_store_executor;
CREATE SCHEMA app_private; GRANT USAGE ON SCHEMA app_private TO anon,authenticated,service_role,hermes_store_executor;
CREATE TABLE app_private.hermes_assistants(id uuid PRIMARY KEY,state text NOT NULL);
CREATE TABLE app_private.hermes_org_policies(organization_id uuid PRIMARY KEY,enabled boolean NOT NULL,version bigint NOT NULL DEFAULT 1,
  read_capabilities text[] NOT NULL DEFAULT '{}',action_capabilities text[] NOT NULL DEFAULT '{}',scope_ids uuid[] NOT NULL DEFAULT '{}');
CREATE TABLE app_private.hermes_sessions(id uuid PRIMARY KEY,assistant_id uuid NOT NULL,organization_id uuid NOT NULL,user_id uuid NOT NULL,
  provider_session_id uuid NOT NULL,state text NOT NULL,envelope jsonb,expires_at timestamptz NOT NULL,revision bigint NOT NULL DEFAULT 1,
  quarantine_reason text);
CREATE TABLE app_private.hermes_connections(id uuid PRIMARY KEY,assistant_id uuid NOT NULL,organization_id uuid NOT NULL,user_id uuid NOT NULL,
  state text NOT NULL,epoch bigint NOT NULL DEFAULT 1,read_capabilities text[] NOT NULL DEFAULT '{}',action_capabilities text[] NOT NULL DEFAULT '{}',
  scope_ids uuid[] NOT NULL DEFAULT '{}',credential_ref uuid,revoked_at timestamptz,permission_mode text NOT NULL DEFAULT 'legacy_allowlist');
CREATE TABLE app_private.hermes_connection_tokens(token_digest text PRIMARY KEY,connection_id uuid NOT NULL,expires_at timestamptz NOT NULL,
  revoked_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE app_private.fixture_members(user_id uuid,organization_id uuid,PRIMARY KEY(user_id,organization_id));
CREATE TABLE app_private.fixture_capabilities(capability text PRIMARY KEY);
CREATE TABLE app_private.fixture_faults(helper text PRIMARY KEY,sqlstate text NOT NULL);
CREATE FUNCTION app_private.hermes_member_v1(p_user uuid,p_org uuid) RETURNS jsonb LANGUAGE plpgsql AS $stub$
DECLARE v_fault text;
BEGIN
  SELECT sqlstate INTO v_fault FROM app_private.fixture_faults WHERE helper='member';
  IF FOUND THEN RAISE EXCEPTION 'fixture_member_fault' USING ERRCODE=v_fault; END IF;
  IF NOT EXISTS(SELECT 1 FROM app_private.fixture_members WHERE user_id=p_user AND organization_id=p_org) THEN
    RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  RETURN '{}'::jsonb;
END $stub$;
CREATE FUNCTION app_private.hermes_validate_limits_v1(p_org uuid,p_read text[],p_action text[],p_scopes uuid[]) RETURNS void LANGUAGE plpgsql AS $stub$
DECLARE v_fault text;
BEGIN
  SELECT sqlstate INTO v_fault FROM app_private.fixture_faults WHERE helper='limits';
  IF FOUND THEN RAISE EXCEPTION 'fixture_limits_fault' USING ERRCODE=v_fault; END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_read||p_action) k WHERE k NOT IN (SELECT capability FROM app_private.fixture_capabilities)) THEN
    RAISE EXCEPTION 'hermes_limits_invalid' USING ERRCODE='22023'; END IF;
END $stub$;
CREATE FUNCTION app_private.hermes_effective_org_policy_v1(p_org uuid,p_read text[],p_action text[],p_scope_ids uuid[])
RETURNS SETOF app_private.hermes_org_policies LANGUAGE sql STABLE AS
$stub$SELECT * FROM app_private.hermes_org_policies WHERE organization_id=p_org$stub$;
INSERT INTO app_private.hermes_assistants VALUES('${ASSISTANT}','ACTIVE');
INSERT INTO app_private.hermes_org_policies(organization_id,enabled,read_capabilities,scope_ids) VALUES('${ORG}',true,ARRAY['rooms.view'],ARRAY['${SCOPE}']::uuid[]);
INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at)
  VALUES('${SESSION}','${ASSISTANT}','${ORG}','${USER}','${PROVIDER_SESSION}','ACTIVE','{"ciphertext":"ENVELOPE-SENTINEL"}',clock_timestamp());
INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,read_capabilities,scope_ids,credential_ref)
  VALUES('${CONNECTION}','${ASSISTANT}','${ORG}','${USER}','ACTIVE',ARRAY['rooms.view'],ARRAY['${SCOPE}']::uuid[],'${SESSION}');
INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES('${DIGEST}','${CONNECTION}',clock_timestamp());
INSERT INTO app_private.fixture_members VALUES('${USER}','${ORG}');
INSERT INTO app_private.fixture_capabilities VALUES('rooms.view');`;

// The two functions given, then the migration's own OWNER/REVOKE/GRANT lines.
const install = (target, functions) => target.exec(`${functions.renew};\n${functions.recover};\n${ACL.join(';\n')};`);
let db, pristine;
before(async () => {
  db = new PGlite();
  await db.exec(STUBS); await db.exec(`${VALIDATOR_SQL.join(';\n')};`);
  // Stubs and validators only: every negative control restores this into its own database and loads a mutated copy there.
  pristine = await db.dumpDataDir('none');
  await install(db, SHIPPED);
});
after(() => db?.close());

// Every case starts from the same committed rows, states its own offsets from the database clock at that moment (floored to
// the millisecond, so an offset may add microseconds on purpose) and is rolled back: no case leaks into the next.
// Defaults: token expired an hour ago and 40 days old, session good for another half hour, nothing else wrong.
const NOW = "date_trunc('milliseconds',clock_timestamp())";
async function scenario(target, { token = "-interval '1 hour'", created = "-interval '40 days'", session = "+interval '30 minutes'", sql = '' }, run) {
  await target.exec('BEGIN');
  try {
    await target.exec(`UPDATE app_private.hermes_connection_tokens SET expires_at=${NOW}${token},created_at=${NOW}${created};
      UPDATE app_private.hermes_sessions SET expires_at=${NOW}${session};${sql}`);
    return await run();
  } finally { await target.exec('ROLLBACK'); }
}
// Always as the store role, which holds EXECUTE on the two functions and nothing on the tables. An error rolls back to the
// savepoint, exactly as the failed statement would be undone for the connector.
async function call(target, fn, payload, role = STORE) {
  await target.exec(`SAVEPOINT store_call; SET LOCAL ROLE ${role}`);
  try {
    const { rows: [row] } = await target.query(`SELECT app_private.${fn}($1::jsonb) AS result`, [payload === null ? null : JSON.stringify(payload)]);
    await target.exec('RESET ROLE; RELEASE SAVEPOINT store_call');
    return row.result;
  } catch (error) {
    await target.exec('ROLLBACK TO SAVEPOINT store_call; RELEASE SAVEPOINT store_call');
    throw error;
  }
}
const recover = (target, digest = DIGEST) => call(target, RECOVER, { tokenDigest: digest });
const JOINED = `app_private.hermes_connection_tokens t JOIN app_private.hermes_connections c ON c.id=t.connection_id
  JOIN app_private.hermes_sessions s ON s.id=c.credential_ref WHERE t.token_digest='${DIGEST}'`;
// The connector echoes what it was last told; here the compare-and-set inputs are read from the rows.
async function renew(target, changes = {}) {
  const { rows: [row] } = await target.query(`SELECT floor(extract(epoch FROM t.expires_at)*1000)::bigint::text AS expires,c.epoch::text AS epoch,
    s.revision::text AS revision FROM ${JOINED}`);
  return call(target, RENEW, { tokenDigest: DIGEST, connectionId: CONNECTION, expectedEpoch: Number(row.epoch), credentialRef: SESSION,
    expectedRevision: Number(row.revision), expectedExpiresAt: Number(row.expires), requestedTtlMs: 900000, ...changes });
}
// Exact arithmetic: microseconds since the epoch as BigInt, never a JavaScript Date.
const MINUTE = 60_000_000n, HOUR = 60n * MINUTE, floorMs = us => us / 1000n * 1000n;
const micros = expression => `(extract(epoch FROM ${expression})*1000000)::bigint::text`;
const clock = async target => BigInt((await target.query(`SELECT ${micros('clock_timestamp()')} AS us`)).rows[0].us);
async function times(target) {
  const { rows: [row] } = await target.query(`SELECT ${micros('t.expires_at')} AS token,${micros('t.created_at')} AS created,${micros('s.expires_at')} AS session FROM ${JOINED}`);
  return { token: BigInt(row.token), created: BigInt(row.created), session: BigInt(row.session) };
}
// The three tables as full row text: "unchanged" below means byte for byte.
async function rows(target) {
  return (await target.query(`SELECT (SELECT string_agg(t::text,E'\\n' ORDER BY t.token_digest) FROM app_private.hermes_connection_tokens t) AS tokens,
    (SELECT string_agg(s::text,E'\\n' ORDER BY s.id) FROM app_private.hermes_sessions s) AS sessions,
    (SELECT string_agg(c::text,E'\\n' ORDER BY c.id) FROM app_private.hermes_connections c) AS connections`)).rows[0];
}
// v_now, the single clock reading a call takes, lies between two readings of the same database clock taken around it.
async function timed(target, run) { const earliest = await clock(target), result = await run(), latest = await clock(target); return { earliest, result, latest }; }
function assertLease(seen, expires, length, label) {
  assert.equal(expires % 1000n, 0n, `${label}: stored at millisecond precision`);
  assert(floorMs(seen.earliest + length) <= expires && expires <= floorMs(seen.latest + length),
    `${label}: ${expires} is not the database clock [${seen.earliest}, ${seen.latest}] + ${length} microseconds`);
}
// The whole answer of a call that did not refuse. deepEqual against it admits no other key.
const answer = (status, sessionReady, at, credentialRef = SESSION, sessionId = PROVIDER_SESSION) => ({ status, connectionId: CONNECTION, credentialRef,
  binding: { assistantId: ASSISTANT, userId: USER, organizationId: ORG, sessionId },
  sessionReady, sessionExpiresAt: Number(at.session / 1000n), expiresAt: Number(at.token / 1000n) });
// One observation: the answer, or the SQLSTATE raised, and whether any token, session or connection row changed.
async function observe(target, arrangement, digest = DIGEST) {
  return scenario(target, arrangement, async () => {
    const earlier = await rows(target); let outcome;
    try { outcome = { result: await recover(target, digest) }; } catch (error) { if (!error.code) throw error; outcome = { raised: error.code }; }
    return { ...outcome, unchanged: isDeepStrictEqual(await rows(target), earlier) };
  });
}
const REFUSED = { result: { status: 'unavailable' }, unchanged: true };
const holds = async (target, { arrangement, expected }, digest) => assert.deepEqual(await observe(target, arrangement, digest), expected);
const raises = (sqlstate, message) => error => { assert.equal(error.code, sqlstate, error.message); if (message) assert.match(error.message, message); return true; };
const session = set => ({ sql: `UPDATE app_private.hermes_sessions SET ${set};` });
const connection = set => ({ sql: `UPDATE app_private.hermes_connections SET ${set};` });
const fault = (helper, sqlstate) => ({ sql: `INSERT INTO app_private.fixture_faults VALUES('${helper}','${sqlstate}');` });
// A second intact session and the connection re-pointed at it; `column`, when given, is the one binding column that differs.
const repointed = column => ({ sql: `INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at)
    SELECT '${OTHER}',assistant_id,organization_id,user_id,'${OTHER}',state,envelope,expires_at FROM app_private.hermes_sessions;
  ${column ? `UPDATE app_private.hermes_sessions SET ${column}='${OTHER}' WHERE id='${OTHER}';` : ''}
  UPDATE app_private.hermes_connections SET credential_ref='${OTHER}';` });
// The four checks the negative controls at the end re-run against a mutated copy of the recovery function.
const GUARDED = {
  tokenSevenDays: { arrangement: { token: "-interval '7 days 1 second'" }, expected: REFUSED },
  sessionSevenDays: { arrangement: { session: "-interval '7 days 1 second'" }, expected: REFUSED },
  quarantine: { arrangement: session("quarantine_reason='refresh_uncertain'"), expected: REFUSED },
  helperFault: { arrangement: fault('member', '55P03'), expected: { raised: '55P03', unchanged: true } },
};

test('expired token, expired session: recovered for five minutes, session reported not ready, only the token row written', async () => {
  await scenario(db, { session: "-interval '3 hours'+interval '789 microseconds'" }, async () => {
    const earlier = await rows(db), seen = await timed(db, () => recover(db)), at = await times(db), later = await rows(db);
    assert.deepEqual(seen.result, answer('recovered', false, at));
    assertLease(seen, at.token, 5n * MINUTE, 'recovered expiry');
    assert.equal(at.session % 1000n, 789n, 'the session expiry carries microseconds, so sessionExpiresAt above is its floor');
    const wire = JSON.stringify(seen.result);
    for (const material of [DIGEST, 'ENVELOPE-SENTINEL', 'ciphertext', 'envelope', 'tokenDigest']) assert(!wire.includes(material), `the answer carries ${material}`);
    assert.equal(later.sessions, earlier.sessions); assert.equal(later.connections, earlier.connections);
    assert.notEqual(later.tokens, earlier.tokens);
  });
});

test('a second call right away, session still not ready: recovered again with a full five minutes', async () => {
  await scenario(db, { session: "-interval '3 hours'" }, async () => {
    assert.equal((await recover(db)).status, 'recovered');
    const first = await times(db), seen = await timed(db, () => recover(db)), second = await times(db);
    assert.deepEqual(seen.result, answer('recovered', false, second));
    assertLease(seen, second.token, 5n * MINUTE, 'second recovered expiry');
    assert(second.token >= first.token, 'the window slides forward, never back');
    assert.equal(second.created, first.created, 'created_at was re-anchored by the first call and is now younger than a day');
  });
});

test('live token, session ready: live, and no row changes', async t => {
  for (const [label, token] of [['ten minutes left', "+interval '10 minutes'+interval '789 microseconds'"], ['two minutes left', "+interval '2 minutes'+interval '789 microseconds'"]]) {
    await t.test(label, () => scenario(db, { token }, async () => {
      const earlier = await rows(db), result = await recover(db), at = await times(db);
      assert.deepEqual(result, answer('live', true, at));
      assert.equal(at.token % 1000n, 789n, 'expiresAt above is the floor of an expiry that was left as it was');
      assert.deepEqual(await rows(db), earlier);
    }));
  }
});

test('live token, session not ready: more than five minutes left stays live and unchanged; less is topped up to five minutes', async t => {
  await t.test('six minutes left: live, unchanged', () => scenario(db, { token: "+interval '6 minutes'", session: "-interval '3 hours'" }, async () => {
    const earlier = await rows(db), result = await recover(db);
    assert.deepEqual(result, answer('live', false, await times(db)));
    assert.deepEqual(await rows(db), earlier);
  }));
  await t.test('four minutes left: recovered', () => scenario(db, { token: "+interval '4 minutes'", session: "-interval '3 hours'" }, async () => {
    const seen = await timed(db, () => recover(db)), at = await times(db);
    assert.deepEqual(seen.result, answer('recovered', false, at));
    assertLease(seen, at.token, 5n * MINUTE, 'topped-up expiry');
  }));
});

test('seven-day switch on the token expiry: just under is recovered, just over is unavailable and unchanged', async t => {
  await t.test('expired seven days less a minute ago: recovered', async () => {
    const seen = await observe(db, { token: "-interval '7 days'+interval '1 minute'" });
    assert.equal(seen.result?.status, 'recovered'); assert.equal(seen.result.sessionReady, true); assert.equal(seen.unchanged, false);
  });
  await t.test('expired seven days and a second ago: unavailable', () => holds(db, GUARDED.tokenSevenDays));
});

test('seven-day switch on the session expiry, with the token expired only an hour ago', async t => {
  await t.test('session expired seven days and a second ago: unavailable', () => holds(db, GUARDED.sessionSevenDays));
  await t.test('session expired seven days less a minute ago: recovered, not ready', async () => {
    const seen = await observe(db, { session: "-interval '7 days'+interval '1 minute'" });
    assert.equal(seen.result?.status, 'recovered'); assert.equal(seen.result.sessionReady, false); assert.equal(seen.unchanged, false);
  });
  // Recovery moves the token expiry and never the session's, so a token kept alive by earlier recoveries does not help.
  await t.test('session expired over seven days ago while the token is still live: unavailable', () =>
    holds(db, { arrangement: { token: "+interval '4 minutes'", session: "-interval '7 days 1 second'" }, expected: REFUSED }));
});

test('refusals answer exactly {"status":"unavailable"} and change no row', async t => {
  await t.test('control: the same rows with nothing wrong are recovered', async () => {
    const seen = await observe(db, {});
    assert.equal(seen.result?.status, 'recovered'); assert.equal(seen.result.sessionReady, true); assert.equal(seen.unchanged, false);
  });
  for (const [label, arrangement, digest] of [
    ['token revoked', { sql: 'UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp();' }],
    ['token created_at in the future', { created: "+interval '1 minute'" }],
    ['connection revoked (revoked_at set, state still ACTIVE)', connection('revoked_at=clock_timestamp()')],
    ['connection state REVOKED', connection("state='REVOKED'")],
    ['connection state PENDING', connection("state='PENDING'")],
    ['session RECONNECT_REQUIRED', session("state='RECONNECT_REQUIRED'")],
    ['session REVOKED', session("state='REVOKED'")],
    ['session DISPATCHED', session("state='DISPATCHED'")],
    ['session STAGED', session("state='STAGED'")],
    ['session quarantined (state still ACTIVE)', GUARDED.quarantine.arrangement],
    ['assistant not ACTIVE', { sql: "UPDATE app_private.hermes_assistants SET state='DISABLED';" }],
    ['assistant row gone', { sql: 'DELETE FROM app_private.hermes_assistants;' }],
    ['company policy disabled', { sql: 'UPDATE app_private.hermes_org_policies SET enabled=false;' }],
    ['company policy narrower than a legacy_allowlist connection (capability)', { sql: "UPDATE app_private.hermes_org_policies SET read_capabilities='{}';" }],
    ['company policy narrower than a legacy_allowlist connection (scope)', { sql: "UPDATE app_private.hermes_org_policies SET scope_ids='{}';" }],
    ['policy helper returns no row', { sql: 'DELETE FROM app_private.hermes_org_policies;' }],
    ['membership refused (42501 from the helper)', { sql: 'DELETE FROM app_private.fixture_members;' }],
    ['limits refused (22023 from the helper)', { sql: 'DELETE FROM app_private.fixture_capabilities;' }],
    ['membership helper raises 22023', fault('member', '22023')],
    ['limits helper raises 42501', fault('limits', '42501')],
    ['unknown digest', {}, UNKNOWN_DIGEST],
    // credential_ref mismatch between connection and session, in the three shapes one connection can stage.
    ['connection without a credential_ref', connection('credential_ref=NULL')],
    ['connection credential_ref names no session', connection(`credential_ref='${OTHER}'`)],
    ['connection credential_ref names a session of another assistant', repointed('assistant_id')],
    ['connection credential_ref names a session of another organization', repointed('organization_id')],
    ['connection credential_ref names a session of another user', repointed('user_id')],
  ]) await t.test(label, () => holds(db, { arrangement, expected: REFUSED }, digest));
  await t.test('control: re-pointed at an intact session of the same binding it is recovered, so the three above are the binding', () =>
    scenario(db, repointed(), async () => assert.deepEqual(await recover(db), answer('recovered', true, await times(db), OTHER, OTHER))));
  await t.test('control: the narrower policy does not bind an inherit_crm connection', () =>
    scenario(db, { sql: "UPDATE app_private.hermes_org_policies SET read_capabilities='{}',scope_ids='{}'; UPDATE app_private.hermes_connections SET permission_mode='inherit_crm';" },
      async () => assert.equal((await recover(db)).status, 'recovered')));
});

test('session RESERVED (a refresh admitted, never dispatched): recovered, and not ready although its expiry is ahead', async () => {
  await scenario(db, session("state='RESERVED'"), async () => assert.deepEqual(await recover(db), answer('recovered', false, await times(db))));
  await scenario(db, { token: "+interval '6 minutes'", ...session("state='RESERVED'") }, async () => assert.deepEqual(await recover(db), answer('live', false, await times(db))));
});

test('created_at: older than a day moves to exactly one hour before the clock the call used; younger is untouched; never the future', async t => {
  for (const created of ["-interval '1 day 1 minute'", "-interval '400 days'"]) {
    await t.test(`created_at = now ${created}: re-anchored`, () => scenario(db, { created }, async () => {
      const seen = await timed(db, () => recover(db)), at = await times(db), sampled = at.created + HOUR;
      assert.equal(seen.result.status, 'recovered');
      assert(seen.earliest <= sampled && sampled <= seen.latest, `created_at + 1 hour = ${sampled} is not a reading of the clock within [${seen.earliest}, ${seen.latest}]`);
      assert.equal(at.token, floorMs(sampled + 5n * MINUTE), 'the same reading gave the expiry: created_at is exactly one hour before it');
      assert(at.created < seen.latest, 'never in the future');
    }));
  }
  for (const created of ["-interval '1 day'+interval '1 minute'", "-interval '1 second'"]) {
    await t.test(`created_at = now ${created}: untouched`, () => scenario(db, { created }, async () => {
      const earlier = await times(db);
      assert.equal((await recover(db)).status, 'recovered');
      const later = await times(db);
      assert.equal(later.created, earlier.created); assert.notEqual(later.token, earlier.token);
    }));
  }
});

test('malformed input raises SQLSTATE 22023', async () => {
  await scenario(db, {}, async () => {
    const earlier = await rows(db);
    for (const [label, payload, message] of [
      ['extra key', { tokenDigest: DIGEST, connectionId: CONNECTION }, /hermes_request_invalid/],
      ['missing key', {}, /hermes_request_invalid/],
      ['another key', { digest: DIGEST }, /hermes_request_invalid/],
      ['not an object', [DIGEST], /hermes_request_invalid/],
      ['SQL NULL', null, /hermes_request_invalid/],
      ['digest is a number', { tokenDigest: 7 }, /hermes_token_invalid/],
      ['digest is null', { tokenDigest: null }, /hermes_token_invalid/],
      ['digest is an array', { tokenDigest: [DIGEST] }, /hermes_token_invalid/],
      ['digest of 63 characters', { tokenDigest: DIGEST.slice(1) }, /hermes_token_invalid/],
      ['digest of 65 characters', { tokenDigest: `${DIGEST}a` }, /hermes_token_invalid/],
      ['digest in upper case', { tokenDigest: DIGEST.toUpperCase() }, /hermes_token_invalid/],
      ['digest outside hex', { tokenDigest: 'g'.repeat(64) }, /hermes_token_invalid/],
      ['digest with a trailing newline', { tokenDigest: `${DIGEST}\n` }, /hermes_token_invalid/],
    ]) await assert.rejects(call(db, RECOVER, payload), raises('22023', message), label);
    assert.deepEqual(await rows(db), earlier);
  });
});

test('a helper error that is neither 42501 nor 22023 propagates instead of becoming "unavailable"', async t => {
  await t.test('membership helper raises 55P03 (lock_not_available)', () => holds(db, GUARDED.helperFault));
  await t.test('limits helper raises 40001 (serialization_failure)', () => holds(db, { arrangement: fault('limits', '40001'), expected: { raised: '40001', unchanged: true } }));
  await t.test('limits helper raises P0001 (a bare RAISE)', () => holds(db, { arrangement: fault('limits', 'P0001'), expected: { raised: 'P0001', unchanged: true } }));
});

test('only the store role may execute either function; it reaches the tables through them alone', async () => {
  await scenario(db, {}, async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const fn of [RECOVER, RENEW]) await assert.rejects(call(db, fn, { tokenDigest: DIGEST }, role), raises('42501', /permission denied for function/), `${role} ${fn}`);
    }
    await db.exec(`SAVEPOINT direct; SET LOCAL ROLE ${STORE}`);
    await assert.rejects(db.query('SELECT 1 FROM app_private.hermes_connection_tokens'), raises('42501', /permission denied for table/));
    await db.exec('ROLLBACK TO SAVEPOINT direct; RELEASE SAVEPOINT direct');
    assert.equal((await recover(db)).status, 'recovered');
  });
});

test('renewal: a token far older than thirty days renews to the database clock + the requested TTL; created_at is re-anchored', async () => {
  await scenario(db, { token: "+interval '1 minute'", created: "-interval '400 days'" }, async () => {
    const earlier = await rows(db), seen = await timed(db, () => renew(db, { requestedTtlMs: 600000 })), at = await times(db), later = await rows(db);
    assert.deepEqual(seen.result, { ok: true, status: 'renewed', expiresAt: Number(at.token / 1000n) });
    assertLease(seen, at.token, 10n * MINUTE, 'renewed expiry');
    const sampled = at.created + HOUR;
    assert(seen.earliest <= sampled && sampled <= seen.latest, `created_at + 1 hour = ${sampled} is not a reading of the clock within [${seen.earliest}, ${seen.latest}]`);
    assert.equal(at.token, floorMs(sampled + 10n * MINUTE));
    assert.equal(later.sessions, earlier.sessions); assert.equal(later.connections, earlier.connections);
  });
});

test('renewal: the session expiry bounds the new lease, floored to the millisecond and never past the session', async () => {
  await scenario(db, { token: "+interval '1 minute'", created: "-interval '400 days'", session: "+interval '4 minutes'+interval '789 microseconds'" }, async () => {
    const seen = await timed(db, () => renew(db)), at = await times(db); // asks for the full 900000 ms
    assert.deepEqual(seen.result, { ok: true, status: 'renewed', expiresAt: Number(at.token / 1000n) });
    assert.equal(at.session - at.token, 789n);
    const sampled = at.created + HOUR;
    assert(seen.earliest <= sampled && sampled <= seen.latest, 'created_at is re-anchored here too');
  });
});

test('renewal: a token younger than a day keeps its created_at', async () => {
  await scenario(db, { token: "+interval '1 minute'", created: "-interval '23 hours'" }, async () => {
    const earlier = await times(db), seen = await timed(db, () => renew(db)), later = await times(db);
    assert.equal(seen.result.status, 'renewed');
    assertLease(seen, later.token, 15n * MINUTE, 'renewed expiry');
    assert.equal(later.created, earlier.created);
  });
});

test('renewal: an expired token is still refused with SQLSTATE 40001, and a TTL above 900000 ms with 22023', async t => {
  for (const token of ["-interval '1 second'", "-interval '1 hour'"]) {
    await t.test(`token expired (now ${token}): 40001`, () => scenario(db, { token }, async () => {
      const earlier = await rows(db);
      await assert.rejects(renew(db), raises('40001', /hermes_context_changed/));
      assert.deepEqual(await rows(db), earlier);
    }));
  }
  await t.test('requestedTtlMs 900001: 22023', () => scenario(db, { token: "+interval '1 minute'" }, async () => {
    const earlier = await rows(db);
    await assert.rejects(renew(db, { requestedTtlMs: 900001 }), raises('22023', /hermes_lease_invalid/));
    assert.deepEqual(await rows(db), earlier);
  }));
});

test('after "recovered" with the session still expired: a live token sits next to an expired session', async () => {
  // This is the five-minute state the migration header calls safe because every authorisation path wants a live session next
  // to a live token. That claim is NOT tested here: no authorisation function is loaded in this fixture. This only shows that
  // the state exists, and that the one other function loaded here, renewal, refuses in it.
  await scenario(db, { session: "-interval '3 hours'" }, async () => {
    assert.equal((await recover(db)).status, 'recovered');
    const { rows: [state] } = await db.query(`SELECT t.expires_at>clock_timestamp() AS token_live,t.revoked_at IS NULL AS token_unrevoked,
      s.state AS session_state,s.expires_at<=clock_timestamp() AS session_expired FROM ${JOINED}`);
    assert.deepEqual(state, { token_live: true, token_unrevoked: true, session_state: 'ACTIVE', session_expired: true });
    await assert.rejects(renew(db), raises('40001', /hermes_context_changed/));
  });
});

// Negative controls. Each edits an in-memory copy of the extracted recovery statement (the migration file is never touched),
// loads it into a database of its own (the stubs-only snapshot restored into a new PGlite) and re-runs one check of the suite
// above. The check must fail there, with the wrong answer named, while the plain case still recovers: the suite would catch
// that edit, and for that reason alone.
function mutate(sql, search, replacement) {
  const count = sql.split(search).length - 1;
  assert.equal(count, 1, `mutation target must occur exactly once in the shipped recovery function, found ${count}: ${search}`);
  return sql.replace(search, () => replacement);
}
for (const [label, search, replacement, guarded, wrong] of [
  ['token seven-day term removed', "OR t.expires_at<=v_now-interval '7 days' ", '', GUARDED.tokenSevenDays, 'recovered'],
  ['session seven-day term removed', " OR s.expires_at<=v_now-interval '7 days'", '', GUARDED.sessionSevenDays, 'recovered'],
  ['quarantine term replaced with false', 's.quarantine_reason IS NOT NULL', 'false', GUARDED.quarantine, 'recovered'],
  ['exception filter widened to WHEN OTHERS', 'EXCEPTION WHEN insufficient_privilege OR invalid_parameter_value THEN', 'EXCEPTION WHEN OTHERS THEN', GUARDED.helperFault, 'unavailable'],
]) {
  test(`negative control: ${label}`, async t => {
    const mutant = new PGlite({ loadDataDir: pristine }); t.after(() => mutant.close());
    const { rows: [fresh] } = await mutant.query(`SELECT to_regprocedure('app_private.${RECOVER}(jsonb)') IS NULL AS empty`);
    assert.equal(fresh.empty, true, 'a database of its own: the shipped function was never in it');
    await install(mutant, { ...SHIPPED, recover: mutate(SHIPPED.recover, search, replacement) });
    assert.equal((await observe(mutant, {})).result?.status, 'recovered', 'the mutant still recovers the plain case');
    const seen = await observe(mutant, guarded.arrangement);
    assert.equal(seen.result?.status, wrong, `the mutant gives the wrong answer: ${JSON.stringify(seen)}`);
    await assert.rejects(holds(mutant, guarded), assert.AssertionError);
  });
}
