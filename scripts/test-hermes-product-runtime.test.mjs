import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createSyntheticFixture, connectSynthetic, createProductWorkspace, closeProductServices, observedEngine, productFailureCode, productInputFiles, MODEL } from './test-hermes-product-runtime.mjs';
import { createHermesBackend } from '../infra/hermes-broker/server.mjs';
import { createContainerRuntime } from '../infra/hermes-runtime/container-driver.mjs';
import { createGatewayTransport } from '../infra/hermes-runtime/gateway-transport.mjs';
import { HERMES_IMAGE } from '../infra/hermes-runtime/runtime-contract.mjs';

test('engine lifecycle receipt preserves bounded safe state diagnostics without inspection payloads or stderr', async () => {
  const child = new EventEmitter(), id = 'a'.repeat(64), evidence = { attaches: 0, childCloses: 0 };
  const inspection = { State: { Status: 'created', Running: false, Dead: false, Restarting: false, OOMKilled: false, ExitCode: 0,
    Error: 'PRIVATE-ENGINE-ERROR' }, Config: { Env: ['TOKEN=PRIVATE-TOKEN'], Labels: { 'ihome.hermes.role': 'gateway' } } };
  const engine = observedEngine({ inspectContainer: async () => inspection, attachStart: () => child }, evidence);
  assert.equal(await engine.inspectContainer(id), inspection);
  assert.deepEqual(evidence.lifecycle[0], { operation: 'inspect', containerId: id, role: 'gateway', status: 'created', running: false,
    dead: false, restarting: false, oomKilled: false, exitCode: 0 });
  assert.equal(engine.attachStart(id), child); child.emit('close', 1, null);
  assert.equal(evidence.attaches, 1); assert.equal(evidence.childCloses, 1);
  assert.deepEqual(evidence.lifecycle[1], { operation: 'attach-close', containerId: id, exitCode: 1, signal: null });
  inspection.State = { Status: 'PRIVATE-STATUS', Running: 'PRIVATE-RUNNING', ExitCode: 1000 };
  inspection.Config.Labels['ihome.hermes.role'] = 'PRIVATE-ROLE';
  for (let index = 0; index < 30; index++) await engine.inspectContainer('PRIVATE-ID');
  assert.equal(evidence.lifecycle.length, 24); assert(!JSON.stringify(evidence).includes('PRIVATE'));
  assert.deepEqual(evidence.lifecycle[0], { operation: 'inspect', containerId: null, role: null, status: 'unknown', running: null,
    dead: null, restarting: null, oomKilled: null, exitCode: null });
});

test('product workspace keeps native socket below the product limit independently of checkout depth', async t => {
  const workspace = await createProductWorkspace();
  t.after(async () => { await rmdir(workspace.gatewayRoot); await rmdir(workspace.runtimeRoot); await rmdir(workspace.directory); });
  assert.equal(path.dirname(workspace.directory), await realpath(os.tmpdir()));
  assert(!workspace.directory.includes('hermes-product'));
  assert.deepEqual(await readdir(workspace.gatewayRoot), []); assert.deepEqual(await readdir(workspace.runtimeRoot), []);
  if (process.platform !== 'win32') {
    const socket = path.join(workspace.gatewayRoot, randomUUID(), 's', 'gateway.sock');
    assert(Buffer.byteLength(socket) <= 100);
    for (const directory of Object.values(workspace)) assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  }
  // This is the old layout's relative suffix alone, before any checkout prefix.
  const previous = path.posix.join('.cache/hermes-product', `run-1791892609552-${randomUUID()}`, 'gateways', randomUUID(), 's/gateway.sock');
  assert(Buffer.byteLength(previous) > 100);
});

test('an oversized OS temp root is rejected before allocating a workspace, with a fixed safe diagnostic', async t => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'hp-test-'));
  assert.equal(path.dirname(parent), os.tmpdir());
  t.after(() => rm(parent, { recursive: true, force: true }));
  const long = path.join(parent, 'long-'.repeat(20)); await mkdir(long);
  await assert.rejects(createProductWorkspace({ temporaryRoot: long, platform: 'linux' }), /workspace_socket_path_too_long/);
  assert.deepEqual(await readdir(long), []);
  for (const code of ['workspace_socket_path_too_long', 'runtime_start_failed', 'gateway_cleanup_unproven']) {
    assert.equal(productFailureCode(Error(code)), code); assert.equal(productFailureCode({ code }), code);
  }
  for (const error of [Error('PRIVATE-TOKEN-DO-NOT-LOG'), { code: 'private_token' }, Error('ENOENT /private/runtime'), null]) {
    assert.equal(productFailureCode(error), 'synthetic_check_failed');
  }
});

