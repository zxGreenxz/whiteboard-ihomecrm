-- Finance V2 (Thu Chi V2) — Stage 9: SHADOW RECONCILE (plan §10.4 / §10.5).
-- ADDITIVE parity + monitoring ONLY. Creates owner-only reconciliation surfaces that run the
-- legacy vs V2 read models side by side (balance per book, accrual P&L per period), plus a
-- single-call SHADOW gate readout and a best-effort bypass-writer monitor for alerting.
--
-- This stage changes NO feature mode, enrolls NO org, and creates NO client-facing surface:
-- every object here is REVOKEd from PUBLIC/anon/authenticated/service_role and lives in
-- app_private (owner-only). It reads the Stage-10 *_v2 read models (accounts_with_balance_v2,
-- effective_profit_contributions_v2) and the Stage-2/4 control-plane ledgers; it writes nothing.
--
-- BODY ONLY: the orchestrator wraps this in one transaction. NO BEGIN/COMMIT/NOTIFY.
-- Idempotent: DROP VIEW IF EXISTS + CREATE, DROP FUNCTION IF EXISTS + CREATE, REVOKE-only ACL.

-- =====================================================================
-- §10.4/§10.5 — BALANCE PARITY per (organization_id, account_id).
-- Legacy cash balance (public.accounts_with_balance = initial + APPROVED
-- income/expense/change/rounding sums) vs V2 cash balance
-- (public.accounts_with_balance_v2 = initial + SUM posting-line signed_amount).
-- Scope: REAL (non-virtual) accounts are the parity target — virtual books are
-- the internal/non-cash ledgers (plan §10.1 rule 6) excluded from cash parity by
-- design. organization_id/is_virtual come from public.accounts (the legacy view
-- exposes neither). Owner-only; security_invoker=true.
-- =====================================================================
BEGIN;

DROP VIEW IF EXISTS app_private.finance_v2_balance_parity_v1;
CREATE VIEW app_private.finance_v2_balance_parity_v1
WITH (security_invoker = true) AS
  SELECT
    a.organization_id,
    a.id                                                                        AS account_id,
    a.name                                                                      AS account_name,
    a.is_virtual,
    legacy.current_amount                                                       AS legacy_current_amount,
    v2.current_amount                                                           AS v2_current_amount,
    (COALESCE(legacy.current_amount, 0) - COALESCE(v2.current_amount, 0))       AS diff,
    (abs(COALESCE(legacy.current_amount, 0) - COALESCE(v2.current_amount, 0)) < 0.01) AS is_match
  FROM public.accounts a
  JOIN public.accounts_with_balance    legacy ON legacy.id = a.id
  JOIN public.accounts_with_balance_v2 v2     ON v2.id = a.id
  WHERE a.deleted_at IS NULL
    AND a.is_virtual = false;

-- Belt-and-suspenders (án lệ 20260704180000: recreate view RỚT security_invoker).
ALTER VIEW app_private.finance_v2_balance_parity_v1 SET (security_invoker = true);
REVOKE ALL ON app_private.finance_v2_balance_parity_v1 FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON VIEW app_private.finance_v2_balance_parity_v1 IS
  'Plan §10.4/§10.5 SHADOW: per real (non-virtual) account, legacy accounts_with_balance.current_amount vs V2 accounts_with_balance_v2.current_amount, diff, is_match (abs(diff)<0.01). After backfill the two MUST tie out per book; any is_match=false is a cutover blocker. Owner-only; additive.';

