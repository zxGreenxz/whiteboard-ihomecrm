import { Buffer } from 'node:buffer';
import { createSupabaseAuthAdapter } from './supabase-adapter.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[\x21-\x7e]{1,16384}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const CODES = new Set(['refresh_invalid_request', 'refresh_request_too_large', 'refresh_response_too_large',
  'refresh_invalid_response', 'refresh_rejected', 'refresh_provider_unavailable', 'refresh_verification_failed',
  'refresh_cancelled', 'refresh_timeout']);

export class SupabaseRefreshError extends Error {
  constructor(code) { super(code); this.name = 'SupabaseRefreshError'; this.code = code; }
}
const fail = code => { throw new SupabaseRefreshError(code); };
const cancelBody = response => { void response.body?.cancel().catch(() => {}); };

async function readJson(response, maxBytes, signal) {
  if (!response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      response.redirected) { cancelBody(response); fail('refresh_invalid_response'); }
  if (Number(response.headers.get('content-length')) > maxBytes) {
    cancelBody(response); fail('refresh_response_too_large');
  }
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) fail('refresh_response_too_large');
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { fail('refresh_invalid_response'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel(); // Cancellation itself must not extend a refresh deadline.
    reader.releaseLock();
  }
}

/** Server-only transport for createRefreshManager, NOT an independent session
 * issuer or durable refresh coordinator. By default verification reuses
 * createSupabaseAuthAdapter behind a bounded, fixed /auth/v1/user transport.
 * An optional trusted verifySession injection MUST validate the actual bearer
 * against this same Auth origin and bound its own response bytes. The wrapper
 * bounds its deadline and result shape; it cannot inspect injected I/O. Never
 * inject a decode-only JWT function.
 *
 * refresh returns token candidates only. The manager MUST call verifySession and
 * compare user/session with its stored binding before encrypting or using them.
 * Provider response user/expiry metadata is never treated as identity evidence.
 * No password, service-role, environment lookup, logging, automatic retry or
 * fallback token reuse. Unknown outcomes require the manager's reconnect path.
 */
export function createSupabaseRefreshProvider({ url, publishableKey, verifySession: trustedVerify,
  fetch: request = globalThis.fetch, clock = Date.now, timeoutMs = 10_000,
  maxRequestBytes = 32_800, maxResponseBytes = 131_072 } = {}) {
  let origin;
  try { origin = new URL(url); } catch { throw new TypeError('invalid_refresh_provider_config'); }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
      typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(publishableKey) ||
      (trustedVerify !== undefined && typeof trustedVerify !== 'function') || typeof request !== 'function' || typeof clock !== 'function' ||
      !positive(timeoutMs) || timeoutMs > 30_000 || !positive(maxRequestBytes) || maxRequestBytes > 65_536 ||
      !positive(maxResponseBytes) || maxResponseBytes > 131_072) throw new TypeError('invalid_refresh_provider_config');
  // Capture an immutable string; no supplied request can replace this endpoint.
  const endpoint = new URL('/auth/v1/token?grant_type=refresh_token', origin).href;
  const userEndpoint = new URL('/auth/v1/user', origin).href;
  const verify = trustedVerify ?? createSupabaseAuthAdapter({ url: origin.href, publishableKey, clock,
    fetch: async (target, options) => {
      if (String(target) !== userEndpoint || options.method !== 'GET' || options.body !== undefined) fail('refresh_verification_failed');
      const response = await request(userEndpoint, options);
      if (options.signal.aborted) { cancelBody(response); throw options.signal.reason; }
      if (!response.ok) { cancelBody(response); fail('refresh_verification_failed'); }
      const value = await readJson(response, maxResponseBytes, options.signal);
      if (!object(value) || ['error', 'error_code', 'error_description'].some(key => Object.hasOwn(value, key))) fail('refresh_verification_failed');
      // Existing adapter owns bearer/claims/user matching. Metadata is discarded
      // before its response.json(), which now reads only this small projection.
      return new Response(JSON.stringify({ id: value.id }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  }).verifySession;

  async function bounded(signal, operation, fallback) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('refresh_invalid_request');
    if (signal?.aborted) fail('refresh_cancelled');
    const controller = new AbortController();
    const onAbort = () => controller.abort(new SupabaseRefreshError('refresh_cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new SupabaseRefreshError('refresh_timeout')), timeoutMs);
    let abortListener;
    const aborted = new Promise((_, reject) => {
      abortListener = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abortListener, { once: true });
    });
    try {
      const result = await Promise.race([operation(controller.signal), aborted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      return result;
    } catch (error) {
      // Never expose an injected transport/verifier's message, cause or tokens.
      fail(error instanceof SupabaseRefreshError && CODES.has(error.code) ? error.code : fallback);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      controller.signal.removeEventListener('abort', abortListener);
      controller.abort();
    }
  }

  return Object.freeze({
    async refresh(input) {
      if (!exact(input, ['refreshToken', 'signal']) || typeof input.refreshToken !== 'string' || !TOKEN.test(input.refreshToken)) {
        fail('refresh_invalid_request');
      }
      const body = JSON.stringify({ refresh_token: input.refreshToken });
      if (Buffer.byteLength(body) > maxRequestBytes) fail('refresh_request_too_large');
      return bounded(input.signal, async signal => {
        const response = await request(endpoint, { method: 'POST', redirect: 'error', signal,
          headers: { apikey: publishableKey, 'content-type': 'application/json', accept: 'application/json' }, body });
        if (signal.aborted) { cancelBody(response); throw signal.reason; }
        if (!response.ok) {
          cancelBody(response);
          fail([400, 401, 403].includes(response.status) ? 'refresh_rejected' : 'refresh_provider_unavailable');
        }
        const value = await readJson(response, maxResponseBytes, signal);
        if (!object(value) || ['error', 'error_code', 'error_description'].some(key => Object.hasOwn(value, key)) ||
            value.token_type !== 'bearer' || typeof value.access_token !== 'string' || !TOKEN.test(value.access_token) ||
            typeof value.refresh_token !== 'string' || !TOKEN.test(value.refresh_token)) fail('refresh_invalid_response');
        return { accessToken: value.access_token, refreshToken: value.refresh_token };
      }, 'refresh_provider_unavailable');
    },
    async verifySession(input) {
      if (!exact(input, ['accessToken', 'signal']) || typeof input.accessToken !== 'string' || !TOKEN.test(input.accessToken)) {
        fail('refresh_invalid_request');
      }
      const accessToken = input.accessToken;
      return bounded(input.signal, async signal => {
        const result = await verify({ accessToken, signal });
        if (signal.aborted) throw signal.reason;
        const now = clock();
        if (!object(result) || !UUID.test(result.userId ?? '') || !UUID.test(result.sessionId ?? '') ||
            !positive(now) || !positive(result.expiresAt) || result.expiresAt <= now) fail('refresh_verification_failed');
        return { userId: result.userId, sessionId: result.sessionId, expiresAt: result.expiresAt };
      }, 'refresh_verification_failed');
    },
  });
}
