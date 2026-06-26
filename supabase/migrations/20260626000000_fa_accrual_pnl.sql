-- =====================================================================
-- Phân tích tài chính — biến thể ACCRUAL (dồn tích) cho P&L & cơ cấu hạng mục.
--
-- Trang /report/finance/analysis trước nay CHỈ ghi nhận theo NGÀY PHIẾU
-- (cash basis: fa_monthly_pnl/fa_type_breakdown gom theo voucher_date).
-- Báo cáo Phân bổ lợi nhuận lại mặc định DỒN TÍCH (useAccrualReport) →
-- cùng một tháng cho 2 con số lợi nhuận khác nhau. 2 RPC dưới đây dựng
-- bản accrual ở cấp toà × tháng để trang Phân tích khớp Phân bổ lợi nhuận.
--
-- Quy tắc accrual (đồng bộ useAccrualReport + allocateAmountByMonth):
--   • Phiếu GẮN hoá đơn (invoice_id) → ghi nhận TRỌN vào invoices.billing_month,
--     bất kể ngày thu tiền / kỳ của item.
--   • Phiếu KHÔNG gắn hoá đơn:
--       - item có kỳ [start_date, end_date] → CHIA ĐỀU ra các tháng trong kỳ
--         theo làm tròn LUỸ TIẾN: phần tháng i = round(amt*(i+1)/n) − round(amt*i/n)
--         (n = số tháng; bảo toàn tổng, mỗi phần lệch ≤ 1đ — KHỚP hàm JS).
--       - kỳ bẩn (end < start) → gom vào tháng start.
--       - item KHÔNG kỳ → ghi nhận trọn vào tháng voucher_date.
--   • Phiếu KHÔNG có item → total_amount vào tháng (billing_month nếu gắn HĐ,
--     ngược lại voucher_date), hạng mục NULL "Không có hạng mục".
--   Nhờ vậy Σ fa_type_breakdown_accrual == Σ fa_monthly_pnl_accrual cùng kỳ.
--   (KHÁC useAccrualReport: hook FE dùng items!inner nên BỎ phiếu không item —
--   ở đây CÓ tính để không thất thoát doanh thu; xem ghi chú chat.)
--
-- Bộ lọc & authz giữ nguyên các fa_*: APPROVED + deleted_at IS NULL +
-- counts_in_business_result = true; CTE allowed lọc can_access_building.
-- Toà ảo "Chung" vẫn có (cờ is_virtual để FE ẩn/hiện). Chỉ trả tháng/toà
-- CÓ phân bổ rơi vào cửa sổ [p_start_date, p_end_date] — FE tự scaffold.
-- =====================================================================

BEGIN;

