#!/usr/bin/env node
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const IMAGE = 'nousresearch/hermes-agent@sha256:a11574b7fe8e1631d7d88d556677dac693bc058abf558cdeb899155688c1bf05';
export const IMAGE_CONFIG = 'sha256:02e7aa0e84123fa0e9b22686e7a2bfb7d85fd59821d4d28812a3e07f3061cf41';
export const NAME = 'ihome-hermes-dashboard';
export const OWNER = 'hermes-owner';
export const WORKER = 'ihome-zalo-worker';
export const PROFILE = '/var/lib/ihome-hermes-profiles/owner';
export const ENV_FILE = '/etc/ihome-hermes/dashboard.env';
export const STATE_FILE = '/var/lib/ihome-hermes-dashboard/container.json';
const LABEL = 'io.ihome.hermes.dashboard';
const OWNER_LABEL = 'io.ihome.hermes.owner-id';
const ID = /^[a-f0-9]{64}$/;
const exec = promisify(execFile);
export class Refusal extends Error {
  constructor(code, exitCode = 78) { super(code); this.exitCode = exitCode; }
}
const requireThat = (ok, code, exitCode) => { if (!ok) throw new Refusal(code, exitCode); };

export function validateTarget(owner, worker, image, namespaces) {
  requireThat(owner?.State?.Running && worker?.State?.Running, 'prerequisite_not_running', 75);
  requireThat(ID.test(owner.Id) && ID.test(worker.Id), 'invalid_container_identity');
  requireThat(owner.Name === `/${OWNER}` && worker.Name === `/${WORKER}`, 'wrong_container_name');
  requireThat(owner.Config?.Image === IMAGE && [image?.Id, IMAGE.split('@')[1]].includes(owner.Image) &&
    [IMAGE_CONFIG, IMAGE.split('@')[1]].includes(image?.Id) &&
    image?.RepoDigests?.includes(IMAGE) && image.Os === 'linux' && image.Architecture === 'amd64', 'image_pin_mismatch');
  requireThat(owner.Config?.User === '10003:10003', 'owner_user_mismatch');
  const mounts = (owner.Mounts ?? []).filter(m => m.Destination === '/home/hermes');
  requireThat(mounts.length === 1 && mounts[0].Type === 'bind' && mounts[0].Source === PROFILE && mounts[0].RW === true, 'owner_profile_mismatch');
  requireThat(owner.HostConfig?.NetworkMode === `container:${worker.Id}` && worker.HostConfig?.NetworkMode === 'bridge', 'owner_network_mismatch');
  requireThat(Number.isSafeInteger(owner.State.Pid) && owner.State.Pid > 1 && Number.isSafeInteger(worker.State.Pid) && worker.State.Pid > 1, 'invalid_namespace_pid');
  requireThat(/^net:\[\d+\]$/.test(namespaces?.owner ?? '') && namespaces.owner === namespaces.worker, 'network_namespace_mismatch', 75);
  return { ownerId: owner.Id, ownerPid: owner.State.Pid, networkNamespace: namespaces.owner };
}

export function createArgs(target) {
  requireThat(ID.test(target?.ownerId), 'invalid_owner_identity');
  return ['create', '--name', NAME,
    '--label', `${LABEL}=owner-v1`, '--label', `${OWNER_LABEL}=${target.ownerId}`,
    '--user', '10003:10003', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
    '--memory=384m', '--memory-swap=384m', '--pids-limit=128',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
    '--tmpfs', '/opt/data:rw,nosuid,nodev,size=16m,uid=10003,gid=10003,mode=0700',
    '--network', `container:${target.ownerId}`, '--pid', `container:${target.ownerId}`,
    '--mount', `type=bind,src=${PROFILE},dst=/home/hermes`,
    '--env-file', ENV_FILE, '--env', 'PYTHONDONTWRITEBYTECODE=1',
    '--env', 'HOME=/home/hermes', '--env', 'HERMES_HOME=/home/hermes/.hermes',
    '--env', 'HERMES_WRITE_SAFE_ROOT=/home/hermes/.hermes',
    '--entrypoint', '/opt/hermes/.venv/bin/hermes', IMAGE,
    '--profile', 'owner', 'dashboard', '--isolated', '--no-open', '--skip-build', '--host', '127.0.0.1', '--port', '9119'];
}

