-- Effective-dated finance-role mapping and fail-closed break-even analytics for
-- the standalone Business Performance page.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS income_expense_types_id_organization_uq
  ON public.income_expense_types(id, organization_id);

CREATE TABLE public.finance_reporting_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  income_expense_type_id uuid NOT NULL,
  finance_reporting_role text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT finance_reporting_role_assignments_type_org_fkey
    FOREIGN KEY (income_expense_type_id, organization_id)
    REFERENCES public.income_expense_types(id, organization_id)
    ON DELETE RESTRICT,
  CONSTRAINT finance_reporting_role_assignments_role_check CHECK (
    finance_reporting_role IN (
      'ROOM_RENT_REVENUE',
      'OTHER_OPERATING_REVENUE',
      'PASS_THROUGH_REVENUE',
      'LANDLORD_RENT_FIXED',
      'OTHER_FIXED_COST',
      'ROOM_VARIABLE_COST',
      'OTHER_VARIABLE_COST',
      'PASS_THROUGH_EXPENSE',
      'OUTSIDE_BREAK_EVEN_MODEL'
    )
  ),
  CONSTRAINT finance_reporting_role_assignments_effective_range_check CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);

CREATE UNIQUE INDEX finance_reporting_role_assignments_start_uq
  ON public.finance_reporting_role_assignments(
    organization_id,
    income_expense_type_id,
    effective_from
  );
CREATE INDEX finance_reporting_role_assignments_lookup_idx
  ON public.finance_reporting_role_assignments(
    organization_id,
    income_expense_type_id,
    effective_from,
    effective_to
  );

ALTER TABLE public.finance_reporting_role_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.finance_reporting_role_assignments FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION app_private.guard_finance_reporting_role_assignment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $guard_finance_reporting_role_assignment$
DECLARE
  v_side text;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      NEW.organization_id::text || ':' || NEW.income_expense_type_id::text,
      0
    )
  );

  SELECT upper(type_row.type)
    INTO v_side
  FROM public.income_expense_types type_row
  WHERE type_row.id = NEW.income_expense_type_id
    AND type_row.organization_id = NEW.organization_id
    AND NOT COALESCE(type_row.is_deposit, false);

  IF v_side IS NULL THEN
    RAISE EXCEPTION 'Finance reporting role requires a non-deposit type in the same organization'
      USING ERRCODE = '23514';
  END IF;

  IF (
    v_side = 'INCOME'
    AND NEW.finance_reporting_role NOT IN (
      'ROOM_RENT_REVENUE',
      'OTHER_OPERATING_REVENUE',
      'PASS_THROUGH_REVENUE',
      'OUTSIDE_BREAK_EVEN_MODEL'
    )
  ) OR (
    v_side = 'EXPENSE'
    AND NEW.finance_reporting_role NOT IN (
      'LANDLORD_RENT_FIXED',
      'OTHER_FIXED_COST',
      'ROOM_VARIABLE_COST',
      'OTHER_VARIABLE_COST',
      'PASS_THROUGH_EXPENSE',
      'OUTSIDE_BREAK_EVEN_MODEL'
    )
  ) OR v_side NOT IN ('INCOME', 'EXPENSE') THEN
    RAISE EXCEPTION 'Finance reporting role does not match income/expense side'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.finance_reporting_role_assignments assignment_row
    WHERE assignment_row.organization_id = NEW.organization_id
      AND assignment_row.income_expense_type_id = NEW.income_expense_type_id
      AND assignment_row.id <> NEW.id
      AND daterange(
        assignment_row.effective_from,
        COALESCE(assignment_row.effective_to, 'infinity'::date),
        '[]'
      ) && daterange(
        NEW.effective_from,
        COALESCE(NEW.effective_to, 'infinity'::date),
        '[]'
      )
  ) THEN
    RAISE EXCEPTION 'finance_reporting_role_assignments_no_overlap'
      USING ERRCODE = '23P01';
  END IF;

  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$guard_finance_reporting_role_assignment$;

REVOKE ALL ON FUNCTION app_private.guard_finance_reporting_role_assignment_v1()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER finance_reporting_role_assignments_no_overlap
BEFORE INSERT OR UPDATE ON public.finance_reporting_role_assignments
FOR EACH ROW EXECUTE FUNCTION app_private.guard_finance_reporting_role_assignment_v1();

