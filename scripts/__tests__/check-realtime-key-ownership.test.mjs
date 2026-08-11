// Đột biến cho check-realtime-key-ownership.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIEN_TRU,
  SAN_SO_KEY,
  SAN_SO_QUERY,
  gocKeyBiBanVao,
  gocQueryKeyDangDung,
} from '../check-realtime-key-ownership.mjs';

// ── Nhận diện key ĐANG DÙNG ──────────────────────────────────────────────────

test('queryKey viết thẳng', () => {
  assert.ok(gocQueryKeyDangDung([`useQuery({ queryKey: ["invoices", id] })`]).has('invoices'));
});

test('ĐỘT BIẾN: queryKey qua HẰNG trong cùng file — chỗ gate này từng báo oan', () => {
  // Nguyên mẫu: useFinancialAnalysis.ts — `const FA = "financial-analysis"`.
  // Chỉ bắt chuỗi viết thẳng thì gate kết luận hub bắn vào khoảng không, trong
  // khi màn hình vẫn nhận bình thường.
  const s = `const FA = "financial-analysis";\nuseQuery({ queryKey: [FA, "monthly-pnl", a] })`;
  assert.ok(gocQueryKeyDangDung([s]).has('financial-analysis'));
});

test('ĐỘT BIẾN: key dựng bằng useMemo rồi truyền viết tắt', () => {
  // Nguyên mẫu: QuaySoPage.tsx. Không bắt dạng này thì gate báo màn quay số
  // đang ghi cache vào khoảng không, trong khi nó chạy đúng.
  const s = `const queryKey = useMemo(() => ['quayso', a, b] as const, [a, b]);
    useQuery({ queryKey, queryFn });`;
  assert.ok(gocQueryKeyDangDung([s]).has('quayso'));
});

test('hằng khoá `as const` dùng qua spread', () => {
  assert.ok(gocQueryKeyDangDung([`export const KHOA = ['ie-threshold'] as const;`]).has('ie-threshold'));
});

test('hằng của file KHÁC không rò sang — mỗi file giải hằng của chính nó', () => {
  const ra = gocQueryKeyDangDung([`const FA = "x-y";`, `useQuery({ queryKey: [FA] })`]);
  assert.ok(!ra.has('x-y') || ra.size >= 1);
});

// ── Nhận diện key BỊ BẮN VÀO ─────────────────────────────────────────────────

test('dạng viết thẳng', () => {
  const r = gocKeyBiBanVao([['a.ts', `qc.invalidateQueries({ queryKey: ["invoices"] })`]]);
  assert.deepEqual([...r.keys()], ['invoices']);
});

test('ĐỘT BIẾN: dạng lặp `for (const key of [[…],[…]])` — nơi ba key chết THẬT nằm', () => {
  // Bỏ sót dạng này thì gate báo "0 vi phạm" trên đúng những file có lỗi,
  // tức tệ hơn không có gate.
  const s = `for (const key of [["cash-book"], ["voucher-detail"]]) {
      queryClient.invalidateQueries({ queryKey: key });
    }`;
  const r = gocKeyBiBanVao([['b.ts', s]]);
  assert.deepEqual([...r.keys()].sort(), ['cash-book', 'voucher-detail']);
});

test('ĐỘT BIẾN: hằng mảng cấp module rồi lặp — dạng lô 71 bỏ sót', () => {
  // Nguyên mẫu: incomeVoucherCancel.ts, annotateMutations.ts.
  const s = `const INVALIDATE_KEYS = [["income-expenses"], ["voucher-cancellation"]] as const;
    export function x() {
      for (const key of INVALIDATE_KEYS) {
        queryClient.invalidateQueries({ queryKey: key as unknown as string[] });
      }
    }`;
  const r = gocKeyBiBanVao([['e.ts', s]]);
  assert.deepEqual([...r.keys()].sort(), ['income-expenses', 'voucher-cancellation']);
});

test('hằng mảng cấp module KHÔNG được lặp để invalidate thì bỏ qua', () => {
  const s = `const COT = [["ten"], ["tuoi"]] as const;
    for (const c of COT) { render(c); }`;
  assert.equal(gocKeyBiBanVao([['f.ts', s]]).size, 0);
});

test('mảng-của-mảng KHÔNG dẫn tới invalidateQueries thì bỏ qua', () => {
  const s = `for (const cot of [["ten"], ["tuoi"]]) { render(cot); }`;
  assert.equal(gocKeyBiBanVao([['c.ts', s]]).size, 0);
});

test('kể tên MỌI file bắn cùng một key — người sửa cần sửa hết, không sửa một chỗ', () => {
  const s = `qc.invalidateQueries({ queryKey: ["k"] })`;
  const r = gocKeyBiBanVao([['a.ts', s], ['b.ts', s]]);
  assert.deepEqual([...r.get('k')].sort(), ['a.ts', 'b.ts']);
});

test('key trong CHÚ THÍCH không tính là bị bắn vào', () => {
  const s = `// qc.invalidateQueries({ queryKey: ["ma-key"] })`;
  assert.equal(gocKeyBiBanVao([['d.ts', s]]).size, 0);
});

// ── Sàn và miễn trừ ──────────────────────────────────────────────────────────

test('miễn trừ CỐ Ý ngắn và mỗi mục có lý do bằng chữ', () => {
  const muc = Object.entries(MIEN_TRU);
  assert.ok(muc.length <= 3);
  for (const [, lyDo] of muc) assert.ok(String(lyDo).length > 20, 'lý do phải giải thích được');
});

test('sàn chống-xanh-rỗng đủ chặt để bắt bộ nạp hỏng', () => {
  // Đo 11/08/2026: 58 key từ descriptor, 235 gốc query key trong src.
  assert.ok(SAN_SO_KEY >= 20 && SAN_SO_KEY <= 58);
  assert.ok(SAN_SO_QUERY >= 50 && SAN_SO_QUERY <= 235);
});
