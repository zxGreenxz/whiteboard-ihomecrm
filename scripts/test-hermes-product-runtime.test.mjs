import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createSyntheticFixture, connectSynthetic, productInputFiles, MODEL } from './test-hermes-product-runtime.mjs';
import { createHermesBackend } from '../infra/hermes-broker/server.mjs';

async function fixture(t) {
  const data = createSyntheticFixture(), backend = createHermesBackend(data.configuration), channels = [];
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const transport = { async open({ handler }) {
    const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); channels.push(server);
    return { descriptor: { networkName: 'product-fixture', networkId: 'a'.repeat(64), mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' },
      close: async () => { const closing = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closing; } };
  } };
  const gateway = backend.createRuntimeGateway({ transport, allowedModels: [MODEL] });
  t.after(async () => { await gateway.shutdown(); await backend.close(); data.dispose(); });
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

test('both synthetic users activate distinct encrypted sessions and revoke A leaves live B authority', async t => {
  const f = createSyntheticFixture(), backend = createHermesBackend(f.configuration);
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await backend.close(); f.dispose(); });
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
    'infra/hermes-broker/dependency-scope.mjs', '.github/workflows/hermes-runtime.yml']) assert(inputs.includes(file), file);
  const source = await readFile(new URL('./test-hermes-product-runtime.mjs', import.meta.url), 'utf8');
  assert(!source.includes('execFile(')); assert(!source.includes('spawn(')); assert(!source.includes("['rm', '-f'"));
  assert(source.includes('createContainerRuntime({ gateway, engine'));
  assert(source.includes('backend.createRuntimeGateway({ transport'));
  assert(source.includes('await pair.drained')); assert(source.includes('await runtime.stop(entry.handle)') || source.includes('return runtime.stop(entry.handle)'));
  assert(source.includes('await gateway.releaseRegistration(ticket)'));
  // Checkout + Node is sufficient for the JS host harness. Python dependencies
  // come exclusively from the pinned image, never npm/uv installation here.
  for (const file of inputs.filter(file => file.endsWith('.mjs'))) {
    const content = await readFile(file, 'utf8');
    for (const match of content.matchAll(/(?:from\s+|import\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      assert(match[1].startsWith('node:') || match[1].startsWith('.'), `${file}: external dependency ${match[1]}`);
    }
  }
});
