// Trusted backend transport. The supplied pool belongs exclusively to this
// adapter and authenticates a dedicated DB login, never postgres/service_role.
// Runtime Hermes has no access to this object, DB credential or encrypted rows.
const FUNCTIONS = Object.freeze({
  activate: 'app_private.hermes_store_activate_v1',
  readConnection: 'app_private.hermes_store_read_connection_v1',
  restrictConnection: 'app_private.hermes_store_restrict_connection_v1',
  renewConnection: 'app_private.hermes_store_renew_connection_v1',
  revokeConnection: 'app_private.hermes_store_revoke_connection_v1',
  acquireRefresh: 'app_private.hermes_store_acquire_refresh_v1',
  dispatchRefresh: 'app_private.hermes_store_dispatch_refresh_v1',
  stageRefresh: 'app_private.hermes_store_stage_refresh_v1',
  publishRefresh: 'app_private.hermes_store_publish_refresh_v1',
  reconnectSession: 'app_private.hermes_store_reconnect_session_v1',
  revokeSession: 'app_private.hermes_store_revoke_session_v1',
  releaseRefresh: 'app_private.hermes_store_release_refresh_v1',
  claimPrivateCommand: 'app_private.hermes_store_claim_private_command_v1',
  dispatchPrivateCommand: 'app_private.hermes_store_dispatch_private_command_v1',
  finishPrivateCommand: 'app_private.hermes_store_finish_private_command_v1',
  failPrivateCommand: 'app_private.hermes_store_fail_private_command_v1',
  prunePrivateCommands: 'app_private.hermes_store_prune_private_commands_v1',
  pruneWorkMemories: 'app_private.hermes_store_prune_work_memories_v1',
});
const PRINCIPAL_SQL = `SELECT current_user AS role, session_user AS session_role, r.rolsuper, r.rolbypassrls,
  r.rolcreaterole, r.rolcreatedb, r.rolreplication,
  pg_catalog.pg_has_role(current_user, 'hermes_store_executor', 'MEMBER') AS scoped,
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles p WHERE p.rolname IN
    ('postgres','service_role','authenticator','supabase_admin')
    AND pg_catalog.pg_has_role(current_user, p.oid, 'MEMBER')) AS privileged_member
  FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class StoreTransportError extends Error {
  constructor(code) { super(code); this.name = 'StoreTransportError'; this.code = code; }
}
const fail = code => { throw new StoreTransportError(code); };
// These PostgreSQL ERROR responses prove this single autocommit statement was
// rejected/rolled back. Connection errors, FATAL/PANIC and completion-unknown
// SQLSTATEs do not prove that, even if they carry a five-character code.
function knownRejection(error) {
  if (error?.severity !== 'ERROR') return null;
  if (error.code === '42501') return 'store_denied';
  if (['40001', '40P01'].includes(error.code)) return 'store_conflict';
  if (/^(22|23)[A-Z0-9]{3}$/.test(error.code ?? '') || ['P0001', '57014'].includes(error.code)) return 'store_rejected';
  return null;
}

/** Pool setup must enforce TLS certificate verification and bounded connection,
 * query and statement timeouts. This layer also enforces a caller deadline,
 * destroys failed/cancelled clients and never retries a dispatched statement.
 * A lost write ACK is store_outcome_unknown, even if the server may have committed.
 * Caller reconciles by the SAME operation/claim; it must not repeat a provider call.
 */
export function createStoreTransport({ pool, expectedRole, timeoutMs = 10_000,
  maxRequestBytes = 131_072, maxResponseBytes = 131_072, dependencyScope } = {}) {
  if (typeof pool?.connect !== 'function' || typeof expectedRole !== 'string' ||
      !/^hermes_store_[a-z0-9_]{1,40}$/.test(expectedRole) || expectedRole === 'hermes_store_executor' ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 131_072 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 131_072 ||
      (dependencyScope !== undefined && typeof dependencyScope?.track !== 'function')) {
    throw new TypeError('invalid_store_transport_config');
  }
  return Object.freeze({
    async call(operation, input, { signal } = {}) {
      if (!Object.hasOwn(FUNCTIONS, operation) || !record(input)) fail('invalid_store_request');
      let serialized;
      try { serialized = JSON.stringify(input); } catch { fail('invalid_store_request'); }
      if (Buffer.byteLength(serialized) > maxRequestBytes) fail('store_request_too_large');
      if (!signal || typeof signal.addEventListener !== 'function') fail('invalid_store_request');
      if (signal.aborted) fail('store_cancelled');
      let client, released = false, stopped = false, dispatched = false;
      const write = operation !== 'readConnection';
      const release = destroy => {
        if (!client || released) return;
        released = true;
        try { client.release(destroy); } catch { /* The caller still receives the safe failure. */ }
      };
      const controller = new AbortController();
      const stop = reason => { stopped = true; controller.abort(reason); release(true); };
      const onAbort = () => stop('store_cancelled');
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => stop('store_timeout'), timeoutMs);
      let abortListener;
      const aborted = new Promise((_, reject) => {
        abortListener = () => reject(new StoreTransportError(controller.signal.reason));
        controller.signal.addEventListener('abort', abortListener, { once: true });
      });
      try {
        const run = async () => {
          client = await pool.connect();
          if (stopped) { release(true); fail('store_cancelled'); }
          const check = await client.query({ text: PRINCIPAL_SQL, values: [], queryMode: 'extended' });
          if (stopped) fail('store_cancelled');
          const principal = check.rows?.[0];
          if (check.rows?.length !== 1 || principal?.role !== expectedRole || principal.session_role !== expectedRole || principal.scoped !== true ||
              principal.privileged_member !== false ||
              ['rolsuper', 'rolbypassrls', 'rolcreaterole', 'rolcreatedb', 'rolreplication'].some(key => principal[key] !== false)) {
            fail('store_principal_refused');
          }
          // Function names are fixed constants. Only the JSON payload is a bound
          // parameter; callers cannot select a schema, arbitrary RPC or SQL text.
          dispatched = true;
          const response = await client.query({ text: `SELECT ${FUNCTIONS[operation]}($1::jsonb) AS result`,
            values: [serialized], queryMode: 'extended' });
          if (stopped) fail('store_cancelled');
          const value = response.rows?.[0]?.result;
          if (response.rows?.length !== 1 || !record(value) || Buffer.byteLength(JSON.stringify(value)) > maxResponseBytes) {
            fail('invalid_store_response');
          }
          return value;
        };
        const value = await Promise.race([dependencyScope ? dependencyScope.track(run) : run(), aborted]);
        if (stopped) fail('store_cancelled');
        release(false);
        return value;
      } catch (error) {
        const rejection = !stopped && knownRejection(error);
        stop('store_failed');
        // Never expose SQL detail or secrets. Known server ERROR responses are
        // final denials; an uncertain write can only be reconciled by its claim.
        if (dispatched && rejection) fail(rejection);
        if (dispatched && write) fail('store_outcome_unknown');
        if (error instanceof StoreTransportError) throw error;
        fail('store_unavailable');
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        controller.signal.removeEventListener('abort', abortListener);
      }
    },
  });
}
