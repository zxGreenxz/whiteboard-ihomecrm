import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { createHermesBackend } from './server.mjs';
import { ProfileLeaseStore } from '../hermes-runtime/profile-lease.mjs';
import { createRuntimeOrchestrator } from '../hermes-runtime/runtime-orchestrator.mjs';
import { createProfileHomes } from '../hermes-runtime/profile-homes.mjs';

const HOST = 'broker.example:8443', ORIGIN = 'https://crm.example', NOW = 1_800_000_000_000;
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const I = { org: id(1), user: id(2), browser: id(3), assistantSession: id(4), assistant: id(5), connection: id(6), member: id(7), building: id(8), scope: id(9) };
const limits = () => ({ read: ['assistant.context.read'], action: [] });
const jwt = (sessionId, expiresAt = NOW + 3_600_000) => `header.${Buffer.from(JSON.stringify({ sub: I.user, role: 'authenticated', session_id: sessionId, exp: expiresAt / 1000 })).toString('base64url')}.signature`;
const browserJwt = jwt(I.browser), assistantJwt = jwt(I.assistantSession);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
const metadata = value => Object.fromEntries(['id', 'assistantId', 'organizationId', 'userId', 'state', 'epoch', 'restrictions', 'scopeIds']
  .map(key => [key, structuredClone(value[key])]));
function fakeBackend() {
  const calls = [], sql = [], audits = [], releases = [], key = randomBytes(32), privateOperations = new Map(), modelOperations = {}, providerOperations = {};
  const acceptedAssistantTokens = new Set([assistantJwt]);
  let joined, poolEnds = 0, prepareCount = 0, signInCount = 0, clock = NOW;
  const principal = { role: 'hermes_store_test', session_role: 'hermes_store_test', scoped: true, privileged_member: false,
    rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false };
  const pool = { async end() { poolEnds++; }, async connect() {
    let count = 0;
    return { async query(query) {
      sql.push(structuredClone(query));
      if (++count === 1) return { rows: [principal] };
      const operation = /^SELECT app_private\.hermes_store_(\w+)_v1\(\$1::jsonb\) AS result$/.exec(query.text)?.[1];
      assert(operation, 'fixed private store statement only'); assert.equal(query.queryMode, 'extended');
      const input = JSON.parse(query.values[0]); let result;
      if (operation === 'activate') {
        const connection = { id: I.connection, assistantId: I.assistant, organizationId: I.org, userId: I.user,
          state: 'active', epoch: 2, restrictions: limits(), scopeIds: [], tokenDigest: input.tokenDigest,
          credentialRef: input.credentialRef, expiresAt: input.tokenExpiresAt };
        joined = { status: 'active', connection, session: { credentialRef: input.credentialRef, revision: 1,
          envelope: input.sessionEnvelope, expiresAt: input.sessionExpiresAt,
          binding: { assistantId: I.assistant, organizationId: I.org, userId: I.user, sessionId: input.providerSessionId } },
        membership: { membershipId: I.member, authorizationVersion: 1, isSuperadmin: false }, policy: { version: 1, ...limits(), scopeIds: [] } };
        result = { ok: true, status: 'activated', connection: metadata(connection), credentialRef: input.credentialRef };
      } else if (operation === 'read_connection') {
        result = joined?.connection.state === 'active' && joined.connection.tokenDigest === input.tokenDigest ? joined : { status: 'unavailable' };
      } else if (operation === 'restrict_connection') {
        assert.equal(input.expectedEpoch, joined.connection.epoch); joined.connection.epoch++;
        joined.connection.restrictions = { read: input.read, action: input.action }; joined.connection.scopeIds = input.scopeIds;
        result = { ok: true, connection: metadata(joined.connection) };
      } else if (operation === 'revoke_connection') {
        assert.equal(input.expectedEpoch, joined.connection.epoch); joined.connection.epoch++; joined.connection.state = 'revoked';
        result = { ok: true, status: 'revoked' };
      } else if (operation === 'renew_connection') {
        assert.equal(input.expectedEpoch, joined.connection.epoch);
        assert.equal(input.expectedExpiresAt, joined.connection.expiresAt);
        assert.equal(input.expectedRevision, joined.session.revision);
        assert.equal(input.tokenDigest, joined.connection.tokenDigest);
        joined.connection.expiresAt = providerOperations.renewExpiry?.(input) ?? joined.connection.expiresAt + 1000;
        result = { ok: true, status: 'renewed', expiresAt: joined.connection.expiresAt };
      } else if (privateOperations.has(operation)) result = await privateOperations.get(operation)(input);
      else assert.fail('unexpected private operation');
      return { rows: [{ result: structuredClone(result) }] };
    }, release(destroy) { releases.push(destroy); } };
  } };
  const fetch = async (url, options) => {
    const endpoint = new URL(url); assert.equal(endpoint.origin, 'https://fixture.supabase.co');
    calls.push({ path: endpoint.pathname, options: { ...options } });
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    const bearer = options.headers.authorization?.replace(/^Bearer /, '');
    const args = options.body ? JSON.parse(options.body) : undefined;
    if (endpoint.pathname === '/auth/v1/token') {
      if (endpoint.search === '?grant_type=refresh_token') {
        assert(providerOperations.refresh, 'refresh must be explicitly arranged by this test');
        return providerOperations.refresh(args, options);
      }
      assert.equal(endpoint.search, '?grant_type=password'); assert.equal(args.password, 'synthetic-password'); signInCount++;
      return Response.json({ token_type: 'bearer', access_token: assistantJwt, refresh_token: 'SYNTHETIC-REFRESH-SECRET', user: { id: I.user } });
    }
    if (bearer !== browserJwt && !acceptedAssistantTokens.has(bearer)) return Response.json({ error: 'not authorized' }, { status: 401 });
    if (endpoint.pathname === '/functions/v1/llm-proxy/chat/completions') {
      assert.equal(bearer, assistantJwt); assert.equal(options.headers['x-organization-id'], I.org);
      assert.equal(options.headers['x-copilot-feature'], 'chat'); assert.match(options.headers['x-task-id'], /^[a-f0-9-]{36}$/);
      assert.equal(args.model, 'openai:fixture'); assert.equal(args.stream, false);
      if (modelOperations.respond) return modelOperations.respond(options);
      return Response.json({ id: 'fixture', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic answer' }, finish_reason: 'stop' }] });
    }
    if (endpoint.pathname === '/auth/v1/user') return Response.json({ id: I.user });
    if (['/rest/v1/rpc/hermes_group_action_context_v1', '/rest/v1/rpc/hermes_work_memory_capabilities_v1', '/rest/v1/rpc/hermes_room_schedule_capabilities_v1', '/rest/v1/rpc/hermes_domain_capabilities_v1', '/rest/v1/rpc/hermes_domain_capabilities_v2', '/rest/v1/rpc/hermes_room_pass_capabilities_v1', '/rest/v1/rpc/hermes_task_create_capabilities_v1', '/rest/v1/rpc/hermes_customer_create_capabilities_v1', '/rest/v1/rpc/hermes_expense_capabilities_v1', '/rest/v1/rpc/hermes_connection_options_v7', '/rest/v1/rpc/hermes_connection_context_v7', '/rest/v1/rpc/hermes_connection_options_v6', '/rest/v1/rpc/hermes_connection_context_v6', '/rest/v1/rpc/hermes_connection_options_v5', '/rest/v1/rpc/hermes_connection_context_v5', '/rest/v1/rpc/hermes_connection_options_v4', '/rest/v1/rpc/hermes_connection_context_v4', '/rest/v1/rpc/hermes_connection_options_v3', '/rest/v1/rpc/hermes_connection_context_v3', '/rest/v1/rpc/hermes_connection_options_v2', '/rest/v1/rpc/hermes_connection_context_v2'].includes(endpoint.pathname))
      return Response.json({ code: 'PGRST202', message: 'Synthetic optional RPC absent', details: null, hint: null }, { status: 404 });
    if (endpoint.pathname === '/rest/v1/rpc/get_authorization_context_v1') return Response.json({ organizationId: I.org,
      membershipId: I.member, authorizationVersion: 1, isPlatformAdmin: false, isOffboarded: false, permissions: { 'rooms.view': true } });
    if (endpoint.pathname === '/rest/v1/rpc/get_my_organizations') return Response.json({ user_id: I.user, organizations: [{ id: I.org }] });
    if (endpoint.pathname === '/rest/v1/rpc/hermes_scope_buildings_v1') {
      assert.equal(args.p_organization_id, I.org); assert.equal(args.p_permission_key, 'rooms.view'); return Response.json([I.building]);
    }
    if (endpoint.pathname === '/rest/v1/rpc/hermes_room_scope_map_v1') {
      assert.equal(bearer, assistantJwt); assert.equal(args.p_organization_id, I.org);
      assert.deepEqual(Object.keys(args).sort(), ['p_organization_id', 'p_scope_ids', 'p_connection_id', 'p_token_digest',
        'p_expected_epoch', 'p_expected_policy_version', 'p_expected_membership_id', 'p_expected_authorization_version', 'p_expected_session_revision'].sort());
      assert.deepEqual(args.p_scope_ids, [I.scope]); assert.equal(args.p_connection_id, I.connection);
      assert.equal(args.p_token_digest, joined.connection.tokenDigest); assert.equal(args.p_expected_membership_id, I.member);
      assert.equal(args.p_expected_authorization_version, 1); assert.equal(args.p_expected_session_revision, joined.session.revision);
      if (args.p_expected_policy_version !== joined.policy.version || args.p_expected_epoch !== joined.connection.epoch) {
        return Response.json({ code: 'PT409' }, { status: 409 });
      }
      return Response.json({ organizationId: I.org, complete: true,
        scopes: [{ id: I.scope, scopeType: 'BUILDING', buildingId: I.building, areaId: null, cashbookId: null }], areaBuildings: [],
        permissionBuildingIds: [I.building], binding: { connectionId: I.connection, epoch: joined.connection.epoch,
          policyVersion: joined.policy.version, membershipId: I.member, authorizationVersion: 1, sessionRevision: joined.session.revision } });
    }
    if (endpoint.pathname === '/rest/v1/rpc/hermes_sale_listing_rooms_v1') {
      assert.equal(bearer, assistantJwt); assert.deepEqual(args, { p_organization_id: I.org });
      const rawRoom = (roomId, buildingId) => ({ id: roomId, building_id: buildingId, code: '101', name: '101', floor: 1, area: 20,
        rent_price: 3000000, deposit_amount: 3000000, status_public: 'free', sale_state: null, sale_today: '2026-10-12',
        avail_date: null, expected_ready_on: null, contact: 'PRIVATE-CONTACT', note: 'PRIVATE-NOTE' });
      return Response.json({ pages: 1, buildings: [{ id: I.building, name: 'House A', code: 'A', note: 'PRIVATE-BUILDING-NOTE' },
        { id: id(80), name: 'Outside scope', code: 'X' }], rooms: [rawRoom(id(10), I.building), rawRoom(id(81), id(80))] });
    }
    assert.equal(bearer, browserJwt, 'management/prepare RPC uses browser session');
    if (endpoint.pathname === '/rest/v1/rpc/hermes_prepare_connection_v1') {
      prepareCount++; return Response.json({ id: I.connection, assistantId: I.assistant, userId: I.user, organizationId: I.org,
        state: 'pending', epoch: 1, restrictions: limits(), scopeIds: [], intentSecret: 'a'.repeat(64), intentExpiresAt: NOW + 300_000 });
    }
    if (endpoint.pathname === '/rest/v1/rpc/hermes_my_connections_v1') return Response.json(joined ? [metadata(joined.connection)] : []);
    if (endpoint.pathname === '/rest/v1/rpc/hermes_connection_context_v1') return Response.json({ ...metadata(joined.connection),
      membershipId: I.member, authorizationVersion: 1, isSuperadmin: false, policyVersion: 1,
      companyCeilings: limits(), effective: structuredClone(joined.connection.restrictions) });
    assert.fail('unexpected public RPC');
  };
  const configuration = { supabase: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' },
    store: { pool, expectedRole: 'hermes_store_test' }, encryption: { activeKeyVersion: 'fixture', keys: new Map([['fixture', key]]) },
    http: { allowedHosts: [HOST], allowedOrigins: [ORIGIN] }, fetch, clock: () => clock, audit: async event => { audits.push(structuredClone(event)); } };
  return { configuration, calls, sql, audits, releases, key, principal, pool, privateOperations, modelOperations, providerOperations, acceptedAssistantTokens,
    read: () => ({ joined, poolEnds, prepareCount, signInCount, clock }),
    nearSessionExpiry() { clock = NOW + 57 * 60000; joined.connection.expiresAt = clock + 120000; },
    grantRooms() { // A trusted fixture models an already-granted connection; browser connect remains default-off.
      joined.connection.restrictions.read.push('rooms.view'); joined.connection.scopeIds = [I.scope];
      joined.policy.read.push('rooms.view'); joined.policy.scopeIds = [I.scope]; joined.policy.version++;
    } };
}

// Real host HTTP handler + real composed authority/crypto/model adapters. Only
// Supabase/DB responses and the not-yet-deployed Docker transport are synthetic.
async function privateGateway(t, http, token) {
  let port, opened = 0, closed = 0;
  const options = { allowedModels: ['openai:fixture'], transport: { async open({ handler, signal }) {
    assert(signal instanceof AbortSignal); opened++;
    const server = createServer(handler);
    await new Promise(done => server.listen(0, '127.0.0.1', done)); port = server.address().port;
    return { descriptor: { networkName: 'fixture-private', networkId: 'a'.repeat(64), mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' },
      async close() { closed++; const stopped = new Promise(done => server.close(done)); server.closeAllConnections(); await stopped; } };
  } } };
  const gateway = http.createRuntimeGateway(options);
  assert.equal(http.createRuntimeGateway(options), gateway);
  assert.throws(() => http.createRuntimeGateway({ ...options }), /already_bound/);
  const home = path.resolve('.cache', 'synthetic-profile');
  const ticket = await gateway.register(token, { home, signal: new AbortController().signal });
  assert.deepEqual(ticket, {}); assert.equal(opened, 0);
  const handle = gateway.prepare({ home, assistantId: I.assistant, userId: I.user, organizationId: I.org });
  assert.equal(opened, 0); await gateway.start(handle, { signal: new AbortController().signal });
  t.after(() => gateway.shutdown());
  const send = (url, body) => new Promise((resolve, reject) => {
    const bytes = JSON.stringify(body);
    const req = httpRequest({ host: '127.0.0.1', port, path: url, method: 'POST', headers: { host: 'hermes-gateway:8787',
      'content-type': 'application/json', 'content-length': Buffer.byteLength(bytes) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, text, body: JSON.parse(text) }); });
    }); req.on('error', reject); req.end(bytes);
  });
  return { gateway, handle, send, read: () => ({ opened, closed }) };
}
async function listening(t, configuration) {
  const backend = createHermesBackend(configuration);
  assert.equal(backend.server.listening, false);
  await new Promise(done => backend.server.listen(0, '127.0.0.1', done));
  t.after(() => backend.close());
  const address = `http://127.0.0.1:${backend.server.address().port}`;
  const send = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const values = { host: HOST, origin: ORIGIN, authorization: `Bearer ${browserJwt}`, 'content-type': 'application/json', ...headers };
    for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
    const request = httpRequest(address + path, { method: 'POST', headers: values }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
        const text = Buffer.concat(chunks).toString(); resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined, text, headers: response.headers });
      }); response.on('error', reject);
    }); request.on('error', reject); request.end(JSON.stringify(body));
  });
  const browser = (operation, more = {}, headers) => send(`/api/hermes/connections/${operation}`, { organizationId: I.org, ...more }, headers);
  const connect = () => browser('connect', { email: 'synthetic@example.invalid', password: 'synthetic-password', restrictions: limits(), scopeIds: [] });
  const mcp = (token, method = 'tools/list', params, headers) => send('/mcp', { jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) },
    { authorization: `Bearer ${token}`, ...headers });
  return { ...backend, address, send, browser, connect, mcp };
}

