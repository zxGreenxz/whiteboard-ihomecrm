import { createServer } from 'node:http';
import { BrokerError, createBroker } from './broker.mjs';
import { createStoreTransport } from './store-transport.mjs';
import { createDurableConnectionStore } from './durable-connection-store.mjs';
import { createSessionCrypto } from './session-crypto.mjs';
import { createSupabaseDurableAuthAdapter } from './supabase-durable-auth-adapter.mjs';
import { createDurableAuthority } from './durable-authority.mjs';
import { createConnectionControlPlane, createSupabaseAssistantSignIn, createSupabaseConnectionPreparation } from './connection-control-plane.mjs';
import { createConnectionManagement, createSupabaseConnectionManagementReads } from './connection-management.mjs';
import { createConnectionHttpHandler } from './connection-http.mjs';
import { createConnectionRenewal } from './connection-renewal.mjs';
import { createConnectionMaintenance } from './connection-maintenance.mjs';
import { createRefreshManager } from './refresh-manager.mjs';
import { createDurableRefreshStore } from './durable-refresh-store.mjs';
import { createSupabaseRefreshProvider } from './supabase-refresh-provider.mjs';
import { createPrivateCommandStore } from './private-command-store.mjs';
import { createPrivateCommandRunner, PrivateCommandRunnerError } from './private-command-runner.mjs';
import { createMcpHttpHandler } from './mcp-http.mjs';
import { createRoomReadService, createSupabaseRoomReads } from './room-read-service.mjs';
import { createZaloBindingService } from '../hermes-zalo-router/binding-service.mjs';
import { createZaloBindingPorts } from '../hermes-zalo-router/binding-adapter.mjs';
import { createZaloBindingHttpHandler } from '../hermes-zalo-router/binding-http.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createModelRelay } from './model-relay.mjs';
import { createRuntimeModelService } from './runtime-model-service.mjs';
import { createRuntimeGateway } from '../hermes-runtime/runtime-gateway.mjs';
import { createConnectionSupervisor } from '../hermes-runtime/connection-supervisor.mjs';

const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function reply(response, status, error) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', connection: 'close' });
  response.end(JSON.stringify({ error }));
}

/** Trusted composition only: constructs one durable authority/business core.
 * No listen(), env/vault lookup, DB provisioning, refresh scheduler or logger.
 * The caller owns the injected dedicated pool and must construct it with the
 * reviewed createStorePool TLS/principal/timeout contract; close() never ends it.
 * Keyring is copied by createSessionCrypto and owned by this composition. Caller
 * owns erasure of its original key bytes and supplying an explicit audit sink.
 * Deploy on a trusted loopback listener behind reviewed same-origin TLS. Exact
 * Host authorities include explicit ports; forwarded headers never override it.
 * Fixed context and available-room reads share the broker's authority/quota/audit.
 * Room discovery additionally requires rooms.view and mapped assistant scopes;
 * its final bound SQL decision follows audit. No future-tool switch is exposed.
 * MCP has the broker's own bounded deadline; its API currently accepts no caller
 * AbortSignal. Disconnect prevents delivery but does not immediately cancel the
 * broker. Its handler retains capacity until that bounded work settles. Browser
 * writes propagate disconnect through the existing connection HTTP handler.
 * resolveConnection() returns a fresh, fixed owner projection to the trusted
 * supervisor. It shares HTTP admission and is aborted/drained on close.
 * Its promise includes actual authority dependency drain, even after an adapter
 * timeout. Startup owners must not free profile capacity on a public SQL race.
 * renewConnection() is a trusted supervisor API with separate bounded admission;
 * it is not an HTTP route or model tool and never refreshes provider credentials.
 * beginConnectionMaintenance() composes token-derived fenced provider refresh
 * and renewal. The trusted host must park its whole command pump until drained;
 * it is not automatically scheduled and never accepts caller credential refs.
 * createPrivateCommandRunner(supervisor) binds one trusted explicit ledger pump;
 * it is never mounted on HTTP/MCP. Repeated calls reuse the same supervisor only.
 * createRuntimeSupervisor({profileStore,runtime}) owns one supervisor with the
 * same dependency scope as SQL/Auth and the runner. It requires the coordinated
 * orchestrator for renewal; its own expiry watchdog always remains active.
 * Runtime command ports must
 * expose actual drain (beginExecutePrivateCommand), or settle only after work.
 * Owned runner/supervisor close concurrently, before gateway/model teardown.
 * External supervisors remain caller-owned and must stop before backend.close.
 * close() blocks admission, aborts renewals, destroys sockets, awaits handlers
 * and direct renewal/private-command dependency promises, then destroys its
 * keyring. Socket loss/unknown write ACK is NOT rollback or a retry guarantee;
 * Nested adapters own transport cancellation; draining their public promises
 * does not prove an in-flight database write rolled back.
 * optional handoff.stage persists an encrypted host WAL before activation. The
 * product host must inject it and own its close after backend.close; this backend
 * tracks actual stage I/O but never lists/decrypts WAL or starts profiles itself.
 * Quota/admission remain process-local; this is not a multi-replica deployment.
 */
