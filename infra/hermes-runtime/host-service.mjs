import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorePool } from '../hermes-broker/store-pool.mjs';
import { createConnectionHandoff } from '../hermes-broker/connection-handoff.mjs';
import { createHermesBackend } from '../hermes-broker/server.mjs';
import { createConnectorMaintenance } from '../hermes-broker/connector-maintenance.mjs';
import { createDockerEngine, createContainerRuntime } from './container-driver.mjs';
import { createGatewayTransport } from './gateway-transport.mjs';
import { createProfileHomes } from './profile-homes.mjs';
import { ProfileLeaseStore } from './profile-lease.mjs';
import { createRuntimeOrchestrator } from './runtime-orchestrator.mjs';
import { createHandoffReconciler } from './handoff-reconciler.mjs';
import { HERMES_IMAGE, assertPinnedImageInspection } from './runtime-contract.mjs';
import { acquireHostOwnership, createHostAudit } from './host-ownership.mjs';

const fail = code => { throw new Error(code); };
const invoke = fn => { try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); } };
async function prepareState(paths, { connectorOnly = false } = {}) {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.getgid() === 0) fail('host_native_nonroot_linux_required');
  const expected = connectorOnly ? { handoffDirectory: 'handoff' }
    : { homeRoot: 'homes', handoffDirectory: 'handoff', runtimeRoot: 'runtime', gatewayRoot: 'gateway' };
  const check = async target => {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.gid !== process.getgid() ||
        (info.mode & 0o777) !== 0o700 || await realpath(target) !== target) fail('host_state_refused');
  };
  await check(paths.stateRoot);
  for (const [key, relative] of Object.entries(expected)) {
    if (paths[key] !== path.join(paths.stateRoot, relative)) fail('host_state_refused');
    try { await mkdir(paths[key], { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await check(paths[key]);
  }
  if (paths.leaseDirectory !== path.join(paths.homeRoot, '.leases')) fail('host_state_refused');
  const auditDirectory = path.join(paths.stateRoot, 'audit');
  try { await mkdir(auditDirectory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await check(auditDirectory);
  return auditDirectory;
}
async function artifacts() {
  const wrapperPath = fileURLToPath(new URL('./agent-process.py', import.meta.url));
  const relayPath = fileURLToPath(new URL('./gateway-relay.mjs', import.meta.url));
  const [wrapper, relay] = await Promise.all([readFile(wrapperPath), readFile(relayPath)]);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  return { wrapperPath, wrapperSha256: hash(wrapper), relayPath, relaySha256: hash(relay) };
}
export async function preflightHostEngine(engine, signal) {
  const provenance = JSON.parse(await readFile(new URL('./image-provenance.json', import.meta.url), 'utf8'));
  await engine.preflight({ signal });
  assertPinnedImageInspection(await engine.inspectImage(HERMES_IMAGE, { signal }), provenance);
}
const DEFAULTS = Object.freeze({
  acquireHostOwnership, prepareState, artifacts, createHostAudit, createStorePool, createConnectionHandoff, createHermesBackend,
  createDockerEngine, createGatewayTransport, createContainerRuntime, createProfileHomes,
  createProfileStore: options => new ProfileLeaseStore(options), createRuntimeOrchestrator, createHandoffReconciler, createConnectorMaintenance,
  preflight: preflightHostEngine,
});

/** Product host lifecycle. Factories are a trusted in-process test seam, never
 * configuration/HTTP input. All production defaults are the real adapters.
 * Owns one host lock, listener, WAL, backend, pool and the coordinated loops.
 * Unknown shutdown retains that lock; no process/PID/age-based recovery occurs.
 * Config must come from loadHostConfiguration; key buffers are disposed after
 * the backend and WAL have copied them, including partial startup failures.
 */
export function createHermesHost(configuration, { factories: overrides = {} } = {}) {
  const factories = { ...DEFAULTS, ...overrides };
  if (!configuration || typeof configuration.dispose !== 'function' ||
      Object.keys(overrides).some(key => !Object.hasOwn(DEFAULTS, key)) ||
      Object.keys(DEFAULTS).some(key => typeof factories[key] !== 'function')) fail('invalid_host_configuration');
  const connectorOnly = configuration.mode === 'connector';
  let ownership, audit, pool, handoff, backend, orchestrator, reconciler;
  let started, startupSettled = Promise.resolve(), closing = false, closePromise, cleanupPromise, reconcileClosed, disposed = false;
  let state = 'idle', failureCode, finishResolve, finishReject;
  const finished = new Promise((resolve, reject) => { finishResolve = resolve; finishReject = reject; });
  void finished.catch(() => {});
  const controller = new AbortController();
  const live = () => { if (closing || controller.signal.aborted) fail('host_stopped'); };
  const dispose = () => { if (!disposed) { disposed = true; configuration.dispose(); } };
  const stopReconciler = () => {
    reconcileClosed ??= invoke(() => reconciler?.close());
    void reconcileClosed.catch(() => {}); return reconcileClosed;
  };
  const closeListener = () => {
    if (!backend?.server) return Promise.resolve();
    return new Promise(resolve => {
      backend.server.close(() => resolve());
      backend.server.closeAllConnections();
    });
  };
  // The orchestrator starts runner/supervisor stop before awaiting this barrier.
  // A late reconciler attachment therefore drains without a shutdown cycle.
  const closeIngress = async () => {
    const results = await Promise.allSettled([closeListener(), stopReconciler()]);
    if (results.some(item => item.status === 'rejected')) fail('host_ingress_retained');
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    closing = true; controller.abort(); state = 'closing';
    cleanupPromise = (async () => {
      dispose();
      const stopped = await Promise.allSettled([stopReconciler(), orchestrator ? invoke(() => orchestrator.close()) : closeIngress()]);
      if (stopped.some(item => item.status === 'rejected')) fail('host_shutdown_retained');
      // Idempotent backend close also handles construction before orchestrator.
      await backend?.close();
      await handoff?.close();
      await pool?.end();
      await audit?.close();
      await ownership?.release();
      state = failureCode ? 'failed' : 'closed';
      if (failureCode) finishReject(new Error(failureCode)); else finishResolve();
    })().catch(() => { state = 'retained'; finishReject(new Error('host_shutdown_retained')); fail('host_shutdown_retained'); });
    void cleanupPromise.catch(() => {}); return cleanupPromise;
  };
  const closeHost = () => {
    if (closePromise) return closePromise;
    closing = true; controller.abort();
    closePromise = startupSettled.then(cleanup);
    void closePromise.catch(() => {}); return closePromise;
  };
  const boot = async () => {
    try {
      live(); state = 'starting';
      ownership = await factories.acquireHostOwnership({ stateRoot: configuration.paths.stateRoot }); live();
      const auditDirectory = await factories.prepareState(configuration.paths, { connectorOnly }); live();
      let files, engine;
      if (!connectorOnly) {
        files = await factories.artifacts(); live();
        engine = factories.createDockerEngine();
        await factories.preflight(engine, controller.signal); live();
      }
      audit = factories.createHostAudit({ directory: auditDirectory });
      handoff = factories.createConnectionHandoff({ directory: configuration.paths.handoffDirectory, ...configuration.encryption });
      // Read once before enrollment is exposed: reject unreadable/tampered WAL.
      await handoff.list({ signal: controller.signal }); live();
      pool = factories.createStorePool(configuration.store);
      backend = factories.createHermesBackend({ supabase: configuration.supabase, store: { pool, expectedRole: configuration.store.role },
        encryption: configuration.encryption, http: configuration.http, audit: audit.write, handoff: { stage: handoff.stage },
        ...(connectorOnly ? { connectorOnly: true, ...(configuration.limits ? { limits: configuration.limits } : {}) } : {}) });
      // Own asynchronous server errors for the entire listener lifetime. Never
      // let a post-listen error bypass runtime drain via an uncaught exception.
      backend.server.on('error', () => { failureCode = 'host_failed'; void closeHost().catch(() => {}); });
      dispose();
      if (connectorOnly) {
        reconciler = factories.createConnectorMaintenance({ handoff, backend });
      } else {
        const transport = factories.createGatewayTransport({ engine, gatewayRoot: configuration.paths.gatewayRoot,
          relayPath: files.relayPath, relaySha256: files.relaySha256 });
        const gateway = backend.createRuntimeGateway({ transport, allowedModels: configuration.model.allowedModels });
        const runtime = factories.createContainerRuntime({ gateway, engine, runtimeRoot: configuration.paths.runtimeRoot,
          wrapperPath: files.wrapperPath, wrapperSha256: files.wrapperSha256, model: configuration.model.model,
          maxTokens: configuration.model.maxTokens, maxIterations: configuration.model.maxIterations });
        const profileHomes = factories.createProfileHomes({ homeRoot: configuration.paths.homeRoot });
        const profileStore = factories.createProfileStore({ directory: configuration.paths.leaseDirectory, homeRoot: configuration.paths.homeRoot });
        const supervisor = backend.createRuntimeSupervisor({ profileStore, runtime });
        const runner = backend.createPrivateCommandRunner(supervisor);
        orchestrator = factories.createRuntimeOrchestrator({ backend, gateway, supervisor, runner, profileHomes,
          closeIngress, closePool: async () => {} }); // Outer host owns pool teardown.
        reconciler = factories.createHandoffReconciler({ handoff, backend, orchestrator });
      }
      live();
      await new Promise((resolve, reject) => {
        const failed = () => { backend.server.off('listening', ready); reject(new Error('host_listener_failed')); };
        const ready = () => { backend.server.off('error', failed); resolve(); };
        backend.server.once('error', failed); backend.server.once('listening', ready);
        backend.server.listen({ host: '127.0.0.1', port: configuration.listenPort, exclusive: true });
      });
      live(); backend.startWorkMemoryRetention(); orchestrator?.start(); reconciler.start(); state = 'running';
    } catch {
      if (!closing) failureCode = 'host_start_failed';
      await cleanup(); fail('host_start_failed');
    } finally { dispose(); }
  };
  return Object.freeze({
    start() {
      if (closing) return Promise.reject(new Error('host_stopped'));
      if (!started) {
        started = boot(); startupSettled = started.then(() => {}, () => {});
        void started.catch(() => {});
      }
      return started;
    },
    close: closeHost,
    finished,
    status() { return Object.freeze({ state }); },
  });
}
