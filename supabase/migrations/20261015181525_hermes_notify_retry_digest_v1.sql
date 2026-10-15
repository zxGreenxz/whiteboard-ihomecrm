-- Trả hai khoản nợ hoãn của đợt Hermes 15/10 (các file 20261015100000,
-- 20261015110000, 20261015130000 giữ nguyên). Chỉ thêm hai cột cho bảng theo dõi,
-- CREATE OR REPLACE hai hàm cũ giữ chữ ký, kiểu trả về, owner, search_path và ACL,
-- cộng một helper riêng tư mới; chạy lại an toàn.
--  (1) hermes_task_follow_tick_v1: nhóm thông báo (người nhận, loại) gửi lỗi thì
--      dấu của đúng loại đó được trả về NULL cho các theo dõi trong nhóm để lượt
--      sau gửi lại; notify_failures đếm số lượt lỗi liên tiếp, lỗi lần thứ 4 thì
--      giữ dấu (bỏ cuộc), ghi audit HERMES_TASK_FOLLOW_NOTICE_ABANDONED + WARNING
--      rồi đặt lại bộ đếm cho thông báo sau. Gửi xong không lỗi thì bộ đếm về 0.
--      Lựa chọn cho theo dõi nằm trong hai nhóm (overdue cho người làm,
--      overdue_report cho người giao): TÁCH DẤU. overdue_reported_at là dấu riêng
--      của báo cáo người giao, nên nhóm nào lỗi chỉ trả dấu của nhóm đó; người đã
--      nhận thành công không bị gửi trùng, người bị lỗi không mất thông báo. Theo
--      dõi đã báo quá hạn trước migration được điền overdue_reported_at bằng dấu
--      chung cũ (báo cáo người giao đã đi cùng lượt đó).
--  (2) hermes_room_schedule_sweep_v1 bước (f): sự cố đủ điều kiện của một lượt
--      được gom theo (công ty, chủ lịch) thành MỘT thông báo tóm tắt qua
--      hermes_schedule_notify_v2 (một sự cố thì dùng nguyên hermes_schedule_notify_v1);
--      từng sự cố vẫn ghi notified_at/notify_result (hoặc closed_notified_at) như
--      cũ. Mỗi nhóm một subtransaction: một chủ lỗi ghi không chặn chủ khác. Giữ
--      LIMIT 20/lượt và trễ 15 phút cho nguyên nhân thoáng qua.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $guard$
BEGIN
  IF to_regclass('app_private.hermes_task_follows') IS NULL OR to_regclass('app_private.hermes_schedule_incidents') IS NULL THEN
    RAISE EXCEPTION 'hermes_notify_retry_digest_requires_20261015_batch' USING ERRCODE='55000'; END IF;
  IF to_regprocedure('app_private.hermes_task_follow_tick_v1(integer)') IS NULL
    OR to_regprocedure('app_private.hermes_task_follow_notify_v1(uuid,uuid,text,jsonb,text,uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_schedule_notify_v1(uuid,text)') IS NULL
    OR to_regprocedure('app_private.hermes_schedule_message_v1(text,text,jsonb,text,timestamptz)') IS NULL
    OR to_regprocedure('public.hermes_room_schedule_sweep_v1(uuid,uuid[])') IS NULL THEN
    RAISE EXCEPTION 'hermes_notify_retry_digest_requires_20261015_batch' USING ERRCODE='55000'; END IF;
END $guard$;

-- (1) Dấu riêng cho báo cáo quá hạn gửi người giao; điền một lần lúc thêm cột.
DO $columns$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='app_private.hermes_task_follows'::regclass
      AND attname='overdue_reported_at' AND NOT attisdropped) THEN
    ALTER TABLE app_private.hermes_task_follows ADD COLUMN overdue_reported_at timestamptz;
    UPDATE app_private.hermes_task_follows SET overdue_reported_at=overdue_notified_at WHERE overdue_notified_at IS NOT NULL;
  END IF;
END $columns$;
-- Số lượt gửi lỗi liên tiếp của thông báo đang chờ; lần thứ 4 là bỏ cuộc nên giá
-- trị lưu không vượt 3.
ALTER TABLE app_private.hermes_task_follows ADD COLUMN IF NOT EXISTS notify_failures integer NOT NULL DEFAULT 0
  CHECK(notify_failures BETWEEN 0 AND 3);

