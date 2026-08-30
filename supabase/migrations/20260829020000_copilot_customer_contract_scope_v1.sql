-- Server-authoritative customer and expiring-contract lookups for Copilot.
-- Scope is resolved from the authenticated actor; callers cannot provide buildings.
-- The scope source is app_private.authorized_scope_v3 via the shared Copilot helper.
-- Safe output keys are 'room_name', 'building_name', and 'customer_name'.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_customer_search_v1(
  p_organization_id uuid,
  p_search text
)
RETURNS TABLE(
  customer_id uuid,
  customer_name text,
  phone text,
  contract_id uuid,
  contract_number text,
  contract_status text,
  room_id uuid,
  room_name text,
  building_id uuid,
  building_name text,
  is_representative boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_query text := NULLIF(btrim(p_search), '');
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- This validates the selected org, active membership, permission and denies.
  v_buildings := public.copilot_org_scope_buildings_v1('customers.view', p_organization_id);

  RETURN QUERY
  WITH candidates AS (
    SELECT
      cst.id AS customer_id,
      cst.full_name AS customer_name,
      cst.phone,
      ct.id AS contract_id,
      ct.contract_number,
      ct.status::text AS contract_status,
      rm.id AS room_id,
      rm.name AS room_name,
      b.id AS building_id,
      b.name AS building_name,
      cc.is_representative,
      row_number() OVER (
        PARTITION BY cst.id
        ORDER BY
          CASE WHEN ct.status IN ('ACTIVE', 'EXTENDED') THEN 0 ELSE 1 END,
          COALESCE(ct.actual_end_date, ct.end_date) DESC NULLS LAST,
          ct.updated_at DESC
      ) AS row_rank
    FROM public.customers cst
    JOIN public.contract_customers cc
      ON cc.customer_id = cst.id
     AND cc.organization_id = p_organization_id
    JOIN public.contracts ct
      ON ct.id = cc.contract_id
     AND ct.organization_id = p_organization_id
     AND ct.deleted_at IS NULL
    JOIN public.rooms rm
      ON rm.id = ct.room_id
     AND rm.organization_id = p_organization_id
     AND rm.deleted_at IS NULL
    JOIN public.buildings b
      ON b.id = rm.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL
     AND b.id = ANY(v_buildings)
    WHERE cst.organization_id = p_organization_id
      AND cst.deleted_at IS NULL
      AND (
        v_query IS NULL
        OR cst.full_name ILIKE '%' || v_query || '%'
        OR cst.phone ILIKE '%' || v_query || '%'
      )
  )
  SELECT
    c.customer_id,
    c.customer_name,
    c.phone,
    c.contract_id,
    c.contract_number,
    c.contract_status,
    c.room_id,
    c.room_name,
    c.building_id,
    c.building_name,
    c.is_representative
  FROM candidates c
  WHERE c.row_rank = 1
  ORDER BY c.customer_name, c.customer_id
  LIMIT 10;
END
$fn$;

CREATE OR REPLACE FUNCTION public.copilot_expiring_contracts_v1(
  p_organization_id uuid,
  p_as_of_date date,
  p_window_days integer
)
RETURNS TABLE(
  contract_id uuid,
  contract_number text,
  customer_name text,
  end_date date,
  effective_end_date date,
  contract_status text,
  room_id uuid,
  room_name text,
  building_id uuid,
  building_name text,
  is_representative boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_actor uuid := auth.uid();
  v_buildings uuid[];
  v_until date;
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  IF p_as_of_date IS NULL OR p_window_days IS NULL OR p_window_days < 1 OR p_window_days > 365 THEN
    RAISE EXCEPTION 'invalid_expiring_window' USING ERRCODE = '22023';
  END IF;

  -- This validates the selected org, active membership, permission and denies.
  v_buildings := public.copilot_org_scope_buildings_v1('reports_real_estate.expiring', p_organization_id);
  v_until := p_as_of_date + p_window_days;

  RETURN QUERY
  SELECT
    ct.id AS contract_id,
    ct.contract_number,
    rep.customer_name,
    ct.end_date,
    COALESCE(ct.actual_end_date, ct.end_date) AS effective_end_date,
    ct.status::text AS contract_status,
    rm.id AS room_id,
    rm.name AS room_name,
    b.id AS building_id,
    b.name AS building_name,
    rep.is_representative
  FROM public.contracts ct
  JOIN public.rooms rm
    ON rm.id = ct.room_id
   AND rm.organization_id = p_organization_id
   AND rm.deleted_at IS NULL
  JOIN public.buildings b
    ON b.id = rm.building_id
   AND b.organization_id = p_organization_id
   AND b.deleted_at IS NULL
   AND b.id = ANY(v_buildings)
  LEFT JOIN LATERAL (
    SELECT
      cst.full_name AS customer_name,
      cc.is_representative
    FROM public.contract_customers cc
    JOIN public.customers cst
      ON cst.id = cc.customer_id
     AND cst.organization_id = p_organization_id
     AND cst.deleted_at IS NULL
    WHERE cc.contract_id = ct.id
      AND cc.organization_id = p_organization_id
    ORDER BY cc.is_representative DESC, cc.created_at
    LIMIT 1
  ) rep ON true
  WHERE ct.organization_id = p_organization_id
    AND ct.deleted_at IS NULL
    AND ct.status IN ('ACTIVE', 'EXTENDED')
    AND COALESCE(ct.actual_end_date, ct.end_date) BETWEEN p_as_of_date AND v_until
  ORDER BY COALESCE(ct.actual_end_date, ct.end_date), ct.contract_number NULLS LAST, ct.id;
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_customer_search_v1(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.copilot_expiring_contracts_v1(uuid, date, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.copilot_customer_search_v1(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.copilot_expiring_contracts_v1(uuid, date, integer) TO authenticated;

COMMENT ON FUNCTION public.copilot_customer_search_v1(uuid, text) IS
  'Read-only customer lookup with server-derived organization/building scope.';
COMMENT ON FUNCTION public.copilot_expiring_contracts_v1(uuid, date, integer) IS
  'Read-only expiring-contract lookup with server-derived organization/building scope.';
COMMIT;
