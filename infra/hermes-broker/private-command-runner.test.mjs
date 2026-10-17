import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createPrivateCommandRunner, PrivateCommandRunnerError } from './private-command-runner.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createStoreTransport } from './store-transport.mjs';
import { createPrivateCommandStore } from './private-command-store.mjs';

const NOW = 1800000000000, token = `hc_${'a'.repeat(43)}`, digest = createHash('sha256').update(token).digest('hex');
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const authority = { connectionId: id(1), assistantId: id(2), userId: id(3), organizationId: id(4), expiresAt: NOW + 600000 };
const item = { ...authority, commandId: id(5), bindingId: id(6), bindingEpoch: 1, text: 'Phòng trống?', expiresAt: NOW + 300000 };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(done => setImmediate(done));
function fixture(t, hooks = {}, dependencyScope) {
  const calls = [], handle = Object.freeze({}), controller = new AbortController(); let now = NOW;
  const log = (method, input, options) => { calls.push({ method, input, options }); return hooks[method]?.(input, options, calls); };
  const store = {
    async claimPrivateCommand(input, options) { return await log('claim', input, options) ?? { status: 'claimed', claimId: input.claimId, command: structuredClone(item) }; },
    async dispatchPrivateCommand(input, options) { return await log('dispatch', input, options) ?? { status: 'dispatched', claimId: input.claimId, commandId: item.commandId }; },
    async finishPrivateCommand(input, options) { return await log('finish', input, options) ?? { status: 'ready', claimId: input.claimId, commandId: item.commandId }; },
    async failPrivateCommand(input, options) { return await log('fail', input, options) ?? { status: 'unknown', claimId: input.claimId, commandId: item.commandId }; },
    async prunePrivateCommands(input, options) { return await log('prune', input, options) ?? { status: 'pruned', count: 0 }; },
  };
  const runner = createPrivateCommandRunner({ store, clock: () => now, dependencyScope,
    async resolveConnection(input, options) { return await log('resolve', input, options) ?? structuredClone(authority); },
    supervisor: { status(value) { if (value !== handle) throw Error('not-branded'); return { state: 'active', expiresAt: authority.expiresAt }; },
      async executePrivateCommand(value, input, options) { assert.equal(value, handle); return await log('execute', input, options) ?? { text: 'Phòng 101 trống.' }; } },
  });
  t.after(() => runner.close());
  return { runner, calls, handle, controller, run: (value = token) => runner.run(value, handle, { signal: controller.signal }),
    advance(ms) { now += ms; } };
}
const methods = f => f.calls.map(call => call.method);
const unknown = { code: 'private_command_outcome_unknown', outcomeUnknown: true };

test('beginRun retains capacity and close until tracked inner work drains after a public adapter failure', async t => {
  const scope = createDependencyScope(), inner = deferred(), entered = deferred();
  const f = fixture(t, { claim() { void scope.track(async () => { entered.resolve(); await inner.promise; }); throw Error('adapter deadline'); } }, scope);
  const pair = f.runner.beginRun(token, f.handle, { signal: f.controller.signal });
  assert(Object.isFrozen(pair)); assert.deepEqual(Object.keys(pair).sort(), ['drained', 'result']);
  await entered.promise; await assert.rejects(pair.result, unknown);
  let drained = false, closed = false; void pair.drained.then(() => { drained = true; });
  await assert.rejects(f.runner.beginRun(token, f.handle, { signal: f.controller.signal }).result, { code: 'busy' });
  const closing = f.runner.close(); void closing.then(() => { closed = true; });
  await tick(); assert.equal(drained, false); assert.equal(closed, false); assert.deepEqual(methods(f), ['resolve', 'claim']);
  inner.resolve(); await pair.drained; await closing; await scope.close(); assert.equal(closed, true);
});

test('beginPrune retains tracked maintenance work and invalid begin requests drain without dependencies', async t => {
  const scope = createDependencyScope(), inner = deferred(), entered = deferred();
  const f = fixture(t, { prune() { void scope.track(async () => { entered.resolve(); await inner.promise; }); throw Error('unknown prune'); } }, scope);
  const invalid = f.runner.beginRun('invalid', f.handle, { signal: f.controller.signal });
  await assert.rejects(invalid.result, { code: 'invalid_request' }); await invalid.drained; assert.deepEqual(f.calls, []);
  const pair = f.runner.beginPrune({ limit: 3 }, { signal: f.controller.signal });
  await entered.promise; await assert.rejects(pair.result, unknown); let drained = false;
  void pair.drained.then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  inner.resolve(); await pair.drained; assert.deepEqual(methods(f), ['prune']);
});

