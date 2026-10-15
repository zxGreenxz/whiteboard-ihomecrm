import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, lstat, chmod, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGatewayTransport } from './gateway-transport.mjs';
import { GATEWAY_URLS } from './container-contract.mjs';
import { HERMES_IMAGE, HERMES_COMMIT, NO_FORWARDING, PRIVATE_DNS, DNS_OPTIONS, ISOLATED_GATEWAY_OPTIONS, runtimeUser } from './runtime-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const wait = async predicate => { const deadline = Date.now() + 3000; while (!predicate()) {
  if (Date.now() >= deadline) throw Error('condition not reached'); await new Promise(resolve => setTimeout(resolve, 5)); } };
const linuxNonroot = process.platform === 'linux' && process.getuid() !== 0 && process.getgid() !== 0;
const user = process.platform === 'linux' ? runtimeUser() : '10000:10000';
const childCode = `process.stdin.resume();
const ready=()=>process.stdout.write('gateway_ready_v1\\n');
if(process.argv[1]==='deferred-ready')process.stdin.once('data',ready);
else if(process.argv[1]==='flood')process.stdout.write('x'.repeat(65537));
else if(process.argv[1]==='fragment-ready'){process.stdout.write('gateway_');setTimeout(()=>process.stdout.write('ready_v1\\n'),10);}
else if(process.argv[1]==='duplicate-ready')process.stdout.write('gateway_ready_v1\\ngateway_ready_v1\\n');
else if(process.argv[1]==='invalid-ready')process.stdout.write('PRIVATE-INVALID-READY\\n');
else if(process.argv[1]==='exit-before-ready')process.exit(3);
else if(process.argv[1]!=='no-ready')ready();
setInterval(()=>{},1000);`;
const hostRequest = (socketPath, body = 'hello') => new Promise((resolve, reject) => {
  const req = request({ socketPath, path: '/mcp', method: 'POST', headers: { host: 'hermes-gateway:8787', 'content-length': Buffer.byteLength(body) } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); res.on('error', reject);
  }); req.on('error', reject); req.end(body);
});

