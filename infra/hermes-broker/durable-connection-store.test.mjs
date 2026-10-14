import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { StoreTransportError } from './store-transport.mjs';
import { createSessionCrypto } from './session-crypto.mjs';

const ids = { connection: '11111111-1111-4111-8111-111111111111', assistant: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  user: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', org: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  session: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', credential: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  operation: 'ffffffff-ffff-4fff-8fff-ffffffffffff', membership: '22222222-2222-4222-8222-222222222222',
  scope: '33333333-3333-4333-8333-333333333333' };
const now = 1_800_000_000_000;
const tokenDigest = 'a'.repeat(64);
const binding = () => ({ assistantId: ids.assistant, userId: ids.user, organizationId: ids.org, sessionId: ids.session });
const limits = () => ({ read: ['assistant.context.read'], action: [] });
const connection = () => ({ id: ids.connection, assistantId: ids.assistant, userId: ids.user,
  organizationId: ids.org, state: 'active', epoch: 2, restrictions: limits(), scopeIds: [ids.scope] });
const envelope = () => ({ v: 1, algorithm: 'A256GCM', keyVersion: 'v1', nonce: Buffer.alloc(12, 1).toString('base64url'),
  tag: Buffer.alloc(16, 2).toString('base64url'), ciphertext: Buffer.from('encrypted-fixture').toString('base64url') });
const activation = () => ({ prepared: { ...connection(), state: 'pending', epoch: 1,
  intentSecret: 'b'.repeat(64), intentExpiresAt: now + 300_000 }, operationId: ids.operation,
credentialRef: ids.credential, binding: binding(), tokenDigest, tokenExpiresAt: now + 900_000,
sessionEnvelope: envelope(), sessionExpiresAt: now + 3_600_000 });
const activationReply = () => ({ ok: true, status: 'activated', connection: connection(), credentialRef: ids.credential });
const readReply = () => ({ status: 'active', connection: { ...connection(), tokenDigest,
  credentialRef: ids.credential, expiresAt: now + 900_000 },
session: { credentialRef: ids.credential, revision: 1, binding: binding(), envelope: envelope(), expiresAt: now + 3_600_000 },
membership: { membershipId: ids.membership, authorizationVersion: 1, isSuperadmin: false },
policy: { version: 1, ...limits(), scopeIds: [ids.scope] } });
const restriction = () => ({ connection: connection(), restrictions: { read: [], action: [] }, scopeIds: [] });
const restrictionReply = () => ({ ok: true, connection: { ...connection(), epoch: 3, restrictions: { read: [], action: [] }, scopeIds: [] } });
const code = expected => error => error.code === expected && error.message === expected && error.cause === undefined;
function fixture(handler, clock = () => now) {
  const calls = [], controller = new AbortController();
  const replies = { activate: activationReply, readConnection: readReply, restrictConnection: restrictionReply,
    revokeConnection: () => ({ ok: true, status: 'revoked' }) };
  const store = createDurableConnectionStore({ clock, transport: { call: async (operation, payload, options) => {
    calls.push({ operation, payload: structuredClone(payload), signal: options.signal });
    return handler ? handler(operation, payload, options) : replies[operation]();
  } } });
  return { store, calls, controller, options: { signal: controller.signal } };
}

test('only five fixed connection operations exist; activation is one atomic encrypted bundle', async () => {
  const f = fixture(), input = activation();
  assert.deepEqual(Object.keys(f.store).sort(), ['activate', 'readConnection', 'renewConnection', 'restrictConnection', 'revokeConnection']);
  assert.deepEqual(await f.store.activate(input, f.options), activationReply());
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { operation: 'activate', signal: f.controller.signal, payload: {
    connectionId: ids.connection, expectedEpoch: 1, operationId: ids.operation, intentSecret: input.prepared.intentSecret,
    userId: ids.user, providerSessionId: ids.session, credentialRef: ids.credential, tokenDigest,
    tokenExpiresAt: input.tokenExpiresAt, sessionEnvelope: envelope(), sessionExpiresAt: input.sessionExpiresAt } });
  assert.equal(f.store.create, undefined); assert.equal(f.store.delete, undefined); assert.equal(f.store.call, undefined);
});