test('actual driver and gateway transport reach network allocation from the bounded workspace without a logical-home directory', async t => {
  const workspace = await createProductWorkspace(), data = createSyntheticFixture(), backend = createHermesBackend(data.configuration);
  const events = [], controller = new AbortController();
  const provenance = JSON.parse(await readFile(new URL('../infra/hermes-runtime/image-provenance.json', import.meta.url)));
  const image = { Id: provenance.expectedConfigDigest, RepoDigests: [HERMES_IMAGE], Os: 'linux', Architecture: 'amd64', Config: { Labels: {} } };
  const engine = {
    async preflight() { events.push('preflight'); return { os: 'linux', version: '28.0.4', nativeHost: true }; },
    async inspectImage() { return image; },
    async createNetwork() { events.push('create-network'); throw Error('synthetic-boundary-reached'); },
  };
  for (const key of ['inspectNetwork', 'removeNetwork', 'create', 'attachStart', 'inspectContainer', 'kill', 'wait', 'remove']) {
    engine[key] = () => assert.fail(`unexpected external operation ${key}`);
  }
  const relayPath = new URL('../infra/hermes-runtime/gateway-relay.mjs', import.meta.url), wrapperPath = new URL('../infra/hermes-runtime/agent-process.py', import.meta.url);
  const digest = async target => createHash('sha256').update(await readFile(target)).digest('hex');
  const transport = createGatewayTransport({ engine, gatewayRoot: workspace.gatewayRoot, relayPath: fileURLToPath(relayPath),
    relaySha256: await digest(relayPath), platform: 'linux' });
  const gateway = backend.createRuntimeGateway({ transport, allowedModels: [MODEL] });
  const runtime = createContainerRuntime({ gateway, engine, runtimeRoot: workspace.runtimeRoot, wrapperPath: fileURLToPath(wrapperPath), wrapperSha256: await digest(wrapperPath), model: MODEL });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    controller.abort();
    await assert.rejects(closeProductServices(gateway, backend, data), error => {
      assert(error instanceof AggregateError); assert.equal(error.errors.length, 2);
      for (const failure of error.errors) assert.equal(failure.code, 'drain_failed');
      return true;
    });
    // Engine is synthetic and cannot allocate resources. The real transport has
    // already closed its listener; its retained receipt is safe to remove here.
    assert.equal(path.dirname(workspace.directory), await realpath(os.tmpdir()));
    await rm(workspace.directory, { recursive: true, force: true });
  });
  const actor = data.actors[0], token = await connectSynthetic(backend, actor), home = path.join(workspace.directory, 'logical-home'); data.grantRooms(actor);
  await assert.rejects(lstat(home), { code: 'ENOENT' });
  await gateway.register(token, { home, signal: controller.signal });
  const handle = runtime.prepare({ binding: { assistantId: actor.assistant, userId: actor.user, organizationId: actor.org, home }, admission: false, signal: controller.signal });
  await assert.rejects(runtime.start(handle), /runtime_start_failed/);
  assert.deepEqual(events, ['preflight', 'preflight', 'create-network']);
  await assert.rejects(runtime.stop(handle), /runtime_stop_unproven/);
});

async function fixture(t) {
  const data = createSyntheticFixture(), backend = createHermesBackend(data.configuration), channels = [];
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const transport = { async open({ handler }) {
    const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); channels.push(server);
    return { descriptor: { networkName: 'product-fixture', networkId: 'a'.repeat(64), mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' },
      close: async () => { const closing = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closing; } };
  } };
  const gateway = backend.createRuntimeGateway({ transport, allowedModels: [MODEL] });
  t.after(() => closeProductServices(gateway, backend, data));
  const actor = data.actors[0], token = await connectSynthetic(backend, actor); data.grantRooms(actor);
  const home = path.resolve('.cache/synthetic-product-home'), signal = new AbortController().signal;
  await gateway.register(token, { home, signal });
  const handle = gateway.prepare({ home, assistantId: actor.assistant, userId: actor.user, organizationId: actor.org });
  await gateway.start(handle, { signal }); gateway.setAdmission(handle, true);
  const send = (url, body) => new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: channels[0].address().port, path: url, method: 'POST',
      headers: { host: 'hermes-gateway:8787', 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }); } catch (error) { reject(error); } });
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  return { ...data, backend, gateway, handle, send, actor, token };
}
const rpc = (name, sequence = 1) => ({ jsonrpc: '2.0', id: sequence, method: 'tools/call', params: { name, arguments: {} } });

