import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { DurableConnectionStoreError } from './durable-connection-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_.:-]{0,127}$/;
const CODES = new Set(['invalid_request', 'unauthorized', 'forbidden', 'context_changed', 'backend_unavailable',
  'cancelled', 'timeout', 'renewal_rejected', 'renewal_outcome_unknown', 'busy', 'backend_closed']);
const record = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const id = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const sha = value => createHash('sha256').update(value).digest('hex');
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class ConnectionRenewalError extends Error {
  constructor(code, outcome = 'not_dispatched', receipt) {
    const safe = CODES.has(code) ? code : 'backend_unavailable';
    super(safe); this.name = 'ConnectionRenewalError'; this.code = safe; this.outcome = outcome;
    this.outcomeUnknown = outcome === 'unknown';
    if (receipt) this.receipt = Object.freeze({ ...receipt });
  }
}
const fail = code => { throw new ConnectionRenewalError(code); };
function list(value, predicate) {
  if (!Array.isArray(value) || value.length > 256 || Array.from(value).some(item => !predicate(item)) || new Set(value).size !== value.length) fail('backend_unavailable');
  return [...value].sort();
}
function permissions(value) {
  if (!exact(value, ['read', 'action'])) fail('backend_unavailable');
  return Object.fromEntries(['read', 'action'].map(kind => [kind, list(value[kind], key => typeof key === 'string' && KEY.test(key))]));
}
function identity(value, now) {
  if (!exact(value, ['row', 'effective', 'policyEpoch', 'isSuperadmin', 'assistantScopeIds', 'scopesByPermission', 'contextVersion']) ||
      !exact(value.row, ['id', 'assistantId', 'userId', 'organizationId', 'state', 'epoch', 'expiresAt', 'restrictions']) ||
      ['id', 'assistantId', 'userId', 'organizationId'].some(key => !id(value.row[key])) || value.row.state !== 'active' ||
      !positive(value.row.epoch) || !positive(value.row.expiresAt) || typeof value.isSuperadmin !== 'boolean' ||
      ![value.policyEpoch, value.contextVersion].every(key => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key))) fail('backend_unavailable');
  if (value.row.expiresAt <= now) fail('unauthorized');
  const effective = permissions(value.effective), restrictions = permissions(value.row.restrictions);
  if (['read', 'action'].some(kind => effective[kind].some(key => !restrictions[kind].includes(key)))) fail('backend_unavailable');
  const scopes = value.scopesByPermission;
  if (!record(scopes) || Object.keys(scopes).length > 256 || [...effective.read, ...effective.action].some(key => !Object.hasOwn(scopes, key))) fail('backend_unavailable');
  const scopesByPermission = Object.fromEntries(Object.keys(scopes).sort().map(key => {
    if (!KEY.test(key) || !exact(scopes[key], ['buildingIds', 'cashbookIds'])) fail('backend_unavailable');
    return [key, { buildingIds: list(scopes[key].buildingIds, id), cashbookIds: list(scopes[key].cashbookIds, id) }];
  }));
  const stable = { row: { id: value.row.id, assistantId: value.row.assistantId, userId: value.row.userId,
    organizationId: value.row.organizationId, state: 'active', epoch: value.row.epoch, restrictions }, effective,
  policyEpoch: value.policyEpoch, isSuperadmin: value.isSuperadmin, assistantScopeIds: list(value.assistantScopeIds, id), scopesByPermission };
  if (Buffer.byteLength(JSON.stringify(stable)) > 131072) fail('backend_unavailable');
  return { stable, expiresAt: value.row.expiresAt, contextVersion: value.contextVersion };
}
function joined(value, initial, tokenDigest, now) {
  if (value === null) fail('unauthorized');
  if (!exact(value, ['status', 'connection', 'session', 'membership', 'policy']) || value.status !== 'active') fail('backend_unavailable');
  const { connection: row, session, membership, policy } = value;
  if (!exact(row, ['id', 'assistantId', 'userId', 'organizationId', 'state', 'epoch', 'expiresAt', 'restrictions', 'scopeIds', 'tokenDigest', 'credentialRef']) ||
      !id(row.credentialRef) || row.tokenDigest !== tokenDigest || !positive(row.expiresAt) ||
      !exact(session, ['credentialRef', 'revision', 'expiresAt', 'binding', 'envelope']) || session.credentialRef !== row.credentialRef ||
      !positive(session.revision) || !positive(session.expiresAt) || !exact(session.binding, ['assistantId', 'userId', 'organizationId', 'sessionId']) ||
      Object.values(session.binding).some(value => !id(value)) ||
      !exact(session.envelope, ['v', 'algorithm', 'keyVersion', 'nonce', 'ciphertext', 'tag']) || session.envelope.v !== 1 || session.envelope.algorithm !== 'A256GCM' ||
      ['keyVersion', 'nonce', 'ciphertext', 'tag'].some(key => typeof session.envelope[key] !== 'string') ||
      !exact(membership, ['membershipId', 'authorizationVersion', 'isSuperadmin']) || !id(membership.membershipId) ||
      !positive(membership.authorizationVersion) || typeof membership.isSuperadmin !== 'boolean' ||
      !exact(policy, ['version', 'read', 'action', 'scopeIds']) || !positive(policy.version)) fail('backend_unavailable');
  if (row.expiresAt <= now || session.expiresAt <= now) fail('unauthorized');
  const owner = initial.stable.row;
  if (['id', 'assistantId', 'userId', 'organizationId', 'state', 'epoch'].some(key => row[key] !== owner[key]) ||
      ['assistantId', 'userId', 'organizationId'].some(key => session.binding[key] !== owner[key]) ||
      !same(permissions(row.restrictions), owner.restrictions)) fail('context_changed');
  const stable = { connection: { ...owner, tokenDigest, credentialRef: row.credentialRef, scopeIds: list(row.scopeIds, id) },
    session: { credentialRef: session.credentialRef, revision: session.revision, expiresAt: session.expiresAt,
      binding: { assistantId: session.binding.assistantId, userId: session.binding.userId, organizationId: session.binding.organizationId, sessionId: session.binding.sessionId },
      envelope: Object.fromEntries(['v', 'algorithm', 'keyVersion', 'nonce', 'ciphertext', 'tag'].map(key => [key, session.envelope[key]])) },
    membership: { membershipId: membership.membershipId, authorizationVersion: membership.authorizationVersion, isSuperadmin: membership.isSuperadmin },
    policy: { version: policy.version, ...permissions({ read: policy.read, action: policy.action }), scopeIds: list(policy.scopeIds, id) } };
  if (Buffer.byteLength(JSON.stringify(stable)) > 131072) fail('backend_unavailable');
  return { stable, expiresAt: row.expiresAt };
}

