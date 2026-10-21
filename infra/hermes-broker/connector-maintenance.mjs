import { createHash } from 'node:crypto';
import { DB_CLOCK_SKEW_MS } from './clock-skew.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const OWNER = ['connectionId', 'assistantId', 'userId', 'organizationId'];
const ACK = ['ok', 'status', 'connectionId', 'expiresAt', 'reconciled'];
const TTL_MS = 900000;
// Database re-read delays after an unconfirmed renewal: 30 s, 60 s, 120 s, then
// every 240 s, but never later than RETRY_LEAD_MS before the last confirmed expiry.
const RETRY_DELAYS_MS = Object.freeze([30000, 60000, 120000, 240000]);
const RETRY_LEAD_MS = 30000;
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
 * calls in the backend. This loop does not revive expired/revoked connections
 * or issue credentials, and nothing it remembers is authority.
 *
 * An unconfirmed renewal (rejected result, invalid ACK, refused admission) is
 * neither latched for the process lifetime nor repeated blindly. After the
 * RETRY_DELAYS_MS backoff the connection is re-read through resolveConnection,
 * the live SQL/Auth/CRM source of truth: an advanced expiry is a committed
 * renewal and is only scheduled; an unchanged one re-enters the same backend
 * lane; a token the database stops serving after its last expiry is final.
 * Re-entering that lane replays nothing:
 * - renewal (hermes_store_renew_connection_v1) is a CAS on the epoch, session
 *   revision and token expiry the lane has just re-read, and only moves this
 *   token's expiry forward within LEAST(now + TTL, session expiry, 30 days);
 *   a stale repeat writes nothing;
 * - provider refresh is fenced in SQL (hermes_store_acquire_refresh_v1): a live
 *   lease answers busy, an expired DISPATCHED/STAGED lease becomes
 *   RECONNECT_REQUIRED, so an ambiguous refresh token is never sent again; the
 *   backend adds per-token fences and per-credential single-flight;
 * - every attempt re-checks live authority; changed ownership/policy fails it.
 * Final for this process: owner mismatch or out-of-bounds expiry, an expired
 * token, and an uncertain drain. That connection keeps its backend fence and
 * resources and close() fails so the host retains them; the other connections
 * continue. Only a malformed handle, whose work cannot be observed, halts all.
 * Optional log(record) gets fixed connector_maintenance_state (on change) and
 * connector_maintenance_connection records with an 8-character connection ID
 * prefix and normalized codes; never a token, digest or error message.
 */
export function createConnectorMaintenance({ handoff, backend, clock = Date.now, pollIntervalMs = 30000,
  renewBeforeMs = 300000, stallAfterMs = 120000, log, timers = { setTimeout, clearTimeout } } = {}) {
  if ([handoff?.list, backend?.resolveConnection, backend?.beginExternalConnectionMaintenance, clock,
    timers?.setTimeout, timers?.clearTimeout].some(fn => typeof fn !== 'function') || (log !== undefined && typeof log !== 'function') ||
    !positive(pollIntervalMs) || pollIntervalMs > 60000 || !positive(renewBeforeMs) || renewBeforeMs > 600000 ||
    !positive(stallAfterMs) || stallAfterMs > 600000) {
    throw new TypeError('invalid_connector_maintenance_config');
  }
  // tracked: operationId -> { fingerprint, nextDue, expiresAt, retry, condition }, scheduling only.
  // stopped: operationId -> 'blocked' | 'expired' | 'retained', final for this process.
  const controller = new AbortController(), tracked = new Map(), stopped = new Map();
  let running, timer, closing = false, started = false, closed, halted = false, state = 'idle', reported = 'idle';
  const checkTime = () => { const time = clock(); if (!positive(time)) throw fault('connector_clock_invalid'); return time; };
  const emit = (event, fields) => {
    if (!log) return;
    let ts = null;
    try { const time = clock(); if (positive(time)) ts = new Date(time).toISOString(); } catch { /* The timestamp is optional. */ }
    try { log(Object.freeze({ event, ts, ...fields })); } catch { /* A log sink never changes maintenance. */ }
  };
  const note = (row, action, fields = {}) => emit('connector_maintenance_connection', { connectionId: row.connectionId.slice(0, 8), action, ...fields });
  const counts = () => {
    const result = { requiresReconnect: 0, retrying: 0, retained: 0 };
    for (const reason of stopped.values()) result[reason === 'retained' ? 'retained' : 'requiresReconnect']++;
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
  const stop = (row, reason, code) => { tracked.delete(row.operationId); stopped.set(row.operationId, reason); note(row, reason, { code }); };
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
    item.retry = { attempts }; item.nextDue = retryAt; item.condition = 'retry';
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
    // Unknown drain: the backend keeps this token fenced and its resources owned.
    // Never re-admit it here; the other connections do not share them.
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
    item.retry = undefined; item.condition = 'ok'; item.expiresAt = result.expiresAt; item.nextDue = result.expiresAt - renewBeforeMs;
  };
  // Returns false only for a read-only discovery failure outside a retry.
  const visit = async row => {
    // A lease/ACK is only a scheduling hint, never cached authority. Changed
    // enrollment ownership or token requires discovery again. Due work still
    // enters the backend's live, single-flight revision/refresh pipeline.
    const fingerprint = createHash('sha256').update(JSON.stringify([...OWNER.map(key => row[key]), row.token])).digest('hex');
    let item = tracked.get(row.operationId);
    if (item?.fingerprint !== fingerprint) {
      item = { fingerprint, nextDue: 0, expiresAt: undefined, retry: undefined, condition: 'ok' };
      tracked.set(row.operationId, item);
    }
    if (checkTime() < item.nextDue) return true;
    let owner;
    try { owner = await watched(row, 'resolve', () => backend.resolveConnection(row.token, { signal: controller.signal })); }
    catch (error) {
      if (closing) return true;
      const code = codeOf(error);
      // The database stops serving a token at its expiry; past the last
      // confirmed one, unauthorized is final (a renewal could not revive it).
      if (code === 'unauthorized' && item.expiresAt !== undefined && checkTime() >= item.expiresAt) { stop(row, 'expired', code); return true; }
      if (item.retry) { retryLater(row, item, 'resolve_failed', { code }); return true; }
      // Read-only discovery may recover after a temporary outage: next poll.
      if (item.condition !== `resolve:${code}`) { item.condition = `resolve:${code}`; note(row, 'resolve_failed', { code }); }
      return false;
    }
    if (closing) return true;
    const now = checkTime();
    // Token expiries are DB clock_timestamp() + TTL after any renewal.
    if (!exact(owner, [...OWNER, 'expiresAt']) || !positive(owner.expiresAt)) { stop(row, 'blocked', 'owner_invalid'); return true; }
    if (!same(row, owner)) { stop(row, 'blocked', 'owner_mismatch'); return true; }
    if (owner.expiresAt <= now) { stop(row, 'expired', 'token_expired'); return true; }
    if (owner.expiresAt > now + TTL_MS + DB_CLOCK_SKEW_MS) { stop(row, 'blocked', 'expiry_out_of_bounds'); return true; }
    if (item.retry && owner.expiresAt > item.expiresAt) {
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
      for (const key of tracked.keys()) if (!seen.has(key)) tracked.delete(key);
      for (const row of rows) {
        if (closing || halted) break;
        if (!stopped.has(row.operationId) && !await visit(row)) unavailable = true;
      }
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
