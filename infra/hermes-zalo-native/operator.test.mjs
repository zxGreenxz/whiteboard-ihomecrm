import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planNativeGrant, applyNativeGrant, inspectNativeDelivery, runNativeOperator } from './operator.mjs';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';
import { createNativeBridge } from '../../worker/lib/hermes-native-bridge.js';
import { createNativeJournal, nativeDigest } from '../../worker/lib/hermes-native-journal.js';

const accountId = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-operator-')));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const configFile = path.join(root, 'config.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateRoot, configFile };
}
function createOptions(f, profile = 'alpha', pairedUid = '200') {
  return { action: 'create', configFile: f.configFile, profile, accountId, ownUid: '100', pairedUid,
    tokenFile: path.join(f.root, `${profile}.token`), ...(!fs.existsSync(f.configFile) ? { stateRoot: f.stateRoot, listenPort: 8991 } : {}) };
}
function apply(options) { return applyNativeGrant({ ...options, expect: planNativeGrant(options).expectedRevision }); }
const config = f => JSON.parse(fs.readFileSync(f.configFile, 'utf8'));
const tree = root => fs.readdirSync(root, { recursive: true }).sort().map(name => {
  const file = path.join(root, name), info = fs.statSync(file);
  return [name, info.mode, info.isFile() ? fs.readFileSync(file).toString('hex') : null];
});
const request = (url, token, route, body = {}) => fetch(url + route, { method: 'POST', headers: {
  Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('create preview is read-only; apply uses the real worker config and private token files', t => {
  const f = fixture(t), options = createOptions(f), before = tree(f.root);
  const preview = planNativeGrant(options);
  assert.deepEqual(tree(f.root), before);
  assert.equal(preview.diskStatus, 'planned');
  assert.equal(preview.runtimeStatus, 'unverified');
  const result = applyNativeGrant({ ...options, expect: preview.expectedRevision });
  assert.equal(result.activation, 'pending_controlled_worker_restart');
  const runtime = readNativeConfig(f.configFile);
  assert.equal(runtime.channels[0].profile, 'alpha');
  assert.match(runtime.channels[0].token, /^hzn_[a-f0-9]{64}$/);
  assert.equal(runtime.channels[0].mainUid, '200');
  assert.ok(!JSON.stringify(result).includes(runtime.channels[0].token));
  assert.equal(fs.statSync(options.tokenFile).nlink, 1);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(options.tokenFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.configFile).mode & 0o777, 0o600);
  }
});

test('rotate and revoke preserve every binding/generation, other users, old secrets and unknown journals', t => {
  const f = fixture(t); apply(createOptions(f)); apply(createOptions(f, 'beta', '300'));
  const before = config(f), channel = readNativeConfig(f.configFile).channels[0];
  const oldToken = fs.readFileSync(before.channels[0].tokenFile, 'utf8');
  const journal = createNativeJournal(f.stateRoot, channel);
  journal.update('outbound', 'unknown-1', { id: 'unknown-1', digest: nativeDigest('fixture message'), status: 'outcome_unknown', startedAt: 10 });
  const journalsBefore = tree(f.stateRoot);
  apply({ action: 'rotate', configFile: f.configFile, profile: 'alpha', tokenFile: path.join(f.root, 'rotated.token') });
  assert.deepEqual(config(f).channels[1], before.channels[1]);
  const { tokenFile: _a, ...a } = config(f).channels[0], { tokenFile: _b, ...b } = before.channels[0];
  assert.deepEqual(a, b);
  assert.notEqual(readNativeConfig(f.configFile).channels[0].token, channel.token);
  const revoke = apply({ action: 'revoke', configFile: f.configFile, profile: 'alpha' });
  assert.equal(revoke.credential, 'replaced_with_unissued_secret');
  assert.equal(config(f).channels.length, 2);
  assert.equal(config(f).channels[0].generation, channel.generation);
  assert.deepEqual(config(f).channels[1], before.channels[1]);
  assert.deepEqual(tree(f.stateRoot), journalsBefore);
  assert.equal(fs.readFileSync(before.channels[0].tokenFile, 'utf8'), oldToken);
  assert.equal(inspectNativeDelivery({ configFile: f.configFile, profile: 'alpha' }).channels[0].quarantine, 'outcome_unknown');
  assert.throws(() => planNativeGrant({ ...createOptions(f), tokenFile: path.join(f.root, 'recreate.token') }), /profile_conflict/);
  assert.throws(() => planNativeGrant({ ...createOptions(f, 'gamma'), tokenFile: path.join(f.root, 'duplicate-peer.token') }), /native_channel/);
});

test('revision CAS, cooperative lock and exclusive token destination reject stale or destructive changes', t => {
  const f = fixture(t); apply(createOptions(f));
  const options = { action: 'rotate', configFile: f.configFile, profile: 'alpha', tokenFile: path.join(f.root, 'new.token') };
  const expected = planNativeGrant(options).expectedRevision;
  fs.appendFileSync(f.configFile, '\n');
  const changed = tree(f.root);
  assert.throws(() => applyNativeGrant({ ...options, expect: expected }), /config_changed/);
  assert.deepEqual(tree(f.root), changed);
  const fresh = planNativeGrant(options).expectedRevision;
  fs.writeFileSync(config(f).channels[0].tokenFile, `hzn_${'b'.repeat(64)}`);
  assert.throws(() => applyNativeGrant({ ...options, expect: fresh }), /config_changed/);
  const lock = `${f.configFile}.operator-lock`; fs.mkdirSync(lock, { mode: 0o700 });
  assert.throws(() => applyNativeGrant({ ...options, expect: planNativeGrant(options).expectedRevision }), /locked/);
  assert.equal(fs.existsSync(lock), true); fs.rmdirSync(lock);
  assert.throws(() => planNativeGrant({ ...options, tokenFile: config(f).channels[0].tokenFile }), /token_file_exists/);
  assert.throws(() => planNativeGrant({ ...options, tokenFile: path.join(f.stateRoot, 'journal-collision.json') }), /reserved_path/);
  assert.throws(() => applyNativeGrant({ ...options, tokenFile: path.join(lock, 'locked.token'), expect: planNativeGrant(options).expectedRevision }), /reserved_path/);
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => applyNativeGrant(options), /expected_revision_required/);
});

