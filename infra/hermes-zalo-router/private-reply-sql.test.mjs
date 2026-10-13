import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture, id, ORG, USER, ACCOUNT, INSTANCE, GENERATION, SESSION, CONNECTION, FOREIGN } from './private-command-fixture.mjs';

// Actual forward SQL on disposable PGlite with synthetic verified bindings and
// credentials. This does not prove provider sends, JWT/RLS hosting or MVCC races.
const MIGRATIONS = ['20261013084000_hermes_private_command_dispatch_v1', '20261013095000_hermes_zalo_private_reply_v1'];
const RPC = 'public.hermes_zalo_private_reply_v1', TOKEN = 'b'.repeat(64), DELIVERY = id('e'), OTHER = id('f');
const source = () => ({ accountId: ACCOUNT, organizationId: ORG, instanceId: INSTANCE, generation: GENERATION,
  accountOwnerId: USER, ownUid: '123', loginRequestedAt: null });
const replyPayload = (operation, delta = {}) => ({ operation, ...source(), deliveryId: DELIVERY,
  ...(operation === 'ack' ? { outcome: 'sent', providerMessageId: 'provider-reply-1' } : {}), ...delta });
const rejected = (promise, code) => assert.rejects(promise, error => error.code === code);
const denied = promise => assert.rejects(promise, error => ['42501', '40001', 'PT409'].includes(error.code));
const sharedSnapshot = async db => ({ messages: (await db.query('SELECT * FROM public.zalo_messages ORDER BY id')).rows,
  conversations: (await db.query('SELECT * FROM public.zalo_conversations ORDER BY id')).rows });

