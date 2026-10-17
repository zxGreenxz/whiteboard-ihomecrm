import { BrokerError } from './broker.mjs';
const fail = code => { throw new BrokerError(code); };
const record = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
function jwt(value) {
  if (typeof value !== 'string' || value.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) return false;
  try { const claims = JSON.parse(Buffer.from(value.split('.')[1], 'base64url')); return record(claims) && claims.role === 'authenticated' && id(claims.sub) && id(claims.session_id); } catch { return false; }
}
async function json(response, signal) {
  if (response.redirected || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
    Number(response.headers.get('content-length')) > 131072) { await response.body?.cancel().catch(() => {}); fail('backend_unavailable'); }
  const reader = response.body.getReader(), chunks = []; let length = 0, cancelled;
  const stop = () => cancelled ??= reader.cancel().catch(() => {});
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (true) { signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted(); if (part.done) break;
      length += part.value.byteLength; if (length > 131072) fail('response_too_large'); chunks.push(part.value); }
    return JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { signal.removeEventListener('abort', stop); await stop(); reader.releaseLock(); }
}
/** Fixed user-JWT endpoints only; transport stays tracked until raw I/O settles.
 * Mutation ACK loss is surfaced to the broker and never retried. */
export function createBoundUserRpcTransport({ url, publishableKey, fetch: request = globalThis.fetch, dependencyScope, allowedNames } = {}) {
  let endpoint; try { endpoint = new URL(url); } catch { throw new TypeError('invalid_memory_transport'); }
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(publishableKey) || typeof request !== 'function' ||
    typeof dependencyScope?.track !== 'function' || !Array.isArray(allowedNames) || !allowedNames.length || allowedNames.length > 32 || allowedNames.some(name => typeof name !== 'string' || !/^hermes_[a-z0-9_]+_v[1-9][0-9]*$/.test(name))) throw new TypeError('invalid_memory_transport');
  const names = new Set(allowedNames);
  async function rpc(name, accessToken, args, { signal, onDispatch, onRejected } = {}, { write = false, optional = false } = {}) {
    if (!names.has(name) || !jwt(accessToken) || !(signal instanceof AbortSignal) || (write && [onDispatch, onRejected].some(fn => typeof fn !== 'function'))) fail('invalid_request');
    if (signal.aborted) fail('timeout');
    return dependencyScope.track(async () => {
      if (write) onDispatch();
      const response = await request(new URL(`/rest/v1/rpc/${name}`, endpoint).href, { method: 'POST', redirect: 'error', signal,
        headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'content-profile': 'public', 'accept-profile': 'public' }, body: JSON.stringify(args) });
      if (signal.aborted) { await response.body?.cancel().catch(() => {}); fail('timeout'); }
      const data = await json(response, signal);
      const error = exact(data, ['code', 'message', 'details', 'hint']) && typeof data.code === 'string' && typeof data.message === 'string' &&
        [data.details, data.hint].every(v => v === null || typeof v === 'string');
      const rejected = error && (response.status === 401 || response.status === 403 && data.code === '42501' ||
        response.status === 409 && data.code === 'PT409' || response.status === 400 && data.code === '22023' || response.status === 404 && data.code === 'PGRST202');
      if (write && rejected) onRejected();
      if (optional && response.status === 404 && error && data.code === 'PGRST202') return null;
      if (response.status === 401) fail('unauthorized');
      if (response.status === 403 && error && data.code === '42501') fail('forbidden');
      if (response.status === 409 && error && data.code === 'PT409') fail('context_changed');
      if (response.status === 400 && error && data.code === '22023') fail('invalid_request');
      // SQL đọc quá trần kích thước (PT413 ⇒ HTTP 413): kết quả quá lớn, không phải yêu cầu sai.
      if (response.status === 413 && error && data.code === 'PT413') fail('result_too_large');
      if (!response.ok || !record(data) || ['error', 'error_code', 'error_description'].some(k => Object.hasOwn(data, k))) fail('backend_unavailable');
      return data;
    });
  }
  return rpc;
}