-- =====================================================================
-- §10.4/§10.5 — P&L (KQKD) PARITY per (organization_id, period).
-- Legacy accrual P&L reproduces public.fa_monthly_pnl_accrual's accrual allocator
-- (invoice -> billing_month whole; item period -> progressive-rounding monthly split;
-- dirty period -> start month; no-period item / no-item voucher -> voucher_date month;
-- EXPENSE negative), filtered to the SAME legacy basis (APPROVED + counts_in_business_result
-- + deleted_at IS NULL), but WITHOUT the per-caller can_access_building gate (owner-only
-- reconciliation is cross-org). V2 side = SUM(signed_kqkd_amount) over
-- app_private.effective_profit_contributions_v2 (BASE incl. pending + RECOGNITION_ADJUSTMENT).
--
-- The two bases differ by construction: V2 recognizes pending UNAPPROVED base vouchers and
-- carries recognition adjustments, and drops no-item vouchers, whereas legacy is APPROVED-only,
-- item-or-total. So `diff` (legacy - v2 effective) is EXPECTED non-zero wherever pending /
-- adjustment / no-item drift exists — it is the monitoring signal. `diff_approved_basis`
-- (legacy - v2 restricted to APPROVED contributions) is the CLEAN tie-out the cutover gate
-- watches. Owner-only; security_invoker=true.
-- =====================================================================
DROP VIEW IF EXISTS app_private.finance_v2_pnl_parity_v1;
CREATE VIEW app_private.finance_v2_pnl_parity_v1
WITH (security_invoker = true) AS
  WITH legacy_base AS (
    SELECT
      ie.id              AS voucher_id,
      ie.organization_id AS org_id,
      ie.type            AS vtype,
      ie.voucher_date    AS vdate,
      ie.total_amount    AS total_amount,
      CASE
        WHEN ie.invoice_id IS NOT NULL AND inv.billing_month ~ '^\d{4}-\d{2}$'
        THEN to_date(inv.billing_month, 'YYYY-MM')
      END                AS inv_month
    FROM public.income_expenses ie
    JOIN public.buildings b   ON b.id = ie.building_id AND b.deleted_at IS NULL
    LEFT JOIN public.invoices inv ON inv.id = ie.invoice_id AND inv.deleted_at IS NULL
    WHERE ie.deleted_at IS NULL
      AND ie.approval_status = 'APPROVED'
      AND ie.counts_in_business_result = true
  ),
  legacy_alloc AS (
    -- A: invoice-linked voucher WITH items -> each item amount into billing month.
    SELECT v.org_id, v.vtype, date_trunc('month', v.inv_month)::date AS m, it.amount::numeric AS amt
    FROM legacy_base v
    JOIN public.income_expense_items it ON it.income_expense_id = v.voucher_id
    WHERE v.inv_month IS NOT NULL
    UNION ALL
    -- A-noitem: invoice-linked voucher WITHOUT items -> total into billing month.
    SELECT v.org_id, v.vtype, date_trunc('month', v.inv_month)::date, v.total_amount
    FROM legacy_base v
    WHERE v.inv_month IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.income_expense_items x WHERE x.income_expense_id = v.voucher_id)
    UNION ALL
    -- B1: no invoice, item with a valid period -> progressive-rounding monthly split.
    SELECT v.org_id, v.vtype,
           (date_trunc('month', it.start_date) + (gs.i || ' month')::interval)::date,
           (round(it.amount * (gs.i + 1) / n.n) - round(it.amount * gs.i / n.n))::numeric
    FROM legacy_base v
    JOIN public.income_expense_items it ON it.income_expense_id = v.voucher_id
    CROSS JOIN LATERAL (
      SELECT GREATEST(
        (extract(year FROM it.end_date)::int * 12 + extract(month FROM it.end_date)::int)
      - (extract(year FROM it.start_date)::int * 12 + extract(month FROM it.start_date)::int) + 1,
        1) AS n
    ) n
    CROSS JOIN LATERAL generate_series(0, n.n - 1) AS gs(i)
    WHERE v.inv_month IS NULL
      AND it.start_date IS NOT NULL AND it.end_date IS NOT NULL AND it.end_date >= it.start_date
    UNION ALL
    -- B1b: no invoice, dirty period (end < start) -> gather into start month.
    SELECT v.org_id, v.vtype, date_trunc('month', it.start_date)::date, it.amount::numeric
    FROM legacy_base v
    JOIN public.income_expense_items it ON it.income_expense_id = v.voucher_id
    WHERE v.inv_month IS NULL
      AND it.start_date IS NOT NULL AND it.end_date IS NOT NULL AND it.end_date < it.start_date
    UNION ALL
    -- B2: no invoice, item WITHOUT a period -> whole amount into voucher_date month.
    SELECT v.org_id, v.vtype, date_trunc('month', v.vdate)::date, it.amount::numeric
    FROM legacy_base v
    JOIN public.income_expense_items it ON it.income_expense_id = v.voucher_id
    WHERE v.inv_month IS NULL
      AND (it.start_date IS NULL OR it.end_date IS NULL)
    UNION ALL
    -- B-noitem: no invoice, no items -> total into voucher_date month.
    SELECT v.org_id, v.vtype, date_trunc('month', v.vdate)::date, v.total_amount
    FROM legacy_base v
    WHERE v.inv_month IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.income_expense_items x WHERE x.income_expense_id = v.voucher_id)
  ),
  legacy_pnl AS (
    SELECT org_id AS organization_id, m AS period,
           SUM(CASE WHEN vtype = 'EXPENSE' THEN -amt ELSE amt END)::numeric AS legacy_pnl
    FROM legacy_alloc
    GROUP BY org_id, m
  ),
  v2_pnl AS (
    SELECT ec.organization_id,
           ec.target_period AS period,
           SUM(ec.signed_kqkd_amount)::numeric                                                   AS v2_pnl,
           SUM(ec.signed_kqkd_amount) FILTER (WHERE ec.source_approval_status = 'APPROVED')::numeric AS v2_pnl_approved
    FROM (SELECT DISTINCT organization_id FROM public.income_expenses WHERE deleted_at IS NULL) o
    CROSS JOIN LATERAL app_private.effective_profit_contributions_v2(o.organization_id, NULL::date) ec
    GROUP BY ec.organization_id, ec.target_period
  )
  SELECT
    COALESCE(l.organization_id, v.organization_id)                                       AS organization_id,
    COALESCE(l.period, v.period)                                                         AS period,
    COALESCE(l.legacy_pnl, 0)                                                            AS legacy_pnl_accrual,
    COALESCE(v.v2_pnl, 0)                                                                AS v2_pnl_effective,
    COALESCE(v.v2_pnl_approved, 0)                                                       AS v2_pnl_approved_basis,
    (COALESCE(l.legacy_pnl, 0) - COALESCE(v.v2_pnl, 0))                                  AS diff,
    (COALESCE(l.legacy_pnl, 0) - COALESCE(v.v2_pnl_approved, 0))                         AS diff_approved_basis,
    (abs(COALESCE(l.legacy_pnl, 0) - COALESCE(v.v2_pnl, 0)) < 0.01)                      AS is_match,
    (abs(COALESCE(l.legacy_pnl, 0) - COALESCE(v.v2_pnl_approved, 0)) < 0.01)             AS is_match_approved_basis
  FROM legacy_pnl l
  FULL JOIN v2_pnl v
    ON v.organization_id = l.organization_id AND v.period = l.period;

