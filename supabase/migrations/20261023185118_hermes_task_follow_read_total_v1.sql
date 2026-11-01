-- Hermes trang Công việc, lượt 11 — sửa theo nghiệm thu bot thật trên TEST (23–24/10). Đường đọc "việc giao cho tôi / tôi giao /
-- nhóm" của Hermes (public.hermes_task_follow_read_v1, DEFINER): dựng từ thân production (md5 9f2af77801993c6deba09d5adcbe19ca, đọc 24/10 bằng db:query,
-- khớp file 20261022031600). Quyền / phạm vi / mệnh đề lọc giữ nguyên từng chữ (chỉ dời vào CTE base).
--  (1) Trả TỔNG của cả tập lọc ('total') và 'summary' {total, open, overdue, completed, byBuilding ≤ 50 nhóm} — trước chỉ có một trang
--      (mặc định 20 dòng) nên bot báo thiếu. Trang + nextOffset như cũ (phân trang).
--  (2) Mỗi dòng thêm 'buildingName' (chữ, có thể rỗng) và 'roomName' (null = cả toà) cạnh buildingId / roomId.
-- KHUÔN TRẢ VỀ ĐỔI ⇒ PHÁT HÀNH CONNECTOR TRƯỚC (bản nhận cả khuôn cũ lẫn mới, infra/hermes-broker/task-follow-contract.mjs): connector
-- cũ kiểm khoá chặt sẽ từ chối khoá mới. Không DROP. Idempotent.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regprocedure('public.job_visible_as_assignee_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.hermes_task_follow_label_v1(text,integer)') IS NULL
    -- Thân đang chạy phải đúng thân 20261022031600 (hoặc đúng thân của file này khi chạy lại).
    OR (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='public.hermes_task_follow_read_v1(jsonb,jsonb)'::regprocedure AND p.prosecdef) NOT IN ('9f2af77801993c6deba09d5adcbe19ca','54ee44b8d50a5d44611b0ac5e1616b85') THEN
    RAISE EXCEPTION 'hermes_task_follow_read_total_dependency_invalid'; END IF;
END $requires$;