test('activation rejects forged prepared identity, raw tokens, noncanonical AAD and malformed envelopes before SQL', async () => {
  const variants = [
    input => { input.binding.userId = ids.org; }, input => { input.binding.organizationId = ids.user; },
    input => { input.binding.assistantId = ids.org; }, input => { input.binding.sessionId = ids.session.toUpperCase(); },
    input => { input.binding.sessionId = 'named-session'; }, input => { input.prepared.id = ids.assistant.toUpperCase(); },
    input => { input.prepared.state = 'active'; }, input => { input.prepared.epoch = Number.MAX_SAFE_INTEGER; },
    input => { input.prepared.intentSecret = 'secret'; }, input => { input.prepared.accessToken = 'raw'; },
    input => { input.accessToken = 'raw'; }, input => { input.tokenDigest = 'hc_raw'; },
    input => { input.tokenExpiresAt = input.sessionExpiresAt + 1; }, input => { input.sessionExpiresAt = Infinity; },
    input => { input.sessionEnvelope.algorithm = 'none'; }, input => { input.sessionEnvelope.nonce = 'invalid'; },
    input => { input.sessionEnvelope.tag = 'bad='; }, input => { input.sessionEnvelope.ciphertext = 'x'.repeat(87383); },
    input => { input.prepared.restrictions.read = ['unknown:syntax']; }, input => { input.prepared.scopeIds = ['foreign']; },
    input => { input.prepared.restrictions.read = new Array(2); },
  ];
  const f = fixture();
  for (const mutate of variants) {
    const input = activation(); mutate(input);
    await assert.rejects(f.store.activate(input, f.options), code('connection_store_request_invalid'));
  }
  assert.equal(f.calls.length, 0);
});

test('explicit activation reconciliation reuses exactly the caller payload without resealing or retrying', async () => {
  const f = fixture(() => ({ ...activationReply(), status: 'already_activated' }));
  const input = activation(); input.prepared.intentExpiresAt = now - 1;
  await f.store.activate(input, f.options);
  await f.store.activate(input, f.options);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].payload, f.calls[1].payload);
  const narrowed = fixture(() => ({ ...activationReply(), status: 'already_activated',
    connection: { ...connection(), epoch: 3, restrictions: { read: [], action: [] }, scopeIds: [] } }));
  assert.equal((await narrowed.store.activate(activation(), narrowed.options)).connection.epoch, 3);
});

test('an activation ACK cannot change owner, credential, grants, epoch or inject material', async () => {
  for (const mutate of [value => { value.connection.userId = ids.org; }, value => { value.connection.assistantId = ids.org; },
    value => { value.connection.organizationId = ids.user; }, value => { value.connection.id = ids.org; },
    value => { value.credentialRef = ids.org; }, value => { value.connection.epoch = 1; },
    value => { value.connection.restrictions.action = ['rooms.edit']; }, value => { value.connection.scopeIds = []; },
    value => { value.accessToken = 'private'; }, value => { value.ok = false; }]) {
    const f = fixture(() => { const value = activationReply(); mutate(value); return value; });
    await assert.rejects(f.store.activate(activation(), f.options), code('store_outcome_unknown'));
    assert.equal(f.calls.length, 1);
  }
});

test('joined read returns only the exact backend bundle, copies state and projects no effective authority', async () => {
  const source = readReply(), f = fixture(() => source);
  const value = await f.store.readConnection({ tokenDigest }, f.options);
  assert.deepEqual(value, source);
  assert.deepEqual(f.calls[0].payload, { tokenDigest });
  assert.equal(value.effective, undefined); assert.equal(value.accessToken, undefined);
  source.session.binding.userId = ids.org; source.policy.read.length = 0;
  assert.equal(value.session.binding.userId, ids.user); assert.deepEqual(value.policy.read, limits().read);
});

