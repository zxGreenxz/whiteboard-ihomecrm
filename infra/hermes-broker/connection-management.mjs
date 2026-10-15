import { BrokerError } from './broker.mjs';
import { DurableConnectionStoreError } from './durable-connection-store.mjs';
import { connectionOptions } from './connection-options.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9._~-]{1,16384}$/;
const CAP = /^[a-z][a-z0-9_.:-]{0,127}$/;
const ROW = ['id', 'assistantId', 'organizationId', 'userId', 'state', 'epoch', 'restrictions', 'scopeIds'];
const CONTEXT = [...ROW, 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'companyCeilings', 'effective'];
const CODES = new Set(['invalid_request', 'reauthentication_required', 'forbidden', 'context_changed', 'cancelled',
  'backend_unavailable', 'operation_rejected', 'operation_outcome_unknown']);
const record = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && UUID.test(value);
const subset = (next, previous) => next.every(key => previous.includes(key));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class ConnectionManagementError extends Error {
  constructor(code, receipt) {
    const safe = CODES.has(code) ? code : 'backend_unavailable';
    super(safe); this.name = 'ConnectionManagementError'; this.code = safe;
    if (receipt) this.receipt = Object.freeze({ ...receipt });
  }
}
const fail = (code, receipt) => { throw new ConnectionManagementError(code, receipt); };
function list(value, predicate, code) {
  if (!Array.isArray(value) || value.length > 256 || Array.from(value).some(item => !predicate(item)) || new Set(value).size !== value.length) fail(code);
  return [...value].sort();
}
function restrictions(value, code) {
  if (!exact(value, ['read', 'action'])) fail(code);
  return Object.fromEntries(['read', 'action'].map(kind => [kind, list(value[kind], key => typeof key === 'string' && CAP.test(key), code)]));
}
function metadata(value, actor, org, keys = ROW) {
  if (!exact(value, keys) || ROW.slice(0, 4).some(key => !uuid(value[key])) || value.userId !== actor || value.organizationId !== org ||
      !['pending', 'active', 'revoked'].includes(value.state) || !positive(value.epoch) || value.epoch >= Number.MAX_SAFE_INTEGER) fail('backend_unavailable');
  return { id: value.id, assistantId: value.assistantId, organizationId: org, userId: actor, state: value.state, epoch: value.epoch,
    restrictions: restrictions(value.restrictions, 'backend_unavailable'), scopeIds: list(value.scopeIds, uuid, 'backend_unavailable') };
}
function contextMetadata(value, actor, org, id) {
  const row = metadata(value, actor, org, CONTEXT);
  if (row.id !== id || row.state !== 'active' || !uuid(value.membershipId) || !positive(value.authorizationVersion) ||
      !(value.policyVersion === 0 || positive(value.policyVersion)) || typeof value.isSuperadmin !== 'boolean') fail('backend_unavailable');
  const companyCeilings = restrictions(value.companyCeilings, 'backend_unavailable');
  const effective = restrictions(value.effective, 'backend_unavailable');
  if (['read', 'action'].some(kind => !subset(effective[kind], row.restrictions[kind]) || !subset(effective[kind], companyCeilings[kind]))) fail('backend_unavailable');
  return { ...row, membershipId: value.membershipId, authorizationVersion: value.authorizationVersion,
    isSuperadmin: value.isSuperadmin, policyVersion: value.policyVersion, companyCeilings, effective };
}
const OWNER_READS = ['list', 'options', 'status'];
function inputRequest(input, operation) {
  const keys = ['browserAccessToken', 'organizationId'];
  if (!OWNER_READS.includes(operation)) keys.push('connectionId');
  if (['restrict', 'revoke'].includes(operation)) keys.push('expectedEpoch');
  if (operation === 'restrict') keys.push('restrictions', 'scopeIds');
  if (!exact(input, keys) || typeof input.browserAccessToken !== 'string' || !TOKEN.test(input.browserAccessToken) ||
      !uuid(input.organizationId) || (!OWNER_READS.includes(operation) && !uuid(input.connectionId)) ||
      (keys.includes('expectedEpoch') && (!positive(input.expectedEpoch) || input.expectedEpoch >= Number.MAX_SAFE_INTEGER))) fail('invalid_request');
  const request = { ...input };
  if (operation === 'restrict') {
    request.restrictions = restrictions(input.restrictions, 'invalid_request'); request.scopeIds = list(input.scopeIds, uuid, 'invalid_request');
  }
  return request;
}
function verified(value, now) {
  if (!exact(value, ['userId', 'sessionId', 'expiresAt']) || !uuid(value.userId) || !uuid(value.sessionId) ||
      !positive(value.expiresAt) || value.expiresAt <= now) fail('reauthentication_required');
  return { ...value };
}
function authorization(value, actor, org, now) {
  if (!record(value) || value.userId !== actor || typeof value.isSuperadmin !== 'boolean' ||
      typeof value.epoch !== 'string' || value.epoch.length < 1 || value.epoch.length > 256) fail('forbidden');
  const active = list(value.activeOrganizationIds, uuid, 'forbidden');
  if (!active.includes(org) || (!value.isSuperadmin && active.length !== 1)) fail('forbidden');
  const m = value.membership;
  if (!exact(m, ['organizationId', 'status', 'revokedAt', 'validFrom', 'validTo', 'membershipId', 'authorizationVersion']) ||
      !uuid(m.membershipId) || !positive(m.authorizationVersion) || m.organizationId !== org || m.status !== 'ACTIVE' || m.revokedAt !== null ||
      !(m.validFrom === null || (positive(m.validFrom) && m.validFrom <= now)) ||
      !(m.validTo === null || (positive(m.validTo) && m.validTo > now))) fail('forbidden');
  // Scalars and canonical arrays are copied before any subsequent await. The
  // adapter's epoch also binds its current CRM scope/permission projection.
  return { epoch: value.epoch, isSuperadmin: value.isSuperadmin, activeOrganizationIds: active,
    membership: { organizationId: org, status: m.status, revokedAt: m.revokedAt, validFrom: m.validFrom, validTo: m.validTo,
      membershipId: m.membershipId, authorizationVersion: m.authorizationVersion },
    permissions: restrictions(value.permissions, 'forbidden'), companyCeilings: restrictions(value.companyCeilings, 'forbidden') };
}
function contextMatchesAuthority(context, current) {
  if (context.membershipId !== current.membership.membershipId ||
      context.authorizationVersion !== current.membership.authorizationVersion || context.isSuperadmin !== current.isSuperadmin ||
      ['read', 'action'].some(kind => !subset(context.effective[kind], current.permissions[kind]) ||
        !subset(context.effective[kind], current.companyCeilings[kind]))) fail('context_changed');
}
function sanitize(error, write, receipt) {
  if (error instanceof ConnectionManagementError) return error;
  if (error instanceof BrokerError) {
    if (error.code === 'unauthorized') return new ConnectionManagementError('reauthentication_required');
    if (['forbidden', 'context_changed'].includes(error.code)) return new ConnectionManagementError(error.code);
  }
  if (write && error instanceof DurableConnectionStoreError) {
    const known = { store_denied: 'forbidden', store_conflict: 'context_changed', store_rejected: 'operation_rejected' };
    if (Object.hasOwn(known, error.code)) return new ConnectionManagementError(known[error.code], receipt);
  }
  return new ConnectionManagementError(write ? 'operation_outcome_unknown' : 'backend_unavailable', write ? receipt : undefined);
}
async function bounded(signal, timeoutMs, operation, outcome, dependencyScope) {
  if (!(signal instanceof AbortSignal)) fail('invalid_request');
  if (signal.aborted) throw outcome('cancelled');
  const controller = new AbortController(); let rejectAbort, reason;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const stop = code => { reason ??= code; controller.abort(); rejectAbort(outcome(reason)); };
  const onAbort = () => stop('cancelled'); signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => stop('backend_unavailable'), timeoutMs);
  const check = () => { if (signal.aborted || controller.signal.aborted) throw outcome(reason ?? 'cancelled'); };
  const work = () => { check(); return operation(controller.signal, check); };
  try { return await Promise.race([Promise.resolve().then(() => dependencyScope ? dependencyScope.track(work) : work()), aborted]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); controller.abort(); }
}

