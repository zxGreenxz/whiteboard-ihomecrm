-- Hermes Đợt 2b — trang Công việc, Mốc 4 (docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 2.1–2.6, 3.2, 21): task.create_batch —
-- giao tối đa 20 việc MỘT lần đồng ý (Q37), cả lô hoặc không gì (CV8). Chỉ file, chưa áp TEST hay production.
-- Cùng vỏ public.hermes_task_action_v1 (BEGIN ATOMIC, gắn OID — không dựng lại). Thay THÂN bốn tầng vỏ gắn, dựng từ thân của
-- 20261022074741 (Mốc 3; md5 ghim ở dưới — thân khác ⇒ dừng, không đè bản vá nào); cùng chữ ký ⇒ OID giữ nguyên. Áp SAU 074741.
--  (1) Dòng chính sách task.create_batch: khoá tasks.create, reversible, chính sách always (luôn xem trước một lần cho cả lô).
--  (2) Lõi giải tên: mỗi mục chạy ĐÚNG luật của task.create (toà/phòng, đoán loại, người nhận, hạn, tiêu đề như web) dưới RLS người
--      hỏi; mục = giá trị chung đè bởi giá trị riêng. buildingsManagedBy thay items: giải người, bước chuẩn bị trải ra mọi toà người đó
--      quản lý trong phạm vi khoá (luật người quản lý toà của Q31: thành viên ACTIVE không phải OWNER có tasks.edit + buildings.view).
--  (3) Chuẩn bị (DEFINER, hàm mới hermes_task_batch_prepare_v1): kiểm từng mục như task.create (toà trong phạm vi, phòng thuộc toà,
--      loại đang bật, người nhận ACTIVE, hạn tương lai), việc trùng đang mở + trùng trong lô, người nhận không quản lý toà ⇒ cảnh báo
--      theo mục; khoá (công ty, toà) theo thứ tự id toà ở lượt ghi; basis nối basis từng mục; hạn mức Q37 cho CẢ lô (vượt ⇒ từ chối
--      ngay ở bản xem trước và kiểm lại ở lượt ghi); mở MỘT biên nhận cho cả lô.
--  (4) Ghi (INVOKER): mọi INSERT trong MỘT khối con dưới RLS + trigger như web; một dòng lỗi ⇒ cả khối lùi.
--  (5) Chốt (DEFINER, hàm mới hermes_task_batch_finish_v1): đối chiếu từng hàng như task.create, sổ hermes_task_jobs, audit
--      HERMES_TASK_CREATED từng việc, chốt biên nhận với danh sách việc.
-- Idempotent; khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('app_private.hermes_task_edit_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_task_edit_finish_v1(jsonb,text,jsonb)') IS NULL
    OR to_regprocedure('app_private.hermes_task_quota_v1(uuid,uuid,uuid[])') IS NULL
    OR to_regprocedure('app_private.hermes_task_when_v1(uuid,timestamptz,boolean)') IS NULL
    OR to_regprocedure('app_private.hermes_task_assignee_member_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.lock_org_for_decision_v1(uuid)') IS NULL
    OR to_regprocedure('public.job_open_duplicates_v1(uuid,uuid,uuid,uuid)') IS NULL
    OR to_regclass('app_private.hermes_task_jobs') IS NULL
    OR NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='task.create' AND capability='tasks.create')
    -- Thân đang chạy phải đúng thân 20261022074741 (hoặc đúng thân của file này khi chạy lại).
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure) NOT IN ('aa23801299885ab5576286ed92ce96a4','c69e78e1d9765ca073f0a5dd89d142d0')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure) NOT IN ('c6f0080b0805fcae40355a4e5d93c3f4','50fab164254d23455ca31d5442ae73f3')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_write_v1(jsonb)'::regprocedure) NOT IN ('9860d1d27c08b06178f1496c65218a43','564705393a88b2ed75911a68e8dff5dd')
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_finish_v1(jsonb,text,jsonb)'::regprocedure) NOT IN ('eda9dde7c93e306e453d1b024aee864f','2a352c005cf388869fa54289fb6e03dc') THEN
    RAISE EXCEPTION 'hermes_task_batch_dependency_invalid'; END IF;
END $requires$;

-- 1. Chính sách thao tác: task.create_batch cùng khoá tasks.create, reversible, LUÔN xem trước (một lần cho cả lô).
INSERT INTO app_private.hermes_action_policies(action,capability,crm_permission,action_class,confirm,private_only)
  VALUES('task.create_batch','tasks.create','tasks.create','reversible','always',true) ON CONFLICT(action) DO NOTHING;

-- 2. Toà một người quản lý (buildingsManagedBy): trong tập toà người hỏi đưa vào (phạm vi khoá ∩ web), toà sống, không ảo, mà người
-- đó có tasks.edit VÀ buildings.view theo quyền hiệu lực — đúng luật người quản lý toà của Q31 (hermes_task_building_managers_v1),
-- kể cả bỏ thành viên OWNER (chủ là người có mọi toà). Chỉ trả id, xếp theo tên toà; người hỏi phải là thành viên ACTIVE.
CREATE OR REPLACE FUNCTION app_private.hermes_task_managed_buildings_v1(p_organization_id uuid,p_person uuid,p_building_ids uuid[])
RETURNS uuid[] LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_ids uuid[];
BEGIN
  IF auth.uid() IS NULL OR p_organization_id IS NULL OR p_person IS NULL OR p_building_ids IS NULL
    OR NOT COALESCE(app_private.hermes_task_assignee_member_v1(auth.uid(),p_organization_id),false) THEN RETURN '{}'::uuid[]; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.organization_memberships om WHERE om.organization_id=p_organization_id AND om.user_id=p_person
      AND om.status='ACTIVE' AND om.revoked_at IS NULL AND om.member_type IS DISTINCT FROM 'OWNER'
      AND (om.valid_from IS NULL OR om.valid_from<=clock_timestamp()) AND (om.valid_to IS NULL OR om.valid_to>clock_timestamp())) THEN
    RETURN '{}'::uuid[]; END IF;
  PERFORM app_private.lock_org_for_decision_v1(p_organization_id);
  SELECT COALESCE(array_agg(b.id ORDER BY b.name,b.id),'{}'::uuid[]) INTO v_ids FROM public.buildings b
    WHERE b.organization_id=p_organization_id AND b.deleted_at IS NULL AND NOT COALESCE(b.is_virtual,false) AND b.id=ANY(p_building_ids)
      AND COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(p_person,p_organization_id,'tasks.edit',b.id,NULL) a),false)
      AND COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(p_person,p_organization_id,'buildings.view',b.id,NULL) a),false);
  RETURN v_ids;
END $fn$;