test('synthetic fixture drives real backend AEAD/Auth/model/room projection with exact MCP tool results', async t => {
  const f = await fixture(t), commandId = randomUUID(); f.gateway.beginTurn(f.handle, { commandId });
  const listed = await f.send('/mcp', { jsonrpc: '2.0', id: 0, method: 'tools/list', params: {} }); assert.equal(listed.status, 200);
  const tools = listed.body.result.tools.map(tool => ({ type: 'function', function: { name: `mcp__crm__${tool.name}`, description: tool.description, parameters: tool.inputSchema } }));
  const body = { model: MODEL, stream: false, max_tokens: 256, tools,
    messages: [{ role: 'user', content: 'SYNTHETIC_A_PROMPT list available rooms' }] };
  const first = await f.send('/v1/chat/completions', body); assert.equal(first.status, 200);
  const calls = first.body.choices[0].message.tool_calls; assert.equal(calls.length, 2);
  body.messages.push(first.body.choices[0].message);
  for (const [index, call] of calls.entries()) {
    const result = await f.send('/mcp', rpc(call.function.name.replace('mcp__crm__', ''), index + 1)); assert.equal(result.status, 200); assert.equal(result.body.result.isError, false);
    body.messages.push({ role: 'tool', tool_call_id: call.id, content: result.body.result.content[0].text });
  }
  const answer = await f.send('/v1/chat/completions', body); assert.equal(answer.status, 200); assert.equal(answer.body.choices[0].message.content, 'SYNTHETIC_A_ROOM_101_VERIFIED');
  assert.equal(f.actor.modelCalls, 2); assert.equal(f.actor.roomReads, 1); assert.equal(f.actor.toolPairs, 1);
  assert(!JSON.stringify(answer).includes(f.token)); assert(!JSON.stringify(answer).includes(f.actor.assistantJwt));
  await f.gateway.endTurn(f.handle, { commandId });
  f.revoke(f.actor); const denied = await f.send('/mcp', rpc('crm_auth_context')); assert(denied.status >= 400); assert.equal(f.actor.modelCalls, 2);
});

test('synthetic model fails closed on fabricated missing tools, foreign actor data or missing room result', async t => {
  const f = await fixture(t), signal = new AbortController().signal;
  const headers = { authorization: `Bearer ${f.actor.assistantJwt}`, 'x-organization-id': f.actor.org, 'x-task-id': randomUUID() };
  const names = ['crm_auth_context', 'crm_available_rooms'];
  const body = { model: MODEL, stream: false, max_tokens: 256, tools: names.map(name => ({ function: { name: `mcp__crm__${name}` } })),
    messages: [{ role: 'user', content: 'SYNTHETIC_A_PROMPT' }] };
  const send = value => f.configuration.fetch('https://synthetic.supabase.invalid/functions/v1/llm-proxy/chat/completions', { headers, signal, redirect: 'error', body: JSON.stringify(value) });
  await assert.rejects(send({ ...body, tools: [] }));
  await assert.rejects(send({ ...body, messages: [{ role: 'user', content: `SYNTHETIC_A_PROMPT ${f.actors[1].room}` }] }));
  await assert.rejects(send({ ...body, messages: [...body.messages, { role: 'tool', content: f.actor.user }] }));
  await assert.rejects(send({ ...body, messages: [...body.messages, { role: 'tool', content: f.actor.user }, { role: 'tool', content: 'A-101' }] }));
  assert.equal(f.actor.toolPairs, 0);
});

