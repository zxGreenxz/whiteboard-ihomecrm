-- Hermes Đợt 2b — trang Công việc (CV-M2b; docs/plans/hermes-crm/CONG-VIEC-THAO-TAC-GHI.md mục 3.6, CV5). Q64 của chủ (CHƯA trả
-- lời; đề xuất (a) "Có, nhưng chỉ với việc giao cho chính họ"): người được giao việc ở toà mình KHÔNG có tasks.edit được ghi
-- tiến độ và bấm hoàn thành việc giao cho chính mình. Migration riêng, áp hay không áp độc lập với phần XEM (20261022031600, phụ
-- thuộc hàm dùng chung của file đó). Phiên chính chỉ áp khi chủ chọn (a).
--  (1) Policy UPDATE mới trên jobs, PERMISSIVE: người nhận sửa được hàng của việc giao cho chính mình (cùng hàm XEM). jobs_update_rbac
--      giữ nguyên; các policy RESTRICTIVE vẫn áp.
--  (2) Guard cột (trigger DEFINER ở app_private + WHEN current_user IN (authenticated, anon), mẫu 20261021114556): người có
--      tasks.edit ở toà (hoặc siêu quản trị) đi như cũ; người chỉ tới được hàng nhờ policy (1) chỉ đổi được cột tiến độ / hoàn
--      thành (status IN_PROGRESS → COMPLETED, completion_*, attachments) — đổi tiêu đề, toà, phòng, người nhận, hạn, mở lại việc
--      đã xong ⇒ 42501. Hàm hệ thống (DEFINER) ghi jobs không bị guard chạm (WHEN theo vai của câu lệnh).
-- Không đổi quyền xoá hay tạo. Idempotent; khối kiểm cuối chỉ đọc catalog.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';

DO $requires$
BEGIN
  IF to_regclass('public.jobs') IS NULL
    OR to_regprocedure('public.job_visible_as_assignee_v1(uuid)') IS NULL
    OR to_regprocedure('app_private.buildings_for_v3(text)') IS NULL
    OR to_regprocedure('public.is_super_admin()') IS NULL
    OR to_regprocedure('public.can_access_org_entity(text,text)') IS NULL THEN
    RAISE EXCEPTION 'jobs_assignee_progress_dependency_invalid'; END IF;
END $requires$;

-- 1. Policy UPDATE cộng thêm cho người nhận (không sửa jobs_update_rbac).
DO $policy$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.jobs'::regclass AND polname='jobs_update_own_assignee') THEN
    CREATE POLICY jobs_update_own_assignee ON public.jobs AS PERMISSIVE FOR UPDATE TO authenticated
      USING (public.job_visible_as_assignee_v1(assignee_id)) WITH CHECK (public.job_visible_as_assignee_v1(assignee_id));
  END IF;
END $policy$;

-- 2. Guard cột cho người chỉ có quyền nhờ là người nhận.
CREATE OR REPLACE FUNCTION app_private.jobs_assignee_update_guard_v1()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,public,app_private AS $fn$
DECLARE v_open text[]:=ARRAY['status','completion_time','completion_attachments','completion_captured_at','completion_lat','completion_lng',
  'completion_distance_m','completion_geofence_status','completion_address','completion_description','attachments','updated_at'];
BEGIN
  IF COALESCE(public.is_super_admin(),false)
    OR (OLD.building_id IS NOT NULL AND OLD.building_id=ANY(COALESCE(app_private.buildings_for_v3('tasks.edit'),'{}'::uuid[])))
    OR (OLD.building_id IS NULL AND COALESCE(public.can_access_org_entity('tasks','edit'),false)) THEN RETURN NEW; END IF;
  IF OLD.assignee_id IS NULL OR OLD.assignee_id IS DISTINCT FROM auth.uid()
    OR (to_jsonb(NEW)-v_open) IS DISTINCT FROM (to_jsonb(OLD)-v_open)
    OR NOT (NEW.status IS NOT DISTINCT FROM OLD.status OR (OLD.status='IN_PROGRESS' AND NEW.status='COMPLETED')) THEN
    RAISE EXCEPTION 'Người được giao chỉ được ghi tiến độ và hoàn thành việc giao cho chính mình' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $fn$;
ALTER FUNCTION app_private.jobs_assignee_update_guard_v1() OWNER TO postgres;
REVOKE ALL ON FUNCTION app_private.jobs_assignee_update_guard_v1() FROM PUBLIC,anon,authenticated,service_role;

DO $trigger$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.jobs'::regclass AND tgname='zz_jobs_assignee_update_guard') THEN
    CREATE TRIGGER zz_jobs_assignee_update_guard BEFORE UPDATE ON public.jobs FOR EACH ROW
      WHEN (current_user IN ('authenticated','anon')) EXECUTE FUNCTION app_private.jobs_assignee_update_guard_v1();
  END IF;
END $trigger$;

DO $check$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_policy p WHERE p.polrelid='public.jobs'::regclass AND p.polname='jobs_update_own_assignee' AND p.polcmd='w' AND p.polpermissive
      AND pg_get_expr(p.polqual,p.polrelid) LIKE '%job_visible_as_assignee_v1(assignee_id)%'
      AND pg_get_expr(p.polwithcheck,p.polrelid) LIKE '%job_visible_as_assignee_v1(assignee_id)%')
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.jobs'::regclass AND tgname='zz_jobs_assignee_update_guard' AND NOT tgisinternal
      AND tgfoid='app_private.jobs_assignee_update_guard_v1()'::regprocedure)
    OR NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='app_private.jobs_assignee_update_guard_v1()'::regprocedure AND prosecdef)
    OR has_function_privilege('authenticated','app_private.jobs_assignee_update_guard_v1()','EXECUTE') THEN
    RAISE EXCEPTION 'jobs_assignee_progress_check_failed'; END IF;
END $check$;

COMMIT;
