-- Bind every shareholder payout to locked profit allocations and reserve the
-- outstanding balance while its approval request is pending.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS profit_allocations_id_org_uq
  ON public.profit_allocations(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS shareholders_id_org_uq
  ON public.shareholders(id, organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS income_expenses_id_org_uq
  ON public.income_expenses(id, organization_id);

CREATE TABLE IF NOT EXISTS public.profit_payout_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  profit_allocation_id uuid NOT NULL,
  shareholder_id uuid NOT NULL,
  payout_voucher_id uuid NOT NULL,
  approval_request_id uuid REFERENCES public.approval_requests(id) ON DELETE RESTRICT,
  amount numeric(15,2) NOT NULL CHECK (
    amount <> 'NaN'::numeric AND amount > 0
  ),
  reservation_source text NOT NULL,
  source_payload_hash text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profit_payout_reservations_allocation_org_fk
    FOREIGN KEY (profit_allocation_id, organization_id)
    REFERENCES public.profit_allocations(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT profit_payout_reservations_shareholder_org_fk
    FOREIGN KEY (shareholder_id, organization_id)
    REFERENCES public.shareholders(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT profit_payout_reservations_voucher_org_fk
    FOREIGN KEY (payout_voucher_id, organization_id)
    REFERENCES public.income_expenses(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT profit_payout_reservations_source_check CHECK (
    reservation_source IN ('CANONICAL_V1', 'LEGACY_BACKFILL')
  ),
  CONSTRAINT profit_payout_reservations_payload_hash_check CHECK (
    (
      reservation_source = 'LEGACY_BACKFILL'
      AND source_payload_hash IS NULL
    ) OR (
      reservation_source = 'CANONICAL_V1'
      AND source_payload_hash ~ '^[0-9a-f]{32}$'
    )
  ),
  CONSTRAINT profit_payout_reservations_voucher_allocation_uq
    UNIQUE (payout_voucher_id, profit_allocation_id)
);

CREATE INDEX IF NOT EXISTS profit_payout_reservations_allocation_idx
  ON public.profit_payout_reservations(profit_allocation_id, created_at);
CREATE INDEX IF NOT EXISTS profit_payout_reservations_shareholder_idx
  ON public.profit_payout_reservations(shareholder_id, created_at);

CREATE TABLE IF NOT EXISTS public.profit_payout_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  shareholder_id uuid NOT NULL REFERENCES public.shareholders(id) ON DELETE RESTRICT,
  payout_voucher_id uuid REFERENCES public.income_expenses(id) ON DELETE RESTRICT,
  exception_code text NOT NULL,
  amount numeric(15,2) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT profit_payout_exceptions_code_check CHECK (
    exception_code IN ('LEGACY_PAYOUT_EXCEEDS_ALLOCATIONS', 'AMBIGUOUS_LEGACY_PAYOUT')
  ),
  CONSTRAINT profit_payout_exceptions_amount_check CHECK (
    amount <> 'NaN'::numeric
  )
);

ALTER TABLE public.profit_payout_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_payout_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS profit_payout_reservations_read_v2
  ON public.profit_payout_reservations;
CREATE POLICY profit_payout_reservations_read_v2
ON public.profit_payout_reservations FOR SELECT TO authenticated
USING (public._profit_can_read_audit_v2(organization_id));

DROP POLICY IF EXISTS profit_payout_exceptions_read_v2
  ON public.profit_payout_exceptions;
CREATE POLICY profit_payout_exceptions_read_v2
ON public.profit_payout_exceptions FOR SELECT TO authenticated
USING (public._profit_can_read_audit_v2(organization_id));

REVOKE ALL ON public.profit_payout_reservations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.profit_payout_exceptions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.profit_payout_reservations TO authenticated;
GRANT SELECT ON public.profit_payout_exceptions TO authenticated;

CREATE OR REPLACE FUNCTION public._profit_allocation_reserved_v2(
  p_profit_allocation_id uuid
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
  SELECT COALESCE(sum(reservation.amount), 0)::numeric
  FROM public.profit_payout_reservations reservation
  JOIN public.income_expenses voucher
    ON voucher.id = reservation.payout_voucher_id
   AND voucher.organization_id = reservation.organization_id
   AND voucher.deleted_at IS NULL
  LEFT JOIN public.approval_requests request_row
    ON request_row.id = reservation.approval_request_id
  WHERE reservation.profit_allocation_id = p_profit_allocation_id
    AND (
      (
        reservation.reservation_source = 'LEGACY_BACKFILL'
        AND voucher.approval_status IN ('UNAPPROVED', 'APPROVED')
      )
      OR (
        reservation.reservation_source = 'CANONICAL_V1'
        AND request_row.state IN ('PENDING_APPROVAL', 'POSTED')
      )
    );
$fn$;

-- Rebuild the per-building hash from the exact canonical source document used
-- by Profit Close V2. The close run records the original building scope, which
-- matters for TOTAL_GROUP manager rules and must not be guessed from current
-- profit_monthly rows.
CREATE OR REPLACE FUNCTION app_private.current_profit_building_source_hash_v1(
  p_profit_monthly_id uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
DECLARE
  v_profit public.profit_monthly%ROWTYPE;
  v_building_ids uuid[];
  v_hash text;
BEGIN
  SELECT profit.* INTO v_profit
  FROM public.profit_monthly profit
  WHERE profit.id = p_profit_monthly_id;
  IF NOT FOUND OR v_profit.status <> 'LOCKED' THEN
    RETURN NULL;
  END IF;

  SELECT array_agg(
           DISTINCT (source_row.value->>'building_id')::uuid
           ORDER BY (source_row.value->>'building_id')::uuid
         )
    INTO v_building_ids
  FROM public.profit_close_revisions revision
  JOIN public.profit_close_runs run ON run.id = revision.run_id
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(run.source_snapshot->'pnl') = 'array'
        THEN run.source_snapshot->'pnl'
      ELSE '[]'::jsonb
    END
  ) source_row(value)
  WHERE revision.profit_monthly_id = v_profit.id
    AND revision.organization_id = v_profit.organization_id
    AND revision.building_id = v_profit.building_id
    AND revision.period_month = v_profit.period_month
    AND revision.revision_number = v_profit.revision_number
    AND revision.operation IN ('CLOSE', 'RECLOSE')
    AND run.organization_id = v_profit.organization_id
    AND run.period_month = v_profit.period_month
    AND run.source_snapshot->>'algorithm_version' = 'profit-close-v2.1';

  IF v_building_ids IS NULL
     OR NOT (v_profit.building_id = ANY(v_building_ids)) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(v_building_ids) source_building(building_id)
    LEFT JOIN public.buildings building
      ON building.id = source_building.building_id
    WHERE building.id IS NULL
       OR building.organization_id IS DISTINCT FROM v_profit.organization_id
       OR building.deleted_at IS NOT NULL
       OR building.is_virtual
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.building_shareholders building_shareholder
    LEFT JOIN public.shareholders shareholder
      ON shareholder.id = building_shareholder.shareholder_id
    WHERE building_shareholder.building_id = ANY(v_building_ids)
      AND (
        building_shareholder.organization_id IS DISTINCT FROM
          v_profit.organization_id
        OR shareholder.id IS NULL
        OR shareholder.organization_id IS DISTINCT FROM
          v_profit.organization_id
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.building_shareholders building_shareholder
    JOIN public.shareholders shareholder
      ON shareholder.id = building_shareholder.shareholder_id
     AND shareholder.organization_id = v_profit.organization_id
     AND shareholder.is_active
     AND shareholder.deleted_at IS NULL
    WHERE building_shareholder.building_id = ANY(v_building_ids)
      AND building_shareholder.organization_id = v_profit.organization_id
    GROUP BY building_shareholder.building_id
    HAVING sum(building_shareholder.percent) > 100
  ) THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_manager_salary_buildings salary_building
    JOIN public.profit_manager_salaries salary
      ON salary.id = salary_building.salary_id
    LEFT JOIN public.profit_managers manager ON manager.id = salary.manager_id
    WHERE salary_building.building_id = ANY(v_building_ids)
      AND salary.is_active
      AND (
        manager.id IS NULL
        OR (
          manager.is_active
          AND manager.deleted_at IS NULL
          AND (
            salary_building.organization_id IS DISTINCT FROM
              v_profit.organization_id
            OR salary.organization_id IS DISTINCT FROM
              v_profit.organization_id
            OR manager.organization_id IS DISTINCT FROM
              v_profit.organization_id
          )
        )
      )
  ) THEN
    RETURN NULL;
  END IF;

  WITH selected AS MATERIALIZED (
    SELECT
      building.id AS building_id,
      building.name AS building_name
    FROM public.buildings building
    WHERE building.id = ANY(v_building_ids)
  ),
  vouchers AS MATERIALIZED (
    SELECT
      voucher.id,
      voucher.type::text AS side,
      voucher.voucher_date,
      selected.building_id,
      selected.building_name,
      voucher.total_amount,
      voucher.business_result_accounting AS override,
      CASE
        WHEN voucher.invoice_id IS NOT NULL
         AND invoice.billing_month ~ '^\d{4}-\d{2}$'
          THEN to_date(invoice.billing_month, 'YYYY-MM')
      END AS invoice_month
    FROM selected
    JOIN public.income_expenses voucher
      ON voucher.building_id = selected.building_id
    LEFT JOIN public.invoices invoice
      ON invoice.id = voucher.invoice_id
     AND invoice.deleted_at IS NULL
    WHERE voucher.deleted_at IS NULL
      AND voucher.approval_status = 'APPROVED'
      AND voucher.business_result_accounting IS DISTINCT FROM false
  ),
  invoice_items AS (
    SELECT
      voucher.invoice_month AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      type_row.id AS type_id,
      type_row.name AS type_name,
      type_row.category,
      COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amount
    FROM vouchers voucher
    JOIN public.income_expense_items item
      ON item.income_expense_id = voucher.id
    JOIN public.income_expense_types type_row
      ON type_row.id = item.income_expense_type_id
    WHERE voucher.invoice_month IS NOT NULL
      AND (voucher.override IS TRUE OR item.accounting_class = 'PNL')
  ),
  invoice_no_item AS (
    SELECT
      voucher.invoice_month AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      NULL::uuid AS type_id,
      U&'Kh\00F4ng c\00F3 h\1EA1ng m\1EE5c'::text AS type_name,
      NULL::text AS category,
      voucher.total_amount::numeric AS amount
    FROM vouchers voucher
    WHERE voucher.invoice_month IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.income_expense_items item
        WHERE item.income_expense_id = voucher.id
      )
  ),
  period_items AS (
    SELECT
      (
        date_trunc('month', item.start_date)
        + (series.i || ' month')::interval
      )::date AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      type_row.id AS type_id,
      type_row.name AS type_name,
      type_row.category,
      (
        round(
          COALESCE(item.amount, item.unit_price * item.quantity)
          * (series.i + 1) / month_count.n
        )
        - round(
          COALESCE(item.amount, item.unit_price * item.quantity)
          * series.i / month_count.n
        )
      )::numeric AS amount
    FROM vouchers voucher
    JOIN public.income_expense_items item
      ON item.income_expense_id = voucher.id
    JOIN public.income_expense_types type_row
      ON type_row.id = item.income_expense_type_id
    CROSS JOIN LATERAL (
      SELECT GREATEST(
        extract(year FROM item.end_date)::integer * 12
          + extract(month FROM item.end_date)::integer
          - extract(year FROM item.start_date)::integer * 12
          - extract(month FROM item.start_date)::integer
          + 1,
        1
      ) AS n
    ) month_count
    CROSS JOIN LATERAL generate_series(
      0, month_count.n - 1
    ) AS series(i)
    WHERE voucher.invoice_month IS NULL
      AND (voucher.override IS TRUE OR item.accounting_class = 'PNL')
      AND item.start_date IS NOT NULL
      AND item.end_date IS NOT NULL
      AND item.end_date >= item.start_date
  ),
  invalid_period_items AS (
    SELECT
      date_trunc('month', item.start_date)::date AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      type_row.id AS type_id,
      type_row.name AS type_name,
      type_row.category,
      COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amount
    FROM vouchers voucher
    JOIN public.income_expense_items item
      ON item.income_expense_id = voucher.id
    JOIN public.income_expense_types type_row
      ON type_row.id = item.income_expense_type_id
    WHERE voucher.invoice_month IS NULL
      AND (voucher.override IS TRUE OR item.accounting_class = 'PNL')
      AND item.start_date IS NOT NULL
      AND item.end_date IS NOT NULL
      AND item.end_date < item.start_date
  ),
  no_period_items AS (
    SELECT
      date_trunc('month', voucher.voucher_date)::date AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      type_row.id AS type_id,
      type_row.name AS type_name,
      type_row.category,
      COALESCE(item.amount, item.unit_price * item.quantity)::numeric AS amount
    FROM vouchers voucher
    JOIN public.income_expense_items item
      ON item.income_expense_id = voucher.id
    JOIN public.income_expense_types type_row
      ON type_row.id = item.income_expense_type_id
    WHERE voucher.invoice_month IS NULL
      AND (voucher.override IS TRUE OR item.accounting_class = 'PNL')
      AND (item.start_date IS NULL OR item.end_date IS NULL)
  ),
  no_item AS (
    SELECT
      date_trunc('month', voucher.voucher_date)::date AS month,
      voucher.id AS voucher_id,
      voucher.building_id,
      voucher.building_name,
      voucher.side,
      NULL::uuid AS type_id,
      U&'Kh\00F4ng c\00F3 h\1EA1ng m\1EE5c'::text AS type_name,
      NULL::text AS category,
      voucher.total_amount::numeric AS amount
    FROM vouchers voucher
    WHERE voucher.invoice_month IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.income_expense_items item
        WHERE item.income_expense_id = voucher.id
      )
  ),
  source_lines AS MATERIALIZED (
    SELECT * FROM invoice_items
    UNION ALL SELECT * FROM invoice_no_item
    UNION ALL SELECT * FROM period_items
    UNION ALL SELECT * FROM invalid_period_items
    UNION ALL SELECT * FROM no_period_items
    UNION ALL SELECT * FROM no_item
  ),
  period_lines AS MATERIALIZED (
    SELECT *
    FROM source_lines
    WHERE month = v_profit.period_month
  ),
  pnl AS MATERIALIZED (
    SELECT
      line.building_id,
      COALESCE(sum(line.amount) FILTER (
        WHERE line.side = 'INCOME'
      ), 0)::numeric AS revenue,
      COALESCE(sum(line.amount) FILTER (
        WHERE line.side = 'EXPENSE'
      ), 0)::numeric AS expense,
      (
        COALESCE(sum(line.amount) FILTER (
          WHERE line.side = 'INCOME'
        ), 0)
        - COALESCE(sum(line.amount) FILTER (
          WHERE line.side = 'EXPENSE'
        ), 0)
      )::numeric AS net
    FROM period_lines line
    GROUP BY line.building_id
  ),
  base AS MATERIALIZED (
    SELECT
      selected.building_id,
      selected.building_name,
      COALESCE(pnl.revenue, 0)::numeric AS source_revenue,
      COALESCE(pnl.expense, 0)::numeric AS source_expense,
      COALESCE(pnl.net, 0)::numeric AS computed_profit
    FROM selected
    LEFT JOIN pnl ON pnl.building_id = selected.building_id
  ),
  share_config AS MATERIALIZED (
    SELECT
      building_shareholder.building_id,
      building_shareholder.shareholder_id,
      shareholder.name AS shareholder_name,
      building_shareholder.percent::numeric AS percent
    FROM public.building_shareholders building_shareholder
    JOIN public.shareholders shareholder
      ON shareholder.id = building_shareholder.shareholder_id
     AND shareholder.organization_id = v_profit.organization_id
     AND shareholder.is_active
     AND shareholder.deleted_at IS NULL
    WHERE building_shareholder.organization_id = v_profit.organization_id
      AND building_shareholder.building_id = ANY(v_building_ids)
  ),
  pnl_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', base.building_id,
        'building_name', base.building_name,
        'revenue', base.source_revenue,
        'expense', base.source_expense,
        'net', base.computed_profit
      ) ORDER BY base.building_id
    ), '[]'::jsonb) AS value
    FROM base
  ),
  line_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'month', line.month,
        'voucher_id', line.voucher_id,
        'building_id', line.building_id,
        'building_name', line.building_name,
        'side', line.side,
        'type_id', line.type_id,
        'type_name', line.type_name,
        'category', line.category,
        'amount', line.amount
      ) ORDER BY
        line.building_id, line.voucher_id, line.side,
        line.type_id NULLS FIRST, line.amount
    ), '[]'::jsonb) AS value
    FROM period_lines line
  ),
  share_config_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'building_id', config.building_id,
        'shareholder_id', config.shareholder_id,
        'shareholder_name', config.shareholder_name,
        'percent', config.percent
      ) ORDER BY config.building_id, config.shareholder_id
    ), '[]'::jsonb) AS value
    FROM share_config config
  ),
  manager_rules_document AS (
    SELECT COALESCE(jsonb_agg(
      jsonb_build_object(
        'rule_id', salary.id,
        'manager_id', salary.manager_id,
        'manager_name', manager.name,
        'label', salary.label,
        'form', salary.form,
        'basis', salary.basis,
        'amount', salary.amount,
        'percent', salary.percent,
        'building_ids', COALESCE((
          SELECT jsonb_agg(
            salary_building.building_id
            ORDER BY salary_building.building_id
          )
          FROM public.profit_manager_salary_buildings salary_building
          WHERE salary_building.salary_id = salary.id
            AND salary_building.organization_id = v_profit.organization_id
            AND salary_building.building_id = ANY(v_building_ids)
        ), '[]'::jsonb)
      ) ORDER BY salary.id
    ), '[]'::jsonb) AS value
    FROM public.profit_manager_salaries salary
    JOIN public.profit_managers manager
      ON manager.id = salary.manager_id
     AND manager.organization_id = v_profit.organization_id
     AND manager.is_active
     AND manager.deleted_at IS NULL
    WHERE salary.organization_id = v_profit.organization_id
      AND salary.is_active
      AND EXISTS (
        SELECT 1
        FROM public.profit_manager_salary_buildings salary_building
        WHERE salary_building.salary_id = salary.id
          AND salary_building.organization_id = v_profit.organization_id
          AND salary_building.building_id = ANY(v_building_ids)
      )
  ),
  source_document AS MATERIALIZED (
    SELECT jsonb_build_object(
      'algorithm_version', 'profit-close-v2.1',
      'organization_id', v_profit.organization_id,
      'period_month', v_profit.period_month,
      'pnl', pnl_document.value,
      'accrual_lines', line_document.value,
      'shareholder_config', share_config_document.value,
      'manager_salary_rules', manager_rules_document.value
    ) AS value
    FROM pnl_document
    CROSS JOIN line_document
    CROSS JOIN share_config_document
    CROSS JOIN manager_rules_document
  )
  SELECT md5(jsonb_build_object(
    'algorithm_version', 'profit-close-v2.1',
    'organization_id', v_profit.organization_id,
    'period_month', v_profit.period_month,
    'building_id', base.building_id,
    'source_building_bases', source_document.value->'pnl',
    'pnl', jsonb_build_object(
      'revenue', base.source_revenue,
      'expense', base.source_expense,
      'net', base.computed_profit
    ),
    'accrual_lines', COALESCE((
      SELECT jsonb_agg(
        entry.value ORDER BY
          entry.value->>'voucher_id', entry.value->>'side',
          entry.value->>'type_id', entry.value->>'amount'
      )
      FROM jsonb_array_elements(
        source_document.value->'accrual_lines'
      ) entry(value)
      WHERE entry.value->>'building_id' = base.building_id::text
    ), '[]'::jsonb),
    'shareholder_config', COALESCE((
      SELECT jsonb_agg(
        entry.value ORDER BY entry.value->>'shareholder_id'
      )
      FROM jsonb_array_elements(
        source_document.value->'shareholder_config'
      ) entry(value)
      WHERE entry.value->>'building_id' = base.building_id::text
    ), '[]'::jsonb),
    'manager_salary_rules', COALESCE((
      SELECT jsonb_agg(entry.value ORDER BY entry.value->>'rule_id')
      FROM jsonb_array_elements(
        source_document.value->'manager_salary_rules'
      ) entry(value)
      WHERE entry.value->'building_ids' @>
        to_jsonb(ARRAY[base.building_id])
    ), '[]'::jsonb)
  )::text)
    INTO v_hash
  FROM base
  CROSS JOIN source_document
  WHERE base.building_id = v_profit.building_id;

  RETURN v_hash;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.profit_monthly_source_is_current_v1(
  p_profit_monthly_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
  SELECT COALESCE((
    SELECT profit.status = 'LOCKED'
       AND NOT profit.is_stale
       AND profit.source_hash =
         app_private.current_profit_building_source_hash_v1(profit.id)
    FROM public.profit_monthly profit
    WHERE profit.id = p_profit_monthly_id
  ), false);
$fn$;

REVOKE ALL ON FUNCTION app_private.current_profit_building_source_hash_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.profit_monthly_source_is_current_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Allocate historical shareholder payouts FIFO so the canonical writer starts
-- from the real outstanding balance. Ambiguous excess remains visible for review.
DO $do$
DECLARE
  v_voucher record;
  v_allocation record;
  v_remaining numeric;
  v_available numeric;
  v_take numeric;
BEGIN
  FOR v_voucher IN
    SELECT
      voucher.id,
      voucher.organization_id,
      voucher.shareholder_id,
      voucher.total_amount,
      voucher.voucher_date,
      voucher.created_at,
      voucher.user_id
    FROM public.income_expenses voucher
    WHERE voucher.shareholder_id IS NOT NULL
      AND voucher.type = 'EXPENSE'
      AND voucher.deleted_at IS NULL
      AND voucher.approval_status IN ('UNAPPROVED', 'APPROVED')
      AND voucher.total_amount > 0
    ORDER BY voucher.organization_id, voucher.shareholder_id,
             voucher.voucher_date, voucher.created_at, voucher.id
  LOOP
    v_remaining := v_voucher.total_amount;

    FOR v_allocation IN
      SELECT pa.id, pa.amount
      FROM public.profit_allocations pa
      JOIN public.profit_monthly pm ON pm.id = pa.profit_monthly_id
      WHERE pa.organization_id = v_voucher.organization_id
        AND pa.shareholder_id = v_voucher.shareholder_id
        AND pa.amount > 0
        AND pm.status = 'LOCKED'
        AND NOT pm.is_stale
        AND app_private.profit_monthly_source_is_current_v1(pm.id)
        AND pm.period_month <= date_trunc('month', v_voucher.voucher_date)::date
      ORDER BY pm.period_month, pm.building_id, pa.id
    LOOP
      EXIT WHEN v_remaining < 0.01;
      v_available := GREATEST(
        v_allocation.amount
        - public._profit_allocation_reserved_v2(v_allocation.id),
        0
      );
      IF v_available < 0.01 THEN
        CONTINUE;
      END IF;

      v_take := LEAST(v_remaining, v_available);
      INSERT INTO public.profit_payout_reservations (
        organization_id, profit_allocation_id, shareholder_id,
        payout_voucher_id, approval_request_id, amount,
        reservation_source, created_by
      ) VALUES (
        v_voucher.organization_id, v_allocation.id, v_voucher.shareholder_id,
        v_voucher.id, NULL, v_take, 'LEGACY_BACKFILL', v_voucher.user_id
      )
      ON CONFLICT (payout_voucher_id, profit_allocation_id) DO NOTHING;
      v_remaining := v_remaining - v_take;
    END LOOP;

    IF v_remaining >= 0.01 THEN
      INSERT INTO public.profit_payout_exceptions (
        organization_id, shareholder_id, payout_voucher_id,
        exception_code, amount, details
      ) VALUES (
        v_voucher.organization_id, v_voucher.shareholder_id, v_voucher.id,
        'LEGACY_PAYOUT_EXCEEDS_ALLOCATIONS', v_remaining,
        jsonb_build_object(
          'voucher_total', v_voucher.total_amount,
          'voucher_date', v_voucher.voucher_date
        )
      );
    END IF;
  END LOOP;
END
$do$;

CREATE OR REPLACE FUNCTION app_private.lock_profit_payout_sources_v2()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
BEGIN
  -- Item DML takes the child table first, then its total-recalculation trigger
  -- updates the parent voucher. Source readers must use that same order.
  LOCK TABLE public.income_expense_items,
             public.income_expenses,
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
             public.super_admins,
             public.buildings,
             public.profit_monthly,
             public.profit_allocations
    IN SHARE ROW EXCLUSIVE MODE;
END
$fn$;

-- Profit Close V2 owns the canonical source snapshot implementation. Rewrite
-- only its two-table lock prefix from the live definition so the algorithm,
-- owner, ACL, and configured search_path remain byte-for-byte catalog-owned.
DO $align_profit_close_item_lock_order$
DECLARE
  v_signature regprocedure := to_regprocedure(
    'public._profit_close_preview_core_v2(uuid,date,uuid[],jsonb,text,boolean)'
  );
  v_definition text;
  v_rewritten text;
  v_owner oid;
  v_acl aclitem[];
  v_config text[];
  v_parent_first constant text :=
    'LOCK TABLE[[:space:]]+public\.income_expenses,' ||
    '[[:space:]]+public\.income_expense_items,';
  v_child_first constant text :=
    'LOCK TABLE[[:space:]]+public\.income_expense_items,' ||
    '[[:space:]]+public\.income_expenses,';
BEGIN
  IF v_signature IS NULL THEN
    RAISE EXCEPTION 'Profit Close V2 source helper is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT pg_get_functiondef(proc.oid), proc.proowner, proc.proacl, proc.proconfig
    INTO v_definition, v_owner, v_acl, v_config
  FROM pg_proc proc
  WHERE proc.oid = v_signature::oid;

  IF v_definition !~* v_child_first THEN
    IF v_definition !~* v_parent_first THEN
      RAISE EXCEPTION 'Profit Close V2 source lock prefix is unrecognized'
        USING ERRCODE = '55000';
    END IF;
    v_rewritten := regexp_replace(
      v_definition,
      v_parent_first,
      E'LOCK TABLE public.income_expense_items,\n               public.income_expenses,',
      'i'
    );
    EXECUTE v_rewritten;
  END IF;

  SELECT pg_get_functiondef(proc.oid)
    INTO v_definition
  FROM pg_proc proc
  WHERE proc.oid = v_signature::oid
    AND proc.proowner = v_owner
    AND proc.proacl IS NOT DISTINCT FROM v_acl
    AND proc.proconfig IS NOT DISTINCT FROM v_config;
  IF NOT FOUND OR v_definition !~* v_child_first THEN
    RAISE EXCEPTION 'Profit Close V2 lock rewrite changed metadata or failed'
      USING ERRCODE = '55000';
  END IF;
END;
$align_profit_close_item_lock_order$;

CREATE OR REPLACE FUNCTION app_private.assert_profit_payout_linkage_v2(
  p_voucher_id uuid,
  p_allow_provisional boolean DEFAULT false,
  p_require_fully_reserved boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
DECLARE
  v_voucher public.income_expenses%ROWTYPE;
  v_request public.approval_requests%ROWTYPE;
  v_reservation_count integer;
  v_canonical_count integer;
  v_legacy_count integer;
  v_null_request_count integer;
  v_distinct_request_count integer;
  v_identity_mismatch_count integer;
  v_hash_mismatch_count integer;
  v_reservation_total numeric;
  v_exception_total numeric;
  v_request_count integer;
  v_request_id uuid;
  v_item_count integer;
  v_bad_item_count integer;
  v_item_total numeric;
BEGIN
  SELECT voucher.* INTO v_voucher
  FROM public.income_expenses voucher
  WHERE voucher.id = p_voucher_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profit payout voucher is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE reservation.reservation_source = 'CANONICAL_V1'
    )::integer,
    count(*) FILTER (
      WHERE reservation.reservation_source = 'LEGACY_BACKFILL'
    )::integer,
    count(*) FILTER (
      WHERE reservation.approval_request_id IS NULL
    )::integer,
    count(DISTINCT reservation.approval_request_id)::integer,
    count(*) FILTER (
      WHERE reservation.organization_id IS DISTINCT FROM
              v_voucher.organization_id
         OR reservation.shareholder_id IS DISTINCT FROM
              v_voucher.shareholder_id
    )::integer,
    count(*) FILTER (
      WHERE reservation.reservation_source = 'CANONICAL_V1'
        AND reservation.source_payload_hash IS DISTINCT FROM
            v_voucher.source_payload_hash
    )::integer,
    COALESCE(sum(reservation.amount), 0),
    (array_agg(
      reservation.approval_request_id
      ORDER BY reservation.approval_request_id
    ) FILTER (
      WHERE reservation.approval_request_id IS NOT NULL
    ))[1]
    INTO
      v_reservation_count,
      v_canonical_count,
      v_legacy_count,
      v_null_request_count,
      v_distinct_request_count,
      v_identity_mismatch_count,
      v_hash_mismatch_count,
      v_reservation_total,
      v_request_id
  FROM public.profit_payout_reservations reservation
  WHERE reservation.payout_voucher_id = p_voucher_id;

  SELECT count(*)::integer,
         (array_agg(
           request_row.id
           ORDER BY request_row.submitted_at DESC, request_row.id DESC
         ))[1]
    INTO v_request_count, v_request_id
  FROM public.approval_requests request_row
  WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
    AND request_row.subject_id = p_voucher_id
    AND request_row.system_source = 'profit.distribution'
    AND (
      v_request_id IS NULL
      OR request_row.id = v_request_id
    );

  IF v_reservation_count = 0 AND v_request_count = 0 THEN
    RETURN;
  END IF;
  IF v_reservation_count = 0 THEN
    RAISE EXCEPTION 'Profit payout request has no allocation reservations'
      USING ERRCODE = '55000';
  END IF;
  IF v_voucher.deleted_at IS NOT NULL
     OR v_voucher.type IS DISTINCT FROM 'EXPENSE'
     OR v_voucher.shareholder_id IS NULL
     OR v_voucher.account_id IS NULL
     OR v_voucher.building_id IS NULL
     OR v_voucher.organization_id IS NULL
     OR v_voucher.voucher_date IS NULL
     OR v_voucher.total_amount IS NULL
     OR v_voucher.total_amount = 'NaN'::numeric
     OR v_voucher.total_amount <= 0
     OR v_identity_mismatch_count <> 0 THEN
    RAISE EXCEPTION 'Profit payout voucher identity no longer matches reservations'
      USING ERRCODE = '55000';
  END IF;

  IF v_canonical_count = v_reservation_count THEN
    PERFORM 1
    FROM public.buildings building_row
    JOIN public.organizations organization
      ON organization.id = building_row.organization_id
     AND organization.status = 'ACTIVE'
    WHERE building_row.id = v_voucher.building_id
      AND building_row.organization_id = v_voucher.organization_id
      AND building_row.deleted_at IS NULL
      AND building_row.is_virtual
    FOR SHARE OF building_row, organization;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Profit payout posting building is no longer active and virtual'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  PERFORM 1
  FROM public.accounts account_row
  WHERE account_row.id = v_voucher.account_id
    AND account_row.organization_id = v_voucher.organization_id
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profit payout cashbook is no longer an active real account'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    count(*)::integer,
    count(*) FILTER (
      WHERE item.organization_id IS DISTINCT FROM v_voucher.organization_id
         OR (
           v_canonical_count = v_reservation_count
           AND item.accounting_class IS DISTINCT FROM 'INTERNAL'
         )
    )::integer,
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
    INTO v_item_count, v_bad_item_count, v_item_total
  FROM public.income_expense_items item
  WHERE item.income_expense_id = p_voucher_id;
  IF v_item_count < 1
     OR v_bad_item_count <> 0
     OR abs(v_item_total - v_voucher.total_amount) >= 0.01 THEN
    RAISE EXCEPTION 'Profit payout items no longer match the voucher amount'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(sum(exception.amount), 0)
    INTO v_exception_total
  FROM public.profit_payout_exceptions exception
  WHERE exception.payout_voucher_id = p_voucher_id
    AND exception.resolved_at IS NULL;

  IF p_require_fully_reserved AND (
    v_exception_total <> 0
    OR abs(v_reservation_total - v_voucher.total_amount) >= 0.01
  ) THEN
    RAISE EXCEPTION 'Profit payout cannot post without full live reservations'
      USING ERRCODE = '55000';
  END IF;

  IF v_canonical_count = v_reservation_count THEN
    IF v_legacy_count <> 0
       OR v_voucher.system_source IS DISTINCT FROM 'profit.distribution'
       OR v_voucher.source_payload_hash IS NULL
       OR v_voucher.source_payload_hash !~ '^[0-9a-f]{32}$'
       OR v_hash_mismatch_count <> 0
       OR v_exception_total <> 0
       OR abs(v_reservation_total - v_voucher.total_amount) >= 0.01 THEN
      RAISE EXCEPTION 'Canonical profit payout reservation payload is inconsistent'
        USING ERRCODE = '55000';
    END IF;

    IF v_null_request_count = v_reservation_count
       AND p_allow_provisional THEN
      SELECT count(*)::integer,
             (array_agg(
               request_row.id
               ORDER BY request_row.submitted_at DESC, request_row.id DESC
             ))[1]
        INTO v_request_count, v_request_id
      FROM public.approval_requests request_row
      WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
        AND request_row.subject_id = p_voucher_id
        AND request_row.system_source = 'profit.distribution';
      IF v_request_count <> 1 THEN
        RAISE EXCEPTION 'Provisional profit payout must have exactly one request'
          USING ERRCODE = '55000';
      END IF;
    ELSIF v_null_request_count <> 0 OR v_distinct_request_count <> 1 THEN
      RAISE EXCEPTION 'Canonical profit payout reservations disagree on request'
        USING ERRCODE = '55000';
    END IF;

    SELECT request_row.* INTO v_request
    FROM public.approval_requests request_row
    WHERE request_row.id = v_request_id
      AND request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.subject_id = p_voucher_id;
    IF NOT FOUND
       OR v_request.organization_id IS DISTINCT FROM v_voucher.organization_id
       OR v_request.system_source IS DISTINCT FROM 'profit.distribution'
       OR v_request.payload_hash IS DISTINCT FROM v_voucher.source_payload_hash
       OR v_request.amount IS DISTINCT FROM v_voucher.total_amount
       OR v_request.cashbook_id IS DISTINCT FROM v_voucher.account_id
       OR v_request.building_id IS DISTINCT FROM v_voucher.building_id
       OR v_request.payload_snapshot->>'subject_id' IS DISTINCT FROM
            v_voucher.id::text
       OR (v_request.payload_snapshot->>'amount')::numeric IS DISTINCT FROM
            v_voucher.total_amount
       OR v_request.payload_snapshot->>'account_id' IS DISTINCT FROM
            v_voucher.account_id::text
       OR v_request.payload_snapshot->>'building_id' IS DISTINCT FROM
            v_voucher.building_id::text
       OR v_request.payload_snapshot->>'type' IS DISTINCT FROM
            v_voucher.type::text
       OR v_request.payload_snapshot->>'source_payload_hash' IS DISTINCT FROM
            v_voucher.source_payload_hash THEN
      RAISE EXCEPTION 'Profit payout approval request payload is inconsistent'
        USING ERRCODE = '55000';
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM app_private.income_expense_flow_ownership ownership
      WHERE ownership.income_expense_id = p_voucher_id
        AND ownership.organization_id = v_voucher.organization_id
        AND ownership.writer_operation = 'shareholder_profit.distribute.v2'
        AND ownership.payload_hash_scheme = 'PG_MD5_JSONB_TEXT_V1'
        AND ownership.payload_hash_value = v_voucher.source_payload_hash
    ) THEN
      RAISE EXCEPTION 'Canonical profit payout is not flow-owned'
        USING ERRCODE = '55000';
    END IF;
  ELSIF v_legacy_count = v_reservation_count THEN
    IF v_canonical_count <> 0
       OR v_null_request_count <> v_reservation_count
       OR v_request_count <> 0
       OR abs(
         v_reservation_total + v_exception_total - v_voucher.total_amount
       ) >= 0.01 THEN
      RAISE EXCEPTION 'Legacy profit payout reservation coverage is inconsistent'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    RAISE EXCEPTION 'Profit payout mixes canonical and legacy reservations'
      USING ERRCODE = '55000';
  END IF;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.assert_profit_payout_fresh_v2(
  p_voucher_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
BEGIN
  PERFORM app_private.lock_profit_payout_sources_v2();

  PERFORM 1
  FROM public.profit_payout_reservations reservation
  JOIN public.profit_allocations allocation
    ON allocation.id = reservation.profit_allocation_id
   AND allocation.organization_id = reservation.organization_id
  JOIN public.profit_monthly profit
    ON profit.id = allocation.profit_monthly_id
   AND profit.organization_id = reservation.organization_id
  WHERE reservation.payout_voucher_id = p_voucher_id
  ORDER BY profit.period_month, profit.building_id, allocation.id
  FOR UPDATE OF reservation, allocation, profit;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profit payout has no lockable allocation reservations'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_payout_reservations reservation
    JOIN public.profit_allocations allocation
      ON allocation.id = reservation.profit_allocation_id
     AND allocation.organization_id = reservation.organization_id
    JOIN public.profit_monthly profit
      ON profit.id = allocation.profit_monthly_id
     AND profit.organization_id = reservation.organization_id
    JOIN public.income_expenses voucher
      ON voucher.id = reservation.payout_voucher_id
    WHERE reservation.payout_voucher_id = p_voucher_id
      AND (
        profit.status IS DISTINCT FROM 'LOCKED'
        OR profit.is_stale
        OR profit.period_month >
           date_trunc('month', voucher.voucher_date)::date
        OR NOT app_private.profit_monthly_source_is_current_v1(profit.id)
      )
  ) THEN
    RAISE EXCEPTION 'Profit payout approval blocked by stale locked allocations'
      USING ERRCODE = '55000';
  END IF;
