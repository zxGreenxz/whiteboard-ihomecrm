-- Hermes Đợt 2b — trang Công việc, Mốc 5 (docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 5.2, 22): bộ sinh việc định kỳ.
-- app_private.hermes_task_recurrence_generate_v1(p_today) — DEFINER, cron 'job-recurrence-daily' lúc 00:10 giờ Việt Nam (17:10 UTC).
--  1. Mỗi quy tắc đang chạy (chưa xoá, chưa tạm dừng): các ngày đến hạn trong (last_generated_date, hôm nay theo giờ công ty], bù tối
--     đa 7 ngày sau sự cố. Dòng quy tắc khoá FOR NO KEY UPDATE SKIP LOCKED: đang bị người dùng / Hermes sửa ⇒ bỏ lượt này (lượt sau bù).
--  2. INSERT lần sinh (quy tắc, ngày) ON CONFLICT DO NOTHING; chỉ ngày vừa chèn được mới sinh việc ⇒ chạy lại hay hai lần chạy song
--     song không bao giờ sinh trùng.
--  3. Kiểm lại trước khi sinh: người tạo còn là thành viên ACTIVE và còn tasks.create ở toà (authorize_tenant_action_v3 — cùng hàm quyền
--     policy INSERT jobs dựa vào), toà / phòng / loại còn sống, người nhận còn là thành viên. Hỏng ⇒ tạm dừng quy tắc kèm lý do, ghi lần
--     sinh 'skipped', audit JOB_RECURRENCE_PAUSED.
--  4. Việc sinh ra là việc thường: user_id = người tạo quy tắc (trigger jobs_set_user_id_audit chỉ điền khi trống), mã việc và E4 do
--     trigger như web; hạn = cuối ngày (ngày sinh + due_days) giờ công ty; mô tả có dòng "(định kỳ DK-NNNN)". Sổ hermes_task_jobs
--     ghi source = recurrence (không tính hạn mức Q37).
--  5. Mỗi quy tắc một khối con: một quy tắc lỗi không chặn quy tắc khác.
-- Không khoá dòng công ty (không vòng với guard Hermes). Chỉ chủ hàm gọi (cron). Không DROP. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.job_recurrence_rules') IS NULL OR to_regclass('public.job_recurrence_occurrences') IS NULL
    OR to_regprocedure('public.job_recurrence_dates_v1(text,integer,smallint[],integer,date,date,date,date)') IS NULL
    OR to_regprocedure('public.job_deadline_v1(uuid,date,time)') IS NULL OR to_regprocedure('public.org_today_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_task_assignee_member_v1(uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.authorize_tenant_action_v3(uuid,uuid,text,uuid,uuid)') IS NULL
    OR to_regprocedure('app_private.append_authz_audit_v1(uuid,text,text,uuid,jsonb,jsonb,text)') IS NULL
    OR to_regclass('app_private.hermes_task_jobs') IS NULL THEN
    RAISE EXCEPTION 'hermes_task_recurrence_generate_dependency_invalid'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION app_private.hermes_task_recurrence_generate_v1(p_today date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE r public.job_recurrence_rules; v_id uuid; v_today date; v_from date; d date; v_reason text; v_job uuid; v_n integer;
  v_checked integer:=0; v_generated integer:=0; v_paused integer:=0; v_failed integer:=0; v_busy integer:=0;
BEGIN
  FOR v_id IN SELECT x.id FROM public.job_recurrence_rules x WHERE x.deleted_at IS NULL AND x.paused_at IS NULL ORDER BY x.organization_id,x.code LOOP
    BEGIN
      SELECT x.* INTO r FROM public.job_recurrence_rules x WHERE x.id=v_id AND x.deleted_at IS NULL AND x.paused_at IS NULL
        FOR NO KEY UPDATE SKIP LOCKED;
      IF NOT FOUND THEN v_busy:=v_busy+1; CONTINUE; END IF;
      v_checked:=v_checked+1;
      v_today:=COALESCE(p_today,public.org_today_v1(r.organization_id));
      v_from:=GREATEST(COALESCE(r.last_generated_date,r.start_date-1)+1,v_today-6,r.start_date);
      IF v_from>v_today OR (r.end_date IS NOT NULL AND v_from>r.end_date) THEN CONTINUE; END IF;
      v_reason:=NULL;
      IF NOT COALESCE(app_private.hermes_task_assignee_member_v1(r.created_by,r.organization_id),false) THEN v_reason:='membership_lost';
      ELSIF NOT COALESCE((SELECT a.allowed FROM app_private.authorize_tenant_action_v3(r.created_by,r.organization_id,'tasks.create',
          r.building_id,NULL) a),false) THEN v_reason:='permission_lost';
      ELSIF NOT EXISTS(SELECT 1 FROM public.buildings b WHERE b.id=r.building_id AND b.organization_id=r.organization_id AND b.deleted_at IS NULL
          AND NOT COALESCE(b.is_virtual,false))
        OR (r.room_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.rooms rm WHERE rm.id=r.room_id AND rm.building_id=r.building_id
          AND rm.deleted_at IS NULL))
        OR NOT EXISTS(SELECT 1 FROM public.job_types j WHERE j.id=r.job_type_id AND j.organization_id=r.organization_id
          AND COALESCE(j.is_active,true)) THEN v_reason:='target_deleted';
      ELSIF r.assignee_id IS NOT NULL AND NOT COALESCE(app_private.hermes_task_assignee_member_v1(r.assignee_id,r.organization_id),false) THEN
        v_reason:='membership_lost';
      END IF;
      IF v_reason IS NOT NULL THEN
        INSERT INTO public.job_recurrence_occurrences(rule_id,occurrence_date,organization_id,outcome,reason)
          SELECT r.id,x,r.organization_id,'skipped',v_reason
          FROM public.job_recurrence_dates_v1(r.frequency,r.every,r.weekdays,r.month_day,r.start_date,r.end_date,v_from,v_today) x
          ON CONFLICT (rule_id,occurrence_date) DO NOTHING;
        UPDATE public.job_recurrence_rules SET paused_at=clock_timestamp(),paused_reason=v_reason WHERE id=r.id;
        PERFORM app_private.append_authz_audit_v1(r.organization_id,'JOB_RECURRENCE_PAUSED','job_recurrence_rule',r.id,NULL,
          jsonb_build_object('code',r.code,'reason',v_reason,'createdBy',r.created_by,'assigneeId',r.assignee_id,'buildingId',r.building_id),
          'Job recurrence auto-paused');
        v_paused:=v_paused+1;
        CONTINUE;
      END IF;
      FOR d IN SELECT x FROM public.job_recurrence_dates_v1(r.frequency,r.every,r.weekdays,r.month_day,r.start_date,r.end_date,v_from,v_today) x
          ORDER BY 1 LOOP
        INSERT INTO public.job_recurrence_occurrences(rule_id,occurrence_date,organization_id,outcome)
          VALUES(r.id,d,r.organization_id,'generated') ON CONFLICT (rule_id,occurrence_date) DO NOTHING;
        GET DIAGNOSTICS v_n=ROW_COUNT;
        IF v_n=0 THEN CONTINUE; END IF;
        INSERT INTO public.jobs(user_id,organization_id,title,description,building_id,room_id,job_type_id,priority,assignee_id,assignee_name,
          deadline,status,started_at,visible_to_customer)
        VALUES(r.created_by,r.organization_id,r.title,left(COALESCE(r.description,r.title)||E'\n(định kỳ '||r.code||')',4000),r.building_id,
          r.room_id,r.job_type_id,r.priority,r.assignee_id,NULL,public.job_deadline_v1(r.organization_id,d+r.due_days,NULL),'IN_PROGRESS',
          clock_timestamp(),false)
        RETURNING id INTO v_job;
        UPDATE public.job_recurrence_occurrences SET job_id=v_job WHERE rule_id=r.id AND occurrence_date=d;
        INSERT INTO app_private.hermes_task_jobs(job_id,organization_id,actor_id,assignee_id,request_id,action,source)
          VALUES(v_job,r.organization_id,r.created_by,r.assignee_id,NULL,'task.recurring_create','recurrence');
        v_generated:=v_generated+1;
      END LOOP;
      UPDATE public.job_recurrence_rules SET last_generated_date=v_today
        WHERE id=r.id AND (last_generated_date IS NULL OR last_generated_date<v_today);
    EXCEPTION WHEN OTHERS THEN
      v_failed:=v_failed+1;
      RAISE WARNING 'hermes_task_recurrence_generate_v1: rule % failed (%)',v_id,SQLSTATE;
    END;
  END LOOP;
  RETURN jsonb_build_object('checked',v_checked,'generated',v_generated,'paused',v_paused,'failed',v_failed,'busy',v_busy);
END $fn$;

ALTER FUNCTION app_private.hermes_task_recurrence_generate_v1(date) OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.hermes_task_recurrence_generate_v1(date) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;

-- Lịch: pg_cron sẵn có (như hermes-task-follow-15m). DB diễn tập không có cron thì bỏ qua; cron.schedule theo tên là ghi đè.
DO $cronblock$
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE NOTICE 'Không có schema cron — bỏ qua đăng ký lịch sinh việc định kỳ.';
    RETURN;
  END IF;
  PERFORM cron.schedule('job-recurrence-daily','10 17 * * *','SELECT app_private.hermes_task_recurrence_generate_v1();');
END
$cronblock$;

DO $check$
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid='app_private.hermes_task_recurrence_generate_v1(date)'::regprocedure)
    OR COALESCE((SELECT p.proacl::text FROM pg_proc p WHERE p.oid='app_private.hermes_task_recurrence_generate_v1(date)'::regprocedure),'')
      ~ '(^|[{,])(authenticated|anon|service_role|hermes_store_executor)=' THEN
    RAISE EXCEPTION 'hermes_task_recurrence_generate_check_failed'; END IF;
END $check$;
COMMIT;
