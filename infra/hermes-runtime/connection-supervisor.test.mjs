import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProfileLeaseStore } from './profile-lease.mjs';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
import { createDependencyScope } from '../hermes-broker/dependency-scope.mjs';
const id = n => `${n.repeat(8)}-${n.repeat(4)}-4${n.repeat(3)}-8${n.repeat(3)}-${n.repeat(12)}`;
const token = `hc_${'a'.repeat(43)}`, tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t, hooks = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hermes-supervisor-'))), home = path.join(root, 'home'); await mkdir(home);
  const store = new ProfileLeaseStore({ homeRoot: root, directory: path.join(root, 'supervisor') });
  let now = 1800000000000, next = 0, resolutions = 0; const tasks = new Map(), calls = [];
  const identity = { connectionId: id('1'), assistantId: id('2'), userId: id('3'), organizationId: id('4'), expiresAt: now + 600000 };
  const supervisor = createConnectionSupervisor({ profileStore: store, clock: () => now,
    timers: { setTimeout(fn, delay) { const key = ++next; tasks.set(key, { fn, at: now + delay }); return key; }, clearTimeout(key) { tasks.delete(key); } },
    ...hooks.config,
    backend: { resolveConnection: async (...args) => { resolutions++; return hooks.resolve ? hooks.resolve(...args) : structuredClone(identity); },
      async renewConnection(value, options) { calls.push(['renew', value]); if (hooks.renew) return hooks.renew(options);
      return { ok: true, status: 'renewed', connectionId: identity.connectionId, expiresAt: now + 900000, reconciled: false }; },
      ...(hooks.maintain ? { beginConnectionMaintenance(value, options) { calls.push(['maintain', value, options]); return hooks.maintain(value, options); } } : {}) },
    runtime: { prepare(input) { return Object.freeze({ input }); },
      async start(instance) { const input = instance.input; calls.push(['start', input]); return hooks.start ? hooks.start(input) : {}; },
      setAdmission(instance, enabled) { calls.push(['gate', enabled]); hooks.gate?.(instance, enabled); },
      async stop(instance) { calls.push(['stop']); await hooks.stop?.(instance); },
      ...(hooks.execute ? { async executePrivateCommand(instance, input, options) {
        calls.push(['execute', instance, input, options]); return hooks.execute(instance, input, options);
      } } : {}),
      ...(hooks.beginExecute ? { beginExecutePrivateCommand(instance, input, options) {
        calls.push(['begin-execute', instance, input, options]); return hooks.beginExecute(instance, input, options);
      } } : {}) },
  });
  t.after(async () => { try { await supervisor.close(); } catch (error) { if (!hooks.expectCloseFailure) throw error; }
    finally { await rm(root, { recursive: true, force: true }); } });
  return { supervisor, store, root, home, identity, calls, tasks, get resolutions() { return resolutions; }, start: () => supervisor.start({ token, home }),
    async advance(ms) { now += ms; for (const [key, task] of [...tasks]) if (task.at <= now) { tasks.delete(key); task.fn(); } await tick(); } };
}
test('acquires real owner lock, grants branded handle and renews same opaque before expiry', async t => {
  const f = await fixture(t), handle = await f.start();
  assert.deepEqual(f.calls.map(call => call[0]), ['start', 'gate']); assert.equal(f.calls[0][1].admission, false);
  assert.throws(() => f.supervisor.status({}), /invalid_handle/);
  await assert.rejects(f.store.acquire({ ...f.calls[0][1].binding }), /profile_in_use/);
  await f.advance(480000); assert.equal(f.calls.filter(call => call[0] === 'renew').length, 1);
  assert.equal(f.calls.find(call => call[0] === 'renew')[1], token);
  assert.equal(f.supervisor.status(handle).state, 'active'); assert.equal(f.tasks.size, 2);
  await f.supervisor.stop(handle); assert.equal(f.tasks.size, 0); assert.equal(f.supervisor.status(handle).state, 'stopped');
});

test('beginStart brands a frozen handle before I/O, snapshots input and preserves start compatibility', async t => {
  let f; f = await fixture(t, { resolve: supplied => { assert.equal(supplied, token); return structuredClone(f.identity); } });
  const input = { token, home: f.home }, started = f.supervisor.beginStart(input);
  assert(Object.isFrozen(started)); assert(Object.isFrozen(started.handle)); assert(started.ready instanceof Promise);
  assert.deepEqual(Object.keys(started), ['handle', 'ready']); assert.equal(f.resolutions, 0); assert.deepEqual(f.calls, []);
  assert.deepEqual(f.supervisor.status(started.handle), { state: 'starting', expiresAt: null });
  input.token = `hc_${'b'.repeat(43)}`; input.home = path.join(f.root, 'foreign');
  assert.equal(await started.ready, started.handle); assert.equal(f.calls[0][1].binding.home, f.home);
  await f.supervisor.stop(started.handle);
  const legacy = await f.start(); assert.equal(f.supervisor.status(legacy).state, 'active'); await f.supervisor.stop(legacy);
});

test('beginStart rejects extra fields/getters synchronously without allocating authority or capacity', async t => {
  const f = await fixture(t, { config: { maxProfiles: 1 } }); let reads = 0;
  for (const request of [{ token, home: f.home, userId: id('9') }, { token },
    { get token() { reads++; return token; }, home: f.home }, { token, get home() { reads++; return f.home; } }]) {
    assert.throws(() => f.supervisor.beginStart(request), /invalid_start/);
  }
  assert.equal(reads, 0); assert.equal(f.resolutions, 0);
  await assert.rejects(f.supervisor.start({ token, home: f.home, extra: true }), /invalid_start/);
  const started = f.supervisor.beginStart({ token, home: f.home }); await started.ready; await f.supervisor.stop(started.handle);
});

test('stop before the beginStart microtask aborts startup without any authority or runtime I/O', async t => {
  const f = await fixture(t), started = f.supervisor.beginStart({ token, home: f.home });
  const failed = assert.rejects(started.ready, /supervisor_start_failed/), stopped = f.supervisor.stop(started.handle);
  assert.equal(f.supervisor.stop(started.handle), stopped); assert.equal(f.supervisor.status(started.handle).state, 'stopped');
  await stopped; await failed; assert.equal(f.resolutions, 0); assert.deepEqual(f.calls, []);
});

test('stopping an ignored initial lookup retains startup capacity until its real promise settles', async t => {
  const entered = deferred(), lookup = deferred(); let observed;
  const f = await fixture(t, { config: { maxProfiles: 1 }, resolve: (_token, options) => { observed = options.signal; entered.resolve(); return lookup.promise; } });
  const started = f.supervisor.beginStart({ token, home: f.home }), failed = assert.rejects(started.ready, /supervisor_start_failed/);
  await entered.promise; let done = false; const stopped = f.supervisor.stop(started.handle).then(() => { done = true; });
  assert.equal(observed.aborted, true); await tick(); assert.equal(done, false);
  assert.throws(() => f.supervisor.beginStart({ token, home: f.home }), /supervisor_busy/);
  lookup.resolve(f.identity); await failed; await stopped; assert.deepEqual(f.calls, []);
});