-- 3. Chuẩn bị của task.create_batch (DEFINER; gọi từ hermes_task_action_prepare_v1). Guard + phát lại theo requestId như task.create;
-- kiểm từng mục như task.create; LUÔN xem trước (chính sách always, kể cả lượt auto); lượt ghi mở MỘT biên nhận cho cả lô.
CREATE OR REPLACE FUNCTION app_private.hermes_task_batch_prepare_v1(p_binding jsonb,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_actor uuid; v_tz text; v_receipt app_private.hermes_action_receipts; v_items jsonb; v jsonb; v_tpl jsonb;
  v_scope uuid[]; v_managed uuid[]; v_person uuid; v_locks uuid[]; v_lock uuid; v_i integer; v_n integer;
  v_building uuid; v_room uuid; v_type uuid; v_assignee uuid; v_deadline timestamptz;
  v_building_name text; v_room_name text; v_type_name text; v_assignee_name text; v_dups jsonb; v_manages boolean; v_org_locked boolean:=false;
  v_bases text[]:='{}'; v_basis text; v_rows jsonb:='[]'::jsonb; v_jobs jsonb:='[]'::jsonb; v_lines text[]:='{}'; v_keys text[]:='{}'; v_key text;
  v_guessed text[]:='{}'; v_noroom text[]:='{}'; v_ambiguous text[]:='{}'; v_dup text[]:='{}'; v_twin text[]:='{}'; v_unmanaged text[]:='{}';
  v_assignees uuid[]:='{}'; v_quota text; v_begin jsonb; v_warnings jsonb:='[]'::jsonb; v_text text; v_who text; v_when text;
BEGIN
  IF p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply') OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR jsonb_typeof(p_resolved->'items') IS DISTINCT FROM 'array'
      OR p_expected_basis IS NULL))
    OR (p_phase<>'apply' AND (p_resolution IS NULL OR jsonb_typeof(p_resolution)<>'object')) THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,'task.create_batch');
  v_org:=(ctx->>'organizationId')::uuid; v_actor:=auth.uid(); v_tz:=app_private.org_timezone_v1(v_org);
  v_scope:=ARRAY(SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid);
  -- requestId đã có biên nhận ⇒ phát lại (hoặc xung đột) TRƯỚC mọi quyết định khác, như task.create.
  IF p_phase<>'preview' THEN
    SELECT * INTO v_receipt FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=v_actor AND r.request_id=p_request_id;
    IF FOUND THEN
      IF v_receipt.connection_id::text IS DISTINCT FROM ctx->>'connectionId' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
      IF v_receipt.action IS DISTINCT FROM 'task.create_batch' OR v_receipt.input->'params' IS DISTINCT FROM p_params THEN
        RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
      IF v_receipt.state='started' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
      RETURN jsonb_build_object('kind','replay','outcome',v_receipt.result);
    END IF;
  END IF;
  IF p_phase='apply' THEN
    v_items:=p_resolved->'items';
  ELSIF p_resolution->>'status'='unresolved' THEN
    RETURN jsonb_strip_nulls(jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',COALESCE(p_resolution->'candidates','[]'::jsonb),'more',COALESCE(p_resolution->'more','false'::jsonb),
      'item',p_resolution->'item'));
  ELSIF p_resolution->>'status'='invalid' AND p_resolution->>'reason' IN ('date_out_of_range','invalid_params','batch_too_large') THEN
    RETURN jsonb_strip_nulls(jsonb_build_object('kind','needs_input','reason',p_resolution->>'reason','item',p_resolution->'item'));
  ELSIF p_resolution->>'status' IS DISTINCT FROM 'resolved' OR p_resolution->'batch' IS DISTINCT FROM 'true'::jsonb
    OR jsonb_typeof(p_resolution->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(p_resolution->'items') NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
  ELSE
    SELECT jsonb_agg(jsonb_build_object('buildingId',x.e#>'{building,id}','roomId',COALESCE(x.e#>'{room,id}','null'::jsonb),
        'roomMissing',x.e->'roomMissing','jobTypeId',x.e#>'{jobType,id}','jobTypeGuessed',x.e->'jobTypeGuessed',
        'assigneeId',COALESCE(x.e#>'{person,id}','null'::jsonb),'assigneeAmbiguous',COALESCE(x.e->'personAmbiguous','false'::jsonb),
        'deadline',x.e->'deadline','deadlineDefaulted',x.e->'deadlineDefaulted','title',x.e->'title','description',x.e->'description',
        'priority',x.e->'priority') ORDER BY x.o)
      INTO v_items FROM jsonb_array_elements(p_resolution->'items') WITH ORDINALITY x(e,o);
    -- Lô không đề xuất người quản lý như Q31 của một việc: mục chưa có người nhận ⇒ hỏi lại (kèm số mục).
    SELECT min(x.o) INTO v_n FROM jsonb_array_elements(v_items) WITH ORDINALITY x(e,o) WHERE jsonb_typeof(x.e->'assigneeId') IS DISTINCT FROM 'string';
    IF v_n IS NOT NULL THEN
      RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field','person','wanted','','why','unspecified',
        'candidates','[]'::jsonb,'more',false,'item',v_n); END IF;
    IF jsonb_typeof(p_resolution->'managedBy')='object' THEN
      -- buildingsManagedBy: trải mẫu (mục duy nhất, không toà) ra mọi toà người đó quản lý trong phạm vi khoá, cả toà, theo tên toà.
      BEGIN v_person:=(p_resolution#>>'{managedBy,id}')::uuid;
      EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END;
      IF jsonb_array_length(v_items)<>1 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
      v_managed:=app_private.hermes_task_managed_buildings_v1(v_org,v_person,v_scope);
      IF cardinality(v_managed)=0 THEN
        RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field','building','wanted','','why','unspecified',
          'candidates','[]'::jsonb,'more',false); END IF;
      IF cardinality(v_managed)>20 THEN RETURN jsonb_build_object('kind','needs_input','reason','batch_too_large'); END IF;
      v_tpl:=v_items->0;
      SELECT jsonb_agg(v_tpl||jsonb_build_object('buildingId',u.b,'roomId',NULL,'roomMissing',false) ORDER BY u.o)
        INTO v_items FROM unnest(v_managed) WITH ORDINALITY u(b,o);
    END IF;
  END IF;
  IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' OR jsonb_array_length(v_items) NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v_n:=jsonb_array_length(v_items);
  -- Lượt có thể ghi: khoá (công ty, toà) TRƯỚC khi tính việc trùng, như task.create; theo thứ tự id toà để hai lô chồng toà không
  -- khoá chéo nhau. Khoá giữ tới hết giao dịch ghi.
  BEGIN
    v_locks:=ARRAY(SELECT DISTINCT (e->>'buildingId')::uuid FROM jsonb_array_elements(v_items) e ORDER BY 1);
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END;
  IF p_phase<>'preview' THEN
    FOREACH v_lock IN ARRAY v_locks LOOP
      IF v_lock IS NOT NULL THEN PERFORM pg_advisory_xact_lock(hashtextextended('hermes_task_dup:'||v_org::text||':'||v_lock::text,0)); END IF;
    END LOOP;
  END IF;
  FOR v_i IN 0..v_n-1 LOOP
    v:=v_items->v_i;
    -- Bản đã giải (lượt 1 hay đưa lại ở lượt 2) phải còn đúng phạm vi hiện tại của khoá.
    BEGIN
      v_building:=(v->>'buildingId')::uuid; v_room:=(v->>'roomId')::uuid; v_type:=(v->>'jobTypeId')::uuid;
      v_assignee:=(v->>'assigneeId')::uuid; v_deadline:=(v->>'deadline')::timestamptz;
    EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
      RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
    END;
    IF v_building IS NULL OR v_type IS NULL OR v_assignee IS NULL OR v_deadline IS NULL
      OR jsonb_typeof(v->'title') IS DISTINCT FROM 'string' OR char_length(v->>'title') NOT BETWEEN 1 AND 200 OR v->>'title' ~ '[\x01-\x1f\x7f]'
      OR jsonb_typeof(v->'description') IS DISTINCT FROM 'string' OR char_length(v->>'description')>4000
      OR v->>'priority' IS NULL OR v->>'priority' NOT IN ('NORMAL','LOW','URGENT') THEN
      RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
    IF NOT (v_building=ANY(v_scope)) THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    SELECT b.name INTO v_building_name FROM public.buildings b WHERE b.id=v_building AND b.organization_id=v_org AND b.deleted_at IS NULL
      AND NOT COALESCE(b.is_virtual,false);
    IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    v_room_name:=NULL;
    IF v_room IS NOT NULL THEN
      SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id=v_room AND r.building_id=v_building AND r.deleted_at IS NULL;
      IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    END IF;
    SELECT j.name INTO v_type_name FROM public.job_types j WHERE j.id=v_type AND j.organization_id=v_org AND COALESCE(j.is_active,true);
    IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
    IF NOT COALESCE(app_private.hermes_task_assignee_member_v1(v_assignee,v_org),false) THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
    IF v_deadline<=clock_timestamp() THEN RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range','item',v_i+1); END IF;
    SELECT p.full_name INTO v_assignee_name FROM public.profiles p WHERE p.id=v_assignee;
    v_dups:=public.job_open_duplicates_v1(v_org,v_building,v_room,v_type);
    v_manages:=true;
    IF v_assignee<>v_actor THEN
      IF NOT v_org_locked THEN PERFORM app_private.lock_org_for_decision_v1(v_org); v_org_locked:=true; END IF;
      v_manages:=COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(v_assignee,v_org,'tasks.edit',v_building,NULL) a),false);
    END IF;
    v_bases:=v_bases||md5(jsonb_build_array('task.create_batch',v_building,v_room,v_type,v_assignee,v_deadline,v->>'title',v->>'description',
      v->>'priority',v_building_name,(SELECT jsonb_agg(e->'id' ORDER BY e->>'id') FROM jsonb_array_elements(v_dups) e),v_manages)::text);
    v_who:=CASE WHEN v_assignee=v_actor THEN 'chính anh/chị' ELSE COALESCE(v_assignee_name,'(không xem được tên)') END;
    IF v->'jobTypeGuessed'='true'::jsonb THEN v_guessed:=v_guessed||format('#%s %s',v_i+1,v_type_name); END IF;
    IF v->'roomMissing'='true'::jsonb THEN v_noroom:=v_noroom||format('#%s',v_i+1); END IF;
    IF v->'assigneeAmbiguous'='true'::jsonb THEN v_ambiguous:=v_ambiguous||format('#%s %s',v_i+1,v_who); END IF;
    IF jsonb_array_length(v_dups)>0 THEN v_dup:=v_dup||format('#%s %s',v_i+1,COALESCE(v_dups->0->>'code','—')); END IF;
    v_key:=v_building::text||'/'||COALESCE(v_room::text,'-')||'/'||v_type::text;
    IF v_key=ANY(v_keys) THEN v_twin:=v_twin||format('#%s',v_i+1); END IF;
    v_keys:=v_keys||v_key;
    IF NOT v_manages AND NOT (format('%s ở toà %s',v_who,v_building_name)=ANY(v_unmanaged)) THEN
      v_unmanaged:=v_unmanaged||format('%s ở toà %s',v_who,v_building_name); END IF;
    v_assignees:=v_assignees||v_assignee;
    v_when:=app_private.hermes_task_when_v1(v_org,v_deadline,v->'deadlineDefaulted'='true'::jsonb);
    v_rows:=v_rows||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('stt',v_i+1,'building',v_building_name,'room',v_room_name,
      'wholeBuilding',v_room IS NULL,'title',v->>'title','jobType',v_type_name,'assignee',v_who,'assigneeSelf',v_assignee=v_actor,
      'deadline',to_char(v_deadline AT TIME ZONE v_tz,'YYYY-MM-DD HH24:MI'),'deadlineText',v_when,'priority',v->>'priority',
      'duplicates',jsonb_array_length(v_dups))));
    v_lines:=v_lines||format('%s) toà %s%s — ''%s'' — giao %s — hạn %s',v_i+1,v_building_name,
      CASE WHEN v_room IS NOT NULL THEN ', phòng '||v_room_name ELSE ', cả toà' END,v->>'title',v_who,v_when);
    v_jobs:=v_jobs||jsonb_build_array(jsonb_build_object('jobId',gen_random_uuid(),'buildingId',v_building,'roomId',v_room,'jobTypeId',v_type,
      'assigneeId',v_assignee,'deadline',v_deadline,'title',v->>'title','description',v->>'description','priority',v->>'priority'));
  END LOOP;
  v_basis:=md5(jsonb_build_array('task.create_batch',v_n,to_jsonb(v_bases))::text);
  IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
  -- Hạn mức (Q37) cho CẢ lô: vượt ⇒ từ chối ngay ở bản xem trước (không hỏi đồng ý một lô sẽ bị chặn); lượt ghi kiểm lại TRƯỚC khi
  -- mở biên nhận (khoá tư vấn theo người hỏi giữ tới hết giao dịch).
  v_quota:=app_private.hermes_task_quota_v1(v_org,v_actor,v_assignees);
  IF v_quota IS NOT NULL THEN RETURN jsonb_build_object('kind','rejected','reason',v_quota); END IF;

  IF p_phase<>'apply' THEN
    IF (SELECT count(DISTINCT jsonb_build_array(e->'title',e->'assignee',e->'deadline',e->'priority')) FROM jsonb_array_elements(v_rows) e)=1 THEN
      v_text:=format('Giao %s việc ''%s'' cho %s, hạn %s%s: %s.',v_n,v_rows->0->>'title',v_rows->0->>'assignee',v_rows->0->>'deadlineText',
        CASE v_rows->0->>'priority' WHEN 'URGENT' THEN ', ưu tiên Gấp' WHEN 'LOW' THEN ', ưu tiên Thấp' ELSE '' END,
        (SELECT string_agg((e->>'building')||CASE WHEN e ? 'room' THEN ' phòng '||(e->>'room') ELSE ' (cả toà)' END,', ' ORDER BY (e->>'stt')::int)
          FROM jsonb_array_elements(v_rows) e));
    ELSE
      v_text:=format('Giao %s việc: %s.',v_n,array_to_string(v_lines,'; '));
    END IF;
    IF cardinality(v_guessed)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Loại việc do bot chọn theo nội dung: '||array_to_string(v_guessed,', ')||' — hỏi lại nếu sai.',300)); END IF;
    IF cardinality(v_noroom)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Chưa nêu phòng ở mục '||array_to_string(v_noroom,', ')||': việc cho CẢ TOÀ.',300)); END IF;
    IF cardinality(v_ambiguous)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Người nhận hiểu theo cách gọi chưa rõ ở mục '||array_to_string(v_ambiguous,', ')
      ||' — nếu là người khác, nêu đủ tên.',300)); END IF;
    IF cardinality(v_dup)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Đã có việc cùng loại đang mở ở chỗ của mục '||array_to_string(v_dup,', ')
      ||' — vẫn tạo thêm?',300)); END IF;
    IF cardinality(v_twin)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Mục '||array_to_string(v_twin,', ')||' trùng chỗ và loại với một mục trước trong lô.',300)); END IF;
    IF cardinality(v_unmanaged)>0 THEN v_warnings:=v_warnings||to_jsonb(left('Không có quyền công việc ở toà (vẫn thấy việc nhưng không sửa/hoàn thành được trên web): '
      ||array_to_string(v_unmanaged,'; ')||'.',300)); END IF;
    RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',jsonb_build_object('items',v_items),'confirm','required','warnings',v_warnings,
      'preview',jsonb_build_object('text',left(v_text,4000),'count',v_n,'items',v_rows));
  END IF;

  -- Lượt ghi: MỘT biên nhận cho cả lô.
  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,'task.create_batch',p_request_id,
    jsonb_build_object('params',p_params,'resolved',jsonb_build_object('items',v_items)));
  IF v_begin->>'state'='replay' THEN RETURN jsonb_build_object('kind','replay','outcome',v_begin->'result'); END IF;
  IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
  IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('kind','write','action','task.create_batch','requestId',p_request_id,'organizationId',v_org,'actorId',v_actor,
    'connectionId',ctx->'connectionId','startedAt',clock_timestamp(),'jobs',v_jobs);