test('beginRun observes actual fixed SQL transport after its dispatched query aborts publicly', async () => {
  const scope = createDependencyScope(), entered = deferred(), query = deferred(), controller = new AbortController(); let count = 0;
  const expectedRole = 'hermes_store_test'; const released = [];
  const transport = createStoreTransport({ dependencyScope: scope, expectedRole, pool: { async connect() { return {
    query() { if (++count === 1) return Promise.resolve({ rows: [{ role: expectedRole, session_role: expectedRole, scoped: true,
      privileged_member: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false }] });
      entered.resolve(); return query.promise; }, release(value) { released.push(value); },
  }; } } });
  const handle = Object.freeze({});
  const runner = createPrivateCommandRunner({ dependencyScope: scope, store: createPrivateCommandStore({ transport }), clock: () => NOW,
    resolveConnection: async () => authority, supervisor: { status: () => ({ state: 'active', expiresAt: authority.expiresAt }),
      executePrivateCommand() { assert.fail('An unknown claim must never execute'); } } });
  const pair = runner.beginRun(token, handle, { signal: controller.signal });
  try {
    await entered.promise; controller.abort(); await assert.rejects(pair.result, unknown);
    let drained = false, closed = false; void pair.drained.then(() => { drained = true; });
    const closing = runner.close(); void closing.then(() => { closed = true; }); await tick();
    assert.equal(drained, false); assert.equal(closed, false); assert.deepEqual(released, [true]);
    query.resolve({ rows: [{ result: { status: 'empty' } }] }); await pair.drained; await closing; assert.equal(count, 2);
  } finally { query.resolve({ rows: [] }); await runner.close(); await scope.close(); }
});

test('trusted pump resolves fresh owner, claims and dispatches once, then returns only READY metadata', async t => {
  const f = fixture(t), result = await f.run();
  assert.deepEqual(result, { status: 'ready', commandId: item.commandId }); assert(Object.isFrozen(result));
  assert.deepEqual(methods(f), ['resolve', 'claim', 'resolve', 'dispatch', 'execute', 'resolve', 'finish']);
  const mutation = f.calls.filter(call => ['claim', 'dispatch', 'finish'].includes(call.method));
  assert(mutation.every(call => call.input.tokenDigest === digest));
  assert.match(mutation[0].input.claimId, /^[a-f0-9-]{36}$/);
  assert(mutation.every(call => call.input.claimId === mutation[0].input.claimId));
  assert.deepEqual(Object.keys(mutation[0].input).sort(), ['claimId', 'tokenDigest']);
  assert.equal(mutation[2].input.text, 'Phòng 101 trống.');
  assert(!JSON.stringify(mutation).includes(token)); assert(!JSON.stringify(result).includes('text'));
  assert.equal(f.calls.find(call => call.method === 'execute').options.timeoutMs, 120000);
});

// The DB stamps token expiry as clock_timestamp() + 15 min; literal skews so a zeroed tolerance is caught.
for (const ahead of [50, 4000]) {
  test(`owner expiry ${ahead} ms past the 15-minute TTL (DB clock ahead) is still accepted`, async t => {
    const f = fixture(t, { resolve: () => ({ ...authority, expiresAt: NOW + 900000 + ahead }) });
    assert.deepEqual(await f.run(), { status: 'ready', commandId: item.commandId });
    assert.deepEqual(methods(f), ['resolve', 'claim', 'resolve', 'dispatch', 'execute', 'resolve', 'finish']);
  });
}

test('owner expiry 6000 ms past the 15-minute TTL is rejected before any write', async t => {
  const f = fixture(t, { resolve: () => ({ ...authority, expiresAt: NOW + 900000 + 6000 }) });
  await assert.rejects(f.run(), { code: 'authority_unavailable' }); assert.deepEqual(methods(f), ['resolve']);
});