test('stop reaches a prepared runtime immediately but retains its real lease until ignored startup and stop both drain', async t => {
  const entered = deferred(), startup = deferred(), cleanup = deferred();
  const f = await fixture(t, { start: () => { entered.resolve(); return startup.promise; }, stop: () => cleanup.promise });
  const acquire = f.store.acquire.bind(f.store); let releaseAttempts = 0;
  f.store.acquire = async input => { const lease = await acquire(input); return { ...lease,
    release: () => { releaseAttempts++; return lease.release(); } }; };
  const started = f.supervisor.beginStart({ token, home: f.home }), failed = assert.rejects(started.ready, /supervisor_start_failed/);
  await entered.promise; let done = false; const stopped = f.supervisor.stop(started.handle).then(() => { done = true; });
  const binding = f.calls.find(call => call[0] === 'start')[1].binding;
  try {
    assert.equal(f.calls.find(call => call[0] === 'start')[1].signal.aborted, true);
    assert(f.calls.some(call => call[0] === 'gate' && call[1] === false)); await tick();
    assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
    assert(!f.calls.some(call => call[0] === 'gate' && call[1]));
    cleanup.resolve(); await tick(); assert.equal(done, false); assert.equal(releaseAttempts, 0);
    await assert.rejects(f.store.acquire(binding), /profile_in_use/);
  } finally { cleanup.resolve(); startup.resolve(); await failed; await stopped; }
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
  const lease = await f.store.acquire(binding); await lease.release();
});

test('cancelling startup A never stops active B and failed A cleanup retains only A capacity and lease', async t => {
  const entered = deferred(), startup = deferred(), stoppedOwners = [], tokenB = `hc_${'b'.repeat(43)}`;
  let f; f = await fixture(t, { config: { maxProfiles: 2 }, expectCloseFailure: true,
    resolve: supplied => ({ ...f.identity, ...(supplied === tokenB ? { connectionId: id('7'), assistantId: id('8'), userId: id('9') } : {}) }),
    start: input => { if (input.binding.userId === id('3')) { entered.resolve(); return startup.promise; } return {}; },
    stop: instance => { stoppedOwners.push(instance.input.binding.userId); if (instance.input.binding.userId === id('3')) throw Error('A-stop-failed'); } });
  const homeB = path.join(f.root, 'home-b'); await mkdir(homeB);
  const b = f.supervisor.beginStart({ token: tokenB, home: homeB }); await b.ready;
  const a = f.supervisor.beginStart({ token, home: f.home }), failed = assert.rejects(a.ready, /A-stop-failed/);
  await entered.promise;
  const stopped = assert.rejects(f.supervisor.stop(a.handle), /A-stop-failed/);
  try {
    await tick(); assert.deepEqual(stoppedOwners, [id('3')]); assert.equal(f.supervisor.status(b.handle).state, 'active');
    assert.throws(() => f.supervisor.beginStart({ token, home: f.home }), /supervisor_busy/);
  } finally { startup.resolve(); await failed; await stopped; }
  assert.equal(f.supervisor.status(b.handle).state, 'active');
  const binding = f.calls.find(call => call[0] === 'start' && call[1].binding.userId === id('3'))[1].binding;
  await assert.rejects(f.store.acquire(binding), /profile_in_use/);
  assert.throws(() => f.supervisor.beginStart({ token, home: f.home }), /supervisor_busy/);
  await f.supervisor.stop(b.handle); assert.deepEqual(stoppedOwners, [id('3'), id('9')]);
});
test('unknown renewal stops admission and runtime without retries', async t => {
  const f = await fixture(t, { renew: () => { throw Error('unknown'); } }), handle = await f.start();
  await f.advance(480000); await tick();
  assert.equal(f.supervisor.status(handle).state, 'reconnect_required');
  assert(f.calls.some(call => call[0] === 'gate' && call[1] === false)); assert(f.calls.some(call => call[0] === 'stop'));
  await f.advance(900000); assert.equal(f.calls.filter(call => call[0] === 'renew').length, 1);
});
test('expiry watchdog stops runtime during ignored-abort renewal and late ACK cannot reopen admission', async t => {
  const d = deferred(); let signal;
  const f = await fixture(t, { renew: options => { signal = options.signal; return d.promise; } }), handle = await f.start();
  await f.advance(480000); await f.advance(120000); assert.equal(signal.aborted, true);
  assert.equal(f.supervisor.status(handle).state, 'expired');
  d.resolve({ ok: true, status: 'renewed', connectionId: id('1'), expiresAt: f.identity.expiresAt + 900000, reconciled: false }); await tick();
  assert.equal(f.calls.filter(call => call[0] === 'gate' && call[1]).length, 1); assert.equal(f.tasks.size, 0);
});
test('duplicate connection cannot start a second runtime or steal existing lease', async t => {
  const f = await fixture(t), handle = await f.start(); await assert.rejects(f.start(), /supervisor_start_failed/);
  assert.equal(f.calls.filter(call => call[0] === 'start').length, 1); assert.equal(f.supervisor.status(handle).state, 'active');
});
test('close waits for runtime start, never opens admission, and releases acquired owner lock', async t => {
  const d = deferred(), entered = deferred();
  const f = await fixture(t, { start: () => { entered.resolve(); return d.promise; } });
  const starting = f.start(); const rejected = assert.rejects(starting, /supervisor_start_failed/); await entered.promise;
  const closing = f.supervisor.close(); assert.equal(f.supervisor.close(), closing); let done = false; void closing.then(() => { done = true; }, () => {});
  await tick(); assert.equal(done, false); d.resolve({}); await rejected;
  await closing;
  assert(!f.calls.some(call => call[0] === 'gate' && call[1]));
  assert(f.calls.some(call => call[0] === 'stop'));
  await assert.rejects(f.start(), /supervisor_closed/);
});
test('renewal for another connection fails closed without reopening or retry', async t => {
  const f = await fixture(t, { renew: () => ({ ok: true, status: 'renewed', connectionId: id('9'), expiresAt: 1800001400000, reconciled: false }) });
  const handle = await f.start(); await f.advance(480000); await tick();
  assert.equal(f.supervisor.status(handle).state, 'reconnect_required'); assert.equal(f.tasks.size, 0);
});
test('a profile home remains bound to its original user and organization after stop', async t => {
  const f = await fixture(t), handle = await f.start(); await f.supervisor.stop(handle);
  f.identity.organizationId = id('8'); f.identity.userId = id('7'); f.identity.connectionId = id('6');
  await assert.rejects(f.start(), /supervisor_start_failed/); assert.equal(f.calls.filter(call => call[0] === 'start').length, 1);
});
test('failed runtime stop retains owner lock and close reports failure', async t => {
  const f = await fixture(t, { stop: () => { throw Error('synthetic-stop-failure'); }, expectCloseFailure: true }), handle = await f.start();
  await assert.rejects(f.supervisor.stop(handle), /synthetic-stop-failure/);
  await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
  await assert.rejects(f.supervisor.close(), /supervisor_close_failed/);
});
test('close drains outstanding renewal and never permits late success to reschedule', async t => {
  const d = deferred(), f = await fixture(t, { renew: () => d.promise }); await f.start(); await f.advance(480000);
  let closed = false; const closing = f.supervisor.close(); void closing.then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  d.resolve({ ok: true, status: 'renewed', connectionId: id('1'), expiresAt: 1800001400000, reconciled: false }); await closing;
  assert.equal(f.tasks.size, 0); assert.equal(f.calls.filter(call => call[0] === 'gate' && call[1]).length, 1);
});
test('late owner change before opening runtime admission is rejected', async t => {
  let f; f = await fixture(t, { start: () => { f.identity.organizationId = id('9'); return {}; } });
  await assert.rejects(f.start(), /supervisor_start_failed/);
  assert(!f.calls.some(call => call[0] === 'gate' && call[1])); assert(f.calls.some(call => call[0] === 'stop'));
});
test('gate failure still attempts runtime stop and retains owner lock', async t => {
  const f = await fixture(t, { gate: (_instance, enabled) => { if (!enabled) throw Error('gate-broken'); }, expectCloseFailure: true });
  const handle = await f.start();
  await assert.rejects(f.supervisor.stop(handle), /runtime_gate_failed/);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
  await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
});
test('mutable initial resolver object cannot change the owner comparison after lease acquisition', async t => {
  const identity = { connectionId: id('1'), assistantId: id('2'), userId: id('3'), organizationId: id('4'), expiresAt: 1800000600000 };
  const f = await fixture(t, { resolve: () => identity, start: () => { identity.organizationId = id('9'); return {}; } });
  await assert.rejects(f.start(), /supervisor_start_failed/);
  assert(!f.calls.some(call => call[0] === 'gate' && call[1]));
  assert.equal(f.calls[0][1].binding.organizationId, id('4'));
  assert(f.calls.some(call => call[0] === 'stop'));
});

