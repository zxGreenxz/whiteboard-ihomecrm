import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const HERMES_IMAGE = 'nousresearch/hermes-agent@sha256:ffa4fbb471c2bc8c85fbcfc629347585cc1586c86d2e6db465d01203ce696d95';
export const HERMES_RELEASE = 'v0.21.6';
export const HERMES_COMMIT = '818c13be1dc4fd28987e1e881a9408224afd4535';
const HERMES_TAG_OBJECT = 'f27cdbce5ab63eafe8633b293a75151409da5769';
const REGISTRY_MANIFESTS = 'https://registry-1.docker.io/v2/nousresearch/hermes-agent/manifests/';
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const sha256 = raw => `sha256:${createHash('sha256').update(raw).digest('hex')}`;

// Offline verification of the reviewed upstream receipt and content-addressed
// manifest chain. This is NOT a signed attestation or reproducible-build proof.
// The mutable Docker :v0.21.6 tag was an older attempt, not this release receipt.
export function assertImageProvenance(artifact) {
  assert.equal(artifact?.schemaVersion, 1); assert.equal(artifact.kind, 'unsigned_release_receipt');
  assert.equal(artifact.repositoryUrl, 'https://github.com/NousResearch/hermes-agent');
  assert.equal(artifact.releaseUrl, `https://github.com/NousResearch/hermes-agent/releases/tag/${HERMES_RELEASE}`);
  assert.equal(artifact.tag?.objectSha, HERMES_TAG_OBJECT);
  assert.equal(artifact.tag.apiUrl, `https://api.github.com/repos/NousResearch/hermes-agent/git/tags/${HERMES_TAG_OBJECT}`);
  assert.equal(artifact.tag.signatureVerified, false); assert.equal(artifact.tag.commit, HERMES_COMMIT);
  assert.equal(typeof artifact.tag.raw, 'string'); assert.ok(Buffer.byteLength(artifact.tag.raw) <= 16_384);
  assert.equal(createHash('sha1').update(`tag ${Buffer.byteLength(artifact.tag.raw)}\0`).update(artifact.tag.raw).digest('hex'), HERMES_TAG_OBJECT,
    'Annotated tag bytes differ from the reviewed Git object');
  const tagSplit = artifact.tag.raw.indexOf('\n\n'); assert.ok(tagSplit > 0);
  const tagHeaders = artifact.tag.raw.slice(0, tagSplit).split('\n');
  assert.equal(tagHeaders[0], `object ${HERMES_COMMIT}`); assert.equal(tagHeaders[1], 'type commit');
  assert.equal(tagHeaders[2], `tag ${HERMES_RELEASE}`);
  assert.equal(typeof artifact.tag.receiptMessage, 'string'); assert.ok(artifact.tag.receiptMessage.length <= 8192);
  assert.equal(artifact.tag.receiptMessage, artifact.tag.raw.slice(tagSplit + 2));
  assert.deepEqual(JSON.parse(artifact.tag.receiptMessage), artifact.releaseReceipt);
  const receipt = artifact.releaseReceipt;
  assert.equal(receipt.schema, 1); assert.equal(receipt.commit, HERMES_COMMIT);
  assert.equal(`v${receipt.version}`, HERMES_RELEASE); assert.match(receipt.dockerManifestDigest, DIGEST);
  const parseManifest = (value, expected) => {
    assert.equal(value?.digest, expected); assert.equal(value.url, `${REGISTRY_MANIFESTS}${expected}`);
    assert.equal(typeof value.raw, 'string'); assert.ok(Buffer.byteLength(value.raw) > 0 && Buffer.byteLength(value.raw) <= 100_000);
    assert.equal(sha256(value.raw), expected, 'Manifest bytes do not match the reviewed digest');
    const result = JSON.parse(value.raw); assert.equal(result.schemaVersion, 2); return result;
  };
  const index = parseManifest(artifact.index, receipt.dockerManifestDigest);
  assert.equal(index.mediaType, 'application/vnd.docker.distribution.manifest.list.v2+json');
  assert.ok(Array.isArray(index.manifests));
  const members = index.manifests.filter(value => value.platform?.os === 'linux' && value.platform?.architecture === 'amd64');
  assert.equal(members.length, 1, 'Expected exactly one Linux amd64 release member');
  const digest = HERMES_IMAGE.split('@')[1];
  assert.equal(members[0].digest, digest, 'Pinned image is not the release receipt platform member');
  assert.equal(members[0].mediaType, 'application/vnd.docker.distribution.manifest.v2+json');
  const manifest = parseManifest(artifact.platformManifest, digest);
  assert.equal(members[0].size, Buffer.byteLength(artifact.platformManifest.raw));
  assert.equal(manifest.mediaType, members[0].mediaType);
  assert.match(artifact.expectedConfigDigest, DIGEST); assert.equal(manifest.config?.digest, artifact.expectedConfigDigest);
  assert.equal(manifest.config.mediaType, 'application/vnd.docker.container.image.v1+json');
  return { kind: 'unsigned_release_receipt', artifactVerified: true, signatureVerified: false,
    sourceCommit: HERMES_COMMIT, release: HERMES_RELEASE, tagObjectSha: HERMES_TAG_OBJECT,
    releaseIndexDigest: receipt.dockerManifestDigest, platformManifestDigest: digest,
    expectedConfigDigest: artifact.expectedConfigDigest, imageInspectionVerified: false, revisionLabelVerified: false };
}

