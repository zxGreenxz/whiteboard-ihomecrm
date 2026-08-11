// Đột biến cho check-rpc-layer.

import assert from 'node:assert/strict';
import test from 'node:test';

import { MIEN_TRU, SAN_SO_FILE, TANG_GIAO_DIEN, timLoiGoi } from '../check-rpc-layer.mjs';

test('bắt lời gọi rpc thường', () => {
  assert.deepEqual(timLoiGoi(`await supabase.rpc('lay_gi_do_v1', { p_a: 1 })`), ['lay_gi_do_v1']);
});

test('bắt cả khi có khoảng trắng quanh dấu chấm', () => {
  assert.deepEqual(timLoiGoi(`supabase\n  .rpc("ten_ham", {})`), ['ten_ham']);
});

test('ĐỘT BIẾN: tên rpc nằm trong CHÚ THÍCH không được tính là vi phạm', () => {
  // Repo này đã dính đúng lỗi "gate đọc văn kể lại về mã" bốn lần. Một dòng
  // hướng dẫn `// đừng gọi supabase.rpc('x') ở đây` mà làm gate đỏ thì người ta
  // sẽ xoá dòng hướng dẫn, chứ không sửa mã.
  assert.deepEqual(timLoiGoi(`// đừng gọi supabase.rpc('cam_v1') ở component`), []);
  assert.deepEqual(timLoiGoi(`/* supabase.rpc('cam_v1') */`), []);
});

test('nhiều lời gọi trong một file đều được kể tên', () => {
  const s = `supabase.rpc('a_v1'); supabase.rpc('b_v1');`;
  assert.deepEqual(timLoiGoi(s), ['a_v1', 'b_v1']);
});

test('gọi qua biến khác tên `supabase` KHÔNG bị tính — gate nói về client chuẩn', () => {
  assert.deepEqual(timLoiGoi(`khach.rpc('a_v1')`), []);
});

test('file không có rpc ⇒ rỗng', () => {
  assert.deepEqual(timLoiGoi(`export const A = 1;`), []);
});

test('sàn chống-xanh-rỗng phải đủ lớn để bắt được bộ liệt kê hỏng', () => {
  // Đo 11/08/2026: 601 file .tsx trong ba thư mục. Sàn 300 nghĩa là mất quá nửa
  // mới báo động — đủ rộng để không kêu oan khi repo co lại, đủ chặt để một
  // bộ liệt kê trả về gần rỗng không lọt thành "đã sạch".
  assert.ok(SAN_SO_FILE >= 100);
  assert.ok(SAN_SO_FILE <= 600);
});

test('miễn trừ CỐ Ý ngắn — mỗi dòng là một chỗ nguyên tắc không còn đúng', () => {
  assert.ok(MIEN_TRU.length <= 3, `miễn trừ đang có ${MIEN_TRU.length} dòng`);
  assert.ok(MIEN_TRU.every((p) => p.startsWith('src/')));
});

test('ba thư mục giao diện đều được khai', () => {
  assert.deepEqual(TANG_GIAO_DIEN, ['src/components', 'src/pages', 'src/copilot']);
});