test('partial runtime startup failure still stops the allocated instance before releasing ownership', async t => {
  const cleanup = deferred(), entered = deferred();
  const f = await fixture(t, { start: () => { entered.resolve(); throw Error('partial-start'); }, stop: () => cleanup.promise });
  let settled = false;
  const starting = f.start(); const rejected = assert.rejects(starting, /supervisor_start_failed/);
  void starting.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise;
  await tick();
  try {
    assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
    assert.equal(settled, false);
    await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
    assert(!f.calls.some(call => call[0] === 'gate' && call[1]));
  } finally { cleanup.resolve(); await rejected; }
  const lease = await f.store.acquire(f.calls[0][1].binding); await lease.release();
});

test('failed teardown after partial startup preserves the lock and reports close failure', async t => {
  const f = await fixture(t, { start: () => { throw Error('partial-start'); },
    stop: () => { throw Error('partial-stop-failed'); }, expectCloseFailure: true });
  await assert.rejects(f.start(), /partial-stop-failed/);
  assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
  await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
  await assert.rejects(f.supervisor.close(), /supervisor_close_failed/);
});

const commandFixture = (t, hooks = {}) => fixture(t, { execute: () => ({ text: 'Phòng A đang trống.' }), ...hooks });
const claim = (f, overrides = {}) => ({ ...f.identity, commandId: id('5'), bindingId: id('6'), bindingEpoch: 1,
  text: 'Danh sách phòng trống', expiresAt: 1800000050000, ...overrides });
const executions = f => f.calls.filter(call => call[0] === 'execute');

const maintenanceAck = (f, expiresAt = f.identity.expiresAt) => ({ ok: true, status: 'renewed', connectionId: f.identity.connectionId, expiresAt, reconciled: false });
async function maintenanceFixture(t, hooks = {}) {
  const scope = hooks.scope ?? createDependencyScope(); let f;
  f = await commandFixture(t, { ...hooks, config: { renewalMode: 'coordinated', dependencyScope: scope, ...hooks.config },
    maintain: hooks.maintain ?? (() => {
      f.identity.expiresAt += 300000;
      return Object.freeze({ result: Promise.resolve(maintenanceAck(f)), drained: Promise.resolve() });
    }) });
  return Object.assign(f, { scope });
}

test('coordinated mode is explicit and readonly, keeps only expiry watchdog, and legacy automatic renewal remains default', async t => {
  const legacy = await fixture(t), old = await legacy.start(); assert.equal(legacy.supervisor.renewalMode, 'automatic');
  assert.throws(() => legacy.supervisor.beginMaintain(old, { signal: new AbortController().signal }), /maintenance_unavailable/);
  const f = await maintenanceFixture(t), handle = await f.start(); assert.equal(f.supervisor.renewalMode, 'coordinated');
  assert.throws(() => { f.supervisor.renewalMode = 'automatic'; }, TypeError); assert.equal(f.tasks.size, 1);
  await f.advance(480000); assert.equal(f.calls.filter(call => call[0] === 'renew').length, 0); assert.equal(f.supervisor.status(handle).state, 'active');
});

test('coordinated mode rejects missing shared scope or maintenance port before startup', async t => {
  const f = await fixture(t), base = { profileStore: f.store,
    backend: { resolveConnection() {}, renewConnection() {} }, runtime: { prepare() {}, start() {}, setAdmission() {}, stop() {} } };
  for (const config of [{ renewalMode: 'coordinated' }, { renewalMode: 'coordinated', dependencyScope: { track() {} } }, { renewalMode: 'foreign' }]) {
    assert.throws(() => createConnectionSupervisor({ ...base, ...config }), /invalid_supervisor_config/);
  }
  assert.throws(() => createConnectionSupervisor({ ...base, renewalMode: 'coordinated', dependencyScope: createDependencyScope() }), /invalid_supervisor_config/);
});

test('maintenance closes admission synchronously and reopens only after backend and fresh authority scope actually drain', async t => {
  const provider = deferred(), providerEntered = deferred(), query = deferred(), queryEntered = deferred(), scope = createDependencyScope(); let f, lookups = 0;
  f = await maintenanceFixture(t, { scope,
    maintain: () => { providerEntered.resolve(); f.identity.expiresAt += 300000; return { result: Promise.resolve(maintenanceAck(f)), drained: provider.promise }; },
    resolve: () => {
      if (++lookups === 3) { scope.track(() => { queryEntered.resolve(); return query.promise; }); }
      return structuredClone(f.identity);
    } });
  const handle = await f.start(), originalExpiry = f.identity.expiresAt;
  const operation = f.supervisor.beginMaintain(handle, { signal: new AbortController().signal });
  assert(Object.isFrozen(operation)); assert.deepEqual(Object.keys(operation), ['result', 'drained']);
  assert.deepEqual(f.supervisor.status(handle), { state: 'maintaining', expiresAt: originalExpiry });
  assert.equal(f.calls.at(-1)[0], 'gate'); assert.equal(f.calls.at(-1)[1], false);
  await providerEntered.promise; await tick(); assert.equal(lookups, 2); assert.equal(f.tasks.size, 2);
  provider.resolve(); await queryEntered.promise; await tick(); let completed = false;
  void operation.result.then(() => { completed = true; }); assert.equal(completed, false); assert.equal(f.supervisor.status(handle).state, 'maintaining');
  assert.equal(f.calls.filter(call => call[0] === 'gate' && call[1]).length, 1);
  query.resolve(); assert.deepEqual(await operation.result, maintenanceAck(f)); await operation.drained;
  assert.equal(f.supervisor.status(handle).state, 'active'); assert.equal(f.supervisor.status(handle).expiresAt, originalExpiry + 300000);
  assert.equal(f.tasks.size, 1); assert.equal(f.calls.filter(call => call[0] === 'renew').length, 0);
});

