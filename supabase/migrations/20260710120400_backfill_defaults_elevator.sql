-- =============================================================================
-- Backfill dữ liệu vận hành cho trang Đóng tiền tập trung (10/07)
--
-- 1) building_fee_accounts.default_amount = số tiền PHIẾU GẦN NHẤT per (tòa ×
--    hạng mục), normalize PER-KỲ (chia số tháng item phủ). First-write-wins —
--    không đè cấu hình đã nhập tay. BỎ QUA quan_ly (bảng bfa SELECT-visible cho
--    staff theo tòa → không copy số của hạng mục hạn chế ra ngoài).
-- 2) buildings.has_elevator = true cho tòa ĐANG có phiếu thang máy (data-driven,
--    không hardcode tên) — 4 tòa đang trả phí bị ẩn khỏi page vì thiếu cờ.
-- =============================================================================

BEGIN;

-- ── 1) Backfill default_amount (per-kỳ) ──
WITH cat AS (
  SELECT unnest(ARRAY['tien_nha','dien','nuoc','internet','ve_sinh','cong_an','rac','thang_may']) AS k
),
latest AS (
  SELECT DISTINCT ON (ie.building_id, c.k)
         ie.building_id,
         c.k AS fee_category,
         round(it.amount / GREATEST(
           (EXTRACT(YEAR FROM age(date_trunc('month', it.end_date), date_trunc('month', it.start_date))) * 12
            + EXTRACT(MONTH FROM age(date_trunc('month', it.end_date), date_trunc('month', it.start_date))))::int + 1,
           1)) AS per_ky,
         b.user_id AS owner_id
    FROM income_expense_items it
    JOIN income_expense_types t ON t.id = it.income_expense_type_id AND t.type = 'expense'
    JOIN cat c ON public.fee_type_matches(c.k, t.category, t.name)
    JOIN income_expenses ie ON ie.id = it.income_expense_id
                           AND ie.type = 'EXPENSE'
                           AND ie.approval_status = 'APPROVED'
                           AND ie.deleted_at IS NULL
    JOIN buildings b ON b.id = ie.building_id AND b.deleted_at IS NULL AND b.is_virtual = false
   WHERE it.amount > 0
   ORDER BY ie.building_id, c.k, ie.voucher_date DESC, it.end_date DESC NULLS LAST
)
INSERT INTO building_fee_accounts (building_id, fee_category, default_amount, user_id)
SELECT l.building_id, l.fee_category, l.per_ky, l.owner_id
  FROM latest l
ON CONFLICT (building_id, fee_category) WHERE deleted_at IS NULL
DO UPDATE SET
  default_amount = COALESCE(building_fee_accounts.default_amount, EXCLUDED.default_amount),
  updated_at = now();

-- ── 2) Gắn cờ thang máy theo phiếu thực tế ──
UPDATE public.buildings b
   SET has_elevator = true
 WHERE b.deleted_at IS NULL
   AND b.is_virtual = false
   AND b.has_elevator IS DISTINCT FROM true
   AND EXISTS (
     SELECT 1
       FROM income_expenses ie
       JOIN income_expense_items it ON it.income_expense_id = ie.id
       JOIN income_expense_types t ON t.id = it.income_expense_type_id
      WHERE ie.building_id = b.id
        AND ie.type = 'EXPENSE'
        AND ie.deleted_at IS NULL
        AND public.fee_type_matches('thang_may', t.category, t.name)
   );

COMMIT;

NOTIFY pgrst, 'reload schema';
