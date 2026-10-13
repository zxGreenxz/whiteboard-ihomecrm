import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, id, ORG, USER, ASSISTANT, SESSION, CONNECTION, BINDING, FOREIGN } from './private-command-fixture.mjs';

// Actual candidate SQL and role ACLs on disposable PGlite. The fixtures seed
// verified credentials/bindings; this does not prove JWT/provider or MVCC races.
const migration = '20261013084000_hermes_private_command_dispatch_v1';
const TOKEN = 'b'.repeat(64), OTHER_TOKEN = 'e'.repeat(64);
const CLAIM = id('e'), OTHER_CLAIM = id('f');
const rejects = (work, code) => assert.rejects(work, error => error.code === code);
const names = Object.fromEntries(['claim', 'dispatch', 'finish', 'fail'].map(op => [op, `app_private.hermes_store_${op}_private_command_v1`]));
names.prune = 'app_private.hermes_store_prune_private_commands_v1';
const payload = op => op === 'prune' ? { limit: 256 } : {
  tokenDigest: TOKEN, claimId: CLAIM, ...(op === 'finish' ? { text: 'PRIVATE REPLY' } : op === 'fail' ? { reason: 'runtime_failed' } : {}),
};

async function dispatchFixture(t) {
  const f = await fixture(t, { migrations: [migration] });
  // A changed provider owner is a real user in the disposable CRM fixture.
  await f.db.query('INSERT INTO auth.users(id) VALUES($1)', [FOREIGN]);
  const run = (op, overrides = {}, role) => f.rpc(names[op], { ...payload(op), ...overrides }, role);
  const row = async () => (await f.db.query('SELECT * FROM app_private.hermes_zalo_private_commands ORDER BY accepted_at,id')).rows[0];
  async function prepare(phase) {
    const accepted = await f.call({ providerMessageId: `case-${randomUUID()}` });
    if (phase !== 'claim') await run('claim');
    if (['finish', 'fail-after-dispatch', 'ready'].includes(phase)) await run('dispatch');
    if (phase === 'ready') await run('finish');
    return accepted;
  }
  return { ...f, run, row, prepare };
}

