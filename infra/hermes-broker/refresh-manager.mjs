import { randomUUID } from 'node:crypto';
import { validateSessionBinding, validateSessionMaterial } from './session-crypto.mjs';

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
 * lease must atomically become reconnect_required, NEVER issue the old token.
 *
 * markDispatched(claim) -> bool: CAS revision+owner+fence, reserved/live lease;
 * persist DISPATCHED before contacting the provider. False dispatches nothing.
 * commitRefresh({...claim,envelope,expiresAt}) -> bool: CAS same revision/fence,
 * binding, DISPATCHED state and live lease, increment revision, activate new
 * envelope. Retain the fence so uncertainty can still invalidate this commit.
 * requireReconnect(claim) -> bool: same fence/owner, invalidate both pending
 * and just-committed output of that refresh. Clear material, increment revision.
 * It must never overwrite revoked state or another/newer operation's fence.
 * release(claim) -> bool: RESERVED only, same fence/revision, return to active.
 * revoke({credentialRef}) -> bool: terminal tombstone, fence/revision increment,
 * clear material; all pending commits and release attempts must then fail.
 *
 * Store reads for broker use must exclude reserved/dispatched/reconnect/revoked
 * rows. Never delete a tombstone and reuse the same credential reference.
 * There must be one credential owner for each independent provider session.
 * A store error/timeout may have committed: no unsafe compensating token reuse.
 * On session_reconnect_required the caller must disable its connection/jobs and
 * never fall back to cached access material. If storage also fails during
 * invalidation, durable quarantine/reconciliation is a backend responsibility;
 * this primitive cannot certify recovery or cross-process safety without it.
 * Provider refresh returns {accessToken,refreshToken}; verifySession separately
 * verifies the actual access token's {userId,sessionId,expiresAt}.
 */
export function createRefreshManager({ store, provider, crypto, clock = Date.now,
  timeoutMs = 10_000, leaseMs = 30_000 } = {}) {
  const methods = ['acquire', 'markDispatched', 'commitRefresh', 'requireReconnect', 'release', 'revoke'];
  if (methods.some((key) => typeof store?.[key] !== 'function') ||
      typeof provider?.refresh !== 'function' || typeof provider?.verifySession !== 'function' ||
      typeof crypto?.open !== 'function' || typeof crypto?.seal !== 'function' || typeof clock !== 'function' ||
      !integer(timeoutMs) || timeoutMs > 30_000 || !integer(leaseMs) || leaseMs > 120_000 || leaseMs < timeoutMs * 2) {
    fail('refresh_config_invalid');
  }
  const bounded = async (operation, code) => {
    const controller = new AbortController(); let timer;
    try {
      return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new SessionRefreshError(code)); }, timeoutMs);
      })]);
    } catch { fail(code); }
    finally { clearTimeout(timer); controller.abort(); }
  };
  const stored = (name, input) => bounded(() => store[name](input), 'refresh_storage_unavailable');
  const now = () => { const value = clock(); if (!integer(value)) fail('refresh_clock_invalid'); return value; };

  return Object.freeze({
    async refresh(credentialRef, suppliedBinding) {
      if (!reference(credentialRef)) fail('refresh_invalid_request');
      let binding;
      try { binding = validateSessionBinding(suppliedBinding); } catch { fail('refresh_invalid_request'); }
      const ownerId = randomUUID();
      now();
      const acquisition = await stored('acquire', { credentialRef, binding, ownerId, leaseMs });
      if (acquisition?.status !== 'acquired') {
        const codes = { busy: 'refresh_busy', reconnect_required: 'session_reconnect_required',
          revoked: 'session_revoked', missing: 'session_revoked' };
        fail(Object.hasOwn(codes, acquisition?.status) ? codes[acquisition.status] : 'refresh_storage_unavailable');
      }
      const { credential, lease } = acquisition;
      if (!integer(credential?.revision) || !integer(lease?.fence) || !integer(lease?.expiresAt) ||
          lease.expiresAt <= now() || !sameBinding(credential.binding, binding)) fail('refresh_storage_unavailable');
      const claim = { credentialRef, binding, ownerId, revision: credential.revision, fence: lease.fence };
      let dispatched = false;
      try {
        const previous = validateSessionMaterial(crypto.open(credential.envelope, binding));
        // Treat even an ambiguous markDispatched acknowledgement as dispatched.
        // It may have committed on a remote store before the connection failed.
        dispatched = true;
        if (await stored('markDispatched', claim) !== true) fail('session_reconnect_required');
        if (lease.expiresAt <= now()) fail('session_reconnect_required');
        const material = await bounded(async (signal) => {
          const tokens = await provider.refresh({ refreshToken: previous.refreshToken, signal });
          if (signal.aborted) fail('session_reconnect_required');
          // Validate size and shape before allowing provider material into verification.
          validateSessionMaterial({ accessToken: tokens?.accessToken, refreshToken: tokens?.refreshToken, expiresAt: 1 });
          const verified = await provider.verifySession({ accessToken: tokens.accessToken, signal });
          if (signal.aborted || !sameBinding(verified, { userId: binding.userId, sessionId: binding.sessionId }) ||
              !integer(verified?.expiresAt) || verified.expiresAt <= now()) fail('session_reconnect_required');
          return validateSessionMaterial({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: verified.expiresAt });
        }, 'session_reconnect_required');
        if (lease.expiresAt <= now() || material.expiresAt <= now()) fail('session_reconnect_required');
        const envelope = crypto.seal(material, binding);
        if (await stored('commitRefresh', { ...claim, envelope, expiresAt: material.expiresAt }) !== true) fail('session_reconnect_required');
        // No credentials leave this control-plane result. Broker reads must
        // independently recheck live store state and current CRM authorization.
        return { credentialRef, expiresAt: material.expiresAt };
      } catch {
        if (dispatched) {
          // Never reuse the previous token when a provider or commit outcome is
          // uncertain. Pending DISPATCHED rows stay fail-closed even after lease
          // expiry. Ambiguous COMMIT plus unavailable invalidation also requires
          // caller quarantine/reconciliation; there is no safe automatic fallback.
          await stored('requireReconnect', claim).catch(() => {});
          fail('session_reconnect_required');
        }
        await stored('release', claim).catch(() => {});
        fail('refresh_material_unavailable');
      }
    },
    async revoke(credentialRef) {
      if (!reference(credentialRef)) fail('refresh_invalid_request');
      if (await stored('revoke', { credentialRef }) !== true) fail('refresh_storage_unavailable');
      return { revoked: true };
    },
  });
}
