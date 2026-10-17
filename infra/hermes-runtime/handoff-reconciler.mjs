import { DB_CLOCK_SKEW_MS } from '../hermes-broker/clock-skew.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^hc_[A-Za-z0-9_-]{43}$/;
const OWNER = ['connectionId', 'assistantId', 'userId', 'organizationId'];
const RECORD = [...OWNER, 'operationId', 'token'];
const positive = value => Number.isSafeInteger(value) && value > 0;
const fail = code => { throw new Error(code); };
function exact(raw, keys) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || Reflect.ownKeys(raw).length !== keys.length) fail('handoff_reconciler_invalid_data');
  return Object.freeze(Object.fromEntries(keys.map(key => {
    const item = Object.getOwnPropertyDescriptor(raw, key);
    if (!item || !Object.hasOwn(item, 'value')) fail('handoff_reconciler_invalid_data');
    return [key, item.value];
  })));
}
function method(port, key) {
  const descriptor = port && Object.getOwnPropertyDescriptor(port, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') fail('handoff_reconciler_invalid_config');
  return descriptor.value.bind(port);
}
function records(raw, limit) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > limit ||
      Reflect.ownKeys(raw).length !== raw.length + 1) fail('handoff_reconciler_invalid_data');
  const seen = new Set(), result = [];
  for (let i = 0; i < raw.length; i++) {
    const item = Object.getOwnPropertyDescriptor(raw, String(i));
    if (!item || !Object.hasOwn(item, 'value')) fail('handoff_reconciler_invalid_data');
    const row = exact(item.value, RECORD);
    if ([...OWNER, 'operationId'].some(key => typeof row[key] !== 'string' || !UUID.test(row[key])) ||
        typeof row.token !== 'string' || !TOKEN.test(row.token) || seen.has(row.operationId)) fail('handoff_reconciler_invalid_data');
    seen.add(row.operationId); result.push(row);
  }
  return Object.freeze(result);
}
const same = (a, b, keys = OWNER) => keys.every(key => a[key] === b[key]);
const promise = value => { if (!(value instanceof Promise)) fail('handoff_reconciler_invalid_lifecycle'); return value; };

/** Single-host, read-only discovery of encrypted handoffs. Stored metadata is
 * an expected owner, never authority; both this resolver and orchestrator.attach
 * verify the same opaque token. Only pre-attach authority reads may repeat.
 * Every dispatched attachment is retained as a no-replay tombstone in memory.
 * Neither WAL deletion nor sign-in/activation/expiry extension is supported.
 *
 * Required trusted ports include actual work drain in their returned promises:
 * handoff.list (FS), backend.resolveConnection (Auth/SQL), orchestrator.attach
 * and stop (startup/runtime). A public timeout race is not that contract.
 * Host shutdown must begin close() and orchestrator.close() concurrently, then
 * await both before releasing backend keys/pool. This component never closes
 * those shared services. Expired authority or a surviving crash lease remains
 * blocked; this module does not recover expired tokens or take over runtimes.
 */
