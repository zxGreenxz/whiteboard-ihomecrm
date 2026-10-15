import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHermesHost, preflightHostEngine } from './host-service.mjs';
import { HERMES_IMAGE, HERMES_COMMIT } from './runtime-contract.mjs';
import { createHermesBackend } from '../hermes-broker/server.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
test('real host preflight checks the pinned image against bundled provenance before serving', async () => {
  const provenance = JSON.parse(await readFile(new URL('./image-provenance.json', import.meta.url), 'utf8'));
  const image = { Id: provenance.expectedConfigDigest, RepoDigests: [HERMES_IMAGE], Os: 'linux', Architecture: 'amd64',
    Config: { Labels: { 'org.opencontainers.image.revision': HERMES_COMMIT } } };
  const signal = new AbortController().signal, calls = [];
  const engine = { async preflight(options) { assert.equal(options.signal, signal); calls.push('preflight'); },
    async inspectImage(pin, options) { assert.equal(pin, HERMES_IMAGE); assert.equal(options.signal, signal); calls.push('inspect'); return image; } };
  await preflightHostEngine(engine, signal); assert.deepEqual(calls, ['preflight', 'inspect']);
  image.Id = 'sha256:' + '0'.repeat(64); await assert.rejects(preflightHostEngine(engine, signal));
});
function fixture(t, changes = {}) {
  const events = [], server = createServer((_req, res) => res.end('fixture'));
  const key = Buffer.alloc(32, 7), signal = new AbortController().signal;
  let closes = 0, stage;
  const configuration = { paths: { stateRoot: '/state', homeRoot: '/state/homes', leaseDirectory: '/state/homes/.leases',
    handoffDirectory: '/state/handoff', runtimeRoot: '/state/runtime', gatewayRoot: '/state/gateway' },
    supabase: {}, store: { role: 'hermes_store_fixture' }, encryption: { activeKeyVersion: 'k1', keys: new Map([['k1', key]]) },
    http: {}, ...(changes.connectorOnly ? { mode: 'connector' } : { model: { model: 'fixture', maxTokens: 1024, maxIterations: 4, allowedModels: ['fixture'] } }), listenPort: 0,
    dispose() { events.push('dispose'); key.fill(0); } };
  const handoff = { stage: async () => {}, async list() { events.push('list'); await changes.list?.(); return []; },
    async close() { events.push('wal-close'); await changes.walClose?.(); } };
  const gateway = {}, supervisor = {}, runner = {}, profileHomes = {}, profileStore = {}, transport = {}, engine = {}, runtime = {};
  const backend = { server,
    startWorkMemoryRetention() { assert(server.listening); events.push('retention-start'); },
    createRuntimeGateway(options) { assert.equal(options.transport, transport); assert.deepEqual(options.allowedModels, ['fixture']); return gateway; },
    createRuntimeSupervisor(options) { assert.equal(options.profileStore, profileStore); assert.equal(options.runtime, runtime); return supervisor; },
    createPrivateCommandRunner(value) { assert.equal(value, supervisor); return runner; },
    async close() { if (closes++) return; events.push('backend-close'); await changes.backendClose?.(); } };
  const factories = {
    async acquireHostOwnership(options) { assert.deepEqual(options, { stateRoot: '/state' }); events.push('lock'); await changes.lock?.();
      return { async release() { events.push('release'); await changes.release?.(); } }; },
    async prepareState() { events.push('state'); return '/state/audit'; },
    async artifacts() { assert(!changes.connectorOnly); return { wrapperPath: '/code/agent.py', wrapperSha256: 'a'.repeat(64), relayPath: '/code/relay.mjs', relaySha256: 'b'.repeat(64) }; },
    createDockerEngine() { assert(!changes.connectorOnly); return engine; },
    async preflight(value, passedSignal) { assert.equal(value, engine); assert(passedSignal instanceof AbortSignal); events.push('preflight'); await changes.preflight?.(); },
    createHostAudit() { return { write: async () => {}, async close() { events.push('audit-close'); await changes.auditClose?.(); } }; },
    createConnectionHandoff(options) { assert.equal(options.keys.get('k1')[0], 7); events.push('wal-copy'); return handoff; },
    createStorePool() { events.push('pool'); return { async end() { events.push('pool-close'); await changes.poolClose?.(); } }; },
    createHermesBackend(options) { events.push('backend-copy'); assert.equal(options.encryption.keys.get('k1')[0], 7);
      if (changes.connectorOnly) assert.equal(options.connectorOnly, true);
      assert.deepEqual(Object.keys(options.handoff), ['stage']); stage = options.handoff.stage; return backend; },
    createGatewayTransport(options) { assert.equal(options.engine, engine); return transport; },
    createContainerRuntime(options) { assert.equal(options.gateway, gateway); assert.equal(options.engine, engine); return runtime; },
    createProfileHomes() { return profileHomes; }, createProfileStore() { return profileStore; },
    createRuntimeOrchestrator(options) {
      assert.equal(options.backend, backend); assert.equal(options.supervisor, supervisor); assert.equal(options.runner, runner);
      return { start() { events.push('orchestrator-start'); assert(server.listening); changes.start?.(); },
        async close() { events.push('orchestrator-stop');
          // Match the actual orchestrator: initiate runtime stop before awaiting ingress.
          const ingress = options.closeIngress(); events.push('runtime-stop'); changes.runtimeStop?.(); await ingress;
          await changes.orchestratorClose?.(); await backend.close(); await options.closePool();
        } };
    },
    createHandoffReconciler(options) { assert.equal(options.backend, backend); assert.equal(options.handoff, handoff);
      return { start() { events.push('reconciler-start'); assert(server.listening); },
        async close() { events.push('reconciler-stop'); await changes.reconcilerClose?.(); } }; },
    createConnectorMaintenance(options) { assert(changes.connectorOnly); assert.equal(options.backend, backend); assert.equal(options.handoff, handoff);
      return { start() { events.push('connector-maintenance-start'); assert(server.listening); },
        async close() { events.push('connector-maintenance-stop'); await changes.reconcilerClose?.(); } }; },
  };
  const host = createHermesHost(configuration, { factories });
  t.after(async () => { await host.close().catch(() => {}); server.close(); server.closeAllConnections(); });
  return { host, events, server, key, handoff, get stage() { return stage; }, signal };
}

