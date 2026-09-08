import assert from 'node:assert/strict';
import { test } from 'node:test';
const api = await import('../lib/copilot-room-pass-sessions.mjs').catch(() => ({}));
test('requires observed acquired row lock and an executor wait, not overlapping promises', async () => {
  assert.equal(typeof api.observeBarrier, 'function');
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
