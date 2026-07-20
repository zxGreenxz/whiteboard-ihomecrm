-- =============================================================================
-- Profit Close V2 forward fix: ignore inactive/deleted shareholder mappings.
--
-- Production contains legacy building_shareholders rows that still reference a
-- same-organization shareholder after soft deletion. V2 allocations already
-- join only active shareholders; this migration aligns structural validation and
-- the 100-percent guard with that active set. Missing/cross-org IDs still fail.
-- No shareholder/config/source row is modified.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public._profit_close_preview_core_v2(
  p_organization_id uuid,
  p_period_month date,
  p_building_ids uuid[],
  p_adjustments jsonb,
  p_permission_key text,
  p_lock_sources boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_period_end date;
  v_captured_at timestamptz := clock_timestamp();
  v_result jsonb;
  v_source_consistent boolean;
  v_adj record;
BEGIN
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  v_period_end := (p_period_month + interval '1 month - 1 day')::date;

  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, p_permission_key
  );

  IF p_building_ids IS NULL OR cardinality(p_building_ids) = 0 THEN
    RAISE EXCEPTION 'At least one building is required' USING ERRCODE = '22023';
  END IF;
  IF array_position(p_building_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'building_ids cannot contain NULL' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM unnest(p_building_ids) x)
     <> (SELECT count(DISTINCT x) FROM unnest(p_building_ids) x) THEN
    RAISE EXCEPTION 'building_ids contains duplicates' USING ERRCODE = '22023';
  END IF;

  -- Closing is short and infrequent. SHARE locks make the source/config
  -- snapshot atomic with the persisted close without changing any source row.
  IF p_lock_sources THEN
    LOCK TABLE public.income_expenses,
               public.income_expense_items,
               public.income_expense_types,
               public.invoices,
               public.building_shareholders,
               public.shareholders,
               public.profit_managers,
               public.profit_manager_salaries,
               public.profit_manager_salary_buildings,
               public.staff_assignments,
               public.roles,
               public.area_buildings,
               public.super_admins
      IN SHARE MODE;
  END IF;

  PERFORM 1
  FROM public.buildings b
  WHERE b.id = ANY(p_building_ids)
    AND b.organization_id = p_organization_id
    AND b.deleted_at IS NULL
    AND b.is_virtual = false
  FOR SHARE;
  IF (SELECT count(*)
      FROM public.buildings b
      WHERE b.id = ANY(p_building_ids)
        AND b.organization_id = p_organization_id
        AND b.deleted_at IS NULL
        AND b.is_virtual = false)
     <> cardinality(p_building_ids) THEN
    RAISE EXCEPTION 'Every building must be an active real building in the organization'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_super_admin() AND EXISTS (
    SELECT 1
    FROM unnest(p_building_ids) bid
    WHERE NOT public.authorize_v2(
      p_permission_key, p_organization_id, 'BUILDING', bid
    )
  ) THEN
    RAISE EXCEPTION 'Permission does not cover every requested building'
      USING ERRCODE = '42501';
  END IF;

  -- fa_* is the canonical implementation but applies legacy building scope
  -- internally. Fail explicitly instead of silently treating hidden data as 0.
  IF EXISTS (
    SELECT 1
    FROM unnest(p_building_ids) bid
    WHERE NOT COALESCE(public.can_access_building(bid), false)
  ) THEN
    RAISE EXCEPTION
      'Canonical accrual scope denied one or more buildings; no legacy fallback is allowed'
      USING ERRCODE = '42501';
  END IF;

  p_adjustments := COALESCE(p_adjustments, '[]'::jsonb);
  IF jsonb_typeof(p_adjustments) <> 'array' THEN
    RAISE EXCEPTION 'adjustments must be a JSON array' USING ERRCODE = '22023';
  END IF;

  IF (SELECT count(*)
      FROM jsonb_to_recordset(p_adjustments)
        AS a(building_id uuid, adjustment_amount numeric, adjustment_reason text))
     <> (SELECT count(DISTINCT a.building_id)
         FROM jsonb_to_recordset(p_adjustments)
           AS a(building_id uuid, adjustment_amount numeric, adjustment_reason text)) THEN
    RAISE EXCEPTION 'adjustments contains duplicate building_id values'
      USING ERRCODE = '22023';
  END IF;

  FOR v_adj IN
    SELECT *
    FROM jsonb_to_recordset(p_adjustments)
      AS a(building_id uuid, adjustment_amount numeric, adjustment_reason text)
  LOOP
    IF v_adj.building_id IS NULL
       OR NOT (v_adj.building_id = ANY(p_building_ids)) THEN
      RAISE EXCEPTION 'Every adjustment must target a requested building'
        USING ERRCODE = '22023';
    END IF;
    IF v_adj.adjustment_amount IS NULL
       OR v_adj.adjustment_amount::text = 'NaN'
       OR round(v_adj.adjustment_amount, 2) <> v_adj.adjustment_amount
       OR abs(v_adj.adjustment_amount) > 9999999999999.99 THEN
      RAISE EXCEPTION 'adjustment_amount must be a finite numeric with at most 2 decimals'
        USING ERRCODE = '22023';
    END IF;
    IF p_lock_sources AND v_adj.adjustment_amount <> 0
       AND (
         v_adj.adjustment_reason IS NULL
         OR char_length(btrim(v_adj.adjustment_reason)) NOT BETWEEN 8 AND 500
       ) THEN
      RAISE EXCEPTION 'A non-zero adjustment requires a reason of 8..500 characters'
        USING ERRCODE = '22023';
    END IF;
  END LOOP;

  -- Legacy mappings to inactive/soft-deleted shareholders are ignored, matching
  -- the established frontend behavior. Missing IDs and cross-org links remain
  -- structural corruption and fail closed.
  IF EXISTS (
    SELECT 1
    FROM public.building_shareholders bs
    LEFT JOIN public.shareholders sh ON sh.id = bs.shareholder_id
    WHERE bs.building_id = ANY(p_building_ids)
      AND (
        bs.organization_id IS DISTINCT FROM p_organization_id
        OR sh.id IS NULL
        OR sh.organization_id IS DISTINCT FROM p_organization_id
      )
  ) THEN
    RAISE EXCEPTION 'Shareholder configuration contains missing or cross-organization rows'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.building_shareholders bs
    JOIN public.shareholders sh
      ON sh.id = bs.shareholder_id
     AND sh.organization_id = p_organization_id
     AND sh.is_active
     AND sh.deleted_at IS NULL
    WHERE bs.building_id = ANY(p_building_ids)
      AND bs.organization_id = p_organization_id
    GROUP BY bs.building_id
    HAVING sum(bs.percent) > 100
  ) THEN
    RAISE EXCEPTION 'Shareholder percentages exceed 100 for a building'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_manager_salary_buildings rb
    JOIN public.profit_manager_salaries s ON s.id = rb.salary_id
    LEFT JOIN public.profit_managers m ON m.id = s.manager_id
    WHERE rb.building_id = ANY(p_building_ids)
      AND s.is_active
      AND (
        rb.organization_id IS DISTINCT FROM p_organization_id
        OR s.organization_id IS DISTINCT FROM p_organization_id
        OR m.id IS NULL
        OR m.organization_id IS DISTINCT FROM p_organization_id
        OR NOT m.is_active
        OR m.deleted_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Management salary configuration contains inactive or cross-organization rows'
      USING ERRCODE = '55000';
  END IF;

  WITH selected AS MATERIALIZED (
    SELECT b.id AS building_id, b.name AS building_name, b.user_id AS owner_user_id
    FROM public.buildings b
    WHERE b.id = ANY(p_building_ids)
      AND b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false
  ),
  adjustments AS MATERIALIZED (
    SELECT
      a.building_id,
      a.adjustment_amount::numeric AS adjustment_amount,
      CASE WHEN a.adjustment_amount <> 0 THEN btrim(a.adjustment_reason) END
        AS adjustment_reason
    FROM jsonb_to_recordset(p_adjustments)
      AS a(building_id uuid, adjustment_amount numeric, adjustment_reason text)
  ),
  pnl AS MATERIALIZED (
    SELECT
      x.building_id,
      sum(x.revenue)::numeric AS revenue,
      sum(x.expense)::numeric AS expense,
      sum(x.net)::numeric AS net
    FROM public.fa_monthly_pnl_accrual(
      p_period_month, v_period_end, p_building_ids
    ) x
    WHERE x.month = p_period_month AND x.is_virtual = false
    GROUP BY x.building_id
  ),
  source_lines AS MATERIALIZED (
    SELECT
      x.month,
      x.voucher_id,
      x.building_id,
      x.building_name,
      x.side,
      x.type_id,
      x.type_name,
      x.category,
      x.amount::numeric AS amount
    FROM public.fa_accrual_allocations(
      p_period_month, v_period_end, p_building_ids
    ) x
    WHERE x.month = p_period_month AND x.is_virtual = false
  ),
  line_totals AS (
    SELECT
      building_id,
      COALESCE(sum(amount) FILTER (WHERE side = 'INCOME'), 0)::numeric AS revenue,
      COALESCE(sum(amount) FILTER (WHERE side = 'EXPENSE'), 0)::numeric AS expense,
      (
        COALESCE(sum(amount) FILTER (WHERE side = 'INCOME'), 0)
        - COALESCE(sum(amount) FILTER (WHERE side = 'EXPENSE'), 0)
      )::numeric AS net
    FROM source_lines
    GROUP BY building_id
  ),
  base AS MATERIALIZED (
    SELECT
      s.building_id,
      s.building_name,
      s.owner_user_id,
      COALESCE(p.revenue, 0)::numeric AS source_revenue,
      COALESCE(p.expense, 0)::numeric AS source_expense,
      COALESCE(p.net, 0)::numeric AS computed_profit,
      COALESCE(a.adjustment_amount, 0)::numeric AS adjustment_amount,
      a.adjustment_reason,
      (COALESCE(p.net, 0) + COALESCE(a.adjustment_amount, 0))::numeric
        AS adjusted_profit
    FROM selected s
    LEFT JOIN pnl p ON p.building_id = s.building_id
    LEFT JOIN adjustments a ON a.building_id = s.building_id
  ),
  management_doc AS MATERIALIZED (
    SELECT public._profit_management_allocations_v2(
      p_organization_id,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object('building_id', building_id, 'base', adjusted_profit)
          ORDER BY building_id
        ) FROM base
      ), '[]'::jsonb)
    ) AS allocations
  ),
  manager_allocations AS MATERIALIZED (
    SELECT x.manager_id, x.building_id, x.amount::numeric AS amount
    FROM management_doc d
    CROSS JOIN LATERAL jsonb_to_recordset(d.allocations)
      AS x(manager_id uuid, building_id uuid, amount numeric)
  ),
  manager_totals AS (
    SELECT building_id, sum(amount)::numeric AS management_salary
    FROM manager_allocations
    GROUP BY building_id
  ),
  with_salary AS MATERIALIZED (
    SELECT
      b.*,
      COALESCE(mt.management_salary, 0)::numeric AS management_salary,
      (b.adjusted_profit - COALESCE(mt.management_salary, 0))::numeric
        AS distributable_profit
    FROM base b
    LEFT JOIN manager_totals mt ON mt.building_id = b.building_id
  ),
  share_config AS MATERIALIZED (
    SELECT
      bs.building_id,
      bs.shareholder_id,
      sh.name AS shareholder_name,
      bs.percent::numeric AS percent
    FROM public.building_shareholders bs
    JOIN public.shareholders sh
      ON sh.id = bs.shareholder_id
     AND sh.organization_id = p_organization_id
     AND sh.is_active
     AND sh.deleted_at IS NULL
    WHERE bs.organization_id = p_organization_id
      AND bs.building_id = ANY(p_building_ids)
  ),
  share_raw AS (
    SELECT
      ws.building_id,
      sc.shareholder_id,
      sc.shareholder_name,
      sc.percent,
      ws.distributable_profit,
      sum(sc.percent) OVER (PARTITION BY ws.building_id) AS total_percent,
      (ws.distributable_profit * sc.percent / 100)::numeric AS raw_amount,
      round(
        ws.distributable_profit
        * sum(sc.percent) OVER (PARTITION BY ws.building_id)
        / 100
      )::numeric AS target_total
    FROM with_salary ws
    JOIN share_config sc ON sc.building_id = ws.building_id
  ),
  share_based AS (
    SELECT
      sr.*,
      CASE
        WHEN sr.target_total >= 0 THEN floor(sr.raw_amount)
        ELSE ceil(sr.raw_amount)
      END::numeric AS base_part
    FROM share_raw sr
  ),
  share_ranked AS (
    SELECT
      sb.*,
      (
        sb.target_total
        - sum(sb.base_part) OVER (PARTITION BY sb.building_id)
      )::numeric AS delta,
      row_number() OVER (
        PARTITION BY sb.building_id
        ORDER BY
          CASE
            WHEN sb.target_total >= 0 THEN sb.raw_amount - floor(sb.raw_amount)
            ELSE ceil(sb.raw_amount) - sb.raw_amount
          END DESC,
          sb.shareholder_id
      ) AS allocation_rank
    FROM share_based sb
  ),
  shareholder_allocations AS MATERIALIZED (
    SELECT
      building_id,
      shareholder_id,
      shareholder_name,
      percent,
      (
        base_part
        + CASE
            WHEN delta > 0 AND allocation_rank <= delta THEN 1
            WHEN delta < 0 AND allocation_rank <= abs(delta) THEN -1
            ELSE 0
          END
      )::numeric AS amount
    FROM share_ranked
  ),
  shareholder_json AS (
    SELECT
      building_id,
      jsonb_agg(
        jsonb_build_object(
          'shareholder_id', shareholder_id,
          'shareholder_name', shareholder_name,
          'percent', percent,
          'amount', amount
        ) ORDER BY shareholder_id
      ) AS allocations,
      sum(percent)::numeric AS total_percent,
      sum(amount)::numeric AS allocated_amount
    FROM shareholder_allocations
    GROUP BY building_id
  ),
  manager_json AS (
    SELECT
      ma.building_id,
      jsonb_agg(
        jsonb_build_object(
          'manager_id', ma.manager_id,
          'manager_name', m.name,
          'amount', ma.amount
        ) ORDER BY ma.manager_id
      ) AS allocations
    FROM manager_allocations ma
    JOIN public.profit_managers m ON m.id = ma.manager_id
    GROUP BY ma.building_id
  ),
  pnl_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', building_id,
        'building_name', building_name,
        'revenue', source_revenue,
        'expense', source_expense,
        'net', computed_profit
      ) ORDER BY building_id
    ), '[]'::jsonb) AS value
    FROM base
  ),
  line_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'month', month,
        'voucher_id', voucher_id,
        'building_id', building_id,
        'building_name', building_name,
        'side', side,
        'type_id', type_id,
        'type_name', type_name,
        'category', category,
        'amount', amount
      ) ORDER BY building_id, voucher_id, side, type_id NULLS FIRST, amount
    ), '[]'::jsonb) AS value
    FROM source_lines
  ),
  share_config_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', building_id,
        'shareholder_id', shareholder_id,
        'shareholder_name', shareholder_name,
        'percent', percent
      ) ORDER BY building_id, shareholder_id
    ), '[]'::jsonb) AS value
    FROM share_config
  ),
  manager_rules_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'rule_id', s.id,
        'manager_id', s.manager_id,
        'manager_name', m.name,
        'label', s.label,
        'form', s.form,
        'basis', s.basis,
        'amount', s.amount,
        'percent', s.percent,
        'building_ids', COALESCE((
          SELECT jsonb_agg(rb.building_id ORDER BY rb.building_id)
          FROM public.profit_manager_salary_buildings rb
          WHERE rb.salary_id = s.id
            AND rb.organization_id = p_organization_id
            AND rb.building_id = ANY(p_building_ids)
        ), '[]'::jsonb)
      ) ORDER BY s.id
    ), '[]'::jsonb) AS value
    FROM public.profit_manager_salaries s
    JOIN public.profit_managers m
      ON m.id = s.manager_id
     AND m.organization_id = p_organization_id
     AND m.is_active
     AND m.deleted_at IS NULL
    WHERE s.organization_id = p_organization_id
      AND s.is_active
      AND EXISTS (
        SELECT 1
        FROM public.profit_manager_salary_buildings rb
        WHERE rb.salary_id = s.id
          AND rb.organization_id = p_organization_id
          AND rb.building_id = ANY(p_building_ids)
      )
  ),
  source_document AS MATERIALIZED (
    SELECT jsonb_build_object(
      'algorithm_version', 'profit-close-v2.1',
      'organization_id', p_organization_id,
      'period_month', p_period_month,
      'pnl', p.value,
      'accrual_lines', l.value,
      'shareholder_config', sc.value,
      'manager_salary_rules', mr.value
    ) AS value
    FROM pnl_document p
    CROSS JOIN line_document l
    CROSS JOIN share_config_document sc
    CROSS JOIN manager_rules_document mr
  ),
  source_meta AS (
    SELECT value, md5(value::text) AS source_hash
    FROM source_document
  ),
  building_rows AS MATERIALIZED (
    SELECT
      ws.building_id,
      ws.building_name,
      ws.owner_user_id,
      bh.building_source_hash,
      ws.source_revenue,
      ws.source_expense,
      ws.computed_profit,
      ws.adjustment_amount,
      ws.adjustment_reason,
      ws.adjusted_profit,
      ws.management_salary,
      ws.distributable_profit,
      COALESCE(sj.total_percent, 0)::numeric AS shareholder_percent_total,
      COALESCE(sj.allocated_amount, 0)::numeric AS shareholder_allocated_amount,
      (ws.distributable_profit - COALESCE(sj.allocated_amount, 0))::numeric
        AS unallocated_profit,
      COALESCE(sj.allocations, '[]'::jsonb) AS shareholder_allocations,
      COALESCE(mj.allocations, '[]'::jsonb) AS manager_allocations,
      pm.status AS current_status,
      pm.revision_number AS current_revision_number,
      pm.source_hash AS current_source_hash,
      (pm.id IS NOT NULL AND pm.source_hash IS DISTINCT FROM bh.building_source_hash)
        AS current_hash_mismatch,
      (
        COALESCE(pm.is_stale, false)
        OR (pm.id IS NOT NULL AND pm.source_hash IS DISTINCT FROM bh.building_source_hash)
      ) AS current_is_stale,
      CASE
        WHEN pm.id IS NOT NULL AND pm.source_hash IS DISTINCT FROM bh.building_source_hash
          THEN 'SOURCE_HASH_MISMATCH'
        ELSE pm.stale_reason
      END AS current_stale_reason,
      CASE WHEN pm.id IS NOT NULL THEN to_jsonb(pm) END AS current_snapshot
    FROM with_salary ws
    LEFT JOIN shareholder_json sj ON sj.building_id = ws.building_id
    LEFT JOIN manager_json mj ON mj.building_id = ws.building_id
    CROSS JOIN source_meta sm
    CROSS JOIN LATERAL (
      SELECT md5(jsonb_build_object(
        'algorithm_version', 'profit-close-v2.1',
        'organization_id', p_organization_id,
        'period_month', p_period_month,
        'building_id', ws.building_id,
        -- TOTAL_GROUP salary rules depend on every building in the close set;
        -- include the complete source-base vector, not only this row.
        'source_building_bases', sm.value->'pnl',
        'pnl', jsonb_build_object(
          'revenue', ws.source_revenue,
          'expense', ws.source_expense,
          'net', ws.computed_profit
        ),
        'accrual_lines', COALESCE((
          SELECT jsonb_agg(
            x.value ORDER BY
              x.value->>'voucher_id', x.value->>'side',
              x.value->>'type_id', x.value->>'amount'
          )
          FROM jsonb_array_elements(sm.value->'accrual_lines') x(value)
          WHERE x.value->>'building_id' = ws.building_id::text
        ), '[]'::jsonb),
        'shareholder_config', COALESCE((
          SELECT jsonb_agg(x.value ORDER BY x.value->>'shareholder_id')
          FROM jsonb_array_elements(sm.value->'shareholder_config') x(value)
          WHERE x.value->>'building_id' = ws.building_id::text
        ), '[]'::jsonb),
        'manager_salary_rules', COALESCE((
          SELECT jsonb_agg(x.value ORDER BY x.value->>'rule_id')
          FROM jsonb_array_elements(sm.value->'manager_salary_rules') x(value)
          WHERE x.value->'building_ids' @> to_jsonb(ARRAY[ws.building_id])
        ), '[]'::jsonb)
      )::text) AS building_source_hash
    ) bh
    LEFT JOIN public.profit_monthly pm
      ON pm.organization_id = p_organization_id
     AND pm.building_id = ws.building_id
     AND pm.period_month = p_period_month
  ),
  rows_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', building_id,
        'building_name', building_name,
        'building_source_hash', building_source_hash,
        'source_revenue', source_revenue,
        'source_expense', source_expense,
        'computed_profit', computed_profit,
        'adjustment_amount', adjustment_amount,
        'adjustment_reason', adjustment_reason,
        'adjusted_profit', adjusted_profit,
        'management_salary', management_salary,
        'distributable_profit', distributable_profit,
        'shareholder_percent_total', shareholder_percent_total,
        'shareholder_allocated_amount', shareholder_allocated_amount,
        'unallocated_profit', unallocated_profit,
        'shareholder_allocations', shareholder_allocations,
        'manager_allocations', manager_allocations,
        'current_status', current_status,
        'current_revision_number', current_revision_number,
        'current_source_hash', current_source_hash,
        'current_hash_mismatch', current_hash_mismatch,
        'current_is_stale', current_is_stale,
        'current_stale_reason', current_stale_reason,
        'current_snapshot', current_snapshot
      ) ORDER BY building_id
    ), '[]'::jsonb) AS value
    FROM building_rows
  ),
  totals_document AS (
    SELECT jsonb_build_object(
      'source_revenue', COALESCE(sum(source_revenue), 0),
      'source_expense', COALESCE(sum(source_expense), 0),
      'computed_profit', COALESCE(sum(computed_profit), 0),
      'adjustment_amount', COALESCE(sum(adjustment_amount), 0),
      'adjusted_profit', COALESCE(sum(adjusted_profit), 0),
      'management_salary', COALESCE(sum(management_salary), 0),
      'distributable_profit', COALESCE(sum(distributable_profit), 0),
      'shareholder_allocated_amount', COALESCE(sum(shareholder_allocated_amount), 0),
      'unallocated_profit', COALESCE(sum(unallocated_profit), 0)
    ) AS value
    FROM building_rows
  ),
  consistency AS (
    SELECT NOT EXISTS (
      SELECT 1
      FROM base b
      LEFT JOIN line_totals lt ON lt.building_id = b.building_id
      WHERE b.source_revenue <> COALESCE(lt.revenue, 0)
         OR b.source_expense <> COALESCE(lt.expense, 0)
         OR b.computed_profit <> COALESCE(lt.net, 0)
    ) AS ok
  )
  SELECT
    jsonb_build_object(
      'algorithm_version', 'profit-close-v2.1',
      'organization_id', p_organization_id,
      'period_month', p_period_month,
      'source_hash', sm.source_hash,
      'source_captured_at', v_captured_at,
      'source_snapshot', sm.value,
      'buildings', rd.value,
      'totals', td.value
    ),
    c.ok
  INTO v_result, v_source_consistent
  FROM source_meta sm
  CROSS JOIN rows_document rd
  CROSS JOIN totals_document td
  CROSS JOIN consistency c;

  IF NOT COALESCE(v_source_consistent, false) THEN
    RAISE EXCEPTION
      'Canonical fa_monthly_pnl_accrual and fa_accrual_allocations totals disagree'
      USING ERRCODE = '55000';
  END IF;

  RETURN v_result;
END
$fn$;

REVOKE ALL ON FUNCTION public._profit_close_preview_core_v2(
  uuid,date,uuid[],jsonb,text,boolean
) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public._profit_close_preview_core_v2(
  uuid,date,uuid[],jsonb,text,boolean
) IS 'Profit Close V2 canonical preview core. Inactive/soft-deleted same-org shareholder mappings are ignored; missing/cross-org links fail closed.';

COMMIT;

NOTIFY pgrst, 'reload schema';
