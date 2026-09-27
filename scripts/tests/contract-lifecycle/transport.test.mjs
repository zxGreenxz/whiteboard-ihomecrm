import assert from 'node:assert/strict';
import { test } from 'node:test';

import { withTestTransaction, createTestHttp, selectAll, deterministicFixtureId, fixtureLedger, makeReport, loadTestCredentials } from './helpers.mjs';

const ref = 'abcdefghijklmnopqrst';
const config = { expectedRef: ref, url: `https://${ref}.supabase.co`, db: { host: 'aws-1-ap-southeast-1.pooler.supabase.com', user: `postgres.${ref}`, database: 'postgres', password: 'secret' } };

test('void RPC 204 succeeds only when the caller explicitly allows empty results', async () => {
  await withTestTransaction(config, {connect:fakeConnect().connect,readOnly:true,run:async verified=>{
    const http=createTestHttp(config,{verified,apiKey:'anon',fetch:async()=>new Response(null,{status:204})});
    assert.equal(await http.rpc('reject_contract_termination_v1',{}, {allowEmpty:true}),null);
    await assert.rejects(http.rpc('reject_contract_termination_v1',{}),/no baseline evidence/);
  }});
});

function fakeConnect(marker = [{ ref }], fail = false) {
  const calls = [];
  const client = { async query(sql) {
    calls.push(sql);
    if (sql.includes('session_user')) return { rows: [{ session_user: 'postgres' }] };
    if (sql.includes('test_env.danh_dau')) return { rows: marker };
    if (fail && sql === 'SELECT fixture') throw new Error('secret failure');
    return { rows: [{ ok: true }] };
  }, async end() { calls.push('CLOSE'); } };
  return { calls, connect: async () => client };
}

test('invalid target and DB user fail before connection', async () => {
  let connected = false;
  const connect = async () => { connected = true; throw Error('connected'); };
  for (const c of [{ ...config, url: 'https://example.com' }, { ...config, db: { ...config.db, user: 'postgres.otherref' } }]) {
    await assert.rejects(withTestTransaction(c, { connect, run: async () => {} }));
  }
  assert.equal(connected, false);
});

test('explicit trusted CA reaches PostgreSQL TLS options without disabling verification', async () => {
  const ca = '-----BEGIN CERTIFICATE-----\nQUJDRA==\n-----END CERTIFICATE-----';
  let options;
  await withTestTransaction({ ...config, db: { ...config.db, ca } }, {
    connect: async (received) => { options = received; return fakeConnect().connect(); },
    readOnly: true,
    run: async () => {},
  });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca });
  await assert.rejects(withTestTransaction({ ...config, db: { ...config.db, ca: 'not a PEM' } }, {
    connect: async () => { throw Error('must not connect'); }, run: async () => {},
  }));
});

test('missing, wrong and multiple markers reject before fixture query and close connection', async () => {
  for (const marker of [[], [{ ref: 'wrong' }], [{ ref }, { ref }]]) {
    const fake = fakeConnect(marker);
    await assert.rejects(withTestTransaction(config, { connect: fake.connect, run: (db) => db.query('SELECT fixture') }));
    assert.equal(fake.calls.includes('SELECT fixture'), false);
    assert.equal(fake.calls.at(-1), 'CLOSE');
  }
});

test('server-side DB user mismatch fails even when client config and marker look correct', async () => {
  const fake = fakeConnect();
  const connect = async (options) => {
    assert.equal(options.user, `postgres.${ref}`);
    const client = await fake.connect();
    const query = client.query;
    client.query = async (sql) => sql.includes('session_user') ? { rows: [{ session_user: 'postgres.otherref' }] } : query(sql);
    return client;
  };
  await assert.rejects(withTestTransaction(config, { connect, run: (db) => db.query('SELECT fixture') }));
  assert.equal(fake.calls.includes('SELECT fixture'), false);
  assert.deepEqual(fake.calls.slice(-2), ['ROLLBACK', 'CLOSE']);
});

test('pooler server role postgres is accepted while login stays project-bound', async () => {
  const fake = fakeConnect();
  const connect = async (options) => {
    assert.equal(options.user, `postgres.${ref}`);
    const client = await fake.connect();
    const query = client.query;
    client.query = async (sql) => sql.includes('session_user') ? { rows: [{ session_user: 'postgres' }] } : query(sql);
    return client;
  };
  assert.equal(await withTestTransaction(config, { connect, readOnly: true, run: async () => 'accepted' }), 'accepted');
});

