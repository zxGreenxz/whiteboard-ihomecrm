BEGIN;

-- Build one deterministic document for the current snapshot set. The shape of
-- `before` intentionally matches _profit_state_change_v2 so both paths hash the
-- exact same data, including allocations.
CREATE OR REPLACE FUNCTION public._profit_current_state_v2(
  p_organization_id uuid,
  p_period_month date
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
  WITH snapshot_rows AS MATERIALIZED (
    SELECT
      pm.*,
      b.name AS building_name,
      COALESCE(b.is_virtual, false) AS building_is_virtual,
      (b.id IS NULL OR b.deleted_at IS NOT NULL) AS building_deleted,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', pa.id,
            'shareholder_id', pa.shareholder_id,
            'percent', pa.percent,
            'amount', pa.amount,
            'created_at', pa.created_at
          ) ORDER BY pa.shareholder_id, pa.id
        )
        FROM public.profit_allocations pa
        WHERE pa.profit_monthly_id = pm.id
      ), '[]'::jsonb) AS shareholder_allocations,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', pma.id,
            'manager_id', pma.manager_id,
            'amount', pma.amount,
            'created_at', pma.created_at
          ) ORDER BY pma.manager_id, pma.id
        )
        FROM public.profit_manager_allocations pma
        WHERE pma.profit_monthly_id = pm.id
      ), '[]'::jsonb) AS manager_allocations
    FROM public.profit_monthly pm
    LEFT JOIN public.buildings b ON b.id = pm.building_id
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
  ),
  before_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'profit_monthly', to_jsonb(sr)
          - 'building_name'
          - 'building_is_virtual'
          - 'building_deleted'
          - 'shareholder_allocations'
          - 'manager_allocations',
        'shareholder_allocations', sr.shareholder_allocations,
        'manager_allocations', sr.manager_allocations
      ) ORDER BY sr.building_id
    ), '[]'::jsonb) AS value
    FROM snapshot_rows sr
  ),
  row_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', sr.id,
        'building_id', sr.building_id,
        'building_name', COALESCE(sr.building_name, '[Deleted building]'),
        'is_virtual', sr.building_is_virtual,
        'building_deleted', sr.building_deleted,
        'status', sr.status,
        'computed_profit', sr.computed_profit,
        'adjusted_profit', sr.adjusted_profit,
        'adjustment_amount', sr.adjustment_amount,
        'adjustment_reason', sr.adjustment_reason,
        'management_salary', sr.management_salary,
        'distributable_profit', sr.adjusted_profit - sr.management_salary,
        'source_revenue', sr.source_revenue,
        'source_expense', sr.source_expense,
        'source_hash', sr.source_hash,
        'is_stale', sr.is_stale,
        'stale_reason', sr.stale_reason,
        'revision_number', sr.revision_number,
        'locked_at', sr.locked_at
      ) ORDER BY sr.building_id
    ), '[]'::jsonb) AS value
    FROM snapshot_rows sr
  ),
  snapshot_meta AS (
    SELECT
      COALESCE(array_agg(sr.id ORDER BY sr.id), '{}'::uuid[]) AS snapshot_ids,
      COALESCE(array_agg(sr.building_id ORDER BY sr.building_id), '{}'::uuid[])
        AS building_ids,
      count(*)::integer AS snapshot_count,
      count(*) FILTER (WHERE sr.status = 'LOCKED')::integer AS locked_count,
      count(*) FILTER (WHERE sr.status = 'DRAFT')::integer AS draft_count,
      count(*) FILTER (
        WHERE NOT sr.building_is_virtual AND NOT sr.building_deleted
      )::integer AS active_real_snapshot_count,
      bool_or(sr.building_is_virtual OR sr.building_deleted)
        AS has_out_of_scope_snapshots
    FROM snapshot_rows sr
  ),
  building_meta AS (
    SELECT count(*)::integer AS real_building_count
    FROM public.buildings b
    WHERE b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false
  )
  SELECT jsonb_build_object(
    'organization_id', p_organization_id,
    'period_month', p_period_month,
    'state_hash', md5(bd.value::text),
    'snapshot_ids', to_jsonb(sm.snapshot_ids),
    'building_ids', to_jsonb(sm.building_ids),
    'snapshot_count', sm.snapshot_count,
    'locked_count', sm.locked_count,
    'draft_count', sm.draft_count,
    'real_building_count', bm.real_building_count,
    'active_real_snapshot_count', sm.active_real_snapshot_count,
    'has_out_of_scope_snapshots', COALESCE(sm.has_out_of_scope_snapshots, false),
    'rows', rd.value,
    'before', bd.value
  )
  FROM before_document bd
  CROSS JOIN row_document rd
  CROSS JOIN snapshot_meta sm
  CROSS JOIN building_meta bm;
