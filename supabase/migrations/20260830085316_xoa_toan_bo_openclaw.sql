-- =============================================================================
-- XÓA TOÀN BỘ OPENCLAW KHỎI DATABASE
--
-- VÌ SAO: OpenClaw ngừng phát triển 25/08/2026 (CLAUDE.md, test-matrix
--   blockedFromCi). Chủ dự án chốt 30/08/2026: đây là dead code, xóa hẳn.
--   Đo trên production 30/08/2026: 79 bảng openclaw_* chiếm 540 MB trong tổng
--   894 MB database (60%) nhưng chỉ chứa 926 dòng dữ liệu thật — phần còn lại
--   là bloat do cron `openclaw-maintenance-v1` chạy MỖI PHÚT tự đẻ ra
--   (openclaw_service_nonces: 617 dòng / 305 MB). Trên máy Micro 1 GB RAM,
--   đống này ép cache hit ratio xuống 86.5% và làm cả app lag với 2 người dùng.
--
-- ĐƯỜNG LÙI: bản dump đầy đủ ihomecrm-full-2026-08-30T08-51-19-514Z.dump
--   (106.5 MB, sha256 d6d0ecb186626066…, manifest cùng tên .json) + backup JSON
--   riêng cho permission_definitions/role_permissions openclaw và thân hàm gốc
--   trg_room_status_reconcile tại %USERPROFILE%/ihomecrm-backups/openclaw-xoa-2026-08-30/.
--   16 file migration openclaw gốc GIỮ NGUYÊN trong repo (ledger đóng băng) —
--   schema dựng lại được nếu đổi ý.
--
-- THỨ TỰ TRONG FILE LÀ BẮT BUỘC (kiểm kê phụ thuộc 30/08/2026):
--   (0) grant membership các role openclaw cho user chạy migration — cần để
--       CREATE OR REPLACE hàm do openclaw_function_owner sở hữu và REASSIGN sau đó
--   (1) dừng cron TRƯỚC — job chạy mỗi phút, không dừng thì nó giữ lock trên
--       bảng openclaw và DROP TABLE chờ/deadlock
--   (2) rút 7 bảng openclaw khỏi publication supabase_realtime
--   (3) thay thân public.trg_room_status_reconcile — hàm nghiệp vụ SỐNG trên
--       rooms nhưng thân cũ đọc cột openclaw_availability_revision và gọi
--       app_private.openclaw_insert_crm_occurrence_v1; không thay trước thì
--       mọi UPDATE rooms chết ngay sau khi drop
--   (4) drop 6 trigger openclaw trên bảng sống (rooms, leads, lead_activities,
--       organization_roles)
--   (5) drop 10 policy openclaw trên bảng sống (đếm trực tiếp từ pg_policies
--       30/08 — nhiều hơn con số 2 trong kiểm kê sơ bộ)
--   (6) xóa dữ liệu quyền openclaw_zalo.* — member_permission_overrides và
--       role_permissions TRƯỚC (cả hai FK vào permission_definitions.key)
--   (7) drop 5 cột openclaw trên rooms/leads/lead_activities — sau (3) vì thân
--       hàm cũ là nơi DUY NHẤT ngoài openclaw đọc các cột này (đã grep pg_proc)
--   (8) drop 79 bảng openclaw_* CASCADE — không bảng sống nào FK vào (đã kiểm)
--   (9) drop 249 hàm %openclaw% ở public + app_private (sinh động vì overload)
--   (10) REASSIGN/DROP OWNED/DROP ROLE 5 role openclaw_* — CUỐI CÙNG
--
-- IDEMPOTENT: mọi bước quét catalog rồi mới hành động; chạy lần hai là no-op.
-- REPLAY TỪ DB RỖNG: các bước cron/publication/role đều guard tồn tại — môi
--   trường replay (PGlite) không có pg_cron/publication vẫn chạy qua được.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '15s';

-- (0) Membership để được quyền thay owner / replace hàm của openclaw_function_owner
DO $buoc0$
DECLARE r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'openclaw_%' LOOP
    BEGIN
      EXECUTE format('GRANT %I TO %I', r.rolname, current_user);
    EXCEPTION WHEN OTHERS THEN
      NULL; -- đã là member, hoặc môi trường replay là superuser: đều không sao
    END;
  END LOOP;
END $buoc0$;