test('backend rejection stops runtime promptly but lease and close wait for ignored provider drain', async t => {
  const provider = deferred(), entered = deferred(); let f;
  f = await maintenanceFixture(t, { maintain: () => { entered.resolve(); return { result: Promise.reject(Error('PRIVATE PROVIDER')), drained: provider.promise }; } });
  const handle = await f.start(), operation = f.supervisor.beginMaintain(handle, { signal: new AbortController().signal });
  const failed = assert.rejects(operation.result, /^Error: maintenance_failed$/); await entered.promise; await failed; await tick();
  assert.equal(f.supervisor.status(handle).state, 'reconnect_required'); assert(f.calls.some(call => call[0] === 'stop'));
  let stopped = false; const close = f.supervisor.close().then(() => { stopped = true; }); await tick(); assert.equal(stopped, false);
  await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
  provider.resolve(); await operation.drained; await close; assert.equal(stopped, true);
  assert.equal(f.calls.filter(call => call[0] === 'maintain').length, 1);
});

test('caller cancellation and the 60-second deadline reject promptly without reopening after late provider success', async t => {
  for (const kind of ['cancel', 'deadline']) {
    const provider = deferred(), entered = deferred(); let f;
    f = await maintenanceFixture(t, { maintain: () => { entered.resolve(); f.identity.expiresAt += 300000; return { result: Promise.resolve(maintenanceAck(f)), drained: provider.promise }; } });
    const handle = await f.start(), controller = new AbortController(), operation = f.supervisor.beginMaintain(handle, { signal: controller.signal });
    const rejected = assert.rejects(operation.result, kind === 'cancel' ? /maintenance_cancelled/ : /maintenance_timeout/); await entered.promise;
    if (kind === 'cancel') controller.abort(); else await f.advance(60000);
    await rejected; let drained = false; void operation.drained.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
    await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
    provider.resolve(); await operation.drained; await f.supervisor.stop(handle);
    assert.equal(f.calls.filter(call => call[0] === 'gate' && call[1]).length, 1); assert.equal(f.tasks.size, 0);
  }
});

test('old expiry watchdog remains live during maintenance and late renewed expiry cannot revive it', async t => {
  const provider = deferred(); let f;
  f = await maintenanceFixture(t, { maintain: () => { f.identity.expiresAt += 300000; return { result: Promise.resolve(maintenanceAck(f)), drained: provider.promise }; } });
  const handle = await f.start(); await f.advance(590000);
  const operation = f.supervisor.beginMaintain(handle, { signal: new AbortController().signal });
  const rejected = assert.rejects(operation.result, /maintenance_expired/); await tick();
  try { await f.advance(10000); assert.equal(f.supervisor.status(handle).state, 'expired'); await rejected; }
  finally { provider.resolve(); await operation.drained; await f.supervisor.stop(handle); }
  assert.equal(f.calls.filter(call => call[0] === 'gate' && call[1]).length, 1);
});

test('command and duplicate maintenance admission are blocked while maintaining, and in-flight commands prevent maintenance', async t => {
  const runtime = deferred(), provider = deferred(); let f;
  f = await maintenanceFixture(t, { execute: () => runtime.promise, maintain: () => { f.identity.expiresAt += 300000; return { result: Promise.resolve(maintenanceAck(f)), drained: provider.promise }; } });
  const handle = await f.start(), command = f.supervisor.executePrivateCommand(handle, claim(f));
  assert.throws(() => f.supervisor.beginMaintain(handle, { signal: new AbortController().signal }), /maintenance_busy/);
  runtime.resolve({ text: 'completed' }); await command;
  const operation = f.supervisor.beginMaintain(handle, { signal: new AbortController().signal });
  assert.throws(() => f.supervisor.beginMaintain(handle, { signal: new AbortController().signal }), /maintenance_stopped/);
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('7') })), /private_command_stopped/);
  provider.resolve(); await operation.result; await operation.drained; assert.equal(executions(f).length, 1);
});

test('maintenance validates exact options without getters or caller-selected actor and never consumes a pre-cancelled attempt', async t => {
  const f = await maintenanceFixture(t), handle = await f.start(); let getters = 0;
  const getter = {}; Object.defineProperty(getter, 'signal', { get() { getters++; return new AbortController().signal; } });
  for (const options of [getter, { signal: null }, { signal: new AbortController().signal, token }, Object.create({ signal: new AbortController().signal })]) {
    assert.throws(() => f.supervisor.beginMaintain(handle, options), /invalid_maintenance/);
  }
  const controller = new AbortController(); controller.abort();
  assert.throws(() => f.supervisor.beginMaintain(handle, { signal: controller.signal }), /maintenance_cancelled/);
  assert.throws(() => f.supervisor.beginMaintain({}, { signal: new AbortController().signal }), /invalid_handle/);
  assert.equal(getters, 0); assert.equal(f.supervisor.status(handle).state, 'active'); assert(!f.calls.some(call => call[0] === 'maintain'));
});

for (const kind of ['throws', 'extra', 'getter', 'invalid-drain', 'rejected-drain']) {
  test(`maintenance ${kind} lifecycle retains lease/capacity and fails close without leaking or retrying`, async t => {
    let lateReject, getterReads = 0;
    const late = new Promise((_resolve, reject) => { lateReject = reject; }); let f;
    f = await maintenanceFixture(t, { expectCloseFailure: true, config: { maxProfiles: 1 }, maintain: () => {
      if (kind === 'throws') throw Error('PRIVATE BEGIN');
      const value = { result: late, drained: kind === 'rejected-drain' ? Promise.reject(Error('PRIVATE DRAIN')) : kind === 'invalid-drain' ? false : Promise.resolve() };
      if (kind === 'extra') value.extra = true;
      if (kind === 'getter') Object.defineProperty(value, 'drained', { get() { getterReads++; throw Error('PRIVATE GETTER'); } });
      return value;
    } });
    const handle = await f.start(), operation = f.supervisor.beginMaintain(handle, { signal: new AbortController().signal });
    const resultRejected = assert.rejects(operation.result, /maintenance_(outcome_unknown|failed)/);
    // Throws returns no promise to observe; every other malformed shape exposes
    // its real own result promise, which must be caught and held until settle.
    if (kind === 'throws') void late.catch(() => {});
    await tick(); lateReject(Error('PRIVATE LATE')); await resultRejected;
    await assert.rejects(operation.drained, /^Error: maintenance_outcome_unknown$/);
    await assert.rejects(f.supervisor.stop(handle), /maintenance_outcome_unknown/);
    await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
    assert.throws(() => f.supervisor.beginStart({ token, home: f.home }), /supervisor_busy/);
    await assert.rejects(f.supervisor.close(), /supervisor_close_failed/); assert.equal(getterReads, 0);
    assert.equal(f.calls.filter(call => call[0] === 'maintain').length, 1);
  });
}

