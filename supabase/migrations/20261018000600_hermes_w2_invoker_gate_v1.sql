-- Hermes đọc đầy đủ — ĐỢT 2, Gói 0: cổng báo cáo theo mô hình INVOKER + RLS (quyết định kiến trúc 18/10/2026
-- sau hai review độc lập: hàm SQL dùng chung web + Hermes chạy dưới RLS của CHÍNH người dùng, từ chối khi
-- current_user <> 'authenticated'; DEFINER chỉ cho bước kiểm quyền/helper nhỏ). Chạy SAU 20261018000500.
-- Không DROP, không đổi chữ ký hàm đã có, không ghi dữ liệu nghiệp vụ.
--   public.hermes_w2_read_v1 (INVOKER, thân SQL chuẩn) = lối vào MỚI của hai tool meta, connector gọi bằng
--   JWT người dùng như v3. Thân SQL chuẩn (SQL-standard body) gắn hàm theo OID lúc tạo, nên vai authenticated gọi
--   được ba bước dưới mà KHÔNG cần USAGE trên app_private (lớp chặn gọi thẳng vẫn giữ; cùng lối với
--   public.hermes_task_input_options_v1):
--     1. app_private.hermes_w2_scope_v1 (DEFINER): binding/phiên/epoch/chính sách/registry/quyền CRM ∩ overlay,
--        P2-1…P2-3 (khoá ↔ phạm vi, org_wide, sổ quỹ, platform), giải tham số ID; trả kế hoạch + ctx. Đòi người
--        gọi là authenticated (current_user của lối vào INVOKER).
--     2. app_private.hermes_w2<gói>_read_v1 (INVOKER): hàm của gói, chạy dưới RLS của người hỏi.
--     3. app_private.hermes_w2_finish_v1 (DEFINER): kiểm khuôn kết quả gói, RÀO ĐẦU RA (P2-2a) theo đúng
--        fence bước 1 đã cấp, phân trang ≈40 KB, trần 60 KB, kiểm lại kết nối/phiên SAU khi gói đọc.
--   app_private.hermes_w2_gate_v1 (DEFINER) ngừng dùng: thân chỉ còn 22023, để không đường nào chạy hàm gói
--   dưới vai chủ hàm (bỏ qua RLS). v3 vẫn định tuyến report/report_list tới đó ⇒ 22023; broker gọi lối mới.
--   Khung hàm đọc của gói đổi sang SECURITY INVOKER (gói thay thân, GIỮ INVOKER; ACL theo hàm, không đổi).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_w2_permission_kind_v1(text)') IS NULL
    OR to_regprocedure('app_private.hermes_w2_catalog_v1(text)') IS NULL
    OR to_regprocedure('app_private.hermes_w2_gate_v1(jsonb,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'hermes_w2_invoker_requires_foundation_fixes';
  END IF;
END $requires$;

-- Bước 1 (DEFINER): mọi kiểm tra của cổng 20261018000500 TRƯỚC lời gọi gói, giữ nguyên từng dòng.
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
    v_plan:=jsonb_build_object('domain',p_domain,'connectionId',c.id,'package',NULL,'items',v_rows);
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
    IF app_private.hermes_w2_permission_kind_v1(permission)='company' THEN
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
    v_plan:=jsonb_build_object('domain',p_domain,'connectionId',c.id,'report',v_report,'source',v_spec->>'source','scope',v_scope,
      'limit',v_limit,'offset',v_offset,'unavailable',v_unavailable,'fence',v_fence,
      'package',CASE WHEN v_unavailable IS NULL THEN v_spec->>'package' END,'params',v_params,'ctx',v_ctx);
  END IF;
  RETURN v_plan;
END $fn$;

-- Bước 3 (DEFINER): khuôn kết quả gói, rào đầu ra, phân trang, trần byte, kiểm lại kết nối/phiên — từng dòng
-- như phần sau lời gọi gói của cổng 20261018000500, trên fence bước 1 đã cấp.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_finish_v1(p_binding jsonb,p_plan jsonb,p_raw jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; session app_private.hermes_sessions; buildings uuid[]; org_wide boolean;
  v_cashbooks uuid[]; v_scope text; v_report text; v_spec jsonb; v_raw jsonb:=p_raw; v_rows jsonb; v_unavailable text;
  v_page jsonb:='[]'::jsonb; v_bytes integer:=0; v_total integer; v_next integer; v_item jsonb; v_size integer; i integer;
  v_offset integer; v_limit integer; v_result jsonb; v_fence jsonb;
BEGIN
  IF jsonb_typeof(p_plan) IS DISTINCT FROM 'object' OR NOT COALESCE(p_plan->>'domain' IN ('report','report_list'),false)
    THEN RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023'; END IF;
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
  -- Kết nối/phiên còn hiệu lực SAU khi gói đọc, và vẫn đúng kết nối bước 1 đã kiểm.
  c:=app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  SELECT * INTO session FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  IF c.id::text IS DISTINCT FROM p_plan->>'connectionId' OR c.user_id IS DISTINCT FROM auth.uid()
    OR NOT app_private.hermes_session_gate_v1(session) THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'domain',p_plan->>'domain',
    'fetchedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))||v_result;
END $fn$;

-- Bước 2: khung hàm đọc của gói, nay SECURITY INVOKER (chạy dưới RLS của người hỏi). GÓI <x> THAY THÂN và
-- GIỮ nguyên dòng đầu (INVOKER, search_path=pg_catalog,public). Thân plpgsql KHÔNG gọi app_private.* theo
-- tên (authenticated không có USAGE trên app_private ⇒ 42501); cần helper riêng thì dùng thân SQL chuẩn
-- (SQL-standard body) hoặc helper public trả tập id của chính người gọi.
CREATE OR REPLACE FUNCTION app_private.hermes_w2a_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','not_implemented');
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_w2b_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','not_implemented');
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_w2c_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','not_implemented');
END $fn$;
CREATE OR REPLACE FUNCTION app_private.hermes_w2d_read_v1(p_report text,p_params jsonb,p_ctx jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_ctx->>'userId' IS DISTINCT FROM auth.uid()::text
    THEN RAISE EXCEPTION 'hermes_domain_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('rows','[]'::jsonb,'summary',NULL,'sourceCapped',false,'unavailable','not_implemented');
END $fn$;

-- Cổng DEFINER cũ: ngừng dùng (không DROP). Không còn đường nào chạy hàm gói dưới vai chủ hàm.
CREATE OR REPLACE FUNCTION app_private.hermes_w2_gate_v1(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  RAISE EXCEPTION 'hermes_domain_invalid' USING ERRCODE='22023';
END $fn$;

-- Lối vào (INVOKER, thân SQL chuẩn): bước 1 → hàm gói đúng mã → bước 3. CTE MATERIALIZED: mỗi bước chạy
-- đúng một lần, theo thứ tự phụ thuộc. current_user ở đây là vai của người gọi (authenticated qua PostgREST).
CREATE OR REPLACE FUNCTION public.hermes_w2_read_v1(p_binding jsonb,p_domain text,p_input jsonb)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public
BEGIN ATOMIC
 WITH s AS MATERIALIZED (SELECT app_private.hermes_w2_scope_v1(p_binding,p_domain,p_input,current_user::text) AS plan),
 r AS MATERIALIZED (SELECT s.plan,CASE s.plan->>'package'
   WHEN 'a' THEN app_private.hermes_w2a_read_v1(s.plan->>'report',s.plan->'params',s.plan->'ctx')
   WHEN 'b' THEN app_private.hermes_w2b_read_v1(s.plan->>'report',s.plan->'params',s.plan->'ctx')
   WHEN 'c' THEN app_private.hermes_w2c_read_v1(s.plan->>'report',s.plan->'params',s.plan->'ctx')
   WHEN 'd' THEN app_private.hermes_w2d_read_v1(s.plan->>'report',s.plan->'params',s.plan->'ctx') END AS raw FROM s)
 SELECT app_private.hermes_w2_finish_v1(p_binding,r.plan,r.raw) FROM r;
END;

ALTER FUNCTION app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_finish_v1(jsonb,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2a_read_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2b_read_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2c_read_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2d_read_v1(text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_w2_gate_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.hermes_w2_read_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text),app_private.hermes_w2_finish_v1(jsonb,jsonb,jsonb),
  app_private.hermes_w2a_read_v1(text,jsonb,jsonb),app_private.hermes_w2b_read_v1(text,jsonb,jsonb),app_private.hermes_w2c_read_v1(text,jsonb,jsonb),
  app_private.hermes_w2d_read_v1(text,jsonb,jsonb),app_private.hermes_w2_gate_v1(jsonb,text,jsonb),public.hermes_w2_read_v1(jsonb,text,jsonb)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- authenticated: lối vào + ba bước (gọi được nhờ OID trong thân SQL chuẩn; không USAGE trên app_private).
GRANT EXECUTE ON FUNCTION public.hermes_w2_read_v1(jsonb,text,jsonb),app_private.hermes_w2_scope_v1(jsonb,text,jsonb,text),
  app_private.hermes_w2_finish_v1(jsonb,jsonb,jsonb),app_private.hermes_w2a_read_v1(text,jsonb,jsonb),app_private.hermes_w2b_read_v1(text,jsonb,jsonb),
  app_private.hermes_w2c_read_v1(text,jsonb,jsonb),app_private.hermes_w2d_read_v1(text,jsonb,jsonb) TO authenticated;
COMMIT;
NOTIFY pgrst,'reload schema';
