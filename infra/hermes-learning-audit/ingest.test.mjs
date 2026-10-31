import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { IngestError, parseJobConfig, pgJsonText, planBatches, proposalProblem, readPrivateFile, runIngest, sendBatches } from './ingest.mjs';

const ORG = '11111111-1111-4111-8111-111111111111', USER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-10-31T13:45:00Z');
const OUTBOX = '/var/lib/ihome-hermes-learning-audit/outbox';
const STORE = { projectRef: 'abcdefghijklmnopqrst', host: 'aws-1-ap-southeast-1.pooler.supabase.com', role: 'hermes_store_learning',
  passwordFile: '/etc/ihome-hermes/learning-store-password', caFile: '/etc/ihome-hermes/store-ca.pem' };
const key = n => n.toString(16).padStart(64, '0');
const proposal = (n, extra = {}) => ({ dedupeKey: key(n), kind: 'skill_crm_write', title: `Skill crm-task-management: đề xuất ${n}`,
  content: `Dùng crm_action_run task.create (${n})`, source: { profile: 'owner', type: 'curator_ledger', ledgerId: `l${n}` },
  detectedAt: '2026-10-31T08:30:00Z', ...extra });
const outbox = (owner, extra = {}) => ({ schemaVersion: 1, kind: 'hermes-learning-outbox', generatedAt: '2026-10-31T13:40:00Z', profiles: [
  { profile: 'owner', proposals: owner }, { profile: 'tkt', proposals: [proposal(900)] }], ...extra });
const config = (extra = {}) => parseJobConfig({ version: 1, outboxDir: OUTBOX, store: STORE,
  profiles: { owner: { organizationId: ORG, userId: USER } }, ...extra });
const code = expected => error => { assert.ok(error instanceof IngestError, String(error)); assert.equal(error.code, expected); return true; };
const stamp = iso => iso.replace(/[-:]/g, '').replace(/\.\d+/, '');

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
    readdir: async dir => [...files.keys()].filter(file => file.startsWith(`${dir}/`)).map(file => file.slice(dir.length + 1)),
  };
}

/** Transport giả mô phỏng SQL: `reject(item)` ⇒ mục làm cả lời gọi bị từ chối (store_rejected); kịch bản lỗi theo lượt gọi. */
function fakeTransport({ script = [], reject = () => false, rejectHeader = false, rejected = new Set() } = {}) {
  const calls = [];
  let seq = 0;
  return { calls, transport: { async call(operation, input, { signal }) {
    assert.equal(operation, 'ingestLearningProposals');
    assert.ok(signal instanceof AbortSignal);
    calls.push(structuredClone(input));
    const step = script.shift() ?? 'ok';
    const fault = step !== 'ok' ? step : rejectHeader ? 'store_rejected' : input.proposals.some(reject) ? 'store_rejected' : null;
    if (fault) { const error = new Error(fault); error.code = fault; throw error; }
    const duplicates = input.proposals.filter(item => rejected.has(item.dedupeKey));
    return { organizationId: input.organizationId, duplicates: duplicates.length, rejectedDuplicates: duplicates.map(item => item.dedupeKey),
      inserted: input.proposals.filter(item => !rejected.has(item.dedupeKey))
        .map(() => ({ id: `33333333-3333-4333-8333-${String(++seq).padStart(12, '0')}`, seq })) };
  } } };
}

