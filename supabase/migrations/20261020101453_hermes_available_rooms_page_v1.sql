-- B3: Hermes đọc phòng trang Sale đã lọc tòa/trạng thái và phân trang NGAY TRONG SQL
-- (thiết kế docs/plans/hermes-crm/B3-THIET-KE-RPC-PHONG-2026-10-20.md, chốt 20/10/2026).
--
-- Trước: crm_available_rooms gọi hermes_room_scope_map_v1 rồi hermes_sale_listing_rooms_v1
-- (nguyên trang công khai của mọi chủ có link, kể cả ảnh/tòa ngoài phạm vi, trần 2000),
-- rồi connector mới lọc tên tòa và cắt trang trong JS.
--
-- Sau: một hàm public.hermes_available_rooms_page_v1(binding 4 trường, org, tòa thu hẹp, tên tòa,
-- trạng thái, limit, offset):
--  (1) app_private.hermes_room_page_admission_v1: chép khối nhận kết nối của
--      hermes_domain_read_scope_fast_v1 (20261019040111) cho đúng một khóa 'rooms.view', không
--      embed — token/kết nối/phiên/assistant/epoch/revision/thành viên/offboard/chính sách công ty
--      và giao phạm vi trợ lý (ORG/BUILDING/AREA; CASHBOOK = 0 tòa). DB tự suy tập tòa được phép;
--      p_organization_id chỉ để khẳng định, p_building_ids chỉ thu hẹp (ngoài tập ⇒ 42501).
--  (2) Phần chọn trang chép từ public.get_public_available_rooms (20261010022101): chủ có link còn
--      hiệu lực theo công ty, tòa thật của chủ đó, soon_days/hotline/chính sách theo chủ, overlay
--      pass đúng chủ và active, che liên hệ khi contact_manager, địa chỉ, công thức trạng thái
--      gọi NGUYÊN app_private.room_sale_workflow_fact_v1 (không gọi _base_ để giữ lock tạm).
--      Chuông chống trôi: web-parity.json (hash get_public_available_rooms) + test so khối admission.
--  (3) Chỉ phòng free/soon/pass; tổng (totalCount) và trang tính trong cùng một câu, thứ tự
--      tòa (tên, id) rồi tầng giảm dần, tên phòng, id như hermes_sale_listing_payload_v1.
--      Không ảnh/sơ đồ/ghi chú nội bộ; chữ dài cắt left(n+1) để JS cắt 240/80 cho cùng kết quả.
-- Không đổi hàm cũ (hermes_sale_listing_rooms_v1, hermes_room_scope_map_v1, hàm nhóm/lịch).
-- Không ghi dữ liệu. Connector bật bằng cờ roomRead='page' (mặc định legacy).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
DECLARE p record; signature text;
BEGIN
  FOREACH signature IN ARRAY ARRAY['app_private.room_sale_workflow_fact_v1(uuid,uuid,text,boolean,integer)',
    'app_private.hermes_metadata_member_v1(uuid,uuid)',
    'app_private.hermes_metadata_domain_grant_v1(uuid,text,boolean,jsonb)',
    'public.get_authorization_context_v1(uuid)',
    'app_private.hermes_effective_org_policy_v1(uuid,text[],text[],uuid[])'] LOOP
    SELECT * INTO p FROM pg_proc WHERE oid=to_regprocedure(signature);
    IF NOT FOUND OR NOT p.prosecdef OR p.provolatile<>'s' OR pg_get_userbyid(p.proowner)<>'postgres'
      THEN RAISE EXCEPTION 'hermes_rooms_page_dependency_invalid: %',signature; END IF;
  END LOOP;
  IF to_regprocedure('public.get_public_available_rooms(text)') IS NULL
    THEN RAISE EXCEPTION 'hermes_rooms_page_dependency_invalid: public.get_public_available_rooms(text)'; END IF;
END $requires$;

