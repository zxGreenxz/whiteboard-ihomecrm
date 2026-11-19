import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createConnectorMaintenance } from './connector-maintenance.mjs';
import { MIN_REFRESH_WINDOW_MS } from './refresh-window.mjs';

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
const status = (state, changes = {}) => ({ state, requiresReconnect: 0, retrying: 0, retained: 0, staleAtStart: 0, ...changes });
const actions = events => events.filter(event => event.event === 'connector_maintenance_connection');
const lost = events => events.filter(event => event.event === 'connector_connection_lost');
const atRisk = events => events.filter(event => event.event === 'connector_renewal_at_risk');
const states = events => events.filter(event => event.event === 'connector_maintenance_state').map(event => event.state);
// The 30 s poll and the 120 s stall alarm are told apart by their delay.
function fakeTimers() {
  const pending = new Set();
  return { setTimeout(fn, ms) { const handle = { fn, ms }; pending.add(handle); return handle; }, clearTimeout(handle) { pending.delete(handle); },
    take(ms) { const handle = [...pending].find(item => item.ms === ms); pending.delete(handle); return handle?.fn; } };
}
function fixture(t, changes = {}) {
  let time = NOW, expiry = NOW + 120000, calls = 0, reads = 0, recoveries = 0;
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
    // Only a test that passes `recover` gets a backend with a recovery lane; every other test runs without one.
    ...(changes.recover ? { beginExternalConnectionRecovery(token, options) {
      recoveries++; assert.equal(token, row.token); assert(options.signal instanceof AbortSignal);
      return changes.recover();
    } } : {}),
  };
  const service = createConnectorMaintenance({ handoff: { async list() { return changes.rows ?? [row]; } }, backend,
    clock: () => time, log: changes.log ?? (record => events.push(record)), timers,
    ...(changes.renewBeforeMs ? { renewBeforeMs: changes.renewBeforeMs } : {}),
    ...(changes.healthyIds ? { healthyIds: changes.healthyIds } : {}), ...(changes.onHealthyChange ? { onHealthyChange: changes.onHealthyChange } : {}) });
  t.after(() => service.close().catch(() => {}));
  return { service, ack, events, counts: () => ({ calls, reads }), recoveries: () => recoveries, expiry: () => expiry, advance(ms) { time += ms; }, now: () => time,
    nearExpiry() { expiry = time + 120000; }, renewInDatabase() { expiry = time + 900000; }, setExpiry(value) { expiry = value; },
    alarm() { timers.take(120000)(); },
    async cycle() { const poll = timers.take(30000); if (!poll) service.start(); else poll(); await tick(); } };
}
// Several enrolled connections (distinct first and last 8 ID characters) with their own database expiry.
function fleet(t, behaviours, { expiries = [] } = {}) {
  let time = NOW;
  const timers = fakeTimers(), events = [];
  const rows = behaviours.map((_, n) => ({ connectionId: `${String(n + 1).repeat(8)}-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
    assistantId: id(2), userId: id(3), organizationId: id(4), operationId: id(200 + n), token: 'hc_' + String.fromCharCode(98 + n).repeat(43) }));
  const db = rows.map((_, n) => ({ expiry: expiries[n] ?? NOW + 120000, calls: 0, reads: 0 }));
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
    suffix: n => rows[n].connectionId.slice(-8), advance(ms) { time += ms; }, // as /settings/hermes shows "Kết nối …xxxxxxxx"
    async cycle() { const poll = timers.take(30000); if (!poll) service.start(); else poll(); await tick(); } };
}

test('external maintenance renews the same enrolled token without touching any personal runtime and skips fresh connections', async t => {
  const f = fixture(t); assert.deepEqual(f.counts(), { calls: 0, reads: 0 });
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 1 }); assert.equal(f.service.status().state, 'ready');
  for (let i = 0; i < 19; i++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(f.counts(), { calls: 1, reads: 1 });
  f.advance(30000); await f.cycle(); assert.deepEqual(f.counts(), { calls: 2, reads: 2 });
  // A connection that is renewed in time (even first seen with under 3 minutes left) raises no loss or risk record.
  assert.deepEqual(f.events.filter(event => event.event !== 'connector_maintenance_state'), []);
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
  assert.deepEqual(actions(f.events), []); // a shutdown-cancelled outcome is neither retried nor logged as a failure
});

test('unknown dependency drain fails shutdown so host keeps credential and ownership resources', async t => {
  const f = fixture(t, { begin(ack) { return settle(Promise.resolve(ack), Promise.reject(Error('PRIVATE DETAILS'))); } });
  await f.cycle(); assert.deepEqual(f.service.status(), status('retained', { retained: 1 }));
  await assert.rejects(f.service.close(), { message: 'connector_maintenance_retained' });
  assert.deepEqual(actions(f.events).map(event => [event.action, event.code]), [['retained', 'drain_unknown']]);
});

test('shutdown during a pending lookup logs no failure for it', async t => {
  const lookup = deferred();
  const f = fixture(t, { resolve: () => lookup.promise });
  await f.cycle(); const closing = f.service.close();
  lookup.reject(coded('backend_unavailable')); await closing;
  assert.deepEqual(actions(f.events), []); assert.equal(f.service.status().state, 'closed');
});

test('a retained connection stays retained after its row leaves the WAL listing, so shutdown still keeps the host resources', async t => {
  const rows = [{ ...row }];
  const f = fixture(t, { rows, begin(ack) { return settle(Promise.resolve(ack), Promise.reject(Error('PRIVATE drain'))); } });
  await f.cycle(); rows.length = 0; await f.cycle();
  assert.deepEqual(f.service.status(), status('retained', { retained: 1 }));
  await assert.rejects(f.service.close(), { message: 'connector_maintenance_retained' });
});

test('an owner whose expiry has already passed is final as expired, not blocked; it was never healthy here, so it is only counted at start', async t => {
  const f = fixture(t, { resolve: () => owner(row, NOW) });
  await f.cycle();
  assert.deepEqual(f.service.status(), status('ready', { staleAtStart: 1 }));
  assert.deepEqual(actions(f.events).map(event => [event.action, event.code]), [['expired', 'token_expired']]);
  assert.deepEqual(lost(f.events), []);
});

test('an uncertain drain that settles while close() waits is still retained, so shutdown keeps the host resources', async t => {
  const result = deferred(), drain = deferred();
  const f = fixture(t, { begin: () => settle(result.promise, drain.promise) });
  await f.cycle(); const closing = f.service.close();
  result.reject(coded('maintenance_outcome_unknown')); drain.reject(Error('PRIVATE uncertain drain'));
  await assert.rejects(closing, { message: 'connector_maintenance_retained' });
  assert.deepEqual(f.service.status(), status('retained', { retained: 1 }));
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

test('with a 10-minute renewal lead the fourth retry waits the full 240 s before the expiry cap applies', async t => {
  const f = fixture(t, { renewBeforeMs: 600000, begin() { return settle(Promise.reject(coded('maintenance_rejected'))); } });
  f.setExpiry(NOW + 600000);
  await f.cycle();
  for (let guard = 0; guard < 10 && !f.service.status().requiresReconnect; guard++) {
    f.advance(Math.max(actions(f.events).at(-1).retryInMs, 30000)); await f.cycle();
  }
  assert.deepEqual(actions(f.events).map(event => [event.action, event.retryInMs]), [['renewal_failed', 30000], ['renewal_failed', 60000],
    ['renewal_failed', 120000], ['renewal_failed', 240000], ['renewal_failed', 120000], ['renewal_failed', 0], ['expired', undefined]]);
});

test('unauthorized before the last confirmed expiry is not final: the retry keeps its backoff until that expiry passes', async t => {
  let refusing = false;
  const f = fixture(t, { begin() { refusing = true; return settle(Promise.reject(coded('maintenance_outcome_unknown'))); },
    resolve() { if (refusing) throw coded('unauthorized'); return owner(row, NOW + 300000); } });
  await f.cycle(); f.advance(30000); await f.cycle();
  assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 }));
  for (let guard = 0; guard < 10 && !f.service.status().requiresReconnect; guard++) {
    f.advance(Math.max(actions(f.events).at(-1).retryInMs, 30000)); await f.cycle();
  }
  assert.deepEqual(actions(f.events).map(({ action, code, attempt, retryInMs, deniedForMs }) => [action, code, attempt, retryInMs, deniedForMs]), [
    ['renewal_failed', 'maintenance_outcome_unknown', 1, 30000, undefined], ['resolve_failed', 'unauthorized', 2, 60000, undefined],
    ['resolve_failed', 'unauthorized', 3, 120000, undefined], ['resolve_failed', 'unauthorized', 4, 60000, undefined],
    ['resolve_failed', 'unauthorized', 5, 0, undefined], ['expired', 'unauthorized', undefined, undefined, 270000]]);
  assert.equal(f.now() - NOW, 300000); // final exactly at the confirmed expiry, never on the first refusal
  assert.deepEqual(f.counts(), { calls: 1, reads: 6 });
});

test('a token refused at every read for longer than TTL plus clock tolerance is final without a known expiry (it died before this process started)', async t => {
  const f = fixture(t); f.setExpiry(NOW - 1); // the fixture database refuses an expired token as unauthorized
  await f.cycle();
  while (f.now() - NOW < 900000) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(f.service.status(), status('unavailable')); // 15 minutes of refusals: not yet beyond TTL + 5 s
  assert.deepEqual(actions(f.events).map(event => event.action), ['resolve_failed']);
  f.advance(30000); await f.cycle();
  // Dead before this process started: counted apart, so it neither sets needs_attention nor emits a loss.
  assert.deepEqual(f.service.status(), status('ready', { staleAtStart: 1 }));
  assert.deepEqual(lost(f.events), []);
  assert.deepEqual(actions(f.events).map(({ connectionId, action, code, deniedForMs }) => [connectionId, action, code, deniedForMs]),
    [[row.connectionId.slice(-8), 'resolve_failed', 'unauthorized', undefined], [row.connectionId.slice(-8), 'expired', 'unauthorized', 930000]]);
  assert.deepEqual(f.counts(), { calls: 0, reads: 32 });
  f.advance(600000); await f.cycle(); f.advance(600000); await f.cycle();
  assert.deepEqual(f.counts(), { calls: 0, reads: 32 }); // final: the database is not polled again
});

test('any other answer restarts the refusal clock: an outage read between refusals delays finality', async t => {
  const f = fixture(t, { resolve() { throw coded(f.now() - NOW === 450000 ? 'backend_unavailable' : 'unauthorized'); } });
  await f.cycle();
  while (f.now() - NOW < 1380000) { f.advance(30000); await f.cycle(); } // 900 s after the refusals resumed at 480 s
  assert.equal(f.service.status().requiresReconnect, 0);
  f.advance(30000); await f.cycle();
  assert.deepEqual(f.service.status(), status('ready', { staleAtStart: 1 })); // refused from the first read: never healthy here
  assert.equal(actions(f.events).at(-1).deniedForMs, 930000);
  assert.deepEqual(lost(f.events), []);
});

test('a lookup served between refusals restarts the clock; its confirmed expiry then decides finality', async t => {
  // Refused until 600 s, served once at 630 s (expiry at 1530 s, next due at 1230 s), refused again from 1230 s.
  const f = fixture(t, { resolve() { if (f.now() - NOW === 630000) return owner(row, NOW + 1530000); throw coded('unauthorized'); } });
  await f.cycle();
  while (f.now() - NOW < 1500000) { f.advance(30000); await f.cycle(); }
  assert.equal(f.service.status().requiresReconnect, 0); // 1500 s of history, but only 270 s of refusals since it was served
  f.advance(30000); await f.cycle();
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
  assert.deepEqual(actions(f.events).map(event => event.action), ['resolve_failed', 'resolve_recovered', 'resolve_failed', 'expired']);
  assert.equal(actions(f.events).at(-1).deniedForMs, 300000);
  assert.deepEqual(lost(f.events).map(event => event.connectionId), [row.connectionId.slice(-8)]); // it was served at 630 s: a real loss
});

test('one failing connection keeps its own backoff while every other connection is still renewed on schedule', async t => {
  const f = fleet(t, [() => settle(Promise.reject(coded('backend_unavailable'))), undefined]);
  await f.cycle(); assert.deepEqual(f.calls(), [1, 1]);
  for (let poll = 0; poll < 20; poll++) { f.advance(30000); await f.cycle(); } // ten minutes
  // First: attempts at 0, 30 and 90 s, final at its 120 s expiry. Second: renewed at 0 and 600 s.
  assert.deepEqual(f.calls(), [3, 2]);
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
  assert.deepEqual(actions(f.events).filter(event => event.connectionId === f.suffix(0)).map(event => event.action),
    ['renewal_failed', 'renewal_failed', 'renewal_failed', 'expired']);
  assert.equal(actions(f.events).filter(event => event.connectionId === f.suffix(1)).length, 0);
});

test('an uncertain drain retains only that connection: later rows and later polls are still renewed, and close() retains', async t => {
  const f = fleet(t, [ack => settle(Promise.resolve(ack), Promise.reject(Error('PRIVATE drain'))), undefined]);
  await f.cycle(); assert.deepEqual(f.calls(), [1, 1]); // the second row runs in the same cycle
  assert.deepEqual(f.service.status(), status('retained', { retained: 1 }));
  for (let poll = 0; poll < 20; poll++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(f.calls(), [1, 2]); assert.deepEqual(f.reads(), [1, 2]);
  await assert.rejects(f.service.close(), { message: 'connector_maintenance_retained' });
  assert.deepEqual(actions(f.events).map(event => [event.connectionId, event.action, event.code]), [[f.suffix(0), 'retained', 'drain_unknown']]);
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
    () => settle(Promise.reject(Object.assign(Error('PRIVATE'), { code: 'hc_' + 'z'.repeat(10) }))), // short, token-like code
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
  const allowed = new Set(['event', 'ts', 'state', 'previous', 'requiresReconnect', 'retrying', 'retained', 'staleAtStart', 'halted', 'code', 'phase',
    'connectionId', 'action', 'attempt', 'retryInMs', 'expiresInMs', 'deniedForMs', 'source', 'status', 'reconciled']);
  for (const event of f.events) {
    assert(Object.keys(event).every(key => allowed.has(key)), Object.keys(event).join());
    assert(['connector_maintenance_state', 'connector_maintenance_connection', 'connector_renewal_at_risk', 'connector_connection_lost'].includes(event.event));
    assert([NOW, NOW + 30000].map(time => new Date(time).toISOString()).includes(event.ts));
    if (event.connectionId !== undefined) {
      assert.match(event.connectionId, /^[0-9a-f]{8}$/);
      assert(f.rows.some(item => item.connectionId.slice(-8) === event.connectionId), 'connectionId is the last 8 characters shown in the UI');
    }
  }
  const first = actions(f.events);
  assert.deepEqual(first.filter(event => event.attempt === 1).map(event => [event.connectionId, event.action, event.code, event.status]), [
    [f.suffix(0), 'renewal_failed', 'unknown', undefined], [f.suffix(1), 'renewal_unconfirmed', 'ack_not_renewed', 'unknown'],
    [f.suffix(3), 'renewal_not_dispatched', 'invalid_request', undefined], [f.suffix(4), 'renewal_unconfirmed', 'ack_malformed', undefined],
    [f.suffix(5), 'renewal_failed', 'unknown', undefined]]);
  assert.deepEqual(first.filter(event => event.action === 'retained').map(event => [event.connectionId, event.code]), [[f.suffix(2), 'drain_unknown']]);
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

test('renewBeforeMs accepts the 10-minute maximum used by the host and refuses anything above it', () => {
  const parts = { handoff: { list() {} }, backend: { resolveConnection() {}, beginExternalConnectionMaintenance() {} } };
  assert.doesNotThrow(() => createConnectorMaintenance({ ...parts, renewBeforeMs: 600000 }));
  assert.throws(() => createConnectorMaintenance({ ...parts, renewBeforeMs: 600001 }), { message: 'invalid_connector_maintenance_config' });
});

test('renewal starts exactly when 10 minutes are left with the host lead, and not a poll earlier', async t => {
  const f = fixture(t, { renewBeforeMs: 600000 });
  f.setExpiry(NOW + 630000);
  await f.cycle(); assert.deepEqual(f.counts(), { calls: 0, reads: 1 });
  f.advance(29999); await f.cycle(); assert.deepEqual(f.counts(), { calls: 0, reads: 1 }); // cached due time, 600001 ms left
  f.advance(1); await f.cycle(); assert.deepEqual(f.counts(), { calls: 1, reads: 2 });
});

// 31/10: the network was down for a stretch longer than the old 5-minute window. Same outage, two leads.
for (const [lead, survives] of [[600000, true], [300000, false]]) {
  test(`a ${lead / 60000}-minute renewal lead ${survives ? 'survives' : 'loses the connection to'} an outage that ends 330 s after the renewal window opens`, async t => {
    const f = fixture(t, { renewBeforeMs: lead, begin(ack) {
      if (f.now() < NOW + 330000) return settle(Promise.reject(coded('backend_unavailable')));
      f.renewInDatabase(); return settle(Promise.resolve({ ...ack, expiresAt: f.now() + 900000 }));
    } });
    f.setExpiry(NOW + lead);
    await f.cycle();
    for (let guard = 0; guard < 40 && f.now() - NOW < lead; guard++) { f.advance(30000); await f.cycle(); }
    if (survives) {
      assert.deepEqual(f.service.status(), status('ready'));
      assert.deepEqual(lost(f.events), []);
      assert.equal(actions(f.events).at(-1).action, 'renewal_recovered');
    } else {
      assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
      assert.equal(lost(f.events).length, 1);
    }
  });
}

test('a connection healthy in this process that expires emits connector_connection_lost once, with only the 8-character ID and a code', async t => {
  const f = fixture(t, { begin() { return settle(Promise.reject(coded('maintenance_rejected'))); } });
  f.setExpiry(NOW + 300000);
  await f.cycle();
  for (let guard = 0; guard < 20 && !f.service.status().requiresReconnect; guard++) { f.advance(30000); await f.cycle(); }
  assert.equal(lost(f.events).length, 1);
  const [event] = lost(f.events);
  assert.deepEqual(Object.keys(event).sort(), ['code', 'connectionId', 'event', 'ts']);
  assert.equal(event.connectionId, row.connectionId.slice(-8)); assert.equal(event.code, 'unauthorized');
  assert.equal(event.ts, new Date(f.now()).toISOString());
  assert.doesNotMatch(JSON.stringify(event), /hc_|PRIVATE|[0-9a-f]{8}-[0-9a-f]{4}/);
  f.advance(600000); await f.cycle(); f.advance(600000); await f.cycle();
  assert.equal(lost(f.events).length, 1); // final: never repeated
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
});

test('mutation: a WAL row already dead when the process starts never emits connector_connection_lost, however it ends', async t => {
  // Refused from the first read (token_expired and unauthorized finality are the two ways it can end).
  const refused = fixture(t); refused.setExpiry(NOW - 1);
  await refused.cycle();
  for (let guard = 0; guard < 40 && refused.service.status().staleAtStart === 0; guard++) { refused.advance(30000); await refused.cycle(); }
  assert.deepEqual(refused.service.status(), status('ready', { staleAtStart: 1 }));
  assert.deepEqual(actions(refused.events).map(event => event.action).at(-1), 'expired');
  const served = fixture(t, { resolve: () => owner(row, NOW) }); await served.cycle();
  assert.deepEqual(served.service.status(), status('ready', { staleAtStart: 1 }));
  assert.deepEqual(actions(served.events).map(event => event.action), ['expired']);
  for (const f of [refused, served]) { assert.deepEqual(lost(f.events), []); assert.deepEqual(atRisk(f.events), []); }
  // Next to a genuinely lost connection, the dead row stays counted apart and is not itself reported as a loss.
  const f = fleet(t, [undefined, () => settle(Promise.reject(coded('backend_unavailable')))], { expiries: [NOW - 1, NOW + 120000] });
  await f.cycle();
  for (let guard = 0; guard < 40; guard++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(lost(f.events).map(event => event.connectionId), [f.suffix(1)]);
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1, staleAtStart: 1 }));
});

test('a new loss is reported even when needs_attention already stands, so the overall state line cannot hide it', async t => {
  const reject = () => settle(Promise.reject(coded('backend_unavailable')));
  const f = fleet(t, [reject, reject], { expiries: [NOW + 120000, NOW + 420000] });
  await f.cycle();
  for (let guard = 0; guard < 20; guard++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(lost(f.events).map(event => [event.connectionId, event.ts]),
    [[f.suffix(0), new Date(NOW + 120000).toISOString()], [f.suffix(1), new Date(NOW + 420000).toISOString()]]);
  assert.deepEqual(states(f.events), ['retrying', 'needs_attention']); // no state line for the second loss
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 2 }));
});

test('a connection that renewed and is then revoked or lost ends as requiresReconnect', async t => {
  const f = fixture(t); await f.cycle(); // renewed once: healthy
  f.setExpiry(f.now() - 1); // revoked / expired in the database
  for (let guard = 0; guard < 80 && !f.service.status().requiresReconnect; guard++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 }));
  assert.equal(lost(f.events).length, 1);
});

test('renewal_at_risk: reported once per connection and expiry when under 3 minutes remain unrenewed, again for a later expiry', async t => {
  let outage = true;
  const f = fixture(t, { begin(ack) {
    if (outage) return settle(Promise.reject(coded('timeout')));
    f.renewInDatabase(); return settle(Promise.resolve({ ...ack, expiresAt: f.now() + 900000 }));
  } });
  f.setExpiry(NOW + 300000);
  await f.cycle();
  for (let i = 0; i < 8; i++) { f.advance(30000); await f.cycle(); } // to 240 s
  assert.equal(atRisk(f.events).length, 1);
  const [first] = atRisk(f.events);
  assert.deepEqual(Object.keys(first).sort(), ['attempt', 'code', 'connectionId', 'event', 'expiresInMs', 'ts']);
  assert.equal(first.connectionId, row.connectionId.slice(-8)); assert.equal(first.code, 'timeout');
  assert(first.expiresInMs > 0 && first.expiresInMs < 180000);
  assert.equal(first.ts, new Date(NOW + 150000).toISOString()); // the first 30 s poll with under 180 s left
  outage = false; f.advance(30000); await f.cycle(); // the retry is capped 30 s before the expiry
  assert.equal(actions(f.events).at(-1).action, 'renewal_recovered');
  assert.equal(atRisk(f.events).length, 1);
  assert.deepEqual(f.service.status(), status('ready')); assert.deepEqual(lost(f.events), []);
  // A new expiry that is again unrenewed under 3 minutes is a new report.
  outage = true;
  for (let guard = 0; guard < 60 && atRisk(f.events).length < 2; guard++) { f.advance(30000); await f.cycle(); }
  assert.equal(atRisk(f.events).length, 2);
  for (let i = 0; i < 4; i++) { f.advance(30000); await f.cycle(); }
  assert.equal(atRisk(f.events).length, 2);
});

test('renewal_at_risk covers failing database reads and a busy admission, and is silent once the expiry has passed', async t => {
  let down = false;
  const f = fixture(t, { resolve() { if (down) throw coded('backend_unavailable'); return owner(row, NOW + 600000); } });
  await f.cycle(); // served: expiry NOW + 600 s, renewal not yet due
  down = true;
  for (let i = 0; i < 30; i++) { f.advance(30000); await f.cycle(); } // reads fail until well after the confirmed expiry
  assert.deepEqual(atRisk(f.events).map(event => [event.code, event.attempt]), [['backend_unavailable', undefined]]);
  assert.equal(atRisk(f.events)[0].ts, new Date(NOW + 450000).toISOString()); // 150 s left
  assert.deepEqual(lost(f.events), []); // refusals are not unauthorized: no final answer, so no loss claim
  const busy = fixture(t, { begin() { throw Object.assign(Error('busy'), { code: 'busy' }); } });
  busy.setExpiry(NOW + 300000); await busy.cycle();
  for (let i = 0; i < 6; i++) { busy.advance(30000); await busy.cycle(); }
  assert.deepEqual(atRisk(busy.events).map(event => event.code), ['busy']);
});

test('renewal_at_risk is silent for an expiry that already passed before the loop looked again (clock jump or long stall)', async t => {
  let down = false;
  const f = fixture(t, { resolve() { if (down) throw coded('backend_unavailable'); return owner(row, NOW + 600000); } });
  await f.cycle(); down = true;
  f.advance(700000); await f.cycle(); // 100 s past the expiry in one step: never "under 3 minutes left"
  assert.deepEqual(atRisk(f.events), []); assert.deepEqual(lost(f.events), []);
});

test('renewal_at_risk never carries the code of an earlier, recovered failure', async t => {
  let failures = 1;
  const f = fixture(t, { begin(ack) {
    if (failures-- > 0) return settle(Promise.reject(coded('timeout')));
    f.renewInDatabase(); return settle(Promise.resolve({ ...ack, expiresAt: f.now() + 900000 }));
  } });
  f.setExpiry(NOW + 300000);
  await f.cycle(); f.advance(30000); await f.cycle(); // fails once with 'timeout', then renews
  assert.equal(actions(f.events).at(-1).action, 'renewal_recovered'); assert.deepEqual(atRisk(f.events), []);
  f.advance(750000); await f.cycle(); // the loop was away: 150 s left when it looks again, no failure behind it
  assert.equal(atRisk(f.events).length, 1);
  assert.equal('code' in atRisk(f.events)[0], false); assert.equal('attempt' in atRisk(f.events)[0], false);
});

test('a restart longer than the token life: a connection the previous process saw healthy is reported lost, any other is only counted at start', async t => {
  const carried = fixture(t, { healthyIds: [row.operationId] }); carried.setExpiry(NOW - 1); // the database refuses the dead token
  await carried.cycle();
  for (let guard = 0; guard < 40 && !carried.service.status().requiresReconnect; guard++) { carried.advance(30000); await carried.cycle(); }
  assert.deepEqual(carried.service.status(), status('needs_attention', { requiresReconnect: 1 }));
  assert.deepEqual(lost(carried.events).map(event => [event.connectionId, event.code]), [[row.connectionId.slice(-8), 'unauthorized']]);
  // Mutation: carrying every ID, or the wrong one, must not turn a dead row into a loss.
  const other = fixture(t, { healthyIds: [id(99)] }); other.setExpiry(NOW - 1);
  await other.cycle();
  for (let guard = 0; guard < 40 && !other.service.status().staleAtStart; guard++) { other.advance(30000); await other.cycle(); }
  assert.deepEqual(other.service.status(), status('ready', { staleAtStart: 1 })); assert.deepEqual(lost(other.events), []);
});

test('healthy IDs are reported on change only: the operation IDs that are healthy now, never a token, and a failing sink changes nothing', async t => {
  const saved = [];
  const rows = [{ ...row }];
  const f = fixture(t, { rows, healthyIds: [id(99)], onHealthyChange(ids) { saved.push([...ids]); if (saved.length === 1) throw Error('PRIVATE sink'); return Promise.reject(Error('PRIVATE async sink')); } });
  await f.cycle(); await f.cycle(); f.advance(30000); await f.cycle();
  assert.deepEqual(saved, [[row.operationId]]); // the carried ID that is not in the WAL is dropped; unchanged polls write nothing
  assert.equal(f.service.status().state, 'ready'); assert(!JSON.stringify(saved).includes(row.token));
  rows.length = 0; await f.cycle();
  assert.deepEqual(saved, [[row.operationId], []]); // it left the WAL
  rows.push({ ...row }); await f.cycle();
  assert.deepEqual(saved.at(-1), [row.operationId]); // back in the WAL and served again: healthy again, as a new enrollment
});

test('a lost connection is removed from the healthy IDs so the next restart does not report it again', async t => {
  const saved = [];
  const f = fixture(t, { onHealthyChange: ids => { saved.push([...ids]); }, begin() { return settle(Promise.reject(coded('maintenance_rejected'))); } });
  f.setExpiry(NOW + 300000); await f.cycle();
  for (let guard = 0; guard < 20 && !f.service.status().requiresReconnect; guard++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(saved, [[row.operationId], []]); assert.equal(lost(f.events).length, 1);
});

test('mutation: a dead WAL row never enters the healthy IDs, so after a restart it is still not reported as lost', async t => {
  const saved = [];
  const dead = fixture(t, { onHealthyChange: ids => { saved.push([...ids]); } }); dead.setExpiry(NOW - 1); // refused for its whole 930 s
  await dead.cycle();
  for (let guard = 0; guard < 40 && !dead.service.status().staleAtStart; guard++) { dead.advance(30000); await dead.cycle(); }
  assert.deepEqual(dead.service.status(), status('ready', { staleAtStart: 1 }));
  assert.deepEqual(saved, []); // never written: the set stayed empty from start to finish
  const restarted = fixture(t, { healthyIds: saved.at(-1) ?? [] }); restarted.setExpiry(NOW - 1);
  await restarted.cycle();
  for (let guard = 0; guard < 40 && !restarted.service.status().staleAtStart; guard++) { restarted.advance(30000); await restarted.cycle(); }
  assert.deepEqual(restarted.service.status(), status('ready', { staleAtStart: 1 })); assert.deepEqual(lost(restarted.events), []);
});

test('a carried connection that is lost in this process is reported once and dropped from the healthy IDs, so the next restart is quiet', async t => {
  const saved = [];
  const f = fixture(t, { healthyIds: [row.operationId], onHealthyChange: ids => { saved.push([...ids]); }, begin() { return settle(Promise.reject(coded('maintenance_rejected'))); } });
  f.setExpiry(NOW + 300000); await f.cycle();
  for (let guard = 0; guard < 20 && !f.service.status().requiresReconnect; guard++) { f.advance(30000); await f.cycle(); }
  assert.equal(lost(f.events).length, 1);
  assert.deepEqual(saved, [[]]); // the carried ID was consumed by its item and left the set when the item stopped
  const restarted = fixture(t, { healthyIds: saved.at(-1) }); restarted.setExpiry(NOW - 1);
  await restarted.cycle();
  for (let guard = 0; guard < 40 && !restarted.service.status().staleAtStart; guard++) { restarted.advance(30000); await restarted.cycle(); }
  assert.deepEqual(lost(restarted.events), []); assert.deepEqual(restarted.service.status(), status('ready', { staleAtStart: 1 }));
});

test('a healthy connection that becomes retained stays in the healthy IDs, so it is still reported lost if its token dies while the host is down', async t => {
  const saved = [];
  const f = fixture(t, { onHealthyChange: ids => { saved.push([...ids]); }, begin(ack) { return settle(Promise.resolve(ack), Promise.reject(Error('PRIVATE drain'))); } });
  await f.cycle(); await f.cycle();
  assert.deepEqual(f.service.status(), status('retained', { retained: 1 }));
  assert.deepEqual(saved.at(-1), [row.operationId]);
  const restarted = fixture(t, { healthyIds: saved.at(-1) }); restarted.setExpiry(NOW - 1); // the token died during the stop
  await restarted.cycle();
  for (let guard = 0; guard < 40 && !restarted.service.status().requiresReconnect; guard++) { restarted.advance(30000); await restarted.cycle(); }
  assert.deepEqual(lost(restarted.events).map(event => event.connectionId), [row.connectionId.slice(-8)]);
  await assert.rejects(f.service.close(), { message: 'connector_maintenance_retained' });
});

test('healthyIds and onHealthyChange are validated at construction', () => {
  const parts = { handoff: { list() {} }, backend: { resolveConnection() {}, beginExternalConnectionMaintenance() {} } };
  for (const bad of [{ healthyIds: 'x' }, { healthyIds: ['hc_' + 'a'.repeat(43)] }, { healthyIds: ['nope'] }, { healthyIds: Array.from({ length: 65 }, (_, n) => id(n + 1)) }, { onHealthyChange: 'x' }]) {
    assert.throws(() => createConnectorMaintenance({ ...parts, ...bad }), { message: 'invalid_connector_maintenance_config' });
  }
  assert.doesNotThrow(() => createConnectorMaintenance({ ...parts, healthyIds: [id(1)], onHealthyChange() {} }));
});

// A model of the two clocks the loop meets: the token lease (15 min, renewed to LEAST(now + 15 min, session expiry), refused when the
// target is not past the current token expiry: SQL hermes_store_renew_connection_v1) and the provider session (1 h, refreshed inside the
// maintenance step when it has refreshBefore or less left: connection-maintenance.mjs). The host passes the same lead to both.
function lease(t, { lead, refreshBefore, down = () => false, healthyIds, onHealthyChange, recovery = false }) {
  const MIN = 60000;
  let time = NOW, sessionExpiry = NOW + 60 * MIN, tokenExpiry = NOW + 15 * MIN;
  const counts = { refreshed: 0, refused: 0, renewed: 0, recovered: 0, guarded: 0, shortLeaseRefreshes: 0 }, timers = fakeTimers(), events = [];
  const backend = {
    async resolveConnection() {
      if (down(time)) throw coded('backend_unavailable');
      if (tokenExpiry <= time || sessionExpiry <= time) throw coded('unauthorized');
      return owner(row, tokenExpiry);
    },
    beginExternalConnectionMaintenance() {
      const work = (async () => {
        if (down(time) || sessionExpiry <= time || tokenExpiry <= time) throw coded('maintenance_rejected');
        // The system with a recovery lane also has the lease guard of connection-maintenance.mjs (refresh-window.mjs): a due
        // refresh is not started with less than the minimum lease left. The models without the lane keep the earlier behaviour.
        if (sessionExpiry - time <= refreshBefore && tokenExpiry - time < MIN_REFRESH_WINDOW_MS) {
          if (recovery) { counts.guarded++; throw coded('maintenance_rejected'); }
          counts.shortLeaseRefreshes++;
        }
        if (sessionExpiry - time <= refreshBefore) { sessionExpiry = time + 60 * MIN; counts.refreshed++; }
        const target = Math.min(time + 15 * MIN, sessionExpiry);
        if (target <= tokenExpiry) { counts.refused++; throw coded('maintenance_outcome_unknown'); }
        tokenExpiry = target; counts.renewed++;
        return { ok: true, status: 'renewed', connectionId: row.connectionId, expiresAt: target, reconciled: false };
      })();
      void work.catch(() => {}); return settle(work);
    },
    // The recovery lane as SQL and connection-recovery.mjs behave: a lapsed lease gets a 5-minute window, and a
    // session that is expired or inside the refresh lead is refreshed under it. Absent unless the test asks for it.
    ...(recovery ? { beginExternalConnectionRecovery() {
      const work = (async () => {
        if (down(time)) throw coded('recovery_provider_unreachable');
        const status = tokenExpiry <= time ? 'recovered' : 'live'; let refreshed = false;
        if (status === 'recovered') { tokenExpiry = time + 5 * MIN; counts.recovered++; }
        if (sessionExpiry - time <= refreshBefore) {
          if (tokenExpiry - time < MIN_REFRESH_WINDOW_MS) throw coded('recovery_window_short');
          sessionExpiry = time + 60 * MIN; counts.refreshed++; refreshed = true;
        }
        return { ok: true, status, connectionId: row.connectionId, refreshed };
      })();
      void work.catch(() => {}); return settle(work);
    } } : {}),
  };
  const service = createConnectorMaintenance({ handoff: { async list() { return [row]; } }, backend, clock: () => time, timers, renewBeforeMs: lead,
    log: record => events.push(record), ...(healthyIds ? { healthyIds } : {}), ...(onHealthyChange ? { onHealthyChange } : {}) });
  t.after(() => service.close().catch(() => {}));
  return { service, events, counts, async cycle() { const poll = timers.take(30000); if (!poll) service.start(); else poll(); await tick(); },
    advance(ms) { time += ms; }, now: () => time };
}
async function runLease(t, options, minutes) {
  const f = lease(t, options); await f.cycle();
  for (let i = 0; i < minutes * 2 && !f.service.status().requiresReconnect; i++) { f.advance(30000); await f.cycle(); }
  return f;
}

test('with matching 10-minute leads a healthy network shows no failed renewal and no risk report across six session cycles', async t => {
  const f = await runLease(t, { lead: 600000, refreshBefore: 600000 }, 360);
  assert.deepEqual(f.counts.refused, 0); assert(f.counts.refreshed >= 5);
  assert.deepEqual(actions(f.events).filter(event => event.action !== 'renewal_recovered'), []);
  assert.deepEqual(atRisk(f.events), []); assert.deepEqual(lost(f.events), []);
  assert.deepEqual(f.service.status(), status('ready'));
});

test('mutation: a 10-minute renewal lead with the old 5-minute session lead is refused by SQL every session cycle', async t => {
  const f = await runLease(t, { lead: 600000, refreshBefore: 300000 }, 360);
  assert(f.counts.refused >= 5, `refused ${f.counts.refused}`); // about once per session cycle, each with retries and a false risk report
  assert(actions(f.events).some(event => event.action === 'renewal_failed')); assert(atRisk(f.events).length >= 1);
});

// Outage that begins at every minute of one session cycle and lasts `minutes`: how many starts end with the connection lost.
async function deadStarts(t, lead, refreshBefore, minutes) {
  let dead = 0;
  for (let start = 25; start < 85; start++) {
    const from = NOW + start * 60000, f = await runLease(t, { lead, refreshBefore, down: time => time >= from && time < from + minutes * 60000 }, 130);
    if (f.service.status().requiresReconnect) dead++;
  }
  return dead;
}

test('outage sweep: matching 10-minute leads survive what the 5-minute schedule loses, and the mismatch is worse than the old schedule', async t => {
  // [old schedule 5/5, PR as first pushed 10/5, matching 10/10] = starts, out of 60, that end with the connection lost.
  const dead = {};
  for (const minutes of [4, 5, 8]) dead[minutes] = [await deadStarts(t, 300000, 300000, minutes), await deadStarts(t, 600000, 300000, minutes), await deadStarts(t, 600000, 600000, minutes)];
  for (const minutes of [4, 5, 8]) assert.equal(dead[minutes][2], 0, `matching leads lost the connection to a ${minutes}-minute outage`);
  assert(dead[5][0] > 0 && dead[8][0] > 0, 'the old 5-minute schedule loses 5- and 8-minute outages');
  assert(dead[4][1] > dead[4][0], 'a 10-minute renewal lead with a 5-minute session lead is worse than the old schedule for a 4-minute outage');
});

// ---- Recovery lane (backend.beginExternalConnectionRecovery). Every test above runs without it. ----
const recovered = (status = 'recovered', refreshed = false) => ({ ok: true, status, connectionId: row.connectionId, refreshed });
const unavailable = () => ({ ok: true, status: 'unavailable', refreshed: false });
const revivals = events => events.filter(event => event.event === 'connector_connection_recovered');
const brief = events => actions(events).map(event => [event.action, event.code ?? event.status]);
const suffix = row.connectionId.slice(-8);

test('recovery lane: a healthy connection whose lease lapsed during a three-hour outage is recovered, not expired, and the normal lane renews it at the next poll', async t => {
  let down = false; const saved = [];
  const f = fixture(t, { onHealthyChange: ids => { saved.push([...ids]); },
    resolve() { if (down) throw coded('backend_unavailable'); if (f.expiry() <= f.now()) throw coded('unauthorized'); return owner(row, f.expiry()); },
    begin(ack) { if (down) return settle(Promise.reject(coded('backend_unavailable'))); f.renewInDatabase(); return settle(Promise.resolve(ack)); },
    recover() { f.setExpiry(f.now() + 300000); return settle(Promise.resolve(recovered('recovered', true))); } });
  await f.cycle(); assert.deepEqual(f.service.status(), status('ready')); // renewed once: healthy
  down = true;
  for (let i = 0; i < 360; i++) { f.advance(30000); await f.cycle(); }
  assert.equal(f.recoveries(), 0); assert.equal(f.service.status().requiresReconnect, 0); // the outage itself decides nothing
  down = false; f.advance(30000); await f.cycle(); // the database answers again: the lease is long gone
  assert.equal(f.recoveries(), 1); assert.deepEqual(f.service.status(), status('ready'));
  assert.deepEqual(revivals(f.events), [{ event: 'connector_connection_recovered', ts: new Date(f.now()).toISOString(), connectionId: suffix, status: 'recovered', refreshed: true }]);
  assert.deepEqual(brief(f.events), [['resolve_failed', 'backend_unavailable'], ['recovered', 'recovered']]);
  const before = f.counts();
  await f.cycle(); // due at once: the very next poll reads it and the normal lane extends the 5-minute window
  assert.deepEqual(f.counts(), { calls: before.calls + 1, reads: before.reads + 1 }); assert.equal(f.expiry(), f.now() + 900000);
  assert.deepEqual(f.service.status(), status('ready')); assert.deepEqual(lost(f.events), []); assert.equal(f.recoveries(), 1);
  assert.deepEqual(saved.at(-1), [row.operationId]); // still healthy for the next restart
  f.advance(599999); await f.cycle(); assert.equal(f.counts().calls, before.calls + 1); // back on the normal schedule
  f.advance(1); await f.cycle(); assert.equal(f.counts().calls, before.calls + 2);
  assert.deepEqual(states(f.events), ['ready', 'unavailable', 'ready']);
});

test('mutation: the same three-hour outage without a recovery lane still ends as expired and lost', async t => {
  let down = false;
  const f = fixture(t, { resolve() { if (down) throw coded('backend_unavailable'); if (f.expiry() <= f.now()) throw coded('unauthorized'); return owner(row, f.expiry()); } });
  await f.cycle(); down = true;
  for (let i = 0; i < 360; i++) { f.advance(30000); await f.cycle(); }
  down = false; f.advance(30000); await f.cycle();
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 })); assert.equal(lost(f.events).length, 1);
  assert.deepEqual(revivals(f.events), []);
});

test('recovery lane: a token that died while the process was down is recovered at its first refusal instead of waiting TTL plus tolerance', async t => {
  const saved = [];
  const f = fixture(t, { onHealthyChange: ids => { saved.push([...ids]); }, recover() { f.setExpiry(f.now() + 300000); return settle(Promise.resolve(recovered())); } });
  f.setExpiry(NOW - 3600000);
  await f.cycle();
  assert.deepEqual([f.counts().reads, f.recoveries(), f.counts().calls], [1, 1, 0]);
  assert.deepEqual(f.service.status(), status('ready')); // neither stale nor retrying
  assert.deepEqual(revivals(f.events).map(({ connectionId, status: answer, refreshed }) => [connectionId, answer, refreshed]), [[suffix, 'recovered', false]]);
  assert.deepEqual(saved, []); // not healthy before the database serves it
  await f.cycle(); // same instant: read, then renewed by the normal lane
  assert.deepEqual([f.counts().reads, f.recoveries(), f.counts().calls], [2, 1, 1]); assert.equal(f.now(), NOW);
  assert.deepEqual(f.service.status(), status('ready')); assert.deepEqual(saved, [[row.operationId]]);
  assert.deepEqual(brief(f.events), [['recovered', 'recovered']]); assert.deepEqual(lost(f.events), []);
});

test('recovery lane: live with a refreshed session counts as recovered too (the lease was fine, the session was not)', async t => {
  let sessionDead = true;
  const f = fixture(t, { resolve() { if (sessionDead) throw coded('unauthorized'); return owner(row, f.expiry()); },
    recover() { sessionDead = false; return settle(Promise.resolve(recovered('live', true))); } });
  f.setExpiry(NOW + 600000);
  await f.cycle(); await f.cycle();
  assert.deepEqual(revivals(f.events).map(({ status: answer, refreshed }) => [answer, refreshed]), [['live', true]]);
  assert.deepEqual(brief(f.events), [['recovered', 'live']]); assert.deepEqual(f.service.status(), status('ready'));
  assert.deepEqual([f.counts().reads, f.recoveries()], [2, 1]);
});

test('recovery lane: unavailable is the only final answer and ends exactly as before (lost when it was healthy, stale when it never was)', async t => {
  // Healthy here, then revoked in the database: asked only where the stop rule would stop, i.e. at the confirmed expiry.
  const healthy = fixture(t, { recover: () => settle(Promise.resolve(unavailable())) });
  await healthy.cycle(); healthy.setExpiry(healthy.now() - 1);
  for (let guard = 0; guard < 40 && !healthy.service.status().requiresReconnect; guard++) { healthy.advance(30000); await healthy.cycle(); }
  assert.equal(healthy.now() - NOW, 900000); assert.equal(healthy.recoveries(), 1);
  assert.deepEqual(healthy.service.status(), status('needs_attention', { requiresReconnect: 1 }));
  assert.deepEqual(brief(healthy.events), [['resolve_failed', 'unauthorized'], ['expired', 'unauthorized']]);
  assert.equal(actions(healthy.events).at(-1).deniedForMs, 300000);
  assert.deepEqual(lost(healthy.events).map(event => [event.connectionId, event.code]), [[suffix, 'unauthorized']]);
  const reads = healthy.counts().reads;
  healthy.advance(600000); await healthy.cycle(); healthy.advance(600000); await healthy.cycle();
  assert.deepEqual([healthy.counts().reads, healthy.recoveries()], [reads, 1]); // final: neither read nor asked again
  // Dead at startup and beyond recovery: settled at the first poll, counted apart, no loss.
  const stale = fixture(t, { recover: () => settle(Promise.resolve(unavailable())) }); stale.setExpiry(NOW - 1);
  await stale.cycle();
  assert.deepEqual(stale.service.status(), status('ready', { staleAtStart: 1 })); assert.deepEqual(lost(stale.events), []);
  assert.deepEqual(actions(stale.events).map(({ action, code, deniedForMs }) => [action, code, deniedForMs]), [['expired', 'unauthorized', 0]]);
  // The previous process saw it healthy: a real loss, reported once.
  const carried = fixture(t, { healthyIds: [row.operationId], recover: () => settle(Promise.resolve(unavailable())) }); carried.setExpiry(NOW - 1);
  await carried.cycle();
  assert.deepEqual(carried.service.status(), status('needs_attention', { requiresReconnect: 1 })); assert.equal(lost(carried.events).length, 1);
  for (const f of [healthy, stale, carried]) assert.deepEqual(revivals(f.events), []);
});

test('recovery lane: a failed attempt is never final; it is retried on the 30/60/120/240 s backoff, then every 240 s, each time after a database read', async t => {
  const failures = [() => settle(Promise.reject(coded('timeout'))), () => { throw coded('busy'); }, () => settle(Promise.reject(coded('recovery_refresh_refused')))];
  let healed = false;
  const f = fixture(t, { recover() {
    if (!healed) return failures[(f.recoveries() - 1) % failures.length]();
    f.setExpiry(f.now() + 300000); return settle(Promise.resolve(recovered('recovered', true)));
  } });
  f.setExpiry(NOW - 1); // dead when the process starts
  await f.cycle();
  assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 }));
  await f.cycle(); f.advance(29999); await f.cycle();
  assert.deepEqual([f.counts().reads, f.recoveries()], [1, 1]); // polls inside the backoff touch nothing
  f.advance(1); await f.cycle(); assert.deepEqual([f.counts().reads, f.recoveries()], [2, 2]); // read first, then the lane again
  while (f.now() - NOW < 3600000) { f.advance(30000); await f.cycle(); } // an hour of failures: four times TTL + tolerance
  assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 }));
  assert.equal(f.counts().reads, f.recoveries()); assert.equal(f.counts().calls, 0);
  const attempts = actions(f.events);
  assert.deepEqual(attempts.slice(0, 6).map(({ action, code, attempt, retryInMs }) => [action, code, attempt, retryInMs]), [
    ['recovery_failed', 'timeout', 1, 30000], ['recovery_not_dispatched', 'busy', 2, 60000], ['recovery_failed', 'recovery_refresh_refused', 3, 120000],
    ['recovery_failed', 'timeout', 4, 240000], ['recovery_not_dispatched', 'busy', 5, 240000], ['recovery_failed', 'recovery_refresh_refused', 6, 240000]]);
  assert(attempts.every(event => ['recovery_failed', 'recovery_not_dispatched'].includes(event.action) && event.retryInMs <= 240000));
  assert.equal(attempts.length, f.recoveries()); assert(attempts.length >= 15 && attempts.length <= 18, `attempts ${attempts.length}`);
  healed = true;
  for (let guard = 0; guard < 9 && !revivals(f.events).length; guard++) { f.advance(30000); await f.cycle(); }
  assert.equal(revivals(f.events).length, 1); assert.equal(actions(f.events).at(-1).attempt, attempts.length + 1);
  assert.deepEqual(f.service.status(), status('ready'));
  await f.cycle(); assert.equal(f.counts().calls, 1); assert.deepEqual(f.service.status(), status('ready'));
  assert.deepEqual(lost(f.events), []); assert.deepEqual(states(f.events), ['retrying', 'ready']);
  assert(!actions(f.events).some(event => event.action === 'expired'));
});

test('recovery lane: an attempt whose answer was lost is confirmed by the database read; it is not asked twice', async t => {
  const f = fixture(t, { recover() { f.setExpiry(f.now() + 300000); return settle(Promise.reject(coded('recovery_outcome_unknown'))); } });
  f.setExpiry(NOW - 1);
  await f.cycle(); assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 }));
  f.advance(30000); await f.cycle();
  assert.deepEqual([f.counts().reads, f.recoveries(), f.counts().calls], [2, 1, 1]); // served, then renewed by the normal lane
  assert.deepEqual(actions(f.events).map(({ action, code, source, attempt }) => [action, code ?? source, attempt]),
    [['recovery_failed', 'recovery_outcome_unknown', 1], ['recovery_confirmed', 'database', 1]]);
  assert.deepEqual(f.service.status(), status('ready')); assert.deepEqual(revivals(f.events), []);
});

test('recovery lane: an answer that is not the exact receipt is never acted on; the attempt is repeated later', async t => {
  let getterReads = 0;
  for (const [answer, code] of [[{ ...recovered(), connectionId: id(99) }, 'ack_connection_mismatch'], [{ ...recovered(), token: row.token }, 'ack_malformed'],
    [{ ok: true, status: 'unavailable' }, 'ack_malformed'], [{ ok: true, status: 'unavailable', refreshed: true }, 'ack_malformed'],
    [{ ok: false, status: 'unavailable', refreshed: false }, 'ack_malformed'], [{ ...unavailable(), connectionId: row.connectionId }, 'ack_malformed'],
    [recovered('renewed'), 'ack_malformed'], [{ ...recovered(), refreshed: 'yes' }, 'ack_malformed'], [{ ...recovered(), ok: 1 }, 'ack_malformed'],
    [null, 'ack_malformed'], ['recovered', 'ack_malformed'],
    [Object.defineProperty({ ok: true, connectionId: row.connectionId, refreshed: false }, 'status', { get() { getterReads++; return 'unavailable'; }, enumerable: true }), 'ack_malformed']]) {
    const f = fixture(t, { recover: () => settle(Promise.resolve(answer)) }); f.setExpiry(NOW - 1);
    await f.cycle();
    assert.deepEqual(actions(f.events).map(({ action, code: logged, attempt, retryInMs }) => [action, logged, attempt, retryInMs]), [['recovery_unconfirmed', code, 1, 30000]]);
    assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 })); assert.deepEqual(revivals(f.events), []);
    f.advance(30000); await f.cycle(); assert.equal(f.recoveries(), 2);
  }
  assert.equal(getterReads, 0);
});

test('recovery lane: live with nothing refreshed means the lease is sound, so the stop rule applies unchanged', async t => {
  // Refused from the first read although SQL finds lease and session live: asked once, then the usual TTL + tolerance.
  const never = fixture(t, { resolve() { throw coded('unauthorized'); }, recover: () => settle(Promise.resolve(recovered('live', false))) });
  await never.cycle();
  assert.deepEqual(never.service.status(), status('unavailable'));
  while (never.now() - NOW < 900000) { never.advance(30000); await never.cycle(); }
  assert.equal(never.service.status().staleAtStart, 0);
  never.advance(30000); await never.cycle();
  assert.deepEqual(never.service.status(), status('ready', { staleAtStart: 1 })); assert.equal(never.recoveries(), 1);
  assert.deepEqual(actions(never.events).map(({ action, code, deniedForMs }) => [action, code, deniedForMs]),
    [['recovery_not_needed', 'lease_live', undefined], ['resolve_failed', 'unauthorized', undefined], ['expired', 'unauthorized', 930000]]);
  assert.deepEqual(never.counts(), { calls: 0, reads: 32 }); // the same 32 reads as without a lane
  // Healthy, then refused past its confirmed expiry while SQL still finds the lease live: stopped at once, as before.
  let refusing = false;
  const healthy = fixture(t, { resolve() { if (refusing) throw coded('unauthorized'); return owner(row, healthy.expiry()); },
    recover: () => settle(Promise.resolve(recovered('live', false))) });
  await healthy.cycle(); refusing = true;
  for (let guard = 0; guard < 40 && !healthy.service.status().requiresReconnect; guard++) { healthy.advance(30000); await healthy.cycle(); }
  assert.equal(healthy.now() - NOW, 900000); assert.equal(healthy.recoveries(), 1); assert.equal(lost(healthy.events).length, 1);
  assert.deepEqual(brief(healthy.events), [['resolve_failed', 'unauthorized'], ['recovery_not_needed', 'lease_live'], ['expired', 'unauthorized']]);
  for (const f of [never, healthy]) assert.deepEqual(revivals(f.events), []);
});

test('recovery lane: a connection Auth/CRM keeps refusing is not revived in a loop: refused right after a recovery, it is not asked again and ends by the stop rule', async t => {
  let refusing = false;
  const f = fixture(t, { resolve() { if (refusing) throw coded('unauthorized'); return owner(row, f.expiry()); },
    recover() { f.setExpiry(f.now() + 300000); return settle(Promise.resolve(recovered())); } }); // SQL would revive the lease every time it is asked
  await f.cycle(); refusing = true;
  for (let guard = 0; guard < 80 && !f.service.status().requiresReconnect; guard++) { f.advance(30000); await f.cycle(); }
  assert.equal(f.recoveries(), 1); assert.equal(revivals(f.events).length, 1);
  assert.deepEqual(actions(f.events).map(({ action, code, deniedForMs }) => [action, code, deniedForMs]), [
    ['resolve_failed', 'unauthorized', undefined], ['recovered', undefined, undefined], ['recovery_not_needed', 'refused_after_recovery', undefined],
    ['resolve_failed', 'unauthorized', undefined], ['expired', 'unauthorized', 930000]]);
  assert.equal(f.now() - NOW, 900000 + 30000 + 930000); // confirmed expiry, one poll, then TTL + tolerance of refusals
  assert.deepEqual(f.service.status(), status('needs_attention', { requiresReconnect: 1 })); assert.equal(lost(f.events).length, 1);
  const reads = f.counts().reads; f.advance(600000); await f.cycle();
  assert.deepEqual([f.counts().reads, f.recoveries()], [reads, 1]);
});

test('recovery lane: after a refreshed live lease (no 5-minute guarantee) a new refusal asks SQL again, and its "nothing to recover" ends the loop', async t => {
  const answers = [recovered('live', true), recovered('live', false)];
  const f = fixture(t, { resolve() { throw coded('unauthorized'); }, recover: () => settle(Promise.resolve(answers[Math.min(f.recoveries(), answers.length) - 1])) });
  await f.cycle(); assert.equal(revivals(f.events).length, 1);
  for (let guard = 0; guard < 40 && !f.service.status().staleAtStart; guard++) { f.advance(30000); await f.cycle(); }
  assert.equal(f.recoveries(), 2); assert.equal(revivals(f.events).length, 1);
  assert.deepEqual(brief(f.events), [['recovered', 'live'], ['recovery_not_needed', 'lease_live'], ['resolve_failed', 'unauthorized'], ['expired', 'unauthorized']]);
  assert.equal(actions(f.events).at(-1).deniedForMs, 930000); assert.equal(f.now() - NOW, 960000); // counted from the refusal after the recovery
});

test('recovery lane: a recovery lost to a second outage is asked for again once the database refuses the token anew', async t => {
  let down = false;
  const f = fixture(t, { resolve() { if (down) throw coded('backend_unavailable'); if (f.expiry() <= f.now()) throw coded('unauthorized'); return owner(row, f.expiry()); },
    recover() { f.setExpiry(f.now() + 300000); return settle(Promise.resolve(recovered())); } });
  f.setExpiry(NOW - 1);
  await f.cycle(); assert.equal(f.recoveries(), 1); // revived, due at once
  down = true; // ... but the network drops again before the next poll, for longer than the 5-minute window
  for (let i = 0; i < 12; i++) { f.advance(30000); await f.cycle(); }
  assert.equal(f.recoveries(), 1); assert.equal(f.service.status().requiresReconnect + f.service.status().staleAtStart, 0);
  down = false; f.advance(30000); await f.cycle();
  assert.equal(f.recoveries(), 2); // first refusal with no confirmed expiry: asked at once, not after TTL + tolerance
  await f.cycle(); assert.equal(f.counts().calls, 1); assert.deepEqual(f.service.status(), status('ready'));
  assert.deepEqual(brief(f.events), [['recovered', 'recovered'], ['resolve_failed', 'backend_unavailable'], ['recovered', 'recovered']]);
});

test('recovery lane: a database outage in the middle of a recovery retry keeps the backoff and the retry state', async t => {
  let down = false, healed = false;
  const f = fixture(t, { resolve() { if (down) throw coded('backend_unavailable'); if (f.expiry() <= f.now()) throw coded('unauthorized'); return owner(row, f.expiry()); },
    recover() { if (!healed) return settle(Promise.reject(coded('timeout'))); f.setExpiry(f.now() + 300000); return settle(Promise.resolve(recovered())); } });
  f.setExpiry(NOW - 1);
  await f.cycle(); down = true; f.advance(30000); await f.cycle(); // attempt 1 failed; its re-read at 30 s fails too
  assert.deepEqual(actions(f.events).map(({ action, code, attempt, retryInMs }) => [action, code, attempt, retryInMs]),
    [['recovery_failed', 'timeout', 1, 30000], ['resolve_failed', 'backend_unavailable', 2, 60000]]);
  f.advance(30000); await f.cycle(); assert.equal(f.counts().reads, 2); // inside the 60 s backoff
  down = false; healed = true; f.advance(30000); await f.cycle();
  assert.deepEqual([f.counts().reads, f.recoveries()], [3, 2]); assert.equal(revivals(f.events).length, 1);
  assert.deepEqual(f.service.status(), status('ready'));
});

test('recovery lane: an owner served with an expiry already past is recovered once; a second such read ends as before', async t => {
  let stuck = true;
  const f = fixture(t, { resolve: () => owner(row, stuck ? NOW : f.expiry()), recover() { f.setExpiry(f.now() + 300000); return settle(Promise.resolve(recovered())); } });
  await f.cycle(); assert.equal(f.recoveries(), 1); assert.deepEqual(f.service.status(), status('ready'));
  await f.cycle(); // still served as expired right after the recovery: not asked again
  assert.equal(f.recoveries(), 1); assert.deepEqual(f.service.status(), status('ready', { staleAtStart: 1 }));
  assert.deepEqual(brief(f.events), [['recovered', 'recovered'], ['expired', 'token_expired']]);
  const live = fixture(t, { resolve: () => owner(row, stuck ? NOW : live.expiry()), recover() { stuck = false; live.setExpiry(live.now() + 300000); return settle(Promise.resolve(recovered())); } });
  stuck = true; await live.cycle(); await live.cycle();
  assert.deepEqual([live.recoveries(), live.counts().calls], [1, 1]); assert.deepEqual(live.service.status(), status('ready'));
  const dead = fixture(t, { resolve: () => owner(row, NOW), recover: () => settle(Promise.resolve(unavailable())) });
  await dead.cycle(); assert.deepEqual(brief(dead.events), [['expired', 'token_expired']]);
});

test('recovery lane: an unknown drain retains the connection and fails close; a malformed handle halts the loop; shutdown waits for the actual drain', async t => {
  const uncertain = fixture(t, { recover: () => settle(Promise.resolve(recovered()), Promise.reject(Error('PRIVATE drain'))) }); uncertain.setExpiry(NOW - 1);
  await uncertain.cycle();
  assert.deepEqual(uncertain.service.status(), status('retained', { retained: 1 }));
  assert.deepEqual(brief(uncertain.events), [['retained', 'drain_unknown']]); assert.deepEqual(revivals(uncertain.events), []);
  uncertain.advance(600000); await uncertain.cycle(); assert.equal(uncertain.recoveries(), 1); // never re-admitted here
  await assert.rejects(uncertain.service.close(), { message: 'connector_maintenance_retained' });
  let getterReads = 0;
  const malformed = fixture(t, { recover: () => ({ result: Promise.resolve(recovered()), get drained() { getterReads++; return Promise.resolve(); } }) }); malformed.setExpiry(NOW - 1);
  await malformed.cycle();
  assert.deepEqual(brief(malformed.events), [['retained', 'invalid_handle']]); assert.equal(getterReads, 0);
  assert.equal(malformed.events.find(event => event.event === 'connector_maintenance_state').halted, true);
  await assert.rejects(malformed.service.close(), { message: 'connector_maintenance_retained' });
  const result = deferred(), drain = deferred();
  const closing = fixture(t, { recover: () => settle(result.promise, drain.promise) }); closing.setExpiry(NOW - 1);
  await closing.cycle(); let closed = false; const close = closing.service.close().then(() => { closed = true; });
  result.reject(coded('backend_closed')); await tick(); assert.equal(closed, false);
  drain.resolve(); await close; assert.equal(closed, true);
  assert.deepEqual(actions(closing.events), []); // a shutdown-cancelled attempt is neither retried nor logged as a failure
});

test('recovery lane: a recovery step that outlives 120 s is logged as stalled with its phase', async t => {
  const result = deferred();
  t.after(() => result.resolve(recovered()));
  const f = fixture(t, { recover: () => settle(result.promise) }); f.setExpiry(NOW - 1);
  await f.cycle(); f.alarm();
  assert.deepEqual(actions(f.events).map(event => [event.action, event.phase]), [['stalled', 'recovery']]);
  f.setExpiry(f.now() + 300000); result.resolve(recovered()); await tick();
  assert.equal(revivals(f.events).length, 1);
});

test('recovery lane: its log lines carry fixed fields only: no token, digest, operation ID, full connection ID or error text', async t => {
  const tokenCode = 'hc_' + 'b'.repeat(43);
  const scripts = [
    () => settle(Promise.reject(Object.assign(Error(`PRIVATE ${row.token}`), { code: tokenCode }))),
    () => { throw Object.assign(Error('PRIVATE refusal'), { code: 'PRIVATE free text' }); },
    () => settle(Promise.resolve({ ...recovered(), status: 'PRIVATE free text' })),
    () => settle(Promise.resolve(recovered('live', false))),
    () => settle(Promise.resolve(recovered('recovered', true))),
    () => settle(Promise.resolve(unavailable())),
  ];
  const text = [];
  for (const script of scripts) {
    const f = fixture(t, { healthyIds: [row.operationId], recover: script }); f.setExpiry(NOW - 1);
    await f.cycle(); f.advance(30000); await f.cycle();
    text.push(JSON.stringify(f.events));
    const allowed = new Set(['event', 'ts', 'state', 'previous', 'requiresReconnect', 'retrying', 'retained', 'staleAtStart', 'halted', 'code', 'phase',
      'connectionId', 'action', 'attempt', 'retryInMs', 'expiresInMs', 'deniedForMs', 'source', 'status', 'reconciled', 'refreshed']);
    for (const event of f.events) {
      assert(Object.keys(event).every(key => allowed.has(key)), Object.keys(event).join());
      assert(['connector_maintenance_state', 'connector_maintenance_connection', 'connector_renewal_at_risk', 'connector_connection_lost',
        'connector_connection_recovered'].includes(event.event));
      if (event.connectionId !== undefined) assert.equal(event.connectionId, suffix);
      if (event.status !== undefined) assert(['recovered', 'live'].includes(event.status));
    }
  }
  const all = text.join();
  const fingerprint = createHash('sha256').update(JSON.stringify([...OWNER.map(key => row[key]), row.token])).digest('hex');
  for (const secret of [row.token, tokenCode, createHash('sha256').update(row.token).digest('hex'), fingerprint, row.operationId, row.connectionId, 'PRIVATE']) {
    assert(!all.includes(secret), 'a log line leaked a secret or full identifier');
  }
  for (const action of ['recovery_failed', 'recovery_not_dispatched', 'recovery_unconfirmed', 'recovery_not_needed', 'recovered', 'expired']) assert(all.includes(`"action":"${action}"`), action);
});

test('the recovery lane is optional but, when given, must be a function', () => {
  const backend = { resolveConnection() {}, beginExternalConnectionMaintenance() {} };
  assert.doesNotThrow(() => createConnectorMaintenance({ handoff: { list() {} }, backend }));
  assert.doesNotThrow(() => createConnectorMaintenance({ handoff: { list() {} }, backend: { ...backend, beginExternalConnectionRecovery() {} } }));
  for (const bad of ['x', null, {}, 1]) {
    assert.throws(() => createConnectorMaintenance({ handoff: { list() {} }, backend: { ...backend, beginExternalConnectionRecovery: bad } }), { message: 'invalid_connector_maintenance_config' });
  }
});

const recoveryStalls = events => events.filter(event => event.event === 'connector_recovery_stalled');
// Polls every 30 s until the lane has been asked `count` times; bounded, so a regression fails instead of hanging.
async function askedTimes(f, count) {
  for (let guard = 0; guard < 600 && f.recoveries() < count; guard++) { f.advance(30000); await f.cycle(); }
  assert.equal(f.recoveries(), count);
}

test('recovery lane: ten failed or unconfirmed attempts in a row raise one connector_recovery_stalled record per run; it changes nothing, and a recovery ends the run', async t => {
  const failures = [() => settle(Promise.reject(coded('recovery_provider_unreachable'))), () => { throw coded('busy'); },
    () => settle(Promise.resolve({ ...recovered(), connectionId: id(99) }))];
  let healed = false;
  const f = fixture(t, { recover() {
    if (!healed) return failures[(f.recoveries() - 1) % failures.length]();
    f.setExpiry(f.now() + 300000); return settle(Promise.resolve(recovered()));
  } });
  f.setExpiry(NOW - 1);
  await f.cycle();
  await askedTimes(f, 9);
  assert.deepEqual(recoveryStalls(f.events), []); // nine failures: not yet
  await askedTimes(f, 10);
  const [first] = recoveryStalls(f.events); assert.equal(recoveryStalls(f.events).length, 1);
  assert.deepEqual(first, { event: 'connector_recovery_stalled', ts: new Date(f.now()).toISOString(), connectionId: suffix, attempts: 10, code: 'recovery_provider_unreachable' });
  assert.doesNotMatch(JSON.stringify(first), /hc_|PRIVATE|[0-9a-f]{8}-[0-9a-f]{4}/);
  await askedTimes(f, 25);
  assert.equal(recoveryStalls(f.events).length, 1); // once per run, however long it lasts
  assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 })); // behaviour unchanged: still retried, never final
  assert.equal(actions(f.events).filter(event => /^recovery_(failed|not_dispatched|unconfirmed)$/.test(event.action)).length, 25);
  assert.equal(actions(f.events).at(-1).retryInMs, 240000);
  healed = true;
  for (let guard = 0; guard < 9 && !revivals(f.events).length; guard++) { f.advance(30000); await f.cycle(); }
  await f.cycle(); assert.deepEqual(f.service.status(), status('ready')); assert.equal(revivals(f.events).length, 1);
  // A later run of failures on the same connection is a new episode with its own record, counted from one again.
  healed = false; f.setExpiry(f.now() - 1);
  for (let guard = 0; guard < 400 && recoveryStalls(f.events).length < 2; guard++) { f.advance(30000); await f.cycle(); }
  assert.deepEqual(recoveryStalls(f.events).map(event => event.attempts), [10, 10]);
  assert.equal(f.recoveries(), 26 + 10); assert.deepEqual(lost(f.events), []);
});

test('recovery lane: an attempt confirmed by the database, or SQL finding nothing to recover, ends the run of failures before it is reported', async t => {
  let mode = 'fail';
  const f = fixture(t, { resolve() { if (mode === 'served') return owner(row, f.now() + 900000); throw coded(mode === 'outage' ? 'backend_unavailable' : 'unauthorized'); },
    recover: () => mode === 'sound' ? settle(Promise.resolve(recovered('live', false))) : settle(Promise.reject(coded('timeout'))) });
  await f.cycle();
  await askedTimes(f, 9);
  mode = 'served'; f.advance(240000); await f.cycle(); // the re-read serves the token: nine failures are forgotten
  assert.equal(actions(f.events).at(-1).action, 'recovery_confirmed');
  mode = 'fail'; f.advance(900000); await askedTimes(f, 18);
  assert.deepEqual(recoveryStalls(f.events), []); // nine more, eighteen in all, but never ten in a row
  // SQL finding nothing to recover (asked before the stop rule applies) ends a run as well: five failures before it,
  // another answer so that the lane is asked again, five failures after it, and still no run of ten.
  mode = 'fail';
  const g = fixture(t, { resolve() { throw coded(mode === 'outage' ? 'backend_unavailable' : 'unauthorized'); },
    recover: () => mode === 'sound' ? settle(Promise.resolve(recovered('live', false))) : settle(Promise.reject(coded('timeout'))) });
  await g.cycle(); await askedTimes(g, 5);
  mode = 'sound'; await askedTimes(g, 6);
  assert.equal(actions(g.events).filter(event => event.action === 'recovery_not_needed').length, 1);
  assert.deepEqual(g.service.status(), status('unavailable')); // refused for 690 s only: not yet at the stop rule
  mode = 'outage'; g.advance(30000); await g.cycle();
  mode = 'fail'; await askedTimes(g, 11);
  assert.equal(actions(g.events).at(-1).action, 'recovery_failed'); assert.equal(actions(g.events).at(-1).attempt, 5);
  assert.deepEqual(recoveryStalls(g.events), []);
});

test('lease guard in the loop: a refresh due with too little lease left is a retried renewal, the lease lapses, and the recovery lane refreshes under a fresh window', async t => {
  // Session cycle of the model: token renewed to minute 60 (the session expiry) at minute 45, refresh due at minute 50.
  // The database is away from 49:30 to 58:00, so when it answers again a refresh is due with 2 minutes of lease left.
  const MIN = 60000, down = time => time >= NOW + 49.5 * MIN && time < NOW + 58 * MIN;
  const f = lease(t, { lead: 600000, refreshBefore: 600000, recovery: true, down });
  const until = async minute => { while (f.now() < NOW + minute * MIN) { f.advance(30000); await f.cycle(); } };
  await f.cycle(); await until(59.5);
  assert.deepEqual([f.counts.guarded, f.counts.refreshed, f.counts.recovered], [3, 0, 0]); // 58:00, 58:30 and 59:30: refused before any refresh
  assert.deepEqual(f.service.status(), status('retrying', { retrying: 1 }));
  assert.deepEqual(actions(f.events).map(({ action, code, attempt, retryInMs, expiresInMs }) => [action, code, attempt, retryInMs, expiresInMs]), [
    ['resolve_failed', 'backend_unavailable', undefined, undefined, undefined], ['resolve_recovered', undefined, undefined, undefined, undefined],
    ['renewal_failed', 'maintenance_rejected', 1, 30000, 120000], ['renewal_failed', 'maintenance_rejected', 2, 60000, 90000],
    ['renewal_failed', 'maintenance_rejected', 3, 0, 30000]]);
  await until(60); // the lease has lapsed: the recovery lane is asked, SQL grants 5 minutes and the session is refreshed under them
  assert.deepEqual([f.counts.guarded, f.counts.refreshed, f.counts.recovered], [3, 1, 1]);
  assert.deepEqual(revivals(f.events).map(({ status: answer, refreshed }) => [answer, refreshed]), [['recovered', true]]);
  const renewed = f.counts.renewed;
  await until(60.5); // the normal lane extends the recovered lease; no second refresh
  assert.deepEqual([f.counts.renewed, f.counts.refreshed, f.counts.guarded], [renewed + 1, 1, 3]);
  assert.deepEqual(f.service.status(), status('ready')); assert.deepEqual(lost(f.events), []);
  assert(!actions(f.events).some(event => event.action === 'expired'));
  await until(180); // two more session cycles on the normal schedule
  assert.deepEqual([f.counts.guarded, f.counts.recovered, f.counts.refused], [3, 1, 0]); assert.deepEqual(f.service.status(), status('ready'));
  // Mutation: the system without guard and lane refreshes across that 2-minute lease, the case the fence punishes for good.
  const plain = lease(t, { lead: 600000, refreshBefore: 600000, down });
  await plain.cycle(); while (plain.now() < NOW + 58 * MIN) { plain.advance(30000); await plain.cycle(); }
  assert.deepEqual([plain.counts.shortLeaseRefreshes, plain.counts.refreshed], [1, 1]);
});

test('outage sweep with the recovery lane: outages far longer than the token and the session never lose the connection; without it every one does', async t => {
  const MIN = 60000;
  for (const minutes of [20, 90, 300]) {
    let dead = 0, deadWithout = 0;
    for (let start = 25; start < 85; start += 5) { // twelve outage starts across one session cycle
      const from = NOW + start * MIN, down = time => time >= from && time < from + minutes * MIN;
      const f = await runLease(t, { lead: 600000, refreshBefore: 600000, down, recovery: true }, start + minutes + 45);
      if (f.service.status().requiresReconnect || f.service.status().state !== 'ready') dead++;
      assert.equal(f.counts.recovered, 1, `outage of ${minutes} min from minute ${start}: one recovery`);
      assert.deepEqual(lost(f.events), []); assert.equal(revivals(f.events).length, 1);
      assert.equal(actions(f.events).at(-1).action === 'expired', false);
      const plain = await runLease(t, { lead: 600000, refreshBefore: 600000, down }, start + minutes + 45);
      if (plain.service.status().requiresReconnect) deadWithout++;
    }
    assert.equal(dead, 0, `the recovery lane lost the connection to a ${minutes}-minute outage`);
    assert.equal(deadWithout, 12, `without the lane a ${minutes}-minute outage is always final`);
  }
});
