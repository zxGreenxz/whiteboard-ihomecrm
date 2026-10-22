import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIRM_MAX_PENDING, CONFIRM_TOKEN, CONFIRM_TTL_MS, confirmBinding, createConfirmStore, splitConfirmField } from './confirm-guard.mjs';

// Rào xác nhận hai lượt dùng chung (Đợt 1 nền chung, NEN-CHUNG-THAO-TAC-GHI.md mục 3.1). Rào chữ công khai của
// crm_room_pass_upsert đi qua đúng module này (public-text-guard.test.mjs giữ hành vi cũ); thao tác ghi dùng chung
// thêm payload (đầu vào đã giải, dấu trạng thái) mà mô hình không gửi lại được.
const START = Date.parse('2026-10-21T12:00:00.000Z');
const A = confirmBinding(['conn-a', 'probe.confirm', { amount: 1000 }, 'req-1']);
const B = confirmBinding(['conn-b', 'probe.confirm', { amount: 1000 }, 'req-1']);
const store = (extra = {}) => { const clock = { now: START }; return { clock, guard: createConfirmStore({ clock: () => clock.now, ...extra }) }; };

test('hằng số và khoá binding: 10 phút, 1 024 token chờ, token cf_ + 43 ký tự, binding là sha256 của JSON các phần', () => {
  assert.equal(CONFIRM_TTL_MS, 600_000);
  assert.equal(CONFIRM_MAX_PENDING, 1024);
  assert.match(A, /^[0-9a-f]{64}$/);
  assert.notEqual(A, B, 'khác kết nối ⇒ khác khoá');
  assert.notEqual(confirmBinding(['a', 'x', { amount: 1000 }]), confirmBinding(['a', 'x', { amount: 1001 }]), 'khác nội dung ⇒ khác khoá');
  assert.equal(confirmBinding(['a', 'x', 1]), confirmBinding(['a', 'x', 1]));
  assert.throws(() => createConfirmStore({}), /invalid_confirm_clock/);
  for (const limits of [{ ttlMs: 0 }, { ttlMs: CONFIRM_TTL_MS + 1 }, { maxPending: 0 }, { maxPending: CONFIRM_MAX_PENDING + 1 }, { ttlMs: 1.5 }])
    assert.throws(() => createConfirmStore({ clock: Date.now, ...limits }), /invalid_confirm_limits/, JSON.stringify(limits));
  const { guard } = store();
  for (const binding of ['', 'a'.repeat(63), 'A'.repeat(64), null]) assert.throws(() => guard.issue(binding), /invalid_confirm_binding/);
});

test('token dùng một lần: khớp thì trả payload một lần; trình lại, sai khoá hay sai dạng đều từ chối và token mất', () => {
  const { guard } = store();
  const issued = guard.issue(A, { resolved: { roomId: 'r1' }, basis: 'b1' });
  assert.match(issued.token, CONFIRM_TOKEN);
  assert.equal(issued.expiresAt, new Date(START + CONFIRM_TTL_MS).toISOString());
  assert.deepEqual(guard.redeem(issued.token, A), { ok: true, payload: { resolved: { roomId: 'r1' }, basis: 'b1' }, issuedAt: START });
  assert.deepEqual(guard.redeem(issued.token, A), { ok: false }, 'đã dùng');
  // Sai khoá (khác kết nối/nội dung): từ chối, và token cũng mất — không thử lại được bằng khoá đúng.
  const other = guard.issue(A);
  assert.deepEqual(guard.redeem(other.token, B), { ok: false });
  assert.deepEqual(guard.redeem(other.token, A), { ok: false }, 'trình ra là mất');
  for (const bad of [undefined, null, 'cf_short', `cf_${'x'.repeat(42)}!`, `hc_${'x'.repeat(43)}`]) assert.deepEqual(guard.redeem(bad, A), { ok: false });
  assert.equal(guard.size, 0);
});