-- 1. Nhận kết nối + tập tòa cho một khóa, không embed. Khối giữa hai dòng chú thích
-- "fork FAST" chép nguyên văn từ hermes_domain_read_scope_fast_v1 (chỉ đổi tên lỗi);
-- infra/hermes-broker/available-rooms-page-parity.test.mjs so từng dòng với bản FAST.
CREATE OR REPLACE FUNCTION app_private.hermes_room_page_admission_v1(p_binding jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; s app_private.hermes_sessions; t app_private.hermes_connection_tokens;
  a app_private.hermes_assistants; policy app_private.hermes_org_policies;
  member jsonb; context jsonb; permission text:='rooms.view'; enabled boolean;
  selected uuid[]; buildings uuid[]; grant_state jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' OR auth.uid() IS NULL
    THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.hermes_request_v1(p_binding,ARRAY['connectionId','tokenDigest','expectedEpoch','expectedSessionRevision']);
  PERFORM app_private.hermes_uuid_v1(p_binding->'connectionId');
  IF jsonb_typeof(p_binding->'tokenDigest') IS DISTINCT FROM 'string' OR (p_binding->>'tokenDigest') !~ '^[a-f0-9]{64}$'
    OR app_private.hermes_integer_v1(p_binding->'expectedEpoch')<1 OR app_private.hermes_integer_v1(p_binding->'expectedSessionRevision')<1
    THEN RAISE EXCEPTION 'hermes_rooms_page_invalid' USING ERRCODE='22023'; END IF;
  -- fork FAST: begin (hermes_domain_read_scope_fast_v1, một ảnh chụp câu lệnh nhận lượt đọc)
  SELECT * INTO t FROM app_private.hermes_connection_tokens WHERE token_digest=p_binding->>'tokenDigest';
  SELECT * INTO c FROM app_private.hermes_connections WHERE id=t.connection_id;
  SELECT * INTO s FROM app_private.hermes_sessions WHERE id=c.credential_ref;
  SELECT * INTO a FROM app_private.hermes_assistants WHERE id=c.assistant_id;
  IF c.id IS NULL OR s.id IS NULL OR t.token_digest IS NULL OR a.id IS NULL
    OR c.id::text IS DISTINCT FROM p_binding->>'connectionId' OR c.user_id IS DISTINCT FROM auth.uid()
    OR c.state<>'ACTIVE' OR c.revoked_at IS NOT NULL OR a.state<>'ACTIVE'
    OR s.state<>'ACTIVE' OR s.quarantine_reason IS NOT NULL OR s.expires_at<=now()
    OR s.user_id IS DISTINCT FROM c.user_id OR s.organization_id IS DISTINCT FROM c.organization_id OR s.assistant_id IS DISTINCT FROM c.assistant_id
    OR s.provider_session_id::text IS DISTINCT FROM auth.jwt()->>'session_id'
    OR t.revoked_at IS NOT NULL OR t.expires_at<=now() OR t.created_at>now() OR t.created_at+interval '30 days'<=now()
    THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  IF c.epoch::text IS DISTINCT FROM p_binding->>'expectedEpoch' OR s.revision::text IS DISTINCT FROM p_binding->>'expectedSessionRevision'
    THEN RAISE EXCEPTION 'hermes_rooms_page_context_changed' USING ERRCODE='PT409'; END IF;
  member:=app_private.hermes_metadata_member_v1(c.user_id,c.organization_id);
  IF app_private.is_actor_offboarded_v1() THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  context:=public.get_authorization_context_v1(c.organization_id);
  IF context->>'organizationId' IS DISTINCT FROM c.organization_id::text OR context->'isOffboarded' IS DISTINCT FROM 'false'::jsonb
    OR context->>'membershipId' IS DISTINCT FROM member->>'membershipId'
    OR context->>'authorizationVersion' IS DISTINCT FROM member->>'authorizationVersion'
    THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT COALESCE(array_agg(id ORDER BY id),'{}'::uuid[]) INTO selected FROM (
    SELECT unnest(c.scope_ids) id INTERSECT SELECT unnest(policy.scope_ids) id) intersection;
  -- fork FAST: end
  -- Một khóa duy nhất, cùng vị từ cấp khóa và giao phạm vi trợ lý như vòng FOREACH của FAST.
  enabled:=COALESCE(policy.enabled,false) AND permission=ANY(policy.read_capabilities) AND permission=ANY(c.read_capabilities)
    AND NOT(permission=ANY(c.excluded_read)) AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities h WHERE h.capability=permission AND h.mode='read' AND h.enabled);
  grant_state:=app_private.hermes_metadata_domain_grant_v1(c.organization_id,permission,enabled,context);
  SELECT COALESCE(array_agg(b.id ORDER BY b.id),'{}'::uuid[]) INTO buildings FROM public.buildings b
    WHERE b.organization_id=c.organization_id AND b.deleted_at IS NULL AND grant_state->'buildingIds' ? b.id::text
      AND EXISTS(SELECT 1 FROM public.authorization_scopes scope WHERE scope.id=ANY(selected) AND scope.organization_id=c.organization_id
        AND scope.cashbook_id IS NULL AND (scope.scope_type='ORGANIZATION' OR scope.scope_type='BUILDING' AND scope.building_id=b.id
          OR scope.scope_type='AREA' AND EXISTS(SELECT 1 FROM public.area_buildings ab JOIN public.areas ar
            ON ar.id=ab.area_id AND ar.organization_id=ab.organization_id AND ar.deleted_at IS NULL
            WHERE ab.organization_id=c.organization_id AND ab.area_id=scope.area_id AND ab.building_id=b.id)));
  IF grant_state->'allowed' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('organizationId',c.organization_id,'userId',c.user_id,'connectionId',c.id,'permission',permission,
    'buildingIds',to_jsonb(buildings),'cashbookIds','[]'::jsonb);