END $fn$;

-- 4. Chốt của task.create_batch (DEFINER; gọi từ hermes_task_action_finish_v1 sau khi ghi xong cả lô): đối chiếu TỪNG hàng vừa ghi
-- như task.create, sổ hermes_task_jobs (đếm hạn mức, "vừa giao"), audit HERMES_TASK_CREATED từng việc, chốt biên nhận với danh sách việc.
CREATE OR REPLACE FUNCTION app_private.hermes_task_batch_finish_v1(p_binding jsonb,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_org uuid; v_tz text; v_e jsonb; v_job public.jobs; v_out jsonb:='[]'::jsonb; v_codes text[]:='{}'; v_building text; v_room text;
  v_assignee text; v_i integer:=0; v_n integer;
BEGIN
  IF p_plan IS NULL OR p_plan->>'kind' IS DISTINCT FROM 'written' OR p_plan->>'action' IS DISTINCT FROM 'task.create_batch'
    OR p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text OR jsonb_typeof(p_plan->'jobs') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_plan->'jobs') NOT BETWEEN 1 AND 20 THEN
    RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  v_org:=(p_plan->>'organizationId')::uuid; v_tz:=app_private.org_timezone_v1(v_org); v_n:=jsonb_array_length(p_plan->'jobs');
  FOR v_e IN SELECT x.e FROM jsonb_array_elements(p_plan->'jobs') WITH ORDINALITY x(e,o) ORDER BY x.o LOOP
    v_i:=v_i+1;
    SELECT * INTO v_job FROM public.jobs WHERE id=(v_e->>'jobId')::uuid FOR SHARE;
    IF NOT FOUND OR v_job.user_id IS DISTINCT FROM auth.uid() OR v_job.organization_id IS DISTINCT FROM v_org
      OR v_job.building_id IS DISTINCT FROM (v_e->>'buildingId')::uuid OR v_job.room_id IS DISTINCT FROM (v_e->>'roomId')::uuid
      OR v_job.job_type_id IS DISTINCT FROM (v_e->>'jobTypeId')::uuid OR v_job.assignee_id IS DISTINCT FROM (v_e->>'assigneeId')::uuid
      OR v_job.assignee_name IS NOT NULL OR v_job.deadline IS DISTINCT FROM (v_e->>'deadline')::timestamptz
      OR v_job.title IS DISTINCT FROM v_e->>'title' OR v_job.description IS DISTINCT FROM v_e->>'description'
      OR v_job.priority IS DISTINCT FROM v_e->>'priority' OR v_job.status IS DISTINCT FROM 'IN_PROGRESS' OR v_job.code IS NULL
      OR v_job.completion_time IS NOT NULL OR v_job.attachments IS NOT NULL THEN
      RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
    INSERT INTO app_private.hermes_task_jobs(job_id,organization_id,actor_id,assignee_id,request_id,action,source)
      VALUES(v_job.id,v_org,v_job.user_id,v_job.assignee_id,(p_plan->>'requestId')::uuid,'task.create_batch','action');
    PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_TASK_CREATED','job',v_job.id,NULL,
      jsonb_build_object('actor',auth.uid(),'connectionId',p_plan->'connectionId','requestId',p_plan->'requestId','jobId',v_job.id,
        'code',v_job.code,'assigneeId',v_job.assignee_id,'action','task.create_batch','item',v_i,'items',v_n),'Hermes shared task create');
    SELECT b.name INTO v_building FROM public.buildings b WHERE b.id=v_job.building_id;
    v_room:=NULL;
    IF v_job.room_id IS NOT NULL THEN SELECT r.name INTO v_room FROM public.rooms r WHERE r.id=v_job.room_id; END IF;
    SELECT p.full_name INTO v_assignee FROM public.profiles p WHERE p.id=v_job.assignee_id;
    v_out:=v_out||jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('jobId',v_job.id,'code',v_job.code,'title',left(v_job.title,80),
      'building',v_building,'room',v_room,'assignee',CASE WHEN v_job.assignee_id=auth.uid() THEN 'chính anh/chị' ELSE v_assignee END,
      'deadline',to_char(v_job.deadline AT TIME ZONE v_tz,'YYYY-MM-DD HH24:MI'))));
    v_codes:=v_codes||format('%s (%s%s)',v_job.code,v_building,CASE WHEN v_room IS NOT NULL THEN ' phòng '||v_room ELSE '' END);
  END LOOP;
  RETURN app_private.hermes_action_receipt_finish_v1(p_binding,'task.create_batch',(p_plan->>'requestId')::uuid,
    jsonb_build_object('kind','applied','link','/tasks','result',jsonb_build_object(
      'text',left(format('Đã tạo %s việc: %s.',v_n,array_to_string(v_codes,', ')),2000),'count',v_n,'jobs',v_out)));
END $fn$;


