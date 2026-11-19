import { createHash } from 'node:crypto';
import { createDependencyScope } from './dependency-scope.mjs';
import { SessionRefreshError } from './refresh-manager.mjs';
import { DB_CLOCK_SKEW_MS } from './clock-skew.mjs';
import { MIN_REFRESH_WINDOW_MS } from './refresh-window.mjs';

const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BINDING = ['assistantId', 'userId', 'organizationId', 'sessionId'];
const STATE = ['status', 'connectionId', 'credentialRef', 'binding', 'sessionReady', 'sessionExpiresAt', 'expiresAt'];
// No lease SQL grants is longer than the normal 15-minute one; a recovery window is far shorter.
const TTL_MS = 900000;
const positive = value => Number.isSafeInteger(value) && value > 0;
const uuid = value => typeof value === 'string' && UUID.test(value);
const codes = new Set(['invalid_request', 'backend_closed', 'busy', 'cancelled', 'timeout', 'recovery_provider_unreachable', 'recovery_unavailable',
  'recovery_rejected', 'recovery_window_short', 'recovery_refresh_refused', 'recovery_refresh_failed', 'recovery_outcome_unknown']);
export class ConnectionRecoveryError extends Error {
  constructor(code) { super(codes.has(code) ? code : 'recovery_rejected'); this.name = 'ConnectionRecoveryError'; this.code = this.message;
    this.outcomeUnknown = this.code === 'recovery_outcome_unknown'; }
}
const fail = code => { throw new ConnectionRecoveryError(code); };
// Own data properties only: validating a caller's or a port's value never runs an accessor.
function own(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) return undefined;
  const copy = {};
  for (const key of keys) {
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (!item || !Object.hasOwn(item, 'value')) return undefined;
    copy[key] = item.value;
  }
  return copy;
}
const codeOf = error => {
  try {
    const item = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    return item && Object.hasOwn(item, 'value') && typeof item.value === 'string' ? item.value : undefined;
  } catch { return undefined; }
};
// null is SQL's definitive refusal; anything that is not the exact contract is rejected, never interpreted.
function snapshot(value) {
  if (own(value, ['status'])?.status === 'unavailable') return null;
  const state = own(value, STATE), binding = own(state?.binding, BINDING);
  if (!state || !binding || !['recovered', 'live'].includes(state.status) || !uuid(state.connectionId) || !uuid(state.credentialRef) ||
      BINDING.some(key => !uuid(binding[key])) || typeof state.sessionReady !== 'boolean' ||
      !positive(state.sessionExpiresAt) || !positive(state.expiresAt)) fail('recovery_rejected');
  return { ...state, binding: Object.freeze(binding) };
}
// A typed synchronous refusal of the refresh manager precedes any reservation or provider work for the credential.
const ADMISSION = { refresh_busy: 'busy', refresh_closed: 'recovery_unavailable', refresh_cancelled: 'cancelled', refresh_invalid_request: 'recovery_rejected' };
const admissionCode = error => error instanceof SessionRefreshError && Object.hasOwn(ADMISSION, codeOf(error) ?? '') ? ADMISSION[codeOf(error)] : undefined;
// No refresh failure is final here, not even a confirmed quarantine or revocation: the next recovery call asks SQL again.
const REFRESH = { refresh_busy: 'busy', session_reconnect_required: 'recovery_refresh_refused', session_revoked: 'recovery_refresh_refused',
  refresh_outcome_unknown: 'recovery_outcome_unknown' };
const refreshCode = error => !(error instanceof SessionRefreshError) ? 'recovery_outcome_unknown'
  : Object.hasOwn(REFRESH, codeOf(error) ?? '') ? REFRESH[codeOf(error)] : 'recovery_refresh_failed';
const pair = value => {
  // Invalid adapter handles can still own live promises. Observe own data ports
  // before validating shape, without invoking an accessor or discarding errors.
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    for (const key of ['result', 'drained']) {
      const item = Object.getOwnPropertyDescriptor(value, key);
      if (item && Object.hasOwn(item, 'value') && item.value instanceof Promise) void item.value.catch(() => {});
    }
  }
  const task = own(value, ['result', 'drained']);
  if (!task || !(task.result instanceof Promise) || !(task.drained instanceof Promise)) fail('recovery_outcome_unknown');
  void task.result.catch(() => {}); void task.drained.catch(() => {}); return task;
};
const DEAD = Object.freeze({ ok: true, status: 'unavailable', refreshed: false });

