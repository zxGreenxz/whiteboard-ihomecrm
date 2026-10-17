import { createHash } from 'node:crypto';
import { createDependencyScope } from './dependency-scope.mjs';
import { snapshotConnectionAuthority, snapshotConnectionState } from './connection-renewal.mjs';
import { DB_CLOCK_SKEW_MS } from './clock-skew.mjs';

const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const positive = value => Number.isSafeInteger(value) && value > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const codes = new Set(['invalid_request', 'backend_closed', 'busy', 'cancelled', 'timeout', 'maintenance_rejected', 'maintenance_outcome_unknown']);
export class ConnectionMaintenanceError extends Error {
  constructor(code) { super(codes.has(code) ? code : 'maintenance_rejected'); this.name = 'ConnectionMaintenanceError'; this.code = this.message;
    this.outcomeUnknown = this.code === 'maintenance_outcome_unknown'; }
}
const fail = code => { throw new ConnectionMaintenanceError(code); };
function fields(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail('invalid_request');
  return Object.freeze(Object.fromEntries(keys.map(key => {
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (!item || !Object.hasOwn(item, 'value')) fail('invalid_request');
    return [key, item.value];
  })));
}
const pair = value => {
  // Invalid adapter handles can still own live promises. Observe own data ports
  // before validating shape, without invoking an accessor or discarding errors.
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    for (const key of ['result', 'drained']) {
      const item = Object.getOwnPropertyDescriptor(value, key);
      if (item && Object.hasOwn(item, 'value') && item.value instanceof Promise) void item.value.catch(() => {});
    }
  }
  const task = fields(value, ['result', 'drained']);
  if (!(task.result instanceof Promise) || !(task.drained instanceof Promise)) fail('maintenance_outcome_unknown');
  void task.result.catch(() => {}); void task.drained.catch(() => {}); return task;
};

/** Trusted host lane, never HTTP/MCP. The host must park the entire connection's
 * command pump before calling this API and keep it parked until drained. Refresh
 * temporarily makes the shared session unreadable; calling concurrently with a
 * model/tool turn is not supported. This module does not provide that scheduler.
 *
 * Only opaque token input is accepted. Credential reference/session binding come
 * from a matching joined store snapshot and freshly branded Auth/CRM authority.
 * Near expiry: fenced provider refresh -> actual drain -> fresh authority and
 * exact session revision readback -> stable opaque renewal -> final authority.
 * No credential/actor is caller-selectable, no provider retry or timeout replay,
 * and no token/session material leaves this lane. It must run before old expiry;
 * expired sessions require reconnect. A changed policy also stops this caller.
 *
 * Inject the backend's SAME scope for actual SQL/Auth/provider work. Timeout is
 * an observer outcome; per-token/global admission and close wait for real drain.
 * Caller owns refresh manager/provider/renewal lifetimes, closed after admission
 * stops and before destroying crypto/pool. This lane never revokes by raw ref.
 */
