import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntimeOrchestrator } from './runtime-orchestrator.mjs';
import { createProfileHomes } from './profile-homes.mjs';
import { ProfileLeaseStore } from './profile-lease.mjs';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
import { createDependencyScope } from '../hermes-broker/dependency-scope.mjs';

const NOW = 1800000000000;
const A = { connectionId: '40000000-0000-4000-8000-000000000001', assistantId: '30000000-0000-4000-8000-000000000001', userId: '10000000-0000-4000-8000-000000000001', organizationId: '20000000-0000-4000-8000-000000000001', expiresAt: NOW + 600000 };
const B = { ...A, connectionId: '40000000-0000-4000-8000-000000000002', assistantId: '30000000-0000-4000-8000-000000000002', userId: '10000000-0000-4000-8000-000000000002' };
const TA = 'hc_' + 'a'.repeat(43), TB = 'hc_' + 'b'.repeat(43), TC = 'hc_' + 'c'.repeat(43);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const pause = () => new Promise(resolve => setImmediate(resolve));
function timers() {
  const jobs = new Map(); let id = 0;
  return { jobs, setTimeout(fn, ms) { const key = ++id; jobs.set(key, { fn, ms }); return key; }, clearTimeout(key) { jobs.delete(key); },
    fire(ms) { const next = [...jobs].find(([, value]) => value.ms === ms); assert(next, `missing timer ${ms}`); jobs.delete(next[0]); next[1].fn(); } };
}
async function fixture(t, changes = {}) {
  const raw = await mkdtemp(path.join(os.tmpdir(), 'hermes-orchestrator-')), root = await realpath(raw);
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [], waiters = new Map(), timer = timers(), owners = new Map([[TA, A], [TB, B], [TC, A]]), tickets = new Map(), instances = new Map();
  const emit = event => { events.push(event); waiters.get(event)?.resolve(); };
  const waitFor = async event => {
    if (events.includes(event)) return;
    const waiting = deferred(); waiters.set(event, waiting);
    const watchdog = setTimeout(() => waiting.reject(Error('missing lifecycle event: ' + event)), 5000);
    try { await waiting.promise; } finally { clearTimeout(watchdog); waiters.delete(event); }
  };
  let runs = 0, prunes = 0, maintains = 0, clock = NOW;
  const backend = {
    async resolveConnection(token, options) { emit('resolve:' + (owners.get(token)?.assistantId ?? 'unknown')); await changes.resolve?.(token, options); return { ...owners.get(token) }; },
    async renewConnection() { throw Error('coordinated runtime must not use the automatic renewal timer'); },
    beginConnectionMaintenance(token, { signal }) {
      maintains++; emit('maintain:' + owners.get(token).assistantId);
      const publish = () => {
        const owner = owners.get(token), expiresAt = clock + 900000; owners.set(token, { ...owner, expiresAt });
        return { ok: true, status: 'renewed', connectionId: owner.connectionId, expiresAt, reconciled: false };
      };
      return changes.maintain?.({ token, signal, publish, maintains }) ?? { result: Promise.resolve(publish()), drained: Promise.resolve() };
    },
    async close() { emit('backend-close'); await changes.backendClose?.(); },
  };
  const gateway = {
    async register(token, { home, signal }) { emit('register:' + owners.get(token).assistantId); await changes.register?.(token, signal); const ticket = Object.freeze({}); tickets.set(ticket, { token, home }); return ticket; },
    async releaseRegistration(ticket) { const value = tickets.get(ticket); assert(value); if (value.prepared && !value.closed) throw Error('registration_in_use'); emit('release:' + owners.get(value.token).assistantId); tickets.delete(ticket); },
  };
  const runtime = {
    prepare({ binding, admission, signal }) {
      assert.equal(admission, false); const ticket = [...tickets.values()].find(value => value.home === binding.home && owners.get(value.token).assistantId === binding.assistantId); assert(ticket); ticket.prepared = true;
      const handle = Object.freeze({}); instances.set(handle, { binding, ticket, signal }); emit('prepare:' + binding.assistantId); return handle;
    },
    async start(handle) { const value = instances.get(handle); emit('runtime-start:' + value.binding.assistantId); await changes.runtimeStart?.(value.binding.assistantId, value.signal); },
    setAdmission(handle, allowed) { const value = instances.get(handle); value.admission = allowed; emit(`gate:${value.binding.assistantId}:${allowed}`); },
    async stop(handle) { const value = instances.get(handle); emit('runtime-stop:' + value.binding.assistantId); await changes.runtimeStop?.(value.binding.assistantId); value.ticket.closed = true; },
  };
  const leases = new ProfileLeaseStore({ homeRoot: root, directory: path.join(root, 'supervisor') });
  const actual = createConnectionSupervisor({ profileStore: leases, backend, runtime, clock: () => clock, timers: timer,
    renewalMode: 'coordinated', dependencyScope: createDependencyScope() });
  const supervisor = { renewalMode: 'coordinated',
    beginMaintain: (...args) => changes.beginMaintain ? changes.beginMaintain(...args) : actual.beginMaintain(...args), beginStart: (...args) => actual.beginStart(...args), status: (...args) => actual.status(...args),
    stop: (...args) => actual.stop(...args), close() { emit('supervisor-close'); return actual.close(); } };
  const runner = {
    beginRun(token, handle, { signal }) {
      assert.equal(actual.status(handle).state, 'active'); runs++; emit('run:' + owners.get(token).assistantId);
      return changes.run?.({ token, handle, signal, runs }) ?? Object.freeze({ result: Promise.resolve({ status: 'empty' }), drained: Promise.resolve() });
    },
    beginPrune(input, { signal }) { assert.deepEqual(input, { limit: 64 }); prunes++; emit('prune'); return changes.prune?.({ signal, prunes }) ?? Object.freeze({ result: Promise.resolve({ status: 'pruned', count: 0 }), drained: Promise.resolve() }); },
    close() { emit('runner-close'); return changes.runnerClose?.() ?? Promise.resolve(); },
  };
  const config = { backend, gateway, supervisor, runner, profileHomes: createProfileHomes({ homeRoot: root }), closeIngress() { emit('ingress-close'); },
    closePool() { emit('pool-close'); }, clock: () => clock, timers: timer, pollIntervalMs: 5000, pruneIntervalMs: 60000, ...changes.config };
  const orchestrator = createRuntimeOrchestrator(config);
  return { root, events, waitFor, owners, tickets, instances, leases, actual, timer, config, orchestrator, count: () => ({ runs, prunes, maintains }), advanceClock(ms) { clock += ms; },
    attach(token = TA, controller = new AbortController()) { return orchestrator.attach({ token, signal: controller.signal }); } };
}