END
$fn$;

-- Every AUTO_POST, normal approval, self-approval, and emergency approval of a
-- flow-owned voucher converges on this transition through post_financial_request_v1.
-- Payout freshness must therefore be locked before the UPDATE takes its
-- ROW EXCLUSIVE table lock; doing this in a BEFORE UPDATE trigger deadlocks when
-- concurrent approvals attempt to upgrade their locks.
CREATE OR REPLACE FUNCTION app_private.transition_canonical_income_expense_v1(
  p_income_expense_id uuid,
  p_new_approval_status text,
  p_posting_id uuid,
  p_reversed_by_posting_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, app_private, public
AS $fn$
DECLARE
  v_rows integer;
  v_linked_profit_payout boolean;
  v_core_writer boolean;
BEGIN
  IF NOT app_private.is_income_expense_flow_owned(p_income_expense_id) THEN
    RAISE EXCEPTION 'not a canonical row: %', p_income_expense_id
      USING ERRCODE = '55000';
  END IF;
  IF p_new_approval_status NOT IN (
    'APPROVED', 'CANCELLED', 'REVERSED', 'DENIED', 'REJECTED'
  ) THEN
    RAISE EXCEPTION 'illegal transition target %', p_new_approval_status
      USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.profit_payout_reservations reservation
    WHERE reservation.payout_voucher_id = p_income_expense_id
    UNION ALL
    SELECT 1
    FROM public.approval_requests request_row
    WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.subject_id = p_income_expense_id
      AND request_row.system_source = 'profit.distribution'
  ) INTO v_linked_profit_payout;

  IF p_new_approval_status = 'APPROVED' AND v_linked_profit_payout THEN
    SELECT EXISTS (
      SELECT 1
      FROM app_private.accounting_chain_writer_xids capability
      WHERE capability.transaction_id = txid_current()
        AND capability.backend_pid = pg_backend_pid()
    ) INTO v_core_writer;

    -- Acquire source locks before linkage row locks and before the voucher write.
    PERFORM app_private.assert_profit_payout_fresh_v2(p_income_expense_id);
    PERFORM app_private.assert_profit_payout_linkage_v2(
      p_income_expense_id, v_core_writer, true
    );
  END IF;

  INSERT INTO app_private.ie_transition_authorization (
    income_expense_id, xid, purpose
  ) VALUES (
    p_income_expense_id, pg_current_xact_id(), p_new_approval_status
  );

  UPDATE public.income_expenses
     SET approval_status = p_new_approval_status,
         posting_id = COALESCE(p_posting_id, posting_id),
         posted_at_v2 = CASE
           WHEN p_new_approval_status = 'APPROVED' THEN clock_timestamp()
           ELSE posted_at_v2
         END,
         reversed_by_posting_id = COALESCE(
           p_reversed_by_posting_id, reversed_by_posting_id
         )
   WHERE id = p_income_expense_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  DELETE FROM app_private.ie_transition_authorization
  WHERE income_expense_id = p_income_expense_id
    AND xid = pg_current_xact_id();

  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'transition affected % rows (expected 1)', v_rows
      USING ERRCODE = '55000';
  END IF;
