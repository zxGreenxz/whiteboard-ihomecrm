import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createHermesFrontendProxy } from './frontend-proxy.mjs';

const CRM = 'https://crm.example.test', UPSTREAM = 'https://hermes.example.test';
const JWT = 'Bearer synthetic.jwt.signature';
const BODY = '{"organizationId":"10000000-0000-4000-8000-000000000001"}';
const ops = { connections: ['connect','list','context','options','restrict','revoke','status'],
  zalo: ['bots','manageBots','setBot','begin','status','confirm','unlink','list'] };
const send = (port, { path = '/api/hermes/connections/list', method = 'POST', body = BODY, headers = {}, chunked = false } = {}) =>
  new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, method, headers: {
      host: 'crm.example.test', origin: CRM, authorization: JWT, 'content-type': 'application/json',
      ...(!chunked ? { 'content-length': Buffer.byteLength(body) } : {}), ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
async function fixture(t, { remote, timeoutMs = 1000, ...config } = {}) {
  const observed = [];
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }; observed.push(call);
    if (remote) remote(req, res, call);
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const calls = [];
  const transport = (url, options, cb) => {
    calls.push({ url: url.href, options });
    // The only test substitution is network routing into this local HTTP
    // fixture. Product defaults use native HTTPS with normal TLS verification.
    return httpRequest({ ...options, hostname: '127.0.0.1', port: upstream.address().port,
      path: url.pathname, headers: { ...options.headers, host: url.host } }, cb);
  };
  const shared = { upstreamOrigin: UPSTREAM, crmOrigin: CRM, request: transport, timeoutMs, ...config };
  const handlers = Object.fromEntries(Object.keys(ops).map(family => [family, createHermesFrontendProxy({ ...shared, family })]));
  const front = createServer((req, res) => {
    // Vercel helpers expose lazy properties; route forwarding must not use them.
    Object.defineProperties(req, { body: { get() { throw new Error('must_not_read_body_helper'); } },
      query: { get() { throw new Error('must_not_read_route_query'); } } });
    const family = req.url.startsWith('/api/hermes/zalo/') ? 'zalo' : 'connections';
    void handlers[family](req, res);
  });
  front.listen(0, '127.0.0.1'); await once(front, 'listening');
  t.after(async () => { front.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => front.close(resolve)), new Promise(resolve => upstream.close(resolve))]); });
  return { calls, observed, send: input => send(front.address().port, input), port: front.address().port };
}
const payload = result => JSON.parse(result.text);

test('all existing connection and Zalo routes traverse an actual Node HTTP handler', async t => {
  const f = await fixture(t);
  for (const [family, operations] of Object.entries(ops)) for (const operation of operations) {
    const path = `/api/hermes/${family}/${operation}`;
    assert.equal((await f.send({ path })).status, 200);
    assert.equal(f.calls.at(-1).url, UPSTREAM + path);
    assert.equal(f.observed.at(-1).body, BODY);
  }
  assert.equal(f.calls.length, 15);
});

test('only fixed transport headers pass; host, cookies and upstream response headers are not copied', async t => {
  const f = await fixture(t, { remote(req, res) {
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'upstream=private', location: 'https://evil.test',
      authorization: 'private', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=60' });
    res.end('{"ok":true}');
  } });
  const result = await f.send({ body: '{ "password" : "synthetic-only" }', headers: { cookie: 'private=cookie',
    'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http', 'x-upstream-url': 'https://evil.test', 'x-api-key': 'private' } });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(f.calls[0].options.headers).sort(), ['accept','authorization','content-length','content-type','origin']);
  assert.equal(f.observed[0].headers.host, 'hermes.example.test');
  assert.equal(f.observed[0].headers.authorization, JWT); assert.equal(f.observed[0].headers.origin, CRM);
  assert.equal(f.observed[0].body, '{ "password" : "synthetic-only" }');
  for (const key of ['set-cookie','authorization','location','access-control-allow-origin']) assert.equal(result.headers[key], undefined);
  assert.equal(result.headers['cache-control'], 'private, no-store');
});

