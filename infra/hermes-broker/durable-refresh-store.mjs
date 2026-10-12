import { StoreTransportError } from './store-transport.mjs';

// PostgreSQL returns canonical UUIDs. Do not silently normalize an AAD binding
// after encryption: differing casing would make the ciphertext unreadable.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING = ['assistantId', 'userId', 'organizationId', 'sessionId'];
const CLAIM = ['credentialRef', 'binding', 'ownerId', 'revision', 'fence'];
const ENVELOPE = ['v', 'algorithm', 'keyVersion', 'nonce', 'ciphertext', 'tag'];
const record = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && UUID.test(value);

export class DurableRefreshStoreError extends Error {
  constructor(code) { super(code); this.name = 'DurableRefreshStoreError'; this.code = code; }
}
const fail = code => { throw new DurableRefreshStoreError(code); };
const requestInvalid = () => fail('refresh_store_request_invalid');
const responseInvalid = () => fail('refresh_store_response_invalid');

function copyBinding(value, invalid) {
  if (!exact(value, BINDING) || BINDING.some(key => !uuid(value[key]))) invalid();
  return Object.fromEntries(BINDING.map(key => [key, value[key]]));
}
function copyEnvelope(value, invalid) {
  if (!exact(value, ENVELOPE) || value.v !== 1 || value.algorithm !== 'A256GCM' ||
      typeof value.keyVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.keyVersion)) invalid();
  for (const [key, length, cap] of [['nonce', 12, 12], ['tag', 16, 16], ['ciphertext', null, 65536]]) {
    const encoded = value[key];
    if (typeof encoded !== 'string' || encoded.length < 1 || encoded.length > Math.ceil(cap * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
    const decoded = Buffer.from(encoded, 'base64url');
    if (decoded.toString('base64url') !== encoded || decoded.length > cap || (length !== null && decoded.length !== length)) invalid();
  }
  return Object.fromEntries(ENVELOPE.map(key => [key, value[key]]));
}
function copyClaim(value, keys = CLAIM) {
  if (!exact(value, keys) || !uuid(value.credentialRef) || !uuid(value.ownerId) ||
      !positive(value.revision) || value.revision >= Number.MAX_SAFE_INTEGER ||
      !positive(value.fence) || value.fence >= Number.MAX_SAFE_INTEGER) requestInvalid();
  return { credentialRef: value.credentialRef, binding: copyBinding(value.binding, requestInvalid),
    ownerId: value.ownerId, revision: value.revision, fence: value.fence };
}
function booleanReceipt(value, statuses, falseStatuses = []) {
  if (exact(value, ['ok']) && value.ok === false) return false;
  if (!exact(value, ['ok', 'status']) || typeof value.ok !== 'boolean') responseInvalid();
  if (value.ok === false && falseStatuses.includes(value.status)) return false;
  if (value.ok === true && statuses.includes(value.status)) return true;
  responseInvalid();
}

/** Adapter to the fixed private SQL protocol, not a database implementation or
 * evidence of durability. Supply createStoreTransport with a dedicated backend
 * principal. It must enforce its connection/query/response bounds and TLS.
 * No general call()/RPC escape, readConnection, tokens, keys, pool configuration
 * or automatic retry is exposed here. The refresh manager alone owns bounded
 * stage/publish reconciliation. Caller/jobs remain disabled on an unresolved
 * refresh; durable quarantine/pending-journal recovery still needs backend proof.
 */
export function createDurableRefreshStore({ transport } = {}) {
  if (typeof transport?.call !== 'function') throw new TypeError('invalid_refresh_store_config');
  async function call(operation, payload, { signal } = {}) {
    if (!(signal instanceof AbortSignal)) requestInvalid();
    if (signal.aborted) fail('refresh_store_cancelled');
    // Every payload below was projected to exact protocol fields before await.
    let value;
    try { value = await transport.call(operation, payload, { signal }); }
    catch (error) {
      if (error instanceof StoreTransportError && error.code === 'store_outcome_unknown') fail('store_outcome_unknown');
      fail('refresh_store_unavailable');
    }
    if (signal.aborted) fail('refresh_store_cancelled');
    return value;
  }
  return Object.freeze({
    async acquire(input, options) {
      if (!exact(input, ['credentialRef', 'binding', 'ownerId', 'leaseMs']) || !uuid(input.credentialRef) ||
          !uuid(input.ownerId) || !positive(input.leaseMs) || input.leaseMs < 1000 || input.leaseMs > 120000) requestInvalid();
      const payload = { credentialRef: input.credentialRef, binding: copyBinding(input.binding, requestInvalid),
        ownerId: input.ownerId, leaseMs: input.leaseMs };
      const result = await call('acquireRefresh', payload, options);
      if (exact(result, ['status']) && ['missing', 'revoked', 'reconnect_required'].includes(result.status)) return { status: result.status };
      if ((exact(result, ['status']) || (exact(result, ['status', 'reconcile']) && typeof result.reconcile === 'boolean')) && result.status === 'busy') {
        return { status: 'busy', ...(result.reconcile === undefined ? {} : { reconcile: result.reconcile }) };
      }
      if (!exact(result, ['status', 'credential', 'lease']) || result.status !== 'acquired' ||
          !exact(result.credential, ['credentialRef', 'revision', 'envelope', 'expiresAt', 'binding']) ||
          result.credential.credentialRef !== payload.credentialRef || !positive(result.credential.revision) ||
          result.credential.revision >= Number.MAX_SAFE_INTEGER || !positive(result.credential.expiresAt) ||
          !exact(result.lease, ['fence', 'expiresAt']) || !positive(result.lease.fence) ||
          result.lease.fence >= Number.MAX_SAFE_INTEGER || !positive(result.lease.expiresAt)) responseInvalid();
      const binding = copyBinding(result.credential.binding, responseInvalid);
      if (BINDING.some(key => binding[key] !== payload.binding[key])) responseInvalid();
      return { status: 'acquired', credential: { credentialRef: payload.credentialRef, binding,
        revision: result.credential.revision, expiresAt: result.credential.expiresAt,
        envelope: copyEnvelope(result.credential.envelope, responseInvalid) },
      lease: { fence: result.lease.fence, expiresAt: result.lease.expiresAt } };
    },
    async markDispatched(input, options) {
      return booleanReceipt(await call('dispatchRefresh', copyClaim(input), options), ['dispatched']);
    },
    async stageRefresh(input, options) {
      const payload = { ...copyClaim(input, [...CLAIM, 'envelope', 'expiresAt']), envelope: copyEnvelope(input.envelope, requestInvalid), expiresAt: input.expiresAt };
      if (!positive(payload.expiresAt)) requestInvalid();
      return booleanReceipt(await call('stageRefresh', payload, options), ['staged'], ['staged']);
    },
    async publishRefresh(input, options) {
      const payload = copyClaim(input);
      const result = await call('publishRefresh', payload, options);
      if (exact(result, ['ok']) && result.ok === false) return false;
      if (!exact(result, ['ok', 'status', 'revision', 'fence']) || result.ok !== true ||
          !['published', 'already_published'].includes(result.status) || result.revision !== payload.revision + 1 ||
          result.fence !== payload.fence) responseInvalid();
      return { ok: true, status: result.status, revision: result.revision, fence: result.fence };
    },
    async requireReconnect(input, options) {
      return booleanReceipt(await call('reconnectSession', copyClaim(input), options), ['reconnect_required', 'already_quarantined']);
    },
    async release(input, options) {
      return booleanReceipt(await call('releaseRefresh', copyClaim(input), options), ['released']);
    },
    async revoke(input, options) {
      if (!exact(input, ['credentialRef']) || !uuid(input.credentialRef)) requestInvalid();
      return booleanReceipt(await call('revokeSession', { credentialRef: input.credentialRef }, options), ['revoked', 'already_revoked'], ['missing']);
    },
  });
}
