// Bounded TEST transport. Importing this file never opens a vault, socket or database.
import { createHash } from 'node:crypto';

import { captureNamedCatalog, validateTestTarget } from './preflight.mjs';

const IDENT = /^[a-z][a-z0-9_]*$/;
const POOLER = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const SHA = /^[a-f0-9]{40}$/;
const activeContexts = new WeakMap();

function checkDb(config) {
  const target = validateTestTarget(config);
  const db = config.db;
  if (!db || db.user !== `postgres.${target.expectedRef}` || db.database !== 'postgres' ||
      typeof db.password !== 'string' || !db.password ||
      (db.port ?? 5432) !== 5432 ||
      (db.host !== `db.${target.expectedRef}.supabase.co` && !POOLER.test(db.host ?? ''))) {
    throw new Error('Explicit TEST database binding is invalid.');
  }
  if (db.ca !== undefined && (typeof db.ca !== 'string' ||
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----(?:\r?\n)?$/.test(db.ca))) {
    throw new Error('Explicit TEST database CA must be PEM.');
  }
  return {
    host: db.host, user: db.user, database: db.database, password: db.password, port: 5432,
    ssl: { rejectUnauthorized: true, ...(db.ca ? { ca: db.ca } : {}) },
  };
}

export function loadTestCredentials({ env = process.env } = {}) {
  // The sync credential() also requires production secrets and may generate a seed.
  // Read only the TEST fields, only on explicit opt-in, from its single vault source.
  return testCredentialsFrom(env, '');
}

export async function loadTestCredentialsFromVault({ env = process.env } = {}) {
  const { docVault } = await import('../test-env/lib.mjs');
  return testCredentialsFrom(env, docVault());
}

function testCredentialsFrom(env, vault) {
  const field = (name) => env[name] || vault.match(new RegExp(`^${name}=(\\S+)\\s*$`, 'm'))?.[1];
  const expectedRef = field('TEST_SUPABASE_REF');
  const db = {
    host: field('TEST_SUPABASE_POOLER_HOST'),
    user: `postgres.${expectedRef}`,
    database: 'postgres',
    password: field('TEST_SUPABASE_DB_PASSWORD'),
    port: 5432,
  };
  const config = { expectedRef, url: `https://${expectedRef}.supabase.co`, db };
  checkDb(config);
  return config;
}

export async function withTestTransaction(config, { connect, run, commit = false, readOnly = false } = {}) {
  const dbConfig = checkDb(config); // admission before any socket
  if (typeof run !== 'function' || (connect !== undefined && typeof connect !== 'function') ||
      (readOnly && commit)) throw new Error('Invalid TEST transaction options.');
  const open = connect ?? (async (options) => {
    const { Client } = await import('pg');
    const client = new Client(options);
    await client.connect();
    return client;
  });
  let client;
  let verifiedContext;
  let begun = false;
  let settled = false;
  try {
    client = await open(dbConfig);
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    begun = true;
    const user = await client.query('SELECT session_user');
    // Supabase's pooler authenticates postgres.<ref> and maps the server
    // session to postgres. The exact login and marker still bind the project.
    if (user.rows?.length !== 1 || user.rows[0].session_user !== 'postgres') {
      throw new Error('TEST database user binding failed.');
    }
    // No LIMIT: zero, wrong or multiple marker rows all fail. Row lock retains
    // the admission condition through the mutation on this exact connection.
    const marker = await client.query(readOnly ? 'SELECT ref FROM test_env.danh_dau' : 'SELECT ref FROM test_env.danh_dau FOR SHARE');
    if (marker.rows?.length !== 1 || marker.rows[0].ref !== config.expectedRef) {
      throw new Error('TEST marker missing, wrong or multiple.');
    }
    verifiedContext = Object.freeze({ query: (sql, values) => client.query(sql, values) });
    // HTTP RPC uses a separate server transaction. Only a read-only marker
    // context can authorize it, so no fixture/business row lock is held.
    if (readOnly) activeContexts.set(verifiedContext, config.expectedRef);
    const result = await run(verifiedContext);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    settled = true;
    return result;
  } catch {
    if (begun && !settled) {
      try { await client.query('ROLLBACK'); } catch { /* retain sanitized failure */ }
    }
    throw new Error('TEST transaction failed; no result is admissible.');
  } finally {
    // A captured context cannot authorize a later HTTP RPC.
    if (verifiedContext) activeContexts.delete(verifiedContext);
    if (client) {
      try { await client.end(); } catch { /* transaction outcome remains authoritative */ }
    }
  }
}

function safeCode(code) {
  return typeof code === 'string' && /^[A-Z0-9_]{2,20}$/.test(code) ? code : 'UNKNOWN';
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    // Native JSON parser errors can include snippets of JWT or personal data.
    throw new Error('TEST HTTP invalid JSON response.');
  }
}

