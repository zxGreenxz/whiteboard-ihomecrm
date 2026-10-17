import { sharedW2 } from './wave2-sql-fixture.mjs';

// Gói A đợt 2 (thu tiền, công nợ, cọc) — fixture RIÊNG của Gói A, chỉ Gói A sửa. Dựng trên sharedW2:
// fixture đọc đầy đủ đợt 1 + nền đợt 2 + migration của CHÍNH gói A (dải 2026101801xxxx). Bảng/cột và
// RPC web thật (định nghĩa cuối trong baseline/migration) mà báo cáo cần: tạo trong before (trước
// migration — hàm LANGUAGE sql cần lúc tạo) hoặc seed (sau migration). Dữ liệu tổng hợp.
// MỘT PGlite cho cả file test, mỗi ca BEGIN … ROLLBACK (shared.isolated).
export async function sharedW2a(options = {}) {
  return sharedW2({ packages: ['a'], before: null, seed: null, ...options });
}
