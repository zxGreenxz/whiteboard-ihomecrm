-- Hermes Đợt 2b — trang Công việc, Mốc 2 (CV-M2; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 3.6). Q35 của chủ (chốt
-- 21/10): người được giao LUÔN thấy việc của chính mình, kể cả ở toà họ không có buildings.view; web và Hermes cùng MỘT hàm.
-- Chỉ phần XEM. Ghi tiến độ / hoàn thành việc của chính mình là migration riêng (Q64, chờ chủ), áp hay không áp độc lập.
--  (1) Hàm dùng chung public.job_visible_as_assignee_v1(assignee): đúng khi người gọi (auth.uid() theo JWT) là người nhận.
--  (2) Policy SELECT mới trên jobs, PERMISSIVE, gọi hàm (1): cộng thêm vào jobs_select_rbac (giữ nguyên); các policy RESTRICTIVE
--      (ranh giới công ty, ẩn demo/sandbox) vẫn áp. Vế này từng có và bị gỡ 28/05 (20260528000003).
--  (3) Đường đọc DEFINER của Hermes: danh sách việc giao cho tôi (role assigned_to_me) thêm đúng vế (1); dựng từ thân ĐANG CHẠY
--      production (md5 78f403b9…, đọc 22/10 bằng db:query, khớp file 20261015110000), chỉ đổi mệnh đề WHERE.
-- Không đổi quyền ghi. Idempotent; khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.jobs') IS NULL
    OR NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.jobs'::regclass AND polname='jobs_select_rbac')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_task_follow_read_v1(jsonb,jsonb)'::regprocedure AND prosecdef
      AND md5(replace(prosrc,chr(13),'')) IN ('78f403b9e2d00485a1c17b043a58ea42','9f2af77801993c6deba09d5adcbe19ca')) THEN
    RAISE EXCEPTION 'jobs_assignee_visible_dependency_invalid'; END IF;
END $requires$;

