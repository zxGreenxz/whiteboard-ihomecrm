-- One additive read contract for memory and room schedules. Current CRM
-- authority and each persisted connection overlay remain the only grants.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
INSERT INTO app_private.hermes_capabilities(capability,mode,enabled)
VALUES ('chat_zalo.manage_automation','action',false) ON CONFLICT(capability) DO NOTHING;

CREATE OR REPLACE FUNCTION public.hermes_room_schedule_capabilities_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; decision record; v_enabled boolean;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,'{}'::text[],ARRAY['chat_zalo.manage_automation'],'{}'::uuid[]);
  SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(auth.uid(),p_organization_id,'chat_zalo.manage_automation');
  IF decision.authorization_version::text IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  v_enabled:=policy.enabled AND 'chat_zalo.manage_automation'=ANY(policy.action_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.manage_automation' AND mode='action' AND enabled);
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,
    'allowed',COALESCE(v_enabled AND decision.allowed,false),'companyEnabled',COALESCE(v_enabled,false));
END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v3(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb; extra jsonb;
BEGIN
  result:=public.hermes_org_policy_options_v2(p_org);
  SELECT COALESCE(jsonb_agg(capability ORDER BY capability),'[]') INTO extra FROM app_private.hermes_capabilities
    WHERE capability='assistant.memory.read' AND mode='read' AND enabled;
  result:=jsonb_set(result,'{choices,read}',(result#>'{choices,read}')||extra,false);
  SELECT COALESCE(jsonb_agg(capability ORDER BY capability),'[]') INTO extra FROM app_private.hermes_capabilities
    WHERE capability IN ('assistant.memory.write','chat_zalo.manage_automation') AND mode='action' AND enabled;
  RETURN app_private.hermes_domain_extend_options_v1(jsonb_set(result,'{choices,action}',(result#>'{choices,action}')||extra,false),'org_options');
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_connection_options_v3(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb; memory jsonb; schedule jsonb;
BEGIN
  result:=public.hermes_connection_options_v2(p_org);
  memory:=public.hermes_work_memory_capabilities_v1(p_org);
  schedule:=public.hermes_room_schedule_capabilities_v1(p_org);
  IF memory->>'userId' IS DISTINCT FROM result->>'userId' OR memory->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR memory->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR memory->>'policyVersion' IS DISTINCT FROM result->>'policyVersion'
    OR schedule->>'userId' IS DISTINCT FROM result->>'userId' OR schedule->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR schedule->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion' OR schedule->>'policyVersion' IS DISTINCT FROM result->>'policyVersion'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  IF result->'enabled'='true'::jsonb AND memory->'readAllowed'='true'::jsonb THEN
    result:=jsonb_set(result,'{read}',(result->'read')||'"assistant.memory.read"'::jsonb,false); END IF;
  IF result->'enabled'='true'::jsonb AND memory->'writeAllowed'='true'::jsonb THEN
    result:=jsonb_set(result,'{action}',(result->'action')||'"assistant.memory.write"'::jsonb,false); END IF;
  IF result->'enabled'='true'::jsonb AND schedule->'allowed'='true'::jsonb THEN
    result:=jsonb_set(result,'{action}',(result->'action')||'"chat_zalo.manage_automation"'::jsonb,false); END IF;
  RETURN app_private.hermes_domain_extend_options_v1(result,'connection_options');
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_connection_context_v3(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb; memory jsonb; schedule jsonb;
BEGIN
  result:=public.hermes_connection_context_v2(p_connection_id);
  memory:=public.hermes_work_memory_capabilities_v1((result->>'organizationId')::uuid);
  schedule:=public.hermes_room_schedule_capabilities_v1((result->>'organizationId')::uuid);
  IF memory->>'userId' IS DISTINCT FROM result->>'userId' OR memory->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR memory->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR memory->>'policyVersion' IS DISTINCT FROM result->>'policyVersion'
    OR schedule->>'userId' IS DISTINCT FROM result->>'userId' OR schedule->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR schedule->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion' OR schedule->>'policyVersion' IS DISTINCT FROM result->>'policyVersion'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  IF memory->'readAllowed'='true'::jsonb AND result#>'{restrictions,read}' ? 'assistant.memory.read'
    AND result#>'{companyCeilings,read}' ? 'assistant.memory.read' THEN
    result:=jsonb_set(result,'{effective,read}',(result#>'{effective,read}')||'"assistant.memory.read"'::jsonb,false); END IF;
  IF memory->'writeAllowed'='true'::jsonb AND result#>'{restrictions,action}' ? 'assistant.memory.write'
    AND result#>'{companyCeilings,action}' ? 'assistant.memory.write' THEN
    result:=jsonb_set(result,'{effective,action}',(result#>'{effective,action}')||'"assistant.memory.write"'::jsonb,false); END IF;
  IF schedule->'allowed'='true'::jsonb AND result#>'{restrictions,action}' ? 'chat_zalo.manage_automation'
    AND result#>'{companyCeilings,action}' ? 'chat_zalo.manage_automation' THEN
    result:=jsonb_set(result,'{effective,action}',(result#>'{effective,action}')||'"chat_zalo.manage_automation"'::jsonb,false); END IF;
  RETURN app_private.hermes_domain_extend_options_v1(result,'context');
END $fn$;
DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['public.hermes_org_policy_options_v3(uuid)','public.hermes_connection_options_v3(uuid)','public.hermes_connection_context_v3(uuid)','public.hermes_room_schedule_capabilities_v1(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated',signature);
  END LOOP;
END $acl$;
COMMIT;
NOTIFY pgrst,'reload schema';
