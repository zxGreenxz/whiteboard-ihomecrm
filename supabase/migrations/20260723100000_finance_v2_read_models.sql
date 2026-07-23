-- Finance V2 (Thu Chi V2) — Stage 10: read-models v2 (plan §11.2/§11.3).
-- ADDITIVE: accounts_with_balance_v2 (posting-based, security_invoker) +
-- effective_profit_contributions_v2 resolver + posting-based aggregate RPCs v2 + close
-- blockers. Legacy read models untouched until the read-semantics cutover repoints consumers.

BEGIN;

-- Finance V2 (Thu Chi V2) — Stage 10: READ-MODELS V2 (plan §11.2 / §11.3 / §11.4).
-- ADDITIVE. Creates *_v2 read models that compute from canonical posting lines /
-- recognition. The LEGACY accounts_with_balance and money-aggregate RPCs are LEFT
-- UNTOUCHED (the legacy app keeps working until the read-semantics cutover repoints
-- consumers). No feature mode changed, no org enrolled.
-- BODY ONLY: orchestrator wraps in one txn. No BEGIN/COMMIT/NOTIFY. Idempotent.

-- =====================================================================
-- §11.2 — CASH BALANCE: accounts_with_balance_v2
-- current_amount = initial_amount + SUM(income_expense_posting_lines.signed_amount)
-- over the account, from POSTING/REVERSAL events only, NO approval_status filter,
-- composite (organization_id, account_id). security_invoker=true.
-- =====================================================================
DROP VIEW IF EXISTS public.accounts_with_balance_v2;
CREATE VIEW public.accounts_with_balance_v2
WITH (security_invoker = true) AS
  SELECT
    a.id,
    a.user_id,
    a.name,
    a.bank_name,
    a.account_number,
    a.is_default,
    a.created_at,
    a.updated_at,
    a.deleted_at,
    a.code,
    a.description,
    a.bank_account_holder,
    a.initial_amount,
    a.initial_date,
    a.lock_date,
    a.branch,
    a.is_virtual,
    a.organization_id,
    COALESCE(a.initial_amount, 0::numeric)
      + COALESCE((
          SELECT sum(pl.signed_amount)
          FROM public.income_expense_posting_lines pl
          JOIN public.income_expense_postings p
            ON p.id = pl.posting_id
           AND p.organization_id = pl.organization_id
          WHERE pl.organization_id = a.organization_id
            AND pl.account_id = a.id
            AND p.event_kind IN ('POSTING', 'REVERSAL')
        ), 0::numeric) AS current_amount
  FROM public.accounts a
  WHERE a.deleted_at IS NULL;

-- Belt-and-suspenders (án lệ 20260704180000: recreate view RỚT security_invoker).
ALTER VIEW public.accounts_with_balance_v2 SET (security_invoker = true);

-- Narrow the broad grants; mirror the roles the legacy view grants but SELECT-only.
REVOKE ALL ON public.accounts_with_balance_v2 FROM PUBLIC;
REVOKE ALL ON public.accounts_with_balance_v2 FROM anon, authenticated, service_role;
GRANT SELECT ON public.accounts_with_balance_v2 TO anon, authenticated, service_role;

COMMENT ON VIEW public.accounts_with_balance_v2 IS
  'Plan §11.2: cash balance from canonical posting lines (initial_amount + SUM signed_amount over POSTING/REVERSAL events, composite org/account, no approval filter). Additive; legacy accounts_with_balance untouched. security_invoker=true.';