END $fn$;

-- 2. Trang phòng đã lọc. Chữ ký khớp ^hermes_[a-z0-9_]+_v[1-9][0-9]*$ của transport connector.
CREATE OR REPLACE FUNCTION public.hermes_available_rooms_page_v1(p_binding jsonb,p_organization_id uuid,p_building_ids uuid[] DEFAULT NULL,
  p_building_name text DEFAULT '',p_statuses text[] DEFAULT NULL,p_limit integer DEFAULT 50,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE plan jsonb; v_org uuid; v_scope uuid[]; v_statuses text[]; v_result jsonb;
BEGIN
  plan:=app_private.hermes_room_page_admission_v1(p_binding);
  v_org:=(plan->>'organizationId')::uuid;
  IF p_organization_id IS NULL OR p_organization_id<>v_org THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(array_agg(v::uuid ORDER BY v::uuid),'{}'::uuid[]) INTO v_scope FROM jsonb_array_elements_text(plan->'buildingIds') v;
  -- Tập tòa rỗng là từ chối (kết nối không còn tòa nào), không phải trang rỗng.
  IF cardinality(v_scope)<1 THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 2000
    OR p_building_name IS NULL OR char_length(p_building_name)>120
    OR (p_building_ids IS NOT NULL AND (cardinality(p_building_ids)<1 OR cardinality(p_building_ids)>256 OR array_ndims(p_building_ids)<>1
      OR array_position(p_building_ids,NULL) IS NOT NULL OR cardinality(p_building_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_building_ids) x)))
    OR (p_statuses IS NOT NULL AND (cardinality(p_statuses)<1 OR cardinality(p_statuses)>3 OR array_ndims(p_statuses)<>1
      OR EXISTS(SELECT 1 FROM unnest(p_statuses) x WHERE x IS NULL OR x NOT IN ('free','soon','pass'))
      OR cardinality(p_statuses)<>(SELECT count(DISTINCT x) FROM unnest(p_statuses) x)))
    THEN RAISE EXCEPTION 'hermes_rooms_page_invalid' USING ERRCODE='22023'; END IF;
  IF p_building_ids IS NOT NULL THEN
    -- Chỉ thu hẹp: mọi tòa yêu cầu phải nằm trong tập DB đã suy ra; ngoài tập là từ chối, không cắt bớt âm thầm.
    IF NOT(p_building_ids<@v_scope) THEN RAISE EXCEPTION 'hermes_rooms_page_denied' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(array_agg(x ORDER BY x),'{}'::uuid[]) INTO v_scope FROM unnest(p_building_ids) x;
  END IF;
  v_statuses:=COALESCE(p_statuses,ARRAY['free','soon','pass']);
  -- Chép vị từ chọn trang của public.get_public_available_rooms: chủ có link còn hiệu lực của
  -- công ty (publishedPages = số chủ), tòa thật của chủ đó, cấu hình/hotline theo chủ.
  WITH owners AS MATERIALIZED (
    SELECT t.owner_id FROM public.public_room_share_tokens t
    WHERE t.organization_id=v_org AND t.revoked=false
    GROUP BY t.owner_id
  ),
  cb AS MATERIALIZED (
    SELECT b.id,b.name,b.code,b.user_id AS owner_id,b.public_contact_name,b.public_contact_phone,
      CASE WHEN b.street_address IS NOT NULL AND b.street_address LIKE '%,%' THEN b.street_address
        ELSE concat_ws(', ',NULLIF(b.street_address,''),NULLIF(b.ward,''),NULLIF(b.district,''),NULLIF(b.province,'')) END AS address,
      COALESCE(ps.soon_days,30) AS soon_days,NULLIF(btrim(ps.sale_policy),'') AS page_sale_policy,
      h.name AS page_contact_name,h.phone_number AS page_contact_phone
    FROM public.buildings b
    JOIN owners o ON o.owner_id=b.user_id
    LEFT JOIN public.public_room_settings ps ON ps.owner_id=b.user_id
    LEFT JOIN LATERAL (
      SELECT h.name,h.phone_number FROM public.hotlines h
      WHERE h.user_id=b.user_id AND COALESCE(h.is_active,true)=true AND (ps.hotline_id IS NULL OR h.id=ps.hotline_id)
      ORDER BY (h.id=ps.hotline_id) DESC NULLS LAST,h.created_at LIMIT 1) h ON true
    WHERE b.organization_id=v_org AND b.is_virtual=false AND b.deleted_at IS NULL AND b.id=ANY(v_scope)
      AND (p_building_name='' OR strpos(lower(b.name),lower(p_building_name))>0)
  ),
  facts AS MATERIALIZED (
    SELECT rm.id,rm.building_id,rm.floor,rm.name,rm.code,rm.area,rm.rent_price,rm.deposit_amount,
      COALESCE(rm.amenities,'[]'::jsonb) AS amenities,left(rm.description,241) AS description,left(rm.sale_note,241) AS sale_note,left(rm.room_type,121) AS room_type,
      -- Overlay khách pass đúng chủ và active; contact_manager ⇒ che tên/SĐT khách như trang.
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN left(pl.contact_name,81) END AS pass_contact_name,
      CASE WHEN fact.status_public='pass' AND NOT COALESCE(pl.contact_manager,false) THEN left(pl.contact_phone,81) END AS pass_contact_phone,
      CASE WHEN fact.status_public='pass' THEN left(pl.sale_policy,241) END AS pass_sale_policy,
      CASE WHEN fact.status_public='pass' THEN pl.pass_price END AS pass_price,
      CASE WHEN fact.status_public='pass' AND pl.avail_date>=fact.sale_today THEN pl.avail_date END AS pass_avail_date,
      COALESCE(fact.status_public='pass' AND pl.contact_manager,false) AS pass_contact_manager,
      fact.status_public,fact.sale_state,fact.avail_date,fact.sale_today,fact.expected_ready_on
    FROM public.rooms rm
    JOIN cb ON cb.id=rm.building_id
    LEFT JOIN public.room_pass_listings pl ON pl.room_id=rm.id AND pl.user_id=cb.owner_id AND pl.active=true
    CROSS JOIN LATERAL app_private.room_sale_workflow_fact_v1(rm.id,rm.organization_id,rm.status::text,pl.id IS NOT NULL,cb.soon_days) fact
    WHERE rm.organization_id=v_org AND rm.deleted_at IS NULL
  ),
  listed AS MATERIALIZED (
    SELECT f.*,row_number() OVER (ORDER BY cb.name,cb.id,f.floor DESC NULLS LAST,f.name,f.id) AS rn
    FROM facts f JOIN cb ON cb.id=f.building_id
    WHERE f.status_public IN ('free','soon','pass') AND f.status_public=ANY(v_statuses)
  ),
  total AS (SELECT count(*)::integer AS n FROM listed),
  page AS (SELECT * FROM listed WHERE rn>p_offset AND rn<=p_offset+p_limit),
  rooms_j AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'building_id',p.building_id,'floor',p.floor,'name',p.name,'code',p.code,
      'area',p.area,'rent_price',p.rent_price,'deposit_amount',p.deposit_amount,'amenities',p.amenities,'description',p.description,
      'sale_note',p.sale_note,'room_type',p.room_type,'status_public',p.status_public,'sale_state',p.sale_state,'avail_date',p.avail_date,
      'sale_today',p.sale_today,'expected_ready_on',p.expected_ready_on,'pass_contact_name',p.pass_contact_name,
      'pass_contact_phone',p.pass_contact_phone,'pass_sale_policy',p.pass_sale_policy,'pass_price',p.pass_price,
      'pass_avail_date',p.pass_avail_date,'pass_contact_manager',p.pass_contact_manager) ORDER BY p.rn),'[]'::jsonb) AS j
    FROM page p
  ),
  blds_j AS (
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',cb.id,'name',cb.name,'code',cb.code,'address',left(cb.address,301),
      'public_contact_name',left(cb.public_contact_name,121),'public_contact_phone',left(cb.public_contact_phone,65),
      'page_contact_name',left(cb.page_contact_name,121),'page_contact_phone',left(cb.page_contact_phone,65)) ORDER BY cb.name,cb.id),'[]'::jsonb) AS j
    FROM cb WHERE cb.id IN (SELECT building_id FROM page)
  ),
  policies_j AS (
    SELECT COALESCE(jsonb_agg(x.page_sale_policy ORDER BY x.first_rn),'[]'::jsonb) AS j FROM (
      SELECT cb.page_sale_policy,min(l.rn) AS first_rn FROM listed l JOIN cb ON cb.id=l.building_id
      WHERE cb.page_sale_policy IS NOT NULL GROUP BY cb.page_sale_policy) x
  )
  SELECT jsonb_build_object('publishedPages',(SELECT count(*) FROM owners),'totalCount',(SELECT n FROM total),
    'offset',p_offset,'limit',p_limit,
    'nextOffset',CASE WHEN p_offset+p_limit<(SELECT n FROM total) AND p_offset+p_limit<=2000 THEN p_offset+p_limit END,
    'rooms',(SELECT j FROM rooms_j),'buildings',(SELECT j FROM blds_j),'salePolicies',(SELECT j FROM policies_j)) INTO v_result;
  RETURN jsonb_build_object('authority',jsonb_build_object('organizationId',plan->'organizationId','userId',plan->'userId',
    'connectionId',plan->'connectionId','permission',plan->'permission','buildingIds',plan->'buildingIds','cashbookIds',plan->'cashbookIds'),
    'result',v_result);
