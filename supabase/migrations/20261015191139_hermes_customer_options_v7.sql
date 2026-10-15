-- Hermes Thao tác "Khách hàng": đưa customers.create và leads.create vào bộ
-- options/context v7 = lớp khách hàng bọc v6 (v6 giữ nguyên làm legacy).
-- Registry đã bật (20261015172059) và hàm kiểm lúc chạy đã có (20261014104442),
-- nhưng chưa lớp options/context nào thêm hai khoá này nên màn /settings/hermes
-- không cho chọn, kết nối tạo ra thiếu quyền và broker không phát
-- crm_customer_*/crm_lead_*.
-- Lớp mới chỉ thêm lựa chọn/quyền hiệu lực, không bật registry, không ghi chính
-- sách, không sao chép vai trò. Mỗi khoá chỉ hiện khi
-- public.hermes_customer_create_capabilities_v1 cho allowed (registry ∩ trần công
-- ty ∩ quyền CRM tạo khách/khách hẹn của chính user) và còn phạm vi Toàn tổ chức
-- trong trần công ty — cùng vị từ overlay mà hermes_customer_guard_v1 đòi lúc chạy.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $guard$
BEGIN
  IF to_regprocedure('public.hermes_customer_create_capabilities_v1(uuid)') IS NULL
    OR to_regprocedure('public.hermes_org_policy_options_v6(uuid)') IS NULL
    OR to_regprocedure('public.hermes_connection_options_v6(uuid)') IS NULL
    OR to_regprocedure('public.hermes_connection_context_v6(uuid)') IS NULL THEN
    RAISE EXCEPTION 'hermes_customer_options_requires_v6' USING ERRCODE='55000'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION app_private.hermes_customer_extend_options_v1(p_result jsonb,p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb:=p_result; org uuid; member jsonb; caps jsonb; key text;
  policy app_private.hermes_org_policies; choices jsonb; combined jsonb;
  action_keys constant text[]:=ARRAY['customers.create','leads.create'];
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('org_options','connection_options','context')
    OR jsonb_typeof(result) IS DISTINCT FROM 'object' OR auth.role() IS DISTINCT FROM 'authenticated'
    OR result->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_customer_denied' USING ERRCODE='42501'; END IF;
  org:=app_private.hermes_uuid_v1(result->'organizationId');
  PERFORM app_private.lock_org_for_decision_v1(org);
  member:=app_private.hermes_member_v1(auth.uid(),org);
  IF member->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR member->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin'
    THEN RAISE EXCEPTION 'hermes_customer_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='org_options' THEN
    -- The base wrapper already enforced CRM users.edit. Adds enabled registry
    -- choices only; never enables registry/policy or copies a role.
    FOREACH key IN ARRAY action_keys LOOP
      IF EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='action' AND h.enabled)
        AND NOT(result#>'{choices,action}' ? key) THEN
        result:=jsonb_set(result,'{choices,action}',(result#>'{choices,action}')||to_jsonb(key),false);
      END IF;
    END LOOP;
    RETURN result;
  END IF;
  caps:=public.hermes_customer_create_capabilities_v1(org);
  IF caps->>'userId' IS DISTINCT FROM result->>'userId' OR caps->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR caps->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR caps->>'policyVersion' IS DISTINCT FROM result->>'policyVersion' OR caps->'isSuperadmin' IS DISTINCT FROM result->'isSuperadmin'
    THEN RAISE EXCEPTION 'hermes_customer_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='connection_options' AND result->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN result; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(org,NULL,NULL,NULL);
  -- Customer/lead records have no building: only a company-allowed Toàn tổ chức
  -- scope is selectable. Context counts only the connection's own saved scope.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',scope.id,'scopeType',scope.scope_type,'label','Toàn tổ chức',
    'buildingId',scope.building_id,'areaId',scope.area_id,'cashbookId',NULL) ORDER BY scope.id),'[]') INTO choices
    FROM public.authorization_scopes scope
    WHERE scope.organization_id=org AND scope.id=ANY(policy.scope_ids) AND scope.scope_type='ORGANIZATION'
      AND scope.building_id IS NULL AND scope.area_id IS NULL AND scope.cashbook_id IS NULL
      AND (p_kind<>'context' OR (jsonb_typeof(result->'scopeIds')='array' AND result->'scopeIds' ? scope.id::text));
  IF jsonb_array_length(choices)=0 THEN RETURN result; END IF;
  FOREACH key IN ARRAY action_keys LOOP
    CONTINUE WHEN caps#>ARRAY['permissions',key,'allowed'] IS DISTINCT FROM 'true'::jsonb;
    IF p_kind='context' THEN
      IF result#>'{restrictions,action}' ? key AND result#>'{companyCeilings,action}' ? key
        AND NOT(result#>'{effective,action}' ? key) THEN
        result:=jsonb_set(result,'{effective,action}',(result#>'{effective,action}')||to_jsonb(key),false);
      END IF;
      CONTINUE;
    END IF;
    SELECT COALESCE(jsonb_agg(value ORDER BY value->>'scopeId'),'[]') INTO combined FROM (
      SELECT DISTINCT ON (value->>'scopeId') value FROM jsonb_array_elements((result->'scopes')||choices)
      ORDER BY value->>'scopeId') selected;
    IF jsonb_array_length(combined)>256 THEN RAISE EXCEPTION 'hermes_customer_scope_too_large' USING ERRCODE='22023'; END IF;
    result:=jsonb_set(result,'{scopes}',combined,false);
    IF NOT(result->'action' ? key) THEN
      result:=jsonb_set(result,'{action}',(result->'action')||to_jsonb(key),false);
    END IF;
  END LOOP;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v7(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_customer_extend_options_v1(public.hermes_org_policy_options_v6(p_org),'org_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_options_v7(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_customer_extend_options_v1(public.hermes_connection_options_v6(p_org),'connection_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v7(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_customer_extend_options_v1(public.hermes_connection_context_v6(p_connection_id),'context'); END $fn$;

ALTER FUNCTION app_private.hermes_customer_extend_options_v1(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_customer_extend_options_v1(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_org_policy_options_v7(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_org_policy_options_v7(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_connection_options_v7(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_options_v7(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_connection_context_v7(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_context_v7(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v7(uuid),public.hermes_connection_options_v7(uuid),
  public.hermes_connection_context_v7(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