test('a fresh owner re-read with expiry 6000 ms past the TTL stops before dispatch', async t => {
  let resolves = 0;
  const f = fixture(t, { resolve: () => ({ ...authority, expiresAt: NOW + 900000 + (++resolves === 2 ? 6000 : 50) }) });
  await assert.rejects(f.run(), unknown); assert.deepEqual(methods(f), ['resolve', 'claim', 'resolve']);
});

test('empty claim returns without dispatch, runtime, polling or cleanup', async t => {
  const f = fixture(t, { claim: () => ({ status: 'empty' }) });
  assert.deepEqual(await f.run(), { status: 'empty' }); await tick();
  assert.deepEqual(methods(f), ['resolve', 'claim']);
});

test('invalid token, forged handle, options getters and pre-cancelled requests touch no dependency', async t => {
  const f = fixture(t); let read = false; const getter = {}; Object.defineProperty(getter, 'signal', { enumerable: true, get() { read = true; return f.controller.signal; } });
  for (const value of [null, '', 'browser.jwt', `hc_${'x'.repeat(42)}`, { toString() { throw Error('secret'); } }]) {
    await assert.rejects(f.runner.run(value, f.handle, { signal: f.controller.signal }), { code: 'invalid_request' });
  }
  await assert.rejects(f.runner.run(token, {}, { signal: f.controller.signal }), { code: 'invalid_handle' });
  for (const options of [undefined, {}, getter, { signal: f.controller.signal, userId: id(99) }, { signal: {} }]) {
    await assert.rejects(f.runner.run(token, f.handle, options), { code: 'invalid_request' });
  }
  f.controller.abort(); await assert.rejects(f.run(), { code: 'cancelled' });
  assert.equal(read, false); assert.deepEqual(f.calls, []);
});

for (const key of ['connectionId', 'assistantId', 'userId', 'organizationId']) {
  test(`claimed ${key} cannot redirect a live owner`, async t => {
    const f = fixture(t, { claim: input => ({ status: 'claimed', claimId: input.claimId, command: { ...item, [key]: id(99) } }) });
    await assert.rejects(f.run(), unknown); assert.deepEqual(methods(f), ['resolve', 'claim', 'resolve']);
  });
}

test('claim and authority are snapshotted before an awaited lookup can mutate the source', async t => {
  const entered = deferred(), held = deferred(), mutableItem = structuredClone(item), mutableOwner = structuredClone(authority); let resolves = 0;
  const f = fixture(t, { claim: input => ({ status: 'claimed', claimId: input.claimId, command: mutableItem }),
    resolve: () => { if (++resolves === 2) { entered.resolve(); return held.promise; } return mutableOwner; } });
  const running = f.run(); await entered.promise; mutableItem.text = 'changed'; mutableItem.bindingEpoch = 9;
  held.resolve(structuredClone(authority)); await running;
  assert.equal(f.calls.find(call => call.method === 'execute').input.text, item.text);
  assert.equal(f.calls.find(call => call.method === 'execute').input.bindingEpoch, 1);
});

for (const stage of ['claim', 'dispatch', 'finish']) {
  test(`wrong ${stage} claim echo is unknown and never permits another effect`, async t => {
    const f = fixture(t, { [stage]: () => stage === 'claim' ? { status: 'claimed', claimId: id(99), command: structuredClone(item) } :
      { status: stage === 'dispatch' ? 'dispatched' : 'ready', claimId: id(99), commandId: item.commandId } });
    await assert.rejects(f.run(), unknown);
    assert.equal(methods(f).filter(value => value === stage).length, 1);
    assert.equal(methods(f).includes('execute'), stage === 'finish'); assert(!methods(f).includes('fail'));
  });
}

for (const stage of ['dispatch', 'finish']) {
  test(`wrong ${stage} command echo is unknown despite a matching claim ID`, async t => {
    const f = fixture(t, { [stage]: input => ({ status: stage === 'dispatch' ? 'dispatched' : 'ready', commandId: id(99), claimId: input.claimId }) });
    await assert.rejects(f.run(), unknown); assert(!methods(f).includes('fail'));
    assert.equal(methods(f).includes('execute'), stage === 'finish');
  });
}

test('already-dispatched ACK never causes execution or compensation', async t => {
  const f = fixture(t, { dispatch: input => ({ status: 'already_dispatched', claimId: input.claimId, commandId: item.commandId }) });
  await assert.rejects(f.run(), unknown); assert.deepEqual(methods(f), ['resolve', 'claim', 'resolve', 'dispatch']);
});

