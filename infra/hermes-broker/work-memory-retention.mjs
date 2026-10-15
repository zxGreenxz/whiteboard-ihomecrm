import { exact } from './work-memory-contract.mjs';

/** Host-owned periodic cleanup. This fixed executor port can only delete expired
 * CRM note bodies; SQL returns a count and leaves required audit untouched.
 * The host starts/stops it with its existing lifecycle, never from an MCP call. */
export function createWorkMemoryRetention({ transport, intervalMs = 3600000, timers = { setTimeout, clearTimeout } } = {}) {
  if (typeof transport?.call !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 60000 || intervalMs > 86400000 ||
    typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') throw new TypeError('invalid_memory_retention');
  const controller = new AbortController(); let pending, timer, closed, started = false, state = 'idle';
  const poll = () => {
    if (controller.signal.aborted) return;
    state = 'running';
    pending = Promise.resolve().then(async () => {
      const result = await transport.call('pruneWorkMemories', { limit: 500 }, { signal: controller.signal });
      if (!exact(result, ['pruned']) || !Number.isSafeInteger(result.pruned) || result.pruned < 0 || result.pruned > 500) throw new Error('retention_response_invalid');
      state = 'ready';
    }).catch(() => { state = 'unavailable'; }).finally(() => {
      if (!controller.signal.aborted) { timer = timers.setTimeout(poll, intervalMs); timer?.unref?.(); }
    });
  };
  return Object.freeze({
    start() { if (controller.signal.aborted) throw new Error('memory_retention_closed'); if (!started) { started = true; poll(); } },
    status() { return Object.freeze({ state }); },
    close() { if (!closed) { controller.abort(); timers.clearTimeout(timer); closed = Promise.resolve().then(async () => { await pending; state = 'closed'; }); } return closed; },
  });
}
