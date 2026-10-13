import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { createRuntimeModelService, RuntimeModelServiceError } from './runtime-model-service.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createModelRelay, ModelRelayError } from './model-relay.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const I = { org: id(1), user: id(2), assistant: id(3), connection: id(4), session: id(5), credential: id(6), membership: id(7), scope: id(8), foreign: id(9) };
const NOW = Date.parse('2026-10-13T08:00:00Z'), token = 'hc_' + 'A'.repeat(43);
const digest = createHash('sha256').update(token).digest('hex');
const limits = () => ({ read: ['assistant.context.read'], action: [] });
const jwt = (overrides = {}) => ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify({ role: 'authenticated', sub: I.user,
  session_id: I.session, exp: NOW / 1000 + 600, ...overrides })).toString('base64url'), 'signature'].join('.');
const body = () => ({ model: 'openai:test', messages: [{ role: 'user', content: 'Các phòng trống?' }], max_tokens: 128, stream: false });
const answer = () => ({ id: 'safe-completion', object: 'chat.completion', choices: [{ index: 0,
  message: { role: 'assistant', content: 'Phòng 101 trống.' }, finish_reason: 'stop' }], usage: { total_tokens: 12 } });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const code = expected => error => error instanceof RuntimeModelServiceError && error.code === expected && error.message === expected && error.cause === undefined;
const settled = promise => promise.then(() => {}, () => {});

function fixture(t) {
  let time = NOW; const events = [], calls = [], services = [], controller = new AbortController();
  const crypto = createSessionCrypto({ activeKeyVersion: 'test', keys: new Map([['test', randomBytes(32)]]) });
  const binding = { assistantId: I.assistant, userId: I.user, organizationId: I.org, sessionId: I.session };
  const material = { accessToken: jwt(), refreshToken: 'PRIVATE_REFRESH', expiresAt: NOW + 600000 };
  const joined = { status: 'active', connection: { id: I.connection, assistantId: I.assistant, userId: I.user,
    organizationId: I.org, state: 'active', epoch: 1, expiresAt: NOW + 300000, restrictions: limits(), scopeIds: [I.scope], tokenDigest: digest, credentialRef: I.credential },
  session: { credentialRef: I.credential, revision: 1, envelope: crypto.seal(material, binding), expiresAt: material.expiresAt, binding },
  membership: { membershipId: I.membership, authorizationVersion: 1, isSuperadmin: false },
  policy: { version: 1, read: limits().read, action: [], scopeIds: [I.scope] } };
  const authz = { userId: I.user, isSuperadmin: false, activeOrganizationIds: [I.org], epoch: 'crm-1',
    membership: { organizationId: I.org, status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null,
      membershipId: I.membership, authorizationVersion: 1 }, permissions: limits(), companyCeilings: limits(),
    scopesByPermission: { 'assistant.context.read': { buildingIds: [], cashbookIds: [] } } };
  const auth = {
    async verifySession({ accessToken, signal }) { events.push('verify'); assert.equal(accessToken, material.accessToken); assert(signal instanceof AbortSignal);
      return { userId: I.user, sessionId: I.session, expiresAt: material.expiresAt }; },
    async readAuthorization() { events.push('authz'); return structuredClone(authz); },
  };
  const connectionStore = { async readConnection(input) { events.push('store'); assert.deepEqual(input, { tokenDigest: digest }); return structuredClone(joined); } };
  const authority = createDurableAuthority({ auth, connectionStore, crypto, clock: () => time });
  const relay = { beginCompletion(input) { events.push('relay'); calls.push(input); const result = Promise.resolve(answer()); return { result, drained: settled(result) }; } };
  // Synthetic drain scope: integration must replace it with the actual transport
  // tracker; tests below hold/reject drained independently of public settlement.
  const dependencyScope = { begin(work) { const result = work(); return { result, drained: settled(result) }; } };
  const create = extra => { const service = createRuntimeModelService({ authority, connectionStore, crypto, auth, relay, dependencyScope, clock: () => time, ...extra }); services.push(service); return service; };
  const input = extra => ({ token, requestId: randomUUID(), body: body(), signal: controller.signal, ...extra });
  t.after(async () => { for (const service of services) await service.close().catch(() => {}); crypto.destroy(); });
  return { create, input, authority, connectionStore, crypto, auth, authz, relay, dependencyScope, material, binding, joined, calls, events, controller, time: value => { time = value; } };
}

