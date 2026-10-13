import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createGatewayRelay } from './gateway-relay.mjs';

const tick = () => new Promise(done => setImmediate(done));
async function fixture(t, responder, options = {}) {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\hermes-${randomUUID()}` : path.join(os.tmpdir(), `hermes-${randomUUID()}.sock`);
  const calls = [];
  const peer = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const entry = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() }; calls.push(entry);
    if (responder) responder(req, res, entry);
    else { res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'FORBIDDEN=private', authorization: 'Bearer PRIVATE' }); res.end(JSON.stringify({ ok: true })); }
  });
  await new Promise(done => peer.listen(socketPath, done));
  const relay = createGatewayRelay({ socketPath, listenHost: '127.0.0.1', port: 0, ...options });
  await relay.start();
  t.after(async () => { await relay.close(); const stopped = new Promise(done => peer.close(done)); peer.closeAllConnections(); await stopped; });
  const send = (url = '/mcp', body = '{}', headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: relay.server.address().port, path: url, method,
      headers: { host: 'hermes-gateway:8787', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, res => {
      const chunks = []; res.on('data', part => chunks.push(part)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body);
  });
  return { relay, peer, calls, send, socketPath };
}

test('one mounted socket is the only destination; dummy SDK bearer and response headers never propagate', async t => {
  const f = await fixture(t);
  const sent = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
  const reply = await f.send('/mcp', sent, { authorization: 'Bearer gateway-no-credential', 'mcp-protocol-version': '2025-03-26' });
  assert.equal(reply.status, 200); assert.equal(reply.headers['set-cookie'], undefined); assert.equal(reply.headers.authorization, undefined);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body, sent); assert.equal(f.calls[0].headers.authorization, undefined);
  assert.equal(f.calls[0].headers.host, 'hermes-gateway:8787'); assert.equal(f.calls[0].headers['mcp-protocol-version'], '2025-03-26');
  assert.equal((await f.send('/v1/chat/completions')).status, 200);
});

test('foreign routing, authorization, proxy identity and non-JSON requests stop before socket I/O', async t => {
  const f = await fixture(t);
  for (const [url, headers, method] of [
    ['/mcp?user=other', {}, 'POST'], ['http://other/mcp', {}, 'POST'], ['/mcp', {}, 'GET'],
    ['/mcp', { host: 'other:8787' }, 'POST'], ['/mcp', { authorization: 'Bearer OTHER-SECRET' }, 'POST'],
    ['/mcp', { origin: 'https://other' }, 'POST'], ['/mcp', { 'x-organization-id': 'other' }, 'POST'],
    ['/mcp', { 'x-forwarded-host': 'other' }, 'POST'], ['/mcp', { cookie: 'session=other' }, 'POST'],
    ['/mcp', { 'content-encoding': 'gzip' }, 'POST'], ['/mcp', { 'content-type': 'text/plain' }, 'POST'],
  ]) {
    const result = await f.send(url, '{}', headers, method); assert.ok([400, 404].includes(result.status));
    assert(!result.body.includes('OTHER-SECRET'));
  }
  assert.equal(f.calls.length, 0);
});

test('two relays route only to their respective sockets and cannot select another profile by headers', async t => {
  const answer = user => (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ user })); };
  const a = await fixture(t, answer('A')), b = await fixture(t, answer('B'));
  assert.equal(JSON.parse((await a.send()).body).user, 'A'); assert.equal(JSON.parse((await b.send()).body).user, 'B');
  assert.equal((await a.send('/mcp', '{}', { 'x-user-id': 'B' })).status, 400);
  assert.equal(a.calls.length, 1); assert.equal(b.calls.length, 1);
});

test('request/response sizes and upstream redirects are bounded, sanitized and never retried', async t => {
  const small = await fixture(t, null, { maxRequestBytes: 8 });
  assert.equal((await small.send('/mcp', 'x'.repeat(9))).status, 413); assert.equal(small.calls.length, 0);
  const oversized = await fixture(t, (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('PRIVATE'.repeat(50)); }, { maxResponseBytes: 8 });
  const result = await oversized.send(); assert.equal(result.status, 503); assert(!result.body.includes('PRIVATE')); assert.equal(oversized.calls.length, 1);
  const redirect = await fixture(t, (_req, res) => { res.writeHead(302, { 'content-type': 'application/json', location: 'http://outside' }); res.end('{}'); });
  assert.equal((await redirect.send()).status, 503); assert.equal(redirect.calls.length, 1);
});

test('timed-out upstream is not retried and closes capacity only after outgoing socket closes', async t => {
  const f = await fixture(t, () => {}, { timeoutMs: 20, maxConcurrent: 1 });
  const first = f.send();
  while (!f.calls.length) await tick();
  assert.equal((await f.send()).status, 429);
  assert.equal((await first).status, 503); await tick(); assert.equal(f.calls.length, 1);
  const close = f.relay.close(); assert.equal(close, f.relay.close()); await close;
});

test('configuration cannot bind public/wildcard listeners or accept a relative socket', () => {
  for (const change of [{ listenHost: '0.0.0.0' }, { listenHost: '8.8.8.8' }, { listenHost: '::' }, { socketPath: '../other.sock' },
    { socketPath: '/run/../other.sock' }, { maxConcurrent: 5 }, { maxResponseBytes: 131073 }]) {
    assert.throws(() => createGatewayRelay({ socketPath: '/run/hermes/gateway.sock', listenHost: '10.0.0.2', ...change }), /invalid_gateway_relay_config/);
  }
});
