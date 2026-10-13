import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRuntimeGateway } from './runtime-gateway.mjs';
import { createDependencyScope } from '../hermes-broker/dependency-scope.mjs';
import { RuntimeModelServiceError } from '../hermes-broker/runtime-model-service.mjs';

const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tokens = { a: `hc_${'a'.repeat(43)}`, b: `hc_${'b'.repeat(43)}` };
const owner = n => ({ connectionId: id(n), assistantId: id(n + 10), userId: id(n + 20), organizationId: id(n + 30), expiresAt: Date.now() + 600000 });
const owners = { a: owner(1), b: owner(2) };
const body = (content = 'private question') => ({ model: 'openai:fixture', messages: [{ role: 'user', content }], max_tokens: 4096 });
const completed = () => ({ id: 'completion-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'private answer' }, finish_reason: 'stop' }] });
const tool = name => ({ type: 'function', function: { name: `mcp__crm__${name}`, description: 'Synthetic tool', parameters: { type: 'object', properties: {}, additionalProperties: false } } });
const toolCall = (n, name = 'crm_auth_context') => ({ id: `call_${n}`, type: 'function', function: { name: `mcp__crm__${name}`, arguments: '{}' } });
const rpc = (name = 'crm_auth_context', args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const err = code => error => error.code === code;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(predicate) { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() >= deadline) assert.fail('condition did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function stillPending(promise) { let settled = false; void promise.then(() => { settled = true; }, () => { settled = true; }); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(settled, false); }
function http(actor, value, { url = '/mcp', raw, headers = {}, method = 'POST' } = {}) {
  const encoded = raw === undefined ? Buffer.from(JSON.stringify(value)) : Buffer.from(raw);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: actor.port, path: url, method, headers: {
      host: 'hermes-gateway:8787', 'content-type': 'application/json', 'content-length': encoded.length,
      authorization: 'Bearer gateway-no-credential', ...headers }, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null, raw });
      });
    }); req.on('error', reject); req.end(encoded);
  });
}
// The native suite starts many files/processes concurrently. Python imports are
// bootstrap work, not an MCP timeout. Start the unchanged protocol watchdog only
// after the real client acknowledges its pinned imports and receives our GO.
function runPinnedMcpClient(python, script, ports, { spawnProcess = spawn, timers = { setTimeout, clearTimeout } } = {}) {
  return new Promise(resolve => {
    const child = spawnProcess(python, ['-c', script, ...ports.map(String)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const errors = []; let output = '', ready = false, timedOut = null, signalError = null, bytes = 0;
    const kill = phase => { timedOut ??= phase; child.kill(); };
    let timer = timers.setTimeout(() => kill('startup'), 90000);
    child.stdout.on('data', chunk => {
      if (timedOut) return;
      bytes += chunk.length; if (bytes > 65536) { kill('output'); return; }
      output += chunk.toString('utf8');
      if (!ready && output.includes('\n')) {
        const newline = output.indexOf('\n'), line = output.slice(0, newline).trim();
        if (line !== '{"event": "ready", "sdk": "2.0.0"}') { kill('readiness'); return; }
        ready = true; output = output.slice(newline + 1); timers.clearTimeout(timer);
        timer = timers.setTimeout(() => kill('protocol'), 20000);
        child.stdin.end('start\n');
      }
    });
    child.stderr.on('data', chunk => { bytes += chunk.length; if (bytes <= 65536) errors.push(chunk); else kill('output'); });
    child.stdin.on('error', () => { signalError = 'stdin'; kill('transport'); });
    child.on('error', () => { signalError = 'spawn'; });
    child.on('close', (code, signal) => {
      timers.clearTimeout(timer);
      resolve({ code, signal, stdout: output, stderr: Buffer.concat(errors).toString(), ready, timedOut, signalError });
    });
  });
}
async function fixture(t, limits = {}) {
  const scope = createDependencyScope(), channels = [], events = [], releases = [];
  const state = { model: async () => completed(), resolve: async token => owners[token === tokens.a ? 'a' : 'b'],
    auth: async () => ({}), call: async (token, name) => ({ content: [{ type: 'text', text: JSON.stringify(name === 'crm_auth_context'
      ? { assistantId: owners[token === tokens.a ? 'a' : 'b'].assistantId } : { rooms: [token === tokens.a ? 'A-101' : 'B-202'] }) }], isError: false }) };
  const backend = { resolveConnection: (token, options) => { events.push({ kind: 'resolve', token, options }); return state.resolve(token, options); } };
  const broker = { authenticate: token => { events.push({ kind: 'auth', token }); return state.auth(token); },
    listTools: async token => { events.push({ kind: 'list', token }); return { tools: ['crm_auth_context', 'crm_available_rooms'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }; },
    callTool: (token, name, args) => { events.push({ kind: 'tool', token, name, args }); return state.call(token, name, args); } };
  const modelService = { beginCompletion: input => { events.push({ kind: 'model', input }); return scope.begin(() => state.model(input)); } };
  const transport = { open: async input => {
    assert.deepEqual(Object.keys(input).sort(), ['handler', 'signal']); assert.equal(typeof input.handler, 'function'); assert(input.signal instanceof AbortSignal);
    const server = createServer(input.handler); const channel = { server, closes: 0, input }; channels.push(channel);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); channel.port = server.address().port;
    return Object.freeze({ descriptor: Object.freeze({ networkName: `hermes-private-${channels.length}`, networkId: String(channels.length).repeat(64),
      mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' }),
      close: async () => { channel.closes++; server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } });
  } };
  const gateway = createRuntimeGateway({ backend, broker, modelService, transport, dependencyScope: scope, ...limits });
  t.after(async () => { releases.forEach(resolve => resolve()); await gateway.shutdown().catch(() => {}); await scope.close();
    for (const channel of channels) { channel.server.closeAllConnections(); channel.server.close(); } });
  async function add(name = 'a', suffix = name) {
    const identity = owners[name], home = path.resolve(os.tmpdir(), `hermes-gateway-${suffix}`), token = tokens[name];
    const ticket = await gateway.register(token, { home });
    const binding = { assistantId: identity.assistantId, userId: identity.userId, organizationId: identity.organizationId, home };
    const handle = gateway.prepare(binding), descriptor = await gateway.start(handle);
    return { ticket, handle, binding, descriptor, port: channels.at(-1).port, channel: channels.at(-1) };
  }
  const begin = (actor, n = 100, signal) => { gateway.setAdmission(actor.handle, true); gateway.beginTurn(actor.handle, { commandId: id(n), ...(signal ? { signal } : {}) }); return id(n); };
  return { gateway, state, scope, channels, events, add, begin, releases, backend, broker, modelService, transport };
}

test('registration and prepare are inert branded owner/home capabilities; transport never receives a token', async t => {
  const f = await fixture(t), home = path.resolve(os.tmpdir(), 'hermes-gateway-inert');
  const ticket = await f.gateway.register(tokens.a, { home }); assert(Object.isFrozen(ticket)); assert.deepEqual(ticket, {}); assert.equal(f.channels.length, 0);
  const binding = { assistantId: owners.a.assistantId, userId: owners.a.userId, organizationId: owners.a.organizationId, home };
  assert.throws(() => f.gateway.prepare({ ...binding, userId: owners.b.userId }), err('invalid_binding'));
  const handle = f.gateway.prepare(binding); assert(Object.isFrozen(handle)); assert.deepEqual(handle, {}); assert.equal(f.channels.length, 0);
  assert.throws(() => f.gateway.prepare(binding), err('invalid_binding')); assert.throws(() => f.gateway.unregister(ticket), err('unknown_ticket'));
  assert.throws(() => f.gateway.start({}), err('unknown_handle'));
  const descriptor = await f.gateway.start(handle); assert(Object.isFrozen(descriptor)); assert.equal(f.channels.length, 1);
  assert(!JSON.stringify(descriptor).includes(tokens.a)); assert.deepEqual(Object.keys(f.channels[0].input).sort(), ['handler', 'signal']);
  await assert.rejects(f.gateway.register(tokens.b, { home }), err('profile_in_use'));
  await assert.rejects(f.gateway.register(tokens.a, { home: home + '-other' }), err('invalid_identity'));
});

test('unregister releases only an unconsumed registration, including cancellation and unknown ticket rejection', async t => {
  const f = await fixture(t), home = path.resolve(os.tmpdir(), 'hermes-gateway-unregister');
  const ticket = await f.gateway.register(tokens.a, { home }); await f.gateway.unregister(ticket);
  const again = await f.gateway.register(tokens.a, { home }); assert.notEqual(again, ticket); await f.gateway.unregister(again);
  assert.throws(() => f.gateway.unregister({}), err('unknown_ticket'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.gateway.register(tokens.a, { home, signal: controller.signal }), err('invalid_identity'));
  assert.equal(f.channels.length, 0);
});

test('releaseRegistration retires an unconsumed ticket after cleanup and is idempotent only for that branded ticket', async t => {
  const f = await fixture(t), home = path.resolve(os.tmpdir(), 'hermes-gateway-release-unused');
  const ticket = await f.gateway.register(tokens.a, { home });
  await Promise.all([f.gateway.releaseRegistration(ticket), f.gateway.releaseRegistration(ticket)]);
  assert.equal(await f.gateway.releaseRegistration(ticket), undefined); assert.equal(f.channels.length, 0);
  await assert.rejects(f.gateway.releaseRegistration({}), err('unknown_ticket'));
  await assert.rejects(f.gateway.releaseRegistration(null), err('unknown_ticket'));
  assert.throws(() => f.gateway.unregister(ticket), err('unknown_ticket'));
  const replacement = await f.gateway.register(tokens.a, { home }); await f.gateway.releaseRegistration(replacement);
});

test('releaseRegistration cannot close prepared or active profiles and retiring stopped A does not affect B', async t => {
  const f = await fixture(t), a = await f.add('a'), b = await f.add('b');
  await assert.rejects(f.gateway.releaseRegistration(a.ticket), err('registration_in_use'));
  assert.equal(a.channel.closes, 0); assert.equal(b.channel.closes, 0);
  assert.equal((await http(a, rpc())).status, 200); assert.equal((await http(b, rpc())).status, 200);
  await f.gateway.close(a.handle); await f.gateway.releaseRegistration(a.ticket); await f.gateway.releaseRegistration(a.ticket);
  assert.equal(a.channel.closes, 1); assert.equal(b.channel.closes, 0); assert.equal((await http(b, rpc())).status, 200);
  const again = await f.gateway.register(tokens.a, { home: a.binding.home }); await f.gateway.releaseRegistration(again);
});

test('releaseRegistration refuses a prepared handle before any transport has started', async t => {
  const f = await fixture(t), home = path.resolve(os.tmpdir(), 'hermes-gateway-release-prepared');
  const ticket = await f.gateway.register(tokens.a, { home });
  const handle = f.gateway.prepare({ assistantId: owners.a.assistantId, userId: owners.a.userId, organizationId: owners.a.organizationId, home });
  await assert.rejects(f.gateway.releaseRegistration(ticket), err('registration_in_use')); assert.equal(f.channels.length, 0);
  await f.gateway.close(handle); await f.gateway.releaseRegistration(ticket); assert.equal(f.channels.length, 0);
});

test('releaseRegistration rejects while nested work drains and only retires after actual close releases ownership', async t => {
  const f = await fixture(t), a = await f.add(), hold = deferred(); f.releases.push(hold.resolve);
  f.state.call = async () => { void f.scope.track(() => hold.promise); throw Error('private work'); };
  await http(a, rpc()); const closing = f.gateway.close(a.handle); await stillPending(closing);
  await assert.rejects(f.gateway.releaseRegistration(a.ticket), err('registration_in_use'));
  await assert.rejects(f.gateway.register(tokens.a, { home: a.binding.home }), err('profile_in_use'));
  hold.resolve(); await closing; await f.gateway.releaseRegistration(a.ticket);
  const replacement = await f.gateway.register(tokens.a, { home: a.binding.home }); await f.gateway.releaseRegistration(replacement);
});

test('releaseRegistration cannot retire failed transport cleanup or unknown open and never retries cleanup', async t => {
  for (const mode of ['close-failed', 'open-unknown']) {
    const scope = createDependencyScope(); let opens = 0, closes = 0;
    const gateway = createRuntimeGateway({ dependencyScope: scope, backend: { resolveConnection: async () => owners.a },
      broker: { authenticate() {}, listTools() {}, callTool() {} }, modelService: { beginCompletion() {} },
      transport: { async open() { opens++; if (mode === 'open-unknown') throw Error('PRIVATE');
        return { descriptor: { networkName: 'unknown', networkId: 'a'.repeat(64), mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' },
          async close() { closes++; throw Error('PRIVATE'); } }; } } });
    t.after(async () => { await gateway.shutdown().catch(() => {}); await scope.close(); });
    const home = path.resolve(os.tmpdir(), 'hermes-gateway-release-' + mode), ticket = await gateway.register(tokens.a, { home });
    const handle = gateway.prepare({ assistantId: owners.a.assistantId, userId: owners.a.userId, organizationId: owners.a.organizationId, home });
    if (mode === 'open-unknown') await assert.rejects(gateway.start(handle)); else await gateway.start(handle);
    await assert.rejects(gateway.close(handle), err('drain_failed'));
    await assert.rejects(gateway.releaseRegistration(ticket), err('registration_in_use'));
    await assert.rejects(gateway.releaseRegistration(ticket), err('registration_in_use'));
    await assert.rejects(gateway.register(tokens.a, { home }), err('profile_in_use'));
    assert.equal(opens, 1); assert.equal(closes, mode === 'close-failed' ? 1 : 0);
  }
});

test('real HTTP A/B channels permit startup MCP but no rooms/model; actor and bearer spoofing never selects another profile', async t => {
  const f = await fixture(t), a = await f.add('a'), b = await f.add('b');
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
  assert.equal((await http(a, init)).body.result.protocolVersion, '2025-03-26');
  assert.equal((await http(a, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.deepEqual((await http(a, { jsonrpc: '2.0', id: 2, method: 'ping' })).body.result, {});
  assert.equal((await http(a, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).body.result.tools.length, 2);
  for (const [actor, expected] of [[a, owners.a], [b, owners.b]]) {
    const result = await http(actor, rpc()); assert.equal(JSON.parse(result.body.result.content[0].text).assistantId, expected.assistantId);
    assert(!result.raw.includes(tokens.a)); assert(!result.raw.includes(tokens.b));
  }
  assert.equal((await http(a, rpc('crm_available_rooms'))).status, 403);
  assert.equal((await http(a, body(), { url: '/v1/chat/completions' })).status, 403);
  assert.equal((await http(a, rpc(), { headers: { authorization: `Bearer ${tokens.b}` } })).status, 403);
  assert.equal((await http(a, rpc(), { headers: { 'x-user-id': owners.b.userId } })).status, 403);
  assert.equal((await http(a, rpc(), { url: `/mcp?userId=${owners.b.userId}` })).status, 404);
  assert.equal((await http(a, rpc('crm_auth_context', { userId: owners.b.userId }))).status, 400);
  assert.equal((await http(a, { ...rpc(), organizationId: owners.b.organizationId })).status, 400);
  assert.equal(f.events.filter(event => event.kind === 'model').length, 0);
});

test('an admitted turn uses the scoped opaque token, a host request UUID, frozen projected request and bounded CRM calls', async t => {
  const f = await fixture(t), a = await f.add(); const commandId = f.begin(a);
  const answer = await http(a, body(), { url: '/v1/chat/completions' }); assert.equal(answer.status, 200); assert.deepEqual(answer.body, completed());
  const call = f.events.find(event => event.kind === 'model').input;
  assert.equal(call.token, tokens.a); assert.match(call.requestId, /^[a-f0-9-]{36}$/); assert.notEqual(call.requestId, commandId);
  assert(Object.isFrozen(call.body)); assert(Object.isFrozen(call.body.messages)); assert.equal(call.body.stream, false);
  assert(!JSON.stringify(call.body).includes(tokens.a)); assert(!Object.hasOwn(call.body, 'commandId'));
  const room = await http(a, rpc('crm_available_rooms', { limit: 2 })); assert.deepEqual(JSON.parse(room.body.result.content[0].text), { rooms: ['A-101'] });
  await f.gateway.endTurn(a.handle, { commandId }); assert.equal((await http(a, rpc('crm_available_rooms'))).status, 403);
  assert.throws(() => f.gateway.beginTurn(a.handle, { commandId }), err('replay'));
});

test('canonical request replay cannot pay again; distinct sequential rounds are bounded', async t => {
  const f = await fixture(t, { maxModelRounds: 2 }), a = await f.add(); const commandId = f.begin(a);
  assert.equal((await http(a, body(), { url: '/v1/chat/completions' })).status, 200);
  const reordered = { max_tokens: 4096, messages: [{ content: 'private question', role: 'user' }], model: 'openai:fixture', stream: false };
  assert.equal((await http(a, reordered, { url: '/v1/chat/completions' })).body.error, 'replay');
  assert.equal((await http(a, body('next'), { url: '/v1/chat/completions' })).status, 200);
  assert.equal((await http(a, body('third'), { url: '/v1/chat/completions' })).body.error, 'round_limit');
  assert.equal(f.events.filter(event => event.kind === 'model').length, 2); await f.gateway.endTurn(a.handle, { commandId });
});

test('pinned upstream developer and max-completion aliases project into the existing relay contract and one replay identity', async t => {
  const f = await fixture(t), a = await f.add(); f.begin(a);
  // Captured assembler combinations at upstream 818c13be1dc4fd28987e1e881a9408224afd4535:
  // actual ChatCompletionsTransport + MCP schema modules, unchanged max-token
  // method AST with fixed private-host flags; no full AIAgent/OpenAI SDK wire.
  const fixtures = [['openai:gpt-4.1-mini', 'system', 'max_tokens'], ['openai:gpt-5.4', 'developer', 'max_tokens'],
    ['openrouter:openai/gpt-4.1-mini', 'system', 'max_completion_tokens'], ['openrouter:openai/gpt-5.4', 'developer', 'max_completion_tokens']];
  for (const [model, role, budget] of fixtures) {
    const request = { model, [budget]: 4096,
      messages: [{ role, content: 'UNTRUSTED model-facing instructions' }, { role: 'user', content: 'question' }],
      tools: [tool('crm_auth_context')] };
    request.tools[0].function.parameters.required = []; // MCP normalization adds this empty array.
    assert.equal((await http(a, request, { url: '/v1/chat/completions' })).status, 200);
    const projected = f.events.filter(event => event.kind === 'model').at(-1).input.body;
    assert.deepEqual(projected, { model, max_tokens: 4096, stream: false, tools: request.tools,
      messages: [{ role: 'system', content: request.messages[0].content }, request.messages[1]] });
    assert(Object.isFrozen(projected.messages[0])); assert(!Object.hasOwn(projected, 'max_completion_tokens'));
    assert.equal((await http(a, projected, { url: '/v1/chat/completions' })).body.error, 'replay');
    assert.equal((await http(a, request, { url: '/v1/chat/completions' })).body.error, 'replay');
  }
  assert.equal(f.events.filter(event => event.kind === 'model').length, 4);
});

test('upstream aliases preserve the same token bounds, strict fields, leading system position and complete tool pairs', async t => {
  const f = await fixture(t), a = await f.add(); f.begin(a);
  const request = { model: 'openai:fixture', max_completion_tokens: 1,
    messages: [{ role: 'developer', content: 'context' }, { role: 'user', content: 'first' }] };
  assert.equal((await http(a, request, { url: '/v1/chat/completions' })).status, 200);
  const invalid = [
    { ...request, max_tokens: 1 }, { ...request, max_tokens: null },
    ...[0, -1, 4097, 1.5, '4096', null, true].map(value => ({ ...request, max_completion_tokens: value })),
    { model: request.model, messages: request.messages },
    { ...request, extra_body: {} }, { ...request, timeout: 1000 }, { ...request, reasoning: {} },
    { ...request, messages: [request.messages[1], request.messages[0]] },
    { ...request, messages: [request.messages[0], request.messages[0]] },
    { ...request, messages: [{ ...request.messages[0], userId: owners.b.userId }] },
    { ...request, messages: [{ role: 'administrator', content: 'x' }] },
    { ...request, messages: [...request.messages, { role: 'assistant', content: null, tool_calls: [toolCall(1)] }] },
  ];
  for (const candidate of invalid) assert.equal((await http(a, candidate, { url: '/v1/chat/completions' })).status, 400);
  assert.equal(f.events.filter(event => event.kind === 'model').length, 1);
  const next = { ...request, messages: [...request.messages, { role: 'assistant', content: null, tool_calls: [toolCall(1)] },
    { role: 'tool', content: '{}', tool_call_id: 'call_1' }], tools: [tool('crm_auth_context')] };
  assert.equal((await http(a, next, { url: '/v1/chat/completions' })).status, 200);
});

test('typed confirmed model denial preserves profile admission, while the attempted body remains consumed', async t => {
  const f = await fixture(t), a = await f.add(); const commandId = f.begin(a);
  for (const code of ['busy', 'forbidden', 'invalid_request', 'unauthorized', 'context_changed', 'closed']) {
    f.state.model = async () => { throw new RuntimeModelServiceError(code); };
    const denied = await http(a, body(code), { url: '/v1/chat/completions' });
    assert.equal(denied.body.error, code === 'closed' ? 'inactive' : code);
    assert.equal((await http(a, body(code), { url: '/v1/chat/completions' })).body.error, 'replay');
    f.state.model = async () => completed();
    assert.equal((await http(a, body(`after ${code}`), { url: '/v1/chat/completions' })).status, 200);
  }
  await f.gateway.endTurn(a.handle, { commandId });
});

test('synchronous model admission busy is definite, while a denied request still owns nested drain and HTTP capacity', async t => {
  const f = await fixture(t, { maxConcurrentRequests: 1 }), a = await f.add(), hold = deferred(); f.releases.push(hold.resolve); f.begin(a);
  const begin = f.modelService.beginCompletion;
  f.modelService.beginCompletion = () => { throw new RuntimeModelServiceError('busy'); };
  assert.deepEqual((await http(a, body('sync busy'), { url: '/v1/chat/completions' })).body, { error: 'busy' });
  f.modelService.beginCompletion = begin;
  f.state.model = async () => { void f.scope.track(() => hold.promise); throw new RuntimeModelServiceError('forbidden'); };
  assert.deepEqual((await http(a, body('denied with nested work'), { url: '/v1/chat/completions' })).body, { error: 'forbidden' });
  assert.equal((await http(a, rpc())).body.error, 'busy'); hold.resolve(); await until(() => f.events.filter(event => event.kind === 'model').length === 1);
  await new Promise(resolve => setImmediate(resolve)); assert.equal((await http(a, rpc())).status, 200);
});

test('raw model error codes and typed uncertain outcomes still quarantine the profile', async t => {
  for (const cause of [Object.assign(new Error('private body'), { code: 'busy' }), new RuntimeModelServiceError('model_unknown'),
    new RuntimeModelServiceError('timeout'), new RuntimeModelServiceError('cancelled')]) {
    await t.test(cause instanceof RuntimeModelServiceError ? cause.code : 'untrusted code', async t => {
      const f = await fixture(t), a = await f.add(); f.begin(a);
      f.state.model = async () => { throw cause; };
      const result = await http(a, body(), { url: '/v1/chat/completions' }); assert.deepEqual(result.body, { error: 'model_unknown' });
      assert.equal((await http(a, rpc())).body.error, 'inactive'); assert(!result.raw.includes('private body'));
    });
  }
});

test('MCP client watchdog starts protocol time only after imported readiness and retains a killed child until close', async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: 0,
    kill() { this.kills++; return true; } });
  const deadlines = [], cleared = [], timers = { setTimeout(fn, ms) { const timer = { fn, ms }; deadlines.push(timer); return timer; }, clearTimeout(timer) { cleared.push(timer); } };
  const pending = runPinnedMcpClient('fixture-python', '', [1, 2], { spawnProcess: () => child, timers });
  assert.deepEqual(deadlines.map(timer => timer.ms), [90000]); assert.equal(child.stdin.read(), null);
  child.stdout.write('{"event": "ready", "sdk": "2.0.0"}\n');
  assert.deepEqual(deadlines.map(timer => timer.ms), [90000, 20000]); assert.equal(cleared[0], deadlines[0]); assert.equal(child.stdin.read().toString(), 'start\n');
  deadlines[1].fn(); assert.equal(child.kills, 1); let settled = false; void pending.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  child.emit('close', null, 'SIGTERM'); const result = await pending;
  assert.equal(result.timedOut, 'protocol'); assert.equal(result.ready, true); assert.equal(result.signal, 'SIGTERM');
  const slow = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
  const bootstrap = runPinnedMcpClient('fixture-python', '', [], { spawnProcess: () => slow, timers });
  deadlines.at(-1).fn(); slow.stdout.write('{"event": "ready", "sdk": "2.0.0"}\n');
  assert.equal(slow.stdin.read(), null, 'A late ready must not run protocol after startup timeout');
  slow.emit('close', null, 'SIGTERM'); assert.equal((await bootstrap).timedOut, 'startup');
});

test('actual pinned MCP 2.0.0 client negotiates Hermes default handshake and calls isolated A/B context over HTTP', async t => {
  const python = process.env.HERMES_TEST_MCP_PYTHON ?? path.resolve('.cache/hermes-p1/transport-venv/Scripts/python.exe');
  if (!existsSync(python)) { t.skip('Pinned MCP 2.0.0 Python environment unavailable; no installation attempted'); return; }
  const f = await fixture(t), a = await f.add('a'), b = await f.add('b');
  const script = String.raw`
import asyncio, json, sys
from importlib.metadata import version
import httpx2
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
assert version('mcp') == '2.0.0'
print(json.dumps({'event': 'ready', 'sdk': version('mcp')}), flush=True)
assert sys.stdin.readline().strip() == 'start'
async def main():
    reports = []
    for port in sys.argv[1:]:
        metadata = []
        async def capture(request):
            if request.method == 'POST':
                data = json.loads(request.content)
                params = data.get('params', {})
                metadata.append({'method': data.get('method'), 'paramsKeys': sorted(params),
                    'protocolVersion': params.get('protocolVersion'),
                    'capabilityKeys': sorted(params.get('capabilities', {})),
                    'clientInfoKeys': sorted(params.get('clientInfo', {}))})
        async with httpx2.AsyncClient(headers={'Host': 'hermes-gateway:8787', 'Authorization': 'Bearer gateway-no-credential'},
                trust_env=False, event_hooks={'request': [capture]}) as http_client:
            async with streamable_http_client('http://127.0.0.1:' + port + '/mcp', http_client=http_client) as streams:
                async with ClientSession(streams[0], streams[1], read_timeout_seconds=5) as session:
                    initialized = await session.initialize()
                    tools = await session.list_tools()
                    context = await session.call_tool('crm_auth_context', {})
                    reports.append({'version': initialized.protocol_version, 'tools': sorted(tool.name for tool in tools.tools),
                        'assistantId': json.loads(context.content[0].text)['assistantId'], 'requests': metadata})
    print(json.dumps({'sdk': version('mcp'), 'profiles': reports}))
asyncio.run(main())
`;
  const result = await runPinnedMcpClient(python, script, [a.port, b.port]);
  assert.equal(result.timedOut, null, `MCP client exceeded ${result.timedOut} deadline`); assert.equal(result.signalError, null);
  assert.equal(result.ready, true, 'Pinned Python imports never acknowledged readiness');
  assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); const report = JSON.parse(result.stdout);
  assert.equal(report.sdk, '2.0.0');
  for (const [index, expected] of [owners.a, owners.b].entries()) {
    const profile = report.profiles[index]; assert.equal(profile.assistantId, expected.assistantId); assert.equal(profile.version, '2025-11-25');
    assert.deepEqual(profile.tools, ['crm_auth_context', 'crm_available_rooms']);
    assert.deepEqual(profile.requests.map(request => request.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.deepEqual(profile.requests[0], { method: 'initialize', paramsKeys: ['_meta', 'capabilities', 'clientInfo', 'protocolVersion'],
      protocolVersion: '2025-11-25', capabilityKeys: [], clientInfoKeys: ['name', 'version'] });
  }
  t.diagnostic(JSON.stringify(report)); assert.equal(f.events.filter(event => event.kind === 'model').length, 0);
});

test('concurrent changed-body model calls remain singleflight even when another MCP handler finishes', async t => {
  const f = await fixture(t), a = await f.add(), hold = deferred(); f.releases.push(() => hold.resolve(completed()));
  f.state.model = () => hold.promise; const commandId = f.begin(a);
  const first = http(a, body(), { url: '/v1/chat/completions' }); await until(() => f.events.some(event => event.kind === 'model'));
  const ping = http(a, rpc()); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await http(a, body('changed'), { url: '/v1/chat/completions' })).body.error, 'busy');
  assert.equal(f.events.filter(event => event.kind === 'model').length, 1);
  hold.resolve(completed()); assert.equal((await first).status, 200); assert.equal((await ping).status, 200);
  await f.gateway.endTurn(a.handle, { commandId });
});

test('model request projection rejects actor fields, unknown fields, oversized history/tokens and broken tool pairs before the service', async t => {
  const f = await fixture(t), a = await f.add(); f.begin(a);
  const invalid = [
    { ...body(), userId: owners.b.userId }, { ...body(), stream: true }, { ...body(), stream_options: {} }, { ...body(), max_tokens: 4097 },
    { ...body(), messages: Array.from({ length: 65 }, () => ({ role: 'user', content: 'x' })) },
    { ...body(), messages: [{ role: 'user', content: 'x', commandId: id(12) }] },
    { ...body(), messages: [{ role: 'assistant', content: null, tool_calls: [toolCall(1)] }] },
    { ...body(), messages: [{ role: 'tool', content: '{}', tool_call_id: 'foreign' }] },
    { ...body(), tools: [tool('crm_auth_context'), tool('crm_auth_context')] },
    { ...body(), tools: [tool('terminal')] }, { ...body(), temperature: 3 }, { ...body(), messages: [{ role: 'user', content: 'x\0y' }] },
  ];
  for (const request of invalid) assert.equal((await http(a, request, { url: '/v1/chat/completions' })).status, 400);
  assert.equal(f.events.filter(event => event.kind === 'model').length, 0);
});

test('at most two tool calls, including repeated names, survive each response and a complete next-round history', async t => {
  const f = await fixture(t), a = await f.add(); f.begin(a);
  f.state.model = async () => ({ ...completed(), choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall(1), toolCall(2)] }, finish_reason: 'tool_calls' }] });
  const request = { ...body(), tools: [tool('crm_auth_context')] }, first = await http(a, request, { url: '/v1/chat/completions' });
  assert.equal(first.status, 200); assert.equal(first.body.choices[0].message.tool_calls.length, 2);
  f.state.model = async () => completed();
  const next = { ...request, messages: [...request.messages, first.body.choices[0].message,
    { role: 'tool', content: '{}', tool_call_id: 'call_1' }, { role: 'tool', content: '{}', tool_call_id: 'call_2' }] };
  assert.equal((await http(a, next, { url: '/v1/chat/completions' })).status, 200);
  const bad = { ...next, messages: [{ role: 'assistant', content: null, tool_calls: [toolCall(1), toolCall(2), toolCall(3)] }] };
  assert.equal((await http(a, bad, { url: '/v1/chat/completions' })).status, 400);
});

test('three model tool calls cannot reach Hermes and quarantine the profile without replaying the paid call', async t => {
  const f = await fixture(t), a = await f.add(); f.begin(a);
  f.state.model = async () => ({ ...completed(), choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [toolCall(1), toolCall(2), toolCall(3)] }, finish_reason: 'tool_calls' }] });
  const reply = await http(a, { ...body(), tools: [tool('crm_auth_context')] }, { url: '/v1/chat/completions' });
  assert.deepEqual(reply.body, { error: 'model_unknown' }); assert(!reply.raw.includes('call_1'));
  assert.equal((await http(a, body(), { url: '/v1/chat/completions' })).body.error, 'inactive');
  assert.throws(() => f.gateway.setAdmission(a.handle, true), err('inactive')); assert.equal(f.events.filter(event => event.kind === 'model').length, 1);
});