test('joined read rejects inconsistent ownership, provider binding, digest and every context shape', async () => {
  const variants = [value => { value.connection.tokenDigest = 'c'.repeat(64); }, value => { value.connection.state = 'revoked'; },
    value => { value.session.credentialRef = ids.org; }, value => { value.session.binding.userId = ids.org; },
    value => { value.session.binding.organizationId = ids.user; }, value => { value.session.binding.assistantId = ids.org; },
    value => { value.session.binding.sessionId = 'provider-unverified'; }, value => { value.session.binding.sessionId = ids.session.toUpperCase(); },
    value => { value.session.revision = 0; }, value => { value.session.envelope.tag = 'bad'; },
    value => { value.membership.isSuperadmin = 'true'; }, value => { value.membership.authorizationVersion = 0; },
    value => { value.policy.version = -1; }, value => { value.policy.read = new Array(2); },
    value => { value.session.accessToken = 'private'; }, value => { value.debug = 'private'; }];
  for (const mutate of variants) {
    const f = fixture(() => { const value = readReply(); mutate(value); return value; });
    await assert.rejects(f.store.readConnection({ tokenDigest }, f.options), code('connection_store_response_invalid'));
  }
});

test('SQL-unavailable or locally expired joined context cannot be admitted; narrower policy stays authoritative', async () => {
  for (const kind of ['unavailable', 'connection', 'session']) {
    const f = fixture(() => {
      if (kind === 'unavailable') return { status: 'unavailable' };
      const value = readReply(); value[kind].expiresAt = now; return value;
    });
    assert.equal(await f.store.readConnection({ tokenDigest }, f.options), null);
  }
  const f = fixture(() => { const value = readReply(); value.policy.read = []; value.policy.scopeIds = []; return value; });
  const value = await f.store.readConnection({ tokenDigest }, f.options);
  assert.deepEqual(value.connection.restrictions.read, ['assistant.context.read']);
  assert.deepEqual(value.policy.read, []); // No optimistic union or old-policy cache.
  const broken = fixture(undefined, () => NaN);
  await assert.rejects(broken.store.readConnection({ tokenDigest }, broken.options), code('connection_store_clock_invalid'));
});

test('real ciphertext remains bound to canonical SQL identity; decrypt/verify remains a caller obligation', async () => {
  const crypto = createSessionCrypto({ activeKeyVersion: 'v1', keys: new Map([['v1', Buffer.alloc(32, 7)]]) });
  try {
    const material = { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: now + 3_600_000 };
    const sealed = crypto.seal(material, binding());
    const f = fixture(() => { const value = readReply(); value.session.envelope = sealed; return value; });
    const value = await f.store.readConnection({ tokenDigest }, f.options);
    assert.deepEqual(crypto.open(value.session.envelope, value.session.binding), material);
    assert.throws(() => crypto.open(value.session.envelope, { ...value.session.binding, sessionId: ids.operation }));
    assert.equal(JSON.stringify(f.calls).includes(material.refreshToken), false);
  } finally { crypto.destroy(); }
});

test('restriction uses current snapshot CAS and exact narrowed lists, including a joined-read snapshot', async () => {
  const f = fixture();
  assert.deepEqual(await f.store.restrictConnection(restriction(), f.options), restrictionReply());
  assert.deepEqual(f.calls[0].payload, { connectionId: ids.connection, expectedEpoch: 2, read: [], action: [], scopeIds: [] });
  assert.deepEqual(await f.store.restrictConnection({ ...restriction(), connection: readReply().connection }, f.options), restrictionReply());
  for (const delta of [{ restrictions: { read: ['rooms.view'], action: [] } }, { scopeIds: [ids.org] },
    { restrictions: { read: [], action: ['rooms.edit'] } }]) {
    await assert.rejects(f.store.restrictConnection({ ...restriction(), ...delta }, f.options), code('connection_store_request_invalid'));
  }
  assert.equal(f.calls.length, 2);
});

test('restriction ACK must retain exact identity, requested limits and incremented epoch', async () => {
  for (const mutate of [value => { value.connection.userId = ids.org; }, value => { value.connection.id = ids.org; },
    value => { value.connection.epoch = 2; }, value => { value.connection.restrictions = limits(); },
    value => { value.connection.scopeIds = [ids.scope]; }, value => { value.extra = true; }]) {
    const f = fixture(() => { const value = restrictionReply(); mutate(value); return value; });
    await assert.rejects(f.store.restrictConnection(restriction(), f.options), code('store_outcome_unknown'));
    assert.equal(f.calls.length, 1);
  }
});