for (const stage of ['claim', 'dispatch', 'finish']) {
  test(`unknown ${stage} outcome is never retried or compensated, including a lost READY ACK`, async t => {
    const f = fixture(t, { [stage]: () => { throw Error(`secret ${token} SQL text`); } });
    await assert.rejects(f.run(), error => error instanceof PrivateCommandRunnerError && error.code === unknown.code && error.message === unknown.code && error.cause === undefined);
    await tick(); assert.equal(methods(f).filter(value => value === stage).length, 1);
    assert(!methods(f).includes('fail')); assert.equal(methods(f).includes('execute'), stage === 'finish');
  });
}

test('settled runtime failure records runtime_unknown once only after another live authority check', async t => {
  const f = fixture(t, { execute: () => { throw Error('private runtime stack'); } });
  await assert.rejects(f.run(), unknown);
  assert.deepEqual(methods(f), ['resolve', 'claim', 'resolve', 'dispatch', 'execute', 'resolve', 'fail']);
  assert.equal(f.calls.at(-1).input.reason, 'runtime_unknown'); assert(!methods(f).includes('finish'));
});

test('an unknown failure-cleanup ACK is terminal and never retries fail or runtime', async t => {
  const f = fixture(t, { execute: () => { throw Error('private'); }, fail: () => { throw Error('lost ACK'); } });
  await assert.rejects(f.run(), unknown);
  assert.equal(methods(f).filter(value => value === 'execute').length, 1); assert.equal(methods(f).filter(value => value === 'fail').length, 1);
});

test('authority loss after runtime suppresses finish, and authority loss on runtime failure suppresses cleanup', async t => {
  for (const fails of [false, true]) {
    let resolves = 0;
    const f = fixture(t, { resolve: () => { if (++resolves === 3) throw Error('revoked'); }, execute: () => { if (fails) throw Error('failed'); } });
    await assert.rejects(f.run(), unknown); assert(!methods(f).includes('finish')); assert(!methods(f).includes('fail'));
  }
});

test('changed fresh owner before dispatch or after runtime never reaches the following mutation', async t => {
  for (const changeAt of [2, 3]) {
    let resolves = 0; const f = fixture(t, { resolve: () => ({ ...authority, ...(++resolves === changeAt ? { userId: id(99) } : {}) }) });
    await assert.rejects(f.run(), unknown); assert.equal(methods(f).includes('dispatch'), changeAt === 3); assert(!methods(f).includes('finish'));
  }
});

test('malformed claim/getter and malformed output fail closed without evaluating accessors', async t => {
  let reads = 0; const getter = { ...item }; Object.defineProperty(getter, 'text', { enumerable: true, get() { reads++; return 'private'; } });
  const f = fixture(t, { claim: input => ({ status: 'claimed', claimId: input.claimId, command: getter }) });
  await assert.rejects(f.run(), unknown); assert.deepEqual(methods(f), ['resolve', 'claim']);
  const output = {}; Object.defineProperty(output, 'text', { enumerable: true, get() { reads++; return 'private'; } });
  const g = fixture(t, { execute: () => output }); await assert.rejects(g.run(), unknown);
  assert.equal(reads, 0); assert(methods(g).includes('fail')); assert(!methods(g).includes('finish'));
});

for (const stage of ['resolve', 'claim', 'dispatch', 'execute', 'finish']) {
  test(`cancel during ignored-abort ${stage} retains token slot and close drains its public promise`, async t => {
    const entered = deferred(), held = deferred(); let captured, count = 0;
    const f = fixture(t, { [stage]: (input, options) => { if (++count === 1) { captured = { input, options }; entered.resolve(); return held.promise; } } });
    const running = f.run(), rejected = assert.rejects(running, { code: stage === 'resolve' ? 'cancelled' : unknown.code });
    await entered.promise; f.controller.abort(); await rejected; assert.equal(captured.options.signal.aborted, true);
    await assert.rejects(f.runner.run(token, f.handle, { signal: new AbortController().signal }), { code: 'busy' });
    let closed = false; const closing = f.runner.close(); assert.equal(f.runner.close(), closing); void closing.then(() => { closed = true; });
    await tick(); assert.equal(closed, false);
    held.resolve(stage === 'resolve' ? structuredClone(authority) : stage === 'claim' ? { status: 'claimed', claimId: captured.input.claimId, command: structuredClone(item) } :
      stage === 'execute' ? { text: 'late' } : { status: stage === 'dispatch' ? 'dispatched' : 'ready', commandId: item.commandId, claimId: captured.input.claimId });
    await closing; assert.equal(methods(f).at(-1), stage); assert(!methods(f).includes('fail'));
    await assert.rejects(f.run(), { code: 'backend_closed' });
  });
}

