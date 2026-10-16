-- Hermes "Gửi ảnh phòng trống" — sửa sau review độc lập 6b79e702 (16/10/2026). Chạy SAU
-- 20261016111855_hermes_zalo_broadcast_v1 (file đó đã apply TEST nên không sửa; thay thân bằng file này).
--  (P2.1) update: khi trạng thái sau ghi là BẬT và lượt sửa bật lại hoặc thêm/thay người nhận ⇒ đòi thêm
--         Action chat_zalo.send (quyết định CRM ∩ overlay kết nối ∩ chính sách công ty ∩ registry), như send.
--         Kết nối chỉ có manage_automation vẫn đổi giờ/thứ, tắt lịch, bớt nhóm.
--  (P2.2) send/update/cancel không gắn toà ⇒ đòi phạm vi kết nối ORGANIZATION (overlay ∩ chính sách),
--         đúng mẫu tạo khách/lead (20261014104442) và phiếu chi (20261015120100). status/recipients chỉ
--         đọc chat_zalo.view (không trả dữ liệu phòng nên không đòi rooms.view).
--  (P3a)  zalo_dung_khan_cap: mốc dừng = clock_timestamp() lấy SAU khoá công ty (trước đây now() = đầu
--         giao dịch). Một lần lưu cấu hình (kể cả Hermes update) giành khoá trước có updated_at = now()
--         của nó, luôn ≤ mốc dừng ⇒ không còn được tính là "đã gỡ dừng". Kiểm sha thân trước khi thay.
--  (P3b)  Lịch chữ cũ: app_private.hermes_schedule_settings_v1 (chỉ create/update của
--         hermes_room_schedule_manage_v1 — manage_v2 uỷ quyền cho v1 — gọi) nay từ chối
--         'hermes_schedule_retired' ⇒ SQL cũng chặn tạo/sửa, không chỉ connector. list/revoke/
--         issues/reconcile/run giữ nguyên. Kiểm sha thân trước khi thay.
--  (P3c)  update: UUID người nhận chuẩn hoá chữ thường rồi mới so trùng/thêm/bớt.
-- Không đổi chữ ký/kiểu trả về; CREATE OR REPLACE giữ owner/ACL, ACL vẫn khai lại tường minh.
-- Ghi chú (không sửa ở đây): bảng biên nhận hermes_zalo_broadcast_receipts chưa có dọn định kỳ
-- (giống bảng biên nhận tin pass).
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

-- Thân hiện tại phải đúng bản đã rà (hoặc chính bản của file này khi chạy lại).
DO $attest$
DECLARE v_sha text;
BEGIN
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO v_sha
    FROM pg_proc WHERE oid=to_regprocedure('public.hermes_zalo_broadcast_v1(jsonb)');
  IF v_sha IS NULL OR v_sha NOT IN ('4412c49a3bd820a1406e7ad497c584fcf158626153671d103039318c2ecee8dd','a49fc1c01d62eb1c81a505688d5b8ee84e6ff716ec81199b383a1c4f8553b797') THEN
    RAISE EXCEPTION 'unexpected public.hermes_zalo_broadcast_v1 source %',v_sha; END IF;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO v_sha
    FROM pg_proc WHERE oid=to_regprocedure('public.zalo_dung_khan_cap(uuid)');
  -- Vắng chỉ xảy ra trên baseline diễn tập (chuỗi zalo dừng ở 20260831015222): tạo mới.
  IF v_sha IS NOT NULL AND v_sha NOT IN ('d6620d953bbeb6d48e2c9c85063771de33471d464288cf3e164a21e01d828fb7','e0a47db24f566a5be40277ad012088b3bd6199c9ec749a5f53ca4f205d0e338b') THEN
    RAISE EXCEPTION 'unexpected public.zalo_dung_khan_cap source %',v_sha; END IF;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO v_sha
    FROM pg_proc WHERE oid=to_regprocedure('app_private.hermes_schedule_settings_v1(jsonb,uuid)');
  IF v_sha IS NULL OR v_sha NOT IN ('b0b094e84ff9ef17c2b000ddf1b13226c24f825a6abfb13cf1ba80b1d2a2ca0b','fc010a73a1f9a10eb06902a044ed1b8a578eecfd93eba2909333ca19511f3363') THEN
    RAISE EXCEPTION 'unexpected app_private.hermes_schedule_settings_v1 source %',v_sha; END IF;
END $attest$;

