-- Hermes không còn phụ thuộc lúc chạy vào hàm Copilot (chủ chốt 17/10/2026).
--
-- Trước: bốn hàm Hermes (hermes_room_scope_map_v1, hermes_connection_context_v1,
-- hermes_connection_options_v1, hermes_sale_listing_rooms_v1) và connector (RPC
-- PostgREST) lấy toà theo quyền rooms.view qua một hàm bọc của Copilot.
-- Hàm bọc đó chỉ là lớp mỏng quanh bộ giải quyền chung app_private.authorized_scope_v3.
--
-- Sau:
--  (1) public.hermes_scope_buildings_v1(khoá, công ty): CHÍNH phép tính của bản đang chạy
--      trên production (đọc pg_proc 17/10/2026, prosrc md5 7e49860f9ac1a68f786636a577127997):
--      công ty ACTIVE, có auth.uid(), thành viên ACTIVE/chưa thu hồi/trong hiệu lực, rồi
--      building_ids của authorized_scope_v3 (đã trừ DENY theo toà/khu/công ty, chặn khẩn cấp)
--      giao với toà còn hoạt động của đúng công ty, sắp theo id. Cùng mã lỗi/thông điệp.
--      Khác duy nhất: chỉ nhận khoá Hermes dùng ('rooms.view'); khoá khác 22023.
--      Chỉ authenticated gọi được; owner postgres.
--  (2) Bốn hàm trên: chép NGUYÊN bản định nghĩa cuối (20261014000503, 20261016080232),
--      chỉ đổi lời gọi sang (1). Chữ ký, kiểu trả về, volatility, ACL giữ nguyên.
-- Hàm Copilot không bị sửa/xoá: connector cũ vẫn gọi được nó sau migration này.
-- Không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- 1. Phạm vi toà theo quyền CRM của người gọi, thuộc Hermes.
CREATE OR REPLACE FUNCTION public.hermes_scope_buildings_v1(p_permission_key text,p_organization_id uuid)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_now timestamptz:=now(); v_scope uuid[];
BEGIN
  -- Chỉ khoá Hermes cần; thêm khoá phải qua migration có review.
  IF p_permission_key IS NULL OR p_permission_key<>'rooms.view' THEN
    RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;
  IF p_organization_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.organizations o
      WHERE o.id=p_organization_id AND o.status='ACTIVE') THEN
    RAISE EXCEPTION 'organization_required' USING ERRCODE='22023'; END IF;
  IF v_actor IS NULL THEN RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  -- Cổng thành viên độc lập với phép giải quyền: thu hồi/hết hiệu lực là từ chối cứng.
  IF NOT EXISTS(SELECT 1 FROM public.organization_memberships m
      WHERE m.organization_id=p_organization_id AND m.user_id=v_actor AND m.status='ACTIVE' AND m.revoked_at IS NULL
        AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now AND (m.valid_to IS NULL OR m.valid_to>v_now)) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE='42501'; END IF;
  -- building_ids của bộ giải chung đã trừ mọi DENY; không nới theo org_wide.
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO v_scope
    FROM app_private.authorized_scope_v3(p_permission_key,p_organization_id) s
    CROSS JOIN LATERAL unnest(COALESCE(s.building_ids,'{}'::uuid[])) allowed(building_id)
    JOIN public.buildings b ON b.id=allowed.building_id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL;
  -- Rỗng là kết quả hợp lệ, không ngụ ý quyền toàn công ty.
  RETURN COALESCE(v_scope,'{}'::uuid[]);
END $fn$;

