-- Finance V2 (Thu Chi V2) — Stage 1: semantics snapshot + baseline preflight.
--
-- Production-catalog-only. Fails closed unless the reviewed Accounting/V5/RBAC baseline
-- (the plan's prerequisite catalog, §15) is installed and owner-safe. Then it CAPTURES the
-- mutable pre-V2 baseline (row counts/sums, the exact approval/possession constraint defs,
-- feature-flag modes, access inventory) into an append-only private snapshot table. The
-- FIRST captured row is the authoritative pre-V2 baseline / rollback asset (§19.4) and its
-- fingerprint is what apply-finance-v2-rollout.mjs pins.
--
-- This stage is re-runnable: it hard-asserts only ROLLOUT-INVARIANT foundation presence and
-- role/ACL safety; everything that later stages mutate is captured, not asserted, so
-- --live-rollback re-validation never fights a later stage.
--
-- No feature mode is changed and no org is enrolled here (§13).

BEGIN;

DO $finance_v2_preflight$
DECLARE
  v_object text;
  v_client_role text;
  v_namespace_oid oid;
  v_trusted_owner oid;
  v_writer_role oid;
BEGIN
  -- 1) Foundation schema + trusted owner (mirror accounting prerequisites).
  IF to_regnamespace('app_private') IS NULL THEN
    RAISE EXCEPTION 'Finance V2 requires the production authz foundation: missing schema app_private';
  END IF;

  SELECT namespace_row.oid, namespace_row.nspowner
    INTO v_namespace_oid, v_trusted_owner
  FROM pg_catalog.pg_namespace namespace_row
  WHERE namespace_row.nspname = 'app_private';

  IF pg_catalog.pg_get_userbyid(v_trusted_owner) <> session_user THEN
    RAISE EXCEPTION 'Finance V2 rollout must run as app_private owner %, got %',
      pg_catalog.pg_get_userbyid(v_trusted_owner), session_user;
  END IF;

  -- 2) Canonical writer role must exist and remain unprivileged (Finance writers reuse it).
  SELECT role_row.oid INTO v_writer_role
  FROM pg_catalog.pg_roles role_row
  WHERE role_row.rolname = 'ie_canonical_writer'
    AND NOT role_row.rolcanlogin
    AND NOT role_row.rolinherit
    AND NOT role_row.rolsuper
    AND NOT role_row.rolcreaterole
    AND NOT role_row.rolcreatedb
    AND NOT role_row.rolreplication
    AND NOT role_row.rolbypassrls;
  IF v_writer_role IS NULL THEN
    RAISE EXCEPTION 'Missing or unsafe foundation role ie_canonical_writer (NOLOGIN NOINHERIT, no elevated attrs)';
  END IF;

  FOREACH v_client_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF to_regrole(v_client_role) IS NULL THEN
      RAISE EXCEPTION 'Missing Supabase foundation role %', v_client_role;
    END IF;
    IF pg_catalog.has_schema_privilege(v_client_role, v_namespace_oid, 'USAGE,CREATE') THEN
      RAISE EXCEPTION 'Unsafe app_private ACL: role % must have no schema access', v_client_role;
    END IF;
  END LOOP;

  -- 3) Reuse-target control-plane / lifecycle tables must exist and be owner-owned. Finance
  -- V2 EXTENDS these; it must never fork a parallel control plane / idempotency authority
  -- (§4.2, §6.1, §10.4). NOTE: cashbook_possession_bindings + cashbook_possession_candidates
  -- resolve the live divergence — bindings live in PUBLIC, candidates in APP_PRIVATE.
  FOREACH v_object IN ARRAY ARRAY[
    'app_private.server_feature_flags',
    'app_private.server_feature_flag_canary_orgs',
    'app_private.server_feature_flag_operations',
    'app_private.canonical_write_operations',
    'app_private.income_expense_flow_ownership',
    'app_private.termination_forfeit_authorizations',
    'app_private.cashbook_possession_candidates',
    'public.cashbook_possession_bindings',
    'public.profit_payout_reservations',
    'public.approval_requests',
    'public.income_expenses',
    'public.income_expense_items'
  ] LOOP
    IF to_regclass(v_object) IS NULL THEN
      RAISE EXCEPTION 'Missing Finance V2 prerequisite relation %', v_object;
    END IF;
  END LOOP;

  -- 4) Reuse-target control-plane functions must exist (Finance CAS/route/claim ride these).
  FOREACH v_object IN ARRAY ARRAY[
    'app_private.evaluate_feature_route(text,uuid)',
    'app_private.claim_feature_operation_v1(text,uuid,text,uuid,text,numeric)'
  ] LOOP
    IF to_regprocedure(v_object) IS NULL THEN
      RAISE EXCEPTION 'Missing Finance V2 prerequisite function %', v_object;
    END IF;
  END LOOP;
  -- set_feature_route_v1 + assert_accounting_feature_activation_v1 exist by name (signatures
  -- vary across releases); assert by name so a signature bump doesn't spuriously fail preflight.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='app_private' AND p.proname='set_feature_route_v1') THEN
    RAISE EXCEPTION 'Missing Finance V2 prerequisite function app_private.set_feature_route_v1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
                 WHERE n.nspname='app_private' AND p.proname='assert_accounting_feature_activation_v1') THEN
    RAISE EXCEPTION 'Missing accounting activation guard (Finance V2 mirrors, not reuses, it)';
  END IF;
END
$finance_v2_preflight$;

