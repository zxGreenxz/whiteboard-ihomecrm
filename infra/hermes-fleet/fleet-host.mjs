// Tầng chạm máy chủ của bộ công cụ fleet: thu "facts" (chỉ đọc) và chạy từng bước của kế hoạch. Chạy bằng root; mỗi bước
// đụng tới file riêng tư của một UID khác được giao cho helper chạy dưới đúng UID đó qua `setpriv` (mô hình "helper theo từng
// UID" của infra/hermes-runtime/HOST_SERVICE.md). Bí mật (mã kết nối hc_, token kênh hzn_, khoá nhà cung cấp) chỉ đi từ stdout
// của helper này vào stdin của helper kia qua bộ nhớ của tiến trình root; không bao giờ vào đối số, log hay màn hình.
// Mọi thao tác hệ thống đi qua `sys` (exec + vài lệnh file) để test thay bằng bản giả.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import { FleetError, SEED_MARKER, SIDECAR_LABEL, SIDECAR_VALUE, auditDropIn, auditDropInFile, auditScanConfig, channelProjection, connectionDigest,
  containerName, envSourceOf, homeOf, planAdd, planPrune, planRecreate, planRemove, listRows, profileCreateArgs, profileDirOf, profileEnv,
  recreateArgs, redactArgs, renderProfileConfig, retiredContainer, routeEndpoint, sharedEnvFrom, sidecarArgs, sidecarView, soulSourceOf, validateAddRequest } from './fleet-plan.mjs';

const HERE = nodePath.dirname(fileURLToPath(import.meta.url));
const posix = nodePath.posix;
export const SCRIPTS = Object.freeze({
  connector: nodePath.join(HERE, 'helper-connector.mjs'), channel: nodePath.join(HERE, 'helper-channel.mjs'), home: nodePath.join(HERE, 'helper-home.mjs'),
  operator: nodePath.join(HERE, '..', 'hermes-zalo-native', 'operator.mjs'), profile: nodePath.join(HERE, '..', 'hermes-zalo-native', 'profile-provisioning-cli.mjs'),
  launcher: nodePath.join(HERE, '..', '..', 'worker', 'deploy', 'zalo-worker.sh'), template: nodePath.join(HERE, 'khuon', 'config.yaml'),
  skills: nodePath.join(HERE, '..', 'hermes-skills', 'deploy.sh'), release: nodePath.join(HERE, '..', '..'),
});
const fail = (code, detail) => { throw new FleetError(code, detail); };
const out = result => result.stdout.toString('utf8');
const stamp = date => date.toISOString().replace(/[-:]|\.\d+/g, '');

