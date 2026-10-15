import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planNativeGrant, applyNativeGrant, inspectNativeDelivery } from '../../infra/hermes-zalo-native/operator.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = fs.readFileSync(path.join(here, 'zalo-worker.sh'), 'utf8');
const preflight = path.join(here, 'native-preflight.mjs');
const image = `sha256:${'a'.repeat(64)}`;
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const shellPath = value => process.platform === 'win32' ? value.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : value;

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-deploy-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'native-config'), stateRoot = path.join(root, 'native-state');
  const configFile = path.join(configDir, 'config.json'), tokenFile = path.join(configDir, 'alpha.token');
  const log = path.join(root, 'docker.jsonl');
  for (const dir of [configDir, stateRoot, path.join(root, 'sessions')]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'sessions', 'existing-session.json'), 'synthetic-existing-session', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'worker.env'), 'HERMES_ZALO_NATIVE_CONFIG=/unapproved/from-worker-env\n', { mode: 0o600 });
  const create = { action: 'create', configFile, profile: 'alpha', accountId: '11111111-1111-4111-8111-111111111111',
    ownUid: '100', pairedUid: '200', tokenFile, stateRoot, listenPort: 8991 };
  applyNativeGrant({ ...create, expect: planNativeGrant(create).expectedRevision });

  // Only route the fixed installation root to a disposable fixture. The fake
  // Docker transport executes the real preflight, without a daemon or network.
  assert.equal(launcher.split('ROOT=/opt/ihome-zalo-worker').length, 2);
  const script = path.join(root, 'zalo-worker.sh');
  fs.writeFileSync(script, launcher.replace('ROOT=/opt/ihome-zalo-worker', `ROOT='${shellPath(root)}'`).replaceAll('\r\n', '\n'));
  const dockerStub = path.join(root, 'docker.mjs');
  fs.writeFileSync(dockerStub, `
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NATIVE_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'image') { if (process.env.NATIVE_TEST_IMAGE_MISSING) process.exit(1); console.log(${JSON.stringify(image)}); }
else if (args[0] === 'container') { process.exit(0); }
else if (args[0] === 'stop') { process.exit(Number(process.env.NATIVE_TEST_STOP_FAILURE || 0)); }
else if (args[0] === 'run' && args.includes('--rm')) {
  if (process.env.NATIVE_TEST_PREFLIGHT_MISSING) process.exit(1);
  const index = args.indexOf(${JSON.stringify(image)});
  if (index < 0 || args[index + 1] !== '/app/deploy/native-preflight.mjs') process.exit(9);
  const nativePath = value => value.replace(${JSON.stringify(shellPath(root))}, ${JSON.stringify(root)});
  if (process.env.NATIVE_TEST_WRONG_UID) process.getuid = () => Number(process.env.NATIVE_TEST_WRONG_UID);
  if (process.env.NATIVE_TEST_WRONG_GID) process.getgid = () => Number(process.env.NATIVE_TEST_WRONG_GID);
  try {
    const { validateNativeDeployment } = await import(${JSON.stringify(pathToFileURL(preflight).href)});
    validateNativeDeployment(...args.slice(index + 2).map(nativePath));
  } catch { console.error('native_deployment_preflight_failed'); process.exit(2); }
} else if (args[0] === 'run') { console.log('fixture-container-id'); }
else if (args[0] !== 'rm') { process.exit(9); }
`);
  const shellEnv = path.join(root, 'fixture.bash');
  // install's owner change belongs to Docker/VPS integration, outside this
  // unprivileged fixture. The real native validator uses this process principal.
  // Bash reads functions from BASH_ENV, so /tmp can remain mounted noexec.
  fs.writeFileSync(shellEnv, 'docker() { "$NATIVE_TEST_NODE" -- "$NATIVE_TEST_DOCKER" "$@"; }\ninstall() { mkdir -p "${@: -1}"; }\n');
  const run = (args = ['run', 'fixture:selected', '--native'], extraEnv = {}) => {
    fs.writeFileSync(log, '');
    const result = spawnSync(bash, [shellPath(script), ...args], { encoding: 'utf8', env: {
      ...process.env, BASH_ENV: shellPath(shellEnv),
      MSYS2_ARG_CONV_EXCL: '*', NATIVE_TEST_NODE: process.execPath, NATIVE_TEST_DOCKER: dockerStub,
      NATIVE_TEST_LOG: log, ...extraEnv,
    } });
    assert.ifError(result.error);
    return { ...result, calls: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  };
  const edit = change => { const document = JSON.parse(fs.readFileSync(configFile, 'utf8')); change(document); fs.writeFileSync(configFile, JSON.stringify(document)); };
  return { root, configDir, stateRoot, configFile, tokenFile, create, run, edit };
}
const stopped = result => result.calls.some(call => ['stop', 'rm'].includes(call[0]));
const runtimeCall = result => result.calls.find(call => call[0] === 'run' && call.includes('-d'));
function failedBeforeStop(result) {
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(stopped(result), false, JSON.stringify(result.calls));
  assert.equal(runtimeCall(result), undefined);
}

