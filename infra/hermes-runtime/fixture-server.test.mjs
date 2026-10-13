import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFixtureBroker } from '../hermes-broker/fixture.mjs';
import { createMcpHttpServer } from '../hermes-broker/mcp-http.mjs';
import { startRuntimeFixture } from './fixture-server.mjs';
import { assertInside, assertMcpDenial } from './runtime-contract.mjs';

test('combined fixture uses the actual broker, isolates actors and rejects model leaks', async (t) => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'hermes-p1-fixture-'));
  const fixture = await createFixtureBroker();
  let injectBackendFailure = false;
  const broker = { ...fixture.broker, async callTool(...args) {
    if (injectBackendFailure) throw new Error('Injected backend outage');
    return fixture.broker.callTool(...args);
  } };
  const service = await startRuntimeFixture({ fixture: { ...fixture, broker }, createMcpHttpServer, outputDir, port: 0, adminPort: 0, host: '127.0.0.1' });
  t.after(async () => { await service.close(); await rm(assertInside(os.tmpdir(), outputDir), { recursive: true }); });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const admin = `http://127.0.0.1:${service.admin.address().port}/control`;
  const bootstrap = Object.fromEntries(await Promise.all(['a', 'b'].map(async (actor) => [actor,
    JSON.parse(await readFile(path.join(outputDir, `${actor}.json`), 'utf8'))])));
  const rpc = async (actor, name = 'crm_auth_context', args = {}) => {
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${bootstrap[actor].token}`, 'MCP-Protocol-Version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return { status: response.status, body: await response.json() };
  };
  await t.test('bearer connection determines A/B actor and org', async () => {
    for (const actor of ['a', 'b']) {
      const result = await rpc(actor);
      assert.equal(result.status, 200);
      const context = JSON.parse(result.body.result.content[0].text);
      assert.equal(context.userId, bootstrap[actor].userId);
      assert.equal(context.organizationId, bootstrap[actor].organizationId);
      assert.match(context.contextVersion, /^[a-f0-9]{64}$/);
    }
  });
  await t.test('direct caller cannot evade tool allowlist or forge actor', async () => {
    assertMcpDenial(await rpc('a', 'fixture_write'), 'tool_not_available');
    assertMcpDenial(await rpc('a', 'crm_auth_context', { userId: bootstrap.b.userId }), 'invalid_request');
    assert.equal((await fetch(`${base}/control`, { method: 'POST' })).status, 404);
  });
  await t.test('forbidden browser/http canary is live and counts an actual request', async () => {
    assert.equal(service.stats.forbiddenNetworkRequests, 0);
    const response = await fetch(`${base}/forbidden-network-tool`);
    assert.deepEqual(await response.json(), { fixture: 'forbidden-tool-reached-network' });
    assert.equal(service.stats.forbiddenNetworkRequests, 1);
  });
  await t.test('an injected broker outage fails the policy-denial verifier over real HTTP', async () => {
    injectBackendFailure = true;
    try {
      const failure = await rpc('a', 'fixture_write');
      assert.equal(JSON.parse(failure.body.result.content[0].text).error, 'backend_unavailable');
      assert.throws(() => assertMcpDenial(failure, 'tool_not_available'));
      assert.throws(() => assertMcpDenial(failure, 'invalid_request'));
      assert.throws(() => assertMcpDenial(failure, 'unauthorized'));
    } finally { injectBackendFailure = false; }
  });
  await t.test('synthetic model accepts A memory and rejects B memory or connection token', async () => {
    const model = (content) => fetch(`${base}/v1/chat/completions`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture-model-a' },
      body: JSON.stringify({ messages: [{ role: 'system', content }, { role: 'user', content: 'FIXTURE_CONTEXT' }],
        tools: [{ type: 'function', function: { name: 'mcp__crm__crm_auth_context' } }] }) });
    assert.equal((await model(bootstrap.a.sentinel)).status, 200);
    assert.equal((await model(bootstrap.b.sentinel)).status, 400);
    assert.equal((await model(bootstrap.a.token)).status, 400);
    assert.equal(service.stats.modelCalls.length, 1);
    assert.equal(service.stats.modelCalls[0].ownMemorySeen, true);
    assert.ok(!JSON.stringify(service.stats).includes(bootstrap.a.token));
    assert.ok(!JSON.stringify(service.stats).includes(bootstrap.b.sentinel));
  });
  await t.test('revocation rejects A while B retains its own connection', async () => {
    const response = await fetch(admin, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'revoke', actor: 'a' }) });
    assert.equal(response.status, 200);
    assertMcpDenial(await rpc('a'), 'unauthorized');
    assert.equal((await rpc('b')).status, 200);
  });
});
