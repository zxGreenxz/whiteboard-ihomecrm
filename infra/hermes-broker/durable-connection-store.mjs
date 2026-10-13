import { StoreTransportError } from './store-transport.mjs';

// SQL serializes UUIDs in lowercase. Never normalize an already sealed AAD tuple.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const CAPABILITY = /^[a-z][a-z0-9_.]{0,127}$/;
const BINDING = ['assistantId', 'userId', 'organizationId', 'sessionId'];
const CONNECTION = ['id', 'assistantId', 'organizationId', 'userId', 'state', 'epoch', 'restrictions', 'scopeIds'];
const JOINED = [...CONNECTION, 'tokenDigest', 'credentialRef', 'expiresAt'];
const PREPARED = [...CONNECTION, 'intentSecret', 'intentExpiresAt'];
const ENVELOPE = ['v', 'algorithm', 'keyVersion', 'nonce', 'ciphertext', 'tag'];
const record = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && UUID.test(value);
const digest = value => typeof value === 'string' && DIGEST.test(value);
const subset = (next, previous) => next.every(key => previous.includes(key));
const equalSet = (a, b) => a.length === b.length && subset(a, b);

export class DurableConnectionStoreError extends Error {
  constructor(code) { super(code); this.name = 'DurableConnectionStoreError'; this.code = code; }
}
const fail = code => { throw new DurableConnectionStoreError(code); };
const invalidRequest = () => fail('connection_store_request_invalid');
const invalidResponse = () => fail('connection_store_response_invalid');