test('construction does no I/O, requires explicit audit/config, exposes no private services and leaves caller pool/key ownership intact', async () => {
  const f = fakeBackend(), original = Buffer.from(f.key);
  for (const delta of [{ audit: undefined }, { supabase: { ...f.configuration.supabase, serviceRole: 'PRIVATE' } },
    { roomsEnabled: true }, { http: { ...f.configuration.http, allowedHosts: [] } },
    { store: { pool: f.pool, expectedRole: 'postgres' } }, { fetch: undefined }]) {
    assert.throws(() => createHermesBackend({ ...f.configuration, ...delta }), error => error.message === 'invalid_backend_config' && error.cause === undefined);
  }
  const backend = createHermesBackend(f.configuration);
  assert.deepEqual(Object.keys(backend), ['server', 'close', 'resolveConnection', 'renewConnection', 'createPrivateCommandRunner', 'createRuntimeGateway', 'createRuntimeSupervisor', 'beginConnectionMaintenance', 'beginExternalConnectionMaintenance', 'startWorkMemoryRetention', 'workMemoryRetentionStatus']); assert.equal(backend.server.listening, false);
  assert.equal(f.calls.length, 0); assert.equal(f.sql.length, 0); assert.equal(f.audits.length, 0);
  assert.equal(backend.server.requestTimeout, 15000); assert.equal(backend.server.headersTimeout, 10000); assert.equal(backend.server.maxHeadersCount, 32);
  const first = backend.close(); assert.equal(backend.close(), first); await first;
  assert.equal(f.read().poolEnds, 0); assert.deepEqual(f.key, original);
});

test('host-owned retention uses only its fixed executor and backend close waits actual SQL drain', async () => {
  const f = fakeBackend(), entered = deferred(), held = deferred(); let calls = 0;
  f.privateOperations.set('prune_work_memories', async input => { calls++; assert.deepEqual(input, { limit: 500 }); entered.resolve(); await held.promise; return { pruned: 0 }; });
  const backend = createHermesBackend(f.configuration);
  backend.startWorkMemoryRetention(); backend.startWorkMemoryRetention(); await entered.promise;
  assert.equal(calls, 1); assert.equal(backend.workMemoryRetentionStatus().state, 'running');
  let closed = false; const close = backend.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  held.resolve(); await close; assert.equal(backend.workMemoryRetentionStatus().state, 'closed');
  assert.equal(f.calls.length, 0); assert.equal(calls, 1); assert.equal(f.read().poolEnds, 0);
});

test('private gateway composes real model authority and existing llm-proxy without a public model route or runtime credential', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), token = (await http.connect()).body.token;
  const runtime = await privateGateway(t, http, token);
  const context = await runtime.send('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'crm_auth_context', arguments: {} } });
  assert.equal(context.status, 200); assert.equal(context.body.result.isError, false);
  const identity = JSON.parse(context.body.result.content[0].text);
  assert.equal(identity.userId, I.user); assert.equal(identity.organizationId, I.org); assert.equal(identity.assistantId, I.assistant);
  const body = { model: 'openai:fixture', messages: [{ role: 'user', content: 'Synthetic question' }], max_tokens: 128 };
  assert.equal((await runtime.send('/v1/chat/completions', body)).status, 403);
  assert.equal(f.calls.filter(call => call.path.includes('llm-proxy')).length, 0);
  runtime.gateway.setAdmission(runtime.handle, true); runtime.gateway.beginTurn(runtime.handle, { commandId: id(50) });
  const answer = await runtime.send('/v1/chat/completions', body);
  assert.equal(answer.status, 200); assert.equal(answer.body.choices[0].message.content, 'Synthetic answer');
  const calls = f.calls.filter(call => call.path.includes('llm-proxy'));
  assert.equal(calls.length, 1); assert.equal(calls[0].options.headers.authorization, `Bearer ${assistantJwt}`);
  for (const secret of [token, assistantJwt, 'SYNTHETIC-REFRESH-SECRET']) assert(!answer.text.includes(secret));
  assert.equal((await runtime.send('/v1/chat/completions', body)).status, 409);
  assert.equal(f.calls.filter(call => call.path.includes('llm-proxy')).length, 1);
  await runtime.gateway.endTurn(runtime.handle, { commandId: id(50) });
  assert.equal((await http.send('/v1/chat/completions', body)).status, 404);
  await http.close(); assert.deepEqual(runtime.read(), { opened: 1, closed: 1 });
});