test('synthetic optional action RPC is absent with exact PostgREST shape and actor scope', async () => {
  const f = createSyntheticFixture(), actor = f.actors[0];
  try {
    const input = { method: 'POST', headers: { authorization: `Bearer ${actor.browserJwt}` }, signal: new AbortController().signal,
      redirect: 'error', body: JSON.stringify({ p_organization_id: actor.org }) };
    const response = await f.configuration.fetch('https://synthetic.supabase.invalid/rest/v1/rpc/hermes_group_action_context_v1', input);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { code: 'PGRST202', message: 'Synthetic optional RPC absent', details: null, hint: null });
    await assert.rejects(f.configuration.fetch('https://synthetic.supabase.invalid/rest/v1/rpc/hermes_group_action_context_v1', {
      ...input, body: JSON.stringify({ p_organization_id: f.actors[1].org }),
    }));
  } finally { f.dispose(); }
});

test('product cleanup closes the real backend listener after gateway shutdown rejects', async () => {
  const f = createSyntheticFixture(), backend = createHermesBackend(f.configuration), failure = Error('synthetic shutdown failure');
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  let disposed = false;
  await assert.rejects(closeProductServices({ shutdown: async () => { throw failure; } }, backend,
    { dispose() { disposed = true; f.dispose(); } }), error => {
    assert(error instanceof AggregateError); assert.deepEqual(error.errors, [failure]); return true;
  });
  assert.equal(backend.server.listening, false); assert.equal(disposed, true);
});

test('both synthetic users activate distinct encrypted sessions and revoke A leaves live B authority', async t => {
  const f = createSyntheticFixture(), backend = createHermesBackend(f.configuration);
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  t.after(() => closeProductServices(undefined, backend, f));
  const tokens = await Promise.all(f.actors.map(actor => connectSynthetic(backend, actor)));
  assert.notEqual(tokens[0], tokens[1]);
  for (const [index, actor] of f.actors.entries()) {
    const context = await backend.resolveConnection(tokens[index], { signal: new AbortController().signal });
    assert.equal(context.userId, actor.user); assert.equal(context.organizationId, actor.org);
    assert(!JSON.stringify(actor.joined.session.envelope).includes(actor.assistantJwt));
  }
  f.revoke(f.actors[0]);
  await assert.rejects(backend.resolveConnection(tokens[0], { signal: new AbortController().signal }));
  assert.equal((await backend.resolveConnection(tokens[1], { signal: new AbortController().signal })).userId, f.actors[1].user);
});

test('receipt hashes cover actual product dependencies and workflow; harness has no alternate runtime implementation', async () => {
  const inputs = await productInputFiles();
  for (const file of ['infra/hermes-runtime/agent-process.py', 'infra/hermes-runtime/container-driver.mjs', 'infra/hermes-runtime/gateway-transport.mjs',
    'infra/hermes-runtime/runtime-gateway.mjs', 'infra/hermes-runtime/gateway-relay.mjs', 'infra/hermes-runtime/image-provenance.json',
    'infra/hermes-broker/server.mjs', 'infra/hermes-broker/runtime-model-service.mjs', 'infra/hermes-broker/broker.mjs',
    'infra/hermes-broker/dependency-scope.mjs', 'src/lib/roomSaleFacts.ts', 'worker/lib/hermes-link.js', '.github/workflows/hermes-runtime.yml']) assert(inputs.includes(file), file);
  const source = await readFile(new URL('./test-hermes-product-runtime.mjs', import.meta.url), 'utf8');
  assert(!source.includes('execFile(')); assert(!source.includes('spawn(')); assert(!source.includes("['rm', '-f'"));
  assert(source.includes('createContainerRuntime({ gateway, engine'));
  assert(source.includes('backend.createRuntimeGateway({ transport'));
  assert(source.includes('workspace = await createProductWorkspace()'));
  assert(source.includes('const { gatewayRoot, runtimeRoot } = workspace'));
  assert(source.includes('await rmdir(workspace.gatewayRoot); await rmdir(workspace.runtimeRoot); await rmdir(workspace.directory)'));
  assert(source.includes('await pair.drained')); assert(source.includes('await runtime.stop(entry.handle)') || source.includes('return runtime.stop(entry.handle)'));
  assert(source.includes('await gateway.releaseRegistration(ticket)'));
  // Checkout + Node is sufficient for the JS host harness. Python dependencies
  // come exclusively from the pinned image, never npm/uv installation here.
  for (const file of inputs.filter(file => /\.(mjs|js|ts)$/.test(file))) {
    const content = await readFile(file, 'utf8');
    for (const match of content.matchAll(/(?:from\s+|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      assert(match[1].startsWith('node:') || match[1].startsWith('.'), `${file}: external dependency ${match[1]}`);
    }
  }
});