test('missing or invalid server configuration never dispatches', async t => {
  for (const upstreamOrigin of [undefined, '', 'http://hermes.example.test', 'https://user:pass@hermes.example.test',
    'https://hermes.example.test/path', 'https://hermes.example.test?next=1', CRM]) {
    const f = await fixture(t, { upstreamOrigin });
    const result = await f.send(); assert.equal(result.status, 503); assert.equal(payload(result).error, 'backend_unavailable');
    assert.equal(f.calls.length, 0);
  }
});

test('noncanonical paths cannot select another operation, host or route', async t => {
  const f = await fixture(t);
  for (const path of ['/api/hermes/connections/list?operation=revoke', '/api/hermes/connections/list/',
    '/api/hermes/connections/%6cist', '/api/hermes/connections/list/extra', '/api/hermes/connections/../zalo/setBot',
    '/api/hermes/connections/https://evil.test', '/api/hermes/other/list', '/api/hermes/connections/[operation].js']) {
    assert.equal((await f.send({ path })).status, 404);
  }
  assert.equal(f.calls.length, 0);
});

test('Vercel dynamic route metadata is accepted only when it agrees with the fixed pathname', async t => {
  const f = await fixture(t);
  for (const [family, operations] of Object.entries(ops)) for (const operation of operations) {
    const path = `/api/hermes/${family}/${operation}`;
    assert.equal((await f.send({ path: `${path}?operation=${operation}` })).status, 200);
    assert.equal(f.calls.at(-1).url, UPSTREAM + path);
  }
  for (const suffix of ['operation=revoke', 'operation=list&operation=revoke', 'operation=list&upstream=https://evil.test',
    'operation=%6cist', 'other=list']) assert.equal((await f.send({ path: `/api/hermes/connections/list?${suffix}` })).status, 404);
  assert.equal(f.calls.length, 15);
});

test('method, origin, host and bearer boundaries reject before upstream', async t => {
  const f = await fixture(t);
  for (const input of [{ method: 'GET' }, { method: 'OPTIONS' }, { headers: { origin: 'https://evil.test' } },
    { headers: { host: 'evil.test', 'x-forwarded-host': 'crm.example.test' } }, { headers: { origin: '' } },
    { headers: { 'sec-fetch-site': 'cross-site' } }, { headers: { authorization: '' } },
    { headers: { authorization: ['Bearer first.jwt.token', 'Bearer other.jwt.token'] } }]) {
    const result = await f.send(input); assert.ok([400,401,403,405].includes(result.status));
  }
  assert.equal(f.calls.length, 0);
});

test('byte caps, JSON/UTF-8 and encoding validation precede dispatch, including chunked bodies', async t => {
  const f = await fixture(t);
  const cases = [{ body: '{bad' }, { body: '[]' }, { body: Buffer.from([0xff]) }, { headers: { 'content-type': 'text/plain' } },
    { headers: { 'content-encoding': 'gzip' } }, { body: JSON.stringify({ text: 'x'.repeat(65536) }) },
    { path: '/api/hermes/zalo/begin', body: JSON.stringify({ text: 'x'.repeat(4096) }), chunked: true }];
  for (const input of cases) assert.ok([400,413,415].includes((await f.send(input)).status));
  assert.equal(f.calls.length, 0);
});

test('host denial and reconciliation receipts pass through without inventing an outcome', async t => {
  const raw = '{"error":"activation_outcome_unknown","receipt":{"connectionId":"a","operationId":"b"}}';
  const f = await fixture(t, { remote(req, res) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(raw); } });
  const result = await f.send({ path: '/api/hermes/connections/connect' });
  assert.equal(result.status, 503); assert.equal(result.text, raw); assert.equal(f.calls.length, 1);
});

test('redirects are never followed and dispatched writes remain unknown', async t => {
  const f = await fixture(t, { remote(req, res) { res.writeHead(307, { location: 'https://evil.test', 'content-type': 'application/json' }); res.end('{}'); } });
  for (const [path, code] of [['/api/hermes/connections/revoke','operation_outcome_unknown'],
    ['/api/hermes/zalo/confirm','binding_outcome_unknown'], ['/api/hermes/connections/list','backend_unavailable']]) {
    const result = await f.send({ path }); assert.equal(result.status, 503); assert.equal(payload(result).error, code);
  }
  assert.equal(f.calls.length, 3);
});

