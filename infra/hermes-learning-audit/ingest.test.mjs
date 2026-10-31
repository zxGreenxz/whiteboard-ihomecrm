import assert from 'node:assert/strict';
import test from 'node:test';
import { IngestError, parseJobConfig, planBatches, readPrivateFile, runIngest, sendBatches, storeRefFromConnector } from './ingest.mjs';

const ORG = '11111111-1111-4111-8111-111111111111', USER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-31T13:45:00Z');
const key = n => n.toString(16).padStart(64, '0');
const proposal = (n, extra = {}) => ({ dedupeKey: key(n), kind: 'skill_crm_write', title: `Skill crm-task-management: đề xuất ${n}`,
  content: `Dùng crm_action_run task.create (${n})`, source: { profile: 'owner', type: 'curator_ledger', ledgerId: `l${n}` },
  detectedAt: '2026-10-31T08:30:00Z', ...extra });
const report = (owner, extra = {}) => ({ schemaVersion: 1, generatedAt: '2026-10-31T13:40:00Z', profiles: [
  { profile: 'owner', real: true, proposals: owner }, { profile: 'tkt', real: false, proposals: [proposal(900)] }], ...extra });
const config = (extra = {}) => parseJobConfig({ version: 1, report: '/var/lib/ihome-hermes-learning-audit/latest.json',
  connectorConfig: '/etc/ihome-hermes/connector.json', profiles: { owner: { organizationId: ORG, userId: USER } }, ...extra });
const code = expected => error => { assert.ok(error instanceof IngestError, String(error)); assert.equal(error.code, expected); return true; };

/** Hệ tệp giả: file thường 0600 của uid 1000 (trừ khi khai khác), symlink, tráo file giữa lstat và open. */
function memoryIo(files, { uid = 1000, meta = {}, swapped = new Set() } = {}) {
  const inode = file => [...file].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const info = file => {
    if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const extra = meta[file] ?? {};
    return { isSymbolicLink: () => extra.symlink === true, isFile: () => true, size: Buffer.byteLength(files.get(file)),
      mode: extra.mode ?? 0o100600, uid: extra.uid ?? uid, ino: inode(file), dev: 1 };
  };
  return {
    platform: 'linux', uid,
    lstat: async file => info(file),
    open: async file => {
      const data = Buffer.from(files.get(file) ?? '');
      const held = { ...info(file), ino: swapped.has(file) ? 99 : inode(file) };
      return { stat: async () => held, close: async () => {},
        read: async (buffer, offset, length, position) => { const n = data.copy(buffer, offset, position, position + length); return { bytesRead: n }; } };
    },
    read: async file => { if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return Buffer.from(files.get(file)); },
    readdir: async dir => [...files.keys()].filter(file => file.startsWith(`${dir}/`)).map(file => file.slice(dir.length + 1)),
  };
}

function fakeTransport(script) {
  const calls = [];
  return { calls, transport: { async call(operation, input, { signal }) {
    assert.equal(operation, 'ingestLearningProposals');
    assert.ok(signal instanceof AbortSignal);
    calls.push(structuredClone(input));
    const step = script.shift() ?? 'ok';
    if (step !== 'ok') { const error = new Error(step); error.code = step; throw error; }
    return { organizationId: input.organizationId, inserted: input.proposals.map((_, n) => ({ id: `33333333-3333-4333-8333-${String(calls.length).padStart(4, '0')}${String(n).padStart(8, '0')}`, seq: calls.length * 100 + n })), duplicates: 0 };
  } } };
}

