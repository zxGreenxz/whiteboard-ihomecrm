-- Profit close V3 integrity: persist and require an explicit decision for every
-- material unallocated balance without rewriting historical allocations.

BEGIN;

ALTER TABLE public.profit_monthly
  ADD COLUMN IF NOT EXISTS shareholder_percent_total numeric(9,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS shareholder_allocated_amount numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unallocated_profit numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS unallocated_disposition text,
  ADD COLUMN IF NOT EXISTS unallocated_disposition_reason text;

ALTER TABLE public.profit_monthly
  DROP CONSTRAINT IF EXISTS profit_monthly_unallocated_disposition_v3;
ALTER TABLE public.profit_monthly
  ADD CONSTRAINT profit_monthly_unallocated_disposition_v3 CHECK (
    unallocated_disposition IS NULL
    OR unallocated_disposition IN (
      'RETAINED_EARNINGS',
      'CARRY_FORWARD',
      'LEGACY_RETAINED_UNALLOCATED'
    )
  );

ALTER TABLE public.profit_monthly
  DROP CONSTRAINT IF EXISTS profit_monthly_unallocated_reason_v3;
ALTER TABLE public.profit_monthly
  ADD CONSTRAINT profit_monthly_unallocated_reason_v3 CHECK (
    unallocated_disposition IS NULL
    OR (
      unallocated_disposition_reason IS NOT NULL
      AND char_length(btrim(unallocated_disposition_reason)) BETWEEN 8 AND 500
    )
  );

ALTER TABLE public.profit_monthly
  DROP CONSTRAINT IF EXISTS profit_monthly_allocation_amounts_v3;
ALTER TABLE public.profit_monthly
  ADD CONSTRAINT profit_monthly_allocation_amounts_v3 CHECK (
    shareholder_percent_total <> 'NaN'::numeric
    AND shareholder_percent_total BETWEEN 0 AND 100
    AND shareholder_allocated_amount <> 'NaN'::numeric
    AND unallocated_profit <> 'NaN'::numeric
  );

WITH totals AS (
  SELECT
    pm.id AS profit_monthly_id,
    COALESCE(sum(pa.percent), 0)::numeric AS percent_total,
    COALESCE(sum(pa.amount), 0)::numeric AS allocated_amount
  FROM public.profit_monthly pm
  LEFT JOIN public.profit_allocations pa ON pa.profit_monthly_id = pm.id
  GROUP BY pm.id
)
UPDATE public.profit_monthly pm
SET shareholder_percent_total = totals.percent_total,
    shareholder_allocated_amount = totals.allocated_amount,
    unallocated_profit = pm.adjusted_profit - pm.management_salary - totals.allocated_amount,
    unallocated_disposition = CASE
      WHEN abs(pm.adjusted_profit - pm.management_salary - totals.allocated_amount) < 0.01
        THEN NULL
      ELSE 'LEGACY_RETAINED_UNALLOCATED'
    END,
    unallocated_disposition_reason = CASE
      WHEN abs(pm.adjusted_profit - pm.management_salary - totals.allocated_amount) < 0.01
        THEN NULL
      ELSE 'Legacy close retained the undistributed balance without an explicit decision'
    END
FROM totals
WHERE totals.profit_monthly_id = pm.id;

COMMENT ON COLUMN public.profit_monthly.unallocated_profit IS
  'distributable_profit - shareholder_allocated_amount. Never silently discarded.';
COMMENT ON COLUMN public.profit_monthly.unallocated_disposition IS
  'RETAINED_EARNINGS or CARRY_FORWARD for V3 closes; LEGACY_RETAINED_UNALLOCATED marks pre-V3 snapshots.';

CREATE TABLE IF NOT EXISTS public.profit_unallocated_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid REFERENCES public.profit_close_runs(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  profit_monthly_id uuid NOT NULL,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  period_month date NOT NULL,
  unallocated_profit numeric(15,2) NOT NULL,
  disposition text NOT NULL,
  reason text NOT NULL,
  decision_source text NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profit_unallocated_decisions_disposition_check CHECK (
    disposition IN (
      'RETAINED_EARNINGS',
      'CARRY_FORWARD',
      'LEGACY_RETAINED_UNALLOCATED'
    )
  ),
  CONSTRAINT profit_unallocated_decisions_source_check CHECK (
    decision_source IN ('CLOSE_V3', 'RECLOSE_V3', 'LEGACY_BACKFILL')
  ),
  CONSTRAINT profit_unallocated_decisions_reason_check CHECK (
    char_length(btrim(reason)) BETWEEN 8 AND 500
  ),
  CONSTRAINT profit_unallocated_decisions_amount_check CHECK (
    unallocated_profit <> 'NaN'::numeric
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS profit_unallocated_decisions_run_pm_uq
  ON public.profit_unallocated_decisions(run_id, profit_monthly_id)
  WHERE run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS profit_unallocated_decisions_legacy_pm_uq
  ON public.profit_unallocated_decisions(profit_monthly_id)
  WHERE decision_source = 'LEGACY_BACKFILL';
CREATE INDEX IF NOT EXISTS profit_unallocated_decisions_org_period_idx
  ON public.profit_unallocated_decisions(organization_id, period_month, building_id);

INSERT INTO public.profit_unallocated_decisions (
  run_id, organization_id, profit_monthly_id, building_id, period_month,
  unallocated_profit, disposition, reason, decision_source, actor_id
)
SELECT
  NULL, pm.organization_id, pm.id, pm.building_id, pm.period_month,
  pm.unallocated_profit, pm.unallocated_disposition,
  pm.unallocated_disposition_reason, 'LEGACY_BACKFILL', pm.locked_by
FROM public.profit_monthly pm
WHERE abs(pm.unallocated_profit) >= 0.01
ON CONFLICT (profit_monthly_id) WHERE decision_source = 'LEGACY_BACKFILL'
DO NOTHING;

DROP TRIGGER IF EXISTS profit_unallocated_decisions_append_only_v3
  ON public.profit_unallocated_decisions;
CREATE TRIGGER profit_unallocated_decisions_append_only_v3
BEFORE UPDATE OR DELETE ON public.profit_unallocated_decisions
FOR EACH ROW EXECUTE FUNCTION public._profit_close_audit_append_only_v2();

ALTER TABLE public.profit_unallocated_decisions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS profit_unallocated_decisions_read_v3
  ON public.profit_unallocated_decisions;
CREATE POLICY profit_unallocated_decisions_read_v3
ON public.profit_unallocated_decisions FOR SELECT TO authenticated
USING (public._profit_can_read_audit_v2(organization_id));
REVOKE ALL ON public.profit_unallocated_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.profit_unallocated_decisions TO authenticated;

CREATE OR REPLACE FUNCTION public._profit_enrich_unallocated_v3(
  p_document jsonb,
  p_adjustments jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_building_id uuid;
  v_disposition text;
  v_reason text;
BEGIN
  FOR v_row IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_document->'buildings', '[]'::jsonb)) x(value)
  LOOP
    v_building_id := (v_row->>'building_id')::uuid;

    SELECT
      NULLIF(btrim(a.unallocated_disposition), ''),
      NULLIF(btrim(a.unallocated_disposition_reason), '')
    INTO v_disposition, v_reason
    FROM jsonb_to_recordset(COALESCE(p_adjustments, '[]'::jsonb)) AS a(
      building_id uuid,
      unallocated_disposition text,
      unallocated_disposition_reason text
    )
    WHERE a.building_id = v_building_id
    LIMIT 1;

    v_disposition := COALESCE(
      v_disposition,
      v_row->'current_snapshot'->>'unallocated_disposition'
    );
    v_reason := COALESCE(
      v_reason,
      v_row->'current_snapshot'->>'unallocated_disposition_reason'
    );

    v_rows := v_rows || jsonb_build_array(
      v_row || jsonb_build_object(
        'unallocated_disposition', v_disposition,
        'unallocated_disposition_reason', v_reason
      )
    );
  END LOOP;

  RETURN jsonb_set(COALESCE(p_document, '{}'::jsonb), '{buildings}', v_rows, true);
END
$fn$;

CREATE OR REPLACE FUNCTION public._profit_enrich_state_v3(p_document jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_row jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_pm public.profit_monthly%ROWTYPE;
BEGIN
  FOR v_row IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(p_document->'rows', '[]'::jsonb)) x(value)
  LOOP
    SELECT * INTO v_pm
    FROM public.profit_monthly pm
    WHERE pm.id = (v_row->>'id')::uuid;

    v_rows := v_rows || jsonb_build_array(
      v_row || jsonb_build_object(
        'shareholder_percent_total', v_pm.shareholder_percent_total,
        'shareholder_allocated_amount', v_pm.shareholder_allocated_amount,
        'unallocated_profit', v_pm.unallocated_profit,
        'unallocated_disposition', v_pm.unallocated_disposition,
        'unallocated_disposition_reason', v_pm.unallocated_disposition_reason
      )
    );
  END LOOP;

  RETURN jsonb_set(COALESCE(p_document, '{}'::jsonb), '{rows}', v_rows, true);
END
$fn$;

-- Preserve the audited V2 writer and place the V3 decision gate around it.
DO $do$
BEGIN
  IF to_regprocedure(
    'public._profit_write_close_v2_base(text,uuid,date,text,text,text,uuid[],jsonb)'
  ) IS NULL THEN
    ALTER FUNCTION public._profit_write_close_v2(
      text, uuid, date, text, text, text, uuid[], jsonb
    ) RENAME TO _profit_write_close_v2_base;
  END IF;
END
$do$;

CREATE OR REPLACE FUNCTION public._profit_write_close_v2(
  p_operation text,
  p_organization_id uuid,
  p_period_month date,
  p_expected_source_hash text,
  p_reason text,
  p_idempotency_key text,
  p_building_ids uuid[],
  p_adjustments jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_result jsonb;
  v_row jsonb;
  v_building_id uuid;
  v_unallocated numeric;
  v_percent numeric;
  v_allocated numeric;
  v_disposition text;
  v_disposition_reason text;
  v_pm_id uuid;
  v_run_id uuid;
BEGIN
  v_result := public._profit_write_close_v2_base(
    p_operation, p_organization_id, p_period_month, p_expected_source_hash,
    p_reason, p_idempotency_key, p_building_ids, p_adjustments
  );
  v_run_id := NULLIF(v_result->>'run_id', '')::uuid;

  FOR v_row IN
    SELECT value
    FROM jsonb_array_elements(COALESCE(v_result->'buildings', '[]'::jsonb)) x(value)
  LOOP
    v_building_id := (v_row->>'building_id')::uuid;
    v_unallocated := COALESCE((v_row->>'unallocated_profit')::numeric, 0);
    v_percent := COALESCE((v_row->>'shareholder_percent_total')::numeric, 0);
    v_allocated := COALESCE((v_row->>'shareholder_allocated_amount')::numeric, 0);

    IF v_unallocated = 'NaN'::numeric
       OR v_percent = 'NaN'::numeric
       OR v_allocated = 'NaN'::numeric
       OR v_percent < 0 OR v_percent > 100 THEN
      RAISE EXCEPTION 'Profit close returned invalid allocation numbers'
        USING ERRCODE = '55000';
    END IF;

    SELECT
      NULLIF(btrim(a.unallocated_disposition), ''),
      NULLIF(btrim(a.unallocated_disposition_reason), '')
    INTO v_disposition, v_disposition_reason
    FROM jsonb_to_recordset(COALESCE(p_adjustments, '[]'::jsonb)) AS a(
      building_id uuid,
      unallocated_disposition text,
      unallocated_disposition_reason text
    )
    WHERE a.building_id = v_building_id
    LIMIT 1;

    IF abs(v_unallocated) >= 0.01 THEN
      IF v_disposition NOT IN ('RETAINED_EARNINGS', 'CARRY_FORWARD') THEN
        RAISE EXCEPTION
          'Building % has unallocated profit %; choose RETAINED_EARNINGS or CARRY_FORWARD',
          v_building_id, v_unallocated
          USING ERRCODE = '22023';
      END IF;
      IF char_length(COALESCE(v_disposition_reason, '')) NOT BETWEEN 8 AND 500 THEN
        RAISE EXCEPTION 'Unallocated disposition reason must contain 8..500 characters'
          USING ERRCODE = '22023';
      END IF;
    ELSE
      v_disposition := NULL;
      v_disposition_reason := NULL;
    END IF;

    UPDATE public.profit_monthly pm
       SET shareholder_percent_total = v_percent,
           shareholder_allocated_amount = v_allocated,
           unallocated_profit = v_unallocated,
           unallocated_disposition = v_disposition,
           unallocated_disposition_reason = v_disposition_reason
     WHERE pm.organization_id = p_organization_id
       AND pm.building_id = v_building_id
       AND pm.period_month = p_period_month
    RETURNING pm.id INTO v_pm_id;

    IF v_pm_id IS NULL THEN
      RAISE EXCEPTION 'Profit close did not persist building %', v_building_id
        USING ERRCODE = '55000';
    END IF;

    IF abs(v_unallocated) >= 0.01 THEN
      INSERT INTO public.profit_unallocated_decisions (
        run_id, organization_id, profit_monthly_id, building_id, period_month,
        unallocated_profit, disposition, reason, decision_source, actor_id
      ) VALUES (
        v_run_id, p_organization_id, v_pm_id, v_building_id, p_period_month,
        v_unallocated, v_disposition, v_disposition_reason,
        CASE WHEN p_operation = 'RECLOSE' THEN 'RECLOSE_V3' ELSE 'CLOSE_V3' END,
        v_actor
      )
      ON CONFLICT (run_id, profit_monthly_id) WHERE run_id IS NOT NULL
      DO NOTHING;
    END IF;
  END LOOP;

  RETURN public._profit_enrich_unallocated_v3(v_result, p_adjustments);
END
$fn$;

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
  v_preview jsonb;
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

  v_preview := public._profit_close_preview_core_v2(
    p_organization_id, p_period_month, v_building_ids,
    p_adjustments, v_permission, false
  );
  RETURN public._profit_enrich_unallocated_v3(v_preview, p_adjustments);
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

  v_state := public._profit_current_state_v2(p_organization_id, p_period_month);
  RETURN public._profit_enrich_state_v3(
    (v_state - 'before' - 'building_ids') || jsonb_build_object(
      'can_lock', v_can_lock,
      'can_unlock', v_can_unlock
    )
  );
END
$fn$;

CREATE OR REPLACE FUNCTION public.profit_close_v2(
  p_organization_id uuid,
  p_period_month date,
  p_expected_source_hash text,
  p_reason text,
  p_idempotency_key text,
  p_building_ids uuid[] DEFAULT NULL,
  p_adjustments jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
  SELECT public._profit_write_close_v2(
    'CLOSE', p_organization_id, p_period_month, p_expected_source_hash,
    p_reason, p_idempotency_key, p_building_ids, p_adjustments
  );
$fn$;

CREATE OR REPLACE FUNCTION public.profit_reclose_v2(
  p_organization_id uuid,
  p_period_month date,
  p_expected_source_hash text,
  p_reason text,
  p_idempotency_key text,
  p_building_ids uuid[] DEFAULT NULL,
  p_adjustments jsonb DEFAULT '[]'::jsonb
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
  SELECT public._profit_write_close_v2(
    'RECLOSE', p_organization_id, p_period_month, p_expected_source_hash,
    p_reason, p_idempotency_key, p_building_ids, p_adjustments
  );
$fn$;

REVOKE ALL ON FUNCTION public._profit_enrich_unallocated_v3(jsonb,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._profit_enrich_state_v3(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._profit_write_close_v2_base(
  text,uuid,date,text,text,text,uuid[],jsonb
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._profit_write_close_v2(
  text,uuid,date,text,text,text,uuid[],jsonb
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.profit_close_preview_v2(uuid,date,uuid[],jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profit_close_state_v2(uuid,date)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profit_close_v2(uuid,date,text,text,text,uuid[],jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profit_reclose_v2(uuid,date,text,text,text,uuid[],jsonb)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.profit_close_preview_v2(uuid,date,uuid[],jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_close_state_v2(uuid,date)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_close_v2(uuid,date,text,text,text,uuid[],jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_reclose_v2(uuid,date,text,text,text,uuid[],jsonb)
  TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
