import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnectionRecovery, ConnectionRecoveryError } from './connection-recovery.mjs';
import { SessionRefreshError } from './refresh-manager.mjs';
import { DurableConnectionStoreError } from './durable-connection-store.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { MIN_REFRESH_WINDOW_MS } from './refresh-window.mjs';

const NOW = 1800000000000, token = `hc_${'a'.repeat(43)}`, digest = createHash('sha256').update(token).digest('hex');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = () => ({ assistantId: id(2), userId: id(3), organizationId: id(4), sessionId: id(5) });
// SQL answer for a token that had expired: a 5-minute window, session still good for an hour.
const state = (changes = {}) => ({ status: 'recovered', connectionId: id(1), credentialRef: id(6), binding: binding(), sessionReady: true,
  sessionExpiresAt: NOW + 3600000, expiresAt: NOW + 300000, ...changes });
const receipt = (changes = {}) => ({ credentialRef: id(6), expiresAt: NOW + 3600000, ...changes });
const settled = (result, drained = Promise.resolve()) => Object.freeze({ result, drained });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(done => setImmediate(done));
const SECRETS = [token, digest, id(6), id(5), 'credentialRef', 'binding', 'sessionId', 'tokenDigest', 'PRIVATE'];
// Every attempt is probe -> store -> (refresh); `calls` records that order.
function fixture(t, hooks = {}) {
  const scope = createDependencyScope(), calls = [], timers = new Map(); let nextTimer = 0, time = NOW;
  const probe = { beginProbe(input) {
    calls.push('probe'); assert.deepEqual(Object.keys(input), ['signal']); assert(input.signal instanceof AbortSignal);
    return hooks.probe ? hooks.probe({ scope, signal: input.signal }) : settled(Promise.resolve({ reachable: true }));
  } };
  const store = { async recoverConnection(input, options) {
    calls.push('recover'); assert.deepEqual(input, { tokenDigest: digest }); assert(options.signal instanceof AbortSignal);
    return hooks.recover ? hooks.recover({ scope, signal: options.signal }) : state(hooks.state);
  } };
  const manager = { beginRefresh(ref, supplied, options) {
    calls.push('refresh'); assert.equal(ref, id(6)); assert.deepEqual(supplied, binding()); assert(options.signal instanceof AbortSignal);
    return hooks.refresh ? hooks.refresh({ signal: options.signal }) : settled(Promise.resolve(receipt()));
  } };
  const recovery = createConnectionRecovery({ connectionStore: store, refreshManager: manager, providerProbe: probe, dependencyScope: scope, clock: () => time,
    timers: { setTimeout(fn) { const handle = ++nextTimer; timers.set(handle, fn); return handle; }, clearTimeout(handle) { timers.delete(handle); } }, ...hooks.config });
  t.after(async () => { await recovery.close().catch(() => {}); await scope.close(); });
  return { recovery, calls, timers, scope, begin: signal => recovery.begin(token, { signal: signal ?? new AbortController().signal }) };
}
const refused = code => new SessionRefreshError(code);

test('an expired lease SQL has revived needs no refresh while the session is good; nothing but a fixed receipt leaves the lane', async t => {
  const f = fixture(t), operation = f.begin(); assert(Object.isFrozen(operation));
  const result = await operation.result; await operation.drained;
  assert.deepEqual(result, { ok: true, status: 'recovered', connectionId: id(1), refreshed: false }); assert(Object.isFrozen(result));
  assert.deepEqual(f.calls, ['probe', 'recover']); assert.equal(f.timers.size, 0);
  for (const secret of SECRETS) assert(!JSON.stringify(result).includes(secret), secret);
  assert.deepEqual(await f.recovery.recover(token, { signal: new AbortController().signal }), result); // the token is free again
});

test('unavailable is the only definitive answer and never reaches the refresh manager', async t => {
  for (const reply of [{ status: 'unavailable' }, Object.freeze({ status: 'unavailable' })]) {
    const f = fixture(t, { recover: () => reply }), operation = f.begin();
    const result = await operation.result; await operation.drained;
    assert.deepEqual(result, { ok: true, status: 'unavailable', refreshed: false }); assert(Object.isFrozen(result));
    assert.deepEqual(f.calls, ['probe', 'recover']);
  }
});