test('120-second deadline returns unknown but retains admission until ignored-abort runtime settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const entered = deferred(), held = deferred(); let signal;
  const f = fixture(t, { execute: (_input, options) => { signal = options.signal; entered.resolve(); return held.promise; } });
  const result = f.run(), rejected = assert.rejects(result, unknown); await entered.promise;
  f.advance(120000); t.mock.timers.tick(120000); await rejected; assert(signal.aborted);
  await assert.rejects(f.runner.run(token, f.handle, { signal: new AbortController().signal }), { code: 'busy' });
  held.resolve({ text: 'late' }); await f.runner.close(); assert(!methods(f).includes('finish')); assert(!methods(f).includes('fail'));
});

test('sixteen pending operations fill global capacity, including distinct tokens and prune', async t => {
  const held = deferred(); const f = fixture(t, { resolve: () => held.promise });
  const runs = Array.from({ length: 16 }, (_, index) => f.run(`hc_${String(index).padStart(43, '0')}`));
  const results = Promise.allSettled(runs); await tick();
  await assert.rejects(f.run(), { code: 'busy' });
  await assert.rejects(f.runner.prune({ limit: 1 }, { signal: f.controller.signal }), { code: 'busy' });
  const closing = f.runner.close(); held.resolve(structuredClone(authority)); await closing;
  assert((await results).every(value => value.status === 'rejected')); assert(!methods(f).includes('claim'));
});

test('prune is explicit, bounded, snapshotted and returns only its validated receipt', async t => {
  const f = fixture(t); await tick(); assert.equal(f.calls.length, 0);
  for (const input of [{}, { limit: 0 }, { limit: 257 }, { limit: '1' }, { limit: 1, token }]) {
    await assert.rejects(f.runner.prune(input, { signal: f.controller.signal }), { code: 'invalid_request' });
  }
  assert.deepEqual(await f.runner.prune({ limit: 256 }, { signal: f.controller.signal }), { status: 'pruned', count: 0 });
  assert.deepEqual(methods(f), ['prune']);
  const bad = fixture(t, { prune: () => ({ status: 'pruned', count: 2 }) });
  await assert.rejects(bad.runner.prune({ limit: 1 }, { signal: bad.controller.signal }), unknown);
});

test('caller cancellation cannot free a token admission slot while its ignored-abort dependency is pending', async t => {
  const held = deferred(), entered = deferred();
  const f = fixture(t, { claim: () => { entered.resolve(); return held.promise; } });
  const first = f.run(), firstRejected = assert.rejects(first, unknown); await entered.promise;
  f.controller.abort(); await firstRejected;
  const second = f.runner.run(token, f.handle, { signal: new AbortController().signal });
  const secondResult = second.then(value => ({ value }), error => ({ error }));
  try {
    await tick(); assert.equal(methods(f).filter(value => value === 'claim').length, 1);
    assert.equal((await secondResult).error?.code, 'busy');
  } finally { held.resolve({ status: 'empty' }); await f.runner.close(); await secondResult; }
});

test('malformed ACK shapes and bounded text validation never permit follow-up dispatch or finish', async t => {
  for (const bad of [input => ({ status: 'empty', extra: true }), input => ({ status: 'claimed', claimId: input.claimId,
    command: { ...item, bindingEpoch: 0 } }), input => ({ status: 'claimed', claimId: input.claimId,
    command: { ...item, text: 'ấ'.repeat(2731) } })]) {
    const f = fixture(t, { claim: bad }); await assert.rejects(f.run(), unknown); assert(!methods(f).includes('dispatch'));
  }
  for (const output of [{ text: 'a\0b' }, { text: 'ấ'.repeat(10923) }, { text: 'data', extra: true }]) {
    const f = fixture(t, { execute: () => output }); await assert.rejects(f.run(), unknown);
    assert(!methods(f).includes('finish')); assert(methods(f).includes('fail'));
  }
});
