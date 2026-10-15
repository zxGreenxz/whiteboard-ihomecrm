import { randomUUID } from 'node:crypto';
import { validateSessionBinding, validateSessionMaterial } from './session-crypto.mjs';
import { createDependencyScope } from './dependency-scope.mjs';

export class SessionRefreshError extends Error {
  constructor(code) { super(code); this.name = 'SessionRefreshError'; this.code = code; }
}
const fail = (code) => { throw new SessionRefreshError(code); };
const reference = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value > 0;
const sameBinding = (a, b) => Object.keys(b).every((key) => a?.[key] === b[key]);

/**
 * Protocol primitive, NOT a durable backend. All store operations below must be
 * linearizable transactions using the backend's clock and monotonic fence:
 *
 * acquire({credentialRef,binding,ownerId,leaseMs}) -> {status:'acquired',
 *   credential:{revision,binding,envelope}, lease:{fence,expiresAt}} or
 *   {status:'busy'|'reconnect_required'|'revoked'|'missing'}.
 * An acquired row is reserved/refreshing. A nonexpired lease is busy. An expired
 * RESERVED lease may be reclaimed with a higher fence; an expired DISPATCHED
 * or STAGED lease must atomically become reconnect_required, NEVER issue the old token.
 *
 * markDispatched(claim) -> bool: CAS revision+owner+fence, reserved/live lease;
 * persist DISPATCHED before contacting the provider. False dispatches nothing.
 * stageRefresh({...claim,envelope,expiresAt}) -> bool: CAS same revision/fence,
 * binding, DISPATCHED state and live lease. Clear old material; STAGED material
 * is unreadable. Replay succeeds only for the SAME envelope and expiry.
 * publishRefresh(claim) -> {ok:true,status:'published'|'already_published',
 *   revision:claim.revision+1,fence:claim.fence} or false. First publish needs
 * STAGED/live lease; exact replay may acknowledge already-ACTIVE live material.
 * Both calls recheck current authorization. Retain owner/fence for reconciliation.
 * requireReconnect(claim) -> bool: same fence/owner, invalidate both pending
 * and just-committed output of that refresh. Clear material, increment revision.
 * It must never overwrite revoked state or another/newer operation's fence.
 * release(claim) -> bool: RESERVED only, same fence/revision, return to active.
 * revoke({credentialRef}) -> bool: terminal tombstone, fence/revision increment,
 * clear material; all pending commits and release attempts must then fail.
 *
 * Store methods receive (input,{signal}); adapter transport remains bounded.
 * ONLY a store_outcome_unknown error permits one additional stage/publish call,
 * using identical input. No automatic retry of acquire, dispatch or provider.
 * False/denied/malformed replies are not retried. A second unknown outcome gets
 * one bounded requireReconnect, never an unbounded publish/ACK loop.
 *
 * Store reads for broker use must exclude reserved/dispatched/staged/reconnect/revoked
 * rows. Never delete a tombstone and reuse the same credential reference.
 * There must be one credential owner for each independent provider session.
 * A store error/timeout may have committed: no unsafe compensating token reuse.
 * session_reconnect_required means the store acknowledged quarantine (or an
 * acquisition read confirmed that state). After dispatch, false/malformed/lost
 * quarantine ACK or timeout instead returns refresh_outcome_unknown. Both stop
 * this caller/jobs; neither permits cached material or replaying the provider.
 * A caller's unknown outcome is NOT a global revoke. Publication may already be
 * ACTIVE with NEW verified material, and another broker may admit it only after
 * fresh joined-state/Auth/CRM checks. Pending states remain unreadable. The DB
 * decision, not whether this caller received its ACK, owns global admission.
 * The session row retains state/owner/fence/revision for recovery; this primitive
 * does not resume a lost in-memory claim or certify restart recovery. A fresh
 * authoritative read must resolve unknown status before the caller resumes.
 * Two-phase publication is not an exactly-once promise.
 * Provider refresh returns {accessToken,refreshToken}; verifySession separately
 * verifies the actual access token's {userId,sessionId,expiresAt}.
 * refresh(ref,binding,{signal}={}) optionally follows a caller cancellation.
 * Already-aborted calls do nothing. Cancellation of an in-flight acquisition
 * without a confirmed claim is unknown, not proof that no reservation exists.
 * Known RESERVED claims receive one independent bounded release; after dispatch
 * one independent bounded quarantine still runs even when the caller is gone.
 *
 * beginRefresh has the same arguments and returns {result,drained}. A timeout is
 * only a public result: same-credential capacity and close() remain owned until
 * actual dependencies settle. close aborts new work but permits the one bounded
 * release/quarantine above. It never closes a caller-owned dependencyScope.
 * Inject the SAME scope into the manager and fixed store transport so queries
 * below transport deadline races are visible. Provider beginRefresh and
 * beginVerifySession handles are adopted even when they use a separate scope.
 * Legacy injected ports must either settle only after real work or track their
 * inner work in this scope; no wrapper can infer hidden I/O from a raced promise.
 * Drain is not remote rollback, durable recovery, or permission to retry.
 */
