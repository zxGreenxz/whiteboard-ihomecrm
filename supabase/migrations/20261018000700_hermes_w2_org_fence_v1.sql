-- Hermes đọc đầy đủ — ĐỢT 2, Gói 0: sửa sau review độc lập cổng INVOKER (6ed7ec64..ae483386, 18/10/2026).
-- Chạy SAU 20261018000600 (đã áp TEST nên không sửa file đó; thay thân bằng file này). Không DROP, không
-- đổi chữ ký hàm đã có, không ghi dữ liệu nghiệp vụ. Lối vào public.hermes_w2_read_v1 và hàm gói KHÔNG đổi.
--  (P2-a) RLS của người hỏi có thể rộng hơn công ty của kết nối (super admin thấy mọi công ty; người nhiều
--    công ty thấy cả các công ty kia). Bước kết thúc rào thêm:
--    - báo cáo theo toà (rows/buildings): MỌI hàng phải có buildingId (thiếu ⇒ XX000, khuôn sai);
--    - mọi báo cáo trừ self/platform: MỌI hàng phải có organizationId (thiếu ⇒ XX000); hàng có
--      organizationId (mọi phạm vi trừ platform) phải = công ty kết nối, khác ⇒ 42501, không trả gì;
--    - organizationId là trường rào: gỡ khỏi hàng trước khi trả (platform giữ như gói khai);
--    - kết nối/phiên/công ty/người kiểm lại ĐẦU bước kết thúc (bước này chạy sau hàm gói), so cả công ty
--      của bước 1 (kế hoạch nay mang organizationId).
--  (P2-b) Loại khoá 'organization' (app_private.hermes_w2_org_keys_v1, khớp resource organization_scope ở
--    capability-contract.mjs / W2_ORG_KEYS): báo cáo dùng khoá này chỉ được scope organization hoặc cashbooks
--    (chưa có ngoại lệ). Sổ quỹ CRM của bước kiểm quyền tính cho cả loại company và organization.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text)') IS NULL
    OR to_regprocedure('app_private.hermes_w2_finish_v1(jsonb,jsonb,jsonb)') IS NULL
    OR to_regprocedure('public.hermes_w2_read_v1(jsonb,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'hermes_w2_org_fence_requires_invoker_gate';
  END IF;
END $requires$;

-- Khoá đợt 2 cho dữ liệu KHÔNG gắn toà (resource organization_scope), khớp W2_ORG_KEYS (wave2-kit.mjs).
CREATE OR REPLACE FUNCTION app_private.hermes_w2_org_keys_v1()
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT ARRAY['cashbooks.view','shareholder_profit.view','materials.view','salary.view','suppliers.view','hotline.view',
   'task_types.view','service_quotas.view','categories.view']::text[]
$fn$;

-- Loại của một khoá báo cáo: 'platform' | 'self' | 'organization' | 'company'; NULL = không được làm khoá báo cáo.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_permission_kind_v1(p_key text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
 SELECT CASE WHEN p_key='assistant.bank_events.read' THEN 'platform'
   WHEN p_key=ANY(app_private.hermes_w2_self_keys_v1()) THEN 'self'
   WHEN p_key=ANY(app_private.hermes_w2_org_keys_v1()) THEN 'organization'
   WHEN p_key=ANY(app_private.hermes_w2_read_keys_v1()) OR p_key=ANY(app_private.hermes_w2_reused_keys_v1()) THEN 'company' END
$fn$;

-- Bảng gom bốn gói: như 20261018000500, cộng (P2-b) khoá loại organization chỉ scope organization/cashbooks.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_catalog_v1(p_report text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
DECLARE v_all jsonb:='{}'::jsonb; v_part jsonb; v_letter text; v_key text; v_spec jsonb; v_kind text;
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
        OR NOT COALESCE(v_spec->>'scope' IN ('rows','buildings','organization','cashbooks','self','platform'),false)
        OR jsonb_typeof(v_spec->'params') IS DISTINCT FROM 'array' OR jsonb_typeof(v_spec->'required') IS DISTINCT FROM 'array'
        OR jsonb_typeof(v_spec->'scopeKeys') IS DISTINCT FROM 'array'
        OR NOT COALESCE(jsonb_typeof(v_spec->'statuses') IN ('null','array'),false)
        OR NOT COALESCE(jsonb_typeof(v_spec->'kinds') IN ('null','array'),false) THEN
        RAISE EXCEPTION 'hermes_w2_catalog_invalid' USING ERRCODE='XX000'; END IF;
      -- (P2-1) self ⇔ khoá self; platform ⇔ khoá biến động số dư; khoá ngoài danh sách ⇒ không nạp.
      v_kind:=app_private.hermes_w2_permission_kind_v1(v_spec->>'permission');
      IF v_kind IS NULL OR (v_kind='self')<>(v_spec->>'scope'='self') OR (v_kind='platform')<>(v_spec->>'scope'='platform') THEN
        RAISE EXCEPTION 'hermes_w2_catalog_invalid' USING ERRCODE='XX000'; END IF;
      -- (P2-b) Khoá dữ liệu không gắn toà (organization_scope): chỉ báo cáo organization/cashbooks.
      IF v_kind='organization' AND v_spec->>'scope' NOT IN ('organization','cashbooks') THEN
        RAISE EXCEPTION 'hermes_w2_catalog_invalid' USING ERRCODE='XX000'; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_spec->'params') p WHERE jsonb_typeof(p)<>'string'
          OR NOT((p#>>'{}')=ANY(app_private.hermes_w2_param_names_v1())))
        OR jsonb_array_length(v_spec->'params')<>(SELECT count(DISTINCT p) FROM jsonb_array_elements(v_spec->'params') p)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_spec->'required') r WHERE NOT(v_spec->'params' @> jsonb_build_array(r)))
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_spec->'scopeKeys') s WHERE jsonb_typeof(s)<>'string'
          OR (s#>>'{}') !~ '^[a-z][a-z0-9_.]{0,127}$')
        OR (v_spec->'params' @> '["status"]'::jsonb) IS DISTINCT FROM (jsonb_typeof(v_spec->'statuses')='array')
        OR (v_spec->'params' @> '["kind"]'::jsonb) IS DISTINCT FROM (jsonb_typeof(v_spec->'kinds')='array')
        -- Tham số gắn toà (cổng giải về toà) chỉ ở báo cáo theo toà.
        OR v_spec->>'scope' NOT IN ('rows','buildings') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_spec->'params') p
          WHERE p IN ('buildingId','areaId','roomId','contractId','invoiceId')) THEN
        RAISE EXCEPTION 'hermes_w2_catalog_invalid' USING ERRCODE='XX000'; END IF;
      v_all:=v_all||jsonb_build_object(v_key,v_spec||jsonb_build_object('package',v_letter));
    END LOOP;
  END LOOP;
  IF p_report IS NULL THEN RETURN v_all; END IF;
  RETURN v_all->p_report;
