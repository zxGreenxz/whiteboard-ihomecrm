import test from 'node:test';
import assert from 'node:assert/strict';
import { createConnectorMaintenance } from './connector-maintenance.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = 1800000000000;
const row = { connectionId: id(1), assistantId: id(2), userId: id(3), organizationId: id(4), operationId: id(5), token: 'hc_' + 'a'.repeat(43) };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(done => setImmediate(done));
function fixture(t, changes = {}) {
  let expiry = NOW + 120000, calls = 0, reads = 0, scheduled;
  const ack = () => ({ ok: true, status: 'renewed', connectionId: row.connectionId, expiresAt: NOW + 900000, reconciled: false });
  const backend = {
    async resolveConnection(token, options) {
      reads++; assert.equal(token, row.token); assert(options.signal instanceof AbortSignal);
      if (changes.resolve) return changes.resolve();
      return Object.fromEntries([...['connectionId', 'assistantId', 'userId', 'organizationId'].map(key => [key, row[key]]), ['expiresAt', expiry]]);
    },
    beginExternalConnectionMaintenance(token, options) {
      calls++; assert.equal(token, row.token); assert(options.signal instanceof AbortSignal);
      if (changes.begin) return changes.begin(ack());
      expiry = NOW + 900000; return { result: Promise.resolve(ack()), drained: Promise.resolve() };
    },
  };
  const service = createConnectorMaintenance({ handoff: { async list() { return changes.rows ?? [row]; } }, backend,
    clock: () => NOW, timers: { setTimeout(fn) { scheduled = fn; return 1; }, clearTimeout() { scheduled = undefined; } } });
  t.after(() => service.close().catch(() => {}));
  return { service, ack, counts: () => ({ calls, reads }), nearExpiry() { expiry = NOW + 120000; },
    async cycle() { if (!scheduled) service.start(); else { const callback = scheduled; scheduled = undefined; callback(); } await tick(); } };
}

test('external maintenance renews the same enrolled token without touching any personal runtime and skips fresh connections', async t => {
  const f = fixture(t); assert.deepEqual(f.counts(), { calls: 0, reads: 0 });
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 }); assert.equal(f.service.status().state, 'ready');
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 2 });
  f.nearExpiry(); await f.cycle(); assert.equal(f.counts().calls, 2);
  await f.service.close(); assert.equal(f.service.status().state, 'closed');
});

test('owner mismatch and malformed batch fail before renewal; persisted owner never grants authority', async t => {
  const a = fixture(t, { resolve: () => ({ ...Object.fromEntries(['connectionId', 'assistantId', 'userId', 'organizationId'].map(k => [k, row[k]])),
    userId: id(99), expiresAt: NOW + 1000 }) });
  await a.cycle(); await a.cycle(); assert.equal(a.counts().calls, 0); assert.equal(a.service.status().requiresReconnect, 1);
  const b = fixture(t, { rows: [row, { ...row, token: 'BAD' }] }); await b.cycle();
  assert.equal(b.counts().reads, 0); assert.equal(b.service.status().state, 'unavailable');
});

test('CRM authority outage is retried as a read only and does not start maintenance', async t => {
  let unavailable = true;
  const f = fixture(t, { resolve() { if (unavailable) throw Error('CRM unavailable'); return {
    ...Object.fromEntries(['connectionId', 'assistantId', 'userId', 'organizationId'].map(k => [k, row[k]])), expiresAt: NOW + 1000 }; } });
  await f.cycle(); assert.equal(f.counts().calls, 0); assert.equal(f.service.status().state, 'unavailable');
  unavailable = false; await f.cycle(); assert.equal(f.counts().calls, 1);
});

test('unknown maintenance outcome remains latched across polling cycles; no blind refresh retry', async t => {
  const f = fixture(t, { begin() { return { result: Promise.reject(Error('unknown')), drained: Promise.resolve() }; } });
  await f.cycle(); await f.cycle(); assert.equal(f.counts().calls, 1);
  assert.equal(f.service.status().requiresReconnect, 1); assert.equal(f.service.status().state, 'needs_attention');
});

test('definite admission busy permits a later cycle because no write was dispatched', async t => {
  let busy = true;
  const f = fixture(t, { begin(ack) { if (busy) throw Object.assign(Error('busy'), { code: 'busy' }); return { result: Promise.resolve(ack), drained: Promise.resolve() }; } });
  await f.cycle(); assert.equal(f.service.status().requiresReconnect, 0); busy = false;
  await f.cycle(); assert.equal(f.counts().calls, 2);
});

test('shutdown waits actual maintenance drain even when the observed operation already failed', async t => {
  const drain = deferred();
  const f = fixture(t, { begin() { return { result: Promise.reject(Error('timeout')), drained: drain.promise }; } });
  await f.cycle(); let closed = false; const close = f.service.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); drain.resolve(); await close; assert.equal(closed, true);
});

test('unknown dependency drain fails shutdown so host keeps credential and ownership resources', async t => {
  const f = fixture(t, { begin(ack) { return { result: Promise.resolve(ack), drained: Promise.reject(Error('PRIVATE DETAILS')) }; } });
  await f.cycle(); assert.equal(f.service.status().state, 'retained');
  await assert.rejects(f.service.close(), { message: 'connector_maintenance_retained' });
});

test('invalid renewal ACK does not unlock a repeated operation', async t => {
  const f = fixture(t, { begin(ack) { return { result: Promise.resolve({ ...ack, connectionId: id(99) }), drained: Promise.resolve() }; } });
  await f.cycle(); await f.cycle(); assert.equal(f.counts().calls, 1); assert.equal(f.service.status().requiresReconnect, 1);
});
