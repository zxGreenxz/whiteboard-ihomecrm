-- =============================================================================
-- Profit close V2: server-authoritative, auditable monthly profit snapshots.
--
-- Public RPC contract (all periods must be the first day of a month):
--   profit_close_preview_v2(org, period, building_ids?, adjustments?) -> jsonb
--   profit_close_v2(org, period, expected_hash, reason, idempotency, ids?, adj?)
--   profit_reclose_v2(org, period, expected_hash, reason, idempotency, ids?, adj?)
--   profit_reset_v2(org, period, reason, idempotency, ids?, expected_hash?)
--   profit_unlock_v2(org, period, reason, idempotency, ids?, expected_hash?)
--
-- adjustments is an array of:
--   {"building_id":"uuid","adjustment_amount":123,"adjustment_reason":"..."}
-- Omitted buildings have a zero adjustment. Client-computed P&L, salaries, share
-- percentages and allocation amounts are never accepted by these RPCs.
-- =============================================================================

BEGIN;

-- Normalize the legacy period before installing the invariant. Abort rather
-- than merge if malformed legacy dates would collapse onto the same month.
DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.profit_monthly
    GROUP BY building_id, date_trunc('month', period_month)::date
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'profit_monthly contains duplicate building/month rows after normalization';
  END IF;
END
$do$;

UPDATE public.profit_monthly
SET period_month = date_trunc('month', period_month)::date
WHERE period_month <> date_trunc('month', period_month)::date;

-- Explicit adjustments and canonical-source metadata. Legacy rows are marked
-- stale because their historical accrual source detail cannot be reconstructed
-- safely during a schema migration.
ALTER TABLE public.profit_monthly
  ADD COLUMN IF NOT EXISTS adjustment_amount numeric(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS adjustment_reason text,
  ADD COLUMN IF NOT EXISTS adjustment_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS adjustment_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_revenue numeric(15,2),
  ADD COLUMN IF NOT EXISTS source_expense numeric(15,2),
  ADD COLUMN IF NOT EXISTS source_net_profit numeric(15,2),
  ADD COLUMN IF NOT EXISTS source_hash text,
  ADD COLUMN IF NOT EXISTS source_captured_at timestamptz,
  ADD COLUMN IF NOT EXISTS is_stale boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS stale_reason text,
  ADD COLUMN IF NOT EXISTS revision_number bigint NOT NULL DEFAULT 1;

UPDATE public.profit_monthly pm
SET organization_id = b.organization_id
FROM public.buildings b
WHERE b.id = pm.building_id
  AND pm.organization_id IS DISTINCT FROM b.organization_id;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profit_monthly
    WHERE organization_id IS NULL
  ) THEN
    RAISE EXCEPTION 'profit_monthly contains rows without organization_id';
  END IF;
END
$do$;

UPDATE public.profit_monthly
SET adjustment_amount = adjusted_profit - computed_profit,
    adjustment_reason = CASE
      WHEN adjusted_profit <> computed_profit
      THEN COALESCE(NULLIF(btrim(adjustment_reason), ''),
                    'Legacy adjustment; original reason unavailable')
      ELSE NULL
    END,
    adjustment_by = CASE
      WHEN adjusted_profit <> computed_profit THEN COALESCE(adjustment_by, locked_by)
      ELSE NULL
    END,
    adjustment_at = CASE
      WHEN adjusted_profit <> computed_profit
      THEN COALESCE(adjustment_at, locked_at, updated_at, created_at)
      ELSE NULL
    END,
    source_net_profit = COALESCE(source_net_profit, computed_profit),
    source_hash = COALESCE(
      source_hash,
      md5(jsonb_build_object(
        'legacy_profit_monthly_id', id,
        'building_id', building_id,
        'period_month', period_month,
        'computed_profit', computed_profit,
        'adjusted_profit', adjusted_profit,
        'management_salary', management_salary,
        'status', status
      )::text)
    ),
    source_captured_at = COALESCE(source_captured_at, locked_at, updated_at, created_at),
    is_stale = true,
    stale_reason = COALESCE(
      NULLIF(btrim(stale_reason), ''),
      'LEGACY_BASELINE: canonical accrual source totals unavailable'
    ),
    revision_number = GREATEST(COALESCE(revision_number, 1), 1);

