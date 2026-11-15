// Lõi lập kế hoạch THUẦN của bộ công cụ "mỗi người một trợ lý Hermes". Không đọc đĩa, không gọi lệnh: nhận "facts" do
// fleet-host.mjs thu trên máy chủ rồi trả kế hoạch (bước nào cần làm, bước nào đã xong, lý do từ chối) cùng một mã
// `expectedRevision`. Lệnh ghi chỉ chạy khi quản trị truyền lại đúng mã đó (`--apply --expect <mã>`), nên máy chủ đổi
// giữa lúc xem và lúc ghi thì lệnh dừng. Mọi đường dẫn là đường Linux của máy chủ ⇒ dùng path.posix (test chạy cả Windows).
import { createHash } from 'node:crypto';
import { posix as path } from 'node:path';
import yaml from 'js-yaml';

export const SIDECAR_LABEL = 'com.ihomecrm.component';
export const SIDECAR_VALUE = 'hermes-sidecar';
export const FLEET_LABELS = Object.freeze({ name: 'com.ihomecrm.fleet.name', connector: 'com.ihomecrm.fleet.connector',
  connection: 'com.ihomecrm.fleet.connection', trial: 'com.ihomecrm.fleet.trial' });
export const SEED_MARKER = '.ihome-fleet-seeded';
/** Có trong lúc đang gieo; còn lại sau một lần chết giữa chừng ⇒ được gieo lại (container của người này chưa từng chạy). */
export const SEEDING_MARKER = '.ihome-fleet-seeding';
export const CONTAINER_HOME = '/home/hermes';
export const CONTAINER_HERMES_HOME = '/home/hermes/.hermes';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ZALO_UID = /^[1-9][0-9]{0,39}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;
const IMAGE = /^(?:[a-z0-9][a-z0-9._/-]{0,200}@)?sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const MAX_CHANNELS = 100;
export const WORKER_LAUNCHER = Object.freeze({ container: 'ihome-zalo-worker', uid: 10002, nativeConfig: '/opt/ihome-zalo-worker/native-config/config.json' });

export class FleetError extends Error {
  constructor(code, detail) { super(code); this.name = 'FleetError'; this.code = code; if (detail !== undefined) this.detail = detail; }
}
const fail = (code, detail) => { throw new FleetError(code, detail); };
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, required, optional = []) => plain(value) && required.every(key => Object.hasOwn(value, key)) &&
  Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const absolute = value => typeof value === 'string' && value.length <= 1024 && value.startsWith('/') && !/[\0\r\n]/.test(value) &&
  path.normalize(value) === value && value !== '/';
const int = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const uuid = value => typeof value === 'string' && UUID.test(value);
/** 8 ký tự connector ghi ở `tool_call_timing.connection` (broker.mjs: sha256 của ID kết nối, cắt 8). */
export const connectionDigest = connectionId => createHash('sha256').update(connectionId).digest('hex').slice(0, 8);
export const connectionTail = connectionId => connectionId.slice(-8);

/** Tên dùng chung cho hồ sơ Hermes, kênh Zalo (operator.mjs) và container `hermes-<tên>`. Cấm các hậu tố mà công cụ tự đặt
 * cho container đã thay (`-old-…`) hoặc đã gỡ (`-da-go-…`) để không bao giờ nhầm một container bỏ đi là trợ lý sống. */
export function assistantName(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 31 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) ||
      value === 'default' || /(?:^|-)(?:old|da-go)(?:-|$)/.test(value)) fail('ten_khong_hop_le');
  return value;
}
export const containerName = name => `hermes-${name}`;
/** Container đã bị thay hoặc đã gỡ: giữ lại để lùi, không còn là trợ lý. */
export const retiredContainer = name => /-(?:old|da-go)-\d{8}T\d{6}Z$/.test(name);

/** Máy và cổng TCP mà trợ lý phải mở được để tới connector. */
export function routeEndpoint(route) {
  const url = new URL(route.url);
  return { host: url.hostname, port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) };
}
/** `mcpUrl` của connector: https hoặc loopback đi đường thường; IP nội bộ (cửa Docker 172.17.0.1) đi đường
 * `--preserve-existing-http-origin` của profile-provisioning-cli (chỉ thay mã trên server đã có đúng origin đó). */
export function mcpRoute(value) {
  let url;
  try { url = new URL(value); } catch { fail('cau_hinh_sai', 'mcpUrl'); }
  if (url.username || url.password || url.pathname !== '/mcp' || url.search || url.hash || url.href !== value) fail('cau_hinh_sai', 'mcpUrl');
  if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')) return Object.freeze({ url: value, preserveOrigin: null });
  const parts = url.hostname.split('.').map(Number);
  const privateIp = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255) &&
    (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168));
  if (url.protocol !== 'http:' || !privateIp) fail('cau_hinh_sai', 'mcpUrl');
  return Object.freeze({ url: value, preserveOrigin: url.origin });
}

