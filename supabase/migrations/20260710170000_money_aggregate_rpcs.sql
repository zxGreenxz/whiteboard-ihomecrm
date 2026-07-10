-- =============================================================
-- RPC SQL AGGREGATE cho các KPI/tổng tiền (chống bug class cap-1000)
-- (Phase 1b money, 2026-07-10)
--
-- Bug class (memory: "SELECT-rồi-cộng-client dính cap 1000 PostgREST"): FE
-- .from(...).select() KHÔNG .range() rồi .reduce() cộng tiền → PostgREST trả tối
-- đa 1000 dòng/response → tổng HỤT âm thầm khi vượt 1000 dòng. Thay bằng SUM()
-- trong SQL (miễn nhiễm cap-1000).
--
-- TẤT CẢ SECURITY INVOKER: mỗi hook hiện là plain PostgREST select (invoker), nên
-- aggregate INVOKER tái tạo ĐÚNG phạm vi nhìn thấy qua RLS, KHÔNG drift. (DEFINER
-- + can_access_building sẽ SAI cho reservation deposits vì income_expenses RLS có
-- fund-owner/restricted/shareholder KHÁC can_access_building.)
--
-- Đối chứng: node scripts/reconcile-money.mjs (SQL truth = authenticated RPC =
-- frontend phân trang). Sau migration: npm run gen:types.
-- Idempotent.
-- =============================================================

BEGIN;

-- ── 1. Tiền thừa (overpayment) — invoices paid_amount > total_amount ─────────
CREATE OR REPLACE FUNCTION public.get_overpayment_summary(p_building_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'total', COALESCE(SUM(paid_amount - total_amount) FILTER (WHERE paid_amount > total_amount), 0),
    'count', COALESCE(COUNT(*) FILTER (WHERE paid_amount > total_amount), 0)
  )
  FROM public.invoices
  WHERE paid_amount > 0
    AND deleted_at IS NULL           -- vá luôn latent: không tính hoá đơn đã xoá
    AND (p_building_ids IS NULL OR building_id = ANY(p_building_ids));
$$;

