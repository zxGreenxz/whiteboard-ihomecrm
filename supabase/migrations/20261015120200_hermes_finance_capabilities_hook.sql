-- HOOK dùng chung: thêm lựa chọn/quyền hiệu lực của họ đọc v2 (thu chi, chỉ số,
-- cọc, lãi lỗ) và Thao tác ghi phiếu chi Hermes vào ba wrapper options/context v5.
-- Chỉ định nghĩa lại đúng ba hàm public.hermes_org_policy_options_v5,
-- public.hermes_connection_options_v5, public.hermes_connection_context_v5 (giữ
-- nguyên chữ ký, SECURITY, search_path, ACL) để bọc thêm một lớp
-- app_private.hermes_finance_extend_options_v1. Người tích hợp gộp lớp này với
-- các hook song song khác thành MỘT chuỗi; không bật registry, chính sách hay
-- quyền user. Phụ thuộc 20261015120000 và 20261015120100.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
CREATE OR REPLACE FUNCTION app_private.hermes_finance_extend_options_v1(p_result jsonb,p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb:=p_result; org uuid; member jsonb; reads jsonb; actions jsonb; key text; v_mode text; cap jsonb;
  policy app_private.hermes_org_policies; building_ids uuid[]:='{}'::uuid[]; choices jsonb; combined jsonb; kept jsonb;
  read_keys constant text[]:=ARRAY['income_expenses.view','meter_readings.view','deposits.view','reports_finance.analysis'];
  action_keys constant text[]:=ARRAY['income_expenses.create','income_expenses.approve'];
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('org_options','connection_options','context') OR jsonb_typeof(result) IS DISTINCT FROM 'object'
    OR auth.role() IS DISTINCT FROM 'authenticated' OR result->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  org:=app_private.hermes_uuid_v1(result->'organizationId');
  PERFORM app_private.lock_org_for_decision_v1(org);
  member:=app_private.hermes_member_v1(auth.uid(),org);
  IF member->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='org_options' THEN
    -- The base wrapper already enforced CRM users.edit. Adds enabled registry
    -- choices only; never enables registry/policy or copies a role.
    FOR key,v_mode IN SELECT h.capability,h.mode FROM app_private.hermes_capabilities h WHERE h.enabled
      AND ((h.capability=ANY(read_keys) AND h.mode='read') OR (h.capability=ANY(action_keys) AND h.mode='action')) ORDER BY h.capability LOOP
      IF NOT(result#>ARRAY['choices',v_mode] ? key) THEN
        result:=jsonb_set(result,ARRAY['choices',v_mode],(result#>ARRAY['choices',v_mode])||to_jsonb(key),false);
      END IF;
    END LOOP;
    RETURN result;
  END IF;
  reads:=public.hermes_domain_capabilities_v2(org);
  actions:=public.hermes_expense_capabilities_v1(org);
  IF reads->>'policyVersion' IS DISTINCT FROM result->>'policyVersion' OR actions->>'policyVersion' IS DISTINCT FROM result->>'policyVersion'
    OR reads->>'membershipId' IS DISTINCT FROM result->>'membershipId' OR actions->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR reads->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    OR actions->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='connection_options' AND result->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN result; END IF;
  FOREACH key IN ARRAY read_keys||action_keys LOOP
    v_mode:=CASE WHEN key=ANY(read_keys) THEN 'read' ELSE 'action' END;
    cap:=(CASE v_mode WHEN 'read' THEN reads ELSE actions END)->'permissions'->key;
    CONTINUE WHEN cap->'allowed' IS DISTINCT FROM 'true'::jsonb;
    IF p_kind='connection_options' THEN
      IF NOT(result->v_mode ? key) THEN result:=jsonb_set(result,ARRAY[v_mode],(result->v_mode)||to_jsonb(key),false); END IF;
      SELECT COALESCE(array_agg(DISTINCT value::uuid),'{}'::uuid[]) INTO building_ids FROM (
        SELECT unnest(building_ids)::text value UNION SELECT jsonb_array_elements_text(cap->'buildingIds')) merged;
    ELSIF result#>ARRAY['restrictions',v_mode] ? key AND result#>ARRAY['companyCeilings',v_mode] ? key
      AND NOT(result#>ARRAY['effective',v_mode] ? key) THEN
      result:=jsonb_set(result,ARRAY['effective',v_mode],(result#>ARRAY['effective',v_mode])||to_jsonb(key),false);
    END IF;
  END LOOP;
  IF p_kind='context' THEN RETURN result; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(org,NULL,NULL,NULL);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',scope.id,'scopeType',scope.scope_type,
    'label',CASE scope.scope_type WHEN 'ORGANIZATION' THEN 'Toàn tổ chức' WHEN 'BUILDING' THEN 'Toà: '||COALESCE(b.name,'(chưa đặt tên)')
      WHEN 'AREA' THEN 'Khu vực: '||COALESCE(a.name,'(chưa đặt tên)') END,
    'buildingId',scope.building_id,'areaId',scope.area_id,'cashbookId',NULL) ORDER BY scope.id),'[]') INTO choices
    FROM public.authorization_scopes scope
    LEFT JOIN public.buildings b ON b.id=scope.building_id AND b.organization_id=org AND b.deleted_at IS NULL
    LEFT JOIN public.areas a ON a.id=scope.area_id AND a.organization_id=org AND a.deleted_at IS NULL
    WHERE scope.organization_id=org AND scope.id=ANY(policy.scope_ids) AND scope.cashbook_id IS NULL AND (
      (scope.scope_type='ORGANIZATION' AND scope.building_id IS NULL AND scope.area_id IS NULL AND cardinality(building_ids)>0) OR
      (scope.scope_type='BUILDING' AND b.id=ANY(building_ids) AND scope.area_id IS NULL) OR
      (scope.scope_type='AREA' AND a.id IS NOT NULL AND scope.building_id IS NULL AND EXISTS(SELECT 1 FROM public.area_buildings ab
        WHERE ab.organization_id=org AND ab.area_id=a.id AND ab.building_id=ANY(building_ids))));
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'scopeId'),'[]') INTO combined FROM (
    SELECT DISTINCT ON (value->>'scopeId') value FROM jsonb_array_elements((result->'scopes')||choices) ORDER BY value->>'scopeId') selected;
  IF jsonb_array_length(combined)>256 THEN RAISE EXCEPTION 'hermes_domain_scope_too_large' USING ERRCODE='22023'; END IF;
  result:=jsonb_set(result,'{scopes}',combined,false);
  IF jsonb_array_length(combined)=0 THEN
    -- Nothing selectable: do not offer keys that could never be used.
    SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]') INTO kept FROM jsonb_array_elements(result->'read') value WHERE NOT(value#>>'{}'=ANY(read_keys));
    result:=jsonb_set(result,'{read}',kept,false);
    SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]') INTO kept FROM jsonb_array_elements(result->'action') value WHERE NOT(value#>>'{}'=ANY(action_keys));
    result:=jsonb_set(result,'{action}',kept,false);
  END IF;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v5(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_finance_extend_options_v1(app_private.hermes_task_extend_options_v1(public.hermes_org_policy_options_v4(p_org),'org_options'),'org_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_options_v5(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_finance_extend_options_v1(app_private.hermes_task_extend_options_v1(public.hermes_connection_options_v4(p_org),'connection_options'),'connection_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v5(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_finance_extend_options_v1(app_private.hermes_task_extend_options_v1(public.hermes_connection_context_v4(p_connection_id),'context'),'context'); END $fn$;

ALTER FUNCTION app_private.hermes_finance_extend_options_v1(jsonb,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_finance_extend_options_v1(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_org_policy_options_v5(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_org_policy_options_v5(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_org_policy_options_v5(uuid) TO authenticated;
ALTER FUNCTION public.hermes_connection_options_v5(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_options_v5(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_connection_options_v5(uuid) TO authenticated;
ALTER FUNCTION public.hermes_connection_context_v5(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_context_v5(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_connection_context_v5(uuid) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
