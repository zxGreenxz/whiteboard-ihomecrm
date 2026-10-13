import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { createFixtureBroker } from './fixture.mjs';
import { createMcpHttpHandler, createMcpHttpServer } from './mcp-http.mjs';

async function fixture(t, options) {
  const state = await createFixtureBroker();
  const server = createMcpHttpServer({ broker: state.broker, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { ...state, url, send: async (message, headers = {}, actor = 'a') => {
    const response = await fetch(url, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${state.connections[actor].token}`, ...headers,
    }, body: JSON.stringify(message) });
    return { status: response.status, body: response.status === 202 ? null : await response.json() };
  } };
}
const call = (name = 'crm_auth_context', args = {}) => ({ jsonrpc: '2.0', id: 3,
  method: 'tools/call', params: { name, arguments: args } });

test('real HTTP MCP initialize, notification, list and call work with A/B credentials', async (t) => {
  const f = await fixture(t);
  const initialized = await f.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  } });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.body.result.protocolVersion, '2025-03-26');
  assert.equal((await f.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const list = await f.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.body.result.tools.map((tool) => tool.name), ['crm_auth_context']);
  const a = await f.send(call()), b = await f.send(call(), {}, 'b');
  const resultA = JSON.parse(a.body.result.content[0].text), resultB = JSON.parse(b.body.result.content[0].text);
  assert.equal(resultA.userId, f.connections.a.connection.userId);
  assert.equal(resultB.userId, f.connections.b.connection.userId);
  assert.notEqual(resultA.organizationId, resultB.organizationId);
});

test('tool deny returns MCP isError while raw JWT and revoked credential fail transport authentication', async (t) => {
  const f = await fixture(t);
  for (const message of [call('execute_sql'), call('crm_auth_context', { organizationId: 'foreign' })]) {
    const reply = await f.send(message);
    assert.equal(reply.status, 200); assert.equal(reply.body.result.isError, true);
  }
  assert.equal((await f.send(call(), { authorization: 'Bearer raw-supabase-jwt' })).status, 401);
  await f.broker.revokeConnection(f.connections.a.connection.id);
  assert.equal((await f.send(call())).status, 401);
  assert.equal((await f.send(call(), {}, 'b')).body.result.isError, false);
});

test('host/origin validation, content type, size and strict JSON-RPC reject malformed transport', async (t) => {
  const f = await fixture(t, { maxBodyBytes: 512 });
  // Node fetch normalizes Host. Use a raw HTTP client to actually send the hostile value.
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(f.url, { method: 'POST', headers: {
      host: 'attacker.example', 'content-type': 'application/json',
    } }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end(JSON.stringify(call()));
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await f.send(call(), { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.send(call(), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await f.send(call('crm_auth_context', { padding: 'x'.repeat(1000) }))).status, 413);
  assert.equal((await f.send([call()])).status, 400);
  assert.equal((await f.send({ ...call(), organizationId: 'foreign' })).status, 400);
  assert.equal((await f.send(call(), { 'mcp-protocol-version': 'unknown' })).status, 400);
  const unsupported = await fetch(f.url, { method: 'GET' });
  assert.equal(unsupported.status, 405);
});

test('no management method or arbitrary RPC can be invoked over MCP', async (t) => {
  const f = await fixture(t);
  for (const method of ['issueConnection', 'revokeConnection', 'rpc', 'resources/read']) {
    const reply = await f.send({ jsonrpc: '2.0', id: 1, method, params: {} });
    assert.equal(reply.body.error.code, -32601);
  }
  assert.equal((await f.send(call())).body.result.isError, false);
});

test('HTTP errors redact untrusted backend exception text', async (t) => {
  const server = createMcpHttpServer({ broker: { callTool: async () => { throw new Error('private JWT secret'); } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const result = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer hc_${'a'.repeat(43)}`,
  }, body: JSON.stringify(call()) });
  const text = await result.text();
  assert.ok(text.includes('backend_unavailable')); assert.ok(!text.includes('secret'));
});

test('extracted handler composes under a caller-owned server without changing legacy MCP result or hostname semantics', async t => {
  const state = await createFixtureBroker(), handler = createMcpHttpHandler({ broker: state.broker });
  const server = createServer(async (request, response) => {
    if (request.url === '/other') { response.end('caller-owned'); return; }
    await handler(request, response);
  });
  assert.equal(server.listening, false);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await (await fetch(base + '/other')).text(), 'caller-owned');
  const response = await fetch(base + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json',
    authorization: `Bearer ${state.connections.a.token}` }, body: JSON.stringify(call()) });
  assert.equal(response.status, 200); assert.equal((await response.json()).result.isError, false);
});
