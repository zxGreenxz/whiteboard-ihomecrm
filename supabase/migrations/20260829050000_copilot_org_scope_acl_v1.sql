-- The scope helper is an internal authenticated boundary, never an anonymous endpoint.
BEGIN;
SET LOCAL lock_timeout = '15s';

REVOKE ALL ON FUNCTION public.copilot_org_scope_buildings_v1(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.copilot_org_scope_buildings_v1(text,uuid) TO authenticated;

COMMIT;
