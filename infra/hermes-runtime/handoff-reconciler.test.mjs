import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandoffReconciler } from './handoff-reconciler.mjs';
import { createRuntimeOrchestrator } from './runtime-orchestrator.mjs';

const NOW = 1800000000000;
const uuid = (type, n) => `${type}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const record = n => ({ connectionId: uuid(4, n), assistantId: uuid(3, n), userId: uuid(1, n),
  organizationId: uuid(2, 1), operationId: uuid(5, n), token: 'hc_' + String.fromCharCode(96 + n).repeat(43) });
const A = record(1), B = record(2), C = record(3);
const owner = row => Object.fromEntries(['connectionId', 'assistantId', 'userId', 'organizationId'].map(key => [key, row[key]]));
const current = row => ({ ...owner(row), expiresAt: NOW + 600000 });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const pause = () => new Promise(resolve => setImmediate(resolve));
function fakeTimers() {
  const jobs = new Map(); let id = 0;
  return { jobs, setTimeout(fn, ms) { const key = ++id; jobs.set(key, { fn, ms }); return key; }, clearTimeout(key) { jobs.delete(key); },
    fire() { assert.equal(jobs.size, 1); const [key, item] = [...jobs][0]; jobs.delete(key); item.fn(); } };
}
function fixture(changes = {}) {
  const timer = fakeTimers(), events = [], handles = new Map(); let batch = [A, B], now = NOW;
  const calls = { list: 0, resolve: [], attach: [], stop: [] };
  const handoff = { async list(options) { calls.list++; events.push('list'); return changes.list ? changes.list(options, batch) : batch; } };
  const backend = { async resolveConnection(token, options) { calls.resolve.push(token); events.push('resolve');
    if (changes.resolve) return changes.resolve(token, options);
    return current(batch.find(row => row.token === token));
  } };
  const orchestrator = {
    async attach(input) { calls.attach.push(input); events.push('attach');
      if (changes.attach) return changes.attach(input, handles);
      const handle = Object.freeze({}); handles.set(handle, { state: 'active', ...input.expectedOwner, expiresAt: now + 600000 }); return handle;
    },
    status(handle) { events.push('status'); assert(handles.has(handle)); return changes.status ? changes.status(handle, handles) : handles.get(handle); },
    async stop(handle) { calls.stop.push(handle); events.push('stop'); await changes.stop?.(handle); handles.delete(handle); },
  };
  const config = { handoff, backend, orchestrator, timers: timer, clock: () => now, ...changes.config };
  const reconciler = createHandoffReconciler(config);
  return { reconciler, config, calls, events, handles, timer, setBatch(value) { batch = value; }, advance(ms) { now += ms; },
    async poll() { timer.fire(); await pause(); } };
}

test('inert factory, one explicit start, A/B fresh authority and expected-owner snapshots', async () => {
  const f = fixture(); assert.deepEqual(f.events, []); assert.equal(f.timer.jobs.size, 0);
  assert.equal(f.reconciler.status().state, 'idle'); f.reconciler.start(); f.reconciler.start(); await pause();
  assert.equal(f.calls.list, 1); assert.equal(f.calls.attach.length, 2); assert.equal(f.reconciler.status().active, 2);
  for (const input of f.calls.attach) {
    assert.deepEqual(Object.keys(input).sort(), ['expectedOwner', 'signal', 'token']); assert(Object.isFrozen(input.expectedOwner));
    assert.deepEqual(input.expectedOwner, owner(input.token === A.token ? A : B));
  }
  await f.poll(); assert.equal(f.calls.attach.length, 2); assert.equal(f.calls.resolve.length, 2);
  assert(Object.isFrozen(f.reconciler.status())); assert(!JSON.stringify(f.reconciler.status()).includes('hc_'));
  assert(!JSON.stringify(f.reconciler.status()).includes(A.userId));
  await f.reconciler.close(); assert.equal(f.calls.stop.length, 2); assert.equal(f.reconciler.status().active, 0);
  assert.equal(f.reconciler.status().stopped, 2); assert.equal(f.timer.jobs.size, 0);
});

test('stage visible before activation and unknown reads retry only reads; current expiry is authoritative', async () => {
  let published = false;
  const f = fixture({ resolve: async token => { if (!published) throw Error('PRIVATE token ' + token); return current(token === A.token ? A : B); } });
  f.reconciler.start(); await pause(); assert.equal(f.reconciler.status().pending, 2); assert.equal(f.calls.attach.length, 0);
  await f.poll(); assert.equal(f.calls.resolve.length, 4); published = true; await f.poll();
  assert.equal(f.calls.resolve.length, 6); assert.equal(f.calls.attach.length, 2); await f.reconciler.close();
});

test('revoked/expired authority never attaches, changed owner quarantines only that operation', async () => {
  const f = fixture({ resolve: async token => token === A.token ? { ...current(A), organizationId: uuid(2, 9) } : { ...current(B), expiresAt: NOW } });
  f.reconciler.start(); await pause(); assert.equal(f.calls.attach.length, 0); assert.equal(f.reconciler.status().needsAttention, 1);
  assert.equal(f.reconciler.status().pending, 1); await f.poll(); assert.deepEqual(f.calls.resolve, [A.token, B.token, B.token]); await f.reconciler.close();
});

test('owner identity is checked for every immutable field before dispatch', async t => {
  for (const key of ['connectionId', 'assistantId', 'userId', 'organizationId']) await t.test(key, async () => {
    const f = fixture({ resolve: async () => ({ ...current(A), [key]: uuid(9, 1) }) }); f.setBatch([A]);
    f.reconciler.start(); await pause(); assert.equal(f.calls.attach.length, 0); assert.equal(f.reconciler.status().needsAttention, 1); await f.reconciler.close();
  });
});

test('single-flight list and actual resolver drain hold concurrency while other polls remain bounded', async () => {
  const listing = deferred(), reading = deferred(); let delayed = true;
  const f = fixture({ list: () => delayed ? listing.promise : [A, B, C], resolve: async token => { if (token !== C.token) await reading.promise; return current({ [A.token]: A, [B.token]: B, [C.token]: C }[token]); } });
  f.reconciler.start(); await pause(); assert.equal(f.calls.list, 1); assert.equal(f.timer.jobs.size, 0);
  f.reconciler.start(); listing.resolve([A, B, C]); delayed = false; await pause();
  assert.equal(f.calls.resolve.length, 2); assert.equal(f.reconciler.status().inFlight, 2); assert.equal(f.timer.jobs.size, 1);
  await f.poll(); await f.poll(); assert.equal(f.calls.resolve.length, 2); assert.equal(f.calls.attach.length, 0);
  reading.resolve(); await pause(); assert.equal(f.calls.attach.length, 3); assert.equal(f.reconciler.status().inFlight, 0); await f.reconciler.close();
});

test('ignored attach promise retains its slot and no operation is redispatched after a rejected attachment', async () => {
  const waiting = deferred(); let thrown = 0;
  const f = fixture({ attach: input => { if (input.token === A.token) return waiting.promise; thrown++; throw Error('PRIVATE attachment outcome unknown'); } });
  f.setBatch([A, B, C]); f.reconciler.start(); await pause();
  assert.equal(f.calls.attach.length, 3); assert.equal(f.reconciler.status().inFlight, 1); assert.equal(thrown, 2);
  await f.poll(); await f.poll(); assert.equal(f.calls.attach.length, 3);
  let settled = false; const closed = f.reconciler.close().then(() => { settled = true; }); await pause(); assert.equal(settled, false);
  waiting.reject(Error('PRIVATE ignored abort')); await closed; assert.equal(f.calls.attach.length, 3);
});

test('duplicate profile or connection cannot dispatch a second operation; valid B progresses', async () => {
  const sameProfile = { ...C, assistantId: A.assistantId }, sameConnection = { ...record(4), connectionId: A.connectionId };
  const all = [A, sameProfile, sameConnection, B];
  const f = fixture({ resolve: async token => current(all.find(row => row.token === token)) }); f.setBatch(all);
  f.reconciler.start(); await pause(); assert.equal(f.calls.attach.length, 2); assert.deepEqual(f.calls.attach.map(row => row.token), [A.token, B.token]);
  assert.equal(f.reconciler.status().pending, 2); await f.poll(); assert.equal(f.calls.attach.length, 2); await f.reconciler.close();
});

test('malformed batches are atomic and never execute accessors or expose errors', async t => {
  let getters = 0;
  const accessor = { ...A }; Object.defineProperty(accessor, 'token', { enumerable: true, get() { getters++; return A.token; } });
  const arrayGetter = [A]; Object.defineProperty(arrayGetter, '0', { get() { getters++; return A; } });
  const malformed = [ [A, A], [A, { ...B, unexpected: B.token }], [accessor], arrayGetter, [A, { ...B, operationId: 'invalid' }],
    [Object.assign(Object.create({}), A)], Object.assign([A], { extra: true }), [A, , B], { records: [A] } ];
  for (let i = 0; i < malformed.length; i++) await t.test(String(i), async () => {
    const f = fixture(); f.setBatch(malformed[i]); f.reconciler.start(); await pause();
    assert.equal(f.calls.resolve.length, 0); assert.equal(f.calls.attach.length, 0); assert.equal(f.reconciler.status().discovery, 'unavailable');
    assert(!JSON.stringify(f.reconciler.status()).includes(A.token)); await f.reconciler.close();
  });
  assert.equal(getters, 0);
});

test('batch rows are snapshotted before authority awaits and a changed committed record stops only A', async () => {
  const reading = deferred(), mutable = { ...A };
  const f = fixture({ resolve: async token => { if (token === A.token) await reading.promise; return current(token === A.token ? A : B); } });
  f.setBatch([mutable, B]); f.reconciler.start(); await pause(); mutable.token = C.token; mutable.userId = C.userId;
  reading.resolve(); await pause(); assert.equal(f.calls.attach[1].token, A.token); assert.deepEqual(f.calls.attach[1].expectedOwner, owner(A));
  await f.poll(); assert.equal(f.calls.stop.length, 1); assert.equal(f.reconciler.status().needsAttention, 1); assert.equal(f.reconciler.status().active, 1);
  assert.equal(f.reconciler.status().discovery, 'unavailable'); await f.reconciler.close();
});

test('bounded state retains attempted operation tombstones rather than evicting and replaying them', async () => {
  const f = fixture({ config: { maxRecords: 2 } }); f.reconciler.start(); await pause();
  f.setBatch([C]); await f.poll(); assert.equal(f.reconciler.status().records, 2); assert.equal(f.reconciler.status().capacityReached, true);
  f.setBatch([A, B]); await f.poll(); assert.equal(f.calls.attach.length, 2); await f.reconciler.close();
});

test('a new connection for the same assistant waits actual old stop, then attaches once without replaying old operation', async () => {
  const stopped = deferred(), replacement = { ...C, assistantId: A.assistantId, userId: A.userId }; let invalid = false;
  const f = fixture({ resolve: async token => current(token === A.token ? A : replacement),
    status: (handle, handles) => { const value = handles.get(handle); return invalid && value.connectionId === A.connectionId ? { ...value, state: 'reconnect_required' } : value; },
    stop: handle => f.handles.get(handle).connectionId === A.connectionId ? stopped.promise : undefined,
  });
  f.setBatch([A]); f.reconciler.start(); await pause(); f.setBatch([A, replacement]); invalid = true;
  try {
    await f.poll(); assert.equal(f.calls.stop.length, 1); assert.equal(f.calls.attach.length, 1);
    assert.equal(f.reconciler.status().pending, 1, 'new operation must wait, not become a permanent duplicate tombstone');
    await f.poll(); assert.equal(f.calls.attach.length, 1, 'stop result must retain the old profile fence until actual drain');
    stopped.resolve(); await pause(); await f.poll(); assert.equal(f.calls.attach.length, 2);
    assert.equal(f.calls.attach[1].token, replacement.token); assert.equal(f.reconciler.status().active, 1);
    await f.poll(); assert.equal(f.calls.attach.length, 2, 'old dispatched operation must never retry');
  } finally { stopped.resolve(); await f.reconciler.close(); }
});

test('unknown attachment without a handle retains its profile fence against a new operation', async () => {
  const replacement = { ...C, assistantId: A.assistantId, userId: A.userId };
  const f = fixture({ resolve: async token => current(token === A.token ? A : replacement), attach: async () => { throw Error('unknown start outcome'); } });
  f.setBatch([A]); f.reconciler.start(); await pause(); f.setBatch([A, replacement]); await f.poll(); await f.poll();
  assert.equal(f.calls.attach.length, 1); assert.equal(f.reconciler.status().needsAttention, 1); assert.equal(f.reconciler.status().pending, 1);
  await f.reconciler.close();
});

test('runtime terminal/malformed status is stopped without retry; healthy B remains active', async t => {
  for (const broken of ['reconnect_required', 'wrong-owner', 'getter']) await t.test(broken, async () => {
    let invalidate = false, getters = 0;
    const f = fixture({ status: (handle, handles) => {
      const value = handles.get(handle); if (!invalidate || value.userId !== A.userId) return value;
      if (broken === 'wrong-owner') return { ...value, userId: B.userId };
      if (broken === 'getter') { const raw = { ...value }; Object.defineProperty(raw, 'state', { get() { getters++; return 'active'; } }); return raw; }
      return { ...value, state: broken };
    } });
    f.reconciler.start(); await pause(); invalidate = true; await f.poll();
    assert.equal(getters, 0); assert.equal(f.calls.stop.length, 1); assert.equal(f.reconciler.status().active, 1); assert.equal(f.reconciler.status().needsAttention, 1);
    await f.poll(); assert.equal(f.calls.attach.length, 2); await f.reconciler.close();
  });
});

test('close aborts a pending resolver but waits actual drain and starts no attachment', async () => {
  const reading = deferred(); let signal;
  const f = fixture({ resolve: async (token, options) => { signal = options.signal; await reading.promise; return current(A); } }); f.setBatch([A]);
  f.reconciler.start(); await pause(); let settled = false; const closed = f.reconciler.close().then(() => { settled = true; });
  assert(signal.aborted); await pause(); assert.equal(settled, false); reading.resolve(); await closed; assert.equal(f.calls.attach.length, 0);
  assert.equal(f.reconciler.status().state, 'closed'); assert.throws(() => f.reconciler.start(), /handoff_reconciler_closed/);
});

test('close waits late attach handle and actual stop; shared backend/orchestrator close are host-owned', async () => {
  const starting = deferred(), stopping = deferred(), handle = Object.freeze({});
  const f = fixture({ attach: async () => { await starting.promise; return handle; }, stop: () => stopping.promise }); f.setBatch([A]);
  f.config.backend.close = () => assert.fail('must not close shared backend'); f.config.orchestrator.close = () => assert.fail('must not close shared orchestrator');
  f.reconciler.start(); await pause(); let closed = false; const closing = f.reconciler.close(); assert.strictEqual(f.reconciler.close(), closing);
  void closing.then(() => { closed = true; }); await pause(); assert.equal(closed, false); starting.resolve(); await pause();
  assert.deepEqual(f.calls.stop, [handle]); assert.equal(closed, false); stopping.resolve(); await closing; assert.equal(closed, true);
});

test('failed stop and malformed returned handle never claim a clean shutdown or retry attachment', async t => {
  await t.test('failed stop', async () => {
    const f = fixture({ stop: async () => { throw Error('PRIVATE stop failure ' + A.token); } }); f.setBatch([A]); f.reconciler.start(); await pause();
    await assert.rejects(f.reconciler.close(), /^Error: handoff_reconciler_retained$/); assert.equal(f.reconciler.status().retained, true);
  });
  await t.test('malformed handle', async () => {
    const f = fixture({ attach: async () => ({ token: A.token }) }); f.setBatch([A]); f.reconciler.start(); await pause(); await f.poll();
    assert.equal(f.calls.attach.length, 1); assert.equal(f.reconciler.status().needsAttention, 1);
    await assert.rejects(f.reconciler.close(), /^Error: handoff_reconciler_retained$/);
  });
});

test('list drain is retained on close; immediately closed start never begins filesystem I/O', async () => {
  const reading = deferred(), f = fixture({ list: () => reading.promise }); f.reconciler.start(); await pause();
  let finished = false; const closing = f.reconciler.close().then(() => { finished = true; }); await pause(); assert.equal(finished, false);
  reading.resolve([A]); await closing; assert.equal(f.calls.resolve.length, 0);
  const idle = fixture(); idle.reconciler.start(); await idle.reconciler.close(); assert.equal(idle.calls.list, 0);
});

test('configuration rejects accessor ports without executing them and enforces bounded work', () => {
  const f = fixture(); let getters = 0;
  const handoff = {}; Object.defineProperty(handoff, 'list', { get() { getters++; return () => []; } });
  assert.throws(() => createHandoffReconciler({ ...f.config, handoff }), /handoff_reconciler_invalid_config/); assert.equal(getters, 0);
  for (const config of [{ maxRecords: 65 }, { maxConcurrentAttachments: 3 }, { pollIntervalMs: 60001 }, { maxRecords: 0 }]) {
    assert.throws(() => createHandoffReconciler({ ...f.config, ...config }), /handoff_reconciler_invalid_config/);
  }
});

test('a missing actual-work promise or synchronous attach throw retains shutdown and never replays the broken port', async t => {
  for (const broken of ['list', 'resolve', 'attach', 'attach-throw']) await t.test(broken, async () => {
    const f = fixture(); f.setBatch([A]); let calls = 0;
    const options = { ...f.config };
    const malformed = () => { calls++; if (broken === 'attach-throw') throw Error('private synchronous effect unknown'); return undefined; };
    if (broken === 'list') options.handoff = { list: malformed };
    else if (broken === 'resolve') options.backend = { resolveConnection: malformed };
    else options.orchestrator = { ...f.config.orchestrator, attach: malformed };
    const reconciler = createHandoffReconciler(options); reconciler.start(); await pause();
    if (f.timer.jobs.size) { f.timer.fire(); await pause(); }
    assert.equal(calls, 1); assert.equal(reconciler.status().retained, true);
    await assert.rejects(reconciler.close(), /^Error: handoff_reconciler_retained$/);
  });
});

test('two malformed work ports retain both concurrency slots and do not admit user C', async t => {
  for (const broken of ['resolve', 'attach', 'malformed-resolved-handle']) await t.test(broken, async () => {
    const f = fixture(); f.setBatch([A, B, C]); let calls = 0;
    const options = { ...f.config }, malformed = () => { calls++; return broken === 'malformed-resolved-handle' ? Promise.resolve({ private: A.token }) : undefined; };
    if (broken === 'resolve') options.backend = { resolveConnection: malformed };
    else options.orchestrator = { ...f.config.orchestrator, attach: malformed };
    const reconciler = createHandoffReconciler(options); reconciler.start(); await pause();
    assert.equal(calls, 2); assert.equal(reconciler.status().inFlight, 2); assert.equal(reconciler.status().pending, 1);
    f.timer.fire(); await pause(); assert.equal(calls, 2);
    await assert.rejects(reconciler.close(), /handoff_reconciler_retained/);
  });
});

test('actual orchestrator honors persisted expected owner before home/runtime, and closes with reconciler', async t => {
  for (const changed of [false, true]) await t.test(changed ? 'owner changes between resolver calls' : 'same owner', async () => {
    const timer = fakeTimers(), handles = new Set(), events = []; let reads = 0;
    const backend = {
      async resolveConnection() { reads++; return current(changed && reads > 1 ? B : A); },
      async close() { events.push('backend-close'); },
    };
    const supervisor = {
      renewalMode: 'coordinated', beginMaintain() { assert.fail('maintenance should not begin before explicit orchestrator.start'); },
      beginStart() { events.push('runtime-start'); const handle = Object.freeze({}); handles.add(handle); return { handle, ready: Promise.resolve(handle) }; },
      status(handle) { assert(handles.has(handle)); return { state: 'active', expiresAt: NOW + 600000 }; },
      async stop(handle) { events.push('runtime-stop'); handles.delete(handle); }, async close() { events.push('supervisor-close'); },
    };
    const runner = { beginRun() { assert.fail('must not pump'); }, beginPrune() { assert.fail('must not prune'); }, async close() { events.push('runner-close'); } };
    const gateway = { async register() { events.push('register'); return Object.freeze({}); }, async releaseRegistration() { events.push('release'); } };
    const orchestrator = createRuntimeOrchestrator({ backend, supervisor, runner, gateway, timers: timer, clock: () => NOW,
      profileHomes: { async ensure() { events.push('home'); return '/trusted/home'; } }, closeIngress() {}, closePool() { events.push('pool-close'); } });
    const reconciler = createHandoffReconciler({ handoff: { async list() { return [A]; } }, backend, orchestrator, timers: timer, clock: () => NOW });
    reconciler.start(); await pause();
    if (changed) {
      assert.equal(reconciler.status().needsAttention, 1); assert.equal(reads, 2);
      assert(!events.includes('home')); assert(!events.includes('register')); assert(!events.includes('runtime-start'));
    } else { assert.equal(reconciler.status().active, 1); assert(events.includes('runtime-start')); }
    await Promise.all([reconciler.close(), orchestrator.close()]);
    assert.equal(handles.size, 0); assert(events.indexOf('supervisor-close') < events.indexOf('backend-close'));
    assert(events.indexOf('backend-close') < events.indexOf('pool-close'));
  });
});

// DB clock skew: a DB-issued expiry may lead this host's clock by up to 5 s (literals on purpose).
for (const [delta, accepted] of [[50, true], [4000, true], [6000, false]]) {
  test(`fresh authority with DB clock ${delta} ms ahead is ${accepted ? 'accepted and attaches' : 'unreadable: stays pending, never attaches, retried later'}`, async () => {
    let expiresAt = NOW + 900000 + delta;
    const f = fixture({ resolve: async () => ({ ...current(A), expiresAt }) }); f.setBatch([A]);
    f.reconciler.start(); await pause();
    if (accepted) {
      assert.equal(f.calls.attach.length, 1); assert.deepEqual(f.calls.attach[0].expectedOwner, owner(A));
      assert.equal(f.reconciler.status().active, 1); assert.equal(f.calls.resolve.length, 1);
    } else {
      assert.equal(f.calls.resolve.length, 1); assert.equal(f.calls.attach.length, 0);
      assert.equal(f.reconciler.status().pending, 1); assert.equal(f.reconciler.status().needsAttention, 0);
      expiresAt = NOW + 600000; await f.poll(); // a valid read later proceeds normally
      assert.equal(f.calls.resolve.length, 2); assert.equal(f.calls.attach.length, 1); assert.equal(f.reconciler.status().active, 1);
    }
    await f.reconciler.close();
  });
}
