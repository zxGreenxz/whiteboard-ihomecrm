import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import { createFixtureBroker } from './fixture.mjs';
import { createMcpHttpHandler, createMcpHttpServer } from './mcp-http.mjs';
import { BrokerError, actionRejected } from './broker.mjs';
import { ACTION_REASONS } from './action-reasons.mjs';
import { createBoundUserRpcTransport } from './bound-user-rpc.mjs';
import { READ_MISUSE_HINTS, READ_MISUSE_HINT_TEXTS, BUILDING_ID_HINT } from './read-misuse-hints.mjs';
import { CONFIRM_INVALID_TEXTS } from './action-contract.mjs';

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

// P3-7 (review 85280779): SQL đọc quá trần trả PT413 ⇒ HTTP 413 ⇒ result_too_large (không phải
// invalid_request), và tool error dặn model thu hẹp lệnh thay vì gọi lại y hệt.
test('oversized SQL read: PT413 maps to result_too_large with a narrow-the-call hint', async t => {
  const claims = Buffer.from(JSON.stringify({ role: 'authenticated', sub: '10000000-0000-4000-8000-000000000001',
    session_id: '10000000-0000-4000-8000-000000000002' })).toString('base64url');
  const scope = { track: work => work(), begin: () => () => {} };
  const reply = (status, code) => async () => new Response(JSON.stringify({ code, message: 'hermes_domain_response_too_large', details: null, hint: 'x' }),
    { status, headers: { 'content-type': 'application/json' } });
  const rpcWith = fetch => createBoundUserRpcTransport({ url: 'https://example.invalid/', publishableKey: 'sb_publishable_test', fetch, dependencyScope: scope,
    allowedNames: ['hermes_domain_read_v3'] });
  const token = `header.${claims}.signature`, signal = new AbortController().signal;
  await assert.rejects(rpcWith(reply(413, 'PT413'))('hermes_domain_read_v3', token, {}, { signal }), error => error.code === 'result_too_large');
  await assert.rejects(rpcWith(reply(400, '22023'))('hermes_domain_read_v3', token, {}, { signal }), error => error.code === 'invalid_request');
  await assert.rejects(rpcWith(reply(413, 'P0001'))('hermes_domain_read_v3', token, {}, { signal }), error => error.code === 'backend_unavailable');
  assert.equal(new BrokerError('result_too_large').status, 413);
  const server = createMcpHttpServer({ broker: { callTool: async () => { throw new BrokerError('result_too_large'); } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: {
    'content-type': 'application/json', authorization: `Bearer hc_${'a'.repeat(43)}` }, body: JSON.stringify(call('crm_read_invoice_report', { report: 'search' })) });
  const body = await response.json(), value = JSON.parse(body.result.content[0].text);
  assert.equal(body.result.isError, true); assert.equal(value.error, 'result_too_large');
  assert.match(value.hint, /limit nhỏ hơn hoặc bộ lọc hẹp hơn/);
});

// B5d (21/10): a building/room name the directory in scope could not resolve reaches the model as a readable tool
// error with the reason (its own string plus names the asker's RLS already lists); a non-string detail is dropped.
test('read_name_unresolved forwards its detail string to the model and nothing else', async t => {
  let problem = Object.assign(new BrokerError('read_name_unresolved'), { detail: "Nhiều toà khớp 'London': London Garden, London Park — nêu rõ.", token: 'PRIVATE' });
  const server = createMcpHttpServer({ broker: { callTool: async () => { throw problem; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const invoke = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer hc_${'a'.repeat(43)}` }, body: JSON.stringify(call('crm_read_customers', { buildingName: 'London' })) });
    const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.result.isError, true);
    return JSON.parse(body.result.content[0].text);
  };
  assert.deepEqual(await invoke(), { error: 'read_name_unresolved', detail: "Nhiều toà khớp 'London': London Garden, London Park — nêu rõ." });
  assert.equal(new BrokerError('read_name_unresolved').status, 400);
  problem = Object.assign(new BrokerError('read_name_unresolved'), { detail: { secret: 'PRIVATE' } });
  assert.deepEqual(await invoke(), { error: 'read_name_unresolved' });
});

// CV12 (Công việc Mốc 3): a write refusal may carry a relative web link to the very object (e.g. a job with materials that only the
// web can cancel). Only the closed reason + its static text + a link of the relative-path shape reach the model.
test('action_rejected forwards reason, static detail and a relative web link only', async t => {
  let problem = null;
  const server = createMcpHttpServer({ broker: { callTool: async () => { throw problem; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const invoke = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer hc_${'a'.repeat(43)}` }, body: JSON.stringify(call('crm_action_run', { action: 'task.cancel' })) });
    const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.result.isError, true);
    return JSON.parse(body.result.content[0].text);
  };
  const link = '/tasks?job=00000000-0000-4000-8000-000000000009';
  problem = actionRejected('cancel_blocked', link);
  assert.deepEqual(await invoke(), { error: 'action_rejected', reason: 'cancel_blocked', detail: ACTION_REASONS.cancel_blocked.text, link });
  for (const bad of ['https://example.invalid/x', '//example.invalid', '/tasks?job=1 OR 1=1', 42]) {
    problem = Object.assign(actionRejected('cancel_blocked'), { link: bad });
    assert.deepEqual(await invoke(), { error: 'action_rejected', reason: 'cancel_blocked', detail: ACTION_REASONS.cancel_blocked.text }, String(bad));
  }
  assert.equal(actionRejected('task_not_open', 'https://example.invalid').link, undefined, 'actionRejected bỏ link sai khuôn');
});

