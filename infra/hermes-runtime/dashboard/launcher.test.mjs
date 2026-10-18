import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { IMAGE, IMAGE_CONFIG, PROFILE, ENV_FILE, createArgs, validateTarget, validateOwned, validateAuthFile, validatePrivateFile, proxyArgs, proxyStdio } from './launcher.mjs';

const ownerId = 'a'.repeat(64), workerId = 'b'.repeat(64), containerId = 'c'.repeat(64);
function fixture() {
  return {
    owner: { Id: ownerId, Name: '/hermes-owner', Image: IMAGE_CONFIG, Config: { Image: IMAGE, User: '10003:10003' },
      State: { Running: true, Pid: 1200 }, HostConfig: { NetworkMode: `container:${workerId}` },
      Mounts: [{ Type: 'bind', Source: PROFILE, Destination: '/home/hermes', RW: true }] },
    worker: { Id: workerId, Name: '/ihome-zalo-worker', State: { Running: true, Pid: 1100 }, HostConfig: { NetworkMode: 'bridge' } },
    image: { Id: IMAGE_CONFIG, RepoDigests: [IMAGE], Os: 'linux', Architecture: 'amd64' },
    namespaces: { owner: 'net:[2222]', worker: 'net:[2222]' },
  };
}
const validate = f => validateTarget(f.owner, f.worker, f.image, f.namespaces);
function ownedFixture() {
  const record = { version: 1, containerId, ownerId, image: IMAGE };
  const container = { Id: containerId, Name: '/ihome-hermes-dashboard', Config: { Image: IMAGE,
    Labels: { 'io.ihome.hermes.dashboard': 'owner-v1', 'io.ihome.hermes.owner-id': ownerId } },
  HostConfig: { NetworkMode: `container:${ownerId}`, PidMode: `container:${ownerId}` } };
  return { record, container };
}
test('dashboard joins verified owner namespaces with private bind and bounded resources', () => {
  const args = createArgs(validate(fixture()));
  assert.equal(args[args.indexOf('--network') + 1], `container:${ownerId}`);
  assert.equal(args[args.indexOf('--pid') + 1], `container:${ownerId}`);
  assert.equal(args[args.indexOf('--env-file') + 1], ENV_FILE);
  assert.equal(args[args.indexOf('--entrypoint') + 1], '/opt/hermes/.venv/bin/hermes');
  assert.ok(args.includes('HERMES_WRITE_SAFE_ROOT=/home/hermes/.hermes'));
  assert.equal(args[args.indexOf('--mount') + 1], `type=bind,src=${PROFILE},dst=/home/hermes`);
  for (const value of ['--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--memory=384m', '--memory-swap=384m', '--pids-limit=128']) assert.ok(args.includes(value));
  assert.ok(args.includes(IMAGE));
  assert.deepEqual(args.slice(-10), ['--profile', 'owner', 'dashboard', '--isolated', '--no-open', '--skip-build', '--host', '127.0.0.1', '--port', '9119']);
  assert.ok(!args.some(arg => /0\.0\.0\.0|docker\.sock|--privileged|--publish|PASSWORD_HASH=|AUTH_SECRET=/.test(arg)));
});
test('target mutations reject wrong profile, image, user, namespace and absent prerequisites', () => {
  const mutations = [f => { f.owner.Config.Image = 'nousresearch/hermes-agent:latest'; },
    f => { f.image.RepoDigests = []; }, f => { f.image.Architecture = 'arm64'; }, f => { f.image.Id = 'sha256:wrong'; },
    f => { f.owner.Config.User = '0:0'; }, f => { f.owner.Mounts[0].Source += '/another'; },
    f => { f.owner.Mounts[0].RW = false; }, f => { f.owner.HostConfig.NetworkMode = 'host'; },
    f => { f.worker.Name = '/unrelated'; }, f => { f.namespaces.worker = 'net:[9999]'; }];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => validate(f)); }
  const stopped = fixture(); stopped.owner.State.Running = false;
  assert.throws(() => validate(stopped), error => error.exitCode === 75);
  const contentStore = fixture(); contentStore.owner.Image = IMAGE.split('@')[1];
  assert.equal(validate(contentStore).ownerId, ownerId);
});
test('stop authorization is tied to recorded CID, exact labels, image and namespaces', () => {
  const good = ownedFixture(); assert.equal(validateOwned(good.container, good.record), good.container);
  for (const mutate of [f => { f.container.Id = 'd'.repeat(64); }, f => { f.container.Config.Labels = {}; },
    f => { f.container.Config.Image += '-wrong'; }, f => { f.container.HostConfig.PidMode = 'host'; },
    f => { f.record.ownerId = workerId; }]) {
    const f = ownedFixture(); mutate(f); assert.throws(() => validateOwned(f.container, f.record));
  }
});
test('proxy duplicates the systemd listener and replaces LISTEN_PID for its live namespace child', () => {
  const f = fixture(); f.owner.State.Pid = 9911;
  assert.deepEqual(proxyArgs(validate(f)), ['/bin/sh', '-ec',
    'export LISTEN_PID=$$; exec /usr/bin/nsenter --target "$1" --net -- /lib/systemd/systemd-socket-proxyd --connections-max=64 127.0.0.1:9119',
    'hermes-dashboard-proxy', '9911']);
  assert.deepEqual(proxyStdio(), ['ignore', 'inherit', 'inherit', 3]);
  assert.throws(() => proxyArgs({ ownerPid: 0 }));
  assert.throws(() => proxyArgs({ ownerPid: '9911; arbitrary-command' }));
});
test('auth env requires hashed credentials and rejects unrelated inherited flags', () => {
  const auth = ['HERMES_DASHBOARD_PUBLIC_URL=https://crm-hermes.chillhome.io.vn',
    'HERMES_DASHBOARD_BASIC_AUTH_USERNAME=fixture', 'HERMES_DASHBOARD_BASIC_AUTH_PASSWORD_HASH=scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    `HERMES_DASHBOARD_BASIC_AUTH_SECRET=${'x'.repeat(43)}`].join('\n');
  validateAuthFile(auth);
  for (const text of [auth + '\nHERMES_DESKTOP=1', auth.replace('https://crm-hermes', 'http://crm-hermes'),
    auth.replace('PASSWORD_HASH=scrypt$16384$8$1$c2FsdA==$aGFzaA==', 'PASSWORD=plaintext'), auth + '\n' + auth.split('\n')[0]]) assert.throws(() => validateAuthFile(text));
  const info = { isFile: () => true, isSymbolicLink: () => false, uid: 0, nlink: 1, mode: 0o100600 };
  validatePrivateFile(info);
  for (const change of [{ uid: 10003 }, { nlink: 2 }, { mode: 0o100644 }, { isSymbolicLink: () => true }]) assert.throws(() => validatePrivateFile({ ...info, ...change }));
});
test('systemd stop and restart propagate to the loopback socket and namespace proxy', async () => {
  const load = name => readFile(new URL(name, import.meta.url), 'utf8');
  const [service, socket, proxy] = await Promise.all(['hermes-dashboard.service', 'hermes-dashboard-proxy.socket', 'hermes-dashboard-proxy.service'].map(load));
  assert.match(service, /ExecStop=.*launcher\.mjs stop/);
  assert.match(service, /Restart=on-failure/); assert.match(service, /RestartPreventExitStatus=78/);
  assert.match(service, /StateDirectory=ihome-hermes-dashboard/);
  assert.match(service, /WorkingDirectory=\/opt\/ihome-hermes-dashboard\/current/);
  for (const unit of [service, proxy]) {
    assert.match(unit, /ExecStart=\/opt\/ihome-hermes\/node\/bin\/node \/opt\/ihome-hermes-dashboard\/current\/launcher\.mjs/);
    assert.ok(!unit.includes('/opt/ihome-hermes/current'));
  }
  assert.match(service, /ExecStop=.*\/opt\/ihome-hermes-dashboard\/current\/launcher\.mjs stop/);
  for (const unit of [socket, proxy]) { assert.match(unit, /PartOf=hermes-dashboard\.service/); assert.match(unit, /BindsTo=hermes-dashboard\.service/); }
  assert.match(socket, /ListenStream=127\.0\.0\.1:19119/);
  assert.match(proxy, /launcher\.mjs proxy/);
});