// Shared strict projections for trusted connection maintenance. These validate
// snapshots only; callers must still obtain and brand-check live authority.
export { identity as snapshotConnectionAuthority, joined as snapshotConnectionState };

/** Trusted backend primitive only; no endpoint, timer, provider refresh or login.
 * SQL selects expiry from DB time. The host clock only rejects expired snapshots.
 * There is exactly one renewal write, followed by fresh joined/Auth/CRM checks.
 * checkUnchanged cannot compare the pre-renew contextVersion afterwards because
 * the legitimate expiry change is part of that fingerprint. Compare all stable
 * authority/session/policy fields instead, then brand-check the new receipt.
 * A lost ACK may reconcile an observed valid extension by another trusted caller;
 * reconciled does NOT attribute that extension to this write or prove exactly-once.
 * Timeout/cancel after dispatch remains unknown. An underlying dependency may
 * still settle; abort is not rollback. Late work cannot dispatch another operation.
 * No JWT, raw opaque, digest, encrypted credential or provider-session ID escapes.
 * This is a bounded observation, not a transaction across Auth and PostgreSQL.
 */
export function createConnectionRenewal({ authority, connectionStore, requestedTtlMs = 900000, timeoutMs = 30000, maxConcurrentRenewals = 16, clock = Date.now } = {}) {
  if ([authority?.resolve, authority?.checkUnchanged, connectionStore?.readConnection, connectionStore?.renewConnection, clock].some(fn => typeof fn !== 'function') ||
      !positive(requestedTtlMs) || requestedTtlMs > 900000 || !positive(timeoutMs) || timeoutMs > 30000 ||
      !positive(maxConcurrentRenewals) || maxConcurrentRenewals > 64) throw new TypeError('invalid_connection_renewal_config');
  const now = () => { const value = clock(); if (!positive(value)) fail('backend_unavailable'); return value; };
  const pending = new Set(), stops = new Set(); let closing = false, closePromise;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    // Stop admission first. Wait for dependency promises, not the public timeout
    // race. Nested adapters remain responsible for draining their own transports.
    for (const stop of stops) stop('backend_closed');
    closePromise = Promise.allSettled([...pending]).then(() => undefined);
    return closePromise;
  };
  return Object.freeze({ async renew(presentedToken, { signal } = {}) {
    if (closing) fail('backend_closed');
    if (typeof presentedToken !== 'string' || !/^hc_[A-Za-z0-9_-]{43}$/.test(presentedToken) || !(signal instanceof AbortSignal)) fail('invalid_request');
    if (signal.aborted) fail('cancelled');
    if (pending.size >= maxConcurrentRenewals) fail('busy');
    const tokenDigest = sha(presentedToken), controller = new AbortController();
    let dispatched = false, receipt, stopReason, rejectStop;
    const outcome = code => new ConnectionRenewalError(dispatched ? 'renewal_outcome_unknown' : code, dispatched ? 'unknown' : 'not_dispatched', receipt);
    const stopped = new Promise((_, reject) => { rejectStop = reject; });
    const stop = code => { stopReason ??= code; controller.abort(); rejectStop(outcome(stopReason)); };
    stops.add(stop);
    const onAbort = () => stop('cancelled'); signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeoutMs), options = { signal: controller.signal };
    const check = () => { if (signal.aborted || controller.signal.aborted) throw outcome(stopReason ?? 'cancelled'); };
    const work = async () => {
      check(); const beforeReceipt = await authority.resolve(presentedToken, options); check();
      const before = identity(beforeReceipt, now());
      check(); const previous = joined(await connectionStore.readConnection({ tokenDigest }, options), before, tokenDigest, now()); check();
      if (previous.expiresAt !== before.expiresAt) fail('context_changed');
      check(); const checked = await authority.checkUnchanged(presentedToken, beforeReceipt, options); check();
      if (checked !== undefined || beforeReceipt.contextVersion !== before.contextVersion) fail('context_changed');
      if (previous.expiresAt <= now()) fail('unauthorized');
      receipt = Object.freeze({ connectionId: before.stable.row.id, expectedEpoch: before.stable.row.epoch, expectedExpiresAt: previous.expiresAt });
      const input = { tokenDigest, connectionId: receipt.connectionId, expectedEpoch: receipt.expectedEpoch,
        credentialRef: previous.stable.session.credentialRef, expectedRevision: previous.stable.session.revision,
        expectedExpiresAt: previous.expiresAt, requestedTtlMs };
      let ack, reconciled = false;
      check(); dispatched = true;
      try { ack = await connectionStore.renewConnection(input, options); check(); }
      catch (error) {
        check();
        if (error instanceof DurableConnectionStoreError && ['store_denied', 'store_conflict', 'store_rejected'].includes(error.code)) {
          throw new ConnectionRenewalError({ store_denied: 'forbidden', store_conflict: 'context_changed', store_rejected: 'renewal_rejected' }[error.code], 'rejected', receipt);
        }
        if (!(error instanceof DurableConnectionStoreError) || error.code !== 'store_outcome_unknown') throw outcome('backend_unavailable');
        reconciled = true;
      }
      if (!reconciled && (!exact(ack, ['ok', 'status', 'expiresAt']) || ack.ok !== true || ack.status !== 'renewed' || !positive(ack.expiresAt))) {
        // A malformed successful ACK is also uncertain; only authoritative
        // readback can establish current lease state, never this payload.
        reconciled = true;
      }
      check(); const after = joined(await connectionStore.readConnection({ tokenDigest }, options), before, tokenDigest, now()); check();
      if (!same(after.stable, previous.stable)) fail('context_changed');
      if (after.expiresAt <= previous.expiresAt || after.expiresAt > previous.expiresAt + requestedTtlMs ||
          after.expiresAt > after.stable.session.expiresAt || (!reconciled && after.expiresAt !== ack.expiresAt)) throw outcome('backend_unavailable');
      check(); const afterReceipt = await authority.resolve(presentedToken, options); check();
      const current = identity(afterReceipt, now());
      if (!same(current.stable, before.stable) || current.expiresAt !== after.expiresAt || current.contextVersion === before.contextVersion) fail('context_changed');
      check(); const last = joined(await connectionStore.readConnection({ tokenDigest }, options), current, tokenDigest, now()); check();
      if (!same(last, after)) fail('context_changed');
      check(); const final = await authority.checkUnchanged(presentedToken, afterReceipt, options); check();
      if (final !== undefined || afterReceipt.contextVersion !== current.contextVersion) fail('context_changed');
      if (current.expiresAt <= now()) fail('unauthorized');
      return Object.freeze({ ok: true, status: 'renewed', connectionId: receipt.connectionId, expiresAt: current.expiresAt, reconciled });
    };
    const running = Promise.resolve().then(work);
    pending.add(running);
    const release = () => { pending.delete(running); stops.delete(stop); };
    void running.then(release, release);
    try { return await Promise.race([running, stopped]); }
    catch (error) {
      if (error instanceof ConnectionRenewalError && error.outcome !== 'not_dispatched') throw error;
      const code = error instanceof ConnectionRenewalError ? error.code : error instanceof BrokerError &&
        ['unauthorized', 'forbidden', 'context_changed'].includes(error.code) ? error.code : 'backend_unavailable';
      throw new ConnectionRenewalError(code, dispatched ? 'unknown' : 'not_dispatched', dispatched ? receipt : undefined);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); controller.abort(); }
  }, close });
}