-- 5. Lõi giải tên (INVOKER, dưới RLS người hỏi; chỉ tham chiếu public.*): thân 074741 + nhánh lô.
CREATE OR REPLACE FUNCTION app_private.hermes_task_resolve_core_v1(p_ctx jsonb,p_action text,p_params jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_org uuid; v_scope uuid[]; v_building text; v_room text; v_type text; v_person text; v_content text; v_whole boolean:=false;
  v_self boolean:=false; v_res jsonb; v_job jsonb; v_who jsonb; v_guessed boolean:=false; v_date date; v_time time; v_deadline timestamptz;
  v_fold text; v_tfold text; v_title text; v_desc text; v_priority text; v_found jsonb; v_best integer; v_more boolean;
  v_pfold text; v_ambiguous boolean:=false; v_jfold text; v_cwords text[]; v_jwords text[]; v_twanted text;
  v_jq text; v_code text; v_hits jsonb; v_hit jsonb; v_closed boolean; v_changes jsonb;
  v_batch boolean:=false; v_common jsonb; v_who_name text; v_managed jsonb; v_items jsonb; v_item jsonb; v_out jsonb:='[]'::jsonb; v_one jsonb;
  v_i integer;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('task.create','task.create_batch','task.update','task.cancel') OR p_ctx IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_action='task.create' AND jsonb_typeof(p_params->'content') IS DISTINCT FROM 'string') THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  v_org:=(p_ctx->>'organizationId')::uuid;
  v_scope:=ARRAY(SELECT jsonb_array_elements_text(p_ctx->'buildingIds')::uuid);

  -- Mốc 3 (task.update / task.cancel): tìm ĐÚNG MỘT việc. Mã đầy đủ (mọi trạng thái); 3–4 số cuối của mã, "vừa giao"/"vừa tạo"
  -- (việc mới nhất người hỏi tạo trong 24 giờ) hoặc tiêu đề bỏ dấu chứa chuỗi — chỉ việc ĐANG MỞ. Chỉ trong việc người hỏi thấy
  -- qua RLS và trong phạm vi toà của khoá; nêu toà/phòng thì lọc thêm. Khớp nhiều ⇒ hỏi lại kèm mã + tiêu đề + phòng + người nhận
  -- (+ toà), KHÔNG BAO GIỜ tự chọn (sự cố huỷ nhầm việc cùng tên ở toà khác 21/10). Chỉ khớp việc đã xong ⇒ 'closed'.
  IF p_action IN ('task.update','task.cancel') THEN
    v_jq:=NULLIF(btrim(regexp_replace(COALESCE(p_params->>'job',''),'\s+',' ','g')),'');
    IF v_jq IS NULL THEN
      RETURN jsonb_build_object('status','unresolved','field','job','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); END IF;
    v_building:=NULLIF(btrim(p_params->>'buildingName'),''); v_room:=NULLIF(btrim(p_params->>'roomName'),'');
    IF v_room IS NOT NULL AND public.hermes_name_fold_v1(v_room) IN ('tn','toa','ca toa','toan toa','toa nha','ca toa nha') THEN v_room:=NULL; END IF;
    IF v_building IS NOT NULL OR v_room IS NOT NULL THEN
      v_res:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_strip_nulls(jsonb_build_object('building',v_building,'room',v_room)));
      IF v_res->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_res; END IF;
    END IF;
    v_jfold:=public.hermes_name_fold_v1(v_jq);
    v_code:=upper(replace(v_jq,' ',''));
    WITH c AS (SELECT j.id,j.code,j.title,j.status,j.building_id,j.room_id,j.assignee_id,j.deadline,j.created_at,j.user_id
        FROM public.jobs j WHERE j.organization_id=v_org AND j.building_id=ANY(v_scope)
          AND (v_res IS NULL OR j.building_id=(v_res#>>'{building,id}')::uuid)
          AND (v_res IS NULL OR jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object' OR j.room_id IS NOT DISTINCT FROM (v_res#>>'{room,id}')::uuid)),
    m AS (SELECT c.*,CASE
        WHEN upper(COALESCE(c.code,''))=v_code THEN 1
        WHEN v_jq ~ '^[0-9]{3,4}$' AND right(COALESCE(c.code,''),4)=lpad(v_jq,4,'0') THEN 2
        WHEN v_jfold IN ('vua giao','vua tao','viec vua giao','viec vua tao','viec moi giao','viec moi tao') AND c.user_id=auth.uid()
          AND c.created_at>clock_timestamp()-interval '24 hours' THEN 3
        WHEN char_length(v_jfold)>=3 AND position(v_jfold IN public.hermes_name_fold_v1(COALESCE(c.title,'')))>0 THEN 4 END AS how FROM c),
    best AS (SELECT min(m.how) h FROM m WHERE m.how=1 OR (m.how IS NOT NULL AND m.status='IN_PROGRESS')),
    hit AS (SELECT m.* FROM m,best WHERE m.how=best.h AND (m.how=1 OR m.status='IN_PROGRESS')
        AND (m.how<>3 OR m.created_at=(SELECT max(x.created_at) FROM m x WHERE x.how=3 AND x.status='IN_PROGRESS')))
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('id',hit.id,'code',hit.code,'title',hit.title,'status',hit.status,'buildingId',hit.building_id,
          'roomId',hit.room_id,'assigneeId',hit.assignee_id,'deadline',hit.deadline,'how',hit.how) ORDER BY hit.created_at DESC,hit.id) FROM hit),'[]'::jsonb),
      COALESCE((SELECT bool_or(m.status IS DISTINCT FROM 'IN_PROGRESS') FROM m WHERE m.how IS NOT NULL),false)
      INTO v_hits,v_closed;
    IF jsonb_array_length(v_hits)=0 THEN
      IF v_closed THEN RETURN jsonb_build_object('status','closed'); END IF;
      RETURN jsonb_build_object('status','unresolved','field','job','wanted',left(v_jq,120),'why','not_visible','candidates','[]'::jsonb,'more',false);
    ELSIF jsonb_array_length(v_hits)>1 THEN
      RETURN jsonb_build_object('status','unresolved','field','job','wanted',left(v_jq,120),'why','ambiguous',
        'candidates',(SELECT COALESCE(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('name',left(format('%s · %s (%s, %s)',COALESCE(e->>'code','—'),left(e->>'title',60),
              COALESCE((SELECT r.name FROM public.rooms r WHERE r.id=(e->>'roomId')::uuid),'cả toà'),
              COALESCE((SELECT p.full_name FROM public.profiles p WHERE p.id=(e->>'assigneeId')::uuid),'chưa giao')),120),
            'buildingName',(SELECT left(b.name,120) FROM public.buildings b WHERE b.id=(e->>'buildingId')::uuid))) ORDER BY ord),'[]'::jsonb)
          FROM jsonb_array_elements(v_hits) WITH ORDINALITY y(e,ord) WHERE ord<=8),
        'more',jsonb_array_length(v_hits)>8);
    END IF;
    v_hit:=v_hits->0;
    IF v_hit->>'status' IS DISTINCT FROM 'IN_PROGRESS' THEN RETURN jsonb_build_object('status','closed','jobId',v_hit->'id'); END IF;
    IF p_action='task.cancel' THEN RETURN jsonb_build_object('status','resolved','job',v_hit,'personMissing',false); END IF;
    -- task.update: ít nhất một thay đổi. Người nhận mới theo đúng luật của task.create (token tự xưng rõ ràng ⇒ chính mình; mình/anh/
    -- chị/em/tên chính mình ⇒ giải tên + cờ mơ hồ). Hạn: ngày/giờ thô — bước chuẩn bị (DEFINER) tính theo múi giờ công ty.
    v_changes:='{}'::jsonb;
    IF NULLIF(btrim(p_params->>'note'),'') IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('note',left(btrim(p_params->>'note'),1000)); END IF;
    IF NULLIF(btrim(p_params->>'content'),'') IS NOT NULL THEN
      v_changes:=v_changes||jsonb_build_object('title',left(btrim(regexp_replace(p_params->>'content','\s+',' ','g')),200)); END IF;
    IF NULLIF(btrim(p_params->>'description'),'') IS NOT NULL THEN v_changes:=v_changes||jsonb_build_object('description',left(btrim(p_params->>'description'),4000)); END IF;
    IF NULLIF(p_params->>'priority','') IS NOT NULL THEN
      IF p_params->>'priority' NOT IN ('NORMAL','LOW','URGENT') THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('priority',p_params->>'priority');
    END IF;
    IF jsonb_typeof(p_params->'deadline')='string' THEN
      IF p_params->>'deadline' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('deadlineDate',p_params->>'deadline');
    END IF;
    IF jsonb_typeof(p_params->'deadlineTime')='string' THEN
      IF p_params->>'deadlineTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_changes:=v_changes||jsonb_build_object('deadlineTime',p_params->>'deadlineTime');
    END IF;
    v_person:=NULLIF(btrim(p_params->>'assigneeName'),'');
    IF v_person IS NOT NULL THEN
      v_pfold:=public.hermes_name_fold_v1(v_person);
      IF v_pfold IN ('toi','tui','self','me','chinh minh','chinh toi','ban than') THEN
        v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
      ELSE
        IF v_pfold IN ('minh','anh','chi','em') THEN v_ambiguous:=true; END IF;
        v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
        IF v_who->>'status'='resolved' THEN
          v_who:=v_who->'person';
          IF v_who->>'id'=auth.uid()::text THEN v_ambiguous:=true; END IF;
        ELSIF v_ambiguous AND v_who->>'why'='not_visible' THEN
          v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
        ELSE RETURN v_who;
        END IF;
      END IF;
      v_changes:=v_changes||jsonb_build_object('assignee',v_who,'assigneeAmbiguous',v_ambiguous,
        'assigneeWanted',CASE WHEN v_ambiguous THEN left(v_person,40) END);
    END IF;
    IF v_changes='{}'::jsonb THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
    RETURN jsonb_build_object('status','resolved','job',v_hit,'changes',jsonb_strip_nulls(v_changes),'personMissing',false);
  END IF;
  -- Mốc 4 (task.create_batch): mỗi mục chạy ĐÚNG luật của task.create ở dưới (giải tên, đoán loại, người nhận, hạn, tiêu đề) dưới RLS
  -- người hỏi. Mục = giá trị chung (buildingName, jobType, content, description, assigneeName, deadline, deadlineTime, priority) đè bởi giá
  -- trị riêng của mục ("toà X, mỗi phòng một việc" chỉ nêu toà một lần); chuỗi trống = không nêu. buildingsManagedBy thay items: chỉ giải người ở đây và MỘT mẫu không toà (người nhận trống =
  -- chính người đó); bước chuẩn bị (DEFINER) trải mẫu ra mọi toà người đó quản lý trong phạm vi khoá. Mục đầu tiên chưa giải được
  -- ⇒ trả kết quả đó kèm số mục (item, đếm từ 1).
  v_batch:=p_action='task.create_batch';
  IF v_batch THEN
    v_common:=(SELECT COALESCE(jsonb_object_agg(e.key,e.value),'{}'::jsonb) FROM jsonb_each(p_params) e
      WHERE e.key IN ('buildingName','jobType','content','description','assigneeName','deadline','deadlineTime','priority')
        AND jsonb_typeof(e.value)<>'null' AND NOT (jsonb_typeof(e.value)='string' AND btrim(e.value#>>'{}')=''));
    v_who_name:=NULLIF(btrim(COALESCE(p_params->>'buildingsManagedBy','')),'');
    IF (jsonb_typeof(p_params->'items') IS NOT DISTINCT FROM 'array') = (v_who_name IS NOT NULL) THEN
      RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
    IF v_who_name IS NULL THEN
      IF jsonb_array_length(p_params->'items')=0 THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      IF jsonb_array_length(p_params->'items')>20 THEN RETURN jsonb_build_object('status','invalid','reason','batch_too_large'); END IF;
      SELECT jsonb_agg(v_common||COALESCE((SELECT jsonb_object_agg(f.key,f.value)
          FROM jsonb_each(CASE WHEN jsonb_typeof(x.e)='object' THEN x.e ELSE '{}'::jsonb END) f
          WHERE f.key IN ('buildingName','roomName','jobType','content','description','assigneeName','deadline','deadlineTime','priority')
            AND jsonb_typeof(f.value)<>'null' AND NOT (jsonb_typeof(f.value)='string' AND btrim(f.value#>>'{}')='')),'{}'::jsonb) ORDER BY x.ord)
        INTO v_items FROM jsonb_array_elements(p_params->'items') WITH ORDINALITY x(e,ord);
    ELSE
      -- buildingsManagedBy = mọi toà người đó quản lý: nêu thêm một toà là mâu thuẫn ⇒ invalid_params (không lặng lẽ bỏ).
      IF v_common ? 'buildingName' THEN RETURN jsonb_build_object('status','invalid','reason','invalid_params'); END IF;
      v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_who_name));
      IF v_who->>'status' IS DISTINCT FROM 'resolved' THEN RETURN v_who; END IF;
      v_managed:=v_who->'person';
      v_items:=jsonb_build_array(v_common||jsonb_build_object('_template',true)
        ||CASE WHEN v_common ? 'assigneeName' THEN '{}'::jsonb ELSE jsonb_build_object('_assignee',v_managed) END);
    END IF;
  ELSE
    v_items:=jsonb_build_array(p_params);
  END IF;
  FOR v_i IN 0..jsonb_array_length(v_items)-1 LOOP
    v_item:=v_items->v_i;
    v_whole:=false; v_self:=false; v_res:=NULL; v_job:=NULL; v_who:=NULL; v_guessed:=false; v_date:=NULL; v_time:=NULL;
    v_ambiguous:=false; v_twanted:=NULL; v_found:=NULL; v_one:=NULL;
    <<one>>
    BEGIN
      v_building:=NULLIF(btrim(v_item->>'buildingName'),''); v_room:=NULLIF(btrim(v_item->>'roomName'),'');
      v_type:=NULLIF(btrim(v_item->>'jobType'),''); v_person:=NULLIF(btrim(v_item->>'assigneeName'),'');
      v_content:=btrim(regexp_replace(v_item->>'content','\s+',' ','g'));
      IF COALESCE(v_content,'')='' THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
      IF v_room IS NOT NULL AND public.hermes_name_fold_v1(v_room) IN ('tn','toa','ca toa','toan toa','toa nha','ca toa nha') THEN
        v_room:=NULL; v_whole:=true; END IF;
      IF v_item ? '_template' THEN
        v_res:=jsonb_build_object('status','resolved'); v_room:=NULL; v_whole:=true;
      ELSE
      IF v_building IS NULL AND v_room IS NULL THEN
        v_one:=jsonb_build_object('status','unresolved','field','building','wanted','','why','unspecified','candidates','[]'::jsonb,'more',false); EXIT one; END IF;
      v_res:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_strip_nulls(jsonb_build_object('building',v_building,'room',v_room)));
      IF v_res->>'status' IS DISTINCT FROM 'resolved' THEN v_one:=v_res; EXIT one; END IF;
      END IF;

      -- Loại việc (Mốc 2c, bot thật trên TEST 22/10): nêu tên khớp đúng một loại ⇒ dùng. Không khớp (mô hình hay tự đặt "Bảo trì",
      -- "Dọn vệ sinh", "kiểm tra điện"…) ⇒ coi như CHƯA nêu và tự suy theo nội dung + chính chuỗi đó, chấm điểm trên các loại đang bật
      -- mà người hỏi thấy được (RLS): 95 chuỗi loại bỏ khoảng trắng trùng tên loại ("ve sinh" ~ "vesinh") > 90 đầu nội dung (như ô gõ
      -- nhanh của web) > 80 chuỗi loại chứa tên loại > 70 đồng nghĩa trong chuỗi loại > 60 nội dung chứa tên loại > 50 đồng nghĩa trong
      -- nội dung; cùng mức thì tên dài hơn thắng. Đúng một loại điểm cao nhất ⇒ dùng + cờ đoán (luôn xem trước). Không suy được hoặc
      -- hoà ⇒ hỏi lại kèm tối đa 5 gợi ý xếp theo độ gần (điểm, rồi tiền tố chung dài nhất với một từ), không chọn bừa. Đồng nghĩa chỉ
      -- trỏ tới tên loại (bỏ dấu, bỏ khoảng trắng) có trong danh mục thật; công ty không có loại đó thì dòng tự bỏ qua.
      IF v_type IS NOT NULL THEN
        v_job:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('jobType',v_type));
        IF v_job->>'status'='resolved' THEN v_job:=v_job->'jobType'; END IF;
      END IF;
      IF v_type IS NULL OR v_job ? 'status' THEN
        -- So theo từ: bỏ dấu (hàm dùng chung) rồi mọi ký tự không phải chữ/số thành một khoảng trắng ("nước," = "nuoc").
        v_fold:=btrim(regexp_replace(public.hermes_name_fold_v1(v_content),'[^a-z0-9]+',' ','g'));
        v_jfold:=CASE WHEN v_type IS NULL THEN '' ELSE btrim(regexp_replace(public.hermes_name_fold_v1(v_type),'[^a-z0-9]+',' ','g')) END;
        v_cwords:=string_to_array(v_fold,' ');
        v_jwords:=CASE WHEN v_jfold='' THEN '{}'::text[] ELSE string_to_array(v_jfold,' ') END;
        WITH syn(p,kc) AS (VALUES ('sua chua','sua'),('sua sang','sua'),('bao tri','sua'),('bao duong','sua'),('khac phuc','sua'),
            ('hu hong','sua'),('bi hu','sua'),('hong','sua'),('lap dat','sua'),('dieu chinh','sua'),
            ('kiem tra','check'),('ra soat','check'),('kiem dinh','check'),('xem xet','check'),
            ('nhan phong','checkin'),('ky hop dong','checkin'),('lam hop dong','checkin'),('dan khach','checkin'),
            ('don dep','vesinh'),('don phong','vesinh'),('don ve sinh','vesinh'),('don rac','vesinh'),('lau chui','vesinh'),('lau don','vesinh'),
            ('quet don','vesinh'),('quet rac','vesinh'),('chui rua','vesinh'),('ve sinh','vesinh'),
            ('don dep','ve'),('don phong','ve'),('don ve sinh','ve'),('lau chui','ve'),('quet don','ve'),('chui rua','ve'),
            ('thay the','thay'),('thay moi','thay'),('doi moi','thay'),
            ('mua sam','mua'),('dat mua','mua'),
            ('giat ui','giat'),('giat say','giat'),('giat giu','giat'),
            ('thong tac','thong'),('thong cong','thong'),('tac nghen','thong'),('bi tac','thong'),('nghet','thong'),
            ('trang tri','decor'),('bai tri','decor'),
            ('tang ca','ot'),('ngoai gio','ot'),('thu tien','ot')),
        t AS (SELECT j.id,j.name,btrim(regexp_replace(public.hermes_name_fold_v1(j.name),'[^a-z0-9]+',' ','g')) k
          FROM public.job_types j WHERE j.organization_id=v_org AND COALESCE(j.is_active,true) AND btrim(COALESCE(j.name,''))<>''),
        u AS (SELECT t.id,t.name,t.k,replace(t.k,' ','') kc FROM t),
        s AS (SELECT u.id,u.name,u.kc,CASE
            WHEN u.kc='' THEN 0
            WHEN v_jfold<>'' AND replace(v_jfold,' ','')=u.kc THEN 95
            WHEN v_fold=u.k OR left(v_fold,char_length(u.k)+1)=u.k||' ' OR v_cwords[1]||COALESCE(v_cwords[2],'')=u.kc
              OR v_cwords[1]||COALESCE(v_cwords[2],'')||COALESCE(v_cwords[3],'')=u.kc THEN 90
            WHEN v_jfold<>'' AND (position(' '||u.k||' ' IN ' '||v_jfold||' ')>0 OR EXISTS(SELECT 1 FROM generate_series(1,cardinality(v_jwords)) i
              WHERE v_jwords[i]||COALESCE(v_jwords[i+1],'')=u.kc OR v_jwords[i]||COALESCE(v_jwords[i+1],'')||COALESCE(v_jwords[i+2],'')=u.kc)) THEN 80
            WHEN v_jfold<>'' AND EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND position(' '||syn.p||' ' IN ' '||v_jfold||' ')>0) THEN 70
            WHEN position(' '||u.k||' ' IN ' '||v_fold||' ')>0 OR EXISTS(SELECT 1 FROM generate_series(1,cardinality(v_cwords)) i
              WHERE v_cwords[i]||COALESCE(v_cwords[i+1],'')=u.kc OR v_cwords[i]||COALESCE(v_cwords[i+1],'')||COALESCE(v_cwords[i+2],'')=u.kc) THEN 60
            WHEN EXISTS(SELECT 1 FROM syn WHERE syn.kc=u.kc AND position(' '||syn.p||' ' IN ' '||v_fold||' ')>0) THEN 50
            ELSE 0 END AS base FROM u),
        r AS (SELECT s.id,s.name,CASE WHEN s.base>0 THEN s.base*100+least(char_length(s.kc),99) ELSE 0 END AS score,
            CASE WHEN s.base>0 THEN s.base*100+least(char_length(s.kc),99) ELSE
              (SELECT COALESCE(max(n),0) FROM unnest(v_cwords||v_jwords) w(x),generate_series(2,least(char_length(w.x),char_length(s.kc))) n
                WHERE left(w.x,n)=left(s.kc,n)) END AS rank FROM s)
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'name',r.name,'score',r.score) ORDER BY r.rank DESC,r.name,r.id),'[]'::jsonb)
          INTO v_found FROM r;
        v_best:=COALESCE((v_found->0->>'score')::int,0);
        IF v_best>=5000 AND (jsonb_array_length(v_found)=1 OR (v_found->1->>'score')::int<v_best) THEN
          v_job:=jsonb_build_object('id',v_found->0->'id','name',v_found->0->'name'); v_guessed:=true; v_twanted:=v_type;
        ELSIF jsonb_array_length(v_found)=0 AND v_type IS NOT NULL THEN
          v_one:=v_job; EXIT one;  -- không thấy loại nào (vd thiếu task_types.view): giữ nguyên kết quả hàm giải tên, không gợi ý
        ELSE
          v_one:=jsonb_build_object('status','unresolved','field','jobType','wanted','','why','unspecified',
            'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb)
              FROM jsonb_array_elements(v_found) WITH ORDINALITY y(e,ord) WHERE ord<=5),
            'more',jsonb_array_length(v_found)>5); EXIT one;
        END IF;
      END IF;

      -- Người nhận (review Mốc 2, chặn 1): chỉ từ KHÔNG thể là tên người mới hiểu là chính người hỏi và được ghi thẳng. "mình", "anh",
      -- "chị", "em" có thể là tên (Minh, Anh…) ⇒ qua hàm giải tên (hồ sơ thấy được + thành viên ACTIVE); không thấy ai tên như vậy
      -- thì hiểu là chính người hỏi nhưng cờ mơ hồ ⇒ LUÔN xem trước. Tên giải ra đúng người hỏi cũng tính là mơ hồ. Trống ⇒ Q31.
      IF v_person IS NOT NULL THEN
        v_pfold:=public.hermes_name_fold_v1(v_person);
        IF v_pfold IN ('toi','tui','self','me','chinh minh','chinh toi','ban than') THEN v_self:=true; v_person:=NULL;
        ELSIF v_pfold IN ('minh','anh','chi','em') THEN v_ambiguous:=true; END IF;
      END IF;
      IF v_person IS NOT NULL THEN
        v_who:=public.hermes_write_name_resolve_v1(v_org,v_scope,jsonb_build_object('person',v_person));
        IF v_who->>'status'='resolved' THEN
          v_who:=v_who->'person';
          IF v_who->>'id'=auth.uid()::text THEN v_ambiguous:=true; END IF;
        ELSIF v_ambiguous AND v_who->>'why'='not_visible' THEN
          v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
        ELSE v_one:=v_who; EXIT one;
        END IF;
      ELSIF v_self THEN
        v_who:=jsonb_build_object('id',auth.uid(),'name',(SELECT p.full_name FROM public.profiles p WHERE p.id=auth.uid()));
      ELSIF jsonb_typeof(v_item->'_assignee')='object' THEN
        v_who:=v_item->'_assignee';
      END IF;

      -- Hạn (Q30): trống ⇒ hết ngày mai giờ công ty; đã qua ⇒ hỏi lại.
      IF jsonb_typeof(v_item->'deadline')='string' THEN
        IF v_item->>'deadline' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
        v_date:=(v_item->>'deadline')::date;
      END IF;
      IF jsonb_typeof(v_item->'deadlineTime')='string' THEN
        IF v_item->>'deadlineTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
        v_time:=(v_item->>'deadlineTime')::time;
      END IF;
      v_deadline:=public.job_deadline_v1(v_org,v_date,v_time);
      IF v_deadline IS NULL OR v_deadline<=clock_timestamp() THEN v_one:=jsonb_build_object('status','invalid','reason','date_out_of_range'); EXIT one; END IF;

      -- Tiêu đề như web: "<loại> <nội dung>", bỏ lặp nếu nội dung đã mở đầu bằng tên loại.
      v_fold:=public.hermes_name_fold_v1(v_content); v_tfold:=public.hermes_name_fold_v1(v_job->>'name');
      v_title:=CASE WHEN v_tfold='' OR v_fold=v_tfold OR left(v_fold,char_length(v_tfold)+1)=v_tfold||' ' THEN v_content
        ELSE btrim(v_job->>'name')||' '||v_content END;
      v_title:=left(btrim(regexp_replace(v_title,'\s+',' ','g')),200);
      v_desc:=COALESCE(NULLIF(btrim(v_item->>'description'),''),v_content);
      v_priority:=COALESCE(NULLIF(v_item->>'priority',''),'NORMAL');
      IF v_priority NOT IN ('NORMAL','LOW','URGENT') THEN v_one:=jsonb_build_object('status','invalid','reason','invalid_params'); EXIT one; END IF;
      v_one:=jsonb_build_object('status','resolved','building',v_res->'building','room',v_res->'room',
        'wholeBuilding',v_whole AND v_room IS NULL AND jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object',
        'roomMissing',jsonb_typeof(v_res->'room') IS DISTINCT FROM 'object' AND NOT v_whole,
        'jobType',v_job,'jobTypeGuessed',v_guessed,'jobTypeWanted',left(v_twanted,60),'person',v_who,'personMissing',v_who IS NULL,
        'personAmbiguous',v_ambiguous,'personWanted',CASE WHEN v_ambiguous THEN left(btrim(v_item->>'assigneeName'),40) END,
        'deadline',v_deadline,'deadlineDefaulted',v_date IS NULL,'title',v_title,'description',v_desc,'priority',v_priority); EXIT one;
    END one;
    IF v_one->>'status' IS DISTINCT FROM 'resolved' THEN
      RETURN CASE WHEN v_batch THEN v_one||jsonb_build_object('item',v_i+1) ELSE v_one END;
    END IF;
    v_out:=v_out||jsonb_build_array(v_one);
  END LOOP;
  IF NOT v_batch THEN RETURN v_out->0; END IF;
  RETURN jsonb_strip_nulls(jsonb_build_object('status','resolved','batch',true,'items',v_out,'personMissing',false,'managedBy',v_managed));