test('private model result is withheld after connection revocation and the same profile cannot issue another paid request', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), token = (await http.connect()).body.token;
  const runtime = await privateGateway(t, http, token);
  f.modelOperations.respond = () => {
    f.read().joined.connection.state = 'revoked';
    return Response.json({ id: 'fixture', object: 'chat.completion', choices: [{ index: 0,
      message: { role: 'assistant', content: 'PRIVATE-STALE-ANSWER' }, finish_reason: 'stop' }] });
  };
  runtime.gateway.setAdmission(runtime.handle, true); runtime.gateway.beginTurn(runtime.handle, { commandId: id(51) });
  const body = { model: 'openai:fixture', messages: [{ role: 'user', content: 'Synthetic question' }], max_tokens: 128 };
  const result = await runtime.send('/v1/chat/completions', body);
  assert(result.status >= 400); assert(!result.text.includes('PRIVATE-STALE-ANSWER'));
  assert((await runtime.send('/v1/chat/completions', { ...body, temperature: 0.2 })).status >= 400);
  assert.equal(f.calls.filter(call => call.path.includes('llm-proxy')).length, 1);
  await runtime.gateway.endTurn(runtime.handle, { commandId: id(51) });
});

test('trusted supervisor resolves live owner without exposing credentials, permissions or a public identity route', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration);
  const created = await http.connect(), token = created.body.token;
  const options = { signal: new AbortController().signal };
  const owner = await http.resolveConnection(token, options);
  assert.deepEqual(owner, { connectionId: I.connection, assistantId: I.assistant, userId: I.user,
    organizationId: I.org, expiresAt: f.read().joined.connection.expiresAt });
  assert(Object.isFrozen(owner));
  await assert.rejects(http.resolveConnection(token), { code: 'invalid_request' });
  await assert.rejects(http.resolveConnection(browserJwt, options), { code: 'unauthorized' });
  assert.equal((await http.send('/api/hermes/connections/resolve', {})).status, 404);
  const list = await http.mcp(token);
  assert(!list.body.result.tools.some(tool => /resolve|renew/i.test(tool.name)));
  f.read().joined.connection.state = 'revoked';
  await assert.rejects(http.resolveConnection(token, options), { code: 'unauthorized' });
  await http.close();
  await assert.rejects(http.resolveConnection(token, options), { code: 'backend_unavailable' });
});

test('supervisor identity reads share bounded admission and close cancels late output', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration);
  const token = (await http.connect()).body.token, started = deferred(), held = deferred();
  const originalConnect = f.pool.connect;
  f.pool.connect = async () => {
    started.resolve(); await held.promise; return originalConnect.call(f.pool);
  };
  const reads = Array.from({ length: 16 }, () => http.resolveConnection(token, { signal: new AbortController().signal }));
  // Attach rejection handlers before close; no late promise rejection is hidden.
  const results = Promise.allSettled(reads);
  await started.promise;
  await assert.rejects(http.resolveConnection(token, { signal: new AbortController().signal }), { code: 'busy' });
  assert.equal((await http.browser('list')).status, 429);
  const closed = http.close(); held.resolve(); await closed;
  const values = await results;
  assert(values.every(value => value.status === 'rejected'));
  assert.equal(f.read().poolEnds, 0);
});

test('trusted resolver retains startup ownership and admission after transport abort until actual pool work drains', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), token = (await http.connect()).body.token;
  const entered = deferred(), held = deferred(), original = f.pool.connect, controller = new AbortController();
  f.pool.connect = async () => { entered.resolve(); await held.promise; return original.call(f.pool); };
  let settled = 0;
  const reads = Array.from({ length: 16 }, () => http.resolveConnection(token, { signal: controller.signal }).then(
    () => { settled++; }, () => { settled++; }));
  try {
    await entered.promise; controller.abort(); await tick();
    assert.equal(settled, 0, 'a public adapter abort must not release startup ownership');
    await assert.rejects(http.resolveConnection(token, { signal: new AbortController().signal }), { code: 'busy' });
  } finally { held.resolve(); await Promise.all(reads); await http.close(); }
  assert.equal(settled, 16); assert.equal(f.read().poolEnds, 0);
});

test('real composed constructors serve connect, durable MCP authority and management over HTTP using one encrypted backend core', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration);
  const created = await http.connect(); assert.equal(created.status, 200); const token = created.body.token;
  assert.match(token, /^hc_[A-Za-z0-9_-]{43}$/); assert.equal(f.read().signInCount, 1); assert.equal(f.read().prepareCount, 1);
  assert.equal((await http.browser('list')).body.connections[0].id, I.connection);
  assert.equal((await http.browser('context', { connectionId: I.connection })).body.context.membershipId, I.member);
  const listed = await http.mcp(token); assert.equal(listed.status, 200); assert.deepEqual(listed.body.result.tools.map(tool => tool.name), ['crm_auth_context']);
  const called = await http.mcp(token, 'tools/call', { name: 'crm_auth_context', arguments: {} });
  assert.equal(called.body.result.isError, false);
  const identity = JSON.parse(called.body.result.content[0].text); assert.equal(identity.userId, I.user); assert.equal(identity.organizationId, I.org);
  assert.deepEqual(identity.permissions, limits());
  const forbidden = await http.mcp(token, 'tools/call', { name: 'phong_trong', arguments: {} }); assert.equal(forbidden.body.result.isError, true);
  assert(!f.calls.some(call => call.path.includes('copilot_available_rooms') || call.path.includes('hermes_room_scope_map')));
  const restricted = await http.browser('restrict', { connectionId: I.connection, expectedEpoch: 2, restrictions: { read: [], action: [] }, scopeIds: [] });
  assert.equal(restricted.status, 200); assert.deepEqual((await http.mcp(token)).body.result.tools, []);
  assert.equal((await http.browser('revoke', { connectionId: I.connection, expectedEpoch: 3 })).status, 200);
  assert.equal((await http.mcp(token)).status, 401);
  assert(f.audits.length > 0); const serialized = JSON.stringify(f.sql) + JSON.stringify(f.audits) + created.text + called.text;
  for (const secret of [browserJwt, assistantJwt, 'SYNTHETIC-REFRESH-SECRET', 'synthetic-password']) assert(!serialized.includes(secret));
  assert.equal(f.read().joined.session.binding.sessionId, I.assistantSession);
  assert.equal(f.read().joined.session.envelope.algorithm, 'A256GCM'); assert(f.releases.every(value => value === false));
});

test('trusted supervisor renewal uses composed authority/store, is absent from public routes, and stops after revoke/close', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration);
  const created = await http.connect(), token = created.body.token, before = f.read().joined.connection.expiresAt;
  const result = await http.renewConnection(token, { signal: new AbortController().signal });
  assert.deepEqual(result, { ok: true, status: 'renewed', connectionId: I.connection, expiresAt: before + 1000, reconciled: false });
  assert.equal((await http.mcp(token)).status, 200);
  assert.equal((await http.browser('renew')).status, 404);
  assert.equal((await http.send('/internal/hermes/connection/renew', {}, { authorization: `Bearer ${token}` })).status, 404);
  assert(!JSON.stringify(result).includes(token));
  await assert.rejects(http.renewConnection(browserJwt, { signal: new AbortController().signal }), value => value.code === 'invalid_request');
  assert.equal((await http.browser('revoke', { connectionId: I.connection, expectedEpoch: 2 })).status, 200);
  await assert.rejects(http.renewConnection(token, { signal: new AbortController().signal }), value => value.code === 'unauthorized');
  await http.close();
  await assert.rejects(http.renewConnection(token, { signal: new AbortController().signal }), value => value.code === 'backend_closed');
  assert.equal(f.sql.filter(query => query.text?.includes('hermes_store_renew_connection_v1')).length, 1);
});

test('shared outer transport gate fences exact host ports, origins, encoding and auth namespaces on both endpoint families', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration);
  for (const path of ['/mcp', '/api/hermes/connections/list', '/api/hermes/zalo/list', '/unknown']) {
    for (const headers of [{ host: 'broker.example' }, { host: 'broker.example:443' }, { host: 'evil.example', 'x-forwarded-host': HOST }, { origin: 'https://evil.example' }]) {
      const response = await http.send(path, {}, headers); assert.equal(response.status, 403);
      assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
    }
    assert.equal((await http.send(path, {}, { 'content-encoding': 'gzip' })).status, 415);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.sql.length, 0);
  const created = await http.connect(), token = created.body.token;
  assert.equal((await http.mcp(browserJwt)).status, 401);
  assert.equal((await http.browser('list', {}, { authorization: `Bearer ${token}` })).status, 401);
  assert.equal((await http.browser('connect', { email: 'synthetic@example.invalid', password: 'synthetic-password', restrictions: limits(), scopeIds: [] }, { origin: undefined })).status, 403);
  assert.equal((await http.mcp(token, 'tools/list', undefined, { origin: undefined })).status, 200);
  assert.equal((await http.send('/mcp?token=synthetic', {})).status, 404);
  assert.equal(f.read().signInCount, 1);
});

test('duplicate Host/Authorization cannot be normalized into either transport before the outer gate', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration);
  for (const path of ['/mcp', '/api/hermes/connections/list']) {
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(http.address + path, { method: 'POST', headers: ['Host', HOST, 'Origin', ORIGIN,
        'Authorization', `Bearer ${browserJwt}`, 'Authorization', 'Bearer attacker.jwt.token', 'Content-Type', 'application/json'] }, res => {
        const parts = []; res.on('data', part => parts.push(part)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) }));
      }); request.on('error', reject); request.end('{}');
    });
    assert.equal(response.status, 400); assert.equal(response.body.error, 'duplicate_header');
  }
  assert.equal(f.calls.length, 0); assert.equal(f.sql.length, 0);
});