ALTER VIEW app_private.finance_v2_pnl_parity_v1 SET (security_invoker = true);
REVOKE ALL ON app_private.finance_v2_pnl_parity_v1 FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON VIEW app_private.finance_v2_pnl_parity_v1 IS
  'Plan §10.4/§10.5 SHADOW: per (org, month), legacy accrual P&L (reproduces fa_monthly_pnl_accrual: APPROVED + counts_in_business_result, accrual allocation, EXPENSE negative, sans can_access_building for cross-org owner reconciliation) vs V2 SUM(signed_kqkd_amount) from effective_profit_contributions_v2. diff/is_match compare the FULL V2 sum (incl. pending + adjustments); diff_approved_basis/is_match_approved_basis compare V2 restricted to APPROVED contributions — the clean tie-out gate. Owner-only; additive.';

-- =====================================================================
-- §10.4 — SHADOW GATE READOUT: finance_v2_shadow_summary_v1() -> jsonb.
-- One-call rollup of every SHADOW gate counter (plan §10.4/§10.5): unresolved
-- cash-impacting vouchers, unclassified access candidates, open backfill
-- exceptions (both tables), delta lag, balance/P&L mismatch counts, and a
-- best-effort bypass-writer count. `shadow_gate_clear` is true only when every
-- blocking counter is zero and every parity tie-out matches. Owner-only.
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.finance_v2_shadow_summary_v1();
CREATE FUNCTION app_private.finance_v2_shadow_summary_v1()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $finance_v2_shadow_summary_v1$
DECLARE
  v_unresolved_cash        bigint;
  v_pending_access         bigint;
  v_exc_income             bigint;
  v_exc_access             bigint;
  v_unapplied_changelog    bigint;
  v_delta_lag              numeric := NULL;   -- from finance_v2_delta_lag_v1 iff present (plan §10.4)
  v_balance_mismatch       bigint;
  v_pnl_mismatch_full      bigint;
  v_pnl_mismatch_approved  bigint;
  v_bypass_writers         bigint;
  v_gate_clear             boolean;
