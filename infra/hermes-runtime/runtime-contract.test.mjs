import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import { Resolver } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { assertEgressProof, assertFixtureInspection, assertHermesDenial, assertImageProvenance, assertInputsUnchanged, assertInside,
  assertIsolatedNetwork, assertMcpDenial, assertPinnedImageInspection, assertRuntimeInspection, assertUnavailableTerminal, assertUnavailableTool,
  DNS_OPTIONS, HERMES_COMMIT, HERMES_IMAGE, ISOLATED_GATEWAY_OPTIONS, NO_FORWARDING, PRIVATE_DNS,
  controlBridgeAddresses, isolatedNetworkArgs, runtimeArgs, runtimeUser, sourceHashes,
  fixtureMounts, fixtureFailureDiagnostics, sanitizeFixtureDiagnostic } from './runtime-contract.mjs';
import { modelReply, sseReply } from './fake-model.mjs';
import { CANARY_REPLY, dnsReply, startEgressCanary, startHostCanary } from './egress-canary.mjs';

const root = path.resolve('.cache/hermes-p1/test-root');
const spec = { name: 'hermes-p1-test-a', network: 'hermes-p1-test', actor: 'a',
  home: path.join(root, 'a'), bootstrap: path.join(root, 'a.json'), source: path.resolve('infra/hermes-runtime') };
const modelContext = { actor: 'a', sentinels: { a: 'PRIVATE_SENTINEL_A', b: 'PRIVATE_SENTINEL_B' }, connectionTokens: ['hc_synthetic_private'] };
const body = { messages: [{ role: 'system', content: 'PRIVATE_SENTINEL_A' }, { role: 'user', content: 'FIXTURE_CONTEXT' }],
  tools: [{ type: 'function', function: { name: 'mcp__crm__crm_auth_context' } }] };
const imageProvenance = JSON.parse(readFileSync(new URL('./image-provenance.json', import.meta.url), 'utf8'));

test('host canary binds observed bridge addresses when automatic IPAM Gateway fields are absent', () => {
  const network = { Id: 'a'.repeat(64), Driver: 'bridge', Internal: true, EnableIPv6: true, Options: {},
    IPAM: { Config: [{ Subnet: '172.22.0.0/16' }, { Subnet: 'fd01:2:3:4::/64' }] } };
  const entries = [{ address: '172.22.0.1', internal: false }, { address: 'fd01:2:3:4::1', internal: false },
    { address: 'fe80::1', internal: false }];
  assert.deepEqual(controlBridgeAddresses(network, { 'br-aaaaaaaaaaaa': entries }),
    { interface: 'br-aaaaaaaaaaaa', ipv4: '172.22.0.1', ipv6: 'fd01:2:3:4::1' });
  network.Options['com.docker.network.bridge.name'] = 'control-proof';
  assert.equal(controlBridgeAddresses(network, { 'control-proof': entries }).interface, 'control-proof');
  for (const mutate of [
    n => { n.Internal = false; }, n => { n.EnableIPv6 = false; },
    n => { n.Options['com.docker.network.bridge.gateway_mode_ipv6'] = 'isolated'; },
    n => { n.IPAM.Config[0].Gateway = '172.22.0.99'; },
    n => { n.IPAM.Config[1].Subnet = 'fd01:2:3:5::/64'; },
  ]) {
    const changed = structuredClone(network); mutate(changed);
    assert.throws(() => controlBridgeAddresses(changed, { 'control-proof': entries }));
  }
  assert.throws(() => controlBridgeAddresses(network, {}));
  assert.throws(() => controlBridgeAddresses(network, { 'control-proof': entries.slice(0, 1) }));
  assert.throws(() => controlBridgeAddresses(network, { 'control-proof': [...entries, { address: '172.22.0.2', internal: false }] }));
  assert.throws(() => controlBridgeAddresses(network, { 'control-proof': entries.map(row => ({ ...row, internal: true })) }));
});

test('reviewed release receipt binds the pinned amd64 image without claiming a signature or revision label', () => {
  const value = assertImageProvenance(imageProvenance);
  assert.equal(value.kind, 'unsigned_release_receipt'); assert.equal(value.artifactVerified, true);
  assert.equal(value.signatureVerified, false); assert.equal(value.revisionLabelVerified, false);
  assert.equal(value.imageInspectionVerified, false); assert.equal(value.sourceCommit, HERMES_COMMIT);
  assert.equal(value.platformManifestDigest, HERMES_IMAGE.split('@')[1]);
  assert.notEqual(value.platformManifestDigest, 'sha256:32d095e84190ae7266afbb361579e6921f2c633e899f5eacfb88111b9c851a22');
});

