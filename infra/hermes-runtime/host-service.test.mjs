import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHermesHost } from './host-service.mjs';
import { createHermesBackend } from '../hermes-broker/server.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const connectorLimits = Object.freeze({ requestsPerMinute: 60, toolCallsPerMinute: 30, callTimeoutMs: 10_000, maintenanceWaitMs: 5000 });
function fixture(t, changes = {}) {
  const events = [], server = createServer((_req, res) => res.end('fixture'));
  const key = Buffer.alloc(32, 7);
  let closes = 0, stage, callLog, maintenanceLog;
  const configuration = { paths: { stateRoot: '/state', handoffDirectory: '/state/handoff' },
    supabase: {}, store: { role: 'hermes_store_fixture' }, encryption: { activeKeyVersion: 'k1', keys: new Map([['k1', key]]) },
    ...(changes.zaloProvisioning ? { zaloProvisioning: changes.zaloProvisioning } : {}),
    http: {}, mode: 'connector', limits: connectorLimits, listenPort: 0,
    ...(changes.readFastPath === undefined ? {} : { readFastPath: changes.readFastPath }),
    ...(changes.roomRead === undefined ? {} : { roomRead: changes.roomRead }),
    dispose() { events.push('dispose'); key.fill(0); } };
  const handoff = { stage: async () => {}, async list() { events.push('list'); await changes.list?.(); return []; },
    async close() { events.push('wal-close'); await changes.walClose?.(); } };
  const backend = { server,
    startWorkMemoryRetention() { assert(server.listening); events.push('retention-start'); },
    async close() { if (closes++) return; events.push('backend-close'); await changes.backendClose?.(); } };
  const factories = {
    async acquireHostOwnership(options) { assert.deepEqual(options, { stateRoot: '/state' }); events.push('lock'); await changes.lock?.();
      return { async release() { events.push('release'); await changes.release?.(); } }; },
    async prepareState(paths) { assert.equal(paths, configuration.paths); events.push('state'); return '/state/audit'; },
    createHostAudit() { return { write: async () => {}, async close() { events.push('audit-close'); await changes.auditClose?.(); } }; },
    createConnectionHandoff(options) { assert.equal(options.keys.get('k1')[0], 7); events.push('wal-copy'); return handoff; },
    createStorePool() { events.push('pool'); return { async connect(){throw Error('unexpected fixture SQL');}, async end() { events.push('pool-close'); await changes.poolClose?.(); } }; },
    createHermesBackend(options) { events.push('backend-copy'); assert.equal(options.encryption.keys.get('k1')[0], 7);
      assert.equal(options.connectorOnly, true); assert.equal(options.limits, connectorLimits);
      assert.equal(options.readFastPath, changes.readFastPath);
      assert.equal(options.roomRead, changes.roomRead);
      assert.equal(typeof options.callLog, changes.callLogOff ? 'undefined' : 'function'); callLog = options.callLog;
      assert.deepEqual(Object.keys(options.handoff), ['stage']); stage = options.handoff.stage; return backend; },
    createNativeBindingReconciler(options) {
      assert.equal(options.handoff,handoff);assert.equal(options.backend,backend);
      assert.equal(options.configuration,changes.zaloProvisioning);events.push('zalo-reconciler-create');
      return {start(){assert(server.listening);events.push('zalo-reconciler-start');},
        status(){return{state:'pending',pending:1};},
        async close(){events.push('zalo-reconciler-stop');await changes.zaloClose?.();}};
    },
    createConnectorMaintenance(options) { assert.equal(options.backend, backend); assert.equal(options.handoff, handoff);
      assert.deepEqual(Object.keys(options), ['handoff', 'backend', 'log']); assert.equal(typeof options.log, 'function'); maintenanceLog = options.log;
      return { start() { events.push('connector-maintenance-start'); assert(server.listening); },
        async close() { events.push('connector-maintenance-stop'); await changes.maintenanceClose?.(); } }; },
  };
  const host = createHermesHost(configuration, { factories });
  t.after(async () => { await host.close().catch(() => {}); server.close(); server.closeAllConnections(); });
  return { host, events, server, key, handoff, get stage() { return stage; }, get callLog() { return callLog; }, get maintenanceLog() { return maintenanceLog; } };
}

