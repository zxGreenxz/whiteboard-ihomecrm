import { createHash } from 'node:crypto';
import { DB_CLOCK_SKEW_MS } from './clock-skew.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const OWNER = ['connectionId', 'assistantId', 'userId', 'organizationId'];
const ACK = ['ok', 'status', 'connectionId', 'expiresAt', 'reconciled'];
const RECOVERY = ['ok', 'status', 'connectionId', 'refreshed'];
const TTL_MS = 900000;
// SQL guarantees a recovered lease for 5 minutes. A token still refused this soon after one (half of that, less
// the lane's own minute at most) was not refused because of its lease, so the lane is not asked again for it.
const REVIVED_GRACE_MS = 150000;
// A connection whose recovery keeps failing only sits in `retrying`: it never produces connector_connection_lost.
// After this many consecutive failed or unconfirmed attempts one record says so, once per such run.
const RECOVERY_STALLED_AFTER = 10;
// Database re-read delays after an unconfirmed renewal: 30 s, 60 s, 120 s, then
// every 240 s, but never later than RETRY_LEAD_MS before the last confirmed expiry.
const RETRY_DELAYS_MS = Object.freeze([30000, 60000, 120000, 240000]);
const RETRY_LEAD_MS = 30000;
// A connection with less than this left and no confirmed renewal is reported once as at risk.
const AT_RISK_MS = 180000;
// Logged codes are short fixed identifiers; free text, tokens and digests are not.
const CODE = /^(?:[a-z][a-z0-9_]{1,39}|[A-Z][A-Z0-9_]{1,39})$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const same = (a, b) => OWNER.every(key => a[key] === b[key]);
const fault = code => Object.assign(new Error(code), { code });
const safeCode = value => typeof value === 'string' && CODE.test(value) && !value.startsWith('hc_') ? value : 'unknown';
// Reads an own data property only: a log line never runs an adapter getter.
const codeOf = error => {
  try {
    const item = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    return safeCode(item && Object.hasOwn(item, 'value') ? item.value : undefined);
  } catch { return 'unknown'; }
};

