-- =====================================================================
-- Đợt 0 — Vá LỖ C: ba RPC tổng hợp sổ quỹ đang rò tồn quỹ
--
-- `cashbook_period_totals_v2`, `cashbook_opening_balance_v2` và
-- `cashflow_by_day_v2` đều là SECURITY DEFINER, GRANT cho
-- `authenticated`, nhận `p_account_id` DO CLIENT GỬI, và bộ lọc duy
-- nhất là `pl.organization_id = ANY (public.my_org_ids())`.
--
-- Hệ quả: bất kỳ thành viên nào — kể cả người chỉ được "BIẾT SỔ"
-- (KNOWER) hay Viewer — chỉ cần gọi
--     cashbook_opening_balance_v2('2099-01-01', NULL, '<id sổ bất kỳ>')
-- là đọc được tồn quỹ CHÍNH XÁC của một sổ mà giao diện đang cố tình
-- che thành "—". Đúng thứ phá mô hình KNOWER mà cả tính năng thu chi
-- linh hoạt lẫn nghi thức chốt sổ đều dựa vào.
--
-- RLS trên hai bảng nguồn VỐN đã canh đúng
-- (`finance_v2_postings_select_custodian` →
--  `app_private.finance_v2_can_read_posting_v1`), nhưng SECURITY DEFINER
-- đi vòng qua RLS — nên phải tự kiểm trong thân hàm.
--
-- PHẠM VI NHÌN: cố ý RỘNG HƠN `finance_v2_can_read_posting_v1` thuần,
-- vì hàm đó chỉ chấp nhận CUSTODIAN và KHÔNG có lối thoát cho super
-- admin ⇒ áp thẳng sẽ làm bảng điều khiển của chủ về 0. Tập nhìn thấy
-- ở đây = đúng những sổ người dùng vốn đã SELECT được từ `public.accounts`
-- (policy `accounts_select` + `accounts_select_shared`), cộng thêm sổ
-- đang GIỮ (CUSTODIAN).
--
-- Đã đo trước khi áp: super admin duy nhất (90450d5f…) đang là CUSTODIAN
-- của 22 sổ và sở hữu 12 sổ ⇒ không đổi một con số nào trên màn hình chủ.
-- =====================================================================

BEGIN;

-- ── 1. Tập sổ quỹ người gọi được phép nhìn thấy TIỀN ────────────────
CREATE OR REPLACE FUNCTION app_private.ie_visible_cashbook_ids_v1()
RETURNS TABLE(cashbook_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
  SELECT a.id
  FROM public.accounts a
  WHERE a.deleted_at IS NULL
    AND a.organization_id = ANY (public.my_org_ids())
    AND (
      public.is_super_admin()
      OR a.user_id = auth.uid()
      OR public.is_account_shared_with_me(a.id)
      OR EXISTS (
        SELECT 1
        FROM public.cashbook_possession_bindings b
        JOIN public.organization_memberships m ON m.id = b.membership_id
        WHERE b.organization_id = a.organization_id
          AND b.cashbook_id     = a.id
          AND b.possession_kind = 'CUSTODIAN'
          AND b.valid_from <= now()
          AND (b.valid_to IS NULL OR b.valid_to > now())
          AND m.user_id = auth.uid()
          AND m.status  = 'ACTIVE'
      )
    );
$fn$;

REVOKE ALL ON FUNCTION app_private.ie_visible_cashbook_ids_v1()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION app_private.ie_visible_cashbook_ids_v1() IS
  'Sổ quỹ mà người gọi được nhìn thấy SỐ TIỀN. Dùng cho các RPC tổng hợp SECURITY DEFINER (vốn đi vòng qua RLS).';

-- Ném lỗi rõ ràng thay vì trả 0 im lặng khi hỏi đích danh một sổ lạ.
CREATE OR REPLACE FUNCTION app_private.assert_cashbook_readable_v1(p_account_id uuid)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  IF p_account_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_private.ie_visible_cashbook_ids_v1() v
    WHERE v.cashbook_id = p_account_id
  ) THEN
    RAISE EXCEPTION 'Không có quyền xem số dư của sổ quỹ này'
      USING ERRCODE = '42501';
  END IF;
END
$fn$;