/** Cấu hình môi trường của máy chủ (KHÔNG chứa danh sách người): /etc/ihome-hermes-fleet/fleet.json, root 0600. */
export function validateFleetConfig(input) {
  if (!exact(input, ['version', 'profilesRoot', 'archiveRoot', 'image', 'uidRange', 'ram', 'worker', 'template', 'connectors'], ['audit']) ||
      input.version !== 1) fail('cau_hinh_sai', 'khoa');
  const { profilesRoot, archiveRoot, image, uidRange, ram, worker, template, connectors } = input;
  if (!absolute(profilesRoot) || !absolute(archiveRoot) || archiveRoot === profilesRoot ||
      archiveRoot.startsWith(profilesRoot + '/') || profilesRoot.startsWith(archiveRoot + '/')) fail('cau_hinh_sai', 'profilesRoot');
  if (typeof image !== 'string' || !IMAGE.test(image)) fail('cau_hinh_sai', 'image');
  if (!Array.isArray(uidRange) || uidRange.length !== 2 || !int(uidRange[0], 1000, 60000) || !int(uidRange[1], uidRange[0], 60000) ||
      uidRange[1] - uidRange[0] >= 1000) fail('cau_hinh_sai', 'uidRange');
  if (!exact(ram, ['defaultLimitMb', 'expectedMb', 'keepFreeMb']) || !int(ram.defaultLimitMb, 256, 8192) ||
      !int(ram.expectedMb, 64, ram.defaultLimitMb) || !int(ram.keepFreeMb, 0, 65536)) fail('cau_hinh_sai', 'ram');
  if (!exact(worker, ['container', 'uid', 'nativeConfig']) || typeof worker.container !== 'string' ||
      !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(worker.container) || !int(worker.uid, 1, 60000) || !absolute(worker.nativeConfig)) fail('cau_hinh_sai', 'worker');
  // Khoảng UID là dấu "do công cụ dựng" của một home: không được chứa UID của worker.
  if (worker.uid >= uidRange[0] && worker.uid <= uidRange[1]) fail('cau_hinh_sai', 'uidRange_chua_uid_worker');
  // worker/deploy/zalo-worker.sh (launcher mà bước khởi động lại gọi) ghi cứng ba giá trị này; cấu hình khác đi thì launcher sẽ thay MỘT container khác.
  if (Object.entries(WORKER_LAUNCHER).some(([key, value]) => worker[key] !== value)) fail('cau_hinh_sai', 'worker_khac_launcher');
  if (!exact(template, ['sourceHome', 'sourceProfile', 'sharedEnvKeys'], ['configFile']) || !absolute(template.sourceHome) ||
      typeof template.sourceProfile !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(template.sourceProfile) ||
      !Array.isArray(template.sharedEnvKeys) || template.sharedEnvKeys.length > 8 ||
      template.sharedEnvKeys.some(key => typeof key !== 'string' || !ENV_KEY.test(key) || /^(HERMES_ZALO_|MCP_)/.test(key)) ||
      new Set(template.sharedEnvKeys).size !== template.sharedEnvKeys.length ||
      (template.configFile !== undefined && !absolute(template.configFile))) fail('cau_hinh_sai', 'template');
  if (!plain(connectors) || !Object.keys(connectors).length || Object.keys(connectors).length > 4) fail('cau_hinh_sai', 'connectors');
  const normalized = {};
  for (const [key, row] of Object.entries(connectors)) {
    if (!/^[a-z][a-z0-9-]{0,15}$/.test(key) || !exact(row, ['user', 'config', 'unit', 'mcpUrl'], ['trial', 'trialBridgePort']) ||
        typeof row.user !== 'string' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(row.user) || row.user === 'root' || !absolute(row.config) ||
        typeof row.unit !== 'string' || !/^[A-Za-z0-9@_-][A-Za-z0-9@._-]{0,80}\.service$/.test(row.unit) ||
        (row.trial !== undefined && typeof row.trial !== 'boolean')) fail('cau_hinh_sai', 'connectors');
    const trial = row.trial === true;
    // Kênh thử trỏ vào một cổng KHÔNG ai nghe trong network namespace của worker: gateway đứng được mà không chạm cầu thật.
    if (trial !== (row.trialBridgePort !== undefined) || (trial && !int(row.trialBridgePort, 1024, 65535))) fail('cau_hinh_sai', 'trial');
    normalized[key] = Object.freeze({ user: row.user, config: row.config, unit: row.unit, route: mcpRoute(row.mcpUrl), trial,
      ...(trial ? { trialBridgePort: row.trialBridgePort } : {}) });
  }
  const audit = input.audit ?? {};
  if (!exact(audit, [], ['dropInDir', 'scanConfig']) || Object.values(audit).some(value => !absolute(value))) fail('cau_hinh_sai', 'audit');
  return Object.freeze({ version: 1, profilesRoot, archiveRoot, image, uidRange: Object.freeze([...uidRange]), ram: Object.freeze({ ...ram }),
    worker: Object.freeze({ ...worker }), connectors: Object.freeze(normalized),
    template: Object.freeze({ sourceHome: template.sourceHome, sourceProfile: template.sourceProfile,
      sharedEnvKeys: Object.freeze([...template.sharedEnvKeys]), ...(template.configFile ? { configFile: template.configFile } : {}) }),
    audit: Object.freeze({ dropInDir: audit.dropInDir ?? '/etc/systemd/system/ihome-hermes-learning-audit.service.d',
      scanConfig: audit.scanConfig ?? '/etc/ihome-hermes-fleet/learning-audit.json' }) });
}

export const homeOf = (config, name) => path.join(config.profilesRoot, name);
export const profileDirOf = (config, name) => path.join(config.profilesRoot, name, '.hermes', 'profiles', name);
export const soulSourceOf = config => path.join(config.template.sourceHome, '.hermes', 'profiles', config.template.sourceProfile, 'SOUL.md');
export const envSourceOf = config => path.join(config.template.sourceHome, '.hermes', 'profiles', config.template.sourceProfile, '.env');

// ---------------------------------------------------------------------------------------------------------- container

/** Bộ cờ khoá của MỘT sidecar (infra/hermes-zalo-native/README.md › "Triển khai Docker opt-in"). Chỉ bind đúng home của người
 * đó; /opt/data là tmpfs riêng (image khai VOLUME /opt/data: không gắn thì mỗi lần tạo lại để lại một volume ẩn danh). */
export function sidecarArgs({ name, uid, home, image, workerId, memoryMb, connector, connectionId, trial = false }) {
  assistantName(name);
  if (!int(uid, 1, 60000) || !absolute(home) || typeof image !== 'string' || !IMAGE.test(image) || typeof workerId !== 'string' ||
      !CONTAINER_ID.test(workerId) || !int(memoryMb, 256, 8192) || typeof connector !== 'string' || !uuid(connectionId)) fail('tham_so_sai', 'sidecar');
  return ['run', '-d', '--name', containerName(name), '--network', `container:${workerId}`,
    '--user', `${uid}:${uid}`, '--init', '--restart', 'unless-stopped',
    '--memory', `${memoryMb}m`, '--memory-swap', `${memoryMb * 2}m`, '--cpus', '1', '--pids-limit', '256',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=64m,uid=${uid},gid=${uid},mode=0700`,
    '--tmpfs', `/opt/data:rw,nosuid,nodev,noexec,size=16m,uid=${uid},gid=${uid},mode=0700`,
    '--env', `HOME=${CONTAINER_HOME}`, '--env', `HERMES_HOME=${CONTAINER_HERMES_HOME}`, '--env', `HERMES_WRITE_SAFE_ROOT=${CONTAINER_HERMES_HOME}`,
    '--mount', `type=bind,source=${home},target=${CONTAINER_HOME}`,
    '--log-driver', 'json-file', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
    '--label', `${SIDECAR_LABEL}=${SIDECAR_VALUE}`, '--label', `${FLEET_LABELS.name}=${name}`,
    '--label', `${FLEET_LABELS.connector}=${connector}`, '--label', `${FLEET_LABELS.connection}=${connectionId}`,
    '--label', `${FLEET_LABELS.trial}=${trial ? 'true' : 'false'}`,
    '--entrypoint', 'hermes', image, '--profile', name, 'gateway', 'run'];
}

/** Container một lần để Hermes tự tạo khung hồ sơ (`hermes profile create`, v0.22.2): không mạng, cùng bộ cờ khoá. */
export function profileCreateArgs({ name, uid, home, image }) {
  assistantName(name);
  if (!int(uid, 1, 60000) || !absolute(home) || typeof image !== 'string' || !IMAGE.test(image)) fail('tham_so_sai', 'profile');
  return ['run', '--rm', '--network', 'none', '--user', `${uid}:${uid}`, '--init',
    '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128',
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=64m,uid=${uid},gid=${uid},mode=0700`,
    '--tmpfs', `/opt/data:rw,nosuid,nodev,noexec,size=16m,uid=${uid},gid=${uid},mode=0700`,
    '--env', `HOME=${CONTAINER_HOME}`, '--env', `HERMES_HOME=${CONTAINER_HERMES_HOME}`, '--env', `HERMES_WRITE_SAFE_ROOT=${CONTAINER_HERMES_HOME}`,
    '--mount', `type=bind,source=${home},target=${CONTAINER_HOME}`,
    '--entrypoint', 'hermes', image, 'profile', 'create', name, '--no-alias', '--no-skills'];
}

