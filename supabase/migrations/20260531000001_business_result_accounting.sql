-- =====================================================================
-- Hạch toán kết quả kinh doanh (KQKD) — kích hoạt cờ + loại "tiền cọc"
-- khỏi báo cáo Lợi nhuận (P&L), ĐỐI XỨNG cả chiều vào lẫn ra.
--
-- Trước đây income_expenses.business_result_accounting là field CHẾT:
-- BOOLEAN NOT NULL DEFAULT false, không công thức nào đọc → bật/tắt vô
-- tác dụng. Toàn bộ 564 phiếu đều false.
--
-- Mô hình mới (hybrid):
--   • business_result_accounting → NULLABLE. NULL = "tự động" (suy theo
--     hạng mục); TRUE/FALSE = override tay từng phiếu.
--   • counts_in_business_result (cột suy diễn, maintained bằng trigger) =
--       COALESCE(business_result_accounting, NOT has_deposit_item)
--     trong đó has_deposit_item = phiếu có ≥1 item thuộc hạng mục
--     income_expense_types.is_deposit = TRUE.
--   • Báo cáo Lợi nhuận lọc WHERE counts_in_business_result = TRUE.
--     (Trang Thu chi KHÔNG đổi — vẫn là sổ dòng tiền, gồm cả cọc.)
--
-- Quy ước hạng mục cọc (loại khỏi P&L khi auto):
--   THU  "Tiền cọc" / "Cọc giữ phòng"            → is_deposit=TRUE (đã set)
--   CHI  "Hoàn trả thanh lý"                       → is_deposit=TRUE (set ở đây)
--   CHI  "Hoàn cọc / tiền thừa khi thanh lý" (cũ)  → is_deposit=TRUE (set ở đây)
--   CHI  "Hoàn cọc thanh lý" (mới, RPC tách)       → is_deposit=TRUE (set ở RPC)
-- Giữ TÍNH vào P&L:
--   THU  "Tiền cọc khách bỏ" (forfeit = doanh thu) → is_deposit=FALSE
--   CHI  "Hoàn tiền phòng thừa" (giảm doanh thu)    → is_deposit=FALSE
-- =====================================================================

-- 1. Cột ------------------------------------------------------------------
ALTER TABLE income_expenses
  ALTER COLUMN business_result_accounting DROP DEFAULT;
ALTER TABLE income_expenses
  ALTER COLUMN business_result_accounting DROP NOT NULL;

COMMENT ON COLUMN income_expenses.business_result_accounting IS
  'Override tay "tính vào KQKD": NULL=tự động (theo hạng mục is_deposit), TRUE/FALSE=ép.';

ALTER TABLE income_expenses
  ADD COLUMN IF NOT EXISTS counts_in_business_result BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN income_expenses.counts_in_business_result IS
  'Cờ hiệu lực (maintained): có tính vào báo cáo Lợi nhuận hay không. = COALESCE(business_result_accounting, NOT has_deposit_item).';

-- 2. Hàm recompute cho 1 phiếu -------------------------------------------
CREATE OR REPLACE FUNCTION public.recompute_ie_business_result(p_ie_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_override    boolean;
  v_has_deposit boolean;
  v_result      boolean;
BEGIN
  SELECT business_result_accounting INTO v_override
    FROM income_expenses WHERE id = p_ie_id;

  SELECT EXISTS (
    SELECT 1
      FROM income_expense_items it
      JOIN income_expense_types t ON t.id = it.income_expense_type_id
     WHERE it.income_expense_id = p_ie_id
       AND t.is_deposit = TRUE
  ) INTO v_has_deposit;

  v_result := COALESCE(v_override, NOT v_has_deposit);

  UPDATE income_expenses
     SET counts_in_business_result = v_result
   WHERE id = p_ie_id
     AND counts_in_business_result IS DISTINCT FROM v_result;
END;
$$;

-- 3. Trigger fn cho income_expense_items (item gắn SAU phiếu) -------------
CREATE OR REPLACE FUNCTION public.trg_ie_items_recompute_business_result()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.recompute_ie_business_result(OLD.income_expense_id);
    RETURN OLD;
  END IF;

  PERFORM public.recompute_ie_business_result(NEW.income_expense_id);
  IF TG_OP = 'UPDATE' AND NEW.income_expense_id IS DISTINCT FROM OLD.income_expense_id THEN
    PERFORM public.recompute_ie_business_result(OLD.income_expense_id);
  END IF;
  RETURN NEW;
END;
$$;

-- 4. Trigger fn cho income_expenses (insert + đổi override) --------------
--    Lưu ý: chỉ chạy AFTER INSERT và AFTER UPDATE OF business_result_accounting,
--    nên việc hàm recompute tự UPDATE counts_in_business_result KHÔNG gây đệ quy.
CREATE OR REPLACE FUNCTION public.trg_ie_recompute_business_result()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.recompute_ie_business_result(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ie_items_business_result ON income_expense_items;
CREATE TRIGGER ie_items_business_result
  AFTER INSERT OR UPDATE OR DELETE ON income_expense_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_ie_items_recompute_business_result();

DROP TRIGGER IF EXISTS ie_business_result ON income_expenses;
CREATE TRIGGER ie_business_result
  AFTER INSERT OR UPDATE OF business_result_accounting ON income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_ie_recompute_business_result();

-- 5. Index lọc cho báo cáo P&L -------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ie_counts_business_result
  ON income_expenses (counts_in_business_result);

-- 6. Gắn cờ is_deposit cho các hạng mục cọc CHIỀU RA --------------------
UPDATE income_expense_types
   SET is_deposit = TRUE
 WHERE lower(type) = 'expense'
   AND lower(trim(name)) IN (
     'hoàn trả thanh lý',
     'hoàn cọc / tiền thừa khi thanh lý',
     'hoàn cọc thanh lý'
   );

-- 7. Backfill ------------------------------------------------------------
--    Field xưa nay toàn FALSE (dead) → đưa hết về NULL (auto), rồi recompute
--    toàn bộ để counts_in_business_result đúng (cọc → FALSE, còn lại → TRUE).
UPDATE income_expenses SET business_result_accounting = NULL;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM income_expenses LOOP
    PERFORM public.recompute_ie_business_result(r.id);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.recompute_ie_business_result(uuid) FROM PUBLIC;