-- (1) Dừng cron openclaw + giãn clone_org_sync_worker (15 giây -> 5 phút)
--     clone_org_sync_worker không thuộc openclaw nhưng 5.745 lần chạy/ngày với
--     avg 0.00s cho thấy queue gần như luôn rỗng — 5 phút là đủ, đỡ rác
--     job_run_details. Giữ nguyên command, chỉ đổi lịch.
DO $buoc1$
DECLARE v_id bigint; v_cmd text;
BEGIN
  IF pg_catalog.to_regclass('cron.job') IS NULL THEN
    RETURN; -- môi trường replay không có pg_cron
  END IF;
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'openclaw-maintenance-v1';
  SELECT jobid, command INTO v_id, v_cmd FROM cron.job WHERE jobname = 'clone_org_sync_worker';
  IF v_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'clone_org_sync_worker' AND schedule = '*/5 * * * *'
  ) THEN
    PERFORM cron.unschedule(v_id);
    PERFORM cron.schedule('clone_org_sync_worker', '*/5 * * * *', v_cmd);
  END IF;
END $buoc1$;

-- (2) Rút bảng openclaw khỏi realtime publication
DO $buoc2$
DECLARE r record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RETURN;
  END IF;
  FOR r IN
    SELECT schemaname, tablename FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename LIKE 'openclaw%'
  LOOP
    EXECUTE format('ALTER PUBLICATION supabase_realtime DROP TABLE %I.%I', r.schemaname, r.tablename);
  END LOOP;
END $buoc2$;

-- (3) Thay thân trg_room_status_reconcile: gỡ occurrence OpenClaw, GIỮ recompute.
--     Thân gốc đã backup tại openclaw-xoa-2026-08-30/trg_room_status_reconcile_GOC.json.
CREATE OR REPLACE FUNCTION public.trg_room_status_reconcile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
begin
  -- Trước 30/08/2026 hàm này còn phát "CRM occurrence" cho OpenClaw mỗi khi
  -- phòng chuyển về AVAILABLE. OpenClaw đã xóa; việc còn lại của trigger là
  -- đồng bộ lại reservation của phòng sau khi trạng thái đổi.
  perform public.recompute_room_reservation(NEW.id);
  return null;
end;
$function$;

DO $buoc3$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
    ALTER FUNCTION public.trg_room_status_reconcile() OWNER TO postgres;
  END IF;
END $buoc3$;

-- (4) Trigger openclaw trên bảng SỐNG. Danh sách đo 30/08:
--     rooms.openclaw_rooms_availability_revision,
--     leads.openclaw_leads_assignment_revision, leads.openclaw_leads_emit_typed_occurrence,
--     lead_activities.openclaw_lead_activities_organization,
--     lead_activities.openclaw_lead_activities_schedule_revision,
--     organization_roles.organization_roles_provision_openclaw_owner_v1
--     Quét động thay vì liệt kê cứng để bắt cả trigger lọt kiểm kê.
DO $buoc4$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT t.tgname, n.nspname, c.relname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND c.relname NOT LIKE 'openclaw%'
      AND (t.tgname ILIKE '%openclaw%' OR t.tgfoid::regproc::text ILIKE '%openclaw%')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', r.tgname, r.nspname, r.relname);
  END LOOP;
END $buoc4$;

-- (5) Policy openclaw trên bảng SỐNG (rooms, leads×2, lead_activities×2,
--     organizations, organization_memberships, organization_roles,
--     permission_definitions, role_permissions). Policy trên bảng openclaw
--     tự chết theo DROP TABLE ở bước (8).
DO $buoc5$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname FROM pg_policies
    WHERE policyname ILIKE '%openclaw%' AND tablename NOT LIKE 'openclaw%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $buoc5$;

-- (6) Dữ liệu quyền: 24 dòng role_permissions + 8 key permission_definitions
--     (đếm 30/08). member_permission_overrides cũng FK vào key nên xóa trước.
DELETE FROM public.member_permission_overrides WHERE permission_key LIKE 'openclaw_zalo.%';
DELETE FROM public.role_permissions           WHERE permission_key LIKE 'openclaw_zalo.%';
DELETE FROM public.permission_definitions     WHERE key            LIKE 'openclaw_zalo.%';

-- (7) Cột openclaw trên bảng sống. ALTER TABLE ở đây kích event trigger
--     org_boundary_tu_dong nhưng nó thoát sớm vì policy *_org_boundary của cả
--     3 bảng đã tồn tại — đã kiểm 30/08.
ALTER TABLE public.rooms           DROP COLUMN IF EXISTS openclaw_availability_revision;
ALTER TABLE public.leads           DROP COLUMN IF EXISTS openclaw_assignment_revision;
ALTER TABLE public.lead_activities DROP COLUMN IF EXISTS openclaw_schedule_revision;
ALTER TABLE public.lead_activities DROP COLUMN IF EXISTS openclaw_schedule_timezone;
ALTER TABLE public.lead_activities DROP COLUMN IF EXISTS openclaw_scheduled_at_utc;