/** Bản thật của `sys`. exec không qua shell; môi trường của helper được dựng lại tối thiểu (không thừa hưởng env của root). */
export function realSystem({ log = line => process.stderr.write(line + '\n') } = {}) {
  const stat = file => { try { const s = fs.lstatSync(file); return { uid: s.uid, gid: s.gid, mode: s.mode & 0o777, dir: s.isDirectory(), link: s.isSymbolicLink(), mtimeMs: s.mtimeMs }; } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  return {
    node: process.execPath, log, now: () => new Date(), stat,
    sleep: ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    exec(command, args, { input, timeoutMs } = {}) {
      const result = spawnSync(command, args, { input, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1048576, ...(timeoutMs ? { timeout: timeoutMs } : {}),
        env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent' } });
      return { status: result.status ?? 1, stdout: result.stdout ?? Buffer.alloc(0), stderr: result.stderr ?? Buffer.alloc(0), failed: result.error !== undefined,
        timedOut: result.error?.code === 'ETIMEDOUT' };
    },
    read: file => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    readdir: directory => { try { return fs.readdirSync(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } },
    mkdir(directory, mode, uid) { fs.mkdirSync(directory, { mode }); fs.chownSync(directory, uid, uid); fs.chmodSync(directory, mode); },
    write(file, text, mode) {
      const temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, text, { mode, flag: 'wx' }); fs.chmodSync(temp, mode); fs.renameSync(temp, file);
    },
    rename: (from, to) => fs.renameSync(from, to), unlink: file => { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } },
  };
}

function docker(sys, args, options) {
  const result = sys.exec('docker', args, options);
  if (result.status !== 0) fail('docker_loi', { lenh: redactArgs(args).slice(0, 6).join(' '), loi: result.stderr.toString('utf8').trim().slice(0, 300) });
  return out(result);
}
/** Chạy một script của bản phát hành dưới UID khác. `setpriv` bỏ nhóm phụ và chặn nâng quyền lại. */
function asUser(sys, user, script, args, options) {
  return sys.exec('setpriv', ['--reuid', String(user), '--regid', String(user), '--clear-groups', '--no-new-privs', sys.node, script, ...args], options);
}
function helperJson(result, helper) {
  // stderr của helper theo thiết kế chỉ có mã lỗi cố định, không có bí mật.
  if (result.status !== 0) fail('helper_loi', { helper, loi: result.stderr.toString('utf8').trim().slice(0, 300) });
  try { return JSON.parse(out(result)); } catch { fail('helper_loi', { helper, loi: 'đầu ra không phải JSON' }); }
}

// ------------------------------------------------------------------------------------------------------------- facts

function inspectAll(sys) {
  const names = docker(sys, ['ps', '-a', '--format', '{{.Names}}']).split('\n').map(line => line.trim()).filter(Boolean);
  const raw = names.length ? JSON.parse(docker(sys, ['inspect', ...names])) : [];
  return new Map(raw.map(entry => [String(entry.Name).replace(/^\//, ''), entry]));
}
function workerFacts(config, raw) {
  const worker = raw.get(config.worker.container);
  if (!worker) return { running: false, id: null };
  const native = (worker.Config?.Env ?? []).some(entry => /^HERMES_ZALO_NATIVE_CONFIG=.+/.test(entry));
  return { running: worker.State?.Running === true, id: worker.Id, image: worker.Image, startedAt: worker.State?.StartedAt ?? null, native,
    pid: Number.isInteger(worker.State?.Pid) && worker.State.Pid > 0 ? worker.State.Pid : null };
}
/** Mở thử một kết nối TCP tới connector TỪ network namespace của worker (nơi mọi sidecar chạy), không chạy gì trong container:
 * true = mở được, false = không, null = không kiểm được. Máy và cổng đi qua tham số vị trí, không nối vào chuỗi lệnh. */
function routeReachable(sys, worker, route) {
  if (!worker.running || !worker.pid) return null;
  const { host, port } = routeEndpoint(route);
  const probe = sys.exec('nsenter', ['-t', String(worker.pid), '-n', '--', 'bash', '-c', 'exec 3<>"/dev/tcp/$0/$1"', host, String(port)], { timeoutMs: 8000 });
  return probe.failed && probe.status !== 0 && !probe.stderr.length && !probe.timedOut ? null : probe.status === 0;
}
function nativeFacts(sys, config, worker) {
  const result = asUser(sys, config.worker.uid, SCRIPTS.channel, ['list', '--config', config.worker.nativeConfig]);
  if (result.status !== 0) return { ok: false };
  let listed; try { listed = JSON.parse(out(result)); } catch { return { ok: false }; }
  if (!listed.present) return { ok: false };
  const started = Date.parse(worker.startedAt ?? '');
  return { ok: true, listenPort: listed.listenPort, revision: listed.revision, channels: listed.channels,
    newerThanWorker: Number.isFinite(started) ? listed.configMtimeMs > started : true };
}
function homeFacts(sys, config, name) {
  const home = homeOf(config, name), profileDir = profileDirOf(config, name), info = sys.stat(home);
  if (!info) return { exists: false };
  const env = sys.read(posix.join(profileDir, '.env'));
  return { exists: true, uid: info.uid, private: info.dir && !info.link && info.mode === 0o700 && info.uid === info.gid && info.uid !== 0,
    profileDir: sys.stat(profileDir)?.dir === true, seeded: sys.stat(posix.join(profileDir, SEED_MARKER)) !== null,
    skills: sys.stat(posix.join(home, '.hermes', 'ihome-official-skills', 'current')) !== null,
    hasEnv: env !== null && env.split(/\r?\n/).some(line => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) };
}
function baseFacts(sys, config) {
  const raw = inspectAll(sys), worker = workerFacts(config, raw);
  const containers = [...raw.values()].map(sidecarView);
  return { raw, containers, worker };
}
function memAvailableMb(sys) {
  const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(sys.read('/proc/meminfo') ?? '');
  return match ? Number(match[1]) / 1024 : NaN;
}
function gatewayState(sys, view) {
  if (!view.home || !view.profile) return null;
  try {
    const state = JSON.parse(sys.read(posix.join(view.home, '.hermes', 'profiles', view.profile, 'gateway_state.json')) ?? 'null');
    if (!state) return null;
    return { state: state.gateway_state ?? null, activeAgents: state.active_agents ?? null, updatedAt: state.updated_at ?? null,
      zalo: state.platforms?.zalo_personal?.state ?? null };
  } catch { return null; }
}
/** Dòng `tool_call_timing` của connector (journal) cho biết kết nối nào vừa gọi CRM: chỉ có 8 ký tự băm của ID kết nối. */
function callEvidence(sys, unit, sinceEpoch) {
  const result = sys.exec('journalctl', ['-u', unit, '-o', 'cat', '--no-pager', '-g', 'tool_call_timing', '--since', `@${Math.floor(sinceEpoch)}`]);
  const rows = [];
  for (const line of out(result).split('\n')) {
    if (!line.startsWith('{')) continue;
    try { const row = JSON.parse(line); if (row.event === 'tool_call_timing' && typeof row.connection === 'string') rows.push(row); } catch { /* bỏ dòng hỏng */ }
  }
  return rows;
}

export function gatherAddFacts(sys, config, rawRequest) {
  const request = validateAddRequest(rawRequest, config), connector = config.connectors[request.connector];
  const facts = { ...baseFacts(sys, config), memAvailableMb: memAvailableMb(sys) };
  facts.passwdUids = (sys.read('/etc/passwd') ?? '').split('\n').map(line => Number(line.split(':')[2])).filter(Number.isInteger);
  facts.homeUids = sys.readdir(config.profilesRoot).map(entry => sys.stat(posix.join(config.profilesRoot, entry))?.uid).filter(Number.isInteger);
  facts.home = homeFacts(sys, config, request.name);
  facts.imagePresent = sys.exec('docker', ['image', 'inspect', '--format', '{{.Id}}', config.image]).status === 0;
  const envSource = sys.read(envSourceOf(config));
  facts.template = { soul: sys.stat(soulSourceOf(config)) !== null,
    envKeys: (envSource ?? '').split(/\r?\n/).map(line => /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*\S/.exec(line)?.[1]).filter(Boolean) };
  facts.native = nativeFacts(sys, config, facts.worker);
  facts.route = { reachable: routeReachable(sys, facts.worker, connector.route) };
  facts.audit = { registered: sys.stat(auditDropInFile(config, request.name)) !== null };
  let connectionId = request.connectionId ?? null;
  if (!request.trial) {
    const result = asUser(sys, connector.user, SCRIPTS.connector, ['binding', '--config', connector.config, '--binding-id', request.bindingId]);
    facts.binding = result.status === 0 ? (() => { try { return JSON.parse(out(result)).binding; } catch { return null; } })() : null;
    connectionId = facts.binding?.connectionId ?? null;
  }
  const listed = asUser(sys, connector.user, SCRIPTS.connector, ['list', '--config', connector.config]);
  try { facts.handoff = listed.status === 0 ? { ok: true, records: JSON.parse(out(listed)).records } : { ok: false }; } catch { facts.handoff = { ok: false }; }
  facts.connectionAlive = null;
  if (connectionId && facts.handoff.ok) {
    const checked = asUser(sys, connector.user, SCRIPTS.connector, ['check', '--config', connector.config, '--connection-id', connectionId]);
    try { if (checked.status === 0) facts.connectionAlive = JSON.parse(out(checked)).alive[connectionId] ?? null; } catch { /* giữ null */ }
  }
  return facts;
}
export function gatherRemoveFacts(sys, config, name) {
  const facts = baseFacts(sys, config);
  facts.home = homeFacts(sys, config, name);
  facts.native = nativeFacts(sys, config, facts.worker);
  facts.audit = { registered: sys.stat(auditDropInFile(config, name)) !== null };
  return facts;
}
export function gatherListFacts(sys, config) {
  const facts = baseFacts(sys, config);
  facts.native = nativeFacts(sys, config, facts.worker);
  facts.usage = {};
  const stats = sys.exec('docker', ['stats', '--no-stream', '--format', '{{.Name}}|{{.MemUsage}}']);
  for (const line of out(stats).split('\n')) {
    const match = /^([^|]+)\|([0-9.]+)([KMG])iB/.exec(line.trim());
    if (match) facts.usage[match[1]] = { usedMb: Math.round(Number(match[2]) * ({ K: 1 / 1024, M: 1, G: 1024 })[match[3]]) };
  }
  facts.gateways = {}; facts.lastCalls = {};
  for (const view of facts.containers) if (view.labels[SIDECAR_LABEL] === SIDECAR_VALUE && !retiredContainer(view.name)) facts.gateways[view.name] = gatewayState(sys, view);
  const since = sys.now().getTime() / 1000 - 6 * 3600;
  for (const connector of Object.values(config.connectors)) {
    for (const row of callEvidence(sys, connector.unit, since)) {
      const entry = facts.lastCalls[row.connection] ??= { any: null, tool: null };
      if (row.outcome === 'ok') { entry.any = row.ts; if (row.operation === 'tools/call') entry.tool = row.ts; }
    }
  }
  return facts;
}

// ------------------------------------------------------------------------------------------------------------- bước

function waitIdle(sys, view, { limitMs = 180000 } = {}) {
  for (let waited = 0; waited < limitMs; waited += 5000) {
    const gateway = gatewayState(sys, view);
    if (!gateway || gateway.state !== 'running' || gateway.activeAgents === 0) return true;
    sys.sleep(5000);
  }
  sys.log(`${view.name}: gateway vẫn bận sau ${limitMs / 1000} giây, tiếp tục dừng`);
  return false;
}
/** Dừng sidecar cũ, giữ nó dưới tên `-old-<giờ>` để lùi, rồi tạo container mới cùng tên. Tạo hỏng thì trả tên cũ. */
function replaceSidecar(sys, view, args) {
  const old = `${view.name}-old-${stamp(sys.now())}`;
  if (view.running) { waitIdle(sys, view); docker(sys, ['stop', '-t', '30', view.name]); }
  docker(sys, ['rename', view.name, old]);
  const created = sys.exec('docker', args);
  if (created.status !== 0) {
    sys.exec('docker', ['rm', '-f', view.name]); sys.exec('docker', ['rename', old, view.name]);
    fail('tao_sidecar_loi', { container: view.name, loi: created.stderr.toString('utf8').trim().slice(0, 300), giu_lai: view.name });
  }
  return { container: view.name, replaced: old, id: out(created).trim().slice(0, 12) };
}
function recreateFromInspect(sys, raw, name, workerId) {
  const inspect = raw.get(name), imageConfig = JSON.parse(docker(sys, ['image', 'inspect', inspect.Image]))[0]?.Config ?? {};
  return replaceSidecar(sys, sidecarView(inspect), recreateArgs(inspect, imageConfig, workerId));
}
function currentWorker(sys, config) {
  const worker = workerFacts(config, inspectAll(sys));
  if (!worker.running || !worker.id) fail('worker_khong_chay');
  return worker;
}
function registerAudit(sys, config, name, { remove = false } = {}) {
  const dropIn = auditDropInFile(config, name);
  if (remove) sys.unlink(dropIn); else sys.write(dropIn, auditDropIn(config, name), 0o644);
  let current = null; try { current = JSON.parse(sys.read(config.audit.scanConfig) ?? 'null'); } catch { fail('audit_cau_hinh_hong'); }
  sys.write(config.audit.scanConfig, JSON.stringify(auditScanConfig(current, config, name, { remove }), null, 2) + '\n', 0o644);
  if (sys.exec('systemctl', ['daemon-reload']).status !== 0) fail('systemctl_loi');
}
/** Chạy lệnh có xem trước của một helper: lần một lấy expectedRevision, lần hai ghi với đúng mã đó (cùng stdin). */
function planThenApply(sys, user, script, args, helper, input) {
  const planned = helperJson(asUser(sys, user, script, args, { input }), helper);
  if (typeof planned.expectedRevision !== 'string') fail('helper_loi', { helper, loi: 'thiếu expectedRevision' });
  return helperJson(asUser(sys, user, script, [...args, '--apply', '--expect', planned.expectedRevision], { input }), helper);
}
function trialChannel(assistant, connector) {
  return channelProjection({ ...assistant.identity, mainUid: assistant.identity.pairedUid, profile: assistant.name, generation: randomUUID(),
    token: `hzn_${randomBytes(32).toString('hex')}`, listenPort: connector.trialBridgePort });
}
/** Người thật: gateway `running` và Zalo `connected`. Người thử chỉ có kênh giả (cổng không ai nghe) nên Hermes v0.22.2 để gateway ở
 * `degraded` — mọi nền tảng đang chờ thử lại, tiến trình vẫn sống và MCP vẫn nối (gateway/run_startup.py). */
const gatewayReady = (assistant, state, zalo) => assistant.trial ? ['running', 'degraded'].includes(state) : state === 'running' && zalo === 'connected';
function verify(sys, config, assistant, connector, { limitMs = 240000 } = {}) {
  const digest = assistant.connectionId ? connectionDigest(assistant.connectionId) : null;
  let result = { container: 'unknown' };
  for (let waited = 0; waited <= limitMs; waited += 5000) {
    const inspect = JSON.parse(docker(sys, ['inspect', assistant.container]))[0], view = sidecarView(inspect);
    const started = Date.parse(view.startedAt ?? '') / 1000, gateway = gatewayState(sys, view);
    const evidence = digest && Number.isFinite(started) ? callEvidence(sys, connector.unit, started).filter(row => row.connection === digest && row.outcome === 'ok') : [];
    const last = evidence.at(-1);
    result = { container: view.running ? 'running' : 'stopped', restarts: inspect.RestartCount ?? 0, gateway: gateway?.state ?? null, zalo: gateway?.zalo ?? null,
      mounts: view.mounts.map(mount => `${mount.type}:${mount.target}`), homeOnly: view.mounts.filter(mount => mount.type === 'bind').length === 1 && view.home === assistant.home,
      crmEvidence: last ? { seen: true, operation: last.operation, at: last.ts, calls: evidence.length } : { seen: false } };
    if (view.running && gatewayReady(assistant, gateway?.state, gateway?.zalo) && last) break;
    if ((inspect.RestartCount ?? 0) > 3) break;
    sys.sleep(5000);
  }
  const ok = result.container === 'running' && gatewayReady(assistant, result.gateway, result.zalo) && result.homeOnly && result.crmEvidence?.seen === true;
  return { ...result, runtimeStatus: ok ? 'verified' : 'unverified' };
}

export function applyAdd(sys, config, rawRequest, expect) {
  const request = validateAddRequest(rawRequest, config), connector = config.connectors[request.connector];
  const facts = gatherAddFacts(sys, config, rawRequest), plan = planAdd(facts, rawRequest, config);
  if (plan.status !== 'ready') fail('ke_hoach_bi_chan', plan.blocks);
  if (plan.expectedRevision !== expect) fail('ke_hoach_da_doi');
  const { assistant } = plan, state = Object.fromEntries(plan.steps.map(entry => [entry.id, entry.state])), done = [];
  const mark = id => { done.push(id); sys.log(`xong bước: ${id}`); };
  const identity = assistant.identity, identityArgs = ['--account-id', identity.accountId, '--own-uid', identity.ownUid, '--paired-uid', identity.pairedUid];

  if (state.home === 'pending') { sys.mkdir(assistant.home, 0o700, assistant.uid); mark('home'); }
  if (state.profile === 'pending') {
    docker(sys, profileCreateArgs({ name: assistant.name, uid: assistant.uid, home: assistant.home, image: config.image }), { timeoutMs: 300000 });
    if (sys.stat(assistant.profileDir)?.dir !== true) fail('ho_so_khong_duoc_tao');
    mark('profile');
  }
  if (state.channel === 'pending') {
    const tokenFile = posix.join(posix.dirname(config.worker.nativeConfig), `${assistant.name}.issued.${randomUUID()}.token`);
    planThenApply(sys, config.worker.uid, SCRIPTS.operator, ['create', '--config', config.worker.nativeConfig, '--profile', assistant.name, ...identityArgs, '--token-file', tokenFile], 'operator');
    mark('channel');
  }
  if (state.seed === 'pending') {
    let channel;
    if (assistant.trial) channel = trialChannel(assistant, connector);
    else {
      const exported = asUser(sys, config.worker.uid, SCRIPTS.channel, ['export', '--config', config.worker.nativeConfig, '--profile', assistant.name]);
      if (exported.status !== 0) fail('helper_loi', { helper: 'channel export' });
      try { channel = channelProjection(JSON.parse(out(exported))); } finally { exported.stdout.fill(0); }
      if (channel.profile !== assistant.name || channel.accountId !== identity.accountId || channel.ownUid !== identity.ownUid || channel.pairedUid !== identity.pairedUid) fail('kenh_lech_danh_tinh');
    }
    const soul = sys.read(soulSourceOf(config)), templateText = sys.read(config.template.configFile ?? SCRIPTS.template);
    if (!soul || !templateText) fail('khuon_thieu_soul');
    const input = Buffer.from(JSON.stringify({ version: 1, configYaml: renderProfileConfig(templateText, { route: connector.route }), soul,
      env: profileEnv({ shared: sharedEnvFrom(sys.read(envSourceOf(config)) ?? '', config.template.sharedEnvKeys), channel }) }));
    try { helperJson(asUser(sys, assistant.uid, SCRIPTS.home, ['seed', '--profile-dir', assistant.profileDir], { input }), 'home seed'); } finally { input.fill(0); }
    mark('seed');
  }
  if (state.skills === 'pending') {
    // Trước khi có mã CRM: bản sao lưu config.yaml của deploy.sh chưa mang bí mật. Skill thuộc root, UID của trợ lý không ghi được.
    const deployed = sys.exec('bash', [SCRIPTS.skills, '--root', posix.join(assistant.home, '.hermes'), '--profiles', assistant.name,
      '--release', SCRIPTS.release, '--hermes-uid', String(assistant.uid)]);
    if (deployed.status !== 0) fail('cai_ky_nang_loi', { loi: deployed.stderr.toString('utf8').trim().slice(-300) });
    mark('skills');
  }
  {
    // Mã kết nối: stdout của helper connector đi nguyên khối vào stdin của bộ ghi hồ sơ (chạy bằng UID của trợ lý).
    const exported = asUser(sys, connector.user, SCRIPTS.connector, ['export', '--config', connector.config, '--connection-id', assistant.connectionId,
      '--assistant-id', request.assistantId, '--user-id', request.userId, '--organization-id', request.organizationId]);
    try {
      if (exported.status !== 0) fail('helper_loi', { helper: 'connector export', loi: exported.stderr.toString('utf8').trim().slice(0, 200) });
      planThenApply(sys, assistant.uid, SCRIPTS.profile, ['--home', assistant.profileDir, '--mcp-url', connector.route.url, '--profile', assistant.name, ...identityArgs,
        ...(connector.route.preserveOrigin ? ['--preserve-existing-http-origin', connector.route.preserveOrigin] : [])], 'profile-provisioning', exported.stdout);
    } finally { exported.stdout.fill(0); }
    mark('credential');
  }
  if (state.audit === 'pending') { registerAudit(sys, config, assistant.name); mark('audit'); }
  if (state['worker-restart'] === 'pending') {
    // Launcher tự preflight, rồi `docker stop --time -1`: chờ worker drain xong, có thể lâu. Không đặt hạn chót ở đây.
    sys.log('khởi động lại worker Zalo có drain (mọi trợ lý ngắt tạm)…');
    const launched = sys.exec('bash', [SCRIPTS.launcher, 'run', facts.worker.image, '--native']);
    if (launched.status !== 0) fail('worker_khoi_dong_lai_loi', { loi: launched.stderr.toString('utf8').trim().slice(-300) });
    mark('worker-restart');
  }
  const worker = currentWorker(sys, config), replaced = [];
  if (state.sidecars === 'pending') {
    const raw = inspectAll(sys);
    for (const name of plan.others) {
      const view = sidecarView(raw.get(name));
      if (view.running && view.networkMode === `container:${worker.id}`) continue;
      replaced.push(recreateFromInspect(sys, raw, name, worker.id));
    }
    mark('sidecars');
  }
  if (state.container === 'pending') {
    const args = sidecarArgs({ name: assistant.name, uid: assistant.uid, home: assistant.home, image: config.image, workerId: worker.id,
      memoryMb: assistant.memoryMb, connector: assistant.connector, connectionId: assistant.connectionId, trial: assistant.trial });
    const existing = inspectAll(sys).get(assistant.container);
    if (existing) replaced.push(replaceSidecar(sys, sidecarView(existing), args)); else docker(sys, args);
    mark('container');
  }
  const verification = verify(sys, config, assistant, connector);
  return { version: 1, action: 'them-nguoi', status: 'applied', assistant: { ...assistant, identity: undefined }, done, replaced, verification,
    runtimeStatus: verification.runtimeStatus };
}

export function applyRemove(sys, config, name, expect) {
  const facts = gatherRemoveFacts(sys, config, name), plan = planRemove(facts, { name }, config);
  if (plan.status !== 'ready') fail(plan.status === 'done' ? 'khong_con_gi_de_go' : 'ke_hoach_bi_chan', plan.blocks);
  if (plan.expectedRevision !== expect) fail('ke_hoach_da_doi');
  const state = Object.fromEntries(plan.steps.map(entry => [entry.id, entry.state])), time = stamp(sys.now()), done = [];
  const container = containerName(name);
  if (state.stop === 'pending') {
    const view = facts.containers.find(entry => entry.name === container);
    docker(sys, ['update', '--restart', 'no', container]);
    if (view.running) { waitIdle(sys, view); docker(sys, ['stop', '-t', '60', container]); }
    docker(sys, ['rename', container, `${container}-da-go-${time}`]);
    done.push('stop');
  }
  if (state['revoke-channel'] === 'pending') {
    planThenApply(sys, config.worker.uid, SCRIPTS.operator, ['revoke', '--config', config.worker.nativeConfig, '--profile', name], 'operator');
    done.push('revoke-channel');
  }
  if (state.audit === 'pending') { registerAudit(sys, config, name, { remove: true }); done.push('audit'); }
  let archived = null;
  if (state['archive-home'] === 'pending') {
    if (!sys.stat(config.archiveRoot)) sys.mkdir(config.archiveRoot, 0o700, 0);
    archived = posix.join(config.archiveRoot, `${name}-${time}`);
    sys.rename(homeOf(config, name), archived);
    done.push('archive-home');
  }
  return { version: 1, action: 'go-nguoi', status: 'applied', done, archivedHome: archived, keptContainer: state.stop === 'pending' ? `${container}-da-go-${time}` : null,
    followUp: plan.followUp, runtimeStatus: 'unverified' };
}

export function applyRecreate(sys, config, { only = [] }, expect) {
  const facts = baseFacts(sys, config), plan = planRecreate(facts, { only }, config);
  if (plan.status !== 'ready') fail(plan.status === 'done' ? 'khong_can_tao_lai' : 'ke_hoach_bi_chan', plan.blocks);
  if (plan.expectedRevision !== expect) fail('ke_hoach_da_doi');
  const replaced = [];
  for (const row of plan.sidecars) if (row.state === 'recreate') replaced.push(recreateFromInspect(sys, facts.raw, row.container, plan.workerId));
  sys.sleep(8000);
  const after = inspectAll(sys);
  return { version: 1, action: 'tao-lai-sidecar', status: 'applied', replaced,
    sidecars: replaced.map(entry => { const view = sidecarView(after.get(entry.container)); return { container: entry.container, running: view.running, currentNetwork: view.networkMode === `container:${plan.workerId}` }; }),
    rollback: 'Bản cũ còn dưới tên <container>-old-<giờ>; chỉ dùng lại được khi worker cũ còn.', runtimeStatus: 'unverified' };
}

export function planFor(sys, config, action, input) {
  if (action === 'them-nguoi') return planAdd(gatherAddFacts(sys, config, input), input, config);
  if (action === 'go-nguoi') return planRemove(gatherRemoveFacts(sys, config, input.name), input, config);
  if (action === 'tao-lai-sidecar') return planRecreate(baseFacts(sys, config), input, config);
  if (action === 'liet-ke') return { version: 1, action, assistants: listRows(gatherListFacts(sys, config)), memAvailableMb: Math.floor(memAvailableMb(sys)) };
  return fail('lenh_la');
}

/** don-handoff. Xem trước chạy lúc connector ĐANG chạy (hỏi nó từng mã còn sống không); ghi chỉ chạy lúc connector đã dừng. */
export function pruneHandoff(sys, config, { connector: key, connectionIds, apply = false, expect }) {
  const connector = Object.hasOwn(config.connectors, key) ? config.connectors[key] : fail('connector_khong_co');
  const ids = connectionIds.flatMap(id => ['--connection-id', id]);
  const active = sys.exec('systemctl', ['is-active', '--quiet', connector.unit]).status === 0;
  if (!apply) {
    if (!active) fail('connector_khong_chay', 'Xem trước cần connector đang chạy để hỏi từng mã còn sống không.');
    const listed = helperJson(asUser(sys, connector.user, SCRIPTS.connector, ['list', '--config', connector.config]), 'connector list');
    const checked = helperJson(asUser(sys, connector.user, SCRIPTS.connector, ['check', '--config', connector.config, ...ids]), 'connector check');
    return planPrune({ handoff: { ok: true, records: listed.records }, alive: checked.alive }, { connectionIds });
  }
  if (active) fail('connector_dang_chay', 'Dừng sạch connector trước khi ghi (một tiến trình ghi cho mỗi thư mục handoff).');
  if (typeof expect !== 'string') fail('thieu_expect');
  return helperJson(asUser(sys, connector.user, SCRIPTS.connector, ['prune', '--config', connector.config, ...ids, '--apply', '--expect', expect]), 'connector prune');
}
export const fleetConfigDigest = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