/** Browser control-plane orchestration, never exposed as an MCP tool.
 * auth must verify actual Auth and current CRM membership, with the durable Auth
 * adapter's membershipId/authorizationVersion and epoch contract; missing fields
 * deny, including an unextended P1 adapter. reads must be the fixed
 * self-owned public RPC adapter below, using that SAME browser bearer. Private
 * store methods provide CAS, not browser authorization, so they are called only
 * after ownership/org/limits checks and a second actual Auth/CRM check.
 * Reads are metadata, not proof that an assistant provider session/runtime lives.
 * Context reads fence the entire public context once more after final Auth/CRM,
 * so a policy or connection change during that check cannot return stale context.
 * These are bounded observations, not a transaction across Auth and PostgreSQL.
 * Revoke accepts self-owned pending/revoked/expired rows from the list, so it does
 * not depend on a healthy assistant session or enabled assistant policy.
 * Lost write ACK is unknown; no retries, new credentials or cached admission.
 * status (optional health port) answers connector activity only for the ids
 * the verified owner list returned for this actor/org, after the final recheck.
 */
export function createConnectionManagement({ auth, reads, connectionStore, health, clock = Date.now, timeoutMs = 30_000 } = {}) {
  if ([auth?.verifySession, auth?.readAuthorization, reads?.listConnections, reads?.connectionContext,
    connectionStore?.restrictConnection, connectionStore?.revokeConnection, clock].some(fn => typeof fn !== 'function') ||
      (health !== undefined && typeof health?.snapshot !== 'function') ||
      !positive(timeoutMs) || timeoutMs > 30_000) throw new TypeError('invalid_connection_management_config');
  const now = () => { const value = clock(); if (!positive(value)) fail('backend_unavailable'); return value; };
  async function execute(operation, input, { signal } = {}) {
    const request = inputRequest(input, operation); let write = false, receipt;
    const outcome = code => new ConnectionManagementError(write ? 'operation_outcome_unknown' : code, write ? receipt : undefined);
    try {
      return await bounded(signal, timeoutMs, async (innerSignal, check) => {
        const checkLifetime = current => {
          check();
          const observedAt = now();
          if (current.session.expiresAt <= observedAt) throw outcome('reauthentication_required');
          if (current.membership.validTo !== null && current.membership.validTo <= observedAt) throw outcome('forbidden');
        };
        const principal = async () => {
          const session = verified(await auth.verifySession({ accessToken: request.browserAccessToken, signal: innerSignal }), now()); check();
          const current = authorization(await auth.readAuthorization({ accessToken: request.browserAccessToken, userId: session.userId,
            organizationId: request.organizationId, signal: innerSignal }), session.userId, request.organizationId, now()); check();
          const result = { session, ...current };
          // Authz can complete after the already-verified browser JWT expires.
          checkLifetime(result); return result;
        };
        const initial = await principal();
        const recheck = async () => {
          const current = await principal();
          if (!same(current, initial)) fail('context_changed');
          return current;
        };
        const ownList = async () => {
          const raw = await reads.listConnections({ accessToken: request.browserAccessToken, organizationId: request.organizationId }, { signal: innerSignal }); check();
          if (!Array.isArray(raw) || raw.length > 256) fail('backend_unavailable');
          const rows = Array.from(raw, value => metadata(value, initial.session.userId, request.organizationId));
          if (new Set(rows.map(row => row.id)).size !== rows.length) fail('backend_unavailable');
          return rows;
        };
        const ownContext = async () => {
          const raw = await reads.connectionContext({ accessToken: request.browserAccessToken, connectionId: request.connectionId }, { signal: innerSignal }); check();
          return contextMetadata(raw, initial.session.userId, request.organizationId, request.connectionId);
        };
        if (operation === 'options') {
          const choices = async () => {
            const raw = await reads.connectionOptions({ accessToken: request.browserAccessToken, organizationId: request.organizationId }, { signal: innerSignal }); check();
            const value = connectionOptions(raw, request.organizationId, initial.session.userId);
            if (value.membershipId !== initial.membership.membershipId || value.authorizationVersion !== initial.membership.authorizationVersion ||
                value.isSuperadmin !== initial.isSuperadmin || ['read', 'action'].some(kind => value[kind].some(key => !initial.permissions[kind].includes(key) || !initial.companyCeilings[kind].includes(key)))) fail('context_changed');
            return value;
          };
          const before = await choices(), current = await recheck(), options = await choices();
          if (!same(before, options)) fail('context_changed');
          checkLifetime(current); return { options };
        }
        if (operation === 'list') {
          const connections = await ownList(); const current = await recheck(); checkLifetime(current);
          return { connections };
        }
        if (operation === 'status') {
          const connections = await ownList(); const current = await recheck(); checkLifetime(current);
          return health.snapshot(connections.map(row => row.id));
        }
        if (operation === 'context') {
          const context = await ownContext(); contextMatchesAuthority(context, initial);
          const current = await recheck();
          const finalContext = await ownContext(); contextMatchesAuthority(finalContext, current);
          if (!same(finalContext, context)) fail('context_changed');
          checkLifetime(current);
          return { context: finalContext };
        }
        const previous = (await ownList()).find(row => row.id === request.connectionId);
        if (!previous) fail('forbidden');
        if (previous.epoch !== request.expectedEpoch) fail('context_changed');
        let effective;
        if (operation === 'restrict') {
          if (previous.state !== 'active') fail('context_changed');
          effective = await ownContext();
          contextMatchesAuthority(effective, initial);
          if (!same(Object.fromEntries(ROW.map(key => [key, effective[key]])), previous)) fail('context_changed');
          if (['read', 'action'].some(kind => !subset(request.restrictions[kind], previous.restrictions[kind]) ||
            !subset(request.restrictions[kind], effective.companyCeilings[kind])) || !subset(request.scopeIds, previous.scopeIds)) fail('forbidden');
        }
        // The final Auth/CRM check follows all metadata reads. SQL checks the
        // immutable owner binding/current membership and atomically fences epoch.
        const current = await recheck(); check();
        if (operation === 'restrict' && ['read', 'action'].some(kind => !subset(request.restrictions[kind], current.permissions[kind]) ||
            !subset(request.restrictions[kind], current.companyCeilings[kind]))) fail('forbidden');
        checkLifetime(current);
        receipt = { connectionId: previous.id, expectedEpoch: previous.epoch, operation };
        write = true;
        if (operation === 'restrict') {
          const result = await connectionStore.restrictConnection({ connection: previous, restrictions: request.restrictions,
            scopeIds: request.scopeIds }, { signal: innerSignal }); check();
          if (!exact(result, ['ok', 'connection']) || result.ok !== true) throw outcome('operation_outcome_unknown');
          let row;
          try { row = metadata(result.connection, previous.userId, previous.organizationId); } catch { throw outcome('operation_outcome_unknown'); }
          if (row.id !== previous.id || row.assistantId !== previous.assistantId || row.state !== 'active' || row.epoch !== previous.epoch + 1 ||
              !same(row.restrictions, request.restrictions) || !same(row.scopeIds, request.scopeIds)) throw outcome('operation_outcome_unknown');
          checkLifetime(current);
          return { ok: true, connection: row };
        }
        const result = await connectionStore.revokeConnection({ connectionId: previous.id, expectedEpoch: previous.epoch }, { signal: innerSignal }); check();
        if (!exact(result, ['ok', 'status']) || result.ok !== true || !['revoked', 'already_revoked'].includes(result.status)) throw outcome('operation_outcome_unknown');
        checkLifetime(current);
        return { ok: true, status: result.status, connectionId: previous.id };
      }, outcome);
    } catch (error) { throw sanitize(error, write, receipt); }
  }
  return Object.freeze(Object.fromEntries(['list', 'context', 'options', 'restrict', 'revoke', ...(health ? ['status'] : [])].map(operation => [operation,
    (input, options) => execute(operation, input, options)])));
}

