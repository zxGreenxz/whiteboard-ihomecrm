import test from 'node:test';
import assert from 'node:assert/strict';
import { createDurableRefreshStore } from './durable-refresh-store.mjs';
import { StoreTransportError } from './store-transport.mjs';
import { createRefreshManager } from './refresh-manager.mjs';
import { createSessionCrypto } from './session-crypto.mjs';

const binding = { assistantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
const credentialRef = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ownerId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const claim = () => ({ credentialRef, binding: structuredClone(binding), ownerId, revision: 2, fence: 3 });
const envelope = () => ({ v: 1, algorithm: 'A256GCM', keyVersion: 'v1', nonce: Buffer.alloc(12, 1).toString('base64url'),
  tag: Buffer.alloc(16, 2).toString('base64url'), ciphertext: Buffer.from('encrypted-fixture').toString('base64url') });
const acquisition = () => ({ status: 'acquired', credential: { credentialRef, binding: structuredClone(binding),
  revision: 2, expiresAt: 1000, envelope: envelope() }, lease: { fence: 3, expiresAt: 31000 } });
const acquireInput = () => ({ credentialRef, binding: structuredClone(binding), ownerId, leaseMs: 30000 });
const stageInput = () => ({ ...claim(), envelope: envelope(), expiresAt: 61000 });
const replies = {
  acquireRefresh: () => acquisition(), dispatchRefresh: () => ({ ok: true, status: 'dispatched' }),
  stageRefresh: () => ({ ok: true, status: 'staged' }),
  publishRefresh: () => ({ ok: true, status: 'published', revision: 3, fence: 3 }),
  reconnectSession: () => ({ ok: true, status: 'reconnect_required' }),
  releaseRefresh: () => ({ ok: true, status: 'released' }), revokeSession: () => ({ ok: true, status: 'revoked' }),
};
const code = expected => error => error.code === expected && error.message === expected && error.cause === undefined;
function setup(handler) {
  const calls = [];
  const store = createDurableRefreshStore({ transport: { call: async (operation, input, options) => {
    calls.push({ operation, input: structuredClone(input), signal: options.signal });
    return handler ? handler(operation, input, options) : replies[operation]();
  } } });
  const controller = new AbortController();
  return { store, calls, controller, options: { signal: controller.signal } };
}

test('adapter exposes only seven fixed refresh operations and preserves the supplied signal', async () => {
  const f = setup();
  assert.deepEqual(Object.keys(f.store).sort(), ['acquire', 'markDispatched', 'publishRefresh', 'release', 'requireReconnect', 'revoke', 'stageRefresh']);
  assert.deepEqual(await f.store.acquire(acquireInput(), f.options), acquisition());
  assert.equal(await f.store.markDispatched(claim(), f.options), true);
  assert.equal(await f.store.stageRefresh(stageInput(), f.options), true);
  assert.deepEqual(await f.store.publishRefresh(claim(), f.options), replies.publishRefresh());
  assert.equal(await f.store.requireReconnect(claim(), f.options), true);
  assert.equal(await f.store.release(claim(), f.options), true);
  assert.equal(await f.store.revoke({ credentialRef }, f.options), true);
  assert.deepEqual(f.calls.map(call => call.operation), Object.keys(replies));
  assert.ok(f.calls.every(call => call.signal === f.controller.signal));
  assert.equal(f.calls[2].input.envelope.nonce, envelope().nonce);
  assert.equal(f.store.call, undefined); assert.equal(f.store.readConnection, undefined);
});

test('invalid configuration, extra fields, noncanonical identities and malformed claims never reach transport', async () => {
  assert.throws(() => createDurableRefreshStore(), { message: 'invalid_refresh_store_config' });
  const f = setup();
  for (const delta of [{ revision: 0 }, { revision: Number.MAX_SAFE_INTEGER }, { fence: -1 }, { ownerId: 'arbitrary' },
    { credentialRef: 'credential-1' }, { credentialRef: credentialRef.toUpperCase() }, { sql: 'SELECT secrets' }]) {
    await assert.rejects(f.store.publishRefresh({ ...claim(), ...delta }, f.options), code('refresh_store_request_invalid'));
  }
  for (const delta of [{ sessionId: 'named-session' }, { userId: binding.userId.toUpperCase() }, { organizationId: null }, { extra: 'field' }]) {
    await assert.rejects(f.store.acquire({ ...acquireInput(), binding: { ...binding, ...delta } }, f.options), code('refresh_store_request_invalid'));
  }
  for (const leaseMs of [999, 120001, 1000.5, Infinity]) {
    await assert.rejects(f.store.acquire({ ...acquireInput(), leaseMs }, f.options), code('refresh_store_request_invalid'));
  }
  await assert.rejects(f.store.revoke({ credentialRef, binding }, f.options), code('refresh_store_request_invalid'));
  assert.equal(f.calls.length, 0);
});

test('invalid or unbounded envelopes and expiry fail before the stage write', async () => {
  const f = setup();
  for (const delta of [{ v: 2 }, { algorithm: 'none' }, { keyVersion: '' }, { tag: 'abc' }, { nonce: 'x'.repeat(17) },
    { ciphertext: 'bad=' }, { ciphertext: 'x'.repeat(87383) }, { debug: 'field' }]) {
    await assert.rejects(f.store.stageRefresh({ ...stageInput(), envelope: { ...envelope(), ...delta } }, f.options), code('refresh_store_request_invalid'));
  }
  for (const expiresAt of [0, Infinity, 1000.5]) {
    await assert.rejects(f.store.stageRefresh({ ...stageInput(), expiresAt }, f.options), code('refresh_store_request_invalid'));
  }
  assert.equal(f.calls.length, 0);
});

test('acquisition cannot swap credential, user, session or lease metadata', async () => {
  const variants = [
    value => { value.credential.credentialRef = ownerId; },
    value => { value.credential.binding.userId = ownerId; },
    value => { value.credential.binding.sessionId = ownerId; },
    value => { value.credential.revision = Number.MAX_SAFE_INTEGER; },
    value => { delete value.credential.expiresAt; },
    value => { value.lease.fence = 0; },
    value => { value.lease.expiresAt = Infinity; },
    value => { value.credential.envelope.tag = 'bad'; },
    value => { value.debug = 'private detail'; },
  ];
  for (const mutate of variants) {
    const f = setup(() => { const value = acquisition(); mutate(value); return value; });
    await assert.rejects(f.store.acquire(acquireInput(), f.options), code('refresh_store_response_invalid'));
    assert.equal(f.calls.length, 1);
  }
});

test('acquisition distinguishes busy/reconnect/revoked/missing and rejects inherited or unknown states', async () => {
  for (const result of [{ status: 'busy', reconcile: true }, { status: 'busy', reconcile: false }, { status: 'busy' },
    { status: 'reconnect_required' }, { status: 'revoked' }, { status: 'missing' }]) {
    const f = setup(() => result);
    assert.deepEqual(await f.store.acquire(acquireInput(), f.options), result);
  }
  for (const result of [{ status: 'toString' }, { status: 'busy', reconcile: 'yes' }, { status: 'revoked', envelope: envelope() }, false]) {
    const f = setup(() => result);
    await assert.rejects(f.store.acquire(acquireInput(), f.options), code('refresh_store_response_invalid'));
  }
});

test('only exact published/already-published revision and fence receipts are admitted', async () => {
  for (const status of ['published', 'already_published']) {
    const result = { ok: true, status, revision: 3, fence: 3 };
    const f = setup(() => result); assert.deepEqual(await f.store.publishRefresh(claim(), f.options), result);
  }
  for (const result of [true, {}, { ...replies.publishRefresh(), revision: 2 }, { ...replies.publishRefresh(), fence: 4 },
    { ...replies.publishRefresh(), status: 'staged' }, { ...replies.publishRefresh(), envelope: envelope() },
    { ok: 'true', status: 'published', revision: 3, fence: 3 }]) {
    const f = setup(() => result);
    await assert.rejects(f.store.publishRefresh(claim(), f.options), code('refresh_store_response_invalid'));
    assert.equal(f.calls.length, 1);
  }
});

test('known false and idempotent receipts are projected without any adapter retry', async () => {
  const cases = [
    ['markDispatched', claim(), { ok: false }, false], ['stageRefresh', stageInput(), { ok: false }, false],
    ['stageRefresh', stageInput(), { ok: false, status: 'staged' }, false], ['publishRefresh', claim(), { ok: false }, false],
    ['requireReconnect', claim(), { ok: false }, false], ['requireReconnect', claim(), { ok: true, status: 'already_quarantined' }, true],
    ['release', claim(), { ok: false }, false], ['revoke', { credentialRef }, { ok: false, status: 'missing' }, false],
    ['revoke', { credentialRef }, { ok: true, status: 'already_revoked' }, true],
  ];
  for (const [method, input, reply, expected] of cases) {
    const f = setup(() => reply); assert.equal(await f.store[method](input, f.options), expected); assert.equal(f.calls.length, 1);
  }
});

test('wrong boolean receipt status never becomes an acknowledged write', async () => {
  for (const method of ['markDispatched', 'stageRefresh', 'requireReconnect', 'release', 'revoke']) {
    const f = setup(() => ({ ok: true, status: 'unrecognized' }));
    await assert.rejects(f.store[method](method === 'stageRefresh' ? stageInput() : method === 'revoke' ? { credentialRef } : claim(), f.options),
      code('refresh_store_response_invalid'));
  }
});

test('transport unknown outcome is preserved once while raw errors and spoofed codes are sanitized', async () => {
  const unknown = setup(() => { throw new StoreTransportError('store_outcome_unknown'); });
  await assert.rejects(unknown.store.publishRefresh(claim(), unknown.options), code('store_outcome_unknown'));
  assert.equal(unknown.calls.length, 1);
  for (const error of [new Error('credential private detail'), new StoreTransportError('store_principal_refused'),
    Object.assign(new Error('spoofed secret'), { code: 'store_outcome_unknown' })]) {
    const f = setup(() => { throw error; });
    await assert.rejects(f.store.publishRefresh(claim(), f.options), code('refresh_store_unavailable'));
    assert.equal(f.calls.length, 1);
  }
});

test('missing or aborted signal dispatches nothing; a late reply after abort cannot succeed', async () => {
  const f = setup();
  await assert.rejects(f.store.publishRefresh(claim()), code('refresh_store_request_invalid'));
  f.controller.abort(); await assert.rejects(f.store.publishRefresh(claim(), f.options), code('refresh_store_cancelled'));
  assert.equal(f.calls.length, 0);
  let finish;
  const late = setup(() => new Promise(resolve => { finish = resolve; }));
  const pending = late.store.publishRefresh(claim(), late.options);
  late.controller.abort(); finish(replies.publishRefresh());
  await assert.rejects(pending, code('refresh_store_cancelled')); assert.equal(late.calls.length, 1);
});

test('caller mutation cannot change the claim used to validate a delayed publication receipt', async () => {
  let finish;
  const f = setup(() => new Promise(resolve => { finish = resolve; }));
  const input = claim(), pending = f.store.publishRefresh(input, f.options);
  input.revision = 8; input.fence = 9; input.binding.userId = ownerId;
  finish(replies.publishRefresh()); assert.deepEqual(await pending, replies.publishRefresh());
  assert.deepEqual(f.calls[0].input, claim());
});

test('manager and SQL-shaped adapter compose with one provider request after a lost publish ACK', async () => {
  // Fake transport only: SQL transactions, catalog ACL and durable recovery are
  // not established by this interface test.
  const crypto = createSessionCrypto({ activeKeyVersion: 'v1', keys: new Map([['v1', Buffer.alloc(32, 7)]]) });
  const oldEnvelope = crypto.seal({ accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1000 }, binding);
  let publications = 0, providers = 0, operationClaim;
  const f = setup((operation, input) => {
    if (operation === 'acquireRefresh') {
      operationClaim = { credentialRef, binding, ownerId: input.ownerId, revision: 2, fence: 3 };
      return { ...acquisition(), credential: { ...acquisition().credential, envelope: oldEnvelope } };
    }
    if (operation === 'publishRefresh') {
      assert.deepEqual(input, operationClaim); publications++;
      if (publications === 1) throw new StoreTransportError('store_outcome_unknown');
      return { ok: true, status: 'already_published', revision: 3, fence: 3 };
    }
    return replies[operation]();
  });
  const manager = createRefreshManager({ store: f.store, crypto, clock: () => 1000, provider: {
    refresh: async () => { providers++; return { accessToken: 'new-access', refreshToken: 'new-refresh' }; },
    verifySession: async () => ({ userId: binding.userId, sessionId: binding.sessionId, expiresAt: 61000 }),
  } });
  assert.deepEqual(await manager.refresh(credentialRef, binding), { credentialRef, expiresAt: 61000 });
  assert.equal(providers, 1); assert.equal(publications, 2);
  assert.deepEqual(f.calls.map(call => call.operation), ['acquireRefresh', 'dispatchRefresh', 'stageRefresh', 'publishRefresh', 'publishRefresh']);
  assert.ok(f.calls.every(call => call.signal instanceof AbortSignal));
  crypto.destroy();
});
