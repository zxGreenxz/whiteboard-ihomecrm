-- Sửa ba producer thông báo của lương v5 (plan 2026-10-21-realtime-thong-bao-toi-uu.md, gói B mục B11).
--
-- (1) Bản tin "Tuyến hôm nay" hỏng mỗi ngày thường từ 17/09 (NOTIF-SERVER-3): salary-v5-jobs gọi v5_run_digest bằng
--     service_role ⇒ v5_daily_missions ⇒ v5_route_candidates ⇒ get_salary_v5_config() KHÔNG tham số, mà hàm đó ném
--     42501 khi auth.uid() IS NULL (20260915074852:458-462) — kể cả khi có p_org. Đo: cron_runs digest 30/45 lượt lỗi
--     từ 2026-09-17, chỉ Chủ nhật (nhánh return sớm) là OK.
--     Sửa: get_salary_v5_config thêm MỘT nhánh cho người gọi tin cậy — JWT role service_role, hoặc không có JWT và
--     session_user là postgres/supabase_admin (pg_cron, lane) — CHỈ khi auth.uid() IS NULL VÀ p_org tường minh.
--     Người dùng đăng nhập giữ nguyên cổng cũ (membership ACTIVE trong công ty của bộ luật). Cách nhận người gọi tin cậy
--     chép 20260727070000_openclaw_crm_event_sources.sql (đọc request.jwt.claim.role / request.jwt.claims).
--     v5_route_candidates(p_user) truyền công ty suy từ p_user (app_private.v5_salary_org_of_user_v1) thay cho
--     get_salary_v5_config() trần. Với v5_route_candidates_self (p_user = auth.uid()) kết quả y như cũ: bản cũ cũng
--     tự suy công ty bằng đúng hàm đó từ auth.uid(). Vá đúng MỘT dòng khai báo bằng pg_get_functiondef (thân 188 dòng
--     giữ nguyên); thân prod 22/10 khớp byte với 20260721140000 (md5 4f445a6c…).
-- (2) v5_appeal và report_device_issue gửi chuông cho super admin toàn cục (super_admins LIMIT 1) và không ghi
--     organization_id ⇒ trg_autofill_org_strict ném 23502 khi người nhận thuộc ≥2 công ty ⇒ rollback CẢ thao tác
--     (kháng nghị/báo sự cố không lưu được) (NOTIF-SERVER-12). Sửa: suy công ty từ dòng vừa ghi
--     (salary_attendance_day.organization_id / inspection_sessions.organization_id → buildings.organization_id; dự
--     phòng: người gọi thuộc đúng một công ty), người nhận = mọi CHỦ CÔNG TY đang hiệu lực của công ty đó
--     (app_private.ie_actor_is_company_owner_v1, như zalo_canh_gac_bao_v1), ghi organization_id tường minh. Không suy
--     được công ty hoặc không có chủ ⇒ thao tác vẫn thành công, chỉ ghi WARNING (không đoán người nhận).
--     Chữ ký, kiểu trả về, search_path, ACL, nội dung chuông giữ nguyên.
-- Chạy lại an toàn: CREATE OR REPLACE + vá có dấu nhận biết.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $tien_quyet$
BEGIN
  IF to_regprocedure('public.get_salary_v5_config(uuid)') IS NULL
     OR to_regprocedure('public.v5_route_candidates(uuid)') IS NULL
     OR to_regprocedure('public.v5_appeal(date,text)') IS NULL
     OR to_regprocedure('public.report_device_issue(uuid,text)') IS NULL
     OR to_regprocedure('app_private.v5_salary_org_of_user_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.v5_salary_config_for_org_v1(uuid)') IS NULL
     OR to_regprocedure('app_private.ie_actor_is_company_owner_v1(uuid,uuid)') IS NULL
     OR to_regprocedure('app_private.single_org_of_user_v1(uuid)') IS NULL THEN
    RAISE EXCEPTION 'sua_producer_v5_thong_bao_v1: thiếu hàm nền lương v5 / chủ công ty' USING ERRCODE = '55000';
  END IF;
END $tien_quyet$;

