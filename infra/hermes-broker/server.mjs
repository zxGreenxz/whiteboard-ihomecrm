import { createTaskServiceWithOptions } from './task-input-adapter.mjs';
import { createTaskAuth, createTaskReads } from './task-adapter.mjs';
import { createServer } from 'node:http';
import { createRoomPassAuth, createRoomPassReads, createRoomPassService } from './room-pass-adapter.mjs';
import { createCustomerActionAuth, createCustomerActionReads, createCustomerActionService } from './customer-action-adapter.mjs';
import { createExpenseActionAuth, createExpenseActionReads, createExpenseActionService } from './expense-action-adapter.mjs';
import { createDomainMount } from './domain-mount.mjs';
import { createDomainAuthAdapter, createSupabaseDomainReads } from './domain-adapter.mjs';
import { createScheduleMount } from './schedule-mount.mjs';
import { createScheduleAuthAdapter, createSupabaseScheduleReads } from './schedule-adapter.mjs';
import { createZaloBroadcastService } from './zalo-broadcast-adapter.mjs';
import { createWorkMemoryAuthAdapter, createSupabaseWorkMemoryReads } from './work-memory-adapter.mjs';
import { createWorkMemoryService } from './work-memory-service.mjs';
import { createWorkMemoryRetention } from './work-memory-retention.mjs';
import { createHash } from 'node:crypto';
import { BrokerError, TOOLS_LIST_MAX_BYTES, createBroker } from './broker.mjs';
import { createGroupPreviewMount } from './group-preview-mount.mjs';
import { createExternalGroupMount } from './external-group-mount.mjs';
import { createHermesCapabilityAuthAdapter, createSupabaseGroupPreviewReads } from './group-preview-adapter.mjs';
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
import { createMcpHttpHandler } from './mcp-http.mjs';
import { createRoomReadService, createSupabaseRoomReads } from './room-read-service.mjs';
import { createZaloBindingService } from '../hermes-zalo-router/binding-service.mjs';
import { createZaloBindingPorts } from '../hermes-zalo-router/binding-adapter.mjs';
import { createZaloBindingHttpHandler } from '../hermes-zalo-router/binding-http.mjs';
import { createDependencyScope } from './dependency-scope.mjs';
import { createConnectorHealth } from './connector-health.mjs';

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
 * host (connector maintenance). It shares HTTP admission and is aborted/drained
 * on close. Its promise includes actual authority dependency drain, even after
 * an adapter timeout.
 * renewConnection() is a trusted host API with separate bounded admission;
 * it is not an HTTP route or model tool and never refreshes provider credentials.
 * beginConnectionMaintenance() composes token-derived fenced provider refresh
 * and renewal. It is not automatically scheduled and never accepts caller
 * credential refs; the connector reaches it through
 * beginExternalConnectionMaintenance(), which parks that token's MCP admission.
 * close() blocks admission, aborts renewals, destroys sockets, awaits handlers
 * and direct renewal/maintenance dependency promises, then destroys its
 * keyring. Socket loss/unknown write ACK is NOT rollback or a retry guarantee;
 * Nested adapters own transport cancellation; draining their public promises
 * does not prove an in-flight database write rolled back.
 * optional handoff.stage persists an encrypted host WAL before activation. The
 * host must inject it and own its close after backend.close; this backend
 * tracks actual stage I/O but never lists/decrypts WAL.
 * Quota/admission remain process-local; this is not a multi-replica deployment.
 */