test('verified transaction uses one connection and commits only by explicit request', async () => {
  const fake = fakeConnect();
  const value = await withTestTransaction(config, { connect: fake.connect, commit: true, run: async (db) => (await db.query('SELECT fixture')).rows[0].ok });
  assert.equal(value, true);
  assert.deepEqual(fake.calls.slice(-3), ['SELECT fixture', 'COMMIT', 'CLOSE']);
  assert.equal(fake.calls.filter((x) => x.includes('test_env.danh_dau')).length, 1);
});

test('query failure rolls back and closes; read-only snapshot rolls back', async () => {
  const failed = fakeConnect([{ ref }], true);
  await assert.rejects(withTestTransaction(config, { connect: failed.connect, commit: true, run: (db) => db.query('SELECT fixture') }), /TEST transaction failed/);
  assert.deepEqual(failed.calls.slice(-2), ['ROLLBACK', 'CLOSE']);
  const snapshot = fakeConnect();
  await withTestTransaction(config, { connect: snapshot.connect, readOnly: true, run: async () => 1 });
  assert.equal(snapshot.calls[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(snapshot.calls.some((sql) => sql.includes('FOR SHARE')), false);
  assert.deepEqual(snapshot.calls.slice(-2), ['ROLLBACK', 'CLOSE']);
});

test('HTTP errors cannot echo tokens; Auth sign-in sends password to exact origin', async () => {
  const secret = 'a-secret-token';
  const urls = [];
  const headers = [];
  const fetch = async (url, init) => { urls.push(url); headers.push(init.headers); return { ok: false, status: 401, headers: new Headers(), async json() { return { code: 'PGRST301', message: secret }; } }; };
  const http = createTestHttp(config, { fetch, apiKey: secret });
  await assert.rejects(http.rpc('check', {}), /verified TEST transaction/);
  await withTestTransaction(config, { connect: fakeConnect().connect, readOnly: true, run: async (verified) => {
    const http = createTestHttp(config, { verified, fetch, apiKey: secret });
    await assert.rejects(http.rpc('check', {}), (e) => e.message.includes('401') && !e.message.includes(secret));
    await assert.rejects(http.signIn({ email: 'test@example.com', password: secret }), (e) => !e.message.includes(secret));
  } });
  assert.deepEqual(urls, [`${config.url}/rest/v1/rpc/check`, `${config.url}/auth/v1/token?grant_type=password`]);
  assert.equal(headers[0]['Content-Profile'], 'public');
  assert.equal(headers[1]['Content-Profile'], undefined);
});

test('Auth sign-in rejects absent, expired and wrong-target admission before fetch', async () => {
  let fetched = false;
  const fetch = async () => { fetched = true; throw Error('unexpected fetch'); };
  const credentials = { email: 'test@example.com', password: 'secret' };
  await assert.rejects(createTestHttp(config, { apiKey: 'anon', fetch }).signIn(credentials), /verified TEST transaction/);
  let expired;
  await withTestTransaction(config, { connect: fakeConnect().connect, readOnly: true, run: async (verified) => {
    expired = createTestHttp(config, { verified, apiKey: 'anon', fetch });
    const otherRef = 'zzzzzzzzzzzzzzzzzzzz';
    const wrong = createTestHttp({ expectedRef: otherRef, url: `https://${otherRef}.supabase.co` }, { verified, apiKey: 'anon', fetch });
    await assert.rejects(wrong.signIn(credentials), /verified TEST transaction/);
  } });
  await assert.rejects(expired.signIn(credentials), /verified TEST transaction/);
  assert.equal(fetched, false);
});

test('malformed successful RPC, Auth and SELECT bodies never expose parser data', async () => {
  const canary = 'CANARY_JWT_AND_PERSONAL_DATA';
  const fetch = async () => ({
    ok: true, status: 200, headers: new Headers({ 'content-range': '0-0/1' }),
    async json() { throw new SyntaxError(`Unexpected token ${canary}`); },
  });
  await withTestTransaction(config, { connect: fakeConnect().connect, readOnly: true, run: async (verified) => {
    const http = createTestHttp(config, { verified, apiKey: 'anon', fetch });
    for (const operation of [
      () => http.rpc('check', {}),
      () => http.signIn({ email: 'test@example.com', password: 'secret' }),
      () => selectAll(http, { table: 'contracts' }),
      () => http.selectPage({ table: 'contracts', offset: 0, limit: 1 }),
    ]) {
      await assert.rejects(operation(), (error) => error.message.includes('invalid JSON') && !error.message.includes(canary));
    }
  } });
});

test('direct SELECT page uses defined default columns, order and filters', async () => {
  let url;
  const fetch = async (requested) => {
    url = requested;
    return { ok: true, status: 200, headers: new Headers({ 'content-range': '0-0/1' }), async json() { return [{ id: 'a' }]; } };
  };
  const page = await createTestHttp(config, { apiKey: 'anon', fetch }).selectPage({ table: 'contracts', offset: 0, limit: 1 });
  assert.deepEqual(page.rows, [{ id: 'a' }]);
  assert.equal(url, `${config.url}/rest/v1/contracts?select=*&order=id.asc`);
});

test('REST filter accepts uppercase enum values but rejects injected operators before fetch', async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, headers: new Headers({ 'content-range': '0-0/1' }), async json() { return [{ id: 'a' }]; } };
  };
  const http = createTestHttp(config, { apiKey: 'anon', fetch });
  const filters = '&type=eq.INCOME&approval_status=eq.APPROVED';
  assert.equal((await selectAll(http, { table: 'income_expenses', filters })).length, 1);
  assert.equal(urls[0], `${config.url}/rest/v1/income_expenses?select=*&order=id.asc${filters}`);
  for (const unsafe of ['&type=eq.INCOME,EXPENSE', '&type=eq.INCOME%26deleted_at=is.null', '&type=eq.INCOME;DROP', '&type=eq.INCOME&x=or.(a,b)']) {
    await assert.rejects(selectAll(http, { table: 'income_expenses', filters: unsafe }));
  }
  assert.equal(urls.length, 1);
});

