import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { validateSessionMaterial } from './session-crypto.mjs';
const exact = (v, keys) => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, 'value'));
const id = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0 && v < Number.MAX_SAFE_INTEGER;
const fail = code => { throw new BrokerError(code); };
const digest = value => createHash('sha256').update(value).digest('hex');

/** Prepare carries only a branded receipt. The broker awaits its existing audit
 * between prepare/finalize. Final RPC uses the actual caller JWT and is the last
 * await, with live SQL identity, ownership, sharing and TTL decisions. */
export function createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads, mayUse, validateInput, validateResult, clock = Date.now } = {}) {
  if ([authority?.resolve, authority?.checkUnchanged, connectionStore?.readConnection, crypto?.open,
    auth?.verifySession, reads?.execute, mayUse, validateInput, validateResult, clock].some(fn => typeof fn !== 'function')) throw new TypeError('invalid_bound_user_operation_service');
  const issued = new WeakMap();
  const check = signal => { if (!(signal instanceof AbortSignal)) fail('invalid_request'); if (signal.aborted) fail('timeout'); };
  return Object.freeze({
    async prepare(token, operation, suppliedInput, { signal } = {}) {
      check(signal);
      if (typeof token !== 'string' || !/^hc_[A-Za-z0-9_-]{43}$/.test(token)) fail('unauthorized');
      let input; try { input = validateInput(operation, suppliedInput); } catch { fail('invalid_request'); }
      const authorityReceipt = await authority.resolve(token, { signal }); check(signal);
      if (!mayUse(authorityReceipt.effective, operation)) fail('forbidden');
      const identity = structuredClone(authorityReceipt), tokenDigest = digest(token);
      const joined = await connectionStore.readConnection({ tokenDigest }, { signal }); check(signal);
      const c = joined?.connection, s = joined?.session;
      if (joined?.status !== 'active' || !c || !s || ['id', 'assistantId', 'userId', 'organizationId', 'state', 'epoch', 'expiresAt'].some(k => c[k] !== identity.row[k]) ||
        c.tokenDigest !== tokenDigest || s.credentialRef !== c.credentialRef || !positive(s.revision) ||
        !exact(s.binding, ['assistantId', 'userId', 'organizationId', 'sessionId']) ||
        ['assistantId', 'userId', 'organizationId'].some(k => s.binding[k] !== c[k]) || !id(s.binding.sessionId)) fail('context_changed');
      const material = validateSessionMaterial(crypto.open(s.envelope, s.binding)); material.refreshToken = undefined;
      const { accessToken, expiresAt } = material;
      if (expiresAt !== s.expiresAt || expiresAt <= clock() || c.expiresAt <= clock()) fail('unauthorized');
      const verified = await auth.verifySession({ accessToken, signal }); check(signal);
      if (!exact(verified, ['userId', 'sessionId', 'expiresAt']) || verified.userId !== c.userId ||
        verified.sessionId !== s.binding.sessionId || verified.expiresAt !== expiresAt) fail('unauthorized');
      if (!id(joined.membership?.membershipId) || !positive(joined.membership?.authorizationVersion) ||
        !(joined.policy?.version === 0 || positive(joined.policy?.version))) fail('backend_unavailable');
      const binding = { connectionId: c.id, tokenDigest, expectedEpoch: c.epoch, expectedPolicyVersion: joined.policy.version,
        expectedMembershipId: joined.membership.membershipId, expectedAuthorizationVersion: joined.membership.authorizationVersion,
        expectedSessionRevision: s.revision };
      const receipt = Object.freeze({});
      issued.set(receipt, { tokenDigest, operation, input, binding, accessToken, expiresAt,
        identity, authorityReceipt, deadline: clock() + 30000 });
      return receipt;
    },
    async finalize(token, receipt, { signal, onDispatch, onRejected } = {}) {
      check(signal);
      const value = issued.get(receipt); issued.delete(receipt);
      if (!value || typeof token !== 'string' || digest(token) !== value.tokenDigest) fail('context_changed');
      const fresh = () => { check(signal); if (value.expiresAt <= clock() || value.identity.row.expiresAt <= clock()) fail('unauthorized');
        if (value.deadline <= clock()) fail('timeout'); };
      fresh();
      await authority.checkUnchanged(token, value.authorityReceipt, { signal }); fresh();
      const result = await reads.execute(value.operation, { accessToken: value.accessToken, binding: value.binding, input: value.input },
        { signal, onDispatch, onRejected }); fresh();
      try { return validateResult(value.operation, result, value.identity, value.input); } catch { fail('backend_unavailable'); }
    },
  });
}