test('the Auth provider is probed first: unreachable is a transient rejection before SQL is asked, so no window is spent and nothing is dispatched', async t => {
  let getterReads = 0;
  for (const probe of [() => settled(Promise.reject(Error(`PRIVATE ${token} network down`))), () => settled(Promise.reject(Object.assign(Error('x'), { code: 'refresh_timeout' }))),
    () => { throw Error('PRIVATE refusal'); }, () => { throw Object.assign(Error('closed'), { code: 'refresh_closed' }); },
    ...[undefined, null, true, {}, { reachable: false }, { reachable: 'yes' }, { reachable: true, status: 200 }, [true],
      Object.defineProperty({}, 'reachable', { get() { getterReads++; return true; }, enumerable: true })].map(answer => () => settled(Promise.resolve(answer)))]) {
    const f = fixture(t, { probe }), operation = f.begin();
    await assert.rejects(operation.result, error => error instanceof ConnectionRecoveryError && error.code === 'recovery_provider_unreachable' &&
      error.message === 'recovery_provider_unreachable' && error.outcomeUnknown === false && error.cause === undefined);
    await operation.drained; assert.deepEqual(f.calls, ['probe']); // neither the store nor the refresh manager was touched
    assert.doesNotThrow(() => { const again = f.begin(); void again.result.catch(() => {}); }); // nothing is owned
    await f.recovery.close();
  }
  assert.equal(getterReads, 0);
  const order = fixture(t, { state: { sessionReady: false } }), operation = order.begin();
  assert.equal((await operation.result).refreshed, true); await operation.drained;
  assert.deepEqual(order.calls, ['probe', 'recover', 'refresh']);
});

test('the probe is the lane\'s own dependency work: its answer is not used before its actual drain, and an unproven or failed drain is retained', async t => {
  const entered = deferred(), drain = deferred();
  const f = fixture(t, { probe: () => { entered.resolve(); return { result: Promise.resolve({ reachable: true }), drained: drain.promise }; } });
  const operation = f.begin(); await entered.promise; await tick();
  try { assert.deepEqual(f.calls, ['probe']); assert.throws(() => f.begin(), /busy/); } finally { drain.resolve(); }
  await operation.result; await operation.drained; assert.deepEqual(f.calls, ['probe', 'recover']);
  let getterReads = 0;
  for (const probe of [() => ({ result: Promise.resolve({ reachable: true }), drained: Promise.reject(Error('PRIVATE unknown')) }),
    () => ({ result: Promise.resolve({ reachable: true }), drained: null }), () => ({ result: Promise.resolve({ reachable: true }) }),
    () => ({ result: Promise.resolve({ reachable: true }), drained: Promise.resolve(), extra: true }),
    () => ({ result: Promise.resolve({ reachable: true }), get drained() { getterReads++; return Promise.resolve(); } })]) {
    const g = fixture(t, { probe }), failed = g.begin();
    await assert.rejects(failed.result, { code: 'recovery_outcome_unknown' });
    await assert.rejects(failed.drained, { code: 'recovery_outcome_unknown' }); assert.throws(() => g.begin(), /busy/);
    await assert.rejects(g.recovery.close(), { code: 'recovery_outcome_unknown' }); assert.deepEqual(g.calls, ['probe']);
  }
  assert.equal(getterReads, 0);
});

test('a probe that outlives the lane deadline is a plain timeout: it gets the lane signal, SQL is never asked, and close holds its drain', async t => {
  const entered = deferred(), result = deferred(), drain = deferred(); let probeSignal;
  const f = fixture(t, { probe: ({ signal }) => { probeSignal = signal; entered.resolve(); return { result: result.promise, drained: drain.promise }; } });
  const operation = f.begin(); await entered.promise; [...f.timers.values()][0]();
  await assert.rejects(operation.result, { code: 'timeout', outcomeUnknown: false }); assert.equal(probeSignal.aborted, true);
  let closed = false; const closing = f.recovery.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  result.resolve({ reachable: true }); await tick(); assert.equal(closed, false); // a late "reachable" starts nothing
  drain.resolve(); await operation.drained; await closing; assert.deepEqual(f.calls, ['probe']);
});

