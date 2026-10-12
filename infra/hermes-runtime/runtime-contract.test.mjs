import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { assertFixtureInspection, assertHermesDenial, assertInputsUnchanged, assertInside, assertMcpDenial, assertRuntimeInspection,
  assertUnavailableTerminal, HERMES_IMAGE, NO_FORWARDING, runtimeArgs, runtimeUser, sourceHashes } from './runtime-contract.mjs';
import { modelReply, sseReply } from './fake-model.mjs';

const root = path.resolve('.cache/hermes-p1/test-root');
const spec = { name: 'hermes-p1-test-a', network: 'hermes-p1-test', actor: 'a',
  home: path.join(root, 'a'), bootstrap: path.join(root, 'a.json'), source: path.resolve('infra/hermes-runtime') };
const modelContext = { actor: 'a', sentinels: { a: 'PRIVATE_SENTINEL_A', b: 'PRIVATE_SENTINEL_B' }, connectionTokens: ['hc_synthetic_private'] };
const body = { messages: [{ role: 'system', content: 'PRIVATE_SENTINEL_A' }, { role: 'user', content: 'FIXTURE_CONTEXT' }],
  tools: [{ type: 'function', function: { name: 'mcp__crm__crm_auth_context' } }] };

test('runtime uses a digest and dedicated mounts without host ports or Docker socket', () => {
  const args = runtimeArgs(spec);
  assert.match(HERMES_IMAGE, /^nousresearch\/hermes-agent@sha256:[a-f0-9]{64}$/);
  assert.ok(args.includes('--read-only'));
  assert.equal(args[args.indexOf('--user') + 1], '10000:10000');
  assert.equal(args.filter((v) => v.startsWith('type=bind')).length, 3);
  assert.ok(!args.includes('--publish') && !args.includes('-p') && !args.includes('--privileged'));
  assert.ok(!args.join('\n').includes('docker.sock'));
  assert.ok(!args.join('\n').includes('CLAUDE.local'));
});

test('rejects resource injection, foreign actors and ambiguous bind paths', () => {
  assert.throws(() => runtimeArgs({ ...spec, name: '--privileged' }));
  assert.throws(() => runtimeArgs({ ...spec, actor: 'admin' }));
  assert.throws(() => runtimeArgs({ ...spec, home: path.join(root, 'a,b') }));
  assert.throws(() => runtimeArgs({ ...spec, bootstrap: 'relative.json' }));
});

test('Linux uses the supervisor owner for private bind mounts and rejects root or injected IDs', () => {
  const user = runtimeUser({ platform: 'linux', uid: 1001, gid: 1001 });
  assert.equal(user, '1001:1001');
  assert.equal(runtimeUser({ platform: 'win32', uid: undefined, gid: undefined }), '10000:10000');
  const args = runtimeArgs({ ...spec, user });
  assert.equal(args[args.indexOf('--user') + 1], user);
  const inspected = inspection(); inspected.Config.User = user;
  assert.equal(assertRuntimeInspection(inspected, { ...spec, user }), true);
  assert.throws(() => assertRuntimeInspection(inspected, spec));
  for (const uid of [0, -1, 1.5, '1001', null, NaN, 2147483648]) {
    assert.throws(() => runtimeUser({ platform: 'linux', uid, gid: 1001 }));
  }
  assert.throws(() => runtimeUser({ platform: 'linux', uid: 1001, gid: 0 }));
  for (const value of ['0:1001', '1001:0', 'root', '1001:1001 --privileged', '2147483648:1001']) {
    assert.throws(() => runtimeArgs({ ...spec, user: value }));
  }
});