-- (P2.1) Action gửi tin của chính kết nối, cùng bốn lớp với send.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_send_ok_v1(c app_private.hermes_connections)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE policy app_private.hermes_org_policies; decision record;
BEGIN
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  SELECT * INTO decision FROM app_private.authorize_tenant_action_v3(c.user_id,c.organization_id,'chat_zalo.send');
  RETURN COALESCE(decision.allowed IS TRUE AND 'chat_zalo.send'=ANY(c.action_capabilities) AND 'chat_zalo.send'=ANY(policy.action_capabilities)
    AND EXISTS(SELECT 1 FROM app_private.hermes_capabilities WHERE capability='chat_zalo.send' AND mode='action' AND enabled),false);
END $fn$;

-- (P2.2) Phạm vi kết nối Toàn tổ chức (overlay đã lưu ∩ chính sách công ty).
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_org_scope_ok_v1(c app_private.hermes_connections)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE policy app_private.hermes_org_policies;
BEGIN
  policy:=app_private.hermes_effective_org_policy_v1(c.organization_id,c.read_capabilities,c.action_capabilities,c.scope_ids);
  PERFORM 1 FROM public.authorization_scopes overlay WHERE overlay.organization_id=c.organization_id
    AND overlay.id=ANY(c.scope_ids) AND overlay.id=ANY(policy.scope_ids) AND overlay.scope_type='ORGANIZATION'
    AND overlay.building_id IS NULL AND overlay.area_id IS NULL AND overlay.cashbook_id IS NULL FOR SHARE;
  RETURN FOUND;
END $fn$;

-- (P3c) Danh sách người nhận để GHI: chuẩn hoá như worker, UUID về chữ thường, bỏ trùng giữ thứ tự.
CREATE OR REPLACE FUNCTION app_private.hermes_zalo_nguoi_nhan_ghi_v1(p jsonb)
RETURNS text[] LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,app_private AS $fn$
  SELECT COALESCE((SELECT array_agg(v ORDER BY first_at) FROM (
      SELECT v,min(i) AS first_at FROM (
        SELECT CASE WHEN x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN lower(x) ELSE x END AS v,i
        FROM unnest(app_private.hermes_zalo_nguoi_nhan_v1(p)) WITH ORDINALITY u(x,i)) s
      GROUP BY v) d),'{}'::text[])
$fn$;