test('an unready or nearly expired session is refreshed at once through the given manager, after the lease is back', async t => {
  for (const [changes, refreshed] of [[{ sessionReady: false, sessionExpiresAt: NOW - 3600000 }, true], [{ sessionReady: false }, true],
    [{ sessionExpiresAt: NOW + 300000 }, true], [{ sessionExpiresAt: NOW + 300001 }, false],
    [{ status: 'live', sessionReady: false, expiresAt: NOW + MIN_REFRESH_WINDOW_MS }, true], [{ status: 'live', expiresAt: NOW + 1000 }, false],
    [{ expiresAt: NOW + 1000 }, false]]) { // a short lease matters only when a refresh would start under it
    const f = fixture(t, { state: changes }), operation = f.begin();
    const result = await operation.result; await operation.drained;
    assert.deepEqual(result, { ok: true, status: changes.status ?? 'recovered', connectionId: id(1), refreshed });
    assert.deepEqual(f.calls, refreshed ? ['probe', 'recover', 'refresh'] : ['probe', 'recover']);
    for (const secret of SECRETS) assert(!JSON.stringify(result).includes(secret), secret);
  }
  // The session lead is the caller's: the backend passes the maintenance lane's 10 minutes.
  const wide = fixture(t, { state: { sessionExpiresAt: NOW + 600000 }, config: { refreshBeforeMs: 600000 } }), operation = wide.begin();
  assert.equal((await operation.result).refreshed, true); await operation.drained;
});

test('the refresh starts in the same turn as the store reply: the window SQL granted is not spent waiting', async t => {
  const reply = deferred(), order = [];
  const f = fixture(t, { recover: () => reply.promise, refresh: () => { order.push('refresh'); return settled(Promise.resolve(receipt())); } });
  const operation = f.begin(); await tick();
  reply.resolve(state({ sessionReady: false })); void reply.promise.then(() => Promise.resolve()).then(() => order.push('two microtasks later'));
  await operation.result; await operation.drained;
  assert.deepEqual(order, ['refresh', 'two microtasks later']);
});

test('no refresh starts under less than the shared minimum lease, whatever SQL answered: rejected as transient before dispatch, so the next call asks SQL again', async t => {
  assert.equal(MIN_REFRESH_WINDOW_MS, 150000);
  for (const status of ['live', 'recovered']) { // 'recovered' only after an unusually slow store round trip
    const short = fixture(t, { state: { status, sessionReady: false, expiresAt: NOW + MIN_REFRESH_WINDOW_MS - 1 } }), operation = short.begin();
    await assert.rejects(operation.result, { code: 'recovery_window_short', outcomeUnknown: false }); await operation.drained;
    assert.deepEqual(short.calls, ['probe', 'recover']);
    const enough = fixture(t, { state: { status, sessionReady: false, expiresAt: NOW + MIN_REFRESH_WINDOW_MS } }), second = enough.begin();
    assert.equal((await second.result).refreshed, true); await second.drained;
  }
});

test('no refresh failure is final: every one is a transient rejection, the drain is clean and the token can be tried again', async t => {
  for (const [failure, code] of [[refused('session_reconnect_required'), 'recovery_refresh_refused'], [refused('session_revoked'), 'recovery_refresh_refused'],
    [refused('refresh_storage_unavailable'), 'recovery_refresh_failed'], [refused('refresh_material_unavailable'), 'recovery_refresh_failed'],
    [refused('refresh_busy'), 'busy'], [refused('refresh_outcome_unknown'), 'recovery_outcome_unknown'],
    [Object.assign(Error(`PRIVATE ${token}`), { code: 'session_revoked' }), 'recovery_outcome_unknown']]) {
    const f = fixture(t, { state: { sessionReady: false }, refresh: () => settled(Promise.reject(failure)) }), operation = f.begin();
    await assert.rejects(operation.result, error => error instanceof ConnectionRecoveryError && error.code === code && error.message === code && error.cause === undefined);
    await operation.drained; assert.deepEqual(f.calls, ['probe', 'recover', 'refresh']);
    assert.doesNotThrow(() => { const again = f.begin(); void again.result.catch(() => {}); });
    await f.recovery.close();
  }
});

