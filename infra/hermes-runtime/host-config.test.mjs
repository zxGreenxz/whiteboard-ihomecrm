import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadHostConfiguration } from './host-config.mjs';

const ref = 'abcdefghijklmnopqrst';
const refused = error => { assert.equal(error.message, 'host_config_invalid'); assert.equal(Object.hasOwn(error, 'cause'), false); return true; };
async function fixture(t) {
  const original = await mkdtemp(path.join(os.tmpdir(), 'hcfg-')), root = await realpath(original);
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = path.join(root, 's'), configPath = path.join(root, 'host.json'), passwordFile = path.join(root, 'password'), keyFile = path.join(root, 'key');
  await mkdir(stateRoot, { mode: 0o700 });
  await writeFile(passwordFile, 'fixture-password-0123456789', { mode: 0o600 }); await writeFile(keyFile, Buffer.alloc(32, 17), { mode: 0o600 });
  const input = { version: 2, mode: 'connector', supabase: { url: `https://${ref}.supabase.co`, publishableKey: 'sb_publishable_synthetic' },
    store: { projectRef: ref, host: `db.${ref}.supabase.co`, role: 'hermes_store_fixture', passwordFile },
    encryption: { activeKeyVersion: 'one', keys: [{ version: 'one', file: keyFile }] },
    http: { allowedHosts: ['crm.example.test', '127.0.0.1:8740'], allowedOrigins: ['https://crm.example.test'] },
    stateRoot, listenPort: 8740 };
  const save = async (value = input) => writeFile(configPath, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await save();
  return { root, stateRoot, input, configPath, passwordFile, keyFile, save };
}

test('private file loader returns exact factory inputs, fixed uncreated subdirs and independently disposable key bytes', async t => {
  const f = await fixture(t), config = await loadHostConfiguration(f.configPath);
  try {
    assert.deepEqual(Object.keys(config).sort(), ['supabase', 'store', 'encryption', 'http', 'paths', 'mode', 'limits', 'listenPort', 'dispose'].sort());
    assert.equal(config.store.password, 'fixture-password-0123456789'); assert.equal(config.store.projectRef, ref);
    assert.equal(Object.hasOwn(config.store, 'passwordFile'), false);
    assert.deepEqual({ ...config.paths }, { stateRoot: f.stateRoot, handoffDirectory: path.join(f.stateRoot, 'handoff') });
    assert.equal(config.mode, 'connector'); assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.paths));
    assert.deepEqual(await readdir(f.stateRoot), []); assert.deepEqual(config.encryption.keys.get('one'), Buffer.alloc(32, 17));
    const key = config.encryption.keys.get('one'); config.dispose(); config.dispose(); assert.equal(config.encryption.keys.size, 0); assert.ok(key.every(byte => byte === 0));
    assert.deepEqual(await readFile(f.keyFile), Buffer.alloc(32, 17));
  } finally { config.dispose(); }
});

test('loader accepts bounded explicit rotation and CA with matching session-pooler principal', async t => {
  const f = await fixture(t), next = path.join(f.root, 'key-two'), ca = path.join(f.root, 'ca');
  await writeFile(next, Buffer.alloc(32, 23), { mode: 0o600 }); await writeFile(ca, '-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n', { mode: 0o600 });
  f.input.store.host = 'aws-0-synthetic.pooler.supabase.com'; f.input.store.caFile = ca;
  f.input.encryption.keys.push({ version: 'two', file: next }); f.input.encryption.activeKeyVersion = 'two'; await f.save();
  const config = await loadHostConfiguration(f.configPath); assert.equal(config.encryption.keys.size, 2); assert.equal(config.encryption.activeKeyVersion, 'two');
  assert.ok(config.store.ca.startsWith('-----BEGIN CERTIFICATE-----')); config.dispose();
});

test('connector config needs no model or personal profile and rejects the removed managed (version 1) shape', async t => {
  const f = await fixture(t), input = structuredClone(f.input);
  const config = await loadHostConfiguration(f.configPath);
  try {
    assert.equal(config.mode, 'connector'); assert.equal(Object.hasOwn(config, 'model'), false);
    assert.deepEqual(await readdir(f.stateRoot), []); assert.equal(config.listenPort, 8740);
  } finally { config.dispose(); }
  const model = { model: 'openai:fixture-model', maxTokens: 1024, maxIterations: 4 };
  for (const change of [x => { x.model = model; }, x => { x.mode = 'managed'; }, x => { delete x.mode; }, x => { x.version = 1; },
    x => { x.version = 1; delete x.mode; x.model = model; }]) {
    const invalid = structuredClone(input); change(invalid); await f.save(invalid);
    await assert.rejects(loadHostConfiguration(f.configPath), refused);
  }
});