test('inspect reports queued, sent and unknown receipts without exposing message text or mutating files', t => {
  const f = fixture(t); apply(createOptions(f));
  const channel = readNativeConfig(f.configFile).channels[0], journal = createNativeJournal(f.stateRoot, channel);
  const id = nativeDigest([channel.accountId, channel.generation, channel.pairedUid, 'm1']);
  const text = 'private fixture message';
  journal.admit(id, { id, digest: nativeDigest(['m1', 1, text]), messageId: 'm1', sentAt: 1, senderUid: '200', text, status: 'queued' });
  journal.update('outbound', 'sent-1', { id: 'sent-1', digest: nativeDigest('a'), status: 'sent', startedAt: 1, finishedAt: 2, messageId: '42' });
  journal.update('outbound', 'unknown-1', { id: 'unknown-1', digest: nativeDigest('b'), status: 'outcome_unknown', startedAt: 3 });
  const before = tree(f.root), result = inspectNativeDelivery({ configFile: f.configFile });
  assert.deepEqual(tree(f.root), before);
  assert.deepEqual(result.channels[0].outbound.counts, { sent: 1, outcome_unknown: 1 });
  assert.equal(result.channels[0].inbound.counts.queued, 1);
  assert.equal(result.channels[0].quarantine, 'outcome_unknown');
  assert.equal(result.runtimeStatus, 'unverified');
  assert.equal(result.recoverySupported, false);
  assert.ok(!JSON.stringify(result).includes(text));
  assert.ok(!JSON.stringify(result).includes(channel.token));
  assert.equal(inspectNativeDelivery({ configFile: f.configFile, limit: 0 }).channels[0].outbound.records.length, 0);
  fs.rmSync(f.stateRoot, { recursive: true });
  assert.throws(() => inspectNativeDelivery({ configFile: f.configFile }));
  assert.equal(fs.existsSync(f.stateRoot), false, 'read-only inspection cannot recreate missing state');
});