END
$fn$;

-- Preserve the approval engine ACL/owner with CREATE OR REPLACE. Profit payout
-- requests take the source lock before any voucher tuple lock, so a rejected
-- direct UPDATE cannot hold ROW EXCLUSIVE while waiting on that tuple.
CREATE OR REPLACE FUNCTION app_private.post_financial_request_v1(
  p_request_id uuid,
  p_expected_version bigint,
  p_actor uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, app_private, public
AS $fn$
DECLARE
  v_req public.approval_requests;
  v_ie public.income_expenses;
  v_posting uuid := gen_random_uuid();
  v_rows integer;
BEGIN
  SELECT * INTO v_req
  FROM public.approval_requests
  WHERE id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.version <> p_expected_version THEN
    RAISE EXCEPTION 'version conflict' USING ERRCODE = '40001';
  END IF;
  IF v_req.state <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'request not postable from state %', v_req.state
      USING ERRCODE = '55000';
  END IF;
  IF v_req.posted_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'request already posted' USING ERRCODE = '55000';
  END IF;

  IF v_req.system_source = 'profit.distribution' THEN
    PERFORM app_private.lock_profit_payout_sources_v2();
  END IF;

  SELECT * INTO v_ie
  FROM public.income_expenses
  WHERE id = v_req.subject_id
    AND organization_id = v_req.organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subject missing' USING ERRCODE = 'P0002';
  END IF;
  IF v_ie.approval_status = 'APPROVED' OR v_ie.posting_id IS NOT NULL THEN
    RAISE EXCEPTION 'subject already posted' USING ERRCODE = '55000';
  END IF;

  IF app_private.is_income_expense_flow_owned(v_req.subject_id) THEN
    PERFORM app_private.transition_canonical_income_expense_v1(
      v_req.subject_id, 'APPROVED', v_posting, NULL
    );
  ELSE
    UPDATE public.income_expenses
       SET approval_status = 'APPROVED',
           posting_id = v_posting,
           posted_at_v2 = clock_timestamp()
     WHERE id = v_req.subject_id;
  END IF;

  UPDATE public.approval_requests
     SET state = 'POSTED',
         posted_at = clock_timestamp(),
         posted_event_id = v_posting,
         version = version + 1
   WHERE id = p_request_id
     AND version = p_expected_version;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'posting affected % request rows (expected 1)', v_rows
      USING ERRCODE = '55000';
  END IF;

  RETURN v_posting;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.decide_financial_request_v1(
  p_request_id uuid,
  p_expected_version bigint,
  p_actor_membership uuid,
  p_actor_user uuid,
  p_decision text,
  p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, app_private, public
AS $fn$
DECLARE
  v_req public.approval_requests;
  v_ie public.income_expenses;
  v_posting uuid;
  v_step public.approval_request_steps;
  v_next_pending uuid;
BEGIN
  IF p_decision NOT IN ('APPROVE', 'REJECT') THEN
    RAISE EXCEPTION 'invalid decision %', p_decision USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_req
  FROM public.approval_requests
  WHERE id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_req.version <> p_expected_version THEN
    RAISE EXCEPTION 'version conflict' USING ERRCODE = '40001';
  END IF;
  IF v_req.state <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'request not decidable from %', v_req.state
      USING ERRCODE = '55000';
  END IF;

  IF p_actor_membership = v_req.maker_membership_id
     OR p_actor_user = v_req.maker_user_id THEN
    RAISE EXCEPTION 'maker cannot approve own request' USING ERRCODE = '42501';
  END IF;

  IF p_decision = 'APPROVE'
     AND v_req.system_source = 'profit.distribution' THEN
    PERFORM app_private.lock_profit_payout_sources_v2();
  END IF;

  SELECT * INTO v_ie
  FROM public.income_expenses
  WHERE id = v_req.subject_id
    AND organization_id = v_req.organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subject missing' USING ERRCODE = 'P0002';
  END IF;
  IF v_ie.source_payload_hash IS NULL
     OR v_req.payload_hash IS NULL
     OR v_req.payload_hash <> v_ie.source_payload_hash THEN
    RAISE EXCEPTION 'subject changed or lost its snapshot hash (fail-closed)'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO v_step
  FROM public.approval_request_steps
  WHERE request_id = p_request_id
    AND status = 'PENDING'
  ORDER BY step_no
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no PENDING step to decide' USING ERRCODE = '55000';
  END IF;

  IF NOT app_private.is_eligible_current_candidate_v1(
    v_step.id, p_actor_membership
  ) THEN
    RAISE EXCEPTION 'actor is not an eligible candidate for this step'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.approval_decisions (
    organization_id, request_id, request_step_id, actor_membership_id,
    actor_user_id, decision, reason, request_version
  ) VALUES (
    v_req.organization_id, p_request_id, v_step.id, p_actor_membership,
    p_actor_user,
    CASE p_decision
      WHEN 'APPROVE' THEN 'CHECKER_APPROVE'
      ELSE 'CHECKER_REJECT'
    END,
    p_reason, v_req.version
  );

  IF p_decision = 'REJECT' THEN
    UPDATE public.approval_request_steps
       SET status = 'REJECTED'
     WHERE id = v_step.id;
    UPDATE public.approval_requests
       SET state = 'REJECTED', version = version + 1
     WHERE id = p_request_id
       AND version = p_expected_version;
    RETURN NULL;
  END IF;

  IF NOT app_private.step_is_satisfied_v1(v_step.id) THEN
    RETURN NULL;
  END IF;
  UPDATE public.approval_request_steps
     SET status = 'APPROVED'
   WHERE id = v_step.id;

  SELECT id INTO v_next_pending
  FROM public.approval_request_steps
  WHERE request_id = p_request_id
    AND status = 'WAITING'
  ORDER BY step_no
  LIMIT 1;
  IF v_next_pending IS NOT NULL THEN
    UPDATE public.approval_request_steps
       SET status = 'PENDING'
     WHERE id = v_next_pending;
    RETURN NULL;
  END IF;

  v_posting := app_private.post_financial_request_v1(
    p_request_id, v_req.version, p_actor_user
  );
  RETURN v_posting;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.guard_profit_payout_linked_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
DECLARE
  v_linked boolean;
  v_transition_authorized boolean;
  v_core_writer boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.profit_payout_reservations reservation
    WHERE reservation.payout_voucher_id = OLD.id
    UNION ALL
    SELECT 1
    FROM public.approval_requests request_row
    WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.subject_id = OLD.id
      AND request_row.system_source = 'profit.distribution'
  ) INTO v_linked;
  IF NOT v_linked THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Linked profit payout vouchers cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.ie_transition_authorization transition_row
    WHERE transition_row.income_expense_id = OLD.id
      AND transition_row.xid = pg_current_xact_id()
  ) INTO v_transition_authorized;
  IF NOT v_transition_authorized THEN
    RAISE EXCEPTION 'Linked profit payout payload is immutable outside approval transitions'
      USING ERRCODE = '55000';
  END IF;

  IF (
    to_jsonb(OLD) - ARRAY[
      'approval_status', 'posting_id', 'posted_at_v2',
      'reversed_by_posting_id', 'updated_at', 'approved_by', 'approved_at',
      'verified_at', 'verified_by', 'verified_by_name', 'verified_note'
    ]::text[]
  ) IS DISTINCT FROM (
    to_jsonb(NEW) - ARRAY[
      'approval_status', 'posting_id', 'posted_at_v2',
      'reversed_by_posting_id', 'updated_at', 'approved_by', 'approved_at',
      'verified_at', 'verified_by', 'verified_by_name', 'verified_note'
    ]::text[]
  ) THEN
    RAISE EXCEPTION 'Profit payout transition may only change lifecycle columns'
      USING ERRCODE = '55000';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  PERFORM app_private.assert_profit_payout_linkage_v2(
    OLD.id,
    v_core_writer,
    NEW.approval_status = 'APPROVED'
      AND OLD.approval_status IS DISTINCT FROM 'APPROVED'
  );
  RETURN NEW;
