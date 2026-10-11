-- Zalo: browser writes only through guarded RPCs; worker reservations and recovery
-- are transactional. Verified catalog before change: authenticated had ALL table
-- privileges; CRM references had no organization guard. No data backfill/deletion.
-- Run through the forward lane; the caller owns the transaction.
SET LOCAL lock_timeout = '15s';

DO $acl$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_accounts','zalo_conversations','zalo_messages',
    'zalo_send_queue','zalo_labels','zalo_message_templates','zalo_automations'] LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated',t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role',t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I',t||'_org_write',t);
  END LOOP;
END $acl$;

ALTER TABLE public.zalo_send_queue ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;
ALTER TABLE public.zalo_send_queue ADD COLUMN IF NOT EXISTS provider_started_at timestamptz;
ALTER TABLE public.zalo_send_queue ADD COLUMN IF NOT EXISTS processing_instance_id uuid;
ALTER TABLE public.zalo_automation_runs ADD COLUMN IF NOT EXISTS source_zalo_msg_id text;
CREATE UNIQUE INDEX IF NOT EXISTS zalo_auto_reply_source_once_idx
  ON public.zalo_automation_runs(conversation_id,source_zalo_msg_id)
  WHERE kind='auto_reply' AND mode='reply' AND source_zalo_msg_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS zalo_queue_auto_day_idx
  ON public.zalo_send_queue(organization_id,created_at)
  WHERE payload ? 'tu_dong';

CREATE OR REPLACE FUNCTION public.zalo_worker_attachment_allowed_v1(p_org uuid,p_account uuid,p_bucket text,p_path text)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
BEGIN
  IF p_org IS NULL OR p_account IS NULL OR p_path IS NULL OR p_path='' OR length(p_path)>1024
     OR p_path ~ '(^|/)\.{1,2}(/|$)' OR p_path ~ '[\\%]' OR p_path LIKE '%//%'
     OR NOT EXISTS(SELECT 1 FROM public.zalo_accounts x WHERE x.id=p_account AND x.organization_id=p_org)
     OR NOT EXISTS(SELECT 1 FROM storage.objects o WHERE o.bucket_id=p_bucket AND o.name=p_path) THEN RETURN false; END IF;
  IF p_bucket='zalo-media' THEN
    -- One generated table image is shared by the company's selected accounts.
    RETURN EXISTS(SELECT 1 FROM public.zalo_accounts x WHERE x.id::text=split_part(p_path,'/',1) AND x.organization_id=p_org);
  ELSIF p_bucket='room-sale-images' THEN
    -- Existing sale images are keyed by uploader UUID, not by account/org.
    -- A storage key is shareable only when referenced by this organization's
    -- current room/building image list; arbitrary private buckets stay denied.
    RETURN EXISTS(
      SELECT 1 FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.images)='array' THEN r.images ELSE '[]'::jsonb END) i(url)
      WHERE r.organization_id=p_org AND b.organization_id=p_org AND r.deleted_at IS NULL AND b.deleted_at IS NULL
        AND (ltrim(i.url,'/')=p_path OR (split_part(i.url,'?',1) ~ '/object/(public|sign|authenticated)/room-sale-images/'
        AND regexp_replace(split_part(i.url,'?',1),'^.*?/object/(public|sign|authenticated)/room-sale-images/','')=p_path))
      UNION ALL
      SELECT 1 FROM public.buildings b
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(b.images)='array' THEN b.images ELSE '[]'::jsonb END) i(url)
      WHERE b.organization_id=p_org AND b.deleted_at IS NULL
        AND (ltrim(i.url,'/')=p_path OR (split_part(i.url,'?',1) ~ '/object/(public|sign|authenticated)/room-sale-images/'
        AND regexp_replace(split_part(i.url,'?',1),'^.*?/object/(public|sign|authenticated)/room-sale-images/','')=p_path))
    );
  END IF;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.zalo_worker_attachment_allowed_v1(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_attachment_allowed_v1(uuid,uuid,text,text) TO service_role;

CREATE OR REPLACE FUNCTION app_private.zalo_assert_attachment_v1(p_account_id uuid,p_attachment jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.zalo_accounts WHERE id=p_account_id;
  IF jsonb_typeof(p_attachment) IS DISTINCT FROM 'object'
     OR NOT public.zalo_worker_attachment_allowed_v1(v_org,p_account_id,p_attachment->>'bucket',p_attachment->>'path') THEN
    RAISE EXCEPTION 'Tệp Zalo không thuộc tổ chức của hội thoại' USING ERRCODE='42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION app_private.zalo_assert_attachment_v1(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Run after autofill (triggers of the same timing run in alphabetical order).
-- An UPDATE of status/preview alone must remain possible for legacy bad rows;
-- every new or changed relationship is checked, including service-role writes.
CREATE OR REPLACE FUNCTION app_private.zalo_guard_relations_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE j jsonb:=to_jsonb(NEW); old_j jsonb; c public.zalo_conversations;
  m public.zalo_messages; v_org uuid; v_id uuid; a jsonb; v_text text;
BEGIN
  IF TG_OP='UPDATE' THEN
    old_j:=to_jsonb(OLD);
    IF (j->'organization_id',j->'account_id',j->'conversation_id',j->'message_id',j->'customer_id',j->'lead_id',j->'contract_id',j->'room_id',j->'payload')
       IS NOT DISTINCT FROM
       (old_j->'organization_id',old_j->'account_id',old_j->'conversation_id',old_j->'message_id',old_j->'customer_id',old_j->'lead_id',old_j->'contract_id',old_j->'room_id',old_j->'payload') THEN RETURN NEW; END IF;
  END IF;
  v_org:=(j->>'organization_id')::uuid;
  IF v_org IS NULL THEN RAISE EXCEPTION 'Zalo thiếu tổ chức' USING ERRCODE='23502'; END IF;
  IF j->>'account_id' IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.zalo_accounts x WHERE x.id=(j->>'account_id')::uuid AND x.organization_id=v_org) THEN
    RAISE EXCEPTION 'Tài khoản Zalo khác tổ chức' USING ERRCODE='42501';
  END IF;
  IF TG_TABLE_NAME='zalo_conversations' THEN
    IF NEW.customer_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.customers x WHERE x.id=NEW.customer_id AND x.organization_id=v_org) THEN
      RAISE EXCEPTION 'Khách hàng khác tổ chức' USING ERRCODE='42501'; END IF;
    IF NEW.lead_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.leads x WHERE x.id=NEW.lead_id AND x.organization_id=v_org) THEN
      RAISE EXCEPTION 'Lead khác tổ chức' USING ERRCODE='42501'; END IF;
    IF NEW.contract_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.contracts x WHERE x.id=NEW.contract_id AND x.organization_id=v_org) THEN
      RAISE EXCEPTION 'Hợp đồng khác tổ chức' USING ERRCODE='42501'; END IF;
    IF NEW.room_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms x JOIN public.buildings b ON b.id=x.building_id
      WHERE x.id=NEW.room_id AND x.organization_id=v_org AND b.organization_id=v_org) THEN
      RAISE EXCEPTION 'Phòng khác tổ chức' USING ERRCODE='42501'; END IF;
  ELSE
    IF j->>'conversation_id' IS NOT NULL THEN
      SELECT * INTO c FROM public.zalo_conversations WHERE id=(j->>'conversation_id')::uuid;
      IF NOT FOUND OR c.organization_id IS DISTINCT FROM v_org OR c.account_id IS DISTINCT FROM (j->>'account_id')::uuid THEN
        RAISE EXCEPTION 'Hội thoại không khớp tài khoản và tổ chức' USING ERRCODE='42501'; END IF;
    END IF;
    IF TG_TABLE_NAME='zalo_send_queue' THEN
      IF NEW.message_id IS NOT NULL THEN
        SELECT * INTO m FROM public.zalo_messages WHERE id=NEW.message_id;
        IF NOT FOUND OR m.organization_id IS DISTINCT FROM v_org OR m.account_id IS DISTINCT FROM NEW.account_id
          OR m.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
          RAISE EXCEPTION 'Tin nhắn không thuộc hàng đợi này' USING ERRCODE='42501'; END IF;
      END IF;
      IF NEW.payload ? 'message_ids' THEN
        IF jsonb_typeof(NEW.payload->'message_ids') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Danh sách tin nhắn không hợp lệ' USING ERRCODE='22023'; END IF;
        FOR v_text IN SELECT jsonb_array_elements_text(NEW.payload->'message_ids') LOOP
          BEGIN v_id:=v_text::uuid; EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'Mã tin nhắn không hợp lệ' USING ERRCODE='22023'; END;
          IF NOT EXISTS(SELECT 1 FROM public.zalo_messages x WHERE x.id=v_id AND x.organization_id=v_org
            AND x.account_id=NEW.account_id AND x.conversation_id=NEW.conversation_id) THEN
            RAISE EXCEPTION 'Tin đính kèm thuộc hội thoại khác' USING ERRCODE='42501'; END IF;
        END LOOP;
      END IF;
      IF NEW.payload ? 'attachments' THEN
        IF jsonb_typeof(NEW.payload->'attachments') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'Danh sách tệp không hợp lệ' USING ERRCODE='22023'; END IF;
        FOR a IN SELECT jsonb_array_elements(NEW.payload->'attachments') LOOP
          PERFORM app_private.zalo_assert_attachment_v1(NEW.account_id,a);
        END LOOP;
      END IF;
      IF NEW.payload ? 'thread_id' AND c.id IS NOT NULL AND NEW.payload->>'thread_id' IS DISTINCT FROM c.thread_id THEN
        RAISE EXCEPTION 'Thread không khớp hội thoại' USING ERRCODE='42501'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app_private.zalo_guard_relations_v1() FROM PUBLIC,anon,authenticated,service_role;
