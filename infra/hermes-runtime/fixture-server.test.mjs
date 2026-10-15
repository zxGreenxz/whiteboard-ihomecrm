import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { createFixtureBroker } from '../hermes-broker/fixture.mjs';
import { createMcpHttpServer } from '../hermes-broker/mcp-http.mjs';
import { startRuntimeFixture } from './fixture-server.mjs';
import { assertInside, assertMcpDenial, fixtureMounts, FIXTURE_BROKER_PATH } from './runtime-contract.mjs';

test('fixture starts from only the declared mounts; omitting the external fact module fails before readiness', async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'hermes-p1-mounts-'));
  t.after(() => rm(assertInside(os.tmpdir(), sandbox), { recursive: true }));
  const resolveMount = destination => assertInside(sandbox, path.join(sandbox, destination.slice(1)));
  const spec = { source: path.resolve('infra/hermes-runtime'), brokerSource: path.resolve('infra/hermes-broker'),
    roomSaleFactsSource: path.resolve('src/lib/roomSaleFacts.ts'), output: path.join(sandbox, 'host-output') };
  await mkdir(spec.output);
  for (const mount of fixtureMounts(spec)) {
    const destination = resolveMount(mount.destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(mount.source, destination, { recursive: true });
  }
  const moduleUrl = destination => pathToFileURL(resolveMount(destination)).href;
  // Same dynamic imports as the fixture CLI, but ephemeral loopback ports keep
  // this filesystem/import regression independent of Docker and host services.
  const probe = `
    const { startRuntimeFixture } = await import(${JSON.stringify(moduleUrl('/fixture/fixture-server.mjs'))});
    const { createFixtureBroker } = await import(${JSON.stringify(moduleUrl(`${FIXTURE_BROKER_PATH}/fixture.mjs`))});
    const { createMcpHttpServer } = await import(${JSON.stringify(moduleUrl(`${FIXTURE_BROKER_PATH}/mcp-http.mjs`))});
    const service = await startRuntimeFixture({ fixture: await createFixtureBroker(), createMcpHttpServer,
      outputDir: ${JSON.stringify(resolveMount('/output'))}, port: 0, adminPort: 0, host: '127.0.0.1' });
    try {
      const response = await fetch('http://127.0.0.1:' + service.admin.address().port + '/control', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'health' }) });
      if (!response.ok) throw new Error('Fixture readiness rejected');
      console.log(JSON.stringify(await response.json()));
    } finally { await service.close(); }
  `;
  const run = () => spawnSync(process.execPath, ['--input-type=module', '--eval', probe],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const good = run();
  assert.equal(good.status, 0, good.stderr || good.error?.message);
  assert.deepEqual(JSON.parse(good.stdout), { ready: true });
  // Fresh process avoids module-cache false positives when a mount is absent.
  await rm(resolveMount('/src/lib/roomSaleFacts.ts'));
  const missing = run();
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ERR_MODULE_NOT_FOUND/);
  assert.match(missing.stderr, /roomSaleFacts\.ts/);
  assert.equal(missing.stdout, '');
});

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