export function createTestHttp(config, { verified, fetch: doFetch = globalThis.fetch, apiKey, accessToken } = {}) {
  const { url, expectedRef } = validateTestTarget(config);
  if (typeof doFetch !== 'function' || typeof apiKey !== 'string' || !apiKey) {
    throw new Error('Explicit TEST HTTP transport and API key are required.');
  }
  async function request(path, { method = 'GET', body, token = accessToken, headers = {} } = {}) {
    let response;
    try {
      response = await doFetch(`${url}${path}`, {
        method,
        headers: { apikey: apiKey, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error('TEST HTTP transport failed.');
    }
    if (!response.ok) {
      let code = 'UNKNOWN';
      try { code = safeCode((await safeJson(response))?.code); } catch { /* no body */ }
      throw new Error(`TEST HTTP ${response.status} ${code}`);
    }
    return response;
  }
  return Object.freeze({
    async rpc(name, args = {}, { allowEmpty = false, token } = {}) {
      if (!IDENT.test(name)) throw new Error('Invalid TEST RPC name.');
      if (!verified || activeContexts.get(verified) !== expectedRef) throw new Error('RPC requires an active verified TEST transaction.');
      const result = await safeJson(await request(`/rest/v1/rpc/${name}`, { method: 'POST', body: args, token, headers: { 'Content-Type': 'application/json', 'Content-Profile': 'public' } }));
      if (!allowEmpty && (result === null || (Array.isArray(result) && result.length === 0))) throw new Error('TEST RPC returned no baseline evidence.');
      return result;
    },
    async signIn({ email, password }) {
      if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) throw new Error('TEST sign-in credentials required.');
      if (!verified || activeContexts.get(verified) !== expectedRef) throw new Error('Auth sign-in requires an active verified TEST transaction.');
      const result = await safeJson(await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password }, headers: { 'Content-Type': 'application/json' } }));
      if (typeof result?.access_token !== 'string' || !result.access_token) throw new Error('TEST sign-in returned no access token.');
      return result.access_token;
    },
    async selectPage({ table, columns = '*', orderBy = 'id', filters = '', offset, limit, token }) {
      if (!IDENT.test(table) || !IDENT.test(orderBy) || !Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 1000 ||
          (columns !== '*' && !String(columns).split(',').every((v) => IDENT.test(v))) ||
          (filters && (typeof filters !== 'string' || !/^&[a-z0-9_]+=[a-z0-9_.-]+(?:&[a-z0-9_]+=[a-z0-9_.-]+)*$/.test(filters)))) {
        throw new Error('Invalid TEST SELECT page.');
      }
      const response = await request(`/rest/v1/${table}?select=${columns}&order=${orderBy}.asc${filters}`, {
        token, headers: { Prefer: 'count=exact', 'Accept-Profile': 'public', Range: `${offset}-${offset + limit - 1}` },
      });
      return { headers: response.headers, rows: await safeJson(response) };
    },
  });
}

export async function selectAll(http, { table, columns = '*', orderBy = 'id', filters = '', pageSize = 1000, maxRows = 100000, allowEmpty = false, token } = {}) {
  if (!http || typeof http.selectPage !== 'function' || !IDENT.test(table ?? '') || !IDENT.test(orderBy ?? '') ||
      (columns !== '*' && !String(columns).split(',').every((v) => IDENT.test(v))) ||
      (filters && (typeof filters !== 'string' || !/^&[a-z0-9_]+=[a-z0-9_.-]+(?:&[a-z0-9_]+=[a-z0-9_.-]+)*$/.test(filters)))) {
    throw new Error('Invalid TEST SELECT specification.');
  }
  let exactEmpty = false;
  let captured;
  try {
    captured = await captureNamedCatalog({
    requirements: [{ name: table, key: orderBy, minRows: 1 }], pageSize, maxRows,
    fetchPage: async (_name, offset, limit) => {
      const response = await http.selectPage({ table, columns, orderBy, filters, offset, limit, token });
      const raw = response.headers.get('content-range');
      const match = /^(\d+)-(\d+)\/(\d+)$/.exec(raw ?? '');
      const rows = response.rows;
      if (offset === 0 && raw === '*/0' && Array.isArray(rows) && rows.length === 0) {
        exactEmpty = true;
        return { rows, totalCount: 0 };
      }
      if (!match || !Array.isArray(rows) || Number(match[1]) !== offset ||
          Number(match[2]) !== offset + rows.length - 1) throw new Error(`Catalog ${table}: invalid range or count.`);
      return { rows, totalCount: Number(match[3]) };
    },
    });
  } catch (error) {
    if (allowEmpty && exactEmpty && error.message === `Catalog ${table}: missing, short or extra page.`) return [];
    throw error;
  }
  return captured[table].rows;
}

export function deterministicFixtureId({ scenario, role, name } = {}) {
  for (const part of [scenario, role, name]) {
    if (typeof part !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(part)) throw new Error('Fixture identity requires named TEST scenario, role and object.');
  }
  const hex = createHash('sha256').update(`ihomecrm:test:contract-lifecycle:v1\0${scenario}\0${role}\0${name}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function fixtureLedger() {
  const recorded = [];
  return Object.freeze({
    record(table, identity) {
      if (!IDENT.test(table ?? '')) throw new Error('Fixture cleanup requires a named table.');
      const id = deterministicFixtureId(identity);
      recorded.push({ table, id });
      return id;
    },
    async cleanup(deleteById) {
      if (typeof deleteById !== 'function') throw new Error('Fixture delete-by-ID callback required.');
      for (const { table, id } of [...recorded].reverse()) await deleteById(table, id);
      recorded.length = 0;
    },
  });
}

export function makeReport({ runId, gitSha, targetRef, checks, time = new Date().toISOString() } = {}) {
  validateTestTarget({ expectedRef: targetRef, url: `https://${targetRef}.supabase.co` });
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(runId) || !SHA.test(gitSha ?? '') ||
      !checks || typeof checks !== 'object' || Object.keys(checks).length === 0 || !Number.isFinite(Date.parse(time))) {
    throw new Error('Incomplete TEST report metadata.');
  }
  const safe = {};
  for (const [name, check] of Object.entries(checks)) {
    if (!IDENT.test(name) || typeof check?.pass !== 'boolean') throw new Error('Each named TEST check needs an explicit result.');
    safe[name] = { pass: check.pass };
  }
  return { runId, gitSha, targetRef, time, checks: safe };
}