test('cấu hình: ánh xạ hồ sơ → công ty/người dùng, một nguồn store, từ chối khoá lạ', () => {
  assert.deepEqual({ ...config().profiles.owner }, { organizationId: ORG, userId: USER });
  assert.equal(config().reportsDir, '/var/lib/ihome-hermes-learning-audit/reports');
  assert.equal(config().replayDays, 7);
  assert.throws(() => parseJobConfig({ version: 1, report: '/r.json', profiles: { owner: { organizationId: ORG, userId: USER } } }), code('config_store_source_ambiguous'));
  assert.throws(() => config({ extra: true }), code('config_invalid'));
  assert.throws(() => config({ replayDays: 90 }), code('config_invalid'));
  assert.throws(() => config({ profiles: { Owner: { organizationId: ORG, userId: USER } } }), code('config_profile_invalid'));
  assert.throws(() => config({ profiles: { owner: { organizationId: 'org', userId: USER } } }), code('config_profile_invalid'));
  assert.throws(() => config({ report: 'latest.json' }), code('config_invalid'));
  assert.throws(() => parseJobConfig({ version: 1, report: '/r.json', profiles: { owner: { organizationId: ORG, userId: USER } },
    store: { projectRef: 'abcdefghijklmnopqrst', host: 'evil.example.com', role: 'hermes_store_host', passwordFile: '/p' } }), code('store_config_invalid'));
  assert.throws(() => parseJobConfig({ version: 1, report: '/r.json', profiles: { owner: { organizationId: ORG, userId: USER } },
    store: { projectRef: 'abcdefghijklmnopqrst', host: 'db.abcdefghijklmnopqrst.supabase.co', role: 'hermes_store_executor', passwordFile: '/p' } }), code('store_config_invalid'));
});

test('kế hoạch nạp: chỉ hồ sơ có ánh xạ (kể cả tên trùng thuộc tính Object), lô ≤ 25, đề xuất lệch khuôn bị bỏ và đếm', () => {
  const owner = Array.from({ length: 30 }, (_, n) => proposal(n + 1));
  owner.push({ ...proposal(99), dedupeKey: 'abc' }, { ...proposal(98), kind: 'preference' }, { ...proposal(97), extra: 1 },
    { ...proposal(96), title: 'hai\ndòng' }, { ...proposal(95), content: '\n\n' });
  const latest = report(owner);
  latest.profiles.push({ profile: 'constructor', real: false, proposals: [proposal(500)] });
  const plan = planBatches([latest], config(), NOW);
  assert.deepEqual(plan.batches.map(batch => batch.proposals.length), [25, 5]);
  assert.ok(plan.batches.every(batch => batch.organizationId === ORG && batch.userId === USER && batch.profile === 'owner'));
  assert.deepEqual(plan.skipped, [{ profile: 'owner', reason: 'invalid_proposal', proposals: 5 }, { profile: 'tkt', reason: 'no_mapping', proposals: 1 },
    { profile: 'constructor', reason: 'no_mapping', proposals: 1 }]);
  assert.equal(plan.stale, false);
  assert.equal(planBatches(report([proposal(1)]), config(), NOW + 48 * 3_600_000).stale, true);
  assert.throws(() => planBatches([{ ...report([]), schemaVersion: 2 }], config(), NOW), code('report_invalid'));
});

test('kế hoạch nạp: lô không vượt 96 KiB; đề xuất của các báo cáo cũ được gửi lại một lần (SQL bỏ trùng)', () => {
  const heavy = Array.from({ length: 25 }, (_, n) => proposal(n + 1, { content: 'ệ'.repeat(3500) }));
  const plan = planBatches([report(heavy)], config(), NOW);
  assert.ok(plan.batches.length >= 2);
  assert.equal(plan.batches.reduce((sum, batch) => sum + batch.proposals.length, 0), 25);
  assert.ok(plan.batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 96 * 1024));
  const older = { ...report([proposal(1), proposal(2)]), generatedAt: '2026-10-30T13:40:00Z' };
  const merged = planBatches([report([proposal(2), proposal(3)]), older, { broken: true }], config(), NOW);
  // Báo cáo cũ trước: số thứ tự theo trình tự phát hiện.
  assert.deepEqual(merged.batches.flatMap(batch => batch.proposals.map(item => item.dedupeKey)), [key(1), key(2), key(3)]);
  assert.equal(merged.invalidReports, 1);
});

