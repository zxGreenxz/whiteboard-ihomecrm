import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HERMES_IMAGE, NO_FORWARDING, PRIVATE_DNS, DNS_OPTIONS, ISOLATED_GATEWAY_OPTIONS,
  assertPinnedImageInspection, assertIsolatedNetwork, runtimeUser } from './runtime-contract.mjs';
import { dataSnapshot, idPattern, validateRuntimeUser, GATEWAY_URLS } from './container-contract.mjs';

const ENV = Object.freeze({ HOME: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' });
const RELAY_READY = Buffer.from('gateway_ready_v1\n');
// The pinned image declares VOLUME /opt/data. Override it explicitly so the
// sidecar cannot acquire an anonymous writable volume containing runtime state.
const TMPFS = Object.freeze({ '/tmp': 'rw,nosuid,nodev,noexec,size=16777216',
  '/opt/data': 'ro,nosuid,nodev,noexec,size=1048576' });
const positive = value => Number.isSafeInteger(value) && value > 0;
const digest = value => createHash('sha256').update(value).digest('hex');
const safePath = value => typeof value === 'string' && path.isAbsolute(value) && !/[\0\r\n,]/.test(value);
const canonical = value => path.resolve(value).replaceAll('\\', '/').replace(/^([A-Z]):/, (_, letter) => `${letter.toLowerCase()}:`);
const fail = code => { throw new Error(code); };

function containerArgs(spec) {
  return ['create', '--interactive', '--name', spec.containerName, '--network', spec.networkName, '--network-alias', 'hermes-gateway',
    '--platform', 'linux/amd64', '--label', `ihome.hermes.instance=${spec.instanceId}`, '--label', 'ihome.hermes.role=gateway', '--user', spec.user,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
    '--dns', PRIVATE_DNS[0], ...DNS_OPTIONS.flatMap(value => ['--dns-option', value]),
    ...Object.entries(NO_FORWARDING).flatMap(([key, value]) => ['--sysctl', `${key}=${value}`]),
    '--pids-limit', '64', '--memory', '256m', '--cpus', '0.25',
    ...Object.entries(TMPFS).flatMap(([key, value]) => ['--tmpfs', `${key}:${value}`]),
    '--mount', `type=bind,src=${spec.socketDirectory},dst=/run/hermes-gateway,readonly`,
    '--mount', `type=bind,src=${spec.relayCopy},dst=/run/gateway-relay.mjs,readonly`,
    ...Object.entries(ENV).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--workdir', '/tmp', '--entrypoint', '/usr/local/bin/node', HERMES_IMAGE,
    '/run/gateway-relay.mjs', '/run/hermes-gateway/gateway.sock'];
}
function inspectNetwork(value, spec) {
  assertIsolatedNetwork(value); assert.equal(value.Id, spec.networkId); assert.equal(value.Name, spec.networkName);
  assert.equal(value.Labels?.['ihome.hermes.instance'], spec.instanceId); assert.equal(value.Labels?.['ihome.hermes.role'], 'gateway');
}
function inspectContainer(value, spec, image) {
  assert.equal(value.Id, spec.containerId); assert.equal(value.Name, `/${spec.containerName}`);
  assert.equal(value.Image, image.Id); assert.equal(value.Config.Image, HERMES_IMAGE);
  assert.equal(value.Config.Labels?.['ihome.hermes.instance'], spec.instanceId); assert.equal(value.Config.Labels?.['ihome.hermes.role'], 'gateway');
  assert.equal(value.Config.User, spec.user); assert.equal(value.Config.OpenStdin, true); assert.equal(value.Config.Tty, false);
  assert.deepEqual(value.Config.Entrypoint, ['/usr/local/bin/node']);
  assert.deepEqual(value.Config.Cmd, ['/run/gateway-relay.mjs', '/run/hermes-gateway/gateway.sock']); assert.equal(value.Config.WorkingDir, '/tmp');
  assert.equal(value.Path, '/usr/local/bin/node'); assert.deepEqual(value.Args, value.Config.Cmd);
  const cfg = value.HostConfig;
  assert.equal(cfg.ReadonlyRootfs, true); assert.equal(cfg.Privileged, false); assert.deepEqual(cfg.CapDrop, ['ALL']); assert.deepEqual(cfg.CapAdd ?? [], []);
  assert.deepEqual(cfg.SecurityOpt, ['no-new-privileges']); assert.equal(cfg.LogConfig?.Type, 'none'); assert.equal(cfg.NetworkMode, spec.networkName);
  assert.deepEqual(cfg.PortBindings ?? {}, {}); assert.equal(cfg.PublishAllPorts, false); assert.deepEqual(cfg.Sysctls, NO_FORWARDING);
  assert.deepEqual(cfg.Dns, PRIVATE_DNS); assert.deepEqual(cfg.DnsOptions, DNS_OPTIONS); assert.deepEqual(cfg.Tmpfs, TMPFS);
  assert.equal(cfg.PidsLimit, 64); assert.equal(cfg.Memory, 256 * 1024 * 1024); assert.equal(cfg.NanoCpus, 250000000);
  assert.equal(cfg.RestartPolicy?.Name, 'no'); assert.equal(cfg.AutoRemove, false);
  for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode']) assert.notEqual(cfg[key], 'host');
  for (const key of ['Devices', 'DeviceRequests', 'ExtraHosts']) assert.deepEqual(cfg[key] ?? [], []);
  assert.deepEqual(Object.keys(value.NetworkSettings.Networks), [spec.networkName]);
  const network = value.NetworkSettings.Networks[spec.networkName]; assert.equal(network.NetworkID, spec.networkId);
  assert(Array.isArray(network.Aliases) && network.Aliases.includes('hermes-gateway'));
  assert(network.Aliases.every(alias => ['hermes-gateway', spec.containerName, spec.containerId.slice(0, 12)].includes(alias)));
  const expected = new Map([['/run/hermes-gateway', spec.socketDirectory], ['/run/gateway-relay.mjs', spec.relayCopy]]);
  const mounts = value.Mounts.filter(item => item.Type !== 'tmpfs'); assert.equal(mounts.length, 2);
  const seen = new Set();
  for (const item of mounts) { assert(expected.has(item.Destination)); assert(!seen.has(item.Destination)); seen.add(item.Destination);
    assert.equal(item.Type, 'bind'); assert.equal(item.RW, false); assert.equal(canonical(item.Source), canonical(expected.get(item.Destination)));
    assert(item.Propagation === undefined || item.Propagation === 'rprivate'); }
  for (const item of value.Mounts.filter(item => item.Type === 'tmpfs')) {
    assert(Object.hasOwn(TMPFS, item.Destination)); assert(!seen.has(item.Destination)); seen.add(item.Destination);
    assert.equal(item.RW, TMPFS[item.Destination].startsWith('rw,'));
  }
  const env = items => { assert(Array.isArray(items)); const map = new Map();
    for (const item of items) { assert.equal(typeof item, 'string'); const at = item.indexOf('='); assert(at > 0); const key = item.slice(0, at);
      assert(!map.has(key)); assert(!/(?:TOKEN|SECRET|PASSWORD|API_KEY|PROXY|CREDENTIAL)/i.test(key)); map.set(key, item.slice(at + 1)); } return map; };
  const inherited = env(image.Config.Env ?? []); for (const [key, value] of Object.entries(ENV)) inherited.set(key, value);
  assert.deepEqual(env(value.Config.Env), inherited);
}

/** Inert host transport. Uses one exact owned network, sidecar and socket per open.
 * No token/owner identity enters this API. Native Linux/nonroot owner is required;
 * platform override exists for fake-engine Windows named-pipe tests only and does
 * not bypass the actual Docker adapter's native preflight. Inspection proves a
 * running pinned Node process after its bounded listener-ready handshake. The
 * runtime MCP handshake must still complete before supervisor admission opens.
 * Failures retain a private resources.json plus safe error.resources metadata
 * when creation/cleanup cannot be proved. No guessed-name adoption or retry.
 */
export function createGatewayTransport({ engine, gatewayRoot, relayPath, relaySha256, user = runtimeUser(), platform = process.platform,
  startupTimeoutMs = 30000, timers = { setTimeout, clearTimeout } } = {}) {
  const ports = ['preflight', 'inspectImage', 'createNetwork', 'inspectNetwork', 'removeNetwork', 'create', 'attachStart', 'inspectContainer', 'kill', 'wait', 'remove'];
  if (ports.some(key => typeof engine?.[key] !== 'function') || !safePath(gatewayRoot) || !safePath(relayPath) ||
    typeof relaySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(relaySha256) || !['linux', 'win32', 'darwin'].includes(platform) ||
    !positive(startupTimeoutMs) || startupTimeoutMs > 120000 || typeof timers?.setTimeout !== 'function' ||
    typeof timers?.clearTimeout !== 'function') fail('invalid_gateway_transport_config');
  validateRuntimeUser(user); const root = path.resolve(gatewayRoot);
  const scheduleDeadline = timers.setTimeout.bind(timers), cancelDeadline = timers.clearTimeout.bind(timers);
  const resources = entry => Object.freeze({ instanceId: entry.instanceId, directory: entry.directory ?? null,
    networkName: entry.networkName, networkId: entry.networkId ?? null, containerName: entry.containerName, containerId: entry.containerId ?? null,
    networkUnknown: !!entry.networkUnknown, containerUnknown: !!entry.containerUnknown,
    networkRemoved: !!entry.networkRemoved, containerRemoved: !!entry.containerRemoved, phase: entry.phase });
  const receipt = async entry => { if (entry.directory) await writeFile(path.join(entry.directory, 'resources.json'), JSON.stringify(resources(entry)) + '\n', { mode: 0o600 }); };
  const error = (entry, code) => Object.assign(new Error(code), { code, resources: resources(entry) });
  const live = entry => { if (entry.controller.signal.aborted || entry.closing || entry.failed || entry.exited) fail('gateway_transport_stopped'); };
  const privatePath = async (target, directory) => {
    const info = await lstat(target); if (info.isSymbolicLink() || (directory && !info.isDirectory())) fail('gateway_path_refused');
    if (process.platform === 'linux') {
      const [uid, gid] = user.split(':').map(Number);
      if (info.uid !== uid || info.gid !== gid || (info.mode & 0o777) !== (directory ? 0o700 : 0o600)) fail('gateway_path_refused');
    }
  };
  const closeServer = entry => {
    if (!entry.server) return Promise.resolve();
    if (!entry.serverClosed) entry.serverClosed = (async () => {
      // An abort while listen is pending must not leave a late-bound listener.
      await entry.listenSettled?.catch(() => {});
      await new Promise(resolve => { entry.server.close(() => resolve()); entry.server.closeAllConnections(); });
    })();
    return entry.serverClosed;
  };
  const cleanup = entry => {
    if (entry.closing) return entry.closing;
    entry.controller.abort(); entry.phase = 'closing';
    entry.closing = (async () => {
      await entry.work?.catch(() => {}); await closeServer(entry);
      if (entry.networkUnknown || entry.containerUnknown || entry.attachUnknown) throw error(entry, 'gateway_cleanup_unproven');
      if (entry.containerId && !entry.containerRemoved) {
        const before = await engine.inspectContainer(entry.containerId, {}); inspectContainer(before, entry, entry.image);
        if (before.State?.Running === true) await engine.kill(entry.containerId, {});
        if (entry.attachAttempted || before.State?.Status !== 'created' || before.State?.Running !== false) {
          const code = await engine.wait(entry.containerId, {}); if (!Number.isSafeInteger(code) || code < 0 || code > 255) fail('gateway_cleanup_unproven');
        }
        const after = await engine.inspectContainer(entry.containerId, {}); inspectContainer(after, entry, entry.image);
        if (after.State?.Running !== false || after.State?.Dead === true || after.State?.Restarting === true) fail('gateway_cleanup_unproven');
        if (entry.child) await entry.childClosed;
        await engine.remove(entry.containerId, {}); entry.containerRemoved = true;
      }
      if (entry.networkId && !entry.networkRemoved) {
        const inspected = await engine.inspectNetwork(entry.networkId, {}); inspectNetwork(inspected, entry);
        // The orchestrator removes the runtime first. Never detach another
        // endpoint, retry deletion, or hide an incorrect shutdown order.
        if (!inspected.Containers || Object.keys(inspected.Containers).length !== 0) fail('gateway_network_still_in_use');
        await engine.removeNetwork(entry.networkId, {}); entry.networkRemoved = true;
      }
      if (entry.directory) {
        if (path.dirname(entry.directory) !== entry.realRoot || await realpath(entry.directory) !== entry.directory) fail('gateway_cleanup_unproven');
        await privatePath(entry.directory, true); await rm(entry.directory, { recursive: true, force: false });
      }
      entry.detach(); entry.phase = 'closed';
    })().catch(async () => { entry.phase = 'retained'; await receipt(entry).catch(() => {}); throw error(entry, 'gateway_cleanup_unproven'); });
    entry.closing.catch(() => {}); return entry.closing;
  };
  async function open(raw) {
    const input = dataSnapshot(raw, ['handler', 'signal']);
    if (typeof input.handler !== 'function' || !(input.signal instanceof AbortSignal) || input.signal.aborted) fail('invalid_gateway_transport_request');
    if (platform !== 'linux') fail('native_linux_engine_required');
    if (process.platform === 'linux' && user !== `${process.getuid?.()}:${process.getgid?.()}`) fail('gateway_owner_mismatch');
    const instanceId = randomUUID(), controller = new AbortController();
    const entry = { instanceId, user, controller, phase: 'opening', networkName: `ihome-hermes-gateway-${instanceId}`, containerName: `ihome-hermes-relay-${instanceId}` };
    const aborted = () => { controller.abort(); void closeServer(entry); };
    entry.detach = () => input.signal.removeEventListener('abort', aborted);
    input.signal.addEventListener('abort', aborted, { once: true });
    const timer = scheduleDeadline(aborted, startupTimeoutMs), signal = controller.signal;
    entry.work = (async () => {
      const host = dataSnapshot(await engine.preflight({ signal }), ['os', 'version', 'nativeHost']); live(entry);
      if (host.os !== 'linux' || host.nativeHost !== true || typeof host.version !== 'string' || !/^\d+\.\d+/.test(host.version) || Number.parseInt(host.version, 10) < 28) fail('native_linux_engine_required');
      const provenance = JSON.parse(await readFile(new URL('./image-provenance.json', import.meta.url), 'utf8')); live(entry);
      entry.image = await engine.inspectImage(HERMES_IMAGE, { signal }); live(entry); assertPinnedImageInspection(entry.image, provenance);
      const relay = await readFile(relayPath); live(entry); if (digest(relay) !== relaySha256) fail('gateway_relay_digest_changed');
      await mkdir(root, { recursive: true, mode: 0o700 }); await privatePath(root, true); entry.realRoot = await realpath(root); live(entry);
      entry.directory = path.join(entry.realRoot, instanceId); await mkdir(entry.directory, { mode: 0o700 }); await privatePath(entry.directory, true); live(entry);
      entry.socketDirectory = path.join(entry.directory, 's'); entry.relayCopy = path.join(entry.directory, 'gateway-relay.mjs');
      await mkdir(entry.socketDirectory, { mode: 0o700 }); await privatePath(entry.socketDirectory, true);
      await writeFile(entry.relayCopy, relay, { flag: 'wx', mode: 0o600 }); await privatePath(entry.relayCopy, false); await receipt(entry); live(entry);
      entry.socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\hermes-${instanceId}` : path.join(entry.socketDirectory, 'gateway.sock');
      if (process.platform !== 'win32' && Buffer.byteLength(entry.socketPath) > 100) fail('gateway_socket_path_too_long');
      entry.server = createServer({ maxHeaderSize: 16384 }, (req, res) => {
        if (controller.signal.aborted || entry.closing || entry.failed) { res.destroy(); return; }
        try { void Promise.resolve(input.handler(req, res)).catch(() => res.destroy()); } catch { res.destroy(); }
      });
      entry.server.requestTimeout = 15000; entry.server.headersTimeout = 10000; entry.server.maxHeadersCount = 32;
      entry.server.on('clientError', (_error, socket) => socket.destroy());
      entry.server.on('error', () => { entry.failed = true; controller.abort(); void closeServer(entry); });
      entry.listenSettled = new Promise((resolve, reject) => { entry.server.once('error', reject); entry.server.listen(entry.socketPath, () => { entry.server.off('error', reject); resolve(); }); });
      await entry.listenSettled;
      if (process.platform !== 'win32') { await chmod(entry.socketPath, 0o600); await privatePath(entry.socketPath, false); }
      live(entry);
      const hex = randomBytes(5).toString('hex'), subnet = `fd${hex.slice(0, 2)}:${hex.slice(2, 6)}:${hex.slice(6)}:1::/64`;
      const networkArgs = ['network', 'create', '--driver', 'bridge', '--internal', '--ipv6', '--subnet', subnet,
        '--label', `ihome.hermes.instance=${instanceId}`, '--label', 'ihome.hermes.role=gateway',
        ...Object.entries(ISOLATED_GATEWAY_OPTIONS).flatMap(([key, value]) => ['--opt', `${key}=${value}`]), entry.networkName];
      entry.networkAttempted = true;
      try { const id = await engine.createNetwork(networkArgs, { signal }); if (typeof id !== 'string' || !idPattern.test(id)) throw Error(); entry.networkId = id; }
      catch { entry.networkUnknown = true; throw error(entry, 'gateway_network_create_unknown'); }
      await receipt(entry); live(entry); inspectNetwork(await engine.inspectNetwork(entry.networkId, { signal }), entry); live(entry);
      entry.containerAttempted = true;
      try { const id = await engine.create(containerArgs(entry), { signal }); if (typeof id !== 'string' || !idPattern.test(id)) throw Error(); entry.containerId = id; }
      catch { entry.containerUnknown = true; throw error(entry, 'gateway_container_create_unknown'); }
      await receipt(entry); live(entry);
      entry.attachAttempted = true;
      let resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      void ready.catch(() => {});
      const readyAborted = () => rejectReady(error(entry, 'gateway_transport_stopped'));
      signal.addEventListener('abort', readyAborted, { once: true });
      entry.detachReady = () => signal.removeEventListener('abort', readyAborted);
      try {
        entry.child = engine.attachStart(entry.containerId);
        if (!entry.child?.stdin || !entry.child.stdout || !entry.child.stderr || typeof entry.child.once !== 'function') throw Error();
        entry.childClosed = new Promise(resolve => entry.child.once('close', () => { entry.exited = true; controller.abort(); void closeServer(entry); resolve(); }));
        entry.child.once('error', () => { entry.failed = true; controller.abort(); void closeServer(entry); });
        entry.child.stdin.on('error', () => { entry.failed = true; controller.abort(); void closeServer(entry); });
        let output = 0, readyBytes = Buffer.alloc(0), sawReady = false;
        const invalid = () => { entry.failed = true; controller.abort(); void closeServer(entry); };
        const count = chunk => { output += chunk.length; if (output > 65536) { invalid(); return false; } return true; };
        entry.child.stdout.on('data', chunk => {
          if (!count(chunk)) return;
          // docker start --attach is asynchronous. Only the pinned relay may
          // acknowledge that its listener has bound; a child spawn or an early
          // inspect of Docker's created state does not establish readiness.
          if (sawReady || readyBytes.length + chunk.length > RELAY_READY.length) { invalid(); return; }
          readyBytes = Buffer.concat([readyBytes, chunk]);
          if (!RELAY_READY.subarray(0, readyBytes.length).equals(readyBytes)) { invalid(); return; }
          if (readyBytes.length === RELAY_READY.length) { sawReady = true; resolveReady(); }
        });
        entry.child.stderr.on('data', count);
      } catch { entry.attachUnknown = true; fail('gateway_attach_unknown'); }
      await ready; entry.detachReady(); live(entry);
      const inspected = await engine.inspectContainer(entry.containerId, { signal }); live(entry); inspectContainer(inspected, entry, entry.image);
      if (inspected.State?.Running !== true || inspected.State?.Dead === true || inspected.State?.Restarting === true || entry.child.exitCode !== null || entry.child.signalCode !== null) fail('gateway_process_not_running');
      entry.phase = 'opened'; await receipt(entry); live(entry);
      return Object.freeze({ descriptor: Object.freeze({ networkName: entry.networkName, networkId: entry.networkId, ...GATEWAY_URLS }), close: () => cleanup(entry) });
    })();
    try { return await entry.work; }
    catch { await cleanup(entry); throw error(entry, 'gateway_open_failed'); }
    finally { cancelDeadline(timer); entry.detachReady?.(); if (entry.phase === 'closed') entry.detach(); }
  }
  return Object.freeze({ open });
}
