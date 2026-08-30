-- Align Copilot scope resolution with the selectable organization directory.
-- Revoked members are denied, while an authorized organization with no matching
-- resources returns an empty payload instead of a permission error.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_org_scope_buildings_v1(
  p_permission_key text,
  p_organization_id uuid
)
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_scope uuid[];
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.id = p_organization_id
      AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- Directory visibility is only a selection aid. Resource scope must still
  -- come from the shared permission resolver, even for a superadmin.
  -- Do not trust status alone: a revoked membership can remain ACTIVE while
  -- its revocation timestamp is being retained for audit history.
  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships m
    WHERE m.organization_id = p_organization_id
      AND m.user_id = v_actor
      AND m.status = 'ACTIVE'
      AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= v_now
      AND (m.valid_to IS NULL OR m.valid_to > v_now)
  ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  SELECT CASE
           WHEN s.org_wide THEN COALESCE((
             SELECT array_agg(b.id ORDER BY b.id)
             FROM public.buildings b
             WHERE b.organization_id = p_organization_id
               AND b.deleted_at IS NULL
           ), '{}'::uuid[])
           ELSE COALESCE(s.building_ids, '{}'::uuid[])
         END
    INTO v_scope
    FROM app_private.authorized_scope_v3(p_permission_key, p_organization_id) s;

  -- Empty is a valid business result (for example, an empty building set).
  -- The caller still receives no rows and cannot use this as an authorization
  -- bypass because every resource query is constrained by this array.
  RETURN COALESCE(v_scope, '{}'::uuid[]);
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.copilot_scope_cashbooks_v1(
  p_permission_key text,
  p_organization_id uuid
)
RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_now timestamptz := now();
  v_scope uuid[];
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.organizations o
    WHERE o.id = p_organization_id
      AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.organization_memberships m
    WHERE m.organization_id = p_organization_id
      AND m.user_id = v_actor
      AND m.status = 'ACTIVE'
      AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from, '-infinity'::timestamptz) <= v_now
      AND (m.valid_to IS NULL OR m.valid_to > v_now)
  ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  SELECT s.cashbook_ids
    INTO v_scope
    FROM app_private.authorized_scope_v3(p_permission_key, p_organization_id) s;
  RETURN COALESCE(v_scope, '{}'::uuid[]);
END
$fn$;

CREATE OR REPLACE FUNCTION public.copilot_cashbook_settlement_v2(
  p_organization_id uuid,
  p_from date,
  p_to date
)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_scope uuid[];
  v_accounts jsonb;
  v_sessions jsonb;
  v_recons jsonb;