ALTER TABLE public.profit_monthly
  ALTER COLUMN organization_id SET NOT NULL,
  ALTER COLUMN source_hash SET NOT NULL,
  ALTER COLUMN source_captured_at SET NOT NULL,
  ALTER COLUMN revision_number SET DEFAULT 1,
  ALTER COLUMN revision_number SET NOT NULL;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profit_monthly_period_first_day_v2') THEN
    ALTER TABLE public.profit_monthly
      ADD CONSTRAINT profit_monthly_period_first_day_v2
      CHECK (period_month = date_trunc('month', period_month)::date);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profit_monthly_adjustment_equation_v2') THEN
    ALTER TABLE public.profit_monthly
      ADD CONSTRAINT profit_monthly_adjustment_equation_v2
      CHECK (adjusted_profit = computed_profit + adjustment_amount);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profit_monthly_adjustment_reason_v2') THEN
    ALTER TABLE public.profit_monthly
      ADD CONSTRAINT profit_monthly_adjustment_reason_v2
      CHECK (
        adjustment_amount = 0
        OR (
          adjustment_reason IS NOT NULL
          AND char_length(btrim(adjustment_reason)) BETWEEN 8 AND 500
          AND (is_stale OR (adjustment_by IS NOT NULL AND adjustment_at IS NOT NULL))
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profit_monthly_source_totals_v2') THEN
    ALTER TABLE public.profit_monthly
      ADD CONSTRAINT profit_monthly_source_totals_v2
      CHECK (
        source_revenue IS NULL OR source_expense IS NULL OR source_net_profit IS NULL
        OR source_net_profit = source_revenue - source_expense
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profit_monthly_source_hash_v2') THEN
    ALTER TABLE public.profit_monthly
      ADD CONSTRAINT profit_monthly_source_hash_v2
      CHECK (source_hash ~ '^[0-9a-f]{32}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profit_monthly_revision_positive_v2') THEN
    ALTER TABLE public.profit_monthly
      ADD CONSTRAINT profit_monthly_revision_positive_v2
      CHECK (revision_number >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profit_monthly_locked_source_v2') THEN
    ALTER TABLE public.profit_monthly
      ADD CONSTRAINT profit_monthly_locked_source_v2
      CHECK (
        status <> 'LOCKED' OR is_stale
        OR (source_revenue IS NOT NULL AND source_expense IS NOT NULL AND source_net_profit IS NOT NULL)
      );
  END IF;
END
$do$;

COMMENT ON COLUMN public.profit_monthly.adjustment_amount IS
  'Explicit close adjustment. adjusted_profit = computed_profit + adjustment_amount.';
COMMENT ON COLUMN public.profit_monthly.source_hash IS
  'MD5 of the canonical accrual/config snapshot used by Profit Close V2.';
COMMENT ON COLUMN public.profit_monthly.is_stale IS
  'Persisted stale marker for legacy/unlocked rows. Preview additionally derives SOURCE_HASH_MISMATCH from the current canonical per-building hash.';

CREATE TABLE IF NOT EXISTS public.profit_close_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  period_month date NOT NULL,
  operation text NOT NULL CHECK (operation IN ('BASELINE','CLOSE','RECLOSE','RESET','UNLOCK')),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  request_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_hash text NOT NULL,
  expected_source_hash text,
  source_hash text,
  source_captured_at timestamptz,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  allocation_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  result_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profit_close_runs_period_first_day_v2
    CHECK (period_month = date_trunc('month', period_month)::date),
  CONSTRAINT profit_close_runs_request_hash_v2
    CHECK (request_hash ~ '^[0-9a-f]{32}$'),
  CONSTRAINT profit_close_runs_source_hash_v2
    CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{32}$'),
  CONSTRAINT profit_close_runs_idempotency_v2
    UNIQUE (organization_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS profit_close_runs_org_period_idx
  ON public.profit_close_runs (organization_id, period_month, created_at DESC);

CREATE TABLE IF NOT EXISTS public.profit_close_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.profit_close_runs(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  profit_monthly_id uuid NOT NULL,
  building_id uuid NOT NULL REFERENCES public.buildings(id) ON DELETE RESTRICT,
  period_month date NOT NULL,
  revision_number bigint NOT NULL CHECK (revision_number >= 1),
  operation text NOT NULL CHECK (operation IN ('BASELINE','CLOSE','RECLOSE','RESET','UNLOCK')),
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  source_hash text,
  source_captured_at timestamptz,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  shareholder_allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  manager_allocations jsonb NOT NULL DEFAULT '[]'::jsonb,
  previous_snapshot jsonb,
  current_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profit_close_revisions_period_first_day_v2
    CHECK (period_month = date_trunc('month', period_month)::date),
  CONSTRAINT profit_close_revisions_source_hash_v2
    CHECK (source_hash IS NULL OR source_hash ~ '^[0-9a-f]{32}$'),
  CONSTRAINT profit_close_revisions_number_v2
    UNIQUE (organization_id, building_id, period_month, revision_number)
);

CREATE INDEX IF NOT EXISTS profit_close_revisions_run_idx
  ON public.profit_close_revisions (run_id);
CREATE INDEX IF NOT EXISTS profit_close_revisions_pm_idx
  ON public.profit_close_revisions (profit_monthly_id, created_at DESC);

COMMENT ON TABLE public.profit_close_runs IS
  'Append-only audit of Profit Close V2 write operations and canonical source snapshots.';
COMMENT ON TABLE public.profit_close_revisions IS
  'Append-only per-building revisions. profit_monthly_id is intentionally not an FK so RESET can delete current snapshots without deleting history.';

-- Keep legacy child rows org-consistent before taking the immutable baseline.
UPDATE public.profit_allocations pa
SET organization_id = pm.organization_id
FROM public.profit_monthly pm
WHERE pm.id = pa.profit_monthly_id
  AND pa.organization_id IS DISTINCT FROM pm.organization_id;

UPDATE public.profit_manager_allocations pma
SET organization_id = pm.organization_id
FROM public.profit_monthly pm
WHERE pm.id = pma.profit_monthly_id
  AND pma.organization_id IS DISTINCT FROM pm.organization_id;

-- One BASELINE run/revision per current row. This intentionally captures the
-- old computed/adjusted values and both allocation tables before any cleanup.
INSERT INTO public.profit_close_runs (
  id, organization_id, period_month, operation, actor_id, reason,
  idempotency_key, request_payload, request_hash, source_hash,
  source_captured_at, source_snapshot, allocation_snapshot, result_snapshot
)
SELECT
  gen_random_uuid(),
  pm.organization_id,
  pm.period_month,
  'BASELINE',
  pm.locked_by,
  'V2 migration baseline of the pre-existing profit snapshot',
  'baseline:' || pm.id::text,
  jsonb_build_object('profit_monthly_id', pm.id),
  md5(('baseline:' || pm.id::text)::text),
  pm.source_hash,
  pm.source_captured_at,
  jsonb_build_object(
    'kind', 'LEGACY_BASELINE',
    'canonical_source_available', false,
    'profit_monthly', to_jsonb(pm)
  ),
  jsonb_build_object(
    'shareholder_allocations', COALESCE((
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
    ), '[]'::jsonb),
    'manager_allocations', COALESCE((
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
    ), '[]'::jsonb)
  ),
  jsonb_build_object(
    'profit_monthly_id', pm.id,
    'building_id', pm.building_id,
    'revision_number', pm.revision_number,
    'status', pm.status
  )
FROM public.profit_monthly pm
WHERE NOT EXISTS (
  SELECT 1
  FROM public.profit_close_revisions r
  WHERE r.profit_monthly_id = pm.id
)
ON CONFLICT (organization_id, idempotency_key) DO NOTHING;

INSERT INTO public.profit_close_revisions (
  run_id, organization_id, profit_monthly_id, building_id, period_month,
  revision_number, operation, actor_id, reason, source_hash,
  source_captured_at, source_snapshot, shareholder_allocations,
  manager_allocations, previous_snapshot, current_snapshot
)
SELECT
  run.id,
  pm.organization_id,
  pm.id,
  pm.building_id,
  pm.period_month,
  pm.revision_number,
  'BASELINE',
  pm.locked_by,
  run.reason,
  pm.source_hash,
  pm.source_captured_at,
  run.source_snapshot,
  run.allocation_snapshot->'shareholder_allocations',
  run.allocation_snapshot->'manager_allocations',
  NULL,
  to_jsonb(pm)
FROM public.profit_monthly pm
JOIN public.profit_close_runs run
  ON run.organization_id = pm.organization_id
 AND run.idempotency_key = 'baseline:' || pm.id::text
WHERE NOT EXISTS (
  SELECT 1
  FROM public.profit_close_revisions r
  WHERE r.profit_monthly_id = pm.id
)
ON CONFLICT (organization_id, building_id, period_month, revision_number)
DO NOTHING;

CREATE OR REPLACE FUNCTION public._profit_close_audit_append_only_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$fn$;

DROP TRIGGER IF EXISTS profit_close_runs_append_only_v2 ON public.profit_close_runs;
CREATE TRIGGER profit_close_runs_append_only_v2
BEFORE UPDATE OR DELETE ON public.profit_close_runs
FOR EACH ROW EXECUTE FUNCTION public._profit_close_audit_append_only_v2();

DROP TRIGGER IF EXISTS profit_close_revisions_append_only_v2 ON public.profit_close_revisions;
CREATE TRIGGER profit_close_revisions_append_only_v2
BEFORE UPDATE OR DELETE ON public.profit_close_revisions
FOR EACH ROW EXECUTE FUNCTION public._profit_close_audit_append_only_v2();

ALTER TABLE public.profit_close_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_close_revisions ENABLE ROW LEVEL SECURITY;

-- RLS cannot call authorize_v2 directly because that primitive is deliberately
-- private. This narrow definer helper exposes only the audit-read decision.
CREATE OR REPLACE FUNCTION public._profit_can_read_audit_v2(
  p_organization_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
  SELECT auth.uid() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.organization_memberships m
      WHERE m.organization_id = p_organization_id
        AND m.user_id = auth.uid()
        AND m.status = 'ACTIVE'
        AND m.valid_from <= clock_timestamp()
        AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
    )
    AND (
      public.is_super_admin()
      OR public.authorize_v2(
        'shareholder_profit.lock', p_organization_id, 'ORGANIZATION', NULL
      )
    );
$fn$;

DROP POLICY IF EXISTS profit_close_runs_org_read_v2 ON public.profit_close_runs;
CREATE POLICY profit_close_runs_org_read_v2
ON public.profit_close_runs
FOR SELECT TO authenticated
USING (
  public._profit_can_read_audit_v2(organization_id)
);

DROP POLICY IF EXISTS profit_close_revisions_org_read_v2 ON public.profit_close_revisions;
CREATE POLICY profit_close_revisions_org_read_v2
ON public.profit_close_revisions
FOR SELECT TO authenticated
USING (
  public._profit_can_read_audit_v2(organization_id)
);

REVOKE ALL ON TABLE public.profit_close_runs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.profit_close_revisions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.profit_close_runs TO authenticated;
GRANT SELECT ON TABLE public.profit_close_revisions TO authenticated;

-- Current snapshots are now writable only through V2 definer RPCs.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profit_monthly
  FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profit_allocations
  FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.profit_manager_allocations
  FROM anon, authenticated;

-- Permission/membership assertion shared by all public V2 RPCs.
CREATE OR REPLACE FUNCTION public._profit_assert_authorized_v2(
  p_organization_id uuid,
  p_permission_key text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.organizations o
  WHERE o.id = p_organization_id
    AND o.status = 'ACTIVE'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization is missing or inactive' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.organization_memberships m
  WHERE m.organization_id = p_organization_id
    AND m.user_id = v_actor
    AND m.status = 'ACTIVE'
    AND m.valid_from <= clock_timestamp()
    AND (m.valid_to IS NULL OR m.valid_to > clock_timestamp())
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active organization membership required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_super_admin()
     AND NOT public.authorize_v2(
       p_permission_key, p_organization_id, 'ORGANIZATION', NULL
     ) THEN
    RAISE EXCEPTION 'Permission denied: %', p_permission_key
      USING ERRCODE = '42501';
  END IF;
END
$fn$;

-- Full server-side implementation of the existing management-salary rules.
-- TOTAL_GROUP uses largest remainder with building UUID as the deterministic
-- tie-breaker, so every rule conserves its rounded total exactly.
CREATE OR REPLACE FUNCTION public._profit_management_allocations_v2(
  p_organization_id uuid,
  p_building_bases jsonb
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
  WITH bases AS (
    SELECT x.building_id, x.base::numeric AS base
    FROM jsonb_to_recordset(COALESCE(p_building_bases, '[]'::jsonb))
      AS x(building_id uuid, base numeric)
  ),
  rules AS (
    SELECT
      s.id AS rule_id,
      s.manager_id,
      s.form,
      s.basis,
      s.amount::numeric AS fixed_amount,
      s.percent::numeric AS percent
    FROM public.profit_manager_salaries s
    JOIN public.profit_managers m
      ON m.id = s.manager_id
     AND m.organization_id = p_organization_id
     AND m.is_active
     AND m.deleted_at IS NULL
    WHERE s.organization_id = p_organization_id
      AND s.is_active
  ),
  rule_buildings AS (
    SELECT
      r.*,
      b.building_id,
      b.base,
      count(*) OVER (PARTITION BY r.rule_id) AS building_count,
      sum(GREATEST(b.base, 0)) OVER (PARTITION BY r.rule_id) AS positive_base_sum
    FROM rules r
    JOIN public.profit_manager_salary_buildings rb
      ON rb.salary_id = r.rule_id
     AND rb.organization_id = p_organization_id
    JOIN bases b ON b.building_id = rb.building_id
  ),
  targets AS (
    SELECT
      rb.*,
      CASE
        WHEN rb.basis = 'TOTAL_GROUP' AND rb.form = 'FIXED'
          THEN round(GREATEST(rb.fixed_amount, 0))
        WHEN rb.basis = 'TOTAL_GROUP' AND rb.form = 'PERCENT'
          THEN round(GREATEST(rb.positive_base_sum, 0) * GREATEST(rb.percent, 0) / 100)
        ELSE NULL::numeric
      END AS target_total
    FROM rule_buildings rb
  ),
  raw_amounts AS (
    SELECT
      t.*,
      CASE
        WHEN t.basis = 'PER_BUILDING' AND t.form = 'FIXED'
          THEN round(GREATEST(t.fixed_amount, 0))
        WHEN t.basis = 'PER_BUILDING' AND t.form = 'PERCENT'
          THEN round(GREATEST(t.base, 0) * GREATEST(t.percent, 0) / 100)
        WHEN t.positive_base_sum > 0
          THEN t.target_total * GREATEST(t.base, 0) / t.positive_base_sum
        ELSE t.target_total / t.building_count
      END AS raw_amount
    FROM targets t
  ),
  based AS (
    SELECT
      r.*,
      CASE
        WHEN r.basis = 'PER_BUILDING' THEN r.raw_amount
        ELSE floor(r.raw_amount)
      END AS base_part
    FROM raw_amounts r
  ),
  ranked AS (
    SELECT
      b.*,
      CASE
        WHEN b.basis = 'TOTAL_GROUP'
          THEN b.target_total - sum(b.base_part) OVER (PARTITION BY b.rule_id)
        ELSE 0::numeric
      END AS remainder,
      row_number() OVER (
        PARTITION BY b.rule_id
        ORDER BY (b.raw_amount - floor(b.raw_amount)) DESC, b.building_id
      ) AS remainder_rank
    FROM based b
  ),
  amounts AS (
    SELECT
      manager_id,
      building_id,
      CASE
        WHEN basis = 'TOTAL_GROUP' AND remainder_rank <= remainder
          THEN base_part + 1
        ELSE base_part
      END::numeric AS amount
    FROM ranked
  ),
  grouped AS (
    SELECT manager_id, building_id, sum(amount)::numeric AS amount
    FROM amounts
    GROUP BY manager_id, building_id
    HAVING sum(amount) <> 0
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'manager_id', manager_id,
        'building_id', building_id,
        'amount', amount
      ) ORDER BY building_id, manager_id
    ),
    '[]'::jsonb
  )
  FROM grouped;
$fn$;

-- Build one authoritative preview. Close/reclose call this after taking an
-- advisory lock and SHARE table locks; public preview uses one statement
-- snapshot and its hash is rechecked by the writer.
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

  -- Configuration is fail-closed: an assigned shareholder/manager must still
  -- be active and belong to the same organization at close time.
  IF EXISTS (
    SELECT 1
    FROM public.building_shareholders bs
    LEFT JOIN public.shareholders sh ON sh.id = bs.shareholder_id
    WHERE bs.building_id = ANY(p_building_ids)
      AND (
        bs.organization_id IS DISTINCT FROM p_organization_id
        OR sh.id IS NULL
        OR sh.organization_id IS DISTINCT FROM p_organization_id
        OR NOT sh.is_active
        OR sh.deleted_at IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Shareholder configuration contains inactive or cross-organization rows'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.building_shareholders bs
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
BEGIN
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
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
    'shareholder_profit.view',
    false
  );
END
$fn$;

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
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_expected_hash text := lower(btrim(COALESCE(p_expected_source_hash, '')));
  v_building_ids uuid[] := p_building_ids;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_run public.profit_close_runs%ROWTYPE;
  v_preview jsonb;
  v_result jsonb;
  v_allocation_snapshot jsonb;
  v_run_id uuid := gen_random_uuid();
  v_row jsonb;
  v_building_id uuid;
  v_owner_user_id uuid;
  v_pm_id uuid;
  v_revision bigint;
  v_existing_pm public.profit_monthly%ROWTYPE;
  v_has_existing boolean;
  v_previous_snapshot jsonb;
  v_current_snapshot jsonb;
  v_old_shareholder_allocations jsonb;
  v_old_manager_allocations jsonb;
  v_source_snapshot jsonb;
BEGIN
  IF p_operation NOT IN ('CLOSE', 'RECLOSE') THEN
    RAISE EXCEPTION 'Invalid close operation' USING ERRCODE = '22023';
  END IF;
  IF p_period_month IS NULL
     OR p_period_month <> date_trunc('month', p_period_month)::date THEN
    RAISE EXCEPTION 'period_month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;
  IF p_operation = 'CLOSE' AND v_reason = '' THEN
    v_reason := 'Initial monthly profit close';
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
    RAISE EXCEPTION 'expected_source_hash must be a 32-character lowercase MD5'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, 'shareholder_profit.lock'
  );

  v_request_payload := jsonb_build_object(
    'operation', p_operation,
    'organization_id', p_organization_id,
    'period_month', p_period_month,
    'expected_source_hash', v_expected_hash,
    'reason', v_reason,
    'building_ids', to_jsonb(p_building_ids),
    'adjustments', COALESCE(p_adjustments, '[]'::jsonb)
  );
  v_request_hash := md5(v_request_payload::text);

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext('profit-key:' || v_key)
  );

  SELECT *
  INTO v_existing_run
  FROM public.profit_close_runs r
  WHERE r.organization_id = p_organization_id
    AND r.idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing_run.operation <> p_operation
       OR v_existing_run.period_month <> p_period_month
       OR v_existing_run.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'Idempotency key was already used with a different request'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_run.result_snapshot
      || jsonb_build_object('idempotent_replay', true);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext(p_period_month::text)
  );

  IF v_building_ids IS NULL THEN
    IF p_operation = 'CLOSE' THEN
      SELECT array_agg(b.id ORDER BY b.id)
      INTO v_building_ids
      FROM public.buildings b
      WHERE b.organization_id = p_organization_id
        AND b.deleted_at IS NULL
        AND b.is_virtual = false;
    ELSE
      SELECT array_agg(pm.building_id ORDER BY pm.building_id)
      INTO v_building_ids
      FROM public.profit_monthly pm
      JOIN public.buildings b ON b.id = pm.building_id
      WHERE pm.organization_id = p_organization_id
        AND pm.period_month = p_period_month
        AND pm.status = 'LOCKED'
        AND b.deleted_at IS NULL
        AND b.is_virtual = false;
    END IF;
  END IF;

  IF v_building_ids IS NULL OR cardinality(v_building_ids) = 0 THEN
    RAISE EXCEPTION 'No real buildings are available for %', p_operation
      USING ERRCODE = '22023';
  END IF;

  -- A close is a whole-period decision. Partial arrays would change the base
  -- set of TOTAL_GROUP salary rules and therefore produce non-canonical pay.
  IF cardinality(v_building_ids) <> (
    SELECT count(*)
    FROM public.buildings b
    WHERE b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false
  ) OR EXISTS (
    SELECT 1
    FROM public.buildings b
    WHERE b.organization_id = p_organization_id
      AND b.deleted_at IS NULL
      AND b.is_virtual = false
      AND NOT (b.id = ANY(v_building_ids))
  ) THEN
    RAISE EXCEPTION
      'CLOSE/RECLOSE must include every active real building in the organization; reset mixed legacy state first'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND NOT (pm.building_id = ANY(v_building_ids))
  ) THEN
    RAISE EXCEPTION
      'Period contains legacy virtual/deleted-building snapshots; run profit_reset_v2 before closing'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.building_id = ANY(v_building_ids)
      AND pm.period_month = p_period_month
      AND pm.organization_id IS DISTINCT FROM p_organization_id
  ) THEN
    RAISE EXCEPTION 'A current snapshot has an invalid organization boundary'
      USING ERRCODE = '55000';
  END IF;

  IF p_operation = 'CLOSE' AND EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = ANY(v_building_ids)
      AND pm.status = 'LOCKED'
  ) THEN
    RAISE EXCEPTION 'One or more buildings are already closed; use profit_reclose_v2'
      USING ERRCODE = '55000';
  END IF;

  IF p_operation = 'RECLOSE' AND (
    SELECT count(*)
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = ANY(v_building_ids)
      AND pm.status = 'LOCKED'
  ) <> cardinality(v_building_ids) THEN
    RAISE EXCEPTION 'RECLOSE requires an existing LOCKED snapshot for every building'
      USING ERRCODE = '55000';
  END IF;

  v_preview := public._profit_close_preview_core_v2(
    p_organization_id,
    p_period_month,
    v_building_ids,
    COALESCE(p_adjustments, '[]'::jsonb),
    'shareholder_profit.lock',
    true
  );

  IF v_preview->>'source_hash' <> v_expected_hash THEN
    RAISE EXCEPTION
      'PROFIT_SOURCE_CONFLICT expected %, current %',
      v_expected_hash, v_preview->>'source_hash'
      USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'building_id', x.value->>'building_id',
      'shareholder_allocations', x.value->'shareholder_allocations',
      'manager_allocations', x.value->'manager_allocations'
    ) ORDER BY x.value->>'building_id'
  ), '[]'::jsonb)
  INTO v_allocation_snapshot
  FROM jsonb_array_elements(v_preview->'buildings') x(value);

  v_result := v_preview || jsonb_build_object(
    'run_id', v_run_id,
    'operation', p_operation,
    'affected_buildings', cardinality(v_building_ids),
    'idempotent_replay', false
  );

  INSERT INTO public.profit_close_runs (
    id, organization_id, period_month, operation, actor_id, reason,
    idempotency_key, request_payload, request_hash, expected_source_hash,
    source_hash, source_captured_at, source_snapshot, allocation_snapshot,
    result_snapshot
  ) VALUES (
    v_run_id,
    p_organization_id,
    p_period_month,
    p_operation,
    v_actor,
    v_reason,
    v_key,
    v_request_payload,
    v_request_hash,
    v_expected_hash,
    v_preview->>'source_hash',
    (v_preview->>'source_captured_at')::timestamptz,
    v_preview->'source_snapshot',
    v_allocation_snapshot,
    v_result
  );

  FOR v_row IN
    SELECT value
    FROM jsonb_array_elements(v_preview->'buildings') x(value)
    ORDER BY value->>'building_id'
  LOOP
    v_building_id := (v_row->>'building_id')::uuid;

    SELECT b.user_id
    INTO v_owner_user_id
    FROM public.buildings b
    WHERE b.id = v_building_id
      AND b.organization_id = p_organization_id;

    SELECT *
    INTO v_existing_pm
    FROM public.profit_monthly pm
    WHERE pm.building_id = v_building_id
      AND pm.period_month = p_period_month
    FOR UPDATE;
    v_has_existing := FOUND;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', pa.id,
        'shareholder_id', pa.shareholder_id,
        'percent', pa.percent,
        'amount', pa.amount,
        'created_at', pa.created_at
      ) ORDER BY pa.shareholder_id, pa.id
    ), '[]'::jsonb)
    INTO v_old_shareholder_allocations
    FROM public.profit_allocations pa
    WHERE v_has_existing AND pa.profit_monthly_id = v_existing_pm.id;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', pma.id,
        'manager_id', pma.manager_id,
        'amount', pma.amount,
        'created_at', pma.created_at
      ) ORDER BY pma.manager_id, pma.id
    ), '[]'::jsonb)
    INTO v_old_manager_allocations
    FROM public.profit_manager_allocations pma
    WHERE v_has_existing AND pma.profit_monthly_id = v_existing_pm.id;

    v_previous_snapshot := CASE WHEN v_has_existing THEN
      jsonb_build_object(
        'profit_monthly', to_jsonb(v_existing_pm),
        'shareholder_allocations', v_old_shareholder_allocations,
        'manager_allocations', v_old_manager_allocations
      )
      ELSE NULL
    END;

    SELECT COALESCE(max(r.revision_number), 0) + 1
    INTO v_revision
    FROM public.profit_close_revisions r
    WHERE r.organization_id = p_organization_id
      AND r.building_id = v_building_id
      AND r.period_month = p_period_month;

    v_pm_id := CASE WHEN v_has_existing THEN v_existing_pm.id ELSE gen_random_uuid() END;

    INSERT INTO public.profit_monthly AS pm (
      id, user_id, building_id, period_month, computed_profit,
      adjustment_amount, adjustment_reason, adjustment_by, adjustment_at,
      adjusted_profit, management_salary, status, locked_at, locked_by,
      organization_id, source_revenue, source_expense, source_net_profit,
      source_hash, source_captured_at, is_stale, stale_reason,
      revision_number
    ) VALUES (
      v_pm_id,
      v_owner_user_id,
      v_building_id,
      p_period_month,
      (v_row->>'computed_profit')::numeric,
      (v_row->>'adjustment_amount')::numeric,
      NULLIF(btrim(v_row->>'adjustment_reason'), ''),
      CASE WHEN (v_row->>'adjustment_amount')::numeric <> 0 THEN v_actor END,
      CASE WHEN (v_row->>'adjustment_amount')::numeric <> 0
           THEN (v_preview->>'source_captured_at')::timestamptz END,
      (v_row->>'adjusted_profit')::numeric,
      (v_row->>'management_salary')::numeric,
      'LOCKED',
      (v_preview->>'source_captured_at')::timestamptz,
      v_actor,
      p_organization_id,
      (v_row->>'source_revenue')::numeric,
      (v_row->>'source_expense')::numeric,
      (v_row->>'computed_profit')::numeric,
      v_row->>'building_source_hash',
      (v_preview->>'source_captured_at')::timestamptz,
      false,
      NULL,
      v_revision
    )
    ON CONFLICT (building_id, period_month) DO UPDATE
      SET user_id = EXCLUDED.user_id,
          computed_profit = EXCLUDED.computed_profit,
          adjustment_amount = EXCLUDED.adjustment_amount,
          adjustment_reason = EXCLUDED.adjustment_reason,
          adjustment_by = EXCLUDED.adjustment_by,
          adjustment_at = EXCLUDED.adjustment_at,
          adjusted_profit = EXCLUDED.adjusted_profit,
          management_salary = EXCLUDED.management_salary,
          status = 'LOCKED',
          locked_at = EXCLUDED.locked_at,
          locked_by = EXCLUDED.locked_by,
          organization_id = EXCLUDED.organization_id,
          source_revenue = EXCLUDED.source_revenue,
          source_expense = EXCLUDED.source_expense,
          source_net_profit = EXCLUDED.source_net_profit,
          source_hash = EXCLUDED.source_hash,
          source_captured_at = EXCLUDED.source_captured_at,
          is_stale = false,
          stale_reason = NULL,
          revision_number = EXCLUDED.revision_number
    RETURNING pm.id INTO v_pm_id;

    DELETE FROM public.profit_allocations
    WHERE profit_monthly_id = v_pm_id;
    DELETE FROM public.profit_manager_allocations
    WHERE profit_monthly_id = v_pm_id;

    INSERT INTO public.profit_allocations (
      user_id, profit_monthly_id, shareholder_id, percent, amount,
      organization_id
    )
    SELECT
      v_owner_user_id,
      v_pm_id,
      x.shareholder_id,
      x.percent,
      x.amount,
      p_organization_id
    FROM jsonb_to_recordset(v_row->'shareholder_allocations')
      AS x(shareholder_id uuid, shareholder_name text, percent numeric, amount numeric);

    INSERT INTO public.profit_manager_allocations (
      user_id, profit_monthly_id, manager_id, amount, organization_id
    )
    SELECT
      v_owner_user_id,
      v_pm_id,
      x.manager_id,
      x.amount,
      p_organization_id
    FROM jsonb_to_recordset(v_row->'manager_allocations')
      AS x(manager_id uuid, manager_name text, amount numeric)
    WHERE x.amount <> 0;

    SELECT jsonb_build_object(
      'profit_monthly', to_jsonb(pm),
      'shareholder_allocations', v_row->'shareholder_allocations',
      'manager_allocations', v_row->'manager_allocations'
    )
    INTO v_current_snapshot
    FROM public.profit_monthly pm
    WHERE pm.id = v_pm_id;

    SELECT jsonb_build_object(
      'algorithm_version', v_preview->>'algorithm_version',
      'preview_source_hash', v_preview->>'source_hash',
      'building_source_hash', v_row->>'building_source_hash',
      'source_captured_at', v_preview->'source_captured_at',
      'pnl', COALESCE((
        SELECT x.value
        FROM jsonb_array_elements(v_preview->'source_snapshot'->'pnl') x(value)
        WHERE x.value->>'building_id' = v_building_id::text
        LIMIT 1
      ), '{}'::jsonb),
      'accrual_lines', COALESCE((
        SELECT jsonb_agg(x.value)
        FROM jsonb_array_elements(
          v_preview->'source_snapshot'->'accrual_lines'
        ) x(value)
        WHERE x.value->>'building_id' = v_building_id::text
      ), '[]'::jsonb)
    )
    INTO v_source_snapshot;

    INSERT INTO public.profit_close_revisions (
      run_id, organization_id, profit_monthly_id, building_id, period_month,
      revision_number, operation, actor_id, reason, source_hash,
      source_captured_at, source_snapshot, shareholder_allocations,
      manager_allocations, previous_snapshot, current_snapshot
    ) VALUES (
      v_run_id,
      p_organization_id,
      v_pm_id,
      v_building_id,
      p_period_month,
      v_revision,
      p_operation,
      v_actor,
      v_reason,
      v_row->>'building_source_hash',
      (v_preview->>'source_captured_at')::timestamptz,
      v_source_snapshot,
      v_row->'shareholder_allocations',
      v_row->'manager_allocations',
      v_previous_snapshot,
      v_current_snapshot
    );
  END LOOP;

  RETURN v_result;
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

