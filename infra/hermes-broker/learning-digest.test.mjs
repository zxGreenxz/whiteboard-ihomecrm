import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLearningDigest, LEARNING_DIGEST_MAX_ITEMS, LEARNING_REVIEW_PATH, parseLearningReply } from './learning-digest.mjs';

const item = (seq, extra = {}) => ({ seq, kind: 'skill_crm_write', title: `Skill crm-task-management: curator sửa — bài học ghi CRM ${seq}`,
  content: 'For task creation, first rediscover crm_task_create and crm_task_input_options before creating a task.', ...extra });

test('tin tối: đánh số theo seq, báo số đề xuất khác còn chờ, cách trả lời và link trang duyệt', () => {
  const message = formatLearningDigest({ proposals: [item(7), item(5, { kind: 'memory_crm_write', title: 'Bộ nhớ MEMORY.md: tạo phiếu thu' })],
    pendingTotal: 4, webOrigin: 'https://crm.example.vn', date: new Date('2026-10-31T14:00:00Z') });
  const lines = message.split('\n');
  assert.equal(lines[0], 'Bài học Hermes chờ duyệt (31/10): 2 đề xuất mới về cách ghi dữ liệu CRM.');
  assert.match(lines[1], /^#5 Bộ nhớ — Bộ nhớ MEMORY\.md: tạo phiếu thu: «For task creation/);
  assert.match(lines[2], /^#7 Skill — /);
  // Còn chờ ngoài tin = đã báo các tối trước + mới vượt trần (tối sau báo): không gọi là "cũ" (review #391).
  assert.equal(lines[3], 'Còn 2 đề xuất khác đang chờ duyệt (xem trên web).');
  assert.match(lines[4], /^Trả lời "duyệt 5" hoặc "bỏ 5"/);
  assert.equal(lines[5], `Xem kỹ: https://crm.example.vn${LEARNING_REVIEW_PATH}`);
  assert.equal(formatLearningDigest({ proposals: [], pendingTotal: 3 }), null);
  assert.match(formatLearningDigest({ proposals: [item(1)], pendingTotal: 1 }), /Xem kỹ: \/settings\/hermes\?tab=bai-hoc$/);
});

// Mỗi đề xuất đúng một dòng bắt đầu bằng "#số " (dòng số trần thì "#số" đứng giữa dấu phẩy).
const numbered = (message, seq) => new RegExp(`(^|, )#${seq}(?=[ ,]|$)`, 'm').test(message);
const rowsOf = message => message.split('\n').filter(line => /^#\d+ /.test(line));

test('tin tối có số của MỌI đề xuất (SQL đã đánh dấu cả, không bao giờ hiện lại): dài thì rút rồi bỏ trích nội dung, không bỏ dòng', () => {
  assert.equal(LEARNING_DIGEST_MAX_ITEMS, 10);
  // Review #391: 10 đề xuất tiêu đề 136, nội dung 300 (SQL cắt 300; prod có tiêu đề 136, nội dung 867) — bản cũ chỉ liệt kê 6 số.
  for (const kind of ['skill_crm_write', 'memory_crm_write', 'audit_warning']) {
    const long = Array.from({ length: LEARNING_DIGEST_MAX_ITEMS }, (_, n) => item(9_999_990 + n, { kind, title: 't'.repeat(136), content: 'x'.repeat(300) }));
    const message = formatLearningDigest({ proposals: long, pendingTotal: 25, webOrigin: 'https://crm.example.vn', date: new Date('2026-11-05T14:00:00Z') });
    assert.ok(Array.from(message).length <= 1800, kind);
    assert.deepEqual(rowsOf(message).map(line => Number(/^#(\d+) /.exec(line)[1])), long.map(proposal => proposal.seq), `${kind}: mỗi số một dòng, đủ 10`);
    assert.ok(rowsOf(message).every(line => line.includes(` — ${'t'.repeat(89)}…`)), `${kind}: tiêu đề giữ`);
    assert.doesNotMatch(message, /đề xuất mới khác|đề xuất cũ/);
    assert.match(message, /\nCòn 15 đề xuất khác đang chờ duyệt \(xem trên web\)\.\n/);
  }
  // Rút trích trước khi bỏ: còn chỗ cho trích ngắn hơn thì giữ trích ngắn hơn (không nhảy thẳng xuống bỏ trích).
  const medium = Array.from({ length: LEARNING_DIGEST_MAX_ITEMS }, (_, n) => item(n + 1, { title: 'Tiêu đề ngắn', content: 'y'.repeat(300) }));
  const shorter = rowsOf(formatLearningDigest({ proposals: medium, pendingTotal: 10 }));
  assert.equal(shorter.length, 10);
  for (const line of shorter) {
    const excerpt = /: «(y+)…»$/.exec(line);
    assert.ok(excerpt && excerpt[1].length < 139 && excerpt[1].length >= 59, line);
  }
  // Ngắn thì giữ nguyên trích 140.
  assert.match(formatLearningDigest({ proposals: [item(1, { content: 'z'.repeat(300) })], pendingTotal: 1 }), new RegExp(`: «${'z'.repeat(139)}…»`));
});

test('tin tối: vẫn dài sau khi bỏ trích (origin rất dài) ⇒ dòng số trần có đủ mọi số; quá 10 đề xuất ⇒ lỗi (SQL không bao giờ trả quá)', () => {
  const long = Array.from({ length: LEARNING_DIGEST_MAX_ITEMS }, (_, n) => item(106 + n, { kind: 'audit_warning', title: 't'.repeat(200), content: 'x'.repeat(300) }));
  const webOrigin = `https://${'a'.repeat(600)}.example.vn`;
  const message = formatLearningDigest({ proposals: long, pendingTotal: 10, webOrigin });
  const lines = message.split('\n');
  assert.equal(lines[1], `${long.map(proposal => `#${proposal.seq}`).join(', ')} — nội dung xem trên web.`);
  assert.equal(rowsOf(message).length, 0);
  for (const proposal of long) assert.ok(numbered(message, proposal.seq), `#${proposal.seq}`);
  assert.ok(Array.from(message).length <= 1800);
  assert.equal(lines.at(-1), `Xem kỹ: ${webOrigin}${LEARNING_REVIEW_PATH}`);
  // Mọi cỡ 1–10 đề xuất dài: đủ số.
  for (let count = 1; count <= LEARNING_DIGEST_MAX_ITEMS; count++) {
    const some = long.slice(0, count);
    const text = formatLearningDigest({ proposals: some, pendingTotal: 30, webOrigin: 'https://crm.example.vn' });
    for (const proposal of some) assert.ok(numbered(text, proposal.seq), `${count}: #${proposal.seq}`);
    assert.ok(Array.from(text).length <= 1800, String(count));
  }
  assert.throws(() => formatLearningDigest({ proposals: Array.from({ length: LEARNING_DIGEST_MAX_ITEMS + 1 }, (_, n) => item(n + 1)), pendingTotal: 11 }),
    /invalid_learning_digest/);
  assert.throws(() => formatLearningDigest({ proposals: [item(1)], pendingTotal: 0 }), /invalid_learning_digest/);
  assert.throws(() => formatLearningDigest({ proposals: [item(1)], pendingTotal: 1, webOrigin: 'http://crm.example.vn' }), /invalid_learning_digest/);
  assert.throws(() => formatLearningDigest({ proposals: [{ ...item(1), kind: 'preference' }], pendingTotal: 1 }), /invalid_learning_digest/);
});

test('đọc câu trả lời của chủ thành tham số learning.decide', () => {
  assert.deepEqual(parseLearningReply('duyệt 1,3'), { decision: 'approve', numbers: [1, 3], note: null });
  assert.deepEqual(parseLearningReply('Duyệt #3 và #1'), { decision: 'approve', numbers: [1, 3], note: null });
  assert.deepEqual(parseLearningReply('duyet 4-6'), { decision: 'approve', numbers: [4, 5, 6], note: null });
  assert.deepEqual(parseLearningReply('duyệt 1-3, 2'), { decision: 'approve', numbers: [1, 2, 3], note: null }, 'số trùng khử như connector');
  assert.deepEqual(parseLearningReply('bỏ 2 vì sai quy trình thu cọc'), { decision: 'reject', numbers: [2], note: 'sai quy trình thu cọc' });
  assert.deepEqual(parseLearningReply('Bỏ 2: phải dùng phiếu cọc giữ chỗ'), { decision: 'reject', numbers: [2], note: 'phải dùng phiếu cọc giữ chỗ' });
  assert.deepEqual(parseLearningReply('không duyệt 5'), { decision: 'reject', numbers: [5], note: null });
  assert.deepEqual(parseLearningReply('ok 9'), { decision: 'approve', numbers: [9], note: null });
});

test('câu mơ hồ trả null để bot hỏi lại, không đoán', () => {
  for (const text of ['duyệt', 'duyệt hết', 'duyệt 1 bỏ 2', 'bot ơi duyệt 1', 'xem 1', 'duyệt 5-3', 'duyệt 1-40', 'bỏ 0', '', '   ', 42,
    `duyệt 1 vì ${'x'.repeat(520)}`]) {
    assert.equal(parseLearningReply(text), null, String(text).slice(0, 40));
  }
});