test('provenance mutations cannot substitute source, release, manifest bytes, config or a signature claim', () => {
  for (const mutate of [
    v => { v.kind = 'signed_attestation'; }, v => { v.tag.signatureVerified = true; },
    v => { v.tag.objectSha = '0'.repeat(40); }, v => { v.tag.apiUrl = 'https://untrusted.invalid/tag'; },
    v => { v.tag.raw += ' '; }, v => { v.tag.raw = v.tag.raw.replace('type commit', 'type blob'); },
    v => { v.repositoryUrl = 'https://untrusted.invalid/repository'; }, v => { v.releaseUrl += '-other'; },
    v => { v.tag.commit = '0'.repeat(40); },
    v => { v.releaseReceipt.commit = '0'.repeat(40); v.tag.receiptMessage = JSON.stringify(v.releaseReceipt); },
    v => { v.releaseReceipt.version = '0.21.5'; v.tag.receiptMessage = JSON.stringify(v.releaseReceipt); },
    v => { v.releaseReceipt.version = '0.21.5'; }, v => { v.tag.receiptMessage = '{}'; },
    v => { v.index.raw += ' '; }, v => { v.index.raw = '{}'; },
    v => { v.index.digest = `sha256:${'0'.repeat(64)}`; }, v => { v.index.url += '?tag=v0.21.6'; },
    v => { v.platformManifest.raw += ' '; }, v => { v.platformManifest.raw = '{}'; },
    v => { v.platformManifest.digest = `sha256:${'0'.repeat(64)}`; }, v => { v.platformManifest.url += '?tag=v0.21.6'; },
    v => { v.expectedConfigDigest = `sha256:${'0'.repeat(64)}`; },
  ]) {
    const changed = structuredClone(imageProvenance); mutate(changed);
    assert.throws(() => assertImageProvenance(changed));
  }
});

test('even rehashed receipt/index mutations cannot remove, duplicate or replace the pinned platform member', () => {
  for (const mutate of [
    v => { v.manifests = v.manifests.filter(m => m.platform.architecture !== 'amd64'); },
    v => { v.manifests.push(structuredClone(v.manifests.find(m => m.platform.architecture === 'amd64'))); },
    v => { v.manifests.find(m => m.platform.architecture === 'amd64').digest = 'sha256:32d095e84190ae7266afbb361579e6921f2c633e899f5eacfb88111b9c851a22'; },
    v => { v.manifests.find(m => m.platform.architecture === 'amd64').size++; },
    v => { v.manifests.find(m => m.platform.architecture === 'amd64').platform.os = 'windows'; },
    v => { v.mediaType = 'application/vnd.oci.image.index.v1+json'; },
  ]) {
    const changed = structuredClone(imageProvenance), index = JSON.parse(changed.index.raw); mutate(index);
    changed.index.raw = JSON.stringify(index);
    changed.index.digest = `sha256:${createHash('sha256').update(changed.index.raw).digest('hex')}`;
    changed.index.url = `https://registry-1.docker.io/v2/nousresearch/hermes-agent/manifests/${changed.index.digest}`;
    changed.releaseReceipt.dockerManifestDigest = changed.index.digest;
    changed.tag.receiptMessage = JSON.stringify(changed.releaseReceipt);
    assert.throws(() => assertImageProvenance(changed));
  }
});

test('live image inspection must match both the receipt config ID and pinned RepoDigest', () => {
  const inspected = { Id: imageProvenance.expectedConfigDigest, RepoDigests: [HERMES_IMAGE],
    Os: 'linux', Architecture: 'amd64', Config: { Labels: null } };
  const result = assertPinnedImageInspection(inspected, imageProvenance);
  assert.equal(result.imageInspectionVerified, true); assert.equal(result.signatureVerified, false);
  assert.equal(result.revisionLabelVerified, false);
  assert.equal(assertPinnedImageInspection({ ...inspected, Config: { Labels: { 'org.opencontainers.image.revision': HERMES_COMMIT } } }, imageProvenance).revisionLabelVerified, true);
  for (const mutate of [v => { v.Id = `sha256:${'0'.repeat(64)}`; }, v => { v.RepoDigests = []; },
    v => { v.RepoDigests = ['nousresearch/hermes-agent:v0.21.6']; }, v => { v.Os = 'windows'; },
    v => { v.Architecture = 'arm64'; }, v => { v.Config.Labels = { 'org.opencontainers.image.revision': '' }; },
    v => { v.Config.Labels = { 'org.opencontainers.image.revision': '0'.repeat(40) }; }]) {
    const changed = structuredClone(inspected); mutate(changed);
    assert.throws(() => assertPinnedImageInspection(changed, imageProvenance));
  }
});