-- (1) Lượt nhắc/báo cáo (pg_cron hiện có, 15 phút). Như 20261015130000, thêm: dấu
-- riêng overdue_reported_at, nhớ theo dõi nào nằm trong nhóm nào, và xử lý nhóm lỗi.
CREATE OR REPLACE FUNCTION app_private.hermes_task_follow_tick_v1(p_limit integer DEFAULT 500)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private SET lock_timeout='2s' AS $fn$
DECLARE v_org uuid; f app_private.hermes_task_follows; j public.jobs; v_now timestamptz; v_reason text; v_found boolean;
  v_groups jsonb:='{}'; v_members jsonb:='{}'; v_lost jsonb:='{}'; v_sent jsonb:='[]'; v_pending jsonb; v_close integer;
  v_item jsonb; v_locked boolean; g record; p record; r record; v_parts text[]; v_prior integer; v_job uuid;
  v_checked integer:=0; v_closed integer:=0; v_notified integer:=0; v_failed integer:=0; v_skipped integer:=0;
  v_retrying integer:=0; v_abandoned integer:=0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 5000 THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('app_private.hermes_task_follow_tick_v1')) THEN
    RETURN jsonb_build_object('busy',true); END IF;
  FOR v_org IN SELECT DISTINCT organization_id FROM app_private.hermes_task_follows WHERE state='ACTIVE' ORDER BY 1 LOOP
    -- A company whose authorization row stays busy past lock_timeout is skipped
    -- this tick instead of being waited on while earlier companies stay locked.
    v_locked:=true;
    BEGIN PERFORM app_private.lock_org_for_decision_v1(v_org);
    EXCEPTION WHEN OTHERS THEN v_locked:=false;
      RAISE WARNING 'hermes_task_follow_tick_v1: organization % skipped (%)',v_org,SQLSTATE;
    END;
    IF NOT v_locked THEN v_skipped:=v_skipped+1; CONTINUE; END IF;
    v_now:=clock_timestamp();
    -- Least recently checked first, so a large company is covered across ticks.
    FOR f IN SELECT * FROM app_private.hermes_task_follows WHERE organization_id=v_org AND state='ACTIVE'
        ORDER BY checked_at NULLS FIRST,id LIMIT p_limit FOR UPDATE SKIP LOCKED LOOP
      v_checked:=v_checked+1; v_pending:='[]'::jsonb; v_close:=0;
      BEGIN
        UPDATE app_private.hermes_task_follows SET checked_at=v_now WHERE id=f.id;
        v_reason:=app_private.hermes_task_follow_grant_v1(f);
        IF v_reason IS NOT NULL THEN
          UPDATE app_private.hermes_task_follows SET state='REVOKED',close_reason=v_reason,closed_at=v_now,version=version+1,updated_at=v_now WHERE id=f.id;
          PERFORM app_private.append_authz_audit_v1(f.organization_id,'HERMES_TASK_FOLLOW_REVOKED','hermes_task_follow',f.id,NULL,
            jsonb_build_object('assigner',f.assigner_user_id,'executor',f.executor_user_id,'jobId',f.job_id,'reason',v_reason),'Standing follow lost authority');
          v_close:=1;
        ELSE
          SELECT * INTO j FROM public.jobs WHERE id=f.job_id AND organization_id=f.organization_id;
          v_found:=FOUND;
          v_item:=jsonb_build_object('jobId',f.job_id,'code',f.job_code,'title',
            CASE WHEN v_found THEN COALESCE(app_private.hermes_task_follow_label_v1(j.title,200),f.job_title) ELSE f.job_title END,
            'deadline',CASE WHEN v_found THEN app_private.hermes_task_follow_iso_v1(j.deadline) END);
          IF NOT v_found OR j.status='COMPLETED' THEN
            UPDATE app_private.hermes_task_follows SET state=CASE WHEN v_found THEN 'DONE' ELSE 'CANCELLED' END,
              close_reason=CASE WHEN v_found THEN 'completed' ELSE 'job_deleted' END,closed_at=v_now,version=version+1,updated_at=v_now WHERE id=f.id;
            v_close:=1;
            IF f.notify_assigner THEN
              v_pending:=v_pending||jsonb_build_array(jsonb_build_array(
                f.organization_id::text||'|'||f.assigner_user_id::text||'|'||CASE WHEN v_found THEN 'done' ELSE 'deleted' END,v_item,f.id));
            END IF;
          ELSE
            IF j.assignee_id IS NOT NULL AND j.assignee_id IS DISTINCT FROM f.executor_user_id THEN
              UPDATE app_private.hermes_task_follows SET executor_user_id=j.assignee_id,version=version+1,updated_at=v_now WHERE id=f.id;
            END IF;
            IF j.status='IN_PROGRESS' AND j.deadline IS NOT NULL THEN
              IF f.remind_before_minutes IS NOT NULL AND f.due_notified_at IS NULL AND j.assignee_id IS NOT NULL
                AND v_now>=j.deadline-make_interval(mins=>f.remind_before_minutes) AND v_now<j.deadline THEN
                UPDATE app_private.hermes_task_follows SET due_notified_at=v_now,updated_at=v_now WHERE id=f.id;
                v_pending:=v_pending||jsonb_build_array(jsonb_build_array(f.organization_id::text||'|'||j.assignee_id::text||'|due',v_item,f.id));
              END IF;
              -- The executor's notice and the assigner's report keep separate marks,
              -- so retrying one side never repeats the other.
              IF v_now>=j.deadline AND f.overdue_notified_at IS NULL THEN
                UPDATE app_private.hermes_task_follows SET overdue_notified_at=v_now,updated_at=v_now WHERE id=f.id;
                IF j.assignee_id IS NOT NULL THEN
                  v_pending:=v_pending||jsonb_build_array(jsonb_build_array(f.organization_id::text||'|'||j.assignee_id::text||'|overdue',v_item,f.id));
                END IF;
              END IF;
              IF v_now>=j.deadline AND f.overdue_reported_at IS NULL THEN
                UPDATE app_private.hermes_task_follows SET overdue_reported_at=v_now,updated_at=v_now WHERE id=f.id;
                IF f.notify_assigner AND f.assigner_user_id IS DISTINCT FROM j.assignee_id THEN
                  v_pending:=v_pending||jsonb_build_array(jsonb_build_array(f.organization_id::text||'|'||f.assigner_user_id::text||'|overdue_report',v_item,f.id));
                END IF;
              END IF;
            END IF;
          END IF;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_pending:='[]'::jsonb; v_close:=0; v_failed:=v_failed+1;
        RAISE WARNING 'hermes_task_follow_tick_v1: follow % skipped (%)',f.id,SQLSTATE;
        -- Rotate the failing follow behind the others; it is retried next tick.
        UPDATE app_private.hermes_task_follows SET checked_at=v_now WHERE id=f.id;
      END;
      v_closed:=v_closed+v_close;
      FOR p IN SELECT x.e->>0 AS k,x.e->1 AS item,x.e->2 AS follow FROM jsonb_array_elements(v_pending) AS x(e) LOOP
        v_groups:=jsonb_set(v_groups,ARRAY[p.k],COALESCE(v_groups->p.k,'[]'::jsonb)||jsonb_build_array(p.item),true);
        v_members:=jsonb_set(v_members,ARRAY[p.k],COALESCE(v_members->p.k,'[]'::jsonb)||jsonb_build_array(p.follow),true);
      END LOOP;
    END LOOP;
  END LOOP;
  -- A failing notice does not stop the other recipients. Its follows are
  -- remembered with the kind that failed; done/deleted notices close their follow
  -- and have no mark to return.
  FOR g IN SELECT key,value FROM jsonb_each(v_groups) ORDER BY key LOOP
    v_parts:=string_to_array(g.key,'|');
    BEGIN
      IF app_private.hermes_task_follow_notify_v1(v_parts[1]::uuid,v_parts[2]::uuid,v_parts[3],g.value,NULL,NULL) IS NOT NULL THEN
        v_notified:=v_notified+1; END IF;
      v_sent:=v_sent||(v_members->g.key);
    EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;
      RAISE WARNING 'hermes_task_follow_tick_v1: % notice skipped (%)',v_parts[3],SQLSTATE;
      IF v_parts[3] IN ('due','overdue','overdue_report') THEN
        FOR r IN SELECT x.value#>>'{}' AS id FROM jsonb_array_elements(v_members->g.key) AS x(value) LOOP
          v_lost:=jsonb_set(v_lost,ARRAY[r.id],COALESCE(v_lost->r.id,'[]'::jsonb)||to_jsonb(v_parts[3]),true);
        END LOOP;
      END IF;
    END;
  END LOOP;
  -- Return exactly the failed kinds' marks so the next tick sends them again, at
  -- most three consecutive failures; the fourth keeps the marks (gives up), is
  -- audited and resets the counter for the follow's next notice.
  FOR r IN SELECT x.key::uuid AS id,x.value AS kinds FROM jsonb_each(v_lost) AS x ORDER BY x.key LOOP
    BEGIN
      SELECT t.notify_failures,t.organization_id,t.job_id INTO v_prior,v_org,v_job FROM app_private.hermes_task_follows t WHERE t.id=r.id;
      IF v_prior<3 THEN
        UPDATE app_private.hermes_task_follows SET notify_failures=v_prior+1,
          due_notified_at=CASE WHEN r.kinds ? 'due' THEN NULL ELSE due_notified_at END,
          overdue_notified_at=CASE WHEN r.kinds ? 'overdue' THEN NULL ELSE overdue_notified_at END,
          overdue_reported_at=CASE WHEN r.kinds ? 'overdue_report' THEN NULL ELSE overdue_reported_at END,
          updated_at=clock_timestamp() WHERE id=r.id;
        v_retrying:=v_retrying+1;
      ELSE
        UPDATE app_private.hermes_task_follows SET notify_failures=0,updated_at=clock_timestamp() WHERE id=r.id;
        PERFORM app_private.append_authz_audit_v1(v_org,'HERMES_TASK_FOLLOW_NOTICE_ABANDONED','hermes_task_follow',r.id,NULL,
          jsonb_build_object('jobId',v_job,'kinds',r.kinds,'failures',v_prior+1),'Task follow notice abandoned after repeated delivery failures');
        RAISE WARNING 'hermes_task_follow_tick_v1: follow % notice % abandoned after % failures',r.id,r.kinds,v_prior+1;
        v_abandoned:=v_abandoned+1;
      END IF;
    EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;
      RAISE WARNING 'hermes_task_follow_tick_v1: follow % notice state kept (%)',r.id,SQLSTATE;
    END;
  END LOOP;
  -- A follow whose every notice of this tick went through starts a new count.
  BEGIN
    UPDATE app_private.hermes_task_follows SET notify_failures=0
      WHERE id IN (SELECT (x.value#>>'{}')::uuid FROM jsonb_array_elements(v_sent) AS x(value))
        AND NOT(v_lost ? id::text) AND notify_failures<>0;
  EXCEPTION WHEN OTHERS THEN v_failed:=v_failed+1;
    RAISE WARNING 'hermes_task_follow_tick_v1: failure counters kept (%)',SQLSTATE;
  END;
  RETURN jsonb_build_object('checked',v_checked,'closed',v_closed,'notified',v_notified,'failed',v_failed,'skippedOrganizations',v_skipped,
    'retrying',v_retrying,'abandoned',v_abandoned);
END $fn$;

-- (2) One bell + one push for every incident of one (company, owner) in a pass.
-- A single incident keeps the exact v1 notice (text, tag, per-incident
-- idempotency key). Same channel as v1: in-app bell row plus send-push through
-- pg_net with the reminder service JWT slot; a marked TEST database refuses that
-- JWT, so TEST records only the bell. Text never claims a send happened.
CREATE OR REPLACE FUNCTION app_private.hermes_schedule_notify_v2(p_incidents uuid[],p_phase text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,app_private,public AS $fn$
DECLARE v_org uuid; v_user uuid; v_count integer; v_orgs integer; v_users integer; v_schedules integer; v_rows jsonb;
  v_lines text; v_title text; v_body text; v_jwt text; v_error text; v_req bigint;
BEGIN
  IF p_phase IS NULL OR p_phase NOT IN ('opened','recovered') OR p_incidents IS NULL OR cardinality(p_incidents) NOT BETWEEN 1 AND 20
    OR EXISTS(SELECT 1 FROM unnest(p_incidents) x WHERE x IS NULL)
    OR (SELECT count(DISTINCT x) FROM unnest(p_incidents) x)<>cardinality(p_incidents)
    THEN RETURN jsonb_build_object('skipped','invalid'); END IF;
  IF cardinality(p_incidents)=1 THEN RETURN app_private.hermes_schedule_notify_v1(p_incidents[1],p_phase); END IF;
  SELECT count(*),count(DISTINCT i.organization_id),count(DISTINCT i.user_id),min(i.organization_id::text)::uuid,min(i.user_id::text)::uuid
    INTO v_count,v_orgs,v_users,v_org,v_user FROM app_private.hermes_schedule_incidents i WHERE i.id=ANY(p_incidents);
  IF v_count<>cardinality(p_incidents) OR v_orgs<>1 OR v_users<>1 THEN RETURN jsonb_build_object('skipped','invalid'); END IF;
  IF NOT EXISTS(SELECT 1 FROM public.organization_memberships m JOIN public.organizations o ON o.id=m.organization_id
    WHERE m.user_id=v_user AND m.organization_id=v_org AND o.status='ACTIVE' AND m.status='ACTIVE' AND m.revoked_at IS NULL
      AND COALESCE(m.valid_from,'-infinity'::timestamptz)<=clock_timestamp() AND (m.valid_to IS NULL OR m.valid_to>clock_timestamp()))
    THEN RETURN jsonb_build_object('skipped','owner_inactive'); END IF;
  -- Same per-incident label and wording as v1, in notice order.
  SELECT jsonb_agg(jsonb_build_object('id',x.id,'scheduleId',x.schedule_id,'reason',x.reason,'label',x.label,
      'body',app_private.hermes_schedule_message_v1(x.reason,p_phase,x.detail,x.label,x.expires_at)->>'body') ORDER BY x.event_at,x.id)
    INTO v_rows FROM (
      SELECT i.id,i.schedule_id,i.reason,i.detail,g.expires_at,CASE WHEN p_phase='recovered' THEN i.closed_at ELSE i.opened_at END AS event_at,
        CASE WHEN g.settings->>'template'='sale_policy_public_text_v1' THEN 'Lịch báo đổi chính sách' ELSE 'Lịch bản tin phòng' END
          ||' …'||right(i.schedule_id::text,8) AS label
      FROM app_private.hermes_schedule_incidents i
        LEFT JOIN app_private.hermes_room_schedules s ON s.id=i.schedule_id
        LEFT JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id
      WHERE i.id=ANY(p_incidents)) x;
  IF p_phase='opened' THEN
    -- Count, the first three schedules with their reason, and how many remain.
    SELECT string_agg(e.value->>'body',E'\n' ORDER BY e.ord) INTO v_lines
      FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS e(value,ord) WHERE e.ord<=3;
    v_title:='Lịch Hermes có '||v_count||' vấn đề cần xem';
    v_body:=v_lines||CASE WHEN v_count>3 THEN E'\nCòn '||(v_count-3)||' vấn đề khác; xem trong danh sách lịch.' ELSE '' END;
  ELSE
    SELECT string_agg(l.label,', ' ORDER BY l.first_ord) FILTER(WHERE l.rn<=3),count(*) INTO v_lines,v_schedules FROM (
      SELECT e.value->>'label' AS label,min(e.ord) AS first_ord,row_number() OVER(ORDER BY min(e.ord)) AS rn
        FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS e(value,ord) GROUP BY e.value->>'scheduleId',e.value->>'label') l;
    v_title:='Lịch Hermes đã chạy lại ('||v_schedules||' lịch)';
    v_body:=v_lines||CASE WHEN v_schedules>3 THEN ' và '||(v_schedules-3)||' lịch khác' ELSE '' END
      ||' không còn lỗi đã báo; lịch tiếp tục theo nhịp đã đặt. Kết quả từng tin xem trong danh sách lịch.';
  END IF;
  v_body:=left(v_body,1000);
  INSERT INTO public.notifications(organization_id,user_id,type,channel,status,subject,content,metadata)
    VALUES(v_org,v_user,'CUSTOM','IN_APP','PENDING',v_title,v_body,
      jsonb_build_object('v5','hermes_schedule','phase',p_phase,'count',v_count,'url','/settings/hermes',
        'incidentIds',(SELECT jsonb_agg(e.value->'id' ORDER BY e.ord) FROM jsonb_array_elements(v_rows) WITH ORDINALITY AS e(value,ord)),
        'scheduleIds',(SELECT jsonb_agg(DISTINCT e.value->'scheduleId') FROM jsonb_array_elements(v_rows) AS e(value)),
        'reasons',(SELECT jsonb_agg(DISTINCT e.value->'reason') FROM jsonb_array_elements(v_rows) AS e(value))));
  BEGIN
    v_jwt:=app_private.lifecycle_reminder_service_jwt_v1();
  EXCEPTION WHEN OTHERS THEN v_jwt:=NULL; v_error:=left(SQLSTATE||': '||SQLERRM,300); END;
  IF v_jwt IS NOT NULL THEN
    v_req:=net.http_post(
      url:='https://tryymsxyyckgbrmmvozx.supabase.co/functions/v1/send-push',
      body:=jsonb_build_object('userId',v_user,'title',v_title,'body',v_body,'url','/settings/hermes',
        'tag','hermes-schedule-digest:'||v_org::text,
        'idempotencyKey',left('hermes-schedule-digest:'||md5((SELECT string_agg(x::text,',' ORDER BY x) FROM unnest(p_incidents) x))||':'||p_phase,128)),
      headers:=jsonb_build_object('Authorization','Bearer '||v_jwt,'Content-Type','application/json'),
      timeout_milliseconds:=30000);
  END IF;
  RETURN jsonb_build_object('bell',true,'pushRequestId',v_req,'pushError',v_error,'incidents',v_count);
END $fn$;

-- (2) Maintenance on the existing worker tick: as 20261015100000, only step (f)
-- changes (one notice per company/owner group). Bounded batches; never takes
-- the lease row lock.
CREATE OR REPLACE FUNCTION public.hermes_room_schedule_sweep_v1(p_instance_id uuid,p_organization_ids uuid[] DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_pruned jsonb; v_expired integer:=0; v_observed integer:=0; v_notified integer:=0; v_expiry integer:=0; v_closed integer:=0;
  v_row record; v_group record; v_result jsonb; v_probes jsonb; v_jobs uuid[]; v_messages uuid[];
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' OR p_organization_ids IS NULL OR cardinality(p_organization_ids)>100
    OR NOT EXISTS(SELECT 1 FROM public.zalo_worker_lease WHERE id='singleton' AND instance_id=p_instance_id
      AND heartbeat_at>clock_timestamp()-interval '30 seconds' AND heartbeat_at<=clock_timestamp())
    THEN RAISE EXCEPTION 'hermes_schedule_worker_denied' USING ERRCODE='42501'; END IF;
  -- (a) Expired private commands: DISPATCHED becomes UNKNOWN_EFFECT, the rest
  -- EXPIRED; content cleared. Existing helper, no replay.
  v_pruned:=app_private.hermes_store_prune_private_commands_v1(jsonb_build_object('limit',64));
  -- (b) Queued Hermes group jobs whose dispatch expired can never be admitted
  -- by the provider gate. Mark them failed (definitely not sent).
  WITH picked AS (SELECT q.id,q.message_id FROM public.zalo_send_queue q JOIN app_private.hermes_group_dispatches h ON h.id=q.hermes_group_dispatch_id
      WHERE q.status='queued' AND q.provider_started_at IS NULL AND h.expires_at<=clock_timestamp()
        AND (cardinality(p_organization_ids)=0 OR q.organization_id=ANY(p_organization_ids))
      ORDER BY h.expires_at,q.id LIMIT 128 FOR UPDATE OF q SKIP LOCKED),
    expired AS (UPDATE public.zalo_send_queue q SET status='failed',processed_at=clock_timestamp(),
      last_error='EXPIRED_HERMES_DISPATCH: hết hạn trước khi gửi; không tự gửi lại',
      result=COALESCE(q.result,'{}'::jsonb)||jsonb_build_object('outcome','expired')
      FROM picked WHERE q.id=picked.id AND q.status='queued' RETURNING q.id,q.message_id)
  SELECT array_agg(id),array_agg(message_id) FILTER(WHERE message_id IS NOT NULL) INTO v_jobs,v_messages FROM expired;
  v_expired:=COALESCE(cardinality(v_jobs),0);
  IF v_expired>0 THEN
    UPDATE public.zalo_messages SET status='failed' WHERE id=ANY(v_messages) AND status='pending';
  END IF;
  -- (c) Terminal delivery outcomes of scheduled jobs become incidents once.
  FOR v_row IN SELECT r.schedule_id,r.dispatch_id,r.conversation_id,q.id AS job_id,
      CASE WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown' ELSE 'failed' END AS outcome,
      substring(q.last_error FROM '^([A-Z][A-Z_]{2,40})') AS error_code
    FROM app_private.hermes_schedule_runs r JOIN app_private.hermes_group_jobs j ON j.dispatch_id=r.dispatch_id
      JOIN public.zalo_send_queue q ON q.id=j.job_id JOIN app_private.hermes_room_schedules s ON s.id=r.schedule_id
    WHERE r.outcome='queued' AND r.created_at>clock_timestamp()-interval '8 days' AND q.status='failed' AND NOT(COALESCE(q.result,'{}'::jsonb) ? 'reconciliation')
      AND (cardinality(p_organization_ids)=0 OR s.organization_id=ANY(p_organization_ids))
      AND NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_delivery_observations o WHERE o.job_id=q.id
        AND o.outcome=CASE WHEN q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true' THEN 'unknown' ELSE 'failed' END)
    ORDER BY r.created_at,q.id LIMIT 50 LOOP
    INSERT INTO app_private.hermes_schedule_delivery_observations(job_id,outcome,schedule_id,dispatch_id)
      VALUES(v_row.job_id,v_row.outcome,v_row.schedule_id,v_row.dispatch_id) ON CONFLICT DO NOTHING;
    PERFORM app_private.hermes_schedule_incident_open_v1(v_row.schedule_id,'delivery','delivery_'||v_row.outcome,
      jsonb_build_object('jobId',v_row.job_id,'dispatchId',v_row.dispatch_id,'conversationId',v_row.conversation_id,'errorCode',v_row.error_code));
    v_observed:=v_observed+1;
  END LOOP;
  -- Close delivery incidents that no longer hold: unknowns reconciled, or a
  -- later scheduled delivery confirmed sent after the failure was seen.
  UPDATE app_private.hermes_schedule_incidents i SET closed_at=clock_timestamp(),close_reason='recovered'
    WHERE i.closed_at IS NULL AND i.kind='delivery' AND (cardinality(p_organization_ids)=0 OR i.organization_id=ANY(p_organization_ids))
      AND ((i.reason='delivery_unknown' AND NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_runs r
          JOIN app_private.hermes_group_jobs j ON j.dispatch_id=r.dispatch_id JOIN public.zalo_send_queue q ON q.id=j.job_id
          WHERE r.schedule_id=i.schedule_id AND r.outcome='queued' AND q.status='failed'
            AND (q.result->>'outcome'='unknown' OR q.result->>'requires_reconciliation'='true')))
        OR (i.reason='delivery_failed' AND EXISTS(SELECT 1 FROM app_private.hermes_schedule_runs r
          JOIN app_private.hermes_group_jobs j ON j.dispatch_id=r.dispatch_id JOIN public.zalo_send_queue q ON q.id=j.job_id
          WHERE r.schedule_id=i.schedule_id AND r.outcome='queued' AND q.status='sent' AND q.processed_at>i.last_seen_at)));
  GET DIAGNOSTICS v_closed=ROW_COUNT;
  -- (d) Revoked schedules: their incidents end without a recovery notice.
  UPDATE app_private.hermes_schedule_incidents i SET closed_at=clock_timestamp(),close_reason='schedule_revoked'
    FROM app_private.hermes_room_schedules s WHERE s.id=i.schedule_id AND i.closed_at IS NULL AND s.state='REVOKED'
      AND (cardinality(p_organization_ids)=0 OR i.organization_id=ANY(p_organization_ids));
  -- (e) Standing-grant expiry: one warning per grant 72 hours ahead, one notice
  -- at expiry; a replaced grant closes the old notices silently.
  UPDATE app_private.hermes_schedule_incidents i SET closed_at=clock_timestamp(),close_reason='grant_replaced'
    FROM app_private.hermes_room_schedules s WHERE s.id=i.schedule_id AND i.closed_at IS NULL AND i.kind='expiry'
      AND i.detail->>'grantId' IS DISTINCT FROM s.grant_id::text;
  FOR v_row IN SELECT s.id,g.id AS grant_id,g.expires_at FROM app_private.hermes_room_schedules s JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id
    WHERE s.state='ACTIVE' AND g.expires_at<=clock_timestamp()+interval '72 hours'
      AND (cardinality(p_organization_ids)=0 OR s.organization_id=ANY(p_organization_ids))
      AND NOT EXISTS(SELECT 1 FROM app_private.hermes_schedule_incidents i WHERE i.schedule_id=s.id AND i.kind='expiry'
        AND i.detail->>'grantId'=g.id::text AND i.reason=CASE WHEN g.expires_at<=clock_timestamp() THEN 'grant_expired' ELSE 'grant_expiring' END)
    ORDER BY g.expires_at,s.id LIMIT 50 LOOP
    IF v_row.expires_at<=clock_timestamp() THEN
      -- The expired grant is now the only reason the schedule stopped; open
      -- delivery reconciliation work stays open.
      UPDATE app_private.hermes_schedule_incidents SET closed_at=clock_timestamp(),close_reason='superseded'
        WHERE schedule_id=v_row.id AND closed_at IS NULL AND (kind IN ('authority','run') OR (kind='expiry' AND reason='grant_expiring'));
    END IF;
    PERFORM app_private.hermes_schedule_incident_open_v1(v_row.id,'expiry',
      CASE WHEN v_row.expires_at<=clock_timestamp() THEN 'grant_expired' ELSE 'grant_expiring' END,
      jsonb_build_object('grantId',v_row.grant_id,'expiresAt',to_char(v_row.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
    v_expiry:=v_expiry+1;
  END LOOP;
  -- (f) Notify schedule owners: the incidents picked in this pass (at most 20)
  -- are grouped by (company, owner) into ONE notice each, and every incident
  -- still records its own attempt. Transient causes wait 15 minutes so a short
  -- flap closes silently.
  FOR v_group IN WITH picked AS (SELECT i.id,i.organization_id,i.user_id,i.opened_at FROM app_private.hermes_schedule_incidents i
      WHERE i.closed_at IS NULL AND i.notified_at IS NULL AND (cardinality(p_organization_ids)=0 OR i.organization_id=ANY(p_organization_ids))
        AND i.opened_at<=clock_timestamp()-CASE WHEN i.reason IN ('zalo_sender_unavailable','queue_capacity','other_owner_delivery_pending',
          'room_data_changed','context_changed','unclassified') THEN interval '15 minutes' ELSE interval '0' END
      ORDER BY i.opened_at,i.id LIMIT 20 FOR UPDATE SKIP LOCKED)
    SELECT picked.organization_id,picked.user_id,array_agg(picked.id ORDER BY picked.opened_at,picked.id) AS ids FROM picked
    GROUP BY picked.organization_id,picked.user_id ORDER BY min(picked.opened_at),picked.organization_id,picked.user_id LOOP
    -- A failing bell/push write must not stall maintenance or another owner; the
    -- attempt and its error are recorded once per incident, never retried in a loop.
    BEGIN v_result:=app_private.hermes_schedule_notify_v2(v_group.ids,'opened');
    EXCEPTION WHEN OTHERS THEN v_result:=jsonb_build_object('error',SQLSTATE); END;
    UPDATE app_private.hermes_schedule_incidents SET notified_at=clock_timestamp(),notify_result=v_result WHERE id=ANY(v_group.ids);
    v_notified:=v_notified+cardinality(v_group.ids);
  END LOOP;
  FOR v_group IN WITH picked AS (SELECT i.id,i.organization_id,i.user_id,i.closed_at FROM app_private.hermes_schedule_incidents i
      WHERE i.close_reason='recovered' AND i.notified_at IS NOT NULL AND i.closed_notified_at IS NULL AND i.kind IN ('authority','run')
        AND (cardinality(p_organization_ids)=0 OR i.organization_id=ANY(p_organization_ids))
      ORDER BY i.closed_at,i.id LIMIT 20 FOR UPDATE SKIP LOCKED)
    SELECT picked.organization_id,picked.user_id,array_agg(picked.id ORDER BY picked.closed_at,picked.id) AS ids FROM picked
    GROUP BY picked.organization_id,picked.user_id ORDER BY min(picked.closed_at),picked.organization_id,picked.user_id LOOP
    BEGIN PERFORM app_private.hermes_schedule_notify_v2(v_group.ids,'recovered');
    EXCEPTION WHEN OTHERS THEN NULL; END;
    UPDATE app_private.hermes_schedule_incidents SET closed_notified_at=clock_timestamp() WHERE id=ANY(v_group.ids);
    v_notified:=v_notified+cardinality(v_group.ids);
  END LOOP;
  -- (g) Probe candidates; each probe runs in its own worker call.
  SELECT COALESCE(jsonb_agg(id ORDER BY ord),'[]'::jsonb) INTO v_probes FROM (
    SELECT s.id,row_number() OVER(ORDER BY s.last_probed_at NULLS FIRST,s.id) ord FROM app_private.hermes_room_schedules s
      JOIN app_private.hermes_schedule_grants g ON g.id=s.grant_id
    WHERE s.state='ACTIVE' AND g.expires_at>clock_timestamp() AND (s.last_probed_at IS NULL OR s.last_probed_at<clock_timestamp()-interval '10 minutes')
      AND (cardinality(p_organization_ids)=0 OR s.organization_id=ANY(p_organization_ids))
    ORDER BY s.last_probed_at NULLS FIRST,s.id LIMIT 5) candidates;
  RETURN jsonb_build_object('prunedCommands',COALESCE((v_pruned->>'count')::integer,0),'expiredJobs',v_expired,'observed',v_observed,
    'closed',v_closed,'expiry',v_expiry,'notified',v_notified,'probes',v_probes);
END $fn$;

-- Owner/ACL như bản cũ: tick và helper mới riêng tư, không role API nào được
-- EXECUTE; sweep chỉ worker (service_role).
ALTER FUNCTION app_private.hermes_task_follow_tick_v1(integer) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_follow_tick_v1(integer) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION app_private.hermes_schedule_notify_v2(uuid[],text) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_schedule_notify_v2(uuid[],text) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
ALTER FUNCTION public.hermes_room_schedule_sweep_v1(uuid,uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.hermes_room_schedule_sweep_v1(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.hermes_room_schedule_sweep_v1(uuid,uuid[]) TO service_role;

DO $kiem$
BEGIN
  IF has_function_privilege('authenticated','app_private.hermes_task_follow_tick_v1(integer)','EXECUTE')
    OR has_function_privilege('anon','app_private.hermes_task_follow_tick_v1(integer)','EXECUTE')
    OR has_function_privilege('authenticated','app_private.hermes_schedule_notify_v2(uuid[],text)','EXECUTE')
    OR has_function_privilege('service_role','app_private.hermes_schedule_notify_v2(uuid[],text)','EXECUTE')
    OR has_function_privilege('authenticated','public.hermes_room_schedule_sweep_v1(uuid,uuid[])','EXECUTE')
    OR has_function_privilege('anon','public.hermes_room_schedule_sweep_v1(uuid,uuid[])','EXECUTE')
    OR NOT has_function_privilege('service_role','public.hermes_room_schedule_sweep_v1(uuid,uuid[])','EXECUTE')
    OR has_table_privilege('authenticated','app_private.hermes_task_follows','SELECT')
    THEN RAISE EXCEPTION 'hermes_notify_retry_digest_acl_leak'; END IF;
END $kiem$;
COMMIT;
NOTIFY pgrst,'reload schema';