test('private command state machine grants one dispatch acknowledgment and keeps reconciliation private', async t => {
  const f = await dispatchFixture(t);
  await t.test('an old binding epoch cannot block a newer authorized command on the same connection', async () => {
    await f.rollbackCase(async () => {
      const oldCommand = await f.call({ providerMessageId: 'before-binding-change' });
      // The confirmed binding/epoch fixture changes between separate RPCs. A
      // newly accepted event must not wait for the old authorization's TTL.
      await f.db.exec('UPDATE app_private.hermes_zalo_bindings SET epoch=epoch+1');
      const newCommand = await f.call({ providerMessageId: 'after-binding-change' });
      const claimed = await f.run('claim');
      assert.equal(claimed.status, 'claimed'); assert.equal(claimed.command.commandId, newCommand.commandId);
      assert.notEqual(claimed.command.commandId, oldCommand.commandId);
      assert.equal((await f.run('dispatch')).commandId, newCommand.commandId);
      const old = (await f.db.query('SELECT state,claim_id,dispatched_at FROM app_private.hermes_zalo_private_commands WHERE id=$1', [oldCommand.commandId])).rows[0];
      assert.deepEqual(old, { state: 'QUEUED', claim_id: null, dispatched_at: null });
    });
  });
  await t.test('claim retry is stable, busy claims are empty, and only the first dispatch can execute', async () => {
    await f.rollbackCase(async () => {
      const accepted = await f.prepare('claim');
      const claimed = await f.run('claim');
      assert.equal(claimed.status, 'claimed'); assert.equal(claimed.claimId, CLAIM);
      assert.deepEqual(claimed.command, {
        commandId: accepted.commandId, connectionId: CONNECTION, assistantId: ASSISTANT, userId: USER, organizationId: ORG,
        bindingId: BINDING, bindingEpoch: 1, text: f.request.text, expiresAt: claimed.command.expiresAt,
      });
      assert(Number.isSafeInteger(claimed.command.expiresAt));
      const deadline = Number((await f.db.query("SELECT floor(extract(epoch FROM least(q.expires_at,t.expires_at,s.expires_at,t.created_at+interval '30 days'))*1000)::bigint AS time FROM app_private.hermes_zalo_private_commands q JOIN app_private.hermes_connection_tokens t ON t.connection_id=q.connection_id JOIN app_private.hermes_sessions s ON s.id=$1", [SESSION])).rows[0].time);
      assert.equal(claimed.command.expiresAt, deadline);
      assert(!JSON.stringify(claimed).includes(TOKEN));
      assert.deepEqual(await f.run('claim'), claimed);
      assert.deepEqual(await f.run('claim', { claimId: OTHER_CLAIM }), { status: 'empty' });
      await rejects(f.run('finish'), '40001');
      await rejects(f.run('dispatch', { claimId: OTHER_CLAIM }), '42501');
      const dispatched = await f.run('dispatch');
      assert.deepEqual(dispatched, { status: 'dispatched', commandId: accepted.commandId, claimId: CLAIM });
      const dispatchedAt = (await f.row()).dispatched_at;
      assert.deepEqual(await f.run('dispatch'), { ...dispatched, status: 'already_dispatched' });
      assert.equal(String((await f.row()).dispatched_at), String(dispatchedAt));
      await rejects(f.run('claim'), '40001');
      const ready = await f.run('finish');
      assert.deepEqual(ready, { status: 'ready', commandId: accepted.commandId, claimId: CLAIM });
      assert.deepEqual(await f.run('finish'), { ...ready, status: 'already_ready' });
      await rejects(f.run('finish', { text: 'different reply' }), '40001');
      await rejects(f.run('dispatch'), '40001'); await rejects(f.run('fail'), '40001');
      assert.deepEqual(await f.run('claim', { claimId: OTHER_CLAIM }), { status: 'empty' });
      const row = await f.row(); assert.equal(row.state, 'READY'); assert.equal(row.reply_body, 'PRIVATE REPLY');
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM public.zalo_messages')).rows[0].n, 1);
    });
  });

  for (const phase of ['dispatch', 'fail-after-dispatch']) for (const reason of ['runtime_failed', 'runtime_cancelled', 'runtime_unknown']) {
    await t.test(`${phase} then ${reason} clears content and cannot replay`, async () => {
      await f.rollbackCase(async () => {
        const accepted = await f.prepare(phase);
        const expected = phase === 'fail-after-dispatch' || reason === 'runtime_unknown' ? 'UNKNOWN_EFFECT' : 'FAILED';
        const result = await f.run('fail', { reason });
        assert.deepEqual(result, { status: expected === 'FAILED' ? 'failed' : 'unknown', commandId: accepted.commandId, claimId: CLAIM });
        assert.deepEqual(await f.run('fail', { reason }), result);
        const row = await f.row(); assert.equal(row.state, expected); assert.equal(row.body, null); assert.equal(row.reply_body, null);
        assert.equal(row.failure_code, reason); assert.equal(row.id, accepted.commandId); assert.equal(row.claim_id, CLAIM);
        for (const op of ['claim', 'dispatch', 'finish']) await rejects(f.run(op), '40001');
        const otherReason = reason === 'runtime_failed' ? 'runtime_cancelled' : 'runtime_failed';
        await rejects(f.run('fail', { reason: otherReason }), '40001');
        assert.deepEqual(await f.run('claim', { claimId: OTHER_CLAIM }), { status: 'empty' });
        await rejects(f.call({ providerMessageId: row.provider_message_id }), 'PT409');
        assert.equal((await f.db.query('SELECT count(*)::int AS n FROM app_private.hermes_zalo_private_commands')).rows[0].n, 1);
      });
    });
  }
});

