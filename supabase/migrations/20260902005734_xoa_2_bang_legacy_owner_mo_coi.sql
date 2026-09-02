-- =============================================================================
-- Xoá 2 bảng mồ côi legacy_owner_allowlist + legacy_owner_organization_map —
-- theo khuyến nghị §5.2 của docs/audits/AUDIT-DB-BANG-MO-COI-VA-PHAN-CHUA-HOAT-DONG-2026-09-02.md.
--
-- BẰNG CHỨNG MỒ CÔI (đo production 02/09/2026, ghi trong audit §2.3):
--   - n_live_tup = 0 ở cả hai bảng (chưa từng/không còn dữ liệu);
--   - 0 hàm tham chiếu (pg_proc.prosrc ilike '%legacy_owner%' → rỗng);
--   - 0 policy tham chiếu (pg_policy qual + with_check);
--   - 0 FK trỏ vào, 0 view đọc (pg_constraint.confrelid + pg_views — đo trước
--     khi viết file này);
--   - code chỉ còn types.ts (máy sinh, sẽ tự teo khi regen) và một test đọc
--     NGUYÊN VĂN migration lịch sử (không đụng bảng sống).
--
-- ĐƯỜNG LÙI: bảng rỗng nên DROP không mất dữ liệu; schema cũ nằm trong
-- baseline/schema.sql và backup full ngay trước apply (lane migrate:forward
-- tự tạo). Muốn dựng lại chỉ cần re-CREATE từ baseline.
-- =============================================================================

DROP TABLE IF EXISTS public.legacy_owner_allowlist;
DROP TABLE IF EXISTS public.legacy_owner_organization_map;

-- Nghiệm thu: cả hai phải BIẾN MẤT, còn là DỪNG cả file.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('legacy_owner_allowlist', 'legacy_owner_organization_map')
  ) THEN
    RAISE EXCEPTION 'Bảng legacy_owner_* vẫn còn sau DROP. DỪNG.';
  END IF;
END $$;
