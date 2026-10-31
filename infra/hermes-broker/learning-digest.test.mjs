import assert from 'node:assert/strict';
import test from 'node:test';
import { formatLearningDigest, LEARNING_REVIEW_PATH, parseLearningReply } from './learning-digest.mjs';

const item = (seq, extra = {}) => ({ seq, kind: 'skill_crm_write', title: `Skill crm-task-management: curator sửa — bài học ghi CRM ${seq}`,
  content: 'For task creation, first rediscover crm_task_create and crm_task_input_options before creating a task.', ...extra });

test('tin tối: đánh số theo seq, báo đề xuất cũ, cách trả lời và link trang duyệt', () => {
  const message = formatLearningDigest({ proposals: [item(7), item(5, { kind: 'memory_crm_write', title: 'Bộ nhớ MEMORY.md: tạo phiếu thu' })],
    pendingTotal: 4, webOrigin: 'https://crm.example.vn', date: new Date('2026-10-31T14:00:00Z') });
  const lines = message.split('\n');
  assert.equal(lines[0], 'Bài học Hermes chờ duyệt (31/10): 2 đề xuất mới về cách ghi dữ liệu CRM.');
  assert.match(lines[1], /^#5 Bộ nhớ — Bộ nhớ MEMORY\.md: tạo phiếu thu: «For task creation/);
  assert.match(lines[2], /^#7 Skill — /);
  assert.equal(lines[3], 'Còn 2 đề xuất cũ đang chờ.');
  assert.match(lines[4], /^Trả lời "duyệt 5" hoặc "bỏ 5"/);
  assert.equal(lines[5], `Xem kỹ: https://crm.example.vn${LEARNING_REVIEW_PATH}`);
  assert.equal(formatLearningDigest({ proposals: [], pendingTotal: 3 }), null);
  assert.match(formatLearningDigest({ proposals: [item(1)], pendingTotal: 1 }), /Xem kỹ: \/settings\/hermes\?tab=bai-hoc$/);
});

test('tin tối không vượt giới hạn một tin: tối đa 10 dòng, phần dư dồn vào một dòng', () => {
  const many = Array.from({ length: 14 }, (_, n) => item(n + 1, { content: 'x'.repeat(400), title: 't'.repeat(300) }));
  const message = formatLearningDigest({ proposals: many, pendingTotal: 14, webOrigin: 'https://crm.example.vn' });
  assert.ok(Array.from(message).length <= 1800);
  assert.match(message, /… và \d+ đề xuất mới khác \(xem trên web\)\./);
  assert.match(message, /Xem kỹ: https:\/\/crm\.example\.vn\/settings\/hermes\?tab=bai-hoc$/);
  assert.throws(() => formatLearningDigest({ proposals: [item(1)], pendingTotal: 0 }), /invalid_learning_digest/);
  assert.throws(() => formatLearningDigest({ proposals: [item(1)], pendingTotal: 1, webOrigin: 'http://crm.example.vn' }), /invalid_learning_digest/);
  assert.throws(() => formatLearningDigest({ proposals: [{ ...item(1), kind: 'preference' }], pendingTotal: 1 }), /invalid_learning_digest/);
});

test('đọc câu trả lời của chủ thành tham số learning.decide', () => {
  assert.deepEqual(parseLearningReply('duyệt 1,3'), { decision: 'approve', numbers: [1, 3], note: null });
  assert.deepEqual(parseLearningReply('Duyệt #3 và #1'), { decision: 'approve', numbers: [1, 3], note: null });
  assert.deepEqual(parseLearningReply('duyet 4-6'), { decision: 'approve', numbers: [4, 5, 6], note: null });
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
