import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { HERMES_IMAGE, assertPinnedImageInspection, runtimeUser } from './runtime-contract.mjs';
import { buildContainerArgs, dataSnapshot, idPattern, uuidPattern, validateRuntimeUser,
  validateGatewayDescriptor, validateNetworkInspection, validateContainerInspection } from './container-contract.mjs';

const FRAME_BYTES = 65536, MAX_COMMANDS = 1024;
const failure = code => new Error(code);
const reject = code => { throw failure(code); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject }; };
const safeText = (value, cap) => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value) && Buffer.byteLength(value, 'utf8') <= cap;
const positive = value => Number.isSafeInteger(value) && value > 0;
const sync = value => { if (value !== undefined) reject('invalid_gateway_port'); };
const ownedPath = (root, name) => {
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root || !uuidPattern.test(name)) reject('invalid_runtime_path');
  return target;
};
function parseFrame(bytes) {
  // The protocol is a flat scalar object. Parse each key exactly once before
  // JSON.parse can erase duplicate (including escaped-equivalent) properties.
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  if (!text.startsWith('{') || !text.endsWith('}')) reject('runtime_protocol_failed');
  let rest = text.slice(1, -1).trim(); const result = {};
  const string = /^"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001f])*"/;
  while (rest) {
    const keyToken = string.exec(rest)?.[0]; if (!keyToken) reject('runtime_protocol_failed');
    const key = JSON.parse(keyToken); if (Object.hasOwn(result, key)) reject('runtime_protocol_failed');
    rest = rest.slice(keyToken.length).trimStart(); if (!rest.startsWith(':')) reject('runtime_protocol_failed'); rest = rest.slice(1).trimStart();
    const token = string.exec(rest)?.[0] ?? /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest)?.[0];
    if (!token) reject('runtime_protocol_failed');
    Object.defineProperty(result, key, { value: JSON.parse(token), enumerable: true });
    rest = rest.slice(token.length).trimStart(); if (!rest) break;
    if (!rest.startsWith(',')) reject('runtime_protocol_failed'); rest = rest.slice(1).trimStart(); if (!rest) reject('runtime_protocol_failed');
  }
  return result;
}

/** Native transport, never invoked by factory/prepare. No shell, inherited
 * container credentials, install, image pull, automatic provisioning or retries.
 * A CLI timeout/abort is unknown, not proof that an engine mutation rolled back.
 */
