-- Finance V2 (Thu Chi V2) — Stage 12: CUTOVER READINESS (plan §13 step 12).
--
-- Purpose: prove the INERT constraints authored in Stage-2 (NOT VALID FKs) and the
-- header CHECK constraints CAN be enforced against the data as it now stands, and expose
-- an assert-style readiness readout the operator inspects BEFORE flipping any mode. This
-- migration DOES NOT change a feature mode and DOES NOT enroll an org (mode/canary/cohort
-- CAS remain operational steps run by apply-finance-v2-rollout.mjs, plan §13/§20).
--
-- What it does, all idempotent + non-fatal-by-design:
--   1) Append-only private readiness report table (owner-only, RLS deny-all).
--   2) Adds the three header CHECK constraints (posting_status / posting_mode /
--      recognition_source_mode) as NOT VALID so they exist but block nothing now.
--   3) VALIDATEs each Stage-2 NOT-VALID FK + the new CHECKs, one constraint at a time,
--      inside a per-constraint EXCEPTION block: a single bad row is RECORDED to the report,
--      never aborts the migration mid-transaction (plan §6.1: validate only after data
--      supports it; readiness must not hard-fail on a legacy straggler).
--   4) app_private.finance_v2_cutover_readiness_v1() -> jsonb: assert-style readout
--      (backfill exceptions, delta lag, balance/P&L parity, account_shared_users drain,
--      unresolved possession candidates, the 7 feature-key routes, approval_status default).
--      It NEVER throws; it returns the report.
--   5) The birth-default flip (approval_status DEFAULT 'UNAPPROVED') is left COMMENTED OUT
--      with its precondition — the operator applies it deliberately post caller-drain.
--
-- BODY ONLY: apply-finance-v2-rollout.mjs strips the single BEGIN;/COMMIT;/NOTIFY wrapper
-- and runs this stage inside its own advisory-locked transaction. Exactly one standalone
-- BEGIN; + COMMIT; (required by stripMigrationTransactionControl) + one trailing NOTIFY.


-- ===========================================================================
-- PART 0 — Ordering preflight. Readiness is meaningless before the Stage-2 schema
-- exists; assert the minimum and run as the app_private owner (mirror sibling stages).
-- ===========================================================================
BEGIN;

DO $preflight$
DECLARE
  v_owner oid;
BEGIN
  IF to_regnamespace('app_private') IS NULL THEN
    RAISE EXCEPTION 'Finance V2 Stage-12 requires the authz foundation: missing schema app_private';
  END IF;

  SELECT n.nspowner INTO v_owner
  FROM pg_catalog.pg_namespace n WHERE n.nspname = 'app_private';
  IF pg_catalog.pg_get_userbyid(v_owner) <> session_user THEN
    RAISE EXCEPTION 'Finance V2 Stage-12 must run as app_private owner %, got %',
      pg_catalog.pg_get_userbyid(v_owner), session_user;
  END IF;

  -- Stage-2 must have landed (header columns + posting event table).
  IF to_regclass('public.income_expense_postings') IS NULL THEN
    RAISE EXCEPTION 'Finance V2 Stage-12 requires Stage-2 (missing public.income_expense_postings)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='income_expenses' AND column_name='posting_status'
  ) THEN
    RAISE EXCEPTION 'Finance V2 Stage-12 requires Stage-2 header columns (missing income_expenses.posting_status)';
  END IF;
END
$preflight$;

-- One run id shared by the VALIDATE loop and the captured readiness snapshot (txn-local).
SELECT set_config('finance_v2.readiness_run_id', gen_random_uuid()::text, true);

