import { ConnectionControlError } from './connection-control-plane.mjs';
import { ConnectionManagementError } from './connection-management.mjs';

const PREFIX = '/api/hermes/connections/';
const OPERATIONS = ['connect', 'list', 'context', 'restrict', 'revoke'];
const WRITES = new Set(['connect', 'restrict', 'revoke']);
const MAX_BODY_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CAP = /^[a-z][a-z0-9_.:-]{0,127}$/;
const ROW = ['id', 'assistantId', 'organizationId', 'userId', 'state', 'epoch', 'restrictions', 'scopeIds'];
const CONTEXT = [...ROW, 'membershipId', 'authorizationVersion', 'isSuperadmin', 'policyVersion', 'companyCeilings', 'effective'];
const STATUS = Object.freeze({ invalid_request: 400, reauthentication_required: 401, forbidden: 403, context_changed: 409,
  cancelled: 408, timeout: 504, backend_unavailable: 503, additional_authentication_required: 403,
  sign_in_outcome_unknown: 503, prepare_rejected: 409, prepare_outcome_unknown: 503,
  activation_rejected: 409, activation_outcome_unknown: 503, operation_rejected: 409, operation_outcome_unknown: 503 });
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const validList = (value, check) => Array.isArray(value) && value.length <= 256 &&
  Array.from(value).every(check) && new Set(value).size === value.length;
const limits = value => exact(value, ['read', 'action']) && ['read', 'action'].every(kind =>
  validList(value[kind], key => typeof key === 'string' && CAP.test(key)));
const sameSet = (a, b) => a.length === b.length && a.every(value => b.includes(value));
const sameLimits = (a, b) => ['read', 'action'].every(kind => sameSet(a[kind], b[kind]));
class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const invalid = () => { throw new HttpError(400, 'invalid_request'); };
const badOutput = () => { throw new Error('invalid_dependency_output'); };

