-- Preserve the canonical resolver's final building set. In particular, an
-- organization-wide ALLOW may coexist with narrower BUILDING/AREA DENYs; the
-- resolver has already subtracted those resources from building_ids.
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

  -- Keep the selected-organization membership gate independent from permission
  -- resolution so a revoked or out-of-window membership remains a hard denial.
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

  SELECT COALESCE(array_agg(b.id ORDER BY b.id), '{}'::uuid[])
    INTO v_scope
    FROM app_private.authorized_scope_v3(p_permission_key, p_organization_id) s
    CROSS JOIN LATERAL unnest(COALESCE(s.building_ids, '{}'::uuid[])) allowed(building_id)
    JOIN public.buildings b
      ON b.id = allowed.building_id
     AND b.organization_id = p_organization_id
     AND b.deleted_at IS NULL;

  -- Empty is a valid resource result. It does not imply organization permission.
  RETURN COALESCE(v_scope, '{}'::uuid[]);
END
$fn$;

COMMENT ON FUNCTION public.copilot_org_scope_buildings_v1(text, uuid) IS
  'Returns the active selected-organization intersection of authorized_scope_v3 building_ids without widening organization-wide grants past explicit resource DENYs.';

COMMIT;