export function validateRecord(record) {
  requireThat(record?.version === 1 && ID.test(record.containerId) && ID.test(record.ownerId) && record.image === IMAGE,
    'invalid_dashboard_record');
  return record;
}

export function validateOwned(container, record) {
  validateRecord(record);
  requireThat(container?.Id === record.containerId && container.Name === `/${NAME}` &&
    container.Config?.Image === IMAGE && container.Config?.Labels?.[LABEL] === 'owner-v1' &&
    container.Config?.Labels?.[OWNER_LABEL] === record.ownerId &&
    container.HostConfig?.NetworkMode === `container:${record.ownerId}` &&
    container.HostConfig?.PidMode === `container:${record.ownerId}`, 'dashboard_ownership_mismatch');
  return container;
}

export function proxyArgs(target) {
  requireThat(Number.isSafeInteger(target?.ownerPid) && target.ownerPid > 1, 'invalid_namespace_pid');
  // Node marks inherited descriptors CLOEXEC. spawn's explicit FD mapping
  // duplicates the listener without that flag; shell exec keeps its PID/FD.
  return ['/bin/sh', '-ec', 'export LISTEN_PID=$$; exec /usr/bin/nsenter --target "$1" --net -- /lib/systemd/systemd-socket-proxyd --connections-max=64 127.0.0.1:9119',
    'hermes-dashboard-proxy', String(target.ownerPid)];
}
export const proxyStdio = () => ['ignore', 'inherit', 'inherit', 3];

export function validatePrivateFile(info) {
  requireThat(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && info.nlink === 1 && (info.mode & 0o777) === 0o600,
    'private_file_permissions');
}

export function validateAuthFile(text) {
  const values = new Map();
  const required = ['HERMES_DASHBOARD_PUBLIC_URL', 'HERMES_DASHBOARD_BASIC_AUTH_USERNAME',
    'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH', 'HERMES_DASHBOARD_BASIC_AUTH_SECRET'];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const at = line.indexOf('='), key = line.slice(0, at), value = line.slice(at + 1);
    requireThat(at > 0 && [...required, 'HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS'].includes(key) && !values.has(key) && value.trim() === value && value.length > 0,
      'invalid_auth_file');
    values.set(key, value);
  }
  requireThat(required.every(key => values.has(key)) && values.get(required[0]) === 'https://crm-hermes.chillhome.io.vn' &&
    /^scrypt\$\d+\$\d+\$\d+\$[^$]+\$[^$]+$/.test(values.get(required[2])) &&
    /^[A-Za-z0-9_-]{43,}$/.test(values.get(required[3])), 'invalid_auth_file');
  if (values.has('HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS')) requireThat(/^\d+$/.test(values.get('HERMES_DASHBOARD_BASIC_AUTH_TTL_SECONDS')), 'invalid_auth_file');
}

async function docker(args, { missing = false } = {}) {
  try { return (await exec('/usr/bin/docker', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    timeout: args[0] === 'stop' ? 35_000 : 15_000 })).stdout.trim(); }
  catch (error) {
    // A daemon/socket failure is not evidence that a recorded container is gone.
    if (missing && /No such (object|container|image)/i.test(error.stderr ?? '')) return null;
    throw new Refusal('docker_operation_failed', 75);
  }
}
async function inspect(id, type = 'container', missing = false) {
  const raw = await docker(['inspect', '--type', type, id], { missing });
  return raw === null ? null : JSON.parse(raw)[0];
}
async function privateRead(filename, optional = false) {
  let info;
  try { info = await fs.lstat(filename); } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new Refusal('private_file_unavailable');
  }
  validatePrivateFile(info);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const held = await handle.stat(); validatePrivateFile(held);
    requireThat(held.dev === info.dev && held.ino === info.ino, 'private_file_changed');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}
