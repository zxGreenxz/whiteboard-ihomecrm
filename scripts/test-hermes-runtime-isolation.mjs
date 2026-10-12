#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { assertEgressProof, assertFixtureInspection, assertImageProvenance, assertInputsUnchanged, assertInside, assertIsolatedNetwork,
  assertMcpDenial, assertPinnedImageInspection, assertRuntimeInspection, assertUnavailableTool, controlBridgeAddresses, DNS_OPTIONS,
  HERMES_COMMIT, HERMES_IMAGE, HERMES_RELEASE, isolatedNetworkArgs, RESULT_PREFIX, runtimeArgs,
  runtimeUser, sourceHashes } from '../infra/hermes-runtime/runtime-contract.mjs';
import { ProfileLeaseStore } from '../infra/hermes-runtime/profile-lease.mjs';
import { startHostCanary } from '../infra/hermes-runtime/egress-canary.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['--preflight', '--run'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: node scripts/test-hermes-runtime-isolation.mjs --preflight|--run');
  process.exit(1);
}
const docker = process.env.HERMES_FIXTURE_DOCKER ?? (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe') : 'docker');
const id = `hermes-p1-${Date.now()}-${randomBytes(3).toString('hex')}`;
const cacheRoot = path.join(root, '.cache', 'hermes-p1');
const out = assertInside(cacheRoot, path.join(cacheRoot, id));
await mkdir(out, { recursive: true });
const receiptPath = path.join(out, 'receipt.json');
const inputFiles = ['infra/hermes-runtime/runtime-contract.mjs', 'infra/hermes-runtime/runtime-probe.py',
  'infra/hermes-runtime/image-provenance.json',
  'infra/hermes-runtime/egress-canary.mjs', 'infra/hermes-runtime/egress_probe.py',
  'infra/hermes-runtime/profile-lease.mjs',
  'infra/hermes-runtime/fake-model.mjs', 'infra/hermes-runtime/fixture-server.mjs', 'infra/hermes-runtime/control.mjs',
  'scripts/test-hermes-runtime-isolation.mjs', 'infra/hermes-broker/broker.mjs', 'infra/hermes-broker/stores.mjs',
  'infra/hermes-broker/mcp-http.mjs', 'infra/hermes-broker/fixture.mjs', '.github/workflows/hermes-runtime.yml'];
const receipt = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'BLOCKED', mode,
  image: HERMES_IMAGE, release: HERMES_RELEASE, sourceCommit: HERMES_COMMIT, checks: [],
  inputSha256: await sourceHashes(root, inputFiles),
  limitations: ['Synthetic users, model and broker authorization only; no live CRM/RLS, TLS/OAuth, Zalo or paid model.',
    'Admission wrapper is a spike, not the production session supervisor.',
    'Source binding uses a reviewed unsigned upstream release receipt and manifest hashes, not a signed attestation or reproducible-build proof.',
    'TCP/DNS/host probes use live synthetic IPv4/IPv6 canaries, not every possible port/protocol or a production firewall proof.'] };