test('denial verifiers require the expected cause; backend failures cannot satisfy the security check', () => {
  const denial = (error, status = 200) => ({ status, body: { result: {
    isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }],
  } } });
  for (const code of ['tool_not_available', 'invalid_request']) {
    assert.doesNotThrow(() => assertMcpDenial(denial(code), code));
    for (const fault of [denial('backend_unavailable'), denial('unauthorized'),
      { status: 503, body: { error: 'backend_unavailable' } }, { status: 500, body: { error: code } }]) {
      assert.throws(() => assertMcpDenial(fault, code));
    }
    assert.doesNotThrow(() => assertHermesDenial(JSON.stringify({ error: JSON.stringify({ error: code }) }), code));
    assert.throws(() => assertHermesDenial('{"error":"MCP backend failed: 503"}', code));
  }
  assert.doesNotThrow(() => assertMcpDenial({ status: 401, body: { error: 'unauthorized' } }, 'unauthorized'));
  assert.throws(() => assertMcpDenial({ status: 503, body: { error: 'unauthorized' } }, 'unauthorized'));
  assert.doesNotThrow(() => assertHermesDenial('{"error":"Unknown tool: terminal"}', 'unknown_terminal'));
  assert.throws(() => assertHermesDenial('{"error":"terminal backend unavailable"}', 'unknown_terminal'));
  const unauthorizedHttp = [{ actor: 'a', status: 401 }];
  assert.doesNotThrow(() => assertHermesDenial('{"error":"HTTP 401 Unauthorized","needs_reauth":true,"server":"crm"}', 'unauthorized', unauthorizedHttp));
  assert.throws(() => assertHermesDenial('{"error":"auth backend unavailable 503"}', 'unauthorized'));
  const opaque = '{"error":"MCP call failed: MCPError: Server returned an error response"}';
  assert.throws(() => assertHermesDenial(opaque, 'unauthorized'));
  assert.throws(() => assertHermesDenial(opaque, 'unauthorized', [{ actor: 'a', status: 503 }]));
  assert.throws(() => assertHermesDenial(opaque, 'unauthorized', [{ actor: 'b', status: 401 }]));
  assert.doesNotThrow(() => assertHermesDenial(opaque, 'unauthorized', unauthorizedHttp));
  assert.doesNotThrow(() => assertUnavailableTerminal("Tool 'terminal' does not exist. Available tools: mcp__crm__crm_auth_context"));
  assert.throws(() => assertUnavailableTerminal('terminal execution error: backend unavailable'));
  assert.throws(() => assertUnavailableTerminal('FIXTURE_FORBIDDEN_EXECUTION'));
});

test('source receipts fail if an input mutates or disappears between admission and completion', async () => {
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'hash-proof-'));
  await writeFile(path.join(directory, 'input.mjs'), 'original');
  const before = await sourceHashes(directory, ['input.mjs']);
  assertInputsUnchanged(before, await sourceHashes(directory, ['input.mjs']));
  await writeFile(path.join(directory, 'input.mjs'), 'mutated');
  const after = await sourceHashes(directory, ['input.mjs']);
  assert.throws(() => assertInputsUnchanged(before, after));
  assert.throws(() => assertInputsUnchanged(before, {}));
  await assert.rejects(sourceHashes(directory, ['missing.mjs']));
});

test('cache path check rejects root itself and escape paths before any cleanup', () => {
  assert.equal(assertInside(root, spec.home), spec.home);
  assert.throws(() => assertInside(root, root));
  assert.throws(() => assertInside(root, path.resolve(root, '..', 'foreign')));
});

function inspection() {
  return { Config: { User: '10000:10000' }, HostConfig: { ReadonlyRootfs: true, Privileged: false,
    CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], PortBindings: {}, NetworkMode: spec.network,
    Sysctls: { ...NO_FORWARDING },
    Tmpfs: { '/tmp': 'rw,nosuid,nodev,noexec,size=134217728' } },
  NetworkSettings: { Networks: { [spec.network]: {} } }, Mounts: [
    { Type: 'bind', Source: spec.home, Destination: '/opt/data', RW: true },
    { Type: 'bind', Source: spec.bootstrap, Destination: '/run/bootstrap.json', RW: false },
    { Type: 'bind', Source: spec.source, Destination: '/fixture', RW: false },
  ] };
}

test('inspection fails when isolation controls are removed', () => {
  assert.equal(assertRuntimeInspection(inspection(), spec), true);
  for (const mutate of [
    (v) => { v.HostConfig.Privileged = true; },
    (v) => { v.HostConfig.ReadonlyRootfs = false; },
    (v) => { v.HostConfig.CapDrop = []; },
    (v) => { v.HostConfig.NetworkMode = 'host'; },
    (v) => { v.HostConfig.Sysctls['net.ipv4.ip_forward'] = '1'; },
    (v) => { v.NetworkSettings.Networks['hermes-p1-foreign'] = {}; },
    (v) => { v.Mounts.push({ Type: 'bind', Destination: '/var/run/docker.sock', RW: true }); },
    (v) => { v.Mounts[1].RW = true; },
    (v) => { v.Mounts[0].Source = path.join(root, 'foreign-home'); },
    (v) => { v.HostConfig.PortBindings = { '8080/tcp': [{ HostPort: '8080' }] }; },
  ]) {
    const value = inspection(); mutate(value);
    assert.throws(() => assertRuntimeInspection(value, spec));
  }
});