test('gửi lô: thử lại một lần khi kết cục chưa rõ, lỗi từ chối thì dừng lô và báo', async () => {
  const batches = planBatches(report(Array.from({ length: 27 }, (_, n) => proposal(n + 1))), config(), NOW).batches;
  const retried = fakeTransport(['store_outcome_unknown', 'ok', 'ok']);
  const sleeps = [];
  const outcome = await sendBatches(retried.transport, batches, { sleep: async ms => { sleeps.push(ms); } });
  assert.equal(retried.calls.length, 3);
  assert.deepEqual(retried.calls[0], retried.calls[1]); // gửi lại đúng lô cũ (idempotent theo dedupeKey)
  assert.deepEqual(sleeps, [2000]);
  assert.equal(outcome.inserted, 27);
  assert.deepEqual(outcome.failures, []);
  const denied = fakeTransport(['store_denied', 'store_outcome_unknown', 'store_outcome_unknown']);
  const failed = await sendBatches(denied.transport, batches, { sleep: async () => {} });
  assert.equal(denied.calls.length, 3); // lô 1 không thử lại khi bị từ chối; lô 2 thử lại đúng một lần
  assert.deepEqual(failed.failures, [{ profile: 'owner', proposals: 25, code: 'store_denied' }, { profile: 'owner', proposals: 2, code: 'store_outcome_unknown' }]);
  const malformed = { async call() { return { organizationId: ORG, inserted: [], duplicates: 0 }; } };
  assert.deepEqual((await sendBatches(malformed, batches.slice(0, 1))).failures, [{ profile: 'owner', proposals: 25, code: 'ingest_response_invalid' }]);
});

test('file bí mật: tuyệt đối, file thường không symlink, đúng chủ, không mở cho nhóm/người khác, không bị tráo', async () => {
  const file = '/etc/ihome-hermes/store-password', files = new Map([[file, 'x'.repeat(40)]]);
  assert.equal((await readPrivateFile(file, 4096, memoryIo(files))).length, 40);
  await assert.rejects(readPrivateFile(file, 4096, memoryIo(files, { meta: { [file]: { mode: 0o100640 } } })), code('secret_file_too_open'));
  await assert.rejects(readPrivateFile(file, 4096, memoryIo(files, { meta: { [file]: { uid: 0 } } })), code('secret_file_too_open'));
  await assert.rejects(readPrivateFile(file, 4096, memoryIo(files, { meta: { [file]: { symlink: true } } })), code('secret_file_invalid'));
  await assert.rejects(readPrivateFile(file, 4096, memoryIo(files, { swapped: new Set([file]) })), code('secret_file_invalid'));
  await assert.rejects(readPrivateFile('store-password', 4096, memoryIo(files)), code('secret_path_invalid'));
  await assert.rejects(readPrivateFile(file, 10, memoryIo(files)), code('secret_file_invalid'));
});

test('chỉ đọc khối store của connector.json, không mang khoá khác ra ngoài', async () => {
  const connector = { version: 2, mode: 'connector', supabase: { url: 'https://abcdefghijklmnopqrst.supabase.co', publishableKey: 'sb_publishable_x' },
    store: { projectRef: 'abcdefghijklmnopqrst', host: 'aws-1-ap-southeast-1.pooler.supabase.com', role: 'hermes_store_host', passwordFile: '/etc/ihome-hermes/store-password', caFile: '/etc/ihome-hermes/store-ca.pem' },
    encryption: { activeKeyVersion: 'v1', keys: [{ version: 'v1', file: '/etc/ihome-hermes/keys/v1.bin' }] } };
  const path = '/etc/ihome-hermes/connector.json';
  assert.deepEqual({ ...await storeRefFromConnector(path, memoryIo(new Map([[path, JSON.stringify(connector)]]))) }, connector.store);
  await assert.rejects(storeRefFromConnector(path, memoryIo(new Map([[path, '{"version":1}']]))), code('connector_config_invalid'));
});