END $fn$;

-- 6. Chuẩn bị (DEFINER): rẽ sang hàm riêng cho sửa/huỷ (Mốc 3) và lô (Mốc 4).
CREATE OR REPLACE FUNCTION app_private.hermes_task_action_prepare_v1(p_binding jsonb,p_action text,p_phase text,p_request_id uuid,p_params jsonb,
  p_resolved jsonb,p_expected_basis text,p_resolution jsonb,p_managers jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE ctx jsonb; v_org uuid; v_actor uuid; v jsonb; v_building uuid; v_room uuid; v_type uuid; v_assignee uuid; v_deadline timestamptz;
  v_building_name text; v_room_name text; v_type_name text; v_assignee_name text; v_dups jsonb; v_manages boolean:=true; v_basis text;
  v_confirm boolean; v_warnings jsonb:='[]'::jsonb; v_text text; v_quota text; v_begin jsonb; v_dup jsonb; v_who text; v_place text;
  v_receipt app_private.hermes_action_receipts;
BEGIN
  -- Mốc 3: task.update / task.cancel có bước chuẩn bị riêng (app_private.hermes_task_edit_prepare_v1), cùng guard + biên nhận chung.
  IF p_action IN ('task.update','task.cancel') THEN
    RETURN app_private.hermes_task_edit_prepare_v1(p_binding,p_action,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,p_resolution);
  END IF;
  -- Mốc 4: task.create_batch có bước chuẩn bị riêng (app_private.hermes_task_batch_prepare_v1), cùng guard + biên nhận chung.
  IF p_action='task.create_batch' THEN
    RETURN app_private.hermes_task_batch_prepare_v1(p_binding,p_phase,p_request_id,p_params,p_resolved,p_expected_basis,p_resolution);
  END IF;
  IF p_action IS NULL OR p_action<>'task.create' OR p_phase IS NULL OR p_phase NOT IN ('preview','auto','apply')
    OR p_request_id IS NULL OR p_params IS NULL OR jsonb_typeof(p_params)<>'object'
    OR (p_phase='apply' AND (p_resolved IS NULL OR jsonb_typeof(p_resolved)<>'object' OR p_expected_basis IS NULL))
    OR (p_phase<>'apply' AND (p_resolution IS NULL OR jsonb_typeof(p_resolution)<>'object')) THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  ctx:=app_private.hermes_action_guard_v1(p_binding,p_action);
  v_org:=(ctx->>'organizationId')::uuid; v_actor:=auth.uid();
  -- requestId đã có biên nhận ⇒ phát lại (hoặc xung đột) TRƯỚC mọi quyết định khác: việc vừa tạo bởi chính mã này không được
  -- thành "việc trùng" đòi xem trước lại, và hạn mức không đếm lại.
  IF p_phase<>'preview' THEN
    SELECT * INTO v_receipt FROM app_private.hermes_action_receipts r WHERE r.organization_id=v_org AND r.user_id=v_actor AND r.request_id=p_request_id;
    IF FOUND THEN
      IF v_receipt.connection_id::text IS DISTINCT FROM ctx->>'connectionId' THEN RAISE EXCEPTION 'hermes_action_context_changed' USING ERRCODE='PT409'; END IF;
      IF v_receipt.action IS DISTINCT FROM p_action OR v_receipt.input->'params' IS DISTINCT FROM p_params THEN
        RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
      IF v_receipt.state='started' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
      RETURN jsonb_build_object('kind','replay','outcome',v_receipt.result);
    END IF;
  END IF;
  IF p_phase='apply' THEN
    v:=p_resolved;
  ELSIF p_resolution->>'status'='unresolved' THEN
    RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field',p_resolution->'field','wanted',p_resolution->'wanted',
      'why',p_resolution->'why','candidates',COALESCE(p_resolution->'candidates','[]'::jsonb),'more',COALESCE(p_resolution->'more','false'::jsonb));
  ELSIF p_resolution->>'status'='invalid' AND p_resolution->>'reason' IN ('date_out_of_range','invalid_params') THEN
    RETURN jsonb_build_object('kind','needs_input','reason',p_resolution->>'reason');
  ELSIF p_resolution->>'status' IS DISTINCT FROM 'resolved' THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
  ELSE
    v:=jsonb_build_object('buildingId',p_resolution#>'{building,id}','roomId',COALESCE(p_resolution#>'{room,id}','null'::jsonb),
      'wholeBuilding',p_resolution->'wholeBuilding','roomMissing',p_resolution->'roomMissing',
      'jobTypeId',p_resolution#>'{jobType,id}','jobTypeGuessed',p_resolution->'jobTypeGuessed',
      'jobTypeWanted',COALESCE(p_resolution->'jobTypeWanted','null'::jsonb),
      'assigneeId',COALESCE(p_resolution#>'{person,id}','null'::jsonb),'assigneeSuggested',false,
      'assigneeAmbiguous',COALESCE(p_resolution->'personAmbiguous','false'::jsonb),'assigneeWanted',COALESCE(p_resolution->'personWanted','null'::jsonb),
      'deadline',p_resolution->'deadline','deadlineDefaulted',p_resolution->'deadlineDefaulted',
      'title',p_resolution->'title','description',p_resolution->'description','priority',p_resolution->'priority');
    IF p_resolution->'personMissing'='true'::jsonb THEN
      -- Q31: đúng một người quản lý toà ⇒ đề xuất trong bản xem trước (một câu hỏi); 0 hoặc nhiều ⇒ hỏi kèm danh sách.
      IF jsonb_typeof(p_managers)='array' AND jsonb_array_length(p_managers)=1 THEN
        v:=v||jsonb_build_object('assigneeId',p_managers->0->'id','assigneeSuggested',true);
      ELSE
        RETURN jsonb_build_object('kind','needs_input','reason','name_unresolved','field','person','wanted','','why','unspecified',
          'candidates',(SELECT COALESCE(jsonb_agg(jsonb_build_object('name',e->'name') ORDER BY ord),'[]'::jsonb)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_managers)='array' THEN p_managers ELSE '[]'::jsonb END) WITH ORDINALITY x(e,ord) WHERE ord<=8),
          'more',CASE WHEN jsonb_typeof(p_managers)='array' THEN jsonb_array_length(p_managers)>8 ELSE false END);
      END IF;
    END IF;
  END IF;

  -- Bản đã giải (lượt 1 hay đưa lại ở lượt 2) phải còn đúng phạm vi hiện tại của khoá.
  BEGIN
    v_building:=(v->>'buildingId')::uuid; v_room:=(v->>'roomId')::uuid; v_type:=(v->>'jobTypeId')::uuid;
    v_assignee:=(v->>'assigneeId')::uuid; v_deadline:=(v->>'deadline')::timestamptz;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023';
  END;
  IF v_building IS NULL OR v_type IS NULL OR v_assignee IS NULL OR v_deadline IS NULL
    OR jsonb_typeof(v->'title') IS DISTINCT FROM 'string' OR char_length(v->>'title') NOT BETWEEN 1 AND 200 OR v->>'title' ~ '[\x01-\x1f\x7f]'
    OR jsonb_typeof(v->'description') IS DISTINCT FROM 'string' OR char_length(v->>'description')>4000
    OR v->>'priority' IS NULL OR v->>'priority' NOT IN ('NORMAL','LOW','URGENT') THEN
    RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF NOT (v_building IN (SELECT jsonb_array_elements_text(ctx->'buildingIds')::uuid)) THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  SELECT b.name INTO v_building_name FROM public.buildings b WHERE b.id=v_building AND b.organization_id=v_org AND b.deleted_at IS NULL
    AND NOT COALESCE(b.is_virtual,false);
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  IF v_room IS NOT NULL THEN
    SELECT r.name INTO v_room_name FROM public.rooms r WHERE r.id=v_room AND r.building_id=v_building AND r.deleted_at IS NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  END IF;
  SELECT j.name INTO v_type_name FROM public.job_types j WHERE j.id=v_type AND j.organization_id=v_org AND COALESCE(j.is_active,true);
  IF NOT FOUND THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;
  IF NOT COALESCE(app_private.hermes_task_assignee_member_v1(v_assignee,v_org),false) THEN RETURN jsonb_build_object('kind','rejected','reason','not_allowed'); END IF;
  IF v_deadline<=clock_timestamp() THEN RETURN jsonb_build_object('kind','needs_input','reason','date_out_of_range'); END IF;
  SELECT p.full_name INTO v_assignee_name FROM public.profiles p WHERE p.id=v_assignee;

  -- Lượt có thể ghi (auto/apply): khoá theo (công ty, toà) TRƯỚC khi tính việc trùng (review Mốc 2, mục 4) — hai lời gọi song song
  -- khác requestId không cùng thấy "chưa có việc trùng" rồi cùng tạo; lời gọi sau thấy việc của lời gọi trước (basis lệch hoặc
  -- phải xem trước). Khoá giữ tới hết giao dịch ghi.
  IF p_phase<>'preview' THEN PERFORM pg_advisory_xact_lock(hashtextextended('hermes_task_dup:'||v_org::text||':'||v_building::text,0)); END IF;
  v_dups:=public.job_open_duplicates_v1(v_org,v_building,v_room,v_type);
  IF v_assignee<>v_actor THEN
    PERFORM app_private.lock_org_for_decision_v1(v_org);
    v_manages:=COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(v_assignee,v_org,'tasks.edit',v_building,NULL) a),false);
  END IF;
  v_basis:=md5(jsonb_build_array(p_action,v_building,v_room,v_type,v_assignee,v_deadline,v->>'title',v->>'description',v->>'priority',
    v_building_name,(SELECT jsonb_agg(e->'id' ORDER BY e->>'id') FROM jsonb_array_elements(v_dups) e),v_manages)::text);
  IF p_phase='apply' AND p_expected_basis IS DISTINCT FROM v_basis THEN RETURN jsonb_build_object('kind','rejected','reason','state_changed'); END IF;

  IF p_phase<>'apply' THEN
    v_confirm:=p_phase='preview' OR COALESCE(ctx->>'confirm','always')<>'never' OR v_assignee<>v_actor
      OR v->'jobTypeGuessed'='true'::jsonb OR v->'roomMissing'='true'::jsonb OR jsonb_array_length(v_dups)>0
      OR v->'assigneeSuggested'='true'::jsonb OR v->'assigneeAmbiguous'='true'::jsonb OR NOT v_manages;
    IF v_confirm THEN
      -- Mốc 2c: loại mô hình nêu không khớp ⇒ nói rõ đã tự chọn loại nào thay cho chuỗi đó (để người dùng sửa nếu sai).
      IF v->'jobTypeGuessed'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb(left(CASE WHEN jsonb_typeof(v->'jobTypeWanted')='string'
        THEN format('Không khớp loại việc ''%s''; tự chọn loại ''%s'' theo nội dung — hỏi lại nếu sai.',left(v->>'jobTypeWanted',60),v_type_name)
        ELSE format('Loại việc ''%s'' do bot chọn theo nội dung.',v_type_name) END,300)); END IF;
      IF v->'roomMissing'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb('Chưa nêu phòng: việc cho CẢ TOÀ.'::text); END IF;
      IF v->'assigneeAmbiguous'='true'::jsonb THEN v_warnings:=v_warnings||to_jsonb(left(CASE WHEN v_assignee=v_actor
        THEN format('Hiểu ''%s'' là chính anh/chị; nếu là người khác, nêu đủ tên người đó.',v->>'assigneeWanted')
        ELSE format('Hiểu ''%s'' là người nhận %s; nếu ý là chính anh/chị, nói "giao cho tôi".',v->>'assigneeWanted',COALESCE(v_assignee_name,'(không xem được tên)')) END,300));
      END IF;
      FOR v_dup IN SELECT e FROM jsonb_array_elements(v_dups) e LIMIT 3 LOOP
        v_warnings:=v_warnings||to_jsonb(left(format('Đã có việc %s ''%s'' đang mở ở chỗ này (giao %s, hạn %s) — vẫn tạo thêm?',
          COALESCE(v_dup->>'code','—'),left(v_dup->>'title',80),
          COALESCE((SELECT p.full_name FROM public.profiles p WHERE p.id=(v_dup->>'assigneeId')::uuid),'chưa ai'),
          COALESCE(to_char((v_dup->>'deadline')::timestamptz AT TIME ZONE app_private.org_timezone_v1(v_org),'DD/MM'),'không hạn')),300));
      END LOOP;
      IF NOT v_manages THEN v_warnings:=v_warnings||to_jsonb(left(format('%s không có quyền công việc ở toà %s: vẫn thấy việc nhưng không sửa/hoàn thành được trên web.',
        COALESCE(v_assignee_name,'Người nhận'),v_building_name),300)); END IF;
      v_who:=CASE WHEN v_assignee=v_actor THEN 'chính anh/chị' ELSE COALESCE(v_assignee_name,'(không xem được tên)') END;
      v_place:='toà '||v_building_name||CASE WHEN v_room IS NOT NULL THEN ', phòng '||v_room_name ELSE ', cả toà' END;
      v_text:=CASE WHEN v->'assigneeSuggested'='true'::jsonb
          THEN format('Chưa nêu người nhận — đề xuất giao %s (quản lý toà %s). ',v_who,v_building_name) ELSE '' END
        ||format('Tạo việc ''%s'' (loại %s%s) — %s — giao %s — hạn %s — ưu tiên %s.',v->>'title',v_type_name,
          CASE WHEN v->'jobTypeGuessed'='true'::jsonb THEN ', tự chọn theo nội dung' ELSE '' END,v_place,v_who,
          app_private.hermes_task_when_v1(v_org,v_deadline,v->'deadlineDefaulted'='true'::jsonb),
          CASE v->>'priority' WHEN 'URGENT' THEN 'Gấp' WHEN 'LOW' THEN 'Thấp' ELSE 'Bình thường' END);
      RETURN jsonb_build_object('kind','preview','basis',v_basis,'resolved',v,'confirm','required','warnings',v_warnings,
        'preview',jsonb_strip_nulls(jsonb_build_object('text',v_text,'building',v_building_name,'room',v_room_name,
          'wholeBuilding',v_room IS NULL,'jobType',v_type_name,'jobTypeGuessed',v->'jobTypeGuessed','title',v->>'title',
          'assignee',v_who,'assigneeSelf',v_assignee=v_actor,'assigneeSuggested',v->'assigneeSuggested','assigneeManagesBuilding',v_manages,
          'deadline',to_char(v_deadline AT TIME ZONE app_private.org_timezone_v1(v_org),'YYYY-MM-DD HH24:MI'),
          'deadlineDefaulted',v->'deadlineDefaulted','priority',v->>'priority','duplicates',jsonb_array_length(v_dups))));
    END IF;
  END IF;

  -- Lượt ghi. Hạn mức kiểm TRƯỚC khi mở biên nhận: từ chối trước khi ghi, không chốt (cùng requestId gọi lại sau được).
  v_quota:=app_private.hermes_task_quota_v1(v_org,v_actor,ARRAY[v_assignee]);
  IF v_quota IS NOT NULL THEN RETURN jsonb_build_object('kind','rejected','reason',v_quota); END IF;
  v_begin:=app_private.hermes_action_receipt_begin_v1(p_binding,p_action,p_request_id,jsonb_build_object('params',p_params,'resolved',v));
  IF v_begin->>'state'='replay' THEN RETURN jsonb_build_object('kind','replay','outcome',v_begin->'result'); END IF;
  IF v_begin->>'state'='conflict' THEN RETURN jsonb_build_object('kind','rejected','reason','request_conflict'); END IF;
  IF v_begin->>'state' IS DISTINCT FROM 'new' THEN RAISE EXCEPTION 'hermes_action_outcome_unknown' USING ERRCODE='PT409'; END IF;
  RETURN jsonb_build_object('kind','write','action',p_action,'requestId',p_request_id,'organizationId',v_org,'actorId',v_actor,
    'connectionId',ctx->'connectionId','jobId',gen_random_uuid(),'startedAt',clock_timestamp(),
    'job',jsonb_build_object('buildingId',v_building,'roomId',v_room,'jobTypeId',v_type,'assigneeId',v_assignee,'deadline',v_deadline,
      'title',v->>'title','description',v->>'description','priority',v->>'priority'),
    'deadlineDefaulted',v->'deadlineDefaulted');