test('paginated SELECT fetches past 1000 with exact count and order', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => ({ id: String(i).padStart(4, '0') }));
  const ranges = [];
  const fetch = async (_url, init) => {
    const range = init.headers.Range;
    ranges.push(range);
    const [start, end] = range.split('-').map(Number);
    return { ok: true, status: 206, headers: new Headers({ 'content-range': `${start}-${Math.min(end, 1000)}/1001` }), async json() { return rows.slice(start, end + 1); } };
  };
  const actual = await withTestTransaction(config, { connect: fakeConnect().connect, readOnly: true, run: (verified) => selectAll(createTestHttp(config, { verified, fetch, apiKey: 'anon' }), { table: 'contracts', orderBy: 'id', pageSize: 1000 }) });
  assert.equal(actual.length, 1001);
  assert.deepEqual(ranges, ['0-999', '1000-1999']);
});

test('REST SELECT selects public schema explicitly', async () => {
  let headers;
  const fetch = async (_url, init) => {
    headers = init.headers;
    return { ok: true, status: 200, headers: new Headers({ 'content-range': '0-0/1' }), async json() { return [{ id: 'a' }]; } };
  };
  const rows = await selectAll(createTestHttp(config, { apiKey: 'anon', fetch }), { table: 'contracts' });
  assert.deepEqual(rows, [{ id: 'a' }]);
  assert.equal(headers['Accept-Profile'], 'public');
});

test('pagination rejects missing count, changed count, short and unordered pages', async () => {
  for (const response of [
    { range: '0-0/*', rows: [{ id: 'a' }] },
    { range: '0-1/2', rows: [{ id: 'a' }] },
    { range: '0-1/2', rows: [{ id: 'b' }, { id: 'a' }] },
  ]) {
    const fetch = async () => ({ ok: true, status: 206, headers: new Headers({ 'content-range': response.range }), async json() { return response.rows; } });
    await withTestTransaction(config, { connect: fakeConnect().connect, readOnly: true, run: async (verified) => {
      await assert.rejects(selectAll(createTestHttp(config, { verified, fetch, apiKey: 'anon' }), { table: 'contracts', orderBy: 'id', pageSize: 2 }));
    } });
  }
  let page = 0;
  const fetch = async () => {
    page += 1;
    const start = page === 1 ? 0 : 2;
    const count = page === 1 ? 3 : 4;
    return { ok: true, status: 206, headers: new Headers({ 'content-range': `${start}-${start + (page === 1 ? 1 : 0)}/${count}` }), async json() { return page === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }]; } };
  };
  await withTestTransaction(config, { connect: fakeConnect().connect, readOnly: true, run: async (verified) => {
    await assert.rejects(selectAll(createTestHttp(config, { verified, fetch, apiKey: 'anon' }), { table: 'contracts', orderBy: 'id', pageSize: 2 }), /count changed/);
  } });
});

