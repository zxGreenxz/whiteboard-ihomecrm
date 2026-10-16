-- Hermes đọc trang Sale Phòng (20261016080232) — sửa sau review độc lập 16/10/2026.
--  (P2) Công ty không còn link chia sẻ nào: lịch rooms_public_text_v1 trước ghi no_rooms mỗi
--       ngày và observe coi là đã hồi phục ⇒ nay run_v1 dừng bằng lỗi riêng
--       hermes_schedule_no_sale_page, run_v2 phân loại reason no_sale_page (mở sự cố 'run',
--       đóng ngày bị chặn, báo chủ như các lỗi khác), message_v1 có câu báo riêng.
--  (P3.4) Ô liên hệ khách pass quá dài cắt 80 ký tự kèm "…" như connector (PASS_CONTACT_CHARS),
--       để nhãn bản tin nhóm khớp bản xem trước và không làm hỏng cả bản tin.
-- Không đổi chữ ký/kiểu trả về/ACL (CREATE OR REPLACE giữ owner/GRANT). Thân hàm chép nguyên bản
-- mới nhất (fact, run_v1: 20261016080232; run_v2, message_v1: 20261015100000), chỉ đổi đoạn nêu
-- trên. Không ghi dữ liệu.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

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
    -- 80 ký tự/ô như connector (PASS_CONTACT_CHARS): một ô quá dài không làm hỏng cả bản tin.
    v_who:=concat_ws(' ',NULLIF(CASE WHEN char_length(pl.contact_phone)>80 THEN left(pl.contact_phone,79)||'…' ELSE pl.contact_phone END,''),
      '('||NULLIF(CASE WHEN char_length(pl.contact_name)>80 THEN left(pl.contact_name,79)||'…' ELSE pl.contact_name END,'')||')');
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

