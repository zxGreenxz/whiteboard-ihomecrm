-- Hermes đọc đầy đủ — ĐỢT 2, Gói 0: nền tảng tuần tự (18/10/2026). Chạy SAU
-- 20261017033630_hermes_full_read_owner_scope_v1. Chủ chốt 17/10: mọi đọc theo ĐÚNG quyền của user
-- trên web; chỗ web hở thì Hermes chặt hơn (ghi lại để báo chủ). File này KHÔNG đọc dữ liệu nghiệp vụ
-- nào; nó dựng khung để bốn gói A/B/C/D làm song song mà không sửa chung một hàm:
--  1. Seed MỘT lần 35 khoá đọc mới, enabled=false (Gói Z bật sau khi có tool). Tên = khoá web đang
--     dùng; riêng hai khoá Hermes-only vì web không có khoá: assistant.salary.self (Lương của tôi,
--     /finance/my-salary chỉ cần cấu hình lương của chính mình) và assistant.bank_events.read (Biến động
--     số dư, /bien-dong-so-du chỉ RequireSuperAdmin). Danh sách: app_private.hermes_w2_read_keys_v1()
--     (khớp W2_READ_KEYS trong infra/hermes-broker/wave2-registry.mjs).
--  2. public.hermes_domain_capabilities_v3(org): trạng thái cấp quyền từng khoá đợt 2 cho broker (khuôn
--     hermes_domain_capabilities_v2; v2 GIỮ NGUYÊN 4 khoá vì broker đang chạy so khớp đúng 4 khoá).
--  3. Màn Kết nối Hermes (options/context v7, chữ ký giữ nguyên): thêm lớp ngoài cùng
--     app_private.hermes_w2_extend_options_v1 bọc customer(v6); khoá đợt 2 chỉ hiện khi registry bật.
--  4. Cổng đọc: public.hermes_domain_read_v3 (thay MỘT lần) chuyển hai miền meta report_list/report sang
--     app_private.hermes_w2_gate_v1; mọi dòng còn lại GIỮ NGUYÊN thân 20261017033630 (test so từng ký tự).
--     Cổng: binding/phiên/chính sách như v3; quyền = CRM thật ∩ registry ∩ chính sách công ty ∩ Read của
--     kết nối ∩ toà overlay; tham số theo từ điển chung (hermes_w2_params_v1); bảng báo cáo
--     hermes_w2_catalog_v1 gom hermes_w2{a,b,c,d}_catalog_v1; định tuyến sang hermes_w2{a,b,c,d}_read_v1;
--     phân trang/trần byte dùng chung. Mỗi gói CHỈ CREATE OR REPLACE hai hàm của mình (catalog + read)
--     trong dải timestamp riêng: A 2026101801xxxx, B 2026101802xxxx, C 2026101803xxxx, D 2026101804xxxx
--     (Z 2026101809xxxx). Lúc này: catalog rỗng, read trả unavailable=not_implemented.
-- Không DROP, không đổi chữ ký hàm đã phát hành, không gọi hàm copilot_* nào, không ghi dữ liệu nghiệp vụ.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.hermes_domain_read_v3(jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_domain_grant_v2(uuid,text,boolean,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_full_read_scope_v1(app_private.hermes_connections,app_private.hermes_org_policies,jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_customer_extend_options_v1(jsonb,text)') IS NULL
    OR to_regprocedure('public.hermes_connection_options_v6(uuid)') IS NULL THEN
    RAISE EXCEPTION 'hermes_w2_foundation_requires_full_read_and_options_v7';
  END IF;
END $requires$;

-- 1. Khoá đọc đợt 2: một nguồn cho seed, capabilities, options và test.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_read_keys_v1()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT ARRAY['reports_finance.payment_schedule','reports_finance.overpayment','reports_finance.deposits_report','thu_tien.view',
   'reports_finance.daily_cashbook','reports_finance.cash_flow','reports_finance.handover_report','reports_finance.collection_cycle',
   'cashbooks.view','income_expenses.restricted_view','reports_finance.profit_distribution','shareholder_profit.view',
   'personal_finance.view','assistant.bank_events.read',
   'vehicles.view','materials.view','warehouses.view','salary.view','assistant.salary.self','notifications.view','network_center.view',
   'buildings.view','meters.view','suppliers.view','hotline.view','task_types.view','service_quotas.view','categories.view',
   'reports_real_estate.vacant_rooms','reports_real_estate.expiring','reports_real_estate.renewals_transfers',
   'reports_real_estate.promotions','reports_real_estate.new_leases','reports_real_estate.terminations',
   'reports_real_estate.expense_ratio']::text[]
$fn$;
-- Dữ liệu của CHÍNH người hỏi, không theo toà: grant không trả toà, không cần chọn phạm vi.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_self_keys_v1()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT ARRAY['personal_finance.view','assistant.bank_events.read','assistant.salary.self','notifications.view']::text[]
$fn$;

INSERT INTO app_private.hermes_capabilities(capability,mode,enabled)
  SELECT key,'read',false FROM unnest(app_private.hermes_w2_read_keys_v1()) key
ON CONFLICT(capability) DO NOTHING;
DO $seeded$
DECLARE v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing FROM unnest(app_private.hermes_w2_read_keys_v1()) key
    WHERE NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='read');
  IF v_missing<>0 THEN RAISE EXCEPTION 'hermes_w2_keys_not_read: % khoá', v_missing; END IF;
END $seeded$;

-- Cấp quyền MỘT khoá cho đợt 2. Khoá catalog CRM: đúng hermes_domain_grant_v2 (context +
-- authorized_scope_v3 của đúng khoá); khoá self bỏ danh sách toà. Hai khoá Hermes-only tự quyết
-- theo đúng cổng của màn web tương ứng.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_grant_v1(p_org uuid,p_key text,p_enabled boolean,p_context jsonb,p_member jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_state jsonb; v_allowed boolean;
BEGIN
  IF p_org IS NULL OR p_key IS NULL OR jsonb_typeof(p_context) IS DISTINCT FROM 'object' OR jsonb_typeof(p_member) IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  IF p_key='assistant.salary.self' THEN
    -- /finance/my-salary không có khoá web: thành viên nào cũng mở được, trang tự kiểm cấu hình
    -- lương của CHÍNH người xem (Gói C kiểm khi đọc).
    v_allowed:=COALESCE(p_enabled,false);
  ELSIF p_key='assistant.bank_events.read' THEN
    -- /bien-dong-so-du: RequireSuperAdmin; bank_event_admin_v1 chỉ is_super_admin().
    v_allowed:=COALESCE(p_enabled,false) AND p_member->'isSuperadmin'='true'::jsonb;
  ELSE
    v_state:=app_private.hermes_domain_grant_v2(p_org,p_key,p_enabled,p_context);
    IF p_key=ANY(app_private.hermes_w2_self_keys_v1()) THEN RETURN jsonb_set(v_state,'{buildingIds}','[]'::jsonb,false); END IF;
    RETURN v_state;
  END IF;
  RETURN jsonb_build_object('allowed',v_allowed,'companyEnabled',COALESCE(p_enabled,false),'buildingIds','[]'::jsonb,'orgWide',false);
END $fn$;

-- 2. Trạng thái cấp quyền các khoá đợt 2 (khuôn hermes_domain_capabilities_v2; khoá cố định =
-- hermes_w2_read_keys_v1(), khớp DOMAIN_FAMILIES.v3.capabilities của broker).
CREATE OR REPLACE FUNCTION public.hermes_domain_capabilities_v3(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE member jsonb; policy app_private.hermes_org_policies; context jsonb; key text; state jsonb; result jsonb:='{}'; enabled boolean;
  keys constant text[]:=app_private.hermes_w2_read_keys_v1();
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL OR p_organization_id IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  member:=app_private.hermes_member_v1(auth.uid(),p_organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(p_organization_id);
  IF context->>'organizationId' IS DISTINCT FROM p_organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(p_organization_id,keys,'{}'::text[],NULL);
  FOREACH key IN ARRAY keys LOOP
    enabled:=policy.enabled AND key=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=key AND h.mode='read' AND h.enabled);
    state:=app_private.hermes_w2_grant_v1(p_organization_id,key,enabled,context,member);
    result:=result||jsonb_build_object(key,state-'orgWide');
  END LOOP;
  RETURN member||jsonb_build_object('organizationId',p_organization_id,'userId',auth.uid(),'policyVersion',policy.version,'permissions',result);
END $fn$;

-- 3. Lớp options/context đợt 2 (cùng khuôn hermes_finance_extend_options_v1 bản 20261015130000):
-- chính sách công ty thêm lựa chọn từ registry đã bật; options kết nối thêm khoá đang được CRM cấp và
-- phạm vi toà của chúng; context đưa khoá vào effective khi phạm vi kết nối còn phủ toà của grant.
-- Khoá self không theo toà. Không có khoá đợt 2 nào được cấp ⇒ trả NGUYÊN kết quả lớp dưới.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_extend_options_v1(p_result jsonb,p_kind text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE result jsonb:=p_result; org uuid; member jsonb; reads jsonb; key text; cap jsonb; added boolean:=false;
  policy app_private.hermes_org_policies; building_ids uuid[]:='{}'::uuid[]; cap_buildings uuid[]; choices jsonb; combined jsonb; kept jsonb;
  read_keys constant text[]:=app_private.hermes_w2_read_keys_v1(); self_keys constant text[]:=app_private.hermes_w2_self_keys_v1();
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
    -- Lớp gốc đã kiểm users.edit. Chỉ thêm lựa chọn registry đã bật; không bật registry/chính sách.
    FOR key IN SELECT h.capability FROM app_private.hermes_capabilities h WHERE h.enabled AND h.mode='read' AND h.capability=ANY(read_keys)
      ORDER BY h.capability LOOP
      IF NOT(result#>'{choices,read}' ? key) THEN
        result:=jsonb_set(result,'{choices,read}',(result#>'{choices,read}')||to_jsonb(key),false);
      END IF;
    END LOOP;
    RETURN result;
  END IF;
  reads:=public.hermes_domain_capabilities_v3(org);
  IF reads->>'policyVersion' IS DISTINCT FROM result->>'policyVersion' OR reads->>'membershipId' IS DISTINCT FROM result->>'membershipId'
    OR reads->>'authorizationVersion' IS DISTINCT FROM result->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_kind='connection_options' AND result->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN result; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(org,NULL,NULL,NULL);
  FOREACH key IN ARRAY read_keys LOOP
    cap:=reads->'permissions'->key;
    CONTINUE WHEN cap->'allowed' IS DISTINCT FROM 'true'::jsonb;
    IF p_kind='connection_options' THEN
      added:=true;
      IF NOT(result->'read' ? key) THEN result:=jsonb_set(result,'{read}',(result->'read')||to_jsonb(key),false); END IF;
      SELECT COALESCE(array_agg(DISTINCT value::uuid),'{}'::uuid[]) INTO building_ids FROM (
        SELECT unnest(building_ids)::text value UNION SELECT jsonb_array_elements_text(cap->'buildingIds')) merged;
    ELSIF result#>'{restrictions,read}' ? key AND result#>'{companyCeilings,read}' ? key AND NOT(result#>'{effective,read}' ? key) THEN
      IF key=ANY(self_keys) THEN
        result:=jsonb_set(result,'{effective,read}',(result#>'{effective,read}')||to_jsonb(key),false);
      ELSE
        SELECT COALESCE(array_agg(value::uuid),'{}'::uuid[]) INTO cap_buildings
          FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(cap->'buildingIds')='array' THEN cap->'buildingIds' ELSE '[]'::jsonb END);
        IF jsonb_typeof(result->'scopeIds')='array' AND EXISTS(SELECT 1 FROM public.authorization_scopes scope
            LEFT JOIN public.buildings b ON b.id=scope.building_id AND b.organization_id=org AND b.deleted_at IS NULL
            LEFT JOIN public.areas a ON a.id=scope.area_id AND a.organization_id=org AND a.deleted_at IS NULL
            WHERE scope.organization_id=org AND scope.id=ANY(policy.scope_ids) AND scope.cashbook_id IS NULL
              AND result->'scopeIds' ? scope.id::text AND (
              (scope.scope_type='ORGANIZATION' AND scope.building_id IS NULL AND scope.area_id IS NULL AND cardinality(cap_buildings)>0) OR
              (scope.scope_type='BUILDING' AND b.id=ANY(cap_buildings) AND scope.area_id IS NULL) OR
              (scope.scope_type='AREA' AND a.id IS NOT NULL AND scope.building_id IS NULL AND EXISTS(SELECT 1 FROM public.area_buildings ab
                WHERE ab.organization_id=org AND ab.area_id=a.id AND ab.building_id=ANY(cap_buildings))))) THEN
          result:=jsonb_set(result,'{effective,read}',(result#>'{effective,read}')||to_jsonb(key),false);
        END IF;
      END IF;
    END IF;
  END LOOP;
  IF p_kind='context' OR NOT added THEN RETURN result; END IF;
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
    -- Không phạm vi nào chọn được: bỏ khoá đợt 2 cần phạm vi; khoá self vẫn dùng được.
    SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]') INTO kept FROM jsonb_array_elements(result->'read') value
      WHERE NOT(value#>>'{}'=ANY(read_keys)) OR value#>>'{}'=ANY(self_keys);
    result:=jsonb_set(result,'{read}',kept,false);
  END IF;
  RETURN result;
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_org_policy_options_v7(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_w2_extend_options_v1(app_private.hermes_customer_extend_options_v1(public.hermes_org_policy_options_v6(p_org),'org_options'),'org_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_options_v7(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_w2_extend_options_v1(app_private.hermes_customer_extend_options_v1(public.hermes_connection_options_v6(p_org),'connection_options'),'connection_options'); END $fn$;
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v7(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN RETURN app_private.hermes_w2_extend_options_v1(app_private.hermes_customer_extend_options_v1(public.hermes_connection_context_v6(p_connection_id),'context'),'context'); END $fn$;

-- 4a. Bảng báo cáo của từng gói. GÓI <x> THAY THÂN hermes_w2<x>_catalog_v1 (CREATE OR REPLACE trong
-- migration của gói): trả object {mã báo cáo: spec}, spec ĐÚNG tám khoá
-- {"permission","source","scope","params","required","statuses","kinds","scopeKeys"} khớp
-- wave2-<x>-contract.mjs (test so khớp). Khung: chưa có báo cáo.
CREATE OR REPLACE FUNCTION app_private.hermes_w2a_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT '{}'::jsonb
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT '{}'::jsonb
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_w2c_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT '{}'::jsonb
$fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_catalog_v1()
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT '{}'::jsonb
$fn$;

-- Từ điển tên tham số DUY NHẤT của đợt 2 (khớp Object.keys(W2_PARAMS) của wave2-kit.mjs).
CREATE OR REPLACE FUNCTION app_private.hermes_w2_param_names_v1()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT ARRAY['query','status','kind','month','year','fromDate','toDate','date','days','floor','basis','unreadOnly','lowStock',
   'buildingId','areaId','roomId','customerId','contractId','invoiceId','cashbookId','staffId','categoryId','supplierId','materialId',
   'itemId','fromId','toId']::text[]
$fn$;

-- 4b. Gom bốn bảng: kiểm khuôn từng spec, cấm trùng mã giữa các gói (lỗi là lỗi khai báo của gói:
-- XX000 ⇒ broker backend_unavailable, không lộ gì). p_report NULL ⇒ cả bảng; mã ⇒ spec+package hoặc NULL.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_catalog_v1(p_report text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE v_all jsonb:='{}'::jsonb; v_part jsonb; v_letter text; v_key text; v_spec jsonb;
BEGIN
  FOREACH v_letter IN ARRAY ARRAY['a','b','c','d'] LOOP
    v_part:=CASE v_letter WHEN 'a' THEN app_private.hermes_w2a_catalog_v1() WHEN 'b' THEN app_private.hermes_w2b_catalog_v1()
      WHEN 'c' THEN app_private.hermes_w2c_catalog_v1() ELSE app_private.hermes_w2d_catalog_v1() END;
    IF jsonb_typeof(v_part) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'hermes_w2_catalog_invalid' USING ERRCODE='XX000'; END IF;
    FOR v_key,v_spec IN SELECT e.key,e.value FROM jsonb_each(v_part) e LOOP
      -- Kiểm theo bậc: chỉ gọi hàm mảng/khoá trên đúng kiểu, để khai báo hỏng luôn ra XX000.
      IF v_all ? v_key OR v_key !~ '^[a-z][a-z0-9_]{1,47}$' OR jsonb_typeof(v_spec) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'hermes_w2_catalog_invalid' USING ERRCODE='XX000'; END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(v_spec))<>8
        OR NOT(v_spec ?& ARRAY['permission','source','scope','params','required','statuses','kinds','scopeKeys'])
        OR jsonb_typeof(v_spec->'permission') IS DISTINCT FROM 'string' OR (v_spec->>'permission') !~ '^[a-z][a-z0-9_.]{0,127}$'
        OR jsonb_typeof(v_spec->'source') IS DISTINCT FROM 'string' OR (v_spec->>'source') !~ '^crm\.[a-z][a-z0-9_.]{0,79}$'
        OR NOT COALESCE(v_spec->>'scope' IN ('rows','buildings','organization','self'),false)
        OR jsonb_typeof(v_spec->'params') IS DISTINCT FROM 'array' OR jsonb_typeof(v_spec->'required') IS DISTINCT FROM 'array'
        OR jsonb_typeof(v_spec->'scopeKeys') IS DISTINCT FROM 'array'
        OR NOT COALESCE(jsonb_typeof(v_spec->'statuses') IN ('null','array'),false)
        OR NOT COALESCE(jsonb_typeof(v_spec->'kinds') IN ('null','array'),false) THEN
        RAISE EXCEPTION 'hermes_w2_catalog_invalid' USING ERRCODE='XX000'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_spec->'params') p WHERE jsonb_typeof(p)<>'string'
          OR NOT((p#>>'{}')=ANY(app_private.hermes_w2_param_names_v1())))
        OR jsonb_array_length(v_spec->'params')<>(SELECT count(DISTINCT p) FROM jsonb_array_elements(v_spec->'params') p)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_spec->'required') r WHERE NOT(v_spec->'params' @> jsonb_build_array(r)))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_spec->'scopeKeys') s WHERE jsonb_typeof(s)<>'string'
          OR (s#>>'{}') !~ '^[a-z][a-z0-9_.]{0,127}$')
        OR (v_spec->'params' @> '["status"]'::jsonb) IS DISTINCT FROM (jsonb_typeof(v_spec->'statuses')='array')
        OR (v_spec->'params' @> '["kind"]'::jsonb) IS DISTINCT FROM (jsonb_typeof(v_spec->'kinds')='array')
        OR v_spec->>'scope' IN ('organization','self') AND v_spec->'params' @> '["buildingId"]'::jsonb THEN
        RAISE EXCEPTION 'hermes_w2_catalog_invalid' USING ERRCODE='XX000'; END IF;
      v_all:=v_all||jsonb_build_object(v_key,v_spec||jsonb_build_object('package',v_letter));
    END LOOP;
  END LOOP;
  IF p_report IS NULL THEN RETURN v_all; END IF;
  RETURN v_all->p_report;
END $fn$;

-- 4c. Tham số của MỘT báo cáo theo từ điển chung (khớp W2_PARAMS của wave2-kit.mjs): đúng tập tên
-- spec.params (null = không lọc), kiểu theo tên, status/kind trong danh sách của spec, bắt buộc khác
-- null, fromDate ≤ toDate ≤ fromDate+366. Sai ⇒ 22023 (broker invalid_request).
CREATE OR REPLACE FUNCTION app_private.hermes_w2_params_v1(p_spec jsonb,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE v_names text[]; v_name text; v_value jsonb; v_text text; v_from date; v_to date;
BEGIN
  SELECT COALESCE(array_agg(value ORDER BY ordinality),'{}'::text[]) INTO v_names FROM jsonb_array_elements_text(p_spec->'params') WITH ORDINALITY;
  IF jsonb_typeof(p_params) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  IF cardinality(v_names)=0 THEN
    IF p_params<>'{}'::jsonb THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    RETURN p_params;
  END IF;
  PERFORM app_private.hermes_request_v1(p_params,v_names);
  FOREACH v_name IN ARRAY v_names LOOP
    v_value:=p_params->v_name; v_text:=p_params->>v_name;
    IF v_value='null'::jsonb THEN
      IF p_spec->'required' @> to_jsonb(ARRAY[v_name]) THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
      CONTINUE;
    END IF;
    IF v_name IN ('buildingId','areaId','roomId','customerId','contractId','invoiceId','cashbookId','staffId','categoryId','supplierId',
        'materialId','itemId','fromId','toId') THEN PERFORM app_private.hermes_uuid_v1(v_value);
    ELSIF v_name IN ('fromDate','toDate','date') THEN PERFORM app_private.hermes_domain_date_v2(v_value);
    ELSIF NOT (CASE v_name
      WHEN 'query' THEN jsonb_typeof(v_value)='string' AND char_length(v_text)<=200 AND v_text !~ '[[:cntrl:]]'
        AND position(chr(8232) IN v_text)=0 AND position(chr(8233) IN v_text)=0
      WHEN 'month' THEN jsonb_typeof(v_value)='string' AND v_text ~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$'
      WHEN 'year' THEN jsonb_typeof(v_value)='number' AND v_text ~ '^[0-9]{4}$' AND v_text::integer BETWEEN 2000 AND 2100
      WHEN 'days' THEN jsonb_typeof(v_value)='number' AND v_text ~ '^[0-9]{1,3}$' AND v_text::integer BETWEEN 1 AND 365
      WHEN 'floor' THEN jsonb_typeof(v_value)='number' AND v_text ~ '^-?[0-9]{1,3}$' AND v_text::integer BETWEEN -5 AND 200
      WHEN 'basis' THEN jsonb_typeof(v_value)='string' AND v_text IN ('accrual','cash')
      WHEN 'unreadOnly' THEN jsonb_typeof(v_value)='boolean'
      WHEN 'lowStock' THEN jsonb_typeof(v_value)='boolean'
      WHEN 'status' THEN jsonb_typeof(v_value)='string' AND jsonb_typeof(p_spec->'statuses')='array' AND p_spec->'statuses' @> to_jsonb(ARRAY[v_text])
      WHEN 'kind' THEN jsonb_typeof(v_value)='string' AND jsonb_typeof(p_spec->'kinds')='array' AND p_spec->'kinds' @> to_jsonb(ARRAY[v_text])
      ELSE false END) THEN
      RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
    END IF;
  END LOOP;
  v_from:=app_private.hermes_domain_date_v2(p_params->'fromDate'); v_to:=app_private.hermes_domain_date_v2(p_params->'toDate');
  IF v_from IS NOT NULL AND v_to IS NOT NULL AND (v_to<v_from OR v_to-v_from>366) THEN
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  RETURN p_params;
END $fn$;

-- 4d. Hàm đọc của từng gói. Chỉ cổng hermes_w2_gate_v1 gọi (không vai API nào có EXECUTE). GÓI <x>
-- THAY THÂN hermes_w2<x>_read_v1: nhận mã báo cáo, tham số ĐÃ kiểm, ctx do cổng dựng sau khi kiểm quyền
-- {organizationId,userId,report,permission,scope,buildings,requestedBuildingId,overlayOrg,orgWide,
-- isSuperadmin,today,scopes{khoá phụ: [toà]|null}}; trả ĐÚNG {rows:[≤2000 object, đã sắp],
-- summary:object|null, sourceCapped:bool, unavailable:null|'not_implemented'|'source_unavailable'|
-- 'organization_scope_required'|'no_building_scope'}. Cổng phân trang offset/limit và trần byte.
-- Nguồn: RPC web của màn đó (gọi thẳng, truyền ctx.buildings tường minh) hoặc SQL theo đúng bộ lọc web
-- (dẫn file:line); không copilot_*. Khung: chưa có báo cáo ⇒ not_implemented.
CREATE OR REPLACE FUNCTION app_private.hermes_w2a_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','not_implemented');
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','not_implemented');
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_w2c_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','not_implemented');
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  IF auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','not_implemented');
END $fn$;

-- 4e. Cổng đọc đợt 2 (chỉ public.hermes_domain_read_v3 gọi). Binding/phiên/chính sách/ngữ cảnh: y như
-- hermes_domain_read_v3 bản 20261017033630. report_list: báo cáo mà khoá còn được cấp NGAY LÚC GỌI.
-- report: đúng MỘT khoá của báo cáo; toà = grant CRM của khoá ∩ phạm vi overlay của kết nối (∩ chính
-- sách), buildingId thu hẹp và phải nằm trong đó; organization ⇒ cần Toàn tổ chức; rows/buildings mà
-- không còn toà ⇒ no_building_scope (không phải số 0); self ⇒ không theo toà.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_gate_v1(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; enabled boolean;
  org_wide boolean:=false; overlay_org boolean:=false; requested_building uuid; v_report text; v_spec jsonb; v_params jsonb;
  v_limit integer; v_offset integer; v_topic text; v_catalog jsonb; v_allowed text[]:='{}'::text[]; v_extra jsonb:='{}'::jsonb;
  v_ctx jsonb; v_raw jsonb; v_rows jsonb; v_unavailable text; v_page jsonb:='[]'::jsonb; v_bytes integer:=0; v_total integer;
  v_next integer; v_item jsonb; v_size integer; i integer; v_result jsonb;
BEGIN
  IF p_domain='report' THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['report','params','limit','offset']);
    IF jsonb_typeof(p_input->'report') IS DISTINCT FROM 'string' OR jsonb_typeof(p_input->'params') IS DISTINCT FROM 'object'
      OR jsonb_typeof(p_input->'limit') IS DISTINCT FROM 'number' OR (p_input->>'limit') !~ '^[0-9]{1,2}$'
      OR jsonb_typeof(p_input->'offset') IS DISTINCT FROM 'number' OR (p_input->>'offset') !~ '^[0-9]{1,4}$'
      THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    v_limit:=(p_input->>'limit')::integer; v_offset:=(p_input->>'offset')::integer;
    IF v_limit NOT BETWEEN 1 AND 50 OR v_offset>2000 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    v_report:=p_input->>'report';
    v_spec:=app_private.hermes_w2_catalog_v1(v_report);
    IF v_spec IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    permission:=v_spec->>'permission';
    v_params:=app_private.hermes_w2_params_v1(v_spec,p_input->'params');
  ELSIF p_domain='report_list' THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['topic']);
    IF p_input->'topic'<>'null'::jsonb AND (jsonb_typeof(p_input->'topic') IS DISTINCT FROM 'string'
        OR NOT COALESCE(p_input->>'topic' IN ('a','b','c','d'),false))
      THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    v_topic:=p_input->>'topic';
  ELSE
    RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
  END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');
  PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
  FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO session FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.user_id IS DISTINCT FROM auth.uid() OR session.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR NOT app_private.hermes_session_gate_v1(session)
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
    OR session.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'
    OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
    OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
    OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  IF p_domain='report_list' THEN
    v_catalog:=app_private.hermes_w2_catalog_v1(NULL);
    FOR k IN SELECT DISTINCT e.value->>'permission' FROM jsonb_each(v_catalog) e WHERE v_topic IS NULL OR e.value->>'package'=v_topic LOOP
      enabled:=policy.enabled AND k=ANY(policy.read_capabilities) AND EXISTS(
        SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=k AND h.mode='read' AND h.enabled);
      state:=app_private.hermes_w2_grant_v1(c.organization_id,k,enabled,context,member);
      IF state->'allowed'='true'::jsonb AND k=ANY(c.read_capabilities) THEN v_allowed:=v_allowed||k; END IF;
    END LOOP;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('report',e.key,'permission',e.value->>'permission') ORDER BY e.key),'[]'::jsonb) INTO v_rows
      FROM jsonb_each(v_catalog) e WHERE (v_topic IS NULL OR e.value->>'package'=v_topic) AND e.value->>'permission'=ANY(v_allowed);
    v_result:=jsonb_build_object('items',v_rows);
  ELSE
    enabled:=policy.enabled AND permission=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=permission AND h.mode='read' AND h.enabled);
    state:=app_private.hermes_w2_grant_v1(c.organization_id,permission,enabled,context,member);
    IF state->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
      THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO scopes FROM (
      SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
    SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
      FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
      AND state->'buildingIds' ? b.id::text
      AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes) AND scope.organization_id=c.organization_id
        AND scope.cashbook_id IS NULL AND (
        scope.scope_type='ORGANIZATION' OR (scope.scope_type='BUILDING' AND scope.building_id=b.id)
        OR (scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
          ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
          WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id))));
    buildings:=COALESCE(buildings,'{}'::uuid[]);
    overlay_org:=EXISTS(SELECT 1 FROM public.authorization_scopes overlay
      WHERE overlay.id=ANY(scopes) AND overlay.organization_id=c.organization_id AND overlay.scope_type='ORGANIZATION' AND overlay.cashbook_id IS NULL);
    org_wide:=state->'orgWide'='true'::jsonb AND overlay_org;
    IF v_params->'buildingId' IS NOT NULL AND v_params->'buildingId'<>'null'::jsonb THEN
      requested_building:=app_private.hermes_uuid_v1(v_params->'buildingId');
      IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      buildings:=ARRAY[requested_building]; org_wide:=false; overlay_org:=false;
    END IF;
    v_unavailable:=CASE WHEN v_spec->>'scope'='organization' AND NOT overlay_org THEN 'organization_scope_required'
      WHEN v_spec->>'scope' IN ('rows','buildings') AND cardinality(buildings)=0 THEN 'no_building_scope' END;
    IF v_unavailable IS NULL THEN
      -- Khoá phụ (vd. customers.view cho tên khách): cùng cách tính khoá chính; gói tự giao với ctx.buildings.
      FOR k IN SELECT jsonb_array_elements_text(v_spec->'scopeKeys') LOOP
        v_extra:=v_extra||jsonb_build_object(k,to_jsonb(app_private.hermes_full_read_scope_v1(c,policy,context,k)));
      END LOOP;
      v_ctx:=jsonb_build_object('organizationId',c.organization_id,'userId',c.user_id,'report',v_report,'permission',permission,
        'scope',v_spec->>'scope','buildings',to_jsonb(buildings),'requestedBuildingId',requested_building,'overlayOrg',overlay_org,
        'orgWide',org_wide,'isSuperadmin',member->'isSuperadmin'='true'::jsonb,'today',public.org_today_v1(c.organization_id),'scopes',v_extra);
      v_raw:=CASE v_spec->>'package' WHEN 'a' THEN app_private.hermes_w2a_read_v1(v_report,v_params,v_ctx)
        WHEN 'b' THEN app_private.hermes_w2b_read_v1(v_report,v_params,v_ctx) WHEN 'c' THEN app_private.hermes_w2c_read_v1(v_report,v_params,v_ctx)
        WHEN 'd' THEN app_private.hermes_w2d_read_v1(v_report,v_params,v_ctx) END;
      -- Kết quả gói sai khuôn là lỗi của gói (XX000 ⇒ broker backend_unavailable), kiểm theo bậc kiểu.
      IF jsonb_typeof(v_raw) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(v_raw))<>4 OR NOT(v_raw ?& ARRAY['rows','summary','sourceCapped','unavailable'])
        OR jsonb_typeof(v_raw->'rows') IS DISTINCT FROM 'array' OR jsonb_typeof(v_raw->'sourceCapped') IS DISTINCT FROM 'boolean'
        OR NOT COALESCE(jsonb_typeof(v_raw->'summary') IN ('null','object'),false)
        OR NOT(v_raw->'unavailable'='null'::jsonb OR COALESCE(v_raw->>'unavailable' IN
          ('organization_scope_required','no_building_scope','not_implemented','source_unavailable'),false))
        THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
      IF jsonb_array_length(v_raw->'rows')>2000
        OR v_raw->>'unavailable'='no_building_scope' AND v_spec->>'scope' NOT IN ('rows','buildings')
        OR v_raw->'unavailable'<>'null'::jsonb AND (jsonb_array_length(v_raw->'rows')>0 OR v_raw->'summary'<>'null'::jsonb)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r WHERE jsonb_typeof(r)<>'object')
        THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
      v_unavailable:=v_raw->>'unavailable';
    END IF;
    IF v_unavailable IS NOT NULL THEN
      v_result:=jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable',v_unavailable,'summary',NULL,
        'items','[]'::jsonb,'offset',v_offset,'nextOffset',NULL,'sourceCapped',false);
    ELSE
      -- Phân trang trong ảnh chụp gói vừa đọc; dừng sớm ở ≈40 KB đo SAU escape JSON (như broker bọc)
      -- để luôn lọt trần 60 KB dưới đây / 64 KB broker; nextOffset báo phần còn lại.
      v_rows:=v_raw->'rows'; v_total:=jsonb_array_length(v_rows); i:=v_offset;
      WHILE i<v_total AND jsonb_array_length(v_page)<v_limit LOOP
        v_item:=v_rows->i;
        v_size:=octet_length(to_jsonb(v_item::text)::text);
        EXIT WHEN jsonb_array_length(v_page)>0 AND v_bytes+v_size>40000;
        v_page:=v_page||jsonb_build_array(v_item); v_bytes:=v_bytes+v_size; i:=i+1;
      END LOOP;
      IF i<v_total THEN v_next:=i; END IF;
      v_result:=jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable',NULL,'summary',v_raw->'summary',
        'items',v_page,'offset',v_offset,'nextOffset',v_next,'sourceCapped',v_raw->'sourceCapped');
    END IF;
  END IF;
  IF octet_length(to_jsonb(v_result::text)::text)>60000 THEN
    RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='PT413',HINT='Giảm limit hoặc thu hẹp bộ lọc rồi gọi lại.';
  END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,
    'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))||v_result;
END $fn$;

-- 4f. Cổng chung: hai miền meta sang cổng đợt 2; MỌI dòng khác giữ nguyên thân 20261017033630.
CREATE OR REPLACE FUNCTION public.hermes_domain_read_v3(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; enabled boolean; org_wide boolean:=false; overlay_org boolean:=false;
  query text; row_limit integer; cursor_id uuid; requested_building uuid; v_target uuid; v_report jsonb; v_from date; v_to date;
  rows jsonb; next_cursor uuid; v_item jsonb; v_result jsonb; v_customer_scope uuid[]; v_contract_scope uuid[]; v_owners uuid[];
BEGIN
  -- Đợt 2 (20261018000000): hai miền meta sang cổng riêng; mọi dòng dưới giữ nguyên 20261017033630.
  IF p_domain IN ('report','report_list') THEN RETURN app_private.hermes_w2_gate_v1(p_binding,p_domain,p_input); END IF;
  IF p_domain IN ('customers','occupancy') THEN
    permission:=CASE p_domain WHEN 'customers' THEN 'customers.view' ELSE 'reports_real_estate.occupancy' END;
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['query','limit','cursor','buildingId','status']);
  ELSIF p_domain='customer_detail' THEN permission:='customers.view';
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['customerId']);
  ELSIF p_domain='contract_detail' THEN permission:='contracts.view';
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['contractId']);
  ELSIF app_private.hermes_report_catalog_v1(p_domain,NULL) IS NOT NULL THEN
    PERFORM app_private.hermes_request_v1(p_input,ARRAY['report','query','status','month','fromDate','toDate','days','basis','buildingId','limit','offset']);
    IF jsonb_typeof(p_input->'report') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    v_report:=app_private.hermes_report_catalog_v1(p_domain,p_input->>'report');
    permission:=v_report->>'permission';
  END IF;
  IF permission IS NULL THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedPolicyVersion',
    'expectedMembershipId','expectedAuthorizationVersion','expectedSessionRevision']);
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');
  PERFORM app_private.hermes_uuid_v1(p_binding->'expectedMembershipId');
  FOREACH k IN ARRAY ARRAY['expectedEpoch','expectedAuthorizationVersion','expectedSessionRevision'] LOOP
    IF app_private.hermes_integer_v1(p_binding->k)<1 THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  IF (CASE WHEN p_binding->'expectedPolicyVersion'='0'::jsonb THEN 0 ELSE app_private.hermes_integer_v1(p_binding->'expectedPolicyVersion') END)<0
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  IF p_domain NOT IN ('customer_detail','contract_detail') THEN
    row_limit:=app_private.hermes_integer_v1(p_input->'limit'); query:=p_input->>'query';
    IF row_limit NOT BETWEEN 1 AND 50 OR jsonb_typeof(p_input->'query') IS DISTINCT FROM 'string' OR char_length(query)>200
      OR query ~ '[[:cntrl:]]' OR position(chr(8232) IN query)>0 OR position(chr(8233) IN query)>0
      THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    query:=lower(btrim(query));
    IF p_input->'buildingId'<>'null'::jsonb THEN requested_building:=app_private.hermes_uuid_v1(p_input->'buildingId'); END IF;
  END IF;
  IF p_domain IN ('customers','occupancy') THEN
    IF p_input->'status'<>'null'::jsonb THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
    IF p_input->'cursor'<>'null'::jsonb THEN cursor_id:=app_private.hermes_uuid_v1(p_input->'cursor'); END IF;
  ELSIF p_domain='customer_detail' THEN v_target:=app_private.hermes_uuid_v1(p_input->'customerId');
  ELSIF p_domain='contract_detail' THEN v_target:=app_private.hermes_uuid_v1(p_input->'contractId');
  ELSE
    -- Báo cáo: mọi khoá đều có mặt (null = không dùng); bảng catalog nói khoá nào hợp lệ.
    v_from:=app_private.hermes_domain_date_v2(p_input->'fromDate');
    v_to:=app_private.hermes_domain_date_v2(p_input->'toDate');
    IF jsonb_typeof(p_input->'offset') IS DISTINCT FROM 'number' OR (p_input->>'offset') !~ '^[0-9]{1,4}$' OR (p_input->>'offset')::integer>2000
      OR (v_from IS NOT NULL AND v_to IS NOT NULL AND (v_to<v_from OR v_to-v_from>366))
      OR (v_report->>'fromDate')::boolean IS NOT TRUE AND v_from IS NOT NULL
      OR (v_report->>'toDate')::boolean IS NOT TRUE AND v_to IS NOT NULL
      OR (v_report->>'requiresDates')::boolean AND (v_from IS NULL OR v_to IS NULL)
      OR p_input->'days'<>'null'::jsonb AND ((v_report->>'days')::boolean IS NOT TRUE OR jsonb_typeof(p_input->'days') IS DISTINCT FROM 'number'
        OR (p_input->>'days') !~ '^[0-9]{1,3}$' OR (p_input->>'days')::integer NOT BETWEEN 1 AND 365)
      OR p_input->'month'<>'null'::jsonb AND ((v_report->>'month')::boolean IS NOT TRUE OR jsonb_typeof(p_input->'month') IS DISTINCT FROM 'string'
        OR (p_input->>'month') !~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])$')
      OR p_input->'status'<>'null'::jsonb AND (jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string'
        OR NOT COALESCE(v_report->'statuses' ? (p_input->>'status'),false))
      OR p_input->'basis'<>'null'::jsonb AND ((v_report->>'basis')::boolean IS NOT TRUE OR jsonb_typeof(p_input->'basis') IS DISTINCT FROM 'string'
        OR (p_input->>'basis') NOT IN ('accrual','cash'))
      OR (v_report->>'buildingFilter')::boolean IS NOT TRUE AND requested_building IS NOT NULL
      THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  END IF;
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO session FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.user_id IS DISTINCT FROM auth.uid() OR session.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR NOT app_private.hermes_session_gate_v1(session)
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  member:=app_private.hermes_member_v1(c.user_id,c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  IF c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch'
    OR session.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'
    OR member->>'membershipId' IS DISTINCT FROM p_binding->>'expectedMembershipId'
    OR member->>'authorizationVersion' IS DISTINCT FROM p_binding->>'expectedAuthorizationVersion'
    OR policy.version::text IS DISTINCT FROM p_binding->>'expectedPolicyVersion'
    OR context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_domain_context_changed' USING ERRCODE='PT409'; END IF;
  enabled:=policy.enabled AND permission=ANY(policy.read_capabilities) AND EXISTS(
    SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=permission AND h.mode='read' AND h.enabled);
  state:=app_private.hermes_domain_grant_v2(c.organization_id,permission,enabled,context);
  IF state->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO scopes FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) selected;
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings
    FROM public.buildings b WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL
    AND state->'buildingIds' ? b.id::text
    AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(scopes) AND scope.organization_id=c.organization_id
      AND scope.cashbook_id IS NULL AND (
      scope.scope_type='ORGANIZATION' OR (scope.scope_type='BUILDING' AND scope.building_id=b.id)
      OR (scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas a
        ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
        WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id))));
  buildings:=COALESCE(buildings,'{}'::uuid[]);
  -- overlay_org: kết nối (∩ chính sách) đã chọn Toàn tổ chức nên overlay không thu hẹp.
  -- org_wide thêm CRM org_wide của đúng khoá: điều kiện cho bản ghi KHÔNG gắn toà.
  overlay_org:=EXISTS(SELECT 1 FROM public.authorization_scopes overlay
    WHERE overlay.id=ANY(scopes) AND overlay.organization_id=c.organization_id AND overlay.scope_type='ORGANIZATION' AND overlay.cashbook_id IS NULL);
  org_wide:=state->'orgWide'='true'::jsonb AND overlay_org;
  IF requested_building IS NOT NULL THEN
    IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    buildings:=ARRAY[requested_building]; org_wide:=false; overlay_org:=false;
  END IF;
  -- Khoá thứ hai, như RLS các embed của web: người ở / tên khách cần customers.view,
  -- hợp đồng của khách cần contracts.view (quyền CRM ∩ Read kết nối ∩ toà overlay).
  IF p_domain IN ('customers','customer_detail') THEN
    v_contract_scope:=COALESCE(app_private.hermes_full_read_scope_v1(c,policy,context,'contracts.view'),'{}'::uuid[]);
  ELSIF p_domain IN ('contract_detail','contract_search','invoice_report') THEN
    v_customer_scope:=app_private.hermes_full_read_scope_v1(c,policy,context,'customers.view');
  END IF;
  -- (P2-2) RLS customers_select_rbac của web (20260726130000:33-35, production 17/10): mọi hồ sơ
  -- khách chỉ hiện khi chủ hồ sơ (customers.user_id) là thành viên ACTIVE của công ty người hỏi.
  v_owners:=COALESCE(public.current_visible_owner_ids(),'{}'::uuid[]);

  IF p_domain='customers' THEN
    -- Như hermes_domain_read_v1 nhưng SĐT đầy đủ; kết nối Toàn tổ chức thấy cả
    -- khách chưa có hợp đồng (như danh sách /customers), chỉ chủ sở hữu nhìn thấy được.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT customer.id,jsonb_build_object('id',customer.id,'name',app_private.hermes_domain_text_v1(COALESCE(customer.full_name,'')),
        'phone',app_private.hermes_domain_text_v1(customer.phone),
        -- (P3-6) Phòng/toà gần nhất đi cùng hợp đồng: chỉ khi có contracts.view ở toà đó.
        'contractId',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN latest.id END,
        'buildingId',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN latest.building_id END,
        'roomId',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN latest.room_id END,
        'roomName',CASE WHEN latest.building_id=ANY(v_contract_scope) THEN app_private.hermes_domain_text_v1(latest.room_name) END) item
      FROM public.customers customer LEFT JOIN LATERAL (
        SELECT contract.id,room.id room_id,room.building_id,room.name room_name FROM public.contract_customers cc
        JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
        JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
        WHERE cc.customer_id=customer.id AND cc.organization_id=c.organization_id
        ORDER BY CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END,
          COALESCE(contract.actual_end_date,contract.end_date) DESC NULLS LAST,contract.id LIMIT 1) latest ON true
      WHERE customer.organization_id=c.organization_id AND customer.deleted_at IS NULL AND (cursor_id IS NULL OR customer.id>cursor_id)
        AND customer.user_id=ANY(v_owners) AND (latest.id IS NOT NULL OR org_wide)
        AND (query='' OR position(query IN lower(COALESCE(customer.full_name,'')))>0
          OR position(regexp_replace(query,'[^0-9]','','g') IN regexp_replace(COALESCE(customer.phone,''),'[^0-9]','','g'))>0
            AND regexp_replace(query,'[^0-9]','','g')<>'')
      ORDER BY customer.id LIMIT row_limit+1) found;
    IF jsonb_array_length(rows)>row_limit THEN
      SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
      next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
    END IF;
    v_result:=jsonb_build_object('items',rows,'nextCursor',next_cursor);
  ELSIF p_domain='occupancy' THEN
    -- (5) Như trang Báo cáo lấp đầy (src/hooks/reports/useOccupancyDashboard.ts:83): RPC web
    -- occupancy_snapshot_v2 tại hôm nay theo giờ công ty, với tập toà đã giao (CRM ∩ overlay);
    -- không đếm rooms.status như hermes_domain_read_v1.
    SELECT COALESCE(jsonb_agg(item ORDER BY id),'[]') INTO rows FROM (
      SELECT snapshot.building_id id,jsonb_build_object('id',snapshot.building_id,'buildingId',snapshot.building_id,
        'name',app_private.hermes_domain_text_v1(COALESCE(snapshot.building_name,'')),'total',COALESCE(snapshot.total,0),
        'occupied',COALESCE(snapshot.occupied,0),'available',COALESCE(snapshot.available,0)) item
      FROM public.occupancy_snapshot_v2(public.org_today_v1(c.organization_id),buildings) snapshot
      WHERE snapshot.building_id=ANY(buildings) AND (cursor_id IS NULL OR snapshot.building_id>cursor_id)
        AND (query='' OR position(query IN lower(COALESCE(snapshot.building_name,'')))>0)
      ORDER BY snapshot.building_id LIMIT row_limit+1) found;
    IF jsonb_array_length(rows)>row_limit THEN
      SELECT jsonb_agg(value ORDER BY ordinality) INTO rows FROM jsonb_array_elements(rows) WITH ORDINALITY WHERE ordinality<=row_limit;
      next_cursor:=(rows->(row_limit-1)->>'id')::uuid;
    END IF;
    v_result:=jsonb_build_object('items',rows,'nextCursor',next_cursor);
  ELSIF p_domain='customer_detail' THEN
    -- Đúng các trường /customers/:id hiển thị; KHÔNG ảnh CCCD (id_images), không
    -- tài khoản ngân hàng/vân tay. Khách thấy được khi có hợp đồng ở toà được
    -- giao, hoặc kết nối Toàn tổ chức và chủ sở hữu nằm trong phạm vi nhìn thấy.
    SELECT jsonb_build_object('id',cu.id,'name',app_private.hermes_full_text_v1(cu.full_name,200),'phone',app_private.hermes_full_text_v1(cu.phone,40),
      'email',app_private.hermes_full_text_v1(cu.email,200),'customerType',cu.customer_type::text,'status',COALESCE(cu.status_v2::text,cu.status::text),
      'idType',cu.id_type::text,'idNumber',app_private.hermes_full_text_v1(cu.id_number,40),'idIssueDate',cu.id_issue_date,
      'idIssuePlace',app_private.hermes_full_text_v1(cu.id_issue_place,200),'dateOfBirth',cu.date_of_birth,'gender',app_private.hermes_full_text_v1(cu.gender,20),
      'isForeign',cu.is_foreign,'occupation',app_private.hermes_full_text_v1(cu.occupation,200),'workplace',app_private.hermes_full_text_v1(cu.workplace,300),
      'detailedAddress',app_private.hermes_full_text_v1(cu.detailed_address,500),'ward',app_private.hermes_full_text_v1(cu.ward,100),
      'district',app_private.hermes_full_text_v1(cu.district,100),'province',app_private.hermes_full_text_v1(cu.province,100),
      'currentResidence',app_private.hermes_full_text_v1(cu.current_residence,500),'permanentAddress',app_private.hermes_full_text_v1(cu.permanent_address,500),
      'companyName',app_private.hermes_full_text_v1(cu.company_name,200),'contactPerson',app_private.hermes_full_text_v1(cu.contact_person,200),
      'contactPersonPhone',app_private.hermes_full_text_v1(cu.contact_person_phone,40),
      'emergencyContact',CASE WHEN COALESCE(cu.emergency_contact_name,cu.emergency_contact_phone) IS NULL THEN NULL ELSE jsonb_build_object(
        'name',app_private.hermes_full_text_v1(cu.emergency_contact_name,200),'phone',app_private.hermes_full_text_v1(cu.emergency_contact_phone,40),
        'relationship',app_private.hermes_full_text_v1(cu.emergency_contact_relationship,100)) END,
      'notes',app_private.hermes_full_text_v1(cu.notes,2000),'contractsVisible',cardinality(v_contract_scope)>0,
      'contracts',(SELECT COALESCE(jsonb_agg(link.item ORDER BY link.active,link.start_date DESC NULLS LAST,link.id),'[]'::jsonb) FROM (
        SELECT contract.id,contract.start_date,CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END active,
          jsonb_build_object('id',contract.id,'number',app_private.hermes_full_text_v1(contract.contract_number,100),'status',contract.status::text,
            'buildingId',room.building_id,'buildingName',app_private.hermes_full_text_v1(building.name,200),'roomId',room.id,
            'roomName',app_private.hermes_full_text_v1(room.name,100),'startDate',contract.start_date,
            'endDate',COALESCE(contract.actual_end_date,contract.end_date),'rentPrice',COALESCE(contract.rent_price,0)::text,
            'isRepresentative',COALESCE(cc.is_representative,false)) item
        FROM public.contract_customers cc
        JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
        JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(v_contract_scope)
        JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
        WHERE cc.customer_id=cu.id AND cc.organization_id=c.organization_id
        ORDER BY CASE WHEN contract.status IN ('ACTIVE','EXTENDED') THEN 0 ELSE 1 END,contract.start_date DESC NULLS LAST,contract.id LIMIT 20) link))
      INTO v_item FROM public.customers cu
      WHERE cu.id=v_target AND cu.organization_id=c.organization_id AND cu.deleted_at IS NULL AND cu.user_id=ANY(v_owners)
        AND (EXISTS(SELECT 1 FROM public.contract_customers cc
            JOIN public.contracts contract ON contract.id=cc.contract_id AND contract.organization_id=c.organization_id AND contract.deleted_at IS NULL
            JOIN public.rooms room ON room.id=contract.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
            WHERE cc.customer_id=cu.id AND cc.organization_id=c.organization_id)
          OR org_wide);
    v_result:=jsonb_build_object('item',v_item);
  ELSIF p_domain='contract_detail' THEN
    -- Đúng các trường /contracts/:id hiển thị; KHÔNG file hợp đồng, ảnh CCCD, mã
    -- công khai (public_code), tài khoản ngân hàng khách.
    SELECT jsonb_build_object('id',ct.id,'number',app_private.hermes_full_text_v1(ct.contract_number,100),'status',ct.status::text,
      'buildingId',room.building_id,'buildingName',app_private.hermes_full_text_v1(building.name,200),
      'buildingAddress',app_private.hermes_full_text_v1(concat_ws(', ',building.street_address,building.ward,building.district,building.province),500),
      'roomId',room.id,'roomName',app_private.hermes_full_text_v1(room.name,100),
      'signedDate',ct.signed_date,'startDate',ct.start_date,'endDate',ct.end_date,'actualEndDate',ct.actual_end_date,
      'expectedMoveOutDate',ct.expected_move_out_date,'startBillingDate',ct.start_billing_date,'endBillingDate',ct.end_billing_date,
      'rentPrice',COALESCE(ct.rent_price,0)::text,'paymentCycle',ct.payment_cycle::text,
      'totalDeposit',COALESCE(ct.total_deposit,0)::text,'depositPaid',COALESCE(ct.deposit_paid,0)::text,'depositRemaining',COALESCE(ct.deposit_remaining,0)::text,
      'depositDebtMode',app_private.hermes_full_text_v1(ct.deposit_debt_mode,40),'depositDebtReason',app_private.hermes_full_text_v1(ct.deposit_debt_reason,500),
      'depositTopupDueDate',ct.deposit_topup_due_date,
      'initialElectricityReading',ct.initial_electricity_reading::text,'initialWaterReading',ct.initial_water_reading::text,
      'notes',app_private.hermes_full_text_v1(ct.notes,2000),'parentContractId',ct.parent_contract_id,
      'tenantsVisible',room.building_id=ANY(COALESCE(v_customer_scope,'{}'::uuid[])),
      'tenants',CASE WHEN room.building_id=ANY(COALESCE(v_customer_scope,'{}'::uuid[])) THEN (SELECT COALESCE(jsonb_agg(person.item ORDER BY person.representative DESC,person.name,person.id),'[]'::jsonb) FROM (
        SELECT cu.id,cu.full_name name,COALESCE(cc.is_representative,false) representative,jsonb_build_object('customerId',cu.id,
          'name',app_private.hermes_full_text_v1(cu.full_name,200),'phone',app_private.hermes_full_text_v1(cu.phone,40),
          'isRepresentative',COALESCE(cc.is_representative,false),'idNumber',app_private.hermes_full_text_v1(cu.id_number,40),
          'idIssueDate',cu.id_issue_date,'idIssuePlace',app_private.hermes_full_text_v1(cu.id_issue_place,200),
          'dateOfBirth',cu.date_of_birth,'gender',app_private.hermes_full_text_v1(cu.gender,20),'isForeign',cu.is_foreign,
          'permanentAddress',app_private.hermes_full_text_v1(cu.permanent_address,300),'currentResidence',app_private.hermes_full_text_v1(cu.current_residence,300),
          'occupation',app_private.hermes_full_text_v1(cu.occupation,200),'workplace',app_private.hermes_full_text_v1(cu.workplace,200),
          'note',app_private.hermes_full_text_v1(cc.notes,300)) item
        FROM public.contract_customers cc JOIN public.customers cu ON cu.id=cc.customer_id AND cu.organization_id=c.organization_id AND cu.deleted_at IS NULL
          AND cu.user_id=ANY(v_owners)
        WHERE cc.contract_id=ct.id AND cc.organization_id=c.organization_id
        ORDER BY COALESCE(cc.is_representative,false) DESC,cu.full_name,cu.id LIMIT 10) person) ELSE '[]'::jsonb END,
      'services',(SELECT COALESCE(jsonb_agg(line.item ORDER BY line.name,line.id),'[]'::jsonb) FROM (
        SELECT cs.id,service.name,jsonb_build_object('serviceId',service.id,'name',app_private.hermes_full_text_v1(service.name,200),
          'unit',app_private.hermes_full_text_v1(service.unit,40),'type',service.type::text,'pricingType',service.pricing_type::text,
          'unitPrice',COALESCE(cs.unit_price,0)::text,'initialReading',cs.initial_reading::text) item
        FROM public.contract_services cs JOIN public.services service ON service.id=cs.service_id AND service.organization_id=c.organization_id
        WHERE cs.contract_id=ct.id AND (cs.organization_id IS NULL OR cs.organization_id=c.organization_id)
        ORDER BY service.name,cs.id LIMIT 50) line))
      INTO v_item FROM public.contracts ct
      JOIN public.rooms room ON room.id=ct.room_id AND room.organization_id=c.organization_id AND room.deleted_at IS NULL AND room.building_id=ANY(buildings)
      JOIN public.buildings building ON building.id=room.building_id AND building.organization_id=c.organization_id
      WHERE ct.id=v_target AND ct.organization_id=c.organization_id AND ct.deleted_at IS NULL;
    v_result:=jsonb_build_object('item',v_item);
  ELSE
    -- Báo cáo cấp công ty dùng nguồn tự giới hạn theo người gọi (hộp duyệt của chính họ;
    -- RLS Chat Zalo toàn công ty); Hermes đòi thêm overlay không thu hẹp (overlay_org).
    -- Tên khách trong hàng báo cáo: chỉ khi customers.view phủ MỌI toà của báo cáo.
    v_result:=app_private.hermes_report_read_v2(p_domain,p_input,c.organization_id,buildings,overlay_org,
      COALESCE(v_customer_scope@>buildings,false));
  END IF;
  -- (P3-7) Đo SAU khi broker bọc kết quả thành chuỗi JSON (ngoặc kép, xuống dòng được escape):
  -- 60 000 byte ở đây còn lọt trần 65 536 của broker. PT413 ⇒ HTTP 413 ⇒ result_too_large.
  IF octet_length(to_jsonb(v_result::text)::text)>60000 THEN
    RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='PT413',HINT='Giảm limit hoặc thu hẹp bộ lọc rồi gọi lại.';
  END IF;
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  IF NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_domain,
    'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))||v_result;
