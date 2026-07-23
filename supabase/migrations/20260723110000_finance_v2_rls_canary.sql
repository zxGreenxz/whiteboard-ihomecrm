-- Finance V2 (Thu Chi V2) — Stage 11: RLS-canary read boundary + safe read shapes
-- (plan §9.2, §9.4, §12.5, §12.6).
--
-- Wires the canonical CUSTODIAN/KNOWER read boundary:
--   1) Mode-aware SELECT policies on the posting ledger (deny unless the org's
--      read-semantics route is CANONICAL and the actor holds an open CUSTODIAN binding
--      on the affected account) — via a definer predicate, because policies evaluate
--      as the querying role.
--   2) The §9.2 scoped read RPCs: list/stats/detail with the per-cashbook union predicate
--      (CUSTODIAN = all vouchers touching the book incl. change/rounding legs;
--       KNOWER = own-created INCOME only via maker_user_id; no binding = no rows).
--   3) Cashbook intent selectors + access read/admin RPCs + CAS mutation
--      (set_cashbook_access_v2: cashbooks.share exact scope, expected revision,
--       idempotency, no self-role change; bindings are closed, never deleted).
--   4) Safe execution-queue projection.
-- No feature mode changed, no org enrolled. All RPCs resolve the actor from auth.uid()
-- and ignore client-sent org/user fields.

BEGIN;

-- ===========================================================================
-- 1) Mode-aware posting-ledger read predicate + policies.
-- ===========================================================================
CREATE OR REPLACE FUNCTION app_private.finance_v2_can_read_posting_v1(
  p_organization_id uuid,
  p_account_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT app_private.evaluate_feature_route('income_expense.read_semantics.v2', p_organization_id)
           = 'CANONICAL'
     AND EXISTS (
       SELECT 1
       FROM public.cashbook_possession_bindings b
       JOIN public.organization_memberships m ON m.id = b.membership_id
       WHERE b.organization_id = p_organization_id
         AND b.cashbook_id = p_account_id
         AND b.possession_kind = 'CUSTODIAN'
         AND b.valid_to IS NULL
         AND m.user_id = auth.uid()
         AND m.status = 'ACTIVE'
     );
$fn$;

REVOKE ALL ON FUNCTION app_private.finance_v2_can_read_posting_v1(uuid, uuid) FROM PUBLIC;
DO $g11a$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION app_private.finance_v2_can_read_posting_v1(uuid, uuid) FROM anon';
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION app_private.finance_v2_can_read_posting_v1(uuid, uuid) FROM service_role';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION app_private.finance_v2_can_read_posting_v1(uuid, uuid) TO authenticated';
  END IF;
END
$g11a$;

DO $g11b$
BEGIN
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON public.income_expense_postings, public.income_expense_posting_lines TO authenticated';
  END IF;
END
$g11b$;

DROP POLICY IF EXISTS finance_v2_postings_select_custodian ON public.income_expense_postings;
CREATE POLICY finance_v2_postings_select_custodian
  ON public.income_expense_postings FOR SELECT TO authenticated
  USING (app_private.finance_v2_can_read_posting_v1(organization_id, account_id));

DROP POLICY IF EXISTS finance_v2_posting_lines_select_custodian ON public.income_expense_posting_lines;
CREATE POLICY finance_v2_posting_lines_select_custodian
  ON public.income_expense_posting_lines FOR SELECT TO authenticated
  USING (app_private.finance_v2_can_read_posting_v1(organization_id, account_id));

-- ===========================================================================
-- 2) §9.2 scoped voucher read RPCs (single shared predicate, no OR-widening).
-- ===========================================================================
-- Internal row source: the exact §9.2 union for the current actor. AND-composed
-- with deleted_at IS NULL; restricted/building predicates remain enforced by the
-- legacy RLS on direct table reads — these RPCs never widen beyond the binding union.
CREATE OR REPLACE FUNCTION app_private.finance_v2_visible_vouchers()
RETURNS SETOF public.income_expenses
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  WITH me AS (
    SELECT m.id AS membership_id, m.organization_id
    FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
  ),
  custodian AS (
    SELECT b.organization_id, b.cashbook_id
    FROM public.cashbook_possession_bindings b
    JOIN me ON me.membership_id = b.membership_id
    WHERE b.possession_kind = 'CUSTODIAN' AND b.valid_to IS NULL
  ),
  knower AS (
    SELECT b.organization_id, b.cashbook_id
    FROM public.cashbook_possession_bindings b
    JOIN me ON me.membership_id = b.membership_id
    WHERE b.possession_kind = 'KNOWER' AND b.valid_to IS NULL
  )
  SELECT ie.*
  FROM public.income_expenses ie
  WHERE ie.deleted_at IS NULL
    AND (
      EXISTS (SELECT 1 FROM custodian c
              WHERE c.organization_id = ie.organization_id
                AND c.cashbook_id IN (ie.account_id, ie.change_account_id, ie.rounding_account_id))
      OR EXISTS (SELECT 1 FROM knower k
                 WHERE k.organization_id = ie.organization_id
                   AND ie.type = 'INCOME'
                   AND ie.maker_user_id = auth.uid()
                   AND ie.account_id = k.cashbook_id)
    );