test('factory is inert, verifies A/B ownership, and never pumps before explicit start or actual readiness', async t => {
  const starting = deferred(), f = await fixture(t, { runtimeStart: id => id === A.assistantId ? starting.promise : undefined });
  assert.deepEqual(f.events, []); assert.equal(f.timer.jobs.size, 0);
  const pending = f.attach(); await f.waitFor('runtime-start:' + A.assistantId);
  f.orchestrator.start(); f.timer.fire(5000); assert.equal(f.count().runs, 0);
  const b = await f.attach(TB); f.timer.fire(5000); await pause(); assert.equal(f.count().runs, 1);
  starting.resolve(); const a = await pending; f.timer.fire(5000); await pause();
  assert(f.events.includes('run:' + A.assistantId)); assert.equal(f.orchestrator.status(a).userId, A.userId); assert.equal(f.orchestrator.status(b).userId, B.userId);
  assert(!JSON.stringify(f.orchestrator.status(a)).includes(TA)); assert.deepEqual(a, {}); assert(Object.isFrozen(a));
  await f.orchestrator.close(); assert.equal(f.tickets.size, 0);
});

test('exact request snapshot rejects forged actors/getters and duplicate verified profile retains the first owner', async t => {
  const gate = deferred(), f = await fixture(t, { resolve: token => token === TA ? gate.promise : undefined }); let read = 0;
  const getter = { signal: new AbortController().signal }; Object.defineProperty(getter, 'token', { get() { read++; return TA; } });
  await assert.rejects(f.orchestrator.attach(getter)); await assert.rejects(f.orchestrator.attach({ token: TA, signal: new AbortController().signal, userId: B.userId })); assert.equal(read, 0);
  const mutable = { token: TA, signal: new AbortController().signal }, pending = f.orchestrator.attach(mutable); mutable.token = TB;
  await assert.rejects(f.attach(), /orchestrator_busy/); gate.resolve(); const a = await pending;
  await assert.rejects(f.attach(TC), /orchestrator_attach_failed/); assert.equal(f.orchestrator.status(a).userId, A.userId);
  assert.throws(() => f.orchestrator.status({}), /invalid_orchestrator_handle/); await f.orchestrator.close();
});