export function createRefreshManager({ store, provider, crypto, clock = Date.now,
  timeoutMs = 10_000, leaseMs = 30_000, dependencyScope = createDependencyScope() } = {}) {
  const methods = ['acquire', 'markDispatched', 'stageRefresh', 'publishRefresh', 'requireReconnect', 'release', 'revoke'];
  if (methods.some((key) => typeof store?.[key] !== 'function') ||
      typeof provider?.refresh !== 'function' || typeof provider?.verifySession !== 'function' ||
      typeof crypto?.open !== 'function' || typeof crypto?.seal !== 'function' || typeof clock !== 'function' ||
      typeof dependencyScope?.begin !== 'function' || typeof dependencyScope?.track !== 'function' ||
      !integer(timeoutMs) || timeoutMs > 30_000 || !integer(leaseMs) || leaseMs > 120_000 || leaseMs < timeoutMs * 2) {
    fail('refresh_config_invalid');
  }
  const active = new Set(), credentials = new Set();
  let closed = false, closePromise, drainFailed = false;
  function owned(work, callerSignal, credentialRef) {
    if (closed || drainFailed) fail('refresh_closed');
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) fail('refresh_invalid_request');
    if (callerSignal?.aborted) fail('refresh_cancelled');
    if (credentialRef && credentials.has(credentialRef)) fail('refresh_busy');
    const controller = new AbortController(), entry = { controller };
    const onAbort = () => controller.abort();
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    active.add(entry); if (credentialRef) credentials.add(credentialRef);
    let task;
    try { task = dependencyScope.begin(() => work(controller.signal)); }
    catch { active.delete(entry); credentials.delete(credentialRef); callerSignal?.removeEventListener('abort', onAbort); fail('refresh_closed'); }
    const result = task.result.finally(() => { callerSignal?.removeEventListener('abort', onAbort); controller.abort(); });
    const drained = task.drained.then(() => {
      if (drainFailed) fail('refresh_drain_unknown');
      active.delete(entry); credentials.delete(credentialRef);
    }, () => {
      drainFailed = true; fail('refresh_drain_unknown');
    });
    result.catch(() => {}); drained.catch(() => {}); entry.drained = drained;
    return Object.freeze({ result, drained });
  }
  const bounded = async (operation, code, preserveUnknown = false, callerSignal) => {
    if (callerSignal?.aborted) fail('refresh_cancelled');
    const controller = new AbortController(); let timer, rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { controller.abort(); rejectAbort(new SessionRefreshError('refresh_cancelled')); };
    callerSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const result = await Promise.race([dependencyScope.track(() => {
        if (callerSignal?.aborted) fail('refresh_cancelled');
        return operation(controller.signal);
      }), aborted, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SessionRefreshError(code)); }, timeoutMs);
      })]);
      if (callerSignal?.aborted) fail('refresh_cancelled');
      return result;
    } catch (error) {
      if (callerSignal?.aborted) fail('refresh_cancelled');
      if (preserveUnknown && error?.code === 'store_outcome_unknown') fail('store_outcome_unknown');
      fail(code);
    }
    finally { clearTimeout(timer); callerSignal?.removeEventListener('abort', onAbort); controller.abort(); }
  };
  const stored = (name, input, callerSignal, onDispatch) => {
    const snapshot = structuredClone(input);
    return bounded((signal) => {
      const attempt = dependencyScope.begin(() => { onDispatch?.(); return store[name](snapshot, { signal }); });
      return attempt.result.catch(async error => {
        // A transport may report unknown while its query is still running.
        // Reconciliation must wait for actual work, inside the current deadline.
        if (error?.code === 'store_outcome_unknown') await attempt.drained;
        throw error;
      });
    },
      'refresh_storage_unavailable', name === 'stageRefresh' || name === 'publishRefresh', callerSignal);
  };
  const provided = (name, input) => {
    const begin = provider[name === 'refresh' ? 'beginRefresh' : 'beginVerifySession'];
    if (typeof begin !== 'function') return provider[name](input);
    let task;
    try { task = begin.call(provider, input); }
    catch { drainFailed = true; fail('session_reconnect_required'); }
    if (!(task?.result instanceof Promise) || !(task?.drained instanceof Promise)) {
      drainFailed = true; fail('session_reconnect_required');
    }
    // Also account for a provider with its own dependency-scope instance.
    void dependencyScope.track(() => task.drained).catch(() => { drainFailed = true; });
    return task.result.then(async value => {
      // A successful observer is not proof the provider finished. Do not verify
      // candidates or publish material while cancellation/work is still pending
      // or its drain failed. The enclosing bounded lane still owns the deadline.
      await task.drained;
      if (drainFailed) fail('session_reconnect_required');
      return value;
    });
  };
  const reconciled = async (name, input, callerSignal) => {
    const snapshot = structuredClone(input);
    try { return await stored(name, snapshot, callerSignal); }
    catch (error) {
      if (error.code !== 'store_outcome_unknown') throw error;
      // Exactly one extra fixed-name call. Reuse the snapshot, including the
      // original ciphertext nonce. Never reacquire or contact the provider here.
      return stored(name, snapshot, callerSignal);
    }
  };
  const now = () => { const value = clock(); if (!integer(value)) fail('refresh_clock_invalid'); return value; };

  async function refresh(credentialRef, suppliedBinding, callerSignal) {
      if (!reference(credentialRef) || (callerSignal !== undefined && !(callerSignal instanceof AbortSignal))) fail('refresh_invalid_request');
      if (callerSignal?.aborted) fail('refresh_cancelled');
      let binding;
      try { binding = validateSessionBinding(suppliedBinding); } catch { fail('refresh_invalid_request'); }
      const ownerId = randomUUID();
      now();
      let acquisition, acquireDispatched = false;
      try { acquisition = await stored('acquire', { credentialRef, binding, ownerId, leaseMs }, callerSignal,
        () => { acquireDispatched = true; }); }
      catch (error) {
        // No trustworthy claim is available for cleanup. The server may have
        // reserved it before a cancelled/late ACK; never report an unchanged DB.
        if (callerSignal?.aborted) fail(acquireDispatched ? 'refresh_outcome_unknown' : 'refresh_cancelled');
        throw error;
      }
      if (acquisition?.status !== 'acquired') {
        const codes = { busy: 'refresh_busy', reconnect_required: 'session_reconnect_required',
          revoked: 'session_revoked', missing: 'session_revoked' };
        fail(Object.hasOwn(codes, acquisition?.status) ? codes[acquisition.status] : 'refresh_storage_unavailable');
      }
      const { credential, lease } = acquisition;
      if (!integer(credential?.revision) || credential.revision >= Number.MAX_SAFE_INTEGER ||
          !integer(lease?.fence) || !integer(lease?.expiresAt) ||
          lease.expiresAt <= now() || !sameBinding(credential.binding, binding)) fail('refresh_storage_unavailable');
      const claim = { credentialRef, binding, ownerId, revision: credential.revision, fence: lease.fence };
      let dispatched = false;
      try {
        if (callerSignal?.aborted) fail('refresh_cancelled');
        const previous = validateSessionMaterial(crypto.open(credential.envelope, binding));
        // Treat even an ambiguous markDispatched acknowledgement as dispatched.
        // It may have committed on a remote store before the connection failed.
        if (await stored('markDispatched', claim, callerSignal, () => { dispatched = true; }) !== true) fail('session_reconnect_required');
        if (lease.expiresAt <= now()) fail('session_reconnect_required');
        const material = await bounded(async (signal) => {
          const suppliedTokens = await provided('refresh', { refreshToken: previous.refreshToken, signal });
          if (signal.aborted) fail('session_reconnect_required');
          // Validate size and shape before allowing provider material into verification.
          const tokens = validateSessionMaterial({ accessToken: suppliedTokens?.accessToken, refreshToken: suppliedTokens?.refreshToken, expiresAt: 1 });
          const verified = await provided('verifySession', { accessToken: tokens.accessToken, signal });
          if (signal.aborted || !sameBinding(verified, { userId: binding.userId, sessionId: binding.sessionId }) ||
              !integer(verified?.expiresAt) || verified.expiresAt <= now()) fail('session_reconnect_required');
          return validateSessionMaterial({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: verified.expiresAt });
        }, 'session_reconnect_required', false, callerSignal);
        if (lease.expiresAt <= now() || material.expiresAt <= now()) fail('session_reconnect_required');
        const envelope = crypto.seal(material, binding);
        if (await reconciled('stageRefresh', { ...claim, envelope, expiresAt: material.expiresAt }, callerSignal) !== true) fail('session_reconnect_required');
        const receipt = await reconciled('publishRefresh', claim, callerSignal);
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
            Object.keys(receipt).length !== 4 || !['ok', 'status', 'revision', 'fence'].every(key => Object.hasOwn(receipt, key)) ||
            receipt.ok !== true || !['published', 'already_published'].includes(receipt.status) ||
            receipt.revision !== claim.revision + 1 || receipt.fence !== claim.fence) fail('session_reconnect_required');
        // No credentials leave this control-plane result. Broker reads must
        // independently recheck live store state and current CRM authorization.
        return { credentialRef, expiresAt: material.expiresAt };
      } catch {
        if (dispatched) {
          // Attempt quarantine once, with the original claim. A false or lost
          // ACK is not evidence of a global state change; SQL may still contain
          // an unreadable pending row or a newly published ACTIVE candidate.
          const confirmed = await stored('requireReconnect', claim).catch(() => false);
          if (confirmed === true) fail('session_reconnect_required');
          fail('refresh_outcome_unknown');
        }
        const released = await stored('release', claim).catch(() => false);
        if (callerSignal?.aborted) fail(released === true ? 'refresh_cancelled' : 'refresh_outcome_unknown');
        fail('refresh_material_unavailable');
      }
  }
  function beginRefresh(credentialRef, suppliedBinding, { signal } = {}) {
    if (!reference(credentialRef)) fail('refresh_invalid_request');
    let binding; try { binding = validateSessionBinding(suppliedBinding); } catch { fail('refresh_invalid_request'); }
    return owned(inner => refresh(credentialRef, binding, inner), signal, credentialRef);
  }
  return Object.freeze({
    beginRefresh,
    async refresh(credentialRef, binding, options) { return beginRefresh(credentialRef, binding, options).result; },
    async revoke(credentialRef) {
      if (!reference(credentialRef)) fail('refresh_invalid_request');
      return owned(async signal => {
        if (await stored('revoke', { credentialRef }, signal) !== true) fail('refresh_storage_unavailable');
        return { revoked: true };
      }).result;
    },
    close() {
      if (!closePromise) {
        closed = true;
        for (const entry of active) entry.controller.abort();
        closePromise = Promise.all([...active].map(entry => entry.drained)).then(() => {
          if (drainFailed) fail('refresh_drain_unknown');
        });
        closePromise.catch(() => {});
      }
      return closePromise;
    },
  });
}
