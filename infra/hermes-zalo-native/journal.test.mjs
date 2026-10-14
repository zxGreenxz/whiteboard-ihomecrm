import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNativeJournal, nativeDigest } from '../../worker/lib/hermes-native-journal.js';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';

const channel = { accountId: '11111111-1111-4111-8111-111111111111', profile: 'fixture',
  generation: '22222222-2222-4222-8222-222222222222' };
const record = { id: 'reply-1', digest: nativeDigest('reply'), status: 'outcome_unknown', startedAt: 100 };
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-storage-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, file: path.join(root, `${nativeDigest([channel.accountId, channel.profile, channel.generation])}.json`) };
}
test('an ambiguous rename poisons the journal until restart, preserving the durable no-retry obligation', t => {
  const { root } = fixture(t);
  const io = { ...fs, renameSync(from, to) { fs.renameSync(from, to); throw new Error('injected_after_rename'); } };
  const journal = createNativeJournal(root, channel, { io });
  assert.throws(() => journal.update('outbound', record.id, record));
  assert.throws(() => journal.get('outbound', record.id), /journal/);
  assert.throws(() => journal.values('outbound'), /journal/);
  assert.throws(() => journal.update('outbound', 'reply-2', { ...record, id: 'reply-2' }), /journal/);
  assert.equal(createNativeJournal(root, channel).get('outbound', record.id).status, 'outcome_unknown');
});
test('journal rejects malformed durable state and does not expose mutable record references', t => {
  const { root, file } = fixture(t);
  const journal = createNativeJournal(root, channel);
  journal.update('outbound', record.id, record);
  const value = journal.get('outbound', record.id);
  try { value.status = 'sent'; } catch { /* frozen return is also valid */ }
  assert.equal(journal.get('outbound', record.id).status, 'outcome_unknown');
  fs.writeFileSync(file, JSON.stringify({ version: 1, inbound: {}, outbound: { 'reply-1': { ...record, status: 'retry' } } }));
  assert.throws(() => createNativeJournal(root, channel), /journal/);
});
test('private config refuses unknown grants, oversized files and hardlinks', t => {
  const { root } = fixture(t);
  const tokenFile = path.join(root, 'token'), file = path.join(root, 'config.json');
  fs.writeFileSync(tokenFile, 'hzn_' + 'a'.repeat(64), { mode: 0o600 });
  const config = { version: 1, stateRoot: root, listenPort: 8991, channels: [{ ...channel,
    ownUid: '100', pairedUid: '200', mainUid: '200', tokenFile }] };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  assert.equal(readNativeConfig(file).channels.length, 1);
  fs.writeFileSync(file, JSON.stringify({ ...config, allowAll: true }));
  assert.throws(() => readNativeConfig(file), /native/);
  fs.writeFileSync(file, ' '.repeat(65537) + JSON.stringify(config));
  assert.throws(() => readNativeConfig(file), /native/);
  fs.writeFileSync(file, JSON.stringify(config));
  fs.linkSync(tokenFile, path.join(root, 'linked-token'));
  assert.throws(() => readNativeConfig(file), /native/);
});
test('Linux rejects shared permissions and symbolic paths', { skip: process.platform === 'win32' }, t => {
  const { root } = fixture(t);
  fs.chmodSync(root, 0o755);
  assert.throws(() => createNativeJournal(root, channel), /native/);
  fs.chmodSync(root, 0o700);
  const link = path.join(root, 'linked'); fs.symlinkSync(root, link);
  assert.throws(() => createNativeJournal(link, channel), /native/);
});