$fn$;

REVOKE ALL ON FUNCTION app_private.finance_v2_visible_vouchers()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_income_expenses_v2(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE (
  id uuid, organization_id uuid, type text, name text, notes text,
  total_amount numeric, approval_status text, review_state text,
  posting_mode text, posting_status text, account_id uuid,
  voucher_date date, recognition_date date, system_source text,
  maker_user_id uuid, created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT ie.id, ie.organization_id, ie.type, ie.name, ie.notes,
         ie.total_amount, ie.approval_status, ie.review_state,
         ie.posting_mode, ie.posting_status, ie.account_id,
         ie.voucher_date, ie.recognition_date, ie.system_source,
         ie.maker_user_id, ie.created_at
  FROM app_private.finance_v2_visible_vouchers() ie
  WHERE (p_filters->>'type' IS NULL OR ie.type = p_filters->>'type')
    AND (p_filters->>'approvalStatus' IS NULL OR ie.approval_status = p_filters->>'approvalStatus')
    AND (p_filters->>'postingStatus' IS NULL OR ie.posting_status = p_filters->>'postingStatus')
    AND (p_filters->>'accountId' IS NULL OR ie.account_id = (p_filters->>'accountId')::uuid)
    AND (p_filters->>'fromDate' IS NULL OR ie.voucher_date >= (p_filters->>'fromDate')::date)
    AND (p_filters->>'toDate' IS NULL OR ie.voucher_date <= (p_filters->>'toDate')::date)
  ORDER BY ie.voucher_date DESC, ie.created_at DESC
  LIMIT LEAST(GREATEST(COALESCE((p_filters->>'limit')::int, 100), 1), 200)
  OFFSET GREATEST(COALESCE((p_filters->>'offset')::int, 0), 0);
$fn$;

CREATE OR REPLACE FUNCTION public.get_income_expense_stats_v2(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT jsonb_build_object(
    'count', count(*),
    'income_total', COALESCE(sum(ie.total_amount) FILTER (WHERE ie.type = 'INCOME' AND ie.posting_status = 'POSTED'), 0),
    'expense_total', COALESCE(sum(ie.total_amount) FILTER (WHERE ie.type = 'EXPENSE' AND ie.posting_status = 'POSTED'), 0),
    'pending_count', count(*) FILTER (WHERE ie.approval_status = 'UNAPPROVED'),
    'approved_unposted_count', count(*) FILTER (WHERE ie.approval_status = 'APPROVED' AND ie.posting_status = 'UNPOSTED'),
    'posted_count', count(*) FILTER (WHERE ie.posting_status = 'POSTED')
  )
  FROM app_private.finance_v2_visible_vouchers() ie
  WHERE (p_filters->>'type' IS NULL OR ie.type = p_filters->>'type')
    AND (p_filters->>'accountId' IS NULL OR ie.account_id = (p_filters->>'accountId')::uuid)
    AND (p_filters->>'fromDate' IS NULL OR ie.voucher_date >= (p_filters->>'fromDate')::date)
    AND (p_filters->>'toDate' IS NULL OR ie.voucher_date <= (p_filters->>'toDate')::date);
$fn$;

CREATE OR REPLACE FUNCTION public.get_income_expense_detail_v2(p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT to_jsonb(ie.*) - 'idempotency_key' - 'source_payload_hash'
         || jsonb_build_object(
              'items', COALESCE((SELECT jsonb_agg(to_jsonb(it.*))
                                 FROM public.income_expense_items it
                                 WHERE it.income_expense_id = ie.id), '[]'::jsonb))
  FROM app_private.finance_v2_visible_vouchers() ie
  WHERE ie.id = p_id;
$fn$;

-- ===========================================================================
-- 3) Cashbook intent selectors + access read/admin RPCs + CAS mutation.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.list_cashbooks_for_income_v2()
RETURNS TABLE (id uuid, name text, possession_kind text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT a.id, a.name, b.possession_kind
  FROM public.cashbook_possession_bindings b
  JOIN public.organization_memberships m ON m.id = b.membership_id
  JOIN public.accounts a ON a.id = b.cashbook_id
  WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
    AND b.valid_to IS NULL
    AND b.possession_kind IN ('CUSTODIAN', 'KNOWER')
    AND a.deleted_at IS NULL;
$fn$;

CREATE OR REPLACE FUNCTION public.list_cashbooks_for_expense_v2()
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT a.id, a.name
  FROM public.cashbook_possession_bindings b
  JOIN public.organization_memberships m ON m.id = b.membership_id
  JOIN public.accounts a ON a.id = b.cashbook_id
  WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
    AND b.valid_to IS NULL AND b.possession_kind = 'CUSTODIAN'
    AND a.deleted_at IS NULL;
$fn$;

CREATE OR REPLACE FUNCTION public.list_cashbooks_with_balance_v2()
RETURNS TABLE (id uuid, name text, current_amount numeric)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT v.id, v.name, v.current_amount
  FROM public.accounts_with_balance_v2 v
  WHERE EXISTS (
    SELECT 1
    FROM public.cashbook_possession_bindings b
    JOIN public.organization_memberships m ON m.id = b.membership_id
    WHERE b.cashbook_id = v.id AND b.possession_kind = 'CUSTODIAN'
      AND b.valid_to IS NULL AND m.user_id = auth.uid() AND m.status = 'ACTIVE'
  );
$fn$;

CREATE OR REPLACE FUNCTION public.list_my_cashbook_access_v2()
RETURNS TABLE (cashbook_id uuid, cashbook_name text, possession_kind text, since timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT b.cashbook_id, a.name, b.possession_kind, b.valid_from
  FROM public.cashbook_possession_bindings b
  JOIN public.organization_memberships m ON m.id = b.membership_id
  JOIN public.accounts a ON a.id = b.cashbook_id
  WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE' AND b.valid_to IS NULL;
$fn$;

CREATE OR REPLACE FUNCTION public.get_cashbook_access_admin_v2(p_cashbook_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.accounts
  WHERE id = p_cashbook_id AND deleted_at IS NULL;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Cashbook not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT COALESCE((SELECT z.allowed FROM app_private.authorize_tenant_action_v3(
           auth.uid(), v_org, 'cashbooks.share', NULL, p_cashbook_id) z LIMIT 1), false) THEN
    RAISE EXCEPTION 'cashbooks.share required for cashbook access administration'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'cashbook_id', p_cashbook_id,
    'cashbook_name', (SELECT name FROM public.accounts WHERE id = p_cashbook_id),
    'revision', COALESCE((SELECT revision FROM app_private.cashbook_access_states
                          WHERE organization_id = v_org AND cashbook_id = p_cashbook_id), 0),
    'custodians', COALESCE((SELECT jsonb_agg(jsonb_build_object('membership_id', b.membership_id, 'user_id', m.user_id))
                            FROM public.cashbook_possession_bindings b
                            JOIN public.organization_memberships m ON m.id = b.membership_id
                            WHERE b.organization_id = v_org AND b.cashbook_id = p_cashbook_id
                              AND b.possession_kind = 'CUSTODIAN' AND b.valid_to IS NULL), '[]'::jsonb),
    'knowers', COALESCE((SELECT jsonb_agg(jsonb_build_object('membership_id', b.membership_id, 'user_id', m.user_id))
                         FROM public.cashbook_possession_bindings b
                         JOIN public.organization_memberships m ON m.id = b.membership_id
                         WHERE b.organization_id = v_org AND b.cashbook_id = p_cashbook_id
                           AND b.possession_kind = 'KNOWER' AND b.valid_to IS NULL), '[]'::jsonb),
    'eligible_memberships', COALESCE((SELECT jsonb_agg(jsonb_build_object('membership_id', m.id, 'user_id', m.user_id))
                                      FROM public.organization_memberships m
                                      WHERE m.organization_id = v_org AND m.status = 'ACTIVE'), '[]'::jsonb));
END
$fn$;

CREATE OR REPLACE FUNCTION public.set_cashbook_access_v2(
  p_cashbook_id uuid,
  p_custodians uuid[],
  p_knowers uuid[],
  p_expected_revision bigint,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
DECLARE
  v_org uuid;
  v_actor_membership uuid;
  v_payload_hash text;
  v_existing app_private.cashbook_access_mutation_requests%ROWTYPE;
  v_revision bigint;
  v_before text[];
  v_after text[];
  v_result jsonb;
BEGIN
  SELECT organization_id INTO v_org FROM public.accounts
  WHERE id = p_cashbook_id AND deleted_at IS NULL FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Cashbook not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT COALESCE((SELECT z.allowed FROM app_private.authorize_tenant_action_v3(
           auth.uid(), v_org, 'cashbooks.share', NULL, p_cashbook_id) z LIMIT 1), false) THEN
    RAISE EXCEPTION 'cashbooks.share required to change cashbook access' USING ERRCODE = '42501';
  END IF;

  SELECT m.id INTO v_actor_membership FROM public.organization_memberships m
  WHERE m.user_id = auth.uid() AND m.organization_id = v_org AND m.status = 'ACTIVE'
  LIMIT 1;
  IF v_actor_membership IS NULL THEN
    RAISE EXCEPTION 'No active membership in cashbook organization' USING ERRCODE = '42501';
  END IF;

  -- Membership sanity: every target must be an ACTIVE membership of the same org.
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_custodians, '{}') || COALESCE(p_knowers, '{}')) t(mid)
    WHERE NOT EXISTS (SELECT 1 FROM public.organization_memberships m
                      WHERE m.id = t.mid AND m.organization_id = v_org AND m.status = 'ACTIVE')
  ) THEN
    RAISE EXCEPTION 'Target membership is not an active member of this organization'
      USING ERRCODE = '23514';
  END IF;

  v_payload_hash := md5(p_cashbook_id::text || ':' ||
    COALESCE(array_to_string(ARRAY(SELECT unnest(p_custodians) ORDER BY 1), ','), '') || '|' ||
    COALESCE(array_to_string(ARRAY(SELECT unnest(p_knowers) ORDER BY 1), ','), '') || ':' ||
    p_expected_revision::text);

  -- Idempotency (same key + same payload => replay stored result; different payload => conflict).
  SELECT * INTO v_existing FROM app_private.cashbook_access_mutation_requests
  WHERE organization_id = v_org AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.payload_hash = v_payload_hash THEN
      RETURN v_existing.result_snapshot;
    END IF;
    RAISE EXCEPTION 'Idempotency key reused with a different payload' USING ERRCODE = '23505';
  END IF;

  -- CAS on the access revision.
  INSERT INTO app_private.cashbook_access_states (organization_id, cashbook_id, revision)
  VALUES (v_org, p_cashbook_id, 0)
  ON CONFLICT (organization_id, cashbook_id) DO NOTHING;
  SELECT revision INTO v_revision FROM app_private.cashbook_access_states
  WHERE organization_id = v_org AND cashbook_id = p_cashbook_id FOR UPDATE;
  IF v_revision IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'Stale access revision (expected %, current %)', p_expected_revision, v_revision
      USING ERRCODE = '55000';
  END IF;

  -- No self-role change through the normal RPC (§2.5): actor's own kind-set must be
  -- identical before and after; self changes go through a break-glass workflow.
  SELECT COALESCE(array_agg(DISTINCT b.possession_kind ORDER BY b.possession_kind), '{}')
    INTO v_before
  FROM public.cashbook_possession_bindings b
  WHERE b.organization_id = v_org AND b.cashbook_id = p_cashbook_id
    AND b.membership_id = v_actor_membership
    AND b.possession_kind IN ('CUSTODIAN', 'KNOWER') AND b.valid_to IS NULL;
  v_after := '{}';
  IF v_actor_membership = ANY (COALESCE(p_custodians, '{}')) THEN v_after := v_after || 'CUSTODIAN'; END IF;
  IF v_actor_membership = ANY (COALESCE(p_knowers, '{}')) THEN v_after := v_after || 'KNOWER'; END IF;
  v_after := ARRAY(SELECT unnest(v_after) ORDER BY 1);
  IF v_before IS DISTINCT FROM v_after THEN
    RAISE EXCEPTION 'Self role change is not allowed through the normal share RPC'
      USING ERRCODE = '42501';
  END IF;

  -- Close bindings that fall out of the target lists (append-only history: close, never delete).
  UPDATE public.cashbook_possession_bindings b
    SET valid_to = now()
  WHERE b.organization_id = v_org AND b.cashbook_id = p_cashbook_id AND b.valid_to IS NULL
    AND ((b.possession_kind = 'CUSTODIAN' AND NOT (b.membership_id = ANY (COALESCE(p_custodians, '{}'))))
      OR (b.possession_kind = 'KNOWER' AND NOT (b.membership_id = ANY (COALESCE(p_knowers, '{}')))));

  -- Open missing bindings. OPERATOR rows are compatibility-only and never touched here.
  INSERT INTO public.cashbook_possession_bindings
    (organization_id, cashbook_id, membership_id, possession_kind, granted_by, reason)
  SELECT v_org, p_cashbook_id, t.mid, t.kind, auth.uid(), 'set_cashbook_access_v2'
  FROM (
    SELECT unnest(COALESCE(p_custodians, '{}')) AS mid, 'CUSTODIAN'::text AS kind
    UNION ALL
    SELECT unnest(COALESCE(p_knowers, '{}')), 'KNOWER'
  ) t
  WHERE NOT EXISTS (
    SELECT 1 FROM public.cashbook_possession_bindings b
    WHERE b.organization_id = v_org AND b.cashbook_id = p_cashbook_id
      AND b.membership_id = t.mid AND b.possession_kind = t.kind AND b.valid_to IS NULL
  );

  UPDATE app_private.cashbook_access_states
    SET revision = revision + 1, updated_by = auth.uid(), updated_at = now()
  WHERE organization_id = v_org AND cashbook_id = p_cashbook_id;

  v_result := jsonb_build_object(
    'cashbook_id', p_cashbook_id,
    'revision', v_revision + 1,
    'custodian_count', COALESCE(array_length(p_custodians, 1), 0),
    'knower_count', COALESCE(array_length(p_knowers, 1), 0));

  INSERT INTO app_private.cashbook_access_mutation_requests
    (organization_id, idempotency_key, payload_hash, expected_revision,
     resulting_revision, actor_membership_id, result_snapshot)
  VALUES (v_org, p_idempotency_key, v_payload_hash, p_expected_revision,
          v_revision + 1, v_actor_membership, v_result);

  INSERT INTO app_private.finance_v2_semantic_event_log
    (organization_id, event_kind, source_table, source_id, source_kind, actor, txid)
  VALUES (v_org, 'CASHBOOK_ACCESS_MUTATION', 'cashbook_possession_bindings', p_cashbook_id,
          'V2_WRITE', auth.uid(), pg_current_xact_id());

  RETURN v_result;
END
$fn$;

-- ===========================================================================
-- 4) Safe execution-queue projection (§6.4 routing; CUSTODIAN candidates or assigner).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.list_finance_execution_queue_v2()
RETURNS TABLE (
  scope_id uuid, organization_id uuid, execution_subject_kind text,
  execution_subject_id uuid, parent_voucher_id uuid, state text,
  assigned_cashbook_id uuid, revision bigint, my_candidate_cashbooks uuid[]
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  WITH me AS (
    SELECT m.id AS membership_id, m.organization_id
    FROM public.organization_memberships m
    WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE'
  ),
  my_custodian AS (
    SELECT b.organization_id, b.cashbook_id
    FROM public.cashbook_possession_bindings b
    JOIN me ON me.membership_id = b.membership_id
    WHERE b.possession_kind = 'CUSTODIAN' AND b.valid_to IS NULL
  )
  SELECT s.id, s.organization_id, s.execution_subject_kind, s.execution_subject_id,
         s.parent_voucher_id, s.state, s.assigned_cashbook_id, s.revision,
         ARRAY(SELECT c.cashbook_id
               FROM app_private.finance_execution_cashbook_candidates c
               JOIN my_custodian mc ON mc.cashbook_id = c.cashbook_id
               WHERE c.execution_scope_id = s.id) AS my_candidate_cashbooks
  FROM app_private.finance_execution_scopes s
  JOIN me ON me.organization_id = s.organization_id
  WHERE s.state IN ('UNASSIGNED', 'ASSIGNED')
    AND (
      -- CUSTODIAN of an exact candidate/assigned cashbook sees the safe payable row
      EXISTS (SELECT 1 FROM app_private.finance_execution_cashbook_candidates c
              JOIN my_custodian mc ON mc.cashbook_id = c.cashbook_id
              WHERE c.execution_scope_id = s.id)
      OR EXISTS (SELECT 1 FROM my_custodian mc WHERE mc.cashbook_id = s.assigned_cashbook_id)
      -- assigner (cashbooks.share covering the org) sees the Chờ phân sổ queue
      OR COALESCE((SELECT z.allowed FROM app_private.authorize_tenant_action_v3(
           auth.uid(), s.organization_id, 'cashbooks.share', NULL, NULL) z LIMIT 1), false)
    );
$fn$;

-- ===========================================================================
-- ACL: public read RPCs to authenticated only.
-- ===========================================================================
DO $g11c$
DECLARE
  v_fn text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[
    'public.list_income_expenses_v2(jsonb)',
    'public.get_income_expense_stats_v2(jsonb)',
    'public.get_income_expense_detail_v2(uuid)',
    'public.list_cashbooks_for_income_v2()',
    'public.list_cashbooks_for_expense_v2()',
    'public.list_cashbooks_with_balance_v2()',
    'public.list_my_cashbook_access_v2()',
    'public.get_cashbook_access_admin_v2(uuid)',
    'public.set_cashbook_access_v2(uuid,uuid[],uuid[],bigint,text)',
    'public.list_finance_execution_queue_v2()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_fn);
    IF to_regrole('anon') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', v_fn);
    END IF;
    IF to_regrole('service_role') IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM service_role', v_fn);
    END IF;
    IF to_regrole('authenticated') IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_fn);
    END IF;
  END LOOP;
END
$g11c$;

COMMIT;

NOTIFY pgrst, 'reload schema';