-- (8) 79 bảng openclaw_*. CASCADE chỉ để gỡ FK NỘI BỘ giữa các bảng openclaw
--     với nhau — không bảng sống nào FK vào chúng (kiểm pg_constraint 30/08).
DO $buoc8$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename LIKE 'openclaw_%'
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS public.%I CASCADE', r.tablename);
  END LOOP;
END $buoc8$;

-- (9) 249 hàm (public 107 + app_private 142, đếm 30/08). Sinh động bằng
--     pg_get_function_identity_arguments vì nhiều hàm có overload.
DO $buoc9$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT n.nspname, p.proname,
           pg_get_function_identity_arguments(p.oid) AS args,
           CASE p.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END AS kind
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('public', 'app_private')
      AND p.proname ILIKE '%openclaw%'
  LOOP
    EXECUTE format('DROP %s IF EXISTS %I.%I(%s) CASCADE', r.kind, r.nspname, r.proname, r.args);
  END LOOP;
END $buoc9$;

-- (10) 5 role openclaw_*. REASSIGN trước (bảo toàn mọi object lọt kiểm kê thay
--      vì phá), DROP OWNED sau (thu hồi privilege + default ACL còn sót),
--      DROP ROLE cuối. trg_room_status_reconcile đã đổi owner ở bước (3) nên
--      role owner của nó giờ không còn giữ gì sống.
DO $buoc10$
DECLARE r record;
BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'openclaw_%' LOOP
    EXECUTE format('REASSIGN OWNED BY %I TO %I', r.rolname, current_user);
    EXECUTE format('DROP OWNED BY %I', r.rolname);
    EXECUTE format('DROP ROLE IF EXISTS %I', r.rolname);
  END LOOP;
END $buoc10$;

-- ---------------------------------------------------------------------------
-- NGHIỆM THU — đo trong chính transaction này, sai là abort toàn bộ.
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE v integer;
BEGIN
  SELECT count(*) INTO v FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'openclaw_%';
  IF v > 0 THEN RAISE EXCEPTION 'NGHIEM THU: con % bang openclaw', v; END IF;

  SELECT count(*) INTO v FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'app_private') AND p.proname ILIKE '%openclaw%';
  IF v > 0 THEN RAISE EXCEPTION 'NGHIEM THU: con % ham openclaw', v; END IF;

  SELECT count(*) INTO v FROM pg_policies WHERE policyname ILIKE '%openclaw%';
  IF v > 0 THEN RAISE EXCEPTION 'NGHIEM THU: con % policy openclaw', v; END IF;

  SELECT count(*) INTO v FROM pg_roles WHERE rolname LIKE 'openclaw_%';
  IF v > 0 THEN RAISE EXCEPTION 'NGHIEM THU: con % role openclaw', v; END IF;

  SELECT count(*) INTO v FROM public.permission_definitions WHERE key LIKE 'openclaw_zalo.%';
  IF v > 0 THEN RAISE EXCEPTION 'NGHIEM THU: con % permission key openclaw_zalo', v; END IF;

  -- Hàm nghiệp vụ sống phải còn nguyên và không còn nhắc openclaw
  IF pg_catalog.to_regprocedure('public.recompute_room_reservation(uuid)') IS NULL THEN
    RAISE EXCEPTION 'NGHIEM THU: mat ham recompute_room_reservation(uuid)';
  END IF;
  IF pg_catalog.to_regprocedure('public.trg_room_status_reconcile()') IS NULL THEN
    RAISE EXCEPTION 'NGHIEM THU: mat ham trg_room_status_reconcile';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc WHERE proname = 'trg_room_status_reconcile' AND prosrc ILIKE '%openclaw%'
  ) THEN
    RAISE EXCEPTION 'NGHIEM THU: trg_room_status_reconcile van con nhac openclaw';
  END IF;

  -- Cột openclaw trên bảng sống phải biến mất
  SELECT count(*) INTO v FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name LIKE 'openclaw%';
  IF v > 0 THEN RAISE EXCEPTION 'NGHIEM THU: con % cot openclaw tren bang song', v; END IF;
END $nghiem_thu$;

COMMIT;

-- ROLLBACK thủ công nếu cần: restore từ bản dump ghi ở đầu file; hoặc replay
-- 16 migration openclaw gốc (vẫn nằm nguyên trong supabase/migrations/).