const containers = [];
const drivers = [];
const privateFixtureValues = [];
const createdNetworks = [];
let hostCanary;
const command = async (args, timeout = 30_000) => {
  const { stdout } = await exec(docker, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  return stdout.trim();
};
const removeContainer = async (name) => {
  try { await command(['rm', '-f', name]); }
  catch (error) { if (!/No such container/i.test(String(error.stderr))) throw error; }
};
const save = async () => {
  let serialized = JSON.stringify(receipt, null, 2);
  for (const value of privateFixtureValues) serialized = serialized.replaceAll(value, '[fixture-private-value]');
  await writeFile(receiptPath, serialized + '\n');
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, details = {}) => { receipt.checks.push({ name, passed: true, ...details }); console.log(`PASS ${name}`); };

class RuntimeDriver {
  constructor(spec, lease) {
    this.spec = spec; this.lease = lease; this.pending = new Map(); this.sequence = 0; this.logs = '';
    this.child = spawn(docker, runtimeArgs(spec), { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.closed = new Promise((resolve) => this.child.once('close', resolve));
    this.child.on('error', (error) => this.rejectAll(error));
    this.child.on('close', (code) => this.rejectAll(new Error(`Runtime ${spec.actor} exited (${code})`)));
    let buffer = '';
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'); const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (!line.startsWith(RESULT_PREFIX)) { this.logs = (this.logs + line + '\n').slice(-100_000); continue; }
        try {
          const result = JSON.parse(line.slice(RESULT_PREFIX.length));
          const pending = this.pending.get(result.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(result.id); result.ok ? pending.resolve(result.result) : pending.reject(new Error(result.error)); }
        } catch (error) { this.rejectAll(error); }
      }
    });
    this.child.stderr.on('data', (chunk) => { this.logs = (this.logs + chunk.toString()).slice(-100_000); });
  }
  rejectAll(error) { for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); } this.pending.clear(); }
  send(op, args = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Runtime ${this.spec.actor} command ${op} timed out`)); }, 90_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, op, ...args }) + '\n', (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.child.stdin.end();
    await removeContainer(this.spec.name);
    await this.closed;
    await this.lease.release();
    await writeFile(path.join(out, `${this.spec.name}.log`), this.logs);
  }
}

try {
  receipt.stage = 'provenance';
  const provenanceArtifact = JSON.parse(await readFile(path.join(root, 'infra/hermes-runtime/image-provenance.json'), 'utf8'));
  receipt.sourceProvenance = assertImageProvenance(provenanceArtifact);
  const user = runtimeUser(); receipt.runtimeUser = user;
  receipt.stage = 'daemon';
  receipt.docker = JSON.parse(await command(['version', '--format', '{{json .}}'], 15_000));
  if (!receipt.docker.Server) throw new Error('Docker daemon unavailable');
  if (receipt.docker.Server.Os !== 'linux') throw new Error('Linux Docker engine is required');
  check('linux-daemon');
  if (mode === '--preflight') {
    receipt.status = 'PREFLIGHT_ONLY';
  } else {
    receipt.stage = 'capabilities';
    // Docker Desktop routes through a VM; these host listeners would not be the
    // engine host. Do not silently turn that mismatch into a blocked-network pass.
    if (process.platform !== 'linux') throw new Error('Egress proof requires a native Linux supervisor/engine host');
    if (Number.parseInt(receipt.docker.Server.Version, 10) < 28) throw new Error('Docker Engine 28+ isolated gateway mode is required');
    receipt.stage = 'image';
    console.log(`Pulling pinned ${HERMES_RELEASE} image (no installation scripts).`);
    await command(['pull', '--platform', 'linux/amd64', HERMES_IMAGE], 8 * 60_000);
    const [image] = JSON.parse(await command(['image', 'inspect', HERMES_IMAGE]));
    receipt.imageInspection = { id: image.Id, repoDigests: image.RepoDigests, architecture: image.Architecture, os: image.Os,
      labels: image.Config.Labels, declaredVolumes: image.Config.Volumes };
    receipt.sourceProvenance = assertPinnedImageInspection(image, provenanceArtifact);
    receipt.sourceRevisionLabelVerified = receipt.sourceProvenance.revisionLabelVerified;
    check('pinned-image');
    const networks = { a: `${id}-net-a`, b: `${id}-net-b` };
    receipt.stage = 'network';
    const prefix = randomBytes(5).toString('hex');
    const ula = `fd${prefix.slice(0, 2)}:${prefix.slice(2, 6)}:${prefix.slice(6, 10)}`;
    receipt.networks = {};
    for (const actor of ['a', 'b']) {
      await command(isolatedNetworkArgs(networks[actor], `${ula}:${actor === 'a' ? 1 : 2}::/64`));
      createdNetworks.push(networks[actor]);
      const [network] = JSON.parse(await command(['network', 'inspect', networks[actor]]));
      assertIsolatedNetwork(network);
      receipt.networks[actor] = { id: network.Id, internal: network.Internal, ipv6: network.EnableIPv6,
        options: network.Options, ipam: network.IPAM };
    }
    assert.notEqual(receipt.networks.a.id, receipt.networks.b.id);
    check('separate-internal-networks');
    const source = path.join(root, 'infra', 'hermes-runtime');
    const brokerSource = path.join(root, 'infra', 'hermes-broker');
    const fixtureOutput = assertInside(out, path.join(out, 'fixture-output'));
    await mkdir(fixtureOutput);
    // This third network intentionally has a host bridge gateway. It is never
    // attached to either actor or the CRM/model fixture. No public egress needed.
    const controlNetwork = `${id}-control`;
    receipt.stage = 'egress-control';
    await command(['network', 'create', '--internal', '--ipv6', '--subnet', `${ula}:3::/64`,
      '--label', 'ihome.fixture=hermes-p1', controlNetwork]); createdNetworks.push(controlNetwork);
    const [controlInspection] = JSON.parse(await command(['network', 'inspect', controlNetwork]));
    receipt.egressControlNetwork = { id: controlInspection.Id, driver: controlInspection.Driver,
      internal: controlInspection.Internal, options: controlInspection.Options, ipam: controlInspection.IPAM };
    const canaryOutput = assertInside(out, path.join(out, 'canary-output')); await mkdir(canaryOutput);
    const canaryName = `${id}-canary`, dnsName = `canary.${id}.test`;
    containers.push(canaryName);
    await command(['run', '-d', '--name', canaryName, '--network', controlNetwork,
      '--label', 'ihome.fixture=hermes-p1', '--user', user, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '256m', '--cpus', '0.5',
      '--sysctl', 'net.ipv4.ip_forward=0', '--sysctl', 'net.ipv6.conf.all.forwarding=0',
      '--sysctl', 'net.ipv4.ip_unprivileged_port_start=0',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16777216', '--tmpfs', '/opt/data:ro,nosuid,nodev,noexec,size=1048576',
      '--mount', `type=bind,src=${source},dst=/fixture,readonly`, '--mount', `type=bind,src=${canaryOutput},dst=/output`,
      '--entrypoint', '/usr/local/bin/node', HERMES_IMAGE, '/fixture/egress-canary.mjs', dnsName, '/output']);
    const [canaryInspection] = JSON.parse(await command(['inspect', canaryName]));
    assert.deepEqual(Object.keys(canaryInspection.NetworkSettings.Networks), [controlNetwork]);
    assert.ok(!Object.keys(canaryInspection.HostConfig.PortBindings ?? {}).length);
    const external = canaryInspection.NetworkSettings.Networks[controlNetwork];
    assert.ok(external.IPAddress && external.GlobalIPv6Address);
    const canaryCounts = async () => JSON.parse(await readFile(path.join(canaryOutput, 'egress-counts.json'), 'utf8'));
    let canaryReady = false;
    for (let attempt = 0; attempt < 20 && !canaryReady; attempt++) {
      try { await canaryCounts(); canaryReady = true; } catch { await delay(250); }
    }
    assert.equal(canaryReady, true, 'IPv4/IPv6 TCP and DNS canary must be live');
    // Linux libuv filters out interfaces without IFF_UP + IFF_RUNNING. An
    // empty Docker bridge may have no carrier until its first endpoint joins.
    // Start and verify the control canary before observing the host bridge;
    // never guess gateway addresses or treat a missing interface as isolation.
    // https://github.com/libuv/libuv/blob/v1.51.0/src/unix/linux.c#L1832-L1834
    const bridge = controlBridgeAddresses(controlInspection, networkInterfaces());
    receipt.egressControlBridge = bridge;
    const gateway4 = bridge.ipv4, gateway6 = bridge.ipv6;
    hostCanary = await startHostCanary({ ipv4: gateway4, ipv6: gateway6 });
    const egressSpec = { external4: { host: external.IPAddress, port: 19090 }, external6: { host: external.GlobalIPv6Address, port: 19090 },
      host4: { host: gateway4, port: hostCanary.ports.ipv4 }, host6: { host: gateway6, port: hostCanary.ports.ipv6 }, name: dnsName };
    const resolv = path.join(out, 'control-resolv.conf');
    await writeFile(resolv, `nameserver ${external.IPAddress}\nnameserver ${external.GlobalIPv6Address}\noptions timeout:1 attempts:1\n`);
    const positiveEgress = async suffix => {
      const countsBefore = await canaryCounts(), hostCountsBefore = hostCanary.counts();
      const name = `${id}-positive-${suffix}`; containers.push(name);
      const result = JSON.parse(await command(['run', '--rm', '--name', name, '--network', controlNetwork,
        '--label', 'ihome.fixture=hermes-p1', '--user', user, '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '--pids-limit', '64', '--memory', '256m', '--cpus', '0.5',
        '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=16777216', '--tmpfs', '/opt/data:ro,nosuid,nodev,noexec,size=1048576',
        '--mount', `type=bind,src=${source},dst=/fixture,readonly`, '--mount', `type=bind,src=${resolv},dst=/etc/resolv.conf,readonly`,
        '--env', 'PYTHONDONTWRITEBYTECODE=1', '--entrypoint', '/opt/hermes/.venv/bin/python', HERMES_IMAGE,
        '/fixture/egress_probe.py', JSON.stringify(egressSpec)]));
      assertEgressProof(result, true);
      const countsAfter = await canaryCounts(), hostCountsAfter = hostCanary.counts();
      for (const key of Object.keys(countsBefore)) assert.ok(countsAfter[key] > countsBefore[key], `Missing actual positive canary hit: ${key}`);
      for (const key of ['ipv4', 'ipv6']) assert.ok(hostCountsAfter[key] > hostCountsBefore[key], `Control reached a different host: ${key}`);
      check(`egress-positive-controls-${suffix}`, result);
    };
    await positiveEgress('before');
    const fixtureName = `${id}-fixture`;
    containers.push(fixtureName);
    receipt.stage = 'fixture';
    await command(['run', '-d', '--name', fixtureName, '--network', networks.a, '--network-alias', 'fixture',
      '--label', 'ihome.fixture=hermes-p1', '--user', user, '--read-only', '--cap-drop', 'ALL',
      '--dns', '127.0.0.1', ...DNS_OPTIONS.flatMap(option => ['--dns-option', option]),
      '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m', '--cpus', '1',
      '--sysctl', 'net.ipv4.ip_forward=0', '--sysctl', 'net.ipv6.conf.all.forwarding=0',
      '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=67108864',
      // Upstream declares VOLUME /opt/data. Override it explicitly so Docker
      // cannot allocate an uninspected anonymous volume for the fixture.
      '--tmpfs', '/opt/data:ro,nosuid,nodev,noexec,size=1048576',
      '--mount', `type=bind,src=${source},dst=/fixture,readonly`,
      '--mount', `type=bind,src=${brokerSource},dst=/broker,readonly`,
      '--mount', `type=bind,src=${fixtureOutput},dst=/output`,
      '--env', 'HOME=/tmp', '--env', 'HERMES_HOME=/tmp/hermes-fixture',
      '--env', 'HERMES_FIXTURE_BROKER_DIR=/broker', '--entrypoint', '/usr/local/bin/node',
      HERMES_IMAGE, '/fixture/fixture-server.mjs', '--output', '/output']);
    await command(['network', 'connect', '--alias', 'fixture', networks.b, fixtureName]);
    const [fixtureInspection] = JSON.parse(await command(['inspect', fixtureName]));
    receipt.fixtureInspection = { image: fixtureInspection.Image, hostConfig: fixtureInspection.HostConfig, mounts: fixtureInspection.Mounts };
    assertFixtureInspection(fixtureInspection, { networks: Object.values(networks), user, source, brokerSource, output: fixtureOutput });
    check('fixture-hardening-and-exact-mounts');
    const control = async (op, actor) => JSON.parse(await command(['exec', fixtureName, '/usr/local/bin/node', '/fixture/control.mjs', op, ...(actor ? [actor] : [])]));
    let ready = false;
    for (let attempt = 0; attempt < 20 && !ready; attempt++) {
      try { await control('health'); ready = true; } catch { await delay(500); }
    }
    assert.equal(ready, true, 'Fixture service did not become ready');
    const bootstrap = Object.fromEntries(await Promise.all(['a', 'b'].map(async (actor) => [actor,
      JSON.parse(await readFile(path.join(fixtureOutput, `${actor}.json`), 'utf8'))])));
    for (const value of Object.values(bootstrap)) privateFixtureValues.push(value.token, value.sentinel);
    const profiles = new ProfileLeaseStore({ directory: path.join(out, 'profile-leases'), homeRoot: out });
    const launch = async (actor, suffix) => {
      const name = `${id}-${actor}${suffix ?? ''}`;
      const home = assertInside(out, path.join(out, `home-${actor}`)); await mkdir(home, { recursive: true, mode: 0o700 });
      const lease = await profiles.acquire({ home, assistantId: bootstrap[actor].assistantId,
        userId: bootstrap[actor].userId, organizationId: bootstrap[actor].organizationId });
      const spec = { name, actor, network: networks[actor], source, home: lease.binding.home, user,
        bootstrap: path.join(fixtureOutput, `${actor}.json`) };
      try {
        const driver = new RuntimeDriver(spec, lease); containers.push(name); drivers.push(driver); return driver;
      } catch (error) { await lease.release(); throw error; }
    };
    const inspectDriver = async (driver) => {
      const [container] = JSON.parse(await command(['inspect', driver.spec.name]));
      assertRuntimeInspection(container, driver.spec);
      return { name: container.Name, image: container.Image, hostConfig: container.HostConfig, mounts: container.Mounts,
        network: driver.spec.network, ip: container.NetworkSettings.Networks[driver.spec.network].IPAddress,
        ipv6: container.NetworkSettings.Networks[driver.spec.network].GlobalIPv6Address };
    };
    receipt.stage = 'hermes';
    let a = await launch('a'); const b = await launch('b');
    await assert.rejects(launch('a', '-duplicate'), /profile_in_use/);
    check('duplicate-profile-holder-denied-before-container-launch');
    for (const [actor, driver] of [['a', a], ['b', b]]) {
      const result = await driver.send('turn', { text: 'FIXTURE_CONTEXT' });
      assert.equal(result.denied, false); assert.ok(result.final.includes(bootstrap[actor].userId));
      assert.ok(result.final.includes(bootstrap[actor].organizationId));
      await driver.send('seed_token');
      check(`hermes-mcp-model-turn-${actor}`, { toolNames: result.toolNames, apiCalls: result.apiCalls });
    }
    receipt.runtimeInspection = [await inspectDriver(a), await inspectDriver(b)];
    check('runtime-hardening-and-exact-mounts');
    for (const driver of [a, b]) assert.equal((await driver.send('start_peer_listener')).selfReachable, true);
    for (const [driver, peer, peerInspection] of [[a, b, receipt.runtimeInspection[1]], [b, a, receipt.runtimeInspection[0]]]) {
      const direct = await driver.send('probe_peer', { host: peerInspection.ip });
      assert.ok(peerInspection.ipv6);
      const ipv6 = await driver.send('probe_peer', { host: peerInspection.ipv6 });
      const dns = await driver.send('probe_peer', { host: peer.spec.name });
      assert.equal(direct.blocked, true); assert.equal(dns.blocked, true); assert.equal(ipv6.blocked, true);
      check(`peer-listener-blocked-${driver.spec.actor}`, { directIpBlocked: direct.blocked, ipv6Blocked: ipv6.blocked, dnsBlocked: dns.blocked });
    }
    const canaryBefore = await canaryCounts(), hostBefore = hostCanary.counts(), egressResults = {};
    for (const driver of [a, b]) {
      const result = await driver.send('egress_matrix', { spec: egressSpec });
      egressResults[driver.spec.actor] = result;
      assertEgressProof(result, false); check(`host-ipv6-dns-egress-blocked-${driver.spec.actor}`, result);
    }
    assert.deepEqual(await canaryCounts(), canaryBefore, 'Blocked probes reached the external canary');
    assert.deepEqual(hostCanary.counts(), hostBefore, 'Blocked probes reached the host');
    await positiveEgress('after');
    for (const [actor, driver] of [['a', a], ['b', b]]) {
      const snapshot = await driver.send('snapshot');
      assert.ok(snapshot.memory.join('\n').includes(bootstrap[actor].sentinel));
      assert.ok(!snapshot.memory.join('\n').includes(bootstrap[actor === 'a' ? 'b' : 'a'].sentinel));
      assert.equal(snapshot.ownSession, true); assert.equal(snapshot.otherSession, false);
      assert.equal(snapshot.token, `synthetic-${actor}`);
      const egress = { ...(await driver.send('egress')), externalIpBlocked: !egressResults[actor].external4.connected };
      for (const value of Object.values(egress)) assert.equal(value, true);
      check(`memory-session-token-and-egress-${actor}`, egress);
    }
    for (const [suffix, tool] of [['', 'terminal'], ['_BROWSER', 'browser_navigate'], ['_HTTP', 'web_extract']]) {
      const forbidden = await a.send('turn', { text: `FIXTURE_FORBIDDEN_TOOL${suffix}` });
      assertUnavailableTool(forbidden.final, tool);
    }
    assert.equal((await a.send('snapshot')).forbiddenExecution, false);
    const unknown = await a.send('direct_rpc', { method: 'tools/call', params: { name: 'fixture_write', arguments: {} } });
    assertMcpDenial(unknown, 'tool_not_available');
    const spoof = await a.send('direct_rpc', { method: 'tools/call', params: { name: 'crm_auth_context', arguments: { userId: bootstrap.b.userId, organizationId: bootstrap.b.organizationId } } });
    assertMcpDenial(spoof, 'invalid_request');
    check('unavailable-tool-and-spoofed-identity-denied');
    const bindingA = a.lease.binding;
    await a.stop();
    await assert.rejects(profiles.acquire({ ...bindingA, userId: bootstrap.b.userId }), /profile_owner_mismatch/);
    check('profile-owner-reassignment-denied');
    a = await launch('a', '-restart');
    const resumed = await a.send('snapshot');
    receipt.runtimeInspection.push(await inspectDriver(a));
    assert.equal(resumed.ownSession, true); assert.equal(resumed.otherSession, false); assert.equal(resumed.token, 'synthetic-a');
    assert.ok(resumed.memory.join('\n').includes(bootstrap.a.sentinel));
    await a.send('turn', { text: 'FIXTURE_CONTEXT' });
    check('restart-preserves-only-own-state');
    const beforeRevoke = await control('stats');
    await control('revoke', 'a');
    await profiles.revoke(bootstrap.a.assistantId);
    assertMcpDenial(await a.send('direct_rpc', { method: 'tools/call', params: { name: 'crm_auth_context', arguments: {} } }), 'unauthorized');
    const revoked = await a.send('turn', { text: 'FIXTURE_CONTEXT' });
    assert.equal(revoked.denied, true); assert.equal(revoked.contextDiscarded, true);
    assert.equal((await a.send('snapshot')).contextAlive, false);
    const afterRevoke = await control('stats');
    assert.equal(afterRevoke.modelCalls.length, beforeRevoke.modelCalls.length);
    assert.equal((await b.send('turn', { text: 'FIXTURE_CONTEXT' })).denied, false);
    check('revocation-discards-context-before-model-other-user-unaffected');
    await a.stop();
    await assert.rejects(launch('a', '-revoked'), /profile_revoked/);
    check('revoked-profile-cannot-restart');
    receipt.fixtureStats = await control('stats');
    assert.equal(receipt.fixtureStats.forbiddenNetworkRequests, 0);
    for (const actor of ['a', 'b']) assert.ok(receipt.fixtureStats.modelCalls.some((v) => v.actor === actor && v.ownMemorySeen));
    assert.equal(receipt.fixtureStats.failures.length, 0);
    receipt.status = 'PASSED_SYNTHETIC_RUNTIME_UNSIGNED_RELEASE_RECEIPT';
    receipt.stage = 'completed';
  }
} catch (error) {
  receipt.status = ['daemon', 'capabilities'].includes(receipt.stage) ? 'BLOCKED' : 'FAILED';
  receipt.error = String(error.message).slice(0, 4000);
  if (error.stderr && receipt.stage === 'daemon') receipt.daemonError = String(error.stderr).slice(0, 4000);
  process.exitCode = receipt.status === 'BLOCKED' ? 2 : 1;
  console.error(`${receipt.status} at ${receipt.stage}: ${receipt.error}`);
} finally {
  for (const driver of drivers) await driver.stop().catch((error) => { receipt.cleanupError = error.message; });
  for (const name of [...containers].reverse()) {
    // Names originate only from this unique fixture run; never remove existing resources by enumeration.
    await removeContainer(name).catch((error) => { receipt.cleanupError = error.message; });
  }
  await hostCanary?.close().catch(error => { receipt.cleanupError = error.message; });
  for (const network of [...createdNetworks].reverse()) {
    await command(['network', 'rm', network]).catch((error) => { receipt.cleanupError = error.message; });
  }
  if (receipt.cleanupError) { receipt.status = 'FAILED'; process.exitCode = 1; }
  try {
    receipt.inputSha256After = await sourceHashes(root, inputFiles);
    assertInputsUnchanged(receipt.inputSha256, receipt.inputSha256After);
    receipt.inputsUnchanged = true;
  } catch {
    receipt.inputsUnchanged = false; receipt.status = 'FAILED'; process.exitCode = 1;
    receipt.inputError = 'Fixture source changed or became unreadable during the run';
  }
  receipt.finishedAt = new Date().toISOString();
  await save();
  console.log(`Receipt: ${path.relative(root, receiptPath)}`);
}