test('empty SELECT is admitted only with explicit allowEmpty and exact zero count', async () => {
  const fetch = async () => ({ ok: true, status: 200, headers: new Headers({ 'content-range': '*/0' }), async json() { return []; } });
  await withTestTransaction(config, { connect: fakeConnect().connect, readOnly: true, run: async (verified) => {
    const http = createTestHttp(config, { verified, fetch, apiKey: 'anon' });
    await assert.rejects(selectAll(http, { table: 'contracts' }));
    assert.deepEqual(await selectAll(http, { table: 'contracts', allowEmpty: true }), []);
  } });
});

test('HTTP context expires when marker transaction ends', async () => {
  let http;
  await withTestTransaction(config, { connect: fakeConnect().connect, readOnly: true, run: async (verified) => {
    http = createTestHttp(config, { verified, apiKey: 'anon', fetch: async () => { throw Error('must not fetch'); } });
  } });
  await assert.rejects(http.rpc('check', {}), /verified TEST transaction/);
});

test('RPC rejects a verified context for another TEST ref before fetch', async () => {
  let fetched = false;
  const otherRef = 'zzzzzzzzzzzzzzzzzzzz';
  await withTestTransaction(config, { connect: fakeConnect().connect, readOnly: true, run: async (verified) => {
    const http = createTestHttp({ expectedRef: otherRef, url: `https://${otherRef}.supabase.co` }, { verified, apiKey: 'anon', fetch: async () => { fetched = true; throw Error('wrong target'); } });
    await assert.rejects(http.rpc('check', {}), /verified TEST transaction/);
  } });
  assert.equal(fetched, false);
});

test('RPC cannot run while a writable SQL transaction may hold business locks', async () => {
  let fetched = false;
  await withTestTransaction(config, { connect: fakeConnect().connect, run: async (verified) => {
    const http = createTestHttp(config, { verified, apiKey: 'anon', fetch: async () => { fetched = true; throw Error('must not fetch'); } });
    await assert.rejects(http.rpc('check', {}), /verified TEST transaction/);
  } });
  assert.equal(fetched, false);
});

test('fixture IDs isolate scenario and role; ledger cleans only recorded IDs', async () => {
  const a = deterministicFixtureId({ scenario: 'deferred', role: 'manager', name: 'lease' });
  assert.equal(a, deterministicFixtureId({ scenario: 'deferred', role: 'manager', name: 'lease' }));
  assert.notEqual(a, deterministicFixtureId({ scenario: 'deferred', role: 'sale', name: 'lease' }));
  const ledger = fixtureLedger();
  assert.equal(ledger.record('contracts', { scenario: 'deferred', role: 'manager', name: 'lease' }), a);
  assert.throws(() => ledger.record('contracts', a));
  const deleted = [];
  await ledger.cleanup(async (table, id) => deleted.push([table, id]));
  assert.deepEqual(deleted, [['contracts', a]]);
});

test('report contains named checks and no secret values', () => {
  const report = makeReport({ runId: 'run-1', gitSha: 'a'.repeat(40), targetRef: ref, checks: { marker: { pass: true, token: 'secret', rows: [{ email: 'pii' }] } } });
  assert.deepEqual(report.checks, { marker: { pass: true } });
  assert.equal(JSON.stringify(report).includes('secret'), false);
  assert.equal(JSON.stringify(report).includes('pii'), false);
});

test('credential loader is explicit and needs no production credentials', () => {
  assert.deepEqual(loadTestCredentials({ env: { TEST_SUPABASE_REF: ref, TEST_SUPABASE_DB_PASSWORD: 'x', TEST_SUPABASE_POOLER_HOST: config.db.host } }), { expectedRef: ref, url: config.url, db: { host: config.db.host, user: `postgres.${ref}`, database: 'postgres', password: 'x', port: 5432 } });
});