/** Trusted host lane, never HTTP/MCP: brings back a connection whose 15-minute
 * token lease lapsed (the host lost the database for a while) without minting,
 * rotating or accepting any credential. The host must park the connection's MCP
 * admission before calling and keep it parked until drained, as for maintenance.
 *
 * First, before SQL is asked at all, providerProbe.beginProbe must report the
 * Auth provider reachable. This lane runs exactly when the network has just come
 * back, has no Auth round trip of its own before the refresh (maintenance has:
 * authority.resolve), and the refresh manager quarantines the session for good on
 * any provider failure after dispatch. Unreachable (or no clean answer in the
 * probe's own short deadline) rejects recovery_provider_unreachable with nothing
 * dispatched: no SQL window is spent and SQL's token expiry is not moved. The
 * probe carries no credential and changes nothing, so a probe port that throws
 * started nothing; only a handle whose drain cannot be proven is kept as unknown.
 *
 * Only the opaque token is accepted; only its digest reaches SQL. One store call
 * (hermes_store_recover_connection_v1) decides everything on the database clock:
 * - 'unavailable' is the ONLY definitive answer that the connection is dead
 *   (revoked, not ACTIVE, session unusable, membership/policy gone, or dead for
 *   longer than the SQL grace). It resolves { ok, status: 'unavailable' }.
 * - 'recovered': SQL has just guaranteed the token a short window (it had expired,
 *   or was short while the session needs a refresh). 'live': SQL wrote nothing.
 * Every authorization path also needs a live provider session, and the refresh
 * fence only works while the token is live, hence the order: revive first, then,
 * when the session is not ready or within refreshBeforeMs of its expiry, start
 * the fenced provider refresh at once, with no step in between. Whatever the
 * answer, a lease with under MIN_REFRESH_WINDOW_MS left (refresh-window.mjs) is
 * too short to refresh under: 'live' because SQL did not extend it, 'recovered'
 * only after an unusually slow store round trip. That attempt is rejected
 * (recovery_window_short) before any dispatch, so the next one asks SQL again.
 *
 * This lane proves nothing about Auth/CRM authority and renews nothing: after it
 * resolves, the normal resolve -> maintenance path must still admit the token and
 * extend the short window to the usual lease. Its result carries no token,
 * digest, credential reference, binding or session material.
 *
 * Every failure is a rejection with a fixed transient code; the caller retries a
 * later attempt from the probe on. No refresh failure is treated as final (the
 * fence can refuse for timing reasons): SQL answers 'unavailable' next time if
 * the session really was quarantined or revoked. No provider retry or replay
 * happens here. After the refresh is dispatched, timeout/cancel/any doubt is
 * recovery_outcome_unknown. A typed synchronous refusal of the refresh manager
 * (busy/closed) started nothing; any other throw or a malformed handle proves no
 * drain, so ownership is kept and close() fails.
 *
 * Inject the backend's SAME scope and refresh manager, and the refresh provider
 * that manager uses as providerProbe (required: no lane without a probe). Timeout
 * is an observer outcome; per-token/global admission and close wait for real
 * drain, the probe's included. Caller owns the store/refresh manager/provider
 * lifetimes, closed after this lane.
 */