test('connector composition is inert until start, requires WAL, binds loopback and disposes original keys after both copies', async t => {
  const f = fixture(t); assert.deepEqual(f.events, []); assert.equal(f.host.status().state, 'idle');
  const start = f.host.start(); assert.equal(f.host.start(), start); await start;
  assert.equal(f.server.address().address, '127.0.0.1'); assert.equal(f.stage, f.handoff.stage);
  assert.equal(f.key.every(value => value === 0), true); assert.equal(f.events.filter(value => value === 'dispose').length, 1);
  assert(f.events.indexOf('backend-copy') < f.events.indexOf('dispose')); assert(f.events.indexOf('wal-copy') < f.events.indexOf('dispose'));
  assert(f.events.indexOf('list') < f.events.indexOf('backend-copy'));
  assert.equal(f.events.filter(value => value === 'retention-start').length, 1);
  assert.equal(f.events.filter(value => value === 'connector-maintenance-start').length, 1);
  assert.equal(f.host.status().state, 'running'); const close = f.host.close(); assert.equal(f.host.close(), close); await close;
  assert.equal(f.server.listening, false); assert.equal(f.host.status().state, 'closed');
  assert.deepEqual(f.events.slice(-5), ['backend-close', 'wal-close', 'pool-close', 'audit-close', 'release']);
  await assert.rejects(f.host.start(), /host_stopped/);
});

test('only a connector configuration composes a host; the removed managed (version 1) mode is refused before any I/O', () => {
  const base = { paths: { stateRoot: '/state', handoffDirectory: '/state/handoff' }, listenPort: 0, dispose() {} };
  for (const configuration of [{ ...base }, { ...base, mode: 'managed' },
    { ...base, model: { model: 'openai:fixture', maxTokens: 1024, maxIterations: 4, allowedModels: ['openai:fixture'] } }]) {
    assert.throws(() => createHermesHost(configuration), /invalid_host_configuration/);
  }
  for (const factory of ['createDockerEngine', 'createRuntimeOrchestrator', 'createHandoffReconciler', 'preflight']) {
    assert.throws(() => createHermesHost({ ...base, mode: 'connector' }, { factories: { [factory]: () => {} } }), /invalid_host_configuration/);
  }
});

test('host forwards the explicit private read rollout flag to the backend', async t => {
  const f = fixture(t, { readFastPath: true }); await f.host.start(); await f.host.close();
});

test('host forwards the explicit room read source flag to the backend and omits it by default', async t => {
  for (const roomRead of [undefined, 'legacy', 'page']) {
    const f = fixture(t, roomRead === undefined ? {} : { roomRead }); await f.host.start(); await f.host.close();
  }
});

test('connector shutdown closes the listener while maintenance drains and keeps keys/pool/WAL/lock until that barrier', async t => {
  const drain = deferred(), entered = deferred();
  const f = fixture(t, { maintenanceClose: () => { entered.resolve(); return drain.promise; } });
  await f.host.start(); const close = f.host.close(); await entered.promise;
  for (const value of ['backend-close', 'pool-close', 'wal-close', 'release']) assert(!f.events.includes(value), value);
  assert.equal(f.server.listening, false); drain.resolve(); await close;
  assert.equal(f.events.filter(value => value === 'connector-maintenance-stop').length, 1);
  assert.deepEqual(f.events.slice(-5), ['backend-close', 'wal-close', 'pool-close', 'audit-close', 'release']);
});

test('stop during startup waits actual WAL validation, never listens and disposes secret buffers', async t => {
  const work = deferred(), entered = deferred();
  const f = fixture(t, { list: () => { entered.resolve(); return work.promise; } });
  const start = f.host.start(); void start.catch(() => {}); await entered.promise;
  let closed = false; const close = f.host.close().then(() => { closed = true; }); await tick();
  assert.equal(closed, false); assert(!f.events.includes('release')); work.resolve();
  await assert.rejects(start, /host_start_failed/); await close;
  assert(!f.events.includes('pool')); assert(!f.server.listening); assert(f.events.includes('release')); assert(f.key.every(value => value === 0));
});

