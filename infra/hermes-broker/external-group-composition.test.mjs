import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createBroker } from './broker.mjs';
import { createMcpHttpServer } from './mcp-http.mjs';
import { createExternalGroupMount, EXTERNAL_GROUP_TOOLS } from './external-group-mount.mjs';
import { createGroupPreviewMount } from './group-preview-mount.mjs';
import { createRoomReadService, createSupabaseRoomReads } from './room-read-service.mjs';
import { setupMount, token } from './group-preview-fixture.mjs';
import { installGroupSendSql } from '../hermes-zalo-router/group-send-sql-fixture.mjs';
import { splitSqlStatements } from '../../scripts/network-center-function-bodies.mjs';
import { USER, SESSION, ORG, FOREIGN, INSTANCE, CONNECTION, ACCOUNT } from '../hermes-zalo-router/private-command-fixture.mjs';

const migration = name => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8');
const sql = migration('20261014000538_hermes_external_group_connector_v1');
const functions = splitSqlStatements(sql).filter(s => /CREATE OR REPLACE FUNCTION/.test(s));
const REQUEST = '34567890-1234-4567-8123-123456789abc', OTHER_GROUP = '45678901-1234-4567-8123-123456789abc';
const decode = value => { assert.equal(value.isError, false); return JSON.parse(value.content[0].text); };
const code = expected => error => error.code === expected;