test('decoded duplicate keys, malformed UTF8, unknown MCP fields, hostile headers and unsupported paths never reach trusted work', async t => {
  const f = await fixture(t), a = await f.add(); const count = f.events.length;
  for (const raw of ['{"jsonrpc":"2.0","id":1,"method":"ping","method":"tools/call"}',
    '{"jsonrpc":"2.0","id":1,"method":"ping","\\u0069d":2}', '{"x":NaN}', Buffer.from([0xff, 0xfe])]) {
    assert.equal((await http(a, null, { raw })).body.error, 'invalid_json');
  }
  for (const options of [{ headers: { origin: 'https://invalid.test' } }, { headers: { cookie: 'private' } },
    { headers: { host: 'other:8787' } }, { headers: { 'content-encoding': 'gzip' } }, { method: 'GET' }, { url: '/v1/responses' }]) {
    assert.notEqual((await http(a, rpc(), options)).status, 200);
  }
  assert.equal((await http(a, { ...rpc(), params: { ...rpc().params, actor: 'other' } })).status, 400);
  for (const metadata of [{ userId: owners.b.userId }, { progressToken: 1 }, { traceparent: 'private' }, null, []]) {
    assert.equal((await http(a, { ...rpc(), params: { ...rpc().params, _meta: metadata } })).status, 400);
  }
  assert.equal((await http(a, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } })).status, 400);
  assert.equal(f.events.length, count);
});