test('mutable ACK is snapshotted before provider drain, and fresh authority must match its expiry and owner', async t => {
  for (const kind of ['mutation', 'owner', 'expiry']) {
    const provider = deferred(); let f, ack, reads = 0;
    f = await maintenanceFixture(t, { maintain: () => { f.identity.expiresAt += 300000; ack = maintenanceAck(f); return { result: Promise.resolve(ack), drained: provider.promise }; },
      resolve: () => { const current = structuredClone(f.identity); if (++reads === 3) {
        if (kind === 'owner') current.userId = id('8'); if (kind === 'expiry') current.expiresAt--;
      } return current; } });
    const handle = await f.start(), operation = f.supervisor.beginMaintain(handle, { signal: new AbortController().signal }); await tick();
    if (kind === 'mutation') { ack.connectionId = id('9'); ack.expiresAt--; }
    provider.resolve();
    if (kind === 'mutation') { assert.equal((await operation.result).connectionId, f.identity.connectionId); await operation.drained; }
    else { await assert.rejects(operation.result, /maintenance_failed/); await operation.drained; await f.supervisor.stop(handle); }
  }
});

test('stop drains a held fresh authority lookup, while maintaining A never interrupts independent B', async t => {
  const lookup = deferred(), entered = deferred(), tokenB = `hc_${'b'.repeat(43)}`; let f, readsA = 0;
  const identityB = { connectionId: id('7'), assistantId: id('8'), userId: id('9'), organizationId: id('4'), expiresAt: 1800000600000 };
  f = await maintenanceFixture(t, { resolve: supplied => {
    if (supplied === tokenB) return identityB;
    if (++readsA === 3) { entered.resolve(); return lookup.promise; }
    return structuredClone(f.identity);
  } });
  const homeB = path.join(f.root, 'B'); await mkdir(homeB);
  const a = await f.start(), b = await f.supervisor.start({ token: tokenB, home: homeB });
  const operation = f.supervisor.beginMaintain(a, { signal: new AbortController().signal });
  const rejected = assert.rejects(operation.result, /maintenance_stopped/); await entered.promise;
  let done = false; const stopped = f.supervisor.stop(a).then(() => { done = true; }); await rejected; await tick();
  assert.equal(done, false); assert.equal(f.supervisor.status(b).state, 'active');
  await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
  lookup.resolve(structuredClone(f.identity)); await operation.drained; await stopped; assert.equal(done, true);
  assert.equal(f.supervisor.status(b).state, 'active');
});

test('a stop during gate reopening cannot let maintenance restore active state after interruption', async t => {
  let f, handle, opened = 0;
  f = await maintenanceFixture(t, { gate: (_instance, enabled) => { if (enabled && ++opened === 2) void f.supervisor.stop(handle); } });
  handle = await f.start(); const operation = f.supervisor.beginMaintain(handle, { signal: new AbortController().signal });
  await assert.rejects(operation.result, /maintenance_stopped/); await operation.drained; await f.supervisor.stop(handle);
  assert.equal(f.supervisor.status(handle).state, 'stopped'); assert.equal(f.calls.filter(call => call[0] === 'gate').at(-1)[1], false);
});

test('maintenance rejects malformed or non-increasing/unbounded ACK before reopening admission', async t => {
  for (const mutate of [ack => { ack.expiresAt = 1800000600000; }, ack => { ack.expiresAt = 1800000900001; },
    ack => { ack.expiresAt = '1800000900000'; }, ack => { ack.connectionId = id('7'); },
    ack => { ack.reconciled = 'false'; }, ack => { ack.extra = true; }]) {
    let f; f = await maintenanceFixture(t, { maintain: () => {
      f.identity.expiresAt += 300000; const ack = maintenanceAck(f); mutate(ack);
      return { result: Promise.resolve(ack), drained: Promise.resolve() };
    } });
    const handle = await f.start(), operation = f.supervisor.beginMaintain(handle, { signal: new AbortController().signal });
    await assert.rejects(operation.result, /maintenance_failed/); await operation.drained; await f.supervisor.stop(handle);
    assert.equal(f.resolutions, 2, 'invalid ACK must be rejected before a fresh authority read');
    assert.equal(f.calls.filter(call => call[0] === 'gate' && call[1]).length, 1);
  }
});

test('an unavailable finite scope retains maintenance ownership and fails close without invoking backend', async t => {
  const scope = createDependencyScope(), f = await maintenanceFixture(t, { scope, expectCloseFailure: true }), handle = await f.start();
  await scope.close(); const operation = f.supervisor.beginMaintain(handle, { signal: new AbortController().signal });
  await assert.rejects(operation.result, /maintenance_outcome_unknown/); await assert.rejects(operation.drained, /maintenance_outcome_unknown/);
  assert(!f.calls.some(call => call[0] === 'maintain')); await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
  await assert.rejects(f.supervisor.close(), /supervisor_close_failed/);
});

test('shared dependency scope holds actual command work after the supervisor result timeout', async t => {
  const scope = createDependencyScope(), entered = deferred(), work = deferred();
  const f = await commandFixture(t, { config: { dependencyScope: scope }, execute: () => { entered.resolve(); return work.promise; } });
  const handle = await f.start();
  const request = scope.begin(() => f.supervisor.executePrivateCommand(handle, claim(f), { timeoutMs: 1000 }));
  const rejected = assert.rejects(request.result, /private_command_timeout/); let drained = false;
  void request.drained.then(() => { drained = true; });
  await entered.promise;
  try {
    await f.advance(1000); await rejected; await tick();
    assert.equal(drained, false); assert.equal(f.supervisor.status(handle).state, 'reconnect_required');
    await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
    assert.equal(executions(f).length, 1);
  } finally { work.resolve({ text: 'late discarded response' }); await request.drained; await scope.close(); }
  await f.supervisor.stop(handle); assert.equal(drained, true);
});