REVOKE ALL ON FUNCTION app_private.assert_cashbook_readable_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- ── 2. cashbook_period_totals_v2 ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cashbook_period_totals_v2(
  p_start date DEFAULT NULL::date,
  p_end date DEFAULT NULL::date,
  p_building_id uuid DEFAULT NULL::uuid,
  p_account_id uuid DEFAULT NULL::uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_result jsonb;
BEGIN
  PERFORM app_private.assert_cashbook_readable_v1(p_account_id);

  SELECT jsonb_build_object(
    'income',  COALESCE(SUM(pl.signed_amount)  FILTER (WHERE pl.signed_amount > 0), 0),
    'expense', COALESCE(SUM(-pl.signed_amount) FILTER (WHERE pl.signed_amount < 0), 0)
  )
  INTO v_result
  FROM public.income_expense_posting_lines pl
  JOIN public.income_expense_postings p
    ON p.id = pl.posting_id AND p.organization_id = pl.organization_id
  LEFT JOIN public.income_expenses ie
    ON ie.id = p.voucher_id AND ie.organization_id = p.organization_id
  WHERE pl.organization_id = ANY (public.my_org_ids())
    AND p.event_kind IN ('POSTING', 'REVERSAL')
    AND (p_start IS NULL OR p.posted_on >= p_start)
    AND (p_end IS NULL OR p.posted_on <= p_end)
    AND (p_building_id IS NULL OR ie.building_id = p_building_id)
    AND (p_account_id IS NULL OR pl.account_id = p_account_id)
    AND pl.account_id IN (SELECT v.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() v);

  RETURN v_result;
END
$fn$;

-- ── 3. cashbook_opening_balance_v2 ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.cashbook_opening_balance_v2(
  p_before_date date,
  p_building_id uuid DEFAULT NULL::uuid,
  p_account_id uuid DEFAULT NULL::uuid
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
DECLARE
  v_result numeric;
BEGIN
  PERFORM app_private.assert_cashbook_readable_v1(p_account_id);

  SELECT COALESCE(SUM(pl.signed_amount), 0)
  INTO v_result
  FROM public.income_expense_posting_lines pl
  JOIN public.income_expense_postings p
    ON p.id = pl.posting_id AND p.organization_id = pl.organization_id
  LEFT JOIN public.income_expenses ie
    ON ie.id = p.voucher_id AND ie.organization_id = p.organization_id
  WHERE pl.organization_id = ANY (public.my_org_ids())
    AND p.event_kind IN ('POSTING', 'REVERSAL')
    AND p.posted_on < p_before_date
    AND (p_building_id IS NULL OR ie.building_id = p_building_id)
    AND (p_account_id IS NULL OR pl.account_id = p_account_id)
    AND pl.account_id IN (SELECT v.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() v);

  RETURN v_result;
END
$fn$;

-- ── 4. cashflow_by_day_v2 ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cashflow_by_day_v2(
  p_start date,
  p_end date,
  p_building_id uuid DEFAULT NULL::uuid,
  p_account_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(day date, income numeric, expense numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'app_private', 'public'
AS $fn$
BEGIN
  PERFORM app_private.assert_cashbook_readable_v1(p_account_id);

  RETURN QUERY
  SELECT
    p.posted_on AS day,
    COALESCE(SUM(pl.signed_amount)  FILTER (WHERE pl.signed_amount > 0), 0) AS income,
    COALESCE(SUM(-pl.signed_amount) FILTER (WHERE pl.signed_amount < 0), 0) AS expense
  FROM public.income_expense_posting_lines pl
  JOIN public.income_expense_postings p
    ON p.id = pl.posting_id AND p.organization_id = pl.organization_id
  LEFT JOIN public.income_expenses ie
    ON ie.id = p.voucher_id AND ie.organization_id = p.organization_id
  WHERE pl.organization_id = ANY (public.my_org_ids())
    AND p.event_kind IN ('POSTING', 'REVERSAL')
    AND p.posted_on >= p_start
    AND p.posted_on <= p_end
    AND (p_building_id IS NULL OR ie.building_id = p_building_id)
    AND (p_account_id IS NULL OR pl.account_id = p_account_id)
    AND pl.account_id IN (SELECT v.cashbook_id FROM app_private.ie_visible_cashbook_ids_v1() v)
  GROUP BY p.posted_on
  ORDER BY p.posted_on;
END
$fn$;

COMMIT;
