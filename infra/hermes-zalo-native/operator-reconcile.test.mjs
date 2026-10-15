import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planNativeGrant, applyNativeGrant, inspectNativeDelivery, reconcileNativeDelivery, runNativeOperator } from './operator.mjs';
import { readNativeConfig } from '../../worker/lib/hermes-native-config.js';
import { createNativeJournal, nativeDigest } from '../../worker/lib/hermes-native-journal.js';

const accountId = '11111111-1111-4111-8111-111111111111';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-reconcile-')));
  const stateRoot = path.join(root, 'state'); fs.mkdirSync(stateRoot, { mode: 0o700 });
  const configFile = path.join(root, 'config.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { action: 'create', configFile, profile: 'alpha', accountId, ownUid: '100', pairedUid: '200',
    tokenFile: path.join(root, 'alpha.token'), stateRoot, listenPort: 8991 };
  applyNativeGrant({ ...options, expect: planNativeGrant(options).expectedRevision });
  const channel = readNativeConfig(configFile).channels[0], journal = createNativeJournal(stateRoot, channel);
  journal.update('outbound', 'sent-1', { id: 'sent-1', digest: nativeDigest('a'), status: 'sent', startedAt: 1, finishedAt: 2, messageId: '42' });
  journal.update('outbound', 'unknown-1', { id: 'unknown-1', digest: nativeDigest('b'), status: 'outcome_unknown', startedAt: 3 });
  return { root, stateRoot, configFile, channel };
}
const bytes = file => fs.readFileSync(file).toString('hex');
const request = f => ({ action: 'reconcile', configFile: f.configFile, profile: 'alpha', requestId: 'unknown-1', decision: 'not_sent',
  note: 'Đã xem DM trên Zalo: không có tin trả lời lúc 09:00' });

test('reconcile plans read-only, then records one human decision without touching journal, generation or config', t => {
  const f = fixture(t), journalFile = inspectNativeDelivery({ configFile: f.configFile }).channels[0].journalFile;
  const before = { journal: bytes(journalFile), config: bytes(f.configFile), entries: fs.readdirSync(f.root).sort() };
  const plan = reconcileNativeDelivery(request(f));
  assert.deepEqual([plan.diskStatus, plan.journal, plan.generation, plan.resend, plan.quarantineRelease],
    ['planned', 'unchanged', 'unchanged', 'never', 'requires_worker_support']);
  assert.deepEqual(fs.readdirSync(f.root).sort(), before.entries);
  const applied = reconcileNativeDelivery({ ...request(f), expect: plan.expectedRevision }, { apply: true });
  assert.equal(applied.diskStatus, 'recorded');
  assert.equal(bytes(journalFile), before.journal);
  assert.equal(bytes(f.configFile), before.config);
  assert.equal(readNativeConfig(f.configFile).channels[0].generation, f.channel.generation);
  const ledgerFile = `${f.configFile}.reconciliations.json`, ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.deepEqual(ledger.entries.map(entry => [entry.profile, entry.generation, entry.requestId, entry.decision, entry.recordDigest, entry.startedAt]),
    [['alpha', f.channel.generation, 'unknown-1', 'not_sent', nativeDigest('b'), 3]]);
  if (process.platform !== 'win32') assert.equal(fs.statSync(ledgerFile).mode & 0o777, 0o600);
  const inspected = inspectNativeDelivery({ configFile: f.configFile }).channels[0];
  // The worker still quarantines on the unknown record; only the decision is shown.
  assert.equal(inspected.quarantine, 'outcome_unknown');
  assert.deepEqual(inspected.reconciliation, { recorded: 1, unreconciled: 0, quarantineRelease: 'requires_worker_support' });
  assert.equal(inspected.outbound.records.find(record => record.id === 'unknown-1').reconciliation, 'not_sent');
  assert.equal(Object.hasOwn(inspected.outbound.records.find(record => record.id === 'sent-1'), 'reconciliation'), false);
  assert.ok(!JSON.stringify(inspected).includes(f.channel.token));
});

test('reconcile refuses stale revisions, settled or missing records, repeats and malformed arguments', t => {
  const f = fixture(t), plan = reconcileNativeDelivery(request(f));
  assert.throws(() => reconcileNativeDelivery({ ...request(f), expect: 'f'.repeat(64) }, { apply: true }), /native_operator_config_changed/);
  assert.throws(() => reconcileNativeDelivery(request(f), { apply: true }), /native_operator_expected_revision_required/);
  assert.throws(() => reconcileNativeDelivery({ ...request(f), requestId: 'sent-1' }), /native_operator_not_unknown/);
  assert.throws(() => reconcileNativeDelivery({ ...request(f), requestId: 'missing-1' }), /native_operator_record_missing/);
  for (const bad of [{ decision: 'resend' }, { note: '  ' }, { note: 'x'.repeat(501) }, { note: 'bad\u0000' }, { generation: 'new' }, { profile: 'Bad' }]) {
    assert.throws(() => reconcileNativeDelivery({ ...request(f), ...bad }), /native_operator_(arguments|profile_conflict)/);
  }
  reconcileNativeDelivery({ ...request(f), expect: plan.expectedRevision }, { apply: true });
  assert.throws(() => reconcileNativeDelivery({ ...request(f), decision: 'sent' }), /native_operator_already_reconciled/);
  // A stale plan cannot overwrite a newer ledger.
  assert.throws(() => reconcileNativeDelivery({ ...request(f), expect: plan.expectedRevision }, { apply: true }), /native_operator_already_reconciled/);
  // The ledger path is reserved: a token cannot be created over it.
  assert.throws(() => planNativeGrant({ action: 'rotate', configFile: f.configFile, profile: 'alpha', tokenFile: `${f.configFile}.reconciliations.json` }),
    /native_operator_(reserved_path|token_file_exists)/);
  fs.writeFileSync(`${f.configFile}.reconciliations.json`, '{"version":1,"entries":[{"edited":true}]}', { mode: 0o600 });
  assert.throws(() => inspectNativeDelivery({ configFile: f.configFile }), /native_operator_ledger_invalid/);
});

test('CLI reconcile is dry-run unless --apply --expect; no clear-unknown or generation override exists', t => {
  const f = fixture(t);
  let stdout = '', stderr = '';
  const sink = { write: value => { stdout += value; }, error: value => { stderr += value; } };
  const args = ['reconcile', '--config', f.configFile, '--profile', 'alpha', '--request-id', 'unknown-1', '--decision', 'sent', '--note', 'Thấy tin trong Zalo'];
  assert.equal(runNativeOperator(args, sink), 0);
  const plan = JSON.parse(stdout); stdout = '';
  assert.equal(fs.existsSync(`${f.configFile}.reconciliations.json`), false);
  assert.equal(runNativeOperator([...args, '--apply', '--expect', plan.expectedRevision], sink), 0);
  assert.equal(JSON.parse(stdout).diskStatus, 'recorded');
  for (const command of [['clear-unknown', '--profile', 'alpha'], [...args, '--generation', 'x'], ['reconcile', '--config', f.configFile, '--profile', 'alpha']]) {
    assert.equal(runNativeOperator(command, sink), 1);
  }
  assert.ok(!stderr.includes('hzn_'));
});