test('runtime uses a digest and dedicated mounts without host ports or Docker socket', () => {
  const args = runtimeArgs(spec);
  assert.match(HERMES_IMAGE, /^nousresearch\/hermes-agent@sha256:[a-f0-9]{64}$/);
  assert.ok(args.includes('--read-only'));
  assert.equal(args[args.indexOf('--user') + 1], '10000:10000');
  assert.equal(args.filter((v) => v.startsWith('type=bind')).length, 3);
  assert.ok(!args.includes('--publish') && !args.includes('-p') && !args.includes('--privileged'));
  assert.ok(!args.join('\n').includes('docker.sock'));
  assert.ok(!args.join('\n').includes('CLAUDE.local'));
  assert.equal(args[args.indexOf('--dns') + 1], '127.0.0.1');
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
    Sysctls: { ...NO_FORWARDING }, Dns: [...PRIVATE_DNS], DnsOptions: [...DNS_OPTIONS],
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
    (v) => { v.HostConfig.Dns = []; },
    (v) => { v.HostConfig.Dns = ['8.8.8.8']; },
    (v) => { v.HostConfig.DnsOptions = []; },
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
    brokerSource: path.resolve('infra/hermes-broker'), roomSaleFactsSource: path.resolve('src/lib/roomSaleFacts.ts'),
    output: path.join(root, 'output') };
  const value = inspection();
  value.NetworkSettings.Networks[fixtureSpec.networks[1]] = {};
  value.HostConfig.Tmpfs = { '/tmp': 'rw,nosuid,nodev,noexec,size=67108864',
    '/opt/data': 'ro,nosuid,nodev,noexec,size=1048576' };
  const expected = [
    { Type: 'bind', Source: fixtureSpec.source, Destination: '/fixture', RW: false },
    { Type: 'bind', Source: fixtureSpec.brokerSource, Destination: '/infra/hermes-broker', RW: false },
    { Type: 'bind', Source: fixtureSpec.roomSaleFactsSource, Destination: '/src/lib/roomSaleFacts.ts', RW: false },
    { Type: 'bind', Source: fixtureSpec.output, Destination: '/output', RW: true },
  ];
  value.Mounts = fixtureMounts(fixtureSpec).map(({ source, destination, writable }) =>
    ({ Type: 'bind', Source: source, Destination: destination, RW: writable }));
  assert.deepEqual(value.Mounts, expected);
  assert.equal(assertFixtureInspection(value, fixtureSpec), true);
  for (const mutate of [
    v => { v.Mounts.splice(2, 1); },
    v => { v.Mounts[2].RW = true; },
    v => { v.Mounts[2].Source = path.resolve('src'); },
    v => { v.Mounts[2].Destination = '/src'; },
    v => { v.Mounts[1].Destination = '/broker'; },
  ]) {
    const invalid = structuredClone(value); mutate(invalid);
    assert.throws(() => assertFixtureInspection(invalid, fixtureSpec), /mount/);
  }
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

test('fixture failure diagnostics retain startup errors, redact private values and survive inspection/log failure', async () => {
  const calls = [];
  const result = await fixtureFailureDiagnostics(async args => {
    calls.push(args);
    return args[0] === 'inspect' ? { stdout: JSON.stringify({ Status: 'exited', Running: false,
      ExitCode: 1, OOMKilled: false, Error: 'untrusted ignored field', Pid: 123 }) } :
      { stdout: 'synthetic fixture', stderr: 'ERR_MODULE_NOT_FOUND roomSaleFacts.ts hc_secret PRIVATE_A_secret Bearer arbitrary private-exact' };
  }, 'hermes-p1-test-fixture', ['private-exact']);
  assert.deepEqual(calls, [['inspect', '--format', '{{json .State}}', 'hermes-p1-test-fixture'],
    ['logs', '--tail', '80', 'hermes-p1-test-fixture']]);
  assert.deepEqual(result.state, { status: 'exited', running: false, exitCode: 1, oomKilled: false });
  assert.match(result.logs, /ERR_MODULE_NOT_FOUND roomSaleFacts.ts/);
  for (const secret of ['hc_secret', 'PRIVATE_A_secret', 'arbitrary', 'private-exact']) assert.ok(!result.logs.includes(secret));
  const unavailable = await fixtureFailureDiagnostics(async () => { throw Object.assign(new Error('untrusted command error'),
    { stderr: 'partial hzn_secret' }); }, 'hermes-p1-test-fixture');
  assert.equal(unavailable.stateUnavailable, true); assert.equal(unavailable.logsUnavailable, true);
  assert.ok(!unavailable.logs.includes('hzn_secret'));
  const boundary = sanitizeFixtureDiagnostic('x'.repeat(5990) + ' hc_' + 's'.repeat(80));
  assert.equal(boundary.length, 6000); assert.ok(!boundary.includes('hc_'));
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
  for (const [suffix, tool] of [['_BROWSER', 'browser_navigate'], ['_HTTP', 'web_extract']]) {
    const output = modelReply({ ...body, messages: [{ role: 'user', content: `FIXTURE_FORBIDDEN_TOOL${suffix}` }] }, modelContext);
    assert.equal(output.response.choices[0].message.tool_calls[0].function.name, tool);
    assertUnavailableTool(`Tool '${tool}' does not exist. Available tools: mcp__crm__crm_auth_context`, tool);
    assert.throws(() => assertUnavailableTool('network unavailable', tool));
  }
  const spoof = modelReply({ ...body, messages: [{ role: 'user', content: 'FIXTURE_SPOOF_IDENTITY' }] }, modelContext);
  assert.equal(JSON.parse(spoof.response.choices[0].message.tool_calls[0].function.arguments).userId, 'synthetic-other-user');
});

test('isolated dual-stack networks require both gateway modes; internal alone cannot prove host isolation', () => {
  const args = isolatedNetworkArgs(spec.network, 'fdae:1234:5678:1::/64');
  assert.ok(args.includes('--ipv6') && args.includes('--internal'));
  for (const [key, value] of Object.entries(ISOLATED_GATEWAY_OPTIONS)) assert.ok(args.includes(`${key}=${value}`));
  assert.throws(() => isolatedNetworkArgs(spec.network, '::/0'));
  const inspected = { Driver: 'bridge', Internal: true, EnableIPv6: true, Options: { ...ISOLATED_GATEWAY_OPTIONS },
    IPAM: { Config: [{ Subnet: '172.20.0.0/16' }, { Subnet: 'fdae:1234:5678:1::/64' }] } };
  assertIsolatedNetwork(inspected);
  for (const mutate of [value => { value.Internal = false; }, value => { value.EnableIPv6 = false; },
    value => { value.Options = {}; }, value => { value.Options['com.docker.network.bridge.gateway_mode_ipv4'] = 'nat'; },
    value => { value.Options['com.docker.network.bridge.gateway_mode_ipv6'] = 'nat'; }, value => { value.IPAM.Config.pop(); }]) {
    const changed = structuredClone(inspected); mutate(changed); assert.throws(() => assertIsolatedNetwork(changed));
  }
});

test('egress evidence requires every protocol/family and working positives, never absent or generic failed controls', () => {
  const result = reachable => Object.fromEntries(['external4', 'external6', 'host4', 'host6', 'systemDns',
    'tcpDns4', 'tcpDns6', 'udpDns4', 'udpDns6'].map(key => [key, {
    [key === 'systemDns' ? 'resolved' : key.includes('Dns') ? 'answered' : 'connected']: reachable, verified: reachable,
  }]));
  assertEgressProof(result(true), true); assertEgressProof(result(false), false);
  assert.throws(() => assertEgressProof(result(false), true));
  for (const key of Object.keys(result(true))) {
    const missing = result(false); delete missing[key]; assert.throws(() => assertEgressProof(missing, false));
    const reached = result(false); reached[key] = result(true)[key]; assert.throws(() => assertEgressProof(reached, false));
    const unverified = result(true); unverified[key].verified = false; assert.throws(() => assertEgressProof(unverified, true));
  }
});

test('DNS canary answers only the synthetic name, validates packets and never forwards queries', () => {
  const name = 'canary.hermes-p1-unit.test';
  const query = (requested, type) => {
    const header = Buffer.from('641201000001000000000000', 'hex');
    const tail = Buffer.alloc(5); tail.writeUInt16BE(type, 1); tail.writeUInt16BE(1, 3);
    return Buffer.concat([header, ...requested.split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), tail]);
  };
  for (const [type, expected] of [[1, 'c612000a'], [28, '20010db8000000000000000000000010']]) {
    const response = dnsReply(query(name, type), name);
    assert.equal(response.readUInt16BE(0), 0x6412); assert.equal(response.readUInt16BE(6), 1);
    const bytes = type === 1 ? 4 : 16;
    assert.equal(response.length, query(name, type).length + 12 + bytes);
    assert.equal(response.readUInt16BE(query(name, type).length + 10), bytes);
    assert.ok(response.toString('hex').endsWith(expected));
  }
  for (const packet of [query('public.example', 1), query(name, 15)]) {
    const response = dnsReply(packet, name); assert.equal(response[3] & 15, 3); assert.equal(response.readUInt16BE(6), 0);
  }
  for (const packet of [Buffer.alloc(0), Buffer.alloc(513), query(name, 1).subarray(0, 18), Buffer.from('641201000002000000000000', 'hex')]) {
    assert.throws(() => dnsReply(packet, name));
  }
});