test('tampered or unreadable WAL rejects before enrollment/listen, and cleans constructed owners', async t => {
  const f = fixture(t, { list: () => { throw Error('PRIVATE WAL'); } });
  await assert.rejects(f.host.start(), error => error.message === 'host_start_failed');
  assert(!f.events.includes('backend-copy')); assert(!f.events.includes('pool')); assert(!f.server.listening);
  assert.deepEqual(f.events.slice(-3), ['wal-close', 'audit-close', 'release']);
});

test('maintenance unknown drain retains host lock and never destroys backend/WAL or closes pool', async t => {
  const f = fixture(t, { maintenanceClose: async () => { throw Error('PRIVATE ACTUAL WORK'); } });
  await f.host.start(); const close = f.host.close(); await assert.rejects(close, /host_shutdown_retained/);
  assert.equal(f.host.close(), close); assert.equal(f.host.status().state, 'retained');
  for (const value of ['backend-close', 'wal-close', 'pool-close', 'audit-close', 'release']) assert(!f.events.includes(value), value);
});

test('post-listen server error closes through the normal maintenance drain and rejects finished without exposing the error', async t => {
  const work = deferred(), entered = deferred();
  const f = fixture(t, { maintenanceClose: () => { entered.resolve(); return work.promise; } });
  await f.host.start(); let finished = false;
  const result = assert.rejects(f.host.finished, error => error.message === 'host_failed').then(() => { finished = true; });
  assert.doesNotThrow(() => f.server.emit('error', new Error('PRIVATE SOCKET DETAILS')));
  await entered.promise; assert.equal(finished, false); assert(!f.events.includes('release')); assert(!f.events.includes('backend-close'));
  work.resolve(); await result; await f.host.close(); assert.equal(f.host.status().state, 'failed'); assert(f.events.includes('release'));
});

test('fatal listener error with unknown drain rejects finished as retained and keeps ownership', async t => {
  const f = fixture(t, { maintenanceClose: async () => { throw Error('PRIVATE'); } }); await f.host.start();
  f.server.emit('error', new Error('PRIVATE SOCKET DETAILS'));
  await assert.rejects(f.host.finished, /host_shutdown_retained/); await assert.rejects(f.host.close(), /host_shutdown_retained/);
  assert(!f.events.includes('release')); assert.equal(f.host.status().state, 'retained');
});

test('clean explicit close resolves finished only after all shutdown owners settle', async t => {
  const pending = deferred(), entered = deferred(); const f = fixture(t, { poolClose: () => { entered.resolve(); return pending.promise; } });
  await f.host.start(); let done = false; void f.host.finished.then(() => { done = true; });
  const closed = f.host.close(); await entered.promise; assert.equal(done, false); pending.resolve();
  await closed; await f.host.finished; assert.equal(done, true); assert(f.events.includes('release'));
});

test('late shutdown failure preserves host ownership and sanitized error', async t => {
  for (const boundary of ['backendClose', 'walClose', 'poolClose', 'auditClose']) {
    await t.test(boundary, async st => {
      const f = fixture(st, { [boundary]: async () => { throw Error('PRIVATE PASSWORD'); } });
      await f.host.start(); await assert.rejects(f.host.close(), error => error.message === 'host_shutdown_retained');
      assert(!f.events.includes('release')); assert.equal(f.host.status().state, 'retained');
    });
  }
});

test('close before start erases loaded keys without acquiring anything', async t => {
  const f = fixture(t); await f.host.close(); assert.deepEqual(f.events, ['dispose']);
  assert(f.key.every(value => value === 0)); await assert.rejects(f.host.start(), /host_stopped/);
});