test('connector limits default safely, accept bounded overrides and reject unknown or unsafe values', async t => {
  const f = await fixture(t), input = structuredClone(f.input);
  let config = await loadHostConfiguration(f.configPath);
  try {
    assert.deepEqual({ ...config.limits }, { requestsPerMinute: 60, toolCallsPerMinute: 30, callTimeoutMs: 20_000, maintenanceWaitMs: 5000 });
    assert.ok(Object.isFrozen(config.limits));
  } finally { config.dispose(); }
  await f.save({ ...input, limits: { toolCallsPerMinute: 12, maintenanceWaitMs: 0 } });
  config = await loadHostConfiguration(f.configPath);
  try { assert.deepEqual({ ...config.limits }, { requestsPerMinute: 60, toolCallsPerMinute: 12, callTimeoutMs: 20_000, maintenanceWaitMs: 0 }); }
  finally { config.dispose(); }
  await f.save({ ...input, limits: { callTimeoutMs: 25_000, maintenanceWaitMs: 0 } });
  config = await loadHostConfiguration(f.configPath);
  try { assert.equal(config.limits.callTimeoutMs + config.limits.maintenanceWaitMs, 25_000); } finally { config.dispose(); }
  // Wait + deadline above 25 s would outlive the 30 s MCP client / 35 s idle socket.
  for (const limits of [{ callTimeoutMs: 20_001 }, { callTimeoutMs: 16_000, maintenanceWaitMs: 10_000 }, { callTimeoutMs: 30_000, maintenanceWaitMs: 0 },
    { toolCallsPerMinute: 0 }, { toolCallsPerMinute: 61 }, { requestsPerMinute: 601, toolCallsPerMinute: 30 },
    { callTimeoutMs: 999 }, { callTimeoutMs: 30_001 }, { maintenanceWaitMs: 10_001 }, { maintenanceWaitMs: -1 },
    { toolCallsPerMinute: 1.5 }, { toolCallsPerMinute: '30' }, { burst: 5 }, []]) {
    await f.save({ ...input, limits }); await assert.rejects(loadHostConfiguration(f.configPath), refused);
  }
});

test('inline secrets, extra/foreign fields, project mismatch, unsafe role/URL and listen port reject before secret loading', async t => {
  const f = await fixture(t), cases = [
    x => { x.password = 'inline'; }, x => { x.store.password = 'inline'; }, x => { x.encryption.keys[0].secret = 'inline'; },
    x => { x.store.host = 'attacker.test'; }, x => { x.store.role = 'postgres'; }, x => { x.store.role = 'hermes_store_executor'; },
    x => { x.supabase.url = 'https://zyxwvutsrqponmlkjihg.supabase.co'; }, x => { x.supabase.url += '?override=1'; },
    x => { x.supabase.publishableKey = 'service_role_secret'; }, x => { x.listenPort = 0; }, x => { x.listenPort = 65536; }, x => { x.version = 3; },
  ];
  for (const change of cases) { const value = structuredClone(f.input); change(value); await f.save(value); await assert.rejects(loadHostConfiguration(f.configPath), refused); }
});

test('HTTP authorities/origins match canonical backend rules with no credentials, paths or duplicates', async t => {
  const f = await fixture(t);
  for (const http of [{ allowedHosts: [], allowedOrigins: [] }, { allowedHosts: ['crm.test/path'], allowedOrigins: [] },
    { allowedHosts: ['user:pass@crm.test'], allowedOrigins: [] }, { allowedHosts: ['crm.test', 'crm.test'], allowedOrigins: [] },
    { allowedHosts: ['crm.test'], allowedOrigins: ['https://crm.test/path'] }, { allowedHosts: ['crm.test'], allowedOrigins: ['https://crm.test/'] }]) {
    await f.save({ ...f.input, http }); await assert.rejects(loadHostConfiguration(f.configPath), refused);
  }
});

test('config rejects duplicate decoded keys, malformed UTF8, deep nesting and oversized file without leaking content', async t => {
  const f = await fixture(t), json = JSON.stringify(f.input);
  for (const bytes of [json.replace('"version":2', '"version":2,"version":2'), json.replace('"version":2', '"version":2,"\\u0076ersion":2'),
    Buffer.from([0xc0, 0xaf]), '['.repeat(18) + '0' + ']'.repeat(18), ' '.repeat(32769)]) {
    await writeFile(f.configPath, bytes); await assert.rejects(loadHostConfiguration(f.configPath), refused);
  }
});