test('cấu hình: thư mục outbox, login nạp riêng (không phải kho bền connector), ánh xạ hồ sơ, từ chối khoá lạ', () => {
  assert.deepEqual({ ...config().profiles.owner }, { organizationId: ORG, userId: USER });
  assert.equal(config().replayDays, 7);
  assert.equal(config().store.role, 'hermes_store_learning');
  const base = { version: 1, outboxDir: OUTBOX, store: STORE, profiles: { owner: { organizationId: ORG, userId: USER } } };
  const { store: _store, ...withoutStore } = base;
  assert.throws(() => parseJobConfig(withoutStore), code('config_invalid'));
  assert.throws(() => parseJobConfig({ ...base, store: undefined }), code('store_config_invalid'));
  assert.throws(() => parseJobConfig({ ...base, connectorConfig: '/etc/ihome-hermes/connector.json' }), code('config_invalid'));
  assert.throws(() => config({ extra: true }), code('config_invalid'));
  assert.throws(() => config({ replayDays: 90 }), code('config_invalid'));
  assert.throws(() => config({ outboxDir: 'outbox' }), code('config_invalid'));
  assert.throws(() => config({ profiles: { Owner: { organizationId: ORG, userId: USER } } }), code('config_profile_invalid'));
  assert.throws(() => config({ profiles: { owner: { organizationId: 'org', userId: USER } } }), code('config_profile_invalid'));
  assert.throws(() => config({ store: { ...STORE, host: 'evil.example.com' } }), code('store_config_invalid'));
  assert.throws(() => config({ store: { ...STORE, role: 'hermes_store_executor' } }), code('store_config_invalid'));
  assert.throws(() => config({ store: { ...STORE, role: 'hermes_learning_ingest' } }), code('store_config_invalid'));
});

test('mẫu cấu hình trong repo đọc được bằng đúng bộ kiểm của job', () => {
  const example = parseJobConfig(JSON.parse(readFileSync(new URL('./learning-audit.example.json', import.meta.url), 'utf8')));
  assert.equal(example.store.role, 'hermes_store_learning');
  assert.equal(example.outboxDir, OUTBOX);
});

test('khuôn đề xuất khớp SQL: NUL, surrogate lẻ, ký tự điều khiển, độ dài theo ký tự, nguồn ≤ 4096 B dạng chữ jsonb, detectedAt', () => {
  const ok = item => proposalProblem(item, NOW);
  assert.equal(ok(proposal(1)), null);
  assert.equal(ok(proposal(1, { title: '\u{1D54F}'.repeat(200) })), null); // 200 ký tự (400 đơn vị UTF-16) vẫn hợp lệ như char_length
  assert.equal(ok(proposal(1, { content: 'a\tb\nc\rd' })), null);
  assert.equal(ok(proposal(1, { source: { note: 'x'.repeat(4084) } })), null); // {"note": "…"} = 12 + 4084 = 4096 B
  for (const [extra, problem] of [
    [{ dedupeKey: 'abc' }, 'dedupeKey'], [{ kind: 'preference' }, 'kind'], [{ extra: 1 }, 'shape'],
    [{ title: 'hai\ndòng' }, 'title'], [{ title: 'a\u0000b' }, 'title'], [{ title: 'a\ud800b' }, 'title'], [{ title: ' 　 ' }, 'title'],
    [{ title: 'x'.repeat(201) }, 'title'], [{ content: '\n\n\t' }, 'content'], [{ content: 'a\u0001b' }, 'content'],
    [{ content: 'a\u0000b' }, 'content'], [{ content: 'tail\udc00' }, 'content'], [{ content: 'x'.repeat(4001) }, 'content'],
    [{ source: { note: 'x'.repeat(4085) } }, 'source'], [{ source: { skill: 'abc\u0000' } }, 'source'],
    [{ source: { skill: 'abc\udc00' } }, 'source'], [{ source: { ratio: 0.5 } }, 'source'], [{ source: [] }, 'source'],
    [{ source: { k: 'x'.repeat(4096) } }, 'source'],
    [{ detectedAt: '2026-10-31 08:30:00' }, 'detectedAt'], [{ detectedAt: '2026-11-02T13:45:00Z' }, 'detectedAt'],
    [{ detectedAt: '2025-09-25T13:45:00Z' }, 'detectedAt'], [{ detectedAt: '2026-13-45T00:00:00Z' }, 'detectedAt'],
  ]) assert.equal(ok(proposal(1, extra)), problem, JSON.stringify(extra).slice(0, 80));
});