test('private command API and helper ACLs reject caller authority and direct storage access', async t => {
  const f = await dispatchFixture(t);
  for (const role of ['anon', 'authenticated', 'service_role']) for (const op of Object.keys(names)) {
    await t.test(`${role} cannot call ${op}`, () => rejects(f.run(op, {}, role), '42501'));
  }
  for (const op of ['claim', 'dispatch', 'finish', 'fail']) {
    for (const [label, change, code] of [
      ['malformed digest', { tokenDigest: 'invalid' }, '22023'], ['unknown digest', { tokenDigest: 'a'.repeat(64) }, '42501'],
      ['non-string digest', { tokenDigest: null }, '22023'], ['malformed claim', { claimId: 'invalid' }, '22023'],
      ['forged user', { userId: USER }, '22023'], ['forged owner', { ownerId: USER }, '22023'],
      ['forged connection', { connectionId: CONNECTION }, '22023'], ['forged company', { organizationId: ORG }, '22023'],
    ]) await t.test(`${op} rejects ${label}`, () => rejects(f.run(op, change), code));
  }
  for (const text of ['', 'ễ'.repeat(12000), 1, null]) await t.test(`finish rejects invalid text ${typeof text}:${String(text).length}`, () => rejects(f.run('finish', { text }), '22023'));
  for (const reason of ['unsafe_reason', '', 1, null]) await t.test(`fail rejects unreviewed reason ${String(reason)}`, () => rejects(f.run('fail', { reason }), '22023'));
  for (const limit of [0, 257, -1, 1.5, '1', null]) await t.test(`prune rejects invalid limit ${String(limit)}`, () => rejects(f.run('prune', { limit }), '22023'));
  await t.test('prune cannot accept caller-selected company/user filters', () => rejects(f.run('prune', { organizationId: ORG }), '22023'));
  for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
    await t.test(`${role} cannot read/write the ledger or invoke its private helpers`, async () => {
      for (const statement of [
        'SELECT * FROM app_private.hermes_zalo_private_commands',
        "UPDATE app_private.hermes_zalo_private_commands SET body='leak'",
        `SELECT app_private.hermes_private_command_connection_v1('${TOKEN}')`,
        `SELECT app_private.hermes_private_command_lock_v1(NULL::app_private.hermes_connections,NULL::uuid,'${TOKEN}')`,
      ]) {
        await f.db.exec('BEGIN');
        try { await f.db.exec(`SET LOCAL ROLE ${role}`); await rejects(f.db.query(statement), '42501'); }
        finally { await f.db.exec('ROLLBACK; RESET ROLE'); }
      }
    });
  }
});

