import { permissionShape, connectionPermissionSettings } from './connection-permissions.mjs';
import { DurableConnectionStoreError } from './durable-connection-store.mjs';
import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { validateSessionMaterial } from './session-crypto.mjs';
import { authorityRequestEntries, BROKER_AUTHORITY } from './authority-request-scope.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_.:-]{0,127}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const OWNER = ['assistantId', 'userId', 'organizationId', 'sessionId'];
const ROW = ['id', 'assistantId', 'organizationId', 'userId', 'state', 'epoch', 'restrictions', 'scopeIds', 'tokenDigest', 'credentialRef', 'expiresAt'];
const record = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const uuid = value => typeof value === 'string' && UUID.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const fail = code => { throw new BrokerError(code); };
const malformed = () => fail('backend_unavailable');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = value => createHash('sha256').update(value).digest('hex');

function list(value, predicate) {
  if (!Array.isArray(value) || value.length > 256 || Array.from(value).some(item => !predicate(item))) malformed();
  return [...new Set(value)].sort();
}
function permissions(value) {
  if (!exact(value, ['read', 'action'])) malformed();
  const key = item => typeof item === 'string' && KEY.test(item);
  return { read: list(value.read, key), action: list(value.action, key) };
}
function permissionScopes(value, grants) {
  if (!record(value) || Object.keys(value).length > 256) malformed();
  const keys = Object.keys(value).sort();
  if (keys.some(key => !KEY.test(key) || !exact(value[key], ['buildingIds', 'cashbookIds'])) ||
      [...grants.read, ...grants.action].some(key => !Object.hasOwn(value, key))) malformed();
  return Object.fromEntries(keys.map(key => [key, {
    buildingIds: list(value[key].buildingIds, uuid), cashbookIds: list(value[key].cashbookIds, uuid),
  }]));
}
function copyBounded(value) {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 131072) malformed();
    return structuredClone(value);
  } catch { malformed(); }
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function snapshot(value, tokenDigest, now) {
  if (value === null) fail('unauthorized');
  const result = copyBounded(value);
  if (!exact(result, ['status', 'connection', 'session', 'membership', 'policy']) || result.status !== 'active') malformed();
  const { connection: row, session, membership, policy } = result;
  if (!permissionShape(row, ROW) || ['id', 'assistantId', 'organizationId', 'userId', 'credentialRef'].some(key => !uuid(row[key])) ||
      row.state !== 'active' || row.tokenDigest !== tokenDigest || !positive(row.epoch) || !positive(row.expiresAt) ||
      !exact(session, ['credentialRef', 'revision', 'envelope', 'expiresAt', 'binding']) || session.credentialRef !== row.credentialRef ||
      !positive(session.revision) || !positive(session.expiresAt) || !exact(session.binding, OWNER) || OWNER.some(key => !uuid(session.binding[key])) ||
      OWNER.slice(0, 3).some(key => session.binding[key] !== row[key]) ||
      !exact(membership, ['membershipId', 'authorizationVersion', 'isSuperadmin']) || !uuid(membership.membershipId) ||
      !positive(membership.authorizationVersion) || typeof membership.isSuperadmin !== 'boolean' ||
      !exact(policy, ['version', 'read', 'action', 'scopeIds']) || !(policy.version === 0 || positive(policy.version))) malformed();
  if (row.expiresAt <= now || session.expiresAt <= now) fail('unauthorized');
  // The connection-store adapter and crypto validate ciphertext structure. Keep
  // the envelope in this internal comparison only; it never enters the result.
  if (!record(session.envelope)) malformed();
  return { connection: { ...row, ...connectionPermissionSettings(row, permissions, malformed), restrictions: permissions(row.restrictions), scopeIds: list(row.scopeIds, uuid) },
    session, membership, policy: { version: policy.version, ...permissions({ read: policy.read, action: policy.action }),
      scopeIds: list(policy.scopeIds, uuid) } };
}
function verifiedSession(value, expected, material, now) {
  if (!record(value) || !uuid(value.userId) || !uuid(value.sessionId) || !positive(value.expiresAt)) malformed();
  if (value.userId !== expected.userId || value.sessionId !== expected.sessionId || value.expiresAt <= now ||
      value.expiresAt !== material.expiresAt) fail('unauthorized');
}
function authorization(value, before, now) {
  const current = copyBounded(value), { connection: row, membership } = before;
  if (!record(current) || !uuid(current.userId) || typeof current.isSuperadmin !== 'boolean' ||
      typeof current.epoch !== 'string' || current.epoch.length < 1 || current.epoch.length > 256) malformed();
  const activeOrganizations = list(current.activeOrganizationIds, uuid);
  const member = current.membership;
  if (!exact(member, ['organizationId', 'status', 'revokedAt', 'validFrom', 'validTo', 'membershipId', 'authorizationVersion']) ||
      !uuid(member.organizationId) || !uuid(member.membershipId) || !positive(member.authorizationVersion) ||
      typeof member.status !== 'string' || !(member.revokedAt === null || positive(member.revokedAt)) ||
      !(member.validFrom === null || positive(member.validFrom)) || !(member.validTo === null || positive(member.validTo))) malformed();
  if (current.userId !== row.userId || member.organizationId !== row.organizationId || member.status !== 'ACTIVE' ||
      member.revokedAt !== null || (member.validFrom !== null && member.validFrom > now) || (member.validTo !== null && member.validTo <= now) ||
      !activeOrganizations.includes(row.organizationId) || (!current.isSuperadmin && activeOrganizations.length !== 1)) fail('forbidden');
  if (member.membershipId !== membership.membershipId || member.authorizationVersion !== membership.authorizationVersion ||
      current.isSuperadmin !== membership.isSuperadmin) fail('context_changed');
  const granted = permissions(current.permissions), ceiling = permissions(current.companyCeilings);
  return { epoch: current.epoch, isSuperadmin: current.isSuperadmin, activeOrganizationIds: activeOrganizations,
    membership: { ...member }, permissions: granted, companyCeilings: ceiling,
    scopesByPermission: permissionScopes(current.scopesByPermission, granted) };
}