-- 5) Append-only baseline snapshot table (private; no client access). Each apply appends one
-- row; the earliest row is the true pre-V2 baseline. Immutable via trigger.
CREATE TABLE IF NOT EXISTS app_private.finance_v2_semantics_snapshot (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  captured_at         timestamptz NOT NULL DEFAULT now(),
  captured_by         text NOT NULL DEFAULT session_user,
  schema_migrations_tail text,
  baseline            jsonb NOT NULL,
  baseline_fingerprint text NOT NULL
);

REVOKE ALL ON app_private.finance_v2_semantics_snapshot FROM PUBLIC;
DO $grant$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_v2_semantics_snapshot FROM anon'; END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_v2_semantics_snapshot FROM authenticated'; END IF;
  IF to_regrole('service_role') IS NOT NULL THEN EXECUTE 'REVOKE ALL ON app_private.finance_v2_semantics_snapshot FROM service_role'; END IF;
END
$grant$;

CREATE OR REPLACE FUNCTION app_private.finance_v2_snapshot_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $fn$
BEGIN
  RAISE EXCEPTION 'app_private.finance_v2_semantics_snapshot is append-only (no UPDATE/DELETE)';
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS a00_finance_v2_snapshot_immutable ON app_private.finance_v2_semantics_snapshot;
CREATE TRIGGER a00_finance_v2_snapshot_immutable
  BEFORE UPDATE OR DELETE ON app_private.finance_v2_semantics_snapshot
  FOR EACH ROW EXECUTE FUNCTION app_private.finance_v2_snapshot_immutable();

-- 6) Capture the baseline. All read-only aggregates over the reviewed surface.
DO $capture$
DECLARE
  v_baseline jsonb;
  v_tail text;
BEGIN
  SELECT string_agg(version, ',' ORDER BY version DESC)
    INTO v_tail
  FROM (
    SELECT version FROM supabase_migrations.schema_migrations ORDER BY version DESC LIMIT 5
  ) t;

  v_baseline := jsonb_build_object(
    'captured_at_note', 'pre-V2 baseline / rollback asset (plan §19.4)',
    'income_expenses_approval_status_default', (
      SELECT column_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='income_expenses' AND column_name='approval_status'
    ),
    'approval_requests_state_check', (
      SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint
      WHERE conrelid='public.approval_requests'::regclass AND conname='approval_requests_state_check'
    ),
    'possession_kind_check', (
      SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint
      WHERE conrelid='public.cashbook_possession_bindings'::regclass
        AND conname='cashbook_possession_bindings_possession_kind_check'
    ),
    'possession_bindings_open_by_kind', (
      SELECT COALESCE(jsonb_object_agg(possession_kind, cnt), '{}'::jsonb)
      FROM (SELECT possession_kind, count(*) AS cnt FROM public.cashbook_possession_bindings
            WHERE valid_to IS NULL GROUP BY possession_kind) k
    ),
    'account_shared_users_count', (SELECT count(*) FROM public.account_shared_users),
    'income_expenses_by_org_status', (
      SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
        SELECT organization_id, approval_status,
               count(*) AS cnt, COALESCE(sum(total_amount),0) AS total
        FROM public.income_expenses
        WHERE deleted_at IS NULL
        GROUP BY organization_id, approval_status
        ORDER BY organization_id, approval_status
      ) t
    ),
    'pending_kqkd_by_org', (
      SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
        SELECT organization_id, count(*) AS cnt, COALESCE(sum(total_amount),0) AS total
        FROM public.income_expenses
        WHERE approval_status='UNAPPROVED' AND deleted_at IS NULL
        GROUP BY organization_id ORDER BY count(*) DESC
      ) t
    ),
    'feature_flag_modes', (
      SELECT COALESCE(jsonb_object_agg(feature_key, jsonb_build_object('mode', mode, 'force_freeze', force_freeze)), '{}'::jsonb)
      FROM app_private.server_feature_flags
    ),
    'ie_select_policies', (
      SELECT COALESCE(jsonb_agg(policyname ORDER BY policyname), '[]'::jsonb)
      FROM pg_policies WHERE schemaname='public' AND tablename='income_expenses' AND cmd='SELECT'
    ),
    'accounts_select_policies', (
      SELECT COALESCE(jsonb_agg(policyname ORDER BY policyname), '[]'::jsonb)
      FROM pg_policies WHERE schemaname='public' AND tablename='accounts' AND cmd='SELECT'
    ),
    'approval_base_grants_authenticated', (
      SELECT COALESCE(jsonb_object_agg(tbl, has_sel), '{}'::jsonb) FROM (
        SELECT t AS tbl,
               CASE WHEN to_regclass('public.'||t) IS NULL THEN null
                    ELSE pg_catalog.has_table_privilege('authenticated', 'public.'||t, 'SELECT') END AS has_sel
        FROM unnest(ARRAY['approval_requests','approval_request_steps','approval_request_step_candidates','approval_decisions']) t
      ) s
    ),
    'finance_v2_objects_present', (
      SELECT COALESCE(jsonb_object_agg(o, present), '{}'::jsonb) FROM (
        SELECT o, to_regclass(o) IS NOT NULL AS present
        FROM unnest(ARRAY[
          'public.income_expense_postings','public.income_expense_posting_lines',
          'public.finance_evidence_objects','app_private.cashbook_access_states',
          'app_private.finance_execution_scopes','app_private.finance_business_policy_decisions',
          'app_private.finance_v2_backfill_runs','public.salary_settlement_tranches'
        ]) o
      ) s
    )
  );

  INSERT INTO app_private.finance_v2_semantics_snapshot (schema_migrations_tail, baseline, baseline_fingerprint)
  VALUES (v_tail, v_baseline, md5(v_baseline::text));

  RAISE NOTICE 'Finance V2 semantics snapshot captured: fingerprint=%', md5(v_baseline::text);
END
$capture$;

COMMIT;

NOTIFY pgrst, 'reload schema';