END $fn$;

-- Bước 1 (DEFINER): như 20261018000600, cộng sổ quỹ CRM cho cả khoá loại organization và organizationId trong kế hoạch.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_scope_v1(p_binding jsonb,p_domain text,p_input jsonb,p_caller text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; state jsonb; permission text; k text; buildings uuid[]; scopes uuid[]; enabled boolean;
  org_wide boolean:=false; overlay_org boolean:=false; requested_building uuid; v_report text; v_spec jsonb; v_params jsonb;
  v_limit integer; v_offset integer; v_topic text; v_catalog jsonb; v_allowed text[]:='{}'::text[]; v_extra jsonb:='{}'::jsonb;
  v_ctx jsonb; v_rows jsonb; v_unavailable text; v_cashbooks uuid[]:='{}'::uuid[]; v_id uuid;
  v_building uuid; v_ids uuid[]; v_scope text; v_fence jsonb; v_plan jsonb;
BEGIN
  -- Hàm gói chạy dưới vai của lối vào INVOKER; vai khác (vd. lời gọi từ một hàm DEFINER: chủ hàm, bỏ qua RLS) ⇒ từ chối.
  IF p_caller IS DISTINCT FROM 'authenticated' THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
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
    permission:=v_spec->>'permission'; v_scope:=v_spec->>'scope';
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
    -- (P3) Thứ tự byte (COLLATE "C") như so sánh chuỗi của broker; collation production xếp khác.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('report',e.key,'permission',e.value->>'permission') ORDER BY e.key COLLATE "C"),'[]'::jsonb) INTO v_rows
      FROM jsonb_each(v_catalog) e WHERE (v_topic IS NULL OR e.value->>'package'=v_topic) AND e.value->>'permission'=ANY(v_allowed);
    v_plan:=jsonb_build_object('domain',p_domain,'connectionId',c.id,'organizationId',c.organization_id,'package',NULL,'items',v_rows);
  ELSE
    enabled:=policy.enabled AND permission=ANY(policy.read_capabilities) AND EXISTS(
      SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=permission AND h.mode='read' AND h.enabled);
    state:=app_private.hermes_w2_grant_v1(c.organization_id,permission,enabled,context,member);
    IF state->'allowed' IS DISTINCT FROM 'true'::jsonb OR NOT(permission=ANY(c.read_capabilities))
      THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
    -- platform (biến động số dư, toàn nền tảng): chỉ super admin, như RequireSuperAdmin của web.
    IF v_scope='platform' AND member->'isSuperadmin' IS DISTINCT FROM 'true'::jsonb
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
    -- org_wide = CRM toàn công ty của đúng khoá ∩ overlay Toàn tổ chức của kết nối.
    org_wide:=state->'orgWide'='true'::jsonb AND overlay_org;
    -- (P2-3) Sổ quỹ CRM cấp cho khoá (scope CASHBOOK); overlay không có chiều sổ quỹ.
    IF app_private.hermes_w2_permission_kind_v1(permission) IN ('company','organization') THEN
      SELECT COALESCE(array_agg(DISTINCT a.id ORDER BY a.id),'{}'::uuid[]) INTO v_cashbooks
        FROM app_private.authorized_scope_v3(permission,c.organization_id) s
        CROSS JOIN LATERAL unnest(COALESCE(s.cashbook_ids,'{}'::uuid[])) x(id)
        JOIN public.accounts a ON a.id=x.id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL;
    END IF;
    IF v_params->'buildingId' IS NOT NULL AND v_params->'buildingId'<>'null'::jsonb THEN
      requested_building:=app_private.hermes_uuid_v1(v_params->'buildingId');
      IF NOT(requested_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      buildings:=ARRAY[requested_building]; org_wide:=false; overlay_org:=false;
    END IF;
    v_unavailable:=CASE
      WHEN v_scope='organization' AND NOT org_wide THEN 'organization_scope_required'
      WHEN v_scope='cashbooks' AND NOT (org_wide OR overlay_org AND cardinality(v_cashbooks)>0) THEN 'organization_scope_required'
      WHEN v_scope IN ('rows','buildings') AND cardinality(buildings)=0 THEN 'no_building_scope' END;
    IF v_unavailable IS NULL THEN
      -- (P2-2b) ID gắn toà: thuộc công ty kết nối và toà trong ctx.buildings, thu hẹp ctx.buildings.
      FOREACH k IN ARRAY ARRAY['areaId','roomId','contractId','invoiceId'] LOOP
        CONTINUE WHEN v_params->k IS NULL OR v_params->k='null'::jsonb;
        v_id:=app_private.hermes_uuid_v1(v_params->k);
        IF k='areaId' THEN
          SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_ids FROM unnest(buildings) b(id)
            WHERE EXISTS(SELECT 1 FROM public.areas a JOIN public.area_buildings ab ON ab.area_id=a.id AND ab.organization_id=a.organization_id
              WHERE a.id=v_id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL AND ab.building_id=b.id);
          IF cardinality(v_ids)=0 THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
          buildings:=v_ids;
        ELSE
          IF k='roomId' THEN
            SELECT r.building_id INTO v_building FROM public.rooms r
              WHERE r.id=v_id AND r.organization_id=c.organization_id AND r.deleted_at IS NULL;
          ELSIF k='contractId' THEN
            SELECT r.building_id INTO v_building FROM public.contracts ct
              JOIN public.rooms r ON r.id=ct.room_id AND r.organization_id=c.organization_id
              WHERE ct.id=v_id AND ct.organization_id=c.organization_id AND ct.deleted_at IS NULL;
          ELSE
            SELECT inv.building_id INTO v_building FROM public.invoices inv
              WHERE inv.id=v_id AND inv.organization_id=c.organization_id AND inv.deleted_at IS NULL;
          END IF;
          IF v_building IS NULL OR NOT(v_building=ANY(buildings)) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
          buildings:=ARRAY[v_building];
        END IF;
        org_wide:=false; overlay_org:=false;
      END LOOP;
      -- ID không gắn toà: thuộc công ty kết nối (khách: chủ hồ sơ nhìn thấy được, như RLS web). IF lồng:
      -- câu SELECT chỉ được lập kế hoạch khi tham số có mặt (AND trong một biểu thức không chặn bảng vắng).
      IF v_params->'customerId' IS NOT NULL AND v_params->'customerId'<>'null'::jsonb THEN
        IF NOT EXISTS(SELECT 1 FROM public.customers cu
            WHERE cu.id=app_private.hermes_uuid_v1(v_params->'customerId') AND cu.organization_id=c.organization_id AND cu.deleted_at IS NULL
              AND cu.user_id=ANY(COALESCE(public.current_visible_owner_ids(),'{}'::uuid[])))
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      END IF;
      IF v_params->'cashbookId' IS NOT NULL AND v_params->'cashbookId'<>'null'::jsonb THEN
        v_id:=app_private.hermes_uuid_v1(v_params->'cashbookId');
        IF NOT EXISTS(SELECT 1 FROM public.accounts a WHERE a.id=v_id AND a.organization_id=c.organization_id AND a.deleted_at IS NULL)
          OR v_scope='cashbooks' AND NOT org_wide AND NOT(v_id=ANY(v_cashbooks))
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
        IF v_scope='cashbooks' AND NOT org_wide THEN v_cashbooks:=ARRAY[v_id]; END IF;
      END IF;
      IF v_params->'staffId' IS NOT NULL AND v_params->'staffId'<>'null'::jsonb THEN
        IF NOT EXISTS(SELECT 1 FROM public.organization_memberships m
            WHERE m.user_id=app_private.hermes_uuid_v1(v_params->'staffId') AND m.organization_id=c.organization_id
              AND m.status='ACTIVE' AND m.revoked_at IS NULL)
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      END IF;
      IF v_params->'supplierId' IS NOT NULL AND v_params->'supplierId'<>'null'::jsonb THEN
        IF NOT EXISTS(SELECT 1 FROM public.suppliers s
            WHERE s.id=app_private.hermes_uuid_v1(v_params->'supplierId') AND s.organization_id=c.organization_id AND s.deleted_at IS NULL)
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      END IF;
      IF v_params->'materialId' IS NOT NULL AND v_params->'materialId'<>'null'::jsonb THEN
        IF NOT EXISTS(SELECT 1 FROM public.materials m
            WHERE m.id=app_private.hermes_uuid_v1(v_params->'materialId') AND m.organization_id=c.organization_id AND m.deleted_at IS NULL)
          THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
      END IF;
      -- Khoá phụ (vd. customers.view cho tên khách): cùng cách tính khoá chính; gói tự giao với ctx.buildings.
      FOR k IN SELECT jsonb_array_elements_text(v_spec->'scopeKeys') LOOP
        v_extra:=v_extra||jsonb_build_object(k,to_jsonb(app_private.hermes_full_read_scope_v1(c,policy,context,k)));
      END LOOP;
      v_ctx:=jsonb_build_object('organizationId',c.organization_id,'userId',c.user_id,'report',v_report,'permission',permission,
        'scope',v_scope,'buildings',to_jsonb(buildings),'requestedBuildingId',requested_building,'overlayOrg',overlay_org,
        'orgWide',org_wide,'isSuperadmin',member->'isSuperadmin'='true'::jsonb,'today',public.org_today_v1(c.organization_id),
        'scopes',v_extra,'cashbooks',to_jsonb(v_cashbooks));
    END IF;
    -- Phong bì "fence": toà / sổ quỹ / org_wide cổng đã dùng — bước 3 và broker rào đầu ra theo đúng tập này.
    v_fence:=jsonb_build_object('buildings',CASE WHEN v_scope IN ('rows','buildings') THEN to_jsonb(buildings) ELSE '[]'::jsonb END,
      'cashbooks',CASE WHEN v_scope='cashbooks' THEN to_jsonb(v_cashbooks) ELSE '[]'::jsonb END,'orgWide',org_wide);
    -- package chỉ có khi đủ phạm vi: lối vào gọi đúng hàm gói đó với (report, params, ctx).
    v_plan:=jsonb_build_object('domain',p_domain,'connectionId',c.id,'organizationId',c.organization_id,'report',v_report,'source',v_spec->>'source','scope',v_scope,
      'limit',v_limit,'offset',v_offset,'unavailable',v_unavailable,'fence',v_fence,
      'package',CASE WHEN v_unavailable IS NULL THEN v_spec->>'package' END,'params',v_params,'ctx',v_ctx);
  END IF;
  RETURN v_plan;
END $fn$;

-- Bước 3 (DEFINER): như 20261018000600, cộng (P2-a): kiểm lại kết nối/phiên/công ty ĐẦU bước, mọi hàng tự
-- nêu toà (rows/buildings) và công ty (trừ self/platform), hàng công ty khác ⇒ 42501, gỡ organizationId.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_finish_v1(p_binding jsonb,p_plan jsonb,p_raw jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; buildings uuid[]; org_wide boolean;
  v_cashbooks uuid[]; v_scope text; v_report text; v_spec jsonb; v_raw jsonb:=p_raw; v_rows jsonb; v_unavailable text;
  v_page jsonb:='[]'::jsonb; v_bytes integer:=0; v_total integer; v_next integer; v_item jsonb; v_size integer; i integer;
  v_offset integer; v_limit integer; v_result jsonb; v_fence jsonb; v_org text;
BEGIN
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object' OR NOT COALESCE(p_plan->>'domain' IN ('report','report_list'),false)
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
  -- Kết nối/phiên còn hiệu lực SAU khi gói đọc (bước này chạy sau hàm gói), đúng kết nối, người, công ty của bước 1.
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO session FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.id::text IS DISTINCT FROM p_plan->>'connectionId' OR c.user_id IS DISTINCT FROM auth.uid()
    OR c.organization_id::text IS DISTINCT FROM p_plan->>'organizationId' OR NOT app_private.hermes_session_gate_v1(session)
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  v_org:=p_plan->>'organizationId';
  IF p_plan->>'domain'='report_list' THEN
    IF p_raw IS NOT NULL THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
    v_result:=jsonb_build_object('items',p_plan->'items');
  ELSE
    v_report:=p_plan->>'report'; v_scope:=p_plan->>'scope'; v_spec:=jsonb_build_object('source',p_plan->>'source');
    v_limit:=(p_plan->>'limit')::integer; v_offset:=(p_plan->>'offset')::integer; v_unavailable:=p_plan->>'unavailable';
    v_fence:=p_plan->'fence'; org_wide:=(v_fence->>'orgWide')::boolean;
    buildings:=ARRAY(SELECT jsonb_array_elements_text(v_fence->'buildings')::uuid);
    v_cashbooks:=ARRAY(SELECT jsonb_array_elements_text(v_fence->'cashbooks')::uuid);
    IF v_unavailable IS NOT NULL AND p_raw IS NOT NULL THEN
      RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
    IF v_unavailable IS NULL THEN
      -- Kết quả gói sai khuôn là lỗi của gói (XX000 ⇒ broker backend_unavailable), kiểm theo bậc kiểu.
      IF jsonb_typeof(v_raw) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
      IF (SELECT count(*) FROM jsonb_object_keys(v_raw))<>4 OR NOT(v_raw ?& ARRAY['rows','summary','sourceCapped','unavailable'])
        OR jsonb_typeof(v_raw->'rows') IS DISTINCT FROM 'array' OR jsonb_typeof(v_raw->'sourceCapped') IS DISTINCT FROM 'boolean'
        OR NOT COALESCE(jsonb_typeof(v_raw->'summary') IN ('null','object'),false)
        OR NOT(v_raw->'unavailable'='null'::jsonb OR COALESCE(v_raw->>'unavailable' IN
          ('organization_scope_required','no_building_scope','not_implemented','source_unavailable'),false))
        THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
      IF jsonb_array_length(v_raw->'rows')>2000
        OR v_raw->>'unavailable'='no_building_scope' AND v_scope NOT IN ('rows','buildings')
        OR v_raw->'unavailable'<>'null'::jsonb AND (jsonb_array_length(v_raw->'rows')>0 OR v_raw->'summary'<>'null'::jsonb)
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r WHERE jsonb_typeof(r)<>'object')
        THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
      -- (P2-a) Báo cáo theo toà: MỌI hàng tự nêu toà (null chỉ khi org_wide, kiểm dưới). Thiếu ⇒ khuôn sai.
      IF v_scope IN ('rows','buildings') AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r WHERE NOT r ? 'buildingId')
        THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
      -- (P2-a) Báo cáo của công ty (mọi phạm vi trừ self/platform): MỌI hàng tự nêu công ty (cột nguồn). Thiếu ⇒ khuôn sai.
      IF v_scope NOT IN ('self','platform') AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r WHERE NOT r ? 'organizationId')
        THEN RAISE EXCEPTION 'hermes_w2_package_result_invalid' USING ERRCODE='XX000'; END IF;
      -- (P2-a) Hàng nêu công ty khác công ty kết nối (RLS của super admin / người nhiều công ty rộng hơn) ⇒ 42501.
      IF v_scope<>'platform' AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r
          WHERE r ? 'organizationId' AND NOT COALESCE(jsonb_typeof(r->'organizationId')='string' AND r->>'organizationId'=v_org,false))
        THEN RAISE EXCEPTION 'hermes_w2_row_outside_scope' USING ERRCODE='42501'; END IF;
      -- (P2-2a) Rào ĐẦU RA: hàng nêu toà phải nằm trong toà đã giao (null chỉ khi org_wide); báo cáo không
      -- theo toà không được nêu toà; báo cáo sổ quỹ (không org_wide) chỉ trong sổ được cấp. Vi phạm ⇒ 42501.
      IF v_scope IN ('rows','buildings') THEN
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r WHERE
            r ? 'buildingId' AND NOT (CASE WHEN r->'buildingId'='null'::jsonb THEN org_wide
              ELSE jsonb_typeof(r->'buildingId')='string' AND COALESCE((r->>'buildingId')=ANY(buildings::text[]),false) END)
            OR r ? 'buildingIds' AND NOT (CASE WHEN jsonb_typeof(r->'buildingIds')='array' THEN NOT EXISTS(
              SELECT 1 FROM jsonb_array_elements(r->'buildingIds') x WHERE jsonb_typeof(x)<>'string'
                OR NOT COALESCE((x#>>'{}')=ANY(buildings::text[]),false)) ELSE false END))
          THEN RAISE EXCEPTION 'hermes_w2_row_outside_scope' USING ERRCODE='42501'; END IF;
      ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r WHERE r ? 'buildingId' OR r ? 'buildingIds') THEN
        RAISE EXCEPTION 'hermes_w2_row_outside_scope' USING ERRCODE='42501';
      END IF;
      IF v_scope='cashbooks' AND NOT org_wide AND EXISTS(SELECT 1 FROM jsonb_array_elements(v_raw->'rows') r
          WHERE r ? 'cashbookId' AND NOT COALESCE((r->>'cashbookId')=ANY(v_cashbooks::text[]),false))
        THEN RAISE EXCEPTION 'hermes_w2_row_outside_scope' USING ERRCODE='42501'; END IF;
      v_unavailable:=v_raw->>'unavailable';
      -- organizationId là trường rào, không tới mô hình (platform giữ đúng như gói khai).
      IF v_scope<>'platform' THEN
        v_raw:=jsonb_set(v_raw,'{rows}',COALESCE((SELECT jsonb_agg(x.r-'organizationId' ORDER BY x.n)
          FROM jsonb_array_elements(v_raw->'rows') WITH ORDINALITY x(r,n)),'[]'::jsonb));
      END IF;
    END IF;
    IF v_unavailable IS NOT NULL THEN
      v_result:=jsonb_build_object('report',v_report,'source',v_spec->>'source','unavailable',v_unavailable,'summary',NULL,
        'items','[]'::jsonb,'offset',v_offset,'nextOffset',NULL,'sourceCapped',false,'fence',v_fence);
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
        'items',v_page,'offset',v_offset,'nextOffset',v_next,'sourceCapped',v_raw->'sourceCapped','fence',v_fence);
    END IF;
  END IF;
  IF octet_length(to_jsonb(v_result::text)::text)>60000 THEN
    RAISE EXCEPTION 'hermes_domain_response_too_large' USING ERRCODE='PT413',HINT='Giảm limit hoặc thu hẹp bộ lọc rồi gọi lại.';
  END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_plan->>'domain',
    'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))||v_result;
END $fn$;

ALTER FUNCTION app_private.hermes_w2_org_keys_v1() OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_permission_kind_v1(text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_catalog_v1(text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_finish_v1(jsonb,jsonb,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_w2_org_keys_v1(),app_private.hermes_w2_permission_kind_v1(text),app_private.hermes_w2_catalog_v1(text),
  app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text),app_private.hermes_w2_finish_v1(jsonb,jsonb,jsonb)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- authenticated: chỉ hai bước mà lối vào INVOKER gọi qua OID (như 20261018000600).
GRANT EXECUTE ON FUNCTION app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text),app_private.hermes_w2_finish_v1(jsonb,jsonb,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
