-- Finance V2 (Thu Chi V2) — Stage 7: caller drain + ACL (plan §9.3, §13 step 7).
--
-- POINT-OF-NO-RETURN BEFORE SHADOW. This stage revokes direct client DML on the money
-- tables and drops the remaining broad legacy money-write policies, so every write goes
-- through the canonical SECURITY DEFINER RPCs (Stage-5/6). Per plan §8 the runbook MUST
-- verify legacy direct-DML caller count is 0 BEFORE forward-applying this stage: after it,
-- raw INSERT/UPDATE/DELETE from the app (mutations.ts fallbacks, batch.ts, useManagerSalary
-- raw path, useInvoicePayments refund insert, Copilot writeTools) fail with 42501 — that is
-- the intended fail-closed behavior, not a bug. No feature mode changed, no org enrolled.

BEGIN;

-- 1) Revoke client DML on the legacy money tables (SELECT stays, RLS-scoped).
DO $drain_ie$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.income_expenses, public.income_expense_items FROM anon';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON public.income_expenses, public.income_expense_items FROM authenticated';
  END IF;
END
$drain_ie$;

-- 2) Drop the remaining broad legacy money WRITE policies (OR-merge: leak closes only on
--    DROP). SELECT *_rbac stays until Stage-11 canonical read boundary. ie_canonical_writer
--    keeps its rw policies; RESTRICTIVE org-boundary/restricted policies stay.
DROP POLICY IF EXISTS income_expenses_insert_rbac ON public.income_expenses;
DROP POLICY IF EXISTS income_expenses_update_rbac ON public.income_expenses;
DROP POLICY IF EXISTS income_expenses_delete_rbac ON public.income_expenses;
DROP POLICY IF EXISTS income_expense_items_insert_rbac ON public.income_expense_items;
DROP POLICY IF EXISTS income_expense_items_update_rbac ON public.income_expense_items;
DROP POLICY IF EXISTS income_expense_items_delete_rbac ON public.income_expense_items;

-- 3) Defensive client-DML revoke on every Finance V2 base table (Stage-2 already revoked
--    at creation; re-assert so a later grant drift cannot silently reopen).
DO $drain_v2$
DECLARE
  v_table text;
  v_role text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.income_expense_postings',
    'public.income_expense_posting_lines',
    'public.finance_evidence_objects',
    'public.finance_evidence_system_sources',
    'public.income_expense_posting_evidence',
    'public.income_expense_recognition_adjustments',
    'public.salary_settlement_bundles',
    'public.salary_cash_authorizations',
    'public.salary_settlement_tranches',
    'public.salary_earning_consumptions',
    'public.termination_move_out_authorizations',
    'public.termination_move_out_settlement_lines'
  ] LOOP
    IF to_regclass(v_table) IS NULL THEN
      RAISE EXCEPTION 'Finance V2 drain: missing base table % (stages out of order)', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF to_regrole(v_role) IS NOT NULL THEN
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %s FROM %I', v_table, v_role);
      END IF;
    END LOOP;
  END LOOP;
END
$drain_v2$;

-- 4) Assert the app_private control tables expose nothing to client roles (fail loud on
--    drift instead of silently re-revoking a grant someone added deliberately).
DO $drain_priv$
DECLARE
  v_table text;
  v_role text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'app_private.canonical_write_operations',
    'app_private.finance_execution_scopes',
    'app_private.finance_execution_cashbook_candidates',
    'app_private.cashbook_access_states',
    'app_private.cashbook_access_mutation_requests',
    'app_private.finance_flow_owner_adapters',
    'app_private.finance_business_policy_decisions',
    'app_private.finance_v2_activation_attestations',
    'app_private.finance_v2_backfill_runs',
    'app_private.finance_v2_backfill_change_log',
    'app_private.finance_v2_semantic_event_log',
    'app_private.income_expense_v2_backfill_exceptions',
    'app_private.cashbook_access_v2_backfill_exceptions'
  ] LOOP
    IF to_regclass(v_table) IS NULL THEN
      RAISE EXCEPTION 'Finance V2 drain: missing control table %', v_table;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF to_regrole(v_role) IS NOT NULL
         AND pg_catalog.has_table_privilege(v_role, to_regclass(v_table),
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'Finance V2 drain: role % unexpectedly has access to %', v_role, v_table;
      END IF;
    END LOOP;
  END LOOP;
END
$drain_priv$;

COMMIT;

NOTIFY pgrst, 'reload schema';