/** Keeps already enrolled external connections alive without creating Hermes
 * processes or touching personal profiles. The encrypted handoff is a locator;
 * only live backend authority grants access. Maintenance parks and drains MCP
 * calls in the backend. This loop never issues credentials or revives a revoked
 * connection, and nothing it remembers is authority.
 *
 * An unconfirmed renewal (rejected result, invalid ACK, refused admission) is
 * neither latched for the process lifetime nor repeated blindly. After the
 * RETRY_DELAYS_MS backoff the connection is re-read through resolveConnection,
 * the live SQL/Auth/CRM source of truth: an advanced expiry is a committed
 * renewal and is only scheduled; an unchanged one re-enters the same backend
 * lane. Re-entering the lane replays nothing:
 * - renewal (hermes_store_renew_connection_v1) is a CAS on the epoch, session
 *   revision and token expiry the lane has just re-read, and only moves this
 *   token's expiry forward within LEAST(now + TTL, session expiry);
 *   a stale repeat writes nothing;
 * - provider refresh is fenced in SQL (hermes_store_acquire_refresh_v1): a live
 *   lease answers busy, an expired DISPATCHED/STAGED lease becomes
 *   RECONNECT_REQUIRED, so an ambiguous refresh token is never sent again; the
 *   backend adds per-token fences and per-credential single-flight;
 * - every attempt re-checks live authority; changed ownership/policy fails it.
 *
 * A lapsed lease. The database stops serving a token at its expiry, and the
 * renewal lane cannot run while lookups fail. The stop rule: a token the
 * database refuses (unauthorized) past its last confirmed expiry, or at every
 * read for longer than TTL + clock tolerance, is stopped as expired. Without
 * backend.beginExternalConnectionRecovery that rule is final as it stands.
 * With it, expiry alone is not final. The recovery lane is asked instead of
 * stopping, and already at the first refusal of a token that has no confirmed
 * expiry here (it died while the process was down, or was recovered and not
 * served since), rather than after TTL + tolerance. SQL alone decides
 * (hermes_store_recover_connection_v1) and the loop only follows its answer:
 * - recovered, or live with the provider session refreshed: the lease is back
 *   for a short window. Retry and refusal state are cleared and the connection
 *   is due at once, so the normal resolve -> renew path takes over at the next
 *   poll; it is healthy again as soon as that read serves it.
 * - unavailable: the only definitive death (revoked, session unusable,
 *   membership/policy gone, or dead for longer than the SQL grace of 7 days).
 *   It is stopped as expired exactly as without the lane.
 * - live with nothing refreshed: lease and session are sound, so recovery cannot
 *   help this refusal and the stop rule applies to it unchanged. A token still
 *   refused within REVIVED_GRACE_MS of a recovered lease is treated the same
 *   without asking again, so a connection that Auth/CRM refuses is never revived
 *   in a loop; any other answer in between lets the lane be asked again.
 * - a thrown or rejected attempt (Auth provider unreachable, outage, busy,
 *   timeout, lease too short to refresh under, refresh failure, unreadable
 *   answer) is never final: it is retried after the RETRY_DELAYS_MS
 *   backoff, then every 240 s, each time after a database re-read, and counted
 *   as retrying. A re-read that serves the token confirms the attempt instead.
 * Recovery replays nothing either: SQL sets a short expiry on this token only,
 * and the session refresh goes through the same fenced manager as maintenance.
 *
 * Final for this process: owner mismatch or out-of-bounds expiry, a token the
 * stop rule ended (after SQL refused or could not help its recovery, when there
 * is a lane), and an uncertain drain. That connection keeps its backend fence and
 * resources and close() fails so the host retains them; the loop goes on with
 * the others. Their fences are separate, but a provider-refresh drain failure
 * also latches the shared refresh manager/provider, so every later refresh in
 * this process fails and retains its connection too: a retained line calls for
 * an early controlled restart. Only a malformed handle, whose work cannot be
 * observed, halts the whole loop.
 * Optional log(record) gets fixed connector_maintenance_state (on change) and
 * connector_maintenance_connection records with the last 8 characters of the
 * connection ID (as /settings/hermes shows it) and normalized codes; never a
 * token, digest or error message.
 *
 * Two further records do not depend on the overall state changing, because that
 * state can already be needs_attention when a new loss happens:
 * - connector_connection_lost: a connection this process saw healthy (the
 *   database served it with a live expiry, or it renewed) or that the previous
 *   process left in healthyIds turned expired. A
 *   token already dead when the process started never was healthy, so it
 *   produces no such record; it is counted as staleAtStart, not requiresReconnect.
 * - connector_renewal_at_risk: less than AT_RISK_MS left and still not renewed;
 *   once per connection and confirmed expiry.
 * - connector_connection_recovered {status, refreshed}: the recovery lane brought
 *   a lapsed lease back. Its connection lines are recovered, recovery_failed,
 *   recovery_not_dispatched, recovery_unconfirmed (all three retried),
 *   recovery_confirmed (a re-read served the token) and recovery_not_needed.
 * - connector_recovery_stalled {attempts, code}: RECOVERY_STALLED_AFTER attempts
 *   of one connection failed in a row. It changes nothing (the retries go on);
 *   it exists because such a connection stays `retrying` and is never reported
 *   lost. Once per run of failures; a recovery, a confirming read or a stop ends
 *   the run.
 */