-- =====================================================================
-- §11.3 — CANONICAL P&L RESOLVER: app_private.effective_profit_contributions_v2
-- Single source for P&L / close / counter / blocker reads. Owner-only.
--   BASE_ALLOCATION: from active BASE-voucher allocations (recognition_source_mode
--     ='BASE' AND counts_in_business_result), INCLUDING pending UNAPPROVED, EXCLUDING
--     CANCELLED. NOT gated on approval_status='APPROVED', NOT gated on posting. PNL
--     item amounts allocated by billing month / item period / voucher_date (mirror
--     the accrual allocator), signed by voucher type (EXPENSE -> negative).
--   RECOGNITION_ADJUSTMENT: from income_expense_recognition_adjustments with
--     target_period = adjustment_period; server-owned signed delta + allocation
--     snapshot, carrying the voucher's CURRENT approval/review state so close knows
--     whether the contribution is still pending.
-- p_period NULL -> all periods; otherwise filter target_period = month(p_period).
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.effective_profit_contributions_v2(uuid, date);
CREATE FUNCTION app_private.effective_profit_contributions_v2(p_org uuid, p_period date)
RETURNS TABLE(
  organization_id        uuid,
  target_period          date,
  contribution_kind      text,
  contribution_id        uuid,
  source_voucher_id      uuid,
  source_approval_status text,
  source_review_state    text,
  source_version         bigint,
  signed_kqkd_amount     numeric,
  allocation_snapshot    jsonb,
  source_payload_hash    text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $effective_profit_contributions_v2$
  WITH base_v AS (
    SELECT ie.id                       AS voucher_id,
           ie.organization_id          AS org_id,
           ie.type                     AS vtype,
           ie.voucher_date             AS vdate,
           ie.approval_status          AS appr,
           ie.review_state             AS rev,
           ie.approval_version         AS appr_ver,
           ie.recognition_date         AS recog_date,
           ie.source_payload_hash      AS src_hash,
           CASE
             WHEN ie.invoice_id IS NOT NULL AND inv.billing_month ~ '^\d{4}-\d{2}$'
             THEN to_date(inv.billing_month, 'YYYY-MM')
           END                          AS inv_month
    FROM public.income_expenses ie
    LEFT JOIN public.invoices inv
      ON inv.id = ie.invoice_id AND inv.deleted_at IS NULL
    WHERE ie.organization_id = p_org
      AND ie.deleted_at IS NULL
      AND ie.recognition_source_mode = 'BASE'
      AND ie.counts_in_business_result = true
      AND ie.approval_status <> 'CANCELLED'
  ),
  pnl_item AS (
    SELECT it.income_expense_id AS voucher_id,
           it.amount            AS amount,
           it.start_date        AS start_date,
           it.end_date          AS end_date
    FROM public.income_expense_items it
    WHERE COALESCE(it.accounting_class, 'PNL') = 'PNL'
  ),
  alloc AS (
    -- A: invoice-linked -> whole PNL item amount into billing month.
    SELECT v.voucher_id, date_trunc('month', v.inv_month)::date AS m, it.amount AS amt
    FROM base_v v
    JOIN pnl_item it ON it.voucher_id = v.voucher_id
    WHERE v.inv_month IS NOT NULL
    UNION ALL
    -- B1: item with a valid period -> progressive-rounding monthly split.
    SELECT v.voucher_id,
           (date_trunc('month', it.start_date) + (gs.i || ' month')::interval)::date AS m,
           (round(it.amount * (gs.i + 1) / n.n) - round(it.amount * gs.i / n.n))::numeric AS amt
    FROM base_v v
    JOIN pnl_item it ON it.voucher_id = v.voucher_id
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
    UNION ALL
    -- B1b: dirty period (end < start) -> gather into start month.
    SELECT v.voucher_id, date_trunc('month', it.start_date)::date AS m, it.amount AS amt
    FROM base_v v
    JOIN pnl_item it ON it.voucher_id = v.voucher_id
    WHERE v.inv_month IS NULL
      AND it.start_date IS NOT NULL AND it.end_date IS NOT NULL
      AND it.end_date < it.start_date
    UNION ALL
    -- B2: item without a period -> whole amount into voucher_date month.
    SELECT v.voucher_id, date_trunc('month', v.vdate)::date AS m, it.amount AS amt
    FROM base_v v
    JOIN pnl_item it ON it.voucher_id = v.voucher_id
    WHERE v.inv_month IS NULL
      AND (it.start_date IS NULL OR it.end_date IS NULL)
  ),
  base_contrib AS (
    SELECT v.org_id, a.m AS tperiod, v.voucher_id, v.vtype,
           v.appr, v.rev, v.appr_ver, v.src_hash,
           SUM(CASE WHEN v.vtype = 'EXPENSE' THEN -a.amt ELSE a.amt END)::numeric AS signed_kqkd
    FROM alloc a
    JOIN base_v v ON v.voucher_id = a.voucher_id
    GROUP BY v.org_id, a.m, v.voucher_id, v.vtype, v.appr, v.rev, v.appr_ver, v.src_hash
  )
  SELECT
    bc.org_id                              AS organization_id,
    bc.tperiod                             AS target_period,
    'BASE_ALLOCATION'::text                AS contribution_kind,
    bc.voucher_id                          AS contribution_id,
    bc.voucher_id                          AS source_voucher_id,
    bc.appr                                AS source_approval_status,
    bc.rev                                 AS source_review_state,
    bc.appr_ver                            AS source_version,
    bc.signed_kqkd                         AS signed_kqkd_amount,
    jsonb_build_object(
      'kind', 'BASE_ALLOCATION',
      'voucher_id', bc.voucher_id,
      'voucher_type', bc.vtype,
      'target_period', bc.tperiod,
      'signed_kqkd_amount', bc.signed_kqkd
    )                                      AS allocation_snapshot,
    bc.src_hash                            AS source_payload_hash
  FROM base_contrib bc
  WHERE (p_period IS NULL OR bc.tperiod = date_trunc('month', p_period)::date)

  UNION ALL

  SELECT
    adj.organization_id                            AS organization_id,
    date_trunc('month', adj.adjustment_period)::date AS target_period,
    'RECOGNITION_ADJUSTMENT'::text                 AS contribution_kind,
    adj.id                                         AS contribution_id,
    adj.voucher_id                                 AS source_voucher_id,
    ie.approval_status                             AS source_approval_status,
    ie.review_state                                AS source_review_state,
    ie.approval_version                            AS source_version,
    adj.signed_amount                              AS signed_kqkd_amount,
    adj.allocation_snapshot                        AS allocation_snapshot,
    adj.source_payload_hash                        AS source_payload_hash
  FROM public.income_expense_recognition_adjustments adj
  JOIN public.income_expenses ie
    ON ie.id = adj.voucher_id AND ie.organization_id = adj.organization_id
  WHERE adj.organization_id = p_org
    AND (p_period IS NULL
         OR date_trunc('month', adj.adjustment_period)::date = date_trunc('month', p_period)::date);
$effective_profit_contributions_v2$;

REVOKE ALL ON FUNCTION app_private.effective_profit_contributions_v2(uuid, date)
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.effective_profit_contributions_v2(uuid, date) IS
  'Plan §11.3: canonical resolver of effective KQKD contributions per target period. BASE_ALLOCATION (active BASE vouchers incl. pending UNAPPROVED, excl. CANCELLED; NOT gated on APPROVED/posting) + RECOGNITION_ADJUSTMENT (adjustment_period, carrying current voucher approval/review state). Single source for P&L/close/counter/blocker; owner-only.';

-- =====================================================================
-- §11.2 — AGGREGATE RPCs v2 keyed by posted_on off posting lines.
-- Mirror the legacy signatures. SUM posting signed_amount, NO approval filter,
-- window by income_expense_postings.posted_on. SECURITY DEFINER over owner-only
-- posting tables; tenant-scoped to the caller's active org memberships via
-- public.my_org_ids(). income/expense split by line sign (cash-in vs cash-out);
-- reversals contribute the opposite flow naturally.
-- =====================================================================

-- cashbook_period_totals_v2 -> {income, expense}
DROP FUNCTION IF EXISTS public.cashbook_period_totals_v2(date, date, uuid, uuid);
CREATE FUNCTION public.cashbook_period_totals_v2(
  p_start       date DEFAULT NULL,
  p_end         date DEFAULT NULL,
  p_building_id uuid DEFAULT NULL,
  p_account_id  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $cashbook_period_totals_v2$
  SELECT jsonb_build_object(
    'income',  COALESCE(SUM(pl.signed_amount)  FILTER (WHERE pl.signed_amount > 0), 0),
    'expense', COALESCE(SUM(-pl.signed_amount) FILTER (WHERE pl.signed_amount < 0), 0)
  )
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
    AND (p_account_id IS NULL OR pl.account_id = p_account_id);
$cashbook_period_totals_v2$;
REVOKE ALL ON FUNCTION public.cashbook_period_totals_v2(date, date, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_period_totals_v2(date, date, uuid, uuid) TO authenticated;
COMMENT ON FUNCTION public.cashbook_period_totals_v2(date, date, uuid, uuid) IS
  'Plan §11.2: period income/expense from posting lines (SUM signed_amount by sign, window by posted_on, no approval filter), org-scoped. Mirrors legacy cashbook_period_totals.';

-- cashbook_opening_balance_v2 -> numeric (net SUM signed_amount before the date)
DROP FUNCTION IF EXISTS public.cashbook_opening_balance_v2(date, uuid, uuid);
CREATE FUNCTION public.cashbook_opening_balance_v2(
  p_before_date date,
  p_building_id uuid DEFAULT NULL,
  p_account_id  uuid DEFAULT NULL
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $cashbook_opening_balance_v2$
  SELECT COALESCE(SUM(pl.signed_amount), 0)
  FROM public.income_expense_posting_lines pl
  JOIN public.income_expense_postings p
    ON p.id = pl.posting_id AND p.organization_id = pl.organization_id
  LEFT JOIN public.income_expenses ie
    ON ie.id = p.voucher_id AND ie.organization_id = p.organization_id
  WHERE pl.organization_id = ANY (public.my_org_ids())
    AND p.event_kind IN ('POSTING', 'REVERSAL')
    AND p.posted_on < p_before_date
    AND (p_building_id IS NULL OR ie.building_id = p_building_id)
    AND (p_account_id IS NULL OR pl.account_id = p_account_id);
$cashbook_opening_balance_v2$;
REVOKE ALL ON FUNCTION public.cashbook_opening_balance_v2(date, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashbook_opening_balance_v2(date, uuid, uuid) TO authenticated;
COMMENT ON FUNCTION public.cashbook_opening_balance_v2(date, uuid, uuid) IS
  'Plan §11.2: opening balance = net SUM(signed_amount) of posting lines whose posted_on < p_before_date (no approval filter, no initial_amount, mirroring legacy cashbook_opening_balance semantics), org-scoped.';

-- cashflow_by_day_v2 -> (day, income, expense) grouped by posted_on
DROP FUNCTION IF EXISTS public.cashflow_by_day_v2(date, date, uuid, uuid);
CREATE FUNCTION public.cashflow_by_day_v2(
  p_start       date,
  p_end         date,
  p_building_id uuid DEFAULT NULL,
  p_account_id  uuid DEFAULT NULL
)
RETURNS TABLE(day date, income numeric, expense numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $cashflow_by_day_v2$
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
  GROUP BY p.posted_on
  ORDER BY p.posted_on;
$cashflow_by_day_v2$;
REVOKE ALL ON FUNCTION public.cashflow_by_day_v2(date, date, uuid, uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.cashflow_by_day_v2(date, date, uuid, uuid) TO authenticated;
COMMENT ON FUNCTION public.cashflow_by_day_v2(date, date, uuid, uuid) IS
  'Plan §11.2: daily cash flow from posting lines (SUM signed_amount by sign, window by posted_on, no approval filter), org-scoped. Mirrors legacy cashflow_by_day.';

-- =====================================================================
-- §11.4 — CLOSE-PREVIEW BLOCKER HELPER: finance_v2_pending_kqkd_blockers
-- Gate computed on effective contribution of the period being closed:
--   target_period = period AND signed_kqkd_amount <> 0 AND source approval
--   UNAPPROVED AND source not CANCELLED (the resolver already excludes CANCELLED
--   base; CANCELLED adjustment vouchers fall out of the UNAPPROVED filter).
-- APPROVED+UNPOSTED is an informational warning, not a blocker.
-- =====================================================================
DROP FUNCTION IF EXISTS public.finance_v2_pending_kqkd_blockers(uuid, date);
CREATE FUNCTION public.finance_v2_pending_kqkd_blockers(p_org uuid, p_period date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $finance_v2_pending_kqkd_blockers$
DECLARE
  v_period date;
  v_result jsonb;
BEGIN
  IF p_org IS NULL THEN
    RAISE EXCEPTION 'finance_v2_pending_kqkd_blockers: organization is required' USING ERRCODE = '22023';
  END IF;
  IF p_period IS NULL THEN
    RAISE EXCEPTION 'finance_v2_pending_kqkd_blockers: period is required' USING ERRCODE = '22023';
  END IF;
  IF NOT (p_org = ANY (public.my_org_ids())) THEN
    RAISE EXCEPTION 'finance_v2_pending_kqkd_blockers: not a member of organization %', p_org
      USING ERRCODE = '42501';
  END IF;

  v_period := date_trunc('month', p_period)::date;

  WITH c AS (
    SELECT ec.source_voucher_id,
           ec.source_approval_status,
           ec.source_review_state,
           ec.signed_kqkd_amount,
           ie.posting_mode,
           ie.posting_status
    FROM app_private.effective_profit_contributions_v2(p_org, v_period) ec
    LEFT JOIN public.income_expenses ie
      ON ie.id = ec.source_voucher_id AND ie.organization_id = p_org
    WHERE ec.signed_kqkd_amount <> 0
  ),
  pend AS (
    SELECT * FROM c WHERE c.source_approval_status = 'UNAPPROVED'
  ),
  appr AS (
    SELECT * FROM c
    WHERE c.source_approval_status = 'APPROVED'
      AND c.posting_mode = 'CASHBOOK'
      AND c.posting_status = 'UNPOSTED'
  )
  SELECT jsonb_build_object(
    'organization_id',          p_org,
    'target_period',            v_period,
    'pending_kqkd_count',       (SELECT COUNT(DISTINCT source_voucher_id) FROM pend),
    'pending_kqkd_amount',      COALESCE((SELECT SUM(signed_kqkd_amount) FROM pend), 0),
    'changes_requested_count',  (SELECT COUNT(DISTINCT source_voucher_id) FROM pend WHERE source_review_state = 'CHANGES_REQUESTED'),
    'disputed_count',           (SELECT COUNT(DISTINCT source_voucher_id) FROM pend WHERE source_review_state = 'DISPUTED'),
    'approved_unposted_count',  (SELECT COUNT(DISTINCT source_voucher_id) FROM appr),
    'approved_unposted_amount', COALESCE((SELECT SUM(signed_kqkd_amount) FROM appr), 0),
    'blocking_voucher_ids',     COALESCE((SELECT jsonb_agg(DISTINCT source_voucher_id) FROM pend), '[]'::jsonb)
  )
  INTO v_result;

  RETURN v_result;
END
$finance_v2_pending_kqkd_blockers$;
REVOKE ALL ON FUNCTION public.finance_v2_pending_kqkd_blockers(uuid, date) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.finance_v2_pending_kqkd_blockers(uuid, date) TO authenticated;
COMMENT ON FUNCTION public.finance_v2_pending_kqkd_blockers(uuid, date) IS
  'Plan §11.4: close-preview blockers computed from effective_profit_contributions_v2 for the period being closed (pending UNAPPROVED KQKD count/amount + changes_requested/disputed subsets + informational approved_unposted). Tenant-scoped.';

COMMIT;

NOTIFY pgrst, 'reload schema';
