import { lstat, mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createNativeBindingReconciler } from '../hermes-zalo-native/binding-reconciler.mjs';
import { createStoreTransport } from '../hermes-broker/store-transport.mjs';
import { createStorePool } from '../hermes-broker/store-pool.mjs';
import { createConnectionHandoff } from '../hermes-broker/connection-handoff.mjs';
import { createHermesBackend } from '../hermes-broker/server.mjs';
import { createConnectorMaintenance } from '../hermes-broker/connector-maintenance.mjs';
import { acquireHostOwnership, createHostAudit } from './host-ownership.mjs';

const fail = code => { throw new Error(code); };
const invoke = fn => { try { return Promise.resolve(fn()); } catch (error) { return Promise.reject(error); } };
async function prepareState(paths) {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.getgid() === 0) fail('host_native_nonroot_linux_required');
  const check = async target => {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.gid !== process.getgid() ||
        (info.mode & 0o777) !== 0o700 || await realpath(target) !== target) fail('host_state_refused');
  };
  await check(paths.stateRoot);
  if (paths.handoffDirectory !== path.join(paths.stateRoot, 'handoff')) fail('host_state_refused');
  const auditDirectory = path.join(paths.stateRoot, 'audit');
  for (const directory of [paths.handoffDirectory, auditDirectory]) {
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await check(directory);
  }
  return auditDirectory;
}
const DEFAULTS = Object.freeze({
  acquireHostOwnership, prepareState, createHostAudit, createStorePool, createConnectionHandoff, createHermesBackend,
  createConnectorMaintenance, createNativeBindingReconciler,
});

/** Connector host lifecycle (`mode: "connector"` only). Factories are a trusted
 * in-process test seam, never configuration/HTTP input. All production defaults
 * are the real adapters. Owns one host lock, listener, WAL, backend, pool and the
 * connection maintenance and optional allowlisted Zalo provisioning. It never
 * starts a model, container or profile; configuration changes await controlled restart.
 * Unknown shutdown retains that lock; no process/PID/age-based recovery occurs.
 * Config must come from loadHostConfiguration; key buffers are disposed after
 * the backend and WAL have copied them, including partial startup failures.
 */
export function createHermesHost(configuration, { factories: overrides = {} } = {}) {
  const factories = { ...DEFAULTS, ...overrides };
  if (!configuration || typeof configuration.dispose !== 'function' ||
      Object.keys(overrides).some(key => !Object.hasOwn(DEFAULTS, key)) ||
      Object.keys(DEFAULTS).some(key => typeof factories[key] !== 'function') ||
      configuration.mode !== 'connector') fail('invalid_host_configuration');
  let ownership, audit, pool, handoff, backend, maintenance, zaloReconciler;
  let started, startupSettled = Promise.resolve(), closing = false, closePromise, cleanupPromise, maintenanceClosed, disposed = false;
  let state = 'idle', failureCode, finishResolve, finishReject;
  const finished = new Promise((resolve, reject) => { finishResolve = resolve; finishReject = reject; });
  void finished.catch(() => {});
  const controller = new AbortController();
  const live = () => { if (closing || controller.signal.aborted) fail('host_stopped'); };
  const dispose = () => { if (!disposed) { disposed = true; configuration.dispose(); } };
  const stopMaintenance = () => {
    maintenanceClosed ??= Promise.all([invoke(() => maintenance?.close()),invoke(() => zaloReconciler?.close())]);
    void maintenanceClosed.catch(() => {}); return maintenanceClosed;
  };
  const closeListener = () => {
    if (!backend?.server) return Promise.resolve();
    return new Promise(resolve => {
      backend.server.close(() => resolve());
      backend.server.closeAllConnections();
    });
  };
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    closing = true; controller.abort(); state = 'closing';
    cleanupPromise = (async () => {
      dispose();
      // Stop ingress and maintenance together; keys, pool, WAL and lock stay
      // until both have actually drained.
      const stopped = await Promise.allSettled([closeListener(), stopMaintenance()]);
      if (stopped.some(item => item.status === 'rejected')) fail('host_shutdown_retained');
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
      const auditDirectory = await factories.prepareState(configuration.paths); live();
      audit = factories.createHostAudit({ directory: auditDirectory });
      handoff = factories.createConnectionHandoff({ directory: configuration.paths.handoffDirectory, ...configuration.encryption });
      // Read once before enrollment is exposed: reject unreadable/tampered WAL.
      await handoff.list({ signal: controller.signal }); live();
      pool = factories.createStorePool(configuration.store);
      // Mỗi lần broker invoke một dòng JSON tool_call_timing ra stdout (journal), cùng kênh và
      // cùng khuôn với các event host_* của host-cli (console.info nuốt lỗi ghi); HERMES_CALL_LOG=0 tắt.
      const callLog = process.env.HERMES_CALL_LOG === '0' ? undefined : record => console.info(JSON.stringify(record));
      backend = factories.createHermesBackend({ supabase: configuration.supabase, store: { pool, expectedRole: configuration.store.role },
        encryption: configuration.encryption, http: configuration.http, audit: audit.write, handoff: { stage: handoff.stage },
        connectorOnly: true, ...(configuration.limits ? { limits: configuration.limits } : {}),
        ...(configuration.readFastPath === undefined ? {} : { readFastPath: configuration.readFastPath }),
        ...(configuration.roomRead === undefined ? {} : { roomRead: configuration.roomRead }),
        ...(configuration.actionProbe === undefined ? {} : { actionProbe: configuration.actionProbe }),
        ...(callLog ? { callLog } : {}) });
      // Own asynchronous server errors for the entire listener lifetime. Never
      // let a post-listen error bypass maintenance drain via an uncaught exception.
      backend.server.on('error', () => { failureCode = 'host_failed'; void closeHost().catch(() => {}); });
      dispose();
      // Vòng gia hạn ghi connector_maintenance_* (đổi trạng thái, gia hạn lỗi/chưa xác nhận/khoá/hồi phục)
      // cùng kênh stdout; không token/digest/thông điệp lỗi, chỉ khi có thay đổi. HERMES_CALL_LOG không tắt nó.
      maintenance = factories.createConnectorMaintenance({ handoff, backend, log: record => console.info(JSON.stringify(record)) });
      if(configuration.zaloProvisioning) zaloReconciler=factories.createNativeBindingReconciler({
        configuration:configuration.zaloProvisioning,handoff,backend,
        transport:createStoreTransport({pool,expectedRole:configuration.store.role})});

      live();
      await new Promise((resolve, reject) => {
        const failed = () => { backend.server.off('listening', ready); reject(new Error('host_listener_failed')); };
        const ready = () => { backend.server.off('error', failed); resolve(); };
        backend.server.once('error', failed); backend.server.once('listening', ready);
        backend.server.listen({ host: '127.0.0.1', port: configuration.listenPort, exclusive: true });
      });
      live(); backend.startWorkMemoryRetention(); maintenance.start(); zaloReconciler?.start(); state = 'running';
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
    status() { return Object.freeze({ state, ...(zaloReconciler ? { zaloProvisioning: zaloReconciler.status() } : {}) }); },
  });
}