-- 2. Bốn hàm Hermes: bản định nghĩa cuối, chỉ đổi nguồn phạm vi toà sang (1).
-- Bản cuối: 20261014000503.
CREATE OR REPLACE FUNCTION public.hermes_room_scope_map_v1(p_organization_id uuid,p_scope_ids uuid[],
  p_connection_id uuid,p_token_digest text,p_expected_epoch bigint,p_expected_policy_version bigint,
  p_expected_membership_id uuid,p_expected_authorization_version bigint,p_expected_session_revision bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_buildings uuid[]; v_scopes jsonb; v_edges jsonb; v_auth jsonb; v_allowed uuid[];
  v_actor uuid:=auth.uid(); v_now timestamptz:=clock_timestamp(); v_count integer;
  v_c app_private.hermes_connections; v_s app_private.hermes_sessions;
  v_p app_private.hermes_org_policies; v_t app_private.hermes_connection_tokens;
  v_member public.organization_memberships;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_organization_id IS NULL
    OR p_connection_id IS NULL OR p_expected_membership_id IS NULL OR p_token_digest IS NULL
    OR p_token_digest !~ '^[0-9a-f]{64}$' OR p_expected_epoch IS NULL OR p_expected_epoch<1
    OR p_expected_policy_version IS NULL OR p_expected_policy_version<0
    OR p_expected_authorization_version IS NULL OR p_expected_authorization_version<1
    OR p_expected_session_revision IS NULL OR p_expected_session_revision<1 THEN
    RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;
  IF p_scope_ids IS NULL OR cardinality(p_scope_ids)<1 OR cardinality(p_scope_ids)>256
    OR array_ndims(p_scope_ids)<>1 OR array_position(p_scope_ids,NULL) IS NOT NULL
    OR cardinality(p_scope_ids)<>(SELECT count(DISTINCT id) FROM unnest(p_scope_ids) id) THEN
    RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_c FROM app_private.hermes_connections
    WHERE id=p_connection_id AND organization_id=p_organization_id AND user_id=v_actor AND state='ACTIVE';
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_s FROM app_private.hermes_sessions
    WHERE id=v_c.credential_ref AND assistant_id=v_c.assistant_id AND organization_id=p_organization_id
      AND user_id=v_actor AND provider_session_id::text=auth.jwt()->>'session_id'
      AND state='ACTIVE' AND quarantine_reason IS NULL AND expires_at>v_now;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_t FROM app_private.hermes_connection_tokens
    WHERE token_digest=p_token_digest AND connection_id=v_c.id AND revoked_at IS NULL AND expires_at>v_now;
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_p FROM app_private.hermes_effective_org_policy_v1(p_organization_id,v_c.read_capabilities,v_c.action_capabilities,v_c.scope_ids) WHERE enabled;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a
    WHERE a.id=v_c.assistant_id AND a.organization_id=p_organization_id AND a.user_id=v_actor AND a.state='ACTIVE')
    OR NOT ('rooms.view'=ANY(v_c.read_capabilities)) OR NOT ('rooms.view'=ANY(v_p.read_capabilities))
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_capabilities cap
      WHERE cap.capability='rooms.view' AND cap.mode='read' AND cap.enabled) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  IF v_c.epoch<>p_expected_epoch OR v_p.version<>p_expected_policy_version OR v_s.revision<>p_expected_session_revision THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO v_allowed FROM (
    SELECT unnest(v_c.scope_ids) AS id INTERSECT SELECT unnest(v_p.scope_ids) AS id
  ) allowed;
  IF NOT(p_scope_ids<@v_allowed) OR NOT(v_allowed<@p_scope_ids) THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;

  -- Identity/lifetime parity with hermes_member_v1, without calling that VOLATILE
  -- helper inside a coherent read. Permissions remain the shared CRM resolver's.
  SELECT count(*) INTO v_count FROM public.organization_memberships m
    JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=v_actor AND m.organization_id=p_organization_id AND o.status='ACTIVE'
      AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now AND (m.valid_to IS NULL OR m.valid_to>v_now);
  IF v_count<>1 THEN RAISE EXCEPTION 'hermes_membership_required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_member FROM public.organization_memberships
    WHERE id=p_expected_membership_id AND user_id=v_actor AND organization_id=p_organization_id
      AND status='ACTIVE' AND revoked_at IS NULL
      AND COALESCE(valid_from,'-infinity'::timestamptz)<=v_now AND (valid_to IS NULL OR valid_to>v_now);
  IF NOT FOUND THEN RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.super_admins WHERE user_id=v_actor) THEN
    SELECT count(DISTINCT m.organization_id) INTO v_count FROM public.organization_memberships m
      JOIN public.organizations o ON o.id=m.organization_id
      WHERE m.user_id=v_actor AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
        AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=v_now AND (m.valid_to IS NULL OR m.valid_to>v_now);
    IF v_count<>1 THEN RAISE EXCEPTION 'hermes_ordinary_org_ambiguous' USING ERRCODE='42501'; END IF;
  END IF;
  -- require_perm_v1 supplies no target building and would reject legitimate
  -- BUILDING/AREA-scoped readers. Use the same boolean + concrete scope resolver
  -- as the canonical CRM read adapter, then intersect every mapped building.
  v_auth:=public.get_authorization_context_v1(p_organization_id);
  IF v_auth->>'organizationId' IS DISTINCT FROM p_organization_id::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR v_auth->'permissions'->'rooms.view' IS DISTINCT FROM 'true'::jsonb THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  IF v_auth->>'membershipId' IS DISTINCT FROM p_expected_membership_id::text
    OR v_auth->>'authorizationVersion' IS DISTINCT FROM p_expected_authorization_version::text THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='PT409'; END IF;
  v_buildings:=public.hermes_scope_buildings_v1('rooms.view',p_organization_id);
  IF v_buildings IS NULL OR cardinality(v_buildings)<1 OR cardinality(v_buildings)>256 THEN
    RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
  -- Reject an incomplete/foreign/deleted mapping rather than silently dropping
  -- requested nodes. CASHBOOK is metadata only and grants zero room buildings.
  IF EXISTS (
    SELECT 1 FROM unnest(p_scope_ids) requested(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.authorization_scopes s
      WHERE s.id=requested.id AND s.organization_id=p_organization_id AND (
        s.scope_type='ORGANIZATION'
        OR (s.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.areas a
          WHERE a.id=s.area_id AND a.organization_id=p_organization_id AND a.deleted_at IS NULL))
        OR (s.scope_type='BUILDING' AND EXISTS(SELECT 1 FROM public.buildings b
          WHERE b.id=s.building_id AND b.organization_id=p_organization_id AND b.deleted_at IS NULL))
        OR (s.scope_type='CASHBOOK' AND EXISTS(SELECT 1 FROM public.accounts a
          WHERE a.id=s.cashbook_id AND a.organization_id=p_organization_id AND a.deleted_at IS NULL))
      )
    )
  ) THEN RAISE EXCEPTION 'hermes_scope_invalid' USING ERRCODE='22023'; END IF;

  SELECT jsonb_agg(jsonb_build_object('id',s.id,'scopeType',s.scope_type,
    'buildingId',s.building_id,'areaId',s.area_id,'cashbookId',s.cashbook_id) ORDER BY s.id)
    INTO v_scopes FROM public.authorization_scopes s
    WHERE s.organization_id=p_organization_id AND s.id=ANY(p_scope_ids);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('organizationId',ab.organization_id,
    'areaId',ab.area_id,'buildingId',ab.building_id) ORDER BY ab.area_id,ab.building_id),'[]'::jsonb)
    INTO v_edges
    FROM public.area_buildings ab
    JOIN public.areas a ON a.id=ab.area_id AND a.organization_id=ab.organization_id AND a.deleted_at IS NULL
    JOIN public.buildings b ON b.id=ab.building_id AND b.organization_id=ab.organization_id AND b.deleted_at IS NULL
    WHERE ab.organization_id=p_organization_id AND ab.building_id=ANY(v_buildings)
      AND EXISTS(SELECT 1 FROM public.authorization_scopes s WHERE s.organization_id=p_organization_id
        AND s.id=ANY(p_scope_ids) AND s.scope_type='AREA' AND s.area_id=ab.area_id);
  IF jsonb_array_length(v_scopes)<>cardinality(p_scope_ids) OR jsonb_array_length(v_edges)>=4096 THEN
    RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
  IF v_s.expires_at<=clock_timestamp() OR v_t.expires_at<=clock_timestamp()
    OR (v_member.valid_to IS NOT NULL AND v_member.valid_to<=clock_timestamp()) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',p_organization_id,'complete',true,
    'scopes',v_scopes,'areaBuildings',v_edges,'permissionBuildingIds',to_jsonb(v_buildings),
    'binding',jsonb_build_object('connectionId',v_c.id,'epoch',v_c.epoch,'policyVersion',v_p.version,
      'membershipId',v_member.id,'authorizationVersion',p_expected_authorization_version,'sessionRevision',v_s.revision));