CREATE OR REPLACE FUNCTION public.business_performance_reporting_roles_v1(
  p_organization_id uuid,
  p_month date,
  p_building_ids uuid[]
)
RETURNS TABLE(
  income_expense_type_id uuid,
  type_name text,
  side text,
  category text,
  finance_reporting_role text,
  effective_from date,
  effective_to date,
  confirmed_at timestamptz,
  confirmed_by uuid,
  suggested_role text,
  can_manage boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_reporting_roles$
DECLARE
  v_building_ids uuid[];
  v_actor uuid;
  v_can_manage boolean := false;
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => true
  ) AS scope;

  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'Finance reporting role month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;

  SELECT actor.user_id
    INTO v_actor
  FROM app_private.resolve_finance_actor_v2(p_organization_id) actor;

  SELECT decision.allowed
    INTO v_can_manage
  FROM app_private.authorize_tenant_action_v3(
    p_actor => v_actor,
    p_organization_id => p_organization_id,
    p_permission_key => 'categories.edit',
    p_building_id => NULL,
    p_cashbook_id => NULL
  ) decision;

  RETURN QUERY
  SELECT
    type_row.id,
    type_row.name,
    upper(type_row.type),
    type_row.category,
    assignment_row.finance_reporting_role,
    assignment_row.effective_from,
    assignment_row.effective_to,
    assignment_row.confirmed_at,
    assignment_row.confirmed_by,
    CASE
      WHEN upper(type_row.type) = 'EXPENSE'
       AND (
         lower(COALESCE(type_row.category, '')) LIKE '%tiền nhà%'
         OR lower(type_row.name) LIKE '%tiền nhà%'
         OR lower(COALESCE(type_row.category, '')) LIKE '%tien nha%'
         OR lower(type_row.name) LIKE '%tien nha%'
       )
        THEN 'LANDLORD_RENT_FIXED'
      WHEN upper(type_row.type) = 'INCOME'
       AND (
         lower(COALESCE(type_row.category, '')) LIKE '%tiền phòng%'
         OR lower(type_row.name) LIKE '%tiền phòng%'
         OR lower(COALESCE(type_row.category, '')) LIKE '%tien phong%'
         OR lower(type_row.name) LIKE '%tien phong%'
       )
        THEN 'ROOM_RENT_REVENUE'
      ELSE NULL
    END,
    COALESCE(v_can_manage, false)
  FROM public.income_expense_types type_row
  LEFT JOIN LATERAL (
    SELECT assignment.*
    FROM public.finance_reporting_role_assignments assignment
    WHERE assignment.organization_id = p_organization_id
      AND assignment.income_expense_type_id = type_row.id
      AND assignment.effective_from <= p_month
      AND (
        assignment.effective_to IS NULL
        OR assignment.effective_to >= p_month
      )
    ORDER BY assignment.effective_from DESC, assignment.id
    LIMIT 1
  ) assignment_row ON true
  WHERE type_row.organization_id = p_organization_id
    AND upper(type_row.type) IN ('INCOME', 'EXPENSE')
    AND NOT COALESCE(type_row.is_deposit, false)
  ORDER BY upper(type_row.type), lower(type_row.name) COLLATE "C", type_row.id;
END;
$business_performance_reporting_roles$;

