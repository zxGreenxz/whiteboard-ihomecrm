-- =====================================================================
-- Hạch toán KQKD theo HẠNG MỤC (item-level) — cột kqkd_amount.
--
-- Bối cảnh: trước nay cờ counts_in_business_result nằm ở mức CẢ PHIẾU nên
-- khi thu hoá đơn tháng đầu GỘP CỌC, FE phải TÁCH 1 lần thu thành 2 phiếu
-- (doanh thu + cọc) để cọc không lọt vào Phân bổ lợi nhuận. User yêu cầu:
-- 1 lần thu = ĐÚNG 1 phiếu thu (chứng từ khớp giao dịch thực) → chuyển
-- hạch toán KQKD xuống mức hạng mục:
--
--   kqkd_amount = CASE business_result_accounting
--     WHEN TRUE  THEN total_amount                        -- ép tính cả phiếu
--     WHEN FALSE THEN 0                                   -- ép loại cả phiếu
--     ELSE GREATEST(total_amount − Σ(items is_deposit), 0)-- tự động theo hạng mục
--   END
--
-- Phiếu thuần doanh thu → = total; thuần cọc → 0; TRỘN → phần doanh thu.
-- Phiếu không item → total (Σ item cọc = 0) — khớp nhánh noitem của accrual.
-- Dữ liệu cũ (các cặp phiếu đã tách) đều "thuần" → backfill cho ra đúng
-- từng con số hiện tại, tổng Phân bổ LN KHÔNG đổi.
--
-- Đồng bộ bên CỌC: mọi nơi trước đây coi "cọc = total_amount của phiếu có
-- item cọc" phải đổi thành Σ item cọc, nếu không phiếu trộn bị đếm THỪA
-- phần doanh thu vào cọc (recompute_contract_deposit_paid,
-- get_deposit_breakdown_v2, deposit_collected trong get_invoice_statistics_v2).
-- get_invoice_statistics (bản cũ owner-only) là legacy FE không gọi — bỏ qua.
-- =====================================================================

BEGIN;

-- ── 1) Cột kqkd_amount (maintained bằng trigger — không nhập tay) ──────
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS kqkd_amount numeric(15,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.income_expenses.kqkd_amount IS
  'Phần tiền của phiếu được tính vào KQKD (maintained): override TRUE=total_amount, FALSE=0, NULL=total_amount − Σ item is_deposit. Báo cáo P&L cộng cột này thay vì total_amount × counts_in_business_result.';

CREATE INDEX IF NOT EXISTS idx_ie_kqkd_amount_pos
  ON public.income_expenses (kqkd_amount) WHERE kqkd_amount > 0;

-- ── 2) Mở rộng recompute_ie_business_result: tính THÊM kqkd_amount ─────
--    (bản trước ở 20260613000000 tính counts_in_business_result +
--     has_restricted_item; giữ nguyên 2 cờ đó cho tương thích badge/RLS.)
CREATE OR REPLACE FUNCTION public.recompute_ie_business_result(p_ie_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_override       boolean;
  v_total          numeric;
  v_has_deposit    boolean;
  v_has_restricted boolean;
  v_deposit_sum    numeric;
  v_result         boolean;
  v_kqkd           numeric;
BEGIN
  SELECT business_result_accounting, COALESCE(total_amount, 0)
    INTO v_override, v_total
    FROM income_expenses WHERE id = p_ie_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT
    bool_or(t.is_deposit),
    bool_or(t.is_restricted),
    COALESCE(SUM(it.amount) FILTER (WHERE t.is_deposit), 0)
  INTO v_has_deposit, v_has_restricted, v_deposit_sum
  FROM income_expense_items it
  JOIN income_expense_types t ON t.id = it.income_expense_type_id
  WHERE it.income_expense_id = p_ie_id;

  v_has_deposit    := COALESCE(v_has_deposit, false);
  v_has_restricted := COALESCE(v_has_restricted, false);
  v_deposit_sum    := COALESCE(v_deposit_sum, 0);
  v_result := COALESCE(v_override, NOT v_has_deposit);
  v_kqkd := CASE
    WHEN v_override IS TRUE  THEN v_total
    WHEN v_override IS FALSE THEN 0
    ELSE GREATEST(v_total - v_deposit_sum, 0)
  END;

  UPDATE income_expenses
     SET counts_in_business_result = v_result,
         has_restricted_item       = v_has_restricted,
         kqkd_amount               = v_kqkd
   WHERE id = p_ie_id
     AND (counts_in_business_result IS DISTINCT FROM v_result
       OR has_restricted_item       IS DISTINCT FROM v_has_restricted
       OR kqkd_amount               IS DISTINCT FROM v_kqkd);
END;
$$;

REVOKE ALL ON FUNCTION public.recompute_ie_business_result(uuid) FROM PUBLIC;

-- ── 3) Trigger phiếu: fire thêm khi total_amount đổi ───────────────────
--    (auto_recalc_total_amount ghi total_amount sau khi items đổi; item
--     trigger ie_items_business_result đã cover, nhưng ghi TRỰC TIẾP
--     total_amount không qua items — vd RPC nội bộ — cũng phải refresh.)
DROP TRIGGER IF EXISTS ie_business_result ON public.income_expenses;
CREATE TRIGGER ie_business_result
  AFTER INSERT OR UPDATE OF business_result_accounting, total_amount
  ON public.income_expenses
  FOR EACH ROW EXECUTE FUNCTION public.trg_ie_recompute_business_result();