END
$fn$;

-- Bản cuối: 20261014000503.
CREATE OR REPLACE FUNCTION public.hermes_connection_context_v1(p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_c app_private.hermes_connections; v_p app_private.hermes_org_policies;
  v_member jsonb; v_auth jsonb; v_read jsonb; v_buildings uuid[];
BEGIN
  SELECT * INTO v_c FROM app_private.hermes_connections WHERE id=p_connection_id AND user_id=auth.uid();
  IF NOT FOUND OR v_c.state<>'ACTIVE' THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_member:=app_private.hermes_member_v1(auth.uid(),v_c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_p FROM app_private.hermes_effective_org_policy_v1(v_c.organization_id,v_c.read_capabilities,v_c.action_capabilities,v_c.scope_ids);
  IF NOT FOUND OR NOT v_p.enabled OR NOT EXISTS(SELECT 1 FROM app_private.hermes_assistants a WHERE a.id=v_c.assistant_id AND a.state='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_sessions s WHERE s.id=v_c.credential_ref AND s.state='ACTIVE' AND s.quarantine_reason IS NULL AND s.expires_at>clock_timestamp())
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_connection_tokens t WHERE t.connection_id=v_c.id AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501';
  END IF;
  v_auth:=public.get_authorization_context_v1(v_c.organization_id);
  IF v_auth->>'organizationId' IS DISTINCT FROM v_c.organization_id::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_buildings:=public.hermes_scope_buildings_v1('rooms.view',v_c.organization_id);
  SELECT COALESCE(jsonb_agg(cap.capability ORDER BY cap.capability),'[]'::jsonb) INTO v_read
    FROM app_private.hermes_capabilities cap WHERE cap.mode='read' AND cap.enabled
      AND cap.capability=ANY(v_c.read_capabilities) AND cap.capability=ANY(v_p.read_capabilities)
      AND (cap.capability='assistant.context.read' OR
        (cap.capability='rooms.view' AND v_auth->'permissions'->'rooms.view'='true'::jsonb
          AND cardinality(v_buildings)>0));
  RETURN app_private.hermes_connection_json_v1(v_c)||v_member||jsonb_build_object('policyVersion',v_p.version,
    'companyCeilings',jsonb_build_object('read',v_p.read_capabilities,'action',v_p.action_capabilities),
    'effective',jsonb_build_object('read',v_read,'action','[]'::jsonb));
END
$fn$;

-- Bản cuối: 20261014000503.
CREATE OR REPLACE FUNCTION public.hermes_connection_options_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private
AS $fn$
DECLARE v_actor uuid:=auth.uid(); v_member jsonb; v_auth jsonb;
  v_policy app_private.hermes_org_policies; v_buildings uuid[]; v_scopes jsonb:='[]'::jsonb;
  v_read jsonb:='[]'::jsonb; v_enabled boolean:=false;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated' OR p_org IS NULL THEN
    RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_org);
  v_member:=app_private.hermes_member_v1(v_actor,p_org);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_not_permitted' USING ERRCODE='42501'; END IF;
  v_auth:=public.get_authorization_context_v1(p_org);
  IF v_auth->>'organizationId' IS DISTINCT FROM p_org::text
    OR v_auth->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR v_auth->>'membershipId' IS DISTINCT FROM v_member->>'membershipId'
    OR v_auth->>'authorizationVersion' IS DISTINCT FROM v_member->>'authorizationVersion' THEN
    RAISE EXCEPTION 'hermes_context_changed' USING ERRCODE='40001'; END IF;
  PERFORM 1 FROM app_private.hermes_org_policies WHERE organization_id=p_org FOR SHARE;
  SELECT * INTO v_policy FROM app_private.hermes_effective_org_policy_v1(p_org,NULL,NULL,NULL);
  v_enabled:=FOUND AND v_policy.enabled;
  IF v_enabled THEN
    IF 'assistant.context.read'=ANY(v_policy.read_capabilities) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities
      WHERE capability='assistant.context.read' AND mode='read' AND enabled) THEN
      v_read:=v_read||'"assistant.context.read"'::jsonb;
    END IF;
    IF 'rooms.view'=ANY(v_policy.read_capabilities) AND v_auth->'permissions'->'rooms.view'='true'::jsonb
      AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='rooms.view' AND mode='read' AND enabled) THEN
      v_buildings:=public.hermes_scope_buildings_v1('rooms.view',p_org);
      IF v_buildings IS NULL OR cardinality(v_buildings)>256 THEN
        RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
      SELECT COALESCE(jsonb_agg(jsonb_build_object('scopeId',s.id,'scopeType',s.scope_type,
        'label',app_private.scope_label_v1(s.id),'buildingId',s.building_id,'areaId',s.area_id,'cashbookId',NULL) ORDER BY s.id),'[]'::jsonb)
        INTO v_scopes FROM public.authorization_scopes s
        WHERE s.organization_id=p_org AND s.id=ANY(v_policy.scope_ids) AND s.scope_type IN ('ORGANIZATION','AREA','BUILDING')
          AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=ANY(v_buildings) AND b.organization_id=p_org AND b.deleted_at IS NULL
            AND (s.scope_type='ORGANIZATION' OR (s.scope_type='BUILDING' AND s.building_id=b.id)
              OR (s.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.areas a JOIN public.area_buildings ab
                ON ab.area_id=a.id AND ab.organization_id=a.organization_id
                WHERE a.id=s.area_id AND a.organization_id=p_org AND a.deleted_at IS NULL AND ab.building_id=b.id))));
      IF jsonb_array_length(v_scopes)>256 THEN RAISE EXCEPTION 'hermes_scope_too_large' USING ERRCODE='22023'; END IF;
      IF jsonb_array_length(v_scopes)>0 THEN v_read:=v_read||'"rooms.view"'::jsonb; END IF;
    END IF;
  END IF;
  -- A bounded observation, not a lease: enrollment and every runtime call
  -- independently recheck live user/company/policy/scope authority.
  RETURN v_member||jsonb_build_object('userId',v_actor,'organizationId',p_org,
    'policyVersion',COALESCE(v_policy.version,0),'enabled',v_enabled,'read',v_read,'action','[]'::jsonb,'scopes',v_scopes);
