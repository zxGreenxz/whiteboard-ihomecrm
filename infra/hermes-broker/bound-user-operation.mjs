import { createHash } from 'node:crypto';
import { BrokerError } from './broker.mjs';
import { validateSessionMaterial } from './session-crypto.mjs';
const exact = (v, keys) => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).length === keys.length && keys.every(k => Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, 'value'));
const record = v => v !== null && typeof v === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const id = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const positive = v => Number.isSafeInteger(v) && v > 0 && v < Number.MAX_SAFE_INTEGER;
const fail = code => { throw new BrokerError(code); };
const digest = value => createHash('sha256').update(value).digest('hex');
/** Admission modes. 'full' (default) verifies the provider session in prepare and
 * re-resolves authority in finalize. 'initialRead' (the older initialReadAdmission
 * flag) is reserved for the fixed private domain read mount: its RPC owns current
 * CRM/exclusion decisions and returns the output scope (four-key binding).
 * 'cachedBinding' (B2-2, 20/10) keeps the reviewed RPC and the seven-key binding
 * built from the LIVE connection snapshot, takes its identity from the bounded read
 * catalog (readAuthority) and skips both repeats: hermes_domain_read_v1/v2/v3 and
 * hermes_w2_read_v1 compare the caller JWT session and every binding field
 * themselves (42501/PT409), so verifySession/checkUnchanged added no decision. */
export const BOUND_USER_ADMISSIONS = Object.freeze(['full', 'initialRead', 'cachedBinding']);
// B5d (21/10): a read plan may fetch a few more pages of the same statement (same JWT,
// same binding; each page re-admitted by SQL) before merging. Hard ceiling here.
const MAX_PLAN_PAGES = 8;
const plan = value => value === null || (record(value) && Number.isInteger(value.maxPages) && value.maxPages >= 1 && value.maxPages <= MAX_PLAN_PAGES &&
  typeof value.next === 'function' && typeof value.merge === 'function');

/** Prepare carries only a branded receipt. The broker awaits its existing audit
 * between prepare/finalize. Final RPC uses the actual caller JWT and is the last
 * await, with live SQL identity, ownership, sharing and TTL decisions.
 * Writer/group/schedule mounts retain the default ('full') verification and final check.
 * B5d: `resolveInput({operation, input, names, accessToken, identity, tokenDigest, signal})`
 * (optional) turns names the model sent (prepare option `names`) into the ids the validated
 * input carries, after the caller JWT and identity are known and before the receipt is
 * issued; its result goes through validateInput again, and an optional page plan drives
 * finalize. Without the hook, a call carrying names is invalid. */
export function createBoundUserOperationService({ authority, connectionStore, crypto, auth, reads, mayUse, validateInput, validateResult, clock = Date.now,
  initialReadAdmission = false, admission = initialReadAdmission === true ? 'initialRead' : 'full', resolveInput = null } = {}) {
  if ([authority?.resolve, authority?.checkUnchanged, connectionStore?.readConnection, crypto?.open,
    auth?.verifySession, reads?.execute, mayUse, validateInput, validateResult, clock].some(fn => typeof fn !== 'function') ||
    typeof initialReadAdmission !== 'boolean' || !BOUND_USER_ADMISSIONS.includes(admission) ||
    (initialReadAdmission && admission !== 'initialRead') || (resolveInput !== null && typeof resolveInput !== 'function')) throw new TypeError('invalid_bound_user_operation_service');
  // Only the full mode repeats what the final SQL statement already decides.
  const liveRecheck = admission === 'full', fourKeyBinding = admission === 'initialRead';
  const issued = new WeakMap();
  const check = signal => { if (!(signal instanceof AbortSignal)) fail('invalid_request'); if (signal.aborted) fail('timeout'); };
  return Object.freeze({
    async prepare(token, operation, suppliedInput, { signal, names = null } = {}) {
      check(signal);
      if (typeof token !== 'string' || !/^hc_[A-Za-z0-9_-]{43}$/.test(token)) fail('unauthorized');
      if (names !== null && (resolveInput === null || !record(names) || !Object.keys(names).length)) fail('invalid_request');
      // With names the validator may only pass once they are ids (a report whose roomId is required); it runs again below.
      let input; try { input = validateInput(operation, suppliedInput); } catch { if (names === null) fail('invalid_request'); input = suppliedInput; }
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
      if (liveRecheck) {
        const verified = await auth.verifySession({ accessToken, signal }); check(signal);
        if (!exact(verified, ['userId', 'sessionId', 'expiresAt']) || verified.userId !== c.userId ||
          verified.sessionId !== s.binding.sessionId || verified.expiresAt !== expiresAt) fail('unauthorized');
      }
      if (!id(joined.membership?.membershipId) || !positive(joined.membership?.authorizationVersion) ||
        !(joined.policy?.version === 0 || positive(joined.policy?.version))) fail('backend_unavailable');
      // Seven-key binding from the live snapshot just read (never from the cached identity).
      const binding = fourKeyBinding
        ? { connectionId: c.id, tokenDigest, expectedEpoch: c.epoch, expectedSessionRevision: s.revision }
        : { connectionId: c.id, tokenDigest, expectedEpoch: c.epoch, expectedPolicyVersion: joined.policy.version,
          expectedMembershipId: joined.membership.membershipId, expectedAuthorizationVersion: joined.membership.authorizationVersion,
          expectedSessionRevision: s.revision };
      let pages = null;
      if (names !== null) {
        // Names → ids with the caller's own JWT (directory under their RLS); the validator stays the only acceptance fence.
        const resolved = await resolveInput({ operation, input, names: structuredClone(names), accessToken, identity, tokenDigest, signal }); check(signal);
        if (!record(resolved) || !plan(resolved.plan ?? null)) fail('backend_unavailable');
        try { input = validateInput(operation, resolved.input); } catch { fail('invalid_request'); }
        // Input-level grant (crm_read_report: the key of the report named) now that the input is final.
        if (!mayUse(authorityReceipt.effective, operation, input)) fail('forbidden');
        pages = resolved.plan ?? null;
      }
      const receipt = Object.freeze({});
      issued.set(receipt, { tokenDigest, operation, input, binding, accessToken, expiresAt,
        identity, authorityReceipt, deadline: clock() + 30000, pages });
      return receipt;
    },
    async finalize(token, receipt, { signal, onDispatch, onRejected } = {}) {
      check(signal);
      const value = issued.get(receipt); issued.delete(receipt);
      if (!value || typeof token !== 'string' || digest(token) !== value.tokenDigest) fail('context_changed');
      const fresh = () => { check(signal); if (value.expiresAt <= clock() || value.identity.row.expiresAt <= clock()) fail('unauthorized');
        if (value.deadline <= clock()) fail('timeout'); };
      fresh();
      if (liveRecheck) { await authority.checkUnchanged(token, value.authorityReceipt, { signal }); fresh(); }
      const read = async input => {
        const result = await reads.execute(value.operation, { accessToken: value.accessToken, binding: value.binding, input },
          { signal, onDispatch, onRejected }); fresh();
        try { return validateResult(value.operation, result, value.identity, input); } catch { fail('backend_unavailable'); }
      };
      if (value.pages === null) return read(value.input);
      // Page plan (B5d): the same statement, binding and JWT, page after page, each validated; merged once.
      const collected = []; let input = value.input;
      for (;;) {
        const page = await read(input); collected.push(page);
        const next = collected.length < value.pages.maxPages ? value.pages.next(page, input) : null;
        if (next === null) return value.pages.merge(collected);
        try { input = validateInput(value.operation, next); } catch { fail('backend_unavailable'); }
      }
    },
  });
}