test('driver observer cancellation cannot drain the command scope or release its profile before actual driver work', async t => {
  const scope = createDependencyScope(), entered = deferred(), drain = deferred();
  const f = await commandFixture(t, { config: { dependencyScope: scope },
    execute: () => assert.fail('must use the actual drain port'),
    beginExecute: (_instance, _input, { signal }) => {
      const result = new Promise((_, reject) => signal.addEventListener('abort', () => reject(Error('private driver abort')), { once: true }));
      entered.resolve(); return Object.freeze({ result, drained: drain.promise });
    } });
  const handle = await f.start(), request = scope.begin(() => f.supervisor.executePrivateCommand(handle, claim(f), { timeoutMs: 1000 }));
  const rejected = assert.rejects(request.result, /private_command_timeout/); let drained = false;
  void request.drained.then(() => { drained = true; }); await entered.promise;
  try {
    await f.advance(1000); await rejected; await tick(); assert.equal(drained, false);
    await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
    assert.equal(executions(f).length, 0); assert.equal(f.calls.filter(call => call[0] === 'begin-execute').length, 1);
  } finally { drain.resolve(); await request.drained; await scope.close(); }
  await f.supervisor.stop(handle); assert.equal(drained, true);
});

test('driver drain failure closes admission and retains a lease when runtime stop cannot prove cleanup', async t => {
  const f = await commandFixture(t, { expectCloseFailure: true, stop: () => { throw Error('cleanup unknown'); },
    beginExecute: () => ({ result: Promise.resolve({ text: 'must be withheld' }), drained: Promise.reject(Error('private drain error')) }) });
  const handle = await f.start();
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)), { message: 'private_command_failed' });
  await assert.rejects(f.supervisor.stop(handle), /cleanup unknown/);
  assert.equal(f.supervisor.status(handle).state, 'reconnect_required');
  await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
});

test('closed dependency scope rejects command without executing or leaking an active profile', async t => {
  const scope = createDependencyScope(), f = await commandFixture(t, { config: { dependencyScope: scope } }), handle = await f.start();
  await scope.close();
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)), /private_command_failed/);
  await f.supervisor.stop(handle); assert.equal(executions(f).length, 0);
  assert.equal(f.supervisor.status(handle).state, 'reconnect_required'); assert.equal(f.tasks.size, 0);
});

test('private command uses branded owner, resolves authority twice and exposes no token or caller identity to runtime', async t => {
  const f = await commandFixture(t), handle = await f.start(), request = claim(f);
  const output = await f.supervisor.executePrivateCommand(handle, request);
  assert.deepEqual(output, { text: 'Phòng A đang trống.' }); assert.equal(Object.isFrozen(output), true);
  assert.equal(f.resolutions, 4); assert.equal(executions(f).length, 1);
  const [, instance, input, options] = executions(f)[0];
  assert.equal(instance.input.binding.userId, request.userId);
  assert.deepEqual(input, { commandId: request.commandId, bindingId: request.bindingId, bindingEpoch: 1, text: request.text });
  assert.equal(Object.isFrozen(input), true); assert.equal(Object.isFrozen(options), true);
  assert.deepEqual(Object.keys(options), ['signal']); assert(options.signal instanceof AbortSignal);
  assert.equal(JSON.stringify([instance, input, output]).includes(token), false);
  assert.equal(f.tasks.size, 2);
});

test('old runtime adapter still starts and renews but cannot execute private commands', async t => {
  const f = await fixture(t), handle = await f.start();
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)), /private_command_unavailable/);
  assert.equal(f.supervisor.status(handle).state, 'active'); assert.equal(f.resolutions, 2);
});

test('fabricated and foreign supervisor handles never resolve or execute', async t => {
  const a = await commandFixture(t), b = await commandFixture(t), handle = await a.start(); await b.start();
  for (const bad of [{}, Object.freeze({}), undefined, null, 'claimed-handle']) {
    await assert.rejects(a.supervisor.executePrivateCommand(bad, claim(a)), /invalid_handle/);
  }
  await assert.rejects(b.supervisor.executePrivateCommand(handle, claim(b)), /invalid_handle/);
  assert.equal(a.resolutions, 2); assert.equal(b.resolutions, 2);
  assert.equal(executions(a).length + executions(b).length, 0);
});

for (const key of ['connectionId', 'assistantId', 'userId', 'organizationId']) {
  test(`private claim cannot substitute another ${key} on a valid handle`, async t => {
    const f = await commandFixture(t), handle = await f.start();
    await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { [key]: id('9') })), /private_command_owner_mismatch/);
    assert.equal(f.resolutions, 2); assert.equal(executions(f).length, 0);
  });
}

test('private claim requires exact own scalar fields, UUIDs, epoch, expiry and bounded UTF-8 text', async t => {
  const f = await commandFixture(t), handle = await f.start(); let reads = 0;
  const accessor = claim(f); Object.defineProperty(accessor, 'text', { get() { reads++; return 'unsafe'; } });
  const missing = claim(f); delete missing.bindingId;
  const invalid = [null, [], Object.assign(Object.create({}), claim(f)), accessor, missing,
    claim(f, { extra: true }), claim(f, { commandId: 'claimed' }), claim(f, { bindingId: id('6').toUpperCase() }),
    claim(f, { bindingEpoch: 0 }), claim(f, { bindingEpoch: 1.5 }), claim(f, { expiresAt: '1800000050000' }),
    claim(f, { expiresAt: Infinity }), claim(f, { text: '' }), claim(f, { text: '  ' }), claim(f, { text: 'a\0b' }),
    claim(f, { text: 'ấ'.repeat(2731) }), claim(f, { commandId: { toString() { throw Error('must not coerce'); } } })];
  // Digits have no case; use an actual alphabetic UUID to prove canonical form.
  invalid[7].bindingId = id('a').toUpperCase();
  for (const request of invalid) await assert.rejects(f.supervisor.executePrivateCommand(handle, request), /invalid_private_command/);
  assert.equal(reads, 0); assert.equal(f.resolutions, 2); assert.equal(executions(f).length, 0);
  await f.supervisor.executePrivateCommand(handle, claim(f, { text: 'a'.repeat(8192) }));
  assert.equal(executions(f).length, 1);
});

test('command options reject unknown fields, accessors, invalid signal and unbounded deadlines', async t => {
  const f = await commandFixture(t), handle = await f.start(); let reads = 0;
  const accessor = {}; Object.defineProperty(accessor, 'timeoutMs', { enumerable: true, get() { reads++; return 10; } });
  for (const options of [null, [], { retry: true }, { timeoutMs: null }, { timeoutMs: 0 }, { timeoutMs: 120001 }, { timeoutMs: Infinity }, { signal: {} }, accessor]) {
    await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f), options), /invalid_private_command/);
  }
  assert.equal(reads, 0); assert.equal(f.resolutions, 2); assert.equal(executions(f).length, 0);
});

