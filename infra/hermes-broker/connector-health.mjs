// Connector release identity, also announced as MCP serverInfo.version.
export const CONNECTOR_VERSION = '0.2.0';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const OPERATIONS = new Set(['authenticate', 'tools/list', 'tools/call']);
const positive = value => Number.isSafeInteger(value) && value > 0;

/** Process-local MCP activity per connection, fed by the broker's outcome
 * observer (the same points that write the audit receipt). It stores only a
 * connection id, timestamps and a fixed error code: no token, actor, argument,
 * tool name or result. It is not authority and is lost on restart, so readers
 * must present it as "since connector start". snapshot() only answers ids the
 * caller already proved it owns; unknown ids return empty activity.
 */
export function createConnectorHealth({ clock = Date.now, version = CONNECTOR_VERSION, maxConnections = 1024 } = {}) {
  if (typeof clock !== 'function' || typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version) ||
      !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 65_536) throw new TypeError('invalid_connector_health_config');
  const now = () => { const value = clock(); return positive(value) ? value : null; };
  const startedAt = now();
  if (startedAt === null) throw new TypeError('invalid_connector_health_config');
  const entries = new Map();
  return Object.freeze({
    record(event) {
      const at = now();
      if (at === null || !event || typeof event !== 'object' || typeof event.connectionId !== 'string' || !UUID.test(event.connectionId) ||
          !OPERATIONS.has(event.operation) || (event.code !== undefined && (typeof event.code !== 'string' || !CODE.test(event.code)))) return;
      const previous = entries.get(event.connectionId) ?? { lastSuccessAt: null, lastToolCallAt: null, lastErrorCode: null, lastErrorAt: null };
      const next = event.code === undefined
        ? { ...previous, lastSuccessAt: at, ...(event.operation === 'tools/call' ? { lastToolCallAt: at } : {}) }
        : { ...previous, lastErrorCode: event.code, lastErrorAt: at };
      // Map order is recency order; evict the least recently active connection.
      entries.delete(event.connectionId); entries.set(event.connectionId, Object.freeze(next));
      if (entries.size > maxConnections) entries.delete(entries.keys().next().value);
    },
    snapshot(connectionIds) {
      if (!Array.isArray(connectionIds) || connectionIds.length > 256 || connectionIds.some(id => typeof id !== 'string' || !UUID.test(id)) ||
          new Set(connectionIds).size !== connectionIds.length) throw new TypeError('invalid_connector_health_request');
      const observedAt = now() ?? startedAt;
      return Object.freeze({ connector: Object.freeze({ version, startedAt, observedAt: Math.max(observedAt, startedAt) }),
        connections: Object.freeze(connectionIds.map(id => Object.freeze({ id, ...(entries.get(id)
          ?? { lastSuccessAt: null, lastToolCallAt: null, lastErrorCode: null, lastErrorAt: null }) }))) });
    },
  });
}