test('a typed admission refusal of the refresh manager started nothing: transient, drained, not retained', async t => {
  for (const [refusal, code] of [['refresh_busy', 'busy'], ['refresh_closed', 'recovery_unavailable'], ['refresh_cancelled', 'cancelled'], ['refresh_invalid_request', 'recovery_rejected']]) {
    const f = fixture(t, { state: { sessionReady: false }, refresh: () => { throw refused(refusal); } }), operation = f.begin();
    await assert.rejects(operation.result, { code, outcomeUnknown: false }); await operation.drained;
    await f.recovery.close(); // resolves: nothing is owned
  }
});

for (const invalid of ['missing drain', 'drain getter', 'extra field', 'begin throws']) {
  test(`unproven refresh drain retains ownership when ${invalid}`, async t => {
    const held = deferred(); let getterReads = 0;
    const f = fixture(t, { state: { sessionReady: false }, refresh: () => {
      if (invalid === 'begin throws') throw Error('refresh may already be running');
      if (invalid === 'drain getter') return { result: held.promise, get drained() { getterReads++; return Promise.resolve(); } };
      if (invalid === 'extra field') return { result: held.promise, drained: Promise.resolve(), unexpected: true };
      return { result: held.promise, drained: null };
    } });
    const operation = f.begin();
    await assert.rejects(operation.result, { code: 'recovery_outcome_unknown', outcomeUnknown: true });
    try {
      await assert.rejects(operation.drained, { code: 'recovery_outcome_unknown' });
      assert.throws(() => f.begin(), /busy/);
      await assert.rejects(f.recovery.close(), { code: 'recovery_outcome_unknown' });
      assert.equal(f.calls.filter(x => x === 'refresh').length, 1); assert.equal(getterReads, 0);
    } finally {
      if (invalid === 'begin throws') void held.promise.catch(() => {});
      held.reject(Error('late private provider failure')); await tick();
    }
  });
}

test('failed provider drain retains capacity and fails close, even with a successful result', async t => {
  const f = fixture(t, { state: { sessionReady: false }, refresh: () => ({ result: Promise.resolve(receipt()), drained: Promise.reject(Error('unknown')) }) });
  const operation = f.begin(); await assert.rejects(operation.result, { code: 'recovery_outcome_unknown' });
  await assert.rejects(operation.drained, { code: 'recovery_outcome_unknown' }); assert.throws(() => f.begin(), /busy/);
  await assert.rejects(f.recovery.close(), { code: 'recovery_outcome_unknown' });
});

test('public provider success is not reported before its actual drain', async t => {
  const entered = deferred(), drain = deferred();
  const f = fixture(t, { state: { sessionReady: false }, refresh: () => { entered.resolve(); return { result: Promise.resolve(receipt()), drained: drain.promise }; } });
  const operation = f.begin(); let done = false; void operation.result.then(() => { done = true; }); await entered.promise; await tick();
  try { assert.equal(done, false); assert.throws(() => f.begin(), /busy/); } finally { drain.resolve(); }
  assert.equal((await operation.result).refreshed, true); await operation.drained;
});

test('a refresh receipt for another credential, already expired, too far ahead or malformed is never reported as recovered', async t => {
  for (const ack of [receipt({ credentialRef: id(99) }), receipt({ expiresAt: NOW }), receipt({ expiresAt: NOW + 86400001 }), receipt({ expiresAt: 1.5 }),
    { ...receipt(), accessToken: 'PRIVATE' }, { credentialRef: id(6) }, null, { get credentialRef() { throw Error('getter'); }, expiresAt: NOW + 3600000 }]) {
    const f = fixture(t, { state: { sessionReady: false }, refresh: () => settled(Promise.resolve(ack)) }), operation = f.begin();
    await assert.rejects(operation.result, { code: 'recovery_outcome_unknown' }); await operation.drained; // the refresh itself drained
  }
  const edge = fixture(t, { state: { sessionReady: false }, refresh: () => settled(Promise.resolve(receipt({ expiresAt: NOW + 86400000 }))) }), operation = edge.begin();
  assert.equal((await operation.result).refreshed, true); await operation.drained;
});