END $fn$;

ALTER FUNCTION app_private.hermes_w2_read_keys_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_self_keys_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_grant_v1(uuid,text,boolean,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_capabilities_v3(uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_extend_options_v1(jsonb,text) OWNER TO postgres;
ALTER FUNCTION public.hermes_org_policy_options_v7(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_connection_options_v7(uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_connection_context_v7(uuid) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2a_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2c_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_catalog_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_param_names_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_catalog_v1(text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_params_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2a_read_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_read_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2c_read_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_read_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_gate_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_domain_read_v3(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_w2_read_keys_v1(),app_private.hermes_w2_self_keys_v1(),
  app_private.hermes_w2_grant_v1(uuid,text,boolean,jsonb,jsonb),public.hermes_domain_capabilities_v3(uuid),
  app_private.hermes_w2_extend_options_v1(jsonb,text),public.hermes_org_policy_options_v7(uuid),public.hermes_connection_options_v7(uuid),
  public.hermes_connection_context_v7(uuid),app_private.hermes_w2a_catalog_v1(),app_private.hermes_w2b_catalog_v1(),
  app_private.hermes_w2c_catalog_v1(),app_private.hermes_w2d_catalog_v1(),app_private.hermes_w2_param_names_v1(),app_private.hermes_w2_catalog_v1(text),
  app_private.hermes_w2_params_v1(jsonb,jsonb),app_private.hermes_w2a_read_v1(text,jsonb,jsonb),app_private.hermes_w2b_read_v1(text,jsonb,jsonb),
  app_private.hermes_w2c_read_v1(text,jsonb,jsonb),app_private.hermes_w2d_read_v1(text,jsonb,jsonb),app_private.hermes_w2_gate_v1(jsonb,text,jsonb),
  public.hermes_domain_read_v3(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_domain_capabilities_v3(uuid),public.hermes_org_policy_options_v7(uuid),public.hermes_connection_options_v7(uuid),
  public.hermes_connection_context_v7(uuid),public.hermes_domain_read_v3(jsonb,text,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