REVOKE ALL ON FUNCTION public.business_performance_reporting_roles_v1(uuid, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_reporting_roles_v1(uuid, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_reporting_roles_v1(uuid, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_reporting_roles_v1(uuid, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_reporting_roles_v1(uuid, date, uuid[]) TO authenticated;

CREATE OR REPLACE FUNCTION public.business_performance_set_reporting_role_v1(
  p_organization_id uuid,
  p_income_expense_type_id uuid,
  p_finance_reporting_role text,
  p_effective_from date
)
RETURNS TABLE(
  assignment_id uuid,
  finance_reporting_role text,
  effective_from date,
  effective_to date,
  confirmed_at timestamptz,
  confirmed_by uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_set_reporting_role$
DECLARE
  v_actor uuid;
  v_allowed boolean;
  v_side text;
  v_existing_id uuid;
  v_next_start date;
  v_assignment_id uuid;
BEGIN
  IF p_organization_id IS NULL
     OR p_income_expense_type_id IS NULL
     OR p_finance_reporting_role IS NULL
     OR p_effective_from IS NULL
     OR p_effective_from <> date_trunc('month', p_effective_from)::date THEN
    RAISE EXCEPTION 'Invalid finance reporting role assignment input'
      USING ERRCODE = '22023';
  END IF;

  SELECT actor.user_id
    INTO v_actor
  FROM app_private.resolve_finance_actor_v2(p_organization_id) actor;

  SELECT decision.allowed
    INTO v_allowed
  FROM app_private.authorize_tenant_action_v3(
    p_actor => v_actor,
    p_organization_id => p_organization_id,
    p_permission_key => 'categories.edit',
    p_building_id => NULL,
    p_cashbook_id => NULL
  ) decision;
  IF NOT COALESCE(v_allowed, false) THEN
    RAISE EXCEPTION 'Business performance mapping access denied'
      USING ERRCODE = '42501';
  END IF;

  SELECT upper(type_row.type)
    INTO v_side
  FROM public.income_expense_types type_row
  WHERE type_row.id = p_income_expense_type_id
    AND type_row.organization_id = p_organization_id
    AND NOT COALESCE(type_row.is_deposit, false)
  FOR SHARE;
  IF v_side IS NULL THEN
    RAISE EXCEPTION 'Income/expense type is outside the selected organization'
      USING ERRCODE = '42501';
  END IF;

  IF (
    v_side = 'INCOME'
    AND p_finance_reporting_role NOT IN (
      'ROOM_RENT_REVENUE',
      'OTHER_OPERATING_REVENUE',
      'PASS_THROUGH_REVENUE',
      'OUTSIDE_BREAK_EVEN_MODEL'
    )
  ) OR (
    v_side = 'EXPENSE'
    AND p_finance_reporting_role NOT IN (
      'LANDLORD_RENT_FIXED',
      'OTHER_FIXED_COST',
      'ROOM_VARIABLE_COST',
      'OTHER_VARIABLE_COST',
      'PASS_THROUGH_EXPENSE',
      'OUTSIDE_BREAK_EVEN_MODEL'
    )
  ) THEN
    RAISE EXCEPTION 'Finance reporting role does not match type side'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_organization_id::text || ':' || p_income_expense_type_id::text,
      0
    )
  );

  SELECT assignment.id
    INTO v_existing_id
  FROM public.finance_reporting_role_assignments assignment
  WHERE assignment.organization_id = p_organization_id
    AND assignment.income_expense_type_id = p_income_expense_type_id
    AND assignment.effective_from = p_effective_from
  FOR UPDATE;

  IF v_existing_id IS NOT NULL THEN
    UPDATE public.finance_reporting_role_assignments assignment
    SET
      finance_reporting_role = p_finance_reporting_role,
      confirmed_at = clock_timestamp(),
      confirmed_by = v_actor,
      updated_at = clock_timestamp()
    WHERE assignment.id = v_existing_id
    RETURNING assignment.id INTO v_assignment_id;
  ELSE
    UPDATE public.finance_reporting_role_assignments assignment
    SET
      effective_to = p_effective_from - 1,
      updated_at = clock_timestamp()
    WHERE assignment.organization_id = p_organization_id
      AND assignment.income_expense_type_id = p_income_expense_type_id
      AND assignment.effective_from < p_effective_from
      AND (
        assignment.effective_to IS NULL
        OR assignment.effective_to >= p_effective_from
      );

    SELECT min(assignment.effective_from)
      INTO v_next_start
    FROM public.finance_reporting_role_assignments assignment
    WHERE assignment.organization_id = p_organization_id
      AND assignment.income_expense_type_id = p_income_expense_type_id
      AND assignment.effective_from > p_effective_from;

    INSERT INTO public.finance_reporting_role_assignments (
      organization_id,
      income_expense_type_id,
      finance_reporting_role,
      effective_from,
      effective_to,
      confirmed_at,
      confirmed_by
    ) VALUES (
      p_organization_id,
      p_income_expense_type_id,
      p_finance_reporting_role,
      p_effective_from,
      CASE WHEN v_next_start IS NULL THEN NULL ELSE v_next_start - 1 END,
      clock_timestamp(),
      v_actor
    )
    RETURNING id INTO v_assignment_id;
  END IF;

  RETURN QUERY
  SELECT
    assignment.id,
    assignment.finance_reporting_role,
    assignment.effective_from,
    assignment.effective_to,
    assignment.confirmed_at,
    assignment.confirmed_by
  FROM public.finance_reporting_role_assignments assignment
  WHERE assignment.id = v_assignment_id;
END;
$business_performance_set_reporting_role$;

REVOKE ALL ON FUNCTION public.business_performance_set_reporting_role_v1(uuid, uuid, text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_set_reporting_role_v1(uuid, uuid, text, date) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_set_reporting_role_v1(uuid, uuid, text, date) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_set_reporting_role_v1(uuid, uuid, text, date) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_set_reporting_role_v1(uuid, uuid, text, date) TO authenticated;

CREATE OR REPLACE FUNCTION public.business_performance_break_even_v1(
  p_organization_id uuid,
  p_basis text,
  p_month date,
  p_building_ids uuid[]
)
RETURNS TABLE(
  building_id uuid,
  building_name text,
  analysis_window text,
  window_start date,
  window_end date,
  source_month_count integer,
  valid_month_count integer,
  revenue numeric,
  expense numeric,
  net numeric,
  gap_to_zero numeric,
  r_room numeric,
  r_other numeric,
  r_pass numeric,
  f_landlord numeric,
  f_other numeric,
  v_room numeric,
  v_other numeric,
  e_pass numeric,
  mapping_coverage_pct numeric,
  unmapped_amount numeric,
  outside_model_amount numeric,
  missing_landlord_months date[],
  cmr_core numeric,
  cmr_room numeric,
  r_core_be numeric,
  r_total_be numeric,
  r_room_be numeric,
  break_even_revenue_available boolean,
  break_even_revenue_reason text,
  room_break_even_revenue_available boolean,
  room_break_even_revenue_reason text,
  capacity_current numeric,
  capacity_blocked numeric,
  capacity_theory numeric,
  invalid_rent_room_count integer,
  break_even_occupancy_current numeric,
  break_even_occupancy_theory numeric,
  room_revenue_utilization_pct numeric,
  break_even_occupancy_available boolean,
  break_even_occupancy_reason text,
  capacity_source text,
  capacity_as_of timestamptz,
  generated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $business_performance_break_even$
DECLARE
  v_building_ids uuid[];
  v_start_month date;
  v_end_date date;
  v_current_month date;
BEGIN
  SELECT scope.building_ids
    INTO v_building_ids
  FROM app_private.business_performance_exact_scope_v1(
    p_organization_id => p_organization_id,
    p_building_ids => p_building_ids,
    p_require_restricted => true
  ) AS scope;

  IF p_basis IS NULL OR p_basis NOT IN ('ACCRUAL', 'VOUCHER_DATE') THEN
    RAISE EXCEPTION 'Unsupported business performance basis'
      USING ERRCODE = '22023';
  END IF;
  IF p_month IS NULL OR p_month <> date_trunc('month', p_month)::date THEN
    RAISE EXCEPTION 'Break-even month must be the first day of a month'
      USING ERRCODE = '22023';
  END IF;

  v_current_month := date_trunc(
    'month',
    clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh'
  )::date;
  IF p_month > v_current_month THEN
    RAISE EXCEPTION 'Break-even month cannot be in the future'
      USING ERRCODE = '22023';
  END IF;

  v_start_month := (p_month - interval '2 months')::date;
  v_end_date := (p_month + interval '1 month - 1 day')::date;

  -- Formula glossary used in the returned rows:
  -- R_room, R_other, R_pass, F_landlord, F_other, V_room, V_other, E_pass.
  -- CMR_core = (R_room + R_other - V_room - V_other) / (R_room + R_other)
  -- CMR_room = (R_room - V_room) / R_room
  -- R_core_BE = MAX(0, (F_landlord + F_other - (R_pass - E_pass)) / CMR_core)
  -- R_room_BE = MAX(0, (F_landlord + F_other - C_non_room) / CMR_room)
  RETURN QUERY
  WITH requested_buildings AS MATERIALIZED (
    SELECT
      building_row.id,
      COALESCE(NULLIF(btrim(building_row.name), ''), 'Unnamed building') AS name
    FROM public.buildings building_row
    WHERE building_row.organization_id = p_organization_id
      AND building_row.deleted_at IS NULL
      AND building_row.is_virtual = false
      AND building_row.id = ANY(v_building_ids)
  ),
  months AS MATERIALIZED (
    SELECT generate_series(v_start_month, p_month, interval '1 month')::date AS month
  ),
  accrual_rows AS MATERIALIZED (
    SELECT
      allocation_row.month,
      allocation_row.voucher_id,
      allocation_row.building_id,
      upper(allocation_row.side) AS side,
      allocation_row.type_id,
      allocation_row.amount::numeric AS amount
    FROM public.fa_accrual_allocations(
      v_start_month,
      v_end_date,
      v_building_ids
    ) allocation_row
    WHERE p_basis = 'ACCRUAL'
      AND allocation_row.building_id = ANY(v_building_ids)
      AND allocation_row.is_virtual = false
  ),
  voucher_items AS MATERIALIZED (
    SELECT
      voucher_row.id AS voucher_id,
      date_trunc('month', voucher_row.voucher_date)::date AS month,
      voucher_row.building_id,
      upper(voucher_row.type::text) AS side,
      voucher_row.kqkd_amount::numeric AS kqkd_amount,
      item_row.income_expense_type_id AS type_id,
      COALESCE(item_row.amount, item_row.unit_price * item_row.quantity, 0)::numeric AS item_amount,
      sum(COALESCE(item_row.amount, item_row.unit_price * item_row.quantity, 0))
        OVER (PARTITION BY voucher_row.id)::numeric AS eligible_item_total,
      count(item_row.id) OVER (PARTITION BY voucher_row.id)::integer AS eligible_item_count
    FROM public.income_expenses voucher_row
    LEFT JOIN public.income_expense_items item_row
      ON item_row.income_expense_id = voucher_row.id
    LEFT JOIN public.income_expense_types type_row
      ON type_row.id = item_row.income_expense_type_id
    WHERE p_basis = 'VOUCHER_DATE'
      AND voucher_row.organization_id = p_organization_id
      AND voucher_row.building_id = ANY(v_building_ids)
      AND voucher_row.deleted_at IS NULL
      AND voucher_row.approval_status = 'APPROVED'
      AND voucher_row.kqkd_amount > 0
      AND voucher_row.voucher_date >= v_start_month
      AND voucher_row.voucher_date <= v_end_date
      AND (
        item_row.id IS NULL
        OR voucher_row.business_result_accounting IS TRUE
        OR NOT COALESCE(type_row.is_deposit, false)
      )
  ),
  voucher_rows AS MATERIALIZED (
    SELECT
      item_row.month,
      item_row.voucher_id,
      item_row.building_id,
      item_row.side,
      item_row.type_id,
      CASE
        WHEN item_row.eligible_item_count = 0 THEN item_row.kqkd_amount
        WHEN item_row.eligible_item_total > 0
          THEN item_row.kqkd_amount * item_row.item_amount / item_row.eligible_item_total
        ELSE item_row.kqkd_amount / NULLIF(item_row.eligible_item_count, 0)
      END::numeric AS amount
    FROM voucher_items item_row
  ),
  source_rows AS MATERIALIZED (
    SELECT * FROM accrual_rows
    UNION ALL
    SELECT * FROM voucher_rows
  ),
  classified_rows AS MATERIALIZED (
    SELECT
      source_row.month,
      source_row.voucher_id,
      source_row.building_id,
      source_row.side,
      source_row.type_id,
      source_row.amount,
      assignment_row.finance_reporting_role
    FROM source_rows source_row
    LEFT JOIN LATERAL (
      SELECT assignment.finance_reporting_role
      FROM public.finance_reporting_role_assignments assignment
      WHERE assignment.organization_id = p_organization_id
        AND assignment.income_expense_type_id = source_row.type_id
        AND assignment.effective_from <= source_row.month
        AND (
          assignment.effective_to IS NULL
          OR assignment.effective_to >= source_row.month
        )
      ORDER BY assignment.effective_from DESC, assignment.id
      LIMIT 1
    ) assignment_row ON true
  ),
  monthly AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      building_row.name AS building_name,
      month_row.month,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.side = 'INCOME'), 0)::numeric AS revenue,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.side = 'EXPENSE'), 0)::numeric AS expense,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role = 'ROOM_RENT_REVENUE'), 0)::numeric AS r_room,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role = 'OTHER_OPERATING_REVENUE'), 0)::numeric AS r_other,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role = 'PASS_THROUGH_REVENUE'), 0)::numeric AS r_pass,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role = 'LANDLORD_RENT_FIXED'), 0)::numeric AS f_landlord,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role = 'OTHER_FIXED_COST'), 0)::numeric AS f_other,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role = 'ROOM_VARIABLE_COST'), 0)::numeric AS v_room,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role = 'OTHER_VARIABLE_COST'), 0)::numeric AS v_other,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role = 'PASS_THROUGH_EXPENSE'), 0)::numeric AS e_pass,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role IS NULL), 0)::numeric AS unmapped_amount,
      COALESCE(sum(source_row.amount) FILTER (WHERE source_row.finance_reporting_role = 'OUTSIDE_BREAK_EVEN_MODEL'), 0)::numeric AS outside_model_amount
    FROM requested_buildings building_row
    CROSS JOIN months month_row
    LEFT JOIN classified_rows source_row
      ON source_row.building_id = building_row.id
     AND source_row.month = month_row.month
    GROUP BY building_row.id, building_row.name, month_row.month
  ),
  windows AS MATERIALIZED (
    SELECT
      monthly.building_id,
      max(monthly.building_name) AS building_name,
      'SELECTED_MONTH'::text AS analysis_window,
      p_month AS window_start,
      p_month AS window_end,
      1::integer AS source_month_count,
      count(*) FILTER (
        WHERE monthly.revenue + monthly.expense > 0
          AND monthly.unmapped_amount = 0
          AND monthly.outside_model_amount = 0
          AND monthly.f_landlord > 0
      )::integer AS valid_month_count,
      sum(monthly.revenue) FILTER (WHERE monthly.month = p_month)::numeric AS revenue,
      sum(monthly.expense) FILTER (WHERE monthly.month = p_month)::numeric AS expense,
      sum(monthly.r_room) FILTER (WHERE monthly.month = p_month)::numeric AS r_room,
      sum(monthly.r_other) FILTER (WHERE monthly.month = p_month)::numeric AS r_other,
      sum(monthly.r_pass) FILTER (WHERE monthly.month = p_month)::numeric AS r_pass,
      sum(monthly.f_landlord) FILTER (WHERE monthly.month = p_month)::numeric AS f_landlord,
      sum(monthly.f_other) FILTER (WHERE monthly.month = p_month)::numeric AS f_other,
      sum(monthly.v_room) FILTER (WHERE monthly.month = p_month)::numeric AS v_room,
      sum(monthly.v_other) FILTER (WHERE monthly.month = p_month)::numeric AS v_other,
      sum(monthly.e_pass) FILTER (WHERE monthly.month = p_month)::numeric AS e_pass,
      sum(monthly.unmapped_amount) FILTER (WHERE monthly.month = p_month)::numeric AS unmapped_amount,
      sum(monthly.outside_model_amount) FILTER (WHERE monthly.month = p_month)::numeric AS outside_model_amount,
      array_agg(monthly.month ORDER BY monthly.month) FILTER (
        WHERE monthly.month = p_month AND monthly.f_landlord <= 0
      ) AS missing_landlord_months
    FROM monthly
    WHERE monthly.month = p_month
    GROUP BY monthly.building_id

    UNION ALL

    SELECT
      monthly.building_id,
      max(monthly.building_name),
      'THREE_MONTH_AVERAGE'::text,
      v_start_month,
      p_month,
      3::integer,
      count(*) FILTER (
        WHERE monthly.revenue + monthly.expense > 0
          AND monthly.unmapped_amount = 0
          AND monthly.outside_model_amount = 0
          AND monthly.f_landlord > 0
      )::integer,
      (sum(monthly.revenue) / 3.0)::numeric,
      (sum(monthly.expense) / 3.0)::numeric,
      (sum(monthly.r_room) / 3.0)::numeric,
      (sum(monthly.r_other) / 3.0)::numeric,
      (sum(monthly.r_pass) / 3.0)::numeric,
      (sum(monthly.f_landlord) / 3.0)::numeric,
      (sum(monthly.f_other) / 3.0)::numeric,
      (sum(monthly.v_room) / 3.0)::numeric,
      (sum(monthly.v_other) / 3.0)::numeric,
      (sum(monthly.e_pass) / 3.0)::numeric,
      sum(monthly.unmapped_amount)::numeric,
      sum(monthly.outside_model_amount)::numeric,
      array_agg(monthly.month ORDER BY monthly.month) FILTER (WHERE monthly.f_landlord <= 0)
    FROM monthly
    GROUP BY monthly.building_id
  ),
  capacity_live AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      COALESCE(sum(GREATEST(room_row.rent_price, 0)) FILTER (
        WHERE CASE
          WHEN active_contract.active_count > 0 THEN 'OCCUPIED'
          WHEN room_row.status::text = 'RESERVED' THEN 'RESERVED'
          WHEN room_row.status::text = 'MAINTENANCE' THEN 'MAINTENANCE'
          WHEN room_row.status::text = 'AVAILABLE' THEN 'AVAILABLE'
          ELSE 'UNAVAILABLE'
        END IN ('OCCUPIED', 'RESERVED', 'AVAILABLE')
      ), 0)::numeric AS capacity_current,
      COALESCE(sum(GREATEST(room_row.rent_price, 0)) FILTER (
        WHERE CASE
          WHEN active_contract.active_count > 0 THEN 'OCCUPIED'
          WHEN room_row.status::text = 'RESERVED' THEN 'RESERVED'
          WHEN room_row.status::text = 'MAINTENANCE' THEN 'MAINTENANCE'
          WHEN room_row.status::text = 'AVAILABLE' THEN 'AVAILABLE'
          ELSE 'UNAVAILABLE'
        END IN ('MAINTENANCE', 'UNAVAILABLE')
      ), 0)::numeric AS capacity_blocked,
      count(room_row.id) FILTER (
        WHERE room_row.rent_price IS NULL OR room_row.rent_price <= 0
      )::integer AS invalid_rent_room_count,
      clock_timestamp() AS capacity_as_of
    FROM requested_buildings building_row
    LEFT JOIN public.rooms room_row
      ON room_row.building_id = building_row.id
     AND room_row.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS active_count
      FROM public.contracts contract_row
      WHERE contract_row.room_id = room_row.id
        AND contract_row.organization_id = p_organization_id
        AND contract_row.deleted_at IS NULL
        AND contract_row.status::text = 'ACTIVE'
        AND contract_row.start_date <= (clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        AND (
          contract_row.actual_end_date IS NULL
          OR contract_row.actual_end_date >= (clock_timestamp() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
        )
    ) active_contract ON true
    WHERE p_month = v_current_month
    GROUP BY building_row.id
  ),
  capacity_snapshot AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      COALESCE(sum(GREATEST(detail.listed_rent, 0)) FILTER (
        WHERE detail.occupancy_group IN ('OCCUPIED', 'RESERVED', 'AVAILABLE')
      ), 0)::numeric AS capacity_current,
      COALESCE(sum(GREATEST(detail.listed_rent, 0)) FILTER (
        WHERE detail.occupancy_group IN ('MAINTENANCE', 'UNAVAILABLE')
      ), 0)::numeric AS capacity_blocked,
      count(detail.id) FILTER (
        WHERE detail.listed_rent IS NULL OR detail.listed_rent <= 0
      )::integer AS invalid_rent_room_count,
      run.as_of_timestamp AS capacity_as_of
    FROM requested_buildings building_row
    JOIN public.finance_month_snapshot_runs run
      ON run.organization_id = p_organization_id
     AND run.snapshot_month = p_month
     AND run.status = 'FINALIZED'
    LEFT JOIN public.finance_room_month_snapshots detail
      ON detail.snapshot_run_id = run.id
     AND detail.building_id = building_row.id
    WHERE p_month < v_current_month
    GROUP BY building_row.id, run.as_of_timestamp
  ),
  capacity AS MATERIALIZED (
    SELECT
      building_row.id AS building_id,
      COALESCE(live_row.capacity_current, snapshot_row.capacity_current) AS capacity_current,
      COALESCE(live_row.capacity_blocked, snapshot_row.capacity_blocked) AS capacity_blocked,
      COALESCE(live_row.invalid_rent_room_count, snapshot_row.invalid_rent_room_count) AS invalid_rent_room_count,
      CASE
        WHEN live_row.building_id IS NOT NULL THEN 'LIVE'
        WHEN snapshot_row.building_id IS NOT NULL THEN 'FINALIZED_SNAPSHOT'
        ELSE 'UNAVAILABLE'
      END AS capacity_source,
      COALESCE(live_row.capacity_as_of, snapshot_row.capacity_as_of) AS capacity_as_of
    FROM requested_buildings building_row
    LEFT JOIN capacity_live live_row ON live_row.building_id = building_row.id
    LEFT JOIN capacity_snapshot snapshot_row ON snapshot_row.building_id = building_row.id
  ),
  calculated AS MATERIALIZED (
    SELECT
      window_row.*,
      CASE
        WHEN window_row.r_room + window_row.r_other > 0
          THEN (window_row.r_room + window_row.r_other - window_row.v_room - window_row.v_other)
            / (window_row.r_room + window_row.r_other)
        ELSE NULL
      END::numeric AS cmr_core,
      CASE
        WHEN window_row.r_room > 0
          THEN (window_row.r_room - window_row.v_room) / window_row.r_room
        ELSE NULL
      END::numeric AS cmr_room,
      capacity.capacity_current,
      capacity.capacity_blocked,
      capacity.invalid_rent_room_count,
      capacity.capacity_source,
      capacity.capacity_as_of
    FROM windows window_row
    JOIN capacity ON capacity.building_id = window_row.building_id
  ),
  outputs AS MATERIALIZED (
    SELECT
      calculated.*,
      calculated.valid_month_count = calculated.source_month_count
        AND calculated.unmapped_amount = 0
        AND calculated.outside_model_amount = 0
        AND calculated.cmr_core > 0 AS core_available,
      calculated.valid_month_count = calculated.source_month_count
        AND calculated.unmapped_amount = 0
        AND calculated.outside_model_amount = 0
        AND (
          calculated.f_landlord + calculated.f_other
            - ((calculated.r_other - calculated.v_other) + (calculated.r_pass - calculated.e_pass)) <= 0
          OR calculated.cmr_room > 0
        ) AS room_available,
      CASE
        WHEN calculated.valid_month_count = calculated.source_month_count
         AND calculated.unmapped_amount = 0
         AND calculated.outside_model_amount = 0
         AND calculated.cmr_core > 0
          THEN GREATEST(
            0,
            (calculated.f_landlord + calculated.f_other - (calculated.r_pass - calculated.e_pass))
              / calculated.cmr_core
          )
        ELSE NULL
      END::numeric AS r_core_be,
      CASE
        WHEN calculated.valid_month_count = calculated.source_month_count
         AND calculated.unmapped_amount = 0
         AND calculated.outside_model_amount = 0
         AND calculated.f_landlord + calculated.f_other
           - ((calculated.r_other - calculated.v_other) + (calculated.r_pass - calculated.e_pass)) <= 0
          THEN 0
        WHEN calculated.valid_month_count = calculated.source_month_count
         AND calculated.unmapped_amount = 0
         AND calculated.outside_model_amount = 0
         AND calculated.cmr_room > 0
          THEN GREATEST(
            0,
            (
              calculated.f_landlord + calculated.f_other
                - ((calculated.r_other - calculated.v_other) + (calculated.r_pass - calculated.e_pass))
            ) / calculated.cmr_room
          )
        ELSE NULL
      END::numeric AS r_room_be
    FROM calculated
  )
  SELECT
    output_row.building_id,
    output_row.building_name,
    output_row.analysis_window,
    output_row.window_start,
    output_row.window_end,
    output_row.source_month_count,
    output_row.valid_month_count,
    output_row.revenue,
    output_row.expense,
    output_row.revenue - output_row.expense,
    output_row.expense - output_row.revenue,
    output_row.r_room,
    output_row.r_other,
    output_row.r_pass,
    output_row.f_landlord,
    output_row.f_other,
    output_row.v_room,
    output_row.v_other,
    output_row.e_pass,
    CASE
      WHEN output_row.revenue + output_row.expense = 0 THEN NULL
      ELSE round(
        (
          output_row.revenue + output_row.expense
            - output_row.unmapped_amount / output_row.source_month_count
        ) * 100.0 / (output_row.revenue + output_row.expense),
        2
      )
    END,
    output_row.unmapped_amount,
    output_row.outside_model_amount,
    COALESCE(output_row.missing_landlord_months, ARRAY[]::date[]),
    output_row.cmr_core,
    output_row.cmr_room,
    output_row.r_core_be,
    CASE WHEN output_row.r_core_be IS NULL THEN NULL ELSE output_row.r_core_be + output_row.r_pass END,
    output_row.r_room_be,
    output_row.core_available,
    CASE
      WHEN output_row.unmapped_amount > 0 THEN 'UNMAPPED_AMOUNT'
      WHEN output_row.outside_model_amount > 0 THEN 'OUTSIDE_MODEL_AMOUNT'
      WHEN output_row.valid_month_count < output_row.source_month_count THEN 'MISSING_LANDLORD_OR_MONTH'
      WHEN output_row.cmr_core IS NULL OR output_row.cmr_core <= 0 THEN 'CMR_CORE_NOT_POSITIVE'
      ELSE NULL
    END,
    output_row.room_available,
    CASE
      WHEN output_row.unmapped_amount > 0 THEN 'UNMAPPED_AMOUNT'
      WHEN output_row.outside_model_amount > 0 THEN 'OUTSIDE_MODEL_AMOUNT'
      WHEN output_row.valid_month_count < output_row.source_month_count THEN 'MISSING_LANDLORD_OR_MONTH'
      WHEN output_row.r_room_be IS NULL THEN 'CMR_ROOM_NOT_POSITIVE'
      ELSE NULL
    END,
    output_row.capacity_current,
    output_row.capacity_blocked,
    CASE WHEN output_row.capacity_current IS NULL THEN NULL
      ELSE output_row.capacity_current + output_row.capacity_blocked END,
    output_row.invalid_rent_room_count,
    CASE
      WHEN output_row.room_available
       AND output_row.r_room_be IS NOT NULL
       AND output_row.cmr_room > 0
       AND output_row.capacity_current > 0
       AND output_row.invalid_rent_room_count = 0
        THEN output_row.r_room_be * 100.0 / output_row.capacity_current
      ELSE NULL
    END,
    CASE
      WHEN output_row.room_available
       AND output_row.r_room_be IS NOT NULL
       AND output_row.cmr_room > 0
       AND output_row.capacity_current + output_row.capacity_blocked > 0
       AND output_row.invalid_rent_room_count = 0
        THEN output_row.r_room_be * 100.0
          / (output_row.capacity_current + output_row.capacity_blocked)
      ELSE NULL
    END,
    CASE
      WHEN output_row.capacity_current > 0
        THEN output_row.r_room * 100.0 / output_row.capacity_current
      ELSE NULL
    END,
    output_row.room_available
      AND output_row.r_room_be IS NOT NULL
      AND output_row.cmr_room > 0
      AND output_row.capacity_current > 0
      AND output_row.invalid_rent_room_count = 0,
    CASE
      WHEN NOT output_row.room_available THEN 'ROOM_BREAK_EVEN_UNAVAILABLE'
      WHEN output_row.capacity_source = 'UNAVAILABLE' THEN 'SNAPSHOT_UNAVAILABLE'
      WHEN output_row.invalid_rent_room_count > 0 THEN 'INVALID_LISTED_RENT'
      WHEN output_row.capacity_current IS NULL OR output_row.capacity_current <= 0 THEN 'CAPACITY_NOT_POSITIVE'
      WHEN output_row.cmr_room IS NULL OR output_row.cmr_room <= 0 THEN 'CMR_ROOM_NOT_POSITIVE'
      ELSE NULL
    END,
    output_row.capacity_source,
    output_row.capacity_as_of,
    clock_timestamp()
  FROM outputs output_row
  ORDER BY lower(output_row.building_name) COLLATE "C", output_row.building_id,
    CASE output_row.analysis_window WHEN 'SELECTED_MONTH' THEN 0 ELSE 1 END;
