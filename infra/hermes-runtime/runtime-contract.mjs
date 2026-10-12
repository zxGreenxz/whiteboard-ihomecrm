import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const HERMES_IMAGE = 'nousresearch/hermes-agent@sha256:32d095e84190ae7266afbb361579e6921f2c633e899f5eacfb88111b9c851a22';
export const HERMES_RELEASE = 'v0.21.6';
export const HERMES_COMMIT = '818c13be1dc4fd28987e1e881a9408224afd4535';
export const RESULT_PREFIX = 'HERMES_RUNTIME_RESULT ';

// Chosen by the trusted host supervisor, never by an actor or model argument.
// Matching a Linux runner's owner permits private bind mounts without chmod/chown.
export function runtimeUser({ platform = process.platform, uid = process.getuid?.(), gid = process.getgid?.() } = {}) {
  if (platform === 'win32') return '10000:10000';
  for (const value of [uid, gid]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error('Fixture requires a non-root numeric UID and GID');
  }
  return `${uid}:${gid}`;
}

export function assertRuntimeUser(user) {
  if (typeof user !== 'string' || !/^[1-9]\d*:[1-9]\d*$/.test(user)) throw new Error('Unsafe runtime user');
  for (const id of user.split(':')) if (Number(id) > 2147483647) throw new Error('Unsafe runtime user');
  return user;
}

export function assertMcpDenial(response, code) {
  if (code === 'unauthorized') {
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: code });
  } else {
    assert.equal(response.status, 200);
    assert.equal(response.body.result?.isError, true);
    assert.deepEqual(response.body.result.content, [{ type: 'text', text: JSON.stringify({ error: code }) }]);
  }
}

export function assertHermesDenial(value, code, observedHttp = []) {
  const result = JSON.parse(value);
  if (code === 'unknown_terminal') assert.deepEqual(result, { error: 'Unknown tool: terminal' });
  else if (code === 'unauthorized') {
    // MCP 2.0 may flatten HTTP rejection into an opaque MCPError. That error
    // alone is not authorization evidence: require the actual call's 401s.
    assert.ok(observedHttp.length > 0, 'Missing HTTP evidence for the revoked Hermes call');
    for (const call of observedHttp) assert.deepEqual(call, { actor: 'a', status: 401 });
    if (result.needs_reauth === true) {
      assert.equal(result.server, 'crm'); assert.match(result.error, /\b401\b/);
    } else assert.deepEqual(result, { error: 'MCP call failed: MCPError: Server returned an error response' });
  } else {
    assert.deepEqual(JSON.parse(result.error), { error: code });
  }
}

export function assertUnavailableTerminal(value) {
  assert.equal(value, "Tool 'terminal' does not exist. Available tools: mcp__crm__crm_auth_context");
}

export async function sourceHashes(root, files) {
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file,
    createHash('sha256').update(await readFile(path.join(root, file))).digest('hex')])));
}

export function assertInputsUnchanged(before, after) {
  assert.deepEqual(after, before, 'Fixture inputs changed while the evidence was being collected');
}

export function assertTaskName(name) {
  if (!/^hermes-p1-[a-z0-9-]{1,40}$/.test(name)) throw new Error('Invalid fixture resource name');
  return name;
}

export function assertInside(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Fixture path must be strictly inside its cache root');
  return path.resolve(candidate);
}

export function runtimeArgs({ name, network, actor, home, bootstrap, source, user = '10000:10000' }) {
  assertTaskName(name);
  assertTaskName(network);
  if (!['a', 'b'].includes(actor)) throw new Error('Unknown fixture actor');
  assertRuntimeUser(user);
  for (const value of [home, bootstrap, source]) {
    if (!path.isAbsolute(value) || value.includes(',')) throw new Error('Fixture mounts must be absolute paths without commas');
  }
  return [
    'run', '--rm', '-i', '--name', name, '--network', network,
    '--label', 'ihome.fixture=hermes-p1', '--user', user,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '1536m', '--cpus', '1',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=134217728',
    '--mount', `type=bind,src=${home},dst=/opt/data`,
    '--mount', `type=bind,src=${bootstrap},dst=/run/bootstrap.json,readonly`,
    '--mount', `type=bind,src=${source},dst=/fixture,readonly`,
    '--env', 'HOME=/opt/data', '--env', 'HERMES_HOME=/opt/data',
    '--env', 'PYTHONDONTWRITEBYTECODE=1', '--env', 'PYTHONUNBUFFERED=1',
    '--env', `FIXTURE_ACTOR=${actor}`, '--workdir', '/opt/hermes',
    '--entrypoint', '/opt/hermes/.venv/bin/python', HERMES_IMAGE,
    '/fixture/runtime-probe.py',
  ];
}

export function assertRuntimeInspection(container, { network, home, bootstrap, source, user = '10000:10000' }) {
  return assertContainerInspection(container, { network, user, expected: new Map([
    ['/opt/data', [home, true]], ['/run/bootstrap.json', [bootstrap, false]], ['/fixture', [source, false]],
  ]) });
}

export function assertFixtureInspection(container, { network, source, brokerSource, output, user }) {
  return assertContainerInspection(container, { network, user, expected: new Map([
    ['/fixture', [source, false]], ['/broker', [brokerSource, false]], ['/output', [output, true]],
  ]) });
}

function assertContainerInspection(container, { network, user, expected }) {
  const cfg = container.HostConfig;
  assertRuntimeUser(user);
  if (!cfg.ReadonlyRootfs || cfg.Privileged || container.Config.User !== user) throw new Error('Unsafe runtime privilege/rootfs');
  if (!cfg.CapDrop?.includes('ALL') || !cfg.SecurityOpt?.includes('no-new-privileges')) throw new Error('Missing process hardening');
  if (cfg.PortBindings && Object.keys(cfg.PortBindings).length) throw new Error('Runtime must not publish ports');
  if (cfg.NetworkMode !== network || Object.keys(container.NetworkSettings.Networks).length !== 1) throw new Error('Unexpected network');
  const mounts = container.Mounts.filter((m) => m.Type !== 'tmpfs');
  if (mounts.length !== expected.size) throw new Error('Unexpected runtime mount count');
  for (const mount of mounts) {
    const match = expected.get(mount.Destination);
    if (!match || mount.Type !== 'bind' || mount.RW !== match[1]) throw new Error('Unexpected runtime mount');
    if (normalizeMountSource(mount.Source) !== normalizeMountSource(match[0])) throw new Error('Unexpected runtime mount source');
  }
  return true;
}

function normalizeMountSource(value) {
  let result = value.replaceAll('\\', '/').replace(/^\/\?\//, '');
  result = result.replace(/^\/(?:run\/desktop\/mnt\/host|host_mnt)\/([a-z])\//i, '$1:/');
  return /^[a-z]:\//i.test(result) ? result.toLowerCase() : result;
}
