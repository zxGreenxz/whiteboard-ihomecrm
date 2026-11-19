// Test hàm thuần của send-push: data trong payload (hợp đồng plan 2026-10-21 §4) và quy tắc DUPLICATE.
import assert from 'node:assert/strict';
import {
  buildPushData,
  buildPushPayload,
  decideExistingIdempotencyKey,
  MAX_DATA_NOTIFICATION_IDS,
  SENDING_FRESH_MS,
  utf8len,
} from './policy.ts';

const ORG = '0e5d1f9a-3c2b-4a1d-9f00-112233445566';
const USER = '7a7a7a7a-0000-4000-8000-000000000001';
const OTHER = '7a7a7a7a-0000-4000-8000-000000000002';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-21T08:00:00Z');

// ── data ─────────────────────────────────────────────────────────────────────────────────────

Deno.test('data gộp body.data + notificationIds (≤20 UUID hợp lệ, bỏ trùng) + organizationId', () => {
  const ids = [uuid(1), 'khong-phai-uuid', uuid(1), ...Array.from({ length: 30 }, (_, i) => uuid(i + 2))];
  const data = buildPushData({ data: { kind: 'E1', organizationId: ORG }, notificationIds: ids });
  assert.equal(data.kind, 'E1');
  assert.equal(data.organizationId, ORG);
  const picked = data.notificationIds as string[];
  assert.equal(picked.length, MAX_DATA_NOTIFICATION_IDS);
  assert.equal(picked[0], uuid(1));
  assert.equal(new Set(picked).size, picked.length);
  assert.ok(!picked.includes('khong-phai-uuid'));
});

Deno.test('notificationIds lấy từ body.data khi body.notificationIds rỗng; organizationId ở body thắng data', () => {
  const data = buildPushData({ notificationIds: [], organizationId: ORG, data: { notificationIds: [uuid(9)], organizationId: uuid(99) } });
  assert.deepEqual(data, { notificationIds: [uuid(9)], organizationId: ORG });
});

Deno.test('giá trị sai kiểu bị bỏ, không ném: data là mảng, org không phải UUID', () => {
  assert.deepEqual(buildPushData({ data: [1, 2], organizationId: 'org-1' }), {});
  assert.deepEqual(buildPushData({ data: { organizationId: 42, notificationIds: 'x' } }), {});
});

// ── payload + trần byte ──────────────────────────────────────────────────────────────────────

const base = { title: 'Phiếu chờ duyệt', url: '/approvals', tag: 'crm-1', icon: '/pwa-192.png', badge: '/pwa-192.png' };

Deno.test('payload dưới trần giữ nguyên và mang data cho service worker', () => {
  const data = buildPushData({ notificationIds: [uuid(1)], organizationId: ORG });
  const built = buildPushPayload({ ...base, body: 'Có 1 phiếu', data }, 3500);
  assert.deepEqual(JSON.parse(built.payload), { ...base, body: 'Có 1 phiếu', data: { notificationIds: [uuid(1)], organizationId: ORG } });
  assert.deepEqual([built.truncatedBody, built.droppedNotificationIds], [false, 0]);
});

Deno.test('quá trần ⇒ cắt notificationIds TRƯỚC, nội dung còn nguyên nếu đủ chỗ', () => {
  const data = buildPushData({ notificationIds: Array.from({ length: 20 }, (_, i) => uuid(i + 1)), organizationId: ORG });
  const body = 'Nội dung tiếng Việt có dấu '.repeat(4);
  const full = buildPushPayload({ ...base, body, data }, 100_000);
  const limit = full.bytes - 200; // thiếu ~200 byte ⇒ đủ bớt vài id là vừa
  const built = buildPushPayload({ ...base, body, data }, limit);
  assert.ok(built.bytes <= limit);
  assert.equal(built.truncatedBody, false);
  assert.ok(built.droppedNotificationIds > 0 && built.droppedNotificationIds < 20);
  const parsed = JSON.parse(built.payload);
  assert.equal(parsed.body, body);
  assert.equal(parsed.data.organizationId, ORG);
});

Deno.test('nội dung quá dài ⇒ bỏ hết id rồi cắt nội dung có dấu …, payload vừa trần', () => {
  const data = buildPushData({ notificationIds: [uuid(1), uuid(2)], organizationId: ORG });
  const built = buildPushPayload({ ...base, body: 'Ồ'.repeat(5000), data }, 3500);
  assert.ok(built.bytes <= 3500);
  assert.equal(built.bytes, utf8len(built.payload));
  assert.equal(built.truncatedBody, true);
  assert.equal(built.droppedNotificationIds, 2);
  const parsed = JSON.parse(built.payload);
  assert.ok(String(parsed.body).endsWith('…'));
  assert.deepEqual(parsed.data, { organizationId: ORG });
});

// ── DUPLICATE hay gửi lại ────────────────────────────────────────────────────────────────────

const log = (outcome: unknown, ageMs: number, user: unknown = USER) =>
  ({ outcome, created_at: new Date(NOW - ageMs).toISOString(), user_id: user });

Deno.test('lượt trước SENT/PARTIAL ⇒ DUPLICATE (dịch vụ push đã nhận, gửi lại là trùng)', () => {
  assert.equal(decideExistingIdempotencyKey(log('SENT', 60_000), USER, NOW), 'duplicate');
  assert.equal(decideExistingIdempotencyKey(log('PARTIAL', 3_600_000), USER, NOW), 'duplicate');
});

Deno.test('SENDING trong 15 phút ⇒ DUPLICATE; quá 15 phút ⇒ giành lại', () => {
  assert.equal(decideExistingIdempotencyKey(log('SENDING', SENDING_FRESH_MS - 1000), USER, NOW), 'duplicate');
  assert.equal(decideExistingIdempotencyKey(log('SENDING', SENDING_FRESH_MS + 1000), USER, NOW), 'reclaim');
  assert.equal(decideExistingIdempotencyKey({ outcome: 'SENDING', created_at: 'không phải ngày', user_id: USER }, USER, NOW), 'duplicate');
});

Deno.test('lượt trước lỗi hoặc không thiết bị ⇒ giành lại khoá để gửi lại (không còn SENT giả)', () => {
  for (const outcome of ['ALL_FAILED', 'PROVIDER_ERROR', 'NO_DEVICE']) {
    assert.equal(decideExistingIdempotencyKey(log(outcome, 1000), USER, NOW), 'reclaim', outcome);
  }
});

Deno.test('khoá thuộc người khác ⇒ conflict, không gửi; so UUID không phân biệt hoa thường', () => {
  assert.equal(decideExistingIdempotencyKey(log('ALL_FAILED', 1000, OTHER), USER, NOW), 'conflict');
  assert.equal(decideExistingIdempotencyKey(log('SENT', 1000, null), USER, NOW), 'conflict');
  assert.equal(decideExistingIdempotencyKey(log('ALL_FAILED', 1000, USER.toUpperCase()), USER, NOW), 'reclaim');
});
