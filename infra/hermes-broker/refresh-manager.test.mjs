import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSessionCrypto } from './session-crypto.mjs';
import { createRefreshManager } from './refresh-manager.mjs';

const binding = { assistantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionId: 'dedicated-session-1' };
const old = { accessToken: 'old-access', refreshToken: 'single-use-refresh', expiresAt: 1000 };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Test double only: synchronous mutations emulate linearizable store operations.
// No SQL, durable storage, distributed locks or crash recovery are proven here.
function fixture() {
  const crypto = createSessionCrypto({ activeKeyVersion: 'v1', keys: new Map([['v1', randomBytes(32)]]) });
  let now = 1000, row = { id: 'credential-1', binding: structuredClone(binding), revision: 1, fence: 0,
    state: 'active', envelope: crypto.seal(old, binding), lease: null };
  const events = []; let providerCalls = 0;
  const owned = (c) => row && row.id === c.credentialRef && row.fence === c.fence && row.lease?.ownerId === c.ownerId;
  const exact = (c) => owned(c) && row.revision === c.revision;
  const store = {
    async acquire({ credentialRef, binding: expected, ownerId, leaseMs }) {
      if (!row || row.id !== credentialRef) return { status: 'missing' };
      if (JSON.stringify(row.binding) !== JSON.stringify(expected)) return { status: 'missing' };
      if (['revoked', 'reconnect_required'].includes(row.state)) return { status: row.state };
      if (row.state === 'refreshing') {
        if (row.lease.expiresAt > now) return { status: 'busy' };
        if (row.lease.dispatched) { row.state = 'reconnect_required'; row.envelope = null; row.revision++; return { status: row.state }; }
      }
      row.state = 'refreshing'; row.fence++;
      row.lease = { ownerId, fence: row.fence, expiresAt: now + leaseMs, dispatched: false };
      events.push('acquired');
      return { status: 'acquired', credential: { revision: row.revision, binding: structuredClone(row.binding), envelope: structuredClone(row.envelope) }, lease: structuredClone(row.lease) };
    },
    async markDispatched(c) {
      if (!exact(c) || row.state !== 'refreshing' || row.lease.dispatched || row.lease.expiresAt <= now) return false;
      row.lease.dispatched = true; events.push('dispatched'); return true;
    },
    async commitRefresh(c) {
      if (!exact(c) || row.state !== 'refreshing' || !row.lease.dispatched || row.lease.expiresAt <= now) return false;
      row.envelope = structuredClone(c.envelope); row.revision++; row.state = 'active'; events.push('committed'); return true;
    },
    async requireReconnect(c) {
      if (!owned(c) || row.state === 'revoked' || row.state === 'reconnect_required') return false;
      row.state = 'reconnect_required'; row.envelope = null; row.revision++; events.push('reconnect'); return true;
    },
    async release(c) {
      if (!exact(c) || row.state !== 'refreshing' || row.lease.dispatched) return false;
      row.state = 'active'; row.lease = null; return true;
    },
    async revoke({ credentialRef }) {
      if (!row || row.id !== credentialRef) return false;
      row.state = 'revoked'; row.envelope = null; row.fence++; row.revision++; row.lease = null; events.push('revoked'); return true;
    },
  };
  const provider = {
    async refresh({ refreshToken }) { providerCalls++; events.push('provider'); assert.equal(refreshToken, old.refreshToken); return { accessToken: 'new-access', refreshToken: 'rotated-refresh' }; },
    async verifySession() { return { userId: binding.userId, sessionId: binding.sessionId, expiresAt: now + 60_000 }; },
  };
  const manager = (options = {}) => createRefreshManager({ store, provider, crypto, clock: () => now, timeoutMs: 100, leaseMs: 500, ...options });
  return { crypto, store, provider, manager, events, row: () => row, now: () => now,
    advance: (ms) => { now += ms; }, providerCalls: () => providerCalls };
}

