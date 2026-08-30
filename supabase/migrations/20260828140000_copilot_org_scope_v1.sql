-- Org-scoped Copilot settlement boundary. Kept additive so existing report RPCs
-- remain unchanged for non-Copilot callers.
BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION public.copilot_cashbook_settlement_v1(
  p_organization_id uuid,
  p_from date,
  p_to date,
  p_building_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_report jsonb;
BEGIN
  IF p_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations o
    WHERE o.id = p_organization_id AND o.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM app_private.authorized_scope_v3('income_expenses.view', p_organization_id) s
    WHERE s.org_wide OR coalesce(array_length(s.building_ids, 1), 0) > 0
  ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  v_report := public.cashbook_settlement_report(p_from, p_to);
  RETURN jsonb_build_object(
    'from', v_report -> 'from',
    'to', v_report -> 'to',
    'accounts', coalesce((
      SELECT jsonb_agg(a ORDER BY a ->> 'name')
      FROM jsonb_array_elements(coalesce(v_report -> 'accounts', '[]'::jsonb)) a
      JOIN public.accounts ac ON ac.id = (a ->> 'account_id')::uuid
       AND ac.organization_id = p_organization_id
       AND ac.deleted_at IS NULL
       AND (p_building_ids IS NULL OR ac.quick_default_building_id = ANY(p_building_ids))
    ), '[]'::jsonb),
    'sessions', '[]'::jsonb,
    'reconciliations', '[]'::jsonb
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.copilot_cashbook_settlement_v1(uuid, date, date, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.copilot_cashbook_settlement_v1(uuid, date, date, uuid[]) TO authenticated;

COMMIT;