test('a real DNS resolver accepts the canary A and AAAA wire records', async t => {
  await mkdir(root, { recursive: true });
  const output = await mkdtemp(path.join(root, 'dns-wire-'));
  const name = 'canary.hermes-p1-wire.test';
  const service = await startEgressCanary({ name, output, tcpPort: 0, dnsPort: 0 });
  t.after(() => service.close());
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  resolver.setServers([`127.0.0.1:${service.endpoints.udpDns4}`]);
  assert.deepEqual(await resolver.resolve4(name), ['198.18.0.10']);
  assert.deepEqual(await resolver.resolve6(name), ['2001:db8::10']);
});

test('live local canary serves/counts TCP and UDP DNS independently on both address families', async t => {
  await mkdir(root, { recursive: true });
  const output = await mkdtemp(path.join(root, 'canary-'));
  const service = await startEgressCanary({ name: 'canary.hermes-p1-unit.test', output, tcpPort: 0, dnsPort: 0 });
  t.after(() => service.close());
  assert.deepEqual(service.addresses, { tcp4: '127.0.0.1', udpDns4: '127.0.0.1', tcpDns4: '127.0.0.1',
    tcp6: '::1', udpDns6: '::1', tcpDns6: '::1' });
  const query = Buffer.concat([Buffer.from('641201000001000000000000', 'hex'),
    ...['canary', 'hermes-p1-unit', 'test'].map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from('0000010001', 'hex')]);
  const exchangeTcp = (host, port, payload) => new Promise((resolve, reject) => {
    const socket = net.connect({ host, port }), chunks = [];
    socket.setTimeout(2000, () => socket.destroy(new Error('Canary test timed out')));
    socket.on('error', reject); socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.once('connect', () => { if (payload) socket.write(payload); });
  });
  for (const [suffix, host] of [['4', '127.0.0.1'], ['6', '::1']]) {
    assert.equal((await exchangeTcp(host, service.endpoints[`tcp${suffix}`])).toString(), CANARY_REPLY);
    const udp = dgram.createSocket(`udp${suffix}`);
    try {
      const answer = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('DNS canary test timed out')), 2000);
        const done = fn => value => { clearTimeout(timer); fn(value); };
        udp.once('error', done(reject)); udp.once('message', done(resolve));
        udp.send(query, service.endpoints[`udpDns${suffix}`], host);
      });
      assert.deepEqual(answer, dnsReply(query, 'canary.hermes-p1-unit.test'));
    } finally { udp.close(); }
    const size = Buffer.alloc(2); size.writeUInt16BE(query.length);
    const response = await exchangeTcp(host, service.endpoints[`tcpDns${suffix}`], Buffer.concat([size, query]));
    assert.equal(response.readUInt16BE(0), response.length - 2);
    assert.deepEqual(response.subarray(2), dnsReply(query, 'canary.hermes-p1-unit.test'));
  }
  assert.deepEqual(JSON.parse(await readFile(path.join(output, 'egress-counts.json'), 'utf8')),
    { tcp4: 1, tcp6: 1, udpDns4: 1, udpDns6: 1, tcpDns4: 1, tcpDns6: 1 });
});