async function replyFixture(t) {
  const f = await fixture(t, { migrations: MIGRATIONS });
  await f.db.exec(`
    CREATE TABLE public.role_bindings(membership_id uuid,organization_id uuid,valid_from timestamptz,valid_to timestamptz);
    CREATE TABLE public.member_permission_overrides(membership_id uuid,organization_id uuid,expires_at timestamptz,revoked_at timestamptz);
  `);
  await f.db.query('INSERT INTO auth.users(id) VALUES($1)', [FOREIGN]);
  const reply = (operation, delta = {}, role = 'service_role') => f.rpc(RPC, replyPayload(operation, delta), role);
  const row = async commandId => (await f.db.query('SELECT * FROM app_private.hermes_zalo_private_commands WHERE id=$1', [commandId])).rows[0];
  async function ready(text = 'PRIVATE REPLY: phòng 101 trống') {
    const accepted = await f.call({ providerMessageId: `incoming-${randomUUID()}` });
    const input = { tokenDigest: TOKEN, claimId: randomUUID() };
    const claimed = await f.rpc('app_private.hermes_store_claim_private_command_v1', input);
    assert.equal(claimed.command.commandId, accepted.commandId);
    await f.rpc('app_private.hermes_store_dispatch_private_command_v1', input);
    await f.rpc('app_private.hermes_store_finish_private_command_v1', { ...input, text });
    return accepted.commandId;
  }
  const prepare = async phase => {
    const commandId = await ready();
    if (phase !== 'claim') await reply('claim');
    if (phase === 'ack') await reply('dispatch');
    return commandId;
  };
  const prune = (limit = 256) => f.rpc('app_private.hermes_store_prune_private_commands_v1', { limit });
  const expire = commandId => f.db.query("UPDATE app_private.hermes_zalo_private_commands SET accepted_at=clock_timestamp()-interval '2 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [commandId]);
  return { ...f, reply, row, ready, prepare, prune, expire };
}

test('private reply grants one provider dispatch and stores only terminal receipt metadata', async t => {
  const f = await replyFixture(t);
  await t.test('empty is bounded and reveals no routing or private text', async () => {
    assert.deepEqual(await f.reply('claim'), { status: 'empty' });
  });
  await t.test('same delivery claim is stable; another delivery cannot steal its reply or reset dispatch', async () => {
    await f.rollbackCase(async () => {
      const commandId = await f.ready(), shared = await sharedSnapshot(f.db);
      const claimed = await f.reply('claim');
      assert.deepEqual(claimed, { status: 'claimed', deliveryId: DELIVERY, commandId, accountId: ACCOUNT,
        organizationId: ORG, generation: GENERATION, recipientUid: '456', text: 'PRIVATE REPLY: phòng 101 trống', expiresAt: claimed.expiresAt });
      assert(Number.isSafeInteger(claimed.expiresAt));
      const actualExpiry = Number((await f.db.query("SELECT floor(extract(epoch FROM least(q.expires_at,t.expires_at,s.expires_at,t.created_at+interval '30 days'))*1000)::bigint AS expiry FROM app_private.hermes_zalo_private_commands q JOIN app_private.hermes_connection_tokens t ON t.connection_id=q.connection_id JOIN app_private.hermes_sessions s ON s.id=$2 WHERE q.id=$1", [commandId, SESSION])).rows[0].expiry);
      assert(claimed.expiresAt <= actualExpiry && claimed.expiresAt > 0);
      assert(!JSON.stringify(claimed).includes(TOKEN));
      assert.deepEqual(await f.reply('claim'), claimed);
      assert.deepEqual(await f.reply('claim', { deliveryId: OTHER }), { status: 'empty' });
      const held = await f.row(commandId);
      assert.equal(held.state, 'REPLY_CLAIMED'); assert.equal(held.delivery_id, DELIVERY);
      assert.equal(held.reply_instance_id, INSTANCE); assert.equal(held.reply_generation, GENERATION);
      assert.equal(held.reply_account_owner_id, USER); assert.equal(held.reply_own_uid, '123'); assert.equal(held.reply_login_requested_at, null);
      await denied(f.reply('ack')); await denied(f.reply('dispatch', { deliveryId: OTHER }));
      const dispatched = await f.reply('dispatch');
      const metadata = { deliveryId: DELIVERY, commandId, accountId: ACCOUNT, organizationId: ORG, generation: GENERATION };
      assert.deepEqual(dispatched, { status: 'dispatched', ...metadata });
      const at = (await f.row(commandId)).reply_dispatched_at;
      assert.deepEqual(await f.reply('dispatch'), { status: 'already_dispatched', ...metadata });
      assert.equal(String((await f.row(commandId)).reply_dispatched_at), String(at));
      await denied(f.reply('claim'));
      assert.deepEqual(await f.reply('claim', { deliveryId: OTHER }), { status: 'empty' });
      const sent = await f.reply('ack');
      assert.deepEqual(sent, { status: 'sent', ...metadata }); assert.deepEqual(await f.reply('ack'), sent);
      const terminal = await f.row(commandId);
      assert.equal(terminal.state, 'SENT'); assert.equal(terminal.body, null); assert.equal(terminal.reply_body, null);
      assert.equal(terminal.reply_provider_message_id, 'provider-reply-1'); assert.equal(terminal.delivery_id, DELIVERY);
      await denied(f.reply('ack', { providerMessageId: 'other-provider-message' }));
      await denied(f.reply('ack', { outcome: 'unknown', providerMessageId: null }));
      await denied(f.reply('dispatch')); await denied(f.reply('claim'));
      assert.deepEqual(await f.reply('claim', { deliveryId: OTHER }), { status: 'empty' });
      await denied(f.call({ providerMessageId: terminal.provider_message_id }));
      assert.deepEqual(await sharedSnapshot(f.db), shared);
    });
  });
  for (const [outcome, phase, state] of [['unknown', 'ack', 'UNKNOWN_EFFECT'], ['cancelled', 'dispatch', 'FAILED']]) {
    await t.test(`${outcome} clears content, reconciles identical payload and preserves dedup`, async () => {
      await f.rollbackCase(async () => {
        const commandId = await f.prepare(phase), before = await f.row(commandId);
        const receipt = await f.reply('ack', { outcome, providerMessageId: null });
        assert.deepEqual(receipt, { status: outcome, deliveryId: DELIVERY, commandId, accountId: ACCOUNT, organizationId: ORG, generation: GENERATION });
        assert.deepEqual(await f.reply('ack', { outcome, providerMessageId: null }), receipt);
        const after = await f.row(commandId);
        assert.equal(after.state, state); assert.equal(after.body, null); assert.equal(after.reply_body, null);
        assert.equal(after.provider_message_id, before.provider_message_id); assert.equal(after.delivery_id, DELIVERY);
        await denied(f.reply('ack', { outcome: 'sent', providerMessageId: 'late-different-effect' }));
        await denied(f.reply('claim')); await denied(f.reply('dispatch'));
        await denied(f.call({ providerMessageId: before.provider_message_id }));
      });
    });
  }
  await t.test('provider-dispatched work cannot be cancelled as though no send occurred', async () => {
    await f.rollbackCase(async () => {
      const commandId = await f.prepare('ack'), before = await f.row(commandId);
      await denied(f.reply('ack', { outcome: 'cancelled', providerMessageId: null }));
      assert.deepEqual(await f.row(commandId), before);
    });
  });
  await t.test('an account holds only one reply delivery while another READY response waits', async () => {
    await f.rollbackCase(async () => {
      const first = await f.ready('First reply'), second = await f.ready('Second reply');
      assert.equal((await f.reply('claim')).commandId, first);
      assert.deepEqual(await f.reply('claim', { deliveryId: OTHER }), { status: 'empty' });
      assert.equal((await f.row(second)).state, 'READY');
      await f.reply('dispatch'); await f.reply('ack');
      const next = await f.reply('claim', { deliveryId: OTHER });
      assert.equal(next.commandId, second); assert.equal(next.text, 'Second reply');
    });
  });
  await t.test('unexecuted, running and failed commands never become outbound reply candidates', async () => {
    await f.rollbackCase(async () => {
      const accepted = await f.call({ providerMessageId: 'not-ready-for-reply' });
      const input = { tokenDigest: TOKEN, claimId: randomUUID() };
      for (const state of ['QUEUED', 'CLAIMED', 'DISPATCHED', 'UNKNOWN_EFFECT']) {
        const before = await f.row(accepted.commandId); assert.equal(before.state, state);
        assert.deepEqual(await f.reply('claim'), { status: 'empty' });
        assert.deepEqual(await f.row(accepted.commandId), before);
        if (state === 'QUEUED') await f.rpc('app_private.hermes_store_claim_private_command_v1', input);
        if (state === 'CLAIMED') await f.rpc('app_private.hermes_store_dispatch_private_command_v1', input);
        if (state === 'DISPATCHED') await f.rpc('app_private.hermes_store_fail_private_command_v1', { ...input, reason: 'runtime_unknown' });
      }
    });
  });
  await t.test('bounded provider receipt IDs retain literal values on successful acknowledgement', async () => {
    for (const providerMessageId of ['a', 'A_9-'.repeat(32)]) {
      await f.rollbackCase(async () => {
        const commandId = await f.prepare('ack');
        assert.equal((await f.reply('ack', { providerMessageId })).status, 'sent');
        assert.equal((await f.row(commandId)).reply_provider_message_id, providerMessageId);
      });
    }
  });
});

test('private reply RPC and ledger reject unauthorized roles and supplied recipient authority', async t => {
  const f = await replyFixture(t);
  for (const role of ['anon', 'authenticated', 'hermes_store_executor']) for (const operation of ['claim', 'dispatch', 'ack']) {
    await t.test(`${role} cannot ${operation}`, () => rejected(f.reply(operation, {}, role), '42501'));
  }
  const invalid = [
    ['forged recipient', { recipientUid: '789' }], ['forged command', { commandId: FOREIGN }],
    ['forged connection', { connectionId: CONNECTION }], ['forged text', { text: 'Send this instead' }],
    ['forged assistant', { assistantId: FOREIGN }], ['forged user', { userId: USER }],
    ['unknown operation', { operation: 'send' }], ['invalid delivery UUID', { deliveryId: 'invalid' }],
    ['invalid account UUID', { accountId: 'invalid' }], ['invalid organization UUID', { organizationId: 'invalid' }],
    ['invalid instance UUID', { instanceId: 'invalid' }], ['invalid generation UUID', { generation: 'invalid' }],
    ['invalid owner UUID', { accountOwnerId: 'invalid' }], ['numeric UID', { ownUid: 123 }],
    ['empty UID', { ownUid: '' }], ['zero UID', { ownUid: '0' }], ['leading zero UID', { ownUid: '0123' }],
    ['overlong UID', { ownUid: '1'.repeat(41) }],
    ['numeric timestamp', { loginRequestedAt: 1800000000000 }], ['invalid timestamp', { loginRequestedAt: 'tomorrow' }],
    ['decimal timestamp string', { loginRequestedAt: '1800000000000' }], ['string null timestamp', { loginRequestedAt: 'null' }],
  ];
  for (const operation of ['claim', 'dispatch', 'ack']) for (const [label, delta] of invalid) {
    await t.test(`${operation} rejects ${label}`, () => rejected(f.reply(operation, delta), '22023'));
  }
  for (const operation of ['claim', 'dispatch', 'ack']) {
    for (const key of ['operation', ...Object.keys(source()), 'deliveryId', ...(operation === 'ack' ? ['outcome', 'providerMessageId'] : [])]) {
      await t.test(`${operation} requires ${key}`, async () => {
        const request = replyPayload(operation); delete request[key];
        await rejected(f.rpc(RPC, request, 'service_role'), '22023');
      });
    }
  }
  for (const [label, delta] of [
    ['sent requires provider ID', { providerMessageId: null }], ['empty provider ID', { providerMessageId: '' }],
    ['invalid provider ID', { providerMessageId: 'unsafe/id' }], ['long provider ID', { providerMessageId: 'a'.repeat(129) }],
    ['numeric provider ID', { providerMessageId: 123 }], ['unknown must not assert provider ID', { outcome: 'unknown' }],
    ['cancelled must not assert provider ID', { outcome: 'cancelled' }], ['unknown outcome', { outcome: 'retry' }],
  ]) await t.test(`ack rejects ${label}`, () => rejected(f.reply('ack', delta), '22023'));
  for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor']) {
    await t.test(`${role} cannot read the ledger or use the private reply helper`, async () => {
      for (const statement of ['SELECT * FROM app_private.hermes_zalo_private_commands',
        "UPDATE app_private.hermes_zalo_private_commands SET reply_body='leaked'",
        'SELECT app_private.hermes_private_command_authority_guard_v1()',
        `SELECT app_private.hermes_private_reply_lock_v1('${FOREIGN}'::uuid,'{}'::jsonb)`]) {
        await f.db.exec('BEGIN');
        try { await f.db.exec(`SET LOCAL ROLE ${role}`); await rejected(f.db.query(statement), '42501'); }
        finally { await f.db.exec('ROLLBACK; RESET ROLE'); }
      }
    });
  }
});