test('TTL 10 phút: còn hạn tới đúng trước 10 phút; đúng 10 phút hoặc đồng hồ lùi là hết hạn', () => {
  const { clock, guard } = store();
  const near = guard.issue(A), edge = guard.issue(A), back = guard.issue(A);
  clock.now = START + CONFIRM_TTL_MS - 1;
  assert.equal(guard.redeem(near.token, A).ok, true);
  clock.now = START + CONFIRM_TTL_MS;
  assert.equal(guard.redeem(edge.token, A).ok, false);
  clock.now = START - 1;
  assert.equal(guard.redeem(back.token, A).ok, false, 'đồng hồ lùi');
  // `now` của người gọi thắng đồng hồ của sổ (một lần đọc đồng hồ cho cả lượt).
  const given = guard.issue(A, null, START + 5);
  assert.equal(given.issuedAt, START + 5);
  assert.equal(guard.redeem(given.token, A, START + 5 + CONFIRM_TTL_MS - 1).ok, true);
});

test('sổ đầy: dọn token hết hạn trước, còn đầy thì bỏ token cũ nhất', () => {
  const { clock, guard } = store({ maxPending: 3 });
  const first = guard.issue(A), second = guard.issue(A), third = guard.issue(A);
  const fourth = guard.issue(A);
  assert.equal(guard.size, 3);
  assert.equal(guard.redeem(first.token, A).ok, false, 'cũ nhất bị bỏ');
  assert.equal(guard.redeem(second.token, A).ok, true);
  clock.now += CONFIRM_TTL_MS;
  guard.issue(A);
  assert.equal(guard.size, 1, 'token hết hạn được dọn lúc cấp mới');
  assert.equal(guard.redeem(third.token, A).ok, false);
  assert.equal(guard.redeem(fourth.token, A).ok, false);
});

test('tách confirmToken trước validator: giữ descriptor khoá khác; null/rỗng = không gửi; accessor hay sai dạng = invalid', () => {
  const token = `cf_${'x'.repeat(43)}`;
  assert.deepEqual(splitConfirmField({ a: 1, confirmToken: ` ${token} ` }), { args: { a: 1 }, confirmToken: token, invalid: false });
  for (const blank of [null, '', '   ']) assert.deepEqual(splitConfirmField({ a: 1, confirmToken: blank }), { args: { a: 1 }, confirmToken: undefined, invalid: false });
  assert.equal(splitConfirmField({ confirmToken: 'abc' }).invalid, true);
  assert.equal(splitConfirmField({ confirmToken: 42 }).invalid, true);
  const accessor = Object.defineProperty({ a: 1 }, 'confirmToken', { enumerable: true, get: () => token });
  assert.equal(splitConfirmField(accessor).invalid, true);
  const hidden = Object.defineProperty({ a: 1 }, 'confirmToken', { enumerable: false, value: token });
  assert.equal(splitConfirmField(hidden).invalid, true);
  const plain = { a: 1 };
  assert.equal(splitConfirmField(plain).args, plain, 'không có confirmToken ⇒ giữ nguyên đối tượng');
  for (const value of [null, 'x', 7]) assert.deepEqual(splitConfirmField(value), { args: value, confirmToken: undefined, invalid: false });
  // Khoá khác giữ nguyên descriptor (accessor vẫn tới validator để bị từ chối ở đó).
  const withGetter = Object.defineProperty({ confirmToken: token }, 'roomId', { enumerable: true, get: () => 'r' });
  const split = splitConfirmField(withGetter);
  assert.equal(typeof Object.getOwnPropertyDescriptor(split.args, 'roomId').get, 'function');
});

test('rào chữ công khai đi qua module chung: không còn sổ token hay bộ sinh token riêng', () => {
  const source = readFileSync(fileURLToPath(new URL('./public-text-guard.mjs', import.meta.url)), 'utf8');
  assert.match(source, /from '\.\/confirm-guard\.mjs'/);
  assert.doesNotMatch(source, /randomBytes|new Map\(/);
});