test('body caps stop paid calls before parsing and model bodies never select connection, request or command identity', async t => {
  const f = await fixture(t, { maxBodyBytes: 1024 }), a = await f.add(); f.begin(a);
  assert.equal((await http(a, body('x'.repeat(1100)), { url: '/v1/chat/completions' })).body.error, 'body_too_large');
  for (const key of ['token', 'connectionId', 'organizationId', 'requestId', 'commandId']) {
    assert.equal((await http(a, { ...body(), [key]: tokens.b }, { url: '/v1/chat/completions' })).status, 400);
  }
  assert.equal(f.events.filter(event => event.kind === 'model').length, 0);
});

test('model timeout responds safely but holds the turn/profile until ignored-abort dependency actually settles', async t => {
  const f = await fixture(t, { timeoutMs: 30 }), a = await f.add(), b = await f.add('b'), hold = deferred(); f.releases.push(() => hold.resolve(completed()));
  f.state.model = input => { assert(input.signal instanceof AbortSignal); return hold.promise; };
  const commandId = f.begin(a), reply = await http(a, body(), { url: '/v1/chat/completions' });
  assert.deepEqual(reply.body, { error: 'model_unknown' }); assert.equal(f.events.find(event => event.kind === 'model').input.signal.aborted, true);
  assert.equal((await http(a, body(), { url: '/v1/chat/completions' })).body.error, 'inactive');
  assert.equal((await http(b, rpc())).status, 200);
  const ended = f.gateway.endTurn(a.handle, { commandId }); await stillPending(ended);
  const closing = f.gateway.close(a.handle); await stillPending(closing); assert.equal(a.channel.closes, 1);
  hold.resolve(completed()); await ended; await closing; assert.equal(f.events.filter(event => event.kind === 'model').length, 1);
});

