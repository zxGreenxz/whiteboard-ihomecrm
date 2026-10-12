import pg from 'pg';

// Backend configuration only. No environment lookup, vault lookup, URL override,
// postgres fallback or implicit SSL downgrade is allowed here.
export function createStorePool({ projectRef, host, role, password, ca,
  onIdleFailure = () => {} } = {}, { Pool = pg.Pool } = {}) {
  const validRef = typeof projectRef === 'string' && /^[a-z0-9]{20}$/.test(projectRef);
  const direct = host === `db.${projectRef}.supabase.co`;
  const sessionPooler = typeof host === 'string' && /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(host);
  if (!validRef || (!direct && !sessionPooler) || typeof role !== 'string' ||
      !/^hermes_store_[a-z0-9_]{1,40}$/.test(role) || role === 'hermes_store_executor' ||
      typeof password !== 'string' || password.length < 16 || password.length > 4096 || /[\r\n\0]/.test(password) ||
      (ca !== undefined && (typeof ca !== 'string' || ca.length > 65_536 || !ca.includes('-----BEGIN CERTIFICATE-----'))) ||
      typeof onIdleFailure !== 'function' || typeof Pool !== 'function') throw new TypeError('invalid_store_pool_config');
  const pool = new Pool({
    host, port: 5432, database: 'postgres', user: direct ? role : `${role}.${projectRef}`, password,
    ssl: { rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }) },
    max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000,
    query_timeout: 10_000, statement_timeout: 8000, lock_timeout: 3000,
    // Nonempty: pg falls back to ambient PGOPTIONS for an empty string.
    options: '-c statement_timeout=8000 -c lock_timeout=3000 -c idle_in_transaction_session_timeout=10000',
    application_name: 'ihomecrm-hermes-store', keepAlive: true,
  });
  // pg emits background errors for idle clients. Do not crash or leak its error,
  // connection config, SQL or credential through the observer callback.
  pool.on('error', () => {
    try { Promise.resolve(onIdleFailure({ code: 'store_idle_connection_failed' })).catch(() => {}); }
    catch { /* An observer must not become an unhandled background exception. */ }
  });
  return pool;
}