test('private pool principal failure prevents SQL activation and returned HTTP error never exposes backend details', async t => {
  const f = fakeBackend(); f.principal.session_role = 'postgres';
  const http = await listening(t, f.configuration), response = await http.connect();
  assert.equal(response.status, 503); assert.equal(response.body.error, 'activation_outcome_unknown');
  assert.equal(f.sql.length, 1); assert.equal(f.read().joined, undefined); assert.deepEqual(f.releases, [true]);
  for (const secret of ['postgres', 'SELECT', browserJwt, assistantJwt, 'SYNTHETIC-REFRESH-SECRET']) assert(!response.text.includes(secret));
});

test('closing during browser sign-in aborts that pipeline, dispatches no later prepare/activation and does not end the caller pool', async t => {
  const f = fakeBackend(), wait = deferred(), entered = deferred(); const original = f.configuration.fetch;
  let signal;
  f.configuration.fetch = async (url, options) => {
    if (new URL(url).pathname === '/auth/v1/token') { signal = options.signal; entered.resolve(); return wait.promise; }
    return original(url, options);
  };
  const http = await listening(t, f.configuration), response = http.connect().catch(error => ({ error }));
  await entered.promise; await http.close(); assert(signal.aborted);
  assert((await response).error); wait.resolve(Response.json({ token_type: 'bearer', access_token: assistantJwt, refresh_token: 'synthetic', user: { id: I.user } }));
  await tick(); assert.equal(f.read().prepareCount, 0); assert.equal(f.sql.length, 0); assert.equal(f.read().poolEnds, 0);
});

test('closing MCP stops delivery but waits for bounded broker work rather than claiming caller cancellation', async t => {
  const f = fakeBackend(), entered = deferred(), wait = deferred();
  f.configuration.audit = async event => { f.audits.push(event); entered.resolve(); await wait.promise; };
  const http = await listening(t, f.configuration), created = await http.connect();
  const response = http.mcp(created.body.token).catch(error => ({ error })); await entered.promise;
  let closed = false; const closing = http.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); wait.resolve(); await closing;
  assert((await response).error); assert.equal(f.read().poolEnds, 0);
});

test('composed room tool uses the encrypted assistant JWT, fixed scope/data RPCs and a final decision after audit', async t => {
  const f = fakeBackend(), order = []; const original = f.configuration.fetch;
  f.configuration.fetch = async (url, options) => { order.push(new URL(url).pathname.split('/').at(-1)); return original(url, options); };
  f.configuration.audit = async event => { f.audits.push(event); order.push(`audit:${event.outcome}`); };
  const http = await listening(t, f.configuration), created = await http.connect(), token = created.body.token;
  assert.equal((await http.mcp(token, 'tools/call', { name: 'crm_available_rooms', arguments: {} })).body.result.isError, true);
  f.grantRooms();
  assert.deepEqual((await http.mcp(token)).body.result.tools.map(tool => tool.name), ['crm_auth_context', 'crm_available_rooms']);
  order.length = 0;
  const response = await http.mcp(token, 'tools/call', { name: 'crm_available_rooms', arguments: { buildingName: 'House', limit: 100 } });
  assert.equal(response.body.result.isError, false);
  const data = JSON.parse(response.body.result.content[0].text);
  assert.equal(data.rooms.length, 1); assert.equal(data.rooms[0].building.id, I.building); assert.equal(data.rooms[0].availability.label, 'Trống sẵn');
  assert.equal(data.totalInSnapshot, 1); assert.equal(data.nextOffset, null); assert.equal(data.completeness, 'complete');
  assert.equal(order.filter(value => value === 'hermes_room_scope_map_v1').length, 2);
  assert(order.indexOf('hermes_sale_listing_rooms_v1') < order.indexOf('audit:prepared'));
  assert.equal(order.at(-1), 'hermes_room_scope_map_v1');
  const exposed = response.text + JSON.stringify(f.audits);
  for (const secret of [token, browserJwt, assistantJwt, 'SYNTHETIC-REFRESH-SECRET', 'PRIVATE-CONTACT', 'PRIVATE-NOTE', 'PRIVATE-BUILDING-NOTE', 'Outside scope']) assert(!exposed.includes(secret));
  const invalid = await http.mcp(token, 'tools/call', { name: 'crm_available_rooms', arguments: { organizationId: id(99) } });
  assert.equal(JSON.parse(invalid.body.result.content[0].text).error, 'invalid_request');
  assert.equal(f.calls.filter(call => call.path.endsWith('hermes_sale_listing_rooms_v1')).length, 1);
});

test('server auth chain consults customer/expense capability RPCs; absent RPCs keep their create tools closed', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), created = await http.connect(), token = created.body.token;
  f.grantRooms();
  const listed = (await http.mcp(token)).body.result.tools.map(tool => tool.name);
  for (const path of ['hermes_customer_create_capabilities_v1', 'hermes_expense_capabilities_v1'])
    assert(f.calls.some(call => call.path === `/rest/v1/rpc/${path}` && call.options.headers.authorization === `Bearer ${assistantJwt}`), path);
  assert(!listed.some(name => /^crm_(customer|lead|expense)_/.test(name)));
  for (const name of ['crm_customer_create', 'crm_lead_status', 'crm_expense_create', 'crm_expense_input_options']) {
    const response = await http.mcp(token, 'tools/call', { name, arguments: {} });
    assert.equal(JSON.parse(response.body.result.content[0].text).error, 'tool_not_available', name);
  }
  assert(!f.calls.some(call => /hermes_(customer_create|expense)_action_v1$/.test(call.path)), 'no action RPC without capability');
});

test('composed room response is withheld if policy changes at the final bound RPC after successful audit', async t => {
  const f = fakeBackend(), original = f.configuration.fetch; let maps = 0, sawAudit = false;
  f.configuration.audit = async event => { f.audits.push(event); if (event.outcome === 'prepared' && maps === 1) sawAudit = true; };
  f.configuration.fetch = async (url, options) => {
    if (new URL(url).pathname.endsWith('/hermes_room_scope_map_v1') && ++maps === 2) {
      assert(sawAudit); f.read().joined.policy.version++;
    }
    return original(url, options);
  };
  const http = await listening(t, f.configuration), created = await http.connect(); f.grantRooms();
  const response = await http.mcp(created.body.token, 'tools/call', { name: 'crm_available_rooms', arguments: {} });
  assert.equal(maps, 2); assert.equal(response.body.result.isError, true);
  assert.deepEqual(JSON.parse(response.body.result.content[0].text), { error: 'context_changed' });
  assert(!response.text.includes('House A')); assert.equal(f.audits.at(-1).outcome, 'denied');
});

test('mounted Zalo routes use verified browser identity and cannot dispatch ingress or arbitrary operations', async t => {
  const f = fakeBackend(), original = f.configuration.fetch, bindings = [];
  f.configuration.fetch = async (url, options) => {
    if (!new URL(url).pathname.endsWith('/hermes_zalo_binding_v1')) return original(url, options);
    assert.equal(options.headers.authorization, `Bearer ${browserJwt}`);
    const input = JSON.parse(options.body).p; bindings.push(input);
    return Response.json({ status: 'listed', userId: I.user, organizationId: I.org, nextCursor: null,
      ...(input.operation === 'bots' ? { bots: [{ accountId: id(70), name: 'Company bot', zaloUid: '12345' }] } : { bindings: [] }) });
  };
  const http = await listening(t, f.configuration);
  assert.equal((await http.send('/api/hermes/zalo/bots', { organizationId: I.org, afterAccountId: null })).body.bots[0].name, 'Company bot');
  assert.equal((await http.send('/api/hermes/zalo/list', { organizationId: I.org, afterBindingId: null })).status, 200);
  assert.equal((await http.send('/api/hermes/zalo/list', { organizationId: I.org, afterBindingId: null, userId: id(99) })).status, 400);
  assert.equal((await http.send('/api/hermes/zalo/observe', {})).status, 404);
  assert.equal((await http.send('/api/hermes/zalo/register', {})).status, 404);
  assert.equal((await http.send('/api/hermes/zalo/list?other=1', {})).status, 404);
  assert.equal((await http.send('/api/hermes/zalo/list', {}, { authorization: 'Bearer hc_' + 'a'.repeat(43) })).status, 401);
  assert.equal((await http.send('/api/hermes/zalo/begin', {}, { origin: undefined })).status, 403);
  assert.equal(bindings.length, 2); assert.equal(f.sql.length, 0);
  assert.equal(f.calls.filter(c => c.path === '/auth/v1/user').length, 4);
});

test('bot administration reaches only caller-JWT SQL, preserves permission denial and rejects stale configuration', async t => {
  const f = fakeBackend(), original = f.configuration.fetch, bot = id(70); let permitted = false, version = 0, mutations = 0;
  f.configuration.fetch = async (url, options) => {
    if (!new URL(url).pathname.endsWith('/hermes_zalo_binding_v1')) return original(url, options);
    assert.equal(options.headers.authorization, `Bearer ${browserJwt}`);
    const input = JSON.parse(options.body).p;
    if (!permitted) return Response.json({ code: '42501', message: 'PRIVATE' }, { status: 403 });
    if (input.operation === 'manageBots') return Response.json({ status: 'listed', userId: I.user, organizationId: I.org, nextCursor: null,
      bots: [{ accountId: bot, name: 'Secondary', zaloUid: '12345', connected: true, enabled: version > 0, version }] });
    assert.equal(input.operation, 'setBot'); assert.equal(input.accountId, bot);
    if (input.expectedVersion !== version) return Response.json({ code: 'PT409', message: 'PRIVATE' }, { status: 409 });
    mutations++; version++;
    return Response.json({ status: 'configured', userId: I.user, organizationId: I.org, accountId: bot, version, enabled: input.enabled });
  };
  const http = await listening(t, f.configuration);
  const denied = await http.send('/api/hermes/zalo/manageBots', { organizationId: I.org, afterAccountId: null });
  assert.equal(denied.status, 403); assert.deepEqual(denied.body, { error: 'forbidden' });
  permitted = true;
  assert.equal((await http.send('/api/hermes/zalo/manageBots', { organizationId: I.org, afterAccountId: null })).body.bots[0].version, 0);
  const request = { organizationId: I.org, accountId: bot, expectedVersion: 0, enabled: true };
  assert.equal((await http.send('/api/hermes/zalo/setBot', request)).body.version, 1);
  const stale = await http.send('/api/hermes/zalo/setBot', request);
  assert.equal(stale.status, 409); assert.deepEqual(stale.body, { error: 'context_changed' });
  assert.equal(mutations, 1); assert.equal(f.sql.length, 0);
});