test('đo nguồn bằng dạng chữ jsonb: khớp đúng octet_length(source::text) của PostgreSQL', async t => {
  const db = new PGlite(); t.after(() => db.close());
  for (const source of [{}, { a: 1 }, { type: 'curator_ledger', ledgerId: 'abc', reasons: ['nhắc crm_action_run', 'tool ghi crm_task_create'] },
    { nested: { deep: [1, 2, { x: null, y: true }] }, 'khóa có dấu': 'giá trị "trích" \\ / \t\n\r\b\f \u0001 \u007f 𝕏 ệ' },
    { n: -9007199254740991, z: 0, e: [] }]) {
    const { rows: [row] } = await db.query('SELECT octet_length($1::jsonb::text) AS n', [JSON.stringify(source)]);
    assert.equal(Buffer.byteLength(pgJsonText(source)), row.n, JSON.stringify(source));
  }
});

test('kế hoạch nạp: mỗi hồ sơ có ánh xạ một nhịp kiểm (kể cả rỗng), lô ≤ 25, mục lệch bị bỏ và báo khoá', () => {
  const owner = Array.from({ length: 30 }, (_, n) => proposal(n + 1));
  owner.push(proposal(99, { dedupeKey: 'abc' }), proposal(98, { source: { skill: 'abc\u0000' } }), proposal(97, { title: 'hai\ndòng' }));
  const latest = outbox(owner);
  latest.profiles.push({ profile: 'constructor', proposals: [proposal(500)] });
  const plan = planBatches([latest], config(), NOW);
  assert.deepEqual(plan.batches.map(batch => batch.proposals.length), [25, 5]);
  assert.ok(plan.batches.every(batch => batch.organizationId === ORG && batch.userId === USER && batch.profile === 'owner'
    && batch.auditGeneratedAt === '2026-10-31T13:40:00.000Z'));
  assert.deepEqual(plan.dropped, [{ profile: 'owner', dedupeKey: null, problem: 'dedupeKey' },
    { profile: 'owner', dedupeKey: key(98), problem: 'source' }, { profile: 'owner', dedupeKey: key(97), problem: 'title' }]);
  assert.deepEqual(plan.skipped, [{ profile: 'tkt', reason: 'no_mapping', proposals: 1 }, { profile: 'constructor', reason: 'no_mapping', proposals: 1 }]);
  assert.deepEqual(plan.missingProfiles, []);
  assert.equal(plan.stale, false);
  const empty = planBatches([outbox([])], config(), NOW);
  assert.deepEqual(empty.batches, [{ organizationId: ORG, userId: USER, profile: 'owner', auditGeneratedAt: '2026-10-31T13:40:00.000Z', proposals: [] }]);
  assert.equal(planBatches([outbox([])], config(), NOW + 48 * 3_600_000).stale, true);
  // Đồng hồ host chạy trước: mốc kiểm không vượt "bây giờ".
  assert.equal(planBatches([outbox([], { generatedAt: '2026-10-31T15:00:00Z' })], config(), NOW).batches[0].auditGeneratedAt,
    new Date(NOW).toISOString());
  const none = planBatches([], config(), NOW);
  assert.deepEqual([none.batches, none.missingProfiles, none.stale], [[], ['owner'], true]);
  assert.equal(planBatches([{ ...outbox([]), schemaVersion: 2 }], config(), NOW).invalidFiles, 1);
});

