import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnectorMaintenance } from './connector-maintenance.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = 1800000000000;
const OWNER = ['connectionId', 'assistantId', 'userId', 'organizationId'];
const row = { connectionId: id(1), assistantId: id(2), userId: id(3), organizationId: id(4), operationId: id(5), token: 'hc_' + 'a'.repeat(43) };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(done => setImmediate(done));
const owner = (source, expiresAt) => ({ ...Object.fromEntries(OWNER.map(key => [key, source[key]])), expiresAt });
const settle = (result, drained = Promise.resolve()) => ({ result, drained });
// Backend errors here carry secrets in their free text: only a code may reach the log.
const coded = code => Object.assign(new Error(`PRIVATE ${row.token} ${code}`), { code });
const status = (state, changes = {}) => ({ state, requiresReconnect: 0, retrying: 0, retained: 0, ...changes });
const actions = events => events.filter(event => event.event === 'connector_maintenance_connection');
const states = events => events.filter(event => event.event === 'connector_maintenance_state').map(event => event.state);
// The 30 s poll and the 120 s stall alarm are told apart by their delay.
function fakeTimers() {
  const pending = new Set();
  return { setTimeout(fn, ms) { const handle = { fn, ms }; pending.add(handle); return handle; }, clearTimeout(handle) { pending.delete(handle); },
    take(ms) { const handle = [...pending].find(item => item.ms === ms); pending.delete(handle); return handle?.fn; } };
}
function fixture(t, changes = {}) {
  let time = NOW, expiry = NOW + 120000, calls = 0, reads = 0;
  const timers = fakeTimers(), events = [];
  const ack = () => ({ ok: true, status: 'renewed', connectionId: row.connectionId, expiresAt: time + 900000, reconciled: false });
  const backend = {
    async resolveConnection(token, options) {
      reads++; assert.equal(token, changes.rows?.[0]?.token ?? row.token); assert(options.signal instanceof AbortSignal);
      if (changes.resolve) return changes.resolve();
      if (expiry <= time) throw coded('unauthorized'); // The database stops serving a token at its expiry.
      return owner(row, expiry);
    },
    beginExternalConnectionMaintenance(token, options) {
      calls++; assert.equal(token, row.token); assert(options.signal instanceof AbortSignal);
      if (changes.begin) return changes.begin(ack());
      expiry = time + 900000; return settle(Promise.resolve(ack()));
    },
  };
  const service = createConnectorMaintenance({ handoff: { async list() { return changes.rows ?? [row]; } }, backend,
    clock: () => time, log: changes.log ?? (record => events.push(record)), timers });
  t.after(() => service.close().catch(() => {}));
  return { service, ack, events, counts: () => ({ calls, reads }), advance(ms) { time += ms; }, now: () => time,
    nearExpiry() { expiry = time + 120000; }, renewInDatabase() { expiry = time + 900000; }, setExpiry(value) { expiry = value; },
    alarm() { timers.take(120000)(); },
    async cycle() { const poll = timers.take(30000); if (!poll) service.start(); else poll(); await tick(); } };
}
// Several enrolled connections with distinct 8-character ID prefixes and their own database expiry.
function fleet(t, behaviours) {
  let time = NOW;
  const timers = fakeTimers(), events = [];
  const rows = behaviours.map((_, n) => ({ connectionId: `${String(n + 1).repeat(8)}-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
    assistantId: id(2), userId: id(3), organizationId: id(4), operationId: id(200 + n), token: 'hc_' + String.fromCharCode(98 + n).repeat(43) }));
  const db = rows.map(() => ({ expiry: NOW + 120000, calls: 0, reads: 0 }));
  const find = token => { const n = rows.findIndex(item => item.token === token); assert(n >= 0); return n; };
  const backend = {
    async resolveConnection(token) { const n = find(token); db[n].reads++; if (db[n].expiry <= time) throw coded('unauthorized'); return owner(rows[n], db[n].expiry); },
    beginExternalConnectionMaintenance(token) {
      const n = find(token); db[n].calls++;
      const ack = { ok: true, status: 'renewed', connectionId: rows[n].connectionId, expiresAt: time + 900000, reconciled: false };
      const custom = behaviours[n]?.(ack);
      if (custom) return custom;
      db[n].expiry = time + 900000; return settle(Promise.resolve(ack));
    },
  };
  const service = createConnectorMaintenance({ handoff: { async list() { return rows; } }, backend, clock: () => time,
    log: record => events.push(record), timers });
  t.after(() => service.close().catch(() => {}));
  return { service, rows, events, calls: () => db.map(item => item.calls), reads: () => db.map(item => item.reads),
    prefix: n => rows[n].connectionId.slice(0, 8), advance(ms) { time += ms; },
    async cycle() { const poll = timers.take(30000); if (!poll) service.start(); else poll(); await tick(); } };
}

test('external maintenance renews the same enrolled token without touching any personal runtime and skips fresh connections', async t => {
  const f = fixture(t); assert.deepEqual(f.counts(), { calls: 0, reads: 0 });
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 }); assert.equal(f.service.status().state, 'ready');
  for (let i = 0; i < 19; i++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
  f.advance(30000); await f.cycle(); assert.deepEqual(f.counts(), { calls: 2, reads: 2 });
  await f.service.close(); assert.equal(f.service.status().state, 'closed');
});

// Owner expiry is DB clock_timestamp() + 15 min; literal skews so a zeroed tolerance is caught.
for (const ahead of [50, 4000]) {
  test(`owner expiry ${ahead} ms past the 15-minute TTL (DB clock ahead) is not blocked`, async t => {
    let expiry = NOW + 900000 + ahead;
    const f = fixture(t, { resolve: () => owner(row, expiry) });
    await f.cycle(); assert.deepEqual(f.counts(), { calls: 0, reads: 1 });
    assert.deepEqual(f.service.status(), status('ready'));
    f.advance(600000 + ahead); expiry = NOW + 900000 + ahead;
    await f.cycle(); assert.equal(f.counts().calls, 1); // still renewable, i.e. never latched
  });
}

test('owner expiry 6000 ms past the 15-minute TTL blocks the connection from renewal', async t => {
  let expiry = NOW + 900000 + 6000;
  const f = fixture(t, { resolve: () => owner(row, expiry) });
  await f.cycle(); assert.equal(f.counts().calls, 0); assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
  expiry = NOW + 120000; await f.cycle(); assert.equal(f.counts().calls, 0); assert.equal(f.service.status().requiresReconnect, 1);
  assert.deepEqual(actions(f.events).map(event => [event.action, event.code]), [['blocked', 'expiry_out_of_bounds']]);
});

for (const ahead of [50, 4000]) {
  test(`renewal ACK ${ahead} ms past the 15-minute TTL (DB clock ahead) unlocks the next renewal`, async t => {
    const f = fixture(t, { begin: ack => settle(Promise.resolve({ ...ack, expiresAt: NOW + 900000 + ahead })) });
    await f.cycle(); assert.equal(f.counts().calls, 1); assert.deepEqual(f.service.status(), status('ready'));
    await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 }); // ACK is the next schedule source.
    f.advance(600000 + ahead); f.nearExpiry(); await f.cycle(); assert.equal(f.counts().calls, 2);
  });
}

test('renewal ACK 6000 ms past the 15-minute TTL is never a schedule source; the database re-read decides', async t => {
  let reads = 0;
  // The database still reports an out-of-bounds expiry at the re-read: blocked, never a second maintenance.
  const f = fixture(t, { begin: ack => settle(Promise.resolve({ ...ack, expiresAt: NOW + 900000 + 6000 })),
    resolve: () => owner(row, ++reads === 1 ? NOW + 120000 : f.now() + 900000 + 6000) });
  await f.cycle(); assert.equal(f.counts().calls, 1); assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 }));
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
  f.advance(30000); await f.cycle();
  assert.deepEqual(f.counts(), { calls: 1, reads: 2 }); assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
  assert.deepEqual(actions(f.events).map(event => [event.action, event.code]), [['renewal_unconfirmed', 'ack_expiry_invalid'], ['blocked', 'expiry_out_of_bounds']]);
});

test('owner mismatch and malformed batch fail before renewal; persisted owner never grants authority', async t => {
  const a = fixture(t, { resolve: () => ({ ...owner(row, NOW + 1000), userId: id(99) }) });
  await a.cycle(); await a.cycle(); assert.equal(a.counts().calls, 0); assert.equal(a.service.status().requiresReconnect, 1);
  assert.deepEqual(actions(a.events).map(event => [event.action, event.code]), [['blocked', 'owner_mismatch']]);
  const b = fixture(t, { rows: [row, { ...row, token: 'BAD' }] }); await b.cycle();
  assert.equal(b.counts().reads, 0); assert.equal(b.service.status().state, 'unavailable');
  assert.equal(b.events.find(event => event.event === 'connector_maintenance_state').code, 'connector_handoff_invalid');
});

test('CRM authority outage is retried as a read only and does not start maintenance', async t => {
  let unavailable = true;
  const f = fixture(t, { resolve() { if (unavailable) throw Error('CRM unavailable'); return owner(row, NOW + 1000); } });
  await f.cycle(); assert.equal(f.counts().calls, 0); assert.equal(f.service.status().state, 'unavailable');
  unavailable = false; await f.cycle(); assert.equal(f.counts().calls, 1);
});

test('unknown maintenance outcome is not repeated blindly: polls inside the backoff touch nothing and the retry starts with a database read', async t => {
  const f = fixture(t, { begin() { return settle(Promise.reject(coded('maintenance_outcome_unknown'))); } });
  await f.cycle(); await f.cycle(); f.advance(29999); await f.cycle();
  assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
  assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 }));
  f.advance(1); await f.cycle(); assert.deepEqual(f.counts(), { calls: 2, reads: 2 }); // read first, then the same backend lane
});

test('definite admission busy permits a later cycle because no write was dispatched', async t => {
  let busy = true;
  const f = fixture(t, { begin(ack) { if (busy) throw Object.assign(Error('busy'), { code: 'busy' }); return settle(Promise.resolve(ack)); } });
  await f.cycle(); assert.equal(f.service.status().requiresReconnect, 0); busy = false;
  await f.cycle(); assert.equal(f.counts().calls, 2);
  assert.deepEqual(actions(f.events).map(event => [event.action, event.code ?? null]), [['renewal_not_dispatched', 'busy'], ['renewal_recovered', null]]);
});

test('shutdown waits actual maintenance drain even when the observed operation already failed', async t => {
  const drain = deferred();
  const f = fixture(t, { begin() { return settle(Promise.reject(Error('timeout')), drain.promise); } });
  await f.cycle(); let closed = false; const close = f.service.close().then(() => { closed = true; });
  await tick(); assert.equal(closed, false); drain.resolve(); await close; assert.equal(closed, true);
});

test('unknown dependency drain fails shutdown so host keeps credential and ownership resources', async t => {
  const f = fixture(t, { begin(ack) { return settle(Promise.resolve(ack), Promise.reject(Error('PRIVATE DETAILS'))); } });
  await f.cycle(); assert.deepEqual(f.service.status(), status('retained', { retained: 1 }));
  await assert.rejects(f.service.close(), { message: 'connector_maintenance_retained' });
  assert.deepEqual(actions(f.events).map(event => [event.action, event.code]), [['retained', 'drain_unknown']]);
});

// Invalid ACKs are never trusted as a schedule: the database (resolveConnection) decides.
for (const [name, change, code] of [
  ['connection mismatch', ack => ({ ...ack, connectionId: id(99) }), 'ack_connection_mismatch'],
  ['status other than renewed', ack => ({ ...ack, status: 'rejected' }), 'ack_not_renewed'],
  ['expiry not advanced', ack => ({ ...ack, expiresAt: NOW + 120000 }), 'ack_expiry_invalid'],
  ['extra field', ack => ({ ...ack, token: row.token }), 'ack_malformed'],
]) {
  for (const committed of [true, false]) {
    test(`invalid renewal ACK (${name}) is re-read from the database: ${committed ? 'committed, so only rescheduled' : 'not committed, so the same lane runs once more'}`, async t => {
      const f = fixture(t, { begin(ack) { if (committed) f.renewInDatabase(); return settle(Promise.resolve(change(ack))); } });
      await f.cycle(); await f.cycle(); assert.equal(f.counts().calls, 1);
      assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 }));
      f.advance(30000); await f.cycle();
      assert.deepEqual(f.counts(), { calls: committed ? 1 : 2, reads: 2 });
      const [first, second] = actions(f.events);
      assert.equal(first.action, 'renewal_unconfirmed'); assert.equal(first.code, code);
      if (code === 'ack_not_renewed') assert.equal(first.status, 'rejected');
      assert.equal(second.action, committed ? 'renewal_confirmed' : 'renewal_unconfirmed');
      assert.deepEqual(f.service.status(), committed ? status('ready') : status('retrying', { retrying: 1 }));
    });
  }
}

test('a transient failure renews on the first retry after 30 s and returns to the normal schedule', async t => {
  let failures = 1;
  const f = fixture(t, { begin(ack) {
    if (failures-- > 0) return settle(Promise.reject(coded('timeout')));
    f.renewInDatabase(); return settle(Promise.resolve(ack));
  } });
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
  f.advance(30000); await f.cycle(); assert.deepEqual(f.counts(), { calls: 2, reads: 2 });
  assert.deepEqual(f.service.status(), status('ready'));
  f.advance(599999); await f.cycle(); assert.equal(f.counts().calls, 2);
  f.advance(1); await f.cycle(); assert.equal(f.counts().calls, 3);
  assert.deepEqual(actions(f.events).map(({ action, code, attempt, retryInMs, expiresInMs }) => ({ action, code, attempt, retryInMs, expiresInMs })), [
    { action: 'renewal_failed', code: 'timeout', attempt: 1, retryInMs: 30000, expiresInMs: 120000 },
    { action: 'renewal_recovered', code: undefined, attempt: 2, retryInMs: undefined, expiresInMs: undefined }]);
  assert.deepEqual(states(f.events), ['retrying', 'ready']);
});

test('lost ACK: the database re-read shows the renewal committed, so it is only rescheduled and never dispatched twice', async t => {
  let first = true;
  const f = fixture(t, { begin(ack) {
    f.renewInDatabase();
    if (first) { first = false; return settle(Promise.reject(coded('maintenance_outcome_unknown'))); }
    return settle(Promise.resolve(ack));
  } });
  await f.cycle(); f.advance(30000); await f.cycle();
  assert.deepEqual(f.counts(), { calls: 1, reads: 2 }); assert.deepEqual(f.service.status(), status('ready'));
  // Scheduled from the database expiry (NOW + 900000), five minutes ahead of it.
  f.advance(569999); await f.cycle(); assert.equal(f.counts().calls, 1);
  f.advance(1); await f.cycle(); assert.equal(f.counts().calls, 2);
  assert.deepEqual(actions(f.events).map(event => [event.action, event.code ?? event.source]),
    [['renewal_failed', 'maintenance_outcome_unknown'], ['renewal_confirmed', 'database']]);
});

test('a failed database re-read during a retry keeps the backoff instead of polling every 30 s', async t => {
  let failures = 1, readFailures = 0;
  const f = fixture(t, { begin(ack) {
    if (failures-- > 0) { readFailures = 1; return settle(Promise.reject(coded('maintenance_outcome_unknown'))); }
    return settle(Promise.resolve(ack));
  }, resolve() {
    if (readFailures-- > 0) throw coded('backend_unavailable');
    return owner(row, NOW + 300000);
  } });
  await f.cycle(); f.advance(30000); await f.cycle(); // attempt 1 fails; its re-read at 30 s fails too
  assert.deepEqual(f.counts(), { calls: 1, reads: 2 });
  f.advance(30000); await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 2 }); // inside the 60 s backoff
  f.advance(30000); await f.cycle(); assert.deepEqual(f.counts(), { calls: 2, reads: 3 });
  assert.deepEqual(actions(f.events).map(({ action, code, attempt, retryInMs }) => [action, code, attempt, retryInMs]), [
    ['renewal_failed', 'maintenance_outcome_unknown', 1, 30000], ['resolve_failed', 'backend_unavailable', 2, 60000],
    ['renewal_recovered', undefined, 3, undefined]]);
  assert.deepEqual(f.service.status(), status('ready'));
});

test('retries back off 30, 60, 120 s, finish ahead of the token expiry, then the expired token is final and logged', async t => {
  const f = fixture(t, { begin() { return settle(Promise.reject(coded('maintenance_rejected'))); } });
  f.setExpiry(NOW + 300000);
  await f.cycle();
  for (let guard = 0; guard < 10 && !f.service.status().requiresReconnect; guard++) {
    f.advance(Math.max(actions(f.events).at(-1).retryInMs, 30000)); await f.cycle(); // the poll runs every 30 s
  }
  assert.deepEqual(actions(f.events).map(({ action, attempt, retryInMs, expiresInMs }) => [action, attempt, retryInMs, expiresInMs]), [
    ['renewal_failed', 1, 30000, 300000], ['renewal_failed', 2, 60000, 270000], ['renewal_failed', 3, 120000, 210000],
    ['renewal_failed', 4, 60000, 90000], ['renewal_failed', 5, 0, 30000], ['expired', undefined, undefined, undefined]]);
  assert.equal(actions(f.events).at(-1).code, 'unauthorized');
  assert.deepEqual(f.counts(), { calls: 5, reads: 6 });
  f.advance(600000); await f.cycle(); f.advance(600000); await f.cycle();
  assert.deepEqual(f.counts(), { calls: 5, reads: 6 }); // final: no further read or maintenance
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
  assert.deepEqual(states(f.events), ['retrying', 'needs_attention']);
});

test('one failing connection keeps its own backoff while every other connection is still renewed on schedule', async t => {
  const f = fleet(t, [() => settle(Promise.reject(coded('backend_unavailable'))), undefined]);
  await f.cycle(); assert.deepEqual(f.calls(), [1, 1]);
  for (let poll = 0; poll < 20; poll++) { f.advance(30000); await f.cycle(); } // ten minutes
  // First: attempts at 0, 30 and 90 s, final at its 120 s expiry. Second: renewed at 0 and 600 s.
  assert.deepEqual(f.calls(), [3, 2]);
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
  assert.deepEqual(actions(f.events).filter(event => event.connectionId === f.prefix(0)).map(event => event.action),
    ['renewal_failed', 'renewal_failed', 'renewal_failed', 'expired']);
  assert.equal(actions(f.events).filter(event => event.connectionId === f.prefix(1)).length, 0);
});

test('an uncertain drain retains only that connection: later rows and later polls are still renewed, and close() retains', async t => {
  const f = fleet(t, [ack => settle(Promise.resolve(ack), Promise.reject(Error('PRIVATE drain'))), undefined]);
  await f.cycle(); assert.deepEqual(f.calls(), [1, 1]); // the second row runs in the same cycle
  assert.deepEqual(f.service.status(), status('retained', { retained: 1 }));
  for (let poll = 0; poll < 20; poll++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(f.calls(), [1, 2]); assert.deepEqual(f.reads(), [1, 2]);
  await assert.rejects(f.service.close(), { message: 'connector_maintenance_retained' });
  assert.deepEqual(actions(f.events).map(event => [event.connectionId, event.action, event.code]), [[f.prefix(0), 'retained', 'drain_unknown']]);
  assert.deepEqual(f.events.filter(event => event.event === 'connector_maintenance_state').map(({ state, retained, halted }) => [state, retained, halted]),
    [['retained', 1, false]]);
});

test('a malformed maintenance handle still halts the whole loop: nothing it may own can be observed', async t => {
  const f = fleet(t, [ack => ({ result: Promise.resolve(ack) }), undefined]);
  await f.cycle(); assert.deepEqual(f.calls(), [1, 0]);
  assert.deepEqual(f.service.status(), status('retained', { retained: 1 }));
  f.advance(600000); await f.cycle(); assert.deepEqual(f.calls(), [1, 0]); assert.deepEqual(f.reads(), [1, 0]);
  assert.deepEqual(actions(f.events).map(event => [event.action, event.code]), [['retained', 'invalid_handle']]);
  assert.equal(f.events.find(event => event.event === 'connector_maintenance_state').halted, true);
  await assert.rejects(f.service.close(), { message: 'connector_maintenance_retained' });
});

test('maintenance log lines carry fixed fields only: no token, digest, operation ID, full connection ID or error text', async t => {
  const tokenCode = 'hc_' + 'b'.repeat(43);
  const f = fleet(t, [
    () => settle(Promise.reject(Object.assign(Error(`PRIVATE ${tokenCode}`), { code: tokenCode }))),
    ack => settle(Promise.resolve({ ...ack, status: 'PRIVATE free text' })),
    ack => settle(Promise.resolve(ack), Promise.reject(Error('PRIVATE drain'))),
    () => { throw Object.assign(Error('PRIVATE refusal'), { code: 'invalid_request' }); },
    ack => settle(Promise.resolve({ ...ack, token: ack.connectionId })),
  ]);
  await f.cycle(); f.advance(30000); await f.cycle();
  const text = JSON.stringify(f.events);
  const fingerprint = item => createHash('sha256').update(JSON.stringify([...OWNER.map(key => item[key]), item.token])).digest('hex');
  for (const item of f.rows) {
    for (const secret of [item.token, createHash('sha256').update(item.token).digest('hex'), fingerprint(item), item.operationId, item.connectionId]) {
      assert(!text.includes(secret), 'a log line leaked a secret or full identifier');
    }
  }
  assert(!text.includes('PRIVATE'));
  const allowed = new Set(['event', 'ts', 'state', 'previous', 'requiresReconnect', 'retrying', 'retained', 'halted', 'code', 'phase',
    'connectionId', 'action', 'attempt', 'retryInMs', 'expiresInMs', 'source', 'status', 'reconciled']);
  for (const event of f.events) {
    assert(Object.keys(event).every(key => allowed.has(key)), Object.keys(event).join());
    assert(['connector_maintenance_state', 'connector_maintenance_connection'].includes(event.event));
    assert([NOW, NOW + 30000].map(time => new Date(time).toISOString()).includes(event.ts));
    if (event.connectionId !== undefined) assert.match(event.connectionId, /^[0-9a-f]{8}$/);
  }
  const first = actions(f.events);
  assert.deepEqual(first.filter(event => event.attempt === 1).map(event => [event.connectionId, event.action, event.code, event.status]), [
    [f.prefix(0), 'renewal_failed', 'unknown', undefined], [f.prefix(1), 'renewal_unconfirmed', 'ack_not_renewed', 'unknown'],
    [f.prefix(3), 'renewal_not_dispatched', 'invalid_request', undefined], [f.prefix(4), 'renewal_unconfirmed', 'ack_malformed', undefined]]);
  assert.deepEqual(first.filter(event => event.action === 'retained').map(event => [event.connectionId, event.code]), [[f.prefix(2), 'drain_unknown']]);
});

test('a healthy poll writes nothing; a read outage is logged once and its recovery once', async t => {
  let down = false;
  const f = fixture(t, { resolve() { if (down) throw coded('backend_unavailable'); return owner(row, f.now() + 900000); } });
  await f.cycle(); for (let i = 0; i < 5; i++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(states(f.events), ['ready']); assert.equal(f.events.length, 1);
  f.advance(600000); down = true; await f.cycle();
  for (let i = 0; i < 4; i++) { f.advance(30000); await f.cycle(); }
  assert.equal(f.counts().reads, 6);
  down = false; f.advance(30000); await f.cycle();
  assert.deepEqual(actions(f.events).map(event => [event.action, event.code ?? null]), [['resolve_failed', 'backend_unavailable'], ['resolve_recovered', null]]);
  assert.deepEqual(states(f.events), ['ready', 'unavailable', 'ready']);
  assert.equal(f.counts().calls, 0);
});

test('a step that outlives 120 s is logged as stalled while the loop still waits for its actual drain', async t => {
  const result = deferred(), drain = deferred();
  t.after(() => { result.resolve(); drain.resolve(); }); // registered first: a failed assertion cannot leave close() waiting
  const f = fixture(t, { begin: () => settle(result.promise, drain.promise) });
  await f.cycle(); assert.equal(f.service.status().state, 'checking');
  f.alarm(); assert.equal(f.service.status().state, 'stalled');
  assert.deepEqual(actions(f.events).map(event => [event.action, event.phase]), [['stalled', 'maintenance']]);
  result.resolve(f.ack()); await tick(); assert.equal(f.service.status().state, 'stalled');
  drain.resolve(); await tick(); await f.cycle();
  assert.deepEqual(states(f.events), ['stalled', 'ready']); assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
});

test('a throwing log sink never changes maintenance; a non-function sink is refused', async t => {
  let sinkCalls = 0;
  const f = fixture(t, { log() { sinkCalls++; throw Error('sink down'); }, begin() { return settle(Promise.reject(coded('timeout'))); } });
  await f.cycle(); f.advance(30000); await f.cycle();
  assert.deepEqual(f.counts(), { calls: 2, reads: 2 }); assert(sinkCalls >= 2);
  assert.throws(() => createConnectorMaintenance({ handoff: { list() {} }, backend: { resolveConnection() {}, beginExternalConnectionMaintenance() {} }, log: 'stdout' }),
    { message: 'invalid_connector_maintenance_config' });
});

test('changed enrollment token or owner invalidates a cached due time; cache never grants authority', async t => {
  const rows = [{ ...row }], f = fixture(t, { rows });
  await f.cycle(); await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
  rows[0].token = 'hc_' + 'b'.repeat(43);
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 2 });
  rows[0].userId = id(99);
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 3 });
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
});

test('removed enrollment discards its scheduling cache before it can return', async t => {
  const rows = [{ ...row }], f = fixture(t, { rows });
  await f.cycle(); rows.length = 0; await f.cycle(); rows.push({ ...row });
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 2 });
});

test('slow renewal keeps one polling flight and publishes no next schedule until ACK and actual drain', async t => {
  const result = deferred(), drain = deferred();
  const f = fixture(t, { begin: () => settle(result.promise, drain.promise) });
  await f.cycle(); await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
  result.resolve(f.ack()); await tick(); await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
  drain.resolve(); await tick(); await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
});