-- ── 4) Backfill toàn bảng (chỉ điền cột dẫn xuất — không đổi số user nhập)
UPDATE public.income_expenses ie
SET kqkd_amount = sub.v
FROM (
  SELECT ie2.id,
    CASE
      WHEN ie2.business_result_accounting IS TRUE  THEN COALESCE(ie2.total_amount, 0)
      WHEN ie2.business_result_accounting IS FALSE THEN 0
      ELSE GREATEST(
        COALESCE(ie2.total_amount, 0) - COALESCE((
          SELECT SUM(it.amount)
          FROM public.income_expense_items it
          JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
          WHERE it.income_expense_id = ie2.id AND t.is_deposit = TRUE
        ), 0), 0)
    END AS v
  FROM public.income_expenses ie2
) sub
WHERE sub.id = ie.id
  AND ie.kqkd_amount IS DISTINCT FROM sub.v;

-- ── 5) fa_monthly_pnl: SUM(kqkd_amount) thay cờ cả-phiếu ───────────────
CREATE OR REPLACE FUNCTION public.fa_monthly_pnl(
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
  WITH allowed AS (
    SELECT b.id, b.name, b.is_virtual
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  )
  SELECT
    date_trunc('month', ie.voucher_date)::date,
    a.id,
    a.name,
    a.is_virtual,
    COALESCE(SUM(ie.kqkd_amount) FILTER (WHERE ie.type = 'INCOME'),  0)::numeric,
    COALESCE(SUM(ie.kqkd_amount) FILTER (WHERE ie.type = 'EXPENSE'), 0)::numeric,
    (COALESCE(SUM(ie.kqkd_amount) FILTER (WHERE ie.type = 'INCOME'),  0)
   - COALESCE(SUM(ie.kqkd_amount) FILTER (WHERE ie.type = 'EXPENSE'), 0))::numeric
  FROM allowed a
  JOIN public.income_expenses ie ON ie.building_id = a.id
  WHERE ie.deleted_at IS NULL
    AND ie.approval_status = 'APPROVED'
    AND ie.kqkd_amount > 0
    AND ie.voucher_date >= p_start_date
    AND ie.voucher_date <= p_end_date
  GROUP BY 1, a.id, a.name, a.is_virtual
  ORDER BY 1, a.name;
$$;
COMMENT ON FUNCTION public.fa_monthly_pnl(date, date, uuid[]) IS
'P&L KQKD theo tháng × toà — cộng kqkd_amount (item-level: phiếu trộn chỉ tính phần không-cọc). Chỉ trả tháng/toà CÓ dữ liệu — FE tự scaffold tháng trống.';

-- ── 6) fa_type_breakdown: phiếu trộn vẫn đóng góp item không-cọc ───────
CREATE OR REPLACE FUNCTION public.fa_type_breakdown(
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
  WITH allowed AS (
    SELECT b.id
    FROM public.buildings b
    WHERE b.deleted_at IS NULL
      AND (p_building_ids IS NULL OR b.id = ANY(p_building_ids))
      AND public.can_access_building(b.id)
  ),
  base AS (
    SELECT ie.id, ie.type, ie.total_amount,
           ie.business_result_accounting AS override,
           date_trunc('month', ie.voucher_date)::date AS m
    FROM public.income_expenses ie
    JOIN allowed a ON a.id = ie.building_id
    WHERE ie.deleted_at IS NULL
      AND ie.approval_status = 'APPROVED'
      AND ie.business_result_accounting IS DISTINCT FROM false
      AND ie.voucher_date >= p_start_date
      AND ie.voucher_date <= p_end_date
  )
  SELECT b.m, b.type::text, t.id, t.name, t.category,
         SUM(it.amount)::numeric, COUNT(DISTINCT b.id)
  FROM base b
  JOIN public.income_expense_items it ON it.income_expense_id = b.id
  JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
  WHERE (b.override IS TRUE OR t.is_deposit = false)
  GROUP BY b.m, b.type, t.id, t.name, t.category
  UNION ALL
  SELECT b.m, b.type::text, NULL::uuid, 'Không có hạng mục'::text, NULL::text,
         SUM(b.total_amount)::numeric, COUNT(*)
  FROM base b
  WHERE NOT EXISTS (
    SELECT 1 FROM public.income_expense_items x WHERE x.income_expense_id = b.id
  )
  GROUP BY b.m, b.type
  ORDER BY 1, 2, 6 DESC;
$$;
COMMENT ON FUNCTION public.fa_type_breakdown(date, date, uuid[]) IS
'Cơ cấu thu/chi KQKD theo tháng × hạng mục (item-level: loại item is_deposit trừ khi phiếu ép TRUE). Σ total_amount == Σ fa_monthly_pnl cùng kỳ.';

-- ── 7) fa_accrual_allocations: item-level thay cờ cả-phiếu ─────────────
--    (nguồn thật của Phân bổ LN cổ đông qua fa_monthly_pnl_accrual.)
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
  -- Phiếu trong phạm vi toà (bỏ phiếu ép KHÔNG-KQKD); phiếu trộn vẫn vào,
  -- item cọc bị loại ở các nhánh bên dưới. Suy tháng kỳ hoá đơn nếu gắn HĐ.
  v AS (
    SELECT ie.id, ie.type::text AS side, ie.voucher_date,
           a.id AS bid, a.name AS bname, a.is_virtual,
           ie.total_amount,
           ie.business_result_accounting AS override,
           CASE
             WHEN ie.invoice_id IS NOT NULL AND inv.billing_month ~ '^\d{4}-\d{2}$'
             THEN to_date(inv.billing_month, 'YYYY-MM')
           END AS inv_month
    FROM allowed a
    JOIN public.income_expenses ie ON ie.building_id = a.id
    LEFT JOIN public.invoices inv ON inv.id = ie.invoice_id AND inv.deleted_at IS NULL
    WHERE ie.deleted_at IS NULL
      AND ie.approval_status = 'APPROVED'
      AND ie.business_result_accounting IS DISTINCT FROM false
  ),
  -- ── Nhánh A: phiếu GẮN hoá đơn → trọn vào billing_month ──
  a_items AS (
    SELECT v.inv_month AS m, v.id, v.bid, v.bname, v.is_virtual, v.side,
           t.id AS tid, t.name AS tname, t.category, it.amount::numeric AS amt
    FROM v
    JOIN public.income_expense_items it ON it.income_expense_id = v.id
    JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
    WHERE v.inv_month IS NOT NULL
      AND (v.override IS TRUE OR t.is_deposit = false)
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
      AND (v.override IS TRUE OR t.is_deposit = false)
      AND it.start_date IS NOT NULL AND it.end_date IS NOT NULL
      AND it.end_date >= it.start_date
  ),
  b_period_bad AS (
    SELECT date_trunc('month', it.start_date)::date AS m,
           v.id, v.bid, v.bname, v.is_virtual, v.side,
           t.id AS tid, t.name AS tname, t.category, it.amount::numeric AS amt
    FROM v
    JOIN public.income_expense_items it ON it.income_expense_id = v.id
    JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
    WHERE v.inv_month IS NULL
      AND (v.override IS TRUE OR t.is_deposit = false)
      AND it.start_date IS NOT NULL AND it.end_date IS NOT NULL
      AND it.end_date < it.start_date
  ),
  b_noperiod AS (
    SELECT date_trunc('month', v.voucher_date)::date AS m,
           v.id, v.bid, v.bname, v.is_virtual, v.side,
           t.id AS tid, t.name AS tname, t.category, it.amount::numeric AS amt
    FROM v
    JOIN public.income_expense_items it ON it.income_expense_id = v.id
    JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id
    WHERE v.inv_month IS NULL
      AND (v.override IS TRUE OR t.is_deposit = false)
      AND (it.start_date IS NULL OR it.end_date IS NULL)
  ),
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
COMMENT ON FUNCTION public.fa_accrual_allocations(date, date, uuid[]) IS
'Helper nội bộ (KHÔNG cấp cho authenticated): bung phiếu KQKD thành dòng phân bổ accrual tháng × toà × hạng mục. Item-level: loại item is_deposit (trừ phiếu ép TRUE); phiếu ép FALSE bỏ hẳn. Gọi qua fa_monthly_pnl_accrual / fa_type_breakdown_accrual.';

