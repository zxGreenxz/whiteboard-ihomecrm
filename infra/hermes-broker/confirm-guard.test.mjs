import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CONFIRM_MAX_PENDING, CONFIRM_TOKEN, CONFIRM_TOKEN_NEAR, CONFIRM_TTL_MS, confirmBinding, createConfirmStore, splitConfirmField } from './confirm-guard.mjs';

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

// Nghiệm thu Sale phòng 08/11: bulk_patch bị confirmation_invalid vì khoá trong từng phần tử items[] được băm theo thứ tự mô hình gửi.
const nested = () => ({ requestId: 'r', items: [
  { roomId: 'r1', sale_note: 'A', amenities: ['Wifi', 'Máy lạnh'], meta: { a: 1, b: [{ x: 1, y: null }] } },
  { roomId: 'r2', rent_price: 1000 },
] });
const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value !== null && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reverseKeys(value[key])])) : value;
const bindNested = value => confirmBinding(['conn', 'crm_sale_bulk_patch', 'r', value]);

test('khoá binding chuẩn hoá khoá ĐỆ QUY: đảo khoá ở mọi cấp ⇒ cùng khoá, thứ tự phần tử mảng giữ nguyên, không đụng đầu vào', () => {
  const input = nested(), reversed = reverseKeys(input), snapshot = JSON.stringify(input);
  assert.notEqual(JSON.stringify(reversed), snapshot, 'phép đảo phải đổi thứ tự khoá thật');
  assert.deepEqual(reversed, input, 'phép đảo không đổi nội dung');
  assert.equal(bindNested(reversed), bindNested(input));
  assert.equal(bindNested({ items: input.items, requestId: 'r' }), bindNested(input), 'đảo khoá ngoài');
  assert.equal(bindNested({ ...input, items: [{ ...reverseKeys(input.items[0]) }, input.items[1]] }), bindNested(input), 'đảo khoá của một phần tử');
  assert.equal(JSON.stringify(input), snapshot, 'băm không sửa đầu vào');
  assert.notEqual(confirmBinding(['a', 'b']), confirmBinding(['b', 'a']), 'thứ tự các phần giữ nguyên');
  // crm_action_run băm [kết nối, thao tác, canonicalJson(params), requestId]: phần toàn chuỗi ra đúng khoá như cũ.
  const strings = ['conn', 'expense.create', '{"amount":1}', 'req-1'];
  assert.equal(confirmBinding(strings), createHash('sha256').update(JSON.stringify(strings)).digest('hex'));
});

test('khoá binding: đổi giá trị / kiểu lồng, thêm / bớt / dời khoá lồng, đảo phần tử mảng ⇒ khác khoá', () => {
  const original = bindNested(nested());
  for (const [label, mutate] of [
    ['đổi chuỗi lồng', x => { x.items[0].sale_note = 'B'; }],
    ['đổi số ở cấp sâu', x => { x.items[0].meta.b[0].x = 2; }],
    ['đổi kiểu: số thành chuỗi', x => { x.items[1].rent_price = '1000'; }],
    ['đổi kiểu: số thành boolean', x => { x.items[0].meta.a = true; }],
    ['null thành chuỗi rỗng', x => { x.items[0].meta.b[0].y = ''; }],
    ['null thành vắng', x => { delete x.items[0].meta.b[0].y; }],
    ['thêm khoá lồng', x => { x.items[1].description = 'C'; }],
    ['thêm khoá lồng giá trị null', x => { x.items[1].area = null; }],
    ['bớt khoá lồng', x => { delete x.items[1].rent_price; }],
    ['dời khoá sang phần tử khác', x => { x.items[1].sale_note = x.items[0].sale_note; delete x.items[0].sale_note; }],
    ['đảo phần tử mảng object', x => { x.items.reverse(); }],
    ['đảo phần tử mảng chuỗi', x => { x.items[0].amenities.reverse(); }],
    ['thêm khoá __proto__ từ JSON', x => { x.items[1] = JSON.parse('{"roomId":"r2","rent_price":1000,"__proto__":{"a":1}}'); }],
  ]) {
    const changed = nested();
    mutate(changed);
    assert.notEqual(bindNested(changed), original, label);
    assert.notEqual(bindNested(reverseKeys(changed)), original, `${label} (kèm đảo khoá)`);
  }
});