// Real broker, encrypted store, fixed adapters and complete forward SQL execute
// together. HTTPS/Auth/CRM facts are explicit synthetic ports: not production
// JWT, PostgREST, provider delivery or concurrent PostgreSQL evidence.
test('external MCP uses its real connection origin through preview, queue and provider admission', { timeout: 60000 }, async t => {
  const hooks = {}, x = await setupMount(t, hooks), { f } = x, db = f.db;
  const queue = await installGroupSendSql(x);
  await db.exec(migration('20261013095000_hermes_zalo_private_reply_v1'));
  await db.exec(migration('20261014000503_hermes_optional_org_policy_v1'));
  const catalog = () => db.query(`SELECT p.proname,p.prosrc,p.provolatile,p.proowner,p.proacl,p.proconfig
    FROM pg_proc p WHERE p.proname LIKE 'hermes_external_group_%' OR p.proname IN ('hermes_group_assert_dispatch_v1','hermes_group_preview_from_context_v1') ORDER BY p.proname`);
  await db.exec(sql); const first = await catalog(); await db.exec(sql); assert.deepEqual(await catalog(), first);
  await db.exec(`DELETE FROM app_private.hermes_org_policies; DELETE FROM app_private.hermes_zalo_private_commands;
    INSERT INTO public.zalo_conversations(id,account_id,organization_id,thread_type,thread_id,peer_name,user_id)
      VALUES('${OTHER_GROUP}','${ACCOUNT}','${ORG}','group','988','Other synthetic group','${FOREIGN}')`);
  let beforeWrite, loseReply = false, sendCalls = 0, lastRequest;
  const specs = Object.fromEntries(['directory', 'preview_decision', 'send', 'send_status'].map(operation =>
    [`hermes_external_group_${operation}_v1`, `SELECT public.hermes_external_group_${operation}_v1($1::jsonb) result`]));
  hooks.beforeFetch = async (url, options) => {
    const u = new URL(url), name = u.pathname.slice('/rest/v1/rpc/'.length), statement = specs[name];
    if (!statement) return;
    assert.equal(u.origin, 'https://example.invalid'); assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.apikey, 'sb_publishable_test');
    await x.baseAuth.verifySession({ accessToken: options.headers.authorization.slice(7) });
    const args = JSON.parse(options.body); assert.deepEqual(Object.keys(args), ['p']);
    for (const key of ['commandId', 'claimId', 'body', 'userId', 'accountId', 'approval', 'publicFacts']) assert(!Object.hasOwn(args.p, key));
    assert.equal(Object.keys(args.p).length, name.includes('send_status') ? 9 : name.includes('directory') ? 8 : 13);
    if (name === 'hermes_external_group_send_v1') {
      sendCalls++; lastRequest = args.p; assert.equal(args.p.requestId, REQUEST);
      if (beforeWrite) await beforeWrite();
    }
    x.events.push(name);
    await db.exec('SAVEPOINT external_http; SET LOCAL ROLE authenticated');
    let result;
    try {
      await db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)", [USER, SESSION]);
      result = (await db.query(statement, [JSON.stringify(args.p)])).rows[0].result;
      await db.exec('RESET ROLE; RELEASE SAVEPOINT external_http');
    } catch (error) {
      await db.exec('ROLLBACK TO SAVEPOINT external_http; RELEASE SAVEPOINT external_http; RESET ROLE');
      return Response.json({ code: error.code, message: error.message, details: null, hint: null },
        { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 });
    }
    if (name === 'hermes_external_group_send_v1' && loseReply) throw new TypeError('synthetic lost SQL reply');
    return Response.json(result);
  };
  const roomReads = createRoomReadService({ authority: x.authority, connectionStore: x.connectionStore, crypto: x.crypto, auth: x.auth,
    reads: createSupabaseRoomReads(x.config) });
  const mount = createExternalGroupMount({ auth: x.auth, authority: x.authority, connectionStore: x.connectionStore, crypto: x.crypto,
    supabase: { url: x.config.url, publishableKey: x.config.publishableKey }, dependencyScope: x.scope, fetch: x.config.fetch });
  const create = () => createBroker({ authority: x.authority, roomReads, externalGroups: mount, dependencyScope: x.scope,
    audit: async event => x.events.push('audit:' + event.outcome), limits: { maxResultBytes: 65536 } });
  const selection = { ...x.selection, requestId: REQUEST };
  const send = broker => broker.callTool(token, 'crm_group_room_send', selection);
  const status = broker => broker.callTool(token, 'crm_group_send_status', { dispatchId: REQUEST });
  const rows = () => db.query(`SELECT q.id,q.user_id,q.payload,q.hermes_group_dispatch_id,m.sent_by,m.body,h.origin,h.command_id
    FROM public.zalo_send_queue q JOIN public.zalo_messages m ON m.id=q.message_id JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id`);
  const each = (name, work) => t.test(name, () => f.rollbackCase(async () => {
    beforeWrite = undefined; loseReply = false; sendCalls = 0; lastRequest = undefined; await x.reset(); await work();
  }));

  await each('directory, preview, send and status work with no DM command, Copilot flag or organization policy', async () => {
    const broker = create(), tools = (await broker.listTools(token)).tools;
    assert.deepEqual(tools.map(tool => tool.name), ['crm_available_rooms', ...EXTERNAL_GROUP_TOOLS.map(tool => tool.name)]);
    assert(tools.find(tool => tool.name === 'crm_group_room_send').inputSchema.required.includes('requestId'));
    const directory = decode(await broker.callTool(token, 'crm_group_directory', {}));
    assert.equal(directory.conversations.length, 2);
    const preview = decode(await broker.callTool(token, 'crm_group_room_preview', x.selection));
    assert.equal(preview.status, 'preview_only'); assert.match(preview.display.body, /5\.000\.000 đ\/tháng/);
    assert.equal((await rows()).rows.length, 0);
    const ack = decode(await send(broker)); assert.equal(ack.dispatchId, REQUEST); assert.equal(ack.status, 'queued');
    const stored = (await rows()).rows; assert.equal(stored.length, 1); assert.equal(stored[0].origin, 'external_mcp'); assert.equal(stored[0].command_id, null);
    assert.equal(stored[0].user_id, FOREIGN); assert.equal(stored[0].sent_by, USER); assert.equal(stored[0].body, stored[0].payload.body);
    assert.equal(stored[0].body, preview.display.body);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_private.hermes_zalo_private_commands')).rows[0].n, 0);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_private.hermes_org_policies')).rows[0].n, 0);
    assert(x.events.indexOf('audit:prepared') < x.events.indexOf('hermes_external_group_send_v1'));
    const current = decode(await status(broker)); assert.equal(current.status, 'dispatch_status'); assert.deepEqual(current.recipients, ack.recipients);
    for (const secret of [token, x.CLAIM, CONNECTION, stored[0].id, 'SYNTHETIC_PRIVATE_REFRESH']) assert(!JSON.stringify([directory, preview, ack, current]).includes(secret));
    await db.exec('SET CONSTRAINTS ALL IMMEDIATE');
  });
  await each('same requestId deduplicates; changed selection and additional authority fields reject', async () => {
    const broker = create(), firstAck = decode(await send(broker));
    assert.deepEqual(decode(await send(broker)), firstAck); assert.equal((await rows()).rows.length, 1);
    await assert.rejects(broker.callTool(token, 'crm_group_room_send', { ...selection, conversationIds: [OTHER_GROUP] }), code('context_changed'));
    for (const args of [x.selection, { ...selection, commandId: x.baseline.commandId }, { ...selection, requestId: 'not-a-uuid' }])
      await assert.rejects(broker.callTool(token, 'crm_group_room_send', args), code('invalid_request'));
    assert.equal((await rows()).rows.length, 1);
  });
  await each('a requestId already owned by another actor is a definite collision with zero new jobs', async () => {
    await db.query(`INSERT INTO app_private.hermes_group_dispatches(id,user_id,organization_id,origin,request_id,request,snapshot,body,payload_digest,expires_at)
      VALUES($1,$2,$2,'external_mcp',$1,'{}','{}','other actor',sha256(convert_to('fixture','UTF8')),clock_timestamp()+interval '5 minutes')`, [REQUEST, FOREIGN]);
    await assert.rejects(send(create()), code('context_changed')); assert.equal(sendCalls, 1);
    assert.equal((await rows()).rows.length, 0);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_private.hermes_group_dispatches')).rows[0].n, 1);
  });
  await each('real MCP HTTP initialize/list/call serializes the same directory, preview, queue and status', async () => {
    const server = createMcpHttpServer({ broker: create() });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      let sequence = 0;
      const call = async (method, params) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, ...(params ? { params } : {}) }) });
        assert.equal(response.status, 200); const message = await response.json(); assert.equal(message.jsonrpc, '2.0');
        assert.equal(message.id, sequence); assert(!message.error); return message.result;
      };
      assert.equal((await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } })).protocolVersion, '2025-03-26');
      assert((await call('tools/list')).tools.some(tool => tool.name === 'crm_group_room_send'));
      const tool = (name, args) => call('tools/call', { name, arguments: args });
      assert.equal(decode(await tool('crm_group_directory', {})).conversations.length, 2);
      assert.equal(decode(await tool('crm_group_room_preview', x.selection)).status, 'preview_only');
      assert.equal(decode(await tool('crm_group_room_send', selection)).dispatchId, REQUEST);
      assert.equal(decode(await tool('crm_group_send_status', { dispatchId: REQUEST })).recipients[0].status, 'queued');
      assert.equal(sendCalls, 1); assert.equal((await rows()).rows.length, 1);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  await each('lost SQL response stays unknown and the stable ID recovers through status with no second write', async () => {
    const broker = create(); loseReply = true;
    await assert.rejects(send(broker), error => error.code === 'send_outcome_unknown' && error.dispatchId === REQUEST);
    assert.equal((await rows()).rows.length, 1); assert.equal(decode(await status(broker)).recipients[0].status, 'queued');
    assert.equal(sendCalls, 1);
  });
  await each('CRM read-only users can discover, preview and read status but cannot send', async () => {
    const broker = create(); await send(broker); await db.exec('UPDATE public.fixture_authority SET send_zalo=false');
    assert(!(await broker.listTools(token)).tools.some(tool => tool.name === 'crm_group_room_send'));
    assert.equal(decode(await broker.callTool(token, 'crm_group_room_preview', x.selection)).status, 'preview_only');
    assert.equal(decode(await status(broker)).recipients[0].status, 'queued');
    await assert.rejects(send(broker), code('tool_not_available')); assert.equal(sendCalls, 1);
  });
  await each('revocation after broker checks is rejected by real SQL with no effect', async () => {
    beforeWrite = () => db.exec('UPDATE public.fixture_authority SET send_zalo=false');
    await assert.rejects(send(create()), code('context_changed')); assert.equal(sendCalls, 1);
    assert.equal((await rows()).rows.length, 0);
    assert.equal((await db.query('SELECT count(*)::int n FROM app_private.hermes_group_dispatches')).rows[0].n, 0);
  });
  for (const [name, statement] of [
    ['read revoked', 'UPDATE public.fixture_authority SET view_zalo=false'],
    ['room right revoked', 'UPDATE public.fixture_authority SET rooms=false'],
    ['membership revoked', "UPDATE public.organization_memberships SET status='REVOKED'"],
    ['connection action removed', "UPDATE app_private.hermes_connections SET action_capabilities='{}'"],
    ['sender revoked', "UPDATE app_private.hermes_zalo_bindings SET state='REVOKED',revoked_at=clock_timestamp()"],
    ['sender login changed', 'UPDATE public.zalo_accounts SET login_requested_at=clock_timestamp()'],
    ['room price changed', 'UPDATE public.rooms SET rent_price=1'],
  ]) await each(`provider rechecks ${name} before any delivery claim`, async () => {
    await send(create()); const job = (await rows()).rows[0].id;
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job]);
    await db.exec(statement); await assert.rejects(queue.provider(job, { ownUid: '1'.repeat(40) }));
    assert.equal((await db.query('SELECT provider_started_at FROM public.zalo_send_queue WHERE id=$1', [job])).rows[0].provider_started_at, null);
  });
  await each('same queue fences provider payloads and admits the external origin exactly once', async () => {
    await send(create()); const job = (await rows()).rows[0].id;
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job]);
    assert.equal(await queue.provider(job, {}, true), false);
    assert.equal(await queue.provider(job, { body: 'tampered', ownUid: '1'.repeat(40) }), false);
    assert.equal(await queue.provider(job, { ownUid: '1'.repeat(40) }), true);
    assert.equal(await queue.provider(job, { ownUid: '1'.repeat(40) }), false);
    await assert.rejects(send(create()), code('context_changed')); assert.equal((await rows()).rows.length, 1);
  });
  await each('current session, owner and sender guards deny direct SQL misuse', async () => {
    await send(create()); const binding = Object.fromEntries(Object.entries(lastRequest).filter(([key]) => !['roomIds', 'conversationIds', 'expectedContextVersion', 'intentDigest', 'roomReadDigest'].includes(key)));
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [FOREIGN]);
    await assert.rejects(f.rpc('public.hermes_external_group_directory_v1', binding, 'authenticated'), code('42501'));
    await assert.rejects(f.rpc('public.hermes_external_group_send_status_v1', { ...binding, dispatchId: REQUEST }, 'authenticated'), code('42501'));
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)", [USER, FOREIGN]);
    await assert.rejects(f.rpc('public.hermes_external_group_directory_v1', binding, 'authenticated'), code('42501'));
    await db.query("SELECT set_config('request.jwt.claim.session',$1,true)", [SESSION]);
    await db.exec("UPDATE app_private.hermes_zalo_bindings SET state='REVOKED',revoked_at=clock_timestamp()");
    await assert.rejects(f.rpc('public.hermes_external_group_directory_v1', binding, 'authenticated'), code('42501'));
  });
  await each('two active sender bindings deny instead of selecting the first account', async () => {
    const other = '56789012-1234-4567-8123-123456789abc';
    await db.exec(`
      INSERT INTO public.zalo_accounts SELECT (jsonb_populate_record(NULL::public.zalo_accounts,to_jsonb(a)||jsonb_build_object('id','${other}'))).* FROM public.zalo_accounts a WHERE id='${ACCOUNT}';
      INSERT INTO app_private.hermes_zalo_bots SELECT (jsonb_populate_record(NULL::app_private.hermes_zalo_bots,to_jsonb(b)||jsonb_build_object('account_id','${other}'))).* FROM app_private.hermes_zalo_bots b WHERE account_id='${ACCOUNT}';
      INSERT INTO public.zalo_conversations SELECT (jsonb_populate_record(NULL::public.zalo_conversations,to_jsonb(c)||jsonb_build_object('id','${other}','account_id','${other}'))).* FROM public.zalo_conversations c WHERE account_id='${ACCOUNT}' AND thread_type='user' LIMIT 1;
      INSERT INTO public.zalo_messages SELECT (jsonb_populate_record(NULL::public.zalo_messages,to_jsonb(m)||jsonb_build_object('id','${other}','account_id','${other}','conversation_id','${other}','zalo_raw',jsonb_build_object('uidFrom','456','idTo','123')))).* FROM public.zalo_messages m WHERE account_id='${ACCOUNT}' AND direction='in' LIMIT 1;
      INSERT INTO app_private.hermes_zalo_link_challenges SELECT (jsonb_populate_record(NULL::app_private.hermes_zalo_link_challenges,to_jsonb(c)||jsonb_build_object('id','${other}','account_id','${other}','conversation_id','${other}','message_id','${other}','challenge_digest',repeat('d',64)))).* FROM app_private.hermes_zalo_link_challenges c LIMIT 1;
      INSERT INTO app_private.hermes_zalo_bindings SELECT (jsonb_populate_record(NULL::app_private.hermes_zalo_bindings,to_jsonb(b)||jsonb_build_object('id','${other}','account_id','${other}','conversation_id','${other}','challenge_id','${other}'))).* FROM app_private.hermes_zalo_bindings b LIMIT 1;
    `);
    await assert.rejects(create().callTool(token, 'crm_group_directory', {}), code('forbidden'));
    await assert.rejects(send(create()), code('forbidden')); assert.equal(sendCalls, 0); assert.equal((await rows()).rows.length, 0);
  });
  await each('ACL and volatility remain fixed across migration replay', async () => {
    for (const operation of ['directory', 'preview_decision', 'send', 'send_status']) {
      const signature = `public.hermes_external_group_${operation}_v1(jsonb)`;
      for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor'])
        assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed, role === 'authenticated');
      const meta = (await db.query('SELECT provolatile,prosecdef,proconfig,proowner::regrole::text owner FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0];
      assert.equal(meta.provolatile, 'v'); assert.equal(meta.prosecdef, true); assert.equal(meta.owner, 'postgres'); assert.deepEqual(meta.proconfig, ['search_path=pg_catalog, public, app_private']);
    }
    for (const name of ['hermes_external_group_context_v1(jsonb)', 'hermes_external_group_current_v1(jsonb)', 'hermes_group_preview_from_context_v1(jsonb,jsonb)'])
      for (const role of ['anon', 'authenticated', 'service_role', 'hermes_store_executor'])
        assert.equal((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, 'app_private.' + name])).rows[0].allowed, false);
  });
  await each('authorization mutation is caught by the same revoked-before-write invariant', async () => {
    const context = functions.find(s => s.includes('CREATE OR REPLACE FUNCTION app_private.hermes_external_group_context_v1('));
    const mutant = context.replace("IF v_auth.allowed AND 'chat_zalo.send'", "IF true AND 'chat_zalo.send'"); assert.notEqual(mutant, context);
    await db.exec(mutant); beforeWrite = () => db.exec('UPDATE public.fixture_authority SET send_zalo=false');
    // The production test expects this write to reject. This one changed SQL
    // predicate makes that exact assertion fail, proving the guard is observed.
    await assert.rejects(assert.rejects(send(create()), code('context_changed')), { code: 'ERR_ASSERTION' });
    assert.equal((await rows()).rows.length, 1);
  });
  await each('idempotency mutation is caught by the same changed-selection invariant', async () => {
    await send(create());
    const definition = functions.find(s => s.includes('CREATE OR REPLACE FUNCTION public.hermes_external_group_send_v1('));
    const mutant = definition.replace(/OR \(h\.request-ARRAY\['expectedContextVersion','intentDigest','roomReadDigest'\]\) IS DISTINCT FROM \(p-ARRAY\['expectedContextVersion','intentDigest','roomReadDigest'\]\)/,
      'OR false').replace('OR h.snapshot IS DISTINCT FROM v_snapshot', 'OR false'); assert.notEqual(mutant, definition);
    await db.exec(mutant);
    const changed = { ...lastRequest, conversationIds: [OTHER_GROUP] };
    await assert.rejects(assert.rejects(f.rpc('public.hermes_external_group_send_v1', changed, 'authenticated'), code('PT409')), { code: 'ERR_ASSERTION' });
    assert.equal((await rows()).rows.length, 1);
  });
  assert.equal(createHash('sha256').update(migration('20261014000538_hermes_external_group_connector_v1')).digest('hex'), createHash('sha256').update(sql).digest('hex'));
});