-- ===========================================================================
-- PART 1 — Append-only readiness report (owner-only). Each apply appends rows.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS app_private.finance_v2_cutover_readiness_report (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid        NOT NULL,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  captured_by     text        NOT NULL DEFAULT session_user,
  entry_kind      text        NOT NULL,   -- 'CONSTRAINT_VALIDATION' | 'READINESS_SNAPSHOT'
  target          text,                   -- schema.table
  constraint_name text,
  constraint_type text,                   -- 'FOREIGN KEY' | 'CHECK'
  outcome         text,                   -- VALIDATED | ALREADY_VALID | ABSENT | VALIDATE_FAILED | SNAPSHOT
  detail          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT finance_v2_cutover_readiness_report_entry_kind_check
    CHECK (entry_kind IN ('CONSTRAINT_VALIDATION','READINESS_SNAPSHOT')),
  CONSTRAINT finance_v2_cutover_readiness_report_outcome_check
    CHECK (outcome IN ('VALIDATED','ALREADY_VALID','ABSENT','VALIDATE_FAILED','SNAPSHOT'))
);
COMMENT ON TABLE app_private.finance_v2_cutover_readiness_report IS
  'Plan §13.12: append-only readiness ledger. One row per NOT-VALID constraint validation attempt + one READINESS_SNAPSHOT per apply. Owner-only; RLS deny-all.';

REVOKE ALL ON app_private.finance_v2_cutover_readiness_report FROM PUBLIC;
DO $rep_acl$
BEGIN
  IF to_regrole('anon')         IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_v2_cutover_readiness_report FROM anon'; END IF;
  IF to_regrole('authenticated')IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_v2_cutover_readiness_report FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_v2_cutover_readiness_report FROM service_role'; END IF;
END
$rep_acl$;
ALTER TABLE app_private.finance_v2_cutover_readiness_report ENABLE ROW LEVEL SECURITY;  -- deny-all: no policy

-- Append-only: reuse the shared ledger-immutable guard (§10.0/§10.4).
DROP TRIGGER IF EXISTS a00_finance_v2_cutover_readiness_report_immutable
  ON app_private.finance_v2_cutover_readiness_report;
CREATE TRIGGER a00_finance_v2_cutover_readiness_report_immutable
  BEFORE UPDATE OR DELETE ON app_private.finance_v2_cutover_readiness_report
  FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_v2_ledger_immutable();