test('mutable claim and options cannot change the frozen command during authority lookup', async t => {
  const lookup = deferred(), entered = deferred(); let f;
  f = await commandFixture(t, { resolve: () => { if (f.resolutions === 3) { entered.resolve(); return lookup.promise; } return structuredClone(f.identity); } });
  const handle = await f.start(), request = claim(f), options = { timeoutMs: 1000 };
  const response = f.supervisor.executePrivateCommand(handle, request, options); await entered.promise;
  request.text = 'changed'; request.bindingId = id('9'); request.bindingEpoch = 99; request.userId = id('9'); options.timeoutMs = 1;
  lookup.resolve(structuredClone(f.identity)); await response;
  assert.deepEqual(executions(f)[0][2], { commandId: id('5'), bindingId: id('6'), bindingEpoch: 1, text: 'Danh sách phòng trống' });
});

for (const phase of ['before', 'after']) {
  for (const key of ['connectionId', 'assistantId', 'userId', 'organizationId']) {
    test(`authority change in ${key} ${phase} dispatch denies delivery and stops admission`, async t => {
      let f; f = await commandFixture(t, { resolve: () => ({ ...f.identity,
        ...(f.resolutions === (phase === 'before' ? 3 : 4) ? { [key]: id('9') } : {}) }) });
      const handle = await f.start();
      await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)), /private_command_authority_changed/);
      assert.equal(executions(f).length, phase === 'before' ? 0 : 1);
      assert.equal(f.supervisor.status(handle).state, 'reconnect_required');
      await f.supervisor.close(); assert.equal(f.tasks.size, 0);
    });
  }
}

test('revoked, expired, malformed or unavailable authority cannot execute and never leaks backend errors', async t => {
  for (const altered of [null, { expiresAt: 1800000000000 }, { expiresAt: 1800001000000 }, { extra: true }, 'throw']) {
    let f; f = await commandFixture(t, { resolve: () => {
      if (f.resolutions < 3) return structuredClone(f.identity);
      if (altered === 'throw') throw Error(`secret ${token} text`);
      return altered === null ? null : { ...f.identity, ...altered };
    } });
    const handle = await f.start();
    await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)),
      { message: altered === 'throw' ? 'private_command_authority_unavailable' : 'private_command_authority_changed' });
    assert.equal(executions(f).length, 0); assert.equal(f.supervisor.status(handle).state, 'reconnect_required');
  }
});

test('runtime response is snapshotted before the final authority lookup', async t => {
  const lookup = deferred(), entered = deferred(), output = { text: 'original response' }; let f;
  f = await commandFixture(t, { execute: () => output, resolve: () => {
    if (f.resolutions === 4) { entered.resolve(); return lookup.promise; } return structuredClone(f.identity);
  } });
  const handle = await f.start(), result = f.supervisor.executePrivateCommand(handle, claim(f)); await entered.promise;
  output.text = 'changed response'; lookup.resolve(structuredClone(f.identity));
  assert.deepEqual(await result, { text: 'original response' });
});

test('each handle admits one command, remembers completed IDs and does not cache results for duplicate text', async t => {
  const work = deferred(), entered = deferred(); const f = await commandFixture(t, { execute: () => { entered.resolve(); return work.promise; } });
  const handle = await f.start(), request = claim(f), pending = f.supervisor.executePrivateCommand(handle, request); await entered.promise;
  await assert.rejects(f.supervisor.executePrivateCommand(handle, request), /private_command_duplicate/);
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('7') })), /private_command_busy/);
  work.resolve({ text: 'done' }); await pending;
  await assert.rejects(f.supervisor.executePrivateCommand(handle, { ...request, text: 'different payload' }), /private_command_duplicate/);
  await f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('7') }));
  assert.equal(executions(f).length, 2);
});

test('remembered command capacity fails closed without eviction or runtime replay', async t => {
  const f = await commandFixture(t, { config: { maxRememberedCommands: 2 } }), handle = await f.start();
  await f.supervisor.executePrivateCommand(handle, claim(f));
  await f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('7') }));
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('8') })), /private_command_capacity/);
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)), /private_command_duplicate/);
  assert.equal(executions(f).length, 2);
});

test('timeout returns promptly but holds command slot and profile until ignored-abort runtime actually settles', async t => {
  const work = deferred(), entered = deferred(); let signal;
  const f = await commandFixture(t, { execute: (_instance, _input, options) => { signal = options.signal; entered.resolve(); return work.promise; } });
  const handle = await f.start(), result = f.supervisor.executePrivateCommand(handle, claim(f), { timeoutMs: 100 });
  const rejected = assert.rejects(result, { message: 'private_command_timeout' }); await entered.promise;
  try {
    await f.advance(100); await rejected; assert.equal(signal.aborted, true);
    assert.equal(f.calls.filter(call => call[0] === 'gate').at(-1)[1], false);
    assert.equal(f.supervisor.status(handle).state, 'reconnect_required');
    await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)), /private_command_stopped/);
    await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('7') })), /private_command_stopped/);
    await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
  } finally { work.resolve({ text: 'too late' }); await tick(); }
  assert.equal(f.resolutions, 3);
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)), /private_command_stopped/);
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('7') })), /private_command_stopped/);
});

test('caller abort during lookup never dispatches after a late authority ACK', async t => {
  const lookup = deferred(), entered = deferred(), caller = new AbortController(); let f;
  f = await commandFixture(t, { resolve: () => {
    if (f.resolutions === 3) { entered.resolve(); return lookup.promise; } return structuredClone(f.identity);
  } });
  const handle = await f.start(), result = f.supervisor.executePrivateCommand(handle, claim(f), { signal: caller.signal });
  const rejected = assert.rejects(result, /private_command_cancelled/); await entered.promise; caller.abort(); await rejected;
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('7') })), /private_command_stopped/);
  lookup.resolve(structuredClone(f.identity)); await tick(); assert.equal(executions(f).length, 0);
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)), /private_command_stopped/);
});

test('pre-cancelled, expired and stopped requests cannot consume a runtime command', async t => {
  const f = await commandFixture(t), handle = await f.start(), caller = new AbortController(); caller.abort();
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f), { signal: caller.signal }), /private_command_cancelled/);
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { expiresAt: 1800000000000 })), /private_command_expired/);
  assert.equal(executions(f).length, 0); await f.supervisor.executePrivateCommand(handle, claim(f));
  await f.supervisor.stop(handle);
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('7') })), /private_command_stopped/);
});

test('claim expiry aborts runtime even with a longer caller deadline', async t => {
  const work = deferred(), entered = deferred(); let signal;
  const f = await commandFixture(t, { execute: (_instance, _input, options) => { signal = options.signal; entered.resolve(); return work.promise; } });
  const handle = await f.start(), result = f.supervisor.executePrivateCommand(handle, claim(f, { expiresAt: 1800000000050 }), { timeoutMs: 1000 });
  const rejected = assert.rejects(result, /private_command_expired/); await entered.promise;
  try { await f.advance(50); await rejected; assert.equal(signal.aborted, true); }
  finally { work.resolve({ text: 'late' }); await tick(); }
  assert.equal(f.resolutions, 3);
});

