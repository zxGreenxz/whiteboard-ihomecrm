-- =============================================
-- Migration: Làm tròn tiền thiếu < 10K
-- Created: 2026-05-27
-- Description:
--   - Thêm 2 cột metadata `rounding_amount` + `rounding_account_id` vào
--     income_expenses (song song với change_amount/change_account_id) để
--     ghi nhận giao dịch "Làm tròn tiền thiếu" mà không trừ số dư sổ quỹ.
--   - Sửa recompute_invoice_for_id: residual < 10.000 ₫ (và > 0) cũng coi
--     là PAID — paid_amount giữ nguyên số thực thu, status chuyển PAID.
--   - Tạo DUY NHẤT 1 sổ quỹ "Làm tròn tiền thiếu" thuộc owner chính
--     (user sở hữu nhiều building nhất). 2 nhân viên dùng chung qua RLS
--     accounts_select_staff. KHÔNG seed 1 sổ / 1 user — owner phụ trách.
-- =============================================

BEGIN;

-- ── 1) Thêm 2 cột rounding (metadata-only, không gây side-effect) ──
ALTER TABLE income_expenses
  ADD COLUMN IF NOT EXISTS rounding_amount DECIMAL(15, 2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rounding_account_id UUID REFERENCES accounts(id);

COMMENT ON COLUMN income_expenses.rounding_amount IS
  'Số tiền làm tròn (tiền thiếu < 10K được "tha" cho khách) — metadata audit, KHÔNG ảnh hưởng số dư sổ quỹ. Tương tự change_amount.';
COMMENT ON COLUMN income_expenses.rounding_account_id IS
  'Sổ quỹ "Làm tròn tiền thiếu" — ledger ghi nhận, không phải nguồn tiền.';

-- ── 2) Sửa recompute để áp dụng ngưỡng < 10K ──
CREATE OR REPLACE FUNCTION recompute_invoice_for_id(p_invoice_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $BODY$
DECLARE
  v_total NUMERIC(15, 2);
  v_paid  NUMERIC(15, 2);
  v_refunded NUMERIC(15, 2);
  v_status invoice_status;
  v_paid_date DATE;
  v_rounding_threshold CONSTANT NUMERIC(15, 2) := 10000;
BEGIN
  IF p_invoice_id IS NULL THEN RETURN; END IF;

  SELECT total_amount INTO v_total FROM invoices WHERE id = p_invoice_id;
  IF v_total IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(amount), 0), MAX(payment_date)
  INTO v_paid, v_paid_date
  FROM payments
  WHERE invoice_id = p_invoice_id;

  SELECT COALESCE(SUM(iei.unit_price * iei.quantity), 0)
  INTO v_refunded
  FROM income_expenses ie
  JOIN income_expense_items iei ON iei.income_expense_id = ie.id
  JOIN income_expense_types iet ON iet.id = iei.income_expense_type_id
  WHERE ie.invoice_id = p_invoice_id
    AND ie.type = 'EXPENSE'
    AND ie.approval_status = 'APPROVED'
    AND ie.deleted_at IS NULL
    AND iet.name = 'Tiền thối';

  v_paid := v_paid - v_refunded;

  -- Ngưỡng làm tròn: nếu khoản thiếu < 10K (và > 0) → coi như đủ.
  -- paid_amount KHÔNG bị bump lên total (giữ đúng số khách trả thực).
  IF v_total > 0 AND v_paid > 0 AND (v_total - v_paid) < v_rounding_threshold THEN
    v_status := 'PAID';
  ELSIF v_paid >= v_total AND v_total > 0 THEN
    v_status := 'PAID';
  ELSIF v_paid > 0 THEN
    v_status := 'PARTIAL_PAID';
    v_paid_date := NULL;
  ELSE
    v_status := 'APPROVED';
    v_paid_date := NULL;
  END IF;

  UPDATE invoices
  SET paid_amount = v_paid,
      status = v_status,
      paid_date = v_paid_date
  WHERE id = p_invoice_id;
END;
$BODY$;

-- ── 3) Tạo DUY NHẤT 1 sổ "Làm tròn tiền thiếu" thuộc owner chính,
--        2 nhân viên dùng chung qua RLS accounts (staff_can_view). ──
DO $$
DECLARE
  v_owner_id UUID;
BEGIN
  -- Owner = user_id sở hữu nhiều building nhất (heuristic: chủ chính).
  SELECT user_id INTO v_owner_id
  FROM buildings
  WHERE deleted_at IS NULL OR deleted_at IS NULL
  GROUP BY user_id
  ORDER BY COUNT(*) DESC
  LIMIT 1;

  IF v_owner_id IS NULL THEN
    RETURN;
  END IF;

  -- Xoá các sổ duplicate (nếu có) thuộc user khác, giữ duy nhất 1 sổ của owner.
  DELETE FROM accounts
  WHERE name = 'Làm tròn tiền thiếu' AND user_id <> v_owner_id;

  IF NOT EXISTS (
    SELECT 1 FROM accounts
    WHERE user_id = v_owner_id AND name = 'Làm tròn tiền thiếu'
  ) THEN
    INSERT INTO accounts (user_id, name)
    VALUES (v_owner_id, 'Làm tròn tiền thiếu');
  END IF;
END $$;

-- ── 4) Backfill: recompute toàn bộ HĐ đang có residual < 10K để
--                  cập nhật status thành PAID ngay. ──
DO $$
DECLARE
  inv_id UUID;
BEGIN
  FOR inv_id IN
    SELECT id FROM invoices
    WHERE deleted_at IS NULL
      AND status IN ('PARTIAL_PAID', 'OVERDUE', 'APPROVED')
      AND total_amount > paid_amount
      AND (total_amount - paid_amount) < 10000
      AND paid_amount > 0
  LOOP
    PERFORM recompute_invoice_for_id(inv_id);
  END LOOP;
END $$;

COMMIT;