-- ===========================================================================
-- PART 2 — Header CHECK constraints on public.income_expenses, added NOT VALID
-- (plan §6.1). NULL is allowed for the whole expand phase; the domains match every
-- value any Finance V2 writer/backfill stamps. NOT VALID => no scan, blocks nothing now.
-- ===========================================================================
DO $add_checks$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid='public.income_expenses'::regclass
                   AND conname='income_expenses_posting_status_v2_check') THEN
    ALTER TABLE public.income_expenses
      ADD CONSTRAINT income_expenses_posting_status_v2_check
      CHECK (posting_status IS NULL
             OR posting_status IN ('UNPOSTED','POSTED','REVERSED','NOT_APPLICABLE'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid='public.income_expenses'::regclass
                   AND conname='income_expenses_posting_mode_v2_check') THEN
    ALTER TABLE public.income_expenses
      ADD CONSTRAINT income_expenses_posting_mode_v2_check
      CHECK (posting_mode IS NULL
             OR posting_mode IN ('CASHBOOK','NON_CASH'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
                 WHERE conrelid='public.income_expenses'::regclass
                   AND conname='income_expenses_recognition_source_mode_v2_check') THEN
    ALTER TABLE public.income_expenses
      ADD CONSTRAINT income_expenses_recognition_source_mode_v2_check
      CHECK (recognition_source_mode IS NULL
             OR recognition_source_mode IN ('BASE','ADJUSTMENT_ONLY'))
      NOT VALID;
  END IF;
END
$add_checks$;

COMMENT ON CONSTRAINT income_expenses_posting_status_v2_check ON public.income_expenses IS
  'Plan §6.1: posting_status domain (UNPOSTED/POSTED/REVERSED/NOT_APPLICABLE, NULL in expand). NOT VALID; Stage-12 validates non-fatally.';
COMMENT ON CONSTRAINT income_expenses_posting_mode_v2_check ON public.income_expenses IS
  'Plan §6.1: posting_mode domain (CASHBOOK/NON_CASH, NULL in expand). NOT VALID; Stage-12 validates non-fatally.';
COMMENT ON CONSTRAINT income_expenses_recognition_source_mode_v2_check ON public.income_expenses IS
  'Plan §6.1: recognition_source_mode domain (BASE/ADJUSTMENT_ONLY, server-owned, NULL in expand). NOT VALID; Stage-12 validates non-fatally.';

-- ===========================================================================
-- PART 3 — Guarded VALIDATE pass. For each Stage-2 NOT-VALID FK and the new CHECKs:
--   * ABSENT if the table/constraint does not exist (partial environment);
--   * ALREADY_VALID if already validated;
--   * else attempt VALIDATE inside its own subtransaction — success => VALIDATED,
--     any error (a violating legacy row) => VALIDATE_FAILED with SQLSTATE/SQLERRM.
-- A caught exception rolls back only that constraint's subtransaction; the outer
-- transaction and the report INSERT survive (plan §13.12: prefer a report row).
-- ===========================================================================
DO $validate$
DECLARE
  v_run     uuid := current_setting('finance_v2.readiness_run_id')::uuid;
  v_rec     record;
  v_regcls  regclass;
  v_valid   boolean;
  v_outcome text;
  v_detail  jsonb;
BEGIN
  FOR v_rec IN
    SELECT * FROM (VALUES
      -- (schema, table, constraint, type) — the 19 Stage-2 NOT-VALID cross/self FKs.
      ('public',     'income_expense_postings',              'fk_ie_postings_replaces',                                'FOREIGN KEY'),
      ('public',     'income_expense_postings',              'fk_ie_postings_reversal_of',                             'FOREIGN KEY'),
      ('public',     'income_expense_postings',              'fk_ie_postings_voucher',                                 'FOREIGN KEY'),
      ('public',     'income_expense_postings',              'fk_ie_postings_account',                                 'FOREIGN KEY'),
      ('public',     'income_expense_postings',              'fk_ie_postings_approval_request',                        'FOREIGN KEY'),
      ('public',     'income_expense_posting_lines',         'fk_ie_posting_lines_account',                            'FOREIGN KEY'),
      ('public',     'income_expense_posting_evidence',      'income_expense_posting_evidence_inherited_from_fkey',    'FOREIGN KEY'),
      ('public',     'income_expense_posting_evidence',      'income_expense_posting_evidence_posting_fkey',           'FOREIGN KEY'),
      ('app_private','finance_execution_scopes',             'finance_execution_scopes_assigned_cashbook_fk',          'FOREIGN KEY'),
      ('app_private','finance_execution_scopes',             'finance_execution_scopes_parent_voucher_fk',             'FOREIGN KEY'),
      ('public',     'income_expenses',                      'income_expenses_active_posting_id_v2_fkey',              'FOREIGN KEY'),
      ('public',     'income_expense_recognition_adjustments','income_expense_recognition_adjustments_voucher_fkey',   'FOREIGN KEY'),
      ('public',     'income_expense_recognition_adjustments','income_expense_recognition_adjustments_close_run_fkey', 'FOREIGN KEY'),
      ('public',     'salary_settlement_tranches',           'salary_settlement_tranches_active_posting_fk',           'FOREIGN KEY'),
      ('public',     'profit_payout_reservations',           'profit_payout_reservations_consumed_posting_fk',         'FOREIGN KEY'),
      ('public',     'profit_payout_reservations',           'profit_payout_reservations_reversed_posting_fk',         'FOREIGN KEY'),
      ('public',     'salary_settlement_bundles',            'salary_settlement_bundles_parent_voucher_fk',            'FOREIGN KEY'),
      ('public',     'termination_move_out_authorizations',  'termination_move_out_authorizations_revenue_voucher_fk', 'FOREIGN KEY'),
      ('public',     'termination_move_out_authorizations',  'termination_move_out_authorizations_offset_voucher_fk',  'FOREIGN KEY'),
      -- the 3 header CHECKs added in PART 2.
      ('public',     'income_expenses',                      'income_expenses_posting_status_v2_check',                'CHECK'),
      ('public',     'income_expenses',                      'income_expenses_posting_mode_v2_check',                  'CHECK'),
      ('public',     'income_expenses',                      'income_expenses_recognition_source_mode_v2_check',       'CHECK')
    ) AS t(sch, tbl, con, ctype)
  LOOP
    v_regcls := to_regclass(quote_ident(v_rec.sch) || '.' || quote_ident(v_rec.tbl));

    IF v_regcls IS NULL THEN
      v_outcome := 'ABSENT';
      v_detail  := jsonb_build_object('reason', 'relation_absent');
    ELSE
      SELECT c.convalidated INTO v_valid
      FROM pg_catalog.pg_constraint c
      WHERE c.conrelid = v_regcls AND c.conname = v_rec.con;

      IF v_valid IS NULL THEN
        v_outcome := 'ABSENT';
        v_detail  := jsonb_build_object('reason', 'constraint_absent');
      ELSIF v_valid THEN
        v_outcome := 'ALREADY_VALID';
        v_detail  := '{}'::jsonb;
      ELSE
        BEGIN
          EXECUTE format('ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
                         v_rec.sch, v_rec.tbl, v_rec.con);
          v_outcome := 'VALIDATED';
          v_detail  := '{}'::jsonb;
        EXCEPTION WHEN OTHERS THEN
          -- One violating legacy row must NOT abort the migration — record and move on.
          v_outcome := 'VALIDATE_FAILED';
          v_detail  := jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM);
        END;
      END IF;
    END IF;

    INSERT INTO app_private.finance_v2_cutover_readiness_report
      (run_id, entry_kind, target, constraint_name, constraint_type, outcome, detail)
    VALUES
      (v_run, 'CONSTRAINT_VALIDATION',
       v_rec.sch || '.' || v_rec.tbl, v_rec.con, v_rec.ctype, v_outcome, v_detail);
  END LOOP;
END
$validate$;

-- ===========================================================================
-- PART 4 — app_private.finance_v2_cutover_readiness_v1() -> jsonb.
-- Assert-style readout. Owner-only, SECURITY DEFINER, never throws. Every read is
-- guarded so a not-yet-applied later stage (delta-catchup / shadow-reconcile) yields
-- NULL rather than an error. Gates: PASS / FAIL / UNVERIFIABLE.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_private.finance_v2_cutover_readiness_v1()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_ie_exc        bigint := 0;
  v_cb_exc        bigint := 0;
  v_shared        bigint := 0;
  v_cand_pending  bigint := 0;
  v_cand_ambig    bigint := 0;
  v_cand_op_open  bigint := 0;
  v_open_operator bigint := 0;
  v_delta         bigint;
  v_delta_src     text;
  v_bal_parity    bigint;
  v_pnl_parity    bigint;
  v_parity_src    text;
  v_default       text;
  v_default_appr  boolean;
  v_notvalid      bigint := 0;
  v_failed        bigint := 0;
  v_routes        jsonb  := '{}'::jsonb;
  v_key           text;
  v_mode          text;
  v_freeze        boolean;
  v_route         text;
  v_p             jsonb;
  v_keys text[] := ARRAY[
    'income_expense.workflow.v2',
    'income_expense.posting.v2',
    'cashbook.access.v2',
    'income_expense.profit_close.v2',
    'income_expense.read_semantics.v2',
    'contract.commission.settlement.v2',
    'salary.settlement.v2'
  ];
  v_known text[] := ARRAY[
    'fk_ie_postings_replaces','fk_ie_postings_reversal_of','fk_ie_postings_voucher',
    'fk_ie_postings_account','fk_ie_postings_approval_request','fk_ie_posting_lines_account',
    'income_expense_posting_evidence_inherited_from_fkey','income_expense_posting_evidence_posting_fkey',
    'finance_execution_scopes_assigned_cashbook_fk','finance_execution_scopes_parent_voucher_fk',
    'income_expenses_active_posting_id_v2_fkey',
    'income_expense_recognition_adjustments_voucher_fkey','income_expense_recognition_adjustments_close_run_fkey',
    'salary_settlement_tranches_active_posting_fk',
    'profit_payout_reservations_consumed_posting_fk','profit_payout_reservations_reversed_posting_fk',
    'salary_settlement_bundles_parent_voucher_fk',
    'termination_move_out_authorizations_revenue_voucher_fk','termination_move_out_authorizations_offset_voucher_fk',
    'income_expenses_posting_status_v2_check','income_expenses_posting_mode_v2_check',
    'income_expenses_recognition_source_mode_v2_check'
  ];
  fn_gate CONSTANT text := 'gate';
BEGIN
  -- (1) Backfill exceptions must be zero (plan §6.5/§10.1/§10.2).
  IF to_regclass('app_private.income_expense_v2_backfill_exceptions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM app_private.income_expense_v2_backfill_exceptions' INTO v_ie_exc;
  END IF;
  IF to_regclass('app_private.cashbook_access_v2_backfill_exceptions') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM app_private.cashbook_access_v2_backfill_exceptions' INTO v_cb_exc;
  END IF;

  -- (2) Legacy account_shared_users must be drained to zero (plan §3.2/§10.2).
  IF to_regclass('public.account_shared_users') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.account_shared_users' INTO v_shared;
  END IF;

  -- (3) Possession candidates still needing disposition; OPERATOR-proposed must be zero (§4.1).
  IF to_regclass('app_private.cashbook_possession_candidates') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FILTER (WHERE status = 'PENDING_REVIEW'),
             count(*) FILTER (WHERE status = 'AMBIGUOUS'),
             count(*) FILTER (WHERE status IN ('PENDING_REVIEW','AMBIGUOUS') AND proposed_kind = 'OPERATOR')
      FROM app_private.cashbook_possession_candidates
    $q$ INTO v_cand_pending, v_cand_ambig, v_cand_op_open;
  END IF;

  -- (3b) Open OPERATOR possession bindings must be zero (target is CUSTODIAN/KNOWER only, §4.1).
  IF to_regclass('public.cashbook_possession_bindings') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FROM public.cashbook_possession_bindings
      WHERE valid_to IS NULL AND possession_kind = 'OPERATOR'
    $q$ INTO v_open_operator;
  END IF;

  -- (4) Delta lag (Stage-8). Prefer a dedicated fn; else count unapplied change-log rows.
  IF to_regprocedure('app_private.finance_v2_delta_lag_v1()') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT app_private.finance_v2_delta_lag_v1()' INTO v_delta;
      v_delta_src := 'fn:finance_v2_delta_lag_v1';
    EXCEPTION WHEN OTHERS THEN
      v_delta := NULL; v_delta_src := NULL;
    END;
  ELSIF to_regclass('app_private.finance_v2_backfill_change_log') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM app_private.finance_v2_backfill_change_log WHERE applied_at IS NULL'
      INTO v_delta;
    v_delta_src := 'change_log_unapplied';
  ELSE
    v_delta := NULL; v_delta_src := NULL;
  END IF;

  -- (5) Balance / P&L parity (Stage-9 shadow reconcile). NULL until that stage lands.
  IF to_regprocedure('app_private.finance_v2_shadow_parity_summary_v1()') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT app_private.finance_v2_shadow_parity_summary_v1()' INTO v_p;
      v_bal_parity := NULLIF(v_p->>'balance_mismatch_count','')::bigint;
      v_pnl_parity := NULLIF(v_p->>'pnl_mismatch_count','')::bigint;
      v_parity_src := 'fn:finance_v2_shadow_parity_summary_v1';
    EXCEPTION WHEN OTHERS THEN
      v_bal_parity := NULL; v_pnl_parity := NULL; v_parity_src := NULL;
    END;
  END IF;

  -- (6) Inert constraints still NOT VALID / failed among the Stage-12 known set.
  SELECT count(*) INTO v_notvalid
  FROM pg_catalog.pg_constraint c
  WHERE c.conname = ANY (v_known) AND NOT c.convalidated;

  IF to_regclass('app_private.finance_v2_cutover_readiness_report') IS NOT NULL THEN
    EXECUTE $q$
      SELECT count(*) FROM (
        SELECT DISTINCT ON (constraint_name) constraint_name, outcome
        FROM app_private.finance_v2_cutover_readiness_report
        WHERE entry_kind = 'CONSTRAINT_VALIDATION'
        ORDER BY constraint_name, captured_at DESC
      ) latest
      WHERE outcome = 'VALIDATE_FAILED'
    $q$ INTO v_failed;
  END IF;

  -- (7) approval_status birth default — informational (flip is a separate post-drain step).
  SELECT column_default INTO v_default
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='income_expenses' AND column_name='approval_status';
  v_default_appr := (v_default IS NOT NULL
                     AND v_default LIKE '%APPROVED%'
                     AND v_default NOT LIKE '%UNAPPROVED%');

  -- (8) Feature routes of the 7 keys (global evaluation, NULL org -> global-effective route).
  FOREACH v_key IN ARRAY v_keys LOOP
    v_mode := NULL; v_freeze := NULL; v_route := NULL;
    IF to_regclass('app_private.server_feature_flags') IS NOT NULL THEN
      EXECUTE 'SELECT mode, force_freeze FROM app_private.server_feature_flags WHERE feature_key = $1'
        INTO v_mode, v_freeze USING v_key;
    END IF;
    IF to_regprocedure('app_private.evaluate_feature_route(text,uuid)') IS NOT NULL THEN
      BEGIN
        EXECUTE 'SELECT app_private.evaluate_feature_route($1, NULL::uuid)' INTO v_route USING v_key;
      EXCEPTION WHEN OTHERS THEN
        v_route := 'ERROR';
      END;
    END IF;
    v_routes := v_routes || jsonb_build_object(
      v_key, jsonb_build_object('mode', v_mode, 'force_freeze', v_freeze, 'global_route', v_route)
    );
  END LOOP;

  -- Assemble the assert-style readout with per-check gates.
  RETURN jsonb_build_object(
    'schema_version', 1,
    'generated_at', now(),
    'note', 'Assert-style readiness readout. Does NOT change any feature mode or enroll an org.',
    'checks', jsonb_build_object(
      'backfill_exceptions', jsonb_build_object(
        'income_expense', v_ie_exc, 'cashbook_access', v_cb_exc,
        'total', v_ie_exc + v_cb_exc,
        fn_gate, CASE WHEN (v_ie_exc + v_cb_exc) = 0 THEN 'PASS' ELSE 'FAIL' END),
      'account_shared_users_drain', jsonb_build_object(
        'remaining', v_shared,
        fn_gate, CASE WHEN v_shared = 0 THEN 'PASS' ELSE 'FAIL' END),
      'possession_candidates_unresolved', jsonb_build_object(
        'pending_review', v_cand_pending, 'ambiguous', v_cand_ambig,
        'operator_proposed_unresolved', v_cand_op_open,
        'total', v_cand_pending + v_cand_ambig,
        fn_gate, CASE WHEN (v_cand_pending + v_cand_ambig) = 0 THEN 'PASS' ELSE 'FAIL' END),
      'operator_bindings_open', jsonb_build_object(
        'count', v_open_operator,
        fn_gate, CASE WHEN v_open_operator = 0 THEN 'PASS' ELSE 'FAIL' END),
      'inert_constraints', jsonb_build_object(
        'known', cardinality(v_known),
        'not_valid_remaining', v_notvalid,
        'validate_failed_latest', v_failed,
        fn_gate, CASE WHEN v_notvalid = 0 THEN 'PASS' ELSE 'FAIL' END),
      'delta_lag', jsonb_build_object(
        'value', v_delta, 'source', v_delta_src,
        fn_gate, CASE WHEN v_delta IS NULL THEN 'UNVERIFIABLE'
                      WHEN v_delta = 0 THEN 'PASS' ELSE 'FAIL' END),
      'parity', jsonb_build_object(
        'balance_mismatch', v_bal_parity, 'pnl_mismatch', v_pnl_parity, 'source', v_parity_src,
        fn_gate, CASE WHEN v_bal_parity IS NULL OR v_pnl_parity IS NULL THEN 'UNVERIFIABLE'
                      WHEN v_bal_parity = 0 AND v_pnl_parity = 0 THEN 'PASS' ELSE 'FAIL' END),
      'approval_status_default', jsonb_build_object(
        'value', v_default, 'is_APPROVED', v_default_appr,
        'note', 'Expected APPROVED until the operator applies the commented post-drain flip; not a cutover gate.')
    ),
    'feature_routes', v_routes,
    'is_cutover_ready',
      (v_ie_exc + v_cb_exc) = 0
      AND v_shared = 0
      AND (v_cand_pending + v_cand_ambig) = 0
      AND v_open_operator = 0
      AND v_notvalid = 0
      AND v_delta IS NOT NULL AND v_delta = 0
      AND v_bal_parity IS NOT NULL AND v_bal_parity = 0
      AND v_pnl_parity IS NOT NULL AND v_pnl_parity = 0
  );
END
$fn$;

REVOKE ALL ON FUNCTION app_private.finance_v2_cutover_readiness_v1()
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION app_private.finance_v2_cutover_readiness_v1() IS
  'Plan §13.12: assert-style cutover-readiness readout (backfill exceptions, account_shared_users drain, unresolved/OPERATOR possession candidates, inert-constraint validation state, delta lag, balance/P&L parity, 7 feature-key routes, approval_status default). NEVER throws; returns the report. Owner-only; does not change a mode or enroll an org.';

-- ===========================================================================
-- PART 5 — Capture one readiness snapshot into the append-only report for this apply.
-- ===========================================================================
DO $snapshot$
DECLARE
  v_run  uuid := current_setting('finance_v2.readiness_run_id')::uuid;
  v_snap jsonb;
BEGIN
  v_snap := app_private.finance_v2_cutover_readiness_v1();
  INSERT INTO app_private.finance_v2_cutover_readiness_report
    (run_id, entry_kind, outcome, detail)
  VALUES
    (v_run, 'READINESS_SNAPSHOT', 'SNAPSHOT', v_snap);
  RAISE NOTICE 'Finance V2 Stage-12 readiness snapshot: is_cutover_ready=%',
    (v_snap->>'is_cutover_ready');
END
$snapshot$;

-- ===========================================================================
-- PART 6 — BIRTH-DEFAULT FLIP (approval_status DEFAULT 'UNAPPROVED'). INTENTIONALLY
-- LEFT COMMENTED OUT. The current default is 'APPROVED'::text (set by
-- 20260426000002_thu_chi_remove_approval_add_cancel.sql).
--
-- PRECONDITION before the operator uncomments + applies this deliberately:
--   * Stage-7 (caller_drain_acl) applied: raw DML on public.income_expenses REVOKEd from
--     anon/authenticated/service_role, so no client path relies on the DB default; AND
--   * zero raw-DML callers remain (every Finance V2 RPC/adapter already sets the birth
--     approval_status EXPLICITLY to 'UNAPPROVED'), so the default only matters for stray
--     raw INSERTs — which Stage-7 has closed off.
-- Flipping earlier is unsafe: a legacy raw INSERT would silently birth 'UNAPPROVED' cash
-- vouchers before the workflow is live. Flipping is a one-line ALTER; keep it out of the
-- forward-only manifest so it is an explicit, audited operator action.
--
--   ALTER TABLE public.income_expenses ALTER COLUMN approval_status SET DEFAULT 'UNAPPROVED';
-- ===========================================================================

COMMIT;

NOTIFY pgrst, 'reload schema';
