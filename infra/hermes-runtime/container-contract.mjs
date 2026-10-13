import assert from 'node:assert/strict';
import path from 'node:path';
import { HERMES_IMAGE, NO_FORWARDING, PRIVATE_DNS, DNS_OPTIONS, assertIsolatedNetwork } from './runtime-contract.mjs';

export const GATEWAY_URLS = Object.freeze({ mcpUrl: 'http://hermes-gateway:8787/mcp', modelBaseUrl: 'http://hermes-gateway:8787/v1' });
export const RUNTIME_ENV = Object.freeze({ HOME: '/tmp', HERMES_HOME: '/opt/data', PYTHONDONTWRITEBYTECODE: '1',
  PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PATH: '/opt/hermes/.venv/bin:/usr/local/bin:/usr/bin:/bin' });
export const RUNTIME_TMPFS = Object.freeze({ '/tmp': 'rw,nosuid,nodev,noexec,size=134217728' });
export const idPattern = /^[a-f0-9]{64}$/;
export const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const resourcePattern = /^[a-z0-9][a-z0-9_.-]{0,79}$/;
export function dataSnapshot(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== names.length) throw Error('invalid_object');
  return Object.freeze(Object.fromEntries(names.map(name => {
    const field = Object.getOwnPropertyDescriptor(value, name);
    if (!field || !Object.hasOwn(field, 'value') || field.value === undefined) throw Error('invalid_object');
    return [name, field.value];
  })));
}
export function validateGatewayDescriptor(raw) {
  const value = dataSnapshot(raw, ['networkName', 'networkId', 'mcpUrl', 'modelBaseUrl']);
  if (typeof value.networkName !== 'string' || !resourcePattern.test(value.networkName) || typeof value.networkId !== 'string' ||
      !idPattern.test(value.networkId) || value.mcpUrl !== GATEWAY_URLS.mcpUrl || value.modelBaseUrl !== GATEWAY_URLS.modelBaseUrl) throw Error('invalid_gateway');
  return value;
}
export function validateRuntimeUser(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,8}:[1-9][0-9]{0,8}$/.test(value)) throw Error('invalid_runtime_user');
}
const mountPath = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[,\0\r\n]/.test(value)) throw Error('invalid_mount');
};
export function buildContainerArgs(spec) {
  if (!uuidPattern.test(spec.instanceId) || spec.name !== `ihome-hermes-runtime-${spec.instanceId}` || !resourcePattern.test(spec.networkName)) throw Error('invalid_resource');
  validateRuntimeUser(spec.user);
  [spec.home, spec.wrapper, spec.bootstrap].forEach(mountPath);
  return ['create', '--interactive', '--name', spec.name, '--network', spec.networkName, '--platform', 'linux/amd64',
    '--label', `ihome.hermes.instance=${spec.instanceId}`, '--label', 'ihome.hermes.role=runtime', '--user', spec.user,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none',
    '--dns', PRIVATE_DNS[0], ...DNS_OPTIONS.flatMap(value => ['--dns-option', value]),
    ...Object.entries(NO_FORWARDING).flatMap(([key, value]) => ['--sysctl', `${key}=${value}`]),
    '--pids-limit', '256', '--memory', '1536m', '--cpus', '1',
    ...Object.entries(RUNTIME_TMPFS).flatMap(([key, value]) => ['--tmpfs', `${key}:${value}`]),
    '--mount', `type=bind,src=${spec.home},dst=/opt/data`,
    '--mount', `type=bind,src=${spec.bootstrap},dst=/run/bootstrap.json,readonly`,
    '--mount', `type=bind,src=${spec.wrapper},dst=/run/agent-process.py,readonly`,
    ...Object.entries(RUNTIME_ENV).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    '--workdir', '/opt/hermes', '--entrypoint', '/opt/hermes/.venv/bin/python', HERMES_IMAGE,
    '/run/agent-process.py', '/run/bootstrap.json'];
}
export function validateNetworkInspection(network, descriptor) {
  assertIsolatedNetwork(network);
  assert.equal(network.Id, descriptor.networkId); assert.equal(network.Name, descriptor.networkName);
}
const canonical = value => path.resolve(value).replaceAll('\\', '/').replace(/^([A-Z]):/, (_, letter) => `${letter.toLowerCase()}:`);
export function validateContainerInspection(container, spec, image) {
  assert.equal(container.Id, spec.containerId); assert.equal(container.Name, `/${spec.name}`);
  assert.equal(container.Image, image.Id); assert.equal(container.Config.Image, HERMES_IMAGE);
  assert.equal(container.Config.Labels?.['ihome.hermes.instance'], spec.instanceId);
  assert.equal(container.Config.Labels?.['ihome.hermes.role'], 'runtime');
  assert.equal(container.Config.User, spec.user); assert.equal(container.Config.OpenStdin, true); assert.equal(container.Config.Tty, false);
  assert.deepEqual(container.Config.Entrypoint, ['/opt/hermes/.venv/bin/python']);
  assert.deepEqual(container.Config.Cmd, ['/run/agent-process.py', '/run/bootstrap.json']); assert.equal(container.Config.WorkingDir, '/opt/hermes');
  const cfg = container.HostConfig;
  assert.equal(cfg.ReadonlyRootfs, true); assert.equal(cfg.Privileged, false); assert.deepEqual(cfg.CapDrop, ['ALL']);
  assert.deepEqual(cfg.CapAdd ?? [], []); assert.deepEqual(cfg.SecurityOpt, ['no-new-privileges']);
  assert.equal(cfg.LogConfig?.Type, 'none'); assert.equal(cfg.NetworkMode, spec.networkName);
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks), [spec.networkName]);
  assert.equal(container.NetworkSettings.Networks[spec.networkName].NetworkID, spec.networkId);
  assert.deepEqual(cfg.PortBindings ?? {}, {}); assert.equal(cfg.PublishAllPorts, false);
  assert.deepEqual(cfg.Sysctls, NO_FORWARDING); assert.deepEqual(cfg.Dns, PRIVATE_DNS); assert.deepEqual(cfg.DnsOptions, DNS_OPTIONS);
  assert.deepEqual(cfg.Tmpfs, RUNTIME_TMPFS); assert.equal(cfg.PidsLimit, 256); assert.equal(cfg.Memory, 1536 * 1024 * 1024); assert.equal(cfg.NanoCpus, 1_000_000_000);
  assert.equal(cfg.RestartPolicy?.Name, 'no'); assert.equal(cfg.AutoRemove, false);
  for (const key of ['PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode']) {
    assert.notEqual(cfg[key], 'host', `Host namespace forbidden: ${key}`);
  }
  assert.deepEqual(cfg.Devices ?? [], []); assert.deepEqual(cfg.DeviceRequests ?? [], []); assert.deepEqual(cfg.ExtraHosts ?? [], []);
  const expected = new Map([['/opt/data', [spec.home, true]], ['/run/bootstrap.json', [spec.bootstrap, false]], ['/run/agent-process.py', [spec.wrapper, false]]]);
  const mounts = container.Mounts.filter(value => value.Type !== 'tmpfs'); assert.equal(mounts.length, expected.size);
  for (const item of mounts) {
    const expectedMount = expected.get(item.Destination); assert.ok(expectedMount); assert.equal(item.Type, 'bind');
    assert.equal(item.RW, expectedMount[1]); assert.equal(canonical(item.Source), canonical(expectedMount[0]));
    assert.ok(item.Propagation === undefined || item.Propagation === 'rprivate');
  }
  for (const item of container.Mounts.filter(value => value.Type === 'tmpfs')) assert.ok(Object.hasOwn(RUNTIME_TMPFS, item.Destination));
  // The pinned image's inherited environment is data, never host process.env.
  // Every actual entry must exactly match that image plus the explicit overrides.
  const envMap = values => {
    assert.ok(Array.isArray(values)); const result = new Map();
    for (const item of values) { assert.equal(typeof item, 'string'); const index = item.indexOf('='); assert.ok(index > 0);
      const key = item.slice(0, index); assert.ok(!result.has(key)); result.set(key, item.slice(index + 1)); }
    return result;
  };
  const expectedEnv = envMap(image.Config.Env ?? []);
  for (const [key, value] of Object.entries(RUNTIME_ENV)) expectedEnv.set(key, value);
  assert.deepEqual(envMap(container.Config.Env), expectedEnv);
  for (const key of expectedEnv.keys()) assert.ok(!/(?:TOKEN|SECRET|PASSWORD|API_KEY|PROXY|CREDENTIAL)/i.test(key), 'Credential/proxy environment forbidden');
}