test('cancel during ignored startup stops only that profile and holds its lease until actual startup settles', async t => {
  const starting = deferred(), f = await fixture(t, { runtimeStart: id => id === A.assistantId ? starting.promise : undefined });
  const controller = new AbortController(), pending = f.attach(TA, controller); void pending.catch(() => {});
  await f.waitFor('runtime-start:' + A.assistantId); const b = await f.attach(TB);
  controller.abort(); await f.waitFor('runtime-stop:' + A.assistantId);
  const aInstance = [...f.instances.values()].find(value => value.binding.assistantId === A.assistantId);
  await assert.rejects(f.leases.acquire(aInstance.binding), /profile_in_use/);
  assert.equal(f.orchestrator.status(b).state, 'active'); assert(!f.events.includes('supervisor-close'));
  starting.resolve(); await assert.rejects(pending, /orchestrator_attach_failed/); const lease = await f.leases.acquire(aInstance.binding); await lease.release();
  await f.orchestrator.close();
});

test('public unknown result stops admission and keeps pump/global slot until actual drain, without retry', async t => {
  const result = deferred(), drained = deferred(), f = await fixture(t, { config: { maxConcurrentPumps: 1 }, run: ({ token }) => token === TA ? { result: result.promise, drained: drained.promise } : undefined });
  const a = await f.attach(), b = await f.attach(TB); f.orchestrator.start(); f.timer.fire(5000); assert.equal(f.count().runs, 1);
  result.reject(Error('PRIVATE SQL OR TOKEN')); await f.waitFor('runtime-stop:' + A.assistantId);
  f.timer.fire(5000); assert.equal(f.count().runs, 1); assert.equal(f.orchestrator.status(a).state, 'reconnect_required'); assert.equal(f.orchestrator.status(b).state, 'active');
  drained.resolve(); await f.waitFor('release:' + A.assistantId);
  f.timer.fire(5000); await pause(); assert.equal(f.count().runs, 2); assert.equal(f.events.filter(value => value === 'run:' + A.assistantId).length, 1);
  await f.orchestrator.close();
});

test('successful public result also holds single flight until actual drain; malformed result quarantines', async t => {
  const drained = deferred(); let bad = false;
  const f = await fixture(t, { run: () => ({ result: Promise.resolve(bad ? { status: 'ready', commandId: 'invalid', text: 'PRIVATE' } : { status: 'empty' }), drained: bad ? Promise.resolve() : drained.promise }) });
  const a = await f.attach(); f.orchestrator.start(); f.timer.fire(5000); await pause(); f.timer.fire(5000); assert.equal(f.count().runs, 1);
  drained.resolve(); await pause(); bad = true; f.timer.fire(5000); await f.waitFor('runtime-stop:' + A.assistantId); assert.equal(f.orchestrator.status(a).state, 'reconnect_required');
  assert.equal(f.count().runs, 2); await f.orchestrator.close();
});

