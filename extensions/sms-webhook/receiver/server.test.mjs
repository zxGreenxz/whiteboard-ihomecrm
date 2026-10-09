import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createReceiver } from './server.mjs';

const TOKEN = 'test-fixture-only-'.repeat(4);
const sms = (overrides = {}) => ({
  schemaVersion: 1,
  event: 'sms.received',
  id: 'a'.repeat(64),
  deviceId: 'dc9c3d8a-468e-48bd-b50b-272bebd2c912',
  sender: 'DEMO',
  body: 'Nội dung thử nghiệm\nDòng thứ hai 😊',
  receivedAt: '2026-10-09T01:02:03.456Z',
  subscriptionId: null,
  ...overrides,
});
const notification = (overrides = {}) => ({
  schemaVersion: 1,
  event: 'notification.received',
  id: 'b'.repeat(64),
  deviceId: sms().deviceId,
  receivedAt: '2026-10-09T08:02:03+07:00',
  packageName: 'vn.example.demobank',
  appName: 'Ngân hàng DEMO',
  title: 'Thông báo thử nghiệm',
  body: 'Đây là dữ liệu giả lập.\nKhông có tài khoản thật.',
  ...overrides,
});

async function fixture(t, token = TOKEN) {
  const directory = await mkdtemp(join(tmpdir(), 'sms-webhook-test-'));
  const dbPath = join(directory, 'events.sqlite');
  let server;
  const context = {
    dbPath,
    async start() {
      server = createReceiver({ token, dbPath });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      context.url = `http://127.0.0.1:${server.address().port}`;
    },
    async stop() {
      if (!server) return;
      const closed = once(server, 'close');
      server.close();
      server.closeIdleConnections();
      await closed;
      server = undefined;
    },
    async post(value = sms(), headers = {}, body = JSON.stringify(value)) {
      const response = await fetch(`${context.url}/webhooks/sms`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          Authorization: `Bearer ${token}`,
          'X-Idempotency-Key': value.id,
          ...headers,
        },
        body,
      });
      return { status: response.status, data: await response.json() };
    },
  };
  t.after(async () => {
    await context.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await context.start();
  return context;
}

function rows(dbPath) {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return database.prepare('SELECT payload FROM received_events ORDER BY id').all()
      .map(({ payload }) => JSON.parse(payload));
  } finally { database.close(); }
}

