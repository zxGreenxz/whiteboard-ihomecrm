-- Forward only persisted, visible media. Browser supplies IDs, never a URL or
-- provider payload. Requires the guarded queue/receipt migration 20261011052259.
SET LOCAL lock_timeout = '15s';

CREATE OR REPLACE FUNCTION app_private.zalo_forward_sources_v1(p_ids uuid[],p_org uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE m public.zalo_messages; v_org uuid; v_account uuid; v_conv uuid; v_kind text;
  v_id uuid; v_items jsonb:='[]'; v_caption text; v_image_captions text[]:='{}';
BEGIN
  IF COALESCE(cardinality(p_ids),0) NOT BETWEEN 1 AND 12 OR array_position(p_ids,NULL) IS NOT NULL
    OR cardinality(p_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_ids) x) THEN
    RAISE EXCEPTION 'Chọn tối đa 12 ảnh hoặc một video, tin thoại, tệp' USING ERRCODE='22023'; END IF;
  FOREACH v_id IN ARRAY p_ids LOOP
    SELECT * INTO m FROM public.zalo_messages WHERE id=v_id;
    IF NOT FOUND OR m.organization_id IS NULL OR (p_org IS NOT NULL AND m.organization_id IS DISTINCT FROM p_org)
      OR m.hidden_at IS NOT NULL OR m.status NOT IN ('sent','delivered','seen')
      OR m.msg_type NOT IN ('image','video','voice','file') OR NULLIF(btrim(m.media_url),'') IS NULL
      OR NOT EXISTS(SELECT 1 FROM public.zalo_conversations c JOIN public.zalo_accounts a ON a.id=c.account_id
        WHERE c.id=m.conversation_id AND c.account_id=m.account_id AND c.organization_id=m.organization_id AND a.organization_id=m.organization_id) THEN
      RAISE EXCEPTION 'Tin nguồn không còn khả dụng để chuyển tiếp' USING ERRCODE='42501'; END IF;
    IF v_org IS NULL THEN v_org:=m.organization_id; v_account:=m.account_id; v_conv:=m.conversation_id; v_kind:=m.msg_type; END IF;
    IF m.organization_id IS DISTINCT FROM v_org OR m.account_id IS DISTINCT FROM v_account
      OR m.conversation_id IS DISTINCT FROM v_conv OR m.msg_type IS DISTINCT FROM v_kind THEN
      RAISE EXCEPTION 'Tin nguồn phải cùng hội thoại và cùng loại' USING ERRCODE='22023'; END IF;
    IF m.msg_type='image' AND NULLIF(btrim(m.body),'') IS NOT NULL AND btrim(m.body) !~* '^\[Hình ảnh\]$'
      AND NOT (btrim(m.body)=ANY(v_image_captions)) THEN
      v_image_captions:=array_append(v_image_captions,btrim(m.body));
    ELSIF m.msg_type='file' AND v_caption IS NULL AND NULLIF(btrim(m.body),'') IS NOT NULL
      AND btrim(m.body) !~* '^\[(Tệp tin|Tệp đính kèm)\]$'
      AND btrim(m.body) IS DISTINCT FROM btrim(m.media_label) AND btrim(m.body) IS DISTINCT FROM btrim(m.media_meta->>'filename') THEN v_caption:=btrim(m.body); END IF;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('id',m.id,'body',m.body,'media_url',m.media_url,
      'media_meta',m.media_meta,'media_label',m.media_label,'media_tone',m.media_tone));
  END LOOP;
  -- Adjacent images can form one UI album even when their captions differ.
  -- Keep every distinct trimmed caption in source order in one text receipt.
  IF v_kind='image' THEN v_caption:=NULLIF(array_to_string(v_image_captions,E'\n'),''); END IF;
  IF cardinality(p_ids)>1 AND v_kind<>'image' THEN RAISE EXCEPTION 'Chỉ ảnh hỗ trợ chuyển tiếp theo album' USING ERRCODE='22023'; END IF;
  RETURN jsonb_build_object('organization_id',v_org,'account_id',v_account,'conversation_id',v_conv,'kind',v_kind,'items',v_items,'caption',v_caption);
