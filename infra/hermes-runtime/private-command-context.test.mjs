import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createPrivateCommandRunner } from '../hermes-broker/private-command-runner.mjs';
import { createConnectionSupervisor } from './connection-supervisor.mjs';
import { createRuntimeGateway } from './runtime-gateway.mjs';
import { ProfileLeaseStore } from './profile-lease.mjs';
import { createDependencyScope } from '../hermes-broker/dependency-scope.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = 1800000000000, token = `hc_${'a'.repeat(43)}`;
const identity = Object.freeze({ connectionId: id(1), assistantId: id(2), userId: id(3), organizationId: id(4), expiresAt: NOW + 600000 });
const command = n => ({ ...identity, commandId: id(n), bindingId: id(6), bindingEpoch: 1, text: 'Phòng trống?', expiresAt: NOW + 300000 });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject }; };
const tick = () => new Promise(done => setImmediate(done));
const pending = async promise => { let settled = false; void promise.then(() => { settled = true; }, () => { settled = true; });
  await tick(); assert.equal(settled, false); };
const signal = () => new AbortController().signal;

async function fixture(t, hooks = {}) {
  const baseUrl = new URL('../../.cache/hermes-private-command-context/', import.meta.url);
  await mkdir(baseUrl, { recursive: true });
  const base = await realpath(baseUrl), root = await realpath(await mkdtemp(path.join(base, 'fixture-')));
  const home = path.join(root, 'home'); await mkdir(home);
  const scope = createDependencyScope(), events = [], contexts = [], modelInputs = [];
  let supervisor, handler, n = 20, runtimeHandle, time = NOW, resolveOwner = () => ({ ...identity });
  const backend = { async resolveConnection(value) { assert.equal(value, token); return resolveOwner(); }, async renewConnection() { throw Error('unused'); } };
  const gateway = createRuntimeGateway({ backend, dependencyScope: scope, clock: () => time,
    resolvePrivateCommandContext: (handle, binding) => supervisor.readPrivateCommandContext(handle, binding),
    transport: { async open(input) { handler = input.handler; return { descriptor: { networkName: 'fixture', networkId: 'b'.repeat(64),
      mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' }, async close() {} }; } },
    broker: { async authenticate() { return {}; }, async listTools() { return { tools: [] }; }, async callTool() { return { content: [], isError: false }; } },
    modelService: { beginCompletion(input) { modelInputs.push(input); return { result: Promise.resolve({ id: 'reply', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }] }), drained: Promise.resolve() }; } },
  });
  const runtime = {
    prepare({ binding }) { const handle = { gateway: gateway.prepare(binding) }; runtimeHandle = handle; return handle; },
    start(handle) { return gateway.start(handle.gateway); }, setAdmission(handle, allowed) { gateway.setAdmission(handle.gateway, allowed); },
    stop(handle) { return gateway.close(handle.gateway); },
    beginExecutePrivateCommand(handle, input, options) {
      events.push({ kind: 'runtime', input });
      if (options.commandContext) contexts.push(options.commandContext);
      let result;
      try {
        gateway.beginTurn(handle.gateway, { commandId: input.commandId, signal: options.signal,
          ...(options.commandContext ? { commandContext: options.commandContext } : {}) });
        result = Promise.resolve().then(() => hooks.execute?.({ gateway, handle: handle.gateway, input, options, scope, events }) ?? { text: 'OK' });
      } catch (error) { result = Promise.reject(error); }
      void result.catch(() => {});
      const drained = (async () => { await result.catch(() => {}); await hooks.runtimeDrain?.promise;
        await gateway.endTurn(handle.gateway, { commandId: input.commandId }); })();
      void drained.catch(() => {}); return { result, drained };
    },
  };
  supervisor = createConnectionSupervisor({ profileStore: new ProfileLeaseStore({ homeRoot: root, directory: path.join(root, 'leases') }),
    backend, runtime, dependencyScope: scope, clock: () => time,
    timers: { setTimeout() { return {}; }, clearTimeout() {} } });
  const registration = await gateway.register(token, { home });
  const handle = await supervisor.start({ token, home });
  const store = {
    async claimPrivateCommand(input) { events.push({ kind: 'claim', input }); return { status: 'claimed', claimId: input.claimId, command: command(n) }; },
    async dispatchPrivateCommand(input) { events.push({ kind: 'dispatch', input }); return hooks.dispatch ? hooks.dispatch(input, command(n))
      : { status: 'dispatched', claimId: input.claimId, commandId: id(n) }; },
    async finishPrivateCommand(input) { events.push({ kind: 'finish', input }); return { status: 'ready', claimId: input.claimId, commandId: id(n) }; },
    async failPrivateCommand(input) { events.push({ kind: 'fail', input }); return { status: 'unknown', claimId: input.claimId, commandId: id(n) }; },
    async prunePrivateCommands() { return { status: 'pruned', count: 0 }; },
  };
  const runner = createPrivateCommandRunner({ store, supervisor, resolveConnection: backend.resolveConnection, clock: () => time, dependencyScope: scope });
  t.after(async () => {
    hooks.cleanup?.(); hooks.runtimeDrain?.resolve();
    await Promise.allSettled([runner.close(), supervisor.close()]); await gateway.shutdown(); await gateway.releaseRegistration(registration); await scope.close();
    assert(path.resolve(root).startsWith(path.resolve(base) + path.sep)); await rm(root, { recursive: true, force: true });
  });
  return { gateway, supervisor, runner, scope, contexts, events, modelInputs, handle, home, runtimeHandle,
    bind: (number = n) => ({ token, ...Object.fromEntries(['connectionId', 'assistantId', 'userId', 'organizationId'].map(key => [key, identity[key]])), home, commandId: id(number) }),
    run: (controller = new AbortController()) => runner.beginRun(token, handle, { signal: controller.signal }),
    next() { n++; }, setOwner(value) { resolveOwner = () => value; }, setTime(value) { time = value; },
    async http(url, body) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.method = 'POST'; req.url = url;
      req.headers = { host: 'hermes-gateway:8787', 'content-type': 'application/json' }; req.rawHeaders = ['Host', req.headers.host, 'Content-Type', 'application/json'];
      const res = new EventEmitter(), done = deferred(); res.destroyed = false; res.writableEnded = false;
      res.writeHead = status => { res.status = status; }; res.end = value => { res.writableEnded = true; done.resolve({ status: res.status, body: value ? JSON.parse(value) : undefined }); };
      handler(req, res); return done.promise;
    },
  };
}

test('real runner → supervisor → gateway host callback carries the ACK claim and no wire credentials', async t => {
  let f, observed;
  f = await fixture(t, { async execute({ gateway, handle, input, options }) {
    assert(Object.isFrozen(options.commandContext)); assert.deepEqual(Reflect.ownKeys(options.commandContext), []);
    assert.deepEqual(Object.keys(input).sort(), ['bindingEpoch', 'bindingId', 'commandId', 'text']);
    observed = await gateway.withPrivateCommandContext(handle, { commandId: input.commandId, signal: options.signal }, value => {
      assert.equal(value.token, token); assert(value.signal instanceof AbortSignal); return value.commandContext;
    });
    const reply = await f.http('/v1/chat/completions', { model: 'fixture:model', messages: [{ role: 'user', content: input.text }], max_tokens: 10 });
    assert.equal(reply.status, 200); assert(!JSON.stringify(reply).includes(observed.claimId)); assert(!JSON.stringify(reply).includes(token));
    const malicious = await f.http('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'crm_group_room_preview', arguments: {} } });
    assert.equal(malicious.body.error, 'tool_not_available');
    return { text: 'OK' };
  } });
  const operation = f.run(); assert.deepEqual(await operation.result, { status: 'ready', commandId: id(20) }); await operation.drained;
  const dispatch = f.events.find(event => event.kind === 'dispatch'); assert.deepEqual(observed, { commandId: id(20), claimId: dispatch.input.claimId });
  assert(f.events.findIndex(event => event.kind === 'dispatch') < f.events.findIndex(event => event.kind === 'runtime'));
  assert.equal(f.modelInputs.length, 1); assert(!JSON.stringify(f.modelInputs[0].body).includes(dispatch.input.claimId));
  assert(!JSON.stringify(f.modelInputs[0].body).includes(token));
  assert.throws(() => f.supervisor.readPrivateCommandContext(f.contexts[0], f.bind()), /invalid_private_command_context/);
});

for (const mode of ['already_dispatched', 'wrong_claim', 'wrong_command', 'throw', 'timeout_cancel', 'deadline']) {
  test(`no context mint or runtime invocation for dispatch ${mode}`, async t => {
    const reached = deferred(), hold = deferred(), controller = new AbortController();
    let f; f = await fixture(t, { cleanup: () => hold.resolve(), async dispatch(input, item) {
      reached.resolve(); if (mode === 'throw') throw Error('unknown'); if (mode === 'timeout_cancel') await hold.promise;
      if (mode === 'deadline') f.setTime(NOW + 120001);
      return { status: mode === 'already_dispatched' ? mode : 'dispatched', claimId: mode === 'wrong_claim' ? id(999) : input.claimId,
        commandId: mode === 'wrong_command' ? id(999) : item.commandId };
    } });
    const run = f.run(controller); await reached.promise;
    if (mode === 'timeout_cancel') { controller.abort(); await assert.rejects(run.result, /private_command_outcome_unknown/); await pending(run.drained); hold.resolve(); }
    else await assert.rejects(run.result, /private_command_outcome_unknown/);
    await run.drained; assert.deepEqual(f.contexts, []); assert(!f.events.some(event => event.kind === 'runtime'));
  });
}

test('token, profile, connection, actor, org, assistant and command fences reject crossed host contexts', async t => {
  let f; const fences = [];
  f = await fixture(t, { async execute({ gateway, handle, input, options }) {
    const scope = f.bind(); assert.equal(f.supervisor.readPrivateCommandContext(options.commandContext, scope).commandId, input.commandId);
    for (const key of ['token', 'connectionId', 'assistantId', 'userId', 'organizationId', 'home', 'commandId']) {
      let rejected = false;
      try { f.supervisor.readPrivateCommandContext(options.commandContext, { ...scope, [key]: key === 'home' ? path.join(f.home, 'foreign') : id(999) }); }
      catch (error) { rejected = /invalid_private_command_context/.test(error.message); }
      fences.push({ key, rejected });
    }
    assert.throws(() => f.supervisor.readPrivateCommandContext(Object.freeze({}), scope), /invalid_private_command_context/);
    assert.throws(() => f.supervisor.readPrivateCommandContext(structuredClone(options.commandContext), scope), /invalid_private_command_context/);
    assert.throws(() => gateway.withPrivateCommandContext(handle, { commandId: id(999), signal: options.signal }, () => {}), /inactive/);
    let reads = 0; const bad = { ...scope }; Object.defineProperty(bad, 'token', { get() { reads++; return token; } });
    assert.throws(() => f.supervisor.readPrivateCommandContext(options.commandContext, bad), /invalid_private_command_context/); assert.equal(reads, 0);
    return { text: 'OK' };
  } });
  const op = f.run(); await op.result; await op.drained;
  assert.equal(fences.length, 7); assert.deepEqual(fences.filter(item => !item.rejected), []);
});

test('ordinary direct supervisor commands have no trusted claim and cannot invoke the preview seam', async t => {
  const f = await fixture(t, { execute({ gateway, handle, input, options }) {
    assert.equal(options.commandContext, undefined);
    return gateway.withPrivateCommandContext(handle, { commandId: input.commandId, signal: options.signal }, () => { throw Error('must not invoke'); });
  } });
  await assert.rejects(f.supervisor.executePrivateCommand(f.handle, command(20)), /private_command_failed/); assert.deepEqual(f.contexts, []);
});

test('gateway rejects a fabricated empty context before activating a turn or invoking trusted work', async t => {
  const f = await fixture(t);
  assert.throws(() => f.gateway.beginTurn(f.runtimeHandle.gateway, { commandId: id(999), signal: signal(), commandContext: Object.freeze({}) }), /context_changed/);
  assert.throws(() => f.gateway.withPrivateCommandContext(f.runtimeHandle.gateway, { commandId: id(999), signal: signal() }, () => { throw Error('unexpected'); }), /inactive/);
  const operation = f.run(); await operation.result; await operation.drained;
});

test('trusted dispatch port snapshots only token and claim ID, rejecting foreign tokens, fields and getters', async t => {
  const f = await fixture(t); let getters = 0;
  for (const dispatch of [{ token: `hc_${'b'.repeat(43)}`, claimId: id(700) }, { token, claimId: 'invalid' },
    { token, claimId: id(700), userId: identity.userId }, { get token() { getters++; return token; }, claimId: id(700) },
    { token, get claimId() { getters++; return id(700); } }]) {
    await assert.rejects(f.supervisor.executeDispatchedPrivateCommand(f.handle, command(20), dispatch), /invalid_private_command/);
  }
  assert.equal(getters, 0); assert.deepEqual(f.contexts, []); assert(!f.events.some(event => event.kind === 'runtime'));
});

test('claim retained until actual gateway dependency drain; abort disables reads without releasing profile or runner', async t => {
  const entered = deferred(), inner = deferred(), toolObserved = deferred(); let f;
  f = await fixture(t, { cleanup: () => inner.resolve(), async execute({ gateway, handle, input, options, scope }) {
    const work = gateway.withPrivateCommandContext(handle, { commandId: input.commandId, signal: options.signal }, () => {
      void scope.track(async () => { entered.resolve(); await inner.promise; });
      throw Error('synthetic early dependency observer');
    });
    void work.catch(() => toolObserved.resolve()); await entered.promise;
    return { text: 'OK' };
  } });
  const controller = new AbortController(), op = f.run(controller); await entered.promise; const context = f.contexts[0];
  controller.abort(); await assert.rejects(op.result, /private_command_outcome_unknown/); await pending(op.drained); await toolObserved.promise;
  assert.throws(() => f.supervisor.readPrivateCommandContext(context, f.bind()), /private_command_context_inactive/);
  assert.equal(f.supervisor.status(f.handle).state, 'reconnect_required');
  let closed = false; const closing = f.supervisor.close().then(() => { closed = true; }); await tick(); assert.equal(closed, false);
  inner.resolve(); await op.drained; await closing;
  assert.throws(() => f.supervisor.readPrivateCommandContext(context, f.bind()), /invalid_private_command_context/);
});

test('new turn cannot reuse retired context; command dedup and active-turn ownership remain authoritative', async t => {
  let f, prior;
  f = await fixture(t, { execute({ gateway, handle, input, options }) {
    if (prior) {
      assert.notEqual(options.commandContext, prior);
      assert.throws(() => f.supervisor.readPrivateCommandContext(prior, f.bind(20)), /invalid_private_command_context/);
      assert.throws(() => gateway.beginTurn(handle, { commandId: id(999), signal: options.signal, commandContext: prior }), /busy/);
    }
    prior = options.commandContext; return { text: 'OK' };
  } });
  const first = f.run(); await first.result; await first.drained; f.next(); const second = f.run(); await second.result; await second.drained;
  assert.equal(f.contexts.length, 2); await assert.rejects(f.supervisor.executeDispatchedPrivateCommand(f.handle, command(21), { token, claimId: id(900) }), /private_command_duplicate/);
});

test('rejected actual drain retains an unusable context and never reports it as normally retired', async t => {
  const runtimeDrain = deferred(), entered = deferred();
  const f = await fixture(t, { runtimeDrain, execute() { entered.resolve(); return { text: 'OK' }; } });
  const operation = f.run(); await entered.promise; runtimeDrain.reject(Error('synthetic unproven drain'));
  await assert.rejects(operation.result, /private_command_outcome_unknown/); await operation.drained;
  assert.throws(() => f.supervisor.readPrivateCommandContext(f.contexts[0], f.bind()), /private_command_context_inactive/);
});