export function assertPinnedImageInspection(image, artifact) {
  const provenance = assertImageProvenance(artifact);
  assert.equal(image?.Id, provenance.expectedConfigDigest, 'Image config differs from release manifest');
  assert.ok(Array.isArray(image.RepoDigests) && image.RepoDigests.includes(HERMES_IMAGE), 'Missing pinned image RepoDigest');
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, 'amd64');
  const revision = image.Config?.Labels?.['org.opencontainers.image.revision'];
  if (revision !== undefined && revision !== null) assert.equal(revision, HERMES_COMMIT, 'Image revision differs from pinned source');
  return { ...provenance, imageInspectionVerified: true, revisionLabelVerified: revision === HERMES_COMMIT };
}
export const RESULT_PREFIX = 'HERMES_RUNTIME_RESULT ';
export const NO_FORWARDING = Object.freeze({ 'net.ipv4.ip_forward': '0', 'net.ipv6.conf.all.forwarding': '0' });
export const PRIVATE_DNS = Object.freeze(['127.0.0.1']);
export const DNS_OPTIONS = Object.freeze(['timeout:1', 'attempts:1']);
// Engine 28+: internal alone retains a host bridge address; isolated removes it.
// https://docs.docker.com/engine/network/port-publishing/#gateway-modes
export const ISOLATED_GATEWAY_OPTIONS = Object.freeze({
  'com.docker.network.bridge.gateway_mode_ipv4': 'isolated',
  'com.docker.network.bridge.gateway_mode_ipv6': 'isolated',
});

export function isolatedNetworkArgs(name, subnet6) {
  assertTaskName(name);
  if (typeof subnet6 !== 'string' || !/^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}:[123]::\/64$/.test(subnet6)) throw new Error('Invalid fixture IPv6 subnet');
  return ['network', 'create', '--internal', '--ipv6', '--subnet', subnet6,
    '--label', 'ihome.fixture=hermes-p1', ...Object.entries(ISOLATED_GATEWAY_OPTIONS).flatMap(([key, value]) => ['--opt', `${key}=${value}`]), name];
}

export function assertIsolatedNetwork(network) {
  assert.equal(network.Driver, 'bridge'); assert.equal(network.Internal, true); assert.equal(network.EnableIPv6, true);
  for (const [key, value] of Object.entries(ISOLATED_GATEWAY_OPTIONS)) assert.equal(network.Options?.[key], value);
  assert.ok(network.IPAM?.Config?.some(value => value.Subnet?.includes(':')), 'Missing IPv6 fixture subnet');
  assert.ok(network.IPAM?.Config?.some(value => value.Subnet?.includes('.')), 'Missing IPv4 fixture subnet');
}