END $fn$;

-- 7. Ghi (INVOKER): INSERT (tạo, lô) / UPDATE (sửa) / DELETE (huỷ) dưới RLS như web.
CREATE OR REPLACE FUNCTION app_private.hermes_task_action_write_v1(p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
DECLARE v_job jsonb; v_id uuid; v_constraint text; v_i integer:=0;
BEGIN
  IF p_plan IS NULL OR p_plan->>'kind' IS DISTINCT FROM 'write' THEN RETURN p_plan; END IF;
  IF current_user<>'authenticated' OR auth.uid() IS NULL OR p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  IF p_plan->>'action'='task.create_batch' THEN
    -- Mốc 4 (CV8): cả lô hoặc không gì — mọi INSERT trong MỘT khối con, dưới RLS + trigger như web; một dòng lỗi ⇒ cả khối lùi,
    -- kế hoạch mang write_failed kèm số dòng (item). Lỗi tạm ⇒ RAISE (cả giao dịch lùi, kể cả biên nhận).
    BEGIN
      FOR v_job IN SELECT x.e FROM jsonb_array_elements(p_plan->'jobs') WITH ORDINALITY x(e,o) ORDER BY x.o LOOP
        v_i:=v_i+1;
        INSERT INTO public.jobs(id,user_id,organization_id,title,description,building_id,room_id,job_type_id,priority,assignee_id,assignee_name,deadline,
          status,started_at,visible_to_customer,attachments)
        VALUES((v_job->>'jobId')::uuid,auth.uid(),(p_plan->>'organizationId')::uuid,v_job->>'title',v_job->>'description',(v_job->>'buildingId')::uuid,
          (v_job->>'roomId')::uuid,(v_job->>'jobTypeId')::uuid,v_job->>'priority',(v_job->>'assigneeId')::uuid,NULL,(v_job->>'deadline')::timestamptz,
          'IN_PROGRESS',(p_plan->>'startedAt')::timestamptz,false,NULL) RETURNING id INTO v_id;
        IF v_id IS DISTINCT FROM (v_job->>'jobId')::uuid THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
      END LOOP;
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
      GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
      RETURN p_plan||jsonb_build_object('kind','write_failed','sqlstate',SQLSTATE,'message',left(SQLERRM,200),'constraint',NULLIF(v_constraint,''),'item',v_i);
    END;
    RETURN p_plan||jsonb_build_object('kind','written');
  END IF;
  v_job:=p_plan->'job';
  BEGIN
    IF p_plan->>'action'='task.update' THEN
      -- Mốc 3: chỉ cột có trong kế hoạch; RLS UPDATE jobs (tasks.edit ở toà) + trigger như web. 0 hàng ⇒ RLS chặn.
      UPDATE public.jobs SET title=CASE WHEN v_job ? 'title' THEN v_job->>'title' ELSE title END,
        description=CASE WHEN v_job ? 'description' THEN v_job->>'description' ELSE description END,
        priority=CASE WHEN v_job ? 'priority' THEN v_job->>'priority' ELSE priority END,
        assignee_id=CASE WHEN v_job ? 'assigneeId' THEN (v_job->>'assigneeId')::uuid ELSE assignee_id END,
        deadline=CASE WHEN v_job ? 'deadline' THEN (v_job->>'deadline')::timestamptz ELSE deadline END,
        completion_description=CASE WHEN v_job ? 'note' THEN v_job->>'note' ELSE completion_description END
        WHERE id=(p_plan->>'jobId')::uuid AND status='IN_PROGRESS' RETURNING id INTO v_id;
    ELSIF p_plan->>'action'='task.cancel' THEN
      -- Mốc 3: xoá hẳn như web (RLS DELETE jobs: tasks.delete ở toà). 0 hàng ⇒ RLS chặn.
      DELETE FROM public.jobs WHERE id=(p_plan->>'jobId')::uuid AND status='IN_PROGRESS' RETURNING id INTO v_id;
    ELSE
    INSERT INTO public.jobs(id,user_id,organization_id,title,description,building_id,room_id,job_type_id,priority,assignee_id,assignee_name,deadline,
      status,started_at,visible_to_customer,attachments)
    VALUES((p_plan->>'jobId')::uuid,auth.uid(),(p_plan->>'organizationId')::uuid,v_job->>'title',v_job->>'description',(v_job->>'buildingId')::uuid,
      (v_job->>'roomId')::uuid,(v_job->>'jobTypeId')::uuid,v_job->>'priority',(v_job->>'assigneeId')::uuid,NULL,(v_job->>'deadline')::timestamptz,
      'IN_PROGRESS',(p_plan->>'startedAt')::timestamptz,false,NULL) RETURNING id INTO v_id;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE IN ('40001','40P01','55P03','PT409') THEN RAISE; END IF;
    GET STACKED DIAGNOSTICS v_constraint=CONSTRAINT_NAME;
    RETURN p_plan||jsonb_build_object('kind','write_failed','sqlstate',SQLSTATE,'message',left(SQLERRM,200),'constraint',NULLIF(v_constraint,''));
  END;
  IF v_id IS NULL AND p_plan->>'action' IN ('task.update','task.cancel') THEN
    RETURN p_plan||jsonb_build_object('kind','write_failed','sqlstate','42501','message','row_level_security','constraint',NULL); END IF;
  IF v_id IS DISTINCT FROM (p_plan->>'jobId')::uuid THEN RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  RETURN p_plan||jsonb_build_object('kind','written');
END $fn$;

-- 8. Chốt (DEFINER): rẽ sang hàm riêng cho sửa/huỷ và lô.
CREATE OR REPLACE FUNCTION app_private.hermes_task_action_finish_v1(p_binding jsonb,p_action text,p_plan jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_job public.jobs; v_plan jsonb:=p_plan->'job'; v_org uuid; v_outcome jsonb; v_building text; v_room text; v_assignee text; v_when text;
BEGIN
  IF p_plan IS NULL OR jsonb_typeof(p_plan)<>'object' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF p_plan->>'kind' IN ('preview','needs_input','rejected') THEN RETURN p_plan; END IF;
  IF p_plan->>'kind'='replay' THEN RETURN p_plan->'outcome'; END IF;
  IF p_plan->>'action' IS DISTINCT FROM p_action OR p_plan->>'actorId' IS DISTINCT FROM auth.uid()::text THEN
    RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  IF p_plan->>'kind'='write_failed' THEN
    RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,(p_plan->>'requestId')::uuid,
      jsonb_build_object('kind','rejected','reason',app_private.hermes_action_reason_v1(p_plan->>'sqlstate',p_plan->>'message',p_plan->>'constraint')),
      p_plan->>'sqlstate',p_plan->>'message');
  END IF;
  IF p_plan->>'kind' IS DISTINCT FROM 'written' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  -- Mốc 3: task.update / task.cancel chốt ở app_private.hermes_task_edit_finish_v1.
  IF p_action IN ('task.update','task.cancel') THEN RETURN app_private.hermes_task_edit_finish_v1(p_binding,p_action,p_plan); END IF;
  -- Mốc 4: task.create_batch chốt ở app_private.hermes_task_batch_finish_v1.
  IF p_action='task.create_batch' THEN RETURN app_private.hermes_task_batch_finish_v1(p_binding,p_plan); END IF;
  v_org:=(p_plan->>'organizationId')::uuid;
  SELECT * INTO v_job FROM public.jobs WHERE id=(p_plan->>'jobId')::uuid FOR SHARE;
  IF NOT FOUND OR v_job.user_id IS DISTINCT FROM auth.uid() OR v_job.organization_id IS DISTINCT FROM v_org
    OR v_job.building_id IS DISTINCT FROM (v_plan->>'buildingId')::uuid OR v_job.room_id IS DISTINCT FROM (v_plan->>'roomId')::uuid
    OR v_job.job_type_id IS DISTINCT FROM (v_plan->>'jobTypeId')::uuid OR v_job.assignee_id IS DISTINCT FROM (v_plan->>'assigneeId')::uuid
    OR v_job.assignee_name IS NOT NULL OR v_job.deadline IS DISTINCT FROM (v_plan->>'deadline')::timestamptz
    OR v_job.title IS DISTINCT FROM v_plan->>'title' OR v_job.description IS DISTINCT FROM v_plan->>'description'
    OR v_job.priority IS DISTINCT FROM v_plan->>'priority' OR v_job.status IS DISTINCT FROM 'IN_PROGRESS' OR v_job.code IS NULL
    OR v_job.completion_time IS NOT NULL OR v_job.attachments IS NOT NULL THEN
    RAISE EXCEPTION 'hermes_task_receipt_invalid' USING ERRCODE='PT409'; END IF;
  INSERT INTO app_private.hermes_task_jobs(job_id,organization_id,actor_id,assignee_id,request_id,action,source)
    VALUES(v_job.id,v_org,v_job.user_id,v_job.assignee_id,(p_plan->>'requestId')::uuid,p_action,'action');
  PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_TASK_CREATED','job',v_job.id,NULL,
    jsonb_build_object('actor',auth.uid(),'connectionId',p_plan->'connectionId','requestId',p_plan->'requestId','jobId',v_job.id,
      'code',v_job.code,'assigneeId',v_job.assignee_id,'action',p_action),'Hermes shared task create');
  SELECT b.name INTO v_building FROM public.buildings b WHERE b.id=v_job.building_id;
  SELECT r.name INTO v_room FROM public.rooms r WHERE r.id=v_job.room_id;
  SELECT p.full_name INTO v_assignee FROM public.profiles p WHERE p.id=v_job.assignee_id;
  v_when:=app_private.hermes_task_when_v1(v_org,v_job.deadline,p_plan->'deadlineDefaulted'='true'::jsonb);
  v_outcome:=jsonb_build_object('kind','applied','link','/tasks?job='||v_job.id::text,'result',jsonb_strip_nulls(jsonb_build_object(
    'text',format('Đã tạo việc %s ''%s'' — toà %s%s — giao %s — hạn %s.',v_job.code,v_job.title,v_building,
      CASE WHEN v_room IS NOT NULL THEN ', phòng '||v_room ELSE ', cả toà' END,
      CASE WHEN v_job.assignee_id=auth.uid() THEN 'chính anh/chị' ELSE COALESCE(v_assignee,'(không xem được tên)') END,v_when),
    -- jobId (review Mốc 2, mục 5): để bot gọi tiếp crm_task_follow_set (giao rồi theo dõi); SOUL dặn không đọc UUID cho người dùng.
    'job',jsonb_strip_nulls(jsonb_build_object('jobId',v_job.id,'code',v_job.code,'title',v_job.title,'building',v_building,'room',v_room,
      'wholeBuilding',v_job.room_id IS NULL,'assignee',CASE WHEN v_job.assignee_id=auth.uid() THEN 'chính anh/chị' ELSE v_assignee END,
      'assigneeSelf',v_job.assignee_id=auth.uid(),
      'deadline',to_char(v_job.deadline AT TIME ZONE app_private.org_timezone_v1(v_org),'YYYY-MM-DD HH24:MI'),'deadlineText',v_when,
      'priority',v_job.priority)),
    'deadlineDefaulted',p_plan->'deadlineDefaulted')));
  RETURN app_private.hermes_action_receipt_finish_v1(p_binding,p_action,(p_plan->>'requestId')::uuid,v_outcome);