test('actual backend and connector maintenance compose behind the real loopback listener', async () => {
  const key = Buffer.alloc(32, 19), events = [];
  let server, lists = 0;
  const configuration = { paths: { stateRoot: '/state', handoffDirectory: '/state/handoff' },
    supabase: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' },
    store: { role: 'hermes_store_fixture' }, encryption: { activeKeyVersion: 'k1', keys: new Map([['k1', key]]) },
    http: { allowedHosts: ['broker.example:8443'], allowedOrigins: ['https://crm.example'] },
    mode: 'connector', limits: connectorLimits, listenPort: 0,
    dispose() { key.fill(0); } };
  const host = createHermesHost(configuration, { factories: {
    async acquireHostOwnership() { return { async release() { events.push('release'); } }; },
    async prepareState() { return '/state/audit'; },
    createHostAudit() { return { async write() {}, async close() { events.push('audit-close'); } }; },
    createConnectionHandoff() { return { async list() { lists++; return []; }, async stage() {}, async close() { events.push('wal-close'); } }; },
    createStorePool() { return { async connect() { throw Error('unexpected external SQL'); }, async end() { events.push('pool-close'); } }; },
    createHermesBackend(config) {
      assert.equal(config.connectorOnly, true);
      const value = createHermesBackend({ ...config, fetch: async () => { throw Error('unexpected external HTTP'); } }); server = value.server; return value;
    },
  } });
  try {
    await host.start(); assert.equal(host.status().state, 'running'); assert(key.every(value => value === 0));
    const response = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/api/hermes/connections/list',
        headers: { host: 'broker.example:8443', 'content-type': 'application/json' } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      }); req.on('error', reject); req.end(JSON.stringify({ organizationId: '20000000-0000-4000-8000-000000000001' }));
    });
    assert.deepEqual(response, { status: 401, body: { error: 'reauthentication_required' } });
    assert.equal(lists, 2); // Startup validation plus the first actual maintenance cycle.
  } finally { await host.close(); }
  assert.equal(server.listening, false); assert.equal(host.status().state, 'closed');
  assert.deepEqual(events, ['wal-close', 'pool-close', 'audit-close', 'release']);
});

test('optional native provisioning shares the host lifecycle and retains WAL/pool until its actual drain',async t=>{
  const pending=deferred(),entered=deferred();
  const f=fixture(t,{zaloProvisioning:{profiles:[]},zaloClose:()=>{entered.resolve();return pending.promise;}});
  await f.host.start();
  assert(f.events.includes('zalo-reconciler-create'));assert(f.events.includes('zalo-reconciler-start'));
  assert.deepEqual(f.host.status().zaloProvisioning,{state:'pending',pending:1});
  const closing=f.host.close();await entered.promise;
  assert(!f.events.includes('pool-close'));assert(!f.events.includes('wal-close'));assert(!f.events.includes('release'));
  pending.resolve();await closing;assert(f.events.includes('pool-close'));assert(f.events.includes('release'));
});

test('tool_call_timing sink: one stdout JSON line per record like host_* events; HERMES_CALL_LOG=0 passes no callLog', async t => {
  const previous = process.env.HERMES_CALL_LOG;
  t.after(() => { if (previous === undefined) delete process.env.HERMES_CALL_LOG; else process.env.HERMES_CALL_LOG = previous; });
  delete process.env.HERMES_CALL_LOG;
  const on = fixture(t); await on.host.start();
  const info = t.mock.method(console, 'info', () => {});
  const record = { event: 'tool_call_timing', ts: '2026-10-20T00:00:00.000Z', operation: 'tools/call', tool: 'crm_auth_context', totalMs: 3 };
  on.callLog(record);
  assert.equal(info.mock.callCount(), 1); assert.deepEqual(info.mock.calls[0].arguments, [JSON.stringify(record)]);
  info.mock.restore(); await on.host.close();
  process.env.HERMES_CALL_LOG = '0';
  const off = fixture(t, { callLogOff: true }); await off.host.start(); assert.equal(off.callLog, undefined); await off.host.close();
});

test('connector maintenance sink: one stdout JSON line per record, and HERMES_CALL_LOG=0 does not silence it', async t => {
  const previous = process.env.HERMES_CALL_LOG;
  t.after(() => { if (previous === undefined) delete process.env.HERMES_CALL_LOG; else process.env.HERMES_CALL_LOG = previous; });
  process.env.HERMES_CALL_LOG = '0';
  const f = fixture(t, { callLogOff: true }); await f.host.start();
  const info = t.mock.method(console, 'info', () => {});
  const record = { event: 'connector_maintenance_connection', ts: '2026-10-21T08:46:00.000Z', connectionId: '1a2b3c4d', action: 'renewal_failed',
    code: 'maintenance_outcome_unknown', attempt: 1, retryInMs: 30000, expiresInMs: 270000 };
  f.maintenanceLog(record);
  assert.equal(info.mock.callCount(), 1); assert.deepEqual(info.mock.calls[0].arguments, [JSON.stringify(record)]);
  info.mock.restore(); await f.host.close();
});
