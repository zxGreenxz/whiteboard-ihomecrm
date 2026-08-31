-- Close the restricted/system-only category gap on the live Copilot RPCs.
--
-- The preceding draft-writer migration hardens a candidate writer, but an
-- already-applied catalog can still contain the older RPC bodies.  Keep those
-- bodies as private delegates and put a small, lock-taking authorization
-- boundary in front of both preview and execute.  This is additive and
-- forward-only; no deployed migration is edited in place.

BEGIN;
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION app_private.copilot_ie_type_allowed_v1(
  p_organization_id uuid,
  p_type            text,
  p_type_id         uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $function$
DECLARE
  v_type public.income_expense_types%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL
     OR p_organization_id IS NULL
     OR p_type_id IS NULL
     OR p_type IS NULL THEN
    RETURN false;
  END IF;

  -- Hold the category row through the caller's transaction so a restriction
  -- toggle cannot race the authorization check and the subsequent write.
  SELECT t.*
    INTO v_type
    FROM public.income_expense_types t
   WHERE t.id = p_type_id
     AND t.organization_id = p_organization_id
   FOR SHARE;

  IF NOT FOUND
     OR lower(v_type.type) IS DISTINCT FROM lower(p_type)
     OR coalesce(v_type.system_only, false)
     OR (
       coalesce(v_type.is_restricted, false)
       AND NOT public.can_create_restricted_ie()
     ) THEN
    RETURN false;
  END IF;
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION app_private.copilot_ie_type_allowed_v1(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the old implementations as owner-only delegates.  The conditional
-- rename makes this migration safe to replay after a partial or full apply.
DO $rename$
BEGIN
  IF to_regprocedure('public.copilot_preview_income_expense_v1(uuid,jsonb)') IS NOT NULL
     AND to_regprocedure('public.copilot_preview_income_expense_legacy_v1(uuid,jsonb)') IS NULL THEN
    ALTER FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb)
      RENAME TO copilot_preview_income_expense_legacy_v1;
  END IF;

  IF to_regprocedure('public.copilot_execute_income_expense_v1(text,jsonb)') IS NOT NULL
     AND to_regprocedure('public.copilot_execute_income_expense_legacy_v1(text,jsonb)') IS NULL THEN
    ALTER FUNCTION public.copilot_execute_income_expense_v1(text, jsonb)
      RENAME TO copilot_execute_income_expense_legacy_v1;
  END IF;

  IF to_regprocedure('public.copilot_preview_income_expense_legacy_v1(uuid,jsonb)') IS NULL
     OR to_regprocedure('public.copilot_execute_income_expense_legacy_v1(text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Copilot legacy RPC delegates are missing';
  END IF;
END
$rename$;

REVOKE EXECUTE ON FUNCTION public.copilot_preview_income_expense_legacy_v1(uuid, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.copilot_execute_income_expense_legacy_v1(text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.copilot_preview_income_expense_v1(
  p_organization_id uuid,
  p_payload         jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $function$
DECLARE
  v_result  jsonb;
  v_canon   jsonb;
  v_org     uuid;
  v_type_id uuid;
  v_type    text;
BEGIN
  v_result := public.copilot_preview_income_expense_legacy_v1(
    p_organization_id, p_payload);
  v_canon := v_result -> 'canonical';

  BEGIN
    v_org := (v_canon ->> 'organization_id')::uuid;
    v_type_id := (v_canon ->> 'type_id')::uuid;
    v_type := v_canon ->> 'type';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'copilot_category_invalid' USING ERRCODE = '42501';
  END;

  IF NOT app_private.copilot_ie_type_allowed_v1(v_org, v_type, v_type_id) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  RETURN v_result;
END
$function$;

COMMENT ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb) IS
  'Copilot preview with a server-locked system-only/restricted category authorization boundary.';

REVOKE EXECUTE ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_preview_income_expense_v1(uuid, jsonb)
  TO authenticated;

CREATE OR REPLACE FUNCTION public.copilot_execute_income_expense_v1(
  p_confirmation_nonce text,
  p_payload            jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private, extensions
AS $function$
DECLARE
  v_org     uuid;
  v_type_id uuid;
  v_type    text;
BEGIN
  BEGIN
    v_org := (p_payload ->> 'organization_id')::uuid;
    v_type_id := (p_payload ->> 'type_id')::uuid;
    v_type := p_payload ->> 'type';
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'payload_changed' USING ERRCODE = '42501';
  END;

  -- This check runs again after preview and before the delegate can consume
  -- the nonce, so revocation and restricted-category changes take effect now.
  IF NOT app_private.copilot_ie_type_allowed_v1(v_org, v_type, v_type_id) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  RETURN public.copilot_execute_income_expense_legacy_v1(
    p_confirmation_nonce, p_payload);
END
$function$;

COMMENT ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb) IS
  'Copilot execute with a server-locked system-only/restricted category authorization boundary.';

REVOKE EXECUTE ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.copilot_execute_income_expense_v1(text, jsonb)
  TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