DO $triggers$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_conversations','zalo_messages','zalo_send_queue'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS zz_zalo_guard_relations ON public.%I',t);
    EXECUTE format('CREATE TRIGGER zz_zalo_guard_relations BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION app_private.zalo_guard_relations_v1()',t);
  END LOOP;
END $triggers$;

-- SECURITY INVOKER keeps customers/leads RLS and owner visibility. Building
-- checks are explicit as well: a linked UUID never expands the caller's scope.
CREATE OR REPLACE FUNCTION public.zalo_get_crm_summary(p_conversation_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE c public.zalo_conversations; v_out jsonb:='{}'; v_part jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF NOT public.zalo_can('view',c.organization_id) THEN RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('customer',jsonb_build_object('id',x.id,'full_name',x.full_name,'phone',x.phone,
    'avatar_url',x.avatar_url,'customer_type',x.customer_type,'status',x.status_v2)) INTO v_part
    FROM public.customers x WHERE x.id=c.customer_id AND x.organization_id=c.organization_id AND x.deleted_at IS NULL;
  v_out:=v_out||COALESCE(v_part,'{}');
  SELECT jsonb_build_object('lead',jsonb_build_object('id',x.id,'customer_name',x.customer_name,'phone',x.phone,
    'status',x.status::text,'source',x.source,'budget_min',x.budget_min,'budget_max',x.budget_max,
    'move_in_date',x.move_in_date,'next_follow_up_date',x.next_follow_up_date)) INTO v_part
    FROM public.leads x WHERE x.id=c.lead_id AND x.organization_id=c.organization_id AND x.deleted_at IS NULL
      AND (x.building_id IS NULL OR public.can_access_building(x.building_id));
  v_out:=v_out||COALESCE(v_part,'{}');
  SELECT jsonb_build_object('contract',jsonb_build_object('id',x.id,'contract_number',x.contract_number,
    'status',x.status::text,'start_date',x.start_date,'end_date',x.end_date,'rent_price',x.rent_price,'payment_cycle',x.payment_cycle)) INTO v_part
    FROM public.contracts x JOIN public.rooms r ON r.id=x.room_id JOIN public.buildings b ON b.id=r.building_id
    WHERE x.id=c.contract_id AND x.organization_id=c.organization_id AND r.organization_id=c.organization_id
      AND b.organization_id=c.organization_id AND x.deleted_at IS NULL AND r.deleted_at IS NULL AND b.deleted_at IS NULL
      AND public.can_access_building(b.id);
  v_out:=v_out||COALESCE(v_part,'{}');
  SELECT jsonb_build_object('room',jsonb_build_object('id',r.id,'code',r.code,'name',r.name,'floor',r.floor,'building_name',b.name)) INTO v_part
    FROM public.rooms r JOIN public.buildings b ON b.id=r.building_id
    WHERE r.id=c.room_id AND r.organization_id=c.organization_id AND b.organization_id=c.organization_id
      AND r.deleted_at IS NULL AND b.deleted_at IS NULL AND public.can_access_building(b.id);
  RETURN NULLIF(v_out||COALESCE(v_part,'{}'),'{}'::jsonb);
END $$;
REVOKE ALL ON FUNCTION public.zalo_get_crm_summary(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.zalo_get_crm_summary(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.zalo_link_conversation(p_conversation_id uuid,p_customer_id uuid DEFAULT NULL,p_lead_id uuid DEFAULT NULL)
RETURNS public.zalo_conversations LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE c public.zalo_conversations; v_contract uuid; v_room uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF (p_customer_id IS NULL)=(p_lead_id IS NULL) THEN RAISE EXCEPTION 'Chọn đúng một khách hàng hoặc lead' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id FOR UPDATE;
  IF NOT FOUND OR NOT public.zalo_can('send',c.organization_id) THEN RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE='42501'; END IF;
  IF p_customer_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM public.customers x WHERE x.id=p_customer_id AND x.organization_id=c.organization_id AND x.deleted_at IS NULL
      AND public.can_access_org_entity('customers','view') AND x.user_id=ANY(public.current_visible_owner_ids())
      AND NOT ((public.is_super_admin() OR public.is_admin()) AND x.user_id=ANY(public.demo_user_ids()))) THEN
      RAISE EXCEPTION 'Không được liên kết khách hàng này' USING ERRCODE='42501'; END IF;
    SELECT ct.id,ct.room_id INTO v_contract,v_room FROM public.tenants t
      JOIN public.contracts ct ON ct.tenant_id=t.id JOIN public.rooms r ON r.id=ct.room_id
      JOIN public.buildings b ON b.id=r.building_id
      WHERE t.organization_id=c.organization_id AND ct.organization_id=c.organization_id AND r.organization_id=c.organization_id
        AND b.organization_id=c.organization_id AND t.deleted_at IS NULL AND ct.deleted_at IS NULL AND r.deleted_at IS NULL AND b.deleted_at IS NULL
        AND ct.status IN ('ACTIVE','EXTENDED') AND public.can_access_building(b.id)
        AND public.phone_digits(t.phone)=(SELECT public.phone_digits(x.phone) FROM public.customers x WHERE x.id=p_customer_id)
      ORDER BY ct.start_date DESC NULLS LAST,ct.id LIMIT 1;
    UPDATE public.zalo_conversations SET customer_id=p_customer_id,lead_id=NULL,contract_id=v_contract,room_id=v_room,
      kind='tenant',profile=jsonb_set(COALESCE(profile,'{}'),'{kind}','"tenant"'),updated_at=now()
      WHERE id=c.id RETURNING * INTO c;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.leads x WHERE x.id=p_lead_id AND x.organization_id=c.organization_id AND x.deleted_at IS NULL
      AND CASE WHEN x.building_id IS NULL THEN public.can_access_org_entity('leads','view') ELSE public.can_access_building(x.building_id) END
      AND NOT ((public.is_super_admin() OR public.is_admin()) AND x.user_id=ANY(public.demo_user_ids()))) THEN
      RAISE EXCEPTION 'Không được liên kết lead này' USING ERRCODE='42501'; END IF;
    UPDATE public.zalo_conversations SET customer_id=NULL,lead_id=p_lead_id,contract_id=NULL,room_id=NULL,
      kind='lead',profile=jsonb_set(COALESCE(profile,'{}'),'{kind}','"lead"'),updated_at=now()
      WHERE id=c.id RETURNING * INTO c;
  END IF;
  RETURN c;
END $$;
REVOKE ALL ON FUNCTION public.zalo_link_conversation(uuid,uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.zalo_link_conversation(uuid,uuid,uuid) TO authenticated;

-- Helpers below are private; service-only public entry points own their locks.
CREATE OR REPLACE FUNCTION app_private.zalo_config_int_v1(p_value jsonb,p_default integer,p_max integer)
RETURNS integer LANGUAGE plpgsql IMMUTABLE SET search_path TO 'pg_catalog'
AS $$
DECLARE n numeric;
BEGIN
  IF p_value IS NULL THEN RETURN p_default; END IF;
  IF p_value='null'::jsonb OR jsonb_typeof(p_value)='boolean' OR btrim(p_value#>>'{}')='' THEN RETURN 1; END IF;
  n:=(p_value#>>'{}')::numeric;
  IF n IS NULL OR n IN ('NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric) THEN RETURN p_default; END IF;
  RETURN greatest(1,least(p_max,round(n)))::integer;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN p_default;
END $$;
CREATE OR REPLACE FUNCTION app_private.zalo_in_allowed_hours_v1(p_at timestamptz,p_config jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path TO 'pg_catalog'
AS $$
DECLARE f text:=p_config#>>'{antiSpam,allowedHours,from}'; t text:=p_config#>>'{antiSpam,allowedHours,to}';
  lo integer; hi integer; minute_now integer;
BEGIN
  IF f IS NULL OR f !~ '^([01]?[0-9]|2[0-3]):([0-5]?[0-9])$' THEN f:='08:00'; END IF;
  IF t IS NULL OR t !~ '^([01]?[0-9]|2[0-3]):([0-5]?[0-9])$' THEN t:='20:00'; END IF;
  lo:=split_part(f,':',1)::int*60+split_part(f,':',2)::int;
  hi:=split_part(t,':',1)::int*60+split_part(t,':',2)::int;
  minute_now:=extract(hour FROM p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int*60+extract(minute FROM p_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::int;
  RETURN CASE WHEN lo<=hi THEN minute_now BETWEEN lo AND hi ELSE minute_now>=lo OR minute_now<=hi END;
END $$;
REVOKE ALL ON FUNCTION app_private.zalo_config_int_v1(jsonb,integer,integer),app_private.zalo_in_allowed_hours_v1(timestamptz,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.zalo_enqueue_auto_reply_v1(p_conversation_id uuid,p_body text,p_source_zalo_msg_id text,p_detail jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE c public.zalo_conversations; a public.zalo_automations; r public.zalo_automation_runs;
  v_cap int; v_cooldown int; v_count int; v_msg uuid; v_job uuid; v_run uuid; v_now timestamptz:=clock_timestamp();
  v_day timestamptz; v_reason text; v_source public.zalo_messages; v_keyword text; v_keywords jsonb; v_blocked jsonb;
BEGIN
  IF btrim(COALESCE(p_body,''))='' OR length(p_body)>20000 OR btrim(COALESCE(p_source_zalo_msg_id,''))='' OR length(p_source_zalo_msg_id)>300
    OR jsonb_typeof(p_detail) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Nội dung tự động không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||c.organization_id::text,0));
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id FOR SHARE;
  SELECT * INTO r FROM public.zalo_automation_runs WHERE conversation_id=c.id AND kind='auto_reply' AND mode='reply' AND source_zalo_msg_id=p_source_zalo_msg_id;
  IF FOUND THEN RETURN jsonb_build_object('status','queued','reused',true,'run_id',r.id,'message_id',r.detail->>'message_id','job_id',r.detail->>'job_id','reason','Nguồn tin này đã được xếp hàng'); END IF;
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=c.organization_id AND kind='auto_reply' FOR SHARE;
  IF NOT FOUND OR NOT a.enabled THEN v_reason:='Tự động trả lời đang tắt';
  ELSIF NOT c.is_sale_partner THEN v_reason:='Hội thoại chưa được đánh dấu sale';
  ELSIF NOT EXISTS(SELECT 1 FROM public.zalo_accounts x WHERE x.id=c.account_id AND x.organization_id=c.organization_id AND x.kind='personal' AND x.status='connected') THEN v_reason:='Tài khoản chưa kết nối'; END IF;
  SELECT * INTO v_source FROM public.zalo_messages WHERE conversation_id=c.id AND account_id=c.account_id
    AND organization_id=c.organization_id AND direction='in' AND zalo_msg_id=p_source_zalo_msg_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không có tin đến làm nguồn trả lời' USING ERRCODE='42501'; END IF;
  v_keywords:=CASE WHEN jsonb_typeof(a.config->'keywords')='array' THEN a.config->'keywords' ELSE '["phòng","giá","trống","còn ko","còn không","xem phòng"]'::jsonb END;
  v_blocked:=CASE WHEN jsonb_typeof(a.config->'blockedKeywords')='array' THEN a.config->'blockedKeywords' ELSE '["cọc","chuyển khoản","hợp đồng","thanh toán","hoá đơn","hóa đơn","khiếu nại","hoàn tiền"]'::jsonb END;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_blocked) k WHERE btrim(COALESCE(k,''))<>'') THEN
    v_blocked:='["cọc","chuyển khoản","hợp đồng","thanh toán","hoá đơn","hóa đơn","khiếu nại","hoàn tiền"]'::jsonb;
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(v_blocked) k WHERE btrim(k)<>'' AND position(lower(btrim(k)) IN lower(COALESCE(v_source.body,'')))>0) THEN v_reason:='Tin đến có từ khóa cần người thật trả lời'; END IF;
  SELECT k INTO v_keyword FROM jsonb_array_elements_text(v_keywords) k WHERE btrim(k)<>'' AND position(lower(btrim(k)) IN lower(COALESCE(v_source.body,'')))>0 LIMIT 1;
  IF v_reason IS NULL AND v_keyword IS NULL THEN v_reason:='Tin đến không khớp từ khóa'; END IF;
  v_cap:=app_private.zalo_config_int_v1(a.config->'dailyCap',50,1000);
  v_cooldown:=app_private.zalo_config_int_v1(a.config->'cooldownMinutes',30,1440);
  v_day:=date_trunc('day',v_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
  IF v_reason IS NULL AND EXISTS(SELECT 1 FROM public.zalo_automation_runs WHERE conversation_id=c.id AND kind='auto_reply' AND mode='reply'
    AND created_at>v_now-make_interval(mins=>v_cooldown)) THEN v_reason:='Hội thoại còn trong thời gian chờ chống lặp'; END IF;
  SELECT count(*) INTO v_count FROM public.zalo_automation_runs WHERE organization_id=c.organization_id AND kind='auto_reply' AND mode='reply' AND created_at>=v_day AND created_at<v_day+interval '1 day';
  IF v_reason IS NULL AND v_count>=v_cap THEN v_reason:='Đã chạm trần trả lời tự động trong ngày'; END IF;
  IF v_reason IS NOT NULL THEN
    INSERT INTO public.zalo_automation_runs(organization_id,account_id,conversation_id,kind,mode,reason,source_zalo_msg_id)
      VALUES(c.organization_id,c.account_id,c.id,'auto_reply','skipped',v_reason,p_source_zalo_msg_id) RETURNING id INTO v_run;
    RETURN jsonb_build_object('status','skipped','reason',v_reason,'run_id',v_run);
  END IF;
  INSERT INTO public.zalo_messages(user_id,organization_id,conversation_id,account_id,direction,msg_type,body,status,sent_at,client_dedup_key)
    VALUES(c.user_id,c.organization_id,c.id,c.account_id,'out','text',p_body,'pending',v_now,'automation:reply:'||p_source_zalo_msg_id) RETURNING id INTO v_msg;
  INSERT INTO public.zalo_send_queue(user_id,organization_id,conversation_id,account_id,message_id,channel,payload,status,not_before)
    VALUES(c.user_id,c.organization_id,c.id,c.account_id,v_msg,'personal',jsonb_build_object('body',p_body,'tu_dong',true,'auto_reply',true),'queued',v_now+interval '8 seconds') RETURNING id INTO v_job;
  INSERT INTO public.zalo_automation_runs(organization_id,account_id,conversation_id,kind,mode,reason,recipients_count,messages_count,detail,source_zalo_msg_id)
    VALUES(c.organization_id,c.account_id,c.id,'auto_reply','reply','Đã xếp hàng trả lời tự động; chờ worker gửi',1,1,
      p_detail||jsonb_build_object('message_id',v_msg,'job_id',v_job,'tu_khoa',v_keyword),p_source_zalo_msg_id) RETURNING id INTO v_run;
  UPDATE public.zalo_conversations SET last_message_text=p_body,last_message_at=v_now,last_message_dir='out' WHERE id=c.id;
  RETURN jsonb_build_object('status','queued','reused',false,'reason','Đã xếp hàng trả lời tự động','message_id',v_msg,'job_id',v_job,'run_id',v_run);
END $$;
REVOKE ALL ON FUNCTION public.zalo_enqueue_auto_reply_v1(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_enqueue_auto_reply_v1(uuid,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.zalo_enqueue_broadcast_v1(p_conversation_id uuid,p_body text,p_not_before timestamptz,p_request_key text,p_attachment jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE c public.zalo_conversations; a public.zalo_automations; v_msg uuid; v_job uuid; v_payload jsonb;
  v_now timestamptz:=clock_timestamp(); v_day timestamptz; v_count int; v_cap int; v_reason text; v_key text;
BEGIN
  IF (btrim(COALESCE(p_body,''))='' AND p_attachment IS NULL) OR length(p_body)>20000 OR p_not_before IS NULL
    OR btrim(COALESCE(p_request_key,''))='' OR length(p_request_key)>300 THEN RAISE EXCEPTION 'Nội dung gửi tự động không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hội thoại không tồn tại' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||c.organization_id::text,0));
  SELECT * INTO c FROM public.zalo_conversations WHERE id=p_conversation_id FOR SHARE;
  v_key:='automation:broadcast:'||p_request_key;
  SELECT id INTO v_msg FROM public.zalo_messages WHERE conversation_id=c.id AND client_dedup_key=v_key;
  IF FOUND THEN
    SELECT id INTO v_job FROM public.zalo_send_queue WHERE message_id=v_msg ORDER BY created_at,id LIMIT 1;
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
  IF p_attachment IS NOT NULL THEN PERFORM app_private.zalo_assert_attachment_v1(c.account_id,p_attachment); END IF;
  INSERT INTO public.zalo_messages(user_id,organization_id,conversation_id,account_id,direction,msg_type,body,media_url,media_meta,status,sent_at,client_dedup_key)
    VALUES(c.user_id,c.organization_id,c.id,c.account_id,'out',CASE WHEN p_attachment IS NULL THEN 'text' ELSE 'image' END,p_body,
      p_attachment->>'url',CASE WHEN p_attachment IS NULL THEN NULL ELSE (p_attachment-'url')||'{"tu_dong":true}'::jsonb END,'pending',v_now,v_key) RETURNING id INTO v_msg;
  v_payload:=jsonb_build_object('body',p_body,'tu_dong',true,'automation_request_key',p_request_key);
  IF p_attachment IS NOT NULL THEN v_payload:=v_payload||jsonb_build_object('type','image','attachments',jsonb_build_array(p_attachment),'message_ids',jsonb_build_array(v_msg)); END IF;
  INSERT INTO public.zalo_send_queue(user_id,organization_id,conversation_id,account_id,message_id,channel,payload,status,not_before)
    VALUES(c.user_id,c.organization_id,c.id,c.account_id,v_msg,'personal',v_payload,'queued',greatest(v_now,p_not_before)) RETURNING id INTO v_job;
  UPDATE public.zalo_conversations SET last_message_text=COALESCE(NULLIF(p_body,''),'[Hình ảnh]'),last_message_at=v_now,last_message_dir='out' WHERE id=c.id;
  RETURN jsonb_build_object('status','queued','reused',false,'reason','Đã xếp hàng gửi phòng trống','message_id',v_msg,'job_id',v_job);
END $$;
REVOKE ALL ON FUNCTION public.zalo_enqueue_broadcast_v1(uuid,text,timestamptz,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_enqueue_broadcast_v1(uuid,text,timestamptz,text,jsonb) TO service_role;

-- Lock order for queue transitions: lease -> organization advisory lock -> job.
-- Emergency stop and enqueue take the same organization lock, preventing a batch
-- still being constructed from appearing after the stop transaction commits.
CREATE OR REPLACE FUNCTION public.zalo_worker_claim_job_v1(p_job_id uuid,p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE q public.zalo_send_queue;
BEGIN
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','lease_lost'); END IF;
  SELECT * INTO q FROM public.zalo_send_queue WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR q.status<>'queued' OR COALESCE(q.not_before,'-infinity')>clock_timestamp() THEN RETURN jsonb_build_object('ok',false,'reason','not_ready'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.zalo_accounts a WHERE a.id=q.account_id AND a.organization_id=q.organization_id AND a.status='connected') THEN
    RETURN jsonb_build_object('ok',false,'reason','account_disconnected'); END IF;
  UPDATE public.zalo_send_queue SET status='processing',processing_started_at=clock_timestamp(),provider_started_at=NULL,
    processing_instance_id=p_instance_id,attempts=attempts+1 WHERE id=q.id;
  RETURN jsonb_build_object('ok',true,'reason',NULL);
END $$;

CREATE OR REPLACE FUNCTION public.zalo_worker_begin_provider_v1(p_job_id uuid,p_instance_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE q public.zalo_send_queue; c public.zalo_conversations; a public.zalo_automations;
  v_kind text; v_now timestamptz:=clock_timestamp(); v_day timestamptz; v_cap int; v_count int; v_org uuid;
BEGIN
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id AND heartbeat_at>v_now-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT organization_id INTO v_org FROM public.zalo_send_queue WHERE id=p_job_id;
  IF v_org IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  SELECT * INTO q FROM public.zalo_send_queue WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR q.status<>'processing' OR q.processing_instance_id IS DISTINCT FROM p_instance_id THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.zalo_accounts x WHERE x.id=q.account_id AND x.organization_id=q.organization_id AND x.status='connected') THEN RETURN false; END IF;
  IF q.payload ? 'tu_dong' THEN
    v_kind:=CASE WHEN q.payload->>'auto_reply'='true' THEN 'auto_reply' ELSE 'broadcast_vacant' END;
    SELECT * INTO a FROM public.zalo_automations WHERE organization_id=q.organization_id AND kind=v_kind FOR SHARE;
    SELECT * INTO c FROM public.zalo_conversations WHERE id=q.conversation_id;
    IF a.id IS NULL OR NOT a.enabled OR c.id IS NULL OR (v_kind='auto_reply' AND NOT c.is_sale_partner) OR c.account_id IS DISTINCT FROM q.account_id OR c.organization_id IS DISTINCT FROM q.organization_id THEN RETURN false; END IF;
    v_day:=date_trunc('day',v_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh';
    IF v_kind='broadcast_vacant' AND (q.created_at<v_day OR q.created_at>=v_day+interval '1 day') THEN RETURN false; END IF;
    IF v_kind='broadcast_vacant' AND (NOT COALESCE(a.config->'recipients' ? c.id::text,false) OR NOT app_private.zalo_in_allowed_hours_v1(v_now,a.config)) THEN RETURN false; END IF;
    v_cap:=CASE WHEN v_kind='auto_reply' THEN app_private.zalo_config_int_v1(a.config->'dailyCap',50,1000)
      ELSE app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000) END;
    IF q.provider_started_at IS NULL THEN
      SELECT count(*) INTO v_count FROM public.zalo_send_queue x WHERE x.organization_id=q.organization_id AND x.payload ? 'tu_dong'
        AND CASE WHEN v_kind='auto_reply' THEN COALESCE(x.payload->>'auto_reply'='true',false) ELSE NOT COALESCE(x.payload->>'auto_reply'='true',false) END
        AND x.provider_started_at>=v_day AND x.provider_started_at<v_day+interval '1 day';
      IF v_count>=v_cap THEN RETURN false; END IF;
    END IF;
  END IF;
  UPDATE public.zalo_send_queue SET provider_started_at=COALESCE(provider_started_at,v_now) WHERE id=q.id;
  RETURN true;
END $$;

-- Provider receipts preserve the original pending row (and its client key).
-- A self-listen echo may already own the provider id. Move its references before
-- deleting only that echo, then complete every message and queue receipt atomically.
CREATE OR REPLACE FUNCTION public.zalo_worker_finalize_send_v1(p_job_id uuid,p_instance_id uuid,p_receipts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE q public.zalo_send_queue; m public.zalo_messages; e public.zalo_messages; receipt jsonb;
  expected uuid[]; received uuid[]; zid text; cid text; attempt int; v_account uuid;
BEGIN
  IF jsonb_typeof(p_receipts) IS DISTINCT FROM 'array' OR jsonb_array_length(p_receipts) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Biên nhận gửi không hợp lệ' USING ERRCODE='22023'; END IF;
  SELECT account_id INTO v_account FROM public.zalo_send_queue WHERE id=p_job_id;
  IF v_account IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','job_missing'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_finalize:'||v_account::text,0));
  SELECT * INTO q FROM public.zalo_send_queue WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR q.processing_instance_id IS DISTINCT FROM p_instance_id THEN
    RETURN jsonb_build_object('ok',false,'reason','claim_changed'); END IF;
  IF q.status='sent' AND q.result->>'outcome'='sent' AND q.result->'provider_receipts'=p_receipts THEN
    RETURN jsonb_build_object('ok',true,'status','sent','reused',true,'message_ids',q.result->'message_ids'); END IF;
  IF q.status<>'processing' OR q.provider_started_at IS NULL THEN RETURN jsonb_build_object('ok',false,'reason','claim_changed'); END IF;
  SELECT array_agg(DISTINCT id ORDER BY id) INTO expected FROM (
    SELECT q.message_id AS id WHERE q.message_id IS NOT NULL UNION ALL
    SELECT value::uuid FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(q.payload->'message_ids')='array' THEN q.payload->'message_ids' ELSE '[]'::jsonb END)
  ) ids;
  BEGIN
    SELECT array_agg((value->>'message_id')::uuid ORDER BY (value->>'message_id')::uuid) INTO received FROM jsonb_array_elements(p_receipts);
  EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Mã biên nhận không hợp lệ' USING ERRCODE='22023'; END;
  IF expected IS NULL OR received IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Biên nhận không khớp toàn bộ tin của job' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_receipts) WHERE NULLIF(btrim(value->>'zalo_msg_id'),'') IS NULL) THEN
    RAISE EXCEPTION 'Thiếu mã provider; cần đối soát kết quả gửi' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*)<>count(DISTINCT NULLIF(btrim(value->>'zalo_msg_id'),'')) FROM jsonb_array_elements(p_receipts)
      WHERE NULLIF(btrim(value->>'zalo_msg_id'),'') IS NOT NULL) THEN
    RAISE EXCEPTION 'Mã provider trùng trong một lô' USING ERRCODE='22023'; END IF;
  FOR receipt IN SELECT value FROM jsonb_array_elements(p_receipts) ORDER BY value->>'message_id' LOOP
    zid:=NULLIF(btrim(receipt->>'zalo_msg_id'),''); cid:=NULLIF(btrim(receipt->>'cli_msg_id'),'');
    IF length(zid)>300 OR length(cid)>300 THEN RAISE EXCEPTION 'Mã provider quá dài' USING ERRCODE='22023'; END IF;
    SELECT * INTO m FROM public.zalo_messages WHERE id=(receipt->>'message_id')::uuid FOR UPDATE;
    IF NOT FOUND OR m.organization_id IS DISTINCT FROM q.organization_id OR m.account_id IS DISTINCT FROM q.account_id
      OR m.conversation_id IS DISTINCT FROM q.conversation_id OR m.direction<>'out'
      OR (zid IS NOT NULL AND m.zalo_msg_id IS NOT NULL AND m.zalo_msg_id<>zid) THEN
      RAISE EXCEPTION 'Biên nhận thuộc tin nhắn khác' USING ERRCODE='42501'; END IF;
    -- An inbound echo can race the lookup/update. Retry the unique conflict in a
    -- subtransaction so the newly committed echo is merged without resending.
    FOR attempt IN 1..3 LOOP
      BEGIN
        SELECT * INTO e FROM public.zalo_messages WHERE account_id=q.account_id AND zalo_msg_id=zid AND id<>m.id FOR UPDATE;
        IF FOUND THEN
          IF e.organization_id IS DISTINCT FROM q.organization_id OR e.conversation_id IS DISTINCT FROM q.conversation_id OR e.direction<>'out'
            OR (e.client_dedup_key IS NOT NULL AND e.client_dedup_key IS DISTINCT FROM m.client_dedup_key) THEN
            RAISE EXCEPTION 'Echo thuộc hội thoại hoặc yêu cầu khác' USING ERRCODE='42501'; END IF;
          IF EXISTS(SELECT 1 FROM public.zalo_send_queue x WHERE (x.message_id=e.id OR x.payload->'message_ids' ? e.id::text)
            AND (x.organization_id IS DISTINCT FROM q.organization_id OR x.account_id IS DISTINCT FROM q.account_id OR x.conversation_id IS DISTINCT FROM q.conversation_id)) THEN
            RAISE EXCEPTION 'Tham chiếu echo khác phạm vi' USING ERRCODE='42501'; END IF;
          UPDATE public.zalo_send_queue x SET message_id=CASE WHEN x.message_id=e.id THEN m.id ELSE x.message_id END,
            payload=CASE WHEN jsonb_typeof(x.payload->'message_ids')='array' THEN jsonb_set(x.payload,'{message_ids}',
              (SELECT jsonb_agg(CASE WHEN value=e.id::text THEN m.id::text ELSE value END ORDER BY ordinal)
               FROM jsonb_array_elements_text(x.payload->'message_ids') WITH ORDINALITY AS a(value,ordinal))) ELSE x.payload END
            WHERE x.organization_id=q.organization_id AND x.account_id=q.account_id AND x.conversation_id=q.conversation_id
              AND (x.message_id=e.id OR x.payload->'message_ids' ? e.id::text);
          UPDATE public.zalo_automation_runs SET detail=jsonb_set(detail,'{message_id}',to_jsonb(m.id::text))
            WHERE organization_id=q.organization_id AND account_id=q.account_id AND conversation_id=q.conversation_id AND detail->>'message_id'=e.id::text;
          DELETE FROM public.zalo_messages WHERE id=e.id;
        END IF;
        UPDATE public.zalo_messages SET zalo_msg_id=COALESCE(zid,m.zalo_msg_id),cli_msg_id=COALESCE(cid,m.cli_msg_id,e.cli_msg_id),
          status=CASE WHEN m.status='seen' OR e.status='seen' THEN 'seen' WHEN m.status='delivered' OR e.status='delivered' THEN 'delivered' ELSE 'sent' END,
          sent_at=COALESCE(m.sent_at,e.sent_at,clock_timestamp()),body=COALESCE(m.body,e.body),
          media_url=COALESCE(m.media_url,e.media_url),media_label=COALESCE(m.media_label,e.media_label),media_tone=COALESCE(m.media_tone,e.media_tone),
          media_meta=CASE WHEN jsonb_typeof(m.media_meta)='object' AND jsonb_typeof(e.media_meta)='object' THEN e.media_meta||m.media_meta ELSE COALESCE(m.media_meta,e.media_meta) END,
          reply_to=COALESCE(m.reply_to,e.reply_to),reactions=COALESCE(e.reactions,'{}')||m.reactions,
          reaction_emoji=COALESCE(m.reaction_emoji,e.reaction_emoji),zalo_raw=COALESCE(e.zalo_raw,m.zalo_raw),hidden_at=COALESCE(m.hidden_at,e.hidden_at)
          WHERE id=m.id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN IF attempt=3 THEN RAISE; END IF;
      END;
    END LOOP;
  END LOOP;
  UPDATE public.zalo_send_queue SET status='sent',last_error=NULL,processed_at=clock_timestamp(),
    result=COALESCE(result,'{}')||jsonb_build_object('outcome','sent','message_ids',to_jsonb(expected),'provider_receipts',p_receipts) WHERE id=q.id;
  RETURN jsonb_build_object('ok',true,'status','sent','message_ids',to_jsonb(expected));
END $$;
REVOKE ALL ON FUNCTION public.zalo_worker_finalize_send_v1(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_finalize_send_v1(uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.zalo_worker_recover_jobs_v1(p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE q public.zalo_send_queue; v_requeued int:=0; v_unknown int:=0;
BEGIN
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('requeued',0,'unknown',0,'reason','lease_lost'); END IF;
  FOR q IN SELECT * FROM public.zalo_send_queue WHERE status='processing' AND processing_instance_id IS DISTINCT FROM p_instance_id FOR UPDATE SKIP LOCKED LOOP
    IF q.processing_started_at IS NOT NULL AND q.provider_started_at IS NULL THEN
      UPDATE public.zalo_send_queue SET status='queued',processing_started_at=NULL,processing_instance_id=NULL,last_error=NULL WHERE id=q.id;
      v_requeued:=v_requeued+1;
    ELSE
      UPDATE public.zalo_send_queue SET status='failed',processed_at=clock_timestamp(),
        last_error='UNKNOWN_EFFECT: worker dừng khi chưa xác nhận kết quả; không gửi lại tự động',
        result=jsonb_build_object('outcome','unknown','requires_reconciliation',true) WHERE id=q.id;
      UPDATE public.zalo_messages m SET status='failed' WHERE m.status='pending' AND m.organization_id=q.organization_id
        AND m.account_id=q.account_id AND m.conversation_id=q.conversation_id
        AND (m.id=q.message_id OR (jsonb_typeof(q.payload->'message_ids')='array' AND q.payload->'message_ids' ? m.id::text));
      v_unknown:=v_unknown+1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('requeued',v_requeued,'unknown',v_unknown);
END $$;
REVOKE ALL ON FUNCTION public.zalo_worker_claim_job_v1(uuid,uuid),public.zalo_worker_begin_provider_v1(uuid,uuid),public.zalo_worker_recover_jobs_v1(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_claim_job_v1(uuid,uuid),public.zalo_worker_begin_provider_v1(uuid,uuid),public.zalo_worker_recover_jobs_v1(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.zalo_dung_khan_cap(p_organization_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'pg_catalog','public'
AS $$
DECLARE v_org uuid:=p_organization_id; v_orgs uuid[]; v_jobs uuid[]; v_msgs uuid[]; v_jobs_count int:=0; v_msgs_count int:=0; v_processing int:=0; v_acc uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  IF v_org IS NULL THEN
    SELECT array_agg(o) INTO v_orgs FROM public.zalo_authorized_org_ids('manage_automation') o;
    IF array_length(v_orgs,1) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Cần chọn tổ chức' USING ERRCODE='22023'; END IF;
    v_org:=v_orgs[1];
  END IF;
  IF NOT public.zalo_can('manage_automation',v_org) THEN RAISE EXCEPTION 'Bạn không có quyền' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||v_org::text,0));
  UPDATE public.zalo_automations SET enabled=false,updated_at=now() WHERE organization_id=v_org AND enabled;
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
  INSERT INTO public.zalo_automation_runs(organization_id,account_id,kind,mode,reason,messages_count,detail)
    VALUES(v_org,v_acc,'broadcast_vacant','stopped',format('Đã dừng %s tin đang chờ và tắt tự động hóa',v_jobs_count),v_jobs_count,
      jsonb_build_object('so_job_huy',v_jobs_count,'so_tin_danh_dau_that_bai',v_msgs_count,'con_dang_gui',v_processing,'boi',auth.uid()));
  RETURN jsonb_build_object('da_huy',v_jobs_count,'tin_danh_dau_that_bai',v_msgs_count,'con_dang_gui',v_processing);
END $$;
REVOKE ALL ON FUNCTION public.zalo_dung_khan_cap(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.zalo_dung_khan_cap(uuid) TO authenticated;

DO $verify$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['zalo_accounts','zalo_conversations','zalo_messages','zalo_send_queue','zalo_labels','zalo_message_templates','zalo_automations'] LOOP
    IF has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') THEN RAISE EXCEPTION 'Direct write remains on %',t; END IF;
    IF NOT has_table_privilege('authenticated','public.'||t,'SELECT') THEN RAISE EXCEPTION 'Missing read privilege on %',t; END IF;
  END LOOP;
END $verify$;
NOTIFY pgrst,'reload schema';