test('CLI uses configured path, redacts credentials, and offers no recovery or generation override', t => {
  const f = fixture(t); apply(createOptions(f));
  const oldEnv = process.env.HERMES_ZALO_NATIVE_CONFIG; process.env.HERMES_ZALO_NATIVE_CONFIG = f.configFile;
  t.after(() => { if (oldEnv === undefined) delete process.env.HERMES_ZALO_NATIVE_CONFIG; else process.env.HERMES_ZALO_NATIVE_CONFIG = oldEnv; });
  let stdout = '', stderr = '';
  const sink = { write: value => { stdout += value; }, error: value => { stderr += value; } };
  assert.equal(runNativeOperator(['inspect'], sink), 0);
  assert.equal(JSON.parse(stdout).configFile, f.configFile);
  for (const command of [['recover'], ['clear-unknown'], ['rotate', '--profile', 'alpha', '--generation', 'arbitrary'], ['inspect', '--apply'], ['revoke', '--profile', 'alpha', '--token', 'hzn_secret']]) {
    assert.equal(runNativeOperator(command, sink), 1);
  }
  assert.ok(!stderr.includes('hzn_secret'));
  stdout = '';
  const pathWithSecret = path.join(f.root, `hzn_${'f'.repeat(64)}`);
  assert.equal(runNativeOperator(['rotate', '--profile', 'alpha', '--token-file', pathWithSecret], sink), 0);
  assert.ok(!stdout.includes('hzn_'));
  assert.equal(fs.existsSync(pathWithSecret), false);
});

test('disk rotation/revoke take effect only on controlled restart; unknown quarantine survives both', async t => {
  const f = fixture(t); apply(createOptions(f));
  const original = readNativeConfig(f.configFile), old = original.channels[0];
  let bridge = createNativeBridge({ config: original }); let url = await bridge.listen(0);
  t.after(async () => { await bridge.close(); });
  const mutation = apply({ action: 'rotate', configFile: f.configFile, profile: 'alpha', tokenFile: path.join(f.root, 'new.token') });
  const rotated = readNativeConfig(f.configFile).channels[0];
  assert.equal(mutation.liveRevocationVerified, false);
  assert.equal((await request(url, old.token, '/v1/channel')).status, 200);
  assert.equal((await request(url, rotated.token, '/v1/channel')).status, 401);
  await bridge.close();
  let sends = 0;
  const journal = createNativeJournal(f.stateRoot, old);
  journal.update('outbound', 'uncertain', { id: 'uncertain', digest: nativeDigest('old message'), status: 'outcome_unknown', startedAt: 1 });
  bridge = createNativeBridge({ config: readNativeConfig(f.configFile) }); url = await bridge.listen(0);
  bridge.attach({ accountId, ownUid: '100', isActive: () => true, api: { sendMessage: async () => { sends++; return { message: { msgId: 1 }, attachment: [] }; } } });
  assert.equal((await request(url, old.token, '/v1/channel')).status, 401);
  assert.equal((await request(url, rotated.token, '/v1/channel')).status, 200);
  const blocked = await request(url, rotated.token, '/v1/send', { generation: old.generation, requestId: 'new-id', text: 'new content' });
  assert.equal((await blocked.json()).status, 'outcome_unknown');
  assert.equal(sends, 0);
  apply({ action: 'revoke', configFile: f.configFile, profile: 'alpha' });
  assert.equal((await request(url, rotated.token, '/v1/channel')).status, 200);
  await bridge.close();
  bridge = createNativeBridge({ config: readNativeConfig(f.configFile) }); url = await bridge.listen(0);
  assert.equal((await request(url, rotated.token, '/v1/channel')).status, 401);
  assert.equal(inspectNativeDelivery({ configFile: f.configFile }).channels[0].quarantine, 'outcome_unknown');
});

test('private file guards reject hardlinks without changing them', t => {
  const f = fixture(t); apply(createOptions(f));
  const options = { action: 'rotate', configFile: f.configFile, profile: 'alpha', tokenFile: path.join(f.root, 'next.token') };
  const tokenFile = config(f).channels[0].tokenFile, hardlink = path.join(f.root, 'hardlink');
  fs.linkSync(tokenFile, hardlink);
  assert.throws(() => planNativeGrant(options), /native/); fs.unlinkSync(hardlink);
});