END
$fn$;

CREATE OR REPLACE FUNCTION app_private.guard_profit_payout_item_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
DECLARE
  v_linked boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM public.profit_payout_reservations reservation
    WHERE reservation.payout_voucher_id IN (
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.income_expense_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.income_expense_id END
    )
    UNION ALL
    SELECT 1
    FROM public.approval_requests request_row
    WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.system_source = 'profit.distribution'
      AND request_row.subject_id IN (
        CASE WHEN TG_OP <> 'INSERT' THEN OLD.income_expense_id END,
        CASE WHEN TG_OP <> 'DELETE' THEN NEW.income_expense_id END
      )
  ) INTO v_linked;
  IF v_linked THEN
    RAISE EXCEPTION 'Items of a linked profit payout are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

DROP TRIGGER IF EXISTS a05_profit_payout_linked_guard
  ON public.income_expenses;
CREATE TRIGGER a05_profit_payout_linked_guard
BEFORE UPDATE OR DELETE ON public.income_expenses
FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_payout_linked_v2();

DROP TRIGGER IF EXISTS a05_profit_payout_item_guard
  ON public.income_expense_items;
CREATE TRIGGER a05_profit_payout_item_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.income_expense_items
FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_payout_item_v2();

DO $assert_profit_payout_links$
DECLARE
  v_voucher_id uuid;
