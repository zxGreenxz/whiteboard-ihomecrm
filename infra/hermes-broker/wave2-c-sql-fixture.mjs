import { sharedW2 } from './wave2-sql-fixture.mjs';

// Gói C đợt 2 (xe, kho vật tư, lương, thông báo, Network Center) — fixture RIÊNG của Gói C, chỉ Gói C
// sửa. Dựng trên sharedW2: fixture đọc đầy đủ đợt 1 + nền đợt 2 + migration của CHÍNH gói C (dải
// 2026101803xxxx). Bảng/cột và RPC web thật mà báo cáo cần: tạo trong before (trước migration — hàm
// LANGUAGE sql cần lúc tạo) hoặc seed (sau migration). Dữ liệu tổng hợp.
// MỘT PGlite cho cả file test, mỗi ca BEGIN … ROLLBACK (shared.isolated).
export async function sharedW2c(options = {}) {
  return sharedW2({ packages: ['c'], before: null, seed: null, ...options });
}