function allowedConfiguration(values, origin) {
  if (!Array.isArray(values) || values.length > 64 || (!origin && values.length === 0) || new Set(values).size !== values.length) return false;
  return values.every(value => {
    if (typeof value !== 'string' || value.length > 512) return false;
    try {
      const parsed = new URL(origin ? value : `http://${value}`);
      return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password &&
        parsed.pathname === '/' && !parsed.search && !parsed.hash && (origin ? parsed.origin === value : parsed.host === value);
    } catch { return false; }
  });
}
function inputBody(value, operation) {
  const fields = ['organizationId'];
  if (operation === 'connect') fields.push('email', 'password', 'restrictions', 'scopeIds');
  if (!['connect', 'list'].includes(operation)) fields.push('connectionId');
  if (['restrict', 'revoke'].includes(operation)) fields.push('expectedEpoch');
  if (operation === 'restrict') fields.push('restrictions', 'scopeIds');
  if (!exact(value, fields) || !id(value.organizationId) ||
      (fields.includes('connectionId') && !id(value.connectionId)) ||
      (fields.includes('expectedEpoch') && !positive(value.expectedEpoch)) ||
      (fields.includes('scopeIds') && (!validList(value.scopeIds, id) || !limits(value.restrictions)))) invalid();
  if (operation === 'connect' && (typeof value.email !== 'string' || value.email.length > 320 ||
      !/^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(value.email) ||
      typeof value.password !== 'string' || value.password.length < 1 || Buffer.byteLength(value.password) > 4096 ||
      value.restrictions.action.length !== 0 || value.restrictions.read.some(key => key !== 'assistant.context.read'))) invalid();
  return value;
}
function row(value, org, fields = ROW) {
  if (!exact(value, fields) || ROW.slice(0, 4).some(key => !id(value[key])) || value.organizationId !== org ||
      !['pending', 'active', 'revoked'].includes(value.state) || !positive(value.epoch) ||
      !limits(value.restrictions) || !validList(value.scopeIds, id)) badOutput();
  return Object.fromEntries(ROW.map(key => [key, structuredClone(value[key])]));
}
function output(value, operation, input) {
  if (operation === 'connect') {
    if (!exact(value, ['status', 'connection', 'token', 'tokenExpiresAt']) || value.status !== 'active' ||
        typeof value.token !== 'string' || !/^hc_[A-Za-z0-9_-]{43}$/.test(value.token) || !positive(value.tokenExpiresAt)) badOutput();
    const connection = row(value.connection, input.organizationId);
    if (connection.state !== 'active' || !sameLimits(connection.restrictions, input.restrictions) || !sameSet(connection.scopeIds, input.scopeIds)) badOutput();
    // The sole credential allowed over this browser boundary is the one-time
    // opaque handoff from successful connect. No provider token is serialized.
    return { status: 'active', connection, token: value.token, tokenExpiresAt: value.tokenExpiresAt };
  }
  if (operation === 'list') {
    if (!exact(value, ['connections']) || !Array.isArray(value.connections) || value.connections.length > 256) badOutput();
    const connections = Array.from(value.connections, item => row(item, input.organizationId));
    if (new Set(connections.map(item => item.id)).size !== connections.length) badOutput();
    return { connections };
  }
  if (operation === 'context') {
    if (!exact(value, ['context'])) badOutput();
    const context = row(value.context, input.organizationId, CONTEXT), raw = value.context;
    if (context.id !== input.connectionId || context.state !== 'active' || !id(raw.membershipId) ||
        !positive(raw.authorizationVersion) || !positive(raw.policyVersion) || typeof raw.isSuperadmin !== 'boolean' ||
        !limits(raw.companyCeilings) || !limits(raw.effective) || ['read', 'action'].some(kind =>
          raw.effective[kind].some(key => !context.restrictions[kind].includes(key) || !raw.companyCeilings[kind].includes(key)))) badOutput();
    return { context: { ...context, ...Object.fromEntries(CONTEXT.slice(ROW.length).map(key => [key, structuredClone(raw[key])])) } };
  }
  if (operation === 'restrict') {
    if (!exact(value, ['ok', 'connection']) || value.ok !== true) badOutput();
    const connection = row(value.connection, input.organizationId);
    if (connection.id !== input.connectionId || connection.state !== 'active' || connection.epoch !== input.expectedEpoch + 1 ||
        !sameLimits(connection.restrictions, input.restrictions) || !sameSet(connection.scopeIds, input.scopeIds)) badOutput();
    return { ok: true, connection };
  }
  if (!exact(value, ['ok', 'status', 'connectionId']) || value.ok !== true ||
      !['revoked', 'already_revoked'].includes(value.status) || value.connectionId !== input.connectionId) badOutput();
  return { ok: true, status: value.status, connectionId: value.connectionId };
}
function safeReceipt(value, operation) {
  if (operation === 'connect' && exact(value, ['connectionId', 'operationId']) && id(value.connectionId) && id(value.operationId)) {
    return { connectionId: value.connectionId, operationId: value.operationId };
  }
  if (['restrict', 'revoke'].includes(operation) && exact(value, ['connectionId', 'expectedEpoch', 'operation']) &&
      id(value.connectionId) && positive(value.expectedEpoch) && value.operation === operation) {
    return { connectionId: value.connectionId, expectedEpoch: value.expectedEpoch, operation };
  }
  return undefined;
}
function safeError(error, operation, dispatched) {
  if (error instanceof HttpError) return { status: error.status, body: { error: error.code } };
  const expectedClass = operation === 'connect' ? ConnectionControlError : ConnectionManagementError;
  if (error instanceof expectedClass && Object.hasOwn(STATUS, error.code)) {
    const receipt = safeReceipt(error.receipt, operation);
    return { status: STATUS[error.code], body: { error: error.code, ...(receipt ? { receipt } : {}) } };
  }
  const code = dispatched && WRITES.has(operation) ? 'operation_outcome_unknown' : 'backend_unavailable';
  return { status: STATUS[code], body: { error: code } };
}
function reply(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...(status >= 400 ? { connection: 'close' } : {}) });
  response.end(JSON.stringify(body));
}
function readBody(request, signal) {
  return new Promise((resolve, reject) => {
    let chunks = [], bytes = 0;
    const cleanup = () => {
      request.removeListener('data', data); request.removeListener('end', end);
      request.removeListener('error', error); request.removeListener('aborted', abort);
      signal.removeEventListener('abort', abort);
    };
    const error = value => { cleanup(); chunks = []; request.pause(); reject(value); };
    const abort = () => error(new HttpError(408, 'cancelled'));
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { error(new HttpError(413, 'body_too_large')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new HttpError(400, 'invalid_json')); }
      finally { chunks = []; }
    };
    if (signal.aborted || request.aborted) { abort(); return; }
    request.on('data', data); request.once('end', end); request.once('error', error); request.once('aborted', abort);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Embeddable browser control-plane handler; return false for non-owned routes.
 * All five routes are POST /api/hermes/connections/{connect,list,context,restrict,revoke}.
 * The browser bearer is a syntactic JWT only here; the injected existing control
 * and management primitives MUST perform actual Auth/CRM ownership verification.
 * No cookie, forwarded Host, caller-selected provider, CORS or OPTIONS fallback.
 * Deploy behind reviewed TLS and header/request timeouts; this does not listen.
 * Same-origin browser deployment needs no CORS headers. Origin allowlists also
 * apply to reads, and writes require an Origin. Host includes any explicit port.
 * Deadline/disconnect aborts the dependency signal. A dispatched write with no
 * known result stays unknown, never a claimed clean cancellation or retry cue.
 * A dependency ignoring abort retains its concurrency slot until it settles;
 * this bounds orphan work without pretending an HTTP timeout rolls back a write.
 * No logger or durable credential delivery exists here; loss of connect's HTTP
 * response can lose its one-time opaque token and requires reconciliation.
 */
export function createConnectionHttpHandler({ controlPlane, management, allowedHosts, allowedOrigins = [],
  timeoutMs = 30_000, maxConcurrentRequests = 16 } = {}) {
  if (typeof controlPlane?.connect !== 'function' || ['list', 'context', 'restrict', 'revoke'].some(key => typeof management?.[key] !== 'function') ||
      !allowedConfiguration(allowedHosts, false) || !allowedConfiguration(allowedOrigins, true) ||
      !positive(timeoutMs) || timeoutMs > 30_000 || !positive(maxConcurrentRequests) || maxConcurrentRequests > 64) {
    throw new TypeError('invalid_connection_http_config');
  }
  const hosts = new Set(allowedHosts), origins = new Set(allowedOrigins);
  let active = 0;
  return async function handleConnectionHttp(request, response) {
    const operation = typeof request.url === 'string' && request.url.startsWith(PREFIX) ? request.url.slice(PREFIX.length) : '';
    if (!OPERATIONS.includes(operation)) return false;
    let dispatched = false, body, input;
    const seen = new Set();
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (seen.has(name)) { reply(response, 400, { error: 'duplicate_header' }); return true; }
      seen.add(name);
    }
    if (seen.size > 32) { reply(response, 431, { error: 'too_many_headers' }); return true; }
    if (!hosts.has(request.headers.host) || (request.headers.origin !== undefined && !origins.has(request.headers.origin)) ||
        (WRITES.has(operation) && request.headers.origin === undefined)) {
      reply(response, 403, { error: 'forbidden' }); return true;
    }
    if (request.method !== 'POST') { response.setHeader('allow', 'POST'); reply(response, 405, { error: 'method_not_allowed' }); return true; }
    if (request.headers['content-encoding'] !== undefined) { reply(response, 415, { error: 'unsupported_content_encoding' }); return true; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
      reply(response, 415, { error: 'unsupported_content_type' }); return true;
    }
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
      reply(response, 400, { error: 'invalid_request' }); return true;
    }
    if (length !== undefined && Number(length) > MAX_BODY_BYTES) { reply(response, 413, { error: 'body_too_large' }); return true; }
    const authorization = request.headers.authorization;
    const match = typeof authorization === 'string' && authorization.length <= 16_391 && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization);
    if (!match) { reply(response, 401, { error: 'reauthentication_required' }); return true; }
    if (active >= maxConcurrentRequests) { reply(response, 429, { error: 'busy' }); return true; }
    active += 1;
    const controller = new AbortController(); let rejectAbort, timedOut = false;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = () => {
      // Reject before notifying dependencies, so an abort-ignorant or late
      // successful write can never win the timeout race and become HTTP success.
      rejectAbort(new HttpError(dispatched && WRITES.has(operation) ? 503 : timedOut ? 504 : 408,
        dispatched && WRITES.has(operation) ? 'operation_outcome_unknown' : timedOut ? 'timeout' : 'cancelled'));
      controller.abort();
    };
    const close = () => { if (!response.writableEnded) stop(); };
    request.once('aborted', stop); response.once('close', close);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const work = (async () => {
      body = inputBody(await readBody(request, controller.signal), operation);
      if (controller.signal.aborted) throw new HttpError(408, 'cancelled');
      // The dependency receives its own request, not the stable protocol fence.
      // Keep no password or browser bearer in the expected response projection.
      const expected = Object.fromEntries(['organizationId', 'connectionId', 'expectedEpoch', 'restrictions', 'scopeIds']
        .filter(key => Object.hasOwn(body, key)).map(key => [key, structuredClone(body[key])]));
      input = { browserAccessToken: match[1], ...body };
      dispatched = true;
      const result = await (operation === 'connect' ? controlPlane.connect(input, { signal: controller.signal })
        : management[operation](input, { signal: controller.signal }));
      if (controller.signal.aborted) throw new Error('late_dependency_result');
      const projected = output(result, operation, expected);
      if (Buffer.byteLength(JSON.stringify(projected)) > MAX_RESPONSE_BYTES) badOutput();
      return projected;
    })();
    const release = () => {
      active -= 1;
      // Best-effort reference clearing only; JS does not promise secret erasure.
      // A dependency freezing its input must not cause an unhandled rejection.
      try { if (body && Object.hasOwn(body, 'password')) body.password = ''; } catch { /* immutable dependency input */ }
      try { if (input) { input.browserAccessToken = ''; if (Object.hasOwn(input, 'password')) input.password = ''; } } catch { /* immutable dependency input */ }
      body = undefined; input = undefined;
    };
    void work.then(release, release);
    try { reply(response, 200, await Promise.race([work, aborted])); }
    catch (error) { const safe = safeError(error, operation, dispatched); reply(response, safe.status, safe.body); }
    finally {
      clearTimeout(timer); request.removeListener('aborted', stop); response.removeListener('close', close); controller.abort();
    }
    return true;
  };
}
