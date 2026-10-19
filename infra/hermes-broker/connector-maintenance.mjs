import { createHash } from 'node:crypto';
import { DB_CLOCK_SKEW_MS } from './clock-skew.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const OWNER = ['connectionId', 'assistantId', 'userId', 'organizationId'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype &&
  Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, 'value'));
const same = (a, b) => OWNER.every(key => a[key] === b[key]);

/** Keeps already enrolled external connections alive without creating Hermes
 * processes or touching personal profiles. The encrypted handoff is a locator;
 * only live backend authority grants access. Maintenance parks and drains MCP
 * calls in the backend. No provider write is retried after an ambiguous result.
 * This loop does not revive expired/revoked connections or issue credentials.
 */
export function createConnectorMaintenance({ handoff, backend, clock = Date.now, pollIntervalMs = 30000,
  renewBeforeMs = 300000, timers = { setTimeout, clearTimeout } } = {}) {
  if ([handoff?.list, backend?.resolveConnection, backend?.beginExternalConnectionMaintenance, clock,
    timers?.setTimeout, timers?.clearTimeout].some(fn => typeof fn !== 'function') ||
    !positive(pollIntervalMs) || pollIntervalMs > 60000 || !positive(renewBeforeMs) || renewBeforeMs > 600000) {
    throw new TypeError('invalid_connector_maintenance_config');
  }
  const controller = new AbortController(), blocked = new Set(), schedule = new Map();
  let running, timer, closing = false, started = false, closed, retained = false, state = 'idle';
  const checkTime = () => { const time = clock(); if (!positive(time)) throw new Error('connector_clock_invalid'); return time; };
  const cycle = async () => {
    state = 'checking';
    let unavailable = false;
    try {
      const rows = await handoff.list({ signal: controller.signal });
      if (!Array.isArray(rows) || rows.length > 64) throw new Error('connector_handoff_invalid');
      const seen = new Set();
      // Validate the complete batch before any maintenance write is attempted.
      for (const row of rows) {
        if (!exact(row, [...OWNER, 'operationId', 'token']) || [...OWNER, 'operationId'].some(key => !UUID.test(row[key])) ||
          typeof row.token !== 'string' || !TOKEN.test(row.token) || seen.has(row.operationId)) throw new Error('connector_handoff_invalid');
        seen.add(row.operationId);
      }
      for (const key of schedule.keys()) if (!seen.has(key)) schedule.delete(key);
      for (const row of rows) {
        if (closing) break;
        if (blocked.has(row.operationId)) continue;
        // A lease/ACK is only a scheduling hint, never cached authority. Changed
        // enrollment ownership or token requires discovery again. Due work still
        // enters the backend's live, single-flight revision/refresh pipeline.
        const fingerprint = createHash('sha256').update(JSON.stringify([...OWNER.map(key => row[key]), row.token])).digest('hex');
        const cached = schedule.get(row.operationId);
        if (cached?.fingerprint === fingerprint && checkTime() < cached.nextDue) continue;
        schedule.delete(row.operationId);
        let owner;
        try { owner = await backend.resolveConnection(row.token, { signal: controller.signal }); }
        catch { unavailable = true; continue; } // Read-only discovery may recover after a temporary outage.
        if (closing) break;
        // Token expiries are DB clock_timestamp() + TTL after any renewal.
        if (!exact(owner, [...OWNER, 'expiresAt']) || !same(row, owner) || !positive(owner.expiresAt) ||
          owner.expiresAt <= checkTime() || owner.expiresAt > checkTime() + 900000 + DB_CLOCK_SKEW_MS) { blocked.add(row.operationId); continue; }
        schedule.set(row.operationId, { fingerprint, nextDue: owner.expiresAt - renewBeforeMs });
        if (owner.expiresAt - checkTime() > renewBeforeMs) continue;
        // Latch before dispatch. Only a fully validated ACK plus actual drain
        // allows a later scheduled renewal of this connection.
        blocked.add(row.operationId);
        let operation;
        try {
          operation = backend.beginExternalConnectionMaintenance(row.token, { signal: controller.signal });
          // Observe both own promises even when a defective trusted adapter
          // returns an invalid handle. Do not invoke getters while validating.
          for (const key of ['result', 'drained']) {
            const part = operation && Object.getOwnPropertyDescriptor(operation, key);
            if (part && Object.hasOwn(part, 'value') && part.value instanceof Promise) void part.value.catch(() => {});
          }
          if (!exact(operation, ['result', 'drained']) || !(operation.result instanceof Promise) || !(operation.drained instanceof Promise)) {
            retained = true; throw new Error('connector_maintenance_invalid_handle');
          }
          void operation.drained.catch(() => {});
          let result;
          try { result = await operation.result; }
          finally { try { await operation.drained; } catch { retained = true; throw new Error('connector_maintenance_retained'); } }
          if (!exact(result, ['ok', 'status', 'connectionId', 'expiresAt', 'reconciled']) || result.ok !== true || result.status !== 'renewed' ||
            result.connectionId !== row.connectionId || !positive(result.expiresAt) || result.expiresAt <= owner.expiresAt ||
            result.expiresAt > checkTime() + 900000 + DB_CLOCK_SKEW_MS || typeof result.reconciled !== 'boolean') continue;
          schedule.set(row.operationId, { fingerprint, nextDue: result.expiresAt - renewBeforeMs });
          blocked.delete(row.operationId);
        } catch (error) {
          // The backend rejects admission synchronously before any write when
          // busy. Everything after receiving a handle remains uncertain.
          if (!operation && error?.code === 'busy') blocked.delete(row.operationId);
        }
        if (retained) break;
      }
      state = retained ? 'retained' : blocked.size ? 'needs_attention' : unavailable ? 'unavailable' : 'ready';
    } catch { state = 'unavailable'; }
  };
  const poll = () => {
    if (closing || retained) return;
    running = cycle().finally(() => {
      if (!closing && !retained) { timer = timers.setTimeout(poll, pollIntervalMs); timer?.unref?.(); }
    });
    void running.catch(() => {});
  };
  return Object.freeze({
    start() { if (closing) throw new Error('connector_maintenance_closed'); if (!started) { started = true; poll(); } },
    status() { return Object.freeze({ state, requiresReconnect: blocked.size }); },
    close() {
      if (!closed) { closing = true; controller.abort(); timers.clearTimeout(timer);
        closed = Promise.resolve().then(async () => {
          await running;
          if (retained) throw new Error('connector_maintenance_retained');
          state = 'closed';
        }); void closed.catch(() => {});
      }
      return closed;
    },
  });
}