$fn$;

CREATE OR REPLACE FUNCTION public.profit_close_scopes_v2()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_is_super_admin boolean;
  v_organizations jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  v_is_super_admin := public.is_super_admin();

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'organization_id', scoped.organization_id,
      'organization_name', scoped.organization_name,
      'organization_slug', scoped.organization_slug,
      'can_lock', scoped.can_lock,
      'can_unlock', scoped.can_unlock
    ) ORDER BY scoped.organization_name, scoped.organization_id
  ), '[]'::jsonb)
  INTO v_organizations
  FROM (
    SELECT
      o.id AS organization_id,
      o.name AS organization_name,
      o.slug AS organization_slug,
      (
        v_is_super_admin OR public.authorize_v2(
          'shareholder_profit.lock', o.id, 'ORGANIZATION', NULL
        )
      ) AS can_lock,
      (
        v_is_super_admin OR public.authorize_v2(
          'shareholder_profit.unlock', o.id, 'ORGANIZATION', NULL
        )
      ) AS can_unlock
    FROM public.organizations o
    JOIN public.organization_memberships m
      ON m.organization_id = o.id
     AND m.user_id = v_actor
     AND m.status = 'ACTIVE'
     AND m.valid_from <= clock_timestamp()
     AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
    WHERE o.status = 'ACTIVE'
  ) scoped
  WHERE scoped.can_lock OR scoped.can_unlock;

  RETURN jsonb_build_object('organizations', v_organizations);
END
$fn$;

