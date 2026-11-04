import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionCatalog, validateActionParams } from './action-catalog.mjs';
import { HERMES_CAPABILITIES, HERMES_LEARNING_ACTION_KEYS } from './capability-contract.mjs';
import { LEARNING_ACTIONS, LEARNING_DECIDE, LEARNING_DIGEST, LEARNING_REVIEW_KEY, learningPresenters, presentLearningDigest } from './learning-action-contract.mjs';
import { formatLearningDigest, parseLearningReply } from './learning-digest.mjs';

// Trang Bài học (đợt 3 học có kiểm duyệt, docs/plans/hermes-crm/HOC-CO-KIEM-DUYET.md mục 4): khai thao tác, khuôn tham số khớp bộ đọc câu
// trả lời "duyệt 1,3", và bộ dựng tin tối tất định từ kết quả SQL.
const SQL = { announcedAt: '2026-11-04T14:00:00.123456Z', pendingTotal: 4, items: [
  { seq: 9, kind: 'audit_warning', title: 'Cảnh báo kiểm học: tên tool chết', content: 'crm_task_create không còn; dùng task.create.' },
  { seq: 3, kind: 'skill_crm_write', title: 'Skill crm-task-management', content: 'Gọi crm_action_run task.create.' }] };

test('khai: hai thao tác trang learning, cùng khoá riêng Hermes, một RPC trang; khoá có trong hợp đồng quyền', () => {
  assert.deepEqual(LEARNING_ACTIONS.map(action => [action.id, action.page, action.key, action.class, action.rpc]), [
    ['learning.digest', 'learning', 'assistant.learning_review', 'reversible', 'hermes_learning_action_v1'],
    ['learning.decide', 'learning', 'assistant.learning_review', 'reversible', 'hermes_learning_action_v1']]);
  assert.equal(LEARNING_REVIEW_KEY, HERMES_LEARNING_ACTION_KEYS[0]);
  assert.deepEqual(HERMES_CAPABILITIES[LEARNING_REVIEW_KEY], { mode: 'action', resource: 'organization' });
  const catalog = createActionCatalog(LEARNING_ACTIONS);
  assert.deepEqual([catalog.keys, catalog.rpcs, catalog.pages], [['assistant.learning_review'], ['hermes_learning_action_v1'], ['learning']]);
  assert.deepEqual(LEARNING_DIGEST.params, {});
  assert.match(LEARNING_DIGEST.title, /^Chỉ job tin tối 21:00 gọi/);
  assert.deepEqual([...LEARNING_DECIDE.reasons], ['learning_not_pending']);
  const listed = catalog.listing({ read: [], action: ['assistant.learning_review'] }).find(item => item.action === 'learning.decide');
  assert.deepEqual(Object.keys(listed.params), ['numbers', 'decision', 'note']);
  assert.deepEqual([listed.params.numbers.min, listed.params.numbers.max, listed.params.decision.values], [1, 20, ['approve', 'reject']]);
});

test('khuôn learning.decide nhận đúng đầu ra của bộ đọc "duyệt 1,3" / "bỏ 2 vì …"; câu mơ hồ không thành tham số', () => {
  for (const [reply, value] of [['duyệt 1,3', { numbers: [1, 3], decision: 'approve' }], ['duyet 4-6', { numbers: [4, 5, 6], decision: 'approve' }],
    ['bỏ 2 vì sai quy trình thu cọc', { numbers: [2], decision: 'reject', note: 'sai quy trình thu cọc' }]]) {
    const checked = validateActionParams(LEARNING_DECIDE, parseLearningReply(reply));
    assert.deepEqual(checked, { ok: true, value }, reply);
  }
  for (const reply of ['duyệt hết', 'duyệt 1 bỏ 2', 'xem 1']) assert.equal(parseLearningReply(reply), null, reply);
  // Ngoài khuôn ⇒ needs_input (không gọi SQL): số 0 / quá 20 số / quá 7 chữ số / quyết định lạ / ghi chú xuống dòng hay quá 500 ký tự.
  for (const params of [{ numbers: [], decision: 'approve' }, { numbers: [0], decision: 'approve' }, { numbers: Array.from({ length: 21 }, (_, n) => n + 1), decision: 'approve' },
    { numbers: [10_000_000], decision: 'approve' }, { numbers: [1], decision: 'maybe' }, { numbers: [1] },
    { numbers: [1], decision: 'reject', note: 'dòng 1\ndòng 2' }, { numbers: [1], decision: 'reject', note: 'x'.repeat(501) }, { numbers: [1], decision: 'approve', extra: 1 }])
    assert.equal(validateActionParams(LEARNING_DECIDE, params).ok, false, JSON.stringify(params).slice(0, 80));
  assert.equal(validateActionParams(LEARNING_DIGEST, {}).ok, true);
  assert.equal(validateActionParams(LEARNING_DIGEST, { force: true }).ok, false);
});

