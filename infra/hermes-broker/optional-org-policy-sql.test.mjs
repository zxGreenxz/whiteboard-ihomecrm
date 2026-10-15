import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';
import { setupGroupSendSql } from '../hermes-zalo-router/group-send-sql-fixture.mjs';
import { ORG, USER, SESSION, CONNECTION, FOREIGN, INSTANCE, ACCOUNT, GENERATION, id } from '../hermes-zalo-router/private-command-fixture.mjs';

const migration = name => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const sql = migration('20261014000503_hermes_optional_org_policy_v1');
const functions = splitSqlStatements(sql).filter(s => /CREATE OR REPLACE FUNCTION/.test(s));
const code = value => error => error.code === value;

// Actual forward functions and their foundation/queue dependencies. CRM resolver
// and crypto extension ports are synthetic; this is not real JWT/RLS/MVCC proof.
test('optional organization ceiling preserves live CRM and connection authority across actual SQL entry points', async t => {
  const x = await setupGroupSendSql(t), { f, SCOPE } = x, db = f.db;
  await db.exec(`
    ALTER TABLE public.areas ADD COLUMN name text;
    CREATE SCHEMA extensions;
    CREATE FUNCTION extensions.digest(value text,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$SELECT sha256(convert_to(value,'UTF8'))$$;
    CREATE FUNCTION extensions.gen_random_bytes(size integer) RETURNS bytea LANGUAGE sql VOLATILE AS $$SELECT sha256(convert_to(gen_random_uuid()::text,'UTF8'))$$;
    CREATE TABLE public.fixture_admin(offboarded boolean,admin boolean); INSERT INTO public.fixture_admin VALUES(false,true);
    CREATE TABLE public.role_bindings(membership_id uuid,organization_id uuid,valid_from timestamptz,valid_to timestamptz);
    CREATE TABLE public.member_permission_overrides(membership_id uuid,organization_id uuid,revoked_at timestamptz,expires_at timestamptz);
    CREATE TABLE public.fixture_audit(event text);
    CREATE FUNCTION app_private.is_actor_offboarded_v1() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT offboarded FROM public.fixture_admin$$;
    CREATE FUNCTION app_private.scope_label_v1(s uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT 'Synthetic scope'::text$$;
    CREATE FUNCTION app_private.require_perm_v1(o uuid,p text,label text) RETURNS void LANGUAGE plpgsql AS $$BEGIN
      IF o<>'${ORG}' OR p<>'users.edit' OR NOT (SELECT admin FROM public.fixture_admin) THEN RAISE EXCEPTION 'denied' USING ERRCODE='42501'; END IF; END$$;
    CREATE FUNCTION app_private.append_authz_audit_v1(o uuid,e text,k text,item uuid,old_value jsonb,new_value jsonb,reason text) RETURNS void LANGUAGE sql AS $$INSERT INTO public.fixture_audit VALUES(e)$$;
  `);
  await db.exec(migration('20261012074002_hermes_envelope_length_guard_v1'));
  await db.exec(migration('20261013095000_hermes_zalo_private_reply_v1'));
  await db.exec(migration('20261013164116_hermes_group_capability_options_v2'));
  const setter = splitSqlStatements(migration('20261012165809_hermes_public_conflict_http_v1')).find(s => s.includes('CREATE OR REPLACE FUNCTION public.hermes_set_org_policy_v1('));
  await db.exec(setter);
  const catalog = () => db.query(`SELECT n.nspname,p.proname,p.prosrc,p.provolatile,p.proowner,p.proacl,p.proconfig FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proname LIKE 'hermes_%' ORDER BY n.nspname,p.proname,p.oid`);
  await db.exec(sql); const first = await catalog(); await db.exec(sql); assert.deepEqual(await catalog(), first);
  // Start every scenario with no organization policy; this is the behavior under
  // test, not a seed of a broad policy or a CRM permission grant.
  await db.exec('DELETE FROM app_private.hermes_org_policies');
  const snapshot = () => db.query(`SELECT (SELECT jsonb_agg(p) FROM app_private.hermes_org_policies p) policies,
    (SELECT jsonb_agg(c) FROM app_private.hermes_capabilities c) registry,
    (SELECT jsonb_agg(m) FROM organization_memberships m) memberships`);
  async function userRpc(name, args = [ORG]) {
    await db.exec('SAVEPOINT user_rpc; SET LOCAL ROLE authenticated');
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.session',$2,true)", [USER, SESSION]);
    try { return (await db.query(`SELECT public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) AS value`, args)).rows[0].value; }
    finally { await db.exec('ROLLBACK TO SAVEPOINT user_rpc; RELEASE SAVEPOINT user_rpc; RESET ROLE'); }
  }
  const scenario = (name, work) => t.test(name, () => f.rollbackCase(work));
  const storeRead = () => f.rpc('app_private.hermes_store_read_connection_v1', { tokenDigest: x.baseline.tokenDigest });
  const effective = async () => (await db.query('SELECT to_jsonb(app_private.hermes_effective_org_policy_v1($1,$2,$3,$4)) AS value', [ORG, ['rooms.view', 'chat_zalo.view'], ['chat_zalo.send'], [SCOPE]])).rows[0].value;
  const explicit = (enabled = true, read = ['rooms.view', 'chat_zalo.view'], action = ['chat_zalo.send'], scopes = [SCOPE]) => db.query(`INSERT INTO app_private.hermes_org_policies(organization_id,enabled,read_capabilities,action_capabilities,scope_ids,updated_by)
    VALUES($1,$2,$3,$4,$5,$6)`, [ORG, enabled, read, action, scopes, USER]);
  const roomMap = version => userRpc('hermes_room_scope_map_v1', [ORG, [SCOPE], CONNECTION, x.baseline.tokenDigest, 1, version, USER, 1, 1]);
  const neutralRequest = async () => {
    const base = { ...x.baseline, expectedPolicyVersion: 0 };
    const directory = await f.rpc('public.hermes_group_directory_v1', base, 'authenticated');
    return { ...base, roomIds: [x.ROOM], conversationIds: [x.GROUP], expectedContextVersion: directory.authority.contextVersion,
      intentDigest: 'c'.repeat(64), roomReadDigest: 'd'.repeat(64) };
  };

  await scenario('neutral options/context/read/session/room/group paths need no organization policy row', async () => {
    const before = await snapshot(), policy = await effective();
    assert.equal(policy.version, 0); assert.equal(policy.enabled, true); assert.deepEqual(policy.scope_ids, [SCOPE]);
    const options = await userRpc('hermes_connection_options_v2');
    assert.equal(options.policyVersion, 0); assert.equal(options.enabled, true);
    assert.deepEqual(options.read, ['assistant.context.read', 'rooms.view', 'chat_zalo.view']); assert.deepEqual(options.action, ['chat_zalo.send']);
    const admin = await userRpc('hermes_org_policy_options_v2'); assert.equal(admin.policy.version, 0); assert.equal(admin.policy.enabled, true);
    const context = await userRpc('hermes_connection_context_v2', [CONNECTION]);
    assert.equal(context.policyVersion, 0); assert.deepEqual(context.effective, { read: ['rooms.view', 'chat_zalo.view'], action: ['chat_zalo.send'] });
    assert.equal((await storeRead()).policy.version, 0);
    assert.equal((await db.query('SELECT app_private.hermes_session_gate_v1(s) allowed FROM app_private.hermes_sessions s')).rows[0].allowed, true);
    assert.equal((await roomMap(0)).binding.policyVersion, 0);
    const directory = await f.rpc('public.hermes_group_directory_v1', { ...x.baseline, expectedPolicyVersion: 0 }, 'authenticated');
    assert.equal(directory.authority.binding.policyVersion, 0);
    assert.equal((await db.query('SELECT (app_private.hermes_private_command_connection_v1($1)).id AS id', [x.baseline.tokenDigest])).rows[0].id, CONNECTION);
    assert.equal((await db.query('SELECT (app_private.hermes_zalo_context_v1($1,$2,$3,$4)).id AS id', [CONNECTION, USER, ORG, 1])).rows[0].id, CONNECTION);
    assert.deepEqual(await snapshot(), before);
  });
  await scenario('explicit disabled policy remains disabled in every public/store path', async () => {
    await explicit(false);
    const options = await userRpc('hermes_connection_options_v2'); assert.equal(options.enabled, false); assert.deepEqual(options.read, []); assert.deepEqual(options.action, []);
    assert.equal((await storeRead()).status, 'unavailable');
    assert.equal((await db.query('SELECT app_private.hermes_session_gate_v1(s) allowed FROM app_private.hermes_sessions s')).rows[0].allowed, false);
    await assert.rejects(userRpc('hermes_connection_context_v2', [CONNECTION]), code('42501'));
    await assert.rejects(roomMap(1), code('42501'));
    await assert.rejects(f.rpc('public.hermes_group_directory_v1', { ...x.baseline, expectedPolicyVersion: 1 }, 'authenticated'), code('42501'));
  });
  await scenario('explicit narrow read/action/scope ceilings remain exact; empty is never neutral', async () => {
    await explicit(true, ['chat_zalo.view'], [], []); const policy = await effective();
    assert.equal(policy.version, 1); assert.deepEqual(policy.read_capabilities, ['chat_zalo.view']); assert.deepEqual(policy.action_capabilities, []); assert.deepEqual(policy.scope_ids, []);
    const options = await userRpc('hermes_connection_options_v2'); assert.deepEqual(options.read, ['chat_zalo.view']); assert.deepEqual(options.action, []); assert.deepEqual(options.scopes, []);
    assert.deepEqual((await userRpc('hermes_connection_context_v2', [CONNECTION])).effective, { read: ['chat_zalo.view'], action: [] });
    await assert.rejects(roomMap(1), code('42501'));
  });
  await scenario('neutral is bounded by registry, current user rights and connection opt-out independently', async () => {
    await db.exec("UPDATE public.fixture_authority SET rooms=false,send_zalo=false");
    let options = await userRpc('hermes_connection_options_v2'); assert.deepEqual(options.read, ['assistant.context.read', 'chat_zalo.view']); assert.deepEqual(options.action, []); assert.deepEqual(options.scopes, []);
    await assert.rejects(roomMap(0), code('42501'));
    await db.exec("UPDATE public.fixture_authority SET rooms=true,send_zalo=true; UPDATE app_private.hermes_connections SET action_capabilities='{}',read_capabilities=ARRAY['rooms.view']");
    assert.deepEqual((await userRpc('hermes_connection_context_v2', [CONNECTION])).effective, { read: ['rooms.view'], action: [] });
    await db.exec("UPDATE app_private.hermes_capabilities SET enabled=false WHERE capability IN ('rooms.view','chat_zalo.send')");
    options = await userRpc('hermes_connection_options_v2'); assert.deepEqual(options.read, ['assistant.context.read', 'chat_zalo.view']); assert.deepEqual(options.action, []);
    assert.deepEqual((await effective()).action_capabilities, []); await assert.rejects(roomMap(0), code('42501'));
  });
  await scenario('creating the first explicit policy invalidates version-zero scope and group receipts', async () => {
    await roomMap(0); const prior = await f.rpc('public.hermes_group_directory_v1', { ...x.baseline, expectedPolicyVersion: 0 }, 'authenticated');
    await explicit(); await assert.rejects(roomMap(0), code('PT409'));
    await assert.rejects(f.rpc('public.hermes_group_directory_v1', { ...x.baseline, expectedPolicyVersion: 0 }, 'authenticated'), code('PT409'));
    const current = await f.rpc('public.hermes_group_directory_v1', x.baseline, 'authenticated');
    assert.notEqual(current.authority.contextVersion, prior.authority.contextVersion); assert.equal((await storeRead()).policy.version, 1);
    await db.exec('DELETE FROM app_private.hermes_org_policies'); await assert.rejects(roomMap(1), code('PT409'));
  });
  await scenario('offboarding, revoked membership, foreign organization and negative versions still deny', async () => {
    await assert.rejects(userRpc('hermes_connection_options_v2', [FOREIGN]), code('42501'));
    await assert.rejects(roomMap(-1), code('22023'));
    await assert.rejects(f.rpc('public.hermes_group_directory_v1', { ...x.baseline, expectedPolicyVersion: -1 }, 'authenticated'), code('22023'));
    await db.exec('UPDATE public.fixture_admin SET offboarded=true'); await assert.rejects(userRpc('hermes_connection_options_v2'), code('42501'));
    await db.exec('UPDATE public.fixture_admin SET offboarded=false; UPDATE public.organization_memberships SET revoked_at=clock_timestamp()'); await assert.rejects(storeRead(), code('42501'));
  });
  await scenario('same opaque renewal retains neutral policy and cannot cross a new explicit deny', async () => {
    const read = await storeRead();
    const payload = { tokenDigest: x.baseline.tokenDigest, connectionId: CONNECTION, expectedEpoch: 1, credentialRef: SESSION,
      expectedRevision: 1, expectedExpiresAt: read.connection.expiresAt, requestedTtlMs: 900000 };
    assert.equal((await f.rpc('app_private.hermes_store_renew_connection_v1', payload)).status, 'renewed');
    const next = await storeRead(); await explicit(false);
    await assert.rejects(f.rpc('app_private.hermes_store_renew_connection_v1', { ...payload, expectedExpiresAt: next.connection.expiresAt }), code('42501'));
  });
  await scenario('neutral group send binds version zero into queue snapshot and delivers once through current authority', async () => {
    const request = await neutralRequest(), sent = await x.send(request), job = sent.dispatch.recipients[0].jobId;
    const saved = (await db.query('SELECT snapshot FROM app_private.hermes_group_dispatches')).rows[0].snapshot;
    assert.equal(saved.binding.policyVersion, 0);
    await assert.rejects(x.send({ ...request, intentDigest: 'e'.repeat(64) }), code('PT409'));
    assert.equal((await x.status(sent.dispatch.id)).recipients[0].status, 'queued');
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job]);
    assert.equal(await x.provider(job, {}, true), false);
    assert.equal(await x.provider(job, { body: 'tampered' }), false);
    assert.equal(await x.provider(job), true); assert.equal(await x.provider(job), false);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_private.hermes_org_policies')).rows[0].n, 0);
  });
  await scenario('neutral private command intake and reply dispatch keep their original channel and current-policy fences', async () => {
    // End the setup command, dispatched before the reply trigger was installed,
    // then use a fresh intake/claim/dispatch so the real trigger binds authority.
    await f.rpc('app_private.hermes_store_fail_private_command_v1', { tokenDigest: x.baseline.tokenDigest, claimId: x.CLAIM, reason: 'runtime_cancelled' });
    const incoming = await f.call({ providerMessageId: 'neutral-incoming' }); assert.equal(incoming.status, 'queued');
    const claim = { tokenDigest: x.baseline.tokenDigest, claimId: id('f') };
    const claimedCommand = await f.rpc('app_private.hermes_store_claim_private_command_v1', claim);
    assert.equal(claimedCommand.command.commandId, incoming.commandId);
    await f.rpc('app_private.hermes_store_dispatch_private_command_v1', claim);
    await f.rpc('app_private.hermes_store_finish_private_command_v1', { ...claim, text: 'Synthetic reply' });
    const reply = { accountId: ACCOUNT, organizationId: ORG, instanceId: INSTANCE, generation: GENERATION,
      accountOwnerId: FOREIGN, ownUid: '123', loginRequestedAt: null, deliveryId: id('e') };
    const claimed = await f.rpc('public.hermes_zalo_private_reply_v1', { ...reply, operation: 'claim' }, 'service_role');
    assert.equal(claimed.status, 'claimed'); assert.equal(claimed.text, 'Synthetic reply');
    await explicit(false);
    await assert.rejects(f.rpc('public.hermes_zalo_private_reply_v1', { ...reply, operation: 'dispatch' }, 'service_role'), code('42501'));
    await assert.rejects(f.call({ providerMessageId: 'blocked-incoming' }), code('42501'));
  });
  for (const [name, change] of [
    ['new explicit deny', () => explicit(false)],
    ['current CRM action removed', () => db.exec('UPDATE public.fixture_authority SET send_zalo=false')],
    ['connection room scope removed', () => db.exec("UPDATE app_private.hermes_connections SET scope_ids='{}'")],
    ['expired token', () => db.exec("UPDATE app_private.hermes_connection_tokens SET expires_at=clock_timestamp()-interval '1 second'")],
    ['expired session', () => db.exec("UPDATE app_private.hermes_sessions SET expires_at=clock_timestamp()-interval '1 second'")],
  ]) await scenario(`neutral queued delivery rejects ${name} before provider admission`, async () => {
    const sent = await x.send(await neutralRequest()), job = sent.dispatch.recipients[0].jobId;
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job]);
    await change(); await assert.rejects(x.provider(job));
    assert.equal((await db.query('SELECT provider_started_at FROM public.zalo_send_queue WHERE id=$1', [job])).rows[0].provider_started_at, null);
  });
  await scenario('first explicit policy is created by an admin with version-zero CAS and invalidates previous scope receipts', async () => {
    const saved = await userRpc('hermes_set_org_policy_v1', [ORG, 0, true, ['rooms.view'], [], [SCOPE]]);
    assert.equal(saved.version, 1); assert.deepEqual(saved.action, []);
    // userRpc is a read-isolated fixture helper, so persist this write explicitly.
    await db.query('SELECT public.hermes_set_org_policy_v1($1,$2,$3,$4,$5,$6)', [ORG, 0, true, ['rooms.view'], [], [SCOPE]]);
    await assert.rejects(roomMap(0), code('PT409'));
    await assert.rejects(userRpc('hermes_set_org_policy_v1', [ORG, 0, true, ['rooms.view'], [], [SCOPE]]), code('PT409'));
  });
  await scenario('prepare and activation use a caller-selected neutral overlay without creating policy grants', async () => {
    // Test extension shims supply randomness/hash only. The real SQL intent,
    // session-binding and activation CAS are exercised without a fake user JWT.
    const prepare = async () => (await db.query('SELECT public.hermes_prepare_connection_v1($1,$2,$3,$4) AS value', [ORG, ['rooms.view'], [], [SCOPE]])).rows[0].value;
    const prepared = await prepare(), now = Number((await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n')).rows[0].n);
    const activation = { connectionId: prepared.id, expectedEpoch: 1, operationId: id('e'), intentSecret: prepared.intentSecret, userId: USER,
      providerSessionId: id('f'), credentialRef: id('a'), tokenDigest: 'c'.repeat(64), tokenExpiresAt: now + 600000,
      sessionEnvelope: { v: 1, algorithm: 'A256GCM', keyVersion: 'fixture', nonce: 'a'.repeat(16), tag: 'a'.repeat(22), ciphertext: 'fixture' }, sessionExpiresAt: now + 3600000 };
    assert.equal((await f.rpc('app_private.hermes_store_activate_v1', activation)).status, 'activated');
    assert.equal((await f.rpc('app_private.hermes_store_read_connection_v1', { tokenDigest: activation.tokenDigest })).policy.version, 0);
    assert.equal((await db.query('SELECT count(*)::integer n FROM app_private.hermes_org_policies')).rows[0].n, 0);
    await explicit(false); await assert.rejects(prepare(), code('42501'));
  });
  await scenario('ACL replay keeps the helper private and never exposes store methods to API roles', async () => {
    for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
      assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed', [role, 'app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[])'])).rows[0].allowed, false);
    }
    const stable = (await db.query("SELECT provolatile FROM pg_proc WHERE oid='public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint)'::regprocedure")).rows[0].provolatile;
    assert.equal(stable, 's');
    for (const definition of functions.filter(s => /LANGUAGE plpgsql STABLE/.test(s))) assert.doesNotMatch(definition.replace(/--[^\n]*/g, ''), /FOR (?:SHARE|UPDATE|NO KEY UPDATE)/);
    for (const definition of functions) {
      const [, schema, name] = definition.match(/CREATE OR REPLACE FUNCTION ([a-z_]+)\.([a-z_0-9]+)\(/);
      const [entry] = (await db.query(`SELECT p.oid,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.provolatile
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname=$2`, [schema, name])).rows;
      assert.equal(entry.owner, 'postgres'); assert.equal(entry.prosecdef, true);
      assert.deepEqual(entry.proconfig, ['search_path=pg_catalog, public, app_private']);
      assert.equal(entry.provolatile, /LANGUAGE plpgsql STABLE/.test(definition) ? 's' : 'v');
      const allowedRole = schema === 'app_private' ? name.startsWith('hermes_store_') ? 'hermes_store_executor' : null
        : ['hermes_zalo_private_command_v1', 'hermes_zalo_private_reply_v1'].includes(name) ? 'service_role' : 'authenticated';
      for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
        assert.equal((await db.query("SELECT has_function_privilege($1,$2::oid,'EXECUTE') allowed", [role, entry.oid])).rows[0].allowed, role === allowedRole, `${name}: ${role}`);
      }
    }
  });
  await scenario('permission mutation: bypassing explicit policy would be detected by the disabled regression', async () => {
    await explicit(false); assert.equal((await userRpc('hermes_connection_options_v2')).enabled, false);
    const helper = functions.find(s => s.includes('CREATE OR REPLACE FUNCTION app_private.hermes_effective_org_policy_v1('));
    await db.exec(helper.replace('IF FOUND THEN RETURN v_policy; END IF;', 'IF false THEN RETURN v_policy; END IF;'));
    // Mutation witness: the same public getter now violates the expected deny.
    const mutated = await userRpc('hermes_connection_options_v2');
    assert.throws(() => assert.equal(mutated.enabled, false), assert.AssertionError);
  });
  await scenario('missing-policy mutation: replacing neutral with deny is detected by enrollment regression', async () => {
    assert.equal((await userRpc('hermes_connection_options_v2')).enabled, true);
    const helper = functions.find(s => s.includes('CREATE OR REPLACE FUNCTION app_private.hermes_effective_org_policy_v1('));
    await db.exec(helper.replace('v_policy.enabled:=true; v_policy.version:=0;', 'v_policy.enabled:=false; v_policy.version:=0;'));
    const mutated = await userRpc('hermes_connection_options_v2');
    assert.throws(() => assert.equal(mutated.enabled, true), assert.AssertionError);
  });
});