test('binding shutdown waits for the dispatched RPC and never returns late success after disconnect', async t => {
  const f = fakeBackend(), original = f.configuration.fetch, entered = deferred(), wait = deferred(); let signal;
  f.configuration.fetch = async (url, options) => {
    if (!new URL(url).pathname.endsWith('/hermes_zalo_binding_v1')) return original(url, options);
    signal = options.signal; entered.resolve(); await wait.promise;
    return Response.json({ status: 'listed', userId: I.user, organizationId: I.org, nextCursor: null, bindings: [] });
  };
  const http = await listening(t, f.configuration);
  const response = http.send('/api/hermes/zalo/list', { organizationId: I.org, afterBindingId: null }).catch(error => ({ error }));
  await entered.promise;
  let closed = false; const close = http.close().then(() => { closed = true; });
  await tick(); assert(signal.aborted); assert.equal(closed, false);
  wait.resolve(); await close;
  assert((await response).error);
});

test('private runner factory binds once, uses composed live authority/store and exposes no public pump route', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), handle = Object.freeze({}), executed = [], ledger = [];
  const command = { commandId: id(70), connectionId: I.connection, assistantId: I.assistant, userId: I.user,
    organizationId: I.org, bindingId: id(71), bindingEpoch: 1, text: 'Private question', expiresAt: NOW + 300000 };
  const supervisor = { status(value) { assert.equal(value, handle); return { state: 'active', expiresAt: NOW + 600000 }; },
    async executePrivateCommand(value, input, options) { assert.equal(value, handle); assert(options.signal instanceof AbortSignal); executed.push(input); return { text: 'Private response' }; } };
  assert.throws(() => http.createPrivateCommandRunner({}), /invalid_private_command_runner_config/);
  const runner = http.createPrivateCommandRunner(supervisor);
  assert.equal(http.createPrivateCommandRunner(supervisor), runner);
  assert.throws(() => http.createPrivateCommandRunner({ ...supervisor }), /private_command_runner_already_bound/);
  assert.equal(f.sql.length, 0); assert.deepEqual(Object.keys(runner), ['beginRun', 'beginPrune', 'run', 'prune', 'close']);
  for (const operation of ['claim_private_command', 'dispatch_private_command', 'finish_private_command', 'prune_private_commands']) {
    f.privateOperations.set(operation, input => {
      ledger.push({ operation, input });
      if (operation === 'prune_private_commands') return { status: 'pruned', count: 0 };
      assert.equal(input.tokenDigest, f.read().joined.connection.tokenDigest);
      if (operation === 'claim_private_command') return { status: 'claimed', claimId: input.claimId, command };
      return { status: operation === 'dispatch_private_command' ? 'dispatched' : 'ready', commandId: command.commandId, claimId: input.claimId };
    });
  }
  const token = (await http.connect()).body.token, options = { signal: new AbortController().signal };
  assert.deepEqual(await runner.run(token, handle, options), { status: 'ready', commandId: command.commandId });
  assert.deepEqual(await runner.prune({ limit: 12 }, options), { status: 'pruned', count: 0 });
  assert.deepEqual(executed, [command]); assert.equal(ledger.at(-2).input.text, 'Private response');
  assert.equal(new Set(ledger.slice(0, 3).map(row => row.input.claimId)).size, 1);
  assert(!JSON.stringify(ledger).includes(token));
  for (const path of ['/api/hermes/commands/run', '/internal/hermes/private-command/run']) assert.equal((await http.send(path, {})).status, 404);
  assert(!(await http.mcp(token)).body.result.tools.some(tool => /command|prune|dispatch/i.test(tool.name)));
  await http.close(); await assert.rejects(runner.run(token, handle, options), { code: 'backend_closed' });
  assert.throws(() => http.createPrivateCommandRunner(supervisor), { code: 'backend_closed' });
});

test('backend close aborts and drains private runtime promise before erasing its copied encryption key', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), entered = deferred(), held = deferred(), handle = Object.freeze({});
  const command = { commandId: id(70), connectionId: I.connection, assistantId: I.assistant, userId: I.user,
    organizationId: I.org, bindingId: id(71), bindingEpoch: 1, text: 'Private question', expiresAt: NOW + 300000 };
  f.privateOperations.set('claim_private_command', input => ({ status: 'claimed', claimId: input.claimId, command }));
  f.privateOperations.set('dispatch_private_command', input => ({ status: 'dispatched', claimId: input.claimId, commandId: command.commandId }));
  let signal, destroyed = false; const fill = Buffer.prototype.fill;
  t.mock.method(Buffer.prototype, 'fill', function (value, ...args) {
    if (value === 0 && this.length === 32 && this.equals(f.key)) destroyed = true;
    return Reflect.apply(fill, this, [value, ...args]);
  });
  const runner = http.createPrivateCommandRunner({ status() { return { state: 'active', expiresAt: NOW + 600000 }; },
    executePrivateCommand(_handle, _command, options) { signal = options.signal; entered.resolve(); return held.promise; } });
  const token = (await http.connect()).body.token;
  const running = runner.run(token, handle, { signal: new AbortController().signal });
  const rejected = assert.rejects(running, { code: 'private_command_outcome_unknown' }); await entered.promise;
  let closed = false; const closing = http.close(); void closing.then(() => { closed = true; });
  try { await rejected; await tick(); assert(signal.aborted); assert.equal(closed, false); assert.equal(destroyed, false); }
  finally { held.resolve({ text: 'late response' }); await closing; }
  assert.equal(destroyed, true); assert.equal(f.read().poolEnds, 0);
  assert(!f.sql.some(query => /hermes_store_(finish|fail)_private_command/.test(query.text)));
});

async function ownedRuntime(t, http, token, hooks = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hermes-backend-runtime-')));
  const home = path.join(root, 'assistant'); await mkdir(home);
  t.after(async () => { await http.close(); await rm(root, { recursive: true, force: true }); });
  const events = [], profileStore = new ProfileLeaseStore({ homeRoot: root, directory: path.join(root, 'leases') });
  const gateway = http.createRuntimeGateway({ allowedModels: ['openai:fixture'], transport: {
    async open() { events.push('transport-open'); return {
      descriptor: { networkName: 'fixture-private', networkId: 'a'.repeat(64), mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' },
      async close() { events.push('transport-close'); },
    }; },
  } });
  const runtime = {
    prepare({ binding, admission, signal }) { assert.equal(admission, false); assert(signal instanceof AbortSignal);
      return gateway.prepare(binding); },
    start(handle) { return gateway.start(handle, { signal: new AbortController().signal }); },
    setAdmission(handle, value) { events.push(`gate-${value}`); gateway.setAdmission(handle, value); },
    async stop(handle) { events.push('runtime-stop'); hooks.stopEntered?.resolve(); await hooks.stopWait?.promise;
      await gateway.close(handle); events.push('runtime-stopped'); },
    beginExecutePrivateCommand: hooks.beginExecute ?? (() => Object.freeze({ result: Promise.resolve({ text: 'answer' }), drained: Promise.resolve() })),
  };
  const options = { profileStore, runtime }, supervisor = http.createRuntimeSupervisor(options);
  assert.equal(http.createRuntimeSupervisor(options), supervisor);
  assert.throws(() => http.createRuntimeSupervisor({ ...options }), /runtime_supervisor_already_bound/);
  await gateway.register(token, { home, signal: new AbortController().signal });
  const started = supervisor.beginStart({ token, home }); await started.ready;
  return { supervisor, handle: started.handle, events, profileStore, home };
}

test('owned supervisor factory is inert, rejects getters and closes runtime before gateway teardown', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration);
  let getters = 0;
  for (const options of [{}, { profileStore: {}, runtime: {}, dependencyScope: {} },
    { profileStore: {}, get runtime() { getters++; return {}; } }]) {
    assert.throws(() => http.createRuntimeSupervisor(options), /invalid_runtime_supervisor_config|invalid_supervisor_config/);
  }
  assert.equal(getters, 0); assert.equal(f.sql.length, 0); assert.equal(f.calls.length, 0);
  const token = (await http.connect()).body.token, stopWait = deferred(), stopEntered = deferred();
  const runtime = await ownedRuntime(t, http, token, { stopWait, stopEntered });
  assert.throws(() => http.createPrivateCommandRunner({}), /private_command_supervisor_mismatch/);
  let closed = false; const closing = http.close().then(() => { closed = true; }); await stopEntered.promise;
  try { await tick(); assert.equal(closed, false); assert(!runtime.events.includes('transport-close'));
    assert.equal(runtime.events.at(-1), 'runtime-stop');
  } finally { stopWait.resolve(); await closing; }
  assert(runtime.events.indexOf('runtime-stop') < runtime.events.indexOf('transport-close'));
  assert.equal(runtime.events.at(-1), 'runtime-stopped'); assert.equal(f.read().poolEnds, 0);
  assert.throws(() => http.createRuntimeSupervisor({}), { code: 'backend_unavailable' });
});