export function assertEgressProof(result, reachable) {
  assert.deepEqual(Object.keys(result).sort(), ['external4', 'external6', 'host4', 'host6', 'systemDns',
    'tcpDns4', 'tcpDns6', 'udpDns4', 'udpDns6'].sort());
  for (const [key, value] of Object.entries(result)) {
    const field = key === 'systemDns' ? 'resolved' : key.includes('Dns') ? 'answered' : 'connected';
    assert.deepEqual(value, { [field]: reachable, verified: reachable }, `Unexpected egress evidence: ${key}`);
  }
}

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
  assertUnavailableTool(value, 'terminal');
}

export function assertUnavailableTool(value, name) {
  assert.ok(['terminal', 'browser_navigate', 'web_extract'].includes(name));
  assert.equal(value, `Tool '${name}' does not exist. Available tools: mcp__crm__crm_auth_context`);
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
    '--dns', PRIVATE_DNS[0], ...DNS_OPTIONS.flatMap(option => ['--dns-option', option]),
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--sysctl', 'net.ipv4.ip_forward=0', '--sysctl', 'net.ipv6.conf.all.forwarding=0',
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
  return assertContainerInspection(container, { networks: [network], user, tmpfs: {
    '/tmp': 'rw,nosuid,nodev,noexec,size=134217728',
  }, expected: new Map([
    ['/opt/data', [home, true]], ['/run/bootstrap.json', [bootstrap, false]], ['/fixture', [source, false]],
  ]) });
}

export function assertFixtureInspection(container, { networks, source, brokerSource, output, user }) {
  if (!Array.isArray(networks) || networks.length !== 2 || networks[0] === networks[1]) throw new Error('Fixture requires distinct actor networks');
  return assertContainerInspection(container, { networks, user, tmpfs: {
    '/tmp': 'rw,nosuid,nodev,noexec,size=67108864',
    '/opt/data': 'ro,nosuid,nodev,noexec,size=1048576',
  }, expected: new Map([
    ['/fixture', [source, false]], ['/broker', [brokerSource, false]], ['/output', [output, true]],
  ]) });
}

function assertContainerInspection(container, { networks, user, tmpfs, expected }) {
  const cfg = container.HostConfig;
  assertRuntimeUser(user);
  if (!cfg.ReadonlyRootfs || cfg.Privileged || container.Config.User !== user) throw new Error('Unsafe runtime privilege/rootfs');
  if (!cfg.CapDrop?.includes('ALL') || !cfg.SecurityOpt?.includes('no-new-privileges')) throw new Error('Missing process hardening');
  if (cfg.PortBindings && Object.keys(cfg.PortBindings).length) throw new Error('Runtime must not publish ports');
  for (const network of networks) assertTaskName(network);
  if (cfg.NetworkMode !== networks[0]) throw new Error('Unexpected primary network');
  assert.deepEqual(Object.keys(container.NetworkSettings.Networks).sort(), [...networks].sort(), 'Unexpected attached networks');
  assert.deepEqual(cfg.Sysctls, NO_FORWARDING, 'Container must not route between networks');
  assert.deepEqual(cfg.Dns, PRIVATE_DNS, 'Runtime must not inherit host/external DNS');
  assert.deepEqual(cfg.DnsOptions, DNS_OPTIONS, 'Unexpected DNS retry/deadline options');
  assert.deepEqual(cfg.Tmpfs, tmpfs, 'Unexpected runtime tmpfs');
  for (const mount of container.Mounts.filter((m) => m.Type === 'tmpfs')) {
    if (!Object.hasOwn(tmpfs, mount.Destination)) throw new Error('Unexpected tmpfs mount');
  }
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