END $fn$;

ALTER FUNCTION app_private.hermes_room_page_admission_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_room_page_admission_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) TO authenticated;
COMMENT ON FUNCTION public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer) IS
  'Hermes: một trang phòng trang Sale (free/soon/pass) đã lọc tòa/tên/trạng thái trong SQL; binding kết nối 4 trường, tập tòa do DB suy từ rooms.view và phạm vi trợ lý.';

-- Tự kiểm trước khi commit: đúng quyền, đúng nguồn công thức, đúng tính chất hàm.
DO $assert$
DECLARE p record;
BEGIN
  IF has_function_privilege('anon','public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)','EXECUTE')
    OR has_function_privilege('service_role','public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_room_page_admission_v1(jsonb)','EXECUTE')
    OR has_function_privilege('service_role','app_private.hermes_room_page_admission_v1(jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_room_page_admission_v1(jsonb)','EXECUTE')
    OR has_function_privilege('hermes_store_executor','app_private.hermes_room_page_admission_v1(jsonb)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes rooms page ACL'; END IF;
  FOR p IN SELECT pr.prosecdef,pr.provolatile,pg_get_userbyid(pr.proowner) AS owner,pr.oid::regprocedure::text AS signature FROM pg_proc pr
    WHERE pr.oid IN (to_regprocedure('public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)'),
      to_regprocedure('app_private.hermes_room_page_admission_v1(jsonb)')) LOOP
    IF NOT p.prosecdef OR p.provolatile<>'s' OR p.owner<>'postgres' THEN RAISE EXCEPTION 'hermes rooms page definition: %',p.signature; END IF;
  END LOOP;
  IF position('room_sale_workflow_fact_v1(' IN pg_get_functiondef('public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)'::regprocedure))=0
    OR position('get_public_available_rooms(' IN pg_get_functiondef('public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)'::regprocedure))>0
    OR position('room_sale_workflow_base_fact_v1(' IN pg_get_functiondef('public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)'::regprocedure))>0
    OR position('hermes_room_page_admission_v1(p_binding)' IN pg_get_functiondef('public.hermes_available_rooms_page_v1(jsonb,uuid,uuid[],text,text[],integer,integer)'::regprocedure))=0
    OR position('hermes_metadata_domain_grant_v1(c.organization_id,permission,enabled,context)' IN pg_get_functiondef('app_private.hermes_room_page_admission_v1(jsonb)'::regprocedure))=0
    THEN RAISE EXCEPTION 'hermes rooms page source'; END IF;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