test('owned supervisor shares runner drain scope; close starts runtime stop before waiting for the aborted result', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), token = (await http.connect()).body.token;
  const entered = deferred(), held = deferred(), stopEntered = deferred(); let observed;
  const runtime = await ownedRuntime(t, http, token, { stopWait: held, stopEntered,
    beginExecute(_handle, _input, { signal }) {
      observed = signal; entered.resolve();
      const result = new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true }));
      return Object.freeze({ result, drained: held.promise });
    },
  });
  const command = { commandId: id(70), connectionId: I.connection, assistantId: I.assistant, userId: I.user,
    organizationId: I.org, bindingId: id(71), bindingEpoch: 1, text: 'Private question', expiresAt: NOW + 300000 };
  f.privateOperations.set('claim_private_command', input => ({ status: 'claimed', claimId: input.claimId, command }));
  f.privateOperations.set('dispatch_private_command', input => ({ status: 'dispatched', claimId: input.claimId, commandId: command.commandId }));
  const runner = http.createPrivateCommandRunner(runtime.supervisor);
  const operation = runner.beginRun(token, runtime.handle, { signal: new AbortController().signal });
  const rejected = assert.rejects(operation.result, { code: 'private_command_outcome_unknown' }); await entered.promise;
  let drained = false, closed = false; void operation.drained.then(() => { drained = true; });
  const closing = http.close().then(() => { closed = true; }); await stopEntered.promise; await rejected;
  try { await tick(); assert(observed.aborted); assert.equal(drained, false); assert.equal(closed, false);
    assert(!runtime.events.includes('transport-close'));
  } finally { held.resolve(); await closing; await operation.drained; }
  assert.equal(drained, true); assert.equal(f.read().poolEnds, 0);
  assert(!f.sql.some(query => /hermes_store_(finish|fail)_private_command/.test(query.text)));
});

function arrangeRefresh(f) {
  const operations = [], old = structuredClone(f.read().joined.session);
  const nextJwt = jwt(I.assistantSession, NOW + 7200000); let ownerId, staged;
  f.acceptedAssistantTokens.add(nextJwt);
  f.providerOperations.refresh = args => {
    assert.deepEqual(args, { refresh_token: 'SYNTHETIC-REFRESH-SECRET' });
    return Response.json({ token_type: 'bearer', access_token: nextJwt, refresh_token: 'NEXT-SYNTHETIC-REFRESH' });
  };
  for (const operation of ['acquire_refresh', 'dispatch_refresh', 'stage_refresh', 'publish_refresh', 'reconnect_session']) {
    f.privateOperations.set(operation, input => {
      operations.push(operation);
      assert.equal(input.credentialRef, old.credentialRef); assert.deepEqual(input.binding, old.binding);
      if (operation === 'acquire_refresh') {
        ownerId = input.ownerId; assert.match(ownerId, /^[a-f0-9-]{36}$/);
        return { status: 'acquired', credential: old, lease: { fence: 1, expiresAt: f.read().clock + input.leaseMs } };
      }
      assert.equal(input.ownerId, ownerId); assert.equal(input.revision, old.revision); assert.equal(input.fence, 1);
      if (operation === 'dispatch_refresh') return { ok: true, status: 'dispatched' };
      if (operation === 'stage_refresh') {
        staged = structuredClone(input); assert.equal(staged.expiresAt, NOW + 7200000);
        assert.notDeepEqual(staged.envelope, old.envelope);
        for (const secret of [nextJwt, assistantJwt, 'NEXT-SYNTHETIC-REFRESH']) assert(!JSON.stringify(staged).includes(secret));
        return { ok: true, status: 'staged' };
      }
      if (operation === 'publish_refresh') {
        assert(staged); const session = f.read().joined.session;
        session.envelope = staged.envelope; session.expiresAt = staged.expiresAt; session.revision++;
        // From publish onward an old bearer cannot pass a fresh Auth lookup.
        f.acceptedAssistantTokens.delete(assistantJwt);
        return { ok: true, status: 'published', revision: session.revision, fence: 1 };
      }
      return { ok: true, status: 'reconnect_required' };
    });
  }
  return { operations, nextJwt };
}

test('trusted maintenance composes actual refresh, encrypted publish and same-token renewal without a public route', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), token = (await http.connect()).body.token;
  f.nearSessionExpiry(); const refresh = arrangeRefresh(f), previousExpiry = f.read().joined.connection.expiresAt;
  const operation = http.beginConnectionMaintenance(token, { signal: new AbortController().signal });
  const result = await operation.result; await operation.drained;
  assert.deepEqual(result, { ok: true, status: 'renewed', connectionId: I.connection, expiresAt: previousExpiry + 1000, reconciled: false });
  assert.deepEqual(refresh.operations, ['acquire_refresh', 'dispatch_refresh', 'stage_refresh', 'publish_refresh']);
  assert.equal(f.calls.filter(call => call.path === '/auth/v1/token').length, 2); // One login, one refresh.
  assert.equal(f.read().joined.session.revision, 2);
  assert(f.calls.filter(call => call.path === '/auth/v1/user' && call.options.headers.authorization === `Bearer ${refresh.nextJwt}`).length >= 2);
  assert.equal((await http.resolveConnection(token, { signal: new AbortController().signal })).expiresAt, result.expiresAt);
  for (const secret of [token, assistantJwt, refresh.nextJwt, 'SYNTHETIC-REFRESH', 'credentialRef', 'sessionId']) assert(!JSON.stringify(result).includes(secret));
  for (const route of ['/api/hermes/connections/maintain', '/internal/hermes/refresh']) assert.equal((await http.send(route, {})).status, 404);
  assert(!(await http.mcp(token)).body.result.tools.some(tool => /maintain|refresh/i.test(tool.name)));
});

test('external connector parks only its token, drains an active MCP call and refreshes before admitting another call', async t => {
  const f = fakeBackend(), http = await listening(t, { ...f.configuration, connectorOnly: true });
  const token = (await http.connect()).body.token, entered = deferred(), held = deferred(), refreshEntered = deferred(), refreshHeld = deferred();
  t.after(() => { held.resolve(); refreshHeld.resolve(); });
  f.nearSessionExpiry(); const refresh = arrangeRefresh(f);
  // Delay the first SQL read, retaining the real HTTP dependency promise.
  let holdRead = true;
  const connect = f.pool.connect;
  f.pool.connect = async () => {
    const client = await connect(); const query = client.query;
    client.query = async statement => {
      if (holdRead && /hermes_store_read_connection_v1/.test(statement.text)) { holdRead = false; entered.resolve(); await held.promise; }
      return query(statement);
    };
    return client;
  };
  const respond = f.providerOperations.refresh;
  f.providerOperations.refresh = async (...args) => { refreshEntered.resolve(); await refreshHeld.promise; return respond(...args); };
  const first = http.mcp(token); await entered.promise;
  const operation = http.beginExternalConnectionMaintenance(token, { signal: new AbortController().signal });
  assert.throws(() => http.beginExternalConnectionMaintenance(token, { signal: new AbortController().signal }), { code: 'busy' });
  assert.equal((await http.mcp(token)).body.error, 'connection_maintenance');
  assert.equal((await http.mcp('hc_' + 'z'.repeat(43))).status, 401);
  assert.equal(refresh.operations.length, 0);
  held.resolve(); assert.equal((await first).status, 200); await refreshEntered.promise;
  assert.equal((await http.mcp(token)).status, 503); refreshHeld.resolve();
  const result = await operation.result; await operation.drained;
  assert.equal(result.status, 'renewed'); assert.equal((await http.mcp(token)).status, 200);
  assert.deepEqual(refresh.operations, ['acquire_refresh', 'dispatch_refresh', 'stage_refresh', 'publish_refresh']);
  for (const method of ['createRuntimeGateway', 'createRuntimeSupervisor', 'createPrivateCommandRunner']) {
    assert.throws(() => http[method]({}), { code: 'tool_not_available' });
  }
  assert(!f.calls.some(call => call.path.includes('llm-proxy')));
});

test('cancelled external maintenance retains the MCP fence until old SQL drains and never dispatches renewal', async t => {
  const f = fakeBackend(), http = await listening(t, { ...f.configuration, connectorOnly: true });
  const token = (await http.connect()).body.token, entered = deferred(), held = deferred(), controller = new AbortController();
  const connect = f.pool.connect; let once = true;
  f.pool.connect = async () => {
    const client = await connect(), query = client.query;
    client.query = async statement => {
      if (once && /hermes_store_read_connection_v1/.test(statement.text)) { once = false; entered.resolve(); await held.promise; }
      return query(statement);
    };
    return client;
  };
  const active = http.mcp(token); await entered.promise;
  const maintenance = http.beginExternalConnectionMaintenance(token, { signal: controller.signal });
  const failed = assert.rejects(maintenance.result, { code: 'backend_unavailable' }); controller.abort();
  try {
    assert.equal((await http.mcp(token)).body.error, 'connection_maintenance');
    assert(!f.sql.some(query => /hermes_store_renew_connection/.test(query.text)));
  } finally { held.resolve(); }
  await active; await failed; await maintenance.drained;
  assert.equal((await http.mcp(token)).status, 200);
  assert(!f.sql.some(query => /hermes_store_renew_connection/.test(query.text)));
});

