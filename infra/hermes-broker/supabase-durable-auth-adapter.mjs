import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { createSupabaseAuthAdapter } from './supabase-adapter.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[\x21-\x7e]{1,16384}$/;
const PATHS = Object.freeze({ user: '/auth/v1/user', context: '/rest/v1/rpc/get_authorization_context_v1',
  directory: '/rest/v1/rpc/get_my_organizations', scope: '/rest/v1/rpc/hermes_scope_buildings_v1' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const fail = code => { throw new BrokerError(code); };
const unavailable = () => fail('backend_unavailable');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cancel = async response => { await response.body?.cancel().catch(() => {}); };

async function readJson(response, limit, signal) {
  if (response.redirected || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length')) > limit) { await cancel(response); unavailable(); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  let cancellation;
  const stop = () => cancellation ??= reader.cancel().catch(() => {});
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (true) {
      if (signal.aborted) unavailable();
      const { done, value } = await reader.read();
      if (signal.aborted) unavailable();
      if (done) break;
      size += value.byteLength; if (size > limit) unavailable(); chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { unavailable(); }
  } finally { signal.removeEventListener('abort', stop); await stop(); reader.releaseLock(); }
}
function ids(value, max = 256) {
  if (!Array.isArray(value) || value.length > max || Array.from(value).some(item => !uuid(item))) unavailable();
  return [...new Set(value)].sort();
}

/** Extension of the existing P1 Auth adapter, not another permission engine.
 * verifySession delegates to its actual /auth/v1/user validation. Authorization
 * delegates to its strict membership/candidate probes and fixed rooms.view bit.
 * This wrapper bounds I/O and captures metadata inside ONE request-local closure.
 * It never reads env, accepts endpoint/permission arguments, retries, or refreshes.
 *
 * Membership ID/version come from get_authorization_context_v1. Selected-org
 * BUILDING IDs come ONLY from hermes_scope_buildings_v1('rooms.view', org),
 * which checks active/revoked/time membership and expands orgWide server-side.
 * scopeSets, frontend orgWide flags and other-org probe scopes are NOT authority
 * for this result. Self-context has no resource IDs. No cashbook permission is
 * exposed; cashbookIds stays empty. The two P1 read bits are informational until
 * SQL policy/connection restrictions and a reviewed business tool also allow use.
 * DurableAuthority separately matches membership against SQL and preserves its
 * authorization_scopes.id constraints; this adapter never mixes that namespace.
 */
export function createSupabaseDurableAuthAdapter({ url, publishableKey, fetch: request = globalThis.fetch,
  clock = Date.now, timeoutMs = 10000, maxResponseBytes = 131072, dependencyScope } = {}) {
  let origin;
  try { origin = new URL(url); } catch { throw new TypeError('invalid_durable_auth_config'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(publishableKey) ||
      typeof request !== 'function' || typeof clock !== 'function' || !positive(timeoutMs) || timeoutMs > 30000 ||
      !positive(maxResponseBytes) || maxResponseBytes > 131072 ||
      (dependencyScope !== undefined && typeof dependencyScope?.track !== 'function')) throw new TypeError('invalid_durable_auth_config');
  const baseUrl = origin.href;
  const checkedClock = () => { const value = clock(); if (!positive(value)) unavailable(); return value; };
  async function bounded(signal, operation) {
    if (!(signal instanceof AbortSignal) || signal.aborted) unavailable();
    const controller = new AbortController(); let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = () => { controller.abort(); rejectAbort(new BrokerError('backend_unavailable')); };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, timeoutMs);
    try {
      const run = () => {
        if (controller.signal.aborted) unavailable(); return operation(controller.signal);
      };
      const result = await Promise.race([dependencyScope ? dependencyScope.track(run) : Promise.resolve().then(run), aborted]);
      if (controller.signal.aborted) unavailable(); return result;
    } catch (error) {
      if (error instanceof BrokerError && ['unauthorized', 'forbidden', 'backend_unavailable'].includes(error.code)) throw error;
      unavailable();
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); controller.abort(); }
  }
  function client(accessToken, signal, selectedOrg, capture) {
    return createSupabaseAuthAdapter({ url: baseUrl, publishableKey, clock: checkedClock, fetch: async (target, options) => {
      const endpoint = new URL(target);
      if (endpoint.origin !== origin.origin || endpoint.search || endpoint.hash || !Object.values(PATHS).includes(endpoint.pathname) ||
          options.signal !== signal || options.redirect !== 'error') unavailable();
      const path = endpoint.pathname;
      if ((selectedOrg === undefined) !== (path === PATHS.user)) unavailable();
      let args;
      if (path === PATHS.user) {
        if (options.method !== 'GET' || options.body !== undefined) unavailable();
      } else {
        if (options.method !== 'POST') unavailable();
        try { args = JSON.parse(options.body); } catch { unavailable(); }
        if (path === PATHS.context && (!exact(args, ['p_organization_id']) || args.p_organization_id !== selectedOrg)) unavailable();
        if (path === PATHS.directory && !exact(args, [])) unavailable();
        if (path === PATHS.scope && (!exact(args, ['p_permission_key', 'p_organization_id']) ||
            args.p_permission_key !== 'rooms.view' || !uuid(args.p_organization_id))) unavailable();
      }
      if (signal.aborted) unavailable();
      const response = await request(endpoint.href, { method: options.method, redirect: 'error', signal,
        headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
          ...(path !== PATHS.user ? { 'content-profile': 'public', 'accept-profile': 'public' } : {}) },
        ...(args === undefined ? {} : { body: JSON.stringify(args) }) });
      if (signal.aborted) { await cancel(response); unavailable(); }
      const data = await readJson(response, maxResponseBytes, signal);
      if (!response.ok) {
        if (response.status === 401) fail('unauthorized');
        if (response.status === 403 || data?.code === '42501') fail('forbidden');
        unavailable();
      }
      if (record(data) && ['error', 'error_code', 'error_description'].some(key => Object.hasOwn(data, key))) unavailable();
      let projected;
      if (path === PATHS.user) {
        if (!record(data) || !uuid(data.id)) unavailable();
        projected = { id: data.id };
      } else if (path === PATHS.context) {
        if (!record(data)) unavailable();
        if (data.organizationId !== selectedOrg || data.isOffboarded === true) fail('forbidden');
        if (!uuid(data.membershipId) || !positive(data.authorizationVersion) || typeof data.isPlatformAdmin !== 'boolean' ||
            data.isOffboarded !== false || !record(data.permissions) ||
            (Object.hasOwn(data.permissions, 'rooms.view') && typeof data.permissions['rooms.view'] !== 'boolean') || capture.context) unavailable();
        capture.context = Object.freeze({ membershipId: data.membershipId, authorizationVersion: data.authorizationVersion });
        projected = { organizationId: data.organizationId, ...capture.context, isPlatformAdmin: data.isPlatformAdmin,
          isOffboarded: false, permissions: { 'rooms.view': data.permissions['rooms.view'] === true } };
      } else if (path === PATHS.directory) {
        if (!record(data) || !uuid(data.user_id) || !Array.isArray(data.organizations)) unavailable();
        const organizations = ids(data.organizations.map(item => item?.id));
        projected = { user_id: data.user_id, organizations: organizations.map(id => ({ id })) };
      } else {
        projected = ids(data);
        if (args.p_organization_id === selectedOrg) {
          if (capture.buildingIds) unavailable(); capture.buildingIds = Object.freeze([...projected]);
        }
      }
      return new Response(JSON.stringify(projected), { headers: { 'content-type': 'application/json' } });
    } });
  }
  return Object.freeze({
    async verifySession({ accessToken, signal } = {}) {
      if (typeof accessToken !== 'string' || !TOKEN.test(accessToken)) fail('unauthorized');
      return bounded(signal, innerSignal => client(accessToken, innerSignal).verifySession({ accessToken, signal: innerSignal }));
    },
    async readAuthorization({ accessToken, userId, organizationId, signal } = {}) {
      if (typeof accessToken !== 'string' || !TOKEN.test(accessToken)) fail('unauthorized');
      if (!uuid(userId) || !uuid(organizationId)) fail('forbidden');
      return bounded(signal, async innerSignal => {
        const capture = {}; // Never shared across actors, organizations, or requests.
        const current = await client(accessToken, innerSignal, organizationId, capture).readAuthorization({
          accessToken, userId, organizationId, signal: innerSignal,
        });
        if (innerSignal.aborted || !capture.context || !capture.buildingIds) unavailable();
        const scopesByPermission = { 'assistant.context.read': { buildingIds: [], cashbookIds: [] } };
        if (current.permissions.read.includes('rooms.view')) scopesByPermission['rooms.view'] = { buildingIds: [...capture.buildingIds], cashbookIds: [] };
        return { ...current, membership: { ...current.membership, ...capture.context }, scopesByPermission,
          epoch: hash({ authorizationEpoch: current.epoch, membership: capture.context, scopesByPermission }) };
      });
    },
  });
}
