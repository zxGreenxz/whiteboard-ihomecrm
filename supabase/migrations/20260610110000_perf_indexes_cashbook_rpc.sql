-- =====================================================================
-- Perf batch: index theo pattern truy vấn phổ biến + RPC số dư đầu kỳ
-- sổ quỹ + gỡ trigger cọc legacy đã chết lâm sàng.
-- =====================================================================

-- 1. Index sort/lọc phổ biến -------------------------------------------
-- Các trang list đều .order(created_at DESC) — thiếu index nên sort toàn bộ
-- kết quả mỗi trang.
CREATE INDEX IF NOT EXISTS idx_invoices_created_at  ON invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_created_at ON contracts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers (created_at DESC);

-- Lọc kỳ áp dụng của items (useAccrualReport + lọc kỳ ở trang Thu chi):
-- query .or(and(start_date.lte...,end_date.gte...)) hiện full-scan bảng items.
CREATE INDEX IF NOT EXISTS idx_ie_items_period
  ON income_expense_items (start_date, end_date)
  WHERE start_date IS NOT NULL;

-- Combo lọc phổ biến nhất của invoices (trang Thu tiền mobile + InvoicesPage
-- lọc đồng thời toà + tháng).
CREATE INDEX IF NOT EXISTS idx_invoices_building_month
  ON invoices (building_id, billing_month)
  WHERE deleted_at IS NULL;

-- Danh sách thu chi: lọc deleted + order voucher_date desc.
CREATE INDEX IF NOT EXISTS idx_ie_active_voucher_date
  ON income_expenses (voucher_date DESC)
  WHERE deleted_at IS NULL;

-- 2. RPC số dư đầu kỳ sổ quỹ -------------------------------------------
-- useCashBookSummary hiện kéo TOÀN BỘ lịch sử phiếu trước start_date về
-- client chỉ để cộng tổng (payload tăng vô hạn theo thời gian). RPC trả
-- 1 số. SECURITY INVOKER: đi qua RLS y hệt query FE cũ — không đổi phạm
-- vi nhìn thấy của caller.
CREATE OR REPLACE FUNCTION public.cashbook_opening_balance(
  p_before_date DATE,
  p_building_id UUID DEFAULT NULL,
  p_account_id  UUID DEFAULT NULL
)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(
    SUM(CASE WHEN ie.type = 'INCOME' THEN ie.total_amount ELSE -ie.total_amount END),
    0
  )
  FROM income_expenses ie
  WHERE ie.approval_status = 'APPROVED'
    AND ie.deleted_at IS NULL
    AND ie.voucher_date < p_before_date
    AND (p_building_id IS NULL OR ie.building_id = p_building_id)
    AND (p_account_id  IS NULL OR ie.account_id  = p_account_id);
$$;

REVOKE ALL ON FUNCTION public.cashbook_opening_balance(DATE, UUID, UUID) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.cashbook_opening_balance(DATE, UUID, UUID) TO authenticated;

-- 3. Gỡ trigger cọc legacy (migration 012) ------------------------------
-- trigger_auto_calculate_deposit_paid match deposits theo NEW.tenant_id khi
-- INSERT contracts — nhưng useCreateContract LUÔN insert tenant_id=NULL nên
-- trigger không bao giờ chạy từ 2026-05. Nguồn sự thật cọc hiện là phiếu IE
-- is_deposit (recompute_contract_deposit_paid). Giữ lại chỉ gây hiểu nhầm
-- + rủi ro 2 nguồn ghi đè deposit_paid nếu sau này có flow set tenant_id.
DROP TRIGGER IF EXISTS trigger_auto_calculate_deposit_paid ON contracts;
DROP FUNCTION IF EXISTS auto_calculate_deposit_paid();

NOTIFY pgrst, 'reload schema';