test('opt-in validates the selected immutable image before replacing the one existing worker', t => {
  const f = fixture(t), before = fs.readdirSync(f.stateRoot), result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const check = result.calls.find(call => call[0] === 'run' && call.includes('--rm'));
  const run = runtimeCall(result);
  for (const args of [check, run]) {
    assert.ok(args.includes(image));
    assert.equal(args[args.indexOf('--user') + 1], '10002:10002');
    assert.ok(args.includes('--read-only'));
    assert.ok(args.includes(`type=bind,source=${shellPath(f.configDir)},target=${shellPath(f.configDir)},readonly`));
    assert.ok(args.includes(`type=bind,source=${shellPath(f.stateRoot)},target=${shellPath(f.stateRoot)}`));
    assert.ok(!args.some(arg => /^(--publish|-p|--network=host)$/.test(arg)));
  }
  assert.equal(check[check.indexOf('--network') + 1], 'none');
  assert.ok(!check.includes('--env-file'));
  assert.ok(!check.some(arg => arg.includes('/sessions')));
  assert.equal(check[check.indexOf('--entrypoint') + 1], 'node');
  assert.ok(result.calls.indexOf(check) < result.calls.findIndex(call => call[0] === 'stop'));
  assert.ok(run.includes(`HERMES_ZALO_NATIVE_CONFIG=${shellPath(f.configFile)}`));
  assert.equal(run[run.indexOf('--stop-timeout') + 1], '-1');
  assert.deepEqual(result.calls.find(call => call[0] === 'stop'), ['stop', '--time', '-1', 'ihome-zalo-worker']);
  assert.deepEqual(fs.readdirSync(f.stateRoot), before);
  assert.equal(fs.readFileSync(path.join(f.root, 'sessions', 'existing-session.json'), 'utf8'), 'synthetic-existing-session');
  assert.equal(inspectNativeDelivery({ configFile: f.configFile }).runtimeStatus, 'unverified');
});

test('disabled mode overrides worker.env and cannot silently enable native transport', t => {
  const f = fixture(t), result = f.run(['run', 'fixture:selected']);
  assert.equal(result.status, 0, result.stderr);
  const run = runtimeCall(result);
  assert.ok(run.includes('HERMES_ZALO_NATIVE_CONFIG='));
  assert.ok(run.indexOf('HERMES_ZALO_NATIVE_CONFIG=') > run.indexOf('--env-file'));
  assert.ok(!run.some(arg => arg.includes('/native-config') || arg.includes('/native-state')));
  assert.equal(result.calls.filter(call => call[0] === 'run').length, 1);
  failedBeforeStop(f.run(['run', 'fixture:selected', '--native-typo']));
});