export function createConnectorMaintenance({ handoff, backend, clock = Date.now, pollIntervalMs = 30000,
  renewBeforeMs = 300000, stallAfterMs = 120000, log, healthyIds, onHealthyChange, timers = { setTimeout, clearTimeout } } = {}) {
  if ([handoff?.list, backend?.resolveConnection, backend?.beginExternalConnectionMaintenance, clock,
    timers?.setTimeout, timers?.clearTimeout].some(fn => typeof fn !== 'function') || (log !== undefined && typeof log !== 'function') ||
    (backend.beginExternalConnectionRecovery !== undefined && typeof backend.beginExternalConnectionRecovery !== 'function') ||
    (onHealthyChange !== undefined && typeof onHealthyChange !== 'function') ||
    (healthyIds !== undefined && (!Array.isArray(healthyIds) || healthyIds.length > 64 || healthyIds.some(value => typeof value !== 'string' || !UUID.test(value)))) ||
    !positive(pollIntervalMs) || pollIntervalMs > 60000 || !positive(renewBeforeMs) || renewBeforeMs > 600000 ||
    !positive(stallAfterMs) || stallAfterMs > 600000) {
    throw new TypeError('invalid_connector_maintenance_config');
  }
  // tracked: operationId -> { fingerprint, nextDue, expiresAt, retry, condition }, scheduling only.
  // stopped: operationId -> 'blocked' | 'expired' | 'stale' | 'retained', final for this process. 'stale' is
  // 'expired' for a connection never healthy in this process (a dead WAL row at startup): kept, never deleted.
  // risked: operationId -> the confirmed expiry already reported as at risk.
  const controller = new AbortController(), tracked = new Map(), stopped = new Map(), risked = new Map();
  // Optional recovery lane. Its scheduling hints exist only with it: recovering (an attempt is owed after a failed
  // one), recoveryFailures (how many in a row), leaseSound (during this run of refusals SQL found nothing to
  // recover) and revivedAt (last recovered lease).
  const recoverable = typeof backend.beginExternalConnectionRecovery === 'function';
  // healthyIds: operation IDs an earlier process saw healthy (a restart longer than the token life would otherwise
  // turn every live connection into 'stale' and hide its loss). Only a log/count hint, never authority: a wrong or
  // missing list changes which record is written, nothing else. Consumed once per ID, when its first item is created.
  // onHealthyChange(ids) receives the current healthy IDs whenever they change; its failure never changes maintenance.
  // kept: healthy connections that turned 'retained' (never visited again in this process). They are still alive in the
  // database, so a restart must still be able to report them lost if their token dies while the process is down.
  const carried = new Set(healthyIds ?? []), kept = new Set();
  let persisted = [...carried].sort().join();
  const persist = () => {
    if (!onHealthyChange) return;
    const ids = [...new Set([...carried, ...kept, ...[...tracked].filter(([, item]) => item.healthy).map(([key]) => key)])].sort();
    if (ids.join() === persisted) return;
    persisted = ids.join();
    try { void Promise.resolve(onHealthyChange(Object.freeze(ids))).catch(() => {}); } catch { /* A persistence failure never changes maintenance. */ }
  };
  let running, timer, closing = false, started = false, closed, halted = false, state = 'idle', reported = 'idle';
  const checkTime = () => { const time = clock(); if (!positive(time)) throw fault('connector_clock_invalid'); return time; };
  const emit = (event, fields) => {
    if (!log) return;
    let ts = null;
    try { const time = clock(); if (positive(time)) ts = new Date(time).toISOString(); } catch { /* The timestamp is optional. */ }
    try { log(Object.freeze({ event, ts, ...fields })); } catch { /* A log sink never changes maintenance. */ }
  };
  const note = (row, action, fields = {}) => emit('connector_maintenance_connection', { connectionId: row.connectionId.slice(-8), action, ...fields });
  const counts = () => {
    const result = { requiresReconnect: 0, retrying: 0, retained: 0, staleAtStart: 0 };
    for (const reason of stopped.values()) result[reason === 'retained' ? 'retained' : reason === 'stale' ? 'staleAtStart' : 'requiresReconnect']++;
    for (const item of tracked.values()) if (item.retry) result.retrying++;
    return result;
  };
  const settled = unavailable => {
    const { requiresReconnect, retrying, retained } = counts();
    return halted || retained ? 'retained' : requiresReconnect ? 'needs_attention' : retrying ? 'retrying' : unavailable ? 'unavailable' : 'ready';
  };
  // A state line is written only when the settled state changes, never per poll.
  const report = (next, fields = {}) => {
    state = next;
    if (next === reported) return;
    const previous = reported; reported = next;
    emit('connector_maintenance_state', { state: next, previous, ...counts(), halted, ...fields });
  };
  const stop = (row, reason, code, fields = {}) => {
    const healthy = tracked.get(row.operationId)?.healthy === true;
    tracked.delete(row.operationId); risked.delete(row.operationId);
    if (reason === 'retained' && healthy) kept.add(row.operationId);
    stopped.set(row.operationId, reason === 'expired' && !healthy ? 'stale' : reason); note(row, reason, { code, ...fields });
    if (reason === 'expired' && healthy) emit('connector_connection_lost', { connectionId: row.connectionId.slice(-8), code });
  };
  // Reported before the schedule gate so a connection waiting out its backoff is still seen.
  const watchRisk = (row, item) => {
    if (item.expiresAt === undefined) return;
    const expiresInMs = item.expiresAt - checkTime();
    if (expiresInMs <= 0 || expiresInMs >= AT_RISK_MS || risked.get(row.operationId) === item.expiresAt) return;
    risked.set(row.operationId, item.expiresAt);
    emit('connector_renewal_at_risk', { connectionId: row.connectionId.slice(-8), expiresInMs,
      ...(item.retry ? { attempt: item.retry.attempts } : {}), ...(item.lastCode ? { code: item.lastCode } : {}) });
  };
  // Backend steps run one at a time, so one alarm reports a step outliving
  // stallAfterMs. The loop still awaits its actual settlement and drain.
  const watched = async (row, phase, work) => {
    const alarm = timers.setTimeout(() => { if (row) note(row, 'stalled', { phase }); report('stalled', { phase }); }, stallAfterMs);
    alarm?.unref?.();
    try { return await work(); } finally { timers.clearTimeout(alarm); }
  };
  const retryLater = (row, item, action, fields) => {
    const now = checkTime(), attempts = (item.retry?.attempts ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
    const retryAt = Math.max(now, Math.min(now + delay, item.expiresAt - RETRY_LEAD_MS));
    item.retry = { attempts }; item.nextDue = retryAt; item.condition = 'retry'; item.lastCode = fields.code;
    note(row, action, { ...fields, attempt: attempts, retryInMs: retryAt - now, expiresInMs: item.expiresAt - now });
  };
  // Only a fully validated ACK is a schedule source; anything else is re-read from the database.
  const ackProblem = (result, row, baseline) => {
    if (!exact(result, ACK) || typeof result.reconciled !== 'boolean') return 'ack_malformed';
    if (result.ok !== true || result.status !== 'renewed') return 'ack_not_renewed';
    if (result.connectionId !== row.connectionId) return 'ack_connection_mismatch';
    if (!positive(result.expiresAt) || result.expiresAt <= baseline || result.expiresAt > checkTime() + TTL_MS + DB_CLOCK_SKEW_MS) return 'ack_expiry_invalid';
    return undefined;
  };
  const renew = async (row, item) => {
    let operation;
    try { operation = backend.beginExternalConnectionMaintenance(row.token, { signal: controller.signal }); }
    catch (error) {
      // A synchronous refusal precedes any fence, read or write in the backend.
      if (closing) return;
      const code = codeOf(error);
      if (code !== 'busy') { retryLater(row, item, 'renewal_not_dispatched', { code }); return; }
      // Admission busy: the next poll tries again; logged once per episode.
      item.lastCode = code;
      if (item.condition !== 'busy') { item.condition = 'busy'; note(row, 'renewal_not_dispatched', { code }); }
      return;
    }
    // Observe both own promises even when a defective trusted adapter
    // returns an invalid handle. Do not invoke getters while validating.
    for (const key of ['result', 'drained']) {
      const part = operation && Object.getOwnPropertyDescriptor(operation, key);
      if (part && Object.hasOwn(part, 'value') && part.value instanceof Promise) void part.value.catch(() => {});
    }
    if (!exact(operation, ['result', 'drained']) || !(operation.result instanceof Promise) || !(operation.drained instanceof Promise)) {
      halted = true; stop(row, 'retained', 'invalid_handle'); return; // Its work can be neither observed nor drained.
    }
    void operation.drained.catch(() => {});
    let result, failure, failed = false, drainFailed = false;
    await watched(row, 'maintenance', async () => {
      try { result = await operation.result; } catch (error) { failed = true; failure = error; }
      try { await operation.drained; } catch { drainFailed = true; }
    });
    // Unknown drain, checked before closing so a drain failing during close() is
    // still retained: the backend keeps this token fenced and its resources owned.
    // Never re-admit it here. Other tokens have their own fences, but a failed
    // provider-refresh drain latches the shared refresh manager for all of them.
    if (drainFailed) { stop(row, 'retained', 'drain_unknown'); return; }
    if (closing) return;
    if (failed) { retryLater(row, item, 'renewal_failed', { code: codeOf(failure) }); return; }
    const problem = ackProblem(result, row, item.expiresAt);
    if (problem) {
      retryLater(row, item, 'renewal_unconfirmed', { code: problem, ...(problem === 'ack_not_renewed' ? { status: safeCode(result.status) } : {}) });
      return;
    }
    if (item.condition === 'retry' || item.condition === 'busy') {
      note(row, 'renewal_recovered', { ...(item.retry ? { attempt: item.retry.attempts + 1 } : {}), reconciled: result.reconciled });
    }
    item.retry = undefined; item.condition = 'ok'; item.lastCode = undefined; item.expiresAt = result.expiresAt; item.nextDue = result.expiresAt - renewBeforeMs;
  };
  // Past a lapsed lease there is no expiry to finish ahead of: the plain backoff, then every 240 s.
  const backoff = (row, item, action, fields) => {
    const now = checkTime(), attempts = (item.retry?.attempts ?? 0) + 1;
    const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1];
    item.retry = { attempts }; item.nextDue = now + delay; item.condition = 'retry'; item.lastCode = fields.code;
    note(row, action, { ...fields, attempt: attempts, retryInMs: delay });
  };
  // Only a fully validated answer of the recovery lane is acted on; anything else is asked again later.
  const recoveryProblem = (result, row) => {
    if (exact(result, ['ok', 'status', 'refreshed'])) return result.ok === true && result.status === 'unavailable' && result.refreshed === false ? undefined : 'ack_malformed';
    if (!exact(result, RECOVERY) || result.ok !== true || !['recovered', 'live'].includes(result.status) || typeof result.refreshed !== 'boolean') return 'ack_malformed';
    return result.connectionId === row.connectionId ? undefined : 'ack_connection_mismatch';
  };
  // Asks the backend's recovery lane once. 'dead': SQL refused for good. 'sound': SQL found lease and session
  // live, so the caller's stop rule decides. 'revived': due at once. 'pending': nothing is decided here
  // (retried on the backoff, retained, or shutting down).
  const recover = async (row, item) => {
    const later = (action, code) => {
      item.recovering = true; backoff(row, item, action, { code });
      // Changes nothing: one line to alert on per run of failures, ended by a recovery, a confirming read or a stop.
      if (++item.recoveryFailures === RECOVERY_STALLED_AFTER) {
        emit('connector_recovery_stalled', { connectionId: row.connectionId.slice(-8), attempts: item.recoveryFailures, code });
      }
      return 'pending';
    };
    let operation;
    try { operation = backend.beginExternalConnectionRecovery(row.token, { signal: controller.signal }); }
    // A synchronous refusal precedes any fence, read or write in the backend.
    catch (error) { return closing ? 'pending' : later('recovery_not_dispatched', codeOf(error)); }
    for (const key of ['result', 'drained']) {
      const part = operation && Object.getOwnPropertyDescriptor(operation, key);
      if (part && Object.hasOwn(part, 'value') && part.value instanceof Promise) void part.value.catch(() => {});
    }
    if (!exact(operation, ['result', 'drained']) || !(operation.result instanceof Promise) || !(operation.drained instanceof Promise)) {
      halted = true; stop(row, 'retained', 'invalid_handle'); return 'pending'; // Its work can be neither observed nor drained.
    }
    void operation.drained.catch(() => {});
    let result, failure, failed = false, drainFailed = false;
    await watched(row, 'recovery', async () => {
      try { result = await operation.result; } catch (error) { failed = true; failure = error; }
      try { await operation.drained; } catch { drainFailed = true; }
    });
    // As in renew: an unknown drain keeps the backend fence and its resources, also during close().
    if (drainFailed) { stop(row, 'retained', 'drain_unknown'); return 'pending'; }
    if (closing) return 'pending';
    if (failed) return later('recovery_failed', codeOf(failure));
    const problem = recoveryProblem(result, row);
    if (problem) return later('recovery_unconfirmed', problem);
    if (result.status === 'unavailable') return 'dead';
    if (result.status === 'live' && !result.refreshed) {
      if (item.recovering) { item.retry = undefined; item.condition = 'ok'; item.recovering = false; }
      item.recoveryFailures = 0; item.leaseSound = true; note(row, 'recovery_not_needed', { code: 'lease_live' });
      return 'sound';
    }
    note(row, 'recovered', { status: result.status, refreshed: result.refreshed, ...(item.retry ? { attempt: item.retry.attempts + 1 } : {}) });
    emit('connector_connection_recovered', { connectionId: row.connectionId.slice(-8), status: result.status, refreshed: result.refreshed });
    // Nothing of the old lease is kept: the next poll reads the new expiry and lets the normal lane extend it.
    // Only 'recovered' carries SQL's 5-minute guarantee; a refreshed 'live' lease may be shorter, so SQL is asked about it again.
    risked.delete(row.operationId);
    Object.assign(item, { nextDue: 0, expiresAt: undefined, retry: undefined, deniedSince: undefined, condition: 'ok', lastCode: undefined,
      recovering: false, recoveryFailures: 0, leaseSound: false, revivedAt: result.status === 'recovered' ? checkTime() : undefined });
    return 'revived';
  };
  // Returns false only for a read-only discovery failure outside a retry.
  const visit = async row => {
    // A lease/ACK is only a scheduling hint, never cached authority. Changed
    // enrollment ownership or token requires discovery again. Due work still
    // enters the backend's live, single-flight revision/refresh pipeline.
    const fingerprint = createHash('sha256').update(JSON.stringify([...OWNER.map(key => row[key]), row.token])).digest('hex');
    let item = tracked.get(row.operationId);
    if (item?.fingerprint !== fingerprint) {
      item = { fingerprint, nextDue: 0, expiresAt: undefined, retry: undefined, deniedSince: undefined, condition: 'ok', lastCode: undefined, healthy: carried.delete(row.operationId),
        recovering: false, recoveryFailures: 0, leaseSound: false, revivedAt: undefined };
      tracked.set(row.operationId, item); risked.delete(row.operationId);
    }
    watchRisk(row, item);
    if (checkTime() < item.nextDue) return true;
    let owner;
    try { owner = await watched(row, 'resolve', () => backend.resolveConnection(row.token, { signal: controller.signal })); }
    catch (error) {
      if (closing) return true;
      const code = codeOf(error), now = checkTime(), refused = code === 'unauthorized', first = refused && item.deniedSince === undefined;
      // Consecutive refusals start a clock; any other answer restarts it.
      item.deniedSince = refused ? item.deniedSince ?? now : undefined;
      if (!refused) item.leaseSound = false;
      // The database stops serving a token at its expiry, and only this loop
      // renews it (the store principal's RPC, after a successful lookup), never
      // while lookups fail. So the stop rule ends an unauthorized token past the
      // last confirmed expiry, or once refusals outlast any renewal (TTL + DB clock
      // tolerance); the latter also settles WAL rows that died before this process started.
      const ended = refused && ((item.expiresAt !== undefined && now >= item.expiresAt) || now - item.deniedSince >= TTL_MS + DB_CLOCK_SKEW_MS);
      if (recoverable && refused) {
        // Refused although SQL has just guaranteed the lease: the lease is not what is wrong.
        if (!item.leaseSound && item.revivedAt !== undefined && now - item.revivedAt < REVIVED_GRACE_MS) {
          item.leaseSound = true; note(row, 'recovery_not_needed', { code: 'refused_after_recovery' });
        }
        // With a recovery lane the lapsed lease is SQL's call: asked where the rule would stop, when an attempt is
        // still owed, and at the first refusal of a token with no confirmed expiry here instead of TTL + tolerance later.
        if (!item.leaseSound && (ended || item.recovering || (first && item.expiresAt === undefined))) {
          const outcome = await recover(row, item);
          if (outcome === 'pending' || outcome === 'revived') return true;
          if (outcome === 'dead') { stop(row, 'expired', code, { deniedForMs: now - item.deniedSince }); return true; }
        }
      }
      if (ended) { stop(row, 'expired', code, { deniedForMs: now - item.deniedSince }); return true; }
      // A recovery retry, or one with no confirmed expiry, has no expiry to finish ahead of.
      if (item.retry) { (item.recovering || item.expiresAt === undefined ? backoff : retryLater)(row, item, 'resolve_failed', { code }); return true; }
      item.lastCode = code;
      // Read-only discovery may recover after a temporary outage: next poll.
      if (item.condition !== `resolve:${code}`) { item.condition = `resolve:${code}`; note(row, 'resolve_failed', { code }); }
      return false;
    }
    if (closing) return true;
    const now = checkTime();
    item.deniedSince = undefined; item.leaseSound = false;
    // Token expiries are DB clock_timestamp() + TTL after any renewal.
    if (!exact(owner, [...OWNER, 'expiresAt']) || !positive(owner.expiresAt)) { stop(row, 'blocked', 'owner_invalid'); return true; }
    if (!same(row, owner)) { stop(row, 'blocked', 'owner_mismatch'); return true; }
    if (owner.expiresAt <= now) {
      // Served with an expiry already past: as for a refusal, SQL decides first, once per recovery.
      if (recoverable && !(item.revivedAt !== undefined && now - item.revivedAt < REVIVED_GRACE_MS)) {
        const outcome = await recover(row, item);
        if (outcome === 'pending' || outcome === 'revived') return true;
      }
      stop(row, 'expired', 'token_expired'); return true;
    }
    if (owner.expiresAt > now + TTL_MS + DB_CLOCK_SKEW_MS) { stop(row, 'blocked', 'expiry_out_of_bounds'); return true; }
    item.healthy = true; item.lastCode = undefined; item.revivedAt = undefined; // the database served it with a live, in-bounds expiry
    if (item.recovering) {
      // The unconfirmed recovery attempt did take effect (lost or unreadable answer), or the refusal ended: schedule only.
      note(row, 'recovery_confirmed', { source: 'database', attempt: item.retry?.attempts, expiresInMs: owner.expiresAt - now });
      item.retry = undefined; item.condition = 'ok'; item.recovering = false; item.recoveryFailures = 0;
    } else if (item.retry && owner.expiresAt > item.expiresAt) {
      // The unconfirmed attempt did commit (lost or invalid ACK): schedule only.
      note(row, 'renewal_confirmed', { source: 'database', attempt: item.retry.attempts, expiresInMs: owner.expiresAt - now });
      item.retry = undefined; item.condition = 'ok';
    } else if (item.condition.startsWith('resolve:')) { item.condition = 'ok'; note(row, 'resolve_recovered'); }
    item.expiresAt = owner.expiresAt; item.nextDue = owner.expiresAt - renewBeforeMs;
    if (owner.expiresAt - now > renewBeforeMs) return true;
    await renew(row, item);
    return true;
  };
  const cycle = async () => {
    state = 'checking';
    let unavailable = false;
    try {
      const rows = await watched(undefined, 'list', () => handoff.list({ signal: controller.signal }));
      if (!Array.isArray(rows) || rows.length > 64) throw fault('connector_handoff_invalid');
      const seen = new Set();
      // Validate the complete batch before any maintenance write is attempted.
      for (const row of rows) {
        if (!exact(row, [...OWNER, 'operationId', 'token']) || [...OWNER, 'operationId'].some(key => !UUID.test(row[key])) ||
          typeof row.token !== 'string' || !TOKEN.test(row.token) || seen.has(row.operationId)) throw fault('connector_handoff_invalid');
        seen.add(row.operationId);
      }
      for (const key of tracked.keys()) if (!seen.has(key)) { tracked.delete(key); risked.delete(key); }
      for (const key of [...carried, ...kept]) if (!seen.has(key)) { carried.delete(key); kept.delete(key); } // left the WAL: nothing to carry
      for (const row of rows) {
        if (closing || halted) break;
        if (!stopped.has(row.operationId) && !await visit(row)) unavailable = true;
      }
      persist();
      report(settled(unavailable));
    } catch (error) { report(halted || counts().retained ? 'retained' : 'unavailable', { code: codeOf(error) }); }
  };
  const poll = () => {
    if (closing || halted) return;
    running = cycle().finally(() => {
      if (!closing && !halted) { timer = timers.setTimeout(poll, pollIntervalMs); timer?.unref?.(); }
    });
    void running.catch(() => {});
  };
  return Object.freeze({
    start() { if (closing) throw new Error('connector_maintenance_closed'); if (!started) { started = true; poll(); } },
    status() { return Object.freeze({ state, ...counts() }); },
    close() {
      if (!closed) { closing = true; controller.abort(); timers.clearTimeout(timer);
        closed = Promise.resolve().then(async () => {
          await running;
          if (halted || counts().retained) throw fault('connector_maintenance_retained');
          report('closed');
        }); void closed.catch(() => {});
      }
      return closed;
    },
  });
}