-- (1a) Người gọi tin cậy: dùng chung cho mọi RPC cần chạy dưới service_role/pg_cron mà không có người dùng.
CREATE OR REPLACE FUNCTION app_private.trusted_server_caller_v1()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'pg_catalog'
AS $fn$
DECLARE
  v_role text := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
                          '');
BEGIN
  RETURN v_role = 'service_role'
      OR (v_role = '' AND session_user IN ('postgres', 'supabase_admin'));
END $fn$;
REVOKE ALL ON FUNCTION app_private.trusted_server_caller_v1() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_salary_v5_config(p_org uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
BEGIN
  IF v_uid IS NULL THEN
    -- Job máy chủ (digest v5): KHÔNG có người dùng, công ty phải tường minh. Người gọi khác không có JWT ⇒ 42501 như cũ.
    IF p_org IS NOT NULL AND app_private.trusted_server_caller_v1() THEN
      RETURN app_private.v5_salary_config_for_org_v1(p_org);
    END IF;
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_org := COALESCE(p_org, app_private.v5_salary_org_of_user_v1(v_uid));
  IF v_org IS NULL THEN
    RETURN NULL; -- người gọi không gắn với tổ chức nào có bộ luật v5
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_memberships m
    WHERE m.user_id = v_uid
      AND m.organization_id = v_org
      AND m.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  RETURN app_private.v5_salary_config_for_org_v1(v_org);
END;
$fn$;

-- (1b) Vá một dòng của v5_route_candidates.
DO $va_route$
DECLARE
  v_sig  constant regprocedure := 'public.v5_route_candidates(uuid)'::regprocedure;
  v_old  constant text := 'v_cfg JSONB := public.get_salary_v5_config();';
  v_new  constant text := 'v_cfg JSONB := public.get_salary_v5_config(app_private.v5_salary_org_of_user_v1(p_user));';
  v_src  text := pg_get_functiondef(v_sig);
  v_next text;
BEGIN
  IF position(v_new IN v_src) > 0 THEN
    RETURN;  -- đã vá (lượt hai)
  END IF;
  IF (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old) <> 1 THEN
    RAISE EXCEPTION 'sua_producer_v5: v5_route_candidates không còn đúng một dòng "%" — đã có ai sửa hàm, dừng.', v_old
      USING ERRCODE = '55000';
  END IF;
  v_next := replace(v_src, v_old, v_new);
  EXECUTE v_next;
END $va_route$;

-- (2a) Kháng nghị nghi án.
CREATE OR REPLACE FUNCTION public.v5_appeal(p_date date, p_text text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   UUID := auth.uid();
  v_org   UUID;
  v_owner UUID;
  v_name  TEXT;
  v_n     INTEGER := 0;
BEGIN
  UPDATE public.salary_attendance_day SET
    audit = audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', v_uid, 'action', 'appeal', 'text', p_text)),
    updated_at = now()
  WHERE user_id = v_uid AND work_date = p_date AND status = 'flagged'
  RETURNING organization_id INTO v_org;   -- UNIQUE(user_id, work_date) ⇒ tối đa một dòng
  IF NOT FOUND THEN RAISE EXCEPTION 'Không có nghi án đang mở ở ngày này'; END IF;

  v_org := COALESCE(v_org, app_private.single_org_of_user_v1(v_uid));
  IF v_org IS NULL THEN
    RAISE WARNING 'v5_appeal: không suy được công ty của % ngày % — không gửi chuông (kháng nghị vẫn lưu)', v_uid, p_date;
    RETURN jsonb_build_object('appealed', true);
  END IF;

  v_name := (SELECT COALESCE(full_name,'Nhân viên') FROM public.profiles WHERE id = v_uid);
  FOR v_owner IN
    SELECT DISTINCT m.user_id
      FROM public.organization_memberships m
     WHERE m.organization_id = v_org
       AND m.status = 'ACTIVE'
       AND m.user_id IS DISTINCT FROM v_uid
       AND app_private.ie_actor_is_company_owner_v1(v_org, m.user_id)
     ORDER BY m.user_id
  LOOP
    INSERT INTO public.notifications (user_id, organization_id, type, channel, status, subject, content, metadata)
    VALUES (v_owner, v_org, 'CUSTOM','IN_APP','PENDING','Kháng nghị nghi án',
      COALESCE(v_name, 'Nhân viên') || ' phản hồi ngày ' || to_char(p_date,'DD/MM') || ': ' || p_text,
      jsonb_build_object('v5','appeal','staff_id', v_uid, 'date', p_date));
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN
    RAISE WARNING 'v5_appeal: công ty % không có chủ công ty đang hiệu lực — không gửi chuông', v_org;
  END IF;
  RETURN jsonb_build_object('appealed', true);
END; $fn$;

-- (2b) Báo sự cố thiết bị (kiểm tra nhà).
CREATE OR REPLACE FUNCTION public.report_device_issue(p_session uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid   UUID := auth.uid();
  v_sess  public.inspection_sessions;
  v_org   UUID;
  v_owner UUID;
  v_text  TEXT;
  v_n     INTEGER := 0;
BEGIN
  SELECT * INTO v_sess FROM public.inspection_sessions WHERE id = p_session;
  IF NOT FOUND OR v_sess.user_id <> v_uid THEN RAISE EXCEPTION 'Phiên không hợp lệ'; END IF;
  UPDATE public.inspection_sessions SET
    device_issue = jsonb_build_object('reported_at', now(), 'reason', p_reason),
    updated_at = now()
  WHERE id = p_session;

  v_org := COALESCE(v_sess.organization_id,
                    (SELECT b.organization_id FROM public.buildings b WHERE b.id = v_sess.building_id),
                    app_private.single_org_of_user_v1(v_uid));
  IF v_org IS NULL THEN
    RAISE WARNING 'report_device_issue: không suy được công ty của phiên % — không gửi chuông (báo cáo vẫn lưu)', p_session;
    RETURN jsonb_build_object('reported', true);
  END IF;

  v_text := (SELECT COALESCE(full_name,'Nhân viên') FROM public.profiles WHERE id = v_uid) || ' báo sự cố tại toà ' ||
            (SELECT name FROM public.buildings WHERE id = v_sess.building_id) || ': ' || p_reason;
  FOR v_owner IN
    SELECT DISTINCT m.user_id
      FROM public.organization_memberships m
     WHERE m.organization_id = v_org
       AND m.status = 'ACTIVE'
       AND m.user_id IS DISTINCT FROM v_uid
       AND app_private.ie_actor_is_company_owner_v1(v_org, m.user_id)
     ORDER BY m.user_id
  LOOP
    INSERT INTO public.notifications (user_id, organization_id, type, channel, status, subject, content, metadata)
    VALUES (v_owner, v_org, 'CUSTOM', 'IN_APP', 'PENDING', 'Báo sự cố thiết bị (kiểm tra nhà)',
      COALESCE(v_text, 'Nhân viên báo sự cố thiết bị: ' || COALESCE(p_reason, '')),
      jsonb_build_object('v5','device_issue','session_id', p_session, 'staff_id', v_uid));
    v_n := v_n + 1;
  END LOOP;
  IF v_n = 0 THEN
    RAISE WARNING 'report_device_issue: công ty % không có chủ công ty đang hiệu lực — không gửi chuông', v_org;
  END IF;
  RETURN jsonb_build_object('reported', true);
END; $fn$;

-- CREATE OR REPLACE giữ ACL cũ (authenticated + service_role); nói lại tường minh, anon/PUBLIC không bao giờ.
REVOKE ALL ON FUNCTION public.get_salary_v5_config(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.v5_appeal(date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_device_issue(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_salary_v5_config(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.v5_appeal(date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.report_device_issue(uuid, text) TO authenticated, service_role;

DO $nghiem_thu$
BEGIN
  IF position('get_salary_v5_config(app_private.v5_salary_org_of_user_v1(p_user))'
              IN pg_get_functiondef('public.v5_route_candidates(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'nghiệm thu: v5_route_candidates chưa truyền công ty' USING ERRCODE = '55000';
  END IF;
  IF has_function_privilege('anon', 'public.get_salary_v5_config(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.v5_appeal(date,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.report_device_issue(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'nghiệm thu: anon gọi được hàm lương v5' USING ERRCODE = '55000';
  END IF;
END $nghiem_thu$;

COMMIT;
NOTIFY pgrst, 'reload schema';