END;
$business_performance_break_even$;

REVOKE ALL ON FUNCTION public.business_performance_break_even_v1(uuid, text, date, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_performance_break_even_v1(uuid, text, date, uuid[]) FROM anon;
REVOKE ALL ON FUNCTION public.business_performance_break_even_v1(uuid, text, date, uuid[]) FROM authenticated;
REVOKE ALL ON FUNCTION public.business_performance_break_even_v1(uuid, text, date, uuid[]) FROM service_role;
GRANT EXECUTE ON FUNCTION public.business_performance_break_even_v1(uuid, text, date, uuid[]) TO authenticated;

COMMENT ON TABLE public.finance_reporting_role_assignments IS
  'Confirmed effective-dated analytical role for each non-deposit income/expense type.';
COMMENT ON FUNCTION public.business_performance_reporting_roles_v1(uuid, date, uuid[]) IS
  'Read mapping state and conservative suggestions for the selected organization/month.';
COMMENT ON FUNCTION public.business_performance_set_reporting_role_v1(uuid, uuid, text, date) IS
  'Confirm or restate a finance role from a month boundary; requires categories.edit.';
COMMENT ON FUNCTION public.business_performance_break_even_v1(uuid, text, date, uuid[]) IS
  'Fail-closed selected-month and 3-month-average building break-even, with live/finalized capacity provenance.';

COMMIT;