BEGIN
  FOR v_voucher_id IN
    SELECT reservation.payout_voucher_id
    FROM public.profit_payout_reservations reservation
    UNION
    SELECT request_row.subject_id
    FROM public.approval_requests request_row
    WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.system_source = 'profit.distribution'
  LOOP
    PERFORM app_private.assert_profit_payout_linkage_v2(
      v_voucher_id, false, false
    );
  END LOOP;
END
$assert_profit_payout_links$;

CREATE OR REPLACE FUNCTION public._guard_profit_payout_insert_v2()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public
AS $fn$
DECLARE
  v_core_writer boolean;
  v_has_reservation boolean;
  v_has_request boolean;
  v_is_payout boolean := false;
BEGIN
  IF NEW.shareholder_id IS NOT NULL THEN
    v_is_payout := true;
  END IF;
  IF NEW.system_source = 'profit.distribution' THEN
    v_is_payout := true;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    OLD.shareholder_id IS NOT NULL
    OR OLD.system_source = 'profit.distribution'
  ) THEN
    v_is_payout := true;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.profit_payout_reservations reservation
    WHERE reservation.payout_voucher_id = NEW.id
  ) INTO v_has_reservation;
  SELECT EXISTS (
    SELECT 1
    FROM public.approval_requests request_row
    WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.subject_id = NEW.id
      AND request_row.system_source = 'profit.distribution'
  ) INTO v_has_request;
  v_is_payout := v_is_payout OR v_has_reservation OR v_has_request;

  IF v_is_payout THEN
    IF NEW.shareholder_id IS NULL THEN
      RAISE EXCEPTION 'Shareholder payout cannot clear its shareholder identity'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.account_id IS NULL THEN
      RAISE EXCEPTION 'Shareholder payout requires a real cashbook account'
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = NEW.account_id
      AND account_row.organization_id = NEW.organization_id
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shareholder payout account must be an active real cashbook in the same organization'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.profit_payout_reservations reservation
      WHERE reservation.payout_voucher_id = NEW.id
        AND (
          reservation.organization_id IS DISTINCT FROM NEW.organization_id
          OR reservation.shareholder_id IS DISTINCT FROM NEW.shareholder_id
        )
    ) THEN
      RAISE EXCEPTION 'Shareholder payout no longer matches its reservation identity'
        USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.approval_requests request_row
      WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
        AND request_row.subject_id = NEW.id
        AND request_row.system_source = 'profit.distribution'
        AND (
          request_row.organization_id IS DISTINCT FROM NEW.organization_id
          OR request_row.cashbook_id IS DISTINCT FROM NEW.account_id
        )
    ) THEN
      RAISE EXCEPTION 'Shareholder payout no longer matches its approval request'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF v_is_payout
     AND (
       TG_OP = 'INSERT'
       OR NEW.shareholder_id IS DISTINCT FROM OLD.shareholder_id
     )
     AND NOT v_core_writer THEN
    RAISE EXCEPTION 'Shareholder payout must use distribute_shareholder_profit_v1'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS guard_profit_payout_insert_v2 ON public.income_expenses;