test('tin tối: message tất định từ kết quả SQL (ngày = announcedAt, link theo origin host), không chuyển nội dung đề xuất', () => {
  const shown = presentLearningDigest(SQL, { webOrigin: 'https://app.example.vn' });
  assert.deepEqual(shown, { message: formatLearningDigest({ proposals: SQL.items, pendingTotal: 4, webOrigin: 'https://app.example.vn', date: new Date(SQL.announcedAt) }),
    newCount: 2, numbers: [9, 3], pendingTotal: 4 });
  assert.match(shown.message, /^Bài học Hermes chờ duyệt \(04\/11\): 2 đề xuất mới về cách ghi dữ liệu CRM\.\n#3 Skill/);
  assert.match(shown.message, /Còn 2 đề xuất cũ đang chờ\./);
  assert.deepEqual(presentLearningDigest(structuredClone(SQL), { webOrigin: 'https://app.example.vn' }), shown, 'cùng kết quả SQL ⇒ cùng tin');
  assert.match(presentLearningDigest(SQL).message, /Xem kỹ: \/settings\/hermes\?tab=bai-hoc$/, 'không có origin ⇒ chỉ đường dẫn');
  assert.deepEqual(presentLearningDigest({ ...SQL, items: [] }), { message: null, newCount: 0, numbers: [], pendingTotal: 4 }, 'không mục mới ⇒ null');
  for (const bad of [{ ...SQL, extra: 1 }, { ...SQL, announcedAt: '2026-11-04T14:00:00Z' }, { ...SQL, pendingTotal: 1 }, { ...SQL, pendingTotal: '4' },
    { ...SQL, items: Array.from({ length: 21 }, (_, n) => ({ ...SQL.items[0], seq: n + 1 })) }, { ...SQL, items: [{ ...SQL.items[0], kind: 'preference' }] },
    { ...SQL, items: [{ ...SQL.items[0], extra: 1 }] }, { ...SQL, items: [{ ...SQL.items[0], seq: 0 }] }, { announcedAt: SQL.announcedAt, pendingTotal: 4 }, null, []])
    assert.throws(() => presentLearningDigest(bad), TypeError, JSON.stringify(bad)?.slice(0, 80));
});

test('learningPresenters: kiểm origin lúc dựng (origin tin tối không nhận ⇒ không khởi động); chỉ khai learning.digest', () => {
  const presenters = learningPresenters({ webOrigin: 'https://app.example.vn' });
  assert.deepEqual(Object.keys(presenters), ['learning.digest']);
  assert.equal(presenters['learning.digest'](SQL).message, presentLearningDigest(SQL, { webOrigin: 'https://app.example.vn' }).message);
  assert.equal(learningPresenters()['learning.digest'](SQL).message, presentLearningDigest(SQL).message);
  for (const webOrigin of ['http://app.example.vn', 'https://app.example.vn/', 'https://[::1]', 'app.example.vn'])
    assert.throws(() => learningPresenters({ webOrigin }), TypeError, webOrigin);
});