test('key refs are raw32 private files, bounded unique versions with an active member and no fallback', async t => {
  const f = await fixture(t);
  for (const encryption of [{ activeKeyVersion: 'missing', keys: f.input.encryption.keys }, { activeKeyVersion: 'one', keys: [] },
    { activeKeyVersion: 'one', keys: [f.input.encryption.keys[0], f.input.encryption.keys[0]] },
    { activeKeyVersion: '0', keys: Array.from({ length: 17 }, (_, i) => ({ version: String(i), file: f.keyFile })) }]) {
    await f.save({ ...f.input, encryption }); await assert.rejects(loadHostConfiguration(f.configPath), refused);
  }
  await f.save();
  for (const bytes of [Buffer.alloc(31), Buffer.alloc(33), Buffer.from(Buffer.alloc(32).toString('base64'))]) {
    await writeFile(f.keyFile, bytes); await assert.rejects(loadHostConfiguration(f.configPath), refused);
  }
  await rm(f.keyFile); await assert.rejects(loadHostConfiguration(f.configPath), refused);
});

test('a later key-load failure zeroes already-read original key buffers before rejecting', async t => {
  const f = await fixture(t), captured = [], original = Buffer.from;
  f.input.encryption.keys.push({ version: 'two', file: path.join(f.root, 'missing-key') }); await f.save();
  Buffer.from = function (...args) {
    const output = Reflect.apply(original, Buffer, args);
    if (output.length === 32 && output.every(byte => byte === 17)) captured.push(output);
    return output;
  };
  try { await assert.rejects(loadHostConfiguration(f.configPath), refused); }
  finally { Buffer.from = original; }
  assert.ok(captured.length > 0); assert.ok(captured.every(bytes => bytes.every(byte => byte === 0)));
});

test('password/CA are bounded strict UTF8 private files, no trimming or inline/default substitution', async t => {
  const f = await fixture(t);
  for (const bytes of ['short', 'fixture-password-0123456789\n', 'x'.repeat(4097), Buffer.from([0xc0, 0xaf])]) {
    await writeFile(f.passwordFile, bytes); await assert.rejects(loadHostConfiguration(f.configPath), refused);
  }
  await writeFile(f.passwordFile, 'fixture-password-0123456789'); const caFile = path.join(f.root, 'ca'); f.input.store.caFile = caFile; await f.save();
  for (const bytes of ['not-a-certificate', 'x'.repeat(65537)]) { await writeFile(caFile, bytes, { mode: 0o600 }); await assert.rejects(loadHostConfiguration(f.configPath), refused); }
});

test('state root must preexist and config/secret files cannot reside below the WAL root', async t => {
  const f = await fixture(t);
  await f.save({ ...f.input, stateRoot: path.join(f.root, 'absent') }); await assert.rejects(loadHostConfiguration(f.configPath), refused); await assert.rejects(lstat(path.join(f.root, 'absent')), { code: 'ENOENT' });
  for (const subdir of ['handoff']) {
    const dir = path.join(f.stateRoot, subdir); await mkdir(dir, { mode: 0o700 });
    const keyFile = path.join(dir, 'key'); await writeFile(keyFile, Buffer.alloc(32, 1), { mode: 0o600 });
    const input = structuredClone(f.input); input.encryption.keys[0].file = keyFile; await f.save(input); await assert.rejects(loadHostConfiguration(f.configPath), refused);
    input.encryption.keys[0].file = f.keyFile; input.store.passwordFile = keyFile; await f.save(input); await assert.rejects(loadHostConfiguration(f.configPath), refused);
  }
});

test('relative refs and symlinked existing directories or secret files are rejected', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); f.input.encryption.keys[0].file = 'relative'; await f.save(); await assert.rejects(loadHostConfiguration(f.configPath), refused);
  f.input.encryption.keys[0].file = f.keyFile; await f.save();
  const link = path.join(f.root, 'key-link'); await symlink(f.keyFile, link); f.input.encryption.keys[0].file = link; await f.save(); await assert.rejects(loadHostConfiguration(f.configPath), refused);
  f.input.encryption.keys[0].file = f.keyFile; await f.save(); await symlink(f.root, path.join(f.stateRoot, 'handoff'), 'dir'); await assert.rejects(loadHostConfiguration(f.configPath), refused);
});

test('Linux requires private config/secret modes, trusted root and existing subdir modes', { skip: process.platform !== 'linux' }, async t => {
  const f = await fixture(t);
  for (const [target, invalid, valid] of [[f.configPath, 0o640, 0o600], [f.passwordFile, 0o644, 0o600], [f.keyFile, 0o640, 0o600], [f.stateRoot, 0o750, 0o700]]) {
    await chmod(target, invalid); await assert.rejects(loadHostConfiguration(f.configPath), refused); await chmod(target, valid);
  }
  const handoff = path.join(f.stateRoot, 'handoff'); await mkdir(handoff, { mode: 0o750 }); await assert.rejects(loadHostConfiguration(f.configPath), refused);
});