export function createConnectionRecovery({ connectionStore, refreshManager, providerProbe, dependencyScope = createDependencyScope(), clock = Date.now,
  refreshBeforeMs = 300000, timeoutMs = 60000, maxConcurrent = 16, timers = { setTimeout, clearTimeout } } = {}) {
  if ([connectionStore?.recoverConnection, refreshManager?.beginRefresh, providerProbe?.beginProbe, dependencyScope?.begin, dependencyScope?.track, clock,
    timers?.setTimeout, timers?.clearTimeout].some(fn => typeof fn !== 'function') ||
    !positive(refreshBeforeMs) || refreshBeforeMs > 900000 || !positive(timeoutMs) || timeoutMs > 120000 ||
    !positive(maxConcurrent) || maxConcurrent > 16) throw new TypeError('invalid_connection_recovery_config');
  const entries = new Set(), tokens = new Set(); let closing = false, closePromise;
  const now = () => { const time = clock(); if (!positive(time)) fail('recovery_rejected'); return time; };
  const begin = (token, rawOptions) => {
    const request = own(rawOptions, ['signal']);
    if (!request || typeof token !== 'string' || !TOKEN.test(token) || !(request.signal instanceof AbortSignal)) fail('invalid_request');
    const { signal } = request;
    if (closing) fail('backend_closed'); if (signal.aborted) fail('cancelled');
    const digest = createHash('sha256').update(token).digest('hex');
    if (entries.size >= maxConcurrent || tokens.has(digest)) fail('busy');
    const controller = new AbortController(), entry = { controller, dispatched: false }; let rejectStop;
    const outcome = code => new ConnectionRecoveryError(entry.dispatched ? 'recovery_outcome_unknown' : code);
    const stopped = new Promise((_resolve, reject) => { rejectStop = reject; }); void stopped.catch(() => {});
    const stop = code => { entry.reason ??= code; controller.abort(); rejectStop(outcome(entry.reason)); };
    const cancelled = () => stop('cancelled'); signal.addEventListener('abort', cancelled, { once: true });
    const timer = timers.setTimeout(() => stop('timeout'), timeoutMs), options = Object.freeze({ signal: controller.signal });
    entry.stop = stop; entries.add(entry); tokens.add(digest);
    const check = () => { if (closing || signal.aborted || controller.signal.aborted) throw outcome(entry.reason ?? 'cancelled'); };
    let operation;
    try { operation = dependencyScope.begin(async () => {
      check();
      // Reachability first: nothing below can be taken back once the provider turns out to be gone.
      let handle, probe;
      try { handle = providerProbe.beginProbe(options); } catch { check(); fail('recovery_provider_unreachable'); }
      try { probe = pair(handle); } catch (error) { entry.drainFailed = true; throw error; }
      let answer, unreachable = false;
      try { answer = await probe.result; } catch { unreachable = true; }
      try { await probe.drained; } catch { entry.drainFailed = true; fail('recovery_outcome_unknown'); }
      check();
      if (unreachable || own(answer, ['reachable'])?.reachable !== true) fail('recovery_provider_unreachable');
      let reply;
      try { reply = await connectionStore.recoverConnection({ tokenDigest: digest }, options); }
      catch (error) {
        // The call is idempotent: a lost ACK, like an outage, is simply asked again by the next attempt.
        check(); fail(['store_denied', 'store_conflict', 'store_rejected'].includes(codeOf(error)) ? 'recovery_rejected' : 'recovery_unavailable');
      }
      check();
      const state = snapshot(reply);
      if (state === null) return DEAD;
      const time = now();
      // A lease this host already counts as expired cannot be admitted by the normal path either.
      if (state.expiresAt <= time || state.expiresAt > time + TTL_MS + DB_CLOCK_SKEW_MS) fail('recovery_rejected');
      const alive = refreshed => Object.freeze({ ok: true, status: state.status, connectionId: state.connectionId, refreshed });
      if (state.sessionReady && state.sessionExpiresAt - time > refreshBeforeMs) return alive(false);
      if (state.expiresAt - time < MIN_REFRESH_WINDOW_MS) fail('recovery_window_short');
      // Nothing is awaited between the store reply and this dispatch: the window SQL granted is not spent waiting.
      let refresh;
      try { refresh = pair(refreshManager.beginRefresh(state.credentialRef, state.binding, options)); }
      catch (error) {
        const refused = admissionCode(error);
        if (refused) fail(refused);
        // Any other throw or a malformed handle provides no proof that provider
        // work stopped. Keep ownership and fail close; never infer rollback.
        entry.dispatched = true; entry.drainFailed = true; throw outcome('recovery_outcome_unknown');
      }
      entry.dispatched = true;
      let ack, failure, failed = false;
      try { ack = await refresh.result; } catch (error) { failed = true; failure = error; }
      try { await refresh.drained; } catch { entry.drainFailed = true; throw outcome('recovery_outcome_unknown'); }
      check();
      if (failed) fail(refreshCode(failure));
      const receipt = own(ack, ['credentialRef', 'expiresAt']), after = now();
      if (!receipt || receipt.credentialRef !== state.credentialRef || !positive(receipt.expiresAt) ||
          receipt.expiresAt <= after || receipt.expiresAt > after + 86400000) throw outcome('recovery_rejected');
      return alive(true);
    }); } catch (error) {
      timers.clearTimeout(timer); signal.removeEventListener('abort', cancelled); entries.delete(entry); tokens.delete(digest); throw error;
    }
    entry.drained = operation.drained.then(() => { timers.clearTimeout(timer); signal.removeEventListener('abort', cancelled);
      if (entry.drainFailed) fail('recovery_outcome_unknown');
      entries.delete(entry); tokens.delete(digest); }, () => {
      timers.clearTimeout(timer); signal.removeEventListener('abort', cancelled); stop('recovery_outcome_unknown'); fail('recovery_outcome_unknown');
    }); void entry.drained.catch(() => {});
    const completed = operation.result.then(async value => { await entry.drained; check(); return value; },
      error => { throw error instanceof ConnectionRecoveryError ? error : outcome('recovery_rejected'); });
    const result = Promise.race([completed, stopped]); void result.catch(() => {});
    return Object.freeze({ result, drained: entry.drained });
  };
  return Object.freeze({ begin,
    async recover(token, options) { return begin(token, options).result; },
    close() { if (!closePromise) { closing = true; for (const entry of entries) entry.stop('backend_closed');
      closePromise = Promise.all([...entries].map(entry => entry.drained)).then(() => undefined); void closePromise.catch(() => {}); }
    return closePromise; },
  });
}