test('verified opaque connection uses its real encrypted user JWT and existing authority before and after relay', async t => {
  const f = fixture(t), service = f.create(), input = f.input();
  const handle = service.beginCompletion(input), result = await handle.result; await handle.drained;
  assert.deepEqual(result, answer()); assert(Object.isFrozen(result)); assert(Object.isFrozen(result.choices[0].message));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(Object.keys(f.calls[0]).sort(), ['accessToken', 'organizationId', 'requestId', 'body', 'signal'].sort());
  assert.equal(f.calls[0].accessToken, f.material.accessToken); assert.equal(f.calls[0].organizationId, I.org); assert.equal(f.calls[0].requestId, input.requestId);
  assert(!JSON.stringify(f.calls[0].body).includes('PRIVATE')); assert(!JSON.stringify(handle).includes(token));
  assert(!JSON.stringify(result).includes(f.material.accessToken)); assert(!JSON.stringify(result).includes('PRIVATE_REFRESH'));
  assert.equal(f.events.filter(event => event === 'authz').length, 3);
  assert.equal(f.events.at(-1), 'store'); assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('missing actual-drain ports and unbounded configuration are rejected', t => {
  const f = fixture(t);
  for (const extra of [{ relay: { complete() {} } }, { dependencyScope: {} }, { timeoutMs: 0 }, { timeoutMs: 180001 },
    { maxConcurrent: 0 }, { maxConcurrent: 65 }, { maxRequests: 65537 }, { clock: null }]) {
    assert.throws(() => f.create(extra), /invalid_runtime_model_service_config/);
  }
});

test('caller cannot assert JWT, organization, connection, user, or accessors before any dependency', async t => {
  const f = fixture(t), service = f.create(); let getterCalls = 0;
  for (const delta of [{ organizationId: I.foreign }, { accessToken: jwt() }, { connectionId: I.connection }, { userId: I.user },
    { requestId: 'invalid' }, { signal: {} }, { body: { ...body(), stream: true } }, { body: { ...body(), max_tokens: 4097 } },
    { body: { ...body(), endpoint: 'https://foreign.invalid' } }, { body: { ...body(), messages: new Array(1) } },
    { body: { ...body(), messages: [{ role: 'user', content: 'x'.repeat(262145) }] } }]) {
    await assert.rejects(service.complete(f.input(delta)), code('invalid_request'));
  }
  const accessor = f.input(); Object.defineProperty(accessor, 'token', { enumerable: true, get() { getterCalls++; return token; } });
  await assert.rejects(service.complete(accessor), code('invalid_request'));
  const nested = body(); Object.defineProperty(nested.messages[0], 'content', { enumerable: true, get() { getterCalls++; return 'secret'; } });
  await assert.rejects(service.complete(f.input({ body: nested })), code('invalid_request'));
  await assert.rejects(service.complete(f.input({ token: jwt() })), code('unauthorized'));
  const cyclic = body(); cyclic.messages[0].content = cyclic;
  await assert.rejects(service.complete(f.input({ body: cyclic })), code('invalid_request'));
  assert.equal(getterCalls, 0); assert.equal(f.events.length, 0);
});

test('the request body and trusted joined reply are captured before later caller mutation', async t => {
  const f = fixture(t), wait = deferred(), started = deferred(), original = f.connectionStore.readConnection;
  f.connectionStore.readConnection = async (...args) => { started.resolve(); await wait.promise; return original(...args); };
  const request = f.input(), originalText = request.body.messages[0].content;
  const pending = f.create().complete(request); await started.promise;
  request.body.messages[0].content = 'MUTATED'; request.body.model = 'other:provider'; request.token = 'hc_' + 'B'.repeat(43); request.requestId = I.foreign;
  wait.resolve(); await pending;
  assert.equal(f.calls[0].body.messages[0].content, originalText); assert.equal(f.calls[0].body.model, 'openai:test');
  assert(Object.isFrozen(f.calls[0].body)); assert(Object.isFrozen(f.calls[0].body.messages[0]));
});

test('digest, owner, credential, session and epoch mismatches are refused before relay', async t => {
  for (const mutate of [joined => { joined.connection.tokenDigest = 'b'.repeat(64); }, joined => { joined.connection.id = I.foreign; },
    joined => { joined.connection.epoch++; }, joined => { joined.connection.userId = I.foreign; },
    joined => { joined.connection.organizationId = I.foreign; }, joined => { joined.connection.assistantId = I.foreign; },
    joined => { joined.session.binding.sessionId = I.foreign; }, joined => { joined.session.binding.userId = I.foreign; },
    joined => { joined.session.credentialRef = I.foreign; }, joined => { joined.session.expiresAt = NOW; }]) {
    const f = fixture(t), original = f.connectionStore.readConnection; let reads = 0;
    f.connectionStore.readConnection = async input => { const result = await original(input); if (++reads === 3) mutate(result); return result; };
    await assert.rejects(f.create().complete(f.input()), error => error instanceof RuntimeModelServiceError);
    assert.equal(f.calls.length, 0);
  }
});

test('privileged or foreign JWT claims and real Auth mismatches never reach paid relay', async t => {
  for (const change of [{ role: 'service_role' }, { sub: I.foreign }, { session_id: I.foreign }, { exp: NOW / 1000 + 601 }]) {
    const f = fixture(t); f.material.accessToken = jwt(change); f.joined.session.envelope = f.crypto.seal(f.material, f.binding);
    await assert.rejects(f.create().complete(f.input()), code('unauthorized')); assert.equal(f.calls.length, 0);
  }
  const f = fixture(t), original = f.auth.verifySession; let verified = 0;
  f.auth.verifySession = async input => ({ ...await original(input), ...( ++verified === 2 ? { sessionId: I.foreign } : {}) });
  await assert.rejects(f.create().complete(f.input()), code('unauthorized')); assert.equal(f.calls.length, 0);
});

test('permission or owner changes before model admission block the relay', async t => {
  for (const mutate of [f => { f.joined.connection.epoch++; }, f => { f.authz.permissions.read = []; },
    f => { f.authz.membership.revokedAt = NOW; }, f => { f.joined.session.revision++; }, f => { f.joined.policy.version++; }]) {
    const f = fixture(t), original = f.auth.verifySession; let count = 0;
    f.auth.verifySession = async input => { const result = await original(input); if (++count === 2) mutate(f); return result; };
    await assert.rejects(f.create().complete(f.input()), error => error instanceof RuntimeModelServiceError && ['forbidden', 'context_changed'].includes(error.code));
    assert.equal(f.calls.length, 0);
  }
});

test('post-model permission, session and epoch changes discard output after one paid attempt', async t => {
  for (const mutate of [f => { f.joined.connection.epoch++; }, f => { f.authz.permissions.read = []; },
    f => { f.authz.membership.revokedAt = NOW; }, f => { f.joined.session.revision++; }, f => { f.joined.policy.version++; }]) {
    const f = fixture(t), original = f.relay.beginCompletion;
    f.relay.beginCompletion = input => { const handle = original(input); mutate(f); return handle; };
    const service = f.create(), input = f.input();
    await assert.rejects(service.complete(input), error => error instanceof RuntimeModelServiceError && ['forbidden', 'context_changed'].includes(error.code));
    await assert.rejects(service.complete(input), code('invalid_request')); assert.equal(f.calls.length, 1);
  }
});

test('both unchanged checks must return void and cannot accept a forged receipt result', async t => {
  for (const breakAt of [1, 2]) {
    const f = fixture(t); let count = 0;
    const authority = { ...f.authority, async checkUnchanged(...args) { await f.authority.checkUnchanged(...args); if (++count === breakAt) return { ok: true }; } };
    await assert.rejects(f.create({ authority }).complete(f.input()), code('context_changed'));
    assert.equal(f.calls.length, breakAt === 1 ? 0 : 1);
  }
});

test('unknown relay errors are sanitized and latch the token across new request IDs without retry', async t => {
  for (const thrown of [new Error(`RAW ${token} ${jwt()} PRIVATE_REFRESH`), new ModelRelayError('proxy_unavailable'), new ModelRelayError('timeout')]) {
    const f = fixture(t); f.relay.beginCompletion = input => { f.calls.push(input); const result = Promise.reject(thrown); return { result, drained: settled(result) }; };
    const service = f.create(); await assert.rejects(service.complete(f.input()), code('model_unknown'));
    await assert.rejects(service.complete(f.input()), code('model_unknown')); assert.equal(f.calls.length, 1);
  }
});

test('definite relay policy rejection is sanitized, never retried, and does not impersonate a permission grant', async t => {
  const f = fixture(t); f.relay.beginCompletion = input => { f.calls.push(input); const result = Promise.reject(new ModelRelayError('not_entitled')); return { result, drained: settled(result) }; };
  const service = f.create(), input = f.input();
  await assert.rejects(service.complete(input), code('forbidden'));
  await assert.rejects(service.complete(input), code('invalid_request')); assert.equal(f.calls.length, 1);
});

test('caller cancellation and timeout settle the public result but retain relay capacity and close until actual drain', async t => {
  for (const mode of ['cancel', 'timeout', 'close']) {
    const f = fixture(t), launched = deferred(), upstream = deferred(), drained = deferred();
    f.relay.beginCompletion = input => { f.calls.push(input); launched.resolve(); return { result: upstream.promise, drained: drained.promise }; };
    const service = f.create({ maxConcurrent: 1, timeoutMs: mode === 'timeout' ? 20 : 1000 });
    const handle = service.beginCompletion(f.input()), rejection = assert.rejects(handle.result, code('model_unknown'));
    await launched.promise;
    let closing, closed = false;
    if (mode === 'cancel') f.controller.abort();
    if (mode === 'close') closing = service.close().then(() => { closed = true; });
    await rejection; assert(f.calls[0].signal.aborted);
    if (!closing) closing = service.close().then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    upstream.resolve(answer()); await tick(); assert.equal(closed, false);
    drained.resolve(); await handle.drained; await closing; assert.equal(closed, true);
    assert.equal(f.calls.length, 1); assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
  }
});

test('an early authority timeout does not release hidden transport tracked by dependencyScope', async t => {
  const f = fixture(t), transport = deferred(), entered = deferred();
  const dependencyScope = { begin(work) { const result = work(); return { result, drained: Promise.all([settled(result), transport.promise]).then(() => {}) }; } };
  const authority = { ...f.authority, async resolve() { entered.resolve(); throw new Error('unavailable'); } };
  const service = f.create({ authority, dependencyScope, maxConcurrent: 1 });
  const handle = service.beginCompletion(f.input()); await entered.promise;
  await assert.rejects(handle.result, code('backend_unavailable'));
  await assert.rejects(service.complete(f.input()), code('busy'));
  let closed = false; const closing = service.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  transport.resolve(); await handle.drained; await closing; assert.equal(f.calls.length, 0);
});

test('rejected drain closes admission and does not claim shutdown succeeded', async t => {
  const f = fixture(t), transport = deferred();
  f.relay.beginCompletion = input => { f.calls.push(input); return { result: Promise.resolve(answer()), drained: transport.promise }; };
  const service = f.create(), handle = service.beginCompletion(f.input()); await handle.result;
  transport.reject(new Error('PRIVATE_DRAIN_FAILURE'));
  await assert.rejects(handle.drained, code('backend_unavailable'));
  await assert.rejects(service.complete(f.input()), code('closed'));
  await assert.rejects(service.close(), code('backend_unavailable')); assert.equal(f.calls.length, 1);
});

test('capacity tracks actual relay drain even after a successful result and tombstones never evict into replay', async t => {
  const f = fixture(t), transport = deferred();
  f.relay.beginCompletion = input => { f.calls.push(input); return { result: Promise.resolve(answer()), drained: transport.promise }; };
  const service = f.create({ maxConcurrent: 1, maxRequests: 1 }), input = f.input(), handle = service.beginCompletion(input);
  await handle.result;
  await assert.rejects(service.complete(input), code('invalid_request'));
  await assert.rejects(service.complete(f.input()), code('busy'));
  transport.resolve(); await handle.drained;
  await assert.rejects(service.complete(f.input()), code('busy')); assert.equal(f.calls.length, 1);
});

test('completion shape and size failures never expose relay internals and prevent paid replay', async t => {
  for (const mutate of [result => { result.accessToken = jwt(); }, result => { result.error = { message: 'PRIVATE' }; },
    result => { result.choices[0].message.content = 'x'.repeat(131073); }, result => { result.choices[0].message.userId = I.user; },
    result => { result.choices[0].message.tool_calls = [{ id: 'call-1', type: 'function', function: { name: 'mcp__crm__unknown', arguments: '{}' } }]; }]) {
    const f = fixture(t); f.relay.beginCompletion = input => { f.calls.push(input); const value = answer(); mutate(value); return { result: Promise.resolve(value), drained: Promise.resolve() }; };
    const service = f.create(); await assert.rejects(service.complete(f.input()), code('model_unknown'));
    await assert.rejects(service.complete(f.input()), code('model_unknown')); assert.equal(f.calls.length, 1);
  }
});

test('close is idempotent, aborts before admission and owns no refresh or crypto-destroy operation', async t => {
  const f = fixture(t), service = f.create(); const closing = service.close(); assert.strictEqual(service.close(), closing); await closing;
  await assert.rejects(service.complete(f.input()), code('closed')); assert.equal(f.events.length, 0);
  assert.equal(f.crypto.open(f.joined.session.envelope, f.binding).refreshToken, 'PRIVATE_REFRESH');
});

test('actual dependency scope and relay retain ignored fetch until its real promise settles', async t => {
  const f = fixture(t), scope = createDependencyScope(), fetching = deferred(), response = deferred(); let sends = 0;
  const relay = createModelRelay({ supabaseUrl: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture',
    allowedModels: ['openai:test'], timeoutMs: 20, fetch: async (_url, options) => {
      sends++; assert.equal(options.headers.authorization, `Bearer ${f.material.accessToken}`); fetching.resolve(); return response.promise;
    } });
  const service = f.create({ dependencyScope: scope, relay, timeoutMs: 1000, maxConcurrent: 1 });
  const handle = service.beginCompletion(f.input()), rejection = assert.rejects(handle.result, code('model_unknown'));
  await fetching.promise; await rejection;
  let done = false; const closing = service.close().then(() => { done = true; }); await tick(); assert.equal(done, false);
  response.resolve(Response.json(answer())); await handle.drained; await closing; await scope.close(); assert.equal(sends, 1);
});

test('actual scope tracks a hidden authority dependency after its public failure', async t => {
  const f = fixture(t), scope = createDependencyScope(), inner = deferred(), reached = deferred();
  const authority = { ...f.authority, async resolve() {
    void scope.track(async () => { reached.resolve(); await inner.promise; }); throw new Error('private timeout');
  } };
  const service = f.create({ authority, dependencyScope: scope, maxConcurrent: 1 });
  const handle = service.beginCompletion(f.input()); await reached.promise; await assert.rejects(handle.result, code('backend_unavailable'));
  await assert.rejects(service.complete(f.input()), code('busy'));
  let done = false; const closing = service.close().then(() => { done = true; }); await tick(); assert.equal(done, false);
  inner.resolve(); await handle.drained; await closing; await scope.close(); assert.equal(f.calls.length, 0);
});

test('malformed relay handles fail closed and cannot certify transport drain', async t => {
  const f = fixture(t); f.relay.beginCompletion = input => { f.calls.push(input); return { result: Promise.resolve(answer()) }; };
  const service = f.create(), handle = service.beginCompletion(f.input());
  await assert.rejects(handle.result, code('model_unknown'));
  await assert.rejects(handle.drained, code('backend_unavailable'));
  await assert.rejects(service.close(), code('backend_unavailable')); assert.equal(f.calls.length, 1);
});

test('clock expiry and early cancellation before relay never continue to another dependency', async t => {
  for (const mode of ['expiry', 'abort']) {
    const f = fixture(t), entered = deferred(), wait = deferred(), original = f.auth.verifySession; let checks = 0;
    if (mode === 'expiry') f.joined.connection.expiresAt = NOW + 10;
    f.auth.verifySession = async input => { const value = await original(input); if (++checks === 2) { entered.resolve(); await wait.promise; } return value; };
    const service = f.create(), handle = service.beginCompletion(f.input());
    const rejection = assert.rejects(handle.result, code(mode === 'expiry' ? 'unauthorized' : 'cancelled'));
    await entered.promise;
    if (mode === 'expiry') f.time(NOW + 10); else f.controller.abort();
    wait.resolve(); await rejection; await handle.drained; assert.equal(f.calls.length, 0);
  }
});