-- ── 8) monthly_building_profit (legacy — FE không còn gọi, sửa cho nhất quán)
CREATE OR REPLACE FUNCTION public.monthly_building_profit(
  p_start date,
  p_end   date,
  p_building_id uuid DEFAULT NULL
)
RETURNS TABLE (
  building_id   uuid,
  building_name text,
  total_income  numeric,
  total_expense numeric,
  net_profit    numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  v_owner := (SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1);

  RETURN QUERY
  SELECT
    b.id,
    b.name,
    COALESCE(i.total, 0)::numeric,
    COALESCE(e.total, 0)::numeric,
    (COALESCE(i.total, 0) - COALESCE(e.total, 0))::numeric
  FROM public.buildings b
  LEFT JOIN (
    SELECT ie.building_id, SUM(ie.kqkd_amount) AS total
    FROM public.income_expenses ie
    WHERE ie.user_id = v_owner
      AND ie.type = 'INCOME'
      AND ie.kqkd_amount > 0
      AND ie.approval_status = 'APPROVED'
      AND ie.deleted_at IS NULL
      AND ie.voucher_date BETWEEN p_start AND p_end
    GROUP BY ie.building_id
  ) i ON i.building_id = b.id
  LEFT JOIN (
    SELECT ie.building_id, SUM(ie.kqkd_amount) AS total
    FROM public.income_expenses ie
    WHERE ie.user_id = v_owner
      AND ie.type = 'EXPENSE'
      AND ie.kqkd_amount > 0
      AND ie.approval_status = 'APPROVED'
      AND ie.deleted_at IS NULL
      AND ie.voucher_date BETWEEN p_start AND p_end
    GROUP BY ie.building_id
  ) e ON e.building_id = b.id
  WHERE b.user_id = v_owner
    AND b.is_virtual = false
    AND b.deleted_at IS NULL
    AND (p_building_id IS NULL OR b.id = p_building_id)
  ORDER BY b.name;
END;
$$;

-- ── 9) recompute_contract_deposit_paid: cộng theo ITEM cọc ─────────────
--    (phiếu trộn: chỉ phần item cọc vào deposit_paid, không lôi cả total.)
CREATE OR REPLACE FUNCTION public.recompute_contract_deposit_paid(p_contract_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total NUMERIC(15,2) := 0;
  v_count INT := 0;
BEGIN
  IF p_contract_id IS NULL THEN
    RETURN;
  END IF;

  SELECT COALESCE(SUM(it.amount), 0), COUNT(DISTINCT ie.id)
  INTO v_total, v_count
  FROM income_expenses ie
  JOIN income_expense_items it ON it.income_expense_id = ie.id
  JOIN income_expense_types t  ON t.id = it.income_expense_type_id AND t.is_deposit = TRUE
  WHERE ie.contract_id = p_contract_id
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND ie.deleted_at IS NULL;

  -- Chỉ ghi đè khi có IE cọc thực sự → tránh đè 0 lên giá trị từ deposits.
  IF v_count > 0 THEN
    UPDATE contracts
    SET deposit_paid = v_total,
        updated_at = NOW()
    WHERE id = p_contract_id
      AND deleted_at IS NULL;
  END IF;
END;
$$;

-- ── 10) get_deposit_breakdown_v2: amount = Σ item cọc của phiếu ────────
CREATE OR REPLACE FUNCTION public.get_deposit_breakdown_v2(
  p_building_id uuid DEFAULT NULL::uuid,
  p_room_id uuid DEFAULT NULL::uuid,
  p_start_date date DEFAULT NULL::date,
  p_end_date date DEFAULT NULL::date,
  p_billing_month text DEFAULT NULL::text,
  p_building_ids uuid[] DEFAULT NULL::uuid[]
)
 RETURNS TABLE(
   building_id uuid, building_name text, room_id uuid, room_name text,
   contract_id uuid, contract_number text,
   total_deposit numeric, deposit_paid numeric, deposit_remaining numeric, deposit_debt_mode text,
   voucher_id uuid, code text, voucher_date date, amount numeric, account_name text, notes text,
   invoice_id uuid, invoice_number text, invoice_total numeric
 )
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ie.building_id, b.name, ie.room_id, r.name,
    ie.contract_id, c.contract_number,
    c.total_deposit, c.deposit_paid, c.deposit_remaining, c.deposit_debt_mode,
    ie.id, ie.code, ie.voucher_date,
    dep.amount,
    COALESCE(a.name,''), ie.notes,
    inv.id, inv.invoice_number, inv.total_amount
  FROM income_expenses ie
  JOIN LATERAL (
    SELECT COALESCE(SUM(it.amount), 0) AS amount
    FROM income_expense_items it
    JOIN income_expense_types t ON t.id = it.income_expense_type_id
    WHERE it.income_expense_id = ie.id AND t.is_deposit = TRUE
  ) dep ON dep.amount > 0
  LEFT JOIN buildings b ON b.id = ie.building_id
  LEFT JOIN rooms r ON r.id = ie.room_id
  LEFT JOIN contracts c ON c.id = ie.contract_id
  LEFT JOIN accounts a ON a.id = ie.account_id
  LEFT JOIN invoices inv ON inv.id = ie.invoice_id AND inv.deleted_at IS NULL
  WHERE ie.deleted_at IS NULL AND ie.type='INCOME' AND ie.approval_status='APPROVED'
    AND public.can_access_building(ie.building_id)
    AND (p_building_id IS NULL OR ie.building_id = p_building_id)
    AND (p_building_ids IS NULL OR ie.building_id = ANY(p_building_ids))
    AND (p_room_id IS NULL OR ie.room_id = p_room_id)
    AND (p_start_date IS NULL OR ie.voucher_date >= p_start_date)
    AND (p_end_date IS NULL OR ie.voucher_date <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date,'YYYY-MM') = p_billing_month)
  ORDER BY b.name, r.name, ie.voucher_date;
