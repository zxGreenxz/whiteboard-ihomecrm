-- Công việc Mốc 6 (docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 6, 23): ba RPC cho worker Zalo đọc hàng đợi nhắc việc
-- (app_private.task_reminder_outbox, 20261023063140). Chỉ service_role; worker phải đang giữ lease singleton zalo_worker_lease (như
-- zalo_worker_claim_job_v1). Hợp đồng đầy đủ cho worker: docs/zalo/NHAC-VIEC-WORKER.md.
--  claim  ⇒ lấy ≤ p_limit tin đến giờ (SKIP LOCKED), kiểm lại cấu hình + liên kết + ngày, giữ 60 s; trả id + nick gửi + UID người nhận.
--  begin  ⇒ cổng NGAY TRƯỚC khi gọi Zalo: còn giữ tin, cấu hình còn bật, liên kết còn hiệu lực, E4 còn bật, ngoài giờ yên, việc còn mở
--           (dựng lại nội dung từ việc đang mở; hết việc ⇒ skipped); chuyển sending, giữ 90 s; trả nội dung để gửi.
--  settle ⇒ sent | failed (CHẮC CHẮN chưa gửi: thử lại tối đa 3 lần, giãn 5 / 30 phút) | unknown (đã gọi Zalo mà mất kết quả: không bao
--           giờ gửi lại). Gọi lại cùng kết quả là phát lại an toàn.
-- Lease quá hạn: claimed ⇒ queued; sending ⇒ unknown (app_private.task_reminder_reap_v1, chạy ở claim và ở bộ sinh). Chỉ thêm hàm mới;
-- không đụng zalo_worker_claim_job_v1 / begin_provider_v1 / zalo_send_queue. Không khoá dòng công ty. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $requires$
BEGIN
  IF to_regclass('app_private.task_reminder_outbox') IS NULL OR to_regclass('app_private.task_reminder_config') IS NULL
    OR to_regclass('public.zalo_worker_lease') IS NULL
    OR to_regprocedure('app_private.task_reminder_recipient_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.task_reminder_body_v1(uuid,uuid,text,date,integer,text)') IS NULL
    OR to_regprocedure('app_private.task_reminder_quiet_end_v1(uuid,uuid,timestamptz)') IS NULL
    OR to_regprocedure('app_private.task_reminder_reap_v1(timestamptz)') IS NULL
    OR to_regprocedure('app_private.notify_gate_v1(uuid,uuid,text,numeric)') IS NULL
    OR to_regprocedure('app_private.org_timezone_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'zalo_worker_task_reminder_dependency_invalid'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION public.zalo_worker_claim_task_reminders_v1(p_instance_id uuid,p_limit integer DEFAULT 5)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_now timestamptz:=clock_timestamp(); v_limit integer:=LEAST(GREATEST(COALESCE(p_limit,5),1),20); o app_private.task_reminder_outbox;
  r record; v_items jsonb:='[]'::jsonb; v_skip text;
BEGIN
  IF p_instance_id IS NULL THEN RAISE EXCEPTION 'task_reminder_invalid' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id AND heartbeat_at>v_now-interval '30 seconds' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','lease_lost','items','[]'::jsonb); END IF;
  PERFORM app_private.task_reminder_reap_v1(v_now);
  FOR o IN SELECT x.* FROM app_private.task_reminder_outbox x WHERE x.state='queued' AND x.not_before<=v_now
      ORDER BY x.not_before,x.created_at,x.id LIMIT v_limit FOR UPDATE SKIP LOCKED LOOP
    v_skip:=NULL;
    IF NOT EXISTS(SELECT 1 FROM app_private.task_reminder_config c WHERE c.organization_id=o.organization_id AND c.enabled) THEN v_skip:='disabled';
    ELSIF (v_now AT TIME ZONE app_private.org_timezone_v1(o.organization_id))::date<>o.reminder_date THEN v_skip:='expired';
    ELSE
      SELECT x.* INTO r FROM app_private.task_reminder_recipient_v1(o.organization_id,o.user_id) x;
      IF NOT FOUND THEN v_skip:='recipient_unbound'; END IF;
    END IF;
    IF v_skip IS NOT NULL THEN
      UPDATE app_private.task_reminder_outbox SET state='skipped',error_code=v_skip,updated_at=v_now WHERE id=o.id;
      CONTINUE;
    END IF;
    UPDATE app_private.task_reminder_outbox SET state='claimed',lease_until=v_now+interval '60 seconds',instance_id=p_instance_id,
      binding_id=r.binding_id,updated_at=v_now WHERE id=o.id;
    v_items:=v_items||jsonb_build_array(jsonb_build_object('id',o.id,'accountId',r.account_id,'peerUid',r.peer_uid,'kind',o.kind,
      'reminderDate',o.reminder_date,'leaseUntil',v_now+interval '60 seconds'));
  END LOOP;
  RETURN jsonb_build_object('ok',true,'items',v_items);
END $fn$;

CREATE OR REPLACE FUNCTION public.zalo_worker_begin_task_reminder_v1(p_id uuid,p_instance_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_now timestamptz:=clock_timestamp(); o app_private.task_reminder_outbox; c app_private.task_reminder_config; r record; b record;
  v_tz text; v_end timestamptz; v_skip text;
BEGIN
  IF p_id IS NULL OR p_instance_id IS NULL THEN RAISE EXCEPTION 'task_reminder_invalid' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id AND heartbeat_at>v_now-interval '30 seconds' FOR SHARE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','lease_lost'); END IF;
  SELECT x.* INTO o FROM app_private.task_reminder_outbox x WHERE x.id=p_id FOR UPDATE;
  IF NOT FOUND OR o.state<>'claimed' OR o.instance_id IS DISTINCT FROM p_instance_id OR o.lease_until<=v_now THEN
    RETURN jsonb_build_object('ok',false,'reason','not_claimed','state',o.state); END IF;
  v_tz:=app_private.org_timezone_v1(o.organization_id);
  SELECT x.* INTO c FROM app_private.task_reminder_config x WHERE x.organization_id=o.organization_id AND x.enabled;
  IF NOT FOUND THEN v_skip:='disabled';
  ELSIF (v_now AT TIME ZONE v_tz)::date<>o.reminder_date THEN v_skip:='expired';
  ELSE
    SELECT x.* INTO r FROM app_private.task_reminder_recipient_v1(o.organization_id,o.user_id) x;
    IF NOT FOUND THEN v_skip:='recipient_unbound';
    -- (NULL, NULL) = chưa có dòng sở thích = bật, như mọi nơi gọi notify_gate_v1.
    ELSIF NOT COALESCE((SELECT COALESCE(g.g_in_app,true) OR COALESCE(g.g_push,true)
        FROM app_private.notify_gate_v1(o.user_id,o.organization_id,'E4',NULL) g LIMIT 1),true) THEN
      v_skip:='notifications_off';
    END IF;
  END IF;
  IF v_skip IS NULL THEN
    v_end:=app_private.task_reminder_quiet_end_v1(o.organization_id,o.user_id,v_now);
    IF v_end IS NULL OR v_end>v_now THEN
      IF v_end IS NULL OR (v_end AT TIME ZONE v_tz)::date<>o.reminder_date THEN v_skip:='quiet_hours';
      ELSE
        UPDATE app_private.task_reminder_outbox SET state='queued',lease_until=NULL,not_before=v_end,updated_at=v_now WHERE id=o.id;
        RETURN jsonb_build_object('ok',false,'reason','quiet_hours','notBefore',v_end);
      END IF;
    END IF;
  END IF;
  IF v_skip IS NULL THEN
    SELECT x.* INTO b FROM app_private.task_reminder_body_v1(o.organization_id,o.user_id,o.kind,o.reminder_date,c.overdue_days,c.app_base_url) x;
    IF NOT FOUND THEN v_skip:='jobs_closed'; END IF;
  END IF;
  IF v_skip IS NOT NULL THEN
    UPDATE app_private.task_reminder_outbox SET state='skipped',lease_until=NULL,error_code=v_skip,updated_at=v_now WHERE id=o.id;
    RETURN jsonb_build_object('ok',false,'reason',v_skip);
  END IF;
  UPDATE app_private.task_reminder_outbox SET state='sending',lease_until=v_now+interval '90 seconds',provider_started_at=v_now,
    binding_id=r.binding_id,job_ids=b.job_ids,job_total=b.job_total,body=b.body,updated_at=v_now WHERE id=o.id;
  RETURN jsonb_build_object('ok',true,'id',o.id,'accountId',r.account_id,'peerUid',r.peer_uid,'body',b.body,'leaseUntil',v_now+interval '90 seconds');
END $fn$;

CREATE OR REPLACE FUNCTION public.zalo_worker_settle_task_reminder_v1(p_id uuid,p_instance_id uuid,p_outcome text,p_error_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_now timestamptz:=clock_timestamp(); o app_private.task_reminder_outbox; v_code text; v_attempts integer;
BEGIN
  IF p_id IS NULL OR p_instance_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('sent','failed','unknown') THEN
    RAISE EXCEPTION 'task_reminder_invalid' USING ERRCODE='22023'; END IF;
  v_code:=NULLIF(left(lower(btrim(regexp_replace(COALESCE(p_error_code,''),'[^A-Za-z0-9_]+','_','g'),'_')),64),'');
  SELECT x.* INTO o FROM app_private.task_reminder_outbox x WHERE x.id=p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_found'); END IF;
  -- Phát lại cùng kết quả cuối (mất phản hồi của lần settle trước) ⇒ ok, không đổi gì.
  IF o.instance_id IS NOT DISTINCT FROM p_instance_id AND o.state=p_outcome AND o.state IN ('sent','unknown') THEN
    RETURN jsonb_build_object('ok',true,'state',o.state,'attempts',o.attempts,'replay',true); END IF;
  IF o.instance_id IS DISTINCT FROM p_instance_id OR o.state NOT IN ('claimed','sending') THEN
    RETURN jsonb_build_object('ok',false,'reason','not_owner','state',o.state); END IF;
  IF p_outcome IN ('sent','unknown') AND o.state<>'sending' THEN
    RETURN jsonb_build_object('ok',false,'reason','not_started','state',o.state); END IF;
  IF p_outcome='sent' THEN
    UPDATE app_private.task_reminder_outbox SET state='sent',sent_at=v_now,lease_until=NULL,error_code=NULL,updated_at=v_now WHERE id=o.id;
    RETURN jsonb_build_object('ok',true,'state','sent','attempts',o.attempts);
  ELSIF p_outcome='unknown' THEN
    UPDATE app_private.task_reminder_outbox SET state='unknown',lease_until=NULL,error_code=COALESCE(v_code,'unknown_effect'),updated_at=v_now
      WHERE id=o.id;
    RETURN jsonb_build_object('ok',true,'state','unknown','attempts',o.attempts);
  END IF;
  v_attempts:=o.attempts+1;
  IF v_attempts<3 THEN
    UPDATE app_private.task_reminder_outbox SET state='queued',attempts=v_attempts,lease_until=NULL,provider_started_at=NULL,
      not_before=v_now+CASE v_attempts WHEN 1 THEN interval '5 minutes' ELSE interval '30 minutes' END,
      error_code=COALESCE(v_code,'failed'),updated_at=v_now WHERE id=o.id;
    RETURN jsonb_build_object('ok',true,'state','queued','attempts',v_attempts);
  END IF;
  UPDATE app_private.task_reminder_outbox SET state='failed',attempts=v_attempts,lease_until=NULL,error_code=COALESCE(v_code,'failed'),updated_at=v_now
    WHERE id=o.id;
  RETURN jsonb_build_object('ok',true,'state','failed','attempts',v_attempts);
END $fn$;

ALTER FUNCTION public.zalo_worker_claim_task_reminders_v1(uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.zalo_worker_begin_task_reminder_v1(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.zalo_worker_settle_task_reminder_v1(uuid,uuid,text,text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.zalo_worker_claim_task_reminders_v1(uuid,integer),public.zalo_worker_begin_task_reminder_v1(uuid,uuid),
  public.zalo_worker_settle_task_reminder_v1(uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.zalo_worker_claim_task_reminders_v1(uuid,integer),public.zalo_worker_begin_task_reminder_v1(uuid,uuid),
  public.zalo_worker_settle_task_reminder_v1(uuid,uuid,text,text) TO service_role;

DO $check$
DECLARE f regprocedure;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.zalo_worker_claim_task_reminders_v1(uuid,integer)','public.zalo_worker_begin_task_reminder_v1(uuid,uuid)',
      'public.zalo_worker_settle_task_reminder_v1(uuid,uuid,text,text)']::regprocedure[] LOOP
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid=f) OR has_function_privilege('authenticated',f,'EXECUTE')
      OR has_function_privilege('anon',f,'EXECUTE') OR NOT has_function_privilege('service_role',f,'EXECUTE') THEN
      RAISE EXCEPTION 'zalo_worker_task_reminder_check_failed: %',f; END IF;
  END LOOP;
END $check$;
COMMIT;