BEGIN
  -- Unresolved cash-impacting vouchers: real-account APPROVED voucher with no V2 posting
  -- classification stamped (posting_mode IS NULL). These block cutover (plan §10.5).
  SELECT count(*) INTO v_unresolved_cash
  FROM public.income_expenses ie
  JOIN public.accounts a ON a.id = ie.account_id AND a.is_virtual = false
  WHERE ie.deleted_at IS NULL
    AND ie.approval_status = 'APPROVED'
    AND ie.posting_mode IS NULL;

  -- Unclassified cashbook access candidates awaiting owner disposition (plan §10.2).
  SELECT count(*) INTO v_pending_access
  FROM app_private.cashbook_possession_candidates c
  WHERE c.status = 'PENDING_REVIEW';

  -- Open backfill exceptions (both staging tables, plan §6.5/§10.1/§10.2).
  SELECT count(*) INTO v_exc_income   FROM app_private.income_expense_v2_backfill_exceptions;
  SELECT count(*) INTO v_exc_access   FROM app_private.cashbook_access_v2_backfill_exceptions;

  -- Delta lag proxy: unapplied change-log rows to watermark (plan §10.5 "delta lag = 0").
  SELECT count(*) INTO v_unapplied_changelog
  FROM app_private.finance_v2_backfill_change_log
  WHERE applied_at IS NULL;

  -- Preferred delta-lag source finance_v2_delta_lag_v1 if a later stage introduces it; else NULL.
  IF to_regclass('app_private.finance_v2_delta_lag_v1') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT max(lag)::numeric FROM app_private.finance_v2_delta_lag_v1' INTO v_delta_lag;
    EXCEPTION WHEN others THEN
      v_delta_lag := NULL;  -- unknown shape: degrade to NULL, rely on unapplied_change_log_count
    END;
  END IF;

  -- Balance / P&L mismatch counts off the parity views.
  SELECT count(*) INTO v_balance_mismatch
  FROM app_private.finance_v2_balance_parity_v1 WHERE is_match = false;

  SELECT count(*) INTO v_pnl_mismatch_full
  FROM app_private.finance_v2_pnl_parity_v1 WHERE is_match = false;

  SELECT count(*) INTO v_pnl_mismatch_approved
  FROM app_private.finance_v2_pnl_parity_v1 WHERE is_match_approved_basis = false;

  -- Best-effort bypass writers (recent income_expenses writes without a V2 event; see monitor fn).
  SELECT count(*) INTO v_bypass_writers
  FROM app_private.finance_v2_bypass_monitor_v1(now() - interval '24 hours', NULL::uuid);

  v_gate_clear := (v_unresolved_cash = 0
               AND v_pending_access = 0
               AND (v_exc_income + v_exc_access) = 0
               AND v_unapplied_changelog = 0
               AND COALESCE(v_delta_lag, 0) = 0
               AND v_balance_mismatch = 0
               AND v_pnl_mismatch_approved = 0
               AND v_bypass_writers = 0);

  RETURN jsonb_build_object(
    'generated_at',                    now(),
    'unresolved_cash_vouchers',        v_unresolved_cash,
    'unclassified_access_candidates',  v_pending_access,
    'open_backfill_exceptions_income', v_exc_income,
    'open_backfill_exceptions_access', v_exc_access,
    'open_backfill_exceptions_total',  v_exc_income + v_exc_access,
    'unapplied_change_log_count',      v_unapplied_changelog,
    'delta_lag',                       v_delta_lag,
    'balance_mismatch_count',          v_balance_mismatch,
    'pnl_mismatch_count',              v_pnl_mismatch_full,
    'pnl_mismatch_count_approved_basis', v_pnl_mismatch_approved,
    'bypass_writer_count',             v_bypass_writers,
    'shadow_gate_clear',               v_gate_clear
  );