/** Rút phần cần của `docker inspect` (không mang giá trị env ra ngoài hàm này trừ ba biến đường dẫn đã biết). */
export function sidecarView(inspect) {
  const host = inspect?.HostConfig ?? {}, config = inspect?.Config ?? {};
  const mounts = (inspect?.Mounts ?? []).map(m => ({ type: m.Type, source: m.Type === 'volume' ? m.Name : m.Source, target: m.Destination, rw: m.RW !== false }));
  const cmd = config.Cmd ?? [], at = cmd.indexOf('--profile');
  const homeMount = mounts.find(m => m.type === 'bind' && m.target === CONTAINER_HOME);
  return { name: String(inspect?.Name ?? '').replace(/^\//, ''), id: inspect?.Id ?? '', running: inspect?.State?.Running === true,
    startedAt: inspect?.State?.StartedAt ?? null, image: inspect?.Image ?? '', user: config.User ?? '', labels: { ...(config.Labels ?? {}) },
    networkMode: host.NetworkMode ?? '', memoryMb: host.Memory ? Math.round(host.Memory / 1048576) : 0,
    profile: at >= 0 && typeof cmd[at + 1] === 'string' ? cmd[at + 1] : null, home: homeMount?.source ?? null, mounts,
    readOnly: host.ReadonlyRootfs === true, capDrop: host.CapDrop ?? [], capAdd: host.CapAdd ?? [], securityOpt: host.SecurityOpt ?? [],
    privileged: host.Privileged === true, published: Object.keys(host.PortBindings ?? {}).length > 0,
    pidMode: host.PidMode ?? '', ipcMode: host.IpcMode ?? '', devices: (host.Devices ?? []).length, extraBinds: (host.Binds ?? []).length,
    // Không xét CgroupnsMode: trên host cgroup v1 Docker ghi "host" cho MỌI container, kể cả container do công cụ dựng.
    hostNamespaces: [host.UsernsMode, host.UTSMode].includes('host'), groupAdd: (host.GroupAdd ?? []).length > 0 };
}

/** Sidecar lệch bộ cờ khoá thì công cụ KHÔNG tạo lại (tạo lại sẽ nhân bản cấu hình lỏng). Trả danh sách mã lệch. */
export function lockViolations(view, { profilesRoot }) {
  const out = [];
  const [uid, gid] = String(view.user).split(':');
  if (!/^[1-9][0-9]*$/.test(uid ?? '') || uid !== gid) out.push('user');
  if (!view.readOnly) out.push('read_only');
  if (!view.capDrop.map(c => String(c).toUpperCase()).includes('ALL') || view.capAdd.length) out.push('capabilities');
  if (!view.securityOpt.some(opt => /^no-new-privileges(?::true)?$/.test(opt))) out.push('no_new_privileges');
  // Tạo lại chép nguyên security-opt: mọi tuỳ chọn khác (seccomp/apparmor=unconfined, label=disable…) là nới lỏng.
  if (view.securityOpt.some(opt => !/^no-new-privileges(?::true)?$/.test(opt))) out.push('security_opt');
  if (view.hostNamespaces || view.groupAdd) out.push('host_namespaces');
  if (view.privileged || view.devices || view.published || view.extraBinds) out.push('privileged_surface');
  if (!/^container:[a-f0-9]{64}$/.test(view.networkMode)) out.push('network');
  if (view.pidMode || !['', 'private', 'shareable', 'none'].includes(view.ipcMode)) out.push('namespaces');
  const binds = view.mounts.filter(m => m.type === 'bind');
  if (binds.length !== 1 || binds[0].target !== CONTAINER_HOME || !binds[0].source?.startsWith(profilesRoot + '/') ||
      path.dirname(binds[0].source) !== profilesRoot) out.push('home_mount');
  if (view.mounts.some(m => m.type !== 'bind' && m.target !== '/opt/data')) out.push('extra_mount');
  return out;
}

/** Tạo lại ĐÚNG cấu hình đang chạy, chỉ đổi `--network` sang ID worker mới (`docker restart` không đổi network namespace).
 * Chuyển từ script ngoài repo `w3-recreate-sidecar.py`; env/label chỉ truyền lại phần khác image. */
export function recreateArgs(inspect, imageConfig, workerId) {
  if (typeof workerId !== 'string' || !CONTAINER_ID.test(workerId)) fail('tham_so_sai', 'worker');
  const host = inspect.HostConfig ?? {}, config = inspect.Config ?? {}, name = String(inspect.Name ?? '').replace(/^\//, '');
  const args = ['run', '-d', '--name', name, '--network', `container:${workerId}`];
  if (config.User) args.push('--user', config.User);
  if (host.Init) args.push('--init');
  if (host.RestartPolicy?.Name) args.push('--restart', host.RestartPolicy.Name);
  if (host.ReadonlyRootfs) args.push('--read-only');
  for (const cap of host.CapDrop ?? []) args.push('--cap-drop', cap);
  for (const opt of host.SecurityOpt ?? []) args.push('--security-opt', opt);
  for (const [target, options] of Object.entries(host.Tmpfs ?? {})) args.push('--tmpfs', options ? `${target}:${options}` : target);
  if (host.Memory) args.push('--memory', String(host.Memory));
  if (host.MemorySwap) args.push('--memory-swap', String(host.MemorySwap));
  if (host.MemoryReservation) args.push('--memory-reservation', String(host.MemoryReservation));
  if (host.NanoCpus) args.push('--cpus', String(host.NanoCpus / 1e9));
  if (host.PidsLimit) args.push('--pids-limit', String(host.PidsLimit));
  if (config.StopTimeout !== undefined && config.StopTimeout !== null) args.push('--stop-timeout', String(config.StopTimeout));
  if (host.LogConfig?.Type) args.push('--log-driver', host.LogConfig.Type);
  for (const [key, value] of Object.entries(host.LogConfig?.Config ?? {})) args.push('--log-opt', `${key}=${value}`);
  for (const mount of inspect.Mounts ?? []) {
    if (mount.Type === 'bind') args.push('--mount', `type=bind,source=${mount.Source},target=${mount.Destination}${mount.RW === false ? ',readonly' : ''}`);
    else if (mount.Type === 'volume') args.push('--mount', `type=volume,source=${mount.Name},target=${mount.Destination}${mount.RW === false ? ',readonly' : ''}`);
    else if (mount.Type !== 'tmpfs') fail('sidecar_mount_la', mount.Type);
  }
  const imageEnv = new Map((imageConfig?.Env ?? []).map(entry => { const at = entry.indexOf('='); return [entry.slice(0, at), entry.slice(at + 1)]; }));
  for (const entry of config.Env ?? []) {
    const at = entry.indexOf('='), key = entry.slice(0, at);
    if (imageEnv.get(key) !== entry.slice(at + 1)) args.push('--env', entry);
  }
  for (const [key, value] of Object.entries(config.Labels ?? {})) if ((imageConfig?.Labels ?? {})[key] !== value) args.push('--label', `${key}=${value}`);
  if (config.WorkingDir && config.WorkingDir !== (imageConfig?.WorkingDir ?? '')) args.push('--workdir', config.WorkingDir);
  const entrypoint = config.Entrypoint ?? [];
  if (entrypoint.length) args.push('--entrypoint', entrypoint[0]);
  args.push(inspect.Image, ...entrypoint.slice(1), ...(config.Cmd ?? []));
  return args;
}
/** In lệnh docker mà không lộ giá trị env (chỉ tên biến). */
export function redactArgs(args) {
  return args.map((arg, index) => args[index - 1] === '--env' ? `${arg.split('=', 1)[0]}=<ẩn>` : arg);
}

// --------------------------------------------------------------------------------------------------------------- khuôn

/** config.yaml của hồ sơ mới từ khuôn đã duyệt trong repo. Khuôn không được mang server MCP, nền tảng hay bí mật: hai mục
 * đầu do công cụ đặt, mã CRM do profile-provisioning-cli ghi sau. K1: chỉ bật đúng `zalo_personal`. */
export function renderProfileConfig(templateText, { route }) {
  let template;
  try { template = yaml.load(templateText, { schema: yaml.JSON_SCHEMA }); } catch { fail('khuon_sai', 'yaml'); }
  if (!plain(template) || Object.hasOwn(template, 'mcp_servers') || Object.hasOwn(template, 'platforms')) fail('khuon_sai', 'khoa_do_cong_cu_dat');
  const secretLike = value => typeof value === 'string' && (/^(hc_|hzn_|sk-|eyJ|Bearer\s)/.test(value) || /[A-Za-z0-9_-]{40,}/.test(value));
  const walk = value => Array.isArray(value) ? value.some(walk) : plain(value) ?
    Object.entries(value).some(([key, inner]) => /authorization|password|secret|api_key|apikey/i.test(key) || walk(inner)) : secretLike(value);
  if (walk(template)) fail('khuon_sai', 'bi_mat');
  const next = { ...template,
    // Cửa nội bộ: đặt sẵn server KHÔNG có mã; bộ ghi mã chỉ thay Authorization trên đúng origin này, không tạo/đổi hướng server.
    ...(route.preserveOrigin ? { mcp_servers: { ihomecrm: { url: route.url, transport: 'http', connect_timeout: 30, timeout: 60,
      enabled: true, strict_redirect_headers: true } } } : {}),
    platforms: { zalo_personal: { enabled: true } } };
  return yaml.dump(next, { schema: yaml.JSON_SCHEMA, noRefs: true, lineWidth: -1, sortKeys: false });
}

/** Bản chiếu kênh do worker cấp (readNativeProfileChannel) hoặc kênh THỬ không ai nghe. Cùng khuôn với
 * validateNativeProfileChannel của profile-provisioning.mjs; bộ ghi mã kiểm lại lần nữa trên file đã ghi. */
export function channelProjection(channel) {
  if (!exact(channel, ['accountId', 'ownUid', 'pairedUid', 'mainUid', 'profile', 'generation', 'token', 'listenPort']) ||
      !uuid(channel.accountId) || !uuid(channel.generation) || !ZALO_UID.test(channel.ownUid ?? '') || !ZALO_UID.test(channel.pairedUid ?? '') ||
      channel.ownUid === channel.pairedUid || channel.mainUid !== channel.pairedUid ||
      typeof channel.profile !== 'string' || typeof channel.token !== 'string' || !/^hzn_[a-f0-9]{64}$/.test(channel.token) ||
      !int(channel.listenPort, 1024, 65535)) fail('kenh_sai');
  return channel;
}
/** `.env` của hồ sơ mới: khoá dùng chung (nhà cung cấp model) + năm biến kênh theo đúng khuôn channelEnv của
 * profile-provisioning.mjs + kênh nhà cho cron. Không có mã CRM: mã nằm ở header trong config.yaml. */
export function profileEnv({ shared, channel }) {
  channelProjection(channel);
  if (!plain(shared) || Object.entries(shared).some(([key, value]) => !ENV_KEY.test(key) || typeof value !== 'string' ||
      !value || value.length > 512 || /[\s'"#\\$`]/.test(value))) fail('khuon_sai', 'env');
  const lines = [...Object.entries(shared).map(([key, value]) => `${key}=${value}`),
    `HERMES_ZALO_BRIDGE_URL=http://127.0.0.1:${channel.listenPort}`, `HERMES_ZALO_BRIDGE_TOKEN=${channel.token}`,
    `HERMES_ZALO_PROFILE=${channel.profile}`, `HERMES_ZALO_PAIRED_UID=${channel.pairedUid}`,
    `HERMES_ZALO_GENERATION=${channel.generation}`, `ZALO_PERSONAL_HOME_CHANNEL=${channel.pairedUid}`];
  return lines.join('\n') + '\n';
}
/** Lấy đúng các khoá dùng chung từ `.env` của hồ sơ khuôn (root đọc); thiếu khoá nào thì từ chối, không đoán. */
export function sharedEnvFrom(envText, keys) {
  const found = {};
  for (const line of String(envText).split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !keys.includes(match[1])) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (Object.hasOwn(found, match[1])) fail('khuon_sai', 'env_trung');
    found[match[1]] = value;
  }
  if (keys.some(key => !found[key])) fail('khuon_thieu_khoa');
  return found;
}

/** Drop-in gắn (chỉ đọc) đúng sáu đường của hồ sơ mới vào sandbox job kiểm học tập. */
export function auditDropIn(config, name) {
  const base = profileDirOf(config, assistantName(name));
  const paths = ['skills', 'memories', '.curator_backups', 'state.db', 'state.db-wal', 'state.db-shm'].map(entry => `-${base}/${entry}`);
  return `# Sinh bởi infra/hermes-fleet (them-nguoi ${name}); go-nguoi sẽ gỡ. Không sửa tay.\n[Service]\nBindReadOnlyPaths=${paths.join(' ')}\n`;
}
export const auditDropInFile = (config, name) => path.join(config.audit.dropInDir, `fleet-${name}.conf`);
/** File gốc quét của job kiểm (learning_audit.py --config-optional): thêm/bớt một trợ lý, giữ các mục khác. */
export function auditScanConfig(current, config, name, { remove = false } = {}) {
  const base = plain(current) ? current : {};
  const root = path.join(homeOf(config, name), '.hermes', 'profiles');
  const defaults = [path.join(config.template.sourceHome, '.hermes', 'profiles')];
  const roots = (Array.isArray(base.profilesRoots) && base.profilesRoots.length ? base.profilesRoots : defaults).filter(entry => entry !== root);
  const real = (Array.isArray(base.realProfiles) && base.realProfiles.length ? base.realProfiles : [config.template.sourceProfile]).filter(entry => entry !== name);
  if (!remove) { roots.push(root); real.push(name); }
  return { ...base, profilesRoots: roots, realProfiles: real };
}

// ----------------------------------------------------------------------------------------------------------- kế hoạch

/** Sidecar quản trị đã dừng tay: không chạy nhưng vẫn bám đúng worker hiện tại. */
const adminStopped = (view, workerId) => !view.running && view.networkMode === `container:${workerId}`;
export function memoryGate({ memAvailableMb, expectedMb, keepFreeMb }) {
  if (!Number.isFinite(memAvailableMb)) return { ok: false, code: 'ram_khong_do_duoc' };
  const afterMb = Math.floor(memAvailableMb - expectedMb);
  return afterMb >= keepFreeMb ? { ok: true, afterMb } : { ok: false, code: 'ram_khong_du', afterMb, keepFreeMb };
}
export function allocateUid({ range, used }) {
  for (let uid = range[0]; uid <= range[1]; uid++) if (!used.includes(uid)) return uid;
  return null;
}
const sameIdentity = (row, request) => ['assistantId', 'userId', 'organizationId'].every(key => row?.[key] === request[key]);
/** Danh tính kênh của người THỬ: cố định theo tên (chạy lại ra đúng giá trị cũ), không trùng nick Zalo thật nào; kênh này
 * không có trong cấu hình worker và trỏ vào cổng không ai nghe. */
export function trialIdentity(name) {
  const hex = createHash('sha256').update(`ihome-fleet-trial:${name}`).digest('hex');
  return Object.freeze({ accountId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`, ownUid: '1', pairedUid: '2' });
}
const step = (id, as, state, summary) => ({ id, as, state, summary });

export function validateAddRequest(request, config) {
  const keys = ['name', 'connector', 'assistantId', 'userId', 'organizationId'];
  if (!exact(request, keys, ['bindingId', 'connectionId', 'trial', 'memoryMb', 'uid'])) fail('tham_so_sai', 'khoa');
  assistantName(request.name);
  const connector = Object.hasOwn(config.connectors, request.connector) ? config.connectors[request.connector] : null;
  if (!connector) fail('connector_khong_co');
  if (!['assistantId', 'userId', 'organizationId'].every(key => uuid(request[key]))) fail('tham_so_sai', 'danh_tinh');
  const trial = request.trial === true;
  if (trial && !connector.trial) fail('thu_khong_duoc_phep');
  // Người thật: danh tính kênh đến từ liên kết Zalo trong SQL. Người thử: không có liên kết, quản trị chỉ rõ kết nối.
  if (trial ? (!uuid(request.connectionId) || request.bindingId !== undefined) : (!uuid(request.bindingId) || request.connectionId !== undefined)) fail('tham_so_sai', 'lien_ket');
  if (request.memoryMb !== undefined && !int(request.memoryMb, 256, 8192)) fail('tham_so_sai', 'ram');
  if (request.uid !== undefined && !int(request.uid, config.uidRange[0], config.uidRange[1])) fail('tham_so_sai', 'uid');
  return { ...request, trial, memoryMb: request.memoryMb ?? config.ram.defaultLimitMb };
}

/** Kế hoạch thêm một người. Chạy lại sau khi hỏng giữa chừng thì bước đã xong được nhận ra từ facts và bỏ qua. */
export function planAdd(facts, rawRequest, config) {
  const request = validateAddRequest(rawRequest, config), connector = config.connectors[request.connector];
  const { name, trial } = request, blocks = [], notes = [];
  const home = homeOf(config, name), profileDir = profileDirOf(config, name), container = containerName(name);
  const block = code => { if (!blocks.includes(code)) blocks.push(code); };
  const existing = facts.containers.find(view => view.name === container) ?? null;
  // UID: home đã có thì theo chủ của home (chạy tiếp lần trước); chưa có thì UID chỉ định hoặc số trống thấp nhất.
  // Đã dùng = có trong passwd, là chủ của một home (kể cả home đã CẤT: nó còn giữ mã CRM của người cũ), hoặc là user của một container.
  const used = [...new Set([...(facts.passwdUids ?? []), ...(facts.homeUids ?? []), config.worker.uid,
    ...facts.containers.map(view => Number(String(view.user).split(':')[0])).filter(Number.isInteger)])];
  let uid = facts.home.exists ? facts.home.uid : request.uid ?? allocateUid({ range: config.uidRange, used });
  // Tên hồ sơ là khoá của job kiểm học tập và của ops.sh: trùng một hồ sơ ở home khác (vd hồ sơ thử nằm chung home dựng tay) là nhập nhằng.
  if ((facts.profileNames ?? []).includes(name)) block('ten_trung_ho_so_khac');
  if (uid === null) block('het_uid');
  else if (facts.home.exists) { if (request.uid !== undefined && request.uid !== uid) block('home_khac_uid'); if (!facts.home.private) block('home_sai_quyen'); }
  else if (used.includes(uid)) block('uid_da_dung');
  if (!facts.imagePresent) block('anh_chua_co');
  if (!facts.template.soul) block('khuon_thieu_soul');
  if (config.template.sharedEnvKeys.some(key => !facts.template.envKeys.includes(key))) block('khuon_thieu_khoa');
  if (!facts.worker.running) block('worker_khong_chay');
  // Sidecar dùng chung network namespace của worker: từ đó mà không mở được cổng của connector thì trợ lý dựng xong cũng không gọi được CRM.
  else if (facts.route?.reachable === false) block('khong_toi_duoc_connector');
  else if (facts.route?.reachable !== true) block('khong_kiem_duoc_duong_toi_connector');

  // Danh tính kênh.
  let identity = null, connectionId = request.connectionId ?? null, channelState = 'skipped', channelAction = null;
  if (trial) {
    identity = trialIdentity(name);
    if (!facts.native?.ok) block('khong_doc_duoc_cau_hinh_kenh'); // phải biết cổng cầu thật để chắc kênh thử không trỏ vào nó
    else if (connector.trialBridgePort === facts.native.listenPort) block('cong_thu_trung_cau_that');
    // Người thử không có kênh thật. Trùng tên một kênh thật thì lúc gỡ người thử sẽ thu hồi nhầm kênh của người khác.
    else if (facts.native.channels.some(entry => entry.profile === name)) block('ten_trung_kenh_that');
  } else {
    if (facts.worker.native === false) block('worker_khong_native');
    const row = facts.binding;
    if (!row) block('khong_doc_duoc_lien_ket');
    else if (!sameIdentity(row, request) || row.bindingId !== request.bindingId) block('lien_ket_lech_danh_tinh');
    else if (row.status !== 'active' || !uuid(row.connectionId) || !ZALO_UID.test(row.ownUid ?? '') || !ZALO_UID.test(row.senderUid ?? '')) block('lien_ket_khong_hoat_dong');
    else { identity = { accountId: row.accountId, ownUid: row.ownUid, pairedUid: row.senderUid }; connectionId = row.connectionId; }
    if (!facts.native?.ok) block('khong_doc_duoc_cau_hinh_kenh');
    else {
      const channel = facts.native.channels.find(entry => entry.profile === name);
      if (channel && identity && (channel.accountId !== identity.accountId || channel.ownUid !== identity.ownUid || channel.pairedUid !== identity.pairedUid)) block('kenh_lech_danh_tinh');
      // Người đã gỡ được thêm lại bằng ĐÚNG tên cũ: kênh thu hồi vẫn giữ cặp nick bot–nick người dùng (tên khác sẽ bị chặn trùng nick),
      // nên cấp token mới cho chính kênh đó (operator.mjs rotate) thay vì tạo kênh.
      else if (channel?.unissued) { channelState = 'pending'; channelAction = 'rotate'; }
      else if (channel) channelState = 'done';
      else {
        channelState = 'pending'; channelAction = 'create';
        if (facts.native.channels.length >= MAX_CHANNELS) block('kenh_day');
        // Một nick Zalo đã ghép cho hồ sơ khác trên cùng nick bot: worker sẽ từ chối cấu hình trùng peer.
        if (identity && facts.native.channels.some(entry => entry.accountId === identity.accountId && entry.pairedUid === identity.pairedUid)) block('nick_zalo_da_co_kenh');
      }
    }
  }
  // Mã kết nối: đúng MỘT bản ghi handoff của đúng kết nối + danh tính, và connector đang nhận mã đó.
  if (connectionId) {
    const matched = (facts.handoff?.records ?? []).filter(row => row.connectionId === connectionId && sameIdentity(row, request));
    if (!facts.handoff?.ok) block('khong_doc_duoc_handoff');
    else if (matched.length !== 1) block('chua_co_ma_ket_noi');
    else if (facts.connectionAlive !== true) block(facts.connectionAlive === false ? 'ket_noi_khong_song' : 'khong_kiem_duoc_ket_noi');
  }

  const homeState = facts.home.exists ? 'done' : 'pending';
  const profileState = facts.home.profileDir ? 'done' : 'pending';
  const seedState = facts.home.seeded ? 'done' : 'pending';
  const skillsState = facts.home.skills ? 'done' : 'pending';
  // Hồ sơ có .env mang biến mà không do công cụ dựng (`seeding` = lần gieo trước chết giữa chừng: được gieo lại).
  if (facts.home.profileDir && !facts.home.seeded && !facts.home.seeding && facts.home.hasEnv) block('ho_so_la');
  // Người thật: hồ sơ chỉ được gieo SAU khi đã có kênh. Đã gieo mà chưa có kênh ⇒ đây là home của một người thử trùng tên.
  if (!trial && facts.home.seeded && channelAction === 'create') block('home_cua_nguoi_thu');
  // Kênh đã thu hồi mà home cũ còn (go-nguoi hỏng sau bước thu hồi, hoặc thu hồi tay): cấp token mới thì .env đã gieo vẫn giữ token
  // cũ và không bước nào sửa. Phải gỡ nốt (cất home) rồi mới thêm lại trên home mới.
  if (channelAction === 'rotate' && facts.home.exists) block('kenh_da_thu_hoi_con_home');
  const workerId = facts.worker.id ?? '';
  // Worker đọc cấu hình kênh một lần lúc khởi động ⇒ kênh mới (hoặc cấu hình mới hơn worker) cần khởi động lại có drain.
  const restartState = trial ? 'skipped' : channelState === 'pending' || facts.native?.newerThanWorker ? 'pending' : 'done';
  const labelled = facts.containers.filter(view => view.labels[SIDECAR_LABEL] === SIDECAR_VALUE && !retiredContainer(view.name) && view.name !== container);
  // Chỉ sidecar ĐANG CHẠY mới được tạo lại; sidecar quản trị đã dừng tay thì để yên (tạo lại sẽ làm nó chạy lại, ăn RAM ngoài cửa RAM).
  // "Dừng tay" = không chạy mà vẫn bám đúng worker hiện tại: để yên. Không chạy mà bám worker CŨ là sidecar chết vì worker đã bị thay
  // (Docker không khởi động lại được nó): phải tạo lại như sidecar đang chạy.
  const stopped = labelled.filter(view => adminStopped(view, workerId)), others = labelled.filter(view => !adminStopped(view, workerId));
  const stale = others.filter(view => view.networkMode !== `container:${workerId}`);
  const sidecarState = trial ? 'skipped' : restartState === 'pending' || stale.length ? 'pending' : 'done';
  if (sidecarState === 'pending') for (const view of others) if (lockViolations(view, config).length) block('sidecar_lech_khoa');
  // Container chung network namespace với worker mà không mang nhãn sidecar sẽ bị bỏ lại ở namespace chết khi worker được thay.
  if (!trial && facts.containers.some(view => view.networkMode === `container:${workerId}` && view.labels[SIDECAR_LABEL] !== SIDECAR_VALUE &&
      !retiredContainer(view.name))) block('sidecar_khong_nhan');
  if (stopped.length) notes.push(`Sidecar đang dừng, không đụng tới: ${stopped.map(view => view.name).join(', ')}.`);
  let containerState = 'pending';
  if (existing) {
    const matches = existing.labels[FLEET_LABELS.name] === name && existing.home === home;
    if (!matches) block('container_trung_ten');
    else if ((existing.labels[FLEET_LABELS.trial] === 'true') !== trial) block('container_khac_che_do');
    else if (existing.running && existing.networkMode === `container:${workerId}` && restartState !== 'pending') containerState = 'done';
    else containerState = 'pending'; // sẽ được tạo lại theo worker hiện tại
  }
  // Cửa RAM áp cho mọi lần làm thêm một container chạy: container mới, hoặc container của người này đang dừng được dựng lại.
  if (containerState === 'pending' && !existing?.running) {
    const gate = memoryGate({ memAvailableMb: facts.memAvailableMb, expectedMb: config.ram.expectedMb, keepFreeMb: config.ram.keepFreeMb });
    if (!gate.ok) block(gate.code);
    notes.push(`RAM còn dùng được ${Math.floor(facts.memAvailableMb ?? 0)} MB; sau khi thêm ước còn ${gate.afterMb ?? '?'} MB (giữ trống tối thiểu ${config.ram.keepFreeMb} MB).`);
  }
  const auditState = trial ? 'skipped' : facts.audit?.registered ? 'done' : 'pending';
  // Danh sách gốc của job kiểm học tập hỏng thì bước đăng ký sẽ hỏng SAU khi đã tạo kênh (bước không lùi được): chặn từ đầu.
  if (!trial && facts.audit?.broken) block('audit_cau_hinh_hong');
  const steps = [
    step('home', 'root', homeState, `Tạo home riêng ${home} (chủ ${uid}, 0700)`),
    step('profile', 'assistant', profileState, `Hermes tự tạo khung hồ sơ "${name}" (container một lần, không mạng)`),
    step('channel', 'worker', channelState, trial ? 'Người thử: không tạo kênh Zalo thật' : channelAction === 'rotate' ?
      `Cấp token mới cho kênh đã thu hồi của "${name}" (operator.mjs rotate, UID ${config.worker.uid})` : `Tạo kênh Zalo cho "${name}" (operator.mjs create, UID ${config.worker.uid})`),
    step('seed', 'assistant', seedState, 'Ghi config.yaml, .env, SOUL và plugin từ khuôn vào hồ sơ mới'),
    step('skills', 'root', skillsState, 'Cài kỹ năng CRM chuẩn của bản phát hành vào home mới (thuộc root, trợ lý chỉ đọc)'),
    step('credential', 'assistant', 'pending', `Chuyển mã kết nối …${connectionId ? connectionTail(connectionId) : '?'} từ handoff vào hồ sơ (không in ra màn hình)`),
    step('audit', 'root', auditState, trial ? 'Người thử: không đăng ký kiểm học tập' : 'Đăng ký hồ sơ với job kiểm học tập (drop-in + danh sách gốc)'),
    step('worker-restart', 'root', restartState, trial ? 'Người thử: không khởi động lại worker' : 'Khởi động lại worker Zalo có drain (MỌI trợ lý ngắt tạm)'),
    step('sidecars', 'root', sidecarState, trial ? 'Người thử: không đụng sidecar khác' : `Tạo lại ${others.length} sidecar đang có theo worker mới`),
    step('container', 'root', containerState, `Dựng container ${container} (trần RAM ${request.memoryMb} MB)`),
    step('verify', 'root', 'pending', 'Kiểm: container, gateway, và connector đã thấy trợ lý gọi CRM bằng đúng kết nối'),
  ];
  const pending = steps.filter(entry => entry.state === 'pending' && entry.id !== 'verify' && entry.id !== 'credential').length;
  const assistant = { name, uid, home, profileDir, container, memoryMb: request.memoryMb, connector: request.connector, trial,
    connectionId, connectionTail: connectionId ? connectionTail(connectionId) : null, identity, channelAction };
  const status = blocks.length ? 'blocked' : 'ready';
  // Mã ghi ràng cả cấu hình môi trường: đổi image, mcpUrl, hồ sơ khuôn hay UID worker giữa lúc xem và lúc ghi thì mã lệch.
  const expectedRevision = digest(['add', 1, config, request, assistant, steps.map(entry => [entry.id, entry.state]), blocks, workerId,
    facts.native?.revision ?? null, others.map(view => [view.name, view.id]).sort()]);
  return { version: 1, action: 'them-nguoi', status, blocks, notes, assistant, steps, pendingSteps: pending, others: others.map(view => view.name),
    expectedRevision, runtimeStatus: 'unverified' };
}

/** Gỡ một trợ lý do công cụ dựng: dừng container (giữ lại, đổi tên), thu hồi kênh, bỏ đăng ký kiểm, CẤT home (không xoá). */
export function planRemove(facts, rawRequest, config) {
  if (!exact(rawRequest, ['name'])) fail('tham_so_sai', 'khoa');
  const name = assistantName(rawRequest.name), container = containerName(name), blocks = [];
  const existing = facts.containers.find(view => view.name === container) ?? null;
  // Dấu "do công cụ dựng" phải là thứ root đặt, không phải file trong home của trợ lý: nhãn container, hoặc (khi chưa có container, vd
  // lượt thêm dở) home thuộc một UID trong khoảng công cụ cấp. hermes-owner dựng tay (UID ngoài khoảng, không nhãn) không bao giờ khớp.
  const uidInRange = facts.home.exists && int(facts.home.uid, config.uidRange[0], config.uidRange[1]);
  const fleetOwned = existing ? existing.labels[FLEET_LABELS.name] === name : uidInRange;
  if (!existing && !facts.home.exists) blocks.push('khong_tim_thay');
  else if (!fleetOwned) blocks.push('khong_phai_cua_cong_cu');
  const trial = existing?.labels[FLEET_LABELS.trial] === 'true';
  const channel = facts.native?.ok ? facts.native.channels.find(entry => entry.profile === name) : null;
  if (!trial && !facts.native?.ok) blocks.push('khong_doc_duoc_cau_hinh_kenh');
  // Danh sách gốc hỏng thì bước bỏ đăng ký sẽ hỏng SAU khi container đã bị dừng và đổi tên: chặn từ đầu. Người thử chưa từng đăng ký.
  if (!trial && facts.audit?.broken) blocks.push('audit_cau_hinh_hong');
  const steps = [
    step('stop', 'root', existing ? 'pending' : 'skipped', `Chờ gateway rảnh rồi dừng ${container}, tắt tự khởi động, đổi tên thành ${container}-da-go-<giờ> (giữ để lùi)`),
    // Người thử không có kênh thật: không bao giờ thu hồi kênh trùng tên của người khác.
    step('revoke-channel', 'worker', !trial && channel && !channel.unissued ? 'pending' : 'skipped', 'Thu hồi kênh Zalo (operator.mjs revoke): token cũ hết hiệu lực ở lần khởi động lại worker kế tiếp'),
    // Đăng ký gồm hai nửa (drop-in + danh sách gốc); còn một nửa nào cũng phải gỡ, nếu không job kiểm học tập đỏ mỗi đêm.
    step('audit', 'root', !trial && (facts.audit?.dropIn || facts.audit?.listed) ? 'pending' : 'skipped', 'Bỏ đăng ký kiểm học tập'),
    step('archive-home', 'root', facts.home.exists ? 'pending' : 'skipped', `Cất home sang ${config.archiveRoot}/${name}-<giờ> (không xoá)`),
  ];
  const expectedRevision = digest(['remove', 1, config, name, steps.map(entry => [entry.id, entry.state]), blocks, existing?.id ?? null, facts.native?.revision ?? null]);
  return { version: 1, action: 'go-nguoi', status: blocks.length ? 'blocked' : steps.some(entry => entry.state === 'pending') ? 'ready' : 'done',
    blocks, assistant: { name, container, home: homeOf(config, name), trial }, steps, expectedRevision, runtimeStatus: 'unverified',
    followUp: ['Người dùng tự thu hồi kết nối CRM ở /settings/hermes (quản trị không thu hồi hộ được).'] };
}

/** Tạo lại sidecar theo ID worker hiện tại. Mặc định mọi sidecar; `only` giới hạn theo tên container. */
export function planRecreate(facts, { only = [] } = {}, config) {
  if (!Array.isArray(only) || only.some(entry => typeof entry !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(entry))) fail('tham_so_sai', 'chi');
  const blocks = [], workerId = facts.worker.id ?? '';
  if (!facts.worker.running) blocks.push('worker_khong_chay');
  const all = facts.containers.filter(view => view.labels[SIDECAR_LABEL] === SIDECAR_VALUE && !retiredContainer(view.name));
  for (const wanted of only) if (!all.some(view => view.name === wanted)) blocks.push('khong_tim_thay');
  // Chạy cho MỌI sidecar mà có container chung network namespace với worker không mang nhãn: nó sẽ bị bỏ sót ⇒ dừng, không báo "xong".
  // Kể cả container không nhãn ĐANG CHẠY mà bám một container không còn tồn tại (worker đã bị thay): nó nằm ở namespace mồ côi.
  const ids = new Set(facts.containers.map(view => view.id));
  const orphan = view => view.running && /^container:[a-f0-9]{64}$/.test(view.networkMode) && !ids.has(view.networkMode.slice('container:'.length));
  if (!only.length && facts.containers.some(view => (view.networkMode === `container:${workerId}` || orphan(view)) && view.labels[SIDECAR_LABEL] !== SIDECAR_VALUE &&
      !retiredContainer(view.name) && view.id !== workerId)) blocks.push('sidecar_khong_nhan');
  const rows = all.filter(view => !only.length || only.includes(view.name)).map(view => {
    const violations = lockViolations(view, config);
    const current = view.running && view.networkMode === `container:${workerId}`;
    // Sidecar đang dừng chỉ được dựng lại khi quản trị nêu đích danh (--chi): tạo lại là làm nó chạy lại.
    const state = current ? 'ok' : adminStopped(view, workerId) && !only.includes(view.name) ? 'stopped' : violations.length ? 'blocked' : 'recreate';
    if (state === 'blocked' && !blocks.includes('sidecar_lech_khoa')) blocks.push('sidecar_lech_khoa');
    return { container: view.name, id: view.id, state, running: view.running, violations };
  }).sort((a, b) => a.container.localeCompare(b.container));
  // Dựng lại một sidecar đang KHÔNG chạy là thêm một container chạy: qua cửa RAM, tính cho từng cái.
  const revived = rows.filter(row => row.state === 'recreate' && !row.running).length;
  if (revived) {
    const gate = memoryGate({ memAvailableMb: facts.memAvailableMb, expectedMb: config.ram.expectedMb * revived, keepFreeMb: config.ram.keepFreeMb });
    if (!gate.ok) blocks.push(gate.code);
  }
  const expectedRevision = digest(['recreate', 1, config, workerId, rows.map(row => [row.container, row.id, row.state]), blocks]);
  return { version: 1, action: 'tao-lai-sidecar', status: blocks.length ? 'blocked' : rows.some(row => row.state === 'recreate') ? 'ready' : 'done',
    blocks, workerId, sidecars: rows, expectedRevision, runtimeStatus: 'unverified' };
}

/** Mỗi trợ lý một dòng: container, RAM, kênh, lần gọi CRM cuối (theo nhật ký connector còn giữ). */
export function listRows(facts) {
  return facts.containers.filter(view => view.labels[SIDECAR_LABEL] === SIDECAR_VALUE && !retiredContainer(view.name)).map(view => {
    const name = view.labels[FLEET_LABELS.name] ?? view.profile ?? view.name, connectionId = view.labels[FLEET_LABELS.connection] ?? null;
    const channel = facts.native?.ok ? facts.native.channels.find(entry => entry.profile === view.profile) : null;
    const usage = facts.usage?.[view.name] ?? null, gateway = facts.gateways?.[view.name] ?? null;
    return { name, container: view.name, managed: Object.hasOwn(view.labels, FLEET_LABELS.name), trial: view.labels[FLEET_LABELS.trial] === 'true',
      running: view.running, currentNetwork: view.networkMode === `container:${facts.worker.id ?? ''}`,
      ramMb: usage?.usedMb ?? null, ramLimitMb: view.memoryMb || null,
      channel: view.labels[FLEET_LABELS.trial] === 'true' ? 'thử (không có kênh)' : channel ? (channel.unissued ? 'đã thu hồi' : 'có') : 'không thấy',
      gateway: gateway?.state ?? null, zalo: gateway?.zalo ?? null,
      connection: connectionId ? `…${connectionTail(connectionId)}` : null,
      lastCrmCall: connectionId ? facts.lastCalls?.[connectionDigest(connectionId)] ?? null : null };
  }).sort((a, b) => a.container.localeCompare(b.container));
}

/** Dọn handoff: quản trị chỉ rõ ID kết nối đã thu hồi (tra SQL chỉ đọc). Từ chối mọi ID mà connector còn nhận mã. */
export function planPrune(facts, { connectionIds }) {
  if (!Array.isArray(connectionIds) || !connectionIds.length || connectionIds.length > 64 || connectionIds.some(id => !uuid(id)) ||
      new Set(connectionIds).size !== connectionIds.length) fail('tham_so_sai', 'connection-id');
  const blocks = [];
  if (!facts.handoff?.ok) blocks.push('khong_doc_duoc_handoff');
  const known = new Set((facts.handoff?.records ?? []).map(row => row.connectionId));
  const rows = connectionIds.map(id => ({ connection: `…${connectionTail(id)}`, present: known.has(id), alive: facts.alive?.[id] ?? null }));
  if (rows.some(row => !row.present)) blocks.push('khong_co_trong_handoff');
  if (rows.some(row => row.alive === true)) blocks.push('ket_noi_con_song');
  if (rows.some(row => row.present && row.alive === null)) blocks.push('khong_kiem_duoc_ket_noi');
  // Kế hoạch bị chặn KHÔNG phát mã ghi: lúc ghi connector đã dừng nên không hỏi lại được mã nào còn sống.
  const expectedRevision = blocks.length ? null : pruneRevision(connectionIds, known);
  return { version: 1, action: 'don-handoff', status: blocks.length ? 'blocked' : 'ready', blocks, total: known.size, selected: rows, expectedRevision,
    note: 'Chỉ nêu ID mà SQL báo ĐÃ THU HỒI: connector từ chối mã (401) cả với kết nối hết hạn còn tự hồi được, cất bản ghi của nó là mất kết nối đó. ' +
      'Ghi thật chỉ chạy khi connector đã dừng sạch (một tiến trình ghi cho mỗi thư mục handoff); bản ghi được CẤT, không xoá.' };
}
/** Mã ghi của `don-handoff` lúc connector đã dừng: chỉ còn danh sách tệp và ID đã chọn để đối chiếu. */
export const pruneRevision = (connectionIds, knownIds) => digest(['prune', 1, [...connectionIds].sort(), [...knownIds].sort()]);

export const BLOCK_TEXT = Object.freeze({
  ten_khong_hop_le: 'Tên không hợp lệ (chữ thường, số, gạch nối; 2–31 ký tự).', connector_khong_co: 'Không có connector tên đó trong cấu hình.',
  thu_khong_duoc_phep: 'Connector này không cho chế độ thử (chỉ connector TEST có `trial: true`).', het_uid: 'Hết UID trong khoảng cấu hình.',
  uid_da_dung: 'UID đã có người dùng.', home_khac_uid: 'Home đã có nhưng thuộc UID khác với --uid.', home_sai_quyen: 'Home đã có nhưng không phải thư mục riêng 0700 của một UID.',
  anh_chua_co: 'Máy chủ chưa có image Hermes ghim trong cấu hình.', khuon_thieu_soul: 'Hồ sơ khuôn không có SOUL.md.', khuon_thieu_khoa: 'Hồ sơ khuôn thiếu khoá dùng chung trong .env.',
  worker_khong_chay: 'Worker Zalo không chạy.', cong_thu_trung_cau_that: 'Cổng kênh thử trùng cổng cầu Zalo thật.',
  worker_khong_native: 'Worker Zalo đang chạy không bật cầu Hermes (--native).',
  khong_toi_duoc_connector: 'Từ network namespace của worker không mở được cổng của connector (mcpUrl): kiểm cửa nội bộ Docker của connector đó đã bật chưa.',
  khong_kiem_duoc_duong_toi_connector: 'Không kiểm được đường từ network namespace của worker tới connector (thiếu nsenter hoặc không đọc được PID của worker).',
  khong_doc_duoc_lien_ket: 'Không đọc được liên kết Zalo từ SQL.', lien_ket_lech_danh_tinh: 'Liên kết Zalo không thuộc đúng trợ lý / người dùng / công ty đã nêu.',
  lien_ket_khong_hoat_dong: 'Liên kết Zalo không ở trạng thái hoạt động (người dùng chưa liên kết hoặc đã ngắt).',
  khong_doc_duoc_cau_hinh_kenh: 'Không đọc được cấu hình kênh của worker.', kenh_lech_danh_tinh: 'Đã có kênh cùng tên nhưng khác nick Zalo.',
  kenh_day: 'Worker đã đủ 100 kênh.',
  nick_zalo_da_co_kenh: 'Nick Zalo này đã có kênh ở hồ sơ khác trên cùng nick bot. Nếu là người đã gỡ trước đây: thêm lại bằng ĐÚNG tên cũ (kênh đã thu hồi được cấp token mới).',
  ten_trung_ho_so_khac: 'Tên này trùng một hồ sơ Hermes đang có ở home khác; chọn tên khác.',
  ten_trung_kenh_that: 'Tên người thử trùng một kênh Zalo thật trong cấu hình worker; chọn tên khác.',
  home_cua_nguoi_thu: 'Home cùng tên đã được gieo mà chưa có kênh Zalo (home của một người thử): gỡ nó trước bằng go-nguoi.',
  kenh_da_thu_hoi_con_home: 'Kênh của tên này đã bị thu hồi mà home cũ vẫn còn: chạy go-nguoi để cất home, rồi thêm lại.',
  container_khac_che_do: 'Container cùng tên thuộc chế độ khác (người thử / người thật): gỡ nó trước bằng go-nguoi.',
  sidecar_khong_nhan: 'Có container chung network namespace với worker mà không mang nhãn com.ihomecrm.component=hermes-sidecar: công cụ sẽ bỏ sót nó khi worker được thay. Gắn nhãn (tạo lại container đó) hoặc gỡ nó trước.',
  khong_doc_duoc_handoff: 'Không đọc được kho mã kết nối của connector.',
  audit_cau_hinh_hong: 'File danh sách gốc của job kiểm học tập (audit.scanConfig) không phải JSON hợp lệ: sửa trước khi thêm người.',
  chua_co_ma_ket_noi: 'Connector không giữ mã của kết nối đang chọn: người dùng tạo kết nối mới rồi bấm "Dùng kết nối này cho trợ lý".',
  ket_noi_khong_song: 'Connector từ chối mã của kết nối đang chọn (hết hạn hoặc đã thu hồi).', khong_kiem_duoc_ket_noi: 'Không hỏi được connector xem kết nối còn sống không.',
  ho_so_la: 'Thư mục hồ sơ đã có .env mà không do công cụ dựng.', sidecar_lech_khoa: 'Có sidecar lệch bộ cờ khoá; công cụ không tạo lại cấu hình lỏng.',
  container_trung_ten: 'Đã có container cùng tên không do công cụ dựng cho người này.', ram_khong_du: 'RAM còn lại không đủ cho thêm một trợ lý.',
  ram_khong_do_duoc: 'Không đo được RAM của máy.', khong_tim_thay: 'Không tìm thấy trợ lý / container đó.',
  khong_phai_cua_cong_cu: 'Thứ này không do công cụ dựng (ví dụ hermes-owner): công cụ không gỡ.',
  khong_co_trong_handoff: 'Có ID không nằm trong kho mã kết nối.', ket_noi_con_song: 'Có kết nối connector còn nhận mã: không dọn.',
});