test('prune is bounded/single-flight and an unknown outcome disables only maintenance without replay', async t => {
  const result = deferred(), drained = deferred(), f = await fixture(t, { prune: () => ({ result: result.promise, drained: drained.promise }) });
  const a = await f.attach(); f.orchestrator.start(); f.timer.fire(60000); f.timer.fire(60000); assert.equal(f.count().prunes, 1);
  result.reject(Error('unknown')); await pause(); f.timer.fire(5000); assert.equal(f.count().runs, 1); assert.equal(f.orchestrator.status(a).state, 'active');
  drained.resolve(); await pause(); f.timer.fire(60000); assert.equal(f.count().prunes, 1); await f.orchestrator.close();
});

test('close kicks runner and supervisor together, then drains startup/pump before backend and pool', async t => {
  const drain = deferred(), runnerClosing = deferred(), f = await fixture(t, { run: () => ({ result: Promise.resolve({ status: 'empty' }), drained: drain.promise }), runnerClose: () => runnerClosing.promise });
  await f.attach(); f.orchestrator.start(); f.timer.fire(5000); await pause();
  const closed = f.orchestrator.close(); assert.strictEqual(f.orchestrator.close(), closed);
  assert(f.events.includes('runner-close')); assert(f.events.includes('supervisor-close')); assert(!f.events.includes('backend-close'));
  runnerClosing.resolve(); await pause(); assert(!f.events.includes('backend-close'));
  drain.resolve(); await closed;
  assert(f.events.indexOf('release:' + A.assistantId) < f.events.indexOf('backend-close')); assert(f.events.indexOf('backend-close') < f.events.indexOf('pool-close'));
  assert.equal(f.timer.jobs.size, 0); await assert.rejects(f.attach(), /orchestrator_stopped/);
});

test('unproven stop or runner drain retains resources and never disposes backend or pool', async t => {
  for (const mode of ['stop', 'drain']) {
    const f = await fixture(t, { runtimeStop: () => { if (mode === 'stop') throw Error('PRIVATE FAILURE'); },
      run: () => ({ result: Promise.resolve({ status: 'empty' }), drained: Promise.reject(Error('unproven actual drain')) }) });
    const a = await f.attach(); if (mode === 'drain') { f.orchestrator.start(); f.timer.fire(5000); await assert.rejects(f.orchestrator.stop(a), /orchestrator_profile_retained/); }
    await assert.rejects(f.orchestrator.close(), /^Error: orchestrator_close_retained$/);
    assert(!f.events.includes('backend-close')); assert(!f.events.includes('pool-close')); assert.equal(f.orchestrator.status(a).state, 'retained');
  }
});

test('cancelled authority lookup holds attach capacity until real resolution settles and cleans unprepared ticket', async t => {
  const resolving = deferred(), f = await fixture(t, { config: { maxProfiles: 1 }, resolve: () => resolving.promise });
  const controller = new AbortController(), attaching = f.attach(TA, controller); void attaching.catch(() => {}); controller.abort();
  await assert.rejects(f.attach(TB), /orchestrator_busy/); assert.equal(f.tickets.size, 0);
  resolving.resolve(); await assert.rejects(attaching, /orchestrator_attach_failed/); assert(!f.events.some(event => event.startsWith('prepare:')));
  await f.orchestrator.close();
});

test('startup failure releases a registration and preserves unrelated active profile', async t => {
  const f = await fixture(t, { runtimeStart: id => { if (id === A.assistantId) throw Error('raw private startup failure'); } });
  const b = await f.attach(TB); await assert.rejects(f.attach(), /^Error: orchestrator_attach_failed$/);
  assert.equal(f.orchestrator.status(b).state, 'active'); assert(f.events.includes('release:' + A.assistantId)); assert.equal(f.tickets.size, 1);
  await f.orchestrator.close();
});

test('owner changes before registration or after actual ready prevent any command pump', async t => {
  for (const changeAt of [2, 5]) {
    let calls = 0, f;
    f = await fixture(t, { resolve: () => { if (++calls === changeAt) f.owners.set(TA, B); } });
    f.orchestrator.start(); await assert.rejects(f.attach(), /orchestrator_attach_failed/);
    f.timer.fire(5000); assert.equal(f.count().runs, 0);
    if (changeAt === 2) assert(!f.events.some(event => event.startsWith('register:')));
    else assert(f.events.includes('runtime-stop:' + A.assistantId));
    await f.orchestrator.close();
  }
});