function list(value, predicate, invalid) {
  if (!Array.isArray(value) || value.length > 256 || Array.from(value).some(item => !predicate(item))) invalid();
  return [...new Set(value)].sort();
}
function restrictions(value, invalid) {
  if (!exact(value, ['read', 'action'])) invalid();
  const capability = item => typeof item === 'string' && CAPABILITY.test(item);
  return { read: list(value.read, capability, invalid), action: list(value.action, capability, invalid) };
}
function binding(value, invalid) {
  if (!exact(value, BINDING) || BINDING.some(key => !uuid(value[key]))) invalid();
  return Object.fromEntries(BINDING.map(key => [key, value[key]]));
}
function envelope(value, invalid) {
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
function connection(value, keys, state, invalid) {
  if (!exact(value, keys) || ['id', 'assistantId', 'organizationId', 'userId'].some(key => !uuid(value[key])) ||
      value.state !== state || !positive(value.epoch) || value.epoch >= Number.MAX_SAFE_INTEGER) invalid();
  return { id: value.id, assistantId: value.assistantId, organizationId: value.organizationId, userId: value.userId,
    state, epoch: value.epoch, restrictions: restrictions(value.restrictions, invalid), scopeIds: list(value.scopeIds, uuid, invalid) };
}
function sameOwner(actual, expected, invalid) {
  if (['id', 'assistantId', 'userId', 'organizationId'].some(key => actual[key] !== expected[key])) invalid();
}
function activeSnapshot(value, invalid) {
  if (exact(value, JOINED)) {
    if (!digest(value.tokenDigest) || !uuid(value.credentialRef) || !positive(value.expiresAt)) invalid();
    return connection(value, JOINED, 'active', invalid);
  }
  return connection(value, CONNECTION, 'active', invalid);
}
function sameLimits(actual, expected, invalid) {
  if (!equalSet(actual.restrictions.read, expected.restrictions.read) ||
      !equalSet(actual.restrictions.action, expected.restrictions.action) || !equalSet(actual.scopeIds, expected.scopeIds)) invalid();
}
function narrow(next, previous, invalid) {
  if (!subset(next.restrictions.read, previous.restrictions.read) ||
      !subset(next.restrictions.action, previous.restrictions.action) || !subset(next.scopeIds, previous.scopeIds)) invalid();
}

/** Trusted backend protocol adapter; deliberately NOT the P1 MemoryConnectionStore
 * interface. SQL owns current intent, membership, policy and atomic activation.
 * `prepared` must come from the authenticated public prepare RPC. Caller owns
 * verified Auth identity, canonical AAD sealing, operation/token creation and the
 * retained activation bundle used for explicit same-operation reconciliation.
 * Only digests/ciphertext reach this store. No minting, JWT decoding, decryption,
 * local authority cache, destructive compensation or automatic retry occurs here.
 *
 * An activation ACK is not admission. Use a fresh joined read, decrypt with its
 * exact binding, then verify the bearer/live CRM authority before any use. Returned
 * membership/policy are server snapshots, NOT synthesized effective permissions.
 */
export function createDurableConnectionStore({ transport, clock = Date.now } = {}) {
  if (typeof transport?.call !== 'function' || typeof clock !== 'function') throw new TypeError('invalid_connection_store_config');
  async function call(operation, payload, { signal } = {}) {
    if (!(signal instanceof AbortSignal)) invalidRequest();
    if (signal.aborted) fail('connection_store_cancelled');
    if (Buffer.byteLength(JSON.stringify(payload)) > 131072) invalidRequest();
    let value;
    try { value = await transport.call(operation, payload, { signal }); }
    catch (error) {
      if (error instanceof StoreTransportError && ['store_outcome_unknown', 'store_denied', 'store_conflict', 'store_rejected'].includes(error.code)) fail(error.code);
      fail('connection_store_unavailable');
    }
    if (signal.aborted) fail(operation === 'readConnection' ? 'connection_store_cancelled' : 'store_outcome_unknown');
    return value;
  }
  // A malformed write ACK cannot prove that SQL did not commit. Never compensate.
  const invalidAck = () => fail('store_outcome_unknown');
  return Object.freeze({
    async activate(input, options) {
      if (!exact(input, ['prepared', 'operationId', 'credentialRef', 'binding', 'tokenDigest', 'tokenExpiresAt', 'sessionEnvelope', 'sessionExpiresAt']) ||
          !uuid(input.operationId) || !uuid(input.credentialRef) || !digest(input.tokenDigest) ||
          !positive(input.tokenExpiresAt) || !positive(input.sessionExpiresAt) || input.tokenExpiresAt > input.sessionExpiresAt) invalidRequest();
      const prepared = connection(input.prepared, PREPARED, 'pending', invalidRequest);
      if (!digest(input.prepared.intentSecret) || !positive(input.prepared.intentExpiresAt)) invalidRequest();
      const owner = binding(input.binding, invalidRequest);
      if (['assistantId', 'userId', 'organizationId'].some(key => owner[key] !== prepared[key])) invalidRequest();
      const payload = { connectionId: prepared.id, expectedEpoch: prepared.epoch, operationId: input.operationId,
        intentSecret: input.prepared.intentSecret, userId: owner.userId, providerSessionId: owner.sessionId,
        credentialRef: input.credentialRef, tokenDigest: input.tokenDigest, tokenExpiresAt: input.tokenExpiresAt,
        sessionEnvelope: envelope(input.sessionEnvelope, invalidRequest), sessionExpiresAt: input.sessionExpiresAt };
      // SQL uses its own clock for new activations; an expired intent may still
      // reconcile an already committed identical payload. Do not reseal it here.
      const result = await call('activate', payload, options);
      if (!exact(result, ['ok', 'status', 'connection', 'credentialRef']) || result.ok !== true ||
          !['activated', 'already_activated'].includes(result.status) || result.credentialRef !== payload.credentialRef) invalidAck();
      const row = connection(result.connection, CONNECTION, 'active', invalidAck);
      sameOwner(row, prepared, invalidAck);
      if (result.status === 'activated' || row.epoch === prepared.epoch + 1) {
        if (row.epoch !== prepared.epoch + 1) invalidAck();
        sameLimits(row, prepared, invalidAck);
      } else {
        if (row.epoch <= prepared.epoch + 1) invalidAck();
        narrow(row, prepared, invalidAck);
      }
      return { ok: true, status: result.status, connection: row, credentialRef: payload.credentialRef };
    },
    async readConnection(input, options) {
      if (!exact(input, ['tokenDigest']) || !digest(input.tokenDigest)) invalidRequest();
      const payload = { tokenDigest: input.tokenDigest };
      const result = await call('readConnection', payload, options);
      if (exact(result, ['status']) && result.status === 'unavailable') return null;
      if (!exact(result, ['status', 'connection', 'session', 'membership', 'policy']) || result.status !== 'active') invalidResponse();
      const row = connection(result.connection, JOINED, 'active', invalidResponse);
      const { session, membership, policy } = result;
      if (result.connection.tokenDigest !== payload.tokenDigest || !uuid(result.connection.credentialRef) || !positive(result.connection.expiresAt) ||
          !exact(session, ['credentialRef', 'revision', 'envelope', 'expiresAt', 'binding']) || session.credentialRef !== result.connection.credentialRef ||
          !positive(session.revision) || session.revision >= Number.MAX_SAFE_INTEGER || !positive(session.expiresAt) ||
          !exact(membership, ['membershipId', 'authorizationVersion', 'isSuperadmin']) || !uuid(membership.membershipId) ||
          !positive(membership.authorizationVersion) || typeof membership.isSuperadmin !== 'boolean' ||
          !exact(policy, ['version', 'read', 'action', 'scopeIds']) || !positive(policy.version)) invalidResponse();
      const owner = binding(session.binding, invalidResponse);
      if (['assistantId', 'userId', 'organizationId'].some(key => owner[key] !== row[key])) invalidResponse();
      const copiedSession = { credentialRef: session.credentialRef, revision: session.revision, envelope: envelope(session.envelope, invalidResponse),
        expiresAt: session.expiresAt, binding: owner };
      const copiedPolicy = { version: policy.version, ...restrictions({ read: policy.read, action: policy.action }, invalidResponse),
        scopeIds: list(policy.scopeIds, uuid, invalidResponse) };
      const now = clock();
      if (!positive(now)) fail('connection_store_clock_invalid');
      if (result.connection.expiresAt <= now || session.expiresAt <= now) return null;
      return { status: 'active', connection: { ...row, tokenDigest: payload.tokenDigest,
        credentialRef: copiedSession.credentialRef, expiresAt: result.connection.expiresAt }, session: copiedSession,
      membership: { membershipId: membership.membershipId, authorizationVersion: membership.authorizationVersion, isSuperadmin: membership.isSuperadmin },
      policy: copiedPolicy };
    },
    async restrictConnection(input, options) {
      if (!exact(input, ['connection', 'restrictions', 'scopeIds'])) invalidRequest();
      const previous = activeSnapshot(input.connection, invalidRequest);
      const next = { restrictions: restrictions(input.restrictions, invalidRequest), scopeIds: list(input.scopeIds, uuid, invalidRequest) };
      narrow(next, previous, invalidRequest);
      const payload = { connectionId: previous.id, expectedEpoch: previous.epoch,
        read: next.restrictions.read, action: next.restrictions.action, scopeIds: next.scopeIds };
      const result = await call('restrictConnection', payload, options);
      if (!exact(result, ['ok', 'connection']) || result.ok !== true) invalidAck();
      const row = connection(result.connection, CONNECTION, 'active', invalidAck);
      sameOwner(row, previous, invalidAck);
      if (row.epoch !== previous.epoch + 1) invalidAck();
      sameLimits(row, next, invalidAck);
      return { ok: true, connection: row };
    },
    // Stable opaque renewal is one CAS write, not secret rotation or a grant.
    // Caller must freshly verify Auth/CRM before renewal and before admission.
    // SQL computes the lease using its clock after locks; host time is not an
    // input. Lost ACK requires a joined read of the SAME opaque, never a retry,
    // provider refresh or minting a replacement by this adapter.
    async renewConnection(input, options) {
      const keys = ['tokenDigest', 'connectionId', 'expectedEpoch', 'credentialRef', 'expectedRevision', 'expectedExpiresAt', 'requestedTtlMs'];
      if (!exact(input, keys) || !digest(input.tokenDigest) || !uuid(input.connectionId) || !uuid(input.credentialRef) ||
          ['expectedEpoch', 'expectedRevision', 'expectedExpiresAt', 'requestedTtlMs'].some(key => !positive(input[key])) ||
          input.expectedEpoch >= Number.MAX_SAFE_INTEGER || input.expectedRevision >= Number.MAX_SAFE_INTEGER ||
          input.expectedExpiresAt > Number.MAX_SAFE_INTEGER - 900_000 || input.requestedTtlMs > 900_000) invalidRequest();
      // Copy scalars before awaiting so mutation cannot change CAS or ACK bounds.
      const payload = Object.fromEntries(keys.map(key => [key, input[key]]));
      const result = await call('renewConnection', payload, options);
      // The exact expiry is selected by DB and may be shorter than the requested
      // TTL (session/hard-age cap). Since the old lease must still be live in DB,
      // this relative upper bound is valid without trusting the host clock.
      if (!exact(result, ['ok', 'status', 'expiresAt']) || result.ok !== true || result.status !== 'renewed' ||
          !positive(result.expiresAt) || result.expiresAt <= payload.expectedExpiresAt ||
          result.expiresAt > payload.expectedExpiresAt + payload.requestedTtlMs) invalidAck();
      return { ok: true, status: 'renewed', expiresAt: result.expiresAt };
    },
    async revokeConnection(input, options) {
      if (!exact(input, ['connectionId', 'expectedEpoch']) || !uuid(input.connectionId) ||
          !positive(input.expectedEpoch) || input.expectedEpoch >= Number.MAX_SAFE_INTEGER) invalidRequest();
      const result = await call('revokeConnection', { connectionId: input.connectionId, expectedEpoch: input.expectedEpoch }, options);
      if (!exact(result, ['ok', 'status'])) invalidAck();
      if (result.ok === false && result.status === 'missing') return { ok: false, status: 'missing' };
      if (result.ok !== true || !['revoked', 'already_revoked'].includes(result.status)) invalidAck();
      return { ok: true, status: result.status };
    },
  });
}
