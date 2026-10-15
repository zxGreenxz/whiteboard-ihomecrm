-- Additive action metadata over the existing v1 permission/scope APIs.
-- v1 remains the read-only contract. New names prevent an older, future-stamped
-- v1 migration from overwriting this extension during sorted baseline replay.
-- No company, user, connection or Copilot rollout is enabled here.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled)
VALUES ('chat_zalo.view','read',false),('chat_zalo.send','action',false) ON CONFLICT (capability) DO NOTHING;

CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v2(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_base jsonb; v_action jsonb;
BEGIN
  v_base:=public.hermes_org_policy_options_v1(p_org);
  IF v_base->>'organizationId' IS DISTINCT FROM p_org::text
    OR v_base->>'userId' IS DISTINCT FROM auth.uid()::text
    OR jsonb_typeof(v_base->'choices') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  SELECT COALESCE(jsonb_agg(capability ORDER BY capability),'[]'::jsonb) INTO v_action
    FROM app_private.hermes_capabilities WHERE capability='chat_zalo.send' AND mode='action' AND enabled;
  IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled) THEN
    v_base:=jsonb_set(v_base,'{choices,read}',(v_base#>'{choices,read}')||'"chat_zalo.view"'::jsonb,false); END IF;
  RETURN jsonb_set(v_base,'{choices,action}',v_action,false);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_connection_options_v2(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_base jsonb; v_context jsonb; v_action jsonb:='[]';
BEGIN
  v_base:=public.hermes_connection_options_v1(p_org);
  IF v_base->>'organizationId' IS DISTINCT FROM p_org::text
    OR v_base->>'userId' IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  IF v_base->'enabled'='true'::jsonb AND EXISTS(
    SELECT 1 FROM app_private.hermes_capabilities WHERE (capability='chat_zalo.send' AND mode='action' OR capability='chat_zalo.view' AND mode='read') AND enabled) THEN
    v_context:=public.hermes_group_action_context_v1(p_org);
    IF v_context->>'organizationId' IS DISTINCT FROM p_org::text
      OR v_context->>'userId' IS DISTINCT FROM v_base->>'userId'
      OR v_context->>'membershipId' IS DISTINCT FROM v_base->>'membershipId'
      OR v_context->>'authorizationVersion' IS DISTINCT FROM v_base->>'authorizationVersion'
      OR v_context->>'policyVersion' IS DISTINCT FROM v_base->>'policyVersion' THEN
      RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
    IF v_context->'allowed'='true'::jsonb AND v_context->'companyEnabled'='true'::jsonb THEN
      v_action:='["chat_zalo.send"]'; END IF;
    IF v_context->'readAllowed'='true'::jsonb AND v_context->'readCompanyEnabled'='true'::jsonb THEN
      v_base:=jsonb_set(v_base,'{read}',(v_base->'read')||'"chat_zalo.view"'::jsonb,false); END IF;
  END IF;
  RETURN jsonb_set(v_base,'{action}',v_action,false);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_connection_context_v2(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_base jsonb; v_context jsonb; v_action jsonb:='[]'; v_org uuid;
BEGIN
  v_base:=public.hermes_connection_context_v1(p_connection_id);
  IF v_base->>'id' IS DISTINCT FROM p_connection_id::text
    OR v_base->>'userId' IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  v_org:=(v_base->>'organizationId')::uuid;
  IF (v_base->'restrictions'->'action' ? 'chat_zalo.send'
    AND v_base->'companyCeilings'->'action' ? 'chat_zalo.send'
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities
      WHERE capability='chat_zalo.send' AND mode='action' AND enabled)) OR
    (v_base->'restrictions'->'read' ? 'chat_zalo.view' AND v_base->'companyCeilings'->'read' ? 'chat_zalo.view'
      AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.view' AND mode='read' AND enabled)) THEN
    v_context:=public.hermes_group_action_context_v1(v_org);
    IF v_context->>'organizationId' IS DISTINCT FROM v_org::text
      OR v_context->>'userId' IS DISTINCT FROM v_base->>'userId'
      OR v_context->>'membershipId' IS DISTINCT FROM v_base->>'membershipId'
      OR v_context->>'authorizationVersion' IS DISTINCT FROM v_base->>'authorizationVersion'
      OR v_context->>'policyVersion' IS DISTINCT FROM v_base->>'policyVersion' THEN
      RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
    IF v_context->'allowed'='true'::jsonb AND v_context->'companyEnabled'='true'::jsonb
      AND v_base->'restrictions'->'action' ? 'chat_zalo.send' AND v_base->'companyCeilings'->'action' ? 'chat_zalo.send' THEN
      v_action:='["chat_zalo.send"]'; END IF;
    IF v_context->'readAllowed'='true'::jsonb AND v_context->'readCompanyEnabled'='true'::jsonb
      AND v_base->'restrictions'->'read' ? 'chat_zalo.view' AND v_base->'companyCeilings'->'read' ? 'chat_zalo.view' THEN
      v_base:=jsonb_set(v_base,'{effective,read}',(v_base#>'{effective,read}')||'"chat_zalo.view"'::jsonb,false); END IF;
  END IF;
  RETURN jsonb_set(v_base,'{effective,action}',v_action,false);
END $fn$;

ALTER FUNCTION public.hermes_org_policy_options_v2(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_org_policy_options_v2(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v2(uuid) TO authenticated;
ALTER FUNCTION public.hermes_connection_options_v2(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_options_v2(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_connection_options_v2(uuid) TO authenticated;
ALTER FUNCTION public.hermes_connection_context_v2(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_context_v2(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_connection_context_v2(uuid) TO authenticated;
COMMIT;