test('Linux rejects unsafe file/directory modes and symlink paths without fixing them', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t); apply(createOptions(f));
  const options = { action: 'rotate', configFile: f.configFile, profile: 'alpha', tokenFile: path.join(f.root, 'next.token') };
  const tokenFile = config(f).channels[0].tokenFile;
  fs.chmodSync(tokenFile, 0o644);
  assert.throws(() => planNativeGrant(options), /native/);
  assert.equal(fs.statSync(tokenFile).mode & 0o777, 0o644); fs.chmodSync(tokenFile, 0o600);
  fs.chmodSync(f.root, 0o755);
  assert.throws(() => planNativeGrant(options), /native/);
  fs.chmodSync(f.root, 0o700);
  const link = path.join(f.root, 'linked'); fs.symlinkSync(f.root, link);
  assert.throws(() => planNativeGrant({ ...options, tokenFile: path.join(link, 'new.token') }), /native/);
  assert.throws(() => inspectNativeDelivery({ configFile: path.join(link, 'config.json') }), /native/);
});

test('state ownership blocks bootstrap with an existing unknown journal and copied config paths', async t => {
  const f = fixture(t); apply(createOptions(f));
  const original = readNativeConfig(f.configFile), channel = original.channels[0];
  const journal = createNativeJournal(f.stateRoot, channel);
  journal.update('outbound', 'uncertain', { id: 'uncertain', digest: nativeDigest('old content'), status: 'outcome_unknown', startedAt: 1 });
  const replacement = { ...createOptions(f), configFile: path.join(f.root, 'replacement.json'), tokenFile: path.join(f.root, 'replacement.token'),
    stateRoot: f.stateRoot, listenPort: 8991 };
  const before = tree(f.root);
  assert.throws(() => planNativeGrant(replacement), /state_namespace|state_owner/);
  assert.throws(() => applyNativeGrant({ ...replacement, expect: 'a'.repeat(64) }), /state_namespace|state_owner/);
  assert.deepEqual(tree(f.root), before);
  assert.equal(fs.existsSync(replacement.configFile), false);
  const copy = path.join(f.root, 'copied.json'); fs.copyFileSync(f.configFile, copy);
  assert.throws(() => planNativeGrant({ action: 'rotate', configFile: copy, profile: 'alpha', tokenFile: replacement.tokenFile }), /state_owner/);
  assert.throws(() => inspectNativeDelivery({ configFile: copy }), /state_owner/);
  assert.equal(inspectNativeDelivery({ configFile: f.configFile }).channels[0].quarantine, 'outcome_unknown');
  const bridge = createNativeBridge({ config: original }); const url = await bridge.listen(0);
  let calls = 0;
  bridge.attach({ accountId, ownUid: '100', isActive: () => true, api: { sendMessage: async () => { calls++; return { message: { msgId: 1 }, attachment: [] }; } } });
  try {
    const response = await request(url, channel.token, '/v1/send', { generation: channel.generation, requestId: 'retry-new-id', text: 'old content' });
    assert.equal((await response.json()).status, 'outcome_unknown'); assert.equal(calls, 0);
  } finally { await bridge.close(); }
  fs.unlinkSync(f.configFile);
  assert.throws(() => planNativeGrant({ ...replacement, configFile: f.configFile }), /state_namespace|state_owner/);
});

test('orphan journal blocks recreating a removed profile while another grant remains', t => {
  const f = fixture(t); apply(createOptions(f)); apply(createOptions(f, 'beta', '300'));
  const alpha = readNativeConfig(f.configFile).channels[0];
  createNativeJournal(f.stateRoot, alpha).update('outbound', 'uncertain', { id: 'uncertain', digest: nativeDigest('old content'), status: 'outcome_unknown', startedAt: 1 });
  const altered = config(f); altered.channels = altered.channels.filter(c => c.profile !== 'alpha');
  fs.writeFileSync(f.configFile, JSON.stringify(altered));
  const before = tree(f.root);
  assert.throws(() => planNativeGrant({ ...createOptions(f), tokenFile: path.join(f.root, 'recreated.token') }), /state_namespace/);
  assert.throws(() => applyNativeGrant({ ...createOptions(f), tokenFile: path.join(f.root, 'recreated.token'), expect: 'a'.repeat(64) }), /state_namespace/);
  assert.throws(() => inspectNativeDelivery({ configFile: f.configFile }), /state_namespace/);
  assert.deepEqual(tree(f.root), before);
});