test('cancel during registration waits for its actual ticket and retires only that unprepared registration', async t => {
  const registering = deferred(), f = await fixture(t, { register: token => token === TA ? registering.promise : undefined });
  const controller = new AbortController(), attaching = f.attach(TA, controller); void attaching.catch(() => {});
  await f.waitFor('register:' + A.assistantId); controller.abort();
  const b = await f.attach(TB); assert.equal(f.orchestrator.status(b).state, 'active');
  registering.resolve(); await assert.rejects(attaching, /orchestrator_attach_failed/);
  assert(f.events.includes('release:' + A.assistantId)); assert(!f.events.includes('prepare:' + A.assistantId));
  await f.orchestrator.close();
});

test('close can stop a starting runtime which needs stop to settle, without deadlocking either lifecycle', async t => {
  const starting = deferred(), f = await fixture(t, { runtimeStart: () => starting.promise, runtimeStop: () => starting.resolve() });
  const attaching = f.attach(); void attaching.catch(() => {});
  await f.waitFor('runtime-start:' + A.assistantId);
  await f.orchestrator.close(); await assert.rejects(attaching, /orchestrator_attach_failed/);
  assert(f.events.includes('pool-close')); assert.equal(f.tickets.size, 0);
});

test('bounded scheduler rotates profiles so a consistently empty first profile does not starve later owners', async t => {
  const f = await fixture(t, { config: { maxConcurrentPumps: 1 } });
  const token = 'hc_' + 'd'.repeat(43), c = { ...A, connectionId: '40000000-0000-4000-8000-000000000003', assistantId: '30000000-0000-4000-8000-000000000003', userId: '10000000-0000-4000-8000-000000000003' };
  f.owners.set(token, c); await f.attach(); await f.attach(TB); await f.attach(token); f.orchestrator.start();
  for (let i = 0; i < 3; i++) { f.timer.fire(5000); await pause(); }
  assert.deepEqual(f.events.filter(event => event.startsWith('run:')), [A, B, c].map(owner => 'run:' + owner.assistantId));
  await f.orchestrator.close();
});

test('status follows the supervised runtime renewal and never reports active after its authority stopped', async t => {
  const f = await fixture(t), a = await f.attach(); f.orchestrator.start(); f.advanceClock(300000);
  f.timer.fire(5000); await pause(); assert.equal(f.orchestrator.status(a).expiresAt, NOW + 1200000);
  await f.actual.close(); assert.equal(f.orchestrator.status(a).state, 'reconnect_required');
  await f.orchestrator.close();
});

test('product orchestrator requires coordinated maintenance and reserves enough time before expiry', async t => {
  const f = await fixture(t); let getterCalls = 0;
  for (const supervisor of [{ ...f.config.supervisor, renewalMode: 'automatic' },
    { ...f.config.supervisor, get renewalMode() { getterCalls++; return 'coordinated'; } },
    { ...f.config.supervisor, beginMaintain: undefined }]) {
    assert.throws(() => createRuntimeOrchestrator({ ...f.config, supervisor }), /invalid_orchestrator_config/);
  }
  for (const renewBeforeMs of [180000, 185000, 600001]) assert.throws(() => createRuntimeOrchestrator({ ...f.config, renewBeforeMs }), /invalid_orchestrator_config/);
  assert.equal(getterCalls, 0); assert.deepEqual(f.events, []); await f.orchestrator.close();
});