-- ── 2. Cọc đang giữ (held) — per-building, HĐ ACTIVE ────────────────────────
CREATE OR REPLACE FUNCTION public.get_held_deposit_summary(
  p_building_ids uuid[] DEFAULT NULL,
  p_threshold numeric DEFAULT 10000
)
RETURNS TABLE (
  building_id uuid, building_name text, contract_count bigint,
  expected numeric, held numeric, shortfall_all numeric, shortfall_short numeric,
  full_count bigint, short_count bigint, first_invoice_count bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  WITH base AS (
    SELECT r.building_id AS bid,
           COALESCE(c.total_deposit, 0) AS td,
           COALESCE(c.deposit_paid, 0) AS dp,
           COALESCE(c.deposit_remaining, COALESCE(c.total_deposit,0) - COALESCE(c.deposit_paid,0)) AS rem,
           c.deposit_debt_mode AS ddm
    FROM public.contracts c
    JOIN public.rooms r ON r.id = c.room_id
    WHERE c.deleted_at IS NULL AND c.status = 'ACTIVE'
      AND (p_building_ids IS NULL OR r.building_id = ANY(p_building_ids))
  ),
  tagged AS (
    SELECT *, CASE WHEN rem < p_threshold THEN 'FULL'
                   WHEN ddm = 'FIRST_INVOICE' THEN 'FIRST_INVOICE'
                   ELSE 'SHORT' END AS st
    FROM base
  )
  SELECT t.bid, b.name, COUNT(*),
         SUM(td), SUM(dp),
         SUM(GREATEST(0, rem)),
         SUM(GREATEST(0, rem)) FILTER (WHERE st = 'SHORT'),
         COUNT(*) FILTER (WHERE st = 'FULL'),
         COUNT(*) FILTER (WHERE st = 'SHORT'),
         COUNT(*) FILTER (WHERE st = 'FIRST_INVOICE')
  FROM tagged t
  JOIN public.buildings b ON b.id = t.bid
  GROUP BY t.bid, b.name
  ORDER BY b.name;
$$;

-- ── 3. Cọc giữ chỗ (reservation) — income_expenses is_deposit, contract_id NULL ─
CREATE OR REPLACE FUNCTION public.get_reservation_deposit_summary(p_building_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  WITH vouchers AS (
    SELECT ie.id, ie.approval_status, ie.total_amount,
           (SELECT COALESCE(SUM(it.amount), 0)
              FROM public.income_expense_items it
              JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
             WHERE it.income_expense_id = ie.id AND t.is_deposit = true) AS dep_sum
    FROM public.income_expenses ie
    WHERE ie.contract_id IS NULL AND ie.deleted_at IS NULL AND ie.type = 'INCOME'
      AND ie.approval_status IN ('APPROVED','UNAPPROVED','CANCELLED')
      AND (p_building_ids IS NULL OR ie.building_id = ANY(p_building_ids))
      AND EXISTS (SELECT 1 FROM public.income_expense_items it
                  JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
                  WHERE it.income_expense_id = ie.id AND t.is_deposit = true)
  ),
  amt AS (
    SELECT id, approval_status,
           CASE WHEN dep_sum <> 0 THEN dep_sum ELSE total_amount END AS amount
    FROM vouchers
  )
  SELECT jsonb_build_object(
    'holding_amount', COALESCE(SUM(amount) FILTER (WHERE approval_status = 'APPROVED'), 0),
    'approved_count', COALESCE(COUNT(*) FILTER (WHERE approval_status = 'APPROVED'), 0),
    'unapproved_count', COALESCE(COUNT(*) FILTER (WHERE approval_status = 'UNAPPROVED'), 0),
    'cancelled_count', COALESCE(COUNT(*) FILTER (WHERE approval_status = 'CANCELLED'), 0)
  ) FROM amt;
$$;

-- ── 4. Hoàn/Bỏ cọc (refund/forfeit) — contract_terminations ─────────────────
CREATE OR REPLACE FUNCTION public.get_refund_forfeit_summary(p_building_ids uuid[] DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  WITH base AS (
    SELECT t.termination_type AS tt,
           COALESCE(t.total_deposit, 0) AS td,
           COALESCE(t.refund_amount, 0) AS ra
    FROM public.contract_terminations t
    JOIN public.contracts c ON c.id = t.contract_id
    JOIN public.rooms r ON r.id = c.room_id
    WHERE (p_building_ids IS NULL OR r.building_id = ANY(p_building_ids))
  )
  SELECT jsonb_build_object(
    'refund_total', COALESCE(SUM(GREATEST(0, ra)) FILTER (WHERE tt <> 'FORFEIT'), 0),
    'refund_count', COALESCE(COUNT(*) FILTER (WHERE tt <> 'FORFEIT'), 0),
    'forfeit_total', COALESCE(SUM(td) FILTER (WHERE tt = 'FORFEIT'), 0),
    'forfeit_count', COALESCE(COUNT(*) FILTER (WHERE tt = 'FORFEIT'), 0)
  ) FROM base;
$$;

-- ── 5. BC Tiền cọc (legacy deposits table) ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_deposits_report_summary(
  p_status text DEFAULT NULL,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  WITH base AS (
    SELECT d.status::text AS st, COALESCE(d.amount, 0) AS amount
    FROM public.deposits d
    LEFT JOIN public.rooms r ON r.id = d.room_id
    WHERE d.deleted_at IS NULL
      AND (p_status IS NULL OR d.status::text = p_status)
      AND (p_building_ids IS NULL OR r.building_id = ANY(p_building_ids))
  )
  SELECT jsonb_build_object(
    'total', COALESCE(SUM(amount), 0),
    'count', COALESCE(COUNT(*), 0),
    'holding_total', COALESCE(SUM(amount) FILTER (WHERE st IN ('PENDING','CONFIRMED')), 0),
    'in_invoice_total', COALESCE(SUM(amount) FILTER (WHERE st = 'CONVERTED'), 0)
  ) FROM base;
$$;

-- ── 6. Sổ quỹ: tổng thu/chi trong kỳ (income_expenses APPROVED) ─────────────
CREATE OR REPLACE FUNCTION public.cashbook_period_totals(
  p_start date DEFAULT NULL,
  p_end date DEFAULT NULL,
  p_building_id uuid DEFAULT NULL,
  p_account_id uuid DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'income', COALESCE(SUM(total_amount) FILTER (WHERE type = 'INCOME'), 0),
    'expense', COALESCE(SUM(total_amount) FILTER (WHERE type = 'EXPENSE'), 0)
  )
  FROM public.income_expenses
  WHERE approval_status = 'APPROVED' AND deleted_at IS NULL
    AND (p_start IS NULL OR voucher_date >= p_start)
    AND (p_end IS NULL OR voucher_date <= p_end)
    AND (p_building_id IS NULL OR building_id = p_building_id)
    AND (p_account_id IS NULL OR account_id = p_account_id);
$$;

-- ── 7. Sổ quỹ: dòng tiền theo ngày ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cashflow_by_day(
  p_start date,
  p_end date,
  p_building_id uuid DEFAULT NULL,
  p_account_id uuid DEFAULT NULL
)
RETURNS TABLE (day date, income numeric, expense numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  SELECT voucher_date AS day,
         COALESCE(SUM(total_amount) FILTER (WHERE type = 'INCOME'), 0) AS income,
         COALESCE(SUM(total_amount) FILTER (WHERE type = 'EXPENSE'), 0) AS expense
  FROM public.income_expenses
  WHERE approval_status = 'APPROVED' AND deleted_at IS NULL
    AND voucher_date >= p_start AND voucher_date <= p_end
    AND (p_building_id IS NULL OR building_id = p_building_id)
    AND (p_account_id IS NULL OR account_id = p_account_id)
  GROUP BY voucher_date
  ORDER BY voucher_date;
$$;

-- Grants: chỉ authenticated (mirror get_contract_stats/get_customer_stats).
DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'get_overpayment_summary(uuid[])',
    'get_held_deposit_summary(uuid[], numeric)',
    'get_reservation_deposit_summary(uuid[])',
    'get_refund_forfeit_summary(uuid[])',
    'get_deposits_report_summary(text, uuid[])',
    'cashbook_period_totals(date, date, uuid, uuid)',
    'cashflow_by_day(date, date, uuid, uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', fn);
  END LOOP;
END $$;

-- ── 8. salary_staff_months: bỏ "LIMIT 1 ngẫu nhiên" → resolve owner DETERMINISTIC ─
-- (P3 audit: một staff dưới >1 owner sẽ cho config ngẫu nhiên. Hiện 0 staff đa-owner,
--  nhưng chọn owner có NHIỀU assignment nhất, tie-break theo user_id → ổn định.)
CREATE OR REPLACE FUNCTION public.salary_staff_months()
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' STABLE
AS $$
  SELECT COALESCE(
    (
      SELECT rules -> 'staffMonths'
      FROM public.salary_bonus_rules
      WHERE user_id = COALESCE(
        (SELECT sa.user_id FROM public.super_admins sa WHERE sa.user_id = auth.uid()),
        (SELECT b.user_id FROM public.buildings b
          WHERE b.user_id = auth.uid() AND b.deleted_at IS NULL LIMIT 1),
        (SELECT sa.user_id FROM public.staff_assignments sa
          WHERE sa.staff_id = auth.uid()
          GROUP BY sa.user_id
          ORDER BY count(*) DESC, sa.user_id ASC
          LIMIT 1),
        auth.uid()
      )
      LIMIT 1
    ),
    '{}'::jsonb
  );
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- =============================================================
-- ROLLBACK: DROP FUNCTION các hàm get_*_summary/cashbook_period_totals/
-- cashflow_by_day; salary_staff_months quay lại bản deterministic KHÔNG cần
-- (bản trước cũng an toàn). KHÔNG khôi phục bản LIMIT 1 ngẫu nhiên.
-- =============================================================
