-- Additive room-pass choices. v3 is already applied and remains immutable.
-- The action registry is installed disabled by hermes_room_pass_action_v1.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE OR REPLACE FUNCTION app_private.hermes_room_pass_extend_options_v1(p_result jsonb,p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb:=p_result; org uuid; member jsonb; capability jsonb;
  policy app_private.hermes_org_policies; choices jsonb; combined jsonb; building_ids uuid[];
  action_key constant text:='sale_phong.manage_pass_listings';
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('org_options','connection_options','context')
    OR jsonb_typeof(result) IS DISTINCT FROM 'object' OR auth.role() IS DISTINCT FROM 'authenticated'
    OR result->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_room_pass_denied' USING ERRCODE='42501'; END IF;
  org:=app_private.hermes_uuid_v1(result->'organizationId');
  PERFORM app_private.lock_org_for_decision_v1(org);
  member:=app_private.hermes_member_v1(auth.uid(),org);
  IF member->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR member->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='org_options' THEN
    -- v3 delegates to the existing users.edit guard. This adds a choice only,
    -- never enables the registry or policy and never copies a role.
    IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities registry WHERE registry.capability=action_key AND registry.mode='action' AND registry.enabled)
      AND NOT(result#>'{choices,action}' ? action_key) THEN
      result:=jsonb_set(result,'{choices,action}',(result#>'{choices,action}')||to_jsonb(action_key),false);
    END IF;
    RETURN result;
  END IF;
  capability:=public.hermes_room_pass_capabilities_v1(org);
  IF capability->>'userId' IS DISTINCT FROM result->>'userId'
    OR capability->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR capability->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR capability->>'policyVersion' IS DISTINCT FROM result->>'policyVersion'
    OR capability->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  IF capability->'allowed' IS DISTINCT FROM 'true'::jsonb OR
    (p_kind='connection_options' AND result->'enabled' IS DISTINCT FROM 'true'::jsonb) THEN RETURN result; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(org,NULL,NULL,NULL);
  SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO building_ids
    FROM jsonb_array_elements_text(capability->'buildingIds');
  -- Existing CRM scope IDs, current building ACL and company ceiling all apply.
  -- Action-only connections need these choices even with an empty Read set.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',scope.id,'scopeType',scope.scope_type,
    'label',CASE scope.scope_type WHEN 'ORGANIZATION' THEN 'Toàn tổ chức'
      WHEN 'BUILDING' THEN 'Toà: '||COALESCE(b.name,'(chưa đặt tên)')
      WHEN 'AREA' THEN 'Khu vực: '||COALESCE(a.name,'(chưa đặt tên)') END,
    'buildingId',scope.building_id,'areaId',scope.area_id,'cashbookId',NULL) ORDER BY scope.id),'[]') INTO choices
    FROM public.authorization_scopes scope
    LEFT JOIN public.buildings b ON b.id=scope.building_id AND b.organization_id=org AND b.deleted_at IS NULL
    LEFT JOIN public.areas a ON a.id=scope.area_id AND a.organization_id=org AND a.deleted_at IS NULL
    WHERE scope.organization_id=org AND scope.id=ANY(policy.scope_ids) AND scope.cashbook_id IS NULL
      AND (p_kind<>'context' OR result->'scopeIds' ? scope.id::text) AND (
      (scope.scope_type='ORGANIZATION' AND scope.building_id IS NULL AND scope.area_id IS NULL AND cardinality(building_ids)>0) OR
      (scope.scope_type='BUILDING' AND b.id=ANY(building_ids) AND scope.area_id IS NULL) OR
      (scope.scope_type='AREA' AND a.id IS NOT NULL AND scope.building_id IS NULL AND EXISTS(
        SELECT 1 FROM public.area_buildings ab WHERE ab.organization_id=org AND ab.area_id=a.id AND ab.building_id=ANY(building_ids))));
  IF jsonb_array_length(choices)=0 THEN RETURN result; END IF;
  IF p_kind='context' THEN
    IF result#>'{restrictions,action}' ? action_key AND result#>'{companyCeilings,action}' ? action_key
      AND NOT(result#>'{effective,action}' ? action_key) THEN
      result:=jsonb_set(result,'{effective,action}',(result#>'{effective,action}')||to_jsonb(action_key),false);
    END IF;
    RETURN result;
  END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'scopeId'),'[]') INTO combined FROM (
    SELECT DISTINCT ON (value->>'scopeId') value FROM jsonb_array_elements((result->'scopes')||choices)
    ORDER BY value->>'scopeId') selected;
  IF jsonb_array_length(combined)>256 THEN RAISE EXCEPTION 'hermes_room_pass_scope_too_large' USING ERRCODE='22023'; END IF;
  result:=jsonb_set(result,'{scopes}',combined,false);
  IF NOT(result->'action' ? action_key) THEN result:=jsonb_set(result,'{action}',(result->'action')||to_jsonb(action_key),false); END IF;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v4(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_room_pass_extend_options_v1(public.hermes_org_policy_options_v3(p_org),'org_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_options_v4(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_room_pass_extend_options_v1(public.hermes_connection_options_v3(p_org),'connection_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v4(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_room_pass_extend_options_v1(public.hermes_connection_context_v3(p_connection_id),'context'); END $fn$;
DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.hermes_room_pass_extend_options_v1(jsonb,text)',
    'public.hermes_org_policy_options_v4(uuid)','public.hermes_connection_options_v4(uuid)','public.hermes_connection_context_v4(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
  END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v4(uuid),public.hermes_connection_options_v4(uuid),public.hermes_connection_context_v4(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