CREATE OR REPLACE FUNCTION public.hermes_room_schedule_run_v1(p_schedule_id uuid,p_expected_revision bigint,p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE s app_private.hermes_room_schedules; g app_private.hermes_schedule_grants; z public.zalo_conversations;
  context jsonb; binding jsonb; snapshot jsonb; request jsonb; room_ids uuid[]; room public.rooms; building public.buildings;
  fact record; selected uuid; org uuid; today date; local_now timestamp; scheduled timestamp; previous timestamptz;
  dispatch uuid:=gen_random_uuid(); message_id uuid; job_id uuid; queue jsonb; body text; expiry timestamptz;
  soon_days integer; has_pass boolean; count_today integer; v_template text; v_policy boolean; v_denied jsonb;
  v_projection jsonb; v_digest bytea; v_base bytea; v_prior record; v_delivery text; v_listing jsonb;
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
    -- Không còn link chia sẻ nào ⇒ không có trang sale: lỗi riêng (run_v2 mở sự cố, báo chủ),
    -- không ghi no_rooms vì observe coi no_rooms là đã hồi phục.
    v_listing:=app_private.hermes_sale_listing_payload_v1(org);
    IF COALESCE((v_listing->>'pages')::integer,0)=0 THEN RAISE EXCEPTION 'hermes_schedule_no_sale_page' USING ERRCODE='55000'; END IF;
    SELECT COALESCE(array_agg((listed->>'id')::uuid ORDER BY (listed->>'building_id')::uuid,(listed->>'id')::uuid),'{}'::uuid[]) INTO room_ids
      FROM jsonb_array_elements(v_listing->'rooms') listed
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

CREATE OR REPLACE FUNCTION public.hermes_room_schedule_run_v2(p_schedule_id uuid,p_expected_revision bigint,p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE org uuid; result jsonb; diag jsonb; v_state text; v_message text; v_reason text; v_closed integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  SELECT organization_id INTO org FROM app_private.hermes_room_schedules WHERE id=p_schedule_id;
  IF org IS NULL THEN RAISE EXCEPTION 'hermes_schedule_denied' USING ERRCODE='42501'; END IF;
  PERFORM app_private.lock_org_for_decision_v1(org);
  PERFORM pg_advisory_xact_lock(hashtextextended('hermes-room-schedule:'||org::text,0));
  -- A stale or foreign worker records nothing.
  IF NOT EXISTS(SELECT 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  BEGIN
    result:=public.hermes_room_schedule_run_v1(p_schedule_id,p_expected_revision,p_instance_id);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state=RETURNED_SQLSTATE,v_message=MESSAGE_TEXT;
    IF v_message='hermes_schedule_worker_denied' THEN RAISE; END IF;
    result:=NULL;
  END;
  IF result IS NOT NULL THEN
    PERFORM app_private.hermes_schedule_observe_v1(p_schedule_id,result);
    RETURN result;
  END IF;
  diag:=app_private.hermes_schedule_diagnose_v1(p_schedule_id);
  v_reason:=diag->>'reason';
  -- v1 already skips denied recipients, so a recipient denial never explains
  -- an exception: keep it as its own incident and classify the error itself.
  IF v_reason='target_denied' THEN
    PERFORM app_private.hermes_schedule_incident_open_v1(p_schedule_id,'authority','target_denied',diag->'detail');
    v_reason:=NULL;
  END IF;
  IF v_reason IS NULL THEN
    v_reason:=CASE WHEN v_message='hermes_schedule_no_sale_page' THEN 'no_sale_page'
      WHEN v_message IN ('hermes_group_rooms_changed','hermes_group_rooms_incomplete') THEN 'room_data_changed'
      WHEN v_message='hermes_schedule_message_invalid' THEN 'message_too_large'
      WHEN v_message IN ('hermes_group_context_changed','hermes_group_target_changed') OR v_state IN ('40001','40P01','55P03') THEN 'context_changed'
      ELSE 'unclassified' END;
    diag:=jsonb_build_object('reason',v_reason,'kind','run','detail',jsonb_build_object('sqlstate',v_state,
      'code',CASE WHEN v_message ~ '^hermes_[a-z0-9_]{1,60}$' THEN v_message END));
  END IF;
  IF v_reason<>'schedule_inactive' THEN
    -- The blocking incident already tells the owner; the closed day only
    -- stops re-attempts and keeps the reason on each missed recipient row.
    PERFORM app_private.hermes_schedule_incident_open_v1(p_schedule_id,diag->>'kind',v_reason,diag->'detail');
    v_closed:=app_private.hermes_schedule_close_blocked_day_v1(p_schedule_id,v_reason);
  END IF;
  RETURN jsonb_build_object('status','blocked','reason',v_reason,'closedRecipients',COALESCE(v_closed,0));
END $fn$;

CREATE OR REPLACE FUNCTION app_private.hermes_schedule_message_v1(p_reason text,p_phase text,p_detail jsonb,p_label text,p_expires timestamptz)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $fn$
  SELECT CASE WHEN p_phase='recovered' THEN jsonb_build_object('title','Lịch Hermes đã chạy lại',
      'body',p_label||' không còn lỗi đã báo; lịch tiếp tục theo nhịp đã đặt. Kết quả từng tin xem trong danh sách lịch.')
    ELSE jsonb_build_object('title',CASE p_reason WHEN 'grant_expiring' THEN 'Lịch Hermes sắp hết hạn' WHEN 'grant_expired' THEN 'Lịch Hermes đã hết hạn'
        WHEN 'delivery_unknown' THEN 'Tin của lịch Hermes chưa rõ kết quả' WHEN 'delivery_failed' THEN 'Tin của lịch Hermes chưa gửi được'
        ELSE 'Lịch Hermes đang bị chặn' END,
      'body',p_label||': '||CASE p_reason
        WHEN 'user_permission_revoked' THEN 'tài khoản không còn quyền CRM cần cho lịch ('||COALESCE(p_detail->>'permission','')||'). Nhờ quản trị cấp lại quyền hoặc thu hồi lịch.'
        WHEN 'hermes_overlay_revoked' THEN 'kết nối Hermes đã tắt quyền cần cho lịch ('||COALESCE(p_detail->>'capability','')||'). Tạo kết nối mới có đủ quyền rồi tạo lại lịch.'
        WHEN 'company_policy_revoked' THEN 'chính sách Hermes của công ty không còn cho phép quyền lịch đang dùng. Quản trị công ty cần bật lại; lịch tạm dừng đến khi đó.'
        WHEN 'company_policy_disabled' THEN 'công ty đang tắt Hermes. Lịch tạm dừng đến khi quản trị bật lại.'
        WHEN 'capability_disabled' THEN 'tính năng này đang tắt trên hệ thống. Lịch tạm dừng đến khi được bật lại.'
        WHEN 'template_disabled' THEN 'chế độ lịch này đang tắt trên hệ thống. Lịch tạm dừng đến khi được bật lại.'
        WHEN 'connection_revoked' THEN 'kết nối Hermes của lịch đã bị thu hồi. Kết nối lại Hermes và tạo lại lịch nếu vẫn cần.'
        WHEN 'connection_token_expired' THEN 'mã kết nối Hermes của lịch đã hết hạn. Kết nối lại Hermes và tạo lại lịch nếu vẫn cần.'
        WHEN 'session_expired' THEN 'phiên CRM của kết nối Hermes đã hết hạn. Kết nối lại Hermes và tạo lại lịch nếu vẫn cần.'
        WHEN 'membership_inactive' THEN 'tài khoản không còn là thành viên đang hoạt động của công ty.'
        WHEN 'scope_narrowed' THEN 'phạm vi tòa nhà của bạn hoặc của kết nối đã bị thu hẹp. Sửa lịch bỏ tòa không còn quyền, hoặc nhờ cấp lại phạm vi.'
        WHEN 'target_denied' THEN 'một số nhóm nhận không còn trong phạm vi được gửi. Các nhóm còn quyền vẫn chạy; sửa lịch để bỏ nhóm này.'
        WHEN 'timezone_changed' THEN 'múi giờ công ty đã đổi. Sửa lịch theo múi giờ mới.'
        WHEN 'zalo_binding_changed' THEN 'liên kết Zalo của Hermes đã đổi. Liên kết lại Zalo rồi tạo lại lịch.'
        WHEN 'zalo_sender_unavailable' THEN 'nick Zalo gửi hoặc worker Zalo chưa sẵn sàng. Kiểm tra kết nối Zalo trong CRM.'
        WHEN 'zalo_directory_too_large' THEN 'nick Zalo gửi có quá nhiều nhóm để kiểm phạm vi an toàn.'
        WHEN 'legacy_owner_active' THEN 'tự động hóa cũ đang gửi phòng trống cho cùng nhóm. Tắt tự động hóa cũ cho nhóm này hoặc bỏ nhóm khỏi lịch.'
        WHEN 'blocked_by_unknown_delivery' THEN 'còn tin trước đó chưa rõ đã tới nhóm hay chưa. Kiểm tra trên Zalo rồi xác nhận ở mục Đối soát trong Trợ lý Hermes; hệ thống không gửi lại tự động.'
        WHEN 'other_owner_delivery_pending' THEN 'tin của lịch khác cho cùng nhóm vẫn đang chờ gửi quá lâu. Kiểm tra hàng chờ Zalo.'
        WHEN 'owner_conflict' THEN 'đã có lịch khác cùng nghiệp vụ cho nhóm và tòa này. Thu hồi một trong hai lịch.'
        WHEN 'queue_capacity' THEN 'hàng chờ gửi Zalo của công ty đang đầy. Lịch sẽ thử lại trong khung giờ cho phép.'
        WHEN 'room_limit' THEN 'số phòng vượt giới hạn của lịch nên chưa gửi, không cắt bớt. Tăng giới hạn phòng hoặc thu hẹp tòa.'
        WHEN 'daily_limit' THEN 'đã chạm trần số tin mỗi ngày của lịch.'
        WHEN 'message_too_large' THEN 'nội dung vượt giới hạn một tin nên chưa gửi, không cắt bớt. Thu hẹp phạm vi lịch.'
        WHEN 'missed_window' THEN 'lịch hôm nay đã quá 180 phút sau giờ hẹn mà chưa xếp hàng được cho mọi nhóm; không gửi bù. Kiểm tra worker Zalo và các báo lỗi khác của lịch.'
        WHEN 'membership_ambiguous' THEN 'tài khoản đang thuộc nhiều công ty nên Hermes tạm dừng truy cập CRM. Nhờ quản trị kiểm tra tư cách thành viên.'
        WHEN 'no_sale_page' THEN 'công ty chưa có trang Sale phòng/link chia sẻ còn hiệu lực nên không có danh sách phòng đang đăng để gửi (không phải hết phòng). Tạo lại hoặc bật lại link chia sẻ ở trang Sale phòng.'
        WHEN 'room_data_changed' THEN 'dữ liệu phòng công khai chưa hợp lệ để lập bản tin. Kiểm tra tên tòa, mã phòng và trạng thái phòng.'
        WHEN 'context_changed' THEN 'quyền hoặc kết nối thay đổi liên tục trong lúc chạy.'
        WHEN 'delivery_failed' THEN 'một tin của lịch chưa gửi được ('||COALESCE(p_detail->>'errorCode','không rõ mã')||'). Không gửi lại tự động; lượt sau chạy theo nhịp.'
        WHEN 'delivery_unknown' THEN 'một tin của lịch chưa rõ đã tới nhóm hay chưa. Kiểm tra trên Zalo rồi xác nhận ở mục Đối soát trong Trợ lý Hermes; hệ thống không gửi lại tự động.'
        WHEN 'grant_expiring' THEN 'ủy quyền lịch hết hạn lúc '||to_char(p_expires AT TIME ZONE 'Asia/Ho_Chi_Minh','HH24:MI DD/MM')||'. Sửa lịch để gia hạn nếu vẫn cần.'
        WHEN 'grant_expired' THEN 'ủy quyền lịch đã hết hạn nên lịch đã dừng. Tạo hoặc sửa lịch nếu muốn tiếp tục.'
        ELSE 'lịch không chạy được (mã '||p_reason||'). Kiểm tra lại cấu hình lịch.' END)
    END
$fn$;

-- Tự kiểm trước khi commit.
DO $assert$
BEGIN
  IF position($q$RAISE EXCEPTION 'hermes_schedule_no_sale_page'$q$ IN pg_get_functiondef('public.hermes_room_schedule_run_v1(uuid,bigint,uuid)'::regprocedure))=0
    OR position($q$WHEN v_message='hermes_schedule_no_sale_page' THEN 'no_sale_page'$q$ IN pg_get_functiondef('public.hermes_room_schedule_run_v2(uuid,bigint,uuid)'::regprocedure))=0
    OR position($q$WHEN 'no_sale_page' THEN$q$ IN pg_get_functiondef('app_private.hermes_schedule_message_v1(text,text,jsonb,text,timestamptz)'::regprocedure))=0
    OR position('left(pl.contact_phone,79)' IN pg_get_functiondef('app_private.hermes_group_room_fact_v1(uuid,uuid)'::regprocedure))=0
    THEN RAISE EXCEPTION 'hermes sale listing no-page source'; END IF;
  IF has_function_privilege('authenticated','public.hermes_room_schedule_run_v2(uuid,bigint,uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role','public.hermes_room_schedule_run_v2(uuid,bigint,uuid)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_group_room_fact_v1(uuid,uuid)','EXECUTE')
    OR has_function_privilege('service_role','app_private.hermes_schedule_message_v1(text,text,jsonb,text,timestamptz)','EXECUTE')
    THEN RAISE EXCEPTION 'hermes sale listing no-page ACL'; END IF;
END
$assert$;
COMMIT;
NOTIFY pgrst,'reload schema';
