-- =============================================================================
-- Sổ tổng lợi nhuận cổ đông — dọn hàm ghi bù MỘT LẦN của Đợt 3 sau khi đã dùng.
--
-- VÌ SAO
--   app_private.profit_ledger_luong_backfill_v1 (Đợt 1, 20261115083422) chỉ để D3a
--   (20261115113530) ghi bù phần lợi nhuận đã trả kèm phiếu lương cũ. D3a đã áp production
--   (15/11/2026 20:23Z) rồi D3b bật chi theo sổ tổng (20:26Z); không còn ai gọi hàm này. Giữ lại
--   là để ngỏ một đường ghi dòng lương vào sổ ngoài luồng chính thức (E13–E16).
--
--   Hệ quả có chủ đích: chạy lại D3a sẽ dừng ngay ở bước tiền kiểm ĐẦU TIÊN với câu cố định
--     55000 'D3A_NEN: thiếu nền Đợt 1 — áp đủ năm migration Đợt 1 trước:
--            app_private.profit_ledger_luong_backfill_v1(uuid,numeric,numeric,text,uuid,date)'
--   — không phụ thuộc dữ liệu, nên ngoại lệ pinned của check-forward-migration-idempotent cho D3a
--   (supabase/migration-policy.json, supersededBy = file này) đứng vững. Trước file này D3a chạy lại
--   dừng ở X1 (công tắc đã ON) hoặc, khi sổ có phiếu chi / tháng chốt mới, ở dấu vân tay số dư mà
--   DETAIL đổi theo dữ liệu — ghim theo câu đó sẽ vỡ ngay lần chi đầu tiên.
--
-- ÁP LẠI D3a SAU KHI LÙI (R1–R7): migration áp lại phải tự tạo lại hàm này đúng thân M3
--   (md5 prosrc bỏ CR 7ce5d543f3cb2937a2322fb44d664690) trước khi gọi, rồi dọn lại.
-- AN TOÀN CHẠY LẠI: DROP FUNCTION IF EXISTS — lượt hai không làm gì.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS app_private.profit_ledger_luong_backfill_v1(uuid, numeric, numeric, text, uuid, date);

COMMIT;