// R2b (21/10): a read tool called the wrong way gets invalid_request with ONE of the static routing hints of
// read-misuse-hints.mjs as detail (it names the right tool/parameter, never data). Only those strings pass: any other
// detail on invalid_request — a programming slip, a message carrying arguments — is dropped, and the code is unchanged.
test('invalid_request forwards only a static read-misuse hint as detail, nothing else', async t => {
  let problem = null;
  const server = createMcpHttpServer({ broker: { callTool: async () => { throw problem; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const invoke = async (name, args) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer hc_${'a'.repeat(43)}` }, body: JSON.stringify(call(name, args)) });
    const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.result.isError, true);
    return JSON.parse(body.result.content[0].text);
  };
  for (const hint of READ_MISUSE_HINT_TEXTS) {
    problem = Object.assign(new BrokerError('invalid_request'), { detail: hint, args: { query: 'PRIVATE' } });
    assert.deepEqual(await invoke('crm_read_contracts', { fromDate: '2026-10-21' }), { error: 'invalid_request', detail: hint });
  }
  // Thu chi lượt 14: confirmation_invalid chỉ mang một câu tĩnh của CONFIRM_INVALID_TEXTS (phần nào lệch); chuỗi khác — kể cả câu đọc — không tới.
  for (const text of CONFIRM_INVALID_TEXTS) {
    problem = Object.assign(new BrokerError('confirmation_invalid'), { detail: text });
    assert.deepEqual(await invoke('crm_action_run', {}), { error: 'confirmation_invalid', detail: text });
  }
  for (const detail of ['requestId PRIVATE khác', READ_MISUSE_HINTS.contracts.hint, null]) {
    problem = Object.assign(new BrokerError('confirmation_invalid'), { detail });
    assert.deepEqual(await invoke('crm_action_run', {}), { error: 'confirmation_invalid' }, JSON.stringify(detail));
  }
  assert.ok(READ_MISUSE_HINT_TEXTS.includes(READ_MISUSE_HINTS.pending_approvals.hint) && READ_MISUSE_HINT_TEXTS.includes(BUILDING_ID_HINT));
  for (const detail of [`${READ_MISUSE_HINTS.contracts.hint} PRIVATE`, 'buildingId PRIVATE không hợp lệ', '', { hint: READ_MISUSE_HINTS.contracts.hint }, null]) {
    problem = Object.assign(new BrokerError('invalid_request'), { detail });
    assert.deepEqual(await invoke('crm_read_contracts', { fromDate: '2026-10-21' }), { error: 'invalid_request' }, JSON.stringify(detail));
  }
  problem = new BrokerError('invalid_request');
  assert.deepEqual(await invoke('crm_read_contracts', {}), { error: 'invalid_request' });
  // A static hint on another code is not forwarded either (only invalid_request and read_name_unresolved carry detail).
  problem = Object.assign(new BrokerError('forbidden'), { detail: READ_MISUSE_HINTS.contracts.hint });
  assert.deepEqual(await invoke('crm_read_contracts', {}), { error: 'forbidden' });
});

test('unknown send returns only validated dispatch correlation so native Hermes can check status', async t => {
  const dispatchId = '10000000-0000-4000-8000-000000000099';
  let problem = Object.assign(new BrokerError('send_outcome_unknown'), { dispatchId, token: 'PRIVATE', cause: 'PRIVATE' });
  const server = createMcpHttpServer({ broker: { callTool: async () => { throw problem; } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const invoke = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer hc_${'a'.repeat(43)}`,
    }, body: JSON.stringify(call('crm_group_room_send', { requestId: dispatchId })) });
    const body = await response.json(); assert.equal(body.result.isError, true);
    return JSON.parse(body.result.content[0].text);
  };
  assert.deepEqual(await invoke(), { error: 'send_outcome_unknown', dispatchId });
  problem.dispatchId = 'PRIVATE'; assert.deepEqual(await invoke(), { error: 'send_outcome_unknown' });
  problem = Object.assign(new Error('PRIVATE'), { code: 'send_outcome_unknown', dispatchId });
  assert.deepEqual(await invoke(), { error: 'backend_unavailable' });
});

test('quota on tools/call is a readable tool error with retry hint; other methods keep HTTP 429 plus Retry-After', async t => {
  const state = await createFixtureBroker({ limits: { maxRequestsPerMinute: 2, maxToolCallsPerMinute: 1 } });
  const server = createMcpHttpServer({ broker: state.broker });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const send = async message => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp`, { method: 'POST', headers: {
      'content-type': 'application/json', authorization: `Bearer ${state.connections.a.token}` }, body: JSON.stringify(message) });
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
  };
  assert.equal((await send(call())).body.result.isError, false);
  const limited = await send(call());
  assert.equal(limited.status, 200); assert.equal(limited.body.result.isError, true);
  assert.deepEqual(JSON.parse(limited.body.result.content[0].text), { error: 'rate_limited', retryAfterSeconds: 60 });
  assert.equal((await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 200);
  const transport = await send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.equal(transport.status, 429); assert.deepEqual(transport.body, { error: 'rate_limited' });
  assert.match(transport.retryAfter, /^[1-9][0-9]?$/);
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