test('malformed/oversized/encoded upstream output is bounded and never relayed as success', async t => {
  for (const mode of ['html','invalid-json','invalid-utf8','encoded','declared-large','stream-large']) {
    const f = await fixture(t, { remote(req, res) {
      const headers = { 'content-type': mode === 'html' ? 'text/html' : 'application/json' };
      if (mode === 'encoded') headers['content-encoding'] = 'gzip';
      if (mode === 'declared-large') headers['content-length'] = '65537';
      res.writeHead(200, headers);
      res.end(mode === 'invalid-utf8' ? Buffer.from([0xff]) : mode === 'stream-large' ? JSON.stringify({ text: 'x'.repeat(65536) }) : '<PRIVATE>');
    } });
    const result = await f.send({ path: '/api/hermes/zalo/begin' });
    assert.equal(result.status, 503); assert.deepEqual(payload(result), { error: 'binding_outcome_unknown' });
    assert.equal(f.calls.length, 1);
  }
});

test('deadline after dispatch distinguishes reads and writes and never retries', async t => {
  const f = await fixture(t, { timeoutMs: 40, remote() {} });
  for (const [path, status, code] of [['/api/hermes/connections/list',504,'timeout'],
    ['/api/hermes/connections/connect',503,'operation_outcome_unknown'], ['/api/hermes/zalo/setBot',503,'binding_outcome_unknown']]) {
    const result = await f.send({ path }); assert.equal(result.status, status); assert.equal(payload(result).error, code);
  }
  assert.equal(f.calls.length, 3);
});

test('upstream socket loss after a write has exactly one dispatch and an unknown result', async t => {
  const f = await fixture(t, { remote(req) { req.socket.destroy(); } });
  const result = await f.send({ path: '/api/hermes/connections/restrict' });
  assert.equal(result.status, 503); assert.equal(payload(result).error, 'operation_outcome_unknown'); assert.equal(f.calls.length, 1);
});

test('warm-instance concurrent work is bounded until the upstream actually closes', async t => {
  let started; const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, { maxConcurrent: 1, timeoutMs: 150, remote() { started(); } });
  const pending = f.send(); await began;
  const busy = await f.send(); assert.equal(busy.status, 429); assert.equal(payload(busy).error, 'busy');
  assert.equal(f.calls.length, 1); assert.equal((await pending).status, 504);
});

test('deadline while reading the browser body never starts upstream work', async t => {
  const f = await fixture(t, { timeoutMs: 40 });
  const result = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: f.port, path: '/api/hermes/connections/connect', method: 'POST',
      headers: { host: 'crm.example.test', origin: CRM, authorization: JWT, 'content-type': 'application/json', 'content-length': '100' } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => { resolve({ status: res.statusCode, text }); req.destroy(); });
    });
    req.on('error', reject); req.write('{');
  });
  assert.equal(result.status, 504); assert.equal(payload(result).error, 'timeout'); assert.equal(f.calls.length, 0);
});

test('both Vercel file entries load with missing config and fail closed on their own family', async t => {
  const before = [process.env.HERMES_UPSTREAM_ORIGIN, process.env.HERMES_CRM_ORIGIN];
  delete process.env.HERMES_UPSTREAM_ORIGIN; delete process.env.HERMES_CRM_ORIGIN;
  try {
    for (const family of Object.keys(ops)) {
      const entry = await import(`../../api/hermes/${family}/[operation].js`);
      assert.equal(entry.config.maxDuration, 60);
      const server = createServer(entry.default); server.listen(0, '127.0.0.1'); await once(server, 'listening');
      t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
      const result = await send(server.address().port, { path: `/api/hermes/${family}/list` });
      assert.equal(result.status, 503); assert.equal(payload(result).error, 'backend_unavailable');
    }
  } finally {
    for (const [index, name] of ['HERMES_UPSTREAM_ORIGIN','HERMES_CRM_ORIGIN'].entries()) {
      if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index];
    }
  }
});