END
$finance_v2_shadow_summary_v1$;
REVOKE ALL ON FUNCTION app_private.finance_v2_shadow_summary_v1() FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_shadow_summary_v1() IS
  'Plan §10.4/§10.5: single-call SHADOW gate readout — unresolved cash vouchers, unclassified access candidates, open backfill exceptions, unapplied change-log/delta lag, balance & P&L mismatch counts, best-effort bypass writers, and shadow_gate_clear (all blocking counters zero + parity tie-out). Owner-only; read-only.';

-- =====================================================================
-- §10.4 — BYPASS-WRITER MONITOR: finance_v2_bypass_monitor_v1() -> TABLE.
-- Best-effort alerting surface: recent REAL-account income_expenses writes that
-- did NOT go through a V2 posting/semantic-event (plan §10.4 "log writer nào còn
-- bypass"). Heuristic — a legitimate SHADOW writer appends a V2_WRITE semantic
-- event (and a cash write also produces a posting); a raw-DML/legacy fallback
-- write leaves neither. p_since bounds the monitoring window (pass the SHADOW
-- cutover timestamp so backfill's own header stamps are not flagged). Owner-only.
-- =====================================================================
DROP FUNCTION IF EXISTS app_private.finance_v2_bypass_monitor_v1(timestamptz, uuid);
CREATE FUNCTION app_private.finance_v2_bypass_monitor_v1(
  p_since timestamptz DEFAULT (now() - interval '24 hours'),
  p_org   uuid        DEFAULT NULL
)
RETURNS TABLE(
  organization_id uuid,
  voucher_id      uuid,
  updated_at      timestamptz,
  approval_status text,
  posting_mode    text,
  posting_status  text,
  reason          text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $finance_v2_bypass_monitor_v1$
  SELECT
    ie.organization_id,
    ie.id                AS voucher_id,
    ie.updated_at,
    ie.approval_status,
    ie.posting_mode,
    ie.posting_status,
    'RECENT_WRITE_NO_V2_EVENT'::text AS reason
  FROM public.income_expenses ie
  JOIN public.accounts a ON a.id = ie.account_id AND a.is_virtual = false
  WHERE ie.deleted_at IS NULL
    AND ie.updated_at >= p_since
    AND (p_org IS NULL OR ie.organization_id = p_org)
    -- No V2_WRITE semantic event was appended for this voucher (would prove a V2-pipeline write).
    AND NOT EXISTS (
      SELECT 1 FROM app_private.finance_v2_semantic_event_log e
      WHERE e.source_id = ie.id
        AND e.source_kind = 'V2_WRITE'
        AND e.created_at >= p_since
    )
    -- No posting event was created for this voucher inside the window (cash writes must post).
    AND NOT EXISTS (
      SELECT 1 FROM public.income_expense_postings p
      WHERE p.posting_subject_id = ie.id
        AND p.posting_subject_kind = 'VOUCHER'
        AND p.organization_id = ie.organization_id
        AND p.created_at >= p_since
    )
    -- Not attributable to the backfill change-capture bridge either.
    AND NOT EXISTS (
      SELECT 1 FROM app_private.finance_v2_backfill_change_log cl
      WHERE cl.source_table = 'public.income_expenses'
        AND cl.source_pk = ie.id
        AND cl.changed_at >= p_since
    )
  ORDER BY ie.updated_at DESC;
$finance_v2_bypass_monitor_v1$;
REVOKE ALL ON FUNCTION app_private.finance_v2_bypass_monitor_v1(timestamptz, uuid) FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_bypass_monitor_v1(timestamptz, uuid) IS
  'Plan §10.4: best-effort bypass-writer alerting — recent real-account income_expenses writes since p_since with no matching V2_WRITE semantic event, no posting event, and no backfill change-capture row. Heuristic (pass p_since = SHADOW cutover time to avoid flagging backfill header stamps). Owner-only; read-only.';

COMMIT;

NOTIFY pgrst, 'reload schema';