test('refresh persists dispatch first, verifies identity, stores encrypted rotation and returns no secrets', async () => {
  const f = fixture(), result = await f.manager().refresh('credential-1', binding);
  assert.deepEqual(result, { credentialRef: 'credential-1', expiresAt: 61_000 });
  assert.deepEqual(f.events, ['acquired', 'dispatched', 'provider', 'committed']);
  assert.equal(f.row().revision, 2); assert.equal(f.row().state, 'active');
  assert.deepEqual(f.crypto.open(f.row().envelope, binding), { accessToken: 'new-access', refreshToken: 'rotated-refresh', expiresAt: 61_000 });
  assert.ok(!JSON.stringify(f.row()).includes('rotated-refresh'));
});

test('two managers share one writer lease; a second refresh never calls the provider', async () => {
  const f = fixture(), wait = deferred(), started = deferred(); let calls = 0;
  f.provider.refresh = async () => { calls++; started.resolve(); return wait.promise; };
  const first = f.manager().refresh('credential-1', binding); await started.promise;
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_busy' });
  wait.resolve({ accessToken: 'new-access', refreshToken: 'rotated-refresh' }); await first;
  assert.equal(calls, 1);
});

test('revoke wins a provider response arriving late and blocks every later acquisition', async () => {
  const f = fixture(), wait = deferred(), started = deferred();
  f.provider.refresh = async () => { started.resolve(); return wait.promise; };
  const pending = f.manager().refresh('credential-1', binding); await started.promise;
  await f.manager().revoke('credential-1');
  wait.resolve({ accessToken: 'new-access', refreshToken: 'rotated-refresh' });
  await assert.rejects(pending, { code: 'session_reconnect_required' });
  assert.equal(f.row().state, 'revoked'); assert.equal(f.row().envelope, null);
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_revoked' });
});