test('nested model work hidden behind an early error remains owned through endTurn and close', async t => {
  const f = await fixture(t), a = await f.add(), hold = deferred(); f.releases.push(hold.resolve);
  f.state.model = async () => { void f.scope.track(() => hold.promise); throw new Error(`RAW_PRIVATE ${tokens.a}`); };
  const commandId = f.begin(a), reply = await http(a, body(), { url: '/v1/chat/completions' });
  assert.deepEqual(reply.body, { error: 'model_unknown' }); assert(!reply.raw.includes('RAW_PRIVATE')); assert(!reply.raw.includes(tokens.a));
  const ended = f.gateway.endTurn(a.handle, { commandId }), closing = f.gateway.close(a.handle);
  await stillPending(ended); await stillPending(closing); hold.resolve(); await ended; await closing;
});

test('broker timeout also retains the HTTP capacity until nested ignored-abort read settles', async t => {
  const f = await fixture(t, { maxConcurrentRequests: 1, timeoutMs: 30 }), a = await f.add(), hold = deferred(); f.releases.push(hold.resolve);
  f.state.call = async () => { void f.scope.track(() => hold.promise); throw new Error('PRIVATE_BROKER_ERROR'); };
  const first = await http(a, rpc()); assert.deepEqual(first.body, { error: 'backend_unavailable' });
  assert.equal((await http(a, rpc())).body.error, 'busy'); const closing = f.gateway.close(a.handle); await stillPending(closing);
  hold.resolve(); await closing;
});

