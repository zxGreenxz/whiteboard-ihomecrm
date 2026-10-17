import { sharedW2 } from './wave2-sql-fixture.mjs';

// Gói D đợt 2 (tài sản, danh mục, toà/phòng, báo cáo BĐS) — fixture RIÊNG của Gói D, chỉ Gói D sửa.
// Dựng trên sharedW2: fixture đọc đầy đủ đợt 1 + nền đợt 2 + migration của CHÍNH gói D (dải
// 2026101804xxxx). Bảng/cột và RPC web thật mà báo cáo cần: tạo trong before (trước migration — hàm
// LANGUAGE sql cần lúc tạo) hoặc seed (sau migration). Dữ liệu tổng hợp.
// MỘT PGlite cho cả file test, mỗi ca BEGIN … ROLLBACK (shared.isolated).
export async function sharedW2d(options = {}) {
  return sharedW2({ packages: ['d'], before: null, seed: null, ...options });
}