test('provider timeout poisons the operation and ignores an uncancellable late success', async () => {
  const f = fixture(), wait = deferred(); let verifyCalls = 0;
  f.provider.refresh = async () => wait.promise;
  f.provider.verifySession = async () => { verifyCalls++; throw new Error('must not verify late material'); };
  await assert.rejects(f.manager({ timeoutMs: 15 }).refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(f.row().state, 'reconnect_required');
  wait.resolve({ accessToken: 'late-access', refreshToken: 'late-refresh' }); await tick();
  assert.equal(verifyCalls, 0); assert.equal(f.row().envelope, null);
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
});

test('verification rejects foreign subjects, foreign sessions and expired or malformed tokens', async (t) => {
  for (const delta of [{ userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }, { sessionId: 'browser-shared-session' },
    { expiresAt: 1000 }, { expiresAt: Infinity }]) {
    await t.test(JSON.stringify(delta), async () => {
      const f = fixture(); f.provider.verifySession = async () => ({ userId: binding.userId, sessionId: binding.sessionId, expiresAt: 9000, ...delta });
      await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
      assert.equal(f.row().state, 'reconnect_required'); assert.equal(f.row().envelope, null);
    });
  }
  const f = fixture(); let verified = false;
  f.provider.refresh = async () => ({ accessToken: 'a'.repeat(20_000), refreshToken: 'new' });
  f.provider.verifySession = async () => { verified = true; };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(verified, false);
});

test('unknown provider outcome never exposes the provider error or retries the old token', async () => {
  const f = fixture(); let calls = 0;
  f.provider.refresh = async () => { calls++; throw new Error('provider leaked secret-access-token'); };
  await assert.rejects(f.manager().refresh('credential-1', binding), (error) => error.message === 'session_reconnect_required' && !error.cause);
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(calls, 1);
});

test('expired dispatched lease after simulated worker loss requires reconnect; reserved lease can be reclaimed', async () => {
  const f = fixture(), input = { credentialRef: 'credential-1', binding, ownerId: 'old-worker', leaseMs: 5 };
  const a = await f.store.acquire(input);
  await f.store.markDispatched({ ...input, revision: a.credential.revision, fence: a.lease.fence }); f.advance(6);
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(f.providerCalls(), 0);
  const g = fixture(); const reserved = await g.store.acquire(input); g.advance(6);
  await g.manager().refresh('credential-1', binding);
  assert.ok(g.row().fence > reserved.lease.fence); assert.equal(g.providerCalls(), 1);
  const staleClaim = { ...input, fence: reserved.lease.fence, revision: reserved.credential.revision };
  assert.equal(await g.store.markDispatched(staleClaim), false);
  assert.equal(await g.store.requireReconnect(staleClaim), false);
  assert.equal(await g.store.release(staleClaim), false);
  assert.equal(g.row().state, 'active');
});

test('lease expiry during provider call prevents any write even without a second worker', async () => {
  const f = fixture(); f.provider.refresh = async () => { f.advance(600); return { accessToken: 'new-access', refreshToken: 'new-refresh' }; };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(f.row().state, 'reconnect_required'); assert.ok(!f.events.includes('committed'));
});

test('ambiguous dispatch acknowledgement never calls provider and leaves no reusable old material', async () => {
  const f = fixture(), mark = f.store.markDispatched;
  f.store.markDispatched = async (claim) => { await mark(claim); throw new Error('lost database acknowledgement'); };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(f.providerCalls(), 0); assert.equal(f.row().state, 'reconnect_required');
});

test('ambiguous commit acknowledgement invalidates the just-committed operation by retained fence', async () => {
  const f = fixture(), commit = f.store.commitRefresh;
  f.store.commitRefresh = async (claim) => { await commit(claim); throw new Error('lost commit acknowledgement'); };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(f.row().state, 'reconnect_required'); assert.equal(f.row().envelope, null);
  assert.deepEqual(f.events.slice(-2), ['committed', 'reconnect']);
});

test('late store commit after timeout cannot replace reconnect or revoked state', async () => {
  for (const revoke of [false, true]) {
    const f = fixture(), commit = f.store.commitRefresh, wait = deferred(); let late;
    f.store.commitRefresh = async (claim) => { await wait.promise; late = await commit(claim); return late; };
    await assert.rejects(f.manager({ timeoutMs: 15 }).refresh('credential-1', binding), { code: 'session_reconnect_required' });
    if (revoke) await f.manager().revoke('credential-1');
    wait.resolve(); await tick();
    assert.equal(late, false); assert.equal(f.row().state, revoke ? 'revoked' : 'reconnect_required'); assert.equal(f.row().envelope, null);
  }
});

test('unavailable invalidation retains dispatched uncertainty; expiry cannot restart provider work', async () => {
  const f = fixture(); f.provider.refresh = async () => { throw new Error('unknown remote outcome'); };
  f.store.requireReconnect = async () => { throw new Error('database temporarily down'); };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(f.row().state, 'refreshing'); assert.equal(f.row().lease.dispatched, true);
  f.advance(600);
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
});

test('decrypt failure before dispatch releases reservation without contacting provider', async () => {
  const f = fixture(); f.row().envelope.tag = 'AAAA';
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_material_unavailable' });
  assert.equal(f.providerCalls(), 0); assert.equal(f.row().state, 'active'); assert.equal(f.row().lease, null);
});

test('store cannot swap binding and config caps or malformed acquisition fail closed', async () => {
  const f = fixture();
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 30_001 }, { leaseMs: 10 }, { leaseMs: 120_001 }, { store: {} }, { provider: {} }]) {
    assert.throws(() => f.manager(options), { code: 'refresh_config_invalid' });
  }
  await assert.rejects(f.manager().refresh('credential-1', { ...binding, userId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }), { code: 'session_revoked' });
  const acquire = f.store.acquire;
  f.store.acquire = async (input) => { const value = await acquire(input); value.credential.binding.userId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'; return value; };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_storage_unavailable' });
  assert.equal(f.providerCalls(), 0);
});

test('invalid clocks and inherited status names never start provider work', async () => {
  const f = fixture();
  await assert.rejects(f.manager({ clock: () => NaN }).refresh('credential-1', binding), { code: 'refresh_clock_invalid' });
  assert.equal(f.row().state, 'active');
  f.store.acquire = async () => ({ status: 'toString' });
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_storage_unavailable' });
  assert.equal(f.providerCalls(), 0);
});
