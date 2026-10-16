-- Hermes đọc ĐÚNG danh sách phòng trang Sale Phòng đang đăng (chủ yêu cầu 16/10/2026).
--
-- Trước: crm_available_rooms / bản tin nhóm / lịch rooms_public_text_v1 đọc phòng theo
-- công ty (copilot_available_rooms_v1, tự lặp sale facts) nên (a) lấy cả toà của chủ dữ liệu
-- khác — toà đó không có trên trang/link chia sẻ — và (b) bỏ phòng khách pass đang hiện.
-- Trang công khai (link chia sẻ) đọc public.get_public_available_rooms(token): toà có
-- buildings.user_id = chủ link, soon_days/khách pass/hotline/chính sách của chủ link.
--
-- Sau: một nguồn duy nhất = trang đó.
--  (1) app_private.hermes_sale_listing_payload_v1(org): với mỗi chủ có link chia sẻ còn
--      hiệu lực của công ty, gọi NGUYÊN public.get_public_available_rooms(token) (không viết
--      lại bộ lọc), giữ toà thuộc công ty, phòng trống/sắp trống/khách pass và allowlist
--      cột trang công khai in (bỏ ảnh/sơ đồ). Token không bao giờ rời hàm.
--  (2) public.hermes_sale_listing_rooms_v1(org): JWT người dùng, cắt theo phạm vi rooms.view
--      hiện hành (copilot_org_scope_buildings_v1, như reader cũ). crm_available_rooms đọc hàm này.
--  (3) Quyết định xem trước/gửi nhóm đọc (2) bằng cùng JWT ⇒ digest khớp trang đã đọc; chọn
--      được phòng khách pass.
--  (4) hermes_group_room_fact_v1 (kiểm lại lúc gửi và lúc worker gửi): nhận phòng khách pass,
--      giá = giá pass, nhãn liên hệ đúng như trang (contact_manager ⇒ "liên hệ admin", không lộ SĐT).
--  (5) Lịch rooms_public_text_v1 chọn phòng từ (1) ∩ toà của lịch.
-- Không đổi chữ ký/kiểu trả về/ACL hàm cũ (CREATE OR REPLACE giữ owner/GRANT); thân hàm cũ
-- chép nguyên bản mới nhất (20261013170125, 20261014000538, 20261015100000), chỉ đổi đoạn
-- nêu trên. Rào quyền, khoá, idempotency và digest giữ nguyên. Không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- 1. Danh sách trang sale đang đăng của một công ty (không kiểm người gọi: chỉ hàm
-- private gọi được; người gọi đã qua JWT + rooms.view ở (2) hoặc worker + lịch ở (5)).
CREATE OR REPLACE FUNCTION app_private.hermes_sale_listing_payload_v1(p_org uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_token text; v_page jsonb; v_pages integer:=0; v_buildings jsonb:='[]'::jsonb; v_rooms jsonb:='[]'::jsonb;
BEGIN
  IF p_org IS NULL THEN RAISE EXCEPTION 'hermes_sale_listing_invalid' USING ERRCODE='22023'; END IF;
  -- Mọi link của một chủ ra cùng một trang (reader chỉ dùng owner_id) ⇒ lấy một link/chủ.
  FOR v_token IN SELECT DISTINCT ON (t.owner_id) t.token FROM public.public_room_share_tokens t
      WHERE t.organization_id=p_org AND t.revoked=false
      ORDER BY t.owner_id,t.created_at,t.token LOOP
    v_page:=public.get_public_available_rooms(v_token);
    IF v_page IS NULL OR jsonb_typeof(v_page->'buildings') IS DISTINCT FROM 'array' OR jsonb_typeof(v_page->'rooms') IS DISTINCT FROM 'array'
      THEN RAISE EXCEPTION 'hermes_sale_listing_unavailable' USING ERRCODE='55000'; END IF;
    v_pages:=v_pages+1;
    v_buildings:=v_buildings||COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',pb->'id','name',pb->'name','code',pb->'code','district',pb->'district','ward',pb->'ward','address',pb->'address',
        'public_contact_name',pb->'public_contact_name','public_contact_phone',pb->'public_contact_phone',
        'public_lift_type',pb->'public_lift_type',
        'page_contact_name',v_page#>'{contact,name}','page_contact_phone',v_page#>'{contact,phone}',
        'page_sale_policy',v_page->'sale_policy'))
      FROM jsonb_array_elements(v_page->'buildings') pb
      WHERE EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pb->>'id')::uuid AND b.organization_id=p_org)),'[]'::jsonb);
    v_rooms:=v_rooms||COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id',pr->'id','building_id',pr->'building_id','floor',pr->'floor','name',pr->'name','code',pr->'code',
        'area',pr->'area','rent_price',pr->'rent_price','deposit_amount',pr->'deposit_amount',
        'amenities',pr->'amenities','description',pr->'description','sale_note',pr->'sale_note','room_type',pr->'room_type',
        'status_public',pr->'status_public','sale_state',pr->'sale_state','avail_date',pr->'avail_date',
        'sale_today',pr->'sale_today','expected_ready_on',pr->'expected_ready_on',
        'pass_contact_name',pr->'pass_contact_name','pass_contact_phone',pr->'pass_contact_phone',
        'pass_sale_policy',pr->'pass_sale_policy','pass_price',pr->'pass_price','pass_avail_date',pr->'pass_avail_date',
        'pass_contact_manager',pr->'pass_contact_manager'))
      FROM jsonb_array_elements(v_page->'rooms') pr
      WHERE pr->>'status_public' IN ('free','soon','pass')
        AND EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=(pr->>'building_id')::uuid AND b.organization_id=p_org)),'[]'::jsonb);
  END LOOP;
  -- Một toà chỉ thuộc một chủ; trùng là dữ liệu bất thường ⇒ dừng, không gộp đoán.
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(v_buildings) x)<>jsonb_array_length(v_buildings)
    OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(v_rooms) x)<>jsonb_array_length(v_rooms)
    THEN RAISE EXCEPTION 'hermes_sale_listing_unavailable' USING ERRCODE='55000'; END IF;
  RETURN jsonb_build_object('pages',v_pages,
    'buildings',COALESCE((SELECT jsonb_agg(x ORDER BY x->>'name',x->>'id') FROM jsonb_array_elements(v_buildings) x),'[]'::jsonb),
    'rooms',COALESCE((SELECT jsonb_agg(x ORDER BY bx->>'name',bx->>'id',(x->>'floor')::numeric DESC NULLS LAST,x->>'name',x->>'id')
      FROM jsonb_array_elements(v_rooms) x JOIN jsonb_array_elements(v_buildings) bx ON bx->>'id'=x->>'building_id'),'[]'::jsonb));