function rawPost(url, headers, chunks) {
  return new Promise((resolveResponse, reject) => {
    const req = request(`${url}/webhooks/sms`, { method: 'POST', headers }, (response) => {
      response.resume();
      response.once('end', () => resolveResponse(response.statusCode));
    });
    req.once('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
}

test('authentication rejects missing, wrong and duplicate credentials before storage', async (t) => {
  const f = await fixture(t);
  for (const authorization of ['', 'Bearer short', `Bearer ${'x'.repeat(TOKEN.length)}`, `Basic ${TOKEN}`]) {
    assert.equal((await f.post(sms(), { Authorization: authorization })).status, 401);
  }
  const code = await rawPost(f.url, {
    Authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`],
    'Content-Type': 'application/json',
    'X-Idempotency-Key': sms().id,
  }, [JSON.stringify(sms())]);
  assert.equal(code, 401);
  assert.deepEqual(rows(f.dbPath), []);
  assert.throws(() => createReceiver({ token: 'short', dbPath: f.dbPath }), /WEBHOOK_TOKEN/);
});

test('configured token grammar matches Android Bearer token support', async (t) => {
  const f = await fixture(t, 'ABCdef012._~+/-'.repeat(3) + '==');
  assert.equal((await f.post()).status, 201);
  for (const token of [
    'a'.repeat(31), 'a'.repeat(257), 'a'.repeat(32) + '@',
    'a'.repeat(32) + '===', 'a'.repeat(32) + '=b', 'a'.repeat(32) + ' ',
  ]) assert.throws(() => createReceiver({ token, dbPath: f.dbPath }), /WEBHOOK_TOKEN/);
});

test('Unicode and newlines persist exactly; duplicate delivery survives server restart', async (t) => {
  const f = await fixture(t);
  const value = sms();
  assert.deepEqual(await f.post(value), { status: 201, data: { status: 'accepted' } });
  assert.deepEqual(rows(f.dbPath), [value]);
  await f.stop();
  await f.start();
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  assert.deepEqual(await f.post(reordered), { status: 200, data: { status: 'duplicate' } });
  assert.deepEqual(rows(f.dbPath), [value]);
  assert.equal((await f.post(sms({ body: 'Khác nội dung' }))).status, 409);
  assert.deepEqual(rows(f.dbPath), [value]);
});

test('notification payloads are a distinct authenticated, idempotent event union', async (t) => {
  const f = await fixture(t);
  const value = notification();
  assert.equal((await f.post(value, { Authorization: '' })).status, 401);
  assert.equal((await f.post(value)).status, 201);
  assert.equal((await f.post(value)).status, 200);
  assert.equal((await f.post(sms({ id: value.id }))).status, 409);
  for (const invalid of [
    notification({ sender: 'DEMO' }), notification({ packageName: '' }),
    notification({ packageName: 'a'.repeat(256) }), notification({ title: '😊'.repeat(129) }),
    notification({ appName: 123 }), notification({ appName: 'a'.repeat(513) }),
    { ...sms(), event: 'notification.received' },
  ]) assert.equal((await f.post(invalid)).status, 400);
  assert.deepEqual(rows(f.dbPath), [value]);
});

test('invalid schema, timestamps, idempotency and UTF-8 cannot enter storage', async (t) => {
  const f = await fixture(t);
  const invalidValues = [
    sms({ event: 'unknown' }), sms({ schemaVersion: 2 }), sms({ id: 'A'.repeat(64) }),
    sms({ deviceId: 'not-a-uuid' }), sms({ sender: 1 }), sms({ sender: 'a'.repeat(257) }),
    sms({ subscriptionId: 1.1 }), sms({ subscriptionId: '1' }), sms({ body: '\ud800' }),
    sms({ body: null }), sms({ extra: 'unexpected' }),
    sms({ receivedAt: '2026-02-30T01:02:03Z' }), sms({ receivedAt: '2026-10-09' }),
    sms({ receivedAt: '2026-10-09T24:02:03Z' }), sms({ receivedAt: '2026-10-09T01:02:60Z' }),
    sms({ receivedAt: '2026-10-09T01:02:03+25:00' }),
  ];
  for (const value of invalidValues) assert.equal((await f.post(value)).status, 400);
  for (const body of ['null', '[]', '{', '{}']) assert.equal((await f.post(sms(), {}, body)).status, 400);
  assert.equal((await f.post(sms(), { 'X-Idempotency-Key': 'c'.repeat(64) })).status, 400);
  assert.equal((await f.post(sms(), { 'X-Idempotency-Key': '' })).status, 400);
  assert.equal((await f.post(sms(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post(sms(), { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal(await rawPost(f.url, {
    Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
    'X-Idempotency-Key': sms().id,
  }, [Buffer.from([0xff])]), 400);
  assert.deepEqual(rows(f.dbPath), []);
});

test('UTF-8 body limit and JSON limits apply to Content-Length and chunked uploads', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(sms({ body: '😊'.repeat(2048) }))).status, 201);
  assert.equal((await f.post(sms({ id: 'c'.repeat(64), body: '😊'.repeat(2049) }))).status, 400);
  const controls = sms({ id: 'd'.repeat(64), body: '\u0001'.repeat(8192) });
  assert.equal((await f.post(controls)).status, 201);
  assert.equal((await f.post(sms({ id: 'e'.repeat(64), body: '\u0001'.repeat(8193) }))).status, 400);
  assert.deepEqual(rows(f.dbPath).find((value) => value.id === controls.id), controls);
  assert.equal((await f.post(sms(), {}, ' '.repeat(64 * 1024 + 1))).status, 413);
  assert.equal(await rawPost(f.url, {
    Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
    'X-Idempotency-Key': sms().id, 'Transfer-Encoding': 'chunked',
  }, [Buffer.alloc(32 * 1024, 32), Buffer.alloc(32 * 1024 + 1, 32)]), 413);
  assert.equal(rows(f.dbPath).length, 2);
});

test('storage failure returns retryable 503, then accepts retry after the lock is released', async (t) => {
  const f = await fixture(t);
  const locked = new DatabaseSync(f.dbPath);
  try {
    locked.exec('BEGIN IMMEDIATE');
    const response = await f.post(sms());
    assert.deepEqual(response, { status: 503, data: { status: 'storage_unavailable' } });
    locked.exec('ROLLBACK');
  } finally { locked.close(); }
  assert.deepEqual(rows(f.dbPath), []);
  assert.equal((await f.post()).status, 201);
  assert.equal((await f.post()).status, 200);
  assert.equal(rows(f.dbPath).length, 1);
});

test('test events can be stored and health exposes no SMS data', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(sms({ event: 'gateway.test', receivedAt: '2024-02-29T01:02:03.123456789Z' }))).status, 201);
  const health = await fetch(`${f.url}/health`);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const unknown = await fetch(`${f.url}/events`);
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { status: 'not_found' });
});