function scenario({ latest, extraFiles = [] }) {
  const password = 'mật-khẩu-giả-đủ-dài-1234';
  const files = new Map([
    ['/etc/ihome-hermes/learning-audit.json', JSON.stringify({ version: 1, report: '/var/lib/ihome-hermes-learning-audit/latest.json',
      connectorConfig: '/etc/ihome-hermes/connector.json', profiles: { owner: { organizationId: ORG, userId: USER } } })],
    ['/var/lib/ihome-hermes-learning-audit/latest.json', JSON.stringify(latest)],
    ['/etc/ihome-hermes/connector.json', JSON.stringify({ version: 2, mode: 'connector', store: { projectRef: 'abcdefghijklmnopqrst',
      host: 'db.abcdefghijklmnopqrst.supabase.co', role: 'hermes_store_host', passwordFile: '/etc/ihome-hermes/store-password' } })],
    ['/etc/ihome-hermes/store-password', password], ...extraFiles,
  ]);
  return { password, io: memoryIo(files) };
}

test('chạy trọn: đọc cấu hình + báo cáo (cả báo cáo cũ) + bí mật, nạp, in một dòng tóm tắt không có mật khẩu', async () => {
  const older = { ...report([proposal(7)]), generatedAt: '2026-10-29T13:40:00Z' };
  const tooOld = { ...report([proposal(8)]), generatedAt: '2026-10-01T13:40:00Z' };
  const { password, io } = scenario({ latest: report([proposal(1), proposal(2)]), extraFiles: [
    ['/var/lib/ihome-hermes-learning-audit/reports/learning-audit-20261029T134000Z.json', JSON.stringify(older)],
    ['/var/lib/ihome-hermes-learning-audit/reports/learning-audit-20261001T134000Z.json', JSON.stringify(tooOld)],
    ['/var/lib/ihome-hermes-learning-audit/reports/learning-audit-20261031T134000Z.json', JSON.stringify(report([proposal(1), proposal(2)]))]] });
  const fake = fakeTransport([]);
  let credentials, closed = false;
  const lines = [];
  const status = await runIngest({ configPath: '/etc/ihome-hermes/learning-audit.json', io, now: NOW, log: line => lines.push(line),
    createTransport: async value => { credentials = value; return { transport: fake.transport, close: async () => { closed = true; } }; } });
  assert.equal(status, 0);
  assert.equal(credentials.password, password);
  assert.equal(credentials.role, 'hermes_store_host');
  assert.ok(closed);
  assert.deepEqual(fake.calls.flatMap(call => call.proposals.map(item => item.dedupeKey)), [key(7), key(1), key(2)]);
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.event, 'learning_ingest');
  assert.equal(summary.inserted, 3);
  assert.equal(summary.reports, 2);
  assert.deepEqual(summary.skipped, [{ profile: 'tkt', reason: 'no_mapping', proposals: 1 }]);
  assert.ok(!lines[0].includes(password));
  assert.ok(!lines[0].includes('crm_action_run'), 'tóm tắt không chép nội dung đề xuất');
});

test('chạy trọn: đề xuất lệch khuôn vẫn nạp phần hợp lệ nhưng thoát mã 1 để không âm thầm', async () => {
  const { io } = scenario({ latest: report([proposal(1), { ...proposal(2), title: 'hai\ndòng' }]) });
  const fake = fakeTransport([]);
  const lines = [];
  const status = await runIngest({ configPath: '/etc/ihome-hermes/learning-audit.json', io, now: NOW, log: line => lines.push(line),
    createTransport: async () => ({ transport: fake.transport, close: async () => {} }) });
  assert.equal(status, 1);
  assert.equal(JSON.parse(lines[0]).inserted, 1);
});