-- ── Helper: bung từng item/phiếu thành dòng phân bổ (tháng × toà × hạng mục)
-- SECURITY DEFINER, KHÔNG cấp cho authenticated — chỉ gọi nội bộ qua 2 wrapper
-- bên dưới (chạy dưới quyền owner nên không cần GRANT riêng).
CREATE OR REPLACE FUNCTION public.fa_accrual_allocations(
  p_start_date   date,
  p_end_date     date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  month         date,
  voucher_id    uuid,
  building_id   uuid,
  building_name text,
  is_virtual    boolean,
  side          text,
  type_id       uuid,
  type_name     text,
  category      text,
  amount        numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  WITH allowed AS (
    SELECT b.id, b.name, b.is_virtual
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  win AS (
    SELECT date_trunc('month', p_start_date)::date AS w_start,
           date_trunc('month', p_end_date)::date   AS w_end
  ),
  -- Phiếu KQKD trong phạm vi toà; suy tháng kỳ hoá đơn nếu gắn HĐ.
  v AS (
    SELECT ie.id, ie.type::text AS side, ie.voucher_date,
           a.id AS bid, a.name AS bname, a.is_virtual,
           ie.total_amount,
           CASE
             WHEN ie.invoice_id IS NOT NULL AND inv.billing_month ~ '^\d{4}-\d{2}$'
             THEN to_date(inv.billing_month, 'YYYY-MM')
           END AS inv_month
    FROM allowed a
    JOIN public.income_expenses ie ON ie.building_id = a.id
    LEFT JOIN public.invoices inv ON inv.id = ie.invoice_id AND inv.deleted_at IS NULL
    WHERE ie.deleted_at IS NULL
      AND ie.approval_status = 'APPROVED'
      AND ie.counts_in_business_result = true
  ),
  -- ── Nhánh A: phiếu GẮN hoá đơn → trọn vào billing_month ──
  a_items AS (
    SELECT v.inv_month AS m, v.id, v.bid, v.bname, v.is_virtual, v.side,
           t.id AS tid, t.name AS tname, t.category, it.amount::numeric AS amt
    FROM v
    JOIN public.income_expense_items it ON it.income_expense_id = v.id
    JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
    WHERE v.inv_month IS NOT NULL
  ),
  a_noitem AS (
    SELECT v.inv_month AS m, v.id, v.bid, v.bname, v.is_virtual, v.side,
           NULL::uuid AS tid, 'Không có hạng mục'::text AS tname, NULL::text AS category,
           v.total_amount AS amt
    FROM v
    WHERE v.inv_month IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.income_expense_items x WHERE x.income_expense_id = v.id)
  ),
  -- ── Nhánh B: phiếu KHÔNG gắn hoá đơn ──
  -- B1: item có kỳ hợp lệ → chia đều theo tháng (làm tròn luỹ tiến).
  b_period AS (
    SELECT (date_trunc('month', it.start_date) + (gs.i || ' month')::interval)::date AS m,
           v.id, v.bid, v.bname, v.is_virtual, v.side,
           t.id AS tid, t.name AS tname, t.category,
           (round(it.amount * (gs.i + 1) / n.n) - round(it.amount * gs.i / n.n))::numeric AS amt
    FROM v
    JOIN public.income_expense_items it ON it.income_expense_id = v.id
    JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
    CROSS JOIN LATERAL (
      SELECT GREATEST(
        (extract(year FROM it.end_date)::int * 12 + extract(month FROM it.end_date)::int)
      - (extract(year FROM it.start_date)::int * 12 + extract(month FROM it.start_date)::int) + 1,
        1) AS n
    ) n
    CROSS JOIN LATERAL generate_series(0, n.n - 1) AS gs(i)
    WHERE v.inv_month IS NULL
      AND it.start_date IS NOT NULL AND it.end_date IS NOT NULL
      AND it.end_date >= it.start_date
  ),
  -- B1b: kỳ bẩn (end < start) → gom vào tháng start.
  b_period_bad AS (
    SELECT date_trunc('month', it.start_date)::date AS m,
           v.id, v.bid, v.bname, v.is_virtual, v.side,
           t.id AS tid, t.name AS tname, t.category, it.amount::numeric AS amt
    FROM v
    JOIN public.income_expense_items it ON it.income_expense_id = v.id
    JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
    WHERE v.inv_month IS NULL
      AND it.start_date IS NOT NULL AND it.end_date IS NOT NULL
      AND it.end_date < it.start_date
  ),
  -- B2: item không kỳ → trọn vào tháng voucher_date.
  b_noperiod AS (
    SELECT date_trunc('month', v.voucher_date)::date AS m,
           v.id, v.bid, v.bname, v.is_virtual, v.side,
           t.id AS tid, t.name AS tname, t.category, it.amount::numeric AS amt
    FROM v
    JOIN public.income_expense_items it ON it.income_expense_id = v.id
    JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
    WHERE v.inv_month IS NULL
      AND (it.start_date IS NULL OR it.end_date IS NULL)
  ),
  -- B3: phiếu không item → total_amount vào tháng voucher_date, hạng mục NULL.
  b_noitem AS (
    SELECT date_trunc('month', v.voucher_date)::date AS m,
           v.id, v.bid, v.bname, v.is_virtual, v.side,
           NULL::uuid AS tid, 'Không có hạng mục'::text AS tname, NULL::text AS category,
           v.total_amount AS amt
    FROM v
    WHERE v.inv_month IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.income_expense_items x WHERE x.income_expense_id = v.id)
  ),
  unioned AS (
    SELECT * FROM a_items
    UNION ALL SELECT * FROM a_noitem
    UNION ALL SELECT * FROM b_period
    UNION ALL SELECT * FROM b_period_bad
    UNION ALL SELECT * FROM b_noperiod
    UNION ALL SELECT * FROM b_noitem
  )
  SELECT u.m, u.id, u.bid, u.bname, u.is_virtual, u.side, u.tid, u.tname, u.category, u.amt
  FROM unioned u, win
  WHERE u.m >= win.w_start AND u.m <= win.w_end;
