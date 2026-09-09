import assert from 'node:assert/strict';
import { test } from 'node:test';
const api = await import('../lib/copilot-room-pass-sessions.mjs').catch(() => ({}));
test('requires observed acquired row lock and an executor wait, not overlapping promises', async () => {
  assert.equal(typeof api.observeBarrier, 'function');
});

test('each authenticated participant assigns its transaction ID before a possible row-lock wait', () => {
  const sql = api.authenticatedTransaction({ actorId: '11111111-1111-4111-8111-111111111111', applicationName: 'rp17-xid-proof', body: 'SELECT owned_action_that_waits();' });
  assert.ok(sql.indexOf('SELECT txid_current()') > sql.indexOf('SET LOCAL ROLE authenticated'));
  assert.ok(sql.indexOf('SELECT txid_current()') < sql.indexOf('SELECT owned_action_that_waits()'));
});

test('PgSleep holder then lock waiter requires distinct backend AND transaction IDs and real blocker edge', async () => {
  let tick = 0;
  const holder = { tag: 'rp17-holder', pid: 10, xid: '100', state: 'active', wait_event: 'PgSleep', transaction_started: '2026-09-08T00:00:00Z' };
  const waiter = { tag: 'rp17-executor', pid: 11, xid: '101', state: 'active', wait_event_type: 'Lock', blocking_pids: [10] };
  const result = await api.observeBarrier({ holder: holder.tag, executors: [waiter.tag], transport: { query: async () => [holder, waiter] } });
  assert.equal(result.executors[0].pid, 11);
  for (const bad of [{ ...waiter, xid: '100' }, { ...waiter, blocking_pids: [] }, { ...waiter, wait_event_type: 'IO' }]) {
    tick = 0;
    await assert.rejects(api.observeBarrier({ holder: holder.tag, executors: [waiter.tag],
      now: () => tick, pause: async () => { tick += 100; }, deadlineMs: 200,
      transport: { query: async () => [holder, bad] } }), /lock_barrier_not_observed/);
  }
});

test('runner establishes holder barrier, then first nonce lock, then contender and awaits all original handles', async () => {
  const events = [], handles = [], started = [];
  const actor = '11111111-1111-4111-8111-111111111111';
  const runner = { run: { actorId: actor, runId: actor, organizationId: 'dddd0000-0000-4000-8000-000000000001', marker: 'fixture',
    fixtures: { building: { id: actor }, room: { id: actor }, listing: { id: actor } }, scenarios: [] },
    ownedListing: async () => {}, save: async () => { events.push('journal'); } };
  const proposal = { confirmation_nonce: 'a'.repeat(64), canonical: { organization_id: runner.run.organizationId, listing_id: actor } };
  const transport = { query: async sql => {
    if (sql.startsWith('BEGIN;')) {
      const tag = sql.match(/application_name = '([^']+)'/)[1];
      started.push(tag); events.push(tag.endsWith('-h') ? 'holder-start' : tag.endsWith('-e1') ? 'first-start' : 'second-start');
      return new Promise(resolve => handles.push(resolve));
    }
    events.push(`observe-${started.length}`);
    return started.map((tag, index) => ({ tag, pid: index + 10, xid: `${index + 100}`, state: 'active', transaction_started: '2026-09-08T00:00:00Z',
      ...(index === 0 ? { wait_event: 'PgSleep' } : { wait_event_type: 'Lock', blocking_pids: [index === 1 ? 10 : 11] }) }));
  } };
  const result = await api.runLockCase({ runner, transport, proposal, name: 'same_nonce_sessions', sameNonce: true,
    afterWait: async () => { events.push('after-wait'); handles.forEach(resolve => resolve([])); } });
  assert.ok(events.indexOf('observe-1') < events.indexOf('first-start'));
  assert.ok(events.indexOf('observe-2') < events.indexOf('second-start'));
  assert.ok(events.indexOf('observe-3') < events.indexOf('after-wait'));
  assert.equal(result.state, 'settled'); assert.equal(result.outcomes.length, 3);
});

const { executeManagementQuery } = await import('../apply-accounting-rollout.mjs');
const { createRoomPassManagementTransport } = await import('../lib/copilot-room-pass-transport.mjs');
const config = { pat: 'synthetic-token', projectRef: 'synthetic-project' };