test('every private execution phase rechecks current authority before returning text or changing state', async t => {
  const f = await dispatchFixture(t);
  // Discovery may skip ineligible queued rows. Once claimed, every phase must
  // still reject lost channel/binding authority instead of operating on it.
  const noQueuedCandidate = new Set([
    'connection epoch changed', 'binding revoked', 'binding epoch changed', 'binding connection epoch changed', 'binding sender changed',
    'bot disabled', 'bot version changed', 'worker lease expired', 'worker lease replaced', 'provider disconnected',
    'provider identity changed', 'provider owner changed', 'provider company changed', 'provider login changed', 'ingress missing',
  ]);
  const changes = [
    ['membership revoked', "UPDATE public.organization_memberships SET status='REVOKED'"],
    ['membership expired', "UPDATE public.organization_memberships SET valid_to=clock_timestamp()-interval '1 second'"],
    ['ordinary user has two companies', `INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${FOREIGN}','${USER}','${FOREIGN}','ACTIVE')`],
    ['company disabled', "UPDATE public.organizations SET status='INACTIVE'"],
    ['assistant disabled', "UPDATE app_private.hermes_assistants SET state='DISABLED'"],
    ['policy disabled', 'UPDATE app_private.hermes_org_policies SET enabled=false'],
    ['connection read exceeds policy', "UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['assistant.context.read']"],
    ['connection action exceeds policy', "UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['room.update']"],
    ['connection scope exceeds policy', `UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${FOREIGN}'::uuid]`],
    ['connection epoch changed', 'UPDATE app_private.hermes_connections SET epoch=epoch+1'],
    ['connection revoked', "UPDATE app_private.hermes_connections SET state='REVOKED',revoked_at=clock_timestamp()"],
    ['session expired', "UPDATE app_private.hermes_sessions SET expires_at=clock_timestamp()-interval '1 second'"],
    ['session quarantined', "UPDATE app_private.hermes_sessions SET state='RECONNECT_REQUIRED',quarantine_reason='refresh_uncertain',envelope=NULL"],
    ['token revoked', 'UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp()'],
    ['token expired', "UPDATE app_private.hermes_connection_tokens SET expires_at=clock_timestamp()-interval '1 second'"],
    ['token absolute lifetime elapsed', "UPDATE app_private.hermes_connection_tokens SET created_at=clock_timestamp()-interval '31 days'"],
    ['token not yet created', "UPDATE app_private.hermes_connection_tokens SET created_at=clock_timestamp()+interval '1 minute'"],
    ['binding revoked', "UPDATE app_private.hermes_zalo_bindings SET state='REVOKED'"],
    ['binding epoch changed', 'UPDATE app_private.hermes_zalo_bindings SET epoch=epoch+1'],
    ['binding connection epoch changed', 'UPDATE app_private.hermes_zalo_bindings SET connection_epoch=connection_epoch+1'],
    ['binding sender changed', "UPDATE app_private.hermes_zalo_bindings SET sender_uid='789'"],
    ['bot disabled', 'UPDATE app_private.hermes_zalo_bots SET enabled=false'],
    ['bot version changed', 'UPDATE app_private.hermes_zalo_bots SET version=version+1'],
    ['worker lease expired', "UPDATE public.zalo_worker_lease SET heartbeat_at=clock_timestamp()-interval '1 minute'"],
    ['worker lease replaced', `UPDATE public.zalo_worker_lease SET instance_id='${FOREIGN}'`],
    ['provider disconnected', "UPDATE public.zalo_accounts SET status='disconnected'"],
    ['provider identity changed', "UPDATE public.zalo_accounts SET zalo_uid='789'"],
    ['provider owner changed', `UPDATE public.zalo_accounts SET user_id='${FOREIGN}'`],
    ['provider company changed', `UPDATE public.zalo_accounts SET organization_id='${FOREIGN}'`],
    ['provider login changed', 'UPDATE public.zalo_accounts SET login_requested_at=clock_timestamp()'],
    ['ingress missing', 'DELETE FROM app_private.hermes_zalo_ingress_sessions'],
  ];
  for (const op of ['claim', 'dispatch', 'finish', 'fail']) for (const [label, statement] of changes) {
    await t.test(`${op} withholds authority after ${label} without mutating the row`, async () => {
      await f.rollbackCase(async () => {
        await f.prepare(op === 'fail' ? 'fail-after-dispatch' : op);
        const before = await f.row(); await f.db.exec(statement);
        if (op === 'claim' && noQueuedCandidate.has(label)) assert.deepEqual(await f.run(op), { status: 'empty' });
        else await rejects(f.run(op), '42501');
        const after = await f.row();
        assert.equal(after.state, before.state); assert.equal(after.body, before.body); assert.equal(after.reply_body, before.reply_body);
        assert.equal(after.claim_id, before.claim_id); assert.equal(after.id, before.id);
      });
    });
  }
  await t.test('another live token owner cannot claim, dispatch, finish or fail this connection', async () => {
    await f.rollbackCase(async () => {
      const otherUser = randomUUID(), otherAssistant = randomUUID(), otherSession = randomUUID(), otherConnection = randomUUID();
      await f.db.exec(`
        INSERT INTO auth.users(id) VALUES('${otherUser}');
        INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${otherUser}','${otherUser}','${ORG}','ACTIVE');
        INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${otherAssistant}','${ORG}','${otherUser}');
        INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at)
          VALUES('${otherSession}','${otherAssistant}','${ORG}','${otherUser}','${otherSession}','ACTIVE','{}',clock_timestamp()+interval '1 hour');
        INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id)
          VALUES('${otherConnection}','${otherAssistant}','${ORG}','${otherUser}','ACTIVE','${otherSession}',repeat('e',64),clock_timestamp()+interval '1 hour','${otherConnection}');
        INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES('${OTHER_TOKEN}','${otherConnection}',clock_timestamp()+interval '10 minutes');
      `);
      await f.prepare('dispatch');
      for (const op of ['claim', 'dispatch', 'finish', 'fail']) await rejects(f.run(op, { tokenDigest: OTHER_TOKEN }), '42501');
      assert.deepEqual(await f.run('claim', { tokenDigest: OTHER_TOKEN, claimId: OTHER_CLAIM }), { status: 'empty' });
      assert.equal((await f.row()).state, 'CLAIMED');
    });
  });
});