test('external MCP request waits for the maintenance fence and is admitted only after refresh and renewal drained', async t => {
  const limits = { requestsPerMinute: 60, toolCallsPerMinute: 30, callTimeoutMs: 10_000, maintenanceWaitMs: 2000 };
  const refreshEntered = deferred(), refreshHeld = deferred();
  t.after(() => refreshHeld.resolve()); // Before backend close: a held provider must not deadlock cleanup.
  const f = fakeBackend(), http = await listening(t, { ...f.configuration, connectorOnly: true, limits });
  const token = (await http.connect()).body.token;
  f.nearSessionExpiry(); const refresh = arrangeRefresh(f), respond = f.providerOperations.refresh;
  f.providerOperations.refresh = async (...args) => { refreshEntered.resolve(); await refreshHeld.promise; return respond(...args); };
  const operation = http.beginExternalConnectionMaintenance(token, { signal: new AbortController().signal });
  await refreshEntered.promise;
  const sql = f.sql.length, calls = f.calls.length; let settled = 0;
  const waiting = [http.mcp(token), http.mcp(token, 'tools/call', { name: 'crm_auth_context', arguments: {} })]
    .map(request => request.then(value => { settled++; return value; }));
  await new Promise(resolve => setTimeout(resolve, 50));
  // Held, not refused: nothing of the waiting requests touched SQL/Auth while parked.
  assert.equal(settled, 0); assert.equal(f.sql.length, sql); assert.equal(f.calls.length, calls);
  // Waiters are bounded by the per-connection concurrency; the next one is refused at once.
  assert.equal((await http.mcp(token)).body.error, 'connection_maintenance');
  refreshHeld.resolve();
  const result = await operation.result; await operation.drained;
  assert.equal(result.status, 'renewed');
  const [listed, called] = await Promise.all(waiting);
  // publish_refresh retires the old bearer, so a request admitted before the
  // fence opened would fail Auth; both succeed on the refreshed, renewed session.
  assert.equal(listed.status, 200); assert.equal(called.status, 200); assert.equal(called.body.result.isError, false);
  assert.deepEqual(refresh.operations, ['acquire_refresh', 'dispatch_refresh', 'stage_refresh', 'publish_refresh']);
  assert.equal(f.sql.filter(query => /hermes_store_renew_connection/.test(query.text)).length, 1);
  assert.equal(f.calls.filter(call => call.path === '/auth/v1/token').length, 2); // One login, one refresh: never twice.
});

test('backend close wakes a request waiting on the maintenance fence and never dispatches it', async t => {
  const limits = { requestsPerMinute: 60, toolCallsPerMinute: 30, callTimeoutMs: 10_000, maintenanceWaitMs: 10_000 };
  const refreshEntered = deferred(), refreshHeld = deferred();
  t.after(() => refreshHeld.resolve()); // Before backend close: a held provider must not deadlock cleanup.
  const f = fakeBackend(), http = await listening(t, { ...f.configuration, connectorOnly: true, limits });
  const token = (await http.connect()).body.token;
  f.nearSessionExpiry(); arrangeRefresh(f); const respond = f.providerOperations.refresh;
  f.providerOperations.refresh = async (...args) => { refreshEntered.resolve(); await refreshHeld.promise; return respond(...args); };
  const operation = http.beginExternalConnectionMaintenance(token, { signal: new AbortController().signal });
  void operation.result.catch(() => {});
  await refreshEntered.promise;
  const waiter = http.mcp(token).then(value => value, error => ({ status: 0, error }));
  await new Promise(resolve => setTimeout(resolve, 20));
  const started = Date.now(), closing = http.close();
  const outcome = await waiter;
  assert(Date.now() - started < 2000, 'close wakes the waiter instead of letting it sit out the wait');
  assert(outcome.status === 0 || (outcome.status === 503 && outcome.body.error === 'backend_closed'), JSON.stringify(outcome.body));
  refreshHeld.resolve(); await closing; await operation.drained.catch(() => {});
});

test('maintenance wait is bounded: a request still parked after the wait gets 503 without touching SQL', async t => {
  const limits = { requestsPerMinute: 60, toolCallsPerMinute: 30, callTimeoutMs: 10_000, maintenanceWaitMs: 50 };
  const refreshEntered = deferred(), refreshHeld = deferred();
  t.after(() => refreshHeld.resolve()); // Before backend close: a held provider must not deadlock cleanup.
  const f = fakeBackend(), http = await listening(t, { ...f.configuration, connectorOnly: true, limits });
  const token = (await http.connect()).body.token;
  f.nearSessionExpiry(); arrangeRefresh(f); const respond = f.providerOperations.refresh;
  f.providerOperations.refresh = async (...args) => { refreshEntered.resolve(); await refreshHeld.promise; return respond(...args); };
  const operation = http.beginExternalConnectionMaintenance(token, { signal: new AbortController().signal });
  await refreshEntered.promise;
  const sql = f.sql.length, started = Date.now();
  const late = await http.mcp(token);
  assert.equal(late.status, 503); assert.equal(late.body.error, 'connection_maintenance'); assert(Date.now() - started >= 40);
  assert.equal(f.sql.length, sql);
  const longer = createHermesBackend({ ...f.configuration, connectorOnly: true, limits: { ...limits, maintenanceWaitMs: 10_000 } });
  assert.throws(() => createHermesBackend({ ...f.configuration, connectorOnly: true, limits: { ...limits, maintenanceWaitMs: 10_001 } }),
    { message: 'invalid_backend_config' });
  assert.throws(() => createHermesBackend({ ...f.configuration, connectorOnly: true, limits: { ...limits, toolCallsPerMinute: 61 } }),
    { message: 'invalid_backend_config' });
  // Total wait + deadline is capped below the MCP client timeout and idle-socket cut-off.
  for (const delta of [{ callTimeoutMs: 20_000, maintenanceWaitMs: 5001 }, { callTimeoutMs: 30_000, maintenanceWaitMs: 0 }]) {
    assert.throws(() => createHermesBackend({ ...f.configuration, connectorOnly: true, limits: { ...limits, ...delta } }),
      { message: 'invalid_backend_config' });
  }
  await createHermesBackend({ ...f.configuration, connectorOnly: true, limits: { ...limits, callTimeoutMs: 20_000, maintenanceWaitMs: 5000 } }).close();
  await longer.close();
  refreshHeld.resolve(); await operation.result; await operation.drained;
  assert.equal((await http.mcp(token)).status, 200);
});

test('connector status shows only the caller\'s own connections with last MCP activity and a fixed error code', async t => {
  const f = fakeBackend(), http = await listening(t, { ...f.configuration, connectorOnly: true }), token = (await http.connect()).body.token;
  const empty = await http.browser('status');
  assert.equal(empty.status, 200); assert.match(empty.body.connector.version, /^\d+\.\d+\.\d+$/);
  assert.equal(empty.body.connector.startedAt, NOW);
  assert.deepEqual(empty.body.connections, [{ id: I.connection, lastSuccessAt: null, lastToolCallAt: null, lastErrorCode: null, lastErrorAt: null }]);
  assert.equal((await http.mcp(token)).status, 200);
  const called = await http.mcp(token, 'tools/call', { name: 'crm_auth_context', arguments: {} });
  assert.equal(called.body.result.isError, false);
  const denied = await http.mcp(token, 'tools/call', { name: 'crm_read_customers', arguments: {} });
  assert.equal(JSON.parse(denied.body.result.content[0].text).error, 'tool_not_available');
  const status = await http.browser('status');
  assert.deepEqual(status.body.connections, [{ id: I.connection, lastSuccessAt: NOW, lastToolCallAt: NOW, lastErrorCode: 'tool_not_available', lastErrorAt: NOW }]);
  for (const secret of [token, assistantJwt, browserJwt, 'SYNTHETIC-REFRESH', 'credentialRef', 'crm_auth_context']) assert(!status.text.includes(secret));
  // Another organization or a missing browser session sees nothing.
  assert.equal((await http.browser('status', { organizationId: id(99) })).status, 403);
  assert.equal((await http.send('/api/hermes/connections/status', { organizationId: I.org }, { authorization: undefined })).status, 401);
  assert.equal((await http.browser('status', { connectionId: I.connection })).status, 400);
});

test('backend close holds key and maintenance capacity until ignored-abort refresh fetch actually drains', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), token = (await http.connect()).body.token;
  f.nearSessionExpiry(); const refresh = arrangeRefresh(f), entered = deferred(), held = deferred();
  const respond = f.providerOperations.refresh; let providerSignal, destroyed = false;
  f.providerOperations.refresh = async (args, options) => { providerSignal = options.signal; entered.resolve(); await held.promise; return respond(args); };
  const fill = Buffer.prototype.fill;
  t.mock.method(Buffer.prototype, 'fill', function (value, ...args) {
    if (value === 0 && this.length === 32 && this.equals(f.key)) destroyed = true;
    return Reflect.apply(fill, this, [value, ...args]);
  });
  const operation = http.beginConnectionMaintenance(token, { signal: new AbortController().signal });
  const rejected = assert.rejects(operation.result, { code: 'maintenance_outcome_unknown' }); await entered.promise;
  let drained = false, closed = false; void operation.drained.then(() => { drained = true; });
  const closing = http.close().then(() => { closed = true; });
  try {
    await rejected; await tick(); assert(providerSignal.aborted); assert.equal(drained, false);
    assert.equal(closed, false); assert.equal(destroyed, false);
    assert.throws(() => http.beginConnectionMaintenance(token, { signal: new AbortController().signal }), { code: 'backend_closed' });
  } finally { held.resolve(); await operation.drained; await closing; }
  assert.equal(destroyed, true); assert.equal(f.read().poolEnds, 0); assert.equal(f.read().joined.session.revision, 1);
  assert.deepEqual(refresh.operations, ['acquire_refresh', 'dispatch_refresh', 'reconnect_session']);
  assert(!f.sql.some(query => /hermes_store_renew_connection/.test(query.text)));
  assert.equal(f.calls.filter(call => call.path === '/auth/v1/token').length, 2);
});

