// Đột biến cho check-rpc-arg-names.
//
// Ba ca đầu tiên là ba cách bộ dò này TỪNG sai trên mã thật của repo, mỗi cái
// đều làm gate báo oan một lời gọi hoàn toàn đúng. Chúng ở đây để lần sửa sau
// không vô tình khôi phục lại lỗi cũ.

import assert from 'node:assert/strict';
import test from 'node:test';

import { catObjectLiteral, docChuKy, doiChieu, khoaCapMot } from '../check-rpc-arg-names.mjs';

// ── Ba lỗ đã dính ────────────────────────────────────────────────────────────

test('CHÚ THÍCH chen giữa hai khoá không được nuốt khoá sau nó', () => {
  // Nguyên mẫu: src/hooks/useSpecialFeeBatch.ts
  const than = `
    p_period: a.period,
    // Khoá chống phát lại: gắn theo kỳ + tập toà + mốc phút.
    p_idempotency_key: \`sf-\${a.period}\`,
  `;
  assert.deepEqual(khoaCapMot(than), ['p_period', 'p_idempotency_key']);
});

test('VIẾT TẮT `{ p }` là khoá `p`, không phải không có khoá nào', () => {
  // Nguyên mẫu: src/lib/luckyDrawApi.ts
  assert.deepEqual(khoaCapMot(' p '), ['p']);
});

test('SPREAD ⇒ null (KHÔNG ĐO ĐƯỢC), tuyệt đối không phải "thiếu tham số"', () => {
  // Nguyên mẫu: src/hooks/usePublicRoomsAnalytics.ts. Bản đầu tiên của gate coi
  // đây là vi phạm và báo 7 lỗi giả.
  assert.equal(khoaCapMot(' ...baseParams(f), p_bucket: bucket '), null);
});

// ── Đọc chữ ký server ────────────────────────────────────────────────────────

test('DEFAULT tách được bắt buộc khỏi tuỳ chọn', () => {
  const r = docChuKy('p_start_date date, p_token text DEFAULT NULL::text');
  assert.deepEqual(r.tatCa, ['p_start_date', 'p_token']);
  assert.deepEqual(r.batBuoc, ['p_start_date']);
});

test('dấu phẩy TRONG kiểu không đẻ ra tham số ma', () => {
  // `numeric(12,2)` cắt thô sẽ sinh một tham số tên `2`.
  const r = docChuKy('p_amount numeric(12,2), p_note text');
  assert.deepEqual(r.tatCa, ['p_amount', 'p_note']);
});

test('VARIADIC / INOUT vẫn lấy đúng tên', () => {
  assert.deepEqual(docChuKy('VARIADIC p_ids uuid[]').tatCa, ['p_ids']);
  assert.deepEqual(docChuKy('INOUT p_state jsonb').tatCa, ['p_state']);
});

test('chữ ký rỗng ⇒ không tham số nào, không nổ', () => {
  assert.deepEqual(docChuKy('').tatCa, []);
  assert.deepEqual(docChuKy(null).batBuoc, []);
});

// ── Cắt object literal ───────────────────────────────────────────────────────

test('object LỒNG không làm bộ cắt dừng sớm', () => {
  const s = `rpc('x', { p_payload: { a: 1 }, p_b: 2 })`;
  const than = catObjectLiteral(s, s.indexOf(',') + 1);
  assert.deepEqual(khoaCapMot(than), ['p_payload', 'p_b']);
});

test('đối số không phải object literal ⇒ null', () => {
  const s = `rpc('x', thamSo)`;
  assert.equal(catObjectLiteral(s, s.indexOf(',') + 1), null);
});

// ── Đối chiếu ────────────────────────────────────────────────────────────────

const DN = (args) => [{ args }];

test('khớp đủ ⇒ đạt', () => {
  assert.equal(doiChieu(['p_a'], DN('p_a uuid')).dat, true);
});

test('ĐỘT BIẾN: tên thừa ⇒ hỏng (đây là PGRST202, không phải bỏ qua một trường)', () => {
  const r = doiChieu(['p_a', 'p_sai'], DN('p_a uuid'));
  assert.equal(r.dat, false);
  assert.deepEqual(r.lyDo[0].la, ['p_sai']);
});

test('ĐỘT BIẾN: thiếu tham số BẮT BUỘC ⇒ hỏng', () => {
  const r = doiChieu(['p_b'], DN('p_a uuid, p_b text'));
  assert.equal(r.dat, false);
  assert.deepEqual(r.lyDo[0].thieu, ['p_a']);
});

test('thiếu tham số CÓ DEFAULT ⇒ vẫn đạt', () => {
  assert.equal(doiChieu(['p_a'], DN('p_a uuid, p_b text DEFAULT NULL::text')).dat, true);
});

test('hàm nạp chồng: khớp MỘT overload là đủ — đúng cách Postgres phân giải', () => {
  const dn = [{ args: 'p_a uuid' }, { args: 'p_a uuid, p_b text' }];
  assert.equal(doiChieu(['p_a', 'p_b'], dn).dat, true);
  assert.equal(doiChieu(['p_a'], dn).dat, true);
});

test('nạp chồng mà không overload nào khớp ⇒ hỏng, và kể ra CẢ HAI chữ ký', () => {
  const dn = [{ args: 'p_a uuid' }, { args: 'p_b text' }];
  const r = doiChieu(['p_c'], dn);
  assert.equal(r.dat, false);
  assert.equal(r.lyDo.length, 2);
});

test('gọi không tham số một hàm KHÔNG có tham số bắt buộc ⇒ đạt', () => {
  assert.equal(doiChieu([], DN('p_a text DEFAULT NULL::text')).dat, true);
});

test('ĐỘT BIẾN: gọi không tham số một hàm CÓ tham số bắt buộc ⇒ hỏng', () => {
  assert.equal(doiChieu([], DN('p_a uuid')).dat, false);
});
