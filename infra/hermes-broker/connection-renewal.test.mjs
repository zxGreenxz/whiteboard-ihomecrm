import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnectionRenewal, ConnectionRenewalError } from './connection-renewal.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { DurableConnectionStoreError } from './durable-connection-store.mjs';

const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const now = 1800000000000, token = `hc_${Buffer.alloc(32, 3).toString('base64url')}`;
const tokenDigest = createHash('sha256').update(token).digest('hex');
const grants = () => ({ read: ['assistant.context.read'], action: [] });
function fixture(t, hooks = {}) {
  const crypto = createSessionCrypto({ activeKeyVersion: 'fixture', keys: new Map([['fixture', Buffer.alloc(32, 1)]]) });
  t.after(() => crypto.destroy());
  const binding = { assistantId: id('2'), userId: id('3'), organizationId: id('4'), sessionId: id('5') };
  const row = { status: 'active', connection: { id: id('1'), assistantId: id('2'), userId: id('3'), organizationId: id('4'),
    state: 'active', epoch: 2, expiresAt: now + 600000, restrictions: grants(), scopeIds: [id('8')], tokenDigest, credentialRef: id('6') },
  session: { credentialRef: id('6'), revision: 1, expiresAt: now + 3600000, binding,
    envelope: crypto.seal({ accessToken: 'PRIVATE_ACCESS', refreshToken: 'PRIVATE_REFRESH', expiresAt: now + 3600000 }, binding) },
  membership: { membershipId: id('7'), authorizationVersion: 1, isSuperadmin: false }, policy: { version: 1, ...grants(), scopeIds: [id('8')] } };
  const state = { row, writes: [], reads: 0, verifies: 0, clock: now };
  const controller = new AbortController();
  const store = {
    async readConnection(input, options) { assert.deepEqual(input, { tokenDigest }); state.reads++; await hooks.read?.(state, options); return structuredClone(state.row); },
    async renewConnection(input, options) {
      state.writes.push(structuredClone(input));
      if (hooks.write) return hooks.write(state, input, options);
      state.row.connection.expiresAt = now + 900000;
      return { ok: true, status: 'renewed', expiresAt: state.row.connection.expiresAt };
    },
  };
  const authority = createDurableAuthority({ connectionStore: store, crypto, clock: () => state.clock, auth: {
    async verifySession() { state.verifies++; await hooks.verify?.(state); return { userId: id('3'), sessionId: id('5'), expiresAt: now + 3600000 }; },
    async readAuthorization() { return { userId: id('3'), isSuperadmin: false, activeOrganizationIds: [id('4')], epoch: 'crm-1',
      membership: { organizationId: id('4'), status: 'ACTIVE', revokedAt: null, validFrom: null, validTo: null, membershipId: id('7'), authorizationVersion: 1 },
      permissions: grants(), companyCeilings: grants(), scopesByPermission: { 'assistant.context.read': { buildingIds: [], cashbookIds: [] } } }; },
  } });
  const renewal = createConnectionRenewal({ authority, connectionStore: store, clock: () => state.clock, timeoutMs: hooks.timeoutMs ?? 1000,
    maxConcurrentRenewals: hooks.maxConcurrentRenewals ?? 16 });
  return { state, controller, close: renewal.close, run: () => renewal.renew(token, { signal: controller.signal }) };
}
const error = (outcome, code) => value => value instanceof ConnectionRenewalError && value.outcome === outcome && (!code || value.code === code);