test('product orchestrator parks the actual runner, refreshes through composed backend, then resumes with the same runtime', async t => {
  const f = fakeBackend(), http = await listening(t, f.configuration), token = (await http.connect()).body.token;
  f.nearSessionExpiry(); const refresh = arrangeRefresh(f), entered = deferred(), held = deferred(), reopened = deferred();
  const respond = f.providerOperations.refresh;
  f.providerOperations.refresh = async (...args) => { entered.resolve(); await held.promise; return respond(...args); };
  f.providerOperations.renewExpiry = () => f.read().clock + 900000;
  f.privateOperations.set('claim_private_command', () => ({ status: 'empty' }));
  f.privateOperations.set('prune_private_commands', () => ({ status: 'pruned', count: 0 }));
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hermes-coordinated-backend-')));
  const gates = [], jobs = new Map(); let next = 0, starts = 0, stops = 0;
  const gateway = http.createRuntimeGateway({ allowedModels: ['openai:fixture'], transport: { async open() {
    return { descriptor: { networkName: 'fixture-private', networkId: 'a'.repeat(64), mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' }, async close() {} };
  } } });
  const supervisor = http.createRuntimeSupervisor({ profileStore: new ProfileLeaseStore({ homeRoot: root, directory: path.join(root, 'leases') }),
    runtime: {
      prepare({ binding, admission }) { assert.equal(admission, false); return gateway.prepare(binding); },
      async start(handle) { starts++; await gateway.start(handle, { signal: new AbortController().signal }); },
      setAdmission(handle, allowed) { gateway.setAdmission(handle, allowed); gates.push(allowed); if (allowed && gates.length > 1) reopened.resolve(); },
      async stop(handle) { stops++; await gateway.close(handle); },
    } });
  assert.equal(supervisor.renewalMode, 'coordinated');
  const orchestrator = createRuntimeOrchestrator({ backend: http, gateway, supervisor, runner: http.createPrivateCommandRunner(supervisor),
    profileHomes: createProfileHomes({ homeRoot: root }), clock: () => f.read().clock,
    closeIngress() {}, closePool: () => f.pool.end(),
    timers: { setTimeout(fn, ms) { const key = ++next; jobs.set(key, { fn, ms }); return key; }, clearTimeout(key) { jobs.delete(key); } } });
  t.after(async () => { held.resolve(); await orchestrator.close(); await rm(root, { recursive: true, force: true }); });
  const pump = () => { const job = [...jobs].find(([, value]) => value.ms === 5000); assert(job); jobs.delete(job[0]); job[1].fn(); };
  const handle = await orchestrator.attach({ token, signal: new AbortController().signal }); orchestrator.start(); pump(); await entered.promise;
  assert.equal(orchestrator.status(handle).state, 'maintaining'); assert.deepEqual(gates, [true, false]);
  const reads = f.sql.filter(query => /hermes_store_read_connection/.test(query.text)).length;
  pump(); await tick(); assert.equal(f.sql.filter(query => /hermes_store_read_connection/.test(query.text)).length, reads);
  assert(!f.sql.some(query => /hermes_store_claim_private_command/.test(query.text)));
  held.resolve(); await reopened.promise; await tick(); assert.equal(orchestrator.status(handle).state, 'active');
  assert.equal(orchestrator.status(handle).expiresAt, f.read().clock + 900000); assert.deepEqual(gates, [true, false, true]);
  assert.deepEqual(refresh.operations, ['acquire_refresh', 'dispatch_refresh', 'stage_refresh', 'publish_refresh']);
  pump(); await tick(); assert.equal(f.sql.filter(query => /hermes_store_claim_private_command/.test(query.text)).length, 1);
  assert.equal(starts, 1); assert.equal(stops, 0); assert.equal(f.calls.filter(call => call.path === '/auth/v1/token').length, 2);
  await orchestrator.close(); assert.equal(stops, 1); assert.equal(f.read().poolEnds, 1); assert.equal(jobs.size, 0);
});


test('backend handoff persists before activation and returns the same opaque token through the existing browser route', async t => {
  const f = fakeBackend(), entered = deferred(), hold = deferred(); let captured;
  f.configuration.handoff = { async stage(record, { signal }) {
    assert(signal instanceof AbortSignal); assert(Object.isFrozen(record)); captured = structuredClone(record); entered.resolve();
    await hold.promise; return { status: 'stored', connectionId: record.connectionId, operationId: record.operationId };
  } };
  const http = await listening(t, f.configuration), pending = http.connect(); await entered.promise;
  try { assert.equal(f.read().joined, undefined); assert(!f.sql.some(query => /hermes_store_activate/.test(query.text))); }
  finally { hold.resolve(); }
  const response = await pending; assert.equal(response.status, 200); assert.equal(response.body.token, captured.token);
  assert.deepEqual([captured.connectionId, captured.assistantId, captured.userId, captured.organizationId], [I.connection,I.assistant,I.user,I.org]);
  for (const secret of [browserJwt, assistantJwt, 'SYNTHETIC-REFRESH-SECRET', 'synthetic-password']) assert(!JSON.stringify(captured).includes(secret));
  for (const route of ['/api/hermes/connections/handoff', '/internal/hermes/handoffs']) assert.equal((await http.send(route, {})).status, 404);
});

test('backend close waits actual handoff filesystem work after client disconnect before destroying session keys', async t => {
  const f = fakeBackend(), entered = deferred(), hold = deferred(); let destroyed = false, observed;
  f.configuration.handoff = { async stage(record, { signal }) {
    observed = signal; entered.resolve(); await hold.promise;
    return { status: 'stored', connectionId: record.connectionId, operationId: record.operationId };
  } };
  const fill = Buffer.prototype.fill;
  t.mock.method(Buffer.prototype, 'fill', function(value,...args) {
    if (value === 0 && this.length === 32 && this.equals(f.key)) destroyed = true;
    return Reflect.apply(fill,this,[value,...args]);
  });
  const http = await listening(t,f.configuration), response = http.connect().catch(() => null); await entered.promise;
  let closed = false; const closing = http.close().then(() => { closed = true; }); await response;
  try {
    await tick(); assert(observed.aborted); assert.equal(closed,false); assert.equal(destroyed,false);
    assert.equal(f.read().poolEnds,0); assert(!f.sql.some(query => /hermes_store_activate/.test(query.text)));
  } finally { hold.resolve(); await closing; }
  assert.equal(destroyed,true); assert(!f.sql.some(query => /hermes_store_activate/.test(query.text)));
});

test('unknown host handoff is a sanitized 503 enrollment receipt and never activates', async t => {
  const f = fakeBackend(); let stored;
  f.configuration.handoff = { async stage(record) { stored = record; throw Error('PRIVATE_PATH_AND_SECRET'); } };
  const http = await listening(t,f.configuration), response = await http.connect();
  assert.equal(response.status,503); assert.equal(response.body.error,'activation_outcome_unknown');
  assert.deepEqual(response.body.receipt,{connectionId:I.connection,operationId:stored.operationId});
  for (const secret of [stored.token,browserJwt,assistantJwt,'PRIVATE_PATH_AND_SECRET']) assert(!response.text.includes(secret));
  assert.equal(f.read().joined,undefined);
});

test('backend options composes real Auth and management using the fixed self RPC with no new authority or writes', async t=>{
  const f=fakeBackend(),base=f.configuration.fetch;
  const choices={userId:I.user,organizationId:I.org,membershipId:I.member,authorizationVersion:1,isSuperadmin:false,
    policyVersion:1,enabled:true,read:['assistant.context.read'],action:[],scopes:[]};
  let reads=0;
  f.configuration.fetch=async(url,options)=>{
    if(new URL(url).pathname==='/rest/v1/rpc/hermes_connection_options_v1') {
      reads++;assert.equal(options.headers.authorization,'Bearer '+browserJwt);
      assert.deepEqual(JSON.parse(options.body),{p_org:I.org});return Response.json(choices);
    }return base(url,options);
  };
  const http=await listening(t,f.configuration),result=await http.browser('options');
  assert.equal(result.status,200);assert.deepEqual(result.body,{options:choices});assert.equal(reads,2);
  assert.equal(f.read().signInCount,0);assert.equal(f.sql.length,0);
  for(const secret of [browserJwt,assistantJwt,'SYNTHETIC-REFRESH-SECRET'])assert(!result.text.includes(secret));
});
test('backend close drains ignored-abort options fetch and actual body cancellation before erasing keys',async t=>{
  const f=fakeBackend(),base=f.configuration.fetch,entered=deferred(),fetchHold=deferred(),cancelEntered=deferred(),cancelHold=deferred();
  let observed,destroyed=false;
  f.configuration.fetch=async(url,options)=>{
    if(new URL(url).pathname==='/rest/v1/rpc/hermes_connection_options_v1'){
      observed=options.signal;entered.resolve();await fetchHold.promise;
      return new Response(new ReadableStream({cancel(){cancelEntered.resolve();return cancelHold.promise;}}),{headers:{'content-type':'application/json'}});
    }return base(url,options);
  };
  const fill=Buffer.prototype.fill;
  t.mock.method(Buffer.prototype,'fill',function(value,...args){if(value===0&&this.length===32&&this.equals(f.key))destroyed=true;return Reflect.apply(fill,this,[value,...args]);});
  const http=await listening(t,f.configuration),request=http.browser('options').catch(()=>null);await entered.promise;
  let closed=false;const closing=http.close().then(()=>{closed=true;});await request;
  try{
    await tick();assert(observed.aborted);assert.equal(closed,false);assert.equal(destroyed,false);
    fetchHold.resolve();await cancelEntered.promise;await tick();assert.equal(closed,false);assert.equal(destroyed,false);
  }finally{fetchHold.resolve();cancelHold.resolve();await closing;}
  assert.equal(destroyed,true);assert.equal(f.read().poolEnds,0);
});

test('options disconnect cannot release the global sixteen-request budget before underlying fetches drain', {timeout:10000},async t=>{
  const f=fakeBackend(),base=f.configuration.fetch,hold=deferred(),entered=Array.from({length:16},deferred);
  let calls=0,active=0,peak=0;
  f.configuration.fetch=async(url,options)=>{
    if(new URL(url).pathname==='/rest/v1/rpc/hermes_connection_options_v1'){
      const index=calls++;if(index>=16)return Response.json({});
      active++;peak=Math.max(peak,active);entered[index].resolve();await hold.promise;active--;return Response.json({});
    }return base(url,options);
  };
  const http=await listening(t,f.configuration);
  try{
    for(let i=0;i<16;i++){
      const req=httpRequest(http.address+'/api/hermes/connections/options',{method:'POST',headers:{host:HOST,origin:ORIGIN,
        authorization:'Bearer '+browserJwt,'content-type':'application/json'}},response=>response.resume());
      req.on('error',()=>{});req.end(JSON.stringify({organizationId:I.org}));await entered[i].promise;req.destroy();
      for(let n=0;n<6;n++)await tick();
    }
    const rejected=await http.browser('options');assert.equal(rejected.status,429);
    assert.equal(calls,16);assert.equal(active,16);assert.equal(peak,16);
  }finally{hold.resolve();await http.close();}
});