DROP TRIGGER IF EXISTS a00_00_profit_payout_account_guard
  ON public.income_expenses;
CREATE TRIGGER a00_00_profit_payout_account_guard
BEFORE INSERT OR UPDATE OF shareholder_id, account_id ON public.income_expenses
FOR EACH ROW EXECUTE FUNCTION public._guard_profit_payout_insert_v2();

INSERT INTO app_private.server_feature_flags (
  feature_key, domain, risk_class, mode, reason
)
VALUES (
  'shareholder_profit.distribute.v2', 'profit', 'MONEY', 'SHADOW',
  'Allocation-bound shareholder payout with pending-request reservation'
)
ON CONFLICT (feature_key) DO UPDATE
SET domain = EXCLUDED.domain,
    risk_class = EXCLUDED.risk_class,
    reason = EXCLUDED.reason,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.distribute_shareholder_profit_v1(
  p_shareholder_id uuid,
  p_amount numeric,
  p_account_id uuid,
  p_voucher_date date,
  p_note text,
  p_idempotency_key text
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_org uuid;
  v_building uuid;
  v_owner uuid;
  v_type uuid;
  v_membership uuid;
  v_subject_name text;
  v_authz boolean;
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_route text;
  v_voucher uuid;
  v_request uuid;
  v_name text;
  v_response json;
  v_remaining numeric;
  v_available numeric;
  v_take numeric;
  v_allocation record;
  v_reservations jsonb := '[]'::jsonb;
  c_operation constant text := 'shareholder_profit.distribute.v2';
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key phải dài 8-200 ký tự ASCII an toàn'
      USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount = 'NaN'::numeric
     OR p_amount <= 0 OR round(p_amount, 2) <> p_amount THEN
    RAISE EXCEPTION 'Số tiền chia lợi nhuận không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF p_account_id IS NULL OR p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Thiếu sổ quỹ hoặc ngày chi' USING ERRCODE = '22023';
  END IF;

  SELECT shareholder.organization_id,
         COALESCE(NULLIF(btrim(shareholder.name), ''), 'Cổ đông')
    INTO v_org, v_subject_name
  FROM public.shareholders shareholder
  WHERE shareholder.id = p_shareholder_id
    AND shareholder.deleted_at IS NULL
    AND shareholder.is_active
  FOR SHARE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy cổ đông trong tổ chức hợp lệ'
      USING ERRCODE = '42501';
  END IF;

  SELECT building.id, building.user_id
    INTO v_building, v_owner
  FROM public.buildings building
  JOIN public.organizations organization
    ON organization.id = building.organization_id AND organization.status = 'ACTIVE'
  WHERE building.organization_id = v_org
    AND building.is_virtual
    AND building.deleted_at IS NULL
  ORDER BY building.created_at
  LIMIT 1
  FOR SHARE OF building, organization;
  IF v_building IS NULL THEN
    RAISE EXCEPTION 'Tổ chức chưa có tòa ảo để hạch toán chia lợi nhuận'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1 FROM public.accounts account_row
  WHERE account_row.id = p_account_id
    AND account_row.organization_id = v_org
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sổ quỹ tiền thật không hợp lệ hoặc không thuộc tổ chức'
      USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'shareholder_profit.distribute', v_building, p_account_id
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền chia lợi nhuận'
      USING ERRCODE = '42501';
  END IF;

  SELECT membership.id INTO v_membership
  FROM public.organization_memberships membership
  WHERE membership.user_id = v_actor
    AND membership.organization_id = v_org
    AND membership.status = 'ACTIVE'
    AND membership.valid_from <= clock_timestamp()
    AND (membership.valid_to IS NULL OR membership.valid_to > clock_timestamp())
  LIMIT 1
  FOR SHARE;
  IF v_membership IS NULL THEN
    RAISE EXCEPTION 'Không còn là thành viên tổ chức' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'shareholder_id', p_shareholder_id,
    'amount', round(p_amount, 2),
    'account_id', p_account_id,
    'voucher_date', p_voucher_date,
    'note', NULLIF(btrim(COALESCE(p_note, '')), ''),
    'organization_id', v_org
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, c_operation, p_shareholder_id::text, v_actor, v_key, v_hash
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = c_operation
    AND operation_row.subject_scope = p_shareholder_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key đã dùng với nội dung khác'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload::json;
  END IF;

  v_route := app_private.evaluate_feature_route(c_operation, v_org);
  IF v_route = 'FROZEN' THEN
    RAISE EXCEPTION 'Writer chia lợi nhuận đang bị đóng băng'
      USING ERRCODE = '55000';
  ELSIF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Writer chia lợi nhuận chưa bật' USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.lock_profit_payout_sources_v2();

  v_remaining := p_amount;
  FOR v_allocation IN
    SELECT pa.id, pa.amount, pm.period_month, pm.building_id
    FROM public.profit_allocations pa
    JOIN public.profit_monthly pm ON pm.id = pa.profit_monthly_id
    WHERE pa.organization_id = v_org
      AND pa.shareholder_id = p_shareholder_id
      AND pa.amount > 0
      AND pm.status = 'LOCKED'
      AND NOT pm.is_stale
      AND pm.period_month <= date_trunc('month', p_voucher_date)::date
      AND app_private.profit_monthly_source_is_current_v1(pm.id)
    ORDER BY pm.period_month, pm.building_id, pa.id
    FOR UPDATE OF pa, pm
  LOOP
    EXIT WHEN v_remaining < 0.01;
    v_available := GREATEST(
      v_allocation.amount - public._profit_allocation_reserved_v2(v_allocation.id),
      0
    );
    IF v_available < 0.01 THEN
      CONTINUE;
    END IF;

    v_take := LEAST(v_remaining, v_available);
    v_reservations := v_reservations || jsonb_build_array(jsonb_build_object(
      'profit_allocation_id', v_allocation.id,
      'period_month', v_allocation.period_month,
      'building_id', v_allocation.building_id,
      'amount', v_take
    ));
    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining >= 0.01 THEN
    RAISE EXCEPTION 'Số tiền chi vượt lợi nhuận đã chốt còn khả dụng: thiếu %', v_remaining
      USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.claim_feature_operation_v1(
    c_operation,
    v_org,
    p_shareholder_id::text,
    v_actor,
    v_key,
    round(p_amount, 2)
  );

  SELECT COALESCE(NULLIF(btrim(profile.full_name), ''),
                  NULLIF(btrim(profile.email), ''), 'Người dùng')
    INTO v_actor_name
  FROM public.profiles profile
  WHERE profile.id = v_actor;

  SELECT type_row.id INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'expense'
    AND type_row.name = 'Chia lợi nhuận cổ đông'
  ORDER BY type_row.created_at
  LIMIT 1;
  IF v_type IS NULL THEN
    INSERT INTO public.income_expense_types (
      user_id, organization_id, name, type, category,
      is_default, is_deposit, description
    ) VALUES (
      v_owner, v_org, 'Chia lợi nhuận cổ đông', 'expense', 'Chia lợi nhuận',
      false, false, 'Chi từ lợi nhuận đã chốt; không tính lại vào KQKD'
    ) RETURNING id INTO v_type;
  END IF;

  v_name := COALESCE(
    NULLIF(btrim(COALESCE(p_note, '')), ''),
    'Chia lợi nhuận: ' || v_subject_name
  );
  PERFORM app_private.begin_accounting_chain_write_v1();

  INSERT INTO public.income_expenses (
    user_id, organization_id, creator_name, type, name,
    building_id, account_id, shareholder_id,
    business_result_accounting, approval_status, voucher_date,
    attachments, repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    source_payload_hash, system_source, idempotency_key
  ) VALUES (
    v_owner, v_org, COALESCE(v_actor_name, 'Người dùng'), 'EXPENSE', v_name,
    v_building, p_account_id, p_shareholder_id,
    false, 'UNAPPROVED', p_voucher_date,
    '[]'::jsonb, 'NONE', false, 0, 0,
    v_hash, 'profit.distribution', v_key
  ) RETURNING id INTO v_voucher;

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date,
    accounting_class
  ) VALUES (
    v_voucher, v_org, v_type,
    NULLIF(btrim(COALESCE(p_note, '')), ''),
    1, round(p_amount, 2), round(p_amount, 2),
    p_voucher_date, p_voucher_date, 'INTERNAL'
  );

  INSERT INTO app_private.income_expense_flow_ownership (
    income_expense_id, organization_id, flow_kind, flow_version,
    lifecycle_owner, lifecycle_state, writer_operation,
    payload_hash_scheme, payload_hash_value, maker_user_id,
    claimed_by_user_id, correlation_id
  ) VALUES (
    v_voucher, v_org, 'SHAREHOLDER_PROFIT_PAYOUT_V2', 2,
    'APPROVAL_ENGINE_V2', 'DRAFT', c_operation,
    'PG_MD5_JSONB_TEXT_V1', v_hash, v_actor,
    v_actor, v_voucher
  );

  -- Reserve before submission so AUTO_POST cannot approve an uncovered payout.
  INSERT INTO public.profit_payout_reservations (
    organization_id, profit_allocation_id, shareholder_id,
    payout_voucher_id, approval_request_id, amount,
    reservation_source, source_payload_hash, created_by
  )
  SELECT
    v_org,
    (entry.value->>'profit_allocation_id')::uuid,
    p_shareholder_id,
    v_voucher,
    NULL,
    (entry.value->>'amount')::numeric,
    'CANONICAL_V1',
    v_hash,
    v_actor
  FROM jsonb_array_elements(v_reservations) entry(value);

  v_request := app_private.submit_financial_request_v1(
    v_voucher, v_membership, v_actor, v_key || '-sub'
  );

  UPDATE public.profit_payout_reservations reservation
     SET approval_request_id = v_request
   WHERE reservation.payout_voucher_id = v_voucher
     AND reservation.reservation_source = 'CANONICAL_V1'
     AND reservation.approval_request_id IS NULL;

  PERFORM app_private.assert_profit_payout_linkage_v2(
    v_voucher, false, true
  );

  v_response := json_build_object(
    'profit_voucher_id', v_voucher,
    'approval_request_id', v_request,
    'shareholder_id', p_shareholder_id,
    'reserved_allocations', v_reservations,
    'state', 'PENDING_APPROVAL'
  );

  UPDATE app_private.canonical_write_operations
     SET subject_id = v_voucher,
         response_payload = to_jsonb(v_response),
         completed_at = clock_timestamp()
   WHERE organization_id = v_org
     AND operation = c_operation
     AND subject_scope = p_shareholder_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END
$fn$;

REVOKE ALL ON FUNCTION public._profit_allocation_reserved_v2(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app_private.lock_profit_payout_sources_v2()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.assert_profit_payout_linkage_v2(
  uuid,boolean,boolean
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.assert_profit_payout_fresh_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_payout_linked_v2()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_payout_item_v2()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._guard_profit_payout_insert_v2()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.distribute_shareholder_profit_v1(
  uuid,numeric,uuid,date,text,text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.distribute_shareholder_profit_v1(
  uuid,numeric,uuid,date,text,text
) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