export function createHandoffReconciler({ handoff, backend, orchestrator, clock = Date.now,
  timers = { setTimeout, clearTimeout }, pollIntervalMs = 10000, maxConcurrentAttachments = 2, maxRecords = 64 } = {}) {
  const list = method(handoff, 'list'), resolve = method(backend, 'resolveConnection');
  const attach = method(orchestrator, 'attach'), inspect = method(orchestrator, 'status'), stop = method(orchestrator, 'stop');
  const schedule = method(timers, 'setTimeout'), cancel = method(timers, 'clearTimeout');
  if (typeof clock !== 'function' || !positive(pollIntervalMs) || pollIntervalMs > 60000 ||
      !positive(maxConcurrentAttachments) || maxConcurrentAttachments > 2 ||
      !positive(maxRecords) || maxRecords > 64 || maxConcurrentAttachments > maxRecords) fail('handoff_reconciler_invalid_config');
  const entries = new Map(), profiles = new Map(), connections = new Map(), work = new Set();
  const controller = new AbortController();
  let started = false, closing = false, closed = false, closePromise, timer, polling, cycle = 0, cursor = 0, inFlight = 0;
  let discovery = 'idle', capacityReached = false, retained = false, discoveryRetained = false;
  const now = () => { const time = clock(); if (!positive(time)) fail('handoff_reconciler_clock_invalid'); return time; };
  const track = value => {
    work.add(value); void value.then(() => work.delete(value), () => work.delete(value)); return value;
  };
  const attention = entry => { entry.state = 'needs_attention'; };
  const actual = (port, args, unknown) => {
    try { return promise(port(...args)); }
    catch { retained = true; unknown(); fail('handoff_reconciler_invalid_lifecycle'); }
  };
  const stopEntry = entry => {
    if (!entry.handle || entry.stopping) return entry.stopping;
    // Latch before invoking a port that may synchronously throw or reenter.
    entry.stopping = Promise.resolve().then(() => promise(stop(entry.handle))).then(() => {
      entry.stopped = true;
      // A new human connection may reuse the assistant. Release only the live
      // resource fences after proven stop; keep the dispatched operation itself
      // as a no-replay tombstone. Unknown attach/stop never reaches this branch.
      if (profiles.get(entry.record.assistantId) === entry) profiles.delete(entry.record.assistantId);
      if (connections.get(entry.record.connectionId) === entry) connections.delete(entry.record.connectionId);
    }, () => {
      retained = true; attention(entry); fail('handoff_reconciler_retained');
    });
    track(entry.stopping); void entry.stopping.catch(() => {}); return entry.stopping;
  };
  const identity = raw => {
    const value = exact(raw, [...OWNER, 'expiresAt']), time = now();
    if (OWNER.some(key => typeof value[key] !== 'string' || !UUID.test(value[key])) ||
        !positive(value.expiresAt) || value.expiresAt <= time || value.expiresAt > time + 900000 + DB_CLOCK_SKEW_MS) fail('handoff_reconciler_invalid_authority');
    return value;
  };
  const checkHandle = entry => {
    const value = exact(inspect(entry.handle), ['state', ...OWNER, 'expiresAt']);
    if (!same(value, entry.record) || !['active', 'parking', 'maintaining'].includes(value.state) ||
        !positive(value.expiresAt) || value.expiresAt <= now()) fail('handoff_reconciler_invalid_runtime');
  };
  const monitor = () => {
    for (const entry of entries.values()) {
      if (entry.state !== 'active') continue;
      try { checkHandle(entry); } catch { attention(entry); stopEntry(entry); }
    }
  };
  const perform = async entry => {
    try {
      const unknownWork = () => { entry.retainedWork = true; attention(entry); };
      const current = identity(await actual(resolve, [entry.record.token, { signal: controller.signal }], unknownWork));
      if (closing || entry.state !== 'checking') return;
      if (!same(current, entry.record)) { attention(entry); return; }
      if (profiles.has(current.assistantId) || connections.has(current.connectionId)) { entry.state = 'pending'; return; }
      const expectedOwner = Object.freeze(Object.fromEntries(OWNER.map(key => [key, entry.record[key]])));
      profiles.set(current.assistantId, entry); connections.set(current.connectionId, entry);
      entry.dispatched = true; entry.state = 'attaching';
      const handle = await actual(attach, [{ token: entry.record.token, signal: controller.signal, expectedOwner }], unknownWork);
      // Actual orchestrator handles are branded, frozen empty records. Do not
      // inspect attacker-provided fields or treat arbitrary results as handles.
      if (!handle || Object.getPrototypeOf(handle) !== Object.prototype || !Object.isFrozen(handle) || Reflect.ownKeys(handle).length) {
        retained = true; unknownWork(); fail('handoff_reconciler_invalid_lifecycle');
      }
      entry.handle = handle;
      if (closing || entry.state !== 'attaching') { await stopEntry(entry); return; }
      try { checkHandle(entry); } catch { attention(entry); await stopEntry(entry); return; }
      entry.state = 'active';
    } catch {
      if (entry.dispatched) attention(entry);
      else if (entry.state === 'checking') entry.state = 'pending';
    }
  };
  const pump = () => {
    if (closing) return;
    const all = [...entries.values()];
    for (let count = 0; count < all.length && inFlight < maxConcurrentAttachments; count++) {
      const entry = all[cursor++ % all.length];
      if (entry.state !== 'pending' || entry.attemptCycle === cycle) continue;
      entry.attemptCycle = cycle; entry.state = 'checking'; inFlight++;
      const task = Promise.resolve().then(() => closing ? undefined : perform(entry)).finally(() => {
        if (!entry.retainedWork) inFlight--;
        pump();
      });
      track(task); void task.catch(() => {});
    }
  };
  const merge = batch => {
    // Validate immutable operation contents across the entire batch before any
    // new attachment. A changed committed record cannot silently replace A.
    for (const row of batch) {
      const previous = entries.get(row.operationId);
      if (previous && !same(previous.record, row, RECORD)) { attention(previous); stopEntry(previous); fail('handoff_reconciler_record_changed'); }
    }
    for (const row of batch) {
      if (entries.has(row.operationId)) continue;
      if (entries.size >= maxRecords) { capacityReached = true; continue; }
      entries.set(row.operationId, { record: row, state: 'pending', attemptCycle: -1, dispatched: false });
    }
  };
  const poll = () => {
    if (closing || polling || discoveryRetained) return;
    monitor();
    polling = track(Promise.resolve().then(async () => {
      try {
        if (closing) return;
        const batch = records(await actual(list, [{ signal: controller.signal }], () => { discoveryRetained = true; }), maxRecords);
        if (closing) return;
        merge(batch); discovery = 'ready'; cycle++; pump();
      } catch { if (!closing) discovery = 'unavailable'; }
    }).finally(() => {
      polling = undefined;
      if (!closing && !discoveryRetained) timer = schedule(() => { timer = undefined; poll(); }, pollIntervalMs);
    }));
    void polling.catch(() => { discovery = 'unavailable'; });
  };
  return Object.freeze({
    start() { if (closing) fail('handoff_reconciler_closed'); if (started) return; started = true; poll(); },
    status() {
      const counts = { pending: 0, checking: 0, attaching: 0, active: 0, needsAttention: 0, stopped: 0 };
      for (const entry of entries.values()) counts[entry.state === 'needs_attention' ? 'needsAttention' : entry.state]++;
      return Object.freeze({ state: closed ? 'closed' : closing ? 'closing' : started ? 'running' : 'idle',
        discovery, records: entries.size, inFlight, ...counts, capacityReached, retained });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; if (timer !== undefined) cancel(timer); controller.abort();
      for (const entry of entries.values()) stopEntry(entry);
      closePromise = (async () => {
        // Attach may return a handle after abort and add its actual stop work.
        // Wait in bounded rounds over existing work; no polling timer or retry.
        while (work.size) await Promise.allSettled([...work]);
        if (retained) fail('handoff_reconciler_retained');
        for (const entry of entries.values()) { entry.record = undefined; entry.state = 'stopped'; }
        closed = true;
      })();
      return closePromise;
    },
  });
}