test('parking waits for the entire runner drain before closing admission or starting refresh', async t => {
  const result = deferred(), pumpDrain = deferred(), refreshDrain = deferred();
  const f = await fixture(t, { run: () => ({ result: result.promise, drained: pumpDrain.promise }),
    maintain: ({ publish }) => ({ result: Promise.resolve(publish()), drained: refreshDrain.promise }) });
  const a = await f.attach(); f.orchestrator.start(); f.timer.fire(5000); await pause(); f.advanceClock(300000);
  f.timer.fire(5000); assert.equal(f.orchestrator.status(a).state, 'parking'); assert.equal(f.count().maintains, 0);
  assert(!f.events.includes('gate:' + A.assistantId + ':false'));
  result.resolve({ status: 'empty' }); await pause(); f.timer.fire(5000); assert.equal(f.count().runs, 1); assert.equal(f.count().maintains, 0);
  pumpDrain.resolve(); await pause(); f.timer.fire(5000); await f.waitFor('maintain:' + A.assistantId);
  assert.equal(f.orchestrator.status(a).state, 'maintaining'); assert(f.events.includes('gate:' + A.assistantId + ':false'));
  f.timer.fire(5000); assert.equal(f.count().runs, 1); assert.equal(f.count().maintains, 1);
  refreshDrain.resolve(); await pause(); assert.equal(f.orchestrator.status(a).state, 'active');
  assert.equal(f.orchestrator.status(a).expiresAt, NOW + 1200000); await f.orchestrator.close();
});

test('maintenance gets expiry priority and shares bounded pump capacity until real drain', async t => {
  const drain = deferred();
  const f = await fixture(t, { config: { maxConcurrentPumps: 1 }, maintain: ({ token, publish }) =>
    ({ result: Promise.resolve(publish()), drained: token === TB ? drain.promise : Promise.resolve() }) });
  f.owners.set(TB, { ...B, expiresAt: NOW + 550000 });
  const a = await f.attach(), b = await f.attach(TB); f.orchestrator.start(); f.advanceClock(300000); f.timer.fire(5000);
  await f.waitFor('maintain:' + B.assistantId); assert.equal(f.orchestrator.status(a).state, 'parking');
  assert.equal(f.orchestrator.status(b).state, 'maintaining'); f.timer.fire(5000);
  assert.deepEqual(f.events.filter(event => event.startsWith('maintain:')), ['maintain:' + B.assistantId]); assert.equal(f.count().runs, 0);
  drain.resolve(); await pause(); f.timer.fire(5000); await f.waitFor('maintain:' + A.assistantId); await pause();
  assert.equal(f.orchestrator.status(a).state, 'active'); assert.equal(f.orchestrator.status(b).state, 'active');
  await f.orchestrator.close();
});

test('one refreshing owner does not interrupt another owner with a fresh lease', async t => {
  const drain = deferred(), f = await fixture(t, { maintain: ({ publish }) => ({ result: Promise.resolve(publish()), drained: drain.promise }) });
  f.owners.set(TB, { ...B, expiresAt: NOW + 900000 }); const a = await f.attach(), b = await f.attach(TB);
  f.orchestrator.start(); f.advanceClock(300000); f.timer.fire(5000); await f.waitFor('maintain:' + A.assistantId);
  assert.equal(f.orchestrator.status(a).state, 'maintaining'); assert.equal(f.orchestrator.status(b).state, 'active');
  assert(f.events.includes('run:' + B.assistantId)); assert(!f.events.includes('gate:' + B.assistantId + ':false'));
  drain.resolve(); await pause(); await f.orchestrator.close();
});

test('unknown maintenance stops only its owner, retains actual-work budget, and never retries', async t => {
  const result = deferred(), drain = deferred();
  const f = await fixture(t, { config: { maxConcurrentPumps: 1 }, maintain: () => ({ result: result.promise, drained: drain.promise }) });
  f.owners.set(TB, { ...B, expiresAt: NOW + 900000 }); const a = await f.attach(), b = await f.attach(TB);
  f.orchestrator.start(); f.advanceClock(300000); f.timer.fire(5000); await f.waitFor('maintain:' + A.assistantId);
  result.reject(Error('PRIVATE provider result unknown')); await f.waitFor('runtime-stop:' + A.assistantId);
  f.timer.fire(5000); assert.equal(f.count().maintains, 1); assert.equal(f.count().runs, 0);
  assert.equal(f.orchestrator.status(b).state, 'active'); assert.equal(f.orchestrator.status(a).state, 'reconnect_required');
  drain.resolve(); await f.waitFor('release:' + A.assistantId); f.timer.fire(5000); await pause();
  assert.equal(f.count().maintains, 1); assert.equal(f.count().runs, 1); await f.orchestrator.close();
});