BEGIN
  v_scope := app_private.copilot_scope_cashbooks_v1('cashbooks.view', p_organization_id);

  SELECT jsonb_agg(
    jsonb_build_object(
      'account_id', a.id,
      'name', a.name,
      'is_bank', (a.name ILIKE 'tk%' OR a.bank_name IS NOT NULL),
      'current_balance', COALESCE(ab.current_amount, 0),
      'period_collected', COALESCE((
        SELECT sum(ie.total_amount)
        FROM public.income_expenses ie
        WHERE ie.account_id = a.id
          AND ie.type = 'INCOME'
          AND ie.approval_status = 'APPROVED'
          AND ie.deleted_at IS NULL
          AND ie.handover_transfer_id IS NULL
          AND ie.voucher_date BETWEEN p_from AND p_to
      ), 0),
      'period_spent', COALESCE((
        SELECT sum(ie.total_amount)
        FROM public.income_expenses ie
        WHERE ie.account_id = a.id
          AND ie.type = 'EXPENSE'
          AND ie.approval_status = 'APPROVED'
          AND ie.deleted_at IS NULL
          AND ie.handover_transfer_id IS NULL
          AND ie.voucher_date BETWEEN p_from AND p_to
      ), 0),
      'period_handed_over', COALESCE((
        SELECT sum(ch.total_amount)
        FROM public.cash_handovers ch
        WHERE ch.from_account_id = a.id
          AND ch.status = 'CONFIRMED'
          AND ch.confirmed_at::date BETWEEN p_from AND p_to
      ), 0),
      'last_reconciliation', (
        SELECT jsonb_build_object(
          'as_of_date', r.as_of_date,
          'system_balance', r.system_balance,
          'counted_balance', r.counted_balance,
          'diff', r.diff,
          'status', r.status,
          'confirmed_at', r.confirmed_at
        )
        FROM public.cashbook_reconciliations r
        WHERE r.account_id = a.id
          AND r.status = 'CONFIRMED'
        ORDER BY r.as_of_date DESC, r.confirmed_at DESC
        LIMIT 1
      )
    ) ORDER BY a.name
  )
  INTO v_accounts
  FROM public.accounts a
  LEFT JOIN public.accounts_with_balance ab ON ab.id = a.id
  WHERE a.id = ANY(v_scope)
    AND a.organization_id = p_organization_id
    AND a.deleted_at IS NULL
    AND NOT a.is_virtual
    AND (
      btrim(a.name) LIKE '%Thu'
      OR a.name ILIKE 'tk%'
      OR a.bank_name IS NOT NULL
      OR EXISTS (SELECT 1 FROM public.cash_handovers ch WHERE ch.from_account_id = a.id)
    )
    AND NOT (public.is_super_admin() AND a.organization_id = ANY(public.sandbox_org_ids()))
    AND NOT (
      (public.is_super_admin() OR public.is_admin())
      AND a.user_id = ANY(public.demo_user_ids())
    );

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'code', ch.code,
      'gross', ch.gross_amount,
      'expense', ch.expense_amount,
      'net', ch.total_amount,
      'voucher_count', ch.voucher_count,
      'status', ch.status,
      'confirmed_at', ch.confirmed_at,
      'created_at', ch.created_at
    ) ORDER BY ch.confirmed_at DESC NULLS LAST, ch.created_at DESC
  ), '[]'::jsonb)
  INTO v_sessions
  FROM public.cash_handovers ch
  LEFT JOIN public.accounts fa ON fa.id = ch.from_account_id
  LEFT JOIN public.accounts ta ON ta.id = ch.to_account_id
  WHERE COALESCE(ch.organization_id, fa.organization_id) = p_organization_id
    AND ch.status = 'CONFIRMED'
    AND ch.confirmed_at::date BETWEEN p_from AND p_to
    AND ch.from_account_id = ANY(v_scope)
    AND (
      ch.giver_id = auth.uid()
      OR ch.receiver_id = auth.uid()
      OR public.is_admin()
      OR public.is_super_admin()
    )
    AND NOT fa.is_virtual
    AND NOT (
      public.is_super_admin()
      AND COALESCE(ch.organization_id, fa.organization_id) = ANY(public.sandbox_org_ids())
    )
    AND NOT (
      (public.is_super_admin() OR public.is_admin())
      AND (
        COALESCE(fa.user_id = ANY(public.demo_user_ids()), false)
        OR COALESCE(ta.user_id = ANY(public.demo_user_ids()), false)
      )
    );

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'as_of_date', r.as_of_date,
      'system_balance', r.system_balance,
      'counted_balance', r.counted_balance,
      'diff', r.diff,
      'status', r.status,
      'confirmed_at', r.confirmed_at
    ) ORDER BY r.as_of_date DESC
  ), '[]'::jsonb)
  INTO v_recons
  FROM public.cashbook_reconciliations r
  JOIN public.accounts a ON a.id = r.account_id
  WHERE COALESCE(r.organization_id, a.organization_id) = p_organization_id
    AND r.status = 'CONFIRMED'
    AND r.as_of_date BETWEEN p_from AND p_to
    AND r.account_id = ANY(v_scope)
    AND (
      a.user_id = auth.uid()
      OR r.proposed_by = auth.uid()
      OR r.counterparty_id = auth.uid()
      OR public.same_team(a.user_id)
      OR public.is_admin()
      OR public.is_super_admin()
    )
    AND NOT a.is_virtual
    AND NOT (
      public.is_super_admin()
      AND COALESCE(r.organization_id, a.organization_id) = ANY(public.sandbox_org_ids())
    )
    AND NOT (
      (public.is_super_admin() OR public.is_admin())
      AND a.user_id = ANY(public.demo_user_ids())
    );

  RETURN jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'accounts', COALESCE(v_accounts, '[]'::jsonb),
    'sessions', v_sessions,
    'reconciliations', v_recons
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_org_scope_buildings_v1(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.copilot_org_scope_buildings_v1(text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION app_private.copilot_scope_cashbooks_v1(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION app_private.copilot_scope_cashbooks_v1(text, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.copilot_cashbook_settlement_v2(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.copilot_cashbook_settlement_v2(uuid, date, date) TO authenticated;
COMMIT;
