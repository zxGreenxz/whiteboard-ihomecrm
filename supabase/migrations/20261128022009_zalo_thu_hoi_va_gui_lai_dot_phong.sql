SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS app_private.zalo_sale_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id),
  run_key text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('compact','full','event')),
  recipients uuid[] NOT NULL,
  event_rooms uuid[],
  fingerprint text,
  oneshot_id uuid,
  rebuild_budget integer,
  rebuild_start bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  phase text NOT NULL DEFAULT 'active' CHECK (phase IN ('active','recalling','rebuilding','closed')),
  UNIQUE (organization_id,run_key)
);
ALTER TABLE app_private.zalo_sale_batches ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.zalo_sale_batches FROM PUBLIC,anon,authenticated,service_role;

-- Only cancelled reservations that never started a provider request can be released.
CREATE OR REPLACE FUNCTION app_private.zalo_oneshot_tin_hom_nay_v1(p_org uuid,p_now timestamptz)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT count(*)::integer FROM public.zalo_send_queue WHERE organization_id=p_org AND payload ? 'tu_dong'
    AND NOT COALESCE(payload->>'auto_reply'='true',false)
    AND NOT (status='failed' AND provider_started_at IS NULL AND result @> '{"sale_batch_unreserved":true}'::jsonb IS TRUE)
    AND created_at>=(date_trunc('day',p_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh')
    AND created_at<((date_trunc('day',p_now AT TIME ZONE 'Asia/Ho_Chi_Minh')+interval '1 day') AT TIME ZONE 'Asia/Ho_Chi_Minh')
$$;
DO $quota$
DECLARE f regprocedure; body text;
  original text:=$source$SELECT count(*) INTO v_count FROM public.zalo_send_queue WHERE organization_id=c.organization_id AND payload ? 'tu_dong'
    AND NOT COALESCE(payload->>'auto_reply'='true',false) AND created_at>=v_day AND created_at<v_day+interval '1 day';$source$;
  replacement text:='v_count:=app_private.zalo_oneshot_tin_hom_nay_v1(c.organization_id,v_now);';
BEGIN
  FOREACH f IN ARRAY ARRAY['public.zalo_enqueue_broadcast_v1(uuid,text,timestamptz,text,jsonb)'::regprocedure,
    'public.zalo_enqueue_broadcast_oneshot_v1(uuid,uuid,uuid,text,timestamptz,text,jsonb)'::regprocedure] LOOP
    body:=replace(pg_get_functiondef(f),chr(13),'');
    IF strpos(body,replacement)>0 THEN CONTINUE; END IF;
    IF strpos(body,original)=0 THEN RAISE EXCEPTION 'Định nghĩa kiểm trần đã thay đổi: %',f; END IF;
    EXECUTE replace(body,original,replacement);
  END LOOP;
END $quota$;

-- Use actual sends and still-deliverable reservations. Cancelled slots no longer delay another batch.
CREATE OR REPLACE FUNCTION app_private.zalo_batch_next_start(p_org uuid,p_now timestamptz,p_config jsonb) RETURNS bigint
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT COALESCE(ceil(extract(epoch FROM max(due))*1000)::bigint,0) FROM (
    SELECT greatest(max(COALESCE(processed_at,provider_started_at,not_before))+
      make_interval(secs=>app_private.zalo_config_int_v1(p_config#>'{antiSpam,gapBetweenRoomMsgsSec}',20,600)),
      min(COALESCE(provider_started_at,not_before))+make_interval(secs=>
        app_private.zalo_config_int_v1(p_config#>'{antiSpam,gapBetweenRecipientsSec}',180,3600))) AS due
    FROM public.zalo_send_queue WHERE organization_id=p_org AND payload->'tu_dong'='true'::jsonb AND NOT (payload ? 'auto_reply')
      AND status IN ('sent','processing','queued') AND created_at >= date_trunc('day',p_now AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'
    GROUP BY conversation_id,split_part(payload->>'automation_request_key',':'||conversation_id::text||':',1)
  ) occupied
$$;

CREATE OR REPLACE FUNCTION app_private.zalo_batch_lease(p_instance uuid) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance
    AND heartbeat_at>clock_timestamp()-interval '30 seconds' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Worker không còn giữ lease' USING ERRCODE='PT409'; END IF;
END $$;

CREATE OR REPLACE FUNCTION app_private.zalo_batch_key(p_payload jsonb,p_conv uuid) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path=pg_catalog AS $$
  SELECT regexp_replace(split_part(p_payload->>'automation_request_key',':'||p_conv::text||':',1),':group$','')
  WHERE p_payload->'tu_dong'='true'::jsonb AND NOT (p_payload ? 'auto_reply')
    AND p_payload->>'automation_request_key' ~ ('^(scheduled|event|oneshot|refresh):.+:'||p_conv::text||':(room:[^:]+(:(album|divider))?|link|contact|table_image)$')
$$;

CREATE OR REPLACE FUNCTION public.zalo_worker_register_sale_batch_v1(p_instance uuid,p_org uuid,p_key text,p_mode text,
  p_recipients uuid[],p_event_rooms uuid[],p_fingerprint text,p_oneshot uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE batch app_private.zalo_sale_batches;
BEGIN
  PERFORM app_private.zalo_batch_lease(p_instance);
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||p_org::text,0));
  IF p_key !~ '^(scheduled|event|oneshot|refresh):[0-9a-f:-]+$' OR length(p_key)>160 OR
     p_fingerprint !~ '^[a-f0-9]{64}$' OR p_fingerprint IS NULL OR cardinality(p_recipients)=0 OR
     (p_mode='event') IS DISTINCT FROM (p_event_rooms IS NOT NULL) OR
     (p_key LIKE 'oneshot:%') IS DISTINCT FROM (p_oneshot IS NOT NULL) OR
     (p_oneshot IS NOT NULL AND p_key <> 'oneshot:'||p_oneshot::text) THEN
    RAISE EXCEPTION 'Thông tin đợt gửi không hợp lệ';
  END IF;
  INSERT INTO app_private.zalo_sale_batches(organization_id,run_key,mode,recipients,event_rooms,fingerprint,oneshot_id)
    VALUES(p_org,p_key,p_mode,p_recipients,p_event_rooms,p_fingerprint,p_oneshot)
    ON CONFLICT(organization_id,run_key) DO NOTHING;
  SELECT * INTO STRICT batch FROM app_private.zalo_sale_batches WHERE organization_id=p_org AND run_key=p_key;
  IF batch.phase='active' AND batch.fingerprint IS DISTINCT FROM p_fingerprint AND NOT EXISTS(
    SELECT 1 FROM public.zalo_send_queue q WHERE q.organization_id=p_org AND app_private.zalo_batch_key(q.payload,q.conversation_id)=p_key) THEN
    UPDATE app_private.zalo_sale_batches SET fingerprint=p_fingerprint,mode=p_mode,recipients=p_recipients,event_rooms=p_event_rooms WHERE id=batch.id;
    RETURN true;
  END IF;
  RETURN batch.phase='active' AND batch.fingerprint=p_fingerprint;
END $$;

-- Enqueue and begin_provider already hold the same transaction-scoped organization lock.
CREATE OR REPLACE FUNCTION app_private.zalo_fence_sale_batch() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE batch app_private.zalo_sale_batches; k text;
BEGIN
  IF NEW.payload ? 'sale_recall_batch' THEN
    SELECT * INTO STRICT batch FROM app_private.zalo_sale_batches WHERE organization_id=NEW.organization_id
      AND id=(NEW.payload->>'sale_recall_batch')::uuid;
    IF batch.phase<>'recalling' OR EXISTS(SELECT 1 FROM public.zalo_automation_runs r WHERE r.organization_id=batch.organization_id
      AND r.kind='broadcast_vacant' AND r.mode='stopped' AND r.created_at>=batch.created_at) THEN
      RAISE EXCEPTION 'Đã dừng thu hồi tự động' USING ERRCODE='PT409';
    END IF;
    RETURN NEW;
  END IF;
  k:=app_private.zalo_batch_key(NEW.payload,NEW.conversation_id);
  IF k IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO batch FROM app_private.zalo_sale_batches WHERE organization_id=NEW.organization_id AND run_key=k;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF batch.run_key LIKE 'refresh:%' AND EXISTS(
    SELECT 1 FROM app_private.zalo_sale_batches parent JOIN public.zalo_automation_runs stop
      ON stop.organization_id=parent.organization_id AND stop.kind='broadcast_vacant' AND stop.mode='stopped' AND stop.created_at>=parent.created_at
    WHERE parent.organization_id=batch.organization_id AND 'refresh:'||parent.id::text=batch.run_key
  ) THEN RAISE EXCEPTION 'Đã dừng khẩn cấp lượt gửi lại' USING ERRCODE='PT409'; END IF;
  IF batch.phase<>'active' THEN RAISE EXCEPTION 'Đợt gửi đã dừng để thu hồi' USING ERRCODE='PT409'; END IF;
  IF TG_OP='INSERT' THEN
    NEW.payload:=NEW.payload||jsonb_build_object('sale_batch_fingerprint',batch.fingerprint,'sale_batch_id',batch.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zalo_fence_sale_batch ON public.zalo_send_queue;
CREATE TRIGGER zalo_fence_sale_batch BEFORE INSERT OR UPDATE OF provider_started_at ON public.zalo_send_queue
  FOR EACH ROW WHEN (NEW.payload ?| ARRAY['automation_request_key','sale_recall_batch']) EXECUTE FUNCTION app_private.zalo_fence_sale_batch();

CREATE OR REPLACE FUNCTION public.zalo_worker_stop_sale_batch_v1(p_instance uuid,p_job uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE job public.zalo_send_queue; batch app_private.zalo_sale_batches; k text; ids uuid[]; room_ids uuid[]; m text; shot uuid;
BEGIN
  PERFORM app_private.zalo_batch_lease(p_instance);
  SELECT * INTO job FROM public.zalo_send_queue WHERE id=p_job;
  k:=app_private.zalo_batch_key(job.payload,job.conversation_id);
  IF k IS NULL THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||job.organization_id::text,0));
  SELECT * INTO job FROM public.zalo_send_queue WHERE id=p_job FOR UPDATE;
  SELECT * INTO batch FROM app_private.zalo_sale_batches WHERE organization_id=job.organization_id AND run_key=k FOR UPDATE;
  IF batch.phase IN ('recalling','rebuilding','closed') THEN RETURN true; END IF;
  IF job.status NOT IN ('queued','processing') THEN RETURN false; END IF;
  IF batch.id IS NULL THEN
    -- Only adopt a legacy run when one of its still-live jobs actually observes a stale snapshot.
    SELECT array_agg(DISTINCT q.conversation_id),
      array_agg(DISTINCT substring(q.payload->>'automation_request_key' FROM ':room:([0-9a-f-]{36})')::uuid)
        FILTER (WHERE q.payload->>'automation_request_key' LIKE '%:room:%')
      INTO ids,room_ids FROM public.zalo_send_queue q WHERE q.organization_id=job.organization_id
        AND app_private.zalo_batch_key(q.payload,q.conversation_id)=k;
    shot:=(job.payload->>'oneshot_id')::uuid;
    IF shot IS NOT NULL THEN SELECT mode INTO m FROM public.zalo_automation_oneshots WHERE organization_id=job.organization_id AND id=shot;
    ELSIF k LIKE 'event:%' THEN m:='event';
    ELSE
      SELECT COALESCE(r.detail->>'che_do_dinh_gui',r.mode) INTO m FROM public.zalo_automation_runs r
        WHERE r.organization_id=job.organization_id AND r.kind='broadcast_vacant'
          AND r.mode IN ('full','compact','failed') AND r.detail ? 'gio_hen'
          AND (r.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=(job.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
          AND (length(k)=20 OR right(k,5)=r.detail->>'gio_hen')
        ORDER BY abs(extract(epoch FROM r.created_at-job.created_at)) LIMIT 1;
    END IF;
    IF m IS NULL OR m NOT IN ('event','full','compact') THEN RAISE EXCEPTION 'Chưa nhận diện được chế độ đợt gửi cũ'; END IF;
    INSERT INTO app_private.zalo_sale_batches(organization_id,run_key,mode,recipients,event_rooms,oneshot_id,created_at)
      VALUES(job.organization_id,k,m,ids,CASE WHEN m='event' THEN room_ids END,shot,job.created_at) RETURNING * INTO batch;
  END IF;
  UPDATE app_private.zalo_sale_batches SET phase='recalling' WHERE id=batch.id;
  WITH stopped AS (
    UPDATE public.zalo_send_queue q SET status='failed',processed_at=clock_timestamp(),
      result=COALESCE(q.result,'{}'::jsonb)||jsonb_build_object('sale_batch_unreserved',q.provider_started_at IS NULL),
      last_error='SALE_BATCH_REPLACED: dừng đợt cũ vì danh sách phòng đã đổi'
    WHERE q.organization_id=batch.organization_id AND (q.status='queued' OR (q.status='processing' AND q.provider_started_at IS NULL))
      AND app_private.zalo_batch_key(q.payload,q.conversation_id)=k
    RETURNING q.message_id,q.payload,q.organization_id,q.conversation_id,q.account_id
  )
  UPDATE public.zalo_messages m SET status='failed' FROM stopped s WHERE m.organization_id=s.organization_id
    AND m.account_id=s.account_id AND m.conversation_id=s.conversation_id AND m.status='pending'
    AND (m.id=s.message_id OR s.payload->'message_ids' ? m.id::text);
  INSERT INTO public.zalo_automation_runs(organization_id,kind,mode,reason,detail)
    VALUES(batch.organization_id,'broadcast_vacant','event','Danh sách phòng đã đổi. Đang thu hồi tin của đợt vừa gửi.',jsonb_build_object('sale_batch',batch.id));
  RETURN true;
END $$;

CREATE INDEX IF NOT EXISTS zalo_sale_batch_live_job_idx ON public.zalo_send_queue
  ((payload->>'sale_batch_id')) WHERE status IN ('queued','processing') AND payload ? 'sale_batch_id';

CREATE OR REPLACE FUNCTION public.zalo_worker_sale_batches_due_v1(p_instance uuid,p_orgs uuid[]) RETURNS uuid[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
BEGIN
  PERFORM app_private.zalo_batch_lease(p_instance);
  RETURN ARRAY(SELECT b.id FROM app_private.zalo_sale_batches b WHERE (p_orgs IS NULL OR b.organization_id=ANY(p_orgs))
    AND (b.phase IN ('recalling','rebuilding') OR (b.phase='active' AND EXISTS(
      SELECT 1 FROM public.zalo_send_queue q WHERE q.organization_id=b.organization_id AND q.status IN ('queued','processing')
      AND q.payload ? 'sale_batch_id' AND q.payload->>'sale_batch_id'=b.id::text))) ORDER BY b.created_at,b.id);
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS zalo_sale_batch_recall_message_idx ON public.zalo_send_queue
  ((payload->>'sale_recall_message')) WHERE payload ? 'sale_recall_message';

CREATE OR REPLACE FUNCTION public.zalo_worker_advance_sale_batch_v1(p_instance uuid,p_batch uuid,p_finish text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE b app_private.zalo_sale_batches; a public.zalo_automations; shot public.zalo_automation_oneshots; why text;
  watch_job public.zalo_send_queue; missing boolean; draining boolean; t timestamptz:=clock_timestamp(); remaining integer;
BEGIN
  PERFORM app_private.zalo_batch_lease(p_instance);
  SELECT * INTO STRICT b FROM app_private.zalo_sale_batches WHERE id=p_batch;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||b.organization_id::text,0));
  SELECT * INTO STRICT b FROM app_private.zalo_sale_batches WHERE id=p_batch FOR UPDATE;
  IF b.phase='active' THEN
    SELECT q.* INTO watch_job FROM public.zalo_send_queue q WHERE q.organization_id=b.organization_id AND q.status IN ('queued','processing')
      AND q.payload ? 'sale_batch_id' AND q.payload->>'sale_batch_id'=b.id::text ORDER BY q.created_at,q.id LIMIT 1;
    IF FOUND THEN
      SELECT * INTO a FROM public.zalo_automations WHERE organization_id=b.organization_id AND kind='broadcast_vacant';
      RETURN jsonb_build_object('phase','watching','job',watch_job.id,'org',b.organization_id,'fingerprint',b.fingerprint,'config',a.config);
    END IF;
  END IF;
  IF b.phase NOT IN ('recalling','rebuilding') THEN RETURN jsonb_build_object('phase',b.phase); END IF;
  IF EXISTS(SELECT 1 FROM public.zalo_automation_runs WHERE organization_id=b.organization_id AND kind='broadcast_vacant'
    AND mode='stopped' AND created_at>=b.created_at) THEN
    UPDATE public.zalo_send_queue SET status='failed',processed_at=t,last_error='CANCELLED_AUTOMATION: đã dừng thu hồi'
      WHERE organization_id=b.organization_id AND payload->>'sale_recall_batch'=b.id::text
        AND (status='queued' OR (status='processing' AND provider_started_at IS NULL));
    why:='Đợt đã dừng khẩn cấp.';
  ELSIF b.phase='rebuilding' AND EXISTS(SELECT 1 FROM app_private.zalo_sale_batches child
      WHERE child.organization_id=b.organization_id AND child.run_key='refresh:'||b.id::text AND child.phase<>'active') THEN
    why:='Đợt mới lại đổi nội dung và đã chuyển sang thu hồi.';
  ELSIF p_finish IS NOT NULL THEN
    IF b.phase<>'rebuilding' THEN RAISE EXCEPTION 'Đợt chưa sẵn sàng gửi lại'; END IF;
    why:=p_finish;
  ELSIF b.phase='recalling' THEN
    -- Resolve numbered album items by their canonical primary keys, including videos.
    WITH jobs AS MATERIALIZED (
      SELECT q.* FROM public.zalo_send_queue q WHERE q.organization_id=b.organization_id
        AND app_private.zalo_batch_key(q.payload,q.conversation_id)=b.run_key
    ), targets AS (
      SELECT j.id AS job_id,j.user_id,j.account_id,j.conversation_id,j.message_id FROM jobs j
        WHERE j.status='sent'
      UNION
      SELECT j.id,j.user_id,j.account_id,j.conversation_id,item::uuid FROM jobs j
        CROSS JOIN LATERAL jsonb_array_elements_text(j.payload->'message_ids') item WHERE j.status='sent'
      UNION
      -- An interrupted mixed album can have confirmed provider IDs for only its first items.
      SELECT j.id,j.user_id,j.account_id,j.conversation_id,m.id FROM jobs j
        CROSS JOIN LATERAL jsonb_array_elements_text(j.result->'provider_message_ids') provider_id
        JOIN public.zalo_messages m ON m.zalo_msg_id=provider_id
        WHERE j.status='failed' AND m.account_id=j.account_id AND m.organization_id=b.organization_id
          AND m.conversation_id=j.conversation_id AND m.direction='out'
    ), receipts AS MATERIALIZED (
      SELECT t.*,m.zalo_msg_id,m.cli_msg_id FROM targets t LEFT JOIN public.zalo_messages m ON m.id=t.message_id
        AND m.organization_id=b.organization_id AND m.account_id=t.account_id AND m.conversation_id=t.conversation_id AND m.direction='out'
    ), enqueue_recalls AS (
      INSERT INTO public.zalo_send_queue(user_id,organization_id,account_id,conversation_id,channel,status,payload)
        SELECT r.user_id,b.organization_id,r.account_id,r.conversation_id,'personal','queued',jsonb_build_object(
          'action','recall','sale_recall_batch',b.id,'sale_recall_message',r.message_id,
          'target_msg_id',r.zalo_msg_id,'target_cli_msg_id',r.cli_msg_id)
        FROM receipts r WHERE NULLIF(r.zalo_msg_id,'') IS NOT NULL
        ON CONFLICT ((payload->>'sale_recall_message')) WHERE payload ? 'sale_recall_message' DO NOTHING
    )
    SELECT EXISTS(SELECT 1 FROM jobs WHERE status IN ('queued','processing')),
      EXISTS(SELECT 1 FROM receipts WHERE NULLIF(zalo_msg_id,'') IS NULL) OR
      EXISTS(SELECT 1 FROM jobs WHERE status='failed' AND (provider_started_at IS NOT NULL OR result->>'outcome'='unknown'))
      INTO draining,missing;
    IF draining THEN RETURN jsonb_build_object('phase','draining'); END IF;
    IF EXISTS(SELECT 1 FROM public.zalo_send_queue r WHERE r.organization_id=b.organization_id
      AND r.payload->>'sale_recall_batch'=b.id::text AND r.status IN ('queued','processing')) THEN
      RETURN jsonb_build_object('phase','recalling');
    END IF;
    IF missing OR EXISTS(SELECT 1 FROM public.zalo_send_queue r WHERE r.organization_id=b.organization_id
      AND r.payload->>'sale_recall_batch'=b.id::text AND r.status<>'sent') THEN why:='Cần đối soát tin gửi hoặc thu hồi thiếu biên nhận Zalo.'; END IF;
  END IF;
  SELECT * INTO a FROM public.zalo_automations WHERE organization_id=b.organization_id AND kind='broadcast_vacant';
  IF a.enabled AND (b.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=(t AT TIME ZONE 'Asia/Ho_Chi_Minh')::date THEN
    UPDATE public.zalo_automations SET stats=COALESCE(stats,'{}')||jsonb_build_object(
      'sentDate',to_char(t AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD'),'sentToday',app_private.zalo_oneshot_tin_hom_nay_v1(b.organization_id,t),
      'nextScheduledStart',app_private.zalo_batch_next_start(b.organization_id,t,a.config))
      WHERE id=a.id AND enabled;
  END IF;
  SELECT * INTO shot FROM public.zalo_automation_oneshots WHERE organization_id=b.organization_id AND id=b.oneshot_id;
  IF why IS NULL THEN
    IF (t AT TIME ZONE 'Asia/Ho_Chi_Minh')::date<>(b.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      OR NOT app_private.zalo_in_allowed_hours_v1(t,a.config) THEN why:='Đợt gửi đã hết khung giờ.';
    ELSIF b.oneshot_id IS NULL AND a.enabled IS DISTINCT FROM true THEN why:='Đã tắt lịch gửi.';
    ELSIF b.oneshot_id IS NOT NULL AND (shot.id IS NULL OR shot.status='cancelled') THEN why:='Lượt gửi một lần đã bị huỷ.';
    END IF;
  END IF;
  IF why IS NULL AND b.oneshot_id IS NOT NULL THEN
    INSERT INTO public.zalo_automation_oneshots(organization_id,mode,recipients,run_at,send_now,origin,created_by,request_id,request_fingerprint,result)
      VALUES(b.organization_id,shot.mode,shot.recipients,t,true,shot.origin,shot.created_by,'refresh:'||b.id,md5(b.id::text),
        jsonb_build_object('sale_refresh_parent',b.id,'earliest_start',app_private.zalo_batch_next_start(b.organization_id,t,a.config)))
      ON CONFLICT(organization_id,request_id) DO NOTHING;
    IF NOT EXISTS(SELECT 1 FROM public.zalo_automation_oneshots WHERE organization_id=b.organization_id
      AND request_id='refresh:'||b.id AND result->>'sale_refresh_parent'=b.id::text) THEN
      RAISE EXCEPTION 'Mã lượt gửi mới đã thuộc yêu cầu khác';
    END IF;
    why:='Đã thu hồi xong và tạo lượt gửi một lần mới.';
  END IF;
  IF why IS NULL THEN
    remaining:=greatest(0,app_private.zalo_config_int_v1(a.config#>'{antiSpam,dailyCap}',120,2000)-
      app_private.zalo_oneshot_tin_hom_nay_v1(b.organization_id,t));
    remaining:=COALESCE(b.rebuild_budget,remaining);
    IF remaining>0 THEN
      UPDATE app_private.zalo_sale_batches SET phase='rebuilding',rebuild_budget=remaining,
        rebuild_start=COALESCE(b.rebuild_start,app_private.zalo_batch_next_start(b.organization_id,t,a.config))
        WHERE id=b.id RETURNING * INTO b;
      RETURN jsonb_build_object('phase','rebuilding','org',b.organization_id,'run_key','refresh:'||b.id,
        'earliest_start',b.rebuild_start,'mode',b.mode,'recipients',b.recipients,'rooms',b.event_rooms,'config',a.config,'remaining',remaining);
    END IF;
    why:='Đã chạm trần gửi trong ngày.';
  END IF;
  UPDATE app_private.zalo_sale_batches SET phase='closed' WHERE id=b.id;
  INSERT INTO public.zalo_automation_runs(organization_id,kind,mode,reason,detail)
    VALUES(b.organization_id,'broadcast_vacant',CASE WHEN why LIKE 'Đã thu hồi xong%' THEN 'event' ELSE 'failed' END,
      why,jsonb_build_object('sale_batch',b.id));
  RETURN jsonb_build_object('phase','closed','reason',why);
END $$;

-- Leave a replacement shot running so already queued jobs keep their authority.
-- The normal claimant picks it up after run_at, with the same shot ID, dedup keys and attempt limit.
CREATE OR REPLACE FUNCTION public.zalo_worker_retry_sale_oneshot_v1(p_instance uuid,p_shot uuid,p_budget integer) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $$
DECLARE s public.zalo_automation_oneshots; retry_at timestamptz:=clock_timestamp()+interval '1 minute';
BEGIN
  PERFORM app_private.zalo_batch_lease(p_instance);
  SELECT * INTO s FROM public.zalo_automation_oneshots WHERE id=p_shot;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zalo_automation:'||s.organization_id::text,0));
  UPDATE public.zalo_automation_oneshots SET claimed_by_instance=NULL,run_at=retry_at,updated_at=clock_timestamp(),
    result=result||jsonb_build_object('rebuild_budget',COALESCE((result->>'rebuild_budget')::integer,p_budget))
  WHERE id=p_shot AND claimed_by_instance=p_instance AND status='running' AND attempts<3
    AND (created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date=(retry_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
    AND EXISTS(SELECT 1 FROM app_private.zalo_sale_batches b WHERE b.organization_id=s.organization_id AND
      s.result->>'sale_refresh_parent'=b.id::text AND s.request_id='refresh:'||b.id);
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.zalo_worker_retry_sale_oneshot_v1(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_retry_sale_oneshot_v1(uuid,uuid,integer) TO service_role;

-- Persist successful automatic recalls even if the self-listen undo event is lost.
CREATE OR REPLACE FUNCTION app_private.zalo_record_sale_recall() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.zalo_messages SET body='(Tin đã được thu hồi)',msg_type='sys'
    WHERE id=(NEW.payload->>'sale_recall_message')::uuid AND organization_id=NEW.organization_id
      AND account_id=NEW.account_id AND conversation_id=NEW.conversation_id AND direction='out'
      AND zalo_msg_id=NEW.payload->>'target_msg_id';
  IF NOT FOUND THEN RAISE EXCEPTION 'Không đối chiếu được tin Zalo vừa thu hồi'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS zalo_record_sale_recall ON public.zalo_send_queue;
CREATE TRIGGER zalo_record_sale_recall AFTER UPDATE OF status ON public.zalo_send_queue
  FOR EACH ROW WHEN (NEW.status='sent' AND OLD.status='processing' AND NEW.payload ? 'sale_recall_message')
  EXECUTE FUNCTION app_private.zalo_record_sale_recall();
REVOKE ALL ON FUNCTION app_private.zalo_batch_next_start(uuid,timestamptz,jsonb),app_private.zalo_record_sale_recall() FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON FUNCTION app_private.zalo_batch_key(jsonb,uuid),app_private.zalo_batch_lease(uuid),
  app_private.zalo_fence_sale_batch() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.zalo_worker_register_sale_batch_v1(uuid,uuid,text,text,uuid[],uuid[],text,uuid),
  public.zalo_worker_stop_sale_batch_v1(uuid,uuid),public.zalo_worker_sale_batches_due_v1(uuid,uuid[]),
  public.zalo_worker_advance_sale_batch_v1(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_register_sale_batch_v1(uuid,uuid,text,text,uuid[],uuid[],text,uuid),
  public.zalo_worker_stop_sale_batch_v1(uuid,uuid),public.zalo_worker_sale_batches_due_v1(uuid,uuid[]),
  public.zalo_worker_advance_sale_batch_v1(uuid,uuid,text) TO service_role;