END $fn$;

ALTER FUNCTION app_private.hermes_task_managed_buildings_v1(uuid,uuid,uuid[]) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_batch_finish_v1(jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_write_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_task_action_finish_v1(jsonb,text,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_managed_buildings_v1(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_batch_finish_v1(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_write_v1(jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
REVOKE ALL ON FUNCTION app_private.hermes_task_action_finish_v1(jsonb,text,jsonb) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
-- Vỏ chạy dưới vai authenticated tới bốn tầng qua OID: giữ EXECUTE như 031548. Ba hàm mới chỉ hàm DEFINER gọi: không cấp.
GRANT EXECUTE ON FUNCTION app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_write_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION app_private.hermes_task_action_finish_v1(jsonb,text,jsonb) TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM app_private.hermes_action_policies WHERE action='task.create_batch' AND capability='tasks.create'
      AND crm_permission='tasks.create' AND action_class='reversible' AND confirm='always' AND private_only)
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_resolve_core_v1(jsonb,text,jsonb)'::regprocedure AND NOT p.prosecdef) IS DISTINCT FROM 'c69e78e1d9765ca073f0a5dd89d142d0'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure AND p.prosecdef) IS DISTINCT FROM '50fab164254d23455ca31d5442ae73f3'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_write_v1(jsonb)'::regprocedure AND NOT p.prosecdef) IS DISTINCT FROM '564705393a88b2ed75911a68e8dff5dd'
    OR (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid='app_private.hermes_task_action_finish_v1(jsonb,text,jsonb)'::regprocedure AND p.prosecdef) IS DISTINCT FROM '2a352c005cf388869fa54289fb6e03dc'
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_managed_buildings_v1(uuid,uuid,uuid[])'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb)'::regprocedure AND prosecdef)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.hermes_task_batch_finish_v1(jsonb,jsonb)'::regprocedure AND prosecdef)
    OR has_function_privilege('authenticated','app_private.hermes_task_managed_buildings_v1(uuid,uuid,uuid[])','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_task_batch_prepare_v1(jsonb,text,uuid,jsonb,jsonb,text,jsonb)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_task_batch_finish_v1(jsonb,jsonb)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_task_action_prepare_v1(jsonb,text,text,uuid,jsonb,jsonb,text,jsonb,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_task_batch_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