export function createHermesBackend(configuration = {}) {
  const optional = ['fetch', 'clock', 'handoff'];
  if (!plain(configuration) || Object.keys(configuration).some(key => !['supabase', 'store', 'encryption', 'http', 'audit', ...optional].includes(key)) ||
      !exact(configuration.supabase, ['url', 'publishableKey']) || !exact(configuration.store, ['pool', 'expectedRole']) ||
      !exact(configuration.encryption, ['activeKeyVersion', 'keys']) || !exact(configuration.http, ['allowedHosts', 'allowedOrigins']) ||
      typeof configuration.audit !== 'function' || (Object.hasOwn(configuration, 'fetch') && typeof configuration.fetch !== 'function') ||
      (Object.hasOwn(configuration, 'clock') && typeof configuration.clock !== 'function') ||
      (Object.hasOwn(configuration, 'handoff') && (!exact(configuration.handoff, ['stage']) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(configuration.handoff, 'stage') ?? {}, 'value') ||
        typeof configuration.handoff.stage !== 'function'))) throw new TypeError('invalid_backend_config');
  const { supabase, store, encryption, http, audit, fetch: request = globalThis.fetch, clock = Date.now } = configuration;
  let crypto;
  try {
    const dependencyScope = createDependencyScope();
    const transport = createStoreTransport({ pool: store.pool, expectedRole: store.expectedRole, dependencyScope });
    const connectionStore = createDurableConnectionStore({ transport, clock });
    crypto = createSessionCrypto(encryption);
    const auth = createSupabaseDurableAuthAdapter({ ...supabase, fetch: request, clock, dependencyScope });
    const authority = createDurableAuthority({ auth, connectionStore, crypto, clock });
    const renewal = createConnectionRenewal({ authority, connectionStore, clock });
    const refreshProvider = createSupabaseRefreshProvider({ ...supabase, fetch: request, clock, dependencyScope });
    const refreshManager = createRefreshManager({ store: createDurableRefreshStore({ transport }),
      provider: refreshProvider, crypto, clock, dependencyScope });
    const maintenance = createConnectionMaintenance({ authority, connectionStore, refreshManager, renewal, clock, dependencyScope });
    const roomReads = createRoomReadService({ authority, connectionStore, crypto, auth, clock,
      reads: createSupabaseRoomReads({ ...supabase, fetch: request, dependencyScope }) });
    const broker = createBroker({ authority, roomReads, audit, clock, limits: { maxResultBytes: 65_536 } });
    // The host owns the WAL and its keyring. Track the actual filesystem promise
    // so an HTTP/control timeout cannot let close erase keys while stage is live.
    const stageHandoff = configuration.handoff?.stage.bind(configuration.handoff);
    const handoff = stageHandoff ? { stage: (record, options) => dependencyScope.track(() => stageHandoff(record, options)) } : undefined;
    const controlPlane = createConnectionControlPlane({ auth, connectionStore, crypto, clock, handoff,
      signInProvider: createSupabaseAssistantSignIn({ ...supabase, fetch: request }),
      preparation: createSupabaseConnectionPreparation({ ...supabase, fetch: request }) });
    const management = createConnectionManagement({ auth, connectionStore, clock,
      reads: createSupabaseConnectionManagementReads({ ...supabase, fetch: request }) });
    const connections = createConnectionHttpHandler({ controlPlane, management, ...http });
    const binding = createZaloBindingService(createZaloBindingPorts({ auth, ...supabase, fetch: request, clock }));
    const zalo = createZaloBindingHttpHandler({ service: binding, ...http });
    // Connection HTTP validates/copies both lists. These separate snapshots fence
    // MCP and unknown routes too, before legacy MCP hostname-only checks.
    const hosts = new Set(http.allowedHosts), origins = new Set(http.allowedOrigins);
    const mcp = createMcpHttpHandler({ broker, allowedHosts: [...new Set([...hosts].map(host => new URL(`http://${host}`).hostname))],
      allowedOrigins: [...origins] });
    const pending = new Set(), supervisorAbort = new AbortController(); let closing = false, closePromise, privateRunner, privateSupervisor;
    let runtimeGateway, runtimeModels, runtimeOptions, ownedSupervisor, supervisorOptions;
    const resolveConnection = (token, { signal } = {}) => {
      if (!(signal instanceof AbortSignal)) return Promise.reject(new BrokerError('invalid_request'));
      if (closing || signal.aborted) return Promise.reject(new BrokerError('backend_unavailable'));
      if (pending.size >= 16) return Promise.reject(new BrokerError('busy'));
      const combined = AbortSignal.any([signal, supervisorAbort.signal]);
      const work = Promise.resolve().then(async () => {
        // Scope only the finite authority lookup, never long-lived runtime
        // startup/listeners. Preserve startup ownership and the 16-call limit
        // when a SQL/Auth observer aborts before its actual transport settles.
        const lookup = dependencyScope.begin(() => authority.resolve(token, { signal: combined }));
        let context;
        try { context = await lookup.result; } finally { await lookup.drained; }
        if (closing || combined.aborted) throw new BrokerError('backend_unavailable');
        const { id: connectionId, assistantId, userId, organizationId, expiresAt } = context.row;
        return Object.freeze({ connectionId, assistantId, userId, organizationId, expiresAt });
      });
      pending.add(work);
      void work.then(() => pending.delete(work), () => pending.delete(work));
      return work;
    };
    const server = createServer({ maxHeaderSize: 32_768 }, (req, res) => {
      if (closing) { reply(res, 503, 'backend_closed'); return; }
      const names = new Set();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase();
        if (names.has(name)) { reply(res, 400, 'duplicate_header'); return; } names.add(name);
      }
      if (names.size > 32) { reply(res, 431, 'too_many_headers'); return; }
      if (!hosts.has(req.headers.host) || (req.headers.origin !== undefined && !origins.has(req.headers.origin))) {
        reply(res, 403, 'forbidden'); return;
      }
      if (req.headers['content-encoding'] !== undefined) { reply(res, 415, 'unsupported_content_encoding'); return; }
      if (pending.size >= 16) { reply(res, 429, 'busy'); return; }
      const work = (async () => {
        if (req.url === '/mcp') await mcp(req, res);
        else if (!await connections(req, res) && !await zalo(req, res)) reply(res, 404, 'not_found');
      })();
      pending.add(work);
      void work.catch(() => reply(res, 503, 'backend_unavailable')).finally(() => { pending.delete(work); });
    });
    server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
    server.setTimeout(35_000, socket => { socket.destroy(); });
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
    });
    const close = () => {
      if (closePromise) return closePromise;
      closing = true;
      supervisorAbort.abort();
      const renewalsStopped = renewal.close();
      const refreshStopped = Promise.all([maintenance.close(), refreshManager.close(), refreshProvider.close()]);
      void refreshStopped.catch(() => {});
      const bindingsStopped = binding.close();
      const privateCommandsStopped = privateRunner?.close();
      // Start both stops before awaiting either: a runner can be waiting for
      // the runtime exit caused by supervisor.close(). Never remove a sidecar
      // network or erase credentials while the owned runtime can still execute.
      const supervisorStopped = ownedSupervisor?.close();
      const runtimeStopped = Promise.all([privateCommandsStopped, supervisorStopped]).then(() =>
        Promise.all([runtimeGateway?.shutdown(), runtimeModels?.close()]));
      void runtimeStopped.catch(() => {});
      closePromise = (async () => {
        const stopped = new Promise(resolve => server.close(() => resolve()));
        server.closeAllConnections();
        await stopped;
        await Promise.allSettled([...pending]);
        await renewalsStopped;
        await refreshStopped;
        await bindingsStopped;
        await privateCommandsStopped;
        await runtimeStopped;
        await dependencyScope.close();
        crypto.destroy();
      })();
      return closePromise;
    };
    // Trusted supervisor API only. Never registered as a browser route or MCP
    // tool; the browser JWT and provider credentials cannot renew runtime leases.
    const privateCommandRunner = supervisor => {
      if (closing) throw new PrivateCommandRunnerError('backend_closed');
      if (ownedSupervisor && supervisor !== ownedSupervisor) throw new TypeError('private_command_supervisor_mismatch');
      if (privateRunner) {
        if (supervisor !== privateSupervisor) throw new TypeError('private_command_runner_already_bound');
        return privateRunner;
      }
      const runner = createPrivateCommandRunner({ store: createPrivateCommandStore({ transport }), resolveConnection, supervisor, clock, dependencyScope });
      privateSupervisor = supervisor; privateRunner = runner; return runner;
    };
    const runtimeSupervisorFactory = options => {
      if (closing) throw new BrokerError('backend_unavailable');
      if (!plain(options) || Reflect.ownKeys(options).length !== 2 ||
          ['profileStore', 'runtime'].some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key) ?? {}, 'value'))) {
        throw new TypeError('invalid_runtime_supervisor_config');
      }
      if (ownedSupervisor) {
        if (options !== supervisorOptions) throw new TypeError('runtime_supervisor_already_bound');
        return ownedSupervisor;
      }
      if (privateRunner) throw new TypeError('private_command_runner_already_bound');
      const supervisor = createConnectionSupervisor({ profileStore: options.profileStore, runtime: options.runtime,
        backend: { resolveConnection, renewConnection: renewal.renew, beginConnectionMaintenance: maintenance.begin },
        renewalMode: 'coordinated', clock, dependencyScope });
      supervisorOptions = options; ownedSupervisor = supervisor; return supervisor;
    };
    // Trusted factory only. The model/runtime receive neither this factory nor
    // token/JWT/store/keyring. HTTP routing remains unchanged; model authority
    // is derived from the registration's opaque connection on the host.
    const runtimeGatewayFactory = options => {
      if (closing) throw new BrokerError('backend_unavailable');
      if (!exact(options, ['transport', 'allowedModels']) || typeof options.transport?.open !== 'function') throw new TypeError('invalid_runtime_gateway_config');
      if (runtimeGateway) {
        if (options !== runtimeOptions) throw new TypeError('runtime_gateway_already_bound');
        return runtimeGateway;
      }
      const relay = createModelRelay({ supabaseUrl: supabase.url, publishableKey: supabase.publishableKey,
        allowedModels: options.allowedModels, fetch: request });
      const models = createRuntimeModelService({ authority, connectionStore, crypto, auth, relay, clock, dependencyScope });
      try {
        const gateway = createRuntimeGateway({ backend: { resolveConnection }, broker, modelService: models,
          transport: options.transport, clock, dependencyScope });
        runtimeOptions = options; runtimeModels = models; runtimeGateway = gateway; return gateway;
      } catch (error) { void models.close().catch(() => {}); throw error; }
    };
    return Object.freeze({ server, close, resolveConnection, renewConnection: renewal.renew,
      createPrivateCommandRunner: privateCommandRunner, createRuntimeGateway: runtimeGatewayFactory,
      createRuntimeSupervisor: runtimeSupervisorFactory, beginConnectionMaintenance: maintenance.begin });
  } catch {
    crypto?.destroy();
    throw new TypeError('invalid_backend_config');
  }
}