async function readJson(response, limit, signal) {
  if (response.redirected || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      Number(response.headers.get('content-length')) > limit) { await response.body?.cancel().catch(() => {}); fail('backend_unavailable'); }
  const reader = response.body.getReader(), chunks = []; let bytes = 0;
  let cancellation;
  const stop = () => cancellation ??= reader.cancel().catch(() => {}); signal.addEventListener('abort', stop, { once: true });
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > limit) fail('backend_unavailable'); chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener('abort', stop); await stop(); reader.releaseLock(); }
}

/** Fixed public self-owned read RPCs. No caller-selected host, RPC, role or SQL.
 * Response shape/ownership are validated by management before use. No secret
 * columns are selected and no write retry/control operation exists here.
 */
export function createSupabaseConnectionManagementReads({ url, publishableKey, fetch: transport = globalThis.fetch,
  timeoutMs = 10_000, maxResponseBytes = 131072, dependencyScope } = {}) {
  let origin; try { origin = new URL(url); } catch { throw new TypeError('invalid_management_reads_config'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(publishableKey) || typeof transport !== 'function' ||
      !positive(timeoutMs) || timeoutMs > 30_000 || !positive(maxResponseBytes) || maxResponseBytes > 131072 ||
      (dependencyScope !== undefined && typeof dependencyScope?.track !== 'function')) throw new TypeError('invalid_management_reads_config');
  const fixed = { listConnections: { path: '/rest/v1/rpc/hermes_my_connections_v1', key: 'organizationId', arg: 'p_org' },
    // v6 = task-follow(v5) and v5 = finance(task(v4)) at runtime; older names
    // are negotiated only on an exact PGRST202 while a lane is still applying.
    connectionOptions: { path: '/rest/v1/rpc/hermes_connection_options_v6', legacyPaths: ['/rest/v1/rpc/hermes_connection_options_v5', '/rest/v1/rpc/hermes_connection_options_v4', '/rest/v1/rpc/hermes_connection_options_v3', '/rest/v1/rpc/hermes_connection_options_v2', '/rest/v1/rpc/hermes_connection_options_v1'], key: 'organizationId', arg: 'p_org' },
    connectionContext: { path: '/rest/v1/rpc/hermes_connection_context_v6', legacyPaths: ['/rest/v1/rpc/hermes_connection_context_v5', '/rest/v1/rpc/hermes_connection_context_v4', '/rest/v1/rpc/hermes_connection_context_v3', '/rest/v1/rpc/hermes_connection_context_v2', '/rest/v1/rpc/hermes_connection_context_v1'], key: 'connectionId', arg: 'p_connection_id' } };
  return Object.freeze(Object.fromEntries(Object.entries(fixed).map(([operation, endpoint]) => [operation, async (input, { signal } = {}) => {
    if (!exact(input, ['accessToken', endpoint.key]) || typeof input.accessToken !== 'string' || !TOKEN.test(input.accessToken) || !uuid(input[endpoint.key])) fail('invalid_request');
    const bearer = input.accessToken, body = JSON.stringify({ [endpoint.arg]: input[endpoint.key] });
    try {
      return await bounded(signal, timeoutMs, async (innerSignal, check) => {
        const read = async path => {
          const response = await transport(new URL(path, origin).href, { method: 'POST', redirect: 'error', signal: innerSignal,
            headers: { apikey: publishableKey, authorization: `Bearer ${bearer}`, 'content-type': 'application/json',
              'content-profile': 'public', 'accept-profile': 'public' }, body });
          if (innerSignal.aborted) { await response.body?.cancel().catch(() => {}); check(); }
          const result = await readJson(response, maxResponseBytes, innerSignal); check();
          return { response, result };
        };
        let { response, result } = await read(endpoint.path);
        // Negotiate only an exact missing read RPC within this same deadline.
        // Denied, malformed and uncertain responses never downgrade authority.
        for (const legacyPath of endpoint.legacyPaths ?? []) {
          if (!(response.status === 404 && exact(result, ['code', 'message', 'details', 'hint']) &&
            result.code === 'PGRST202' && typeof result.message === 'string' &&
            [result.details, result.hint].every(value => value === null || typeof value === 'string'))) break;
          ({ response, result } = await read(legacyPath));
        }
        if (response.status === 401) fail('reauthentication_required');
        if (response.status === 403) fail('forbidden');
        if (!response.ok) fail('backend_unavailable');
        return result;
      }, code => new ConnectionManagementError(code), dependencyScope);
    } catch (error) { throw sanitize(error, false); }
  }])));
}