test('connection revoke never deletes/revokes session material and only accepts exact SQL receipts', async () => {
  for (const receipt of [{ ok: true, status: 'revoked' }, { ok: true, status: 'already_revoked' }, { ok: false, status: 'missing' }]) {
    const f = fixture(() => receipt);
    assert.deepEqual(await f.store.revokeConnection({ connectionId: ids.connection, expectedEpoch: 2 }, f.options), receipt);
    assert.deepEqual(f.calls.map(call => call.operation), ['revokeConnection']);
  }
  for (const receipt of [{ ok: true }, { ok: false, status: 'revoked' }, { ok: true, status: 'missing' },
    { ok: true, status: 'revoked', sessionDeleted: true }]) {
    const f = fixture(() => receipt);
    await assert.rejects(f.store.revokeConnection({ connectionId: ids.connection, expectedEpoch: 2 }, f.options), code('store_outcome_unknown'));
  }
});

test('invalid signals, unbounded arrays and arbitrary protocol fields dispatch nothing', async () => {
  assert.throws(() => createDurableConnectionStore(), { message: 'invalid_connection_store_config' });
  const f = fixture();
  await assert.rejects(f.store.readConnection({ tokenDigest }), code('connection_store_request_invalid'));
  await assert.rejects(f.store.readConnection({ tokenDigest, sql: 'SELECT secrets' }, f.options), code('connection_store_request_invalid'));
  await assert.rejects(f.store.revokeConnection({ connectionId: ids.connection, expectedEpoch: 0 }, f.options), code('connection_store_request_invalid'));
  const input = activation(); input.prepared.restrictions.read = Array(257).fill('assistant.context.read');
  await assert.rejects(f.store.activate(input, f.options), code('connection_store_request_invalid'));
  f.controller.abort();
  await assert.rejects(f.store.activate(activation(), f.options), code('connection_store_cancelled'));
  assert.equal(f.calls.length, 0);
});

test('lost ACK, definite SQL denial and injected private errors never trigger retries or compensation', async () => {
  for (const [error, expected] of [[new StoreTransportError('store_outcome_unknown'), 'store_outcome_unknown'],
    [new StoreTransportError('store_denied'), 'store_denied'], [new StoreTransportError('store_conflict'), 'store_conflict'],
    [new StoreTransportError('store_rejected'), 'store_rejected'], [new Error('private refresh token'), 'connection_store_unavailable']]) {
    const f = fixture(() => { throw error; });
    await assert.rejects(f.store.activate(activation(), f.options), code(expected));
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].operation, 'activate');
  }
});

test('abort after dispatch cannot return a successful write or a stale read', async () => {
  for (const write of [true, false]) {
    let settle;
    const f = fixture(() => new Promise(resolve => { settle = resolve; }));
    const pending = write ? f.store.activate(activation(), f.options) : f.store.readConnection({ tokenDigest }, f.options);
    f.controller.abort(); settle(write ? activationReply() : readReply());
    await assert.rejects(pending, code(write ? 'store_outcome_unknown' : 'connection_store_cancelled'));
    assert.equal(f.calls[0].signal, f.controller.signal);
  }
});

test('caller mutation during await cannot change the projected SQL bundle or validation expectations', async () => {
  let settle;
  const f = fixture(() => new Promise(resolve => { settle = resolve; }));
  const input = activation();
  const pending = f.store.activate(input, f.options);
  input.binding.userId = ids.org; input.prepared.restrictions.read.length = 0;
  input.prepared.userId = ids.org; input.sessionEnvelope.ciphertext = 'changed';
  settle(activationReply());
  assert.deepEqual(await pending, activationReply());
  assert.equal(f.calls[0].payload.userId, ids.user);
  assert.equal(f.calls[0].payload.sessionEnvelope.ciphertext, envelope().ciphertext);
});

const renewal = () => ({ tokenDigest, connectionId: ids.connection, expectedEpoch: 2,
  credentialRef: ids.credential, expectedRevision: 3, expectedExpiresAt: now + 300_000, requestedTtlMs: 900_000 });