test('kế hoạch nạp: lô ≤ 96 KiB; outbox cũ trong replayDays được gửi bù trước, trùng khoá chỉ một lần; hồ sơ vắng ở lần kiểm mới nhất bị báo', () => {
  const heavy = Array.from({ length: 25 }, (_, n) => proposal(n + 1, { content: 'ệ'.repeat(3500) }));
  const plan = planBatches([outbox(heavy)], config(), NOW);
  assert.ok(plan.batches.length >= 2);
  assert.equal(plan.batches.reduce((sum, batch) => sum + batch.proposals.length, 0), 25);
  assert.ok(plan.batches.every(batch => Buffer.byteLength(JSON.stringify(batch)) <= 96 * 1024));
  const older = outbox([proposal(1), proposal(2)], { generatedAt: '2026-10-30T13:40:00Z' });
  const tooOld = outbox([proposal(50)], { generatedAt: '2026-10-01T13:40:00Z' });
  const merged = planBatches([outbox([proposal(2), proposal(3)]), older, null, tooOld], config(), NOW);
  assert.deepEqual(merged.batches.flatMap(batch => batch.proposals.map(item => item.dedupeKey)), [key(1), key(2), key(3)]);
  assert.equal(merged.invalidFiles, 1);
  // Lần kiểm mới nhất không có hồ sơ owner (job kiểm lỗi hồ sơ đó): đề xuất cũ vẫn gửi bù với mốc kiểm CŨ của chính nó, và báo thiếu.
  const missing = planBatches([{ ...outbox([]), profiles: [] }, older], config(), NOW);
  assert.deepEqual(missing.missingProfiles, ['owner']);
  assert.deepEqual(missing.batches.map(batch => [batch.auditGeneratedAt, batch.proposals.length]), [['2026-10-30T13:40:00.000Z', 2]]);
});

test('gửi lô: thử lại một lần khi kết cục chưa rõ; bị từ chối thì báo; phản hồi lệch khuôn không được coi là thành công', async () => {
  const batches = planBatches([outbox(Array.from({ length: 27 }, (_, n) => proposal(n + 1)))], config(), NOW).batches;
  const retried = fakeTransport({ script: ['store_outcome_unknown'] });
  const sleeps = [];
  const outcome = await sendBatches(retried.transport, batches, { sleep: async ms => { sleeps.push(ms); } });
  assert.equal(retried.calls.length, 3);
  assert.deepEqual(retried.calls[0], retried.calls[1]); // gửi lại đúng lô cũ (idempotent theo dedupeKey)
  assert.deepEqual(sleeps, [2000]);
  assert.equal(outcome.inserted, 27);
  assert.deepEqual(outcome.failures, []);
  const denied = fakeTransport({ script: ['store_denied', 'store_outcome_unknown', 'store_outcome_unknown'] });
  const failed = await sendBatches(denied.transport, batches, { sleep: async () => {} });
  assert.equal(denied.calls.length, 3); // lô 1 không thử lại khi bị từ chối quyền; lô 2 thử lại đúng một lần
  assert.deepEqual(failed.failures, [{ profile: 'owner', proposals: 25, code: 'store_denied' }, { profile: 'owner', proposals: 2, code: 'store_outcome_unknown' }]);
  for (const result of [{ organizationId: ORG, inserted: [], duplicates: 0 }, { organizationId: ORG, inserted: [], duplicates: 25, rejectedDuplicates: [key(999)] }]) {
    const malformed = { async call() { return result; } };
    assert.deepEqual((await sendBatches(malformed, batches.slice(0, 1))).failures, [{ profile: 'owner', proposals: 25, code: 'ingest_response_invalid' }]);
  }
});

