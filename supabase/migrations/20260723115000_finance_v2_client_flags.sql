-- Finance V2 (Thu Chi V2) — Stage 11b: client feature-route flags (plan §9.6/§12/§15).
--
-- The frontend must be MODE-AWARE (compatibility gate theo effective feature route) but
-- cannot call app_private.evaluate_feature_route directly. This tiny read-only RPC returns
-- the effective Finance V2 routes for every organization the actor is an ACTIVE member of,
-- so the UI can render LEGACY behavior until a route turns CANONICAL. It leaks no config:
-- only the four route names the UI needs (read_semantics / workflow / posting / access).
--
-- Pre-apply the function simply does not exist — the client treats "function not found"
-- as LEGACY (typed schema-absent signal, NOT a permission fallback). No feature mode is
-- changed and no org is enrolled here.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_finance_v2_client_flags_v1()
RETURNS TABLE (
  organization_id uuid,
  read_semantics_route text,
  workflow_route text,
  posting_route text,
  access_route text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app_private, public
AS $fn$
  SELECT m.organization_id,
         app_private.evaluate_feature_route('income_expense.read_semantics.v2', m.organization_id),
         app_private.evaluate_feature_route('income_expense.workflow.v2', m.organization_id),
         app_private.evaluate_feature_route('income_expense.posting.v2', m.organization_id),
         app_private.evaluate_feature_route('cashbook.access.v2', m.organization_id)
  FROM public.organization_memberships m
  WHERE m.user_id = auth.uid() AND m.status = 'ACTIVE';
$fn$;

REVOKE ALL ON FUNCTION public.get_finance_v2_client_flags_v1() FROM PUBLIC;
DO $g11d$
BEGIN
  IF to_regrole('anon') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.get_finance_v2_client_flags_v1() FROM anon';
  END IF;
  IF to_regrole('service_role') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.get_finance_v2_client_flags_v1() FROM service_role';
  END IF;
  IF to_regrole('authenticated') IS NOT NULL THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_finance_v2_client_flags_v1() TO authenticated';
  END IF;
END
$g11d$;

COMMENT ON FUNCTION public.get_finance_v2_client_flags_v1() IS
  'Thu Chi V2 §9.6: effective Finance V2 routes per active-membership org for the mode-aware UI. Route names only; no config leak.';

COMMIT;

NOTIFY pgrst, 'reload schema';