test('actual Management wrapper decodes SQL diagnostic JSON and keeps uncertain boundaries unknown', async t => {
  let next, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; if (next instanceof Error) throw next; return next; });
  const transport = createRoomPassManagementTransport({ executeManagementQuery, config });
  const body = message => JSON.stringify({ message });
  for (const [raw, status, expected] of [
    [body('ERROR: 42501: confirmation_already_used\nCONTEXT: fixture secret'), 400, 'confirmation_already_used'],
    [body('ERROR: P0002: entity_not_found\nCONTEXT: fixture secret'), 500, 'entity_not_found'],
    [body('ERROR: 42501: confirmation_expired'), 400, 'confirmation_expired'],
    [body('ERROR: 42501: tenant_emergency_denied\r\nCONTEXT: fixture secret'), 400, 'tenant_emergency_denied'],
    [body('ERROR: 57014: confirmation_already_used'), 400, 'management_unknown'],
    [body('ERROR: 57014: canceling statement due to statement timeout\nCONTEXT: ERROR: 42501: confirmation_already_used'), 400, 'management_unknown'],
    [body('CONTEXT: ERROR: 42501: confirmation_already_used'), 400, 'management_unknown'],
    [body('ERROR: 42501: not_permitted_extra\nCONTEXT: confirmation_already_used'), 400, 'management_unknown'],
    [body('ERROR: 42501: confirmation_already_used extra'), 400, 'management_unknown'],
    ['ERROR: 42501: confirmation_already_used', 400, 'management_unknown'],
    ['{"message":"ERROR: 42501: confirmation_already_used', 400, 'management_unknown'],
    [body('ERROR: 42501: confirmation_already_used\nCONTEXT: ' + 'x'.repeat(4100)), 400, 'management_unknown'],
    [JSON.stringify({ unrelated: 'ERROR: 42501: confirmation_already_used' }), 400, 'management_unknown'],
    [body('ERROR: 42501: confirmation_already_used'), 200, 'management_unknown'],
  ]) {
    next = new Response(raw, { status });
    await assert.rejects(transport.query('SELECT synthetic'), error => {
      assert.equal(error.message, expected);
      assert.equal(error.response?.body?.message, expected === 'management_unknown' ? undefined : expected);
      assert.doesNotMatch(JSON.stringify(error), /fixture secret|synthetic-token|CONTEXT|SELECT/);
      return true;
    });
  }
  for (const message of ['network disconnected', 'AbortError: timeout', 'ERROR: 42501: confirmation_already_used', 'Supabase database query failed (400): ' + body('ERROR: 42501: confirmation_already_used')]) {
    next = new Error(message);
    await assert.rejects(transport.query('SELECT synthetic'), { message: 'management_unknown' });
  }
  next = { ok: false, status: 400, text: async () => { throw new Error('body interrupted'); } };
  await assert.rejects(transport.query('SELECT synthetic'), { message: 'management_unknown' });
  assert.equal(calls, 19, 'one HTTP request per query; no retries');
});

test('session settlement distinguishes actual wrapped SQL denial from diagnostic text in CONTEXT', async t => {
  for (const known of [true, false]) {
    let finishFetch;
    const started = [], handles = [];
    t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { finishFetch = resolve; }));
    const management = createRoomPassManagementTransport({ executeManagementQuery, config });
    const actor = '11111111-1111-4111-8111-111111111111';
    const runner = { run: { actorId: actor, runId: actor, organizationId: 'dddd0000-0000-4000-8000-000000000001', marker: 'fixture',
      fixtures: { building: { id: actor }, room: { id: actor }, listing: { id: actor } }, scenarios: [] },
      ownedListing: async () => {}, save: async () => {} };
    const transport = { query: async sql => {
      if (sql.startsWith('BEGIN;')) {
        const tag = sql.match(/application_name = '([^']+)'/)[1]; started.push(tag);
        if (tag.endsWith('-h')) return new Promise(resolve => handles.push(resolve));
        return management.query(sql);
      }
      return started.map((tag, index) => ({ tag, pid: 10 + index, xid: String(100 + index), state: 'active', transaction_started: '2026-09-08T00:00:00Z',
        ...(index === 0 ? { wait_event: 'PgSleep' } : { wait_event_type: 'Lock', blocking_pids: [10] }) }));
    } };
    const promise = api.runLockCase({ runner, transport, name: 'wrapped_denial', proposal: { confirmation_nonce: 'a'.repeat(64), canonical: { organization_id: runner.run.organizationId, listing_id: actor } },
      afterWait: async () => {
        handles.forEach(resolve => resolve([]));
        finishFetch(new Response(JSON.stringify({ message: known ? 'Failed to run sql query: ERROR: 42501: confirmation_already_used\nCONTEXT: private sql' : 'ERROR: 57014: timeout\nCONTEXT: ERROR: 42501: confirmation_already_used' }), { status: 400 }));
      } });
    if (known) assert.equal((await promise).state, 'settled');
    else await assert.rejects(promise, /session_settlement_unverified/);
    assert.deepEqual(runner.run.scenarios[0].outcomes, ['ok', known ? 'confirmation_already_used' : 'session_unknown']);
    assert.doesNotMatch(JSON.stringify(runner.run.scenarios), /private sql|CONTEXT|synthetic-token/);
    t.mock.restoreAll();
  }
});

// Exact supported wire prefix verified by root's SELECT-only shape preflight.
test('actual wrapper accepts full Failed to run sql query envelope for all room-pass denials', async t => {
  let message, calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return new Response(JSON.stringify({ message }), { status: 400 }); });
  const transport = createRoomPassManagementTransport({ executeManagementQuery, config });
  const codes = ['confirmation_already_used', 'payload_changed', 'confirmation_expired', 'entity_not_found', 'copilot_action_disabled', 'tenant_emergency_denied', 'not_permitted'];
  for (const code of codes) {
    message = 'Failed to run sql query: ERROR: ' + (code === 'entity_not_found' ? 'P0002' : '42501') + ': ' + code + '\nCONTEXT: private fixture SQL';
    await assert.rejects(transport.query('SELECT synthetic'), error => {
      assert.equal(error.message, code);
      assert.deepEqual(error.response, { status: 403, body: { message: code } });
      assert.doesNotMatch(JSON.stringify(error), /private fixture|CONTEXT|synthetic/);
      return true;
    });
  }
  for (const invalid of [
    'CONTEXT: Failed to run sql query: ERROR: 42501: confirmation_already_used',
    'Failed to run sql query: ERROR: 57014: timeout\nCONTEXT: ERROR: 42501: confirmation_already_used',
    'Failed to run sql query: Failed to run sql query: ERROR: 42501: confirmation_already_used',
    'unrelated Failed to run sql query: ERROR: 42501: confirmation_already_used',
    'Failed to run sql query: ERROR: 42501: confirmation_already_used extra',
  ]) {
    message = invalid;
    await assert.rejects(transport.query('SELECT synthetic'), { message: 'management_unknown' });
  }
  assert.equal(calls, 12, 'one HTTP request per case');
});