test('store failures are transient and typed; only a fixed code crosses the lane', async t => {
  for (const [failure, code] of [[new DurableConnectionStoreError('connection_store_unavailable'), 'recovery_unavailable'],
    [new DurableConnectionStoreError('store_outcome_unknown'), 'recovery_unavailable'], [Error(`PRIVATE ${token}`), 'recovery_unavailable'],
    [new DurableConnectionStoreError('store_denied'), 'recovery_rejected'], [new DurableConnectionStoreError('store_conflict'), 'recovery_rejected'],
    [new DurableConnectionStoreError('store_rejected'), 'recovery_rejected']]) {
    const f = fixture(t, { recover: () => { throw failure; } }), operation = f.begin();
    await assert.rejects(operation.result, error => error instanceof ConnectionRecoveryError && error.code === code && error.message === code && error.cause === undefined);
    await operation.drained; assert.deepEqual(f.calls, ['probe', 'recover']);
  }
});

test('a store reply that is not the exact contract is rejected without interpreting it or invoking a getter', async t => {
  let getterReads = 0;
  for (const reply of [undefined, null, 'unavailable', [], { status: 'unavailable', reason: 'x' }, { status: 'dead' }, state({ status: 'renewed' }), state({ status: 'active' }),
    state({ connectionId: 'ABCDEF00-0000-4000-8000-000000000001' }), state({ credentialRef: 'ref' }), state({ sessionReady: 1 }), state({ sessionExpiresAt: 0 }), state({ expiresAt: 1.5 }),
    state({ expiresAt: Infinity }), state({ binding: { ...binding(), sessionId: 'named' } }), state({ binding: { ...binding(), extra: 1 } }), state({ binding: null }),
    { ...state(), token }, (({ sessionReady, ...rest }) => rest)(state()), Object.create(state()),
    Object.defineProperty(state(), 'status', { get() { getterReads++; return 'recovered'; }, enumerable: true }),
    state({ binding: Object.defineProperty(binding(), 'userId', { get() { getterReads++; return id(3); }, enumerable: true }) })]) {
    const f = fixture(t, { recover: () => reply }), operation = f.begin();
    await assert.rejects(operation.result, { code: 'recovery_rejected' }); await operation.drained;
    assert.deepEqual(f.calls, ['probe', 'recover']);
  }
  assert.equal(getterReads, 0);
});

// The lease instants come from the database clock; this host only bounds them (clock-skew.mjs).
test('a lease this host counts as expired, or longer than any lease SQL grants, is rejected before any refresh', async t => {
  for (const [expiresAt, ok] of [[NOW, false], [NOW + 1, true], [NOW + 900000 + 4000, true], [NOW + 900000 + 5001, false]]) {
    const f = fixture(t, { state: { status: 'live', expiresAt, sessionReady: false } }), operation = f.begin();
    if (ok && expiresAt - NOW >= MIN_REFRESH_WINDOW_MS) assert.equal((await operation.result).refreshed, true);
    else await assert.rejects(operation.result, { code: ok ? 'recovery_window_short' : 'recovery_rejected' });
    await operation.drained; assert.equal(f.calls.includes('refresh'), ok && expiresAt - NOW >= MIN_REFRESH_WINDOW_MS);
  }
});

test('invalid tokens, actors and getters never reach a dependency; configuration is validated and a lane without a probe cannot be built', async t => {
  const f = fixture(t), signal = new AbortController().signal; let reads = 0;
  for (const bad of ['hc_short', `HC_${'a'.repeat(43)}`, digest, undefined, { token }]) assert.throws(() => f.recovery.begin(bad, { signal }), { code: 'invalid_request' });
  assert.throws(() => f.recovery.begin(token), { code: 'invalid_request' });
  assert.throws(() => f.recovery.begin(token, { signal: {} }), { code: 'invalid_request' });
  assert.throws(() => f.recovery.begin(token, { signal, credentialRef: id(99) }), { code: 'invalid_request' });
  assert.throws(() => f.recovery.begin(token, { get signal() { reads++; return signal; } }), { code: 'invalid_request' });
  const aborted = new AbortController(); aborted.abort();
  assert.throws(() => f.recovery.begin(token, { signal: aborted.signal }), { code: 'cancelled' });
  await assert.rejects(f.recovery.recover('hc_short', { signal }), { code: 'invalid_request' });
  assert.equal(reads, 0); assert.deepEqual(f.calls, []); assert.equal(f.timers.size, 0);
  const parts = { connectionStore: { recoverConnection() {} }, refreshManager: { beginRefresh() {} }, providerProbe: { beginProbe() {} } };
  for (const bad of [{ connectionStore: {} }, { refreshManager: {} }, { providerProbe: undefined }, { providerProbe: {} }, { providerProbe: { probe() {} } },
    { refreshBeforeMs: 0 }, { refreshBeforeMs: 900001 }, { timeoutMs: 120001 }, { maxConcurrent: 17 }, { clock: 1 }, { timers: {} }, { dependencyScope: {} }]) {
    assert.throws(() => createConnectionRecovery({ ...parts, ...bad }), { message: 'invalid_connection_recovery_config' });
  }
  assert.throws(() => createConnectionRecovery(), { message: 'invalid_connection_recovery_config' });
  assert.doesNotThrow(() => createConnectionRecovery(parts));
  assert.equal(new ConnectionRecoveryError('PRIVATE free text').code, 'recovery_rejected');
});