test('endTurn closes admission synchronously without stopping transport and prevents new turn until work drains', async t => {
  const f = await fixture(t), a = await f.add(), hold = deferred(); f.releases.push(hold.resolve);
  f.state.call = () => hold.promise; const commandId = f.begin(a), pending = http(a, rpc('crm_available_rooms'));
  await until(() => f.events.some(event => event.kind === 'tool'));
  const end = f.gateway.endTurn(a.handle, { commandId }); assert.throws(() => f.gateway.beginTurn(a.handle, { commandId: id(101) }), err('busy'));
  assert.equal((await http(a, rpc('crm_available_rooms'))).body.error, 'inactive'); assert.equal(a.channel.closes, 0);
  assert.equal((await pending).body.error, 'cancelled'); await stillPending(end);
  hold.resolve({ content: [], isError: false }); await end; f.gateway.beginTurn(a.handle, { commandId: id(101) });
  await f.gateway.endTurn(a.handle, { commandId: id(101) });
});

test('setAdmission(false) and an aborted command signal cannot return a late paid result or reopen a quarantined profile', async t => {
  for (const mode of ['admission', 'signal']) {
    const f = await fixture(t), a = await f.add(), hold = deferred(), controller = new AbortController(); f.releases.push(() => hold.resolve(completed()));
    f.state.model = () => hold.promise; const commandId = f.begin(a, 100, controller.signal), pending = http(a, body(), { url: '/v1/chat/completions' });
    await until(() => f.events.some(event => event.kind === 'model'));
    if (mode === 'admission') f.gateway.setAdmission(a.handle, false); else controller.abort();
    assert.deepEqual((await pending).body, { error: 'model_unknown' }); hold.resolve(completed()); await f.gateway.endTurn(a.handle, { commandId });
    assert.throws(() => f.gateway.setAdmission(a.handle, true), err('inactive'));
  }
});

