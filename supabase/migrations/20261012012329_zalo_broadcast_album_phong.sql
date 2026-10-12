-- Backward-compatible: one attachment object still works; an array is one
-- native Zalo album, with one canonical message and provider receipt per photo.
-- Same signature, service-role ACL, organization lock, quota and time guards.
CREATE OR REPLACE FUNCTION public.zalo_enqueue_broadcast_v1(p_conversation_id uuid,p_body text,p_not_before timestamptz,p_request_key text,p_attachment jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE c public.zalo_conversations; a public.zalo_automations; v_msg uuid; v_job uuid; v_payload jsonb;
  v_now timestamptz:=clock_timestamp(); v_day timestamptz; v_count int; v_cap int; v_reason text; v_key text; v_attachments jsonb; v_attachment jsonb; v_ids jsonb:='[]'; v_item uuid; v_index int:=0;
BEGIN
  IF (btrim(COALESCE(p_body,''))='' AND p_attachment IS NULL) OR length(p_body)>20000 OR p_not_before IS NULL
    OR btrim(COALESCE(p_request_key,''))='' OR length(p_request_key)>300 THEN RAISE EXCEPTION 'Nội dung gửi tự động không hợp lệ' USING ERRCODE='22023'; END IF;
  v_attachments:=CASE WHEN p_attachment IS NULL THEN '[]'::jsonb
    WHEN jsonb_typeof(p_attachment)='object' THEN jsonb_build_array(p_attachment)
    WHEN jsonb_typeof(p_attachment)='array' THEN p_attachment ELSE NULL END;
  IF v_attachments IS NULL OR (p_attachment IS NOT NULL AND jsonb_array_length(v_attachments) NOT BETWEEN 1 AND 12)
    OR (jsonb_typeof(p_attachment)='array' AND btrim(COALESCE(p_body,''))<>'') THEN
    RAISE EXCEPTION 'Album cần 1–12 ảnh và tin thông tin riêng' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||c.organization_id::text,0));
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id FOR SHARE;
  v_key:='automation:broadcast:'||p_request_key;
  SELECT id INTO v_msg FROM public.zalo_messages WHERE conversation_id=c.id AND client_dedup_key=v_key;
  IF FOUND THEN
    SELECT id INTO v_job FROM public.zalo_send_queue WHERE message_id=v_msg
      AND payload->>'automation_request_key'=p_request_key ORDER BY created_at,id LIMIT 1;
    RETURN jsonb_build_object('status','queued','reused',true,'message_id',v_msg,'job_id',v_job,'reason','Tin này đã được xếp hàng');
  END IF;
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=c.organization_id AND kind='broadcast_vacant' FOR SHARE;
  IF NOT FOUND OR NOT a.enabled THEN v_reason:='Lịch gửi đang tắt';
  ELSIF NOT COALESCE(a.config->'recipients' ? c.id::text,false) THEN v_reason:='Hội thoại không còn trong danh sách được chọn';
  ELSIF NOT EXISTS(SELECT 1 FROM public.zalo_accounts x WHERE x.id=c.account_id AND x.organization_id=c.organization_id AND x.kind='personal' AND x.status='connected') THEN v_reason:='Tài khoản chưa kết nối'; END IF;
  v_day:=date_trunc('day',v_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF v_reason IS NULL AND (p_not_before<v_day OR p_not_before>=v_day+interval '1 day') THEN v_reason:='Lịch gửi đã hết hạn trong ngày'; END IF;
  IF v_reason IS NULL AND (NOT app_private.zalo_in_allowed_hours_v1(p_not_before,a.config) OR NOT app_private.zalo_in_allowed_hours_v1(v_now,a.config)) THEN v_reason:='Ngoài khung giờ được phép'; END IF;
  v_cap:=app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000);
  SELECT count(*) INTO v_count FROM public.zalo_send_queue WHERE organization_id=c.organization_id AND payload ? 'tu_dong'
    AND NOT COALESCE(payload->>'auto_reply'='true',false) AND created_at>=v_day AND created_at<v_day+interval '1 day';
  IF v_reason IS NULL AND v_count>=v_cap THEN v_reason:='Đã chạm trần gửi phòng trống trong ngày'; END IF;
  IF v_reason IS NOT NULL THEN RETURN jsonb_build_object('status','skipped','reason',v_reason); END IF;
  -- Validate the entire album before inserting any canonical row. The existing
  -- storage/org guard applies to EVERY image, including later array entries.
  FOR v_attachment IN SELECT jsonb_array_elements(v_attachments) LOOP
    PERFORM app_private.zalo_assert_attachment_v1(c.account_id,v_attachment);
  END LOOP;
  IF jsonb_array_length(v_attachments)=0 THEN
    INSERT INTO public.zalo_messages(user_id,organization_id,conversation_id,account_id,direction,msg_type,body,status,sent_at,client_dedup_key)
      VALUES(c.user_id,c.organization_id,c.id,c.account_id,'out','text',p_body,'pending',v_now,v_key) RETURNING id INTO v_msg;
  ELSE
    FOR v_attachment IN SELECT jsonb_array_elements(v_attachments) LOOP
      INSERT INTO public.zalo_messages(user_id,organization_id,conversation_id,account_id,direction,msg_type,body,media_url,media_meta,status,sent_at,created_at,client_dedup_key)
        VALUES(c.user_id,c.organization_id,c.id,c.account_id,'out','image',COALESCE(p_body,''),v_attachment->>'url',
          (v_attachment-'url')||jsonb_build_object('tu_dong',true,'automation_album_key',v_key,'album_index',v_index,'album_count',jsonb_array_length(v_attachments)),
          'pending',v_now,clock_timestamp(),CASE WHEN v_index=0 THEN v_key ELSE v_key||':image:'||v_index END) RETURNING id INTO v_item;
      IF v_index=0 THEN v_msg:=v_item; END IF;
      v_ids:=v_ids||jsonb_build_array(v_item); v_index:=v_index+1;
    END LOOP;
  END IF;
  v_payload:=jsonb_build_object('body',p_body,'tu_dong',true,'automation_request_key',p_request_key);
  IF jsonb_array_length(v_attachments)>0 THEN
    v_payload:=v_payload||jsonb_build_object('type','image','attachments',v_attachments,'message_ids',v_ids);
  END IF;
  INSERT INTO public.zalo_send_queue(user_id,organization_id,conversation_id,account_id,message_id,channel,payload,status,not_before)
    VALUES(c.user_id,c.organization_id,c.id,c.account_id,v_msg,'personal',v_payload,'queued',greatest(v_now,p_not_before)) RETURNING id INTO v_job;
  UPDATE public.zalo_conversations SET last_message_text=COALESCE(NULLIF(p_body,''),'[Hình ảnh]'),last_message_at=v_now,last_message_dir='out' WHERE id=c.id;
  RETURN jsonb_build_object('status','queued','reused',false,'reason','Đã xếp hàng gửi phòng trống','message_id',v_msg,'job_id',v_job);
END $$;
REVOKE ALL ON FUNCTION public.zalo_enqueue_broadcast_v1(uuid,text,timestamptz,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_enqueue_broadcast_v1(uuid,text,timestamptz,text,jsonb) TO service_role;