export function createConnectionMaintenance({ authority, connectionStore, refreshManager, renewal,
  dependencyScope = createDependencyScope(), clock = Date.now, refreshBeforeMs = 300000,
  timeoutMs = 60000, maxConcurrent = 16, timers = { setTimeout, clearTimeout } } = {}) {
  if ([authority?.resolve, authority?.checkUnchanged, connectionStore?.readConnection, refreshManager?.beginRefresh,
    renewal?.renew, dependencyScope?.begin, dependencyScope?.track, clock, timers?.setTimeout, timers?.clearTimeout].some(fn => typeof fn !== 'function') ||
    !positive(refreshBeforeMs) || refreshBeforeMs > 900000 || !positive(timeoutMs) || timeoutMs > 120000 ||
    !positive(maxConcurrent) || maxConcurrent > 16) throw new TypeError('invalid_connection_maintenance_config');
  const entries = new Set(), tokens = new Set(); let closing = false, closePromise;
  const now = () => { const time = clock(); if (!positive(time)) fail('maintenance_rejected'); return time; };
  const begin = (token, rawOptions) => {
    const { signal } = fields(rawOptions, ['signal']);
    if (typeof token !== 'string' || !TOKEN.test(token) || !(signal instanceof AbortSignal)) fail('invalid_request');
    if (closing) fail('backend_closed'); if (signal.aborted) fail('cancelled');
    const digest = createHash('sha256').update(token).digest('hex');
    if (entries.size >= maxConcurrent || tokens.has(digest)) fail('busy');
    const controller = new AbortController(), entry = { controller, dispatched: false }; let rejectStop;
    const outcome = code => new ConnectionMaintenanceError(entry.dispatched ? 'maintenance_outcome_unknown' : code);
    const stopped = new Promise((_resolve, reject) => { rejectStop = reject; }); void stopped.catch(() => {});
    const stop = code => { entry.reason ??= code; controller.abort(); rejectStop(outcome(entry.reason)); };
    const cancelled = () => stop('cancelled'); signal.addEventListener('abort', cancelled, { once: true });
    const timer = timers.setTimeout(() => stop('timeout'), timeoutMs), options = Object.freeze({ signal: controller.signal });
    entry.stop = stop; entries.add(entry); tokens.add(digest);
    const check = () => { if (closing || signal.aborted || controller.signal.aborted) throw outcome(entry.reason ?? 'cancelled'); };
    const read = async receipt => {
      check(); const context = snapshotConnectionAuthority(receipt, now());
      const state = snapshotConnectionState(await connectionStore.readConnection({ tokenDigest: digest }, options), context, digest, now()); check();
      if (state.expiresAt !== context.expiresAt) fail('maintenance_rejected');
      return { context, state };
    };
    const stable = (current, previous) => {
      if (!same(current.context.stable, previous.context.stable) ||
          !same(current.state.stable.connection, previous.state.stable.connection) ||
          !same(current.state.stable.membership, previous.state.stable.membership) ||
          !same(current.state.stable.policy, previous.state.stable.policy)) fail('maintenance_rejected');
    };
    const unchanged = async receipt => {
      check(); if (await authority.checkUnchanged(token, receipt, options) !== undefined) fail('maintenance_rejected'); check();
    };
    let operation;
    try { operation = dependencyScope.begin(async () => {
      check(); const beforeReceipt = await authority.resolve(token, options); check();
      const before = await read(beforeReceipt); await unchanged(beforeReceipt);
      let expected = before;
      if (before.state.stable.session.expiresAt - now() <= refreshBeforeMs) {
        const old = before.state.stable.session; check(); entry.dispatched = true;
        let refresh;
        try { refresh = pair(refreshManager.beginRefresh(old.credentialRef, old.binding, options)); }
        catch {
          // A thrown begin or malformed handle provides no proof that provider
          // work stopped. Keep ownership and fail close; never infer rollback.
          entry.drainFailed = true; throw outcome('maintenance_outcome_unknown');
        }
        let ack;
        try { ack = await refresh.result; } finally {
          try { await refresh.drained; } catch { entry.drainFailed = true; throw outcome('maintenance_outcome_unknown'); }
        } check();
        const receipt = fields(ack, ['credentialRef', 'expiresAt']);
        if (receipt.credentialRef !== old.credentialRef || !positive(receipt.expiresAt) ||
            receipt.expiresAt <= old.expiresAt || receipt.expiresAt > now() + 86400000) fail('maintenance_rejected');
        const afterReceipt = await authority.resolve(token, options); check(); expected = await read(afterReceipt);
        stable(expected, before);
        const updated = expected.state.stable.session;
        if (expected.context.expiresAt !== before.context.expiresAt || expected.context.contextVersion === before.context.contextVersion ||
            updated.credentialRef !== old.credentialRef || updated.revision !== old.revision + 1 || !same(updated.binding, old.binding) ||
            updated.expiresAt !== receipt.expiresAt || same(updated.envelope, old.envelope)) fail('maintenance_rejected');
        await unchanged(afterReceipt);
      }
      check(); entry.dispatched = true;
      const result = fields(await renewal.renew(token, options), ['ok', 'status', 'connectionId', 'expiresAt', 'reconciled']); check();
      if (result.ok !== true || result.status !== 'renewed' || result.connectionId !== before.context.stable.row.id ||
          // The renewal target is DB clock_timestamp() + TTL.
          !positive(result.expiresAt) || result.expiresAt <= before.context.expiresAt || result.expiresAt > now() + 900000 + DB_CLOCK_SKEW_MS ||
          result.expiresAt > expected.state.stable.session.expiresAt || typeof result.reconciled !== 'boolean') fail('maintenance_rejected');
      const finalReceipt = await authority.resolve(token, options); check(); const final = await read(finalReceipt);
      stable(final, before);
      if (final.context.expiresAt !== result.expiresAt || !same(final.state.stable.session, expected.state.stable.session)) fail('maintenance_rejected');
      await unchanged(finalReceipt); return result;
    }); } catch (error) {
      timers.clearTimeout(timer); signal.removeEventListener('abort', cancelled); entries.delete(entry); tokens.delete(digest); throw error;
    }
    entry.drained = operation.drained.then(() => { timers.clearTimeout(timer); signal.removeEventListener('abort', cancelled);
      if (entry.drainFailed) fail('maintenance_outcome_unknown');
      entries.delete(entry); tokens.delete(digest); }, () => {
      timers.clearTimeout(timer); signal.removeEventListener('abort', cancelled); stop('maintenance_outcome_unknown'); fail('maintenance_outcome_unknown');
    }); void entry.drained.catch(() => {});
    const completed = operation.result.then(async value => { await entry.drained; check(); return value; },
      () => { throw outcome('maintenance_rejected'); });
    const result = Promise.race([completed, stopped]); void result.catch(() => {});
    return Object.freeze({ result, drained: entry.drained });
  };
  return Object.freeze({ begin,
    async maintain(token, options) { return begin(token, options).result; },
    close() { if (!closePromise) { closing = true; for (const entry of entries) entry.stop('backend_closed');
      closePromise = Promise.all([...entries].map(entry => entry.drained)).then(() => undefined); void closePromise.catch(() => {}); }
    return closePromise; },
  });
}
