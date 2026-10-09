import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { test } from 'node:test';
import { configuration, createGateway } from './server.mjs';

const upstream = 'https://example.supabase.co/functions/v1/bank-event-ingest';
const id = 'b'.repeat(64);
const event = { schemaVersion: 1, event: 'sms.received', id,
  deviceId: 'a6406bbe-c6f9-4cc2-86b6-4dd5b5e0be64', sender: 'BANK', body: 'Test synthetic', receivedAt: '2026-10-09T00:00:00Z' };
const receipt = { schemaVersion: 1, ok: true, data: {
  status: 'accepted', eventId: 'ec16e16e-5409-4f1a-8f9e-15a016a601e4',
  sourceId: 'f38a89df-104e-4c8e-91a9-204138a7402b', externalId: id, acceptedAt: '2026-10-09T00:00:01Z',
} };
const auth = `Bearer ${'t'.repeat(48)}`;
const headers = { Authorization: auth, 'X-Idempotency-Key': id, 'Content-Type': 'application/json' };

async function fixture(t, fetchImpl, options = {}) {
  const server = createGateway({ upstream, fetchImpl, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('configuration is HTTPS-only and pins the exact function path without credentials or query', () => {
  assert.equal(configuration({ BANK_EVENT_UPSTREAM: upstream }).port, 8791);
  for (const url of ['http://example.com/functions/v1/bank-event-ingest',
    'https://user:password@example.com/functions/v1/bank-event-ingest',
    `${upstream}?target=other`, `${upstream}#key`, 'https://example.com/other']) {
    assert.throws(() => configuration({ BANK_EVENT_UPSTREAM: url }));
  }
});

test('forwards only authenticated immutable body and returns the durable receipt', async t => {
  let calls = 0;
  const base = await fixture(t, async (url, init) => {
    calls++;
    assert.equal(url, upstream);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, auth);
    assert.equal(init.headers['X-Idempotency-Key'], id);
    assert.deepEqual(JSON.parse(init.body), event);
    assert.equal(Object.keys(init.headers).length, 3);
    return Response.json(receipt, { status: 201 });
  });
  const response = await fetch(`${base}/webhooks/sms`, { method: 'POST', headers, body: JSON.stringify(event) });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), receipt);
  assert.equal(calls, 1);
});

test('duplicate and heartbeat acknowledgements require a matching external event ID', async t => {
  let next = { ...receipt, data: { ...receipt.data, status: 'duplicate' } };
  const base = await fixture(t, async () => Response.json(next));
  const post = body => fetch(`${base}/webhooks/sms`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post(event)).status, 200);
  next = { ...receipt, data: { ...receipt.data, status: 'heartbeat', eventId: null } };
  assert.equal((await post({ ...event, event: 'gateway.heartbeat' })).status, 200);
  next.data.externalId = 'c'.repeat(64);
  assert.equal((await post({ ...event, event: 'gateway.heartbeat' })).status, 502);
});

test('invalid auth, ID mismatch, event type and payloads do not reach upstream', async t => {
  const base = await fixture(t, async () => { throw new Error('Should not be called'); });
  const post = (h, body) => fetch(`${base}/webhooks/sms`, { method: 'POST', headers: h, body });
  assert.equal((await post({ ...headers, Authorization: '' }, JSON.stringify(event))).status, 401);
  assert.equal((await post({ ...headers, Authorization: 'Bearer short' }, JSON.stringify(event))).status, 401);
  assert.equal((await post(headers, JSON.stringify({ ...event, id: 'c'.repeat(64) }))).status, 400);
  assert.equal((await post(headers, JSON.stringify({ ...event, event: 'email.received' }))).status, 400);
  assert.equal((await post(headers, '{bad')).status, 400);
  assert.equal((await post({ ...headers, 'Content-Type': 'text/plain' }, '{}')).status, 415);
  assert.equal((await post({ ...headers, 'Content-Encoding': 'gzip' }, '{}')).status, 415);
  assert.equal((await post(headers, 'x'.repeat(65537))).status, 413);
});

test('rejects duplicate authentication headers rather than choosing an ambiguous credential', async t => {
  const base = await fixture(t, async () => { throw new Error('Should not be called'); });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/webhooks/sms`, {
      method: 'POST', headers: ['Host', new URL(base).host, 'Authorization', auth, 'Authorization', auth,
        'X-Idempotency-Key', id, 'Content-Type', 'application/json'],
    }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end(JSON.stringify(event));
  });
  assert.equal(status, 401);
});

test('token size includes padding and chunked bodies have the same payload bound', async t => {
  const base = await fixture(t, async () => Response.json(receipt));
  const post = token => fetch(`${base}/webhooks/sms`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${token}` }, body: JSON.stringify(event) });
  assert.equal((await post('x'.repeat(31) + '=')).status, 201);
  assert.equal((await post('x'.repeat(254) + '==')).status, 201);
  assert.equal((await post('x'.repeat(30) + '=')).status, 401);
  assert.equal((await post('x'.repeat(256) + '==')).status, 401);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/webhooks/sms`, { method: 'POST', headers: { ...headers, 'Transfer-Encoding': 'chunked' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write('x'.repeat(32000));
    req.end('x'.repeat(34000));
  });
  assert.equal(status, 413);
});

test('empty, malformed, oversized or unrelated 2xx cannot acknowledge a queued message', async t => {
  let next;
  const base = await fixture(t, async () => next);
  const invalid = [new Response(null, { status: 204 }), new Response('<html>login</html>'),
    Response.json({ ok: true }), Response.json({ ...receipt, data: { ...receipt.data, eventId: null } }),
    Response.json({ ...receipt, data: { ...receipt.data, acceptedAt: 'not-a-date' } }),
    new Response('x'.repeat(8193))];
  for (next of invalid) {
    assert.equal((await fetch(`${base}/webhooks/sms`, { method: 'POST', headers, body: JSON.stringify(event) })).status, 502);
  }
});

test('preserves permanent/transient statuses and never leaks an upstream error body', async t => {
  let status;
  const base = await fixture(t, async () => new Response('sensitive diagnostic token body', { status }));
  for (const [up, expected] of [[400,400], [401,401], [403,403], [409,409], [413,413], [422,422], [429,429], [500,502], [302,502]]) {
    status = up;
    const response = await fetch(`${base}/webhooks/sms`, { method: 'POST', headers, body: JSON.stringify(event) });
    assert.equal(response.status, expected);
    assert.doesNotMatch(await response.text(), /sensitive|diagnostic|token/);
  }
});

test('upstream timeout leaves delivery retryable and releases concurrency', async t => {
  const base = await fixture(t, (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }), { timeoutMs: 100, maxInflight: 1 });
  const first = fetch(`${base}/webhooks/sms`, { method: 'POST', headers, body: JSON.stringify(event) });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await fetch(`${base}/webhooks/sms`, { method: 'POST', headers, body: JSON.stringify(event) })).status, 429);
  assert.equal((await first).status, 504);
  assert.equal((await fetch(`${base}/webhooks/sms`, { method: 'POST', headers, body: JSON.stringify(event) })).status, 504);
});

test('health has no device data and unused routes/methods are not proxied', async t => {
  const base = await fixture(t, async () => { throw new Error('Should not be called'); });
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  assert.equal((await fetch(`${base}/webhooks/sms`)).status, 405);
  assert.equal((await fetch(`${base}/events`)).status, 404);
});