END
$fn$;

-- Bản cuối: 20261016080232.
CREATE OR REPLACE FUNCTION public.hermes_sale_listing_rooms_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_buildings uuid[]; v_page jsonb;
BEGIN
  v_buildings:=COALESCE(public.hermes_scope_buildings_v1('rooms.view',p_organization_id),'{}'::uuid[]);
  v_page:=app_private.hermes_sale_listing_payload_v1(p_organization_id);
  RETURN jsonb_build_object('pages',v_page->'pages',
    'buildings',COALESCE((SELECT jsonb_agg(x ORDER BY ord) FROM jsonb_array_elements(v_page->'buildings') WITH ORDINALITY e(x,ord)
      WHERE (x->>'id')::uuid=ANY(v_buildings)),'[]'::jsonb),
    'rooms',COALESCE((SELECT jsonb_agg(x ORDER BY ord) FROM (
      SELECT x,ord FROM jsonb_array_elements(v_page->'rooms') WITH ORDINALITY e(x,ord)
      WHERE (x->>'building_id')::uuid=ANY(v_buildings) ORDER BY ord LIMIT 2000) capped),'[]'::jsonb));
END $fn$;

ALTER FUNCTION public.hermes_scope_buildings_v1(text,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_scope_buildings_v1(text,uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_scope_buildings_v1(text,uuid) TO authenticated;

ALTER FUNCTION public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint) TO authenticated;

ALTER FUNCTION public.hermes_connection_context_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_context_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_connection_context_v1(uuid) TO authenticated;

ALTER FUNCTION public.hermes_connection_options_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_connection_options_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_connection_options_v1(uuid) TO authenticated;

ALTER FUNCTION public.hermes_sale_listing_rooms_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_sale_listing_rooms_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_sale_listing_rooms_v1(uuid) TO authenticated;

COMMENT ON FUNCTION public.hermes_scope_buildings_v1(text,uuid) IS
  'Hermes: toà người gọi được phép theo khoá CRM (chỉ rooms.view) = authorized_scope_v3.building_ids giao toà còn hoạt động của công ty.';

-- Tự kiểm trước khi commit: đúng quyền, đúng nguồn, không còn lời gọi Copilot.
DO $assert$
DECLARE v_name text;
BEGIN
  IF has_function_privilege('anon','public.hermes_scope_buildings_v1(text,uuid)','EXECUTE')
    OR has_function_privilege('service_role','public.hermes_scope_buildings_v1(text,uuid)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','public.hermes_scope_buildings_v1(text,uuid)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.hermes_scope_buildings_v1(text,uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes scope buildings ACL'; END IF;
  IF position('app_private.authorized_scope_v3(p_permission_key,p_organization_id)' IN
      pg_get_functiondef('public.hermes_scope_buildings_v1(text,uuid)'::regprocedure))=0
    THEN RAISE EXCEPTION 'hermes scope buildings source'; END IF;
  FOREACH v_name IN ARRAY ARRAY['public.hermes_scope_buildings_v1(text,uuid)',
    'public.hermes_room_scope_map_v1(uuid,uuid[],uuid,text,bigint,bigint,uuid,bigint,bigint)',
    'public.hermes_connection_context_v1(uuid)','public.hermes_connection_options_v1(uuid)',
    'public.hermes_sale_listing_rooms_v1(uuid)'] LOOP
    IF position('copilot' IN lower(pg_get_functiondef(v_name::regprocedure)))>0
      OR (v_name<>'public.hermes_scope_buildings_v1(text,uuid)'
        AND position('public.hermes_scope_buildings_v1(''rooms.view''' IN pg_get_functiondef(v_name::regprocedure))=0)
      THEN RAISE EXCEPTION 'hermes scope source: %',v_name; END IF;
  END LOOP;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