test('one flight per token and a bounded number overall; a refused begin owns nothing', async t => {
  const held = deferred(), f = fixture(t, { recover: () => held.promise, config: { maxConcurrent: 2 } });
  const first = f.begin();
  assert.throws(() => f.begin(), { code: 'busy' });
  const other = f.recovery.begin(`hc_${'b'.repeat(43)}`, { signal: new AbortController().signal }); void other.result.catch(() => {});
  assert.throws(() => f.recovery.begin(`hc_${'c'.repeat(43)}`, { signal: new AbortController().signal }), { code: 'busy' });
  held.resolve(state()); await first.result; await first.drained;
  await assert.rejects(other.result); await other.drained; // the fixture store only knows the first token
  const again = f.begin(); await again.result; await again.drained;
});

test('timeout before the store answers is a plain timeout; the late answer dispatches no refresh and close holds the actual drain', async t => {
  const held = deferred(), entered = deferred();
  const f = fixture(t, { recover: () => { entered.resolve(); return held.promise; } });
  const operation = f.begin(); await entered.promise; [...f.timers.values()][0]();
  await assert.rejects(operation.result, { code: 'timeout', outcomeUnknown: false });
  let closed = false; const closing = f.recovery.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  assert.throws(() => f.begin(), { code: 'backend_closed' });
  held.resolve(state({ sessionReady: false })); await operation.drained; await closing;
  assert.deepEqual(f.calls, ['probe', 'recover']);
});

test('timeout after refresh dispatch is unknown; the caller abort reaches the refresh and close waits for its drain', async t => {
  const entered = deferred(), result = deferred(), drain = deferred(); let refreshSignal;
  const f = fixture(t, { state: { sessionReady: false }, refresh: ({ signal }) => { refreshSignal = signal; entered.resolve(); return { result: result.promise, drained: drain.promise }; } });
  const operation = f.begin(); await entered.promise; [...f.timers.values()][0]();
  await assert.rejects(operation.result, { code: 'recovery_outcome_unknown' }); assert.equal(refreshSignal.aborted, true);
  let closed = false; const closing = f.recovery.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  result.resolve(receipt()); await tick(); assert.equal(closed, false); drain.resolve();
  await operation.drained; await closing; assert.equal(f.calls.filter(x => x === 'refresh').length, 1);
});

test('caller cancellation and backend close stop the lane with fixed codes', async t => {
  const held = deferred(), controller = new AbortController(), f = fixture(t, { recover: () => held.promise });
  const operation = f.begin(controller.signal); await tick(); controller.abort();
  await assert.rejects(operation.result, { code: 'cancelled' }); held.resolve(state()); await operation.drained;
  const pending = deferred(), g = fixture(t, { recover: () => pending.promise }), second = g.begin(); await tick();
  const closing = g.recovery.close(); assert.equal(g.recovery.close(), closing);
  await assert.rejects(second.result, { code: 'backend_closed' }); pending.resolve(state()); await closing;
  assert.throws(() => g.begin(), { code: 'backend_closed' });
});

test('actual hidden store work retains drain and admission after the public adapter fails', async t => {
  const entered = deferred(), held = deferred();
  const f = fixture(t, { recover: ({ scope }) => { void scope.track(async () => { entered.resolve(); await held.promise; }); throw Error('public deadline'); } });
  const operation = f.begin(); await entered.promise; await assert.rejects(operation.result, { code: 'recovery_unavailable' });
  let drained = false; void operation.drained.then(() => { drained = true; });
  try { await tick(); assert.equal(drained, false); assert.throws(() => f.begin(), /busy/); }
  finally { held.resolve(); await operation.drained; }
});