CREATE OR REPLACE FUNCTION public._profit_state_change_v2(
  p_operation text,
  p_organization_id uuid,
  p_period_month date,
  p_reason text,
  p_idempotency_key text,
  p_building_ids uuid[],
  p_expected_source_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(COALESCE(p_reason, ''));
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_expected_hash text := NULLIF(lower(btrim(COALESCE(p_expected_source_hash, ''))), '');
  v_building_ids uuid[] := p_building_ids;
  v_request_payload jsonb;
  v_request_hash text;
  v_existing_run public.profit_close_runs%ROWTYPE;
  v_before jsonb;
  v_state_hash text;
  v_result jsonb;
  v_run_id uuid := gen_random_uuid();
  v_building_id uuid;
  v_pm public.profit_monthly%ROWTYPE;
  v_revision bigint;
  v_shareholder_allocations jsonb;
  v_manager_allocations jsonb;
  v_previous_snapshot jsonb;
  v_current_snapshot jsonb;
  v_affected integer := 0;
BEGIN
  IF p_operation NOT IN ('RESET', 'UNLOCK') THEN
    RAISE EXCEPTION 'Invalid state-change operation' USING ERRCODE = '22023';
  END IF;
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
  IF v_expected_hash IS NOT NULL AND v_expected_hash !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'expected_source_hash must be a 32-character MD5'
      USING ERRCODE = '22023';
  END IF;

  PERFORM public._profit_assert_authorized_v2(
    p_organization_id, 'shareholder_profit.unlock'
  );

  v_request_payload := jsonb_build_object(
    'operation', p_operation,
    'organization_id', p_organization_id,
    'period_month', p_period_month,
    'reason', v_reason,
    'building_ids', to_jsonb(p_building_ids),
    'expected_source_hash', v_expected_hash
  );
  v_request_hash := md5(v_request_payload::text);

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext('profit-key:' || v_key)
  );

  SELECT *
  INTO v_existing_run
  FROM public.profit_close_runs r
  WHERE r.organization_id = p_organization_id
    AND r.idempotency_key = v_key;
  IF FOUND THEN
    IF v_existing_run.operation <> p_operation
       OR v_existing_run.period_month <> p_period_month
       OR v_existing_run.request_hash <> v_request_hash THEN
      RAISE EXCEPTION 'Idempotency key was already used with a different request'
        USING ERRCODE = '23505';
    END IF;
    RETURN v_existing_run.result_snapshot
      || jsonb_build_object('idempotent_replay', true);
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_organization_id::text), hashtext(p_period_month::text)
  );

  -- NULL intentionally means every current snapshot in the org/period,
  -- including legacy virtual buckets. Close/preview remain real-building-only.
  IF v_building_ids IS NULL THEN
    SELECT array_agg(pm.building_id ORDER BY pm.building_id)
    INTO v_building_ids
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month;
  ELSE
    IF array_position(v_building_ids, NULL) IS NOT NULL THEN
      RAISE EXCEPTION 'building_ids cannot contain NULL' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM unnest(v_building_ids) x)
       <> (SELECT count(DISTINCT x) FROM unnest(v_building_ids) x) THEN
      RAISE EXCEPTION 'building_ids contains duplicates' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*)
        FROM public.profit_monthly pm
        WHERE pm.organization_id = p_organization_id
          AND pm.period_month = p_period_month
          AND pm.building_id = ANY(v_building_ids))
       <> cardinality(v_building_ids) THEN
      RAISE EXCEPTION 'Every requested building must have a current period snapshot'
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_building_ids := COALESCE(v_building_ids, '{}'::uuid[]);

  IF NOT public.is_super_admin() AND EXISTS (
    SELECT 1
    FROM unnest(v_building_ids) bid
    WHERE NOT public.authorize_v2(
      'shareholder_profit.unlock', p_organization_id, 'BUILDING', bid
    )
  ) THEN
    RAISE EXCEPTION 'Unlock permission does not cover every requested building'
      USING ERRCODE = '42501';
  END IF;

  IF p_operation = 'UNLOCK' AND EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = ANY(v_building_ids)
      AND pm.status <> 'LOCKED'
  ) THEN
    RAISE EXCEPTION 'UNLOCK requires LOCKED current snapshots'
      USING ERRCODE = '55000';
  END IF;

  IF v_expected_hash IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = ANY(v_building_ids)
      AND pm.source_hash IS DISTINCT FROM v_expected_hash
  ) THEN
    RAISE EXCEPTION 'PROFIT_SOURCE_CONFLICT current snapshots do not match expected hash'
      USING ERRCODE = '40001';
  END IF;

  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'profit_monthly', to_jsonb(pm),
      'shareholder_allocations', COALESCE((
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
      ), '[]'::jsonb),
      'manager_allocations', COALESCE((
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
      ), '[]'::jsonb)
    ) ORDER BY pm.building_id
  ), '[]'::jsonb)
  INTO v_before
  FROM public.profit_monthly pm
  WHERE pm.organization_id = p_organization_id
    AND pm.period_month = p_period_month
    AND pm.building_id = ANY(v_building_ids);

  v_state_hash := md5(v_before::text);
  v_affected := cardinality(v_building_ids);
  v_result := jsonb_build_object(
    'run_id', v_run_id,
    'operation', p_operation,
    'organization_id', p_organization_id,
    'period_month', p_period_month,
    'affected_buildings', v_affected,
    'deleted_current_snapshots', p_operation = 'RESET',
    'state_hash', v_state_hash,
    'idempotent_replay', false
  );

  INSERT INTO public.profit_close_runs (
    id, organization_id, period_month, operation, actor_id, reason,
    idempotency_key, request_payload, request_hash, expected_source_hash,
    source_hash, source_captured_at, source_snapshot, allocation_snapshot,
    result_snapshot
  ) VALUES (
    v_run_id,
    p_organization_id,
    p_period_month,
    p_operation,
    v_actor,
    v_reason,
    v_key,
    v_request_payload,
    v_request_hash,
    v_expected_hash,
    v_state_hash,
    clock_timestamp(),
    jsonb_build_object('kind', 'CURRENT_PROFIT_SNAPSHOT', 'rows', v_before),
    v_before,
    v_result
  );

  FOREACH v_building_id IN ARRAY v_building_ids
  LOOP
    SELECT *
    INTO STRICT v_pm
    FROM public.profit_monthly pm
    WHERE pm.organization_id = p_organization_id
      AND pm.period_month = p_period_month
      AND pm.building_id = v_building_id
    FOR UPDATE;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', pa.id,
        'shareholder_id', pa.shareholder_id,
        'percent', pa.percent,
        'amount', pa.amount,
        'created_at', pa.created_at
      ) ORDER BY pa.shareholder_id, pa.id
    ), '[]'::jsonb)
    INTO v_shareholder_allocations
    FROM public.profit_allocations pa
    WHERE pa.profit_monthly_id = v_pm.id;

    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', pma.id,
        'manager_id', pma.manager_id,
        'amount', pma.amount,
        'created_at', pma.created_at
      ) ORDER BY pma.manager_id, pma.id
    ), '[]'::jsonb)
    INTO v_manager_allocations
    FROM public.profit_manager_allocations pma
    WHERE pma.profit_monthly_id = v_pm.id;

    v_previous_snapshot := jsonb_build_object(
      'profit_monthly', to_jsonb(v_pm),
      'shareholder_allocations', v_shareholder_allocations,
      'manager_allocations', v_manager_allocations
    );

    SELECT COALESCE(max(r.revision_number), 0) + 1
    INTO v_revision
    FROM public.profit_close_revisions r
    WHERE r.organization_id = p_organization_id
      AND r.building_id = v_building_id
      AND r.period_month = p_period_month;

    DELETE FROM public.profit_allocations
    WHERE profit_monthly_id = v_pm.id;
    DELETE FROM public.profit_manager_allocations
    WHERE profit_monthly_id = v_pm.id;

    IF p_operation = 'RESET' THEN
      DELETE FROM public.profit_monthly WHERE id = v_pm.id;
      v_current_snapshot := NULL;
    ELSE
      UPDATE public.profit_monthly
      SET status = 'DRAFT',
          management_salary = 0,
          locked_at = NULL,
          locked_by = NULL,
          is_stale = true,
          stale_reason = left('UNLOCKED: ' || v_reason, 1000),
          revision_number = v_revision
      WHERE id = v_pm.id;

      SELECT jsonb_build_object(
        'profit_monthly', to_jsonb(pm),
        'shareholder_allocations', '[]'::jsonb,
        'manager_allocations', '[]'::jsonb
      )
      INTO v_current_snapshot
      FROM public.profit_monthly pm
      WHERE pm.id = v_pm.id;
    END IF;

    INSERT INTO public.profit_close_revisions (
      run_id, organization_id, profit_monthly_id, building_id, period_month,
      revision_number, operation, actor_id, reason, source_hash,
      source_captured_at, source_snapshot, shareholder_allocations,
      manager_allocations, previous_snapshot, current_snapshot
    ) VALUES (
      v_run_id,
      p_organization_id,
      v_pm.id,
      v_building_id,
      p_period_month,
      v_revision,
      p_operation,
      v_actor,
      v_reason,
      v_pm.source_hash,
      v_pm.source_captured_at,
      jsonb_build_object(
        'source_revenue', v_pm.source_revenue,
        'source_expense', v_pm.source_expense,
        'source_net_profit', v_pm.source_net_profit,
        'source_hash', v_pm.source_hash,
        'source_captured_at', v_pm.source_captured_at,
        'was_stale', v_pm.is_stale,
        'stale_reason', v_pm.stale_reason
      ),
      v_shareholder_allocations,
      v_manager_allocations,
      v_previous_snapshot,
      v_current_snapshot
    );
  END LOOP;

  RETURN v_result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.profit_reset_v2(
  p_organization_id uuid,
  p_period_month date,
  p_reason text,
  p_idempotency_key text,
  p_building_ids uuid[] DEFAULT NULL,
  p_expected_source_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
  SELECT public._profit_state_change_v2(
    'RESET', p_organization_id, p_period_month, p_reason,
    p_idempotency_key, p_building_ids, p_expected_source_hash
  );
$fn$;

CREATE OR REPLACE FUNCTION public.profit_unlock_v2(
  p_organization_id uuid,
  p_period_month date,
  p_reason text,
  p_idempotency_key text,
  p_building_ids uuid[] DEFAULT NULL,
  p_expected_source_hash text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
  SELECT public._profit_state_change_v2(
    'UNLOCK', p_organization_id, p_period_month, p_reason,
    p_idempotency_key, p_building_ids, p_expected_source_hash
  );
$fn$;

COMMENT ON FUNCTION public.profit_close_preview_v2(uuid,date,uuid[],jsonb) IS
  'Returns {algorithm_version,organization_id,period_month,source_hash,source_captured_at,source_snapshot,buildings[],totals}. Each building includes canonical totals, explicit adjustment, manager/shareholder allocations, and current_* snapshot/stale fields.';
COMMENT ON FUNCTION public.profit_close_v2(uuid,date,text,text,text,uuid[],jsonb) IS
  'Initial close. Requires preview source_hash, accepts adjustments only, and rejects existing LOCKED rows.';
COMMENT ON FUNCTION public.profit_reclose_v2(uuid,date,text,text,text,uuid[],jsonb) IS
  'Reclose existing LOCKED real-building snapshots from current canonical source.';
COMMENT ON FUNCTION public.profit_reset_v2(uuid,date,text,text,uuid[],text) IS
  'Hard-deletes current snapshots while preserving append-only revisions. NULL building_ids includes legacy virtual rows.';
COMMENT ON FUNCTION public.profit_unlock_v2(uuid,date,text,text,uuid[],text) IS
  'Deletes current allocations and changes snapshots to stale DRAFT rows; audit history is preserved.';

-- Internal helpers are never client-callable.
REVOKE ALL ON FUNCTION public._profit_close_audit_append_only_v2()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._profit_can_read_audit_v2(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._profit_can_read_audit_v2(uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public._profit_assert_authorized_v2(uuid,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._profit_management_allocations_v2(uuid,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._profit_write_close_v2(text,uuid,date,text,text,text,uuid[],jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._profit_state_change_v2(text,uuid,date,text,text,uuid[],text)
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.profit_close_preview_v2(uuid,date,uuid[],jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profit_close_v2(uuid,date,text,text,text,uuid[],jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profit_reclose_v2(uuid,date,text,text,text,uuid[],jsonb)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profit_reset_v2(uuid,date,text,text,uuid[],text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.profit_unlock_v2(uuid,date,text,text,uuid[],text)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.profit_close_preview_v2(uuid,date,uuid[],jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_close_v2(uuid,date,text,text,text,uuid[],jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_reclose_v2(uuid,date,text,text,text,uuid[],jsonb)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_reset_v2(uuid,date,text,text,uuid[],text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.profit_unlock_v2(uuid,date,text,text,uuid[],text)
  TO authenticated;

-- V1 accepted client-computed amounts. Remove every client/service execute grant
-- if those live functions exist; authorization errors must never fall back.
DO $do$
BEGIN
  IF to_regprocedure('public.lock_profit_month_v1(text,jsonb)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.lock_profit_month_v1(text,jsonb) '
      || 'FROM PUBLIC, anon, authenticated, service_role';
  END IF;
  IF to_regprocedure('public.unlock_profit_month_v1(text,uuid[])') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.unlock_profit_month_v1(text,uuid[]) '
      || 'FROM PUBLIC, anon, authenticated, service_role';
  END IF;
END
$do$;

COMMIT;

NOTIFY pgrst, 'reload schema';
