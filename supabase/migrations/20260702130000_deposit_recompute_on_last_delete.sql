-- Fix: xoá phiếu cọc CUỐI CÙNG của hợp đồng không reset deposit_paid.
--
-- recompute_contract_deposit_paid có guard "chỉ ghi đè khi còn ≥1 phiếu cọc"
-- (v_count > 0) để không đè 0 lên giá trị từ flow cũ CreateDepositDialog
-- (deposit_paid set lúc tạo HĐ, chưa có phiếu IE nào). Hệ quả: khi phiếu cọc
-- cuối cùng bị soft-delete (vd xoá lần thanh toán có phần cọc), v_count = 0
-- → hàm KHÔNG ghi đè → deposit_paid đứng ở giá trị cũ (ảo).
--
-- Sửa: đếm thêm v_count_any = số phiếu cọc KỂ CẢ đã xoá. Nếu hợp đồng TỪNG
-- có phiếu cọc (v_count_any > 0) thì phiếu IE là nguồn sự thật → luôn ghi đè
-- (kể cả về 0). Chỉ khi hợp đồng CHƯA TỪNG có phiếu cọc nào mới giữ nguyên
-- (bảo toàn giá trị từ flow cũ).

BEGIN;

CREATE OR REPLACE FUNCTION public.recompute_contract_deposit_paid(p_contract_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total     NUMERIC(15,2) := 0;
  v_count     INT := 0;
  v_count_any INT := 0;
BEGIN
  IF p_contract_id IS NULL THEN
    RETURN;
  END IF;

  -- Tổng CỌC = Σ item is_deposit của phiếu APPROVED chưa xoá (item-level —
  -- phiếu trộn chỉ tính phần item cọc, xem 20260702120000_kqkd_item_level).
  SELECT COALESCE(SUM(it.amount), 0), COUNT(DISTINCT ie.id)
  INTO v_total, v_count
  FROM income_expenses ie
  JOIN income_expense_items it ON it.income_expense_id = ie.id
  JOIN income_expense_types t  ON t.id = it.income_expense_type_id AND t.is_deposit = TRUE
  WHERE ie.contract_id = p_contract_id
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND ie.deleted_at IS NULL;

  -- Từng có phiếu cọc? (kể cả đã xoá / chưa duyệt) → IE là nguồn sự thật.
  SELECT COUNT(DISTINCT ie.id)
  INTO v_count_any
  FROM income_expenses ie
  JOIN income_expense_items it ON it.income_expense_id = ie.id
  JOIN income_expense_types t  ON t.id = it.income_expense_type_id AND t.is_deposit = TRUE
  WHERE ie.contract_id = p_contract_id
    AND ie.type = 'INCOME';

  -- Chỉ giữ nguyên khi CHƯA TỪNG có phiếu cọc (giá trị từ flow deposits cũ).
  IF v_count_any > 0 THEN
    UPDATE contracts
    SET deposit_paid = v_total,
        updated_at = NOW()
    WHERE id = p_contract_id
      AND deleted_at IS NULL
      AND deposit_paid IS DISTINCT FROM v_total;
  END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