-- 1. Luật dùng chung: người nhận thấy việc của mình. auth.uid() đọc JWT nên cùng nghĩa trong RLS (INVOKER) lẫn trong hàm DEFINER.
CREATE OR REPLACE FUNCTION public.job_visible_as_assignee_v1(p_assignee_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path=pg_catalog,public AS $fn$
  SELECT p_assignee_id IS NOT NULL AND p_assignee_id=auth.uid()
$fn$;
ALTER FUNCTION public.job_visible_as_assignee_v1(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.job_visible_as_assignee_v1(uuid) FROM PUBLIC,anon,authenticated,service_role,hermes_store_executor;
GRANT EXECUTE ON FUNCTION public.job_visible_as_assignee_v1(uuid) TO authenticated;

-- 2. Policy SELECT cộng thêm (không sửa jobs_select_rbac).
DO $policy$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.jobs'::regclass AND polname='jobs_select_own_assignee') THEN
    CREATE POLICY jobs_select_own_assignee ON public.jobs AS PERMISSIVE FOR SELECT TO authenticated
      USING (public.job_visible_as_assignee_v1(assignee_id));
  END IF;
END $policy$;

-- 3. Danh sách việc giao cho tôi của Hermes: thêm vế người nhận (cùng hàm (1)), ngoài phạm vi toà tasks.view của kết nối.
CREATE OR REPLACE FUNCTION public.hermes_task_follow_read_v1(p_binding jsonb,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE c app_private.hermes_connections; v_role text; v_status text; v_assignee uuid; v_limit integer; v_offset integer;
  v_buildings uuid[]; v_now timestamptz; v_rows jsonb; v_next integer;
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
  SELECT COALESCE(jsonb_agg(item ORDER BY ord),'[]') INTO v_rows FROM (
    SELECT row_number() OVER (ORDER BY (j.deadline IS NULL),j.deadline,j.id) ord,jsonb_build_object(
      'id',j.id,'code',COALESCE(app_private.hermes_task_follow_label_v1(j.code,64),'—'),
      'title',COALESCE(app_private.hermes_task_follow_label_v1(j.title,200),'(không tiêu đề)'),
      'status',j.status,'buildingId',j.building_id,'roomId',j.room_id,'deadline',app_private.hermes_task_follow_iso_v1(j.deadline),
      'overdue',(j.status='IN_PROGRESS' AND j.deadline IS NOT NULL AND j.deadline<=v_now),
      'assigneeId',j.assignee_id,'assigneeName',app_private.hermes_task_follow_name_v1(j.assignee_id),'createdBy',j.user_id,
      'progressNote',CASE WHEN j.completion_description IS NULL THEN NULL ELSE left(j.completion_description,1000) END,
      'progressDigest',md5(COALESCE(j.completion_description,'')),
      'follows',COALESCE((SELECT jsonb_agg(x.follow ORDER BY x.created_at,x.id) FROM (
        SELECT app_private.hermes_task_follow_json_v1(f) follow,f.created_at,f.id FROM app_private.hermes_task_follows f
          WHERE f.job_id=j.id AND f.organization_id=c.organization_id AND f.state='ACTIVE'
          AND (f.assigner_user_id=c.user_id OR f.executor_user_id=c.user_id) ORDER BY f.created_at,f.id LIMIT 5) x),'[]'::jsonb)) item
    FROM public.jobs j
    WHERE j.organization_id=c.organization_id
      AND (j.building_id=ANY(v_buildings) OR (v_role='assigned_to_me' AND public.job_visible_as_assignee_v1(j.assignee_id)))
      AND (v_status='all' OR (v_status='open' AND j.status='IN_PROGRESS') OR (v_status='completed' AND j.status='COMPLETED'))
      AND CASE v_role WHEN 'assigned_to_me' THEN j.assignee_id=c.user_id
        WHEN 'assigned_by_me' THEN j.user_id=c.user_id OR EXISTS(SELECT 1 FROM app_private.hermes_task_follows f
          WHERE f.job_id=j.id AND f.organization_id=c.organization_id AND f.assigner_user_id=c.user_id AND f.state='ACTIVE')
        ELSE v_assignee IS NULL OR j.assignee_id=v_assignee END
    ORDER BY (j.deadline IS NULL),j.deadline,j.id LIMIT v_limit+1 OFFSET v_offset) found;
  IF jsonb_array_length(v_rows)>v_limit THEN
    SELECT jsonb_agg(value ORDER BY ordinality) INTO v_rows FROM jsonb_array_elements(v_rows) WITH ORDINALITY WHERE ordinality<=v_limit;
    v_next:=CASE WHEN v_offset+v_limit<=200 THEN v_offset+v_limit ELSE NULL END;
  END IF;
  IF octet_length(v_rows::text)>60000 THEN RAISE EXCEPTION 'hermes_task_response_too_large' USING ERRCODE='22023'; END IF;
  -- Final lifetime check: a slow read cannot outlive the credential.
  PERFORM app_private.hermes_private_command_connection_v1(p_binding->>'tokenDigest');
  RETURN jsonb_build_object('organizationId',c.organization_id,'role',v_role,'status',v_status,
    'readAt',app_private.hermes_task_follow_iso_v1(v_now),'items',v_rows,'offset',v_offset,'nextOffset',v_next);
END $fn$;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='public.jobs'::regclass AND p.polname='jobs_select_own_assignee' AND p.polcmd='r' AND p.polpermissive
      AND pg_get_expr(p.polqual,p.polrelid) LIKE '%job_visible_as_assignee_v1(assignee_id)%')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.job_visible_as_assignee_v1(uuid)'::regprocedure AND NOT prosecdef AND provolatile='s')
    OR has_function_privilege('anon','public.job_visible_as_assignee_v1(uuid)','EXECUTE')
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.hermes_task_follow_read_v1(jsonb,jsonb)'::regprocedure AND prosecdef
      AND md5(replace(prosrc,chr(13),''))='9f2af77801993c6deba09d5adcbe19ca') THEN
    RAISE EXCEPTION 'jobs_assignee_visible_check_failed'; END IF;
END $check$;

COMMIT;
NOTIFY pgrst,'reload schema';