test('an earlier live authority expiry shortens the watchdog and aborts pending execution', async t => {
  const work = deferred(), entered = deferred(); let signal, f;
  f = await commandFixture(t, {
    resolve: () => ({ ...f.identity, ...(f.resolutions >= 3 ? { expiresAt: 1800000000050 } : {}) }),
    renew: () => { throw Error('revoked'); },
    execute: (_instance, _input, options) => { signal = options.signal; entered.resolve(); return work.promise; },
  });
  const handle = await f.start(), result = f.supervisor.executePrivateCommand(handle, claim(f));
  const rejected = assert.rejects(result, /private_command_stopped/); await entered.promise;
  try { await f.advance(50); await rejected; assert.equal(signal.aborted, true); assert.equal(f.supervisor.status(handle).state, 'expired'); }
  finally { work.resolve({ text: 'late' }); await tick(); }
});

for (const method of ['stop', 'close']) {
  test(`${method} aborts command immediately and drains ignored-abort work before releasing profile without deadlock`, async t => {
    const work = deferred(), entered = deferred(); let signal;
    const f = await commandFixture(t, { execute: (_instance, _input, options) => { signal = options.signal; entered.resolve(); return work.promise; } });
    // Observe the actual release invocation, before its filesystem awaits. Merely
    // probing the lock after one tick could pass while an early release is in I/O.
    let releaseRequested = false; const acquire = f.store.acquire.bind(f.store);
    f.store.acquire = async input => {
      const lease = await acquire(input);
      return { ...lease, release: async () => { releaseRequested = true; return lease.release(); } };
    };
    const handle = await f.start(), result = f.supervisor.executePrivateCommand(handle, claim(f));
    const rejected = assert.rejects(result, /private_command_stopped/); await entered.promise;
    const stopping = method === 'stop' ? f.supervisor.stop(handle) : f.supervisor.close(); let done = false;
    void stopping.then(() => { done = true; }); await rejected; await tick();
    try {
      assert.equal(signal.aborted, true); assert.equal(done, false); assert.equal(f.calls.filter(call => call[0] === 'stop').length, 1);
      assert.equal(releaseRequested, false);
      await assert.rejects(f.store.acquire(f.calls[0][1].binding), /profile_in_use/);
    } finally { work.resolve({ text: 'late' }); await stopping; }
    assert.equal(releaseRequested, true);
    assert.equal(f.resolutions, 3); assert.equal(f.tasks.size, 0);
    const lease = await f.store.acquire(f.calls[0][1].binding); await lease.release();
  });
}

test('closing after caller timeout still drains a pending backend lookup', async t => {
  const lookup = deferred(), entered = deferred(); let f;
  f = await commandFixture(t, { resolve: () => {
    if (f.resolutions === 3) { entered.resolve(); return lookup.promise; } return structuredClone(f.identity);
  } });
  const handle = await f.start(), result = f.supervisor.executePrivateCommand(handle, claim(f), { timeoutMs: 100 });
  const rejected = assert.rejects(result, /private_command_timeout/); await entered.promise; await f.advance(100); await rejected;
  let done = false; const closing = f.supervisor.close(); void closing.then(() => { done = true; }); await tick();
  assert.equal(done, false); lookup.resolve(structuredClone(f.identity)); await closing; assert.equal(executions(f).length, 0);
});

test('malformed runtime output and raw errors are rejected without leaking text or replaying an uncertain command', async t => {
  let output, reads = 0;
  const accessor = {}; Object.defineProperty(accessor, 'text', { enumerable: true, get() { reads++; return 'secret'; } });
  const f = await commandFixture(t, { execute: () => { if (output === 'throw') throw Error(`secret ${token}`); return output; } });
  const handle = await f.start();
  const invalid = [null, [], { text: '' }, { text: ' ' }, { text: 'a\0b' }, { text: 'ấ'.repeat(10923) }, { text: 'secret', token }, accessor, 'throw'];
  for (const [index, value] of invalid.entries()) {
    output = value; const request = claim(f, { commandId: `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000` });
    await assert.rejects(f.supervisor.executePrivateCommand(handle, request),
      { message: output === 'throw' ? 'private_command_failed' : 'private_command_invalid_result' });
    await assert.rejects(f.supervisor.executePrivateCommand(handle, request), /private_command_duplicate/);
  }
  assert.equal(reads, 0); assert.equal(executions(f).length, invalid.length);
  output = { text: 'a'.repeat(32768) }; await f.supervisor.executePrivateCommand(handle, claim(f));
});

test('A and B run concurrently in separate profiles, while a claim for B cannot run on the A handle', async t => {
  const tokenB = `hc_${'b'.repeat(43)}`, work = deferred(), entered = deferred(); let f;
  const identityB = { connectionId: id('7'), assistantId: id('8'), userId: id('9'), organizationId: id('a'), expiresAt: 1800000600000 };
  f = await commandFixture(t, { resolve: value => structuredClone(value === tokenB ? identityB : f.identity),
    execute: (instance, input) => {
      if (instance.input.binding.userId === id('3')) { entered.resolve(); return work.promise; }
      return { text: `B only: ${input.text}` };
    } });
  const handleA = await f.start(), homeB = path.join(f.root, 'home-b'); await mkdir(homeB);
  const handleB = await f.supervisor.start({ token: tokenB, home: homeB });
  const claimA = claim(f), claimB = claim(f, { ...identityB, text: 'B message', expiresAt: claimA.expiresAt });
  const resultA = f.supervisor.executePrivateCommand(handleA, claimA); await entered.promise;
  try {
    await assert.rejects(f.supervisor.executePrivateCommand(handleA, claimB), /private_command_owner_mismatch/);
    assert.deepEqual(await f.supervisor.executePrivateCommand(handleB, claimB), { text: 'B only: B message' });
    assert.equal(executions(f).length, 2);
    assert.deepEqual(executions(f).map(call => call[1].input.binding.userId), [id('3'), id('9')]);
  } finally { work.resolve({ text: 'A only' }); }
  assert.deepEqual(await resultA, { text: 'A only' });
});

test('caller cancellation during runtime aborts immediately and keeps the ID consumed after late success', async t => {
  const work = deferred(), entered = deferred(), caller = new AbortController(); let signal;
  const f = await commandFixture(t, { execute: (_instance, _input, options) => { signal = options.signal; entered.resolve(); return work.promise; } });
  const handle = await f.start(), result = f.supervisor.executePrivateCommand(handle, claim(f), { signal: caller.signal });
  const rejected = assert.rejects(result, /private_command_cancelled/); await entered.promise; caller.abort();
  try {
    await rejected; assert.equal(signal.aborted, true);
    assert.equal(f.calls.filter(call => call[0] === 'gate').at(-1)[1], false);
    assert.equal(f.supervisor.status(handle).state, 'reconnect_required');
    await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f, { commandId: id('7') })), /private_command_stopped/);
  } finally { work.resolve({ text: 'late' }); await tick(); }
  await assert.rejects(f.supervisor.executePrivateCommand(handle, claim(f)), /private_command_stopped/);
  assert.equal(f.resolutions, 3);
});