export function createDockerEngine({ executable = 'docker', argumentsPrefix = [] } = {}) {
  if (typeof executable !== 'string' || !executable || /[\0\r\n]/.test(executable) || !Array.isArray(argumentsPrefix) ||
      argumentsPrefix.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) reject('invalid_engine');
  const prefix = Object.freeze([...argumentsPrefix]);
  const execute = promisify(execFile);
  let routeWork, route, initialized = false;
  const rawCommand = async (args, env, { signal } = {}) => {
    try { const result = await execute(executable, [...prefix, ...args], { env, signal, timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }); return result.stdout.trim(); }
    catch { reject('engine_operation_unknown'); }
  };
  const pinned = () => { if (!initialized) reject('engine_not_initialized'); return route; };
  const command = (args, options) => { const value = pinned(); return rawCommand(['--host', value.endpoint, ...args], value.env, options); };
  const inspect = async (args, options) => {
    try { const value = JSON.parse(await command(args, options)); if (!Array.isArray(value) || value.length !== 1) throw Error(); return value[0]; }
    catch { reject('engine_inspection_failed'); }
  };
  const checkedId = id => { if (typeof id !== 'string' || !idPattern.test(id)) reject('invalid_container_id'); return id; };
  return Object.freeze({
    async preflight(options) {
      if (process.platform !== 'linux') reject('native_linux_engine_required');
      // Docker's DOCKER_CONTEXT overrides DOCKER_HOST. Resolve that selection
      // once, then bind EVERY daemon call (including attach) to this exact Unix
      // endpoint. Never let later ambient env changes silently change ownership.
      routeWork ??= Promise.resolve().then(async () => {
        const source = { ...process.env };
        const env = Object.freeze(Object.fromEntries(Object.entries(source).filter(([key]) =>
          !/^DOCKER_(?:HOST|CONTEXT|TLS_VERIFY|CERT_PATH|API_VERSION|CUSTOM_HEADERS)$/i.test(key))));
        let endpoint;
        if (source.DOCKER_CONTEXT) endpoint = JSON.parse(await rawCommand(['context', 'inspect', source.DOCKER_CONTEXT,
          '--format', '{{json .Endpoints.docker.Host}}'], env, options));
        else if (source.DOCKER_HOST) endpoint = source.DOCKER_HOST;
        else endpoint = JSON.parse(await rawCommand(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], env, options));
        if (typeof endpoint !== 'string' || !/^unix:\/\/\/[^?#\0\r\n]+$/.test(endpoint)) reject('native_linux_engine_required');
        return Object.freeze({ endpoint, env });
      });
      let version;
      try { route = await routeWork;
        version = JSON.parse(await rawCommand(['--host', route.endpoint, 'version', '--format', '{{json .Server}}'], route.env, options)); }
      catch { reject('native_linux_engine_required'); }
      if (version?.Os !== 'linux' || typeof version?.Version !== 'string' || !/^\d+\.\d+/.test(version.Version) ||
          Number.parseInt(version.Version, 10) < 28) reject('native_linux_engine_required');
      initialized = true;
      return Object.freeze({ os: version?.Os, version: version?.Version, nativeHost: true });
    },
    inspectImage: (image, options) => { if (image !== HERMES_IMAGE) reject('invalid_image'); return inspect(['image', 'inspect', image], options); },
    inspectNetwork: (id, options) => inspect(['network', 'inspect', checkedId(id)], options),
    create: (args, options) => command(args, options),
    async createNetwork(args, options) { if (!Array.isArray(args) || args[0] !== 'network' || args[1] !== 'create') reject('invalid_network_command');
      return checkedId(await command(args, options)); },
    removeNetwork: async (id, options) => { await command(['network', 'rm', checkedId(id)], options); },
    attachStart: id => { checkedId(id); const value = pinned();
      return spawn(executable, [...prefix, '--host', value.endpoint, 'start', '--attach', '--interactive', id],
        { env: value.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); },
    inspectContainer: (id, options) => inspect(['inspect', checkedId(id)], options),
    kill: async (id, options) => { await command(['kill', checkedId(id)], options); },
    async wait(id, options) { const value = await command(['wait', checkedId(id)], options);
      if (!/^\d{1,3}$/.test(value) || Number(value) > 255) reject('engine_wait_failed'); return Number(value); },
    remove: async (id, options) => { await command(['rm', checkedId(id)], options); },
  });
}

/** Product supervisor adapter. Gateway owns private network/sidecar/socket and
 * tokens; this adapter owns only an inert handle, fresh runtime home, bootstrap,
 * wrapper copy and one exact container ID. Logical binding.home is never read,
 * mounted or deleted. Persistent memory requires a later reviewed storage layer.
 * prepare() does no I/O. stop() does not own or release the supervisor's lease.
 * Unknown create/stop/cleanup retains a rejected stop forever; no retry/takeover.
 * beginExecutePrivateCommand separates the observer from actual command drain,
 * including gateway.endTurn. A cancelled observer never proves work has stopped.
 */
export function createContainerRuntime({ gateway, engine = createDockerEngine(), runtimeRoot, wrapperPath,
  wrapperSha256, model, maxTokens = 1024, maxIterations = 4, user = runtimeUser(),
  startupTimeoutMs = 30000, stopGraceMs = 3000, timers = { setTimeout, clearTimeout } } = {}) {
  const gatewayPorts = ['prepare', 'start', 'setAdmission', 'beginTurn', 'endTurn', 'close'];
  const enginePorts = ['preflight', 'inspectImage', 'inspectNetwork', 'create', 'attachStart', 'inspectContainer', 'kill', 'wait', 'remove'];
  if (gatewayPorts.some(key => typeof gateway?.[key] !== 'function') || enginePorts.some(key => typeof engine?.[key] !== 'function') ||
      typeof runtimeRoot !== 'string' || !path.isAbsolute(runtimeRoot) || typeof wrapperPath !== 'string' || !path.isAbsolute(wrapperPath) ||
      typeof wrapperSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(wrapperSha256) || typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model) ||
      !positive(maxTokens) || maxTokens > 4096 || !positive(maxIterations) || maxIterations > 16 ||
      !positive(startupTimeoutMs) || startupTimeoutMs > 120000 || !positive(stopGraceMs) || stopGraceMs > 30000 ||
      typeof timers?.setTimeout !== 'function' || typeof timers?.clearTimeout !== 'function') reject('invalid_runtime_config');
  validateRuntimeUser(user); const root = path.resolve(runtimeRoot), handles = new WeakMap();
  const get = handle => { const entry = handles.get(handle); if (!entry) reject('invalid_runtime_handle'); return entry; };
  const live = entry => { if (entry.stopping || entry.controller.signal.aborted) reject('runtime_stopped'); };
  const closeGate = entry => {
    entry.admission = false;
    try { sync(gateway.setAdmission(entry.gateway, false)); } catch { entry.gateFailed = true; }
  };
  const write = (entry, value) => new Promise((resolve, fail) => {
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if (bytes.length > FRAME_BYTES || !entry.child?.stdin?.writable) { fail(failure('runtime_write_failed')); return; }
    entry.child.stdin.write(bytes, error => error ? fail(failure('runtime_write_unknown')) : resolve());
  });
  let stop;
  const poison = (entry, code) => {
    entry.protocolFailed = true; closeGate(entry); entry.ready.reject(failure(code));
    entry.command?.reply.reject(failure(code));
    // Never await stop here; stop drains this command's own work.
    void stop(entry.handle).catch(() => {});
  };
  const attach = entry => {
    const child = entry.child;
    if (!child?.stdin || !child.stdout || !child.stderr || typeof child.once !== 'function') reject('invalid_engine_transport');
    let buffer = Buffer.alloc(0), stderrBytes = 0;
    child.stdout.on('data', chunk => {
      if (entry.exited || entry.protocolFailed) return;
      try {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
        while (buffer.includes(10)) {
          const newline = buffer.indexOf(10); if (newline + 1 > FRAME_BYTES) throw Error();
          const frame = parseFrame(buffer.subarray(0, newline)); buffer = buffer.subarray(newline + 1);
          if (frame.event === 'ready') {
            const value = dataSnapshot(frame, ['event', 'version']);
            if (value.version !== 1 || entry.sawReady || entry.command) throw Error();
            entry.sawReady = true; entry.ready.resolve();
          } else if (frame.event === 'result') {
            const value = dataSnapshot(frame, ['event', 'commandId', 'text']);
            if (!entry.sawReady || !entry.command || value.commandId !== entry.command.id || entry.command.responded || !safeText(value.text, 32768)) throw Error();
            entry.command.responded = true; entry.command.reply.resolve(Object.freeze({ text: value.text }));
          } else if (frame.event === 'error') {
            const value = dataSnapshot(frame, ['event', 'commandId', 'code']);
            if (!/^[a-z_]{1,40}$/.test(value.code) || (value.commandId !== null && !uuidPattern.test(value.commandId))) throw Error();
            if (value.commandId !== null && value.commandId !== entry.command?.id) throw Error();
            poison(entry, 'runtime_command_failed');
          } else throw Error();
        }
        if (buffer.length > FRAME_BYTES) throw Error();
      } catch { poison(entry, 'runtime_protocol_failed'); }
    });
    child.stderr.on('data', chunk => { if (entry.protocolFailed) return; stderrBytes += chunk.length; if (stderrBytes > FRAME_BYTES) poison(entry, 'runtime_transport_failed'); });
    child.stdin.on('error', () => { if (!entry.stopping) poison(entry, 'runtime_transport_failed'); });
    child.once('error', () => { entry.ready.reject(failure('runtime_transport_failed')); });
    child.once('close', () => {
      entry.exited = true; closeGate(entry); entry.closed.resolve();
      entry.ready.reject(failure('runtime_exited')); entry.command?.reply.reject(failure('runtime_exited'));
      if (buffer.length && !entry.stopping) entry.protocolFailed = true;
    });
  };
  const prepare = raw => {
    let input, binding;
    try { input = dataSnapshot(raw, ['binding', 'admission', 'signal']); binding = dataSnapshot(input.binding, ['assistantId', 'userId', 'organizationId', 'home']); }
    catch { reject('invalid_runtime_binding'); }
    if (input.admission !== false || !(input.signal instanceof AbortSignal) || input.signal.aborted ||
        ['assistantId', 'userId', 'organizationId'].some(key => typeof binding[key] !== 'string' || !uuidPattern.test(binding[key])) ||
        typeof binding.home !== 'string' || !path.isAbsolute(binding.home)) reject('invalid_runtime_binding');
    const handle = Object.freeze({}), gatewayHandle = gateway.prepare(binding);
    if (!gatewayHandle || typeof gatewayHandle !== 'object' || typeof gatewayHandle.then === 'function') reject('invalid_gateway_handle');
    const controller = new AbortController(), entry = { handle, binding, gateway: gatewayHandle, controller, admission: false,
      phase: 'prepared', ready: deferred(), closed: deferred(), seen: new Set(), instanceId: randomUUID() };
    const aborted = () => { controller.abort(); closeGate(entry); void stop(handle).catch(() => {}); };
    entry.removeAbort = () => input.signal.removeEventListener('abort', aborted);
    handles.set(handle, entry); input.signal.addEventListener('abort', aborted, { once: true });
    return handle;
  };
  const start = handle => {
    const entry = get(handle); if (entry.phase !== 'prepared' || entry.stopping || entry.controller.signal.aborted) reject('runtime_start_invalid');
    entry.phase = 'starting'; const deadline = deferred();
    const timeout = timers.setTimeout(() => { closeGate(entry); entry.controller.abort(); deadline.reject(failure('runtime_start_timeout')); void stop(handle).catch(() => {}); }, startupTimeoutMs);
    const signal = entry.controller.signal;
    const abort = () => { deadline.reject(failure('runtime_stopped')); entry.ready.reject(failure('runtime_stopped')); };
    signal.addEventListener('abort', abort, { once: true });
    entry.startWork = Promise.resolve().then(async () => {
      const host = dataSnapshot(await engine.preflight({ signal }), ['os', 'version', 'nativeHost']); live(entry);
      if (host.os !== 'linux' || host.nativeHost !== true || typeof host.version !== 'string' || !/^\d+\.\d+/.test(host.version) || Number.parseInt(host.version, 10) < 28) reject('native_linux_engine_required');
      // Host creates private 0600/0700 bind sources. A different container UID
      // cannot read them; do not silently chmod, chown, or run the agent as root.
      if (process.platform === 'linux' && user !== `${process.getuid?.()}:${process.getgid?.()}`) reject('runtime_user_ownership_mismatch');
      const provenance = JSON.parse(await readFile(new URL('./image-provenance.json', import.meta.url), 'utf8')); live(entry);
      entry.image = await engine.inspectImage(HERMES_IMAGE, { signal }); live(entry); assertPinnedImageInspection(entry.image, provenance);
      entry.descriptor = validateGatewayDescriptor(await gateway.start(entry.gateway, { signal })); live(entry);
      validateNetworkInspection(await engine.inspectNetwork(entry.descriptor.networkId, { signal }), entry.descriptor); live(entry);
      await mkdir(root, { recursive: true, mode: 0o700 });
      if ((await lstat(root)).isSymbolicLink()) reject('invalid_runtime_root');
      // Windows 8.3 aliases can legitimately differ from realpath. Use one
      // canonical root for allocation and every subsequent containment check.
      entry.realRoot = await realpath(root); live(entry);
      entry.directory = ownedPath(entry.realRoot, entry.instanceId); await mkdir(entry.directory, { mode: 0o700 }); live(entry);
      const home = path.join(entry.directory, 'home'), bootstrap = path.join(entry.directory, 'bootstrap.json'), wrapper = path.join(entry.directory, 'agent-process.py');
      await mkdir(home, { mode: 0o700 }); live(entry);
      const wrapperBytes = await readFile(wrapperPath); live(entry);
      if (createHash('sha256').update(wrapperBytes).digest('hex') !== wrapperSha256) reject('wrapper_digest_changed');
      const boot = { version: 1, assistantId: entry.binding.assistantId, userId: entry.binding.userId, organizationId: entry.binding.organizationId,
        mcpUrl: entry.descriptor.mcpUrl, modelBaseUrl: entry.descriptor.modelBaseUrl, model, maxTokens, maxIterations };
      await writeFile(wrapper, wrapperBytes, { flag: 'wx', mode: 0o600 }); live(entry);
      await writeFile(bootstrap, JSON.stringify(boot) + '\n', { flag: 'wx', mode: 0o600 }); live(entry);
      entry.spec = Object.freeze({ instanceId: entry.instanceId, name: `ihome-hermes-runtime-${entry.instanceId}`, ...entry.descriptor, home, bootstrap, wrapper, user });
      entry.createAttempted = true;
      try { entry.containerId = await engine.create(buildContainerArgs(entry.spec), { signal });
        if (typeof entry.containerId !== 'string' || !idPattern.test(entry.containerId)) throw Error(); }
      catch { entry.createUnknown = true; reject('runtime_create_unknown'); }
      entry.spec = Object.freeze({ ...entry.spec, containerId: entry.containerId }); live(entry);
      entry.attachAttempted = true;
      try { entry.child = engine.attachStart(entry.containerId); attach(entry); }
      catch { entry.attachUnknown = true; reject('runtime_start_unknown'); }
      live(entry);
      await entry.ready.promise; live(entry);
      const inspected = await engine.inspectContainer(entry.containerId, { signal }); live(entry);
      validateContainerInspection(inspected, entry.spec, entry.image);
      if (inspected.State?.Running !== true || entry.exited) reject('runtime_not_running');
      entry.phase = 'ready';
    }).catch(() => { closeGate(entry); reject('runtime_start_failed'); });
    void entry.startWork.catch(() => {});
    return Promise.race([entry.startWork, deadline.promise]).finally(() => { timers.clearTimeout(timeout); signal.removeEventListener('abort', abort); });
  };
  const setAdmission = (handle, enabled) => {
    const entry = get(handle);
    if (typeof enabled !== 'boolean') reject('invalid_admission');
    if (!enabled) { closeGate(entry); if (entry.gateFailed) reject('runtime_gate_failed'); return; }
    live(entry); if (entry.phase !== 'ready' || entry.protocolFailed || entry.exited) reject('runtime_not_ready');
    try { sync(gateway.setAdmission(entry.gateway, true)); entry.admission = true; }
    catch { closeGate(entry); reject('runtime_gate_failed'); }
  };
  const beginExecutePrivateCommand = (handle, raw, options) => {
    const entry = get(handle); let command, signal;
    try { command = dataSnapshot(raw, ['commandId', 'bindingId', 'bindingEpoch', 'text']); signal = dataSnapshot(options, ['signal']).signal; }
    catch { reject('invalid_runtime_command'); }
    if (![command.commandId, command.bindingId].every(value => typeof value === 'string' && uuidPattern.test(value)) ||
        !positive(command.bindingEpoch) || !safeText(command.text, 8192) || !(signal instanceof AbortSignal)) reject('invalid_runtime_command');
    live(entry); if (!entry.admission || entry.phase !== 'ready' || signal.aborted || entry.exited) reject('runtime_command_stopped');
    if (entry.seen.has(command.commandId)) reject('runtime_command_duplicate');
    if (entry.command) reject('runtime_command_busy'); if (entry.seen.size >= MAX_COMMANDS) reject('runtime_command_capacity');
    entry.seen.add(command.commandId); const operation = { id: command.commandId, reply: deferred(), observer: deferred() }; entry.command = operation;
    const aborted = () => { closeGate(entry); operation.observer.reject(failure('runtime_command_cancelled')); void stop(handle).catch(() => {}); };
    signal.addEventListener('abort', aborted, { once: true });
    operation.work = Promise.resolve().then(async () => {
      try {
        live(entry); if (signal.aborted) reject('runtime_command_cancelled');
        sync(gateway.beginTurn(entry.gateway, Object.freeze({ commandId: command.commandId, signal })));
        operation.opened = true;
        await write(entry, { op: 'turn', ...command });
        const result = await operation.reply.promise;
        if (!entry.admission || signal.aborted || entry.stopping) reject('runtime_command_stopped');
        return result;
      } catch { closeGate(entry); void stop(handle).catch(() => {}); reject('runtime_command_failed'); }
      finally {
        if (operation.opened) {
          try { await gateway.endTurn(entry.gateway, Object.freeze({ commandId: command.commandId })); }
          catch { entry.drainFailed = true; closeGate(entry); void stop(handle).catch(() => {}); reject('runtime_drain_failed'); }
        }
      }
    }).finally(() => {
      signal.removeEventListener('abort', aborted); if (entry.command === operation) entry.command = undefined;
    }).then(value => {
      if (!signal.aborted && !entry.stopping && entry.admission) operation.observer.resolve(value);
      else operation.observer.reject(failure('runtime_command_stopped'));
    }, () => { operation.observer.reject(failure('runtime_command_failed')); });
    const drained = operation.work.then(async () => {
      // A protocol/write failure may reject the observer before the child exits.
      // stop waits for operation.work (not this promise), so this does not form
      // a cycle. A healthy result keeps its reusable runtime alive.
      if (entry.stopping) await entry.stopping;
      if (entry.drainFailed) reject('runtime_drain_failed');
    });
    void drained.catch(() => {});
    return Object.freeze({ result: operation.observer.promise, drained });
  };
  const executePrivateCommand = (handle, raw, options) => beginExecutePrivateCommand(handle, raw, options).result;
  stop = handle => {
    const entry = get(handle); if (entry.stopping) return entry.stopping;
    closeGate(entry); entry.controller.abort(); entry.ready.reject(failure('runtime_stopped')); entry.phase = 'stopping';
    entry.stopping = Promise.resolve().then(async () => {
      await entry.startWork?.catch(() => {});
      if (entry.createUnknown || entry.attachUnknown) reject('runtime_stop_unproven');
      if (entry.containerId) {
        if (entry.child && !entry.exited) {
          void write(entry, { op: 'shutdown' }).catch(() => {});
          let timer; await Promise.race([entry.closed.promise, new Promise(resolve => { timer = timers.setTimeout(resolve, stopGraceMs); })]); timers.clearTimeout(timer);
        }
        const before = await engine.inspectContainer(entry.containerId, {});
        validateContainerInspection(before, entry.spec, entry.image);
        if (before.State?.Running === true) await engine.kill(entry.containerId, {});
        if (entry.attachAttempted || before.State?.Status !== 'created' || before.State?.Running !== false) {
          const exitCode = await engine.wait(entry.containerId, {});
          if (!Number.isSafeInteger(exitCode) || exitCode < 0 || exitCode > 255) reject('runtime_stop_unproven');
        }
        const after = await engine.inspectContainer(entry.containerId, {});
        validateContainerInspection(after, entry.spec, entry.image);
        if (after.State?.Running !== false || after.State?.Dead === true || after.State?.Restarting === true) reject('runtime_stop_unproven');
        if (entry.child) await entry.closed.promise;
        await entry.command?.work;
        await engine.remove(entry.containerId, {});
      }
      await gateway.close(entry.gateway);
      if (entry.gateFailed || entry.drainFailed) reject('runtime_stop_unproven');
      if (entry.directory) {
        if (await realpath(entry.directory) !== ownedPath(entry.realRoot, entry.instanceId) || (await lstat(entry.directory)).isSymbolicLink()) reject('runtime_stop_unproven');
        await rm(entry.directory, { recursive: true, force: false });
      }
      entry.removeAbort(); entry.phase = 'stopped';
    }).catch(() => { reject('runtime_stop_unproven'); });
    void entry.stopping.catch(() => {}); return entry.stopping;
  };
  return Object.freeze({ prepare, start, setAdmission, beginExecutePrivateCommand, executePrivateCommand, stop });
}