test('first bootstrap reserves the state even before any journal exists', t => {
  const f = fixture(t); apply(createOptions(f));
  const alternate = { ...createOptions(f, 'beta', '300'), configFile: path.join(f.root, 'alternate.json'), stateRoot: f.stateRoot, listenPort: 8992 };
  assert.throws(() => planNativeGrant(alternate), /state_namespace|state_owner/);
  assert.equal(fs.existsSync(alternate.configFile), false);
  apply(createOptions(f, 'beta', '300'));
  apply({ action: 'rotate', configFile: f.configFile, profile: 'alpha', tokenFile: path.join(f.root, 'rotated.token') });
  apply({ action: 'revoke', configFile: f.configFile, profile: 'alpha' });
  assert.equal(readNativeConfig(f.configFile).channels.length, 2);
});

test('state lock fences cross-config writers and legacy adoption preserves complete journals', t => {
  const f = fixture(t), options = createOptions(f), preview = planNativeGrant(options);
  const stateLock = path.join(f.stateRoot, '.native-operator-lock'); fs.mkdirSync(stateLock, { mode: 0o700 });
  assert.throws(() => applyNativeGrant({ ...options, expect: preview.expectedRevision }), /state_locked/);
  assert.equal(fs.existsSync(stateLock), true); fs.rmdirSync(stateLock);
  applyNativeGrant({ ...options, expect: preview.expectedRevision });
  const channel = readNativeConfig(f.configFile).channels[0];
  createNativeJournal(f.stateRoot, channel).update('outbound', 'uncertain', { id: 'uncertain', digest: nativeDigest('old'), status: 'outcome_unknown', startedAt: 1 });
  // This fixture now models a pre-CLI config with a complete known namespace.
  fs.unlinkSync(path.join(f.stateRoot, '.native-operator-owner.json'));
  const rotate = { action: 'rotate', configFile: f.configFile, profile: 'alpha', tokenFile: path.join(f.root, 'legacy-rotated.token') };
  const before = tree(f.root), rotatePreview = planNativeGrant(rotate);
  assert.equal(inspectNativeDelivery({ configFile: f.configFile }).channels[0].quarantine, 'outcome_unknown');
  assert.deepEqual(tree(f.root), before, 'legacy plan/inspect cannot adopt state by writing a marker');
  applyNativeGrant({ ...rotate, expect: rotatePreview.expectedRevision });
  assert.equal(readNativeConfig(f.configFile).channels[0].generation, channel.generation);
  assert.equal(inspectNativeDelivery({ configFile: f.configFile }).channels[0].quarantine, 'outcome_unknown');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateRoot, '.native-operator-owner.json'), 'utf8')).configFile, f.configFile);
});

test('a config commit failure retains the durable state owner and cannot bootstrap a new generation', t => {
  const f = fixture(t), options = createOptions(f), preview = planNativeGrant(options);
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === f.configFile) throw new Error('synthetic_config_commit_failure'); return rename(from, to); };
  try { assert.throws(() => applyNativeGrant({ ...options, expect: preview.expectedRevision }), /commit_unknown/); }
  finally { fs.renameSync = rename; }
  assert.equal(fs.existsSync(f.configFile), false);
  const ownerFile = path.join(f.stateRoot, '.native-operator-owner.json');
  assert.equal(JSON.parse(fs.readFileSync(ownerFile, 'utf8')).configFile, f.configFile);
  assert.equal(fs.statSync(ownerFile).nlink, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(ownerFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(f.stateRoot, '.native-operator-lock')), false);
  assert.throws(() => planNativeGrant({ ...options, tokenFile: path.join(f.root, 'retry.token') }), /state_namespace/);
});