END $fn$;

-- 2. Bản chạy bằng JWT người dùng: cùng danh sách, cắt theo phạm vi rooms.view hiện hành
-- (thành viên còn hiệu lực, toà/khu được giao) như copilot_available_rooms_v1. Trần 2000 phòng.
CREATE OR REPLACE FUNCTION public.hermes_sale_listing_rooms_v1(p_organization_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_buildings uuid[]; v_page jsonb;
BEGIN
  v_buildings:=COALESCE(public.copilot_org_scope_buildings_v1('rooms.view',p_organization_id),'{}'::uuid[]);
  v_page:=app_private.hermes_sale_listing_payload_v1(p_organization_id);
  RETURN jsonb_build_object('pages',v_page->'pages',
    'buildings',COALESCE((SELECT jsonb_agg(x ORDER BY ord) FROM jsonb_array_elements(v_page->'buildings') WITH ORDINALITY e(x,ord)
      WHERE (x->>'id')::uuid=ANY(v_buildings)),'[]'::jsonb),
    'rooms',COALESCE((SELECT jsonb_agg(x ORDER BY ord) FROM (
      SELECT x,ord FROM jsonb_array_elements(v_page->'rooms') WITH ORDINALITY e(x,ord)
      WHERE (x->>'building_id')::uuid=ANY(v_buildings) ORDER BY ord LIMIT 2000) capped),'[]'::jsonb));
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_group_room_fact_v1(p_org uuid,p_room uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.rooms; b public.buildings; f record; v_kind text; v_label text; v_date date; v_soon integer; v_pass boolean;
  pl public.room_pass_listings; v_price numeric; v_who text;
BEGIN
  SELECT * INTO r FROM public.rooms WHERE id=p_room AND organization_id=p_org AND deleted_at IS NULL;
  SELECT * INTO b FROM public.buildings WHERE id=r.building_id AND organization_id=p_org AND deleted_at IS NULL AND NOT is_virtual;
  IF r.id IS NULL OR b.id IS NULL THEN RAISE EXCEPTION 'hermes_group_rooms_changed' USING ERRCODE='PT409'; END IF;
  SELECT soon_days INTO v_soon FROM public.public_room_settings WHERE owner_id=b.user_id
    AND (organization_id=p_org OR organization_id IS NULL) ORDER BY organization_id NULLS LAST LIMIT 1;
  -- One active listing per room (room_pass_listings_room_active_uniq); same owner/active
  -- join as the sale page reader (get_public_available_rooms).
  SELECT * INTO pl FROM public.room_pass_listings WHERE room_id=r.id AND user_id=b.user_id
    AND (organization_id=p_org OR organization_id IS NULL) AND active ORDER BY id LIMIT 1;
  v_pass:=pl.id IS NOT NULL;
  SELECT * INTO f FROM app_private.room_sale_workflow_fact_v1(r.id,p_org,r.status::text,v_pass,COALESCE(v_soon,30));
  IF f.status_public NOT IN ('free','soon','pass') OR f.status_public IS NULL
    OR NULLIF(btrim(COALESCE(r.code,r.name)),'') IS NULL OR NULLIF(btrim(b.name),'') IS NULL
    OR COALESCE(r.area<0 OR r.area>9007199254740991,false) OR COALESCE(r.rent_price<0 OR r.rent_price>9007199254740991,false)
    THEN RAISE EXCEPTION 'hermes_group_rooms_changed' USING ERRCODE='PT409'; END IF;
  v_price:=r.rent_price;
  IF f.status_public='pass' THEN
    -- Sale page: pass price overrides rent; customer contact hidden behind "liên hệ admin"
    -- when contact_manager; otherwise printed as "phone (name)" exactly like the page.
    v_kind:='pass'; v_price:=COALESCE(pl.pass_price,r.rent_price);
    IF COALESCE(pl.pass_price<0 OR pl.pass_price>9007199254740991,false) THEN RAISE EXCEPTION 'hermes_group_rooms_changed' USING ERRCODE='PT409'; END IF;
    IF f.sale_today IS NOT NULL AND pl.avail_date>=f.sale_today THEN v_date:=pl.avail_date; END IF;
    v_who:=concat_ws(' ',NULLIF(pl.contact_phone,''),'('||NULLIF(pl.contact_name,'')||')');
    v_label:=CASE WHEN COALESCE(pl.contact_manager,false) THEN 'Khách pass phòng · Liên hệ admin iHome mở cửa'
      WHEN v_who<>'' THEN 'Khách pass phòng: '||v_who ELSE 'Khách pass phòng' END;
  ELSIF f.status_public='soon' THEN
    IF f.sale_state='NOTICE_OVERDUE' OR f.sale_today IS NULL OR f.avail_date IS NULL OR f.avail_date<f.sale_today THEN
      v_kind:='confirm_notice'; v_label:='Cần xác nhận ngày trống';
    ELSE v_kind:='notice'; v_date:=f.avail_date; v_label:='Sắp trống · '||to_char(v_date,'DD/MM/YYYY'); END IF;
  ELSIF f.sale_state='PREPARING' THEN
    v_kind:='preparing';
    IF f.expected_ready_on IS NULL THEN v_label:='Đang chuẩn bị · chưa có ngày dự kiến';
    ELSIF f.sale_today IS NULL OR f.expected_ready_on<f.sale_today THEN v_label:='Đang chuẩn bị · cần xác nhận ngày sẵn sàng';
    ELSE v_date:=f.expected_ready_on; v_label:='Đang chuẩn bị · dự kiến '||to_char(v_date,'DD/MM/YYYY'); END IF;
  ELSE v_kind:='ready'; v_label:='Trống sẵn'; END IF;
  RETURN jsonb_build_object('roomId',r.id,'buildingId',b.id,'roomLabel',COALESCE(r.code,r.name),'buildingLabel',b.name,
    'areaM2',r.area,'rentVnd',v_price,'status',f.status_public,
    'availability',jsonb_build_object('kind',v_kind,'label',v_label,'availableOn',v_date));
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_group_preview_from_context_v1(p jsonb,p_context jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_base jsonb; v_ctx jsonb; v_auth jsonb; v_recipients jsonb; v_rooms uuid[]; v_groups uuid[];
  v_key text; v_room_payload jsonb; v_room_subset jsonb; v_group_subset jsonb; v_count integer; v_now bigint;
  v_map jsonb; v_scope_ids uuid[]; v_buildings uuid[];
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p)) NOT IN (13,15)
    OR NOT(p ?& ARRAY['roomIds','conversationIds','expectedContextVersion','intentDigest','roomReadDigest'])
    THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  FOREACH v_key IN ARRAY ARRAY['expectedContextVersion','intentDigest','roomReadDigest'] LOOP
    IF jsonb_typeof(p->v_key) IS DISTINCT FROM 'string' OR p->>v_key !~ '^[a-f0-9]{64}$'
      THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  FOREACH v_key IN ARRAY ARRAY['roomIds','conversationIds'] LOOP
    IF jsonb_typeof(p->v_key) IS DISTINCT FROM 'array' OR jsonb_array_length(p->v_key)<1
      OR jsonb_array_length(p->v_key)>(CASE WHEN v_key='roomIds' THEN 20 ELSE 8 END)
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->v_key) j WHERE jsonb_typeof(j)<>'string'
        OR j#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      OR (SELECT count(DISTINCT j) FROM jsonb_array_elements(p->v_key) j)<>jsonb_array_length(p->v_key)
      THEN RAISE EXCEPTION 'hermes_group_invalid' USING ERRCODE='22023'; END IF;
  END LOOP;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_rooms FROM jsonb_array_elements_text(p->'roomIds') j;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_groups FROM jsonb_array_elements_text(p->'conversationIds') j;
  v_base:=p-ARRAY['roomIds','conversationIds','expectedContextVersion','intentDigest','roomReadDigest'];
  v_ctx:=p_context; v_auth:=v_ctx->'authority'; v_recipients:=v_ctx->'recipientRead';
  IF NOT(v_auth#>'{effective,read}' ?& ARRAY['rooms.view','chat_zalo.view'])
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT array_agg(j::uuid ORDER BY j) INTO v_scope_ids FROM jsonb_array_elements_text(v_auth->'scopeIds') j;
  v_map:=public.hermes_room_scope_map_v1((v_auth#>>'{owner,organizationId}')::uuid,v_scope_ids,(p->>'connectionId')::uuid,p->>'tokenDigest',
    (p->>'expectedEpoch')::bigint,(p->>'expectedPolicyVersion')::bigint,
    (p->>'expectedMembershipId')::uuid,(p->>'expectedAuthorizationVersion')::bigint,(p->>'expectedSessionRevision')::bigint);
  -- Scope IDs and concrete building IDs are separate namespaces. Cashbooks
  -- grant no rooms, AREA edges only add permission-intersected buildings.
  SELECT COALESCE(array_agg(DISTINCT id ORDER BY id),'{}'::uuid[]) INTO v_buildings FROM (
    SELECT value::uuid AS id FROM jsonb_array_elements_text(v_map->'permissionBuildingIds') permitted(value)
      WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(v_map->'scopes') scope WHERE scope->>'scopeType'='ORGANIZATION')
    UNION SELECT (scope->>'buildingId')::uuid FROM jsonb_array_elements(v_map->'scopes') scope
      WHERE scope->>'scopeType'='BUILDING' AND v_map->'permissionBuildingIds' ? (scope->>'buildingId')
    UNION SELECT (edge->>'buildingId')::uuid FROM jsonb_array_elements(v_map->'areaBuildings') edge
  ) allowed;
  IF cardinality(v_buildings)<1 THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  v_auth:=jsonb_set(v_auth,'{allowedBuildingIds}',to_jsonb(v_buildings),false);
  IF v_auth->>'contextVersion' IS DISTINCT FROM p->>'expectedContextVersion'
    THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(v_recipients->'conversations') g WHERE (g->>'conversationId')::uuid=ANY(v_groups);
  IF v_count<>cardinality(v_groups) THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  -- Same source as crm_available_rooms: the company's published sale page(s),
  -- read with this caller's JWT and current rooms.view scope. The wrapper already
  -- returns only the page's public allowlist (no media/internal notes); the fixed
  -- adapter reprojects this same-snapshot payload and compares the complete
  -- first-page digest to the already read page before releasing output.
  IF auth.uid() IS NULL OR auth.uid()::text IS DISTINCT FROM v_auth#>>'{owner,userId}'
    THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  v_room_payload:=public.hermes_sale_listing_rooms_v1((v_auth->'owner'->>'organizationId')::uuid);
  IF jsonb_typeof(v_room_payload->'rooms') IS DISTINCT FROM 'array' OR jsonb_typeof(v_room_payload->'buildings') IS DISTINCT FROM 'array'
    OR jsonb_array_length(v_room_payload->'rooms')>=2000 OR jsonb_array_length(v_room_payload->'buildings')>=2000
    THEN RAISE EXCEPTION 'hermes_group_rooms_incomplete' USING ERRCODE='22023'; END IF;
  SELECT count(*) INTO v_count FROM jsonb_array_elements(v_room_payload->'rooms') room
    WHERE (room->>'id')::uuid=ANY(v_rooms) AND room->>'status_public' IN ('free','soon','pass')
      AND v_auth->'allowedBuildingIds' ? (room->>'building_id');
  IF v_count<>cardinality(v_rooms) THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  SELECT jsonb_agg(g ORDER BY g->>'conversationId') INTO v_group_subset FROM jsonb_array_elements(v_recipients->'conversations') g
    WHERE (g->>'conversationId')::uuid=ANY(v_groups);
  v_recipients:=v_recipients||jsonb_build_object('allowedConversationIds',to_jsonb(v_groups),'conversations',v_group_subset);
  v_now:=floor(extract(epoch FROM clock_timestamp())*1000)::bigint;
  IF (v_auth->>'expiresAt')::bigint<=v_now THEN RAISE EXCEPTION 'hermes_group_denied' USING ERRCODE='42501'; END IF;
  RETURN jsonb_build_object('decision',jsonb_build_object('kind','hermes.group-room-preview.v1','outcome','allow',
    'decisionId',p->>'requestId','tokenDigest',p->>'tokenDigest','intentDigest',p->>'intentDigest','roomReadDigest',p->>'roomReadDigest',
    'contextVersion',v_auth->>'contextVersion','checkedAt',v_now,'expiresAt',(v_auth->>'expiresAt')::bigint),
    'authority',v_auth,'recipientRead',v_recipients,'roomPayload',v_room_payload);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_room_schedule_run_v1(p_schedule_id uuid,p_expected_revision bigint,p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; g app_private.hermes_schedule_grants; z public.zalo_conversations;
  context jsonb; binding jsonb; snapshot jsonb; request jsonb; room_ids uuid[]; room public.rooms; building public.buildings;
  fact record; selected uuid; org uuid; today date; local_now timestamp; scheduled timestamp; previous timestamptz;
  dispatch uuid:=gen_random_uuid(); message_id uuid; job_id uuid; queue jsonb; body text; expiry timestamptz;
  soon_days integer; has_pass boolean; count_today integer; v_template text; v_policy boolean; v_denied jsonb;
  v_projection jsonb; v_digest bytea; v_base bytea; v_prior record; v_delivery text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO org FROM app_private.hermes_room_schedules WHERE id=p_schedule_id;
  IF org IS NULL THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(org);
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||org::text,0));
  SELECT * INTO s FROM app_private.hermes_room_schedules WHERE id=p_schedule_id FOR UPDATE;
  SELECT * INTO g FROM app_private.hermes_schedule_grants WHERE id=s.grant_id;
  IF s.state<>'ACTIVE' OR s.revision<>p_expected_revision OR g.expires_at<=clock_timestamp()
    THEN RETURN jsonb_build_object('status','skipped','reason','inactive_or_changed'); END IF;
  v_template:=g.settings->>'template';
  IF v_template IS NULL OR v_template NOT IN ('rooms_public_text_v1','sale_policy_public_text_v1')
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_templates WHERE template=v_template AND enabled)
    THEN RAISE EXCEPTION 'hermes_schedule_template_disabled' USING ERRCODE='42501'; END IF;
  v_policy:=v_template='sale_policy_public_text_v1';
  binding:=app_private.hermes_schedule_binding_v1(g,dispatch);
  context:=app_private.hermes_external_group_context_v1(binding);
  PERFORM app_private.hermes_schedule_scope_v2(g.connection_id,g.settings,context,'[]'::jsonb);
  PERFORM app_private.hermes_schedule_owner_v1(s.id,s.organization_id,g.settings);
  IF NOT EXISTS(SELECT 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  local_now:=clock_timestamp() AT TIME ZONE (g.settings->>'timeZone'); today:=local_now::date;
  scheduled:=today+(g.settings->>'time')::time;
  IF NOT(g.settings->'weekdays' @> to_jsonb(extract(isodow FROM local_now)::integer)) OR local_now<scheduled
    THEN RETURN jsonb_build_object('status','skipped','reason','not_due'); END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(g.settings->'conversationIds') target WHERE NOT EXISTS(
    SELECT 1 FROM app_private.hermes_schedule_runs r WHERE r.schedule_id=s.id AND r.local_date=today AND r.conversation_id::text=target))
    THEN RETURN jsonb_build_object('status','already_run'); END IF;
  SELECT COALESCE(jsonb_agg(target ORDER BY target),'[]'::jsonb) INTO v_denied FROM jsonb_array_elements_text(g.settings->'conversationIds') target
    WHERE NOT(context#>'{recipientRead,allowedConversationIds}' ? target) AND NOT EXISTS(
      SELECT 1 FROM app_private.hermes_schedule_runs r WHERE r.schedule_id=s.id AND r.local_date=today AND r.conversation_id::text=target);
  -- Existing automation catch-up limit is 180 minutes. Close all remaining
  -- recipients for a missed day, never replay a backlog after downtime. A
  -- recipient that was denied keeps that reason on its missed row.
  IF local_now>scheduled+interval '180 minutes' THEN
    INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,reason)
      SELECT s.id,g.id,today,target::uuid,'missed',CASE WHEN v_denied ? target THEN 'target_denied' END
      FROM jsonb_array_elements_text(g.settings->'conversationIds') target
      ON CONFLICT(schedule_id,local_date,conversation_id) DO NOTHING;
    GET DIAGNOSTICS count_today=ROW_COUNT;
    RETURN jsonb_build_object('status','skipped','reason','missed_window','deniedTargets',v_denied,
      'missedAllowed',count_today-jsonb_array_length(v_denied));
  END IF;
  SELECT target::uuid INTO selected FROM jsonb_array_elements_text(g.settings->'conversationIds') target
    WHERE context#>'{recipientRead,allowedConversationIds}' ? target AND NOT EXISTS(
      SELECT 1 FROM app_private.hermes_schedule_runs r WHERE r.schedule_id=s.id AND r.local_date=today AND r.conversation_id::text=target)
    ORDER BY target LIMIT 1;
  IF selected IS NULL THEN RETURN jsonb_build_object('status','skipped','reason','target_denied','conversationIds',v_denied); END IF;
  IF v_policy THEN
    -- Compare with the last projection this recipient is known to have
    -- received. Unknown blocks; failed/not-sent was never delivered.
    v_projection:=app_private.hermes_schedule_policy_projection_v1(org,g.settings);
    v_digest:=sha256(convert_to(v_projection::text,'UTF8'));
    FOR v_prior IN SELECT r.outcome,r.policy_digest,r.dispatch_id FROM app_private.hermes_schedule_runs r
        WHERE r.schedule_id=s.id AND r.conversation_id=selected AND r.outcome IN ('baseline','unchanged','queued')
        ORDER BY r.created_at DESC,r.id DESC LIMIT 60 LOOP
      IF v_prior.outcome<>'queued' THEN v_base:=v_prior.policy_digest; EXIT; END IF;
      v_delivery:=NULL;
      SELECT CASE WHEN q.result#>>'{reconciliation,decision}'='sent' THEN 'sent'
          WHEN q.result#>>'{reconciliation,decision}'='not_sent' THEN 'failed'
          WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown'
          WHEN q.status='sent' THEN 'sent' WHEN q.status='failed' THEN 'failed' ELSE 'pending' END INTO v_delivery
        FROM app_private.hermes_group_jobs j JOIN public.zalo_send_queue q ON q.id=j.job_id WHERE j.dispatch_id=v_prior.dispatch_id;
      IF v_delivery='sent' THEN v_base:=v_prior.policy_digest; EXIT; END IF;
      IF v_delivery='unknown' THEN RETURN jsonb_build_object('status','skipped','reason','delivery_unknown','dispatchId',v_prior.dispatch_id); END IF;
      IF v_delivery IS DISTINCT FROM 'failed' THEN RETURN jsonb_build_object('status','skipped','reason','delivery_pending'); END IF;
    END LOOP;
    IF v_base IS NULL AND v_delivery IS NULL THEN
      INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,policy_digest)
        VALUES(s.id,g.id,today,selected,'baseline',v_digest);
      RETURN jsonb_build_object('status','skipped','reason','baseline','conversationId',selected);
    END IF;
    IF v_base=v_digest THEN
      INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,policy_digest)
        VALUES(s.id,g.id,today,selected,'unchanged',v_digest);
      RETURN jsonb_build_object('status','skipped','reason','unchanged','conversationId',selected);
    END IF;
    IF jsonb_array_length(v_projection->'roomNotes')>(g.settings->>'maxRooms')::integer
      THEN RETURN jsonb_build_object('status','skipped','reason','room_limit'); END IF;
  END IF;
  SELECT max(created_at),count(*) FILTER(WHERE outcome='queued') INTO previous,count_today FROM app_private.hermes_schedule_runs
    WHERE schedule_id=s.id AND local_date=today;
  IF previous>clock_timestamp()-interval '180 seconds' THEN RETURN jsonb_build_object('status','skipped','reason','recipient_spacing'); END IF;
  IF count_today>=(g.settings->>'maxMessagesPerDay')::integer THEN RETURN jsonb_build_object('status','skipped','reason','daily_limit'); END IF;
  IF (SELECT count(*) FROM public.zalo_send_queue WHERE organization_id=org AND status IN ('queued','processing'))>=200
    THEN RETURN jsonb_build_object('status','skipped','reason','queue_capacity'); END IF;
  IF v_policy THEN
    body:=app_private.hermes_schedule_policy_body_v1(v_projection);
    request:=binding||jsonb_build_object('conversationIds',jsonb_build_array(selected),
      'expectedContextVersion',context#>>'{authority,contextVersion}','intentDigest',encode(g.request_digest,'hex'),
      'policyDigest',encode(v_digest,'hex'),'scheduleId',s.id,'grantId',g.id,'scheduleRevision',s.revision);
    snapshot:=app_private.hermes_schedule_current_v1(request);
    IF snapshot#>>'{policy,digest}' IS DISTINCT FROM encode(v_digest,'hex')
      THEN RAISE EXCEPTION 'hermes_group_context_changed' USING ERRCODE='PT409'; END IF;
  ELSE
    -- Fresh public-sale facts from the SAME published sale page(s) crm_available_rooms
    -- reads (vacant, soon-vacant and customer-pass rooms). Do not turn an unexpected
    -- formatter error into an empty report; a selected building that is no longer a
    -- live company building still denies the run as before.
    IF EXISTS(SELECT 1 FROM public.rooms r WHERE r.organization_id=org AND r.deleted_at IS NULL
        AND g.settings->'buildingIds' ? r.building_id::text AND NOT EXISTS(SELECT 1 FROM public.buildings b
          WHERE b.id=r.building_id AND b.organization_id=org AND b.deleted_at IS NULL AND NOT b.is_virtual))
      THEN RAISE EXCEPTION 'hermes_schedule_scope_denied' USING ERRCODE='42501'; END IF;
    SELECT COALESCE(array_agg((listed->>'id')::uuid ORDER BY (listed->>'building_id')::uuid,(listed->>'id')::uuid),'{}'::uuid[]) INTO room_ids
      FROM jsonb_array_elements(app_private.hermes_sale_listing_payload_v1(org)->'rooms') listed
      WHERE g.settings->'buildingIds' ? (listed->>'building_id') AND listed->>'status_public' IN ('free','soon','pass');
    IF cardinality(room_ids)=0 THEN
      INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome) VALUES(s.id,g.id,today,selected,'no_rooms');
      RETURN jsonb_build_object('status','skipped','reason','no_rooms');
    END IF;
    -- Do not silently omit rooms when the user's bounded template is too small.
    IF cardinality(room_ids)>(g.settings->>'maxRooms')::integer THEN RETURN jsonb_build_object('status','skipped','reason','room_limit'); END IF;
    request:=binding||jsonb_build_object('roomIds',to_jsonb(room_ids),'conversationIds',jsonb_build_array(selected),
      'expectedContextVersion',context#>>'{authority,contextVersion}','intentDigest',encode(g.request_digest,'hex'),'roomReadDigest',repeat('0',64),
      'scheduleId',s.id,'grantId',g.id,'scheduleRevision',s.revision);
    snapshot:=app_private.hermes_schedule_current_v1(request);
    SELECT 'BẢN TIN PHÒNG TRỐNG'||E'\n'||string_agg(ord::text||'. '||(f->>'buildingLabel')||' · '||(f->>'roomLabel')||' | '||
      regexp_replace(regexp_replace(app_private.hermes_group_number_vi_v1((f->>'areaM2')::numeric),',00$',''),'(,[0-9])0$','\1')||' m² | '||
      regexp_replace(regexp_replace(app_private.hermes_group_number_vi_v1((f->>'rentVnd')::numeric),',00$',''),'(,[0-9])0$','\1')||' đ/tháng | '||
      (f#>>'{availability,label}'),E'\n' ORDER BY ord) INTO body FROM jsonb_array_elements(snapshot->'publicFacts') WITH ORDINALITY entry(f,ord);
  END IF;
  -- The dispatch ledger accepts at most 8192 bytes; report it, never truncate.
  IF body IS NULL OR octet_length(body)>8192 THEN RAISE EXCEPTION 'hermes_schedule_message_invalid' USING ERRCODE='22023'; END IF;
  expiry:=LEAST(g.expires_at,clock_timestamp()+interval '5 minutes',
    (SELECT expires_at FROM app_private.hermes_connection_tokens WHERE token_digest=binding->>'tokenDigest'),
    (SELECT expires_at FROM app_private.hermes_sessions WHERE id=(SELECT credential_ref FROM app_private.hermes_connections WHERE id=g.connection_id)));
  INSERT INTO app_private.hermes_group_dispatches(id,user_id,organization_id,command_id,origin,request_id,request,snapshot,body,payload_digest,expires_at)
    VALUES(dispatch,g.user_id,org,NULL,'standing_grant',dispatch,request,snapshot,body,
      sha256(convert_to(jsonb_build_object('request',request,'snapshot',snapshot,'body',body)::text,'UTF8')),expiry);
  SELECT * INTO z FROM public.zalo_conversations WHERE id=selected;
  message_id:=gen_random_uuid(); job_id:=gen_random_uuid();
  INSERT INTO public.zalo_messages(id,user_id,organization_id,conversation_id,account_id,direction,msg_type,body,status,sent_by,sent_at,client_dedup_key)
    VALUES(message_id,z.user_id,org,z.id,z.account_id,'out','text',body,'pending',g.user_id,clock_timestamp(),'hermes-group:'||dispatch||':'||z.id);
  queue:=jsonb_build_object('id',job_id,'user_id',z.user_id,'organization_id',org,'account_id',z.account_id,
    'conversation_id',z.id,'message_id',message_id,'channel','personal','payload',jsonb_build_object('type','text','body',body));
  INSERT INTO app_private.hermes_group_jobs(job_id,dispatch_id,conversation_id,queue_snapshot) VALUES(job_id,dispatch,z.id,queue);
  INSERT INTO public.zalo_send_queue(id,user_id,organization_id,conversation_id,account_id,message_id,channel,payload,status,hermes_group_dispatch_id)
    VALUES(job_id,z.user_id,org,z.id,z.account_id,message_id,'personal',jsonb_build_object('type','text','body',body),'queued',dispatch);
  UPDATE public.zalo_conversations SET last_message_text=body,last_message_at=clock_timestamp(),last_message_dir='out',updated_at=clock_timestamp() WHERE id=z.id;
  INSERT INTO app_private.hermes_schedule_runs(schedule_id,grant_id,local_date,conversation_id,outcome,dispatch_id,policy_digest)
    VALUES(s.id,g.id,today,z.id,'queued',dispatch,CASE WHEN v_policy THEN v_digest END);
  RETURN jsonb_build_object('status','queued','dispatchId',dispatch,'conversationId',z.id);
END $fn$;

ALTER FUNCTION app_private.hermes_sale_listing_payload_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_sale_listing_payload_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_sale_listing_rooms_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_sale_listing_rooms_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_sale_listing_rooms_v1(uuid) TO authenticated;
COMMENT ON FUNCTION public.hermes_sale_listing_rooms_v1(uuid) IS
  'Hermes: phòng trang Sale Phòng/link chia sẻ của công ty đang đăng (get_public_available_rooms), cắt theo rooms.view của người gọi.';

-- Tự kiểm trước khi commit: đúng nguồn, đúng quyền.
DO $assert$
BEGIN
  IF has_function_privilege('anon','public.hermes_sale_listing_rooms_v1(uuid)','EXECUTE')
    OR has_function_privilege('service_role','public.hermes_sale_listing_rooms_v1(uuid)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.hermes_sale_listing_rooms_v1(uuid)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_sale_listing_payload_v1(uuid)','EXECUTE')
    OR has_function_privilege('service_role','app_private.hermes_sale_listing_payload_v1(uuid)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_group_room_fact_v1(uuid,uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes sale listing ACL'; END IF;
  IF position('get_public_available_rooms(v_token)' IN pg_get_functiondef('app_private.hermes_sale_listing_payload_v1(uuid)'::regprocedure))=0
    OR position('hermes_sale_listing_rooms_v1' IN pg_get_functiondef('app_private.hermes_group_preview_from_context_v1(jsonb,jsonb)'::regprocedure))=0
    OR position('copilot_available_rooms_v1' IN pg_get_functiondef('app_private.hermes_group_preview_from_context_v1(jsonb,jsonb)'::regprocedure))>0
    OR position('hermes_sale_listing_payload_v1(org)' IN pg_get_functiondef('public.hermes_room_schedule_run_v1(uuid,bigint,uuid)'::regprocedure))=0
    OR position('room_sale_workflow_fact_v1' IN pg_get_functiondef('public.hermes_room_schedule_run_v1(uuid,bigint,uuid)'::regprocedure))>0
    OR position($q$NOT IN ('free','soon','pass')$q$ IN pg_get_functiondef('app_private.hermes_group_room_fact_v1(uuid,uuid)'::regprocedure))=0
    THEN RAISE EXCEPTION 'hermes sale listing source'; END IF;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