CREATE OR REPLACE FUNCTION public.profit_close_state_v2(
  p_organization_id uuid,
  p_period_month date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_can_lock boolean;
  v_can_unlock boolean;
  v_state jsonb;
BEGIN
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;

  v_can_lock := public.is_super_admin() OR public.authorize_v2(
    'shareholder_profit.lock', p_organization_id, 'ORGANIZATION', NULL
  );
  v_can_unlock := public.is_super_admin() OR public.authorize_v2(
    'shareholder_profit.unlock', p_organization_id, 'ORGANIZATION', NULL
  );

  IF v_can_lock THEN
    PERFORM public._profit_assert_authorized_v2(
      p_organization_id, 'shareholder_profit.lock'
    );
  ELSE
    PERFORM public._profit_assert_authorized_v2(
      p_organization_id, 'shareholder_profit.unlock'
    );
  END IF;

  v_state := public._profit_current_state_v2(
    p_organization_id, p_period_month
  );

  RETURN (v_state - 'before' - 'building_ids') || jsonb_build_object(
    'can_lock', v_can_lock,
    'can_unlock', v_can_unlock
  );
END
$fn$;

-- Lock operators need canonical preview data even when the independent `view`
-- permission is absent. Unlock-only operators use profit_close_state_v2 and do
-- not need the canonical source preview.
CREATE OR REPLACE FUNCTION public.profit_close_preview_v2(
  p_organization_id uuid,
  p_period_month date,
  p_building_ids uuid[] DEFAULT NULL,
  p_adjustments jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_building_ids uuid[] := p_building_ids;
  v_permission text := 'shareholder_profit.view';
BEGIN
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;

  IF NOT public.is_super_admin()
     AND NOT public.authorize_v2(
       'shareholder_profit.view', p_organization_id, 'ORGANIZATION', NULL
     )
     AND public.authorize_v2(
       'shareholder_profit.lock', p_organization_id, 'ORGANIZATION', NULL
     ) THEN
    v_permission := 'shareholder_profit.lock';
  END IF;

  IF v_building_ids IS NULL THEN
    SELECT array_agg(b.id ORDER BY b.id)
    INTO v_building_ids
    FROM public.buildings b
    WHERE b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false;
  END IF;

  RETURN public._profit_close_preview_core_v2(
    p_organization_id,
    p_period_month,
    v_building_ids,
    p_adjustments,
    v_permission,
    false
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.profit_reset_checked_v2(
  p_organization_id uuid,
  p_period_month date,
  p_reason text,
  p_idempotency_key text,
  p_expected_state_hash text,
  p_expected_snapshot_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_expected_hash text := lower(btrim(COALESCE(p_expected_state_hash, '')));
  v_expected_ids uuid[];
  v_existing public.profit_close_runs%ROWTYPE;
  v_existing_ids uuid[];
  v_state jsonb;
  v_current_ids uuid[];
  v_building_ids uuid[];
  v_current_hash text;
BEGIN
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 8 AND 1000 THEN
    RAISE EXCEPTION 'reason must contain 8..1000 characters'
      USING ERRCODE = '22023';
  END IF;
  IF char_length(v_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'idempotency_key must contain 8..200 characters'
      USING ERRCODE = '22023';
  END IF;
  IF v_expected_hash !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'expected_state_hash must be a 32-character lowercase MD5'
      USING ERRCODE = '22023';
  END IF;
  IF p_expected_snapshot_ids IS NULL
     OR cardinality(p_expected_snapshot_ids) = 0
     OR array_position(p_expected_snapshot_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'expected_snapshot_ids must be a non-empty UUID array'
      USING ERRCODE = '22023';
  END IF;

  SELECT array_agg(DISTINCT snapshot_id ORDER BY snapshot_id)
  INTO v_expected_ids
  FROM unnest(p_expected_snapshot_ids) snapshot_id;
  IF cardinality(v_expected_ids) <> cardinality(p_expected_snapshot_ids) THEN
    RAISE EXCEPTION 'expected_snapshot_ids contains duplicates'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, 'shareholder_profit.unlock'
  );

  -- Keep the same lock order as _profit_state_change_v2. Both locks are
  -- transaction-scoped and re-entrant when the checked wrapper calls it.
  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext('profit-key:' || v_key)
  );

  SELECT *
  INTO v_existing
  FROM public.profit_close_runs r
  WHERE r.organization_id = p_organization_id
    AND r.idempotency_key = v_key;

  IF FOUND THEN
    SELECT COALESCE(array_agg(
      (entry.value->'profit_monthly'->>'id')::uuid
      ORDER BY (entry.value->'profit_monthly'->>'id')::uuid
    ), '{}'::uuid[])
    INTO v_existing_ids
    FROM jsonb_array_elements(
      COALESCE(v_existing.source_snapshot->'rows', '[]'::jsonb)
    ) entry(value);

    IF v_existing.operation <> 'RESET'
       OR v_existing.period_month <> p_period_month
       OR v_existing.reason <> v_reason
       OR COALESCE(v_existing.result_snapshot->>'state_hash', '') <> v_expected_hash
       OR v_existing_ids IS DISTINCT FROM v_expected_ids THEN
      RAISE EXCEPTION 'Idempotency key was already used with a different request'
        USING ERRCODE = '23505';
    END IF;

    RETURN v_existing.result_snapshot
      || jsonb_build_object('idempotent_replay', true);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext(p_period_month::text)
  );

  v_state := public._profit_current_state_v2(
    p_organization_id, p_period_month
  );
  v_current_hash := v_state->>'state_hash';

  SELECT COALESCE(array_agg(value::uuid ORDER BY value::uuid), '{}'::uuid[])
  INTO v_current_ids
  FROM jsonb_array_elements_text(v_state->'snapshot_ids') snapshot_id(value);

  IF v_current_ids IS DISTINCT FROM v_expected_ids
     OR v_current_hash IS DISTINCT FROM v_expected_hash THEN
    RAISE EXCEPTION
      'PROFIT_SNAPSHOT_CONFLICT current snapshots changed; reload before reset'
      USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(array_agg(value::uuid ORDER BY value::uuid), '{}'::uuid[])
  INTO v_building_ids
  FROM jsonb_array_elements_text(v_state->'building_ids') building_id(value);

  RETURN public._profit_state_change_v2(
    'RESET',
    p_organization_id,
    p_period_month,
    v_reason,
    v_key,
    v_building_ids,
    NULL
  );
END
$fn$;

COMMENT ON FUNCTION public.profit_close_scopes_v2() IS
  'Lists active organizations where the caller can lock or unlock profit snapshots.';
COMMENT ON FUNCTION public.profit_close_state_v2(uuid,date) IS
  'Returns the exact current snapshot set and deterministic reset state hash for one organization/month.';
COMMENT ON FUNCTION public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[]) IS
  'Hard reset protected by exact snapshot IDs and a deterministic snapshot/allocation state hash.';

REVOKE ALL ON FUNCTION public._profit_current_state_v2(uuid,date)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.profit_close_scopes_v2()
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profit_close_state_v2(uuid,date)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[])
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.profit_close_scopes_v2()
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_close_state_v2(uuid,date)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_reset_checked_v2(uuid,date,text,text,text,uuid[])
  TO authenticated;

-- The old reset accepted a nullable, per-row source hash and therefore could
-- not protect a whole-month destructive reset. All clients must use checked V2.
REVOKE ALL ON FUNCTION public.profit_reset_v2(uuid,date,text,text,uuid[],text)
  FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
