import { request as httpsRequest } from 'node:https';

const ROUTES = Object.freeze({
  connections: ['connect', 'list', 'context', 'options', 'restrict', 'revoke', 'status'],
  zalo: ['bots', 'manageBots', 'setBot', 'begin', 'status', 'confirm', 'unlink', 'list'],
});
const WRITES = new Set(['connections/connect', 'connections/restrict', 'connections/revoke',
  'zalo/setBot', 'zalo/begin', 'zalo/confirm', 'zalo/unlink']);
const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const CRITICAL = new Set(['host', 'origin', 'authorization', 'content-type', 'content-length', 'content-encoding', 'transfer-encoding']);
class ProxyError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const error = (status, code) => new ProxyError(status, code);
function origin(value) {
  if (typeof value !== 'string' || value.length > 512) throw error(503, 'backend_unavailable');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw error(503, 'backend_unavailable');
  }
  return url;
}
function reply(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store',
    'cdn-cache-control': 'no-store', 'vercel-cdn-cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}
function bytesFrom(stream, limit, signal, response = false) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, settled = false;
    const cleanup = () => {
      stream.removeListener('data', data); stream.removeListener('end', end); stream.removeListener('error', failed);
      stream.removeListener('aborted', failed); signal.removeEventListener('abort', aborted);
    };
    const fail = reason => {
      if (settled) return;
      settled = true; cleanup(); chunks = []; stream.pause(); reject(reason);
    };
    const failed = () => fail(error(response ? 503 : 408, response ? 'backend_unavailable' : 'cancelled'));
    const aborted = () => fail(signal.reason);
    const data = chunk => {
      size += chunk.length;
      if (size > limit) { fail(error(response ? 503 : 413, response ? 'backend_unavailable' : 'body_too_large')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      if (settled) return;
      settled = true; cleanup(); const body = Buffer.concat(chunks); chunks = [];
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(body);
      } catch { reject(error(response ? 503 : 400, response ? 'backend_unavailable' : 'invalid_request')); }
    };
    if (signal.aborted) { aborted(); return; }
    if (stream.aborted) { failed(); return; }
    // Vercel's helpers restore the raw body as data/end events. Do not access
    // req.body/query or reserialize passwords through its lazy JSON getter.
    stream.on('data', data); stream.on('end', end); stream.once('error', failed); stream.once('aborted', failed);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

/** Two fixed browser route families only. The real host remains the Auth/CRM
 * authority. Transport is a trusted in-process test seam, never HTTP/env input.
 * Native HTTPS does not follow redirects or retry; request/response credentials
 * and bodies are never logged. Unknown writes must be reconciled by existing UI.
 */
export function createHermesFrontendProxy({ family, upstreamOrigin, crmOrigin, request = httpsRequest,
  timeoutMs = 25000, maxConcurrent = 16 } = {}) {
  if (!Object.hasOwn(ROUTES, family ?? '') || typeof request !== 'function' || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 || timeoutMs > 25000 || !Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) {
    throw new TypeError('invalid_hermes_proxy_config');
  }
  let upstream, crm;
  try { upstream = origin(upstreamOrigin); crm = origin(crmOrigin); if (upstream.origin === crm.origin) upstream = undefined; }
  catch { upstream = undefined; }
  const prefix = `/api/hermes/${family}/`, requestLimit = family === 'zalo' ? 4096 : 65536;
  const responseLimit = family === 'zalo' ? 65536 : 1048576;
  let active = 0;
  return async function hermesFrontendProxy(incoming, response) {
    const rawPath = typeof incoming.url === 'string' ? incoming.url : '';
    const queryAt = rawPath.indexOf('?'), pathname = queryAt === -1 ? rawPath : rawPath.slice(0, queryAt);
    const operation = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
    const finishError = reason => reply(response, reason.status, JSON.stringify({ error: reason.code }));
    // Vercel's dynamic [operation] route retains the pathname and may append
    // operation=$1. It is only a consistency check, never a target selector.
    if (!ROUTES[family].includes(operation) || queryAt !== -1 && rawPath.slice(queryAt + 1) !== `operation=${operation}`) {
      finishError(error(404, 'not_found')); return;
    }
    if (!upstream) { finishError(error(503, 'backend_unavailable')); return; }
    const seen = new Set();
    for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
      const name = incoming.rawHeaders[i].toLowerCase();
      if (CRITICAL.has(name) && seen.has(name)) { finishError(error(400, 'invalid_request')); return; }
      seen.add(name);
    }
    const headers = incoming.headers;
    if (headers.host !== crm.host || headers.origin !== crm.origin ||
      headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin') {
      finishError(error(403, 'forbidden')); return;
    }
    if (incoming.method !== 'POST') { response.setHeader('allow', 'POST'); finishError(error(405, 'method_not_allowed')); return; }
    if (headers['content-encoding'] !== undefined || !JSON_TYPE.test(headers['content-type'] ?? '')) {
      finishError(error(415, 'invalid_request')); return;
    }
    const length = headers['content-length'];
    if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
      finishError(error(400, 'invalid_request')); return;
    }
    if (length !== undefined && Number(length) > requestLimit) { finishError(error(413, 'body_too_large')); return; }
    const authorization = headers.authorization;
    if (typeof authorization !== 'string' || authorization.length > 16391 || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) {
      finishError(error(401, 'reauthentication_required')); return;
    }
    if (active >= maxConcurrent) { finishError(error(429, 'busy')); return; }
    active++;
    const controller = new AbortController(); let dispatched = false, outbound, upstreamResponse, settleClosed;
    let closed = Promise.resolve();
    const write = WRITES.has(`${family}/${operation}`);
    const unknown = () => error(503, family === 'zalo' ? 'binding_outcome_unknown' : 'operation_outcome_unknown');
    const stop = reason => {
      if (!controller.signal.aborted) controller.abort(reason);
      upstreamResponse?.destroy(); outbound?.destroy();
    };
    const cancelled = () => stop(error(408, 'cancelled'));
    const disconnected = () => { if (!response.writableEnded) cancelled(); };
    incoming.once('aborted', cancelled); incoming.once('error', cancelled); response.once('close', disconnected);
    const timer = setTimeout(() => stop(error(504, 'timeout')), timeoutMs);
    try {
      const body = await bytesFrom(incoming, requestLimit, controller.signal);
      if (controller.signal.aborted) throw controller.signal.reason;
      const result = await new Promise((resolve, reject) => {
        const aborted = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', aborted, { once: true });
        const fail = () => reject(error(503, 'backend_unavailable'));
        try {
          // Every target component comes from server config plus a fixed route.
          // Host/SNI are derived by native HTTPS. No forwarded header is copied.
          dispatched = true;
          outbound = request(new URL(prefix + operation, upstream), { method: 'POST', agent: false,
            headers: { authorization, origin: crm.origin, 'content-type': 'application/json; charset=utf-8',
              accept: 'application/json', 'content-length': String(body.length) } }, async remote => {
            upstreamResponse = remote;
            try {
              if (controller.signal.aborted) throw controller.signal.reason;
              const status = remote.statusCode;
              if (!(status === 200 || status >= 400 && status <= 599) || !JSON_TYPE.test(remote.headers['content-type'] ?? '') ||
                remote.headers['content-encoding'] !== undefined || remote.headers['content-length'] !== undefined &&
                (!/^\d+$/.test(remote.headers['content-length']) || Number(remote.headers['content-length']) > responseLimit)) {
                throw error(503, 'backend_unavailable');
              }
              const payload = await bytesFrom(remote, responseLimit, controller.signal, true);
              resolve({ status, body: payload });
            } catch (reason) { remote.destroy(); reject(reason); }
          });
          closed = new Promise(resolveClosed => { settleClosed = resolveClosed; });
          outbound.once('close', () => { controller.signal.removeEventListener('abort', aborted); settleClosed(); });
          outbound.once('error', fail);
          outbound.end(body);
        } catch { controller.signal.removeEventListener('abort', aborted); fail(); }
      });
      if (controller.signal.aborted) throw controller.signal.reason;
      reply(response, result.status, result.body);
    } catch (reason) {
      finishError(dispatched && write ? unknown() : reason instanceof ProxyError ? reason : error(503, 'backend_unavailable'));
    } finally {
      clearTimeout(timer); stop(error(408, 'cancelled'));
      incoming.removeListener('aborted', cancelled); incoming.removeListener('error', cancelled); response.removeListener('close', disconnected);
      // HTTP deadline is not proof of drain. Native socket close releases this
      // warm-instance slot; a broken transport retains capacity, never retries.
      await closed; active--;
    }
  };
}
