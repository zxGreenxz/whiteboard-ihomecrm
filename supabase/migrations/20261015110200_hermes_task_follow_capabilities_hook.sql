-- Capabilities hook (gói D). Chỉ thêm lựa chọn cho tasks.edit, tasks.delete và
-- assistant.memory.supervise vào bộ options/context v5 đang dùng chung; không bật
-- registry, không ghi chính sách, không sao chép vai trò. Người tích hợp có thể
-- gộp hook này với các hook song song khác thành một tầng v6 duy nhất.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_extend_options_v1(p_result jsonb,p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb:=p_result; org uuid; member jsonb; caps jsonb; info jsonb; r record;
  policy app_private.hermes_org_policies; choices jsonb; combined jsonb; building_ids uuid[]; path text[];
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('org_options','connection_options','context')
    OR jsonb_typeof(result) IS DISTINCT FROM 'object' OR auth.role() IS DISTINCT FROM 'authenticated'
    OR result->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  org:=app_private.hermes_uuid_v1(result->'organizationId');
  PERFORM app_private.lock_org_for_decision_v1(org);
  member:=app_private.hermes_member_v1(auth.uid(),org);
  IF member->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR member->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='org_options' THEN
    -- The base options already enforce CRM users.edit. Add enabled registry choices only.
    FOR r IN SELECT * FROM (VALUES ('tasks.edit','action'),('tasks.delete','action'),('assistant.memory.supervise','read')) AS v(capability,mode) LOOP
      path:=ARRAY['choices',r.mode];
      IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=r.capability AND h.mode=r.mode AND h.enabled)
        AND NOT(result#>path ? r.capability) THEN
        result:=jsonb_set(result,path,(result#>path)||to_jsonb(r.capability),false);
      END IF;
    END LOOP;
    RETURN result;
  END IF;
  caps:=public.hermes_task_follow_capabilities_v1(org);
  IF caps->>'userId' IS DISTINCT FROM result->>'userId' OR caps->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR caps->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR caps->>'policyVersion' IS DISTINCT FROM result->>'policyVersion' OR caps->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin'
    THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='connection_options' AND result->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN result; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(org,NULL,NULL,NULL);
  FOR r IN SELECT * FROM (VALUES ('tasks.edit','action'),('tasks.delete','action'),('assistant.memory.supervise','read')) AS v(capability,mode) LOOP
    info:=caps->'permissions'->r.capability;
    IF info->'allowed' IS DISTINCT FROM 'true'::jsonb THEN CONTINUE; END IF;
    IF r.mode='action' THEN
      SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO building_ids FROM jsonb_array_elements_text(info->'buildingIds');
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
      IF jsonb_array_length(choices)=0 THEN CONTINUE; END IF;
    END IF;
    IF p_kind='context' THEN
      path:=ARRAY['effective',r.mode];
      IF result#>ARRAY['restrictions',r.mode] ? r.capability AND result#>ARRAY['companyCeilings',r.mode] ? r.capability
        AND NOT(result#>path ? r.capability) THEN
        result:=jsonb_set(result,path,(result#>path)||to_jsonb(r.capability),false);
      END IF;
      CONTINUE;
    END IF;
    IF r.mode='action' THEN
      SELECT COALESCE(jsonb_agg(value ORDER BY value->>'scopeId'),'[]') INTO combined FROM (
        SELECT DISTINCT ON (value->>'scopeId') value FROM jsonb_array_elements((result->'scopes')||choices)
        ORDER BY value->>'scopeId') selected;
      IF jsonb_array_length(combined)>256 THEN RAISE EXCEPTION 'hermes_task_scope_too_large' USING ERRCODE='22023'; END IF;
      result:=jsonb_set(result,'{scopes}',combined,false);
    END IF;
    IF NOT(result->r.mode ? r.capability) THEN
      result:=jsonb_set(result,ARRAY[r.mode],(result->r.mode)||to_jsonb(r.capability),false);
    END IF;
  END LOOP;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v6(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_task_follow_extend_options_v1(public.hermes_org_policy_options_v5(p_org),'org_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_options_v6(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_task_follow_extend_options_v1(public.hermes_connection_options_v5(p_org),'connection_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v6(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_task_follow_extend_options_v1(public.hermes_connection_context_v5(p_connection_id),'context'); END $fn$;
DO $acl$ DECLARE signature text; BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.hermes_task_follow_extend_options_v1(jsonb,text)',
    'public.hermes_org_policy_options_v6(uuid)','public.hermes_connection_options_v6(uuid)','public.hermes_connection_context_v6(uuid)'] LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO postgres',signature);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor',signature);
  END LOOP;
END $acl$;
GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v6(uuid),public.hermes_connection_options_v6(uuid),
  public.hermes_connection_context_v6(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