-- (P3b) Lịch chữ cũ không tạo/sửa được nữa ở SQL.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_settings_v1(p jsonb,p_org uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
BEGIN
  -- Cutover P6.06: lịch gửi phòng trống là tự động hoá CRM (hermes_zalo_broadcast_v1).
  RAISE EXCEPTION 'hermes_schedule_retired' USING ERRCODE='42501';
END $fn$;

-- (P3a) Thân 20261016101450; mốc dừng lấy sau khoá công ty.
CREATE OR REPLACE FUNCTION public.zalo_dung_khan_cap(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $fn$
DECLARE v_org uuid:=p_organization_id; v_orgs uuid[]; v_jobs uuid[]; v_msgs uuid[]; v_jobs_count int:=0; v_msgs_count int:=0; v_processing int:=0; v_acc uuid;
  v_shots int:=0; v_mark timestamptz;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('manage_automation') o;
    IF array_length(v_orgs,1) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Cần chọn tổ chức' USING ERRCODE='22023'; END IF;
    v_org:=v_orgs[1];
  END IF;
  IF NOT public.zalo_can('manage_automation',v_org) THEN RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  -- Mốc dừng SAU khi giữ khoá: mọi lần lưu đã giành khoá trước có updated_at ≤ mốc này.
  v_mark:=clock_timestamp();
  UPDATE public.zalo_automations SET enabled=false,updated_at=v_mark WHERE organization_id=v_org AND enabled;
  WITH shots AS (
    UPDATE public.zalo_automation_oneshots SET status='cancelled',cancelled_at=v_mark,cancelled_by=auth.uid(),updated_at=v_mark,
      result=result||jsonb_build_object('code','dung_khan_cap','reason','Người dùng bấm Dừng khẩn cấp')
    WHERE organization_id=v_org AND status IN ('queued','running') RETURNING id
  ) SELECT count(*) INTO v_shots FROM shots;
  WITH stopped AS (
    UPDATE public.zalo_send_queue SET status='failed',processed_at=clock_timestamp(),last_error='CANCELLED_AUTOMATION: người dùng dừng khẩn cấp',
      result=jsonb_build_object('outcome','cancelled','reason','emergency_stop')
    WHERE organization_id=v_org AND status='queued' AND payload ? 'tu_dong' RETURNING id,message_id
  ) SELECT array_agg(id),array_agg(message_id) FILTER(WHERE message_id IS NOT NULL) INTO v_jobs,v_msgs FROM stopped;
  v_jobs_count:=COALESCE(cardinality(v_jobs),0);
  UPDATE public.zalo_messages m SET status='failed' WHERE m.organization_id=v_org AND m.status='pending'
    AND (m.id=ANY(COALESCE(v_msgs,'{}')) OR EXISTS(SELECT 1 FROM public.zalo_send_queue q WHERE q.id=ANY(COALESCE(v_jobs,'{}'))
      AND q.conversation_id=m.conversation_id AND q.account_id=m.account_id AND jsonb_typeof(q.payload->'message_ids')='array' AND q.payload->'message_ids' ? m.id::text));
  GET DIAGNOSTICS v_msgs_count=ROW_COUNT;
  SELECT count(*) INTO v_processing FROM public.zalo_send_queue WHERE organization_id=v_org AND status='processing' AND payload ? 'tu_dong';
  SELECT id INTO v_acc FROM public.zalo_accounts WHERE organization_id=v_org ORDER BY id LIMIT 1;
  INSERT INTO public.zalo_automation_runs(organization_id,account_id,kind,mode,reason,messages_count,detail,created_at)
    VALUES(v_org,v_acc,'broadcast_vacant','stopped',format('Đã dừng %s tin đang chờ, huỷ %s lượt gửi một lần và tắt tự động hóa',v_jobs_count,v_shots),v_jobs_count,
      jsonb_build_object('so_job_huy',v_jobs_count,'so_tin_danh_dau_that_bai',v_msgs_count,'con_dang_gui',v_processing,'so_hen_gio_huy',v_shots,'boi',auth.uid()),v_mark);
  RETURN jsonb_build_object('da_huy',v_jobs_count,'tin_danh_dau_that_bai',v_msgs_count,'con_dang_gui',v_processing,'hen_gio_huy',v_shots);
END $fn$;

CREATE OR REPLACE FUNCTION public.hermes_zalo_broadcast_v1(p jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections;
  receipt app_private.hermes_zalo_broadcast_receipts; a public.zalo_automations;
  op text; input jsonb; v_org uuid; v_now timestamptz:=clock_timestamp(); v_res jsonb; v_req uuid; v_ids uuid[]; v_run timestamptz;
  v_shot uuid; v_group text; v_label text; v_key text; v_limit bigint; v_sched text[]; v_groups jsonb; v_labels jsonb; v_total integer;
  v_keys text[]; v_add uuid[]; v_remove uuid[]; v_set uuid[]; v_bad uuid[]; v_base text[]; v_new text[]; v_cfg jsonb; v_old jsonb;
  v_schedule jsonb; v_enabled boolean; v_old_enabled boolean; v_changed text[]:='{}'; v_warn text[]:='{}'; v_view jsonb; v_result jsonb; v_id uuid;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(p))<>3 OR NOT(p ?& ARRAY['binding','operation','input'])
    OR jsonb_typeof(p->'operation') IS DISTINCT FROM 'string' OR jsonb_typeof(p->'input') IS DISTINCT FROM 'object'
    THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
  op:=p->>'operation'; input:=p->'input';
  IF op NOT IN ('status','recipients','send','cancel','update') THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
  -- Read cho mọi thao tác; ghi thêm Action quản lý tự động hoá + phạm vi Toàn tổ chức; gửi thêm Action gửi tin.
  c:=app_private.hermes_schedule_actor_v1(p->'binding',false);
  IF op IN ('send','cancel','update') THEN
    PERFORM app_private.hermes_schedule_actor_v1(p->'binding',true);
    IF NOT app_private.hermes_zalo_org_scope_ok_v1(c) THEN RAISE EXCEPTION 'hermes_zalo_broadcast_scope_denied' USING ERRCODE='42501'; END IF;
  END IF;
  IF op='send' AND NOT app_private.hermes_zalo_send_ok_v1(c) THEN RAISE EXCEPTION 'hermes_zalo_broadcast_denied' USING ERRCODE='42501'; END IF;
  v_org:=c.organization_id;

  IF op='status' THEN
    IF input<>'{}'::jsonb THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
    v_res:=public.zalo_ds_hen_gui_phong_trong_v1(v_org,10);
    RETURN app_private.hermes_zalo_broadcast_view_v1(v_org)||jsonb_build_object('oneshots',
      COALESCE((SELECT jsonb_agg(app_private.hermes_zalo_oneshot_v1(x,false) ORDER BY i)
        FROM jsonb_array_elements(COALESCE(v_res->'items','[]'::jsonb)) WITH ORDINALITY y(x,i)),'[]'::jsonb));
  END IF;

  IF op='recipients' THEN
    PERFORM app_private.hermes_request_v1(input,ARRAY['groupName','labelName','labelKey','limit']);
    v_group:=app_private.hermes_zalo_query_v1(input->'groupName');
    v_label:=app_private.hermes_zalo_query_v1(input->'labelName');
    IF input->'labelKey'<>'null'::jsonb THEN
      IF jsonb_typeof(input->'labelKey')<>'string' OR input->>'labelKey' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:-?[0-9]{1,10}$'
        THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
      v_key:=input->>'labelKey';
    END IF;
    v_limit:=app_private.hermes_integer_v1(input->'limit');
    IF v_limit>50 THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
    SELECT app_private.hermes_zalo_nguoi_nhan_ghi_v1(CASE WHEN jsonb_typeof(x.config)='object' THEN x.config->'recipients' END) INTO v_sched
      FROM public.zalo_automations x WHERE x.organization_id=v_org AND x.kind='broadcast_vacant';
    v_sched:=COALESCE(v_sched,'{}'::text[]);
    WITH g AS (
      SELECT cv.id,cv.peer_name,z.id AS account_id,z.name AS account_name,
        CASE WHEN jsonb_typeof(cv.label_ids)='array' THEN cv.label_ids ELSE '[]'::jsonb END AS label_ids
      FROM public.zalo_conversations cv
      JOIN public.zalo_accounts z ON z.id=cv.account_id AND z.organization_id=cv.organization_id AND z.kind='personal'
      WHERE cv.organization_id=v_org AND cv.thread_type='group' AND cv.is_sale_partner
    ), l AS (
      SELECT lb.account_id,lb.label_id,lb.name,z.name AS account_name,lb.account_id::text||':'||lb.label_id::text AS key
      FROM public.zalo_labels lb JOIN public.zalo_accounts z ON z.id=lb.account_id AND z.organization_id=v_org AND z.kind='personal'
    ), gl AS (
      SELECT g.id AS conversation_id,l.key,l.name FROM g JOIN l ON l.account_id=g.account_id
        AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(g.label_ids) e WHERE e=l.label_id::text)
    ), ml AS (
      SELECT l.* FROM l WHERE (v_label IS NULL OR strpos(app_private.hermes_zalo_fold_v1(l.name),v_label)>0)
        AND (v_key IS NULL OR l.key=v_key)
    ), sel AS (
      SELECT g.* FROM g WHERE (v_group IS NULL OR strpos(app_private.hermes_zalo_fold_v1(g.peer_name),v_group)>0)
        AND ((v_label IS NULL AND v_key IS NULL) OR EXISTS(SELECT 1 FROM gl JOIN ml ON ml.key=gl.key WHERE gl.conversation_id=g.id))
    ), page AS (
      SELECT sel.*,row_number() OVER (ORDER BY app_private.hermes_zalo_fold_v1(sel.peer_name),sel.id) AS n FROM sel
    ), counted AS (
      SELECT ml.key,ml.name,ml.account_name,(SELECT count(*) FROM gl WHERE gl.key=ml.key)::integer AS groups FROM ml
    )
    SELECT (SELECT count(*) FROM sel)::integer,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('conversationId',page.id,'name',app_private.hermes_zalo_text_v1(page.peer_name,200),
          'accountName',app_private.hermes_zalo_text_v1(page.account_name,200),'inSchedule',page.id::text=ANY(v_sched),
          'labels',COALESCE((SELECT jsonb_agg(jsonb_build_object('key',q.key,'name',app_private.hermes_zalo_text_v1(q.name,200)) ORDER BY q.key)
            FROM (SELECT gl.key,gl.name FROM gl WHERE gl.conversation_id=page.id ORDER BY gl.key LIMIT 10) q),'[]'::jsonb)) ORDER BY page.n)
        FROM page WHERE page.n<=v_limit),'[]'::jsonb),
      COALESCE((SELECT jsonb_agg(jsonb_build_object('key',k.key,'name',app_private.hermes_zalo_text_v1(k.name,200),
          'accountName',app_private.hermes_zalo_text_v1(k.account_name,200),'groupCount',k.groups) ORDER BY k.ord)
        FROM (SELECT counted.*,row_number() OVER (ORDER BY app_private.hermes_zalo_fold_v1(counted.name),counted.key) AS ord FROM counted
              WHERE v_label IS NOT NULL OR v_key IS NOT NULL OR counted.groups>0) k WHERE k.ord<=50),'[]'::jsonb)
      INTO v_total,v_groups,v_labels;
    RETURN jsonb_build_object('groups',v_groups,'labels',v_labels,'total',v_total,'truncated',v_total>v_limit);
  END IF;

  IF op='send' THEN
    PERFORM app_private.hermes_request_v1(input,ARRAY['requestId','conversationIds','mode','runAt']);
    v_req:=app_private.hermes_uuid_v1(input->'requestId');
    v_ids:=app_private.hermes_zalo_ids_v1(input->'conversationIds');
    IF cardinality(v_ids)>50 OR jsonb_typeof(input->'mode') IS DISTINCT FROM 'string' OR input->>'mode' NOT IN ('full','compact')
      THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
    IF input->'runAt'='null'::jsonb THEN v_run:=NULL;
    ELSIF jsonb_typeof(input->'runAt')='string' AND input->>'runAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' THEN
      v_run:=(input->>'runAt')::timestamptz;
    ELSE RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
    IF v_run IS NOT NULL AND (v_run<v_now-interval '5 minutes' OR v_run>v_now+interval '30 days') THEN
      RETURN jsonb_build_object('ok',false,'code','gio_hen_khong_hop_le','reason','Giờ hẹn phải nằm trong 30 ngày tới.',
        'allowedHours',NULL,'suggestedRunAt',NULL,'invalidRecipients','[]'::jsonb);
    END IF;
    BEGIN
      v_res:=public.zalo_hen_gui_phong_trong_v1(v_ids,input->>'mode',v_run,v_req::text,'hermes',v_org);
    EXCEPTION WHEN unique_violation THEN
      RETURN jsonb_build_object('ok',false,'code','ma_yeu_cau_da_dung','reason','Mã yêu cầu đã dùng cho một lượt gửi khác.',
        'allowedHours',NULL,'suggestedRunAt',NULL,'invalidRecipients','[]'::jsonb);
    END;
    IF v_res->'ok'='true'::jsonb THEN
      IF v_res->'reused'='false'::jsonb THEN
        PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_ZALO_BROADCAST_SEND','zalo_automation_oneshot',(v_res#>>'{oneshot,id}')::uuid,NULL,
          jsonb_build_object('actor',auth.uid(),'connectionId',c.id,'requestId',v_req,'mode',input->>'mode','runAt',input->'runAt','recipients',cardinality(v_ids)));
      END IF;
      RETURN jsonb_build_object('ok',true,'reused',v_res->'reused'='true'::jsonb,'oneshot',app_private.hermes_zalo_oneshot_v1(v_res->'oneshot',true));
    END IF;
    RETURN jsonb_build_object('ok',false,'code',v_res->>'code','reason',app_private.hermes_zalo_text_v1(v_res->>'reason',500),
      'allowedHours',CASE WHEN jsonb_typeof(v_res->'khung_gio')='object' THEN jsonb_build_object('from',v_res#>>'{khung_gio,from}','to',v_res#>>'{khung_gio,to}') END,
      'suggestedRunAt',CASE WHEN jsonb_typeof(v_res->'goi_y_run_at')='string' THEN app_private.hermes_zalo_iso_v1((v_res->>'goi_y_run_at')::timestamptz) END,
      'invalidRecipients',CASE WHEN jsonb_typeof(v_res->'nguoi_nhan_loi')='array' THEN v_res->'nguoi_nhan_loi' ELSE '[]'::jsonb END);
  END IF;

  IF op='cancel' THEN
    PERFORM app_private.hermes_request_v1(input,ARRAY['oneshotId']);
    v_shot:=app_private.hermes_uuid_v1(input->'oneshotId');
    IF NOT EXISTS(SELECT 1 FROM public.zalo_automation_oneshots WHERE id=v_shot AND organization_id=v_org) THEN
      RETURN jsonb_build_object('ok',false,'code','khong_tim_thay','reason','Không tìm thấy lượt hẹn này trong công ty.','oneshot',NULL);
    END IF;
    v_res:=public.zalo_huy_hen_gui_phong_trong_v1(v_shot);
    IF v_res->'ok'='true'::jsonb THEN
      IF v_res->'reused'='false'::jsonb THEN
        PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_ZALO_BROADCAST_CANCEL','zalo_automation_oneshot',v_shot,NULL,
          jsonb_build_object('actor',auth.uid(),'connectionId',c.id));
      END IF;
      RETURN jsonb_build_object('ok',true,'reused',v_res->'reused'='true'::jsonb,'oneshot',app_private.hermes_zalo_oneshot_v1(v_res->'oneshot',true));
    END IF;
    RETURN jsonb_build_object('ok',false,'code',v_res->>'code','reason',app_private.hermes_zalo_text_v1(v_res->>'reason',500),
      'oneshot',CASE WHEN jsonb_typeof(v_res->'oneshot')='object' THEN app_private.hermes_zalo_oneshot_v1(v_res->'oneshot',true) END);
  END IF;

  -- update
  v_keys:=ARRAY(SELECT jsonb_object_keys(input));
  IF NOT(input ?& ARRAY['requestId','expectedVersion']) OR cardinality(v_keys)<3 OR EXISTS(SELECT 1 FROM unnest(v_keys) k
      WHERE k NOT IN ('requestId','expectedVersion','enabled','time','days','addConversationIds','removeConversationIds','setConversationIds'))
    OR jsonb_typeof(input->'expectedVersion') IS DISTINCT FROM 'string' OR input->>'expectedVersion' !~ '^[0-9a-f]{64}$'
    OR (input ? 'enabled' AND jsonb_typeof(input->'enabled')<>'boolean')
    OR (input ? 'time' AND (jsonb_typeof(input->'time')<>'string' OR input->>'time' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
    OR (input ? 'days' AND (jsonb_typeof(input->'days')<>'object' OR input->'days'='{}'::jsonb OR EXISTS(SELECT 1 FROM jsonb_each(input->'days') d
      WHERE d.key NOT IN ('mon','tue','wed','thu','fri','sat','sun') OR jsonb_typeof(d.value)<>'string' OR d.value#>>'{}' NOT IN ('full','compact','off'))))
    OR (input ? 'setConversationIds' AND (input ? 'addConversationIds' OR input ? 'removeConversationIds'))
    THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;
  v_req:=app_private.hermes_uuid_v1(input->'requestId');
  IF input ? 'addConversationIds' THEN v_add:=app_private.hermes_zalo_ids_v1(input->'addConversationIds'); END IF;
  IF input ? 'removeConversationIds' THEN v_remove:=app_private.hermes_zalo_ids_v1(input->'removeConversationIds'); END IF;
  IF input ? 'setConversationIds' THEN v_set:=app_private.hermes_zalo_ids_v1(input->'setConversationIds'); END IF;
  IF v_add && v_remove THEN RAISE EXCEPTION 'hermes_zalo_broadcast_invalid' USING ERRCODE='22023'; END IF;

  -- Cùng khoá với dừng khẩn cấp, xếp hàng và tạo lượt một lần.
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  SELECT * INTO receipt FROM app_private.hermes_zalo_broadcast_receipts r WHERE r.connection_id=c.id AND r.request_id=v_req FOR UPDATE;
  IF FOUND THEN
    IF receipt.input IS DISTINCT FROM input OR receipt.organization_id<>v_org OR receipt.user_id<>c.user_id THEN
      RETURN jsonb_build_object('ok',false,'code','ma_yeu_cau_da_dung','reason','Mã yêu cầu đã dùng cho một thay đổi khác.','version',NULL,'invalidRecipients','[]'::jsonb);
    END IF;
    RETURN receipt.result||jsonb_build_object('reused',true);
  END IF;
  IF app_private.zalo_dang_dung_khan_cap_v1(v_org) THEN
    RETURN jsonb_build_object('ok',false,'code','dang_dung_khan_cap','version',NULL,'invalidRecipients','[]'::jsonb,
      'reason','Tự động hoá Zalo đang DỪNG KHẨN CẤP. Người quản lý cần mở cài đặt gửi phòng trống trên CRM và lưu lại; Hermes không tự gỡ.');
  END IF;
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=v_org AND kind='broadcast_vacant' FOR UPDATE;
  IF app_private.hermes_zalo_broadcast_version_v1(a.enabled,a.config)<>input->>'expectedVersion' THEN
    RETURN jsonb_build_object('ok',false,'code','cau_hinh_vua_doi','invalidRecipients','[]'::jsonb,
      'version',app_private.hermes_zalo_broadcast_version_v1(a.enabled,a.config),
      'reason','Cài đặt gửi phòng trống vừa được sửa sau lần đọc; đọc lại rồi áp lại thay đổi.');
  END IF;
  v_old_enabled:=COALESCE(a.enabled,false);
  v_old:=CASE WHEN jsonb_typeof(a.config)='object' THEN a.config ELSE '{}'::jsonb END;
  v_cfg:=v_old;
  v_enabled:=CASE WHEN input ? 'enabled' THEN (input->>'enabled')::boolean ELSE v_old_enabled END;
  -- (P2.1) Lịch BẬT sau ghi mà lượt này bật lại hoặc thêm/thay người nhận ⇒ cần quyền gửi tin.
  IF v_enabled AND (NOT v_old_enabled OR v_add IS NOT NULL OR v_set IS NOT NULL) AND NOT app_private.hermes_zalo_send_ok_v1(c) THEN
    RAISE EXCEPTION 'hermes_zalo_broadcast_send_denied' USING ERRCODE='42501'; END IF;
  IF v_add IS NOT NULL OR v_remove IS NOT NULL OR v_set IS NOT NULL THEN
    SELECT array_agg(x ORDER BY x) INTO v_bad FROM unnest(COALESCE(v_set,v_add,'{}'::uuid[])) x WHERE NOT app_private.hermes_zalo_group_ok_v1(v_org,x);
    IF v_bad IS NOT NULL THEN
      RETURN jsonb_build_object('ok',false,'code','nguoi_nhan_khong_hop_le','version',NULL,'invalidRecipients',to_jsonb(v_bad),
        'reason','Chỉ thêm được nhóm Zalo của công ty đã đánh dấu sale; có '||cardinality(v_bad)||' hội thoại không hợp lệ.');
    END IF;
    -- (P3c) So trùng trên UUID chữ thường.
    v_base:=app_private.hermes_zalo_nguoi_nhan_ghi_v1(v_old->'recipients');
    IF v_set IS NOT NULL THEN
      v_new:=ARRAY(SELECT x::text FROM unnest(v_set) WITH ORDINALITY u(x,i) ORDER BY i);
    ELSE
      v_new:=ARRAY(SELECT x FROM unnest(v_base) WITH ORDINALITY u(x,i) WHERE NOT(x=ANY(COALESCE(v_remove,'{}'::uuid[])::text[])) ORDER BY i)
        ||ARRAY(SELECT x::text FROM unnest(COALESCE(v_add,'{}'::uuid[])) WITH ORDINALITY u(x,i) WHERE NOT(x::text=ANY(v_base)) ORDER BY i);
    END IF;
    IF (v_set IS NOT NULL OR v_add IS NOT NULL) AND cardinality(v_new)>100 THEN
      RETURN jsonb_build_object('ok',false,'code','qua_nhieu_nguoi_nhan','version',NULL,'invalidRecipients','[]'::jsonb,
        'reason','Lịch gửi phòng trống tối đa 100 nhóm nhận.');
    END IF;
    v_cfg:=v_cfg||jsonb_build_object('recipients',to_jsonb(v_new));
  END IF;
  IF input ? 'time' OR input ? 'days' THEN
    v_schedule:=CASE WHEN jsonb_typeof(v_cfg->'schedule')='object' THEN v_cfg->'schedule' ELSE '{}'::jsonb END;
    IF input ? 'time' THEN v_schedule:=v_schedule||jsonb_build_object('time',input->'time'); END IF;
    IF input ? 'days' THEN
      v_schedule:=v_schedule||jsonb_build_object('days',CASE WHEN jsonb_typeof(v_schedule->'days')='object' THEN v_schedule->'days' ELSE '{}'::jsonb END||(input->'days'));
    END IF;
    v_cfg:=v_cfg||jsonb_build_object('schedule',v_schedule);
  END IF;
  IF v_enabled<>v_old_enabled THEN v_changed:=v_changed||'enabled'::text; END IF;
  IF app_private.hermes_zalo_gio_v1(v_cfg#>'{schedule,time}','08:30')<>app_private.hermes_zalo_gio_v1(v_old#>'{schedule,time}','08:30') THEN v_changed:=v_changed||'time'::text; END IF;
  IF app_private.hermes_zalo_ngay_v1(v_cfg#>'{schedule,days}')<>app_private.hermes_zalo_ngay_v1(v_old#>'{schedule,days}') THEN v_changed:=v_changed||'days'::text; END IF;
  IF app_private.hermes_zalo_nguoi_nhan_v1(v_cfg->'recipients')<>app_private.hermes_zalo_nguoi_nhan_v1(v_old->'recipients') THEN v_changed:=v_changed||'recipients'::text; END IF;
  -- Không đổi gì (sau chuẩn hoá) thì không ghi: lưu cấu hình bump updated_at, không có lý do làm vậy.
  IF cardinality(v_changed)>0 THEN
    BEGIN
      PERFORM public.zalo_luu_tu_dong_hoa('broadcast_vacant',v_enabled,v_cfg,v_org);
    EXCEPTION WHEN SQLSTATE 'PT409' THEN
      RETURN jsonb_build_object('ok',false,'code','trung_lich_hermes_cu','version',NULL,'invalidRecipients','[]'::jsonb,
        'reason','Nhóm nhận đang thuộc một lịch chữ cũ của Hermes còn hiệu lực; thu hồi lịch đó trước.');
    END;
  END IF;
  v_view:=app_private.hermes_zalo_broadcast_view_v1(v_org);
  IF NOT app_private.zalo_in_allowed_hours_v1(((date_trunc('day',v_now AT TIME ZONE 'Asia/Ho_Chi_Minh')
      +(v_view->>'time')::time) AT TIME ZONE 'Asia/Ho_Chi_Minh'),v_cfg) THEN v_warn:=v_warn||'gio_gui_ngoai_khung_gio'::text; END IF;
  IF v_enabled AND NOT EXISTS(SELECT 1 FROM unnest(app_private.hermes_zalo_nguoi_nhan_v1(v_cfg->'recipients')) x
      WHERE x ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' AND app_private.hermes_zalo_group_ok_v1(v_org,x::uuid))
    THEN v_warn:=v_warn||'chua_co_nguoi_nhan_hop_le'::text; END IF;
  v_result:=jsonb_build_object('ok',true,'reused',false,'changed',to_jsonb(v_changed),'settings',v_view,'warnings',to_jsonb(v_warn));
  INSERT INTO app_private.hermes_zalo_broadcast_receipts(connection_id,request_id,organization_id,user_id,operation,input,result)
    VALUES(c.id,v_req,v_org,c.user_id,'update',input,v_result);
  IF cardinality(v_changed)>0 THEN
    SELECT id INTO v_id FROM public.zalo_automations WHERE organization_id=v_org AND kind='broadcast_vacant';
    PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_ZALO_BROADCAST_UPDATE','zalo_automation',v_id,NULL,
      jsonb_build_object('actor',auth.uid(),'connectionId',c.id,'requestId',v_req,'changed',to_jsonb(v_changed)));
  END IF;
  RETURN v_result;
END $fn$;

-- ACL tường minh (CREATE OR REPLACE giữ ACL cũ; khai lại để bản dựng mới cũng đúng).
ALTER FUNCTION app_private.hermes_zalo_send_ok_v1(app_private.hermes_connections) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_org_scope_ok_v1(app_private.hermes_connections) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_zalo_nguoi_nhan_ghi_v1(jsonb) OWNER TO postgres;
ALTER FUNCTION app_private.hermes_schedule_settings_v1(jsonb,uuid) OWNER TO postgres;
ALTER FUNCTION public.hermes_zalo_broadcast_v1(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_zalo_send_ok_v1(app_private.hermes_connections),
  app_private.hermes_zalo_org_scope_ok_v1(app_private.hermes_connections),app_private.hermes_zalo_nguoi_nhan_ghi_v1(jsonb),
  app_private.hermes_schedule_settings_v1(jsonb,uuid),public.hermes_zalo_broadcast_v1(jsonb)
  FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_zalo_broadcast_v1(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.zalo_dung_khan_cap(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.zalo_dung_khan_cap(uuid) TO authenticated;

-- Tự kiểm catalog trước khi commit (chạy được trên database rỗng).
DO $assert$
DECLARE f text;
BEGIN
  IF position('hermes_zalo_send_ok_v1' IN pg_get_functiondef('public.hermes_zalo_broadcast_v1(jsonb)'::regprocedure))=0
    OR position('hermes_zalo_org_scope_ok_v1' IN pg_get_functiondef('public.hermes_zalo_broadcast_v1(jsonb)'::regprocedure))=0
    OR position('v_mark:=clock_timestamp()' IN pg_get_functiondef('public.zalo_dung_khan_cap(uuid)'::regprocedure))=0
    OR position('hermes_schedule_retired' IN pg_get_functiondef('app_private.hermes_schedule_settings_v1(jsonb,uuid)'::regprocedure))=0
    THEN RAISE EXCEPTION 'hermes zalo broadcast review fixes source'; END IF;
  IF NOT has_function_privilege('authenticated','public.hermes_zalo_broadcast_v1(jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.hermes_zalo_broadcast_v1(jsonb)','EXECUTE')
    OR has_function_privilege('service_role','public.hermes_zalo_broadcast_v1(jsonb)','EXECUTE')
    OR NOT has_function_privilege('authenticated','public.zalo_dung_khan_cap(uuid)','EXECUTE')
    OR has_function_privilege('anon','public.zalo_dung_khan_cap(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes zalo broadcast review fixes caller ACL'; END IF;
  FOREACH f IN ARRAY ARRAY['app_private.hermes_zalo_send_ok_v1(app_private.hermes_connections)',
      'app_private.hermes_zalo_org_scope_ok_v1(app_private.hermes_connections)','app_private.hermes_zalo_nguoi_nhan_ghi_v1(jsonb)',
      'app_private.hermes_schedule_settings_v1(jsonb,uuid)'] LOOP
    IF has_function_privilege('authenticated',f,'EXECUTE') OR has_function_privilege('anon',f,'EXECUTE')
      OR has_function_privilege('service_role',f,'EXECUTE') THEN RAISE EXCEPTION 'hermes zalo broadcast helper ACL %',f; END IF;
  END LOOP;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