const renewalReply = (expiresAt = now + 900_000) => ({ ok: true, status: 'renewed', expiresAt });
test('renewal sends one exact digest/identity/revision/expiry CAS and requested duration, never a target expiry', async () => {
  const f = fixture(() => renewalReply()), input = renewal();
  assert.deepEqual(await f.store.renewConnection(input, f.options), renewalReply());
  assert.deepEqual(f.calls, [{ operation: 'renewConnection', payload: input, signal: f.controller.signal }]);
  assert.equal(f.store.rotateToken, undefined); assert.equal(f.calls[0].payload.targetExpiresAt, undefined);
});
test('DB-selected expiry may be capped by session or hard age, independently of the host clock', async () => {
  for (const hostNow of [now - 86_400_000, now + 86_400_000, NaN]) {
    let clockReads = 0;
    const response = renewalReply(now + 350_001);
    const f = fixture(() => response, () => { clockReads++; return hostNow; });
    assert.deepEqual(await f.store.renewConnection(renewal(), f.options), response);
    assert.equal(clockReads, 0); assert.equal(f.calls.length, 1);
  }
});
test('renewal rejects invalid duration, identity, CAS or authority fields without SQL', async () => {
  const f = fixture();
  for (const delta of [{ tokenDigest: 'hc_raw' }, { connectionId: ids.assistant.toUpperCase() }, { credentialRef: 'other' },
    { expectedEpoch: 0 }, { expectedRevision: Number.MAX_SAFE_INTEGER }, { expectedRevision: NaN },
    { expectedExpiresAt: 0 }, { expectedExpiresAt: Number.MAX_SAFE_INTEGER }, { expectedExpiresAt: 1.5 },
    { requestedTtlMs: 0 }, { requestedTtlMs: -1 }, { requestedTtlMs: 900_001 }, { requestedTtlMs: 0.1 },
    { requestedTtlMs: '900000' }, { requestedTtlMs: null }, { targetExpiresAt: now + 900_000 },
    { read: ['rooms.view'] }, { binding: binding() }, { rawToken: 'private' }]) {
    await assert.rejects(f.store.renewConnection({ ...renewal(), ...delta }, f.options), code('connection_store_request_invalid'));
  }
  await assert.rejects(f.store.renewConnection(renewal()), code('connection_store_request_invalid'));
  f.controller.abort();
  await assert.rejects(f.store.renewConnection(renewal(), f.options), code('connection_store_cancelled'));
  assert.equal(f.calls.length, 0);
});
test('malformed, nonextending, overlarge or secret-bearing renewal ACK stays unknown', async () => {
  for (const result of [undefined, false, { ok: false, status: 'unavailable' },
    { ...renewalReply(), status: 'already_renewed' }, renewalReply(now + 300_000),
    renewalReply(now + 1_200_001), renewalReply(now + 350_000.5), renewalReply(Infinity),
    { ...renewalReply(), newToken: 'private' }]) {
    const f = fixture(() => result);
    await assert.rejects(f.store.renewConnection(renewal(), f.options), code('store_outcome_unknown'));
    assert.equal(f.calls.length, 1);
  }
});
test('renewal never retries a lost ACK, stale CAS, SQL denial or safe-redacted backend failure', async () => {
  for (const expected of ['store_outcome_unknown', 'store_conflict', 'store_denied', 'store_rejected']) {
    const f = fixture(() => { throw new StoreTransportError(expected); });
    await assert.rejects(f.store.renewConnection(renewal(), f.options), code(expected)); assert.equal(f.calls.length, 1);
  }
  const f = fixture(() => { throw new Error('private credential'); });
  await assert.rejects(f.store.renewConnection(renewal(), f.options), code('connection_store_unavailable'));
  assert.equal(f.calls.length, 1);
});
test('renewal snapshots its scalar CAS tuple and does not accept success after cancellation', async () => {
  for (const cancel of [false, true]) {
    let settle;
    const f = fixture(() => new Promise(done => { settle = done; })), input = renewal();
    const pending = f.store.renewConnection(input, f.options);
    input.tokenDigest = 'b'.repeat(64); input.expectedRevision = 99; input.requestedTtlMs = 1; input.expectedExpiresAt = now + 1;
    if (cancel) f.controller.abort(); settle(renewalReply());
    if (cancel) await assert.rejects(pending, code('store_outcome_unknown'));
    else assert.deepEqual(await pending, renewalReply());
    assert.deepEqual(f.calls[0].payload, renewal()); assert.equal(f.calls.length, 1);
  }
});