test('external forward SQL preserves the private command origin through the shared preview and provider helpers', { timeout: 60000 }, async t => {
  const hooks = {}, x = await setupMount(t, hooks), { f } = x, db = f.db;
  const queue = await installGroupSendSql(x);
  await db.exec(migration('20261013095000_hermes_zalo_private_reply_v1'));
  await db.exec(migration('20261014000503_hermes_optional_org_policy_v1'));
  await db.exec(sql); await db.exec('DELETE FROM app_private.hermes_org_policies');
  hooks.beforeFetch = async (url, options) => {
    const name = new URL(url).pathname.slice('/rest/v1/rpc/'.length);
    if (!['hermes_group_send_v1', 'hermes_group_send_status_v1'].includes(name)) return;
    await x.baseAuth.verifySession({ accessToken: options.headers.authorization.slice(7) });
    const args = JSON.parse(options.body);
    await db.exec('SAVEPOINT private_http; SET LOCAL ROLE authenticated');
    try {
      await db.query("SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.session',$2,true)", [USER, SESSION]);
      const result = name === 'hermes_group_send_v1' ?
        (await db.query('SELECT public.hermes_group_send_v1($1::jsonb) result', [JSON.stringify(args.p)])).rows[0].result :
        (await db.query('SELECT public.hermes_group_send_status_v1($1::uuid) result', [args.p_dispatch_id])).rows[0].result;
      await db.exec('RESET ROLE; RELEASE SAVEPOINT private_http'); return Response.json(result);
    } catch (error) {
      await db.exec('ROLLBACK TO SAVEPOINT private_http; RELEASE SAVEPOINT private_http; RESET ROLE');
      return Response.json({ code: error.code, message: error.message, details: null, hint: null }, { status: error.code === '42501' ? 403 : error.code === 'PT409' ? 409 : 400 });
    }
  };
  const roomReads = createRoomReadService({ authority: x.authority, connectionStore: x.connectionStore, crypto: x.crypto, auth: x.auth, reads: createSupabaseRoomReads(x.config) });
  const groupPreviews = createGroupPreviewMount({ auth: x.auth, authority: x.authority, connectionStore: x.connectionStore, crypto: x.crypto,
    supabase: { url: x.config.url, publishableKey: x.config.publishableKey }, dependencyScope: x.scope, fetch: x.config.fetch });
  const broker = createBroker({ authority: x.authority, roomReads, groupPreviews, dependencyScope: x.scope, limits: { maxResultBytes: 65536 } });
  await f.rollbackCase(async () => {
    await x.reset(); const context = { commandId: x.baseline.commandId, claimId: x.CLAIM }, options = { signal: new AbortController().signal };
    assert.equal((await broker.previewGroupRooms(token, context, x.selection, options)).status, 'preview_only');
    const ack = await broker.sendGroupRooms(token, context, x.selection, options);
    const stored = (await db.query('SELECT id,origin,command_id FROM app_private.hermes_group_dispatches')).rows[0];
    assert.equal(stored.origin, 'private_command'); assert.equal(stored.command_id, context.commandId); assert.equal(stored.id, ack.dispatchId);
    assert.deepEqual((await broker.groupSendStatus(token, context, ack.dispatchId, options)).recipients, ack.recipients);
    const job = (await db.query('SELECT id FROM public.zalo_send_queue')).rows[0].id;
    await db.query("UPDATE public.zalo_send_queue SET status='processing',processing_instance_id=$1 WHERE id=$2", [INSTANCE, job]);
    assert.equal(await queue.provider(job, { ownUid: '1'.repeat(40) }), true);
  });
});