test('product composition is inert until start, requires WAL, binds loopback and disposes original keys after both copies', async t => {
  const f = fixture(t); assert.deepEqual(f.events, []); assert.equal(f.host.status().state, 'idle');
  const start = f.host.start(); assert.equal(f.host.start(), start); await start;
  assert.equal(f.server.address().address, '127.0.0.1'); assert.equal(f.stage, f.handoff.stage);
  assert.equal(f.key.every(value => value === 0), true); assert.equal(f.events.filter(value => value === 'dispose').length, 1);
  assert(f.events.indexOf('backend-copy') < f.events.indexOf('dispose')); assert(f.events.indexOf('wal-copy') < f.events.indexOf('dispose'));
  assert(f.events.indexOf('list') < f.events.indexOf('backend-copy'));
  assert.equal(f.events.filter(value => value === 'retention-start').length, 1);
  assert.equal(f.host.status().state, 'running'); const close = f.host.close(); assert.equal(f.host.close(), close); await close;
  assert.equal(f.server.listening, false); assert.equal(f.host.status().state, 'closed');
  assert.deepEqual(f.events.slice(-5), ['backend-close', 'wal-close', 'pool-close', 'audit-close', 'release']);
  await assert.rejects(f.host.start(), /host_stopped/);
});

test('connector host starts without a model, Docker, personal homes or runtime and drains maintenance before key cleanup', async t => {
  const drain = deferred(), entered = deferred();
  const f = fixture(t, { connectorOnly: true, reconcilerClose: () => { entered.resolve(); return drain.promise; } });
  await f.host.start(); assert(f.events.includes('connector-maintenance-start'));
  assert(!f.events.includes('preflight')); assert(!f.events.includes('orchestrator-start'));
  const close = f.host.close(); await entered.promise;
  assert(!f.events.includes('backend-close')); assert(!f.events.includes('release')); drain.resolve(); await close;
  assert.deepEqual(f.events.slice(-5), ['backend-close', 'wal-close', 'pool-close', 'audit-close', 'release']);
});

