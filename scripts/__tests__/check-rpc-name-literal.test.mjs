// Đột biến cho check-rpc-name-literal.

import assert from 'node:assert/strict';
import test from 'node:test';

import { SAN_LOI_GOI, giaiDuoc, tachLoiGoi } from '../check-rpc-name-literal.mjs';

test('tên viết thẳng được nhận là viết thẳng', () => {
  const r = tachLoiGoi(`supabase.rpc('lay_gi_do_v1', { p_a: 1 })`);
  assert.deepEqual(r.vietThang, ['lay_gi_do_v1']);
  assert.deepEqual(r.an, []);
});

test('ĐỘT BIẾN: tên đi qua biến là CHỖ MÙ, không phải lời gọi hợp lệ bỏ qua', () => {
  // Đây là toàn bộ lý do gate này tồn tại: ba gate RPC kia tìm chuỗi viết thẳng
  // bằng văn bản, nên `supabase.rpc(fn, args)` vô hình với cả ba.
  const r = tachLoiGoi(`supabase.rpc(fn, args)`);
  assert.deepEqual(r.vietThang, []);
  assert.deepEqual(r.an, ['fn']);
});

test('ternary hai chuỗi và tra hằng đều là chỗ mù', () => {
  const r = tachLoiGoi(`supabase.rpc(accrual ? "a_v1" : "b_v1", p); supabase.rpc(RPC.state, q)`);
  assert.equal(r.vietThang.length, 0);
  assert.equal(r.an.length, 2);
});

test('tên trong CHÚ THÍCH không tính là lời gọi', () => {
  // Repo đã bốn lần dính "gate đọc văn kể lại về mã".
  assert.deepEqual(tachLoiGoi(`// đừng viết supabase.rpc(fn) ở đây`).an, []);
  assert.deepEqual(tachLoiGoi(`/* supabase.rpc('x') */`).vietThang, []);
});

test('ternary của hai chuỗi GIẢI ĐƯỢC ra đủ hai tên', () => {
  const g = giaiDuoc(`accrual ? "fa_monthly_pnl_accrual" : "fa_monthly_pnl"`);
  assert.equal(g.kieu, 'ternary');
  assert.deepEqual(g.ten, ['fa_monthly_pnl_accrual', 'fa_monthly_pnl']);
});

test('tra hằng viết hoa GIẢI ĐƯỢC (biết là mẫu gỡ được, chưa suy ra tên)', () => {
  assert.equal(giaiDuoc('PROFIT_CLOSE_RPC.state').kieu, 'hang');
});

test('wrapper nhận `fn: string` KHÔNG giải được — đó là lựa chọn thiết kế, chỉ đếm', () => {
  assert.equal(giaiDuoc('fn'), null);
  assert.equal(giaiDuoc('rpcName'), null);
  assert.equal(giaiDuoc('args.name'), null);
});

test('sàn chống-xanh-rỗng đủ chặt để bắt bộ dò hỏng', () => {
  // Đo 12/08/2026: 270 lời gọi (239 viết thẳng + 31 ẩn).
  assert.ok(SAN_LOI_GOI >= 100 && SAN_LOI_GOI <= 270);
});