test('fixture explicitly overrides the image volume and rejects anonymous or extra tmpfs mounts', () => {
  const fixtureSpec = { networks: [spec.network, 'hermes-p1-peer-network'], user: '10000:10000', source: spec.source,
    brokerSource: path.resolve('infra/hermes-broker'), output: path.join(root, 'output') };
  const value = inspection();
  value.NetworkSettings.Networks[fixtureSpec.networks[1]] = {};
  value.HostConfig.Tmpfs = { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864',
    '/opt/data': 'ro,nosuid,nodev,noexec,size=1048576' };
  value.Mounts = [
    { Type: 'bind', Source: fixtureSpec.source, Destination: '/fixture', RW: false },
    { Type: 'bind', Source: fixtureSpec.brokerSource, Destination: '/broker', RW: false },
    { Type: 'bind', Source: fixtureSpec.output, Destination: '/output', RW: true },
  ];
  assert.equal(assertFixtureInspection(value, fixtureSpec), true);
  const anonymous = structuredClone(value);
  anonymous.Mounts.push({ Type: 'volume', Source: '/var/lib/docker/volumes/unexpected', Destination: '/opt/data', RW: true });
  assert.throws(() => assertFixtureInspection(anonymous, fixtureSpec), /mount count/);
  const extraTmpfs = structuredClone(value);
  extraTmpfs.HostConfig.Tmpfs['/unexpected'] = 'rw';
  assert.throws(() => assertFixtureInspection(extraTmpfs, fixtureSpec), /tmpfs/);
  const writableOverride = structuredClone(value);
  writableOverride.HostConfig.Tmpfs['/opt/data'] = 'rw';
  assert.throws(() => assertFixtureInspection(writableOverride, fixtureSpec), /tmpfs/);
  const shared = { ...fixtureSpec, networks: [spec.network, spec.network] };
  assert.throws(() => assertFixtureInspection(value, shared), /distinct actor networks/);
  const forwarding = structuredClone(value);
  forwarding.HostConfig.Sysctls['net.ipv4.ip_forward'] = '1';
  assert.throws(() => assertFixtureInspection(forwarding, fixtureSpec), /route between networks/);
});

test('model forces a real MCP call and records only sanitized evidence', () => {
  const value = modelReply(body, modelContext);
  assert.equal(value.response.choices[0].message.tool_calls[0].function.name, 'mcp__crm__crm_auth_context');
  assert.equal(value.audit.ownMemorySeen, true);
  assert.ok(!JSON.stringify(value.audit).includes('PRIVATE_SENTINEL_A'));
  assert.match(sseReply(value.response), /data: \[DONE\]/);
});

test('model rejects foreign memory, credential leaks and extra tool surface', () => {
  for (const content of ['PRIVATE_SENTINEL_B', 'hc_synthetic_private']) {
    assert.throws(() => modelReply({ ...body, messages: [...body.messages, { role: 'user', content }] }, modelContext));
  }
  assert.throws(() => modelReply({ ...body, tools: [{ function: { name: 'terminal' } }] }, modelContext));
  assert.throws(() => modelReply(body, { ...modelContext, actor: 'admin' }));
});

test('adversarial fixture emits an unavailable tool rather than a success-only model', () => {
  const value = modelReply({ ...body, messages: [{ role: 'user', content: 'FIXTURE_FORBIDDEN_TOOL' }] }, modelContext);
  assert.equal(value.response.choices[0].message.tool_calls[0].function.name, 'terminal');
  const spoof = modelReply({ ...body, messages: [{ role: 'user', content: 'FIXTURE_SPOOF_IDENTITY' }] }, modelContext);
  assert.equal(JSON.parse(spoof.response.choices[0].message.tool_calls[0].function.arguments).userId, 'synthetic-other-user');
});

test('missing daemon is a nonzero BLOCKED receipt, never an empty runtime pass', () => {
  // Node deliberately stands in for an unavailable Docker executable; no daemon
  // or container is contacted by this unit check.
  const result = spawnSync(process.execPath, ['scripts/test-hermes-runtime-isolation.mjs', '--preflight'], {
    encoding: 'utf8', windowsHide: true, env: { ...process.env, HERMES_FIXTURE_DOCKER: process.execPath },
  });
  assert.equal(result.status, 2);
  const match = result.stdout.match(/Receipt: ([^\r\n]+)/);
  assert.ok(match, result.stderr);
  const receipt = JSON.parse(readFileSync(path.resolve(match[1]), 'utf8'));
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.checks.length, 0);
  assert.equal(receipt.stage, 'daemon');
  assert.ok(receipt.error);
});
