import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { createSessionCrypto } from './session-crypto.mjs';
import { createRefreshManager } from './refresh-manager.mjs';

const binding = { assistantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  organizationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', sessionId: 'dedicated-session-1' };
const old = { accessToken: 'old-access', refreshToken: 'single-use-refresh', expiresAt: 1000 };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const unknown = () => Object.assign(new Error('safe transport classification'), { code: 'store_outcome_unknown' });

// Test double only: synchronous mutations emulate linearizable store operations.
// No SQL, durable storage, distributed locks or crash recovery are proven here.
function fixture() {
  const crypto = createSessionCrypto({ activeKeyVersion: 'v1', keys: new Map([['v1', randomBytes(32)]]) });
  let now = 1000, row = { id: 'credential-1', binding: structuredClone(binding), revision: 1, fence: 0,
    state: 'active', envelope: crypto.seal(old, binding), expiresAt: old.expiresAt, lease: null,
    stagedEnvelope: null, stagedExpiresAt: null, publishedFence: null };
  const events = []; let providerCalls = 0;
  const owned = (c) => row && row.id === c.credentialRef && row.fence === c.fence && row.lease?.ownerId === c.ownerId;
  const exact = (c) => owned(c) && row.revision === c.revision;
  const store = {
    async acquire({ credentialRef, binding: expected, ownerId, leaseMs }) {
      if (!row || row.id !== credentialRef) return { status: 'missing' };
      if (JSON.stringify(row.binding) !== JSON.stringify(expected)) return { status: 'missing' };
      if (['revoked', 'reconnect_required'].includes(row.state)) return { status: row.state };
      if (['refreshing', 'staged'].includes(row.state)) {
        if (row.lease.expiresAt > now) return { status: 'busy' };
        if (row.lease.dispatched) { row.state = 'reconnect_required'; row.envelope = row.stagedEnvelope = null; row.revision++; return { status: row.state }; }
      }
      row.state = 'refreshing'; row.fence++; row.publishedFence = null;
      row.lease = { ownerId, fence: row.fence, expiresAt: now + leaseMs, dispatched: false };
      events.push('acquired');
      return { status: 'acquired', credential: { revision: row.revision, binding: structuredClone(row.binding), envelope: structuredClone(row.envelope) }, lease: structuredClone(row.lease) };
    },
    async markDispatched(c) {
      if (!exact(c) || row.state !== 'refreshing' || row.lease.dispatched || row.lease.expiresAt <= now) return false;
      row.lease.dispatched = true; events.push('dispatched'); return true;
    },
    async stageRefresh(c) {
      if (!exact(c) || !row.lease.dispatched || row.lease.expiresAt <= now || c.expiresAt <= now) return false;
      if (row.state === 'staged') return JSON.stringify(c.envelope) === JSON.stringify(row.stagedEnvelope) && c.expiresAt === row.stagedExpiresAt;
      if (row.state !== 'refreshing') return false;
      row.envelope = null; row.stagedEnvelope = structuredClone(c.envelope); row.stagedExpiresAt = c.expiresAt;
      row.state = 'staged'; events.push('staged'); return true;
    },
    async publishRefresh(c) {
      if (!owned(c)) return false;
      if (row.state === 'active' && row.revision === c.revision + 1 && row.publishedFence === c.fence && row.expiresAt > now) {
        return { ok: true, status: 'already_published', revision: row.revision, fence: row.fence };
      }
      if (!exact(c) || row.state !== 'staged' || row.lease.expiresAt <= now || row.stagedExpiresAt <= now) return false;
      row.envelope = row.stagedEnvelope; row.expiresAt = row.stagedExpiresAt;
      row.stagedEnvelope = row.stagedExpiresAt = null; row.revision++; row.publishedFence = row.fence;
      row.state = 'active'; events.push('published');
      return { ok: true, status: 'published', revision: row.revision, fence: row.fence };
    },
    async requireReconnect(c) {
      if (!owned(c) || ![c.revision, c.revision + 1].includes(row.revision) || row.state === 'revoked') return false;
      if (row.state === 'reconnect_required') return true;
      row.state = 'reconnect_required'; row.envelope = row.stagedEnvelope = null; row.revision++; events.push('reconnect'); return true;
    },
    async release(c) {
      if (!exact(c) || row.state !== 'refreshing' || row.lease.dispatched) return false;
      row.state = 'active'; row.lease = null; return true;
    },
    async revoke({ credentialRef }) {
      if (!row || row.id !== credentialRef) return false;
      row.state = 'revoked'; row.envelope = row.stagedEnvelope = null; row.fence++; row.revision++; row.lease = null; events.push('revoked'); return true;
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
  assert.deepEqual(f.events, ['acquired', 'dispatched', 'provider', 'staged', 'published']);
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
  await assert.rejects(pending, { code: 'refresh_outcome_unknown' });
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
  assert.equal(f.row().state, 'reconnect_required'); assert.ok(!f.events.includes('staged'));
});

test('ambiguous dispatch acknowledgement never calls provider and leaves no reusable old material', async () => {
  const f = fixture(), mark = f.store.markDispatched;
  f.store.markDispatched = async (claim) => { await mark(claim); throw new Error('lost database acknowledgement'); };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(f.providerCalls(), 0); assert.equal(f.row().state, 'reconnect_required');
});

test('lost publish acknowledgement reconciles the same claim without refreshing provider again', async () => {
  const f = fixture(), publish = f.store.publishRefresh, claims = [];
  f.store.publishRefresh = async (claim) => {
    claims.push(structuredClone(claim)); const result = await publish(claim);
    if (claims.length === 1) throw unknown();
    assert.equal(result.status, 'already_published'); return result;
  };
  assert.deepEqual(await f.manager().refresh('credential-1', binding), { credentialRef: 'credential-1', expiresAt: 61_000 });
  assert.equal(claims.length, 2); assert.deepEqual(claims[0], claims[1]);
  assert.equal(f.row().state, 'active'); assert.equal(f.providerCalls(), 1);
  assert.deepEqual(f.events.slice(-2), ['staged', 'published']);
});

test('late store publish after the manager deadline cannot replace reconnect or revoked state', async () => {
  for (const revoke of [false, true]) {
    const f = fixture(), publish = f.store.publishRefresh, wait = deferred(); let late;
    f.store.publishRefresh = async (claim) => { await wait.promise; late = await publish(claim); return late; };
    await assert.rejects(f.manager({ timeoutMs: 15 }).refresh('credential-1', binding), { code: 'session_reconnect_required' });
    if (revoke) await f.manager().revoke('credential-1');
    wait.resolve(); await tick();
    assert.equal(late, false); assert.equal(f.row().state, revoke ? 'revoked' : 'reconnect_required'); assert.equal(f.row().envelope, null);
  }
});

test('unavailable invalidation retains dispatched uncertainty; expiry cannot restart provider work', async () => {
  const f = fixture(); f.provider.refresh = async () => { throw new Error('unknown remote outcome'); };
  f.store.requireReconnect = async () => { throw new Error('database temporarily down'); };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_outcome_unknown' });
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

test('unknown stage acknowledgement reuses the original ciphertext and never reseals or redispatches', async () => {
  const f = fixture(), stage = f.store.stageRefresh, payloads = [];
  let seals = 0;
  const crypto = { open: f.crypto.open, seal: (...args) => { seals++; return f.crypto.seal(...args); } };
  f.store.stageRefresh = async payload => {
    payloads.push(structuredClone(payload)); const result = await stage(payload);
    assert.equal(f.row().envelope, null, 'STAGED is not readable active material');
    if (payloads.length === 1) { payload.envelope.nonce = 'mutated-by-adapter'; throw unknown(); }
    return result;
  };
  await f.manager({ crypto }).refresh('credential-1', binding);
  assert.equal(seals, 1); assert.equal(f.providerCalls(), 1); assert.equal(payloads.length, 2);
  assert.deepEqual(payloads[0], payloads[1]); assert.equal(f.events.filter(e => e === 'dispatched').length, 1);
});

test('two unknown stage or publish outcomes trigger one bounded quarantine and then stop', async () => {
  for (const method of ['stageRefresh', 'publishRefresh']) {
    const f = fixture(), original = f.store[method], reconnect = f.store.requireReconnect;
    let attempts = 0, quarantines = 0;
    f.store[method] = async input => { attempts++; await original(input); throw unknown(); };
    f.store.requireReconnect = async input => { quarantines++; return reconnect(input); };
    await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
    assert.equal(attempts, 2); assert.equal(quarantines, 1); assert.equal(f.providerCalls(), 1);
    assert.equal(f.row().state, 'reconnect_required'); assert.equal(f.row().envelope, null); assert.equal(f.row().stagedEnvelope, null);
    if (method === 'stageRefresh') assert.ok(!f.events.includes('published'));
  }
});

test('false, denied or malformed replies never enter stage/publish retry', async () => {
  for (const method of ['stageRefresh', 'publishRefresh']) {
    for (const failure of [false, { ok: false }, new Error('private backend detail'), { code: 'forbidden' }]) {
      const f = fixture(); let attempts = 0;
      f.store[method] = async () => { attempts++; if (failure instanceof Error || failure.code) throw failure; return failure; };
      await assert.rejects(f.manager().refresh('credential-1', binding), error => error.message === 'session_reconnect_required' && !error.cause);
      assert.equal(attempts, 1); assert.equal(f.providerCalls(), 1); assert.equal(f.row().state, 'reconnect_required');
    }
  }
});

test('publication must acknowledge the exact original revision and fence', async () => {
  for (const delta of [{ revision: 77 }, { fence: 77 }, { status: 'other' }, { ok: false }, { debug: 'secret' }]) {
    const f = fixture(), publish = f.store.publishRefresh; let attempts = 0;
    f.store.publishRefresh = async input => { attempts++; return { ...await publish(input), ...delta }; };
    await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
    assert.equal(attempts, 1); assert.equal(f.row().state, 'reconnect_required');
  }
});

test('revoke between lost publication ACK and its reconciliation always wins', async () => {
  const f = fixture(), publish = f.store.publishRefresh; let attempts = 0;
  f.store.publishRefresh = async input => {
    attempts++; const result = await publish(input);
    if (attempts === 1) { await f.manager().revoke('credential-1'); throw unknown(); }
    return result;
  };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_outcome_unknown' });
  assert.equal(attempts, 2); assert.equal(f.providerCalls(), 1);
  assert.equal(f.row().state, 'revoked'); assert.equal(f.row().envelope, null);
});

test('already-published receipt can reconcile after lease expiry; an unpublished stage cannot', async () => {
  const f = fixture(), publish = f.store.publishRefresh; let attempts = 0;
  f.store.publishRefresh = async input => {
    attempts++; const result = await publish(input);
    if (attempts === 1) { f.advance(600); throw unknown(); }
    return result;
  };
  await f.manager().refresh('credential-1', binding);
  assert.equal(attempts, 2); assert.equal(f.row().state, 'active');
  const g = fixture(), stage = g.store.stageRefresh;
  g.store.stageRefresh = async input => { const result = await stage(input); g.advance(600); return result; };
  await assert.rejects(g.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(g.row().state, 'reconnect_required'); assert.ok(!g.events.includes('published'));
});

test('every store operation receives its own live signal and the manager aborts timed-out work', async () => {
  const f = fixture(), signals = [];
  for (const method of Object.keys(f.store)) {
    const original = f.store[method];
    f.store[method] = async (input, { signal }) => {
      assert.ok(signal instanceof AbortSignal); assert.equal(signal.aborted, false);
      signals.push(signal); return original(input);
    };
  }
  await f.manager().refresh('credential-1', binding); await f.manager().revoke('credential-1');
  assert.equal(new Set(signals).size, signals.length); assert.ok(signals.every(signal => signal.aborted));
  const g = fixture(); let timedOutSignal;
  g.store.stageRefresh = (_input, { signal }) => { timedOutSignal = signal; return new Promise(() => {}); };
  await assert.rejects(g.manager({ timeoutMs: 15 }).refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(timedOutSignal.aborted, true); assert.equal(g.row().state, 'reconnect_required');
});

test('lost ACKs plus unavailable quarantine do not return success or invoke the provider again', async () => {
  const f = fixture(), publish = f.store.publishRefresh;
  let publishes = 0, quarantines = 0;
  f.store.publishRefresh = async input => { publishes++; await publish(input); throw unknown(); };
  f.store.requireReconnect = async () => { quarantines++; throw new Error('DB down'); };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_outcome_unknown' });
  assert.equal(publishes, 2); assert.equal(quarantines, 1); assert.equal(f.providerCalls(), 1);
  // A caller's missing ACK does not overturn a committed DB decision. Its own
  // work stops; another broker still needs fresh joined-state/Auth admission.
  assert.equal(f.row().state, 'active');
  assert.deepEqual(f.crypto.open(f.row().envelope, binding), {
    accessToken: 'new-access', refreshToken: 'rotated-refresh', expiresAt: 61_000,
  });
});

test('unknown dispatch and provider errors are never treated as publication reconciliation', async () => {
  const f = fixture(); let dispatches = 0;
  f.store.markDispatched = async () => { dispatches++; throw unknown(); };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(dispatches, 1); assert.equal(f.providerCalls(), 0);
  const g = fixture(); let providers = 0;
  g.provider.refresh = async () => { providers++; throw unknown(); };
  await assert.rejects(g.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(providers, 1); assert.ok(!g.events.includes('staged'));
});

test('quarantine after two unknown publications uses the same claim and remains deadline-bounded', async () => {
  const f = fixture(), claims = []; let quarantineClaim, quarantineSignal, quarantines = 0;
  f.store.publishRefresh = async input => { claims.push(structuredClone(input)); throw unknown(); };
  f.store.requireReconnect = (input, { signal }) => {
    quarantines++; quarantineClaim = structuredClone(input); quarantineSignal = signal;
    return new Promise(() => {});
  };
  await assert.rejects(f.manager({ timeoutMs: 15 }).refresh('credential-1', binding), { code: 'refresh_outcome_unknown' });
  assert.equal(claims.length, 2); assert.equal(quarantines, 1);
  assert.deepEqual(claims[0], claims[1]); assert.deepEqual(claims[0], quarantineClaim);
  assert.equal(quarantineSignal.aborted, true); assert.equal(f.providerCalls(), 1);
  assert.equal(f.row().state, 'staged'); assert.equal(f.row().envelope, null);
});

test('only a confirmed true quarantine ACK allows the manager to claim reconnect is required', async t => {
  for (const response of [false, undefined, null, {}, { ok: true }]) {
    await t.test(`unconfirmed ${JSON.stringify(response)}`, async () => {
      const f = fixture(); let quarantines = 0;
      f.provider.refresh = async () => { throw new Error('PRIVATE_PROVIDER_ERROR'); };
      f.store.requireReconnect = async () => { quarantines++; return response; };
      await assert.rejects(f.manager().refresh('credential-1', binding), error =>
        error.code === 'refresh_outcome_unknown' && error.message === 'refresh_outcome_unknown' && error.cause === undefined);
      assert.equal(quarantines, 1); assert.equal(f.row().lease.dispatched, true);
      assert.equal(f.row().state, 'refreshing'); assert(!f.events.includes('staged'));
      // An unknown operation cannot be started again under a live lease.
      await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_busy' });
      assert.equal(quarantines, 1);
    });
  }
  const confirmed = fixture(); confirmed.provider.refresh = async () => { throw new Error('provider failure'); };
  await assert.rejects(confirmed.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(confirmed.row().state, 'reconnect_required'); assert.equal(confirmed.row().envelope, null);
});

test('unknown publish without a committed publish leaves STAGED closed and never falls back to old material', async () => {
  const f = fixture(), claims = []; let quarantines = 0;
  f.store.publishRefresh = async claim => { claims.push(structuredClone(claim)); throw unknown(); };
  f.store.requireReconnect = async () => { quarantines++; return false; };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_outcome_unknown' });
  assert.equal(claims.length, 2); assert.deepEqual(claims[0], claims[1]); assert.equal(quarantines, 1);
  assert.equal(f.providerCalls(), 1); assert.equal(f.row().state, 'staged'); assert.equal(f.row().envelope, null);
  assert.deepEqual(f.crypto.open(f.row().stagedEnvelope, binding), {
    accessToken: 'new-access', refreshToken: 'rotated-refresh', expiresAt: 61_000,
  });
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_busy' });
  assert.equal(f.providerCalls(), 1);
});

test('a committed quarantine with lost ACK stays unknown to this caller while storage remains closed', async () => {
  const f = fixture(), publish = f.store.publishRefresh, reconnect = f.store.requireReconnect;
  let publishes = 0, quarantines = 0;
  f.store.publishRefresh = async claim => { publishes++; await publish(claim); throw unknown(); };
  f.store.requireReconnect = async claim => { quarantines++; await reconnect(claim); throw unknown(); };
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'refresh_outcome_unknown' });
  assert.equal(publishes, 2); assert.equal(quarantines, 1); assert.equal(f.providerCalls(), 1);
  assert.equal(f.row().state, 'reconnect_required'); assert.equal(f.row().envelope, null); assert.equal(f.row().stagedEnvelope, null);
  await assert.rejects(f.manager().refresh('credential-1', binding), { code: 'session_reconnect_required' });
  assert.equal(f.providerCalls(), 1);
});

test('optional caller signal is backward compatible; invalid or pre-acquire cancellation has no side effects', async () => {
  for (const signal of [null, {}, 'not-a-signal']) {
    const f = fixture();
    await assert.rejects(f.manager().refresh('credential-1', binding, { signal }), { code: 'refresh_invalid_request' });
    assert.deepEqual(f.events, []);
  }
  const f = fixture(), controller = new AbortController(); controller.abort();
  await assert.rejects(f.manager().refresh('credential-1', binding, { signal: controller.signal }), { code: 'refresh_cancelled' });
  assert.deepEqual(f.events, []);
  const g = fixture(), immediate = new AbortController();
  const pending = g.manager().refresh('credential-1', binding, { signal: immediate.signal }); immediate.abort();
  await assert.rejects(pending, { code: 'refresh_cancelled' }); assert.deepEqual(g.events, []);
  assert.equal(getEventListeners(immediate.signal, 'abort').length, 0);
});

test('cancelled in-flight acquire without a confirmed claim stays unknown and never dispatches after a late ACK', async () => {
  const f = fixture(), controller = new AbortController(), waiting = deferred(), started = deferred(), acquire = f.store.acquire;
  let receivedSignal, releases = 0;
  f.store.acquire = async (input, { signal }) => { receivedSignal = signal; started.resolve(); await waiting.promise; return acquire(input); };
  f.store.release = async () => { releases++; return false; };
  const pending = f.manager().refresh('credential-1', binding, { signal: controller.signal }); await started.promise;
  const rejected = assert.rejects(pending, { code: 'refresh_outcome_unknown' }); controller.abort(); await rejected;
  waiting.resolve(); await tick();
  assert(receivedSignal.aborted); assert.equal(releases, 0); assert.equal(f.providerCalls(), 0);
  assert.equal(f.row().state, 'refreshing'); assert.equal(f.row().lease.dispatched, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('a known reservation cancelled before dispatch gets one independent release; an unconfirmed release stays unknown', async () => {
  for (const ack of [true, false, 'lost']) {
    const f = fixture(), controller = new AbortController(), release = f.store.release;
    let releases = 0, signal;
    const crypto = { ...f.crypto, open: (...args) => { const value = f.crypto.open(...args); controller.abort(); return value; } };
    f.store.release = async (input, options) => {
      releases++; signal = options.signal; assert(!signal.aborted); assert.notEqual(signal, controller.signal);
      if (ack === true) return release(input);
      if (ack === 'lost') { await release(input); throw unknown(); }
      return false;
    };
    await assert.rejects(f.manager({ crypto }).refresh('credential-1', binding, { signal: controller.signal }),
      { code: ack === true ? 'refresh_cancelled' : 'refresh_outcome_unknown' });
    assert.equal(releases, 1); assert.equal(f.providerCalls(), 0); assert(!f.events.includes('dispatched'));
    assert(signal.aborted); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    if (ack === true) assert.equal(f.row().state, 'active');
  }
});

test('cancellation during dispatch acknowledgement quarantines independently and never reaches the provider', async () => {
  const f = fixture(), controller = new AbortController(), started = deferred(), wait = deferred(), dispatch = f.store.markDispatched;
  const reconnect = f.store.requireReconnect; let reconnects = 0, late;
  f.store.markDispatched = async (claim, { signal }) => { started.resolve(); await wait.promise; assert(signal.aborted); late = await dispatch(claim); return late; };
  f.store.requireReconnect = async (claim, { signal }) => { reconnects++; assert(!signal.aborted); return reconnect(claim); };
  const pending = f.manager().refresh('credential-1', binding, { signal: controller.signal }); await started.promise;
  const rejected = assert.rejects(pending, { code: 'session_reconnect_required' }); controller.abort(); await rejected;
  wait.resolve(); await tick();
  assert.equal(reconnects, 1); assert.equal(late, false); assert.equal(f.providerCalls(), 0);
  assert.equal(f.row().state, 'reconnect_required'); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('provider and verifier inherit caller cancellation; late responses cannot verify, stage, publish or retry', async () => {
  for (const cancelAt of ['refresh', 'verifySession']) {
    const f = fixture(), controller = new AbortController(), started = deferred(), wait = deferred();
    const original = f.provider[cancelAt]; let calls = 0, receivedSignal, verifies = 0;
    const verify = f.provider.verifySession;
    f.provider.verifySession = async input => { verifies++; return verify(input); };
    f.provider[cancelAt] = async input => { calls++; receivedSignal = input.signal; started.resolve(); await wait.promise; return original(input); };
    const pending = f.manager().refresh('credential-1', binding, { signal: controller.signal }); await started.promise;
    const rejected = assert.rejects(pending, { code: 'session_reconnect_required' }); controller.abort(); await rejected;
    wait.resolve(); await tick();
    assert(receivedSignal.aborted); assert.equal(calls, 1); assert.equal(verifies, 0);
    assert(!f.events.includes('staged')); assert(!f.events.includes('published'));
    assert.equal(f.row().state, 'reconnect_required'); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});

test('caller cancellation after unknown stage/publication suppresses retry and preserves the original claim for independent quarantine', async () => {
  for (const method of ['stageRefresh', 'publishRefresh']) {
    for (const ack of [true, false]) {
      const f = fixture(), controller = new AbortController(), original = f.store[method], reconnect = f.store.requireReconnect;
      let attempts = 0, reconnects = 0, originalClaim;
      f.store[method] = async input => {
        attempts++; originalClaim = Object.fromEntries(['credentialRef', 'binding', 'ownerId', 'revision', 'fence'].map(key => [key, structuredClone(input[key])]));
        await original(input); controller.abort(); throw unknown();
      };
      f.store.requireReconnect = async (claim, { signal }) => {
        reconnects++; assert(!signal.aborted); assert.deepEqual(claim, originalClaim);
        return ack ? reconnect(claim) : false;
      };
      await assert.rejects(f.manager().refresh('credential-1', binding, { signal: controller.signal }),
        { code: ack ? 'session_reconnect_required' : 'refresh_outcome_unknown' });
      assert.equal(attempts, 1); assert.equal(reconnects, 1); assert.equal(f.providerCalls(), 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    }
  }
});

test('cancelled caller cannot cancel bounded quarantine or turn its missing ACK into a confirmed outcome', async () => {
  const f = fixture(), controller = new AbortController(); let reconnects = 0, cleanupSignal;
  f.provider.refresh = async () => { controller.abort(); throw new Error('private provider outcome'); };
  f.store.requireReconnect = (_claim, { signal }) => { reconnects++; cleanupSignal = signal; assert(!signal.aborted); return new Promise(() => {}); };
  await assert.rejects(f.manager({ timeoutMs: 15 }).refresh('credential-1', binding, { signal: controller.signal }), { code: 'refresh_outcome_unknown' });
  assert.equal(reconnects, 1); assert(cleanupSignal.aborted); assert.equal(f.row().lease.dispatched, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('successful calls remove caller listeners and snapshot provider material before awaited verification', async () => {
  const f = fixture(), controller = new AbortController(), tokens = { accessToken: 'new-access', refreshToken: 'rotated-refresh' };
  f.provider.refresh = async () => tokens;
  f.provider.verifySession = async ({ accessToken, signal }) => {
    assert.equal(accessToken, 'new-access'); assert(!signal.aborted);
    tokens.accessToken = 'foreign-access'; tokens.refreshToken = 'foreign-refresh';
    return { userId: binding.userId, sessionId: binding.sessionId, expiresAt: 61000 };
  };
  await f.manager().refresh('credential-1', binding, { signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(f.crypto.open(f.row().envelope, binding), { accessToken: 'new-access', refreshToken: 'rotated-refresh', expiresAt: 61000 });
  controller.abort(); assert.equal(f.row().state, 'active');
});