test('close waits for late transport creation, closes that actual channel, and never accepts admission after cancellation', async t => {
  const hold = deferred(), opened = deferred(), scope = createDependencyScope(); let closes = 0;
  const gateway = createRuntimeGateway({ dependencyScope: scope, backend: { resolveConnection: async () => owners.a },
    broker: { authenticate() {}, listTools() {}, callTool() {} }, modelService: { beginCompletion() {} },
    transport: { open: async () => { opened.resolve(); await hold.promise; return { descriptor: { networkName: 'late', networkId: 'a'.repeat(64),
      mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' }, close: async () => { closes++; } }; } } });
  t.after(async () => { hold.resolve(); await gateway.shutdown(); await scope.close(); });
  const home = path.resolve(os.tmpdir(), 'hermes-gateway-late'), ticket = await gateway.register(tokens.a, { home });
  const handle = gateway.prepare({ assistantId: owners.a.assistantId, userId: owners.a.userId, organizationId: owners.a.organizationId, home });
  const starting = gateway.start(handle); await opened.promise; const closing = gateway.close(handle); await stillPending(closing);
  await assert.rejects(gateway.releaseRegistration(ticket), err('registration_in_use'));
  hold.resolve(); await assert.rejects(starting, err('cancelled')); await closing; assert.equal(closes, 1); assert.throws(() => gateway.setAdmission(handle, true), err('inactive'));
  await gateway.releaseRegistration(ticket); await gateway.releaseRegistration(ticket);
});

test('shutdown prevents new registration and closes both actual transports only once', async t => {
  const f = await fixture(t), a = await f.add(), b = await f.add('b');
  await Promise.all([f.gateway.close(a.handle), f.gateway.shutdown(), f.gateway.shutdown()]);
  assert.equal(a.channel.closes, 1); assert.equal(b.channel.closes, 1);
  await assert.rejects(f.gateway.register(tokens.a, { home: a.binding.home }), err('gateway_closed'));
  assert.throws(() => f.gateway.prepare(a.binding), err('invalid_binding'));
});