test('gửi lô: SQL từ chối cả lô ⇒ nhịp riêng rồi từng mục; chỉ mục hỏng bị bỏ (báo khoá), trùng với đề xuất đã bỏ được báo riêng', async () => {
  const batches = planBatches([outbox([proposal(1), proposal(2), proposal(3), proposal(4)])], config(), NOW).batches;
  const fake = fakeTransport({ reject: item => item.dedupeKey === key(3), rejected: new Set([key(4)]) });
  const outcome = await sendBatches(fake.transport, batches, { sleep: async () => {} });
  assert.deepEqual(fake.calls.map(call => call.proposals.map(item => item.dedupeKey)), [[key(1), key(2), key(3), key(4)], [], [key(1)], [key(2)], [key(3)], [key(4)]]);
  assert.equal(outcome.inserted, 2);
  assert.deepEqual(outcome.rejected, [{ profile: 'owner', dedupeKey: key(3) }]);
  assert.deepEqual(outcome.rejectedDuplicates, [key(4)]);
  assert.deepEqual(outcome.failures, []);
  // Phần đầu lô (hồ sơ/mốc kiểm) bị từ chối: không đổ lỗi cho từng mục.
  const header = fakeTransport({ rejectHeader: true });
  const broken = await sendBatches(header.transport, batches, { sleep: async () => {} });
  assert.equal(header.calls.length, 2);
  assert.deepEqual([broken.rejected, broken.failures], [[], [{ profile: 'owner', proposals: 4, code: 'batch_header_rejected' }]]);
});

test('file bí mật: tuyệt đối, file thường không symlink, đúng chủ, không mở cho nhóm/người khác, không bị tráo', async () => {
  const file = '/etc/ihome-hermes/learning-store-password', files = new Map([[file, 'x'.repeat(40)]]);
  assert.equal((await readPrivateFile(file, 4096, memoryIo(files))).length, 40);
  await assert.rejects(readPrivateFile(file, 4096, memoryIo(files, { meta: { [file]: { mode: 0o100640 } } })), code('secret_file_too_open'));
  await assert.rejects(readPrivateFile(file, 4096, memoryIo(files, { meta: { [file]: { uid: 0 } } })), code('secret_file_too_open'));
  await assert.rejects(readPrivateFile(file, 4096, memoryIo(files, { meta: { [file]: { symlink: true } } })), code('secret_file_invalid'));
  await assert.rejects(readPrivateFile(file, 4096, memoryIo(files, { swapped: new Set([file]) })), code('secret_file_invalid'));
  await assert.rejects(readPrivateFile('store-password', 4096, memoryIo(files)), code('secret_path_invalid'));
  await assert.rejects(readPrivateFile(file, 10, memoryIo(files)), code('secret_file_invalid'));
});

function scenario(boxes, { meta = {} } = {}) {
  const password = 'mật-khẩu-giả-đủ-dài-1234';
  const files = new Map([
    ['/etc/ihome-hermes/learning-audit.json', JSON.stringify({ version: 1, outboxDir: OUTBOX, store: { ...STORE, caFile: undefined },
      profiles: { owner: { organizationId: ORG, userId: USER } } })],
    [STORE.passwordFile, password],
    ...boxes.map(box => [`${OUTBOX}/learning-outbox-${stamp(box.generatedAt)}.json`, JSON.stringify(box)]),
  ]);
  // Outbox do user của job kiểm ghi, nhóm ihome-hermes đọc (0640, chủ khác): không phải file bí mật nên không đòi 0600/đúng chủ.
  for (const box of boxes) meta[`${OUTBOX}/learning-outbox-${stamp(box.generatedAt)}.json`] ??= { mode: 0o100640, uid: 999 };
  return { password, files, io: memoryIo(files, { meta }) };
}

async function run(io, transport, now = NOW) {
  const lines = [];
  let credentials, closed = false;
  const status = await runIngest({ configPath: '/etc/ihome-hermes/learning-audit.json', io, now, log: line => lines.push(line),
    createTransport: async value => { credentials = value; return { transport, close: async () => { closed = true; } }; } });
  return { status, lines, credentials, closed };
}

