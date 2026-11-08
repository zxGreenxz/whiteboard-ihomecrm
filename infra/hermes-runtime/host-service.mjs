import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
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
// Operation IDs (never tokens) of the connections the previous process saw healthy, so a stop longer than the token
// life still reports each of them as lost. A hint for log lines only, never authority: an unreadable, tampered or
// missing file means [], i.e. the behaviour without it. Written atomically, owner-only; failures are swallowed.
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function createHealthyRecord({ directory }) {
  const file = path.join(directory, 'connector-healthy.json'); let chain = Promise.resolve();
  return Object.freeze({
    async load() {
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.size > 8192) return [];
        const value = JSON.parse(await readFile(file, 'utf8'));
        return value?.v === 1 && Array.isArray(value.ids) ? value.ids.filter(id => typeof id === 'string' && OPERATION_ID.test(id)).slice(0, 64) : [];
      } catch { return []; }
    },
    save(ids) {
      const next = chain.then(async () => {
        const temporary = `${file}.tmp`;
        await writeFile(temporary, JSON.stringify({ v: 1, ids }), { mode: 0o600 }); await chmod(temporary, 0o600); await rename(temporary, file);
      });
      chain = next.catch(() => {}); return next;
    },
  });
}
const DEFAULTS = Object.freeze({
  acquireHostOwnership, prepareState, createHostAudit, createStorePool, createConnectionHandoff, createHermesBackend,
  createConnectorMaintenance, createNativeBindingReconciler, createHealthyRecord,
});

/** Connector host lifecycle (`mode: "connector"` only). Factories are a trusted
 * in-process test seam, never configuration/HTTP input. All production defaults
 * are the real adapters. Owns one host lock, listener, WAL, backend, pool and the
 * connection maintenance and optional allowlisted Zalo provisioning. It never
 * starts a model, container or profile; configuration changes await controlled restart.
 * Unknown shutdown retains that lock. The only automatic replacement is a lock whose
 * recorded kernel boot ID is not the current one, at the next start (host-ownership.mjs).
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
      // Fixed stdout JSON lines, same channel as the host_* lifecycle events and never a path or ID:
      // host_stale_lock_recovered, host_stale_lock_refused {reason} and host_boot_identity_unavailable.
      ownership = await factories.acquireHostOwnership({ stateRoot: configuration.paths.stateRoot },
        { log: record => console.info(JSON.stringify(record)) }); live();
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
        ...(configuration.actionPages === undefined ? {} : { actionPages: [...configuration.actionPages] }),
        ...(configuration.publicWebOrigin === undefined ? {} : { publicWebOrigin: configuration.publicWebOrigin }),
        ...(configuration.authorityCacheTtlMs === undefined ? {} : { authorityCacheTtlMs: configuration.authorityCacheTtlMs }),
        ...(callLog ? { callLog } : {}) });
      // Own asynchronous server errors for the entire listener lifetime. Never
      // let a post-listen error bypass maintenance drain via an uncaught exception.
      backend.server.on('error', () => { failureCode = 'host_failed'; void closeHost().catch(() => {}); });
      dispose();
      // Vòng gia hạn ghi connector_maintenance_* (đổi trạng thái, gia hạn lỗi/chưa xác nhận/khoá/hồi phục)
      // cùng kênh stdout; không token/digest/thông điệp lỗi, chỉ khi có thay đổi. HERMES_CALL_LOG không tắt nó.
      // renewBeforeMs 600000 = tối đa cho phép: token 15 phút, vòng bắt đầu gia hạn khi còn 10 phút, để lịch thử lại 30/60/120/240 s
      // (+ trần hạn - 30 s) có ~9 phút thay vì ~4 phút khi mạng chập chờn (sự cố 31/10: lỡ cửa sổ 5 phút, token chết 10:19 UTC).
      const healthyRecord = factories.createHealthyRecord({ directory: configuration.paths.stateRoot });
      const healthyIds = await healthyRecord.load(); live();
      maintenance = factories.createConnectorMaintenance({ handoff, backend, renewBeforeMs: 600000, healthyIds,
        onHealthyChange: ids => healthyRecord.save(ids), log: record => console.info(JSON.stringify(record)) });
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