test('expiry pruning removes private content while retaining irreversible dedup tombstones', async t => {
  const f = await dispatchFixture(t);
  const expire = () => f.db.exec("UPDATE app_private.hermes_zalo_private_commands SET accepted_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute'");
  for (const [phase, state] of [['claim', 'EXPIRED'], ['dispatch', 'EXPIRED'], ['finish', 'UNKNOWN_EFFECT'], ['ready', 'EXPIRED']]) {
    await t.test(`prunes ${phase} to ${state} without reopening execution or intake`, async () => {
      await f.rollbackCase(async () => {
        const accepted = await f.prepare(phase); const before = await f.row(); await expire();
        if (phase === 'claim') assert.deepEqual(await f.run('claim'), { status: 'empty' });
        else await rejects(f.run('claim'), '42501');
        for (const op of ['dispatch', 'finish', 'fail']) await rejects(f.run(op), '42501');
        assert.deepEqual(await f.run('prune'), { status: 'pruned', count: 1 });
        const after = await f.row();
        assert.equal(after.id, accepted.commandId); assert.equal(after.provider_message_id, before.provider_message_id);
        assert.equal(after.state, state); assert.equal(after.body, null); assert.equal(after.reply_body, null); assert.equal(after.failure_code, 'expired');
        assert.deepEqual(await f.run('prune'), { status: 'pruned', count: 0 });
        await rejects(f.call({ providerMessageId: before.provider_message_id }), 'PT409');
        for (const op of ['dispatch', 'finish', 'fail']) await rejects(f.run(op), '42501');
        assert.deepEqual(await f.run('claim', { claimId: OTHER_CLAIM }), { status: 'empty' });
      });
    });
  }
  await t.test('bounded pruning restores queue capacity while retaining all old IDs', async () => {
    await f.rollbackCase(async () => {
      for (let n = 0; n < 64; n++) await f.call({ providerMessageId: `capacity-${n}` });
      await rejects(f.call({ providerMessageId: 'capacity-next' }), 'PT429');
      assert.deepEqual(await f.run('prune'), { status: 'pruned', count: 0 });
      await expire();
      assert.deepEqual(await f.run('prune', { limit: 1 }), { status: 'pruned', count: 1 });
      assert.equal((await f.call({ providerMessageId: 'capacity-next' })).status, 'queued');
      assert.deepEqual(await f.run('prune', { limit: 256 }), { status: 'pruned', count: 63 });
      const counts = (await f.db.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE state='EXPIRED')::int AS tombstones,count(*) FILTER(WHERE body IS NOT NULL)::int AS bodies FROM app_private.hermes_zalo_private_commands")).rows[0];
      assert.deepEqual(counts, { total: 65, tombstones: 64, bodies: 1 });
      await rejects(f.call({ providerMessageId: 'capacity-0' }), 'PT409');
    });
  });
});