for (const [name, mutate] of [
  ['missing config', f => fs.unlinkSync(f.configFile)],
  ['malformed config', f => fs.writeFileSync(f.configFile, '{broken')],
  ['missing state', f => fs.rmSync(f.stateRoot, { recursive: true })],
  ['missing token', f => fs.unlinkSync(f.tokenFile)],
  ['invalid token', f => fs.writeFileSync(f.tokenFile, 'not-a-channel-token')],
  ['unknown schema property', f => f.edit(value => { value.unapproved = true; })],
  ['invalid paired identity', f => f.edit(value => { value.channels[0].mainUid = '999'; })],
  ['duplicate channel', f => f.edit(value => { value.channels.push({ ...value.channels[0] }); })],
  ['mismatched state mount', f => { const other = path.join(f.root, 'other-state'); fs.mkdirSync(other, { mode: 0o700 }); f.edit(value => { value.stateRoot = other; }); }],
  ['token outside private mount', f => { const other = path.join(f.root, 'other-tokens'); fs.mkdirSync(other, { mode: 0o700 }); const token = path.join(other, 'alpha.token'); fs.copyFileSync(f.tokenFile, token); fs.chmodSync(token, 0o600); f.edit(value => { value.channels[0].tokenFile = token; }); }],
  ['hardlinked token', f => fs.linkSync(f.tokenFile, path.join(f.configDir, 'alias.token'))],
]) test(`${name} leaves the existing worker running`, t => {
  const f = fixture(t); mutate(f); const result = f.run(); failedBeforeStop(result);
  assert.match(result.stderr, /native_deployment_(preflight_failed|directory_invalid)/);
});

test('Linux owner and mode checks run through the real validator before stop', { skip: process.platform === 'win32' && 'Windows does not attest Linux owner/mode' }, t => {
  const f = fixture(t);
  for (const [file, valid, invalid] of [[f.configDir, 0o700, 0o755], [f.stateRoot, 0o700, 0o750], [f.configFile, 0o600, 0o644], [f.tokenFile, 0o600, 0o640]]) {
    fs.chmodSync(file, invalid); failedBeforeStop(f.run()); fs.chmodSync(file, valid);
  }
  // Emulate a different container principal without chown/sudo in CI. The
  // production module still reads real lstat uid/gid; only its caller differs.
  failedBeforeStop(f.run(undefined, { NATIVE_TEST_WRONG_UID: String(process.getuid() + 1) }));
  failedBeforeStop(f.run(undefined, { NATIVE_TEST_WRONG_GID: String(process.getgid() + 1) }));
  const replacement = `${f.configDir}-real`;
  fs.renameSync(f.configDir, replacement); fs.symlinkSync(replacement, f.configDir, 'dir');
  failedBeforeStop(f.run());
});

test('create, rotate and revoke keep canonical operator paths and preflight never exports tokens', t => {
  const f = fixture(t), original = JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
  for (const action of ['create', 'rotate', 'revoke']) {
    if (action !== 'create') {
      const options = { action, configFile: f.configFile, profile: 'alpha',
        ...(action === 'rotate' ? { tokenFile: path.join(f.configDir, 'rotated.token') } : {}) };
      applyNativeGrant({ ...options, expect: planNativeGrant(options).expectedRevision });
    }
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr + JSON.stringify(result.calls), /hzn_[a-f0-9]{64}/);
    assert.equal(inspectNativeDelivery({ configFile: f.configFile }).channels[0].profile, 'alpha');
    assert.equal(JSON.parse(fs.readFileSync(f.configFile, 'utf8')).channels[0].generation, original.channels[0].generation);
  }
});

test('interrupted/failed drain never removes or starts a replacement', t => {
  const f = fixture(t), result = f.run(undefined, { NATIVE_TEST_STOP_FAILURE: '130' });
  assert.notEqual(result.status, 0);
  assert.ok(result.calls.some(call => call[0] === 'stop'));
  assert.ok(!result.calls.some(call => call[0] === 'rm'));
  assert.equal(runtimeCall(result), undefined);
  const stop = f.run(['stop']); assert.equal(stop.status, 0, stop.stderr);
  assert.deepEqual(stop.calls, [['stop', '--time', '-1', 'ihome-zalo-worker']]);
});

test('missing image or preflight entrypoint cannot stop the running worker', t => {
  const f = fixture(t);
  failedBeforeStop(f.run(undefined, { NATIVE_TEST_IMAGE_MISSING: '1' }));
  failedBeforeStop(f.run(undefined, { NATIVE_TEST_PREFLIGHT_MISSING: '1' }));
});

test('preflight CLI returns a redacted nonzero failure without config arguments', () => {
  const result = spawnSync(process.execPath, [preflight], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'native_deployment_preflight_failed');
});
