-- P1 — index còn thiếu trên contracts.
--
-- ĐO THẬT trên production 15/09/2026 (pg_stat_user_tables / pg_stat_user_indexes):
--   contracts: 445 dòng sống, 8.989.557 idx_scan, 25.336 seq_scan.
--   Có sẵn: contracts_organization_id_idx (org, 275 scan) và idx_contracts_status
--   (status, 7.466 scan) — hai index MỘT CỘT riêng lẻ. Không có composite
--   (organization_id, status), và không có index partial nào theo deleted_at
--   dùng được cho lọc nóng (idx_contracts_deleted_at là index đầy đủ trên cột
--   nullable, 1 scan từ lúc dựng).
--
--   Chính sách RLS `contracts_org_boundary` lọc `organization_id IN (…)` trên MỌI
--   câu lệnh, còn màn hình danh sách lọc thêm theo `status` và luôn kèm
--   `deleted_at IS NULL`. Ba vế đó hiện phải ghép từ hai index rời hoặc quét bảng.
--
-- NÓI THẲNG VỀ HIỆU QUẢ HÔM NAY: với 445 dòng, planner nhiều khả năng vẫn chọn
--   seq scan và index này KHÔNG đo được bằng thời gian. Giá trị của nó là lúc dữ
--   liệu lớn lên — thêm một index 445 dòng gần như không tốn gì, còn phát hiện ra
--   thiếu nó lúc bảng đã to thì tốn. Đừng báo cáo file này như một cải thiện tốc
--   độ đã đo được.
--
-- KHÔNG DÙNG `CREATE INDEX CONCURRENTLY` — và đây là cố ý, không phải quên:
--   lane apply (scripts/apply-reviewed-migration.mjs) bọc TOÀN BỘ file trong một
--   transaction có advisory lock, còn CONCURRENTLY thì Postgres cấm chạy trong
--   transaction block. Đi đường riêng ngoài lane nghĩa là bỏ luôn cutoff,
--   provenance, digest và backup. Với một bảng 445 dòng, CREATE INDEX thường
--   khoá ghi trong khoảng mili-giây — đổi bốn lớp bảo vệ lấy chừng đó là lỗ.
--   Khi contracts lớn tới mức khoá ghi thành vấn đề thì phải dựng một lane riêng
--   cho CONCURRENTLY, không phải lách bằng apply-sql.mjs.
--
-- KHÔNG LÀM (đã đối chiếu catalog, không phải bỏ sót):
--   · `contracts(room_id, status)` — đã có `contracts_one_active_per_room_uq`
--     (unique partial trên room_id WHERE deleted_at IS NULL AND status='ACTIVE').
--   · `invoice_audit_log(invoice_id)` — đã có
--     `invoice_audit_log_invoice_id_created_at_idx (invoice_id, created_at DESC)`;
--     invoice_id là cột DẪN ĐẦU nên mọi truy vấn lọc theo invoice_id đã dùng được
--     index đó. Thêm index một cột nữa chỉ tốn chỗ ghi.
--
-- Idempotent. KHÔNG apply trong session này — chỉ dry-run qua `npm run migrate:forward`.

BEGIN;

-- Composite (org, status) + partial deleted_at gộp vào MỘT index: mọi truy vấn
-- danh sách hợp đồng đều mang đủ ba vế, nên tách làm hai index chỉ nhân đôi chi
-- phí ghi mà không thêm đường đọc nào.
CREATE INDEX IF NOT EXISTS idx_contracts_org_status_con_song
  ON public.contracts (organization_id, status)
  WHERE deleted_at IS NULL;

COMMENT ON INDEX public.idx_contracts_org_status_con_song IS
  'Lọc nóng của màn danh sách hợp đồng: biên giới công ty (RLS contracts_org_boundary) '
  '+ status, chỉ trên dòng chưa xoá mềm.';

DO $ktra$
BEGIN
  IF to_regclass('public.idx_contracts_org_status_con_song') IS NULL THEN
    RAISE EXCEPTION 'thieu index idx_contracts_org_status_con_song';
  END IF;

  -- Chốt lại phát hiện đã dùng để BỎ hai index khác. Nếu index nền biến mất thì
  -- lý do "không cần thêm" ở header cũng hết đúng, và phải biết ngay.
  IF to_regclass('public.contracts_one_active_per_room_uq') IS NULL THEN
    RAISE EXCEPTION 'contracts_one_active_per_room_uq bien mat — lap luan bo (room_id,status) khong con dung';
  END IF;
  IF to_regclass('public.invoice_audit_log_invoice_id_created_at_idx') IS NULL THEN
    RAISE EXCEPTION 'invoice_audit_log_invoice_id_created_at_idx bien mat — invoice_audit_log(invoice_id) lai can thiet';
  END IF;
END
$ktra$;

COMMIT;