test('same opaque renewal uses fresh real authority and precise CAS; response contains no credentials', async t => {
  const f = fixture(t), result = await f.run();
  assert.deepEqual(result, { ok: true, status: 'renewed', connectionId: id('1'), expiresAt: now + 900000, reconciled: false });
  assert.deepEqual(f.state.writes, [{ tokenDigest, connectionId: id('1'), expectedEpoch: 2, credentialRef: id('6'), expectedRevision: 1, expectedExpiresAt: now + 600000, requestedTtlMs: 900000 }]);
  assert.equal(f.state.verifies, 4);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|hc_|credential|tokenDigest|sessionId/);
});
test('Auth failure before dispatch never renews', async t => {
  const f = fixture(t, { verify: () => { throw Error('PRIVATE'); } });
  await assert.rejects(f.run(), error('not_dispatched')); assert.equal(f.state.writes.length, 0);
});
test('second Auth recheck detects revocation before dispatch', async t => {
  const f = fixture(t, { verify: state => { if (state.verifies === 2) state.row.membership.authorizationVersion++; } });
  await assert.rejects(f.run(), error('not_dispatched')); assert.equal(f.state.writes.length, 0);
});
for (const code of ['store_denied', 'store_conflict', 'store_rejected']) test(`definite ${code} does not retry`, async t => {
  const f = fixture(t, { write: () => { throw new DurableConnectionStoreError(code); } });
  await assert.rejects(f.run(), error('rejected')); assert.equal(f.state.writes.length, 1);
});
for (const malformed of [false, true]) test(`lost or malformed ACK reconciles current authoritative extension (${malformed})`, async t => {
  const f = fixture(t, { write: state => { state.row.connection.expiresAt = now + 800000;
    if (malformed) return { ok: true, status: 'renewed', expiresAt: -1 };
    throw new DurableConnectionStoreError('store_outcome_unknown'); } });
  assert.equal((await f.run()).reconciled, true); assert.equal(f.state.writes.length, 1);
});
test('unknown ACK with no extension remains unknown and never retries', async t => {
  const f = fixture(t, { write: () => { throw new DurableConnectionStoreError('store_outcome_unknown'); } });
  await assert.rejects(f.run(), error('unknown')); assert.equal(f.state.writes.length, 1);
});
for (const mutate of [s => s.row.session.revision++, s => s.row.membership.authorizationVersion++, s => s.row.policy.version++,
  s => s.row.connection.epoch++, s => s.row.connection.scopeIds.push(id('9')), s => { s.row.session.binding.organizationId = id('9'); }]) {
  test('changed authority/session provenance after dispatch fails closed', async t => {
    const f = fixture(t, { write: state => { state.row.connection.expiresAt = now + 800000; mutate(state); return { ok: true, status: 'renewed', expiresAt: now + 800000 }; } });
    await assert.rejects(f.run(), error('unknown')); assert.equal(f.state.writes.length, 1);
  });
}
test('final Auth change after write cannot report success', async t => {
  const f = fixture(t, { verify: state => { if (state.verifies === 4) throw Error('revoked'); } });
  await assert.rejects(f.run(), error('unknown')); assert.equal(f.state.writes.length, 1);
});
for (const expiresAt of [now + 600000, now + 1600000, now - 1]) test(`invalid extension ${expiresAt} cannot succeed`, async t => {
  const f = fixture(t, { write: state => { state.row.connection.expiresAt = expiresAt; return { ok: true, status: 'renewed', expiresAt }; } });
  await assert.rejects(f.run(), error('unknown')); assert.equal(f.state.writes.length, 1);
});
test('ACK and current lease mismatch remains unknown', async t => {
  const f = fixture(t, { write: state => { state.row.connection.expiresAt = now + 800000; return { ok: true, status: 'renewed', expiresAt: now + 900000 }; } });
  await assert.rejects(f.run(), error('unknown'));
});
test('cancel during dispatched write is unknown and no readback occurs', async t => {
  let f; f = fixture(t, { write: () => { f.controller.abort(); return { ok: true, status: 'renewed', expiresAt: now + 900000 }; } });
  await assert.rejects(f.run(), error('unknown')); assert.equal(f.state.writes.length, 1);
});
test('aborted before entry never invokes dependencies', async t => {
  const f = fixture(t); f.controller.abort(); await assert.rejects(f.run(), error('not_dispatched', 'cancelled')); assert.equal(f.state.reads, 0);
});
test('timeout before dispatch bounds ignored abort; late dependency cannot write', async t => {
  let release; const f = fixture(t, { timeoutMs: 10, verify: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(f.run(), error('not_dispatched', 'timeout')); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.writes.length, 0);
});
test('timeout after dispatch remains unknown; late ACK cannot start readback', async t => {
  let release; const f = fixture(t, { timeoutMs: 10, write: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(f.run(), error('unknown')); const reads = f.state.reads;
  release({ ok: true, status: 'renewed', expiresAt: now + 900000 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.reads, reads); assert.equal(f.state.writes.length, 1);
});
test('timed-out write retains admission until actual settlement; close drains it and blocks admission', async t => {
  let release;
  const f = fixture(t, { timeoutMs: 10, maxConcurrentRenewals: 1, write: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(f.run(), error('unknown'));
  await assert.rejects(f.run(), error('not_dispatched', 'busy'));
  let closed = false; const closing = f.close(); assert.equal(f.close(), closing);
  void closing.then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false);
  await assert.rejects(f.run(), error('not_dispatched', 'backend_closed'));
  release({ ok: true, status: 'renewed', expiresAt: now + 900000 }); await closing;
  assert.equal(closed, true); assert.equal(f.state.writes.length, 1);
});
test('close aborts an in-flight write, returns unknown promptly, and waits for its dependency', async t => {
  let release, entered; const ready = new Promise(resolve => { entered = resolve; });
  const f = fixture(t, { write: (_state, _input, options) => { entered(options.signal); return new Promise(resolve => { release = resolve; }); } });
  const running = f.run(), signal = await ready, closing = f.close();
  await assert.rejects(running, error('unknown')); assert.equal(signal.aborted, true);
  release({ ok: true, status: 'renewed', expiresAt: now + 900000 }); await closing;
  assert.equal(f.state.writes.length, 1);
});
test('close before scheduled work prevents all dependency calls', async t => {
  const f = fixture(t), running = f.run(), closing = f.close();
  await assert.rejects(running, error('not_dispatched', 'backend_closed')); await closing; assert.equal(f.state.reads, 0);
});
