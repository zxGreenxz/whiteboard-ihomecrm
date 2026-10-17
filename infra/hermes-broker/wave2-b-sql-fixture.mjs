import { sharedW2 } from './wave2-sql-fixture.mjs';

// Gói B đợt 2 (sổ quỹ, dòng tiền, KQKD, lợi nhuận cổ đông, ví cá nhân, biến động số dư) — fixture RIÊNG
// của Gói B, chỉ Gói B sửa. Dựng trên sharedW2: fixture đọc đầy đủ đợt 1 + nền đợt 2 + migration của
// CHÍNH gói B (dải 2026101802xxxx). Bảng/cột và RPC web thật mà báo cáo cần: tạo trong before (trước
// migration — hàm LANGUAGE sql cần lúc tạo) hoặc seed (sau migration). Dữ liệu tổng hợp.
// MỘT PGlite cho cả file test, mỗi ca BEGIN … ROLLBACK (shared.isolated).
export async function sharedW2b(options = {}) {
  return sharedW2({ packages: ['b'], before: null, seed: null, ...options });
}