const LIMIT_KEYS = ['requestsPerMinute', 'toolCallsPerMinute', 'callTimeoutMs', 'maintenanceWaitMs'];
const DEFAULT_BACKEND_LIMITS = Object.freeze({ requestsPerMinute: 60, toolCallsPerMinute: 60, callTimeoutMs: 10_000, maintenanceWaitMs: 0 });
const MAX_REQUEST_BUDGET_MS = 25_000;
const integerIn = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
function backendLimits(value) {
  if (value === undefined) return DEFAULT_BACKEND_LIMITS;
  if (!exact(value, LIMIT_KEYS) || !integerIn(value.requestsPerMinute, 1, 600) ||
      !integerIn(value.toolCallsPerMinute, 1, value.requestsPerMinute) || !integerIn(value.callTimeoutMs, 1000, 30_000) ||
      !integerIn(value.maintenanceWaitMs, 0, 10_000) ||
      // Wait + whole-call deadline must finish before the Hermes MCP client timeout
      // (30 s) and this server's 35 s idle-socket cut-off.
      value.callTimeoutMs + value.maintenanceWaitMs > MAX_REQUEST_BUDGET_MS) throw new TypeError('invalid_backend_config');
  return Object.freeze(Object.fromEntries(LIMIT_KEYS.map(key => [key, value[key]])));
}

/** Optional `limits` (all four keys): per-connection sliding-window request and
 * tools/call rates, the broker's total deadline for one MCP invocation, and how
 * long an external MCP request waits for its connection's maintenance fence
 * before answering 503 connection_maintenance (0 keeps the immediate 503).
 */
