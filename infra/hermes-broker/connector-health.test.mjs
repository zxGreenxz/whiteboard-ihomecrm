import test from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTOR_VERSION, createConnectorHealth } from './connector-health.mjs';

const id = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('health keeps last success, last tool call and last error code per connection only', () => {
  let now = 1_800_000_000_000;
  const health = createConnectorHealth({ clock: () => now });
  health.record({ connectionId: id(1), operation: 'authenticate' }); now += 10;
  health.record({ connectionId: id(1), operation: 'tools/call' }); now += 10;
  health.record({ connectionId: id(1), operation: 'tools/call', code: 'rate_limited' });
  const snapshot = health.snapshot([id(1), id(2)]);
  assert.deepEqual(snapshot.connector, { version: CONNECTOR_VERSION, startedAt: 1_800_000_000_000, observedAt: now });
  assert.deepEqual(snapshot.connections, [
    { id: id(1), lastSuccessAt: 1_800_000_000_010, lastToolCallAt: 1_800_000_000_010, lastErrorCode: 'rate_limited', lastErrorAt: now },
    { id: id(2), lastSuccessAt: null, lastToolCallAt: null, lastErrorCode: null, lastErrorAt: null }]);
  assert(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.connections[0]));
  // A later success keeps the last error visible; it is a history of codes, not state.
  now += 10; health.record({ connectionId: id(1), operation: 'tools/list' });
  assert.equal(health.snapshot([id(1)]).connections[0].lastErrorCode, 'rate_limited');
});

test('malformed events are ignored, request ids are validated and memory is bounded', () => {
  const health = createConnectorHealth({ clock: () => 1_800_000_000_000, maxConnections: 2 });
  for (const event of [null, {}, { connectionId: 'not-a-uuid', operation: 'tools/call' }, { connectionId: id(1), operation: 'private/group-room-send' },
    { connectionId: id(1), operation: 'tools/call', code: 'Bearer hc_secret' }, { connectionId: id(1), operation: 'tools/call', code: 7 }]) {
    health.record(event);
  }
  assert.equal(health.snapshot([id(1)]).connections[0].lastSuccessAt, null);
  for (const n of [1, 2, 3]) health.record({ connectionId: id(n), operation: 'tools/call' });
  assert.equal(health.snapshot([id(1)]).connections[0].lastSuccessAt, null, 'least recently active entry evicted');
  assert.equal(health.snapshot([id(3)]).connections[0].lastSuccessAt, 1_800_000_000_000);
  for (const ids of [[id(1), id(1)], ['x'], 'x', Array.from({ length: 257 }, (_, n) => id(n))]) {
    assert.throws(() => health.snapshot(ids), /invalid_connector_health_request/);
  }
  assert.throws(() => createConnectorHealth({ clock: () => NaN }), /invalid_connector_health_config/);
  assert.throws(() => createConnectorHealth({ version: 'latest' }), /invalid_connector_health_config/);
});