$function$;

-- ── 11) get_invoice_statistics_v2: deposit_collected = Σ item cọc ──────
--     (chép nguyên bản 20260701170000, CHỈ đổi khối "Cọc đã thu".)
CREATE OR REPLACE FUNCTION public.get_invoice_statistics_v2(p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_status invoice_status DEFAULT NULL::invoice_status, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_billing_month text DEFAULT NULL::text, p_payment_status text DEFAULT NULL::text, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_paid        DECIMAL(15, 2) := 0;
  v_total_remaining   DECIMAL(15, 2) := 0;
  v_total_amount      DECIMAL(15, 2) := 0;
  v_total_refunded    DECIMAL(15, 2) := 0;
  v_total_count       BIGINT         := 0;
  v_rent_amount       DECIMAL(15, 2) := 0;
  v_electric_amount   DECIMAL(15, 2) := 0;
  v_water_amount      DECIMAL(15, 2) := 0;
  v_pdv_amount        DECIMAL(15, 2) := 0;
  v_total_collected   DECIMAL(15, 2) := 0;
  v_payment_tm        DECIMAL(15, 2) := 0;
  v_payment_tk        DECIMAL(15, 2) := 0;
  v_payment_tt        DECIMAL(15, 2) := 0;
  v_change_amount     DECIMAL(15, 2) := 0;
  v_deposit_collected DECIMAL(15, 2) := 0;
  v_payment_ct        DECIMAL(15, 2) := 0;
  v_priv              BOOLEAN        := FALSE;  -- thấy mọi toà
  v_bids              uuid[]         := NULL;   -- tập toà được phép (khi không priv)
BEGIN
  -- Tính phạm vi toà MỘT lần (thay can_access_building per-row).
  IF public.is_super_admin() OR public.is_admin()
     OR EXISTS (
       SELECT 1 FROM public.staff_assignments sa
       WHERE sa.staff_id = auth.uid() AND sa.building_id IS NULL AND sa.area_id IS NULL
     ) THEN
    v_priv := TRUE;
  ELSE
    SELECT array_agg(DISTINCT b) INTO v_bids
    FROM (
      SELECT sa.building_id AS b
      FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid() AND sa.building_id IS NOT NULL
      UNION
      SELECT ab.building_id
      FROM public.staff_assignments sa2
      JOIN public.area_buildings ab ON ab.area_id = sa2.area_id
      WHERE sa2.staff_id = auth.uid() AND sa2.area_id IS NOT NULL
      UNION
      SELECT pmsb.building_id
      FROM public.profit_manager_salary_buildings pmsb
      JOIN public.profit_manager_salaries pms ON pms.id = pmsb.salary_id
      JOIN public.profit_managers pm ON pm.id = pms.manager_id
      WHERE pm.auth_user_id = auth.uid() AND pm.deleted_at IS NULL
    ) q;
  END IF;

  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
    FROM public.invoices i
    WHERE i.deleted_at IS NULL
      AND (v_priv OR i.building_id = ANY(v_bids))
      AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
      AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
      AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
      AND (p_status        IS NULL OR i.status        = p_status)
      AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
      AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
      AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
      AND (
        p_payment_status IS NULL
        OR (p_payment_status = 'paid'    AND i.status = 'PAID')
        OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
        OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
      )
  )
  SELECT
    COALESCE(SUM(total_amount), 0),
    COALESCE(SUM(paid_amount), 0),
    COALESCE(SUM(GREATEST(remaining_amount, 0)), 0),
    COALESCE(SUM(GREATEST(-remaining_amount, 0)), 0),
    COUNT(*)
  INTO v_total_amount, v_total_paid, v_total_remaining, v_total_refunded, v_total_count
  FROM filtered_invoices;

  SELECT
    COALESCE(SUM(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%điện%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%điện%'
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0)
  INTO v_rent_amount, v_electric_amount, v_water_amount, v_pdv_amount
  FROM public.invoices i
  JOIN public.invoice_items ii ON ii.invoice_id = i.id
  WHERE i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT
    COALESCE(SUM(p.amount), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TM' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TK' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'CT' THEN p.amount ELSE 0 END), 0)
  INTO v_total_collected, v_payment_tm, v_payment_tk, v_payment_tt, v_payment_ct
  FROM public.payments p
  JOIN public.invoices i ON i.id = p.invoice_id
  WHERE i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT COALESCE(SUM(ie.change_amount), 0)
  INTO v_change_amount
  FROM public.income_expenses ie
  JOIN public.invoices i ON i.id = ie.invoice_id
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND (v_priv OR i.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- Cọc đã thu — Σ ITEM cọc (phiếu trộn chỉ tính phần cọc, không lôi cả total).
  SELECT COALESCE(SUM(it.amount), 0)
  INTO v_deposit_collected
  FROM public.income_expenses ie
  JOIN public.income_expense_items it ON it.income_expense_id = ie.id
  JOIN public.income_expense_types t  ON t.id = it.income_expense_type_id AND t.is_deposit = TRUE
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND (v_priv OR ie.building_id = ANY(v_bids))
    AND (p_building_id   IS NULL OR ie.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR ie.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR ie.room_id       = p_room_id)
    AND (p_start_date    IS NULL OR ie.voucher_date  >= p_start_date)
    AND (p_end_date      IS NULL OR ie.voucher_date  <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month);

  RETURN json_build_object(
    'total_amount',       v_total_amount,
    'total_paid',         v_total_paid,
    'total_remaining',    v_total_remaining,
    'total_refunded',     v_total_refunded,
    'total_count',        v_total_count,
    'rent_amount',        v_rent_amount,
    'electric_amount',    v_electric_amount,
    'water_amount',       v_water_amount,
    'pdv_amount',         v_pdv_amount,
    'total_collected',    v_total_collected,
    'payment_tm',         v_payment_tm,
    'payment_tk',         v_payment_tk,
    'payment_tt',         v_payment_tt,
    'payment_ct',         v_payment_ct,
    'change_amount',      v_change_amount,
    'deposit_collected',  v_deposit_collected
  );
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
