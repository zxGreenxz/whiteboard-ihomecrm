import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createConnectionManagement, createSupabaseConnectionManagementReads, ConnectionManagementError } from './connection-management.mjs';
import { DurableConnectionStoreError } from './durable-connection-store.mjs';
import { BrokerError } from './broker.mjs';

const ids = { user: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', org: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  connection: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', assistant: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  session: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', membership: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  scope: '11111111-1111-4111-8111-111111111111', foreign: '22222222-2222-4222-8222-222222222222' };
const now = 1_800_000_000_000;
const limits = () => ({ read: ['assistant.context.read'], action: [] });
const row = () => ({ id: ids.connection, assistantId: ids.assistant, organizationId: ids.org, userId: ids.user,
  state: 'active', epoch: 2, restrictions: limits(), scopeIds: [ids.scope] });
const context = () => ({ ...row(), membershipId: ids.membership, authorizationVersion: 1,
  isSuperadmin: false, policyVersion: 1, companyCeilings: limits(), effective: limits() });
const grantOptions = () => ({ userId: ids.user, organizationId: ids.org, membershipId: ids.membership, authorizationVersion: 1, isSuperadmin: false, policyVersion: 1, enabled: true, read: ['assistant.context.read'], action: [], scopes: [] });
const session = () => ({ userId: ids.user, sessionId: ids.session, expiresAt: now + 60_000 });
const authorization = () => ({ userId: ids.user, isSuperadmin: false, activeOrganizationIds: [ids.org],
  epoch: 'authorization-epoch-1',
  membership: { organizationId: ids.org, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
    membershipId: ids.membership, authorizationVersion: 1 },
  permissions: limits(), companyCeilings: limits() });
const request = operation => ({ browserAccessToken: 'browser.jwt.token', organizationId: ids.org,
  ...(['list', 'options'].includes(operation) ? {} : { connectionId: ids.connection }),
  ...(['restrict', 'revoke'].includes(operation) ? { expectedEpoch: 2 } : {}),
  ...(operation === 'restrict' ? { restrictions: { read: [], action: [] }, scopeIds: [] } : {}) });
const code = expected => error => error.code === expected && error.message === expected && error.cause === undefined;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
function fixture(options = {}) {
  const events = [], writes = [], controller = new AbortController();
  const auth = {
    async verifySession(input) { events.push(['verify', input]); return session(); },
    async readAuthorization(input) { events.push(['authz', input]); return authorization(); },
  };
  const reads = {
    async listConnections(input, options) { events.push(['list', input, options]); return [row()]; },
    async connectionOptions(input, options) { events.push(['options', input, options]); return grantOptions(); },
    async connectionContext(input, options) { events.push(['context', input, options]); return context(); },
  };
  const connectionStore = {
    async restrictConnection(input, options) { writes.push({ operation: 'restrict', input: structuredClone(input), signal: options.signal });
      return { ok: true, connection: { ...row(), epoch: 3, restrictions: structuredClone(input.restrictions), scopeIds: [...input.scopeIds] } }; },
    async revokeConnection(input, options) { writes.push({ operation: 'revoke', input: structuredClone(input), signal: options.signal });
      return { ok: true, status: 'revoked' }; },
  };
  const create = extra => createConnectionManagement({ auth, reads, connectionStore, clock: () => now, ...options, ...extra });
  return { auth, reads, connectionStore, events, writes, controller, options: { signal: controller.signal }, create };
}

test('read operations use the same verified browser bearer and project exact secret-free metadata', async () => {
  const f = fixture(), api = f.create();
  assert.deepEqual(Object.keys(api), ['list', 'context', 'options', 'restrict', 'revoke']);
  assert.deepEqual(await api.list(request('list'), f.options), { connections: [row()] });
  assert.deepEqual(await api.context(request('context'), f.options), { context: context() });
  assert.deepEqual(f.events.map(e => e[0]), ['verify', 'list', 'verify', 'context']);
  for (const [, input] of f.events) assert.equal(input.accessToken, 'browser.jwt.token');
  assert.equal(f.writes.length, 0); assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('TG1 metadata and revoke use one verified session and canonical owner RPC without the full capability catalog', async () => {
  for (const operation of ['list', 'options', 'context', 'revoke']) {
    const f = fixture();
    f.auth.readAuthorization = async () => { throw new Error('metadata must not construct the capability catalog'); };
    const response = await f.create()[operation](request(operation), f.options);
    assert(response);
    assert.equal(f.events.filter(([kind]) => kind === 'verify').length, 1);
    assert.equal(f.events.filter(([kind]) => ['list', 'context', 'options'].includes(kind)).length, 1);
    assert.equal(f.writes.length, operation === 'revoke' ? 1 : 0);
  }
});

test('TG1 overview combines the owned list and in-process health without another authorization or DB read', async () => {
  const f = fixture(), healthCalls = [];
  f.auth.readAuthorization = async () => { throw new Error('no full capability catalog'); };
  const status = { connector: { version: '0.2.0', startedAt: now, observedAt: now }, connections: [] };
  const api = f.create({ health: { snapshot(ownedIds) { healthCalls.push(ownedIds); return status; } } });
  assert.deepEqual(await api.overview(request('list'), f.options), { connections: [row()], status });
  assert.deepEqual(f.events.map(([kind]) => kind), ['verify', 'list']);
  assert.deepEqual(healthCalls, [[ids.connection]]);
});

const settingsRequest = () => ({ ...request('revoke'), permissionMode: 'inherit_crm',
  exclusions: { read: ['assistant.context.read'], action: [] }, scopeMode: 'unrestricted', scopeIds: [] });
function settingsFixture() {
  const f = fixture();
  f.connectionStore.updateConnectionSettings = async (input, options) => {
    f.writes.push({ operation: 'settings', input: structuredClone(input), signal: options.signal });
    return { ok: true, connection: { ...row(), epoch: input.connection.epoch + 1,
      restrictions: { read: limits().read.filter(key => !input.exclusions.read.includes(key)), action: [] },
      permissionMode: input.permissionMode, exclusions: structuredClone(input.exclusions), scopeMode: input.scopeMode,
      scopeIds: input.scopeMode === 'unrestricted' ? [ids.scope] : input.scopeIds } };
  };
  return f;
}

test('settings turn exclusions off/on on the existing connection without token handoff or full catalog auth', async () => {
  const f = settingsFixture(); f.auth.readAuthorization = async () => { throw new Error('no full catalog'); };
  const disabled = await f.create().settings(settingsRequest(), f.options);
  assert.deepEqual(disabled.connection.exclusions, { read: ['assistant.context.read'], action: [] });
  assert.deepEqual(disabled.connection.restrictions.read, []);
  assert.equal(disabled.connection.id, ids.connection); assert.equal(disabled.connection.assistantId, ids.assistant);
  assert.equal(disabled.connection.epoch, 3); assert.equal(disabled.connection.scopeMode, 'unrestricted');
  assert.deepEqual(f.events.map(([kind]) => kind), ['verify', 'list']);
  f.reads.listConnections = async () => [disabled.connection];
  const enabled = await f.create().settings({ ...settingsRequest(), expectedEpoch: 3, exclusions: { read: [], action: [] } }, f.options);
  assert.equal(enabled.connection.epoch, 4); assert.deepEqual(enabled.connection.restrictions, limits());
  assert.equal(f.writes.length, 2); assert(!JSON.stringify(enabled).includes('token'));
});

test('settings preserve explicit restricted scope and cannot write with forged ownership, state or stale epoch', async () => {
  const f = settingsFixture();
  const result = await f.create().settings({ ...settingsRequest(), scopeMode: 'restricted', scopeIds: [] }, f.options);
  assert.deepEqual(result.connection.scopeIds, []);
  for (const [delta, expected] of [[{ userId: ids.foreign }, 'backend_unavailable'], [{ organizationId: ids.foreign }, 'backend_unavailable'],
    [{ state: 'revoked' }, 'context_changed'], [{ epoch: 4 }, 'context_changed']]) {
    const g = settingsFixture(); g.reads.listConnections = async () => [{ ...row(), ...delta }];
    await assert.rejects(g.create().settings(settingsRequest(), g.options), code(expected)); assert.equal(g.writes.length, 0);
  }
  const g = settingsFixture(); g.reads.listConnections = async () => [];
  await assert.rejects(g.create().settings(settingsRequest(), g.options), code('forbidden')); assert.equal(g.writes.length, 0);
});

test('settings reject partial/invalid modes and forged grant payloads before authentication', async () => {
  for (const delta of [{ permissionMode: 'legacy_allowlist' }, { scopeMode: 'all' }, { scopeIds: [ids.scope] },
    { exclusions: { read: new Array(1), action: [] } }, { restrictions: limits() }, { userId: ids.foreign }]) {
    const f = settingsFixture();
    await assert.rejects(f.create().settings({ ...settingsRequest(), ...delta }, f.options), code('invalid_request'));
    assert.equal(f.events.length, 0); assert.equal(f.writes.length, 0);
  }
});

test('settings lost or mismatched ACK stays unknown with a settings receipt and never retries', async () => {
  for (const mode of ['lost', 'wrongOwner', 'wrongExclusions', 'secret', 'wrongEpoch']) {
    const f = settingsFixture(), original = f.connectionStore.updateConnectionSettings;
    f.connectionStore.updateConnectionSettings = async (...args) => {
      const result = await original(...args);
      if (mode === 'lost') throw new Error('private');
      if (mode === 'wrongOwner') result.connection.userId = ids.foreign;
      if (mode === 'wrongExclusions') result.connection.exclusions.read = [];
      if (mode === 'secret') result.connection.token = 'private';
      if (mode === 'wrongEpoch') result.connection.epoch++;
      return result;
    };
    await assert.rejects(f.create().settings(settingsRequest(), f.options), error => {
      assert(code('operation_outcome_unknown')(error));
      assert.deepEqual(error.receipt, { connectionId: ids.connection, expectedEpoch: 2, operation: 'settings' }); return true;
    });
    assert.equal(f.writes.length, 1);
  }
});

test('neutral policy is usable and a later metadata request observes the next SQL snapshot', async () => {
  const f = fixture(); f.reads.connectionOptions = async () => ({ ...grantOptions(), policyVersion: 0 });
  f.reads.connectionContext = async () => ({ ...context(), policyVersion: 0 });
  assert.equal((await f.create().options(request('options'), f.options)).options.policyVersion, 0);
  assert.equal((await f.create().context(request('context'), f.options)).context.policyVersion, 0);
  let calls = 0; f.reads.connectionContext = async () => ({ ...context(), policyVersion: calls++ });
  assert.equal((await f.create().context(request('context'), f.options)).context.policyVersion, 0);
  assert.equal((await f.create().context(request('context'), f.options)).context.policyVersion, 1);
  assert.equal(calls, 2);
});
test('restrict uses trusted owner/epoch metadata, narrows both parts and rechecks actual Auth after reads before one write', async () => {
  const f = fixture();
  assert.deepEqual(await f.create().restrict(request('restrict'), f.options), {
    ok: true, connection: { ...row(), epoch: 3, restrictions: { read: [], action: [] }, scopeIds: [] },
  });
  assert.deepEqual(f.events.map(e => e[0]), ['verify', 'authz', 'list', 'context', 'verify', 'authz']);
  assert.deepEqual(f.writes[0].input, { connection: row(), restrictions: { read: [], action: [] }, scopeIds: [] });
  assert.equal(f.writes.length, 1); assert(f.writes[0].signal.aborted);
});
test('revoke remains available for self-owned pending/expired/revoked metadata without a healthy assistant context', async () => {
  for (const state of ['pending', 'active', 'revoked']) {
    const f = fixture(); f.reads.listConnections = async () => [{ ...row(), state }];
    f.reads.connectionContext = async () => { throw new Error('must not require live assistant context'); };
    f.auth.readAuthorization = async () => ({ ...authorization(), permissions: { read: [], action: [] }, companyCeilings: { read: [], action: [] } });
    if (state === 'revoked') f.connectionStore.revokeConnection = async input => { f.writes.push(input); return { ok: true, status: 'already_revoked' }; };
    assert.deepEqual(await f.create().revoke(request('revoke'), f.options), { ok: true,
      status: state === 'revoked' ? 'already_revoked' : 'revoked', connectionId: ids.connection });
    assert.equal(f.writes.length, 1);
    if (state !== 'revoked') assert.deepEqual(f.writes[0].input, { connectionId: ids.connection, expectedEpoch: 2 });
  }
});
test('forged actor, arbitrary RPC/DB and caller-supplied connection objects are rejected before authentication', async () => {
  for (const operation of ['list', 'context', 'options', 'restrict', 'revoke']) {
    for (const extra of [{ actorId: ids.foreign }, { userId: ids.foreign }, { role: 'service_role' },
      { rpc: 'delete_all' }, { url: 'https://foreign.invalid' }, { connection: row() }, { sql: 'SELECT private' }]) {
      const f = fixture(); await assert.rejects(f.create()[operation]({ ...request(operation), ...extra }, f.options), code('invalid_request'));
      assert.equal(f.events.length, 0); assert.equal(f.writes.length, 0);
    }
  }
  const f = fixture(), input = request('revoke'); Object.defineProperty(input, 'expectedEpoch', { get() { throw new Error('getter must not run'); }, enumerable: true });
  await assert.rejects(f.create().revoke(input, f.options), code('invalid_request'));
});
test('malformed Auth, revoked/expired membership and ordinary multi-company metadata cannot authorize reads or writes', async () => {
  const mutations = [value => { value.userId = ids.foreign; }, value => { value.activeOrganizationIds = [ids.foreign]; },
    value => { value.activeOrganizationIds = [ids.org, ids.foreign]; }, value => { value.membership.revokedAt = now; },
    value => { value.membership.validTo = now; }, value => { value.membership.validFrom = now + 1; },
    value => { value.membership.status = 'INVITED'; }, value => { value.permissions.read = new Array(1); }];
  for (const mutate of mutations) {
    const f = fixture(); f.auth.readAuthorization = async () => { const value = authorization(); mutate(value); return value; };
    await assert.rejects(f.create().restrict(request('restrict'), f.options), code('forbidden')); assert.equal(f.writes.length, 0);
  }
  for (const value of [{ ...session(), expiresAt: now }, { ...session(), userId: 'invalid' }, { ...session(), token: 'private' }]) {
    const f = fixture(); f.auth.verifySession = async () => value;
    await assert.rejects(f.create().list(request('list'), f.options), code('reauthentication_required'));
    assert.equal(f.writes.length, 0);
  }
});
test('self-owned public rows and selected org are required even for superadmin, with duplicate/secret rows rejected', async () => {
  for (const value of [[{ ...row(), userId: ids.foreign }], [{ ...row(), organizationId: ids.foreign }],
    [row(), row()], [{ ...row(), envelope: 'PRIVATE' }], new Array(1), Array(257).fill(row())]) {
    const f = fixture(); f.auth.readAuthorization = async () => ({ ...authorization(), isSuperadmin: true, activeOrganizationIds: [ids.org, ids.foreign] });
    f.reads.listConnections = async () => value;
    await assert.rejects(f.create().revoke(request('revoke'), f.options), code('backend_unavailable')); assert.equal(f.writes.length, 0);
  }
  const f = fixture(); f.reads.listConnections = async () => [];
  await assert.rejects(f.create().revoke(request('revoke'), f.options), code('forbidden'));
});
test('stale epoch, context owner mismatch and widened scopes/read/action never reach the private write', async () => {
  const f = fixture(); await assert.rejects(f.create().restrict({ ...request('restrict'), expectedEpoch: 1 }, f.options), code('context_changed'));
  for (const delta of [{ epoch: 3 }, { assistantId: ids.foreign }, { restrictions: { read: [], action: [] } }]) {
    const g = fixture(); g.reads.connectionContext = async () => ({ ...context(), ...delta, effective: { read: [], action: [] } });
    await assert.rejects(g.create().restrict(request('restrict'), g.options), code('context_changed')); assert.equal(g.writes.length, 0);
  }
  for (const delta of [{ scopeIds: [ids.foreign] }, { restrictions: { read: ['rooms.view'], action: [] } },
    { restrictions: { read: [], action: ['rooms.edit'] } }]) {
    const g = fixture(); await assert.rejects(g.create().restrict({ ...request('restrict'), ...delta }, g.options), code('forbidden'));
    assert.equal(g.writes.length, 0);
  }
  assert.equal(f.writes.length, 0);
});
test('permission downgrade or session/account switch observed after the read prevents the pending write', async () => {
  for (const change of ['session', 'user', 'membership', 'permission']) {
    const f = fixture(); let verifies = 0, authorizations = 0;
    f.auth.verifySession = async () => (++verifies === 2 && change === 'session' ? { ...session(), sessionId: ids.foreign }
      : verifies === 2 && change === 'user' ? { ...session(), userId: ids.foreign } : session());
    f.auth.readAuthorization = async ({ userId }) => {
      authorizations++; const value = { ...authorization(), userId };
      if (authorizations === 2 && change === 'membership') value.membership.validTo = now;
      if (authorizations === 2 && change === 'permission') value.permissions.read = [];
      return value;
    };
    await assert.rejects(f.create().restrict({ ...request('restrict'), restrictions: limits() }, f.options),
      code(change === 'membership' ? 'forbidden' : 'context_changed'));
    assert.equal(f.writes.length, 0);
  }
});
test('company ceiling reduction is respected while turning every assistant permission off remains possible', async () => {
  const f = fixture(); f.reads.connectionContext = async () => ({ ...context(), companyCeilings: { read: [], action: [] }, effective: { read: [], action: [] } });
  await assert.rejects(f.create().restrict({ ...request('restrict'), restrictions: limits() }, f.options), code('forbidden'));
  assert.equal(f.writes.length, 0);
  assert.equal((await f.create().restrict(request('restrict'), f.options)).ok, true); assert.equal(f.writes.length, 1);
});
test('write false/malformed/wrong owner acknowledgements are unknown and return only safe receipt metadata', async () => {
  for (const operation of ['restrict', 'revoke']) {
    for (const result of [false, { ok: false, status: 'missing' }, { ok: true, status: 'revoked', token: 'private' },
      { ok: true, connection: { ...row(), userId: ids.foreign, epoch: 3 } }]) {
      const f = fixture(); let calls = 0;
      f.connectionStore[operation === 'restrict' ? 'restrictConnection' : 'revokeConnection'] = async () => { calls++; return result; };
      await assert.rejects(f.create()[operation](request(operation), f.options), error => {
        assert(code('operation_outcome_unknown')(error));
        assert.deepEqual(error.receipt, { connectionId: ids.connection, expectedEpoch: 2, operation });
        assert(!JSON.stringify(error).includes('private')); return true;
      }); assert.equal(calls, 1);
    }
  }
});
test('definite SQL rejection stays distinct from lost ACK and no management write retries automatically', async () => {
  for (const [thrown, expected] of [[new DurableConnectionStoreError('store_denied'), 'forbidden'],
    [new DurableConnectionStoreError('store_conflict'), 'context_changed'], [new DurableConnectionStoreError('store_rejected'), 'operation_rejected'],
    [new DurableConnectionStoreError('store_outcome_unknown'), 'operation_outcome_unknown'],
    [Object.assign(new Error('PRIVATE SQL/JWT/password'), { code: 'store_denied' }), 'operation_outcome_unknown']]) {
    const f = fixture(); let calls = 0; f.connectionStore.revokeConnection = async () => { calls++; throw thrown; };
    await assert.rejects(f.create().revoke(request('revoke'), f.options), code(expected)); assert.equal(calls, 1);
  }
  const f = fixture(); f.auth.verifySession = async () => { throw new BrokerError('unauthorized'); };
  await assert.rejects(f.create().list(request('list'), f.options), code('reauthentication_required'));
});
test('preabort and cancellation while reading never dispatch a later write, even after a delayed response', async () => {
  const f = fixture(); f.controller.abort();
  await assert.rejects(f.create().revoke(request('revoke'), f.options), code('cancelled')); assert.equal(f.events.length, 0);
  const g = fixture(), started = deferred(), wait = deferred(); let readSignal;
  g.reads.listConnections = async (_input, { signal }) => { readSignal = signal; started.resolve(); await wait.promise; return [row()]; };
  const pending = g.create().revoke(request('revoke'), g.options); await started.promise;
  const rejected = assert.rejects(pending, code('cancelled')); g.controller.abort(); await rejected;
  wait.resolve(); await tick(); assert.equal(g.writes.length, 0); assert(readSignal.aborted);
  assert.equal(getEventListeners(g.controller.signal, 'abort').length, 0);
});
test('cancellation or timeout after dispatch stays unknown and ignores late successful write receipts', async () => {
  for (const cancelled of [true, false]) {
    const f = fixture(), started = deferred(), wait = deferred(); let calls = 0, writeSignal;
    f.connectionStore.revokeConnection = async (_input, { signal }) => { calls++; writeSignal = signal; started.resolve(); return wait.promise; };
    const pending = f.create({ timeoutMs: cancelled ? 1000 : 10 }).revoke(request('revoke'), f.options);
    const rejected = assert.rejects(pending, code('operation_outcome_unknown'));
    await started.promise; if (cancelled) f.controller.abort(); await rejected;
    wait.resolve({ ok: true, status: 'revoked' }); await tick(); assert.equal(calls, 1); assert(writeSignal.aborted);
    assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  }
});
test('request and read reply mutation cannot alter later write identity or granted limits', async () => {
  const f = fixture(), started = deferred(), wait = deferred(), source = row(); let verifies = 0;
  f.reads.listConnections = async () => [source];
  f.auth.verifySession = async () => { if (++verifies === 2) { started.resolve(); await wait.promise; } return session(); };
  const input = request('restrict'), pending = f.create().restrict(input, f.options); await started.promise;
  input.connectionId = ids.foreign; input.restrictions.read.push('rooms.view'); input.scopeIds.push(ids.foreign);
  source.userId = ids.foreign; source.scopeIds.push(ids.foreign); wait.resolve();
  const result = await pending;
  assert.equal(result.connection.userId, ids.user); assert.deepEqual(result.connection.restrictions, { read: [], action: [] });
  assert.deepEqual(f.writes[0].input.connection, row()); assert.deepEqual(f.writes[0].input.scopeIds, []);
});

const origin = 'https://fixture.supabase.co', key = 'sb_publishable_fixture';
test('fixed reads adapter uses exactly three public RPCs, pins bearer/body and accepts no endpoint/role injection', async () => {
  const calls = [], controller = new AbortController();
  const adapter = createSupabaseConnectionManagementReads({ url: origin, publishableKey: key,
    fetch: async (url, options) => { calls.push({ url, ...options }); return Response.json([]); } });
  assert.deepEqual(Object.keys(adapter), ['listConnections', 'connectionOptions', 'connectionContext']);
  await adapter.listConnections({ accessToken: 'browser.token', organizationId: ids.org }, { signal: controller.signal });
  await adapter.connectionContext({ accessToken: 'browser.token', connectionId: ids.connection }, { signal: controller.signal });
  assert.deepEqual(calls.map(c => c.url), [origin + '/rest/v1/rpc/hermes_my_connections_v1', origin + '/rest/v1/rpc/hermes_connection_context_v7']);
  assert.deepEqual(calls.map(c => JSON.parse(c.body)), [{ p_org: ids.org }, { p_connection_id: ids.connection }]);
  for (const call of calls) { assert.equal(call.headers.authorization, 'Bearer browser.token'); assert.equal(call.headers['content-profile'], 'public');
    assert.equal(call.headers['accept-profile'], 'public'); assert.equal(call.redirect, 'error'); assert.equal(call.method, 'POST'); }
  await assert.rejects(adapter.listConnections({ accessToken: 'browser.token', organizationId: ids.org, rpc: 'other' }, { signal: controller.signal }), code('invalid_request'));
  assert.equal(calls.length, 2);
});
test('fixed reads sanitize denied/outage/malformed/oversized replies and never retry', async () => {
  for (const [response, expected] of [[() => Response.json({ message: 'PRIVATE' }, { status: 401 }), 'reauthentication_required'],
    [() => Response.json({ message: 'PRIVATE' }, { status: 403 }), 'forbidden'], [() => Response.json({ message: 'PRIVATE' }, { status: 503 }), 'backend_unavailable'],
    [() => new Response('invalid-json', { headers: { 'content-type': 'application/json' } }), 'backend_unavailable'],
    [() => Response.json({ large: 'x'.repeat(300) }), 'backend_unavailable'], [() => new Response('PRIVATE'), 'backend_unavailable']]) {
    let calls = 0;
    const adapter = createSupabaseConnectionManagementReads({ url: origin, publishableKey: key, maxResponseBytes: 128,
      fetch: async () => { calls++; return response(); } });
    await assert.rejects(adapter.listConnections({ accessToken: 'browser.token', organizationId: ids.org }, { signal: new AbortController().signal }), code(expected));
    assert.equal(calls, 1);
  }
});
test('reads cancellation/deadline bounds a hanging response and prevents use of a late reply', async () => {
  for (const cancel of [false, true]) {
    let calls = 0, receivedSignal; const started = deferred(), wait = deferred(), controller = new AbortController();
    const adapter = createSupabaseConnectionManagementReads({ url: origin, publishableKey: key, timeoutMs: cancel ? 1000 : 10,
      fetch: async (_url, { signal }) => { calls++; receivedSignal = signal; started.resolve(); return wait.promise; } });
    const pending = adapter.listConnections({ accessToken: 'browser.token', organizationId: ids.org }, { signal: controller.signal });
    const rejected = assert.rejects(pending, code(cancel ? 'cancelled' : 'backend_unavailable'));
    await started.promise; if (cancel) controller.abort(); await rejected;
    wait.resolve(Response.json([row()])); await tick(); assert.equal(calls, 1); assert(receivedSignal.aborted);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});
test('configuration and malformed scopes/signals fail before an external dependency is invoked', async () => {
  assert.throws(() => createConnectionManagement(), { message: 'invalid_connection_management_config' });
  for (const url of ['http://fixture.supabase.co', origin + '/rest/v1', 'https://user:password@fixture.supabase.co', origin + '?target=other']) {
    assert.throws(() => createSupabaseConnectionManagementReads({ url, publishableKey: key }));
  }
  const f = fixture();
  await assert.rejects(f.create().list(request('list')), code('invalid_request'));
  for (const scopeIds of [[ids.scope, ids.scope], new Array(1), [ids.assistant.toUpperCase()]]) {
    await assert.rejects(f.create().restrict({ ...request('restrict'), scopeIds }, f.options), code('invalid_request'));
  }
  assert.equal(f.events.length, 0);
  const error = new ConnectionManagementError('private password'); assert.equal(error.code, 'backend_unavailable');
});

test('legacy restrict still rejects authority identity/version/role and permission changes before writing', async () => {
  const mutations = [value => { value.membership.membershipId = ids.foreign; },
    value => { value.membership.authorizationVersion++; }, value => { value.isSuperadmin = true; },
    value => { value.epoch = 'authorization-epoch-2'; }, value => { value.permissions.read = []; },
    value => { value.companyCeilings.read = []; }];
  for (const operation of ['restrict']) {
    for (const mutate of mutations) {
      const f = fixture(); let calls = 0;
      f.auth.readAuthorization = async () => { const value = authorization(); if (++calls === 2) mutate(value); return value; };
      await assert.rejects(f.create()[operation](request(operation), f.options), code('context_changed'));
      assert.equal(calls, 2); assert.equal(f.writes.length, 0);
    }
  }
});

test('missing authority metadata cannot silently fall back to the P1 adapter contract', async () => {
  for (const mutate of [value => { delete value.membership.membershipId; }, value => { delete value.membership.authorizationVersion; },
    value => { delete value.epoch; }, value => { value.membership.authorizationVersion = 0; }]) {
    const f = fixture(); f.auth.readAuthorization = async () => { const value = authorization(); mutate(value); return value; };
    await assert.rejects(f.create().restrict(request('restrict'), f.options), code('forbidden'));
    assert(!f.events.some(([kind]) => kind === 'context')); assert.equal(f.writes.length, 0);
  }
});

test('canonical context must retain owner/org and well-formed membership/version/effective rights', async () => {
  for (const delta of [{ userId: ids.foreign }, { organizationId: ids.foreign }, { membershipId: null },
    { authorizationVersion: 0 }, { isSuperadmin: 'true' }, { effective: { read: ['rooms.view'], action: [] } }]) {
    const f = fixture(); f.reads.connectionContext = async () => ({ ...context(), ...delta });
    await assert.rejects(f.create().context(request('context'), f.options), code('backend_unavailable'));
    assert.equal(f.writes.length, 0);
  }
});

test('metadata snapshots observe policy/connection changes or revocation on the next request', async () => {
  for (const delta of [{ policyVersion: 2 }, { epoch: 3 }, { scopeIds: [] }, { effective: { read: [], action: [] } },
    { restrictions: { read: [], action: [] }, effective: { read: [], action: [] } },
    { companyCeilings: { read: [], action: [] }, effective: { read: [], action: [] } }]) {
    const f = fixture(); let calls = 0;
    f.reads.connectionContext = async () => ({ ...context(), ...(++calls === 2 ? delta : {}) });
    assert.deepEqual((await f.create().context(request('context'), f.options)).context, context());
    assert.deepEqual((await f.create().context(request('context'), f.options)).context, { ...context(), ...delta });
    assert.equal(calls, 2); assert.equal(f.writes.length, 0);
  }
  const f = fixture(); let calls = 0;
  f.reads.connectionContext = async () => { if (++calls === 2) throw new BrokerError('forbidden'); return context(); };
  await f.create().context(request('context'), f.options);
  await assert.rejects(f.create().context(request('context'), f.options), code('forbidden'));
  assert.equal(calls, 2);
});

test('authority snapshots cannot be changed by mutating an earlier provider result', async () => {
  const f = fixture(), source = authorization();
  f.auth.readAuthorization = async () => source;
  f.reads.listConnections = async () => { source.membership.authorizationVersion++; source.permissions.read = []; return [row()]; };
  await assert.rejects(f.create().restrict(request('restrict'), f.options), code('context_changed'));
});

test('metadata does not cache the SQL role projection across requests', async () => {
  const f = fixture(); let calls = 0;
  f.reads.connectionContext = async () => ({ ...context(), isSuperadmin: ++calls === 1 });
  assert.equal((await f.create().context(request('context'), f.options)).context.isSuperadmin, true);
  assert.equal((await f.create().context(request('context'), f.options)).context.isSuperadmin, false);
  assert.equal(calls, 2);
});

test('canonical permission and organization ordering does not invent an authority change', async () => {
  const f = fixture(); let calls = 0;
  f.reads.connectionContext = async () => ({ ...context(), isSuperadmin: true });
  f.auth.readAuthorization = async () => {
    const value = authorization(); value.isSuperadmin = true;
    value.activeOrganizationIds = [ids.org, ids.foreign]; value.permissions.read.push('rooms.view'); value.companyCeilings.read.push('rooms.view');
    if (++calls === 2) { value.activeOrganizationIds.reverse(); value.permissions.read.reverse(); value.companyCeilings.read.reverse(); }
    return value;
  };
  assert.equal((await f.create().restrict(request('restrict'), f.options)).ok, true);
  assert.equal(calls, 2);
});

test('JWT expiry while the canonical metadata RPC is pending cannot return success or dispatch revoke', async () => {
  for (const operation of ['list', 'context', 'options', 'revoke']) {
    const f = fixture(); let time = now;
    for (const method of ['listConnections', 'connectionContext', 'connectionOptions']) {
      const read = f.reads[method];
      f.reads[method] = async (...args) => { const value = await read(...args); time = now + 60_000; return value; };
    }
    await assert.rejects(f.create({ clock: () => time })[operation](request(operation), f.options), code('reauthentication_required'));
    assert.equal(f.writes.length, 0);
  }
});

test('legacy restrict rejects a session expiring during either full authorization read', async () => {
  for (const operation of ['restrict']) {
    for (const expiryRead of [1, 2]) {
      const f = fixture(); let time = now, calls = 0;
      f.auth.readAuthorization = async () => {
        if (++calls === expiryRead) time = now + 60_000;
        return authorization();
      };
      await assert.rejects(f.create({ clock: () => time })[operation](request(operation), f.options), code('reauthentication_required'));
      assert.equal(calls, expiryRead); assert.equal(f.writes.length, 0);
      if (expiryRead === 1) assert(!f.events.some(([kind]) => ['list', 'context'].includes(kind)));
    }
  }
});

test('expiry after write dispatch remains unknown with a safe receipt and never repeats the write', async () => {
  for (const operation of ['restrict', 'revoke']) {
    const f = fixture(); let time = now, calls = 0;
    const method = operation === 'restrict' ? 'restrictConnection' : 'revokeConnection';
    const original = f.connectionStore[method];
    f.connectionStore[method] = async (...args) => { calls++; const result = await original(...args); time = now + 60_000; return result; };
    await assert.rejects(f.create({ clock: () => time })[operation](request(operation), f.options), error => {
      assert(code('operation_outcome_unknown')(error));
      assert.deepEqual(error.receipt, { connectionId: ids.connection, expectedEpoch: 2, operation }); return true;
    });
    assert.equal(calls, 1); assert.equal(f.writes.length, 1);
  }
});

test('self options use the verified browser identity and one canonical choices snapshot',async()=>{
 const f=fixture(),result=await f.create().options(request('options'),f.options);
 assert.deepEqual(result,{options:grantOptions()});assert.equal(f.writes.length,0);
 assert.deepEqual(f.events.map(e=>e[0]),['verify','options']);
 for(const [,input] of f.events)assert.equal(input.accessToken,'browser.jwt.token');
});
test('options reject wrong owner or malformed canonical membership and observe later policy snapshots',async()=>{
 for(const delta of [{userId:ids.foreign},{organizationId:ids.foreign},{membershipId:null},{authorizationVersion:0},{isSuperadmin:'true'}]) {
  const f=fixture();f.reads.connectionOptions=async()=>({...grantOptions(),...delta});
  await assert.rejects(f.create().options(request('options'),f.options));assert.equal(f.writes.length,0);
 }
 for(const field of ['policyVersion','enabled']) {
  const f=fixture();let calls=0;
  f.reads.connectionOptions=async()=>{const value=grantOptions();if(++calls===2){if(field==='policyVersion')value.policyVersion++;else{value.enabled=false;value.read=[];}}return value;};
  const before = (await f.create().options(request('options'),f.options)).options;
  const after = (await f.create().options(request('options'),f.options)).options;
  assert.notEqual(before[field],after[field]);assert.equal(calls,2);
 }
});
test('options are snapshots, cannot trust changed earlier objects or accept arbitrary RPC inputs',async()=>{
 const f=fixture(),source=grantOptions();f.reads.connectionOptions=async()=>source;
 const result=await f.create().options(request('options'),f.options);
 source.policyVersion++;source.read.push('rooms.view');
 assert.deepEqual(result.options,grantOptions());
});
test('fixed options read uses selected organization and never a caller-selected admin catalog',async()=>{
 const calls=[],controller=new AbortController();
 const api=createSupabaseConnectionManagementReads({url:'https://project.example',publishableKey:'sb_publishable_test',fetch:async(url,init)=>{
 calls.push({url,init});return new Response(JSON.stringify(grantOptions()),{headers:{'content-type':'application/json'}});}});
 await api.connectionOptions({accessToken:'browser.jwt.token',organizationId:ids.org},{signal:controller.signal});
 assert.equal(calls[0].url,'https://project.example/rest/v1/rpc/hermes_connection_options_v7');
 assert.deepEqual(JSON.parse(calls[0].init.body),{p_org:ids.org});assert.equal(calls[0].init.headers.authorization,'Bearer browser.jwt.token');
 await assert.rejects(api.connectionOptions({accessToken:'browser.jwt.token',organizationId:ids.org,rpc:'admin_catalog'},{signal:controller.signal}),code('invalid_request'));
 assert.equal(calls.length,1);
});

test('canonical RPC denial for inactive membership or foreign org prevents metadata and revoke',async()=>{
 for(const operation of ['list','context','options','revoke']){
  const f=fixture();
  for(const method of Object.keys(f.reads))f.reads[method]=async()=>{throw new BrokerError('forbidden');};
  await assert.rejects(f.create()[operation](request(operation),f.options),code('forbidden'));
  assert.equal(f.writes.length,0);
 }
});
test('the next options request reflects action revocation from canonical SQL',async()=>{
 const f=fixture();let reads=0;f.reads.connectionOptions=async()=>({...grantOptions(),action:['chat_zalo.send']});
 f.reads.connectionOptions=async()=>({...grantOptions(),action:reads++?[]:['chat_zalo.send']});
 assert.deepEqual((await f.create().options(request('options'),f.options)).options.action,['chat_zalo.send']);
 assert.deepEqual((await f.create().options(request('options'),f.options)).options.action,[]);assert.equal(f.writes.length,0);
});

test('missing v7 read schema keeps v6 action metadata with the same caller', async () => {
  for (const [operation, input, base] of [
    ['connectionOptions', { accessToken: 'browser.token', organizationId: ids.org }, 'hermes_connection_options'],
    ['connectionContext', { accessToken: 'browser.token', connectionId: ids.connection }, 'hermes_connection_context'],
  ]) {
    const calls = [];
    const adapter = createSupabaseConnectionManagementReads({ url: origin, publishableKey: key,
      fetch: async (url, init) => {
        calls.push({ url, init });
        return calls.length === 1 ? Response.json({ code: 'PGRST202', message: 'function absent', details: null, hint: null }, { status: 404 })
          : Response.json({ effective: { read: [], action: [] } });
      } });
    const result = await adapter[operation](input, { signal: new AbortController().signal });
    assert.deepEqual(result.effective.action, []);
    assert.deepEqual(calls.map(call => call.url), [`${origin}/rest/v1/rpc/${base}_v7`, `${origin}/rest/v1/rpc/${base}_v6`]);
    assert.equal(calls[0].init.body, calls[1].init.body);
    assert.equal(calls[0].init.headers.authorization, calls[1].init.headers.authorization);
    assert.equal(calls[0].init.signal, calls[1].init.signal);
  }
});

test('a denied, unknown or malformed v7 reply cannot negotiate legacy authority', async () => {
  for (const [status, body] of [[403, { code: '42501' }], [503, { code: 'PGRST202', message: 'absent', details: null, hint: null }],
    [404, { code: 'PGRST202' }], [404, { code: 'OTHER', message: 'absent', details: null, hint: null }]]) {
    let calls = 0;
    const adapter = createSupabaseConnectionManagementReads({ url: origin, publishableKey: key,
      fetch: async () => { calls++; return Response.json(body, { status }); } });
    await assert.rejects(adapter.connectionOptions({ accessToken: 'browser.token', organizationId: ids.org },
      { signal: new AbortController().signal }));
    assert.equal(calls, 1);
  }
});

test('v1 compatibility is retained after exact missing v7, v6, v5, v4, v3 and v2, with no downgrade on malformed v6', async () => {
  for (const malformed of [false, true]) {
    const calls = [];
    const adapter = createSupabaseConnectionManagementReads({ url: origin, publishableKey: key, fetch: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1 || calls.length <= 6 && !malformed) return Response.json({ code: 'PGRST202', message: 'absent', details: null, hint: null }, { status: 404 });
      if (malformed) return Response.json({ code: 'PGRST202' }, { status: 404 });
      return Response.json({ effective: { read: [], action: [] } });
    } });
    const result = adapter.connectionOptions({ accessToken: 'browser.token', organizationId: ids.org }, { signal: new AbortController().signal });
    if (malformed) { await assert.rejects(result); assert.equal(calls.length, 2); }
    else { await result; assert.deepEqual(calls.map(call => call.url), [7, 6, 5, 4, 3, 2, 1].map(v => `${origin}/rest/v1/rpc/hermes_connection_options_v${v}`)); }
    assert.equal(new Set(calls.map(call => call.init.body)).size, 1);
  }
});