export function createHermesBackend(configuration = {}) {
  const optional = ['fetch', 'clock', 'handoff', 'connectorOnly', 'limits'];
  if (!plain(configuration) || Object.keys(configuration).some(key => !['supabase', 'store', 'encryption', 'http', 'audit', ...optional].includes(key)) ||
      !exact(configuration.supabase, ['url', 'publishableKey']) || !exact(configuration.store, ['pool', 'expectedRole']) ||
      !exact(configuration.encryption, ['activeKeyVersion', 'keys']) || !exact(configuration.http, ['allowedHosts', 'allowedOrigins']) ||
      typeof configuration.audit !== 'function' || (Object.hasOwn(configuration, 'fetch') && typeof configuration.fetch !== 'function') ||
      (Object.hasOwn(configuration, 'clock') && typeof configuration.clock !== 'function') ||
      (Object.hasOwn(configuration, 'connectorOnly') && configuration.connectorOnly !== true) ||
      (Object.hasOwn(configuration, 'handoff') && (!exact(configuration.handoff, ['stage']) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(configuration.handoff, 'stage') ?? {}, 'value') ||
        typeof configuration.handoff.stage !== 'function'))) throw new TypeError('invalid_backend_config');
  const { supabase, store, encryption, http, audit, fetch: request = globalThis.fetch, clock = Date.now } = configuration;
  let crypto;
  try {
    const limits = backendLimits(configuration.limits);
    const health = createConnectorHealth({ clock });
    const dependencyScope = createDependencyScope();
    const transport = createStoreTransport({ pool: store.pool, expectedRole: store.expectedRole, dependencyScope });
    const retention = createWorkMemoryRetention({ transport });
    const connectionStore = createDurableConnectionStore({ transport, clock });
    crypto = createSessionCrypto(encryption);
    const baseAuth = createSupabaseDurableAuthAdapter({ ...supabase, fetch: request, clock, dependencyScope });
    const groupAuth = createHermesCapabilityAuthAdapter({ baseAuth,
      reads: createSupabaseGroupPreviewReads({ ...supabase, fetch: request, dependencyScope }) });
    const memoryReads = createSupabaseWorkMemoryReads({ ...supabase, fetch: request, dependencyScope });
    const memoryAuth = createWorkMemoryAuthAdapter({ baseAuth: groupAuth, reads: memoryReads });
    const scheduleAuth = createScheduleAuthAdapter({ baseAuth: memoryAuth,
      reads: createSupabaseScheduleReads({ ...supabase, fetch: request, dependencyScope }) });
    const domainAuth = createDomainAuthAdapter({ baseAuth: scheduleAuth, reads: createSupabaseDomainReads({ ...supabase, fetch: request, dependencyScope }) });
    const roomPassAuth = createRoomPassAuth({ baseAuth: domainAuth, reads: createRoomPassReads({ ...supabase, fetch: request, dependencyScope }) });
    // Each optional capability RPC absent (PGRST202) leaves its keys ungranted;
    // a present one is bound to the same caller/membership/policy version.
    const customerAuth = createCustomerActionAuth({ baseAuth: roomPassAuth, reads: createCustomerActionReads({ ...supabase, fetch: request, dependencyScope }) });
    const expenseAuth = createExpenseActionAuth({ baseAuth: customerAuth, reads: createExpenseActionReads({ ...supabase, fetch: request, dependencyScope }) });
    const auth = createTaskAuth({ baseAuth: expenseAuth, reads: createTaskReads({ ...supabase, fetch: request, dependencyScope }) });
    const authority = createDurableAuthority({ auth, connectionStore, crypto, clock });
    const workMemory = createWorkMemoryService({ authority, connectionStore, crypto, auth, reads: memoryReads, clock });
    const renewal = createConnectionRenewal({ authority, connectionStore, clock });
    const refreshProvider = createSupabaseRefreshProvider({ ...supabase, fetch: request, clock, dependencyScope });
    const refreshManager = createRefreshManager({ store: createDurableRefreshStore({ transport }),
      provider: refreshProvider, crypto, clock, dependencyScope });
    const maintenance = createConnectionMaintenance({ authority, connectionStore, refreshManager, renewal, clock, dependencyScope });
    const roomReads = createRoomReadService({ authority, connectionStore, crypto, auth, clock,
      reads: createSupabaseRoomReads({ ...supabase, fetch: request, dependencyScope }) });
    // The concrete preview stack is reachable only through the broker's group
    // methods that need a host-supplied private command context (no MCP route).
    // Construction does not grant a capability, policy or connection action.
    const groupPreviews = createGroupPreviewMount({ auth, authority, connectionStore, crypto, clock, dependencyScope,
      supabase, fetch: request });
    const externalGroups = createExternalGroupMount({ auth, authority, connectionStore, crypto, clock, dependencyScope,
      supabase, fetch: request });
    // Same composed auth: chat_zalo.view/send (group) and manage_automation (schedule).
    const zaloBroadcasts = createZaloBroadcastService({ auth, authority, connectionStore, crypto, clock, dependencyScope, supabase, fetch: request });
    const schedules = createScheduleMount({ auth, authority, connectionStore, crypto, clock, dependencyScope, supabase, fetch: request }).createService();
    const domains = createDomainMount({ auth, authority, connectionStore, crypto, clock, dependencyScope, supabase, fetch: request }).createService();
    const roomPass = createRoomPassService({ auth, authority, connectionStore, crypto, clock, dependencyScope, supabase, fetch: request });
    const tasks = createTaskServiceWithOptions({ auth, authority, connectionStore, crypto, clock, dependencyScope, supabase, fetch: request });
    const customers = createCustomerActionService({ auth, authority, connectionStore, crypto, clock, dependencyScope, supabase, fetch: request });
    const expenses = createExpenseActionService({ auth, authority, connectionStore, crypto, clock, dependencyScope, supabase, fetch: request });
    // 64 KiB caps tools/call data (and every other response); the static tools/list catalogue has its own 192 KiB cap.
    const broker = createBroker({ tasks, roomPass, customers, expenses, authority, roomReads, groupPreviews, externalGroups, workMemory, schedules, zaloBroadcasts, domains, dependencyScope, audit, clock,
      publicTextStartTainted: true, observe: health.record, limits: { maxResultBytes: 65_536, maxToolsListBytes: TOOLS_LIST_MAX_BYTES, maxRequestsPerMinute: limits.requestsPerMinute,
        maxToolCallsPerMinute: limits.toolCallsPerMinute, timeoutMs: limits.callTimeoutMs } });
    // The host owns the WAL and its keyring. Track the actual filesystem promise
    // so an HTTP/control timeout cannot let close erase keys while stage is live.
    const stageHandoff = configuration.handoff?.stage.bind(configuration.handoff);
    const handoff = stageHandoff ? { stage: (record, options) => dependencyScope.track(() => stageHandoff(record, options)) } : undefined;
    const controlPlane = createConnectionControlPlane({ auth, connectionStore, crypto, clock, handoff,
      signInProvider: createSupabaseAssistantSignIn({ ...supabase, fetch: request }),
      preparation: createSupabaseConnectionPreparation({ ...supabase, fetch: request }) });
    const management = createConnectionManagement({ auth, connectionStore, clock, health,
      reads: createSupabaseConnectionManagementReads({ ...supabase, fetch: request, dependencyScope }) });
    const connections = createConnectionHttpHandler({ controlPlane, management, ...http });
    const binding = createZaloBindingService(createZaloBindingPorts({ auth, ...supabase, fetch: request, clock }));
    const zalo = createZaloBindingHttpHandler({ service: binding, ...http });
    // Connection HTTP validates/copies both lists. These separate snapshots fence
    // MCP and unknown routes too, before legacy MCP hostname-only checks.
    const hosts = new Set(http.allowedHosts), origins = new Set(http.allowedOrigins);
    const mcp = createMcpHttpHandler({ broker, allowedHosts: [...new Set([...hosts].map(host => new URL(`http://${host}`).hostname))],
      allowedOrigins: [...origins] });
    const pending = new Set(), closeAbort = new AbortController(); let closing = false, closePromise;
    const externalCalls = new Map();
    const tokenKey = token => typeof token === 'string' && /^hc_[A-Za-z0-9_-]{43}$/.test(token)
      ? createHash('sha256').update(token).digest('hex') : null;
    const releaseExternal = (key, entry) => {
      if (!entry.parked && entry.active.size === 0 && !entry.waiters.size && externalCalls.get(key) === entry) externalCalls.delete(key);
    };
    const externalEntry = key => {
      let entry = externalCalls.get(key);
      if (!entry) { entry = { active: new Set(), waiters: new Set(), parked: false }; externalCalls.set(key, entry); }
      return entry;
    };
    // The connector has no command pump or runtime supervisor. Park
    // admission for this token, drain actual HTTP dependencies, then reuse the
    // existing refresh/renew lane. Socket close alone never frees this fence.
    const beginExternalConnectionMaintenance = (token, { signal } = {}) => {
      const key = tokenKey(token);
      if (!configuration.connectorOnly || !key || !(signal instanceof AbortSignal)) throw new BrokerError('invalid_request');
      if (closing || signal.aborted) throw new BrokerError('backend_unavailable');
      if (pending.size >= 16) throw new BrokerError('busy');
      if (externalCalls.get(key)?.parked) throw new BrokerError('busy');
      const entry = externalEntry(key);
      entry.parked = true;
      const combined = AbortSignal.any([signal, closeAbort.signal]);
      let uncertainDrain = false;
      const work = (async () => {
        await Promise.allSettled([...entry.active]);
        if (closing || combined.aborted) throw new BrokerError('backend_unavailable');
        const operation = maintenance.begin(token, { signal: combined });
        try { return await operation.result; }
        finally { try { await operation.drained; } catch (error) { uncertainDrain = true; throw error; } }
      })();
      const drained = work.then(() => undefined, error => { if (uncertainDrain) throw error; }).finally(() => {
        // Wake waiting MCP requests synchronously: admitted while the fence is
        // open, or refused at once when an uncertain drain retains the fence.
        if (!uncertainDrain) entry.parked = false; else entry.retained = true;
        for (const wake of [...entry.waiters]) wake(!uncertainDrain);
        if (!uncertainDrain) releaseExternal(key, entry);
      });
      pending.add(drained);
      void drained.then(() => pending.delete(drained), () => pending.delete(drained));
      void work.catch(() => {}); void drained.catch(() => {});
      return Object.freeze({ result: work, drained });
    };
    const resolveConnection = (token, { signal } = {}) => {
      if (!(signal instanceof AbortSignal)) return Promise.reject(new BrokerError('invalid_request'));
      if (closing || signal.aborted) return Promise.reject(new BrokerError('backend_unavailable'));
      if (pending.size >= 16) return Promise.reject(new BrokerError('busy'));
      const combined = AbortSignal.any([signal, closeAbort.signal]);
      const work = Promise.resolve().then(async () => {
        // Scope only the finite authority lookup. Preserve the 16-call limit
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
      const externalKey = configuration.connectorOnly && req.url === '/mcp'
        ? tokenKey(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]) : null;
      const parked = externalKey ? externalCalls.get(externalKey) : undefined;
      if (parked?.parked) {
        // Renewal/refresh usually finishes within seconds. Hold the request (and
        // one shared slot) until the fence opens instead of failing the call;
        // admission still happens only while the fence is open, never during it.
        // At most the broker's per-connection concurrency (2) waits; a retained
        // (uncertain) fence never opens, so it refuses at once.
        if (!limits.maintenanceWaitMs || parked.retained || parked.waiters.size >= 2) { reply(res, 503, 'connection_maintenance'); return; }
        waitForFence(req, res, externalKey, parked); return;
      }
      dispatch(req, res, externalKey);
    });
    // Request observers can finish before ignored-abort Auth/SQL/fetch work.
    // Retain the shared admission slot until this finite dependency scope
    // actually drains; no long-lived listeners live in this scope.
    function dispatch(req, res, externalKey) {
      const entry = externalKey ? externalEntry(externalKey) : undefined;
      const requestWork = dependencyScope.begin(async () => {
        if (req.url === '/mcp') await mcp(req, res);
        else if (!await connections(req, res) && !await zalo(req, res)) reply(res, 404, 'not_found');
      });
      const work = (async () => {
        try { await requestWork.result; }
        catch { reply(res, 503, 'backend_unavailable'); }
        finally { await requestWork.drained; }
      })();
      pending.add(work);
      if (entry) {
        entry.active.add(work);
        void work.finally(() => { entry.active.delete(work); releaseExternal(externalKey, entry); }).catch(() => {});
      }
      void work.catch(() => reply(res, 503, 'backend_unavailable')).finally(() => { pending.delete(work); });
    }
    function waitForFence(req, res, key, entry) {
      let settle;
      const waiting = new Promise(resolve => { settle = resolve; });
      const finish = open => {
        if (!entry.waiters.delete(wake)) return;
        clearTimeout(timer); closeAbort.signal.removeEventListener('abort', closed); res.off('close', gone);
        // Dispatch synchronously inside the fence-open callback: no other
        // maintenance can park this token between the check and admission.
        if (open && !closing && !res.destroyed && !entry.parked) dispatch(req, res, key);
        else if (!res.destroyed) reply(res, 503, closing ? 'backend_closed' : 'connection_maintenance');
        releaseExternal(key, entry);
        settle();
      };
      const wake = open => finish(open), closed = () => finish(false), gone = () => finish(false);
      entry.waiters.add(wake);
      const timer = setTimeout(() => finish(false), limits.maintenanceWaitMs);
      closeAbort.signal.addEventListener('abort', closed, { once: true });
      res.once('close', gone);
      pending.add(waiting);
      void waiting.then(() => pending.delete(waiting));
    }
    server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
    server.setTimeout(35_000, socket => { socket.destroy(); });
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
    });
    const close = () => {
      if (closePromise) return closePromise;
      closing = true;
      closeAbort.abort();
      const retentionStopped = retention.close();
      const renewalsStopped = renewal.close();
      const refreshStopped = Promise.all([maintenance.close(), refreshManager.close(), refreshProvider.close()]);
      void refreshStopped.catch(() => {});
      const bindingsStopped = binding.close();
      closePromise = (async () => {
        const stopped = new Promise(resolve => server.close(() => resolve()));
        server.closeAllConnections();
        await stopped;
        await Promise.allSettled([...pending]);
        await retentionStopped;
        await renewalsStopped;
        await refreshStopped;
        await bindingsStopped;
        await dependencyScope.close();
        crypto.destroy();
      })();
      return closePromise;
    };
    return Object.freeze({ server, close, resolveConnection, renewConnection: renewal.renew,
      beginConnectionMaintenance: maintenance.begin, beginExternalConnectionMaintenance,
      startWorkMemoryRetention() { if (closing) throw new BrokerError('backend_unavailable'); retention.start(); },
      workMemoryRetentionStatus: retention.status });
  } catch {
    crypto?.destroy();
    throw new TypeError('invalid_backend_config');
  }
}