CREATE OR REPLACE FUNCTION public.hermes_task_follow_read_v1(p_binding jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; v_role text; v_status text; v_assignee uuid; v_limit integer; v_offset integer;
  v_buildings uuid[]; v_now timestamptz; v_rows jsonb; v_next integer; v_summary jsonb;
BEGIN
  PERFORM app_private.hermes_request_v1(p_input,ARRAY['organizationId','role','assigneeUserId','status','limit','offset']);
  PERFORM app_private.hermes_uuid_v1(p_input->'organizationId');
  v_role:=p_input->>'role'; v_status:=p_input->>'status';
  IF jsonb_typeof(p_input->'role') IS DISTINCT FROM 'string' OR v_role NOT IN ('assigned_to_me','assigned_by_me','team')
    OR jsonb_typeof(p_input->'status') IS DISTINCT FROM 'string' OR v_status NOT IN ('open','completed','all')
    THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
  IF p_input->'assigneeUserId'<>'null'::jsonb THEN
    IF v_role<>'team' THEN RAISE EXCEPTION 'hermes_task_invalid' USING ERRCODE='22023'; END IF;
    v_assignee:=app_private.hermes_uuid_v1(p_input->'assigneeUserId');
  END IF;
  v_limit:=app_private.hermes_task_follow_int_v1(p_input->'limit',1,50);
  v_offset:=app_private.hermes_task_follow_int_v1(p_input->'offset',0,200);
  c:=app_private.hermes_task_follow_connection_v1(p_binding);
  IF p_input->>'organizationId' IS DISTINCT FROM c.organization_id::text
    OR NOT app_private.hermes_task_follow_capable_v1(c,'tasks.view','read','tasks.view')
    THEN RAISE EXCEPTION 'hermes_task_denied' USING ERRCODE='42501'; END IF;
  v_buildings:=app_private.hermes_task_follow_buildings_v1(c,'tasks.view');
  v_now:=clock_timestamp();
  -- Nghiệm thu 23–24/10: trả TỔNG + summary của cả tập lọc (không chỉ một trang 20 dòng) và tên toà / phòng của từng dòng (chỉ id thì bot
  -- không nêu được). Cùng một mệnh đề WHERE cho trang và cho summary (CTE base).
  WITH base AS MATERIALIZED (SELECT j.* FROM public.jobs j
    WHERE j.organization_id=c.organization_id
      AND (j.building_id=ANY(v_buildings) OR (v_role='assigned_to_me' AND public.job_visible_as_assignee_v1(j.assignee_id)))
      AND (v_status='all' OR (v_status='open' AND j.status='IN_PROGRESS') OR (v_status='completed' AND j.status='COMPLETED'))
      AND CASE v_role WHEN 'assigned_to_me' THEN j.assignee_id=c.user_id
        WHEN 'assigned_by_me' THEN j.user_id=c.user_id OR EXISTS(SELECT 1 FROM app_private.hermes_task_follows f
          WHERE f.job_id=j.id AND f.organization_id=c.organization_id AND f.assigner_user_id=c.user_id AND f.state='ACTIVE')
        ELSE v_assignee IS NULL OR j.assignee_id=v_assignee END),
  page AS (
    SELECT row_number() OVER (ORDER BY (j.deadline IS NULL),j.deadline,j.id) ord,jsonb_build_object(
      'id',j.id,'code',COALESCE(app_private.hermes_task_follow_label_v1(j.code,64),'—'),
      'title',COALESCE(app_private.hermes_task_follow_label_v1(j.title,200),'(không tiêu đề)'),
      'status',j.status,'buildingId',j.building_id,
      'buildingName',COALESCE(app_private.hermes_task_follow_label_v1((SELECT b.name FROM public.buildings b WHERE b.id=j.building_id),120),''),
      'roomId',j.room_id,'roomName',app_private.hermes_task_follow_label_v1((SELECT r.name FROM public.rooms r WHERE r.id=j.room_id),120),
      'deadline',app_private.hermes_task_follow_iso_v1(j.deadline),
      'overdue',(j.status='IN_PROGRESS' AND j.deadline IS NOT NULL AND j.deadline<=v_now),
      'assigneeId',j.assignee_id,'assigneeName',app_private.hermes_task_follow_name_v1(j.assignee_id),'createdBy',j.user_id,
      'progressNote',CASE WHEN j.completion_description IS NULL THEN NULL ELSE left(j.completion_description,1000) END,
      'progressDigest',md5(COALESCE(j.completion_description,'')),
      'follows',COALESCE((SELECT jsonb_agg(x.follow ORDER BY x.created_at,x.id) FROM (
        SELECT app_private.hermes_task_follow_json_v1(f) follow,f.created_at,f.id FROM app_private.hermes_task_follows f
          WHERE f.job_id=j.id AND f.organization_id=c.organization_id AND f.state='ACTIVE'
          AND (f.assigner_user_id=c.user_id OR f.executor_user_id=c.user_id) ORDER BY f.created_at,f.id LIMIT 5) x),'[]'::jsonb)) item
    FROM base j
    ORDER BY (j.deadline IS NULL),j.deadline,j.id LIMIT v_limit+1 OFFSET v_offset),
  groups AS (
    SELECT b.building_id,count(*)::int n,(count(*) FILTER (WHERE b.status='IN_PROGRESS' AND b.deadline IS NOT NULL AND b.deadline<=v_now))::int o
    FROM base b GROUP BY b.building_id ORDER BY count(*) DESC,b.building_id NULLS LAST LIMIT 50)
  SELECT (SELECT COALESCE(jsonb_agg(p.item ORDER BY p.ord),'[]') FROM page p),
    (SELECT jsonb_build_object('total',count(*)::int,'open',(count(*) FILTER (WHERE b.status='IN_PROGRESS'))::int,
        'overdue',(count(*) FILTER (WHERE b.status='IN_PROGRESS' AND b.deadline IS NOT NULL AND b.deadline<=v_now))::int,
        'completed',(count(*) FILTER (WHERE b.status='COMPLETED'))::int,
        'byBuilding',(SELECT COALESCE(jsonb_agg(jsonb_build_object('buildingId',g.building_id,
            'buildingName',COALESCE(app_private.hermes_task_follow_label_v1((SELECT x.name FROM public.buildings x WHERE x.id=g.building_id),120),''),
            'count',g.n,'overdue',g.o) ORDER BY g.n DESC,g.building_id NULLS LAST),'[]'::jsonb) FROM groups g))
      FROM base b)
    INTO v_rows,v_summary;
  IF jsonb_array_length(v_rows)>v_limit THEN
    SELECT jsonb_agg(value ORDER BY ordinality) INTO v_rows FROM jsonb_array_elements(v_rows) WITH ORDINALITY WHERE ordinality<=v_limit;
    v_next:=CASE WHEN v_offset+v_limit<=200 THEN v_offset+v_limit ELSE NULL END;
  END IF;
  IF octet_length(v_rows::text)>60000 THEN RAISE EXCEPTION 'hermes_task_response_too_large' USING ERRCODE='22023'; END IF;
  -- Final lifetime check: a slow read cannot outlive the credential.
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  RETURN jsonb_build_object('organizationId',c.organization_id,'role',v_role,'status',v_status,
    'readAt',app_private.hermes_task_follow_iso_v1(v_now),'items',v_rows,'offset',v_offset,'nextOffset',v_next,
    'total',v_summary->'total','summary',v_summary);
END $fn$;

DO $check$
BEGIN
  IF (SELECT md5(replace(p.prosrc,chr(13),'')) FROM pg_proc p WHERE p.oid='public.hermes_task_follow_read_v1(jsonb,jsonb)'::regprocedure AND p.prosecdef) IS DISTINCT FROM '54ee44b8d50a5d44611b0ac5e1616b85'
    OR has_function_privilege('anon','public.hermes_task_follow_read_v1(jsonb,jsonb)','EXECUTE') THEN
    RAISE EXCEPTION 'hermes_task_follow_read_total_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