test('chạy trọn: đọc cấu hình + outbox (cả outbox cũ) + bí mật, nạp, một dòng tóm tắt chỉ có số đếm và khoá', async () => {
  const older = outbox([proposal(7)], { generatedAt: '2026-10-29T13:40:00Z' });
  const tooOld = outbox([proposal(8)], { generatedAt: '2026-10-01T13:40:00Z' });
  const { password, io } = scenario([outbox([proposal(1), proposal(2)]), older, tooOld]);
  const fake = fakeTransport({ rejected: new Set([key(2)]) });
  const { status, lines, credentials, closed } = await run(io, fake.transport);
  assert.equal(status, 0);
  assert.equal(credentials.password, password);
  assert.equal(credentials.role, 'hermes_store_learning');
  assert.ok(closed);
  assert.deepEqual(fake.calls.flatMap(call => call.proposals.map(item => item.dedupeKey)), [key(7), key(1), key(2)]);
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.deepEqual([summary.event, summary.inserted, summary.duplicates, summary.outboxFiles], ['learning_ingest', 2, 1, 2]);
  assert.deepEqual([summary.rejectedDuplicates, summary.rejectedDuplicateKeys], [1, [key(2)]]);
  assert.deepEqual(summary.skipped, [{ profile: 'tkt', reason: 'no_mapping', proposals: 1 }]);
  assert.ok(!lines[0].includes(password));
  assert.ok(!lines[0].includes('crm_action_run'), 'tóm tắt không chép nội dung đề xuất');
});

test('chạy trọn: nhịp kiểm không có đề xuất vẫn gọi CRM; outbox quá cũ ⇒ mã 3 (job kiểm đã ngừng)', async () => {
  const fake = fakeTransport();
  const { status } = await run(scenario([outbox([])]).io, fake.transport);
  assert.equal(status, 0);
  assert.deepEqual(fake.calls.map(call => [call.profile, call.auditGeneratedAt, call.proposals.length]), [['owner', '2026-10-31T13:40:00.000Z', 0]]);
  const stale = fakeTransport();
  const late = await run(scenario([outbox([])]).io, stale.transport, NOW + 40 * 3_600_000);
  assert.equal(late.status, 3);
  assert.equal(stale.calls.length, 1); // vẫn gửi mốc kiểm cũ: CRM giữ mốc lớn nhất nên trang báo "lâu chưa kiểm"
  assert.equal(JSON.parse(late.lines[0]).stale, true);
});

test('chạy trọn: mục NUL/lệch khuôn bị bỏ trước khi gửi, phần hợp lệ vẫn nạp, thoát mã 1 để không âm thầm', async () => {
  const bad = proposal(99, { source: { type: 'curator_ledger', ledgerId: 'l99', skill: 'abc\u0000' } });
  const fake = fakeTransport({ reject: item => JSON.stringify(item).includes('\\u0000') });
  const { status, lines } = await run(scenario([outbox([proposal(1), bad, proposal(2)])]).io, fake.transport);
  assert.equal(status, 1);
  assert.equal(fake.calls.length, 1);
  assert.ok(!JSON.stringify(fake.calls).includes('\\u0000'));
  const summary = JSON.parse(lines[0]);
  assert.deepEqual([summary.inserted, summary.droppedInvalid, summary.droppedInvalidKeys], [2, 1, [key(99)]]);
});

test('chạy trọn: không có outbox, outbox là symlink hay hỏng ⇒ báo, không gọi CRM khi không có gì để gửi', async () => {
  const empty = fakeTransport();
  const nothing = await run(scenario([]).io, empty.transport);
  assert.equal(nothing.status, 1);
  assert.equal(empty.calls.length, 0);
  assert.deepEqual(JSON.parse(nothing.lines[0]).missingProfiles, ['owner']);
  const box = outbox([proposal(1)]);
  const file = `${OUTBOX}/learning-outbox-${stamp(box.generatedAt)}.json`;
  const linked = fakeTransport();
  const symlinked = await run(scenario([box], { meta: { [file]: { symlink: true } } }).io, linked.transport);
  assert.equal(symlinked.status, 1);
  assert.equal(linked.calls.length, 0);
  assert.equal(JSON.parse(symlinked.lines[0]).invalidFiles, 1);
  const corrupt = scenario([box]);
  corrupt.files.set(file, '{không phải json');
  assert.equal((await run(corrupt.io, fakeTransport().transport)).status, 1);
});