async function recordRead() {
  const raw = await privateRead(STATE_FILE, true);
  if (raw === null) return null;
  try { return validateRecord(JSON.parse(raw)); } catch { throw new Refusal('invalid_dashboard_record'); }
}
async function targetRead() {
  const owner = await inspect(OWNER, 'container', true), worker = await inspect(WORKER, 'container', true);
  requireThat(owner?.State?.Running && worker?.State?.Running, 'prerequisite_not_running', 75);
  const image = await inspect(IMAGE, 'image', true);
  requireThat(image, 'pinned_image_not_available', 75);
  const namespaces = { owner: await fs.readlink(`/proc/${owner.State.Pid}/ns/net`), worker: await fs.readlink(`/proc/${worker.State.Pid}/ns/net`) };
  return validateTarget(owner, worker, image, namespaces);
}
async function recordWrite(record) {
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(record)}\n`); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, STATE_FILE);
}
export async function stopOwned() {
  const record = await recordRead();
  if (!record) return;
  let container = await inspect(record.containerId, 'container', true);
  if (container) {
    validateOwned(container, record);
    if (container.State.Running) await docker(['stop', '--time', '30', record.containerId], { missing: true });
    container = await inspect(record.containerId, 'container', true);
    if (container) {
      validateOwned(container, record);
      requireThat(!container.State.Running, 'dashboard_stop_unconfirmed', 75);
      await docker(['rm', record.containerId], { missing: true });
    }
  }
  await fs.unlink(STATE_FILE).catch(error => { if (error.code !== 'ENOENT') throw error; });
}
async function start() {
  let stopping = false, created = false, stopTask;
  const onSignal = () => {
    stopping = true;
    if (created) stopTask ??= stopOwned();
    void stopTask?.catch(() => {});
  };
  process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);
  try {
    // Reconcile only the exact previously recorded, label-verified container.
    // An unrecorded name collision is deliberately never adopted or removed.
    await stopOwned();
    requireThat(!(await inspect(NAME, 'container', true)), 'unrecorded_dashboard_exists');
    validateAuthFile(await privateRead(ENV_FILE));
    const target = await targetRead();
    if (stopping) return;
    const cid = await docker(createArgs(target));
    requireThat(ID.test(cid), 'invalid_created_container_identity');
    const record = { version: 1, containerId: cid, ownerId: target.ownerId, image: IMAGE };
    await recordWrite(record);
    created = true;
    validateOwned(await inspect(cid), record);
    const current = await targetRead();
    requireThat(current.ownerId === target.ownerId && current.ownerPid === target.ownerPid && current.networkNamespace === target.networkNamespace,
      'prerequisite_changed', 75);
    if (!stopping) {
      const attached = spawn('/usr/bin/docker', ['start', '--attach', cid], { stdio: 'ignore' });
      await new Promise((resolve, reject) => { attached.once('error', reject); attached.once('exit', resolve); });
    }
  } finally {
    if (created) await (stopTask ??= stopOwned());
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal);
  }
  // Even exit 0 is unexpected when a shared PID namespace/owner goes away.
  if (!stopping) throw new Refusal('dashboard_exited', 75);
}
async function proxy() {
  requireThat(process.env.LISTEN_FDS === '1' && process.env.LISTEN_PID === String(process.pid), 'systemd_socket_required');
  const target = await targetRead(), record = await recordRead();
  requireThat(record && record.ownerId === target.ownerId, 'dashboard_not_ready', 75);
  const container = validateOwned(await inspect(record.containerId), record);
  requireThat(container.State.Running, 'dashboard_not_ready', 75);
  const args = proxyArgs(target);
  const child = spawn(args[0], args.slice(1), { stdio: proxyStdio() });
  let stopping = false;
  const onTerm = () => { stopping = true; child.kill('SIGTERM'); };
  const onInt = () => { stopping = true; child.kill('SIGINT'); };
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  try {
    await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  } finally {
    process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  }
  if (!stopping) throw new Refusal('dashboard_proxy_exited', 75);
}
export async function main(args) {
  requireThat(process.platform === 'linux' && process.getuid?.() === 0, 'root_linux_required');
  requireThat(args.length === 1 && ['start', 'stop', 'proxy'].includes(args[0]), 'invalid_command');
  if (args[0] === 'start') await start();
  else if (args[0] === 'stop') await stopOwned();
  else await proxy();
}
const isMain = process.argv[1] && await fs.realpath(process.argv[1]).then(value => value === fileURLToPath(import.meta.url), () => false);
if (isMain) {
  main(process.argv.slice(2)).catch(error => {
    // No Docker diagnostics, environment values, tokens, or config contents.
    console.error(error instanceof Refusal ? error.message : 'dashboard_operation_failed');
    process.exitCode = error instanceof Refusal ? error.exitCode : 75;
  });
}