/** Trusted read-only resolver, not a broker, tool dispatcher or authority cache.
 * Requires createDurableConnectionStore.readConnection plus real Auth verification.
 * Extended auth contract: the P1 readAuthorization shape with membershipId and
 * authorizationVersion INSIDE membership, and scopesByPermission[key] containing
 * explicit {buildingIds:[],cashbookIds:[]} for every granted permission (including
 * empty lists for self-context). The existing P1 Supabase adapter DOES NOT expose
 * this contract yet and cannot be plugged in unchanged. Missing metadata denies.
 *
 * Effective permissions intersect CRM grants, its company ceiling, SQL org policy
 * and connection restrictions. assistantScopeIds are authorization_scopes.id from
 * SQL policy intersect connection restrictions; they are NOT user-effective scope.
 * scopesByPermission retains CRM BUILDING/CASHBOOK IDs per permission, with no union,
 * wildcard or cross-namespace comparison. A P3 business adapter must resolve/map
 * and intersect the two scope namespaces before accessing any business resource.
 * Only the existing context-read tool is implemented by the current broker.
 *
 * Every resolve rereads storage after Auth. checkUnchanged performs a fresh resolve;
 * its WeakSet only brands comparison receipts, never supplies authority. Call it
 * after the final awaited handler/audit step before releasing data. This is not a
 * distributed transaction across Auth and SQL, nor a production rollout proof.
 * identifyConnection performs only a joined, token-digest-bound storage read for
 * quota admission. Its id is not an authorization receipt: resolve must run after
 * admission and the dispatcher must compare the resolved id with that reserved id.
 *
 * Inside a broker invocation (authority-request-scope) the identify snapshot is
 * reused as the opening read of the next resolve, and a resolve result may be
 * handed to exactly one following resolve of the same checkpoint. Outside that
 * window (maintenance, renewal, runtime) every call is fully fresh. Auth and CRM
 * authorization are read concurrently; their checks keep the sequential order.
 */