test('khoá binding: NFC khác NFD, {} khác [], ranh giới giữa các phần không mờ', () => {
  const [nfc, nfd] = ['Phòng'.normalize('NFC'), 'Phòng'.normalize('NFD')];
  assert.notEqual(nfc, nfd, 'hai dạng phải khác byte thật');
  assert.notEqual(confirmBinding(['a', nfc]), confirmBinding(['a', nfd]), 'giá trị NFC / NFD');
  assert.notEqual(confirmBinding([{ [nfc]: 1 }]), confirmBinding([{ [nfd]: 1 }]), 'khoá NFC / NFD');
  assert.notEqual(confirmBinding(['a', {}]), confirmBinding(['a', []]), '{} với []');
  assert.notEqual(confirmBinding([{ x: {} }]), confirmBinding([{ x: [] }]), '{} với [] lồng');
  for (const [left, right] of [[['ab', 'c'], ['a', 'bc']], [['a', 'b'], ['a,b']], [['a', ['b']], [['a'], 'b']], [['a', 'b'], ['a', 'b', null]], [['a', null], ['a']]])
    assert.notEqual(confirmBinding(left), confirmBinding(right), JSON.stringify([left, right]));
});

test('token dùng một lần: khớp thì trả payload một lần; trình lại, sai khoá hay sai dạng đều từ chối và token mất', () => {
  const { guard } = store();
  const issued = guard.issue(A, { resolved: { roomId: 'r1' }, basis: 'b1' });
  assert.match(issued.token, CONFIRM_TOKEN);
  assert.equal(issued.expiresAt, new Date(START + CONFIRM_TTL_MS).toISOString());
  assert.deepEqual(guard.redeem(issued.token, A), { ok: true, payload: { resolved: { roomId: 'r1' }, basis: 'b1' }, issuedAt: START });
  assert.deepEqual(guard.redeem(issued.token, A), { ok: false, why: 'unknown' }, 'đã dùng');
  // Sai khoá (khác kết nối/nội dung): từ chối, và token cũng mất — không thử lại được bằng khoá đúng. Lượt 14: kèm lý do + payload của bản
  // ghi chờ (người gọi nói đúng phần lệch; payload không tới mô hình).
  const other = guard.issue(A, { requestId: 'r-1' });
  assert.deepEqual(guard.redeem(other.token, B), { ok: false, why: 'mismatch', payload: { requestId: 'r-1' } });
  assert.deepEqual(guard.redeem(other.token, A), { ok: false, why: 'unknown' }, 'trình ra là mất');
  for (const bad of [undefined, null, 'cf_short', `cf_${'x'.repeat(42)}!`, `hc_${'x'.repeat(43)}`]) assert.deepEqual(guard.redeem(bad, A), { ok: false, why: 'unknown' });
  assert.equal(guard.size, 0);
});

test('lượt 16: khoá dạng hàm dựng từ payload của bản ghi chờ — vẫn phải trùng đúng khoá lúc cấp; hàm ném / trả không phải chuỗi ⇒ lệch', () => {
  const { guard } = store();
  const key = requestId => confirmBinding(['conn', 'probe.confirm', '{"amount":1}', requestId]);
  const issued = guard.issue(key('r-1'), { requestId: 'r-1' });
  assert.deepEqual(guard.redeem(issued.token, payload => key(payload.requestId)), { ok: true, payload: { requestId: 'r-1' }, issuedAt: START });
  const wrong = guard.issue(key('r-1'), { requestId: 'r-1' });
  assert.deepEqual(guard.redeem(wrong.token, payload => confirmBinding(['conn', 'probe.confirm', '{"amount":2}', payload.requestId])),
    { ok: false, why: 'mismatch', payload: { requestId: 'r-1' } }, 'phần mô hình gửi lệch ⇒ lệch');
  for (const fn of [() => { throw new Error('x'); }, () => null, () => 42]) {
    const token = guard.issue(key('r-1'), { requestId: 'r-1' }).token;
    assert.equal(guard.redeem(token, fn).why, 'mismatch');
  }
  assert.equal(guard.size, 0);
});

