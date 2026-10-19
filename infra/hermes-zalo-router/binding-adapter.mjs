import { BrokerError } from '../hermes-broker/broker.mjs';
import { ZaloBindingError, ZaloBindingRpcRejection } from './binding-service.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const id = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const fail = code => { throw new ZaloBindingError(code); };
const cancelBody = response => { void response.body?.cancel().catch(() => { /* Failed responses remain rejected. */ }); };

async function readResponse(response, signal) {
  const length = response.headers.get('content-length');
  if (response.redirected || !response.body || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '') ||
      length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > 65536)) {
    cancelBody(response); fail('backend_unavailable');
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  const stop = () => { void reader.cancel().catch(() => { /* Caller already receives a failed or cancelled operation. */ }); };
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (signal.aborted) fail('cancelled');
      if (next.done) {
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { fail('backend_unavailable'); }
      }
      size += next.value.byteLength;
      if (size > 65536) fail('backend_unavailable');
      chunks.push(next.value);
    }
    fail('cancelled');
  } finally {
    signal.removeEventListener('abort', stop); stop();
    try { reader.releaseLock(); } catch { /* An aborted read may still be settling. */ }
  }
}

/** Fixed caller-JWT ports. Uses the existing verified CRM Auth adapter and
 * public RPC; never a service-role, runtime credential, or private SQL pool.
 * The binding service owns deadline, admission and draining these promises. */
export function createZaloBindingPorts({ auth, url, publishableKey, fetch: request = globalThis.fetch, clock = Date.now } = {}) {
  let endpoint;
  try {
    const base = new URL(url);
    if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error();
    endpoint = new URL('/rest/v1/rpc/hermes_zalo_binding_v1', base).href;
  } catch { throw new TypeError('invalid_binding_adapter'); }
  if (typeof auth?.verifySession !== 'function' ||
      typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]{1,512}$/.test(publishableKey) ||
      typeof request !== 'function' || typeof clock !== 'function') throw new TypeError('invalid_binding_adapter');
  const now = () => { const value = clock(); if (!positive(value)) fail('backend_unavailable'); return value; };
  const validate = ({ accessToken, organizationId, signal }, withOrg = true) => {
    if (typeof accessToken !== 'string' || accessToken.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(accessToken) ||
        !(signal instanceof AbortSignal) || withOrg && !id(organizationId)) fail('invalid_request');
    if (signal.aborted) fail('cancelled');
  };
  return Object.freeze({
    async verifyCaller(options) {
      validate(options);
      const { accessToken, organizationId, signal } = options;
      try {
        const raw = await auth.verifySession({ accessToken, signal });
        if (signal.aborted) fail('cancelled');
        if (!raw || !id(raw.userId) || !id(raw.sessionId) || !positive(raw.expiresAt) || raw.expiresAt <= now()) fail('reauthentication_required');
        // The caller-JWT SQL function validates the selected organization and
        // membership. Building all CRM capabilities here duplicates that work.
        return Object.freeze({ userId: raw.userId, organizationId, sessionId: raw.sessionId });
      } catch (error) {
        if (error instanceof ZaloBindingError) throw error;
        if (error instanceof BrokerError && error.code === 'unauthorized') fail('reauthentication_required');
        if (error instanceof BrokerError && error.code === 'forbidden') fail('forbidden');
        fail('backend_unavailable');
      }
    },
    async rpc({ accessToken, functionName, args, signal } = {}) {
      validate({ accessToken, signal }, false);
      if (functionName !== 'hermes_zalo_binding_v1' || !args || Object.keys(args).length !== 1 || !args.p ||
          !['bots','manageBots','setBot','selectCredential','begin','status','confirm','unlink','list'].includes(args.p.operation)) fail('invalid_request');
      const body = JSON.stringify(args);
      if (Buffer.byteLength(body) > 4096) fail('invalid_request');
      let response;
      try {
        response = await request(endpoint, { method: 'POST', redirect: 'error', signal,
          headers: { apikey: publishableKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json',
            'content-profile': 'public', 'accept-profile': 'public' }, body });
        if (signal.aborted) { cancelBody(response); fail('cancelled'); }
        const data = await readResponse(response, signal);
        if (response.status === 200) return data;
        if (response.status === 401) throw new ZaloBindingRpcRejection('reauthentication_required');
        if (response.status === 403 && data?.code === '42501') throw new ZaloBindingRpcRejection('forbidden');
        if (response.status === 409 && ['PT409', '23505'].includes(data?.code)) throw new ZaloBindingRpcRejection('context_changed');
        if (response.status === 400 && data?.code === '22023') throw new ZaloBindingRpcRejection('invalid_request');
        fail('backend_unavailable');
      } catch (error) {
        if (error instanceof ZaloBindingError) throw error;
        fail('backend_unavailable');
      }
    },
  });
}