test('shutdown starts runtime stop while reconciliation drains, and keeps keys/pool/WAL/lock until that barrier', async t => {
  const draining = deferred(), stopped = deferred();
  const f = fixture(t, { reconcilerClose: () => draining.promise, runtimeStop: () => stopped.resolve() });
  await f.host.start(); const close = f.host.close(); await stopped.promise;
  assert(!f.events.includes('backend-close')); assert(!f.events.includes('pool-close')); assert(!f.events.includes('wal-close')); assert(!f.events.includes('release'));
  assert.equal(f.server.listening, false); draining.resolve(); await close;
  assert.equal(f.events.filter(value => value === 'reconciler-stop').length, 1); assert(f.events.includes('release'));
});

test('stop during startup waits actual preflight, never listens and disposes secret buffers', async t => {
  const work = deferred(), entered = deferred();
  const f = fixture(t, { preflight: () => { entered.resolve(); return work.promise; } });
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

test('reconciler unknown drain retains host lock and never destroys backend/WAL or closes pool', async t => {
  const f = fixture(t, { reconcilerClose: async () => { throw Error('PRIVATE ACTUAL WORK'); } });
  await f.host.start(); const close = f.host.close(); await assert.rejects(close, /host_shutdown_retained/);
  assert.equal(f.host.close(), close); assert.equal(f.host.status().state, 'retained');
  for (const value of ['backend-close', 'wal-close', 'pool-close', 'audit-close', 'release']) assert(!f.events.includes(value), value);
});

test('post-listen server error closes runtime through the normal drain and rejects finished without exposing the error', async t => {
  const work = deferred(), entered = deferred();
  const f = fixture(t, { reconcilerClose: () => { entered.resolve(); return work.promise; } });
  await f.host.start(); let finished = false;
  const result = assert.rejects(f.host.finished, error => error.message === 'host_failed').then(() => { finished = true; });
  assert.doesNotThrow(() => f.server.emit('error', new Error('PRIVATE SOCKET DETAILS')));
  await entered.promise; assert.equal(finished, false); assert(!f.events.includes('release')); assert(!f.events.includes('backend-close'));
  work.resolve(); await result; await f.host.close(); assert.equal(f.host.status().state, 'failed'); assert(f.events.includes('release'));
});

test('fatal listener error with unknown drain rejects finished as retained and keeps ownership', async t => {
  const f = fixture(t, { reconcilerClose: async () => { throw Error('PRIVATE'); } }); await f.host.start();
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

test('actual backend, gateway, driver, supervisor, runner and both loops compose behind the real loopback listener', async () => {
  const key = Buffer.alloc(32, 19), events = [];
  let server, lists = 0;
  const configuration = { paths: { stateRoot: '/state', homeRoot: '/state/homes', leaseDirectory: '/state/homes/.leases',
    handoffDirectory: '/state/handoff', runtimeRoot: '/state/runtime', gatewayRoot: '/state/gateway' },
    supabase: { url: 'https://fixture.supabase.co', publishableKey: 'sb_publishable_fixture' },
    store: { role: 'hermes_store_fixture' }, encryption: { activeKeyVersion: 'k1', keys: new Map([['k1', key]]) },
    http: { allowedHosts: ['broker.example:8443'], allowedOrigins: ['https://crm.example'] },
    model: { model: 'openai:fixture', maxTokens: 1024, maxIterations: 4, allowedModels: ['openai:fixture'] }, listenPort: 0,
    dispose() { key.fill(0); } };
  const host = createHermesHost(configuration, { factories: {
    async acquireHostOwnership() { return { async release() { events.push('release'); } }; },
    async prepareState() { return '/state/audit'; },
    async preflight() {}, // Native Docker execution is exercised in the Linux product harness.
    createHostAudit() { return { async write() {}, async close() { events.push('audit-close'); } }; },
    createConnectionHandoff() { return { async list() { lists++; return []; }, async stage() {}, async close() { events.push('wal-close'); } }; },
    createStorePool() { return { async connect() { throw Error('unexpected external SQL'); }, async end() { events.push('pool-close'); } }; },
    createHermesBackend(config) { const value = createHermesBackend({ ...config, fetch: async () => { throw Error('unexpected external HTTP'); } }); server = value.server; return value; },
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
    assert.equal(lists, 2); // Startup validation plus actual reconciler discovery.
  } finally { await host.close(); }
  assert.equal(server.listening, false); assert.equal(host.status().state, 'closed');
  assert.deepEqual(events, ['wal-close', 'pool-close', 'audit-close', 'release']);
});