test('TTL 10 phút: còn hạn tới đúng trước 10 phút; đúng 10 phút hoặc đồng hồ lùi là hết hạn', () => {
  const { clock, guard } = store();
  const near = guard.issue(A), edge = guard.issue(A), back = guard.issue(A);
  clock.now = START + CONFIRM_TTL_MS - 1;
  assert.equal(guard.redeem(near.token, A).ok, true);
  clock.now = START + CONFIRM_TTL_MS;
  assert.deepEqual(guard.redeem(edge.token, A), { ok: false, why: 'expired' });
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

// C3n (nghiệm thu TC c3m 27/10): mô hình chép lệch token (thiếu ký tự, đổi hoa/thường, thừa ký tự) với params y nguyên.
test('C3n redeemNear: đúng một bản ghi chờ cùng khoá + 8 ký tự đầu (không phân biệt hoa/thường) ⇒ khớp, dùng một lần; còn lại unknown và bản ghi giữ nguyên', () => {
  const swap = text => text.replace(/[a-z]/gi, c => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
  for (const [label, garble] of [['thiếu', token => token.slice(0, 33)], ['hoa/thường', token => `cf_${swap(token.slice(3))}`], ['thừa', token => `${token}x`]]) {
    const { guard } = store();
    const issued = guard.issue(A, { requestId: 'r-1' });
    const near = garble(issued.token);
    assert.match(near, CONFIRM_TOKEN_NEAR, label);
    assert.deepEqual(guard.redeem(near, A), { ok: false, why: 'unknown' }, `${label}: khớp chính xác không thấy`);
    assert.equal(guard.size, 1, `${label}: token lệch không làm mất bản ghi chờ`);
    assert.deepEqual(guard.redeemNear(near, () => A), { ok: true, payload: { requestId: 'r-1' }, issuedAt: START, near: true }, label);
    assert.deepEqual(guard.redeemNear(near, () => A), { ok: false, why: 'unknown' }, `${label}: dùng một lần`);
    assert.deepEqual(guard.redeem(issued.token, A), { ok: false, why: 'unknown' }, `${label}: token đúng cũng hết`);
  }
  const { guard, clock } = store();
  const issued = guard.issue(A, { requestId: 'r-1' });
  const near = issued.token.slice(0, 33);
  for (const [label, supplied, binding] of [
    ['khác khoá', near, () => B], ['hàm khoá ném', near, () => { throw new Error('x'); }], ['khoá không phải hàm', near, A],
    // Ký tự thay phải khác cả khi so không phân biệt hoa/thường (token ngẫu nhiên có thể mở đầu bằng 'q').
    ['8 ký tự đầu khác', `cf_${issued.token[3].toLowerCase() === 'q' ? 'R' : 'Q'}${issued.token.slice(4, 30)}`, () => A],
    ['quá ngắn', issued.token.slice(0, 10), () => A], ['không phải token', `hc_${issued.token.slice(3, 30)}`, () => A], ['không phải chuỗi', 42, () => A]]) {
    assert.deepEqual(guard.redeemNear(supplied, binding), { ok: false, why: 'unknown' }, label);
    assert.equal(guard.size, 1, `${label}: bản ghi chờ giữ nguyên`);
  }
  clock.now += CONFIRM_TTL_MS;
  assert.deepEqual(guard.redeemNear(near, () => A), { ok: false, why: 'unknown' }, 'hết hạn');
  // splitConfirmField: chuỗi "giống token" sai khuôn ⇒ invalid kèm near (người gọi khác bỏ qua near, hành vi cũ giữ nguyên).
  assert.deepEqual(splitConfirmField({ a: 1, confirmToken: near }), { args: { a: 1 }, confirmToken: undefined, invalid: true, near });
  for (const bad of ['cf_short', 'abc', `cf_${'x'.repeat(65)}`]) assert.equal(Object.hasOwn(splitConfirmField({ confirmToken: bad }), 'near'), false, bad);
  assert.equal(Object.hasOwn(splitConfirmField({ confirmToken: issued.token }), 'near'), false, 'token đúng khuôn không mang near');
});

test('rào chữ công khai đi qua module chung: không còn sổ token hay bộ sinh token riêng', () => {
  const source = readFileSync(fileURLToPath(new URL('./public-text-guard.mjs', import.meta.url)), 'utf8');
  assert.match(source, /from '\.\/confirm-guard\.mjs'/);
  assert.doesNotMatch(source, /randomBytes|new Map\(/);
});