test('partial canary bind failure closes the listeners created earlier', async t => {
  await mkdir(root, { recursive: true }); const output = await mkdtemp(path.join(root, 'canary-failure-'));
  const createServer = net.createServer, createSocket = dgram.createSocket;
  const servers = [], sockets = [];
  let port;
  t.mock.method(net, 'createServer', (...args) => {
    const server = createServer(...args); servers.push(server);
    // Fail TCP DNS only after real TCP and UDP listeners have bound. A port
    // allocated for TCP may be excluded for UDP on Windows, failing too early.
    if (servers.length === 2) server.listen = () => {
      queueMicrotask(() => server.emit('error', Object.assign(new Error('Synthetic TCP DNS bind conflict'), { code: 'EADDRINUSE' })));
      return server;
    };
    return server;
  });
  t.mock.method(dgram, 'createSocket', (...args) => {
    const socket = createSocket(...args); sockets.push(socket);
    socket.once('listening', () => { port = socket.address().port; });
    return socket;
  });
  t.after(() => {
    for (const socket of sockets) { try { socket.close(); } catch { /* Already closed by the product path. */ } }
    for (const server of servers) server.close();
  });
  await assert.rejects(startEgressCanary({ name: 'canary.hermes-p1-unit.test', output, tcpPort: 0, dnsPort: 0 }), { code: 'EADDRINUSE' });
  assert.equal(servers.length, 2); assert.equal(sockets.length, 1);
  assert.equal(servers[0].listening, false); assert.equal(servers[1].listening, false);
  assert.throws(() => sockets[0].address(), { code: 'ERR_SOCKET_DGRAM_NOT_RUNNING' });
  assert(Number.isInteger(port) && port > 0);
  const udp = dgram.createSocket('udp4');
  try { await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind({ address: '127.0.0.1', port }, resolve); }); }
  finally { udp.close(); }
  // A premature startup success/receipt must not be written.
  await assert.rejects(readFile(path.join(output, 'egress-counts.json')), { code: 'ENOENT' });
});