$$;
REVOKE ALL ON FUNCTION public.fa_accrual_allocations(date, date, uuid[]) FROM PUBLIC, anon, authenticated;
COMMENT ON FUNCTION public.fa_accrual_allocations(date, date, uuid[]) IS
'Helper nội bộ (KHÔNG cấp cho authenticated): bung phiếu KQKD thành dòng phân bổ accrual tháng × toà × hạng mục. Gọi qua fa_monthly_pnl_accrual / fa_type_breakdown_accrual.';

-- ── 1. fa_monthly_pnl_accrual: P&L accrual theo tháng × toà ──────────
CREATE OR REPLACE FUNCTION public.fa_monthly_pnl_accrual(
  p_start_date   date,
  p_end_date     date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  month         date,
  building_id   uuid,
  building_name text,
  is_virtual    boolean,
  revenue       numeric,
  expense       numeric,
  net           numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    al.month, al.building_id, al.building_name, al.is_virtual,
    COALESCE(SUM(al.amount) FILTER (WHERE al.side = 'INCOME'),  0)::numeric,
    COALESCE(SUM(al.amount) FILTER (WHERE al.side = 'EXPENSE'), 0)::numeric,
    (COALESCE(SUM(al.amount) FILTER (WHERE al.side = 'INCOME'),  0)
   - COALESCE(SUM(al.amount) FILTER (WHERE al.side = 'EXPENSE'), 0))::numeric
  FROM public.fa_accrual_allocations(p_start_date, p_end_date, p_building_ids) al
  GROUP BY al.month, al.building_id, al.building_name, al.is_virtual
  ORDER BY al.month, al.building_name;
$$;
REVOKE ALL ON FUNCTION public.fa_monthly_pnl_accrual(date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_monthly_pnl_accrual(date, date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.fa_monthly_pnl_accrual(date, date, uuid[]) IS
'P&L DỒN TÍCH theo tháng × toà (cùng shape fa_monthly_pnl). Phân bổ item theo kỳ áp dụng / billing_month — khớp Phân bổ lợi nhuận. FE tự scaffold tháng trống.';

-- ── 2. fa_type_breakdown_accrual: cơ cấu accrual theo tháng × hạng mục
CREATE OR REPLACE FUNCTION public.fa_type_breakdown_accrual(
  p_start_date   date,
  p_end_date     date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS TABLE (
  month         date,
  side          text,
  type_id       uuid,
  type_name     text,
  category      text,
  total_amount  numeric,
  voucher_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    al.month, al.side, al.type_id, al.type_name, al.category,
    SUM(al.amount)::numeric, COUNT(DISTINCT al.voucher_id)
  FROM public.fa_accrual_allocations(p_start_date, p_end_date, p_building_ids) al
  GROUP BY al.month, al.side, al.type_id, al.type_name, al.category
  ORDER BY al.month, al.side, SUM(al.amount) DESC;
$$;
REVOKE ALL ON FUNCTION public.fa_type_breakdown_accrual(date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fa_type_breakdown_accrual(date, date, uuid[]) TO authenticated;
COMMENT ON FUNCTION public.fa_type_breakdown_accrual(date, date, uuid[]) IS
'Cơ cấu thu/chi DỒN TÍCH theo tháng × hạng mục (cùng shape fa_type_breakdown). Σ total_amount == Σ fa_monthly_pnl_accrual cùng kỳ.';

COMMIT;

NOTIFY pgrst, 'reload schema';