async function fixture(t, changes = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hgt-'));
  const gatewayRoot = path.join(directory, 'g'), relayPath = path.join(directory, 'relay.mjs');
  const relay = Buffer.from('// trusted relay fixture; no credential\n'); await writeFile(relayPath, relay);
  const provenance = JSON.parse(await readFile(new URL('./image-provenance.json', import.meta.url), 'utf8'));
  const image = { Id: provenance.expectedConfigDigest, RepoDigests: [HERMES_IMAGE], Os: 'linux', Architecture: 'amd64',
    Config: { Labels: { 'org.opencontainers.image.revision': HERMES_COMMIT }, Env: ['PATH=/upstream/bin', 'HERMES_HOME=/opt/data'], Volumes: { '/opt/data': {} } } };
  const events = [], children = []; let child, spec, network, running = false, created = false, attached = false, containerRemoved = false;
  const networkId = 'a'.repeat(64), containerId = 'b'.repeat(64);
  const inspection = () => ({ Id: containerId, Name: '/' + spec.containerName, Image: image.Id,
    Config: { Image: HERMES_IMAGE, Labels: { 'ihome.hermes.instance': spec.instanceId, 'ihome.hermes.role': 'gateway' },
      User: user, OpenStdin: true, Tty: false, Entrypoint: ['/usr/local/bin/node'], Cmd: ['/run/gateway-relay.mjs', '/run/hermes-gateway/gateway.sock'], WorkingDir: '/tmp',
      Env: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HERMES_HOME=/opt/data', 'HOME=/tmp'] },
    Path: '/usr/local/bin/node', Args: ['/run/gateway-relay.mjs', '/run/hermes-gateway/gateway.sock'],
    HostConfig: { ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges'],
      LogConfig: { Type: 'none' }, NetworkMode: network.Name, PortBindings: {}, PublishAllPorts: false, Sysctls: NO_FORWARDING,
      Dns: PRIVATE_DNS, DnsOptions: DNS_OPTIONS, Tmpfs: spec.tmpfs,
      PidsLimit: 64, Memory: 256 * 1024 * 1024, NanoCpus: 250000000, RestartPolicy: { Name: 'no' }, AutoRemove: false,
      IpcMode: 'private', PidMode: '', Devices: [], DeviceRequests: [], ExtraHosts: [] },
    NetworkSettings: { Networks: { [network.Name]: { NetworkID: networkId, Aliases: ['hermes-gateway', spec.containerName, containerId.slice(0, 12)] } } },
    Mounts: [
      ...[['/run/hermes-gateway', spec.socketDirectory], ['/run/gateway-relay.mjs', spec.relayCopy]]
        .map(([Destination, Source]) => ({ Type: 'bind', Destination, Source, RW: false, Propagation: 'rprivate' })),
      ...Object.entries(spec.tmpfs).map(([Destination, options]) => ({ Type: 'tmpfs', Destination, RW: options.startsWith('rw,') })),
      // Docker creates an anonymous writable volume for declared image volumes
      // unless the create request explicitly overlays that destination.
      ...Object.keys(image.Config.Volumes).filter(destination => !Object.hasOwn(spec.tmpfs, destination))
        .map(Destination => ({ Type: 'volume', Destination, Source: '/var/lib/docker/volumes/anonymous/_data', RW: true })),
    ],
    State: { Running: running, Dead: false, Restarting: false, Status: running ? 'running' : attached ? 'exited' : 'created' },
  });
  const engine = {
    async preflight() { events.push('preflight'); await changes.preflightWait?.promise; return changes.host ?? { os: 'linux', version: '28.3.0', nativeHost: true }; },
    async inspectImage(pin) { events.push('image'); assert.equal(pin, HERMES_IMAGE); return changes.image ?? image; },
    async createNetwork(args, { signal }) {
      events.push('create-network'); assert(signal instanceof AbortSignal); assert.deepEqual(args.slice(0, 7), ['network', 'create', '--driver', 'bridge', '--internal', '--ipv6', '--subnet']);
      changes.networkEntered?.resolve();
      const labels = args.filter((_v, i) => args[i - 1] === '--label');
      network = { Id: networkId, Name: args.at(-1), Driver: 'bridge', Internal: true, EnableIPv6: true,
        Labels: Object.fromEntries(labels.map(value => value.split('='))), Options: ISOLATED_GATEWAY_OPTIONS,
        IPAM: { Config: [{ Subnet: '172.30.0.0/24' }, { Subnet: args[7] }] }, Containers: {} };
      assert.match(args[7], /^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}:1::\/64$/);
      await changes.networkWait?.promise; if (changes.networkFailure) throw Error('PRIVATE-NETWORK'); return changes.networkId ?? networkId;
    },
    async inspectNetwork(id) { events.push('inspect-network'); assert.equal(id, networkId);
      const result = structuredClone(network);
      if (created && !containerRemoved) result.Containers[containerId] = { Name: spec?.containerName };
      if (changes.foreignEndpoint) result.Containers['f'.repeat(64)] = { Name: 'foreign' };
      changes.mutateNetwork?.(result); return result;
    },
    async removeNetwork(id) { events.push('remove-network'); assert.equal(id, networkId); if (changes.removeNetworkFailure) throw Error('PRIVATE-REMOVE-NETWORK'); },
    async create(args, { signal }) {
      events.push('create'); assert(signal instanceof AbortSignal); const value = key => args[args.indexOf(key) + 1];
      const mounts = args.filter((_v, i) => args[i - 1] === '--mount'), labels = args.filter((_v, i) => args[i - 1] === '--label');
      assert.equal(mounts.length, 2); assert(mounts.every(mount => mount.endsWith(',readonly')));
      const source = destination => mounts.find(mount => mount.includes(`dst=${destination},`)).match(/src=(.*?),dst=/)[1];
      spec = { containerName: value('--name'), instanceId: labels.find(label => label.startsWith('ihome.hermes.instance=')).split('=')[1],
        socketDirectory: source('/run/hermes-gateway'), relayCopy: source('/run/gateway-relay.mjs'), args,
        tmpfs: Object.fromEntries(args.filter((_v, i) => args[i - 1] === '--tmpfs').map(item => { const at = item.indexOf(':'); return [item.slice(0, at), item.slice(at + 1)]; })) };
      assert.equal(value('--entrypoint'), '/usr/local/bin/node'); assert.equal(value('--network-alias'), 'hermes-gateway'); assert.equal(value('--user'), user);
      assert.deepEqual(args.slice(-3), [HERMES_IMAGE, '/run/gateway-relay.mjs', '/run/hermes-gateway/gateway.sock']);
      assert.deepEqual(args.filter((_v, i) => args[i - 1] === '--env'), ['HOME=/tmp', 'PATH=/usr/local/bin:/usr/bin:/bin']);
      assert(!args.some(arg => /token|secret|runtime-home/i.test(arg))); created = true;
      await changes.createWait?.promise; if (changes.createFailure) throw Error('PRIVATE-CREATE'); return changes.containerId ?? containerId;
    },
    attachStart(id) { events.push('attach'); assert.equal(id, containerId); attached = true;
      if (changes.attachFailure) throw Error('PRIVATE-ATTACH'); running = changes.mode !== 'deferred-ready';
      child = spawn(process.execPath, ['-e', childCode, changes.mode ?? 'normal'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
      if (changes.mode === 'flood') {
        let received = 0;
        child.stdout.on('data', chunk => { received += chunk.length; if (received > 65536) events.push('relay-output-over-limit'); });
      }
      child.stdout.on('data', chunk => { if (chunk.toString().includes('gateway_ready_v1')) { running = true; events.push('relay-ready'); } });
      child.once('close', () => { running = false; events.push('child-close'); }); return child;
    },
    async inspectContainer(id) { events.push('inspect'); assert.equal(id, containerId); await changes.inspectWait?.promise;
      if (changes.mode === 'deferred-ready' && !running) events.push('inspected-before-ready');
      const result = structuredClone(inspection()); changes.mutateInspection?.(result); return result; },
    async kill(id) { events.push('kill'); assert.equal(id, containerId); if (changes.killFailure) throw Error('PRIVATE-KILL');
      if (changes.lingeringTransport) { running = false; return; } child?.kill(); },
    async wait(id) { events.push('wait'); assert.equal(id, containerId); if (changes.lingeringTransport) return 137;
      if (child && child.exitCode === null && child.signalCode === null) await once(child, 'close'); return child?.exitCode ?? 137; },
    async remove(id) { events.push('remove'); assert.equal(id, containerId); if (changes.removeFailure) throw Error('PRIVATE-REMOVE'); containerRemoved = true; },
  };
  const controller = new AbortController(), channels = [];
  const config = { engine, gatewayRoot, relayPath, relaySha256: hash(relay), user, platform: 'linux', startupTimeoutMs: changes.startupTimeoutMs ?? 2000,
    ...(changes.timers ? { timers: changes.timers } : {}) };
  const transport = createGatewayTransport(config);
  const handler = changes.handler ?? ((req, res) => { const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => res.end('received:' + Buffer.concat(chunks).toString())); });
  const socketPath = () => process.platform === 'win32' ? `\\\\.\\pipe\\hermes-${spec.instanceId}` : path.join(spec.socketDirectory, 'gateway.sock');
  t.after(async () => {
    changes.preflightWait?.resolve(); changes.networkWait?.resolve(); changes.createWait?.resolve(); changes.inspectWait?.resolve();
    for (const proc of children) if (proc.exitCode === null && proc.signalCode === null) { proc.kill(); await once(proc, 'close'); }
    for (const channel of channels) await channel.close().catch(() => {});
    controller.abort(); await rm(directory, { recursive: true, force: true });
  });
  return { transport, engine, config, controller, events, directory, gatewayRoot, relayPath, relay, image, spec: () => spec, child: () => child,
    socketPath, handler, created: () => created, async open(input = { handler, signal: controller.signal }) { const channel = await transport.open(input); channels.push(channel); return channel; } };
}

test('gateway waits for relay readiness before inspecting an asynchronously started sidecar', async t => {
  const f = await fixture(t, { mode: 'deferred-ready' }); let settled = false;
  const opening = f.open().finally(() => { settled = true; }); void opening.catch(() => {});
  await wait(() => f.events.includes('attach'));
  await new Promise(resolve => setTimeout(resolve, 30));
  // Docker start --attach returns a child immediately, before the daemon or
  // relay is ready. Inspection must wait for the bounded relay handshake.
  const earlyInspection = f.events.includes('inspected-before-ready');
  f.child().stdin.write('ready\n');
  assert.equal(earlyInspection, false);
  assert.equal(settled, false);
  const channel = await opening;
  assert(f.events.indexOf('relay-ready') < f.events.indexOf('inspect'));
  assert.equal(f.events.filter(event => event === 'attach').length, 1);
  assert.equal(f.events.filter(event => event === 'create').length, 1);
  await channel.close();
});

test('fragmented fixed readiness is accepted but duplicate, malformed or exited relay cannot open a gateway', async t => {
  const f = await fixture(t, { mode: 'fragment-ready' }), channel = await f.open();
  await channel.close();
  for (const mode of ['duplicate-ready', 'invalid-ready', 'exit-before-ready']) {
    const rejected = await fixture(t, { mode });
    await assert.rejects(rejected.open(), error => error.code === 'gateway_open_failed' && !error.message.includes('PRIVATE'));
    assert.equal(rejected.events.filter(event => event === 'attach').length, 1);
    assert(rejected.events.includes('remove-network'));
  }
});

test('missing relay readiness stays fenced until deadline or caller cancellation, with no restart', async t => {
  for (const cancellation of ['deadline', 'caller']) {
    let expire;
    const timers = { setTimeout(fn, ms) { assert.equal(ms, 2000); expire = fn; return fn; }, clearTimeout() {} };
    const f = await fixture(t, { mode: 'no-ready', timers }), opening = f.open(); void opening.catch(() => {});
    await wait(() => f.events.includes('attach'));
    assert(!f.events.includes('inspect'));
    if (cancellation === 'deadline') expire(); else f.controller.abort();
    await assert.rejects(opening, /gateway_open_failed/);
    assert.equal(f.events.filter(event => event === 'attach').length, 1);
    assert.equal(f.events.filter(event => event === 'create').length, 1);
    assert(f.events.includes('child-close')); assert(f.events.includes('remove-network'));
  }
});

test('factory is inert; fixed pinned sidecar exposes only its private host handler; close proves child exit before deleting owned resources', async t => {
  const f = await fixture(t); assert.deepEqual(f.events, []); await assert.rejects(lstat(f.gatewayRoot), /ENOENT/);
  const channel = await f.open(); assert(Object.isFrozen(channel)); assert(Object.isFrozen(channel.descriptor));
  assert.deepEqual(channel.descriptor, { networkName: `ihome-hermes-gateway-${f.spec().instanceId}`, networkId: 'a'.repeat(64), ...GATEWAY_URLS });
  assert.deepEqual(await hostRequest(f.socketPath()), { status: 200, text: 'received:hello' });
  assert.deepEqual(await readFile(f.spec().relayCopy), f.relay);
  assert.deepEqual((await readdir(path.dirname(f.spec().relayCopy))).sort(), ['gateway-relay.mjs', 'resources.json', 's']);
  const manifest = JSON.parse(await readFile(path.join(path.dirname(f.spec().relayCopy), 'resources.json'), 'utf8'));
  assert.equal(manifest.networkId, channel.descriptor.networkId); assert.equal(manifest.containerId, 'b'.repeat(64)); assert.equal(manifest.phase, 'opened');
  const closing = channel.close(); assert.equal(channel.close(), closing); await closing;
  assert(f.events.indexOf('child-close') < f.events.indexOf('remove')); assert(f.events.indexOf('remove') < f.events.indexOf('remove-network'));
  assert.equal(f.events.filter(value => value === 'remove').length, 1); assert.equal(f.events.filter(value => value === 'remove-network').length, 1);
  await assert.rejects(lstat(path.dirname(f.spec().relayCopy)), /ENOENT/); await assert.rejects(hostRequest(f.socketPath()));
});

test('open rejects foreign keys and accessors without invoking a handler or creating resources', async t => {
  const f = await fixture(t); let getterCalls = 0;
  for (const value of [{ handler: f.handler, signal: f.controller.signal, token: 'private' }, { handler: f.handler },
    { get handler() { getterCalls++; return f.handler; }, signal: f.controller.signal }, { handler: f.handler, signal: new AbortController().signal, owner: {} }]) {
    await assert.rejects(f.transport.open(value), /invalid_object/);
  }
  assert.equal(getterCalls, 0); assert.deepEqual(f.events, []);
});

test('pinned image VOLUME /opt/data is overlaid by a bounded readonly tmpfs rather than an anonymous volume', async t => {
  const f = await fixture(t), channel = await f.open();
  assert.deepEqual(f.image.Config.Volumes, { '/opt/data': {} });
  assert.equal(f.spec().tmpfs['/opt/data'], 'ro,nosuid,nodev,noexec,size=1048576');
  assert(f.spec().args.includes('/opt/data:ro,nosuid,nodev,noexec,size=1048576'));
  const inspected = await f.engine.inspectContainer('b'.repeat(64));
  assert(!inspected.Mounts.some(mount => mount.Type === 'volume'));
  assert.deepEqual(inspected.Mounts.find(mount => mount.Destination === '/opt/data'), { Type: 'tmpfs', Destination: '/opt/data', RW: false });
  await channel.close();
});

test('anonymous volumes, extra tmpfs paths and altered readonly overlay are refused without cleanup guessing', async t => {
  for (const mutateInspection of [
    c => c.Mounts.push({ Type: 'volume', Destination: '/opt/data', Source: '/var/lib/docker/volumes/foreign/_data', RW: true }),
    c => c.Mounts.push({ Type: 'tmpfs', Destination: '/foreign', RW: false }),
    c => c.Mounts.push({ Type: 'tmpfs', Destination: '/opt/data', RW: false }),
    c => { c.Mounts.find(mount => mount.Destination === '/opt/data').RW = true; },
    c => { c.HostConfig.Tmpfs['/opt/data'] = 'rw,nosuid,nodev,noexec,size=1048576'; },
    c => { c.HostConfig.Tmpfs['/opt/data'] = 'ro,nosuid,nodev,noexec,size=1073741824'; },
  ]) {
    const f = await fixture(t, { mutateInspection }); await assert.rejects(f.open(), /gateway_cleanup_unproven/);
    assert(!f.events.includes('kill')); assert(!f.events.includes('remove')); assert(!f.events.includes('remove-network'));
  }
});

test('mutable request handler is snapshotted before the first await', async t => {
  const preflightWait = deferred(), f = await fixture(t, { preflightWait });
  const input = { handler: f.handler, signal: f.controller.signal }, opening = f.open(input);
  input.handler = (_req, res) => res.end('wrong-owner'); preflightWait.resolve(); const channel = await opening;
  assert.equal((await hostRequest(f.socketPath())).text, 'received:hello'); await channel.close();
});

test('independent channels keep handlers, names and copied files separate', async t => {
  const a = await fixture(t, { handler: (_req, res) => res.end('A') }), b = await fixture(t, { handler: (_req, res) => res.end('B') });
  const ca = await a.open(), cb = await b.open(); assert.notEqual(ca.descriptor.networkName, cb.descriptor.networkName); assert.notEqual(a.spec().relayCopy, b.spec().relayCopy);
  assert.equal((await hostRequest(a.socketPath())).text, 'A'); assert.equal((await hostRequest(b.socketPath())).text, 'B');
  await ca.close(); assert.equal((await hostRequest(b.socketPath())).text, 'B'); await cb.close();
});

test('unsupported host, platform, image and modified relay fail before network mutation', async t => {
  for (const changes of [{ host: { os: 'linux', version: '27.5.0', nativeHost: true } }, { host: { os: 'linux', version: '28.3.0', nativeHost: false } },
    { host: { os: 'windows', version: '28.3.0', nativeHost: true } }, { image: { Id: 'sha256:' + 'f'.repeat(64) } }]) {
    const f = await fixture(t, changes); await assert.rejects(f.open(), /gateway_open_failed/); assert(!f.events.includes('create-network'));
  }
  const f = await fixture(t); await writeFile(f.relayPath, 'changed'); await assert.rejects(f.open(), /gateway_open_failed/); assert(!f.events.includes('create-network'));
  await assert.rejects(createGatewayTransport({ ...f.config, platform: 'win32' }).open({ handler: f.handler, signal: f.controller.signal }), /native_linux_engine_required/);
});

test('unsafe config is rejected before filesystem or engine access', async t => {
  const f = await fixture(t);
  for (const delta of [{ user: '0:0' }, { relaySha256: 'A'.repeat(64) }, { gatewayRoot: 'relative' }, { relayPath: f.relayPath + ',extra' },
    { startupTimeoutMs: 0 }, { startupTimeoutMs: 120001 }, { engine: { ...f.engine, removeNetwork: undefined } },
    { timers: {} }, { timers: { setTimeout, clearTimeout: null } }]) {
    assert.throws(() => createGatewayTransport({ ...f.config, ...delta }));
  }
  assert.deepEqual(f.events, []);
});

test('network identity and isolation changes cannot create a relay or delete an unverified network', async t => {
  for (const mutateNetwork of [n => { n.Internal = false; }, n => { n.Options = {}; }, n => { n.Id = 'f'.repeat(64); },
    n => { n.Labels['ihome.hermes.instance'] = 'foreign'; }]) {
    const f = await fixture(t, { mutateNetwork }); await assert.rejects(f.open(), /gateway_cleanup_unproven/);
    assert(!f.events.includes('create')); assert(!f.events.includes('remove-network'));
  }
});

test('wrong sidecar identity, hardening, mounts, credentials or bridge configuration remain retained without kill or deletion', async t => {
  const mutations = [c => { c.Id = 'f'.repeat(64); }, c => { c.Config.User = '0:0'; }, c => { c.Image = 'sha256:' + 'f'.repeat(64); },
    c => { c.Config.Entrypoint = ['/bin/sh']; }, c => { c.Path = '/bin/sh'; }, c => { c.HostConfig.Privileged = true; },
    c => { c.HostConfig.CapAdd = ['NET_ADMIN']; }, c => { c.HostConfig.PortBindings = { '8787/tcp': [{ HostPort: '8787' }] }; },
    c => { c.HostConfig.PidMode = 'host'; }, c => { c.HostConfig.Dns = ['8.8.8.8']; }, c => { c.Mounts[0].RW = true; },
    c => { c.Mounts[0].Source = path.resolve('foreign'); }, c => { c.Mounts[1].Destination = '/run/hermes-gateway'; },
    c => { c.Config.Env.push('OPENAI_API_KEY=PRIVATE'); }, c => { c.NetworkSettings.Networks.foreign = { NetworkID: 'f'.repeat(64) }; },
    c => { Object.values(c.NetworkSettings.Networks)[0].Aliases.push('foreign'); }];
  for (const mutateInspection of mutations) {
    const f = await fixture(t, { mutateInspection }); await assert.rejects(f.open(), /gateway_cleanup_unproven/);
    assert(!f.events.includes('kill')); assert(!f.events.includes('remove')); assert(!f.events.includes('remove-network'));
  }
});

test('caller cancellation waits for ignored create to settle, then deletes a known never-started sidecar without wait', async t => {
  const createWait = deferred(), f = await fixture(t, { createWait }); let settled = false;
  const opening = f.open().finally(() => { settled = true; }); void opening.catch(() => {});
  await wait(() => f.events.includes('create')); f.controller.abort(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(settled, false); assert(!f.events.includes('attach')); createWait.resolve(); await assert.rejects(opening, /gateway_open_failed/);
  assert(!f.events.includes('wait')); assert(f.events.includes('remove')); assert(f.events.includes('remove-network'));
});

test('timeout cannot retry or forget an ignored pending network create', async t => {
  const networkWait = deferred(), networkEntered = deferred(); let startup, cleared = false, settled = false;
  const timerHandle = Object.freeze({});
  const timers = { setTimeout(fn, ms) { assert.equal(ms, 2000); startup = fn; return timerHandle; },
    clearTimeout(handle) { assert.equal(handle, timerHandle); cleared = true; } };
  const f = await fixture(t, { networkWait, networkEntered, timers });
  const opening = f.open().finally(() => { settled = true; }); void opening.catch(() => {});
  await Promise.race([networkEntered.promise, opening.then(() => assert.fail('open completed before pending create'))]);
  assert.equal(typeof startup, 'function'); startup(); await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false); assert.equal(f.events.filter(value => value === 'create-network').length, 1);
  networkWait.resolve(); await assert.rejects(opening, /gateway_open_failed/); assert(!f.events.includes('create')); assert(f.events.includes('remove-network'));
  assert.equal(cleared, true);
});

test('unknown network or container creation preserves a safe receipt and never retries or adopts a guessed name', async t => {
  for (const changes of [{ networkFailure: true }, { networkId: 'PRIVATE-UNKNOWN-ID' }, { createFailure: true }, { containerId: 'PRIVATE-UNKNOWN-ID' }]) {
    const f = await fixture(t, changes); let observed;
    await assert.rejects(f.open(), error => { observed = error; return error.code === 'gateway_cleanup_unproven'; });
    assert(!JSON.stringify(observed).includes('PRIVATE')); assert.equal(observed.resources.phase, 'retained');
    const manifest = JSON.parse(await readFile(path.join(observed.resources.directory, 'resources.json'), 'utf8')); assert.deepEqual(manifest, observed.resources);
    assert(!f.events.includes('remove-network')); assert(!f.events.includes('remove')); assert(!f.events.includes('attach'));
    assert.equal(f.events.filter(value => value === 'create-network').length, 1); assert(f.events.filter(value => value === 'create').length <= 1);
  }
});

test('unknown attachment retains exact IDs and does not infer a process exit', async t => {
  const f = await fixture(t, { attachFailure: true }); let resources;
  await assert.rejects(f.open(), error => { resources = error.resources; return error.code === 'gateway_cleanup_unproven'; });
  assert.equal(resources.containerId, 'b'.repeat(64)); assert.equal(resources.networkId, 'a'.repeat(64)); assert(!f.events.includes('remove'));
});

test('close retains ownership until attached transport closes even after engine reports stopped', async t => {
  const f = await fixture(t, { lingeringTransport: true }), channel = await f.open(); let settled = false;
  const closing = channel.close().then(() => { settled = true; }); await wait(() => f.events.filter(value => value === 'inspect').length === 3);
  assert.equal(settled, false); assert(!f.events.includes('remove')); f.child().kill(); await closing; assert(f.events.includes('remove-network'));
});

test('unknown kill, delete or still-attached endpoint latches close failure without retry', async t => {
  for (const changes of [{ killFailure: true }, { removeFailure: true }, { removeNetworkFailure: true }, { foreignEndpoint: true }]) {
    const f = await fixture(t, changes), channel = await f.open(), closing = channel.close();
    await assert.rejects(closing, /gateway_cleanup_unproven/); assert.equal(channel.close(), closing);
    assert(f.events.filter(value => value === 'remove').length <= 1); assert(f.events.filter(value => value === 'remove-network').length <= 1);
    if (changes.foreignEndpoint) assert(!f.events.includes('remove-network'));
    await assert.rejects(hostRequest(f.socketPath()));
  }
});

test('aborting an open channel closes the host listener immediately and explicit close later proves ownership release', async t => {
  const f = await fixture(t), channel = await f.open(); f.controller.abort(); await assert.rejects(hostRequest(f.socketPath()));
  await channel.close(); assert(f.events.includes('remove-network'));
});

test('unexpected relay exit closes the host listener and does not automatically delete resources', async t => {
  const f = await fixture(t), channel = await f.open(); f.child().kill(); await wait(() => f.events.includes('child-close'));
  await assert.rejects(hostRequest(f.socketPath())); assert(!f.events.includes('remove')); await channel.close(); assert(f.events.includes('remove'));
});

test('relay output is bounded and never exposed in errors', async t => {
  const inspectWait = deferred(), f = await fixture(t, { mode: 'flood', inspectWait }); const opening = f.open(); void opening.catch(() => {});
  await wait(() => f.events.includes('relay-output-over-limit')); inspectWait.resolve();
  await assert.rejects(opening, error => !error.message.includes('xxx') && /^gateway_/.test(error.message)); assert(f.events.includes('remove-network'));
});

test('server closes active requests while separate gateway handler work remains owned by its caller', async t => {
  const entered = deferred(), work = deferred(); let handlerDone = false;
  const f = await fixture(t, { handler: async (_req, res) => { entered.resolve(); await work.promise; handlerDone = true; res.end('late'); } });
  const channel = await f.open(), pending = hostRequest(f.socketPath()); void pending.catch(() => {}); await entered.promise;
  await channel.close(); await assert.rejects(pending); assert.equal(handlerDone, false);
  work.resolve(); await wait(() => handlerDone); // gateway scope, not transport close, must drain model work.
});

test('native Linux socket and copied files use the configured nonroot owner and private modes', { skip: !linuxNonroot }, async t => {
  const f = await fixture(t), channel = await f.open();
  for (const target of [f.gatewayRoot, path.dirname(f.spec().relayCopy), f.spec().socketDirectory]) {
    const info = await lstat(target); assert.equal(info.mode & 0o777, 0o700); assert.equal(info.uid, process.getuid());
  }
  for (const target of [f.socketPath(), f.spec().relayCopy]) assert.equal((await lstat(target)).mode & 0o777, 0o600);
  await channel.close();
});

test('native Linux rejects an insecure or symlink gateway root before network creation', { skip: !linuxNonroot }, async t => {
  const f = await fixture(t); await mkdir(f.gatewayRoot, { mode: 0o700 }); await chmod(f.gatewayRoot, 0o755);
  await assert.rejects(f.open(), /gateway_open_failed/); assert(!f.events.includes('create-network'));
  const g = await fixture(t), target = path.join(g.directory, 'target'); await mkdir(target, { mode: 0o700 }); await symlink(target, g.gatewayRoot);
  await assert.rejects(g.open(), /gateway_open_failed/); assert(!g.events.includes('create-network'));
});