test('host canary binds only exact literals, defaults to loopback and rejects wildcard/family mistakes', async t => {
  const service = await startHostCanary(); t.after(() => service.close());
  assert.deepEqual(service.addresses, { ipv4: '127.0.0.1', ipv6: '::1' });
  const explicit = await startHostCanary({ ipv4: '127.0.0.1', ipv6: '::1' }); t.after(() => explicit.close());
  assert.deepEqual(explicit.addresses, { ipv4: '127.0.0.1', ipv6: '::1' });
  for (const addresses of [{ ipv4: '0.0.0.0', ipv6: '::1' }, { ipv4: '127.0.0.1', ipv6: '::' },
    { ipv4: '127.0.0.1', ipv6: '0:0:0:0:0:0:0:0' }, { ipv4: 'localhost', ipv6: '::1' },
    { ipv4: '::1', ipv6: '127.0.0.1' }, { ipv4: '127.0.0.1' }]) {
    await assert.rejects(startHostCanary(addresses), /Invalid fixture bind addresses/);
  }
});

test('host canary closes its prior exact-address listener after a later bind fails', async t => {
  const create = net.createServer, created = [];
  t.mock.method(net, 'createServer', (...args) => {
    const server = create(...args); created.push(server);
    if (created.length === 2) server.listen = () => {
      queueMicrotask(() => server.emit('error', Object.assign(new Error('Synthetic unavailable IPv6 address'), { code: 'EADDRNOTAVAIL' })));
      return server;
    };
    return server;
  });
  await assert.rejects(startHostCanary(), { code: 'EADDRNOTAVAIL' });
  assert.equal(created.length, 2); assert.equal(created[0].listening, false); assert.equal(created[1].listening, false);
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
  assert.equal(receipt.sourceProvenance.kind, 'unsigned_release_receipt');
  assert.equal(receipt.sourceProvenance.artifactVerified, true);
  assert.equal(receipt.sourceProvenance.signatureVerified, false);
  assert.equal(receipt.sourceProvenance.imageInspectionVerified, false);
  assert.ok(receipt.error);
});