export function createDurableAuthority({ connectionStore, crypto, auth, clock = Date.now, timeoutMs = 10000 } = {}) {
  if (typeof connectionStore?.readConnection !== 'function' || typeof crypto?.open !== 'function' ||
      typeof auth?.verifySession !== 'function' || typeof auth?.readAuthorization !== 'function' || typeof clock !== 'function' ||
      !positive(timeoutMs) || timeoutMs > 30000) throw new TypeError('invalid_durable_authority_config');
  const issued = new WeakSet(), owner = Object.freeze({});
  const now = () => { const value = clock(); if (!positive(value)) malformed(); return value; };
  // One-shot hand-over inside a single broker checkpoint (authority-request-scope).
  // Only a matching kind is consumed; anything else stays for its owner.
  const take = (tokenDigest, kind) => {
    const entries = authorityRequestEntries(owner), entry = entries?.get(tokenDigest);
    if (entry?.kind !== kind) return undefined;
    entries.delete(tokenDigest); return entry;
  };
  const offer = (tokenDigest, entry) => { authorityRequestEntries(owner)?.set(tokenDigest, entry); };
  const brokerCall = options => options !== null && typeof options === 'object' && options[BROKER_AUTHORITY] === true;
  async function bounded(signal, operation) {
    if (!(signal instanceof AbortSignal)) malformed();
    if (signal.aborted) malformed();
    const controller = new AbortController(); let timer, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const stop = () => { controller.abort(); rejectAbort(new BrokerError('backend_unavailable')); };
    signal.addEventListener('abort', stop, { once: true });
    timer = setTimeout(stop, timeoutMs);
    const check = () => { if (controller.signal.aborted || signal.aborted) malformed(); };
    try { return await Promise.race([Promise.resolve().then(() => { check(); return operation(controller.signal, check); }), aborted]); }
    catch (error) {
      if (error instanceof BrokerError && ['unauthorized', 'forbidden', 'context_changed', 'backend_unavailable'].includes(error.code)) throw error;
      malformed();
    } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); controller.abort(); }
  }
  async function resolve(presentedToken, options = {}) {
    if (typeof presentedToken !== 'string' || !TOKEN.test(presentedToken)) fail('unauthorized');
    const tokenDigest = digest(presentedToken), broker = brokerCall(options);
    if (!broker) {
      // A service may consume the broker's own result of this checkpoint once.
      const handed = take(tokenDigest, 'resolved');
      if (handed) {
        if (!(options?.signal instanceof AbortSignal) || options.signal.aborted) malformed();
        return handed.result;
      }
    }
    return fresh(presentedToken, tokenDigest, options?.signal, broker);
  }
  // broker: the dispatcher's own read. Only it may open with the admission
  // identify snapshot and only its result is offered to the next service.
  function fresh(presentedToken, tokenDigest, signal, broker) {
    const handed = broker ? take(tokenDigest, 'identified') : undefined;
    const pending = bounded(signal, async (innerSignal, check) => {
      const read = async () => {
        let value;
        try { value = await connectionStore.readConnection({ tokenDigest }, { signal: innerSignal }); }
        catch (error) {
          // Only a typed, acknowledged SQL authorization rejection is a denial.
          // Outages, cancellations and uncertain outcomes retain fail-closed 503.
          if (error instanceof DurableConnectionStoreError && error.code === 'store_denied') fail('forbidden');
          throw error;
        }
        check();
        return snapshot(value, tokenDigest, now());
      };
      // The admission identify read of this checkpoint is the opening snapshot;
      // the closing read below still detects any change since that read.
      const before = handed?.kind === 'identified' ? handed.snapshot : await read();
      let material;
      try { material = validateSessionMaterial(crypto.open(before.session.envelope, before.session.binding)); }
      catch { malformed(); }
      if (material.expiresAt <= now() || material.expiresAt !== before.session.expiresAt) fail('unauthorized');
      // Auth and CRM authorization are independent reads of the same bearer and
      // start together, but are awaited in the sequential order: an Auth
      // rejection is returned at once and leaving bounded() aborts the CRM read.
      const verifying = Promise.resolve().then(() => auth.verifySession({ accessToken: material.accessToken, signal: innerSignal }));
      const reading = Promise.resolve().then(() => auth.readAuthorization({ accessToken: material.accessToken, userId: before.connection.userId,
        organizationId: before.connection.organizationId, signal: innerSignal }));
      void reading.catch(() => {});
      const verified = await verifying; check();
      verifiedSession(verified, before.session.binding, material, now());
      const live = await reading; check();
      const current = authorization(live, before, now());
      const after = await read();
      if (fingerprint(before) !== fingerprint(after)) fail('context_changed');
      // Time may advance while the final read is pending even if no row changed.
      if (material.expiresAt <= now() || (current.membership.validTo !== null && current.membership.validTo <= now())) fail('forbidden');
      const row = after.connection;
      const effective = Object.fromEntries(['read', 'action'].map(kind => [kind, current.permissions[kind].filter(key =>
        current.companyCeilings[kind].includes(key) && after.policy[kind].includes(key) && row.restrictions[kind].includes(key))]));
      const assistantScopeIds = after.policy.scopeIds.filter(id => row.scopeIds.includes(id));
      const policyEpoch = fingerprint({ crmEpoch: current.epoch, membership: after.membership, policy: after.policy });
      const contextVersion = fingerprint({ database: after, authorization: current, effective, assistantScopeIds });
      const result = freeze({ row: { id: row.id, assistantId: row.assistantId, userId: row.userId, organizationId: row.organizationId,
        state: row.state, epoch: row.epoch, expiresAt: row.expiresAt, restrictions: row.restrictions },
      effective, policyEpoch, isSuperadmin: current.isSuperadmin, assistantScopeIds,
      scopesByPermission: current.scopesByPermission, contextVersion });
      issued.add(result); return result;
    });
    if (broker) offer(tokenDigest, { kind: 'resolved', result: pending });
    return pending;
  }
  return Object.freeze({
    async identifyConnection(presentedToken, options = {}) {
      const signal = options?.signal, broker = brokerCall(options);
      if (typeof presentedToken !== 'string' || !TOKEN.test(presentedToken)) fail('unauthorized');
      const tokenDigest = digest(presentedToken);
      return bounded(signal, async (innerSignal, check) => {
        let value;
        try { value = await connectionStore.readConnection({ tokenDigest }, { signal: innerSignal }); }
        catch (error) {
          // Only a typed, acknowledged SQL authorization rejection is a denial.
          // Outages, cancellations and uncertain outcomes retain fail-closed 503.
          if (error instanceof DurableConnectionStoreError && error.code === 'store_denied') fail('forbidden');
          throw error;
        }
        check();
        const current = snapshot(value, tokenDigest, now());
        if (broker) offer(tokenDigest, { kind: 'identified', snapshot: current });
        return Object.freeze({ connectionId: current.connection.id });
      });
    },
    resolve, async checkUnchanged(presentedToken, before, options = {}) {
    if (!issued.has(before)) fail('context_changed');
    if (typeof presentedToken !== 'string' || !TOKEN.test(presentedToken)) fail('unauthorized');
    const tokenDigest = digest(presentedToken), broker = brokerCall(options);
    let after;
    if (!broker) {
      // The broker's post-audit result may serve this check, but never the
      // receipt being checked itself: that would compare a result to itself.
      const handed = take(tokenDigest, 'resolved');
      if (handed) {
        if (!(options?.signal instanceof AbortSignal) || options.signal.aborted) malformed();
        const value = await handed.result;
        if (value !== before) after = value;
      }
    }
    after ??= await fresh(presentedToken, tokenDigest, options?.signal, broker);
    if (after.contextVersion !== before.contextVersion) fail('context_changed');
  } });
}