END $$;
REVOKE ALL ON FUNCTION app_private.zalo_forward_sources_v1(uuid[],uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.zalo_forward_media_v1(p_source_message_ids uuid[],p_conversation_ids uuid[],p_client_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE v_actor uuid:=auth.uid(); v_source jsonb; v_org uuid; v_targets uuid[]; v_target uuid;
  v_key text; v_fingerprint text; v_existing_fingerprint text; v_result jsonb:='[]'; v_receipt jsonb;
  c public.zalo_conversations; q public.zalo_send_queue; v_item jsonb; v_messages uuid[]; v_message uuid; v_caption_id uuid;
  v_payload jsonb; v_job uuid; v_ordinal int; v_caption text; v_now timestamptz:=clock_timestamp();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF p_client_request_id IS NULL OR COALESCE(cardinality(p_conversation_ids),0) NOT BETWEEN 1 AND 100
    OR array_position(p_conversation_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'Chọn từ 1 đến 100 hội thoại nhận' USING ERRCODE='22023'; END IF;
  SELECT array_agg(DISTINCT x ORDER BY x) INTO v_targets FROM unnest(p_conversation_ids) x;
  v_key:='forward:'||v_actor::text||':'||p_client_request_id::text;
  -- Actor/request lock serializes retries, including different target sets. The
  -- first canonical message retains this key after echo finalization.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_key,0));
  v_fingerprint:=encode(sha256(convert_to(jsonb_build_object('sources',p_source_message_ids,'targets',v_targets)::text,'UTF8')),'hex');
  SELECT z.payload->>'source_fingerprint',z.organization_id INTO v_existing_fingerprint,v_org FROM public.zalo_messages m
    JOIN public.zalo_send_queue z ON z.message_id=m.id WHERE m.sent_by=v_actor AND m.client_dedup_key=v_key ORDER BY z.created_at,z.id LIMIT 1;
  IF FOUND THEN
    IF NOT public.zalo_can('view',v_org) OR NOT public.zalo_can('send',v_org) THEN RAISE EXCEPTION 'Bạn không có quyền chuyển tiếp tin này' USING ERRCODE='42501'; END IF;
    IF v_existing_fingerprint IS DISTINCT FROM v_fingerprint THEN
    SELECT jsonb_agg(jsonb_build_object('conversation_id',x,'status','rejected','error','Mã yêu cầu đã được dùng cho nguồn hoặc danh sách nhận khác'))
      INTO v_result FROM unnest(v_targets) x;
    RETURN jsonb_build_object('recipients',v_result);
    END IF;
  ELSE
    v_source:=app_private.zalo_forward_sources_v1(p_source_message_ids);
    v_org:=(v_source->>'organization_id')::uuid;
    IF NOT public.zalo_can('view',v_org) OR NOT public.zalo_can('send',v_org) THEN RAISE EXCEPTION 'Bạn không có quyền chuyển tiếp tin này' USING ERRCODE='42501'; END IF;
  END IF;
  FOREACH v_target IN ARRAY v_targets LOOP
    -- A failing recipient rolls back its messages and queue together. Other
    -- selected recipients keep their independently reviewable receipts.
    BEGIN
      SELECT * INTO c FROM public.zalo_conversations WHERE id=v_target FOR UPDATE;
      IF NOT FOUND OR c.organization_id IS DISTINCT FROM v_org OR NOT public.zalo_can('send',c.organization_id)
        OR NOT EXISTS(SELECT 1 FROM public.zalo_accounts a WHERE a.id=c.account_id AND a.organization_id=v_org AND a.kind='personal') THEN
        RAISE EXCEPTION 'Không có quyền gửi đến hội thoại này' USING ERRCODE='42501'; END IF;
      SELECT z.* INTO q FROM public.zalo_messages m JOIN public.zalo_send_queue z ON z.message_id=m.id
        WHERE m.conversation_id=c.id AND m.client_dedup_key=v_key ORDER BY z.created_at,z.id LIMIT 1;
      IF FOUND THEN
        IF q.payload->>'source_fingerprint' IS DISTINCT FROM v_fingerprint THEN RAISE EXCEPTION 'Mã yêu cầu đã được sử dụng' USING ERRCODE='22023'; END IF;
        v_receipt:=jsonb_build_object('conversation_id',c.id,'status','queued','message_ids',q.payload->'message_ids','job_id',q.id,'reused',true);
        IF q.payload ? 'caption_message_id' THEN v_receipt:=v_receipt||jsonb_build_object('caption_message_id',q.payload->'caption_message_id'); END IF;
      ELSE
        -- A known receipt survives later recall/hiding. A previously rejected
        -- destination can enqueue only if the source is still eligible now.
        IF v_source IS NULL THEN v_source:=app_private.zalo_forward_sources_v1(p_source_message_ids,v_org); END IF;
        v_caption:=CASE WHEN cardinality(p_source_message_ids)>1 OR v_source->>'kind'='file' THEN v_source->>'caption' ELSE NULL END;
        IF NOT EXISTS(SELECT 1 FROM public.zalo_accounts a WHERE a.id=c.account_id AND a.status='connected') THEN
          RAISE EXCEPTION 'Tài khoản Zalo chưa kết nối' USING ERRCODE='55000'; END IF;
        v_messages:='{}'; v_caption_id:=NULL; v_ordinal:=0;
        FOR v_item IN SELECT value FROM jsonb_array_elements(v_source->'items') LOOP
          v_ordinal:=v_ordinal+1;
          INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,media_url,media_meta,media_label,media_tone,status,sent_by,sent_at,client_dedup_key)
            VALUES(c.user_id,v_org,c.account_id,c.id,'out',v_source->>'kind',CASE WHEN v_caption IS NULL THEN v_item->>'body' WHEN v_source->>'kind'='image' THEN '[Hình ảnh]' ELSE v_item->>'media_label' END,v_item->>'media_url',NULLIF(v_item->'media_meta','null'),
              v_item->>'media_label',v_item->>'media_tone','pending',v_actor,v_now,v_key||CASE WHEN v_ordinal=1 THEN '' ELSE ':'||v_ordinal::text END) RETURNING id INTO v_message;
          v_messages:=array_append(v_messages,v_message);
        END LOOP;
        IF v_caption IS NOT NULL THEN
          INSERT INTO public.zalo_messages(user_id,organization_id,account_id,conversation_id,direction,msg_type,body,status,sent_by,sent_at,client_dedup_key)
            VALUES(c.user_id,v_org,c.account_id,c.id,'out','text',v_caption,'pending',v_actor,v_now,v_key||':caption') RETURNING id INTO v_caption_id;
          v_messages:=array_append(v_messages,v_caption_id);
        END IF;
        v_payload:=jsonb_build_object('kind','forward_media','source_message_ids',p_source_message_ids,'forwarding_request_id',p_client_request_id,
          'source_fingerprint',v_fingerprint,'message_ids',v_messages);
        IF v_caption_id IS NOT NULL THEN v_payload:=v_payload||jsonb_build_object('caption_message_id',v_caption_id,'caption',v_caption); END IF;
        INSERT INTO public.zalo_send_queue(user_id,organization_id,account_id,conversation_id,message_id,channel,payload,status)
          VALUES(c.user_id,v_org,c.account_id,c.id,v_messages[1],'personal',v_payload,'queued') RETURNING id INTO v_job;
        UPDATE public.zalo_conversations SET last_message_text=COALESCE(v_caption,v_source#>>'{items,0,body}','[Tệp đính kèm]'),last_message_at=v_now,last_message_dir='out' WHERE id=c.id;
        v_receipt:=jsonb_build_object('conversation_id',c.id,'status','queued','message_ids',v_messages,'job_id',v_job,'reused',false);
        IF v_caption_id IS NOT NULL THEN v_receipt:=v_receipt||jsonb_build_object('caption_message_id',v_caption_id); END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      v_receipt:=jsonb_build_object('conversation_id',v_target,'status','rejected','error',CASE
        WHEN SQLSTATE='55000' THEN 'Tài khoản Zalo chưa kết nối'
        WHEN SQLSTATE='42501' THEN 'Không có quyền gửi đến hội thoại này'
        ELSE 'Không thể xếp hàng hội thoại này; hãy thử lại' END);
    END;
    v_result:=v_result||jsonb_build_array(v_receipt);
  END LOOP;
  RETURN jsonb_build_object('recipients',v_result);
END $$;
REVOKE ALL ON FUNCTION public.zalo_forward_media_v1(uuid[],uuid[],uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.zalo_forward_media_v1(uuid[],uuid[],uuid) TO authenticated;

CREATE OR REPLACE FUNCTION app_private.zalo_guard_forward_media_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE v_ids uuid[]; v_dest uuid[]; v_source jsonb; v_caption uuid; v_count int; v_id uuid; v_ord int:=0;
BEGIN
  IF NEW.payload->>'kind' IS DISTINCT FROM 'forward_media' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND (NEW.organization_id,NEW.account_id,NEW.conversation_id,NEW.message_id,NEW.payload)
    IS NOT DISTINCT FROM (OLD.organization_id,OLD.account_id,OLD.conversation_id,OLD.message_id,OLD.payload)
    AND TG_ARGV[0] IS DISTINCT FROM 'provider' THEN RETURN NEW; END IF;
  IF jsonb_typeof(NEW.payload->'source_message_ids') IS DISTINCT FROM 'array' OR jsonb_typeof(NEW.payload->'message_ids') IS DISTINCT FROM 'array'
    OR NEW.payload->>'source_fingerprint' IS NULL OR NEW.payload->>'source_fingerprint' !~ '^[0-9a-f]{64}$'
    OR NULLIF(NEW.payload->>'forwarding_request_id','') IS NULL OR NEW.payload ?| ARRAY['attachments','action','tu_dong'] THEN
    RAISE EXCEPTION 'Nội dung chuyển tiếp không hợp lệ' USING ERRCODE='22023'; END IF;
  PERFORM (NEW.payload->>'forwarding_request_id')::uuid;
  SELECT array_agg(value::uuid ORDER BY ord) INTO v_ids FROM jsonb_array_elements_text(NEW.payload->'source_message_ids') WITH ORDINALITY a(value,ord);
  SELECT array_agg(value::uuid ORDER BY ord) INTO v_dest FROM jsonb_array_elements_text(NEW.payload->'message_ids') WITH ORDINALITY a(value,ord);
  v_source:=app_private.zalo_forward_sources_v1(v_ids,NEW.organization_id);
  v_caption:=(NEW.payload->>'caption_message_id')::uuid; v_count:=cardinality(v_ids);
  IF cardinality(v_dest) IS DISTINCT FROM (v_count+CASE WHEN v_caption IS NULL THEN 0 ELSE 1 END)
    OR cardinality(v_dest)<>(SELECT count(DISTINCT x) FROM unnest(v_dest) x) OR NEW.message_id IS DISTINCT FROM v_dest[1]
    OR (v_caption IS NOT NULL AND ((v_count<2 AND v_source->>'kind'<>'file') OR v_caption IS DISTINCT FROM v_dest[v_count+1] OR NULLIF(btrim(NEW.payload->>'caption'),'') IS NULL)) THEN
    RAISE EXCEPTION 'Danh sách tin chuyển tiếp không khớp' USING ERRCODE='42501'; END IF;
  FOREACH v_id IN ARRAY v_dest LOOP
    v_ord:=v_ord+1;
    IF NOT EXISTS(SELECT 1 FROM public.zalo_messages m WHERE m.id=v_id AND m.organization_id=NEW.organization_id
      AND m.account_id=NEW.account_id AND m.conversation_id=NEW.conversation_id AND m.direction='out'
      AND m.msg_type=CASE WHEN v_id=v_caption THEN 'text' ELSE v_source->>'kind' END
      AND (v_id IS DISTINCT FROM v_caption OR m.body=NEW.payload->>'caption')) THEN
      RAISE EXCEPTION 'Tin chuyển tiếp không thuộc hàng đợi này' USING ERRCODE='42501'; END IF;
  END LOOP;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.zalo_guard_forward_media_v1() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS zz_zalo_guard_forward_media ON public.zalo_send_queue;
CREATE TRIGGER zz_zalo_guard_forward_media BEFORE INSERT OR UPDATE OF organization_id,account_id,conversation_id,message_id,payload
  ON public.zalo_send_queue FOR EACH ROW EXECUTE FUNCTION app_private.zalo_guard_forward_media_v1();
-- begin_provider updates this column on EVERY provider call, including upload
-- followed by send. Recheck recall/hidden/org scope at that boundary, not only enqueue.
DROP TRIGGER IF EXISTS zz_zalo_guard_forward_provider ON public.zalo_send_queue;
CREATE TRIGGER zz_zalo_guard_forward_provider BEFORE UPDATE OF provider_started_at ON public.zalo_send_queue
  FOR EACH ROW WHEN (NEW.provider_started_at IS NOT NULL) EXECUTE FUNCTION app_private.zalo_guard_forward_media_v1('provider');
