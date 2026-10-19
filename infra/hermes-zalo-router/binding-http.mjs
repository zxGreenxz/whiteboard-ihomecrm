import { ZaloBindingError } from './binding-service.mjs';

const PREFIX = '/api/hermes/zalo/';
const OPERATIONS = new Set(['bots', 'manageBots', 'setBot', 'selectCredential', 'begin', 'status', 'confirm', 'unlink', 'list']);
const writes = operation => !['bots', 'manageBots', 'status', 'list'].includes(operation);
const STATUS = { invalid_request: 400, forbidden: 403, reauthentication_required: 401, context_changed: 409,
  backend_unavailable: 503, binding_outcome_unknown: 503, cancelled: 408, timeout: 504, busy: 429, backend_closed: 503 };
class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
function allowed(values, origin) {
  return Array.isArray(values) && values.length <= 64 && (origin || values.length > 0) && new Set(values).size === values.length && values.every(value => {
    if (typeof value !== 'string' || value.length > 512) return false;
    try {
      const url = new URL(origin ? value : `http://${value}`);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash &&
        (origin ? url.origin === value : url.host === value);
    } catch { return false; }
  });
}
function reply(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', ...(status >= 400 ? { connection: 'close' } : {}) });
  response.end(JSON.stringify(body));
}
function readBody(request, signal) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0;
    const cleanup = () => {
      request.removeListener('data', data); request.removeListener('end', end); request.removeListener('error', error);
      request.removeListener('aborted', abort); signal.removeEventListener('abort', abort);
    };
    const error = reason => { cleanup(); chunks = []; request.pause(); reject(reason); };
    const abort = () => error(new HttpError(408, 'cancelled'));
    const data = chunk => {
      size += chunk.length;
      if (size > 4096) { error(new HttpError(413, 'body_too_large')); return; }
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

/** Browser JWT routes only. Service validates payload/result and actual CRM
 * authority; deadline/close aborts it, never retries a write or logs its code.
 * Mount behind the backend's exact-host gate and reviewed TLS proxy. */
export function createZaloBindingHttpHandler({ service, allowedHosts, allowedOrigins = [], timeoutMs = 30000, maxConcurrent = 16 } = {}) {
  if (typeof service?.invoke !== 'function' || !allowed(allowedHosts, false) || !allowed(allowedOrigins, true) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64) throw new TypeError('invalid_binding_http');
  const hosts = new Set(allowedHosts), origins = new Set(allowedOrigins); let active = 0;
  return async (request, response) => {
    const operation = typeof request.url === 'string' && request.url.startsWith(PREFIX) ? request.url.slice(PREFIX.length) : '';
    if (!OPERATIONS.has(operation)) return false;
    const names = new Set();
    for (let i = 0; i < request.rawHeaders.length; i += 2) {
      const name = request.rawHeaders[i].toLowerCase();
      if (names.has(name)) { reply(response, 400, { error: 'duplicate_header' }); return true; }
      names.add(name);
    }
    if (names.size > 32) { reply(response, 431, { error: 'too_many_headers' }); return true; }
    if (!hosts.has(request.headers.host) || request.headers.origin !== undefined && !origins.has(request.headers.origin) || writes(operation) && request.headers.origin === undefined) {
      reply(response, 403, { error: 'forbidden' }); return true;
    }
    if (request.method !== 'POST') { response.setHeader('allow', 'POST'); reply(response, 405, { error: 'method_not_allowed' }); return true; }
    if (request.headers['content-encoding'] !== undefined) { reply(response, 415, { error: 'unsupported_content_encoding' }); return true; }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) {
      reply(response, 415, { error: 'unsupported_content_type' }); return true;
    }
    const length = request.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) { reply(response, 400, { error: 'invalid_request' }); return true; }
    if (length !== undefined && Number(length) > 4096) { reply(response, 413, { error: 'body_too_large' }); return true; }
    const header = request.headers.authorization;
    const bearer = typeof header === 'string' && header.length <= 16391 && /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
    if (!bearer) { reply(response, 401, { error: 'reauthentication_required' }); return true; }
    if (active >= maxConcurrent) { reply(response, 429, { error: 'busy' }); return true; }
    active++;
    const controller = new AbortController(); let dispatched = false, rejectStop;
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const stop = code => {
      const outcome = dispatched && writes(operation) ? 'binding_outcome_unknown' : code;
      rejectStop(new HttpError(STATUS[outcome], outcome)); controller.abort();
    };
    const abort = () => stop('cancelled'), close = () => { if (!response.writableEnded) abort(); };
    request.once('aborted', abort); response.once('close', close);
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const work = (async () => {
      const body = await readBody(request, controller.signal);
      if (controller.signal.aborted) throw new HttpError(408, 'cancelled');
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'organizationId')) throw new HttpError(400, 'invalid_request');
      const { organizationId, ...input } = body;
      dispatched = true;
      const result = await service.invoke(operation, input, { accessToken: bearer[1], organizationId, signal: controller.signal });
      if (controller.signal.aborted) throw new Error('late_result');
      if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new Error('invalid_response');
      return result;
    })();
    void work.then(() => { active--; }, () => { active--; });
    try { reply(response, 200, await Promise.race([work, stopped])); }
    catch (error) {
      if (error instanceof HttpError) reply(response, error.status, { error: error.code });
      else if (error instanceof ZaloBindingError) reply(response, STATUS[error.code], { error: error.code });
      else {
        const code = dispatched && writes(operation) ? 'binding_outcome_unknown' : 'backend_unavailable';
        reply(response, STATUS[code], { error: code });
      }
    } finally {
      clearTimeout(timer); controller.abort(); request.removeListener('aborted', abort); response.removeListener('close', close);
    }
    return true;
  };
}