test('live reply claim and dispatch recheck channel source and current CRM authority', async t => {
  const f = await replyFixture(t);
  const changes = [
    ['membership revoked', "UPDATE public.organization_memberships SET status='REVOKED'"],
    ['membership expired', "UPDATE public.organization_memberships SET valid_to=clock_timestamp()-interval '1 second'"],
    ['ordinary user in another company', `INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${FOREIGN}','${USER}','${FOREIGN}','ACTIVE')`],
    ['company inactive', `UPDATE public.organizations SET status='INACTIVE' WHERE id='${ORG}'`],
    ['CRM permission revision changed', `UPDATE public.organizations SET authorization_version=authorization_version+1 WHERE id='${ORG}'`],
    ['assistant disabled', "UPDATE app_private.hermes_assistants SET state='DISABLED'"],
    ['policy disabled', 'UPDATE app_private.hermes_org_policies SET enabled=false'],
    ['read ceiling removed', "UPDATE app_private.hermes_connections SET read_capabilities=ARRAY['assistant.context.read']"],
    ['action ceiling removed', "UPDATE app_private.hermes_connections SET action_capabilities=ARRAY['room.update']"],
    ['scope ceiling removed', `UPDATE app_private.hermes_connections SET scope_ids=ARRAY['${FOREIGN}'::uuid]`],
    ['connection revoked', "UPDATE app_private.hermes_connections SET state='REVOKED',revoked_at=clock_timestamp()"],
    ['connection epoch changed', 'UPDATE app_private.hermes_connections SET epoch=epoch+1'],
    ['session expired', "UPDATE app_private.hermes_sessions SET expires_at=clock_timestamp()-interval '1 second'"],
    ['session quarantined', "UPDATE app_private.hermes_sessions SET state='RECONNECT_REQUIRED',quarantine_reason='refresh_uncertain',envelope=NULL"],
    ['token revoked', 'UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp()'],
    ['token expired', "UPDATE app_private.hermes_connection_tokens SET expires_at=clock_timestamp()-interval '1 second'"],
    ['token maximum age passed', "UPDATE app_private.hermes_connection_tokens SET created_at=clock_timestamp()-interval '31 days'"],
    ['token from future', "UPDATE app_private.hermes_connection_tokens SET created_at=clock_timestamp()+interval '1 minute'"],
    ['binding revoked', "UPDATE app_private.hermes_zalo_bindings SET state='REVOKED'"],
    ['binding epoch changed', 'UPDATE app_private.hermes_zalo_bindings SET epoch=epoch+1'],
    ['binding connection epoch changed', 'UPDATE app_private.hermes_zalo_bindings SET connection_epoch=connection_epoch+1'],
    ['recipient binding changed', "UPDATE app_private.hermes_zalo_bindings SET sender_uid='789'"],
    ['bot disabled', 'UPDATE app_private.hermes_zalo_bots SET enabled=false'],
    ['bot version changed', 'UPDATE app_private.hermes_zalo_bots SET version=version+1'],
    ['worker heartbeat expired', "UPDATE public.zalo_worker_lease SET heartbeat_at=clock_timestamp()-interval '1 minute'"],
    ['worker replaced', `UPDATE public.zalo_worker_lease SET instance_id='${FOREIGN}'`],
    ['provider disconnected', "UPDATE public.zalo_accounts SET status='disconnected'"],
    ['provider UID changed', "UPDATE public.zalo_accounts SET zalo_uid='789'"],
    ['provider owner changed', `UPDATE public.zalo_accounts SET user_id='${FOREIGN}'`],
    ['provider company changed', `UPDATE public.zalo_accounts SET organization_id='${FOREIGN}'`],
    ['provider login changed', 'UPDATE public.zalo_accounts SET login_requested_at=clock_timestamp()'],
    ['ingress missing', 'DELETE FROM app_private.hermes_zalo_ingress_sessions'],
    ['ingress generation changed', `UPDATE app_private.hermes_zalo_ingress_sessions SET generation='${FOREIGN}'`],
    ['ingress owner changed', `UPDATE app_private.hermes_zalo_ingress_sessions SET account_owner_id='${FOREIGN}'`],
    ['ingress UID changed', "UPDATE app_private.hermes_zalo_ingress_sessions SET own_uid='789'"],
    ['ingress login changed', 'UPDATE app_private.hermes_zalo_ingress_sessions SET login_requested_at=clock_timestamp()'],
  ];
  for (const operation of ['claim', 'dispatch']) for (const [label, statement] of changes) {
    await t.test(`${operation} does not authorize a send after ${label}`, async () => {
      await f.rollbackCase(async () => {
        const commandId = await f.prepare(operation), before = await f.row(commandId);
        await f.db.exec(statement);
        if (operation === 'claim') {
          // Discovery may skip an ineligible READY item or reject the whole
          // worker channel. Both withhold content and must preserve the row.
          try { assert.deepEqual(await f.reply(operation), { status: 'empty' }); }
          catch (error) { if (!['42501', '40001', 'PT409'].includes(error.code)) throw error; }
        } else await denied(f.reply(operation));
        assert.deepEqual(await f.row(commandId), before);
      });
    });
  }
  for (const operation of ['claim', 'dispatch']) for (const [key, value] of Object.entries({
    accountId: FOREIGN, organizationId: FOREIGN, instanceId: FOREIGN, generation: FOREIGN,
    accountOwnerId: FOREIGN, ownUid: '789', loginRequestedAt: '2026-01-01T00:00:00Z',
  })) {
    await t.test(`${operation} cannot assert foreign ${key}`, async () => {
      await f.rollbackCase(async () => {
        const commandId = await f.prepare(operation), before = await f.row(commandId);
        await denied(f.reply(operation, { [key]: value }));
        assert.deepEqual(await f.row(commandId), before);
      });
    });
  }
  await t.test('obsolete READY binding cannot block a newer current reply', async () => {
    await f.rollbackCase(async () => {
      const old = await f.ready('OLD PRIVATE REPLY');
      await f.db.exec('UPDATE app_private.hermes_zalo_bindings SET epoch=epoch+1');
      const current = await f.ready('CURRENT PRIVATE REPLY');
      const result = await f.reply('claim');
      assert.equal(result.commandId, current); assert.equal(result.text, 'CURRENT PRIVATE REPLY');
      assert.equal((await f.row(old)).state, 'READY'); assert.equal((await f.row(old)).delivery_id, null);
    });
  });
  await t.test('obsolete READY permission revision cannot block a new reply generated under current rights', async () => {
    await f.rollbackCase(async () => {
      const old = await f.ready('OLD PERMISSION DATA'), before = await f.row(old);
      await f.db.query('UPDATE public.organizations SET authorization_version=authorization_version+1 WHERE id=$1', [ORG]);
      const current = await f.ready('CURRENT PERMISSION DATA'), result = await f.reply('claim');
      assert.equal(result.commandId, current); assert.equal(result.text, 'CURRENT PERMISSION DATA');
      assert.deepEqual(await f.row(old), before);
      assert.equal(Number((await f.row(current)).authorization_version), Number(before.authorization_version) + 1);
      assert.equal((await f.reply('dispatch')).status, 'dispatched');
    });
  });
  for (const mode of ['revoked', 'ordinary-multi-org', 'duplicate-membership', 'superadmin-multi-org']) {
    await t.test(`shared bot handles ${mode} for earlier user A without blocking authorized user B`, async () => {
      await f.rollbackCase(async () => {
        const commandA = await f.ready('PRIVATE A REPLY');
        const userB = FOREIGN, assistantB = randomUUID(), sessionB = randomUUID(), connectionB = randomUUID();
        const conversationB = randomUUID(), messageB = randomUUID(), challengeB = randomUUID(), bindingB = randomUUID();
        const tokenB = 'e'.repeat(64);
        // A second synthetic verified user/channel uses the same account, with
        // independent assistant, credential, connection and sender ownership.
        await f.db.exec(`
          INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES('${userB}','${userB}','${ORG}','ACTIVE');
          INSERT INTO app_private.hermes_assistants(id,organization_id,user_id) VALUES('${assistantB}','${ORG}','${userB}');
          INSERT INTO app_private.hermes_sessions(id,assistant_id,organization_id,user_id,provider_session_id,state,envelope,expires_at)
            VALUES('${sessionB}','${assistantB}','${ORG}','${userB}','${sessionB}','ACTIVE','{}',clock_timestamp()+interval '1 hour');
          INSERT INTO app_private.hermes_connections(id,assistant_id,organization_id,user_id,state,credential_ref,intent_digest,intent_expires_at,activation_operation_id)
            VALUES('${connectionB}','${assistantB}','${ORG}','${userB}','ACTIVE','${sessionB}',repeat('e',64),clock_timestamp()+interval '1 hour','${connectionB}');
          INSERT INTO app_private.hermes_connection_tokens(token_digest,connection_id,expires_at) VALUES('${tokenB}','${connectionB}',clock_timestamp()+interval '10 minutes');
          INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,peer_zalo_uid)
            VALUES('${conversationB}','${ACCOUNT}','${ORG}','user','789','789');
          INSERT INTO public.zalo_messages(id,account_id,organization_id,conversation_id,direction,msg_type,body,zalo_msg_id,zalo_raw,created_at)
            VALUES('${messageB}','${ACCOUNT}','${ORG}','${conversationB}','in','text','[Hermes link - hidden]','link-b','{"uidFrom":"789","idTo":"123"}',clock_timestamp());
          INSERT INTO app_private.hermes_zalo_link_challenges(id,user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,
            challenge_digest,created_at,expires_at,state,candidate_version,sender_uid,conversation_id,message_id,ingress_generation)
            VALUES('${challengeB}','${userB}','${ORG}','${assistantB}','${connectionB}',1,'${ACCOUNT}',1,repeat('d',64),clock_timestamp(),clock_timestamp()+interval '1 minute',
              'CONFIRMED',1,'789','${conversationB}','${messageB}','${GENERATION}');
          INSERT INTO app_private.hermes_zalo_bindings(id,user_id,organization_id,assistant_id,connection_id,connection_epoch,account_id,bot_version,sender_uid,conversation_id,challenge_id)
            VALUES('${bindingB}','${userB}','${ORG}','${assistantB}','${connectionB}',1,'${ACCOUNT}',1,'789','${conversationB}','${challengeB}');
        `);
        const sentAt = Number((await f.db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS time')).rows[0].time);
        const acceptedB = await f.call({ providerMessageId: 'incoming-user-b', senderUid: '789', sentAt });
        const inputB = { tokenDigest: tokenB, claimId: randomUUID() };
        assert.equal((await f.rpc('app_private.hermes_store_claim_private_command_v1', inputB)).command.commandId, acceptedB.commandId);
        await f.rpc('app_private.hermes_store_dispatch_private_command_v1', inputB);
        await f.rpc('app_private.hermes_store_finish_private_command_v1', { ...inputB, text: 'PRIVATE B REPLY' });
        if (mode === 'revoked') await f.db.query("UPDATE public.organization_memberships SET status='REVOKED' WHERE user_id=$1", [USER]);
        else {
          await f.db.query("INSERT INTO public.organization_memberships(id,user_id,organization_id,status) VALUES($1,$2,$3,'ACTIVE')",
            [randomUUID(), USER, mode === 'duplicate-membership' ? ORG : FOREIGN]);
          if (mode === 'superadmin-multi-org') await f.db.query('INSERT INTO public.super_admins(user_id) VALUES($1)', [USER]);
        }
        const shared = await sharedSnapshot(f.db), result = await f.reply('claim');
        const expectA = mode === 'superadmin-multi-org';
        assert.equal(result.commandId, expectA ? commandA : acceptedB.commandId);
        assert.equal(result.recipientUid, expectA ? '456' : '789');
        assert.equal(result.text, expectA ? 'PRIVATE A REPLY' : 'PRIVATE B REPLY');
        const skipped = await f.row(expectA ? acceptedB.commandId : commandA);
        assert.equal(skipped.state, 'READY'); assert.equal(skipped.delivery_id, null);
        assert.equal((await f.reply('dispatch')).commandId, result.commandId);
        assert.deepEqual(await sharedSnapshot(f.db), shared);
      });
    });
  }
  await t.test('canonical timestamps compare instants and bind the stored login snapshot', async () => {
    await f.rollbackCase(async () => {
      const commandId = await f.ready();
      await f.db.exec("UPDATE public.zalo_accounts SET login_requested_at='2026-01-01T00:00:00.123Z'; UPDATE app_private.hermes_zalo_ingress_sessions SET login_requested_at='2026-01-01T00:00:00.123Z'");
      const result = await f.reply('claim', { loginRequestedAt: '2026-01-01T07:00:00.123+07:00' });
      assert.equal(result.commandId, commandId);
      assert.equal((await f.reply('dispatch', { loginRequestedAt: '2026-01-01T00:00:00.123Z' })).status, 'dispatched');
    });
  });
});

test('CRM permission revision is captured before runtime and fences every later private read or send', async t => {
  const f = await replyFixture(t);
  const bump = () => f.db.query('UPDATE public.organizations SET authorization_version=authorization_version+1 WHERE id=$1', [ORG]);
  const version = async () => Number((await f.db.query('SELECT authorization_version FROM public.organizations WHERE id=$1', [ORG])).rows[0].authorization_version);
  for (const changedAt of ['queued', 'claimed']) {
    await t.test(`permission change while ${changedAt} uses current rights when runtime is admitted`, async () => {
      await f.rollbackCase(async () => {
        const accepted = await f.call({ providerMessageId: `revision-${changedAt}` });
        const input = { tokenDigest: TOKEN, claimId: randomUUID() };
        assert.equal((await f.row(accepted.commandId)).authorization_version, null);
        if (changedAt === 'queued') await bump();
        await f.rpc('app_private.hermes_store_claim_private_command_v1', input);
        assert.equal((await f.row(accepted.commandId)).authorization_version, null);
        if (changedAt === 'claimed') await bump();
        await f.rpc('app_private.hermes_store_dispatch_private_command_v1', input);
        assert.equal(Number((await f.row(accepted.commandId)).authorization_version), await version());
        await f.rpc('app_private.hermes_store_finish_private_command_v1', { ...input, text: 'Data read using fresh permissions' });
        assert.equal((await f.reply('claim')).commandId, accepted.commandId);
        assert.equal((await f.reply('dispatch')).status, 'dispatched');
      });
    });
  }
  await t.test('permission narrowing during runtime cannot bless old output by stamping the new revision at finish', async () => {
    await f.rollbackCase(async () => {
      const accepted = await f.call({ providerMessageId: 'permission-changed-during-runtime' });
      const input = { tokenDigest: TOKEN, claimId: randomUUID() };
      await f.rpc('app_private.hermes_store_claim_private_command_v1', input);
      await f.rpc('app_private.hermes_store_dispatch_private_command_v1', input);
      const before = await f.row(accepted.commandId);
      assert.equal(Number(before.authorization_version), await version());
      await bump();
      await denied(f.rpc('app_private.hermes_store_finish_private_command_v1', { ...input, text: 'Sensitive data from previous rights' }));
      assert.deepEqual(await f.row(accepted.commandId), before);
      assert.deepEqual(await f.reply('claim'), { status: 'empty' });
      // Failure cleanup remains possible and cannot create a new delivery.
      await f.rpc('app_private.hermes_store_fail_private_command_v1', { ...input, reason: 'runtime_unknown' });
      const after = await f.row(accepted.commandId);
      assert.equal(after.state, 'UNKNOWN_EFFECT'); assert.equal(after.body, null); assert.equal(after.reply_body, null);
    });
  });
  await t.test('same delivery claim cannot reread its private output after permission narrowing', async () => {
    await f.rollbackCase(async () => {
      const commandId = await f.prepare('dispatch'), before = await f.row(commandId);
      await bump();
      await denied(f.reply('claim')); await denied(f.reply('dispatch'));
      assert.deepEqual(await f.row(commandId), before);
      assert.equal((await f.reply('ack', { outcome: 'cancelled', providerMessageId: null })).status, 'cancelled');
      assert.equal((await f.row(commandId)).reply_body, null);
    });
  });
  await t.test('captured revision cannot be restamped or moved to a different organization', async () => {
    await f.rollbackCase(async () => {
      const commandId = await f.ready(), before = await f.row(commandId);
      for (const statement of [
        'UPDATE app_private.hermes_zalo_private_commands SET authorization_version=authorization_version+1 WHERE id=$1',
        'UPDATE app_private.hermes_zalo_private_commands SET authorization_version=NULL WHERE id=$1',
        "UPDATE app_private.hermes_zalo_private_commands SET authorization_expires_at=authorization_expires_at+interval '1 day' WHERE id=$1",
        `UPDATE app_private.hermes_zalo_private_commands SET organization_id='${FOREIGN}' WHERE id=$1`,
      ]) {
        await f.db.exec('SAVEPOINT authority_guard_attempt');
        try { await rejected(f.db.query(statement, [commandId]), '42501'); }
        finally { await f.db.exec('ROLLBACK TO SAVEPOINT authority_guard_attempt; RELEASE SAVEPOINT authority_guard_attempt'); }
        assert.deepEqual(await f.row(commandId), before);
      }
    });
  });
});

test('time-based permission boundaries cap private output without relying on a version bump', async t => {
  const f = await replyFixture(t);
  const boundary = async (kind, seconds = 300) => {
    const at = (await f.db.query("SELECT clock_timestamp()+($1::text||' seconds')::interval AS at", [seconds])).rows[0].at;
    if (kind === 'membership end') await f.db.query('UPDATE public.organization_memberships SET valid_to=$1 WHERE id=$2', [at, USER]);
    else if (kind === 'future membership') await f.db.query("INSERT INTO public.organization_memberships(id,user_id,organization_id,status,valid_from) VALUES($1,$2,$3,'ACTIVE',$4)", [randomUUID(), USER, FOREIGN, at]);
    else if (kind === 'role start') await f.db.query('INSERT INTO public.role_bindings(membership_id,organization_id,valid_from) VALUES($1,$2,$3)', [USER, ORG, at]);
    else if (kind === 'role end') await f.db.query('INSERT INTO public.role_bindings(membership_id,organization_id,valid_to) VALUES($1,$2,$3)', [USER, ORG, at]);
    else await f.db.query('INSERT INTO public.member_permission_overrides(membership_id,organization_id,expires_at) VALUES($1,$2,$3)', [USER, ORG, at]);
    return at;
  };
  const passBoundary = at => f.db.query('SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp()))+0.01)', [at]);
  const currentVersion = async () => (await f.db.query('SELECT authorization_version FROM public.organizations WHERE id=$1', [ORG])).rows[0].authorization_version;
  for (const kind of ['membership end', 'future membership', 'role start', 'role end', 'override expiry']) {
    await t.test(`${kind} caps the output deadline before runtime and the claimed reply expiry`, async () => {
      await f.rollbackCase(async () => {
        const at = await boundary(kind), commandId = await f.ready(), command = await f.row(commandId);
        assert.equal(new Date(command.authorization_expires_at).getTime(), new Date(at).getTime());
        assert.equal((await f.reply('claim')).expiresAt, new Date(at).getTime());
      });
    });
  }
  for (const kind of ['role start', 'role end', 'override expiry']) for (const phase of ['runtime', 'ready', 'reply claimed']) {
    await t.test(`${kind} passing during ${phase} blocks output even when authorization_version stays constant`, async () => {
      await f.rollbackCase(async () => {
        const at = await boundary(kind, 0.7), version = await currentVersion();
        const accepted = await f.call({ providerMessageId: `time-boundary-${randomUUID()}` });
        const input = { tokenDigest: TOKEN, claimId: randomUUID() };
        await f.rpc('app_private.hermes_store_claim_private_command_v1', input);
        await f.rpc('app_private.hermes_store_dispatch_private_command_v1', input);
        if (phase !== 'runtime') await f.rpc('app_private.hermes_store_finish_private_command_v1', { ...input, text: 'Data read before time changed permissions' });
        if (phase === 'reply claimed') assert.equal((await f.reply('claim')).expiresAt, new Date(at).getTime());
        const before = await f.row(accepted.commandId);
        await passBoundary(at);
        assert.equal(await currentVersion(), version);
        if (phase === 'runtime') await denied(f.rpc('app_private.hermes_store_finish_private_command_v1', { ...input, text: 'Stale timed permission output' }));
        else if (phase === 'ready') assert.deepEqual(await f.reply('claim'), { status: 'empty' });
        else { await denied(f.reply('claim')); await denied(f.reply('dispatch')); }
        assert.deepEqual(await f.row(accepted.commandId), before);
      });
    });
  }
  await t.test('original dispatched receipt remains metadata-only after the captured deadline', async () => {
    await f.rollbackCase(async () => {
      const at = await boundary('override expiry', 0.7), commandId = await f.prepare('ack');
      await passBoundary(at);
      const receipt = await f.reply('ack');
      assert.deepEqual(receipt, { status: 'sent', deliveryId: DELIVERY, commandId, accountId: ACCOUNT, organizationId: ORG, generation: GENERATION });
      assert.equal((await f.row(commandId)).reply_body, null);
      await denied(f.reply('dispatch'));
    });
  });
  await t.test('unrelated or revoked permission timestamps do not shorten this user output lifetime', async () => {
    await f.rollbackCase(async () => {
      const at = (await f.db.query("SELECT clock_timestamp()+interval '1 minute' AS at")).rows[0].at;
      await f.db.query('INSERT INTO public.role_bindings(membership_id,organization_id,valid_to) VALUES($1,$2,$3)', [FOREIGN, ORG, at]);
      await f.db.query('INSERT INTO public.member_permission_overrides(membership_id,organization_id,expires_at,revoked_at) VALUES($1,$2,$3,clock_timestamp())', [USER, ORG, at]);
      const commandId = await f.ready(), row = await f.row(commandId);
      assert.equal(new Date(row.authorization_expires_at).getTime(), new Date(row.expires_at).getTime());
    });
  });
});

test('reply acknowledgements reconcile the original delivery after authority changes without reopening a send', async t => {
  const f = await replyFixture(t);
  const changes = [
    ['bot disabled', 'UPDATE app_private.hermes_zalo_bots SET enabled=false,version=version+1'],
    ['binding revoked', "UPDATE app_private.hermes_zalo_bindings SET state='REVOKED',epoch=epoch+1"],
    ['connection revoked', "UPDATE app_private.hermes_connections SET state='REVOKED',revoked_at=clock_timestamp()"],
    ['membership revoked', "UPDATE public.organization_memberships SET status='REVOKED'"],
    ['CRM permission revision changed', `UPDATE public.organizations SET authorization_version=authorization_version+1 WHERE id='${ORG}'`],
    ['token revoked', 'UPDATE app_private.hermes_connection_tokens SET revoked_at=clock_timestamp()'],
    ['worker replaced', `UPDATE public.zalo_worker_lease SET instance_id='${FOREIGN}'`],
    ['account relogin', `UPDATE public.zalo_accounts SET user_id='${FOREIGN}',zalo_uid='789',login_requested_at=clock_timestamp(); UPDATE app_private.hermes_zalo_ingress_sessions SET account_owner_id='${FOREIGN}',own_uid='789',generation='${FOREIGN}',login_requested_at=clock_timestamp()`],
  ];
  for (const [label, statement] of changes) await t.test(`matching old-source acknowledgement remains metadata-only after ${label}`, async () => {
    await f.rollbackCase(async () => {
      const commandId = await f.prepare('ack'), shared = await sharedSnapshot(f.db);
      await f.db.exec(statement);
      const result = await f.reply('ack');
      assert.deepEqual(result, { status: 'sent', deliveryId: DELIVERY, commandId, accountId: ACCOUNT, organizationId: ORG, generation: GENERATION });
      assert.deepEqual(await f.reply('ack'), result);
      assert.equal((await f.row(commandId)).state, 'SENT'); assert.equal((await f.row(commandId)).reply_body, null);
      await denied(f.reply('dispatch')); await denied(f.reply('claim'));
      assert.deepEqual(await sharedSnapshot(f.db), shared);
    });
  });
  for (const [key, value] of Object.entries({ accountId: FOREIGN, organizationId: FOREIGN, instanceId: FOREIGN,
    generation: FOREIGN, accountOwnerId: FOREIGN, ownUid: '789', loginRequestedAt: '2026-01-01T00:00:00Z', deliveryId: OTHER })) {
    await t.test(`ack never adopts a foreign stored ${key}`, async () => {
      await f.rollbackCase(async () => {
        const commandId = await f.prepare('ack'), before = await f.row(commandId);
        await denied(f.reply('ack', { [key]: value })); assert.deepEqual(await f.row(commandId), before);
      });
    });
  }
  await t.test('terminal delivery ID cannot be recycled to read another READY command', async () => {
    await f.rollbackCase(async () => {
      const first = await f.prepare('ack'); await f.reply('ack');
      const second = await f.ready('NEXT PRIVATE REPLY');
      await denied(f.reply('claim')); assert.equal((await f.row(second)).delivery_id, null);
      assert.equal((await f.reply('claim', { deliveryId: OTHER })).commandId, second);
      assert.equal((await f.row(first)).state, 'SENT');
    });
  });
});

test('reply expiry pruning clears private bodies without authorizing replay or losing a late delivery receipt', async t => {
  const f = await replyFixture(t);
  for (const [phase, state] of [['claim', 'EXPIRED'], ['dispatch', 'EXPIRED'], ['ack', 'UNKNOWN_EFFECT']]) {
    await t.test(`prunes ${phase} to ${state} while preserving provider-message dedup`, async () => {
      await f.rollbackCase(async () => {
        const commandId = await f.prepare(phase), before = await f.row(commandId);
        await f.expire(commandId);
        if (phase === 'claim') assert.deepEqual(await f.reply('claim'), { status: 'empty' });
        else await denied(f.reply('dispatch'));
        assert.deepEqual(await f.prune(1), { status: 'pruned', count: 1 });
        const after = await f.row(commandId);
        assert.equal(after.state, state); assert.equal(after.body, null); assert.equal(after.reply_body, null);
        assert.equal(after.provider_message_id, before.provider_message_id); assert.equal(after.delivery_id, before.delivery_id);
        assert.deepEqual(await f.prune(), { status: 'pruned', count: 0 });
        assert.deepEqual(await f.reply('claim', { deliveryId: OTHER }), { status: 'empty' });
        await denied(f.call({ providerMessageId: before.provider_message_id }));
        if (phase === 'ack') {
          const late = await f.reply('ack'); assert.equal(late.status, 'sent'); assert.equal(late.commandId, commandId);
          assert.deepEqual(await f.reply('ack'), late);
          assert.equal((await f.row(commandId)).state, 'SENT'); assert.equal((await f.row(commandId)).body, null);
          await denied(f.reply('dispatch')); await denied(f.reply('claim'));
        } else await denied(f.reply('ack'));
      });
    });
  }
});