test('close during maintenance waits for provider drain before releasing ticket, backend and pool', async t => {
  const result = deferred(), drain = deferred(); let publish, signal;
  const f = await fixture(t, { maintain: input => { publish = input.publish; signal = input.signal; return { result: result.promise, drained: drain.promise }; } });
  await f.attach(); f.orchestrator.start(); f.advanceClock(300000); f.timer.fire(5000); await f.waitFor('maintain:' + A.assistantId);
  let closed = false; const closing = f.orchestrator.close().then(() => { closed = true; }); await pause();
  try {
    assert(signal.aborted); assert.equal(closed, false); assert(!f.events.includes('backend-close')); assert.equal(f.tickets.size, 1);
    result.resolve(publish()); await pause(); assert.equal(closed, false);
    assert.equal(f.events.filter(event => event === 'gate:' + A.assistantId + ':true').length, 1);
  } finally { drain.resolve(); await closing; }
  assert.equal(f.tickets.size, 0); assert(f.events.includes('pool-close'));
});

for (const kind of ['maintenance', 'pump', 'prune']) {
  test(`malformed ${kind} lifecycle retains ownership instead of pretending it drained`, async t => {
    const held = deferred(), invalid = () => ({ result: held.promise, drained: null });
    const f = await fixture(t, kind === 'maintenance' ? { beginMaintain: invalid } : kind === 'pump' ? { run: invalid } : { prune: invalid });
    const a = await f.attach(); f.orchestrator.start();
    if (kind === 'maintenance') f.advanceClock(300000);
    f.timer.fire(kind === 'prune' ? 60000 : 5000); await pause();
    await assert.rejects(f.orchestrator.close(), /orchestrator_close_retained/);
    assert(!f.events.includes('backend-close')); assert(!f.events.includes('pool-close'));
    if (kind !== 'prune') assert.equal(f.orchestrator.status(a).state, 'retained');
    held.reject(Error('late private dependency failure')); await pause();
  });
}


test('persisted handoff owner fence rejects every identity change before creating home, registration or runtime', async t => {
  for (const key of ['connectionId','assistantId','userId','organizationId']) {
    const f = await fixture(t), expectedOwner = Object.fromEntries(['connectionId','assistantId','userId','organizationId'].map(name => [name,A[name]]));
    expectedOwner[key] = '90000000-0000-4000-8000-000000000009';
    await assert.rejects(f.orchestrator.attach({token:TA,signal:new AbortController().signal,expectedOwner}), /orchestrator_attach_failed/);
    assert.equal(f.tickets.size,0); assert.equal(f.instances.size,0);
    assert(!f.events.some(value => value.startsWith('register:') || value.startsWith('prepare:')));
    await f.orchestrator.close();
  }
});

test('persisted handoff owner fence snapshots values before await and never executes accessors', async t => {
  const gate = deferred(), f = await fixture(t,{resolve:()=>gate.promise});
  const owner = () => Object.fromEntries(['connectionId','assistantId','userId','organizationId'].map(key => [key,A[key]]));
  for (const expectedOwner of [null,{...owner(),expiresAt:A.expiresAt},Object.defineProperty(owner(),'userId',{get(){throw Error('getter invoked');}})]) {
    await assert.rejects(f.orchestrator.attach({token:TA,signal:new AbortController().signal,expectedOwner}),/invalid_orchestrator_request/);
  }
  assert.equal(f.events.length,0);
  const expectedOwner = owner(), pending = f.orchestrator.attach({token:TA,signal:new AbortController().signal,expectedOwner});
  expectedOwner.userId = B.userId; gate.resolve(); const handle = await pending;
  assert.equal(f.orchestrator.status(handle).userId,A.userId); await f.orchestrator.close();
});
