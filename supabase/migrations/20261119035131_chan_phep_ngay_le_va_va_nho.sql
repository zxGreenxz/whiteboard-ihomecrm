-- =============================================================================
-- Phép: chặn ngày lễ ở MỌI đường xin / duyệt + vá nhỏ của đơn nhiều ngày (sau review chéo PR #448).
--
-- VÌ SAO
--   N_chuẩn = ngày làm của tổ chức (T2–T7 trừ salary_holidays) − MỌI ngày leave_approved trong tháng
--   (app_private.v5_n_chuan_for_org_v1). Phép nằm trên Chủ nhật / ngày lễ vì thế bị trừ HAI lần ⇒ đơn giá ngày tăng
--   sai cho mọi ngày công của tháng, và số dư phép bị trừ cho ngày vốn được nghỉ. 20261119020927 đã chặn ở đơn nhiều
--   ngày, nhưng đường cũ vẫn mở: request_paid_leave (một ngày) chỉ chặn Chủ nhật, còn approve_leave /
--   approve_leave_batch duyệt mọi ngày pending_leave. Đo production 19/11/2026: 0 dòng phép (chờ hoặc đã duyệt) nằm
--   trên Chủ nhật / ngày lễ — không cần sửa dữ liệu, chỉ đóng đường vào.
--
-- LÀM GÌ (CREATE OR REPLACE, giữ nguyên chữ ký, kiểu trả về, SECURITY DEFINER, search_path, ACL)
--   1. request_paid_leave: thân đang chạy (20261007082645, md5 e4e99337…) + (a) từ chối ngày không phải ngày làm của
--      công ty người xin (public.vn_workdays — như request_paid_leave_range), HINT leave_no_workday; (b) khoá advisory
--      CÙNG khoá với request_paid_leave_range để hai đường xin của một người không cùng lọt qua phần đếm số dư.
--   2. approve_leave: thân đang chạy (20260703000004, md5 69909641…) + khi DUYỆT, ngày là Chủ nhật hoặc ngày lễ của
--      tổ chức trên dòng ngày công ⇒ từ chối (HINT leave_not_workday); TỪ CHỐI đơn vẫn làm được như cũ.
--   3. approve_leave_batch: như (2) cho cả đơn; khoá dòng theo thứ tự ngày (cùng thứ tự với request_paid_leave_range —
--      tránh deadlock 40P01).
--   4. request_paid_leave_range: câu thiếu số dư nêu NGÀY bị chặn và số dư của chính ngày đó (khoảng qua tháng / năm
--      trước đây báo "chỉ còn đủ N ngày" thấp hơn thực tế vì số dư tích luỹ theo tháng của từng ngày).
--   Ngày lễ của approve_* lấy theo tổ chức của DÒNG ngày công (không gọi app_private.v5_salary_org_of_user_v1, hàm đó
--   ném lỗi khi người dùng thuộc nhiều tổ chức).
--
-- AN TOÀN CHẠY LẠI
--   Tiền kiểm so md5 thân (prosrc, bỏ CR) của cả bốn hàm: phải là thân đang chạy đã đo (lượt đầu) hoặc thân của
--   chính file này (lượt chạy lại); khác ⇒ 55000, không ghi gì. CREATE OR REPLACE không đổi ACL; REVOKE / GRANT tường
--   minh của hai hàm cũ đưa ACL về đúng production cả trên bản dựng lại của Restore Drill.
--   approve_leave còn khoá dòng (FOR UPDATE) trước khi xét trạng thái — lỗi cũ, cùng lúc với duyệt cả đơn có thể ghi đè.
-- GIỚI HẠN (chưa đóng): ngày lễ THÊM SAU khi phép đã duyệt vẫn bị trừ hai lần (đường thêm ngày lễ không kiểm phép);
--   bên xin tra ngày lễ theo tổ chức lương của người gọi (vn_workdays), bên duyệt theo tổ chức trên dòng ngày công — trùng
--   nhau với người một tổ chức.
--
-- LÙI (migration forward mới): CREATE OR REPLACE bốn hàm bằng nguyên văn thân của 20261007082645 (request_paid_leave),
--   20260703000004 (approve_leave) và 20261119020927 (hai hàm còn lại). Không phá dữ liệu.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Tiền kiểm: đúng thân đã rà.
DO $truoc$
DECLARE
  v_ham  text;
  v_fn   regprocedure;
  v_md5  text;
  v_cho  text[];
BEGIN
  IF to_regprocedure('public.vn_workdays(date)') IS NULL OR to_regclass('public.salary_holidays') IS NULL THEN
    RAISE EXCEPTION 'Thiếu public.vn_workdays(date) / public.salary_holidays' USING ERRCODE = '55000';
  END IF;
  FOREACH v_ham IN ARRAY ARRAY['request_paid_leave(date,text)', 'approve_leave(uuid,date,boolean)',
                               'request_paid_leave_range(date,date,text)', 'approve_leave_batch(uuid,date[],boolean)'] LOOP
    v_fn := to_regprocedure('public.' || v_ham);
    IF v_fn IS NULL THEN
      RAISE EXCEPTION 'Thiếu public.% — 20261119020927 phải áp trước', v_ham USING ERRCODE = '55000';
    END IF;
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_catalog.pg_proc p WHERE p.oid = v_fn;
    -- [0] thân đang chạy production (đo 19/11/2026) · [1] thân của chính file này (lượt chạy lại).
    v_cho := CASE v_ham
      WHEN 'request_paid_leave(date,text)' THEN ARRAY['e4e993370aa9371ce057b2f45bfa189d', '56306a639ab1c11e9b7705d0944632f0']
      WHEN 'approve_leave(uuid,date,boolean)' THEN ARRAY['69909641e1e5bb6fbb70b665a16a04f8', 'a3c1757c227f20ea6a15270df1112c5c']
      WHEN 'request_paid_leave_range(date,date,text)' THEN ARRAY['45f36d22eb838e5f42375ab5ca2b69f2', '2bf0cac0b7f192a12da4bd5637407429']
      ELSE ARRAY['55c832376cf9b68811b41b2b625eee88', 'ff64e789e814ac12d37b1031debf6ef2']
    END;
    IF v_md5 IS NULL OR NOT (v_md5 = ANY (v_cho)) THEN
      RAISE EXCEPTION 'public.% KHÁC thân đã rà (md5 %) — DỪNG, đối chiếu thân đang chạy rồi rà lại', v_ham, v_md5
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$truoc$;

-- 1. Đơn một ngày (đường cũ, web không còn gọi): thân 20261007082645 + chặn ngày lễ + khoá chung với đơn nhiều ngày.
CREATE OR REPLACE FUNCTION public.request_paid_leave(p_date DATE, p_reason TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_cfg JSONB := public.get_salary_v5_config();
  v_bank_from DATE := COALESCE((v_cfg->'system_v5'->>'shield_bank_from')::date, DATE '2026-09-01');
  v_month DATE := date_trunc('month', p_date)::date;
  v_rate INT := COALESCE((v_cfg->'attendance_v5'->>'paid_leave_days_per_month')::int, 1);
  v_quota INT; v_used INT;
  v_owner UUID := (SELECT user_id FROM public.super_admins ORDER BY created_at LIMIT 1);
  v_cur TEXT;
  v_org UUID;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Chưa đăng nhập'; END IF;
  IF p_date < public.vn_local_date(now()) THEN
    RAISE EXCEPTION 'Chỉ xin phép cho hôm nay hoặc ngày tới';
  END IF;
  IF EXTRACT(dow FROM p_date) = 0 THEN
    RAISE EXCEPTION 'Chủ nhật đã là ngày nghỉ — không cần xin phép';
  END IF;
  -- Ngày lễ của công ty người xin cũng đã là ngày nghỉ (N_chuẩn đã trừ) — phép trên đó bị trừ hai lần. 20261119035131.
  IF p_date NOT IN (SELECT w FROM public.vn_workdays(p_date) AS w) THEN
    RAISE EXCEPTION 'Ngày % là ngày lễ của công ty — không cần xin phép', to_char(p_date, 'DD/MM/YYYY')
      USING HINT = 'leave_no_workday';
  END IF;
  -- Cùng khoá với request_paid_leave_range: hai đường xin của một người không cùng lọt qua phần đếm số dư.
  PERFORM pg_advisory_xact_lock(hashtext('request_paid_leave_range:' || v_uid::text));
  IF p_date >= v_bank_from THEN
    -- Phep tich luy theo NAM: so du = LEAST(12, so-thang-da-troi × rate) − da dung trong nam
    v_quota := LEAST(12, EXTRACT(month FROM p_date)::int * v_rate);
    SELECT COUNT(*) INTO v_used FROM public.salary_attendance_day
    WHERE user_id = v_uid AND status IN ('leave_approved','pending_leave')
      AND work_date >= date_trunc('year', p_date)::date
      AND work_date < (date_trunc('year', p_date) + INTERVAL '1 year')::date;
    IF v_used >= v_quota THEN
      RAISE EXCEPTION 'Số dư phép năm đã hết (tích lũy % — đã dùng %)', v_quota, v_used;
    END IF;
  ELSE
    v_quota := v_rate;
    SELECT COUNT(*) INTO v_used FROM public.salary_attendance_day
    WHERE user_id = v_uid AND status IN ('leave_approved','pending_leave')
      AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;
    IF v_used >= v_quota THEN
      RAISE EXCEPTION 'Đã dùng hết % ngày phép có lương của tháng này', v_quota;
    END IF;
  END IF;

  SELECT status INTO v_cur FROM public.salary_attendance_day WHERE user_id = v_uid AND work_date = p_date;
  IF v_cur = 'ticked' THEN RAISE EXCEPTION 'Ngày này đã có ngày công rồi'; END IF;
  IF v_cur IN ('leave_approved','pending_leave') THEN
    RETURN jsonb_build_object('status', v_cur, 'date', p_date); -- idempotent
  END IF;

  INSERT INTO public.salary_attendance_day (user_id, work_date, status, evidence, audit)
  VALUES (v_uid, p_date, 'pending_leave',
          jsonb_build_array(jsonb_build_object('at', now(), 'kind', 'leave_request', 'reason', p_reason)),
          jsonb_build_array(jsonb_build_object('at', now(), 'by', v_uid, 'action', 'request_leave')))
  ON CONFLICT (user_id, work_date) DO UPDATE SET
    status = 'pending_leave',
    evidence = salary_attendance_day.evidence || jsonb_build_array(jsonb_build_object('at', now(), 'kind', 'leave_request', 'reason', p_reason)),
    audit = salary_attendance_day.audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', v_uid, 'action', 'request_leave')),
    updated_at = now()
  RETURNING organization_id INTO v_org;

  -- bao chu (auto-nhac lai sau 24h do digest dam nhiem)
  INSERT INTO public.notifications (organization_id, user_id, type, channel, status, subject, content, metadata)
  VALUES (v_org, v_owner, 'CUSTOM', 'IN_APP', 'PENDING', 'Xin phép nghỉ có lương',
          (SELECT COALESCE(full_name, 'Nhân viên') FROM public.profiles WHERE id = v_uid) || ' xin phép ngày ' || to_char(p_date, 'DD/MM') || COALESCE(' — ' || p_reason, ''),
          jsonb_build_object('v5', 'leave_request', 'staff_id', v_uid, 'date', p_date));

  RETURN jsonb_build_object('status', 'pending_leave', 'date', p_date, 'quota_left', v_quota - v_used - 1);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO public.salary_award_errors(staff_id, fn_name, error_text, payload)
  VALUES (v_uid, 'request_paid_leave', SQLERRM, jsonb_build_object('date', p_date));
  RAISE;
END; $$;

-- 2. Duyệt một ngày: thân 20260703000004 + không duyệt ngày Chủ nhật / ngày lễ (từ chối vẫn được).
CREATE OR REPLACE FUNCTION public.approve_leave(p_user UUID, p_date DATE, p_approve BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cur TEXT; v_org UUID;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Chỉ chủ được duyệt phép'; END IF;
  SELECT status, organization_id INTO v_cur, v_org FROM public.salary_attendance_day WHERE user_id = p_user AND work_date = p_date FOR UPDATE;
  IF v_cur IS DISTINCT FROM 'pending_leave' THEN
    RAISE EXCEPTION 'Ngày này không ở trạng thái chờ duyệt phép';
  END IF;
  -- Phép trên Chủ nhật / ngày lễ bị trừ hai lần khỏi N_chuẩn: chỉ cho TỪ CHỐI. 20261119035131.
  IF p_approve AND (EXTRACT(dow FROM p_date) = 0
                    OR EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.organization_id = v_org AND h.holiday_date = p_date)) THEN
    RAISE EXCEPTION 'Ngày % là Chủ nhật hoặc ngày lễ của công ty — chỉ từ chối được, không duyệt', to_char(p_date, 'DD/MM/YYYY')
      USING HINT = 'leave_not_workday';
  END IF;

  UPDATE public.salary_attendance_day SET
    status = CASE WHEN p_approve THEN 'leave_approved' ELSE 'pending' END,
    audit = audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(),
            'action', CASE WHEN p_approve THEN 'approve_leave' ELSE 'decline_leave' END)),
    updated_at = now()
  WHERE user_id = p_user AND work_date = p_date;

  PERFORM public.v5_recompute_streak(p_user, date_trunc('month', p_date)::date);

  INSERT INTO public.notifications (user_id, type, channel, status, subject, content, metadata)
  VALUES (p_user, 'CUSTOM', 'IN_APP', 'PENDING',
    CASE WHEN p_approve THEN 'Phép đã duyệt ✅' ELSE 'Phép chưa được duyệt' END,
    CASE WHEN p_approve
      THEN 'Phép ngày ' || to_char(p_date,'DD/MM') || ' đã duyệt ✅ — ngày trung tính, chuỗi được bắc cầu, đơn giá ngày tự điều chỉnh'
      ELSE 'Phép ngày ' || to_char(p_date,'DD/MM') || ' chưa được duyệt — trao đổi thêm với chủ nhé' END,
    jsonb_build_object('v5','leave_result','date', p_date, 'approved', p_approve, 'url', '/my-day'));

  RETURN jsonb_build_object('approved', p_approve, 'date', p_date);
END; $$;

-- ACL hai hàm cũ: đúng tập production (đo 19/11/2026: postgres, authenticated, service_role). Production: không đổi
-- gì. Bản dựng lại của Restore Drill (baseline --no-acl + shim cấp mọi hàm public cho anon; không migration forward nào
-- thu anon của hai hàm này) thì được kéo về đúng như production — như 20261116015253 đã làm.
REVOKE ALL ON FUNCTION public.request_paid_leave(date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_paid_leave(date, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.approve_leave(uuid, date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_leave(uuid, date, boolean) TO authenticated, service_role;

-- 3 + 4. Hai hàm của 20261119020927: khoá theo thứ tự ngày + chặn duyệt ngày lễ; câu thiếu số dư nêu ngày bị chặn.
CREATE OR REPLACE FUNCTION public.request_paid_leave_range(p_from date, p_to date, p_reason text DEFAULT NULL)
RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  c_max_days  constant int := 31;
  v_uid       uuid := auth.uid();
  v_today     date := public.vn_local_date(now());
  v_cfg       jsonb;
  v_bank_from date;
  v_rate      int;
  v_owner     uuid := (SELECT s.user_id FROM public.super_admins s ORDER BY s.created_at LIMIT 1);
  v_reason    text := NULLIF(btrim(p_reason), '');
  v_batch     uuid := gen_random_uuid();
  v_days      date[];
  v_holidays  date[];
  v_new       date[] := ARRAY[]::date[];
  v_existing  date[] := ARRAY[]::date[];
  v_n         int;
  v_d         date;
  v_cur       text;
  v_lo        date;
  v_hi        date;
  v_quota     int;
  v_used      int;
  v_ok        int := 0;
  v_span      int;
  v_org       uuid;
  v_row_org   uuid;
  v_name      text;
  v_label     text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING HINT = 'leave_not_signed_in';
  END IF;
  -- Bộ luật lương v5 của tổ chức người gọi (cần JWT nên đọc sau khi đã có người gọi); không có ⇒ mặc định như
  -- request_paid_leave.
  v_cfg := public.get_salary_v5_config();
  v_bank_from := COALESCE((v_cfg->'system_v5'->>'shield_bank_from')::date, DATE '2026-09-01');
  v_rate := COALESCE((v_cfg->'attendance_v5'->>'paid_leave_days_per_month')::int, 1);
  IF p_from IS NULL OR p_to IS NULL THEN
    RAISE EXCEPTION 'Chọn ngày bắt đầu và ngày kết thúc nghỉ' USING HINT = 'leave_range_invalid';
  END IF;
  IF p_to < p_from THEN
    RAISE EXCEPTION 'Ngày kết thúc phải bằng hoặc sau ngày bắt đầu' USING HINT = 'leave_range_invalid';
  END IF;
  IF p_from < v_today THEN
    RAISE EXCEPTION 'Chỉ xin phép cho hôm nay hoặc ngày tới' USING HINT = 'leave_past_date';
  END IF;
  IF p_to - p_from + 1 > c_max_days THEN
    RAISE EXCEPTION 'Mỗi đơn xin tối đa % ngày — chia thành nhiều đơn', c_max_days USING HINT = 'leave_range_too_long';
  END IF;
  IF length(v_reason) > 500 THEN
    RAISE EXCEPTION 'Lý do nghỉ tối đa 500 ký tự' USING HINT = 'leave_reason_too_long';
  END IF;

  -- Ngày làm trong khoảng theo lịch của công ty người gọi (vn_workdays của MỌI tháng khoảng chạm tới — 31 ngày có thể
  -- chạm ba tháng, vd. 30/01 → 01/03), tăng dần. Ngày không phải Chủ nhật mà không là ngày làm = ngày lễ: bỏ, trả về.
  WITH khoang AS (
    SELECT p_from + i AS d FROM generate_series(0, p_to - p_from) AS i
  ), ngay_lam AS (
    SELECT w AS d
      FROM (SELECT DISTINCT date_trunc('month', k.d)::date AS m FROM khoang AS k) AS thang,
           LATERAL public.vn_workdays(thang.m) AS w
  )
  SELECT array_agg(k.d ORDER BY k.d) FILTER (WHERE k.d IN (SELECT n.d FROM ngay_lam AS n)),
         array_agg(k.d ORDER BY k.d) FILTER (WHERE extract(dow FROM k.d) <> 0 AND k.d NOT IN (SELECT n.d FROM ngay_lam AS n))
    INTO v_days, v_holidays
    FROM khoang AS k;
  IF v_days IS NULL THEN
    RAISE EXCEPTION 'Các ngày đã chọn đều là Chủ nhật hoặc ngày lễ — không cần xin phép' USING HINT = 'leave_no_workday';
  END IF;

  -- Một người một lượt: hai lần bấm gửi cùng lúc không cùng lọt qua phần đếm số dư.
  PERFORM pg_advisory_xact_lock(hashtext('request_paid_leave_range:' || v_uid::text));

  -- Từng ngày: đã có ngày công ⇒ từ chối cả đơn; đã có đơn ⇒ giữ nguyên; còn lại ⇒ ngày mới. Khoá dòng đang có để lần
  -- chấm công chạy song song không đổi trạng thái giữa lúc xét và lúc ghi.
  FOREACH v_d IN ARRAY v_days LOOP
    SELECT a.status INTO v_cur FROM public.salary_attendance_day a
     WHERE a.user_id = v_uid AND a.work_date = v_d
       FOR UPDATE;
    IF v_cur = 'ticked' THEN
      RAISE EXCEPTION 'Ngày % đã có ngày công — bỏ ngày đó ra khỏi đơn', to_char(v_d, 'DD/MM/YYYY')
        USING HINT = 'leave_day_ticked';
    ELSIF v_cur IN ('leave_approved', 'pending_leave') THEN
      v_existing := v_existing || v_d;
    ELSE
      v_new := v_new || v_d;
    END IF;
  END LOOP;
  v_n := cardinality(v_new);

  -- Số dư: từng ngày mới theo thứ tự, như gửi lần lượt từng đơn một ngày.
  FOR i IN 1 .. v_n LOOP
    v_d := v_new[i];
    IF v_d >= v_bank_from THEN
      v_quota := LEAST(12, extract(month FROM v_d)::int * v_rate);
      v_lo := date_trunc('year', v_d)::date;
      v_hi := (date_trunc('year', v_d) + interval '1 year')::date;
    ELSE
      v_quota := v_rate;
      v_lo := date_trunc('month', v_d)::date;
      v_hi := (date_trunc('month', v_d) + interval '1 month')::date;
    END IF;
    SELECT count(*) INTO v_used FROM public.salary_attendance_day a
     WHERE a.user_id = v_uid AND a.status IN ('leave_approved', 'pending_leave')
       AND a.work_date >= v_lo AND a.work_date < v_hi;
    v_used := v_used + (SELECT count(*) FROM unnest(v_new[1:i - 1]) AS x WHERE x >= v_lo AND x < v_hi);
    IF v_used >= v_quota THEN
      -- Nêu NGÀY bị chặn: số dư tích luỹ theo tháng của từng ngày và đặt lại đầu năm, nên "còn đủ N ngày" của một
      -- khoảng qua tháng / năm không phải số dư chung. 20261119035131.
      IF v_ok = 0 THEN
        RAISE EXCEPTION 'Số dư phép đã hết cho ngày % (tích lũy % — đã dùng %)', to_char(v_d, 'DD/MM/YYYY'), v_quota, v_used
          USING HINT = 'leave_quota_exceeded';
      END IF;
      RAISE EXCEPTION 'Số dư phép chỉ đủ cho % ngày đầu của đơn, hết từ ngày % (tích lũy % — đã dùng %) — bớt ngày rồi gửi lại',
        v_ok, to_char(v_d, 'DD/MM/YYYY'), v_quota, v_used
        USING HINT = 'leave_quota_exceeded';
    END IF;
    v_ok := v_ok + 1;
  END LOOP;

  -- Ghi các ngày mới, chung mã đơn. Ngày đã có dòng ở trạng thái khác (vd. từng bị từ chối ⇒ pending) chuyển sang chờ
  -- duyệt như request_paid_leave. Điều kiện WHERE chặn trường hợp vừa bị chấm công / vừa có đơn sau lúc xét.
  FOREACH v_d IN ARRAY v_new LOOP
    INSERT INTO public.salary_attendance_day AS a (user_id, work_date, status, evidence, audit)
    VALUES (v_uid, v_d, 'pending_leave',
            jsonb_build_array(jsonb_build_object('at', now(), 'kind', 'leave_request', 'reason', v_reason,
                                                 'batch', v_batch, 'from', v_new[1], 'to', v_new[v_n])),
            jsonb_build_array(jsonb_build_object('at', now(), 'by', v_uid, 'action', 'request_leave', 'batch', v_batch)))
    ON CONFLICT (user_id, work_date) DO UPDATE SET
      status = 'pending_leave',
      evidence = a.evidence || EXCLUDED.evidence,
      audit = a.audit || EXCLUDED.audit,
      updated_at = now()
    WHERE a.status NOT IN ('ticked', 'leave_approved', 'pending_leave')
    RETURNING a.organization_id INTO v_row_org;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Ngày % vừa đổi trạng thái — tải lại rồi gửi lại đơn', to_char(v_d, 'DD/MM/YYYY')
        USING ERRCODE = 'PT409', HINT = 'leave_day_changed';
    END IF;
    v_org := COALESCE(v_org, v_row_org);
  END LOOP;

  -- Một thông báo cho chủ cho cả đơn.
  IF v_n > 0 THEN
    SELECT p.full_name INTO v_name FROM public.profiles p WHERE p.id = v_uid;
    SELECT count(*) INTO v_span FROM generate_series(0, v_new[v_n] - v_new[1]) AS i
     WHERE extract(dow FROM v_new[1] + i) <> 0;
    v_label := CASE
      WHEN v_n = 1 THEN 'ngày ' || to_char(v_new[1], 'DD/MM')
      WHEN v_span = v_n THEN v_n || ' ngày từ ' || to_char(v_new[1], 'DD/MM') || ' đến ' || to_char(v_new[v_n], 'DD/MM')
      ELSE v_n || ' ngày ' || (SELECT string_agg(to_char(x, 'DD/MM'), ', ' ORDER BY x) FROM unnest(v_new) AS x)
    END;
    INSERT INTO public.notifications (organization_id, user_id, type, channel, status, subject, content, metadata)
    VALUES (v_org, v_owner, 'CUSTOM', 'IN_APP', 'PENDING', 'Xin phép nghỉ có lương',
            COALESCE(v_name, 'Nhân viên') || ' xin phép ' || v_label || COALESCE(' — ' || v_reason, ''),
            jsonb_build_object('v5', 'leave_request', 'staff_id', v_uid, 'date', v_new[1], 'date_to', v_new[v_n],
                               'dates', to_jsonb(v_new), 'batch', v_batch, 'url', '/my-day'));
  END IF;

  RETURN jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'requested', to_jsonb(v_new),
    'existing', to_jsonb(v_existing),
    'holidays', to_jsonb(COALESCE(v_holidays, ARRAY[]::date[])),
    'batch', CASE WHEN v_n > 0 THEN v_batch END);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.approve_leave_batch(p_user uuid, p_dates date[], p_approve boolean)
RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $fn$
DECLARE
  c_max_days constant int := 31;
  v_dates    date[];
  v_n        int;
  v_pending  int;
  v_org      uuid;
  v_month    date;
  v_span     int;
  v_label    text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Chỉ chủ được duyệt phép';
  END IF;
  IF p_user IS NULL OR p_approve IS NULL THEN
    RAISE EXCEPTION 'Thiếu người xin nghỉ hoặc quyết định duyệt' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT d ORDER BY d) INTO v_dates FROM unnest(p_dates) AS d WHERE d IS NOT NULL;
  v_n := COALESCE(cardinality(v_dates), 0);
  IF v_n = 0 THEN
    RAISE EXCEPTION 'Chưa chọn ngày phép để duyệt' USING ERRCODE = '22023';
  END IF;
  IF v_n > c_max_days THEN
    RAISE EXCEPTION 'Mỗi lần duyệt tối đa % ngày', c_max_days USING ERRCODE = '22023';
  END IF;

  -- Khoá đúng các dòng; MỌI ngày phải đang chờ duyệt, không thì không đổi ngày nào.
  PERFORM 1 FROM public.salary_attendance_day a
   WHERE a.user_id = p_user AND a.work_date = ANY (v_dates)
   ORDER BY a.work_date
     FOR UPDATE;
  SELECT count(*), (array_agg(a.organization_id ORDER BY a.work_date))[1] INTO v_pending, v_org
    FROM public.salary_attendance_day a
   WHERE a.user_id = p_user AND a.work_date = ANY (v_dates) AND a.status = 'pending_leave';
  IF v_pending <> v_n THEN
    RAISE EXCEPTION 'Ngày này không ở trạng thái chờ duyệt phép'
      USING DETAIL = format('%s/%s ngày còn chờ duyệt', v_pending, v_n);
  END IF;
  -- Phép trên Chủ nhật / ngày lễ (của tổ chức trên dòng ngày công) bị trừ hai lần khỏi N_chuẩn: chỉ cho TỪ CHỐI.
  -- 20261119035131.
  IF p_approve THEN
    SELECT string_agg(to_char(a.work_date, 'DD/MM/YYYY'), ', ' ORDER BY a.work_date) INTO v_label
      FROM public.salary_attendance_day a
     WHERE a.user_id = p_user AND a.work_date = ANY (v_dates)
       AND (extract(dow FROM a.work_date) = 0
            OR EXISTS (SELECT 1 FROM public.salary_holidays h
                        WHERE h.organization_id = a.organization_id AND h.holiday_date = a.work_date));
    IF v_label IS NOT NULL THEN
      RAISE EXCEPTION 'Ngày % là Chủ nhật hoặc ngày lễ của công ty — từ chối riêng ngày đó ở Bảng lương → Đơn xin nghỉ rồi duyệt các ngày còn lại', v_label
        USING HINT = 'leave_not_workday';
    END IF;
  END IF;

  UPDATE public.salary_attendance_day a SET
    status = CASE WHEN p_approve THEN 'leave_approved' ELSE 'pending' END,
    audit = a.audit || jsonb_build_array(jsonb_build_object('at', now(), 'by', auth.uid(),
            'action', CASE WHEN p_approve THEN 'approve_leave' ELSE 'decline_leave' END, 'batch_days', v_n)),
    updated_at = now()
  WHERE a.user_id = p_user AND a.work_date = ANY (v_dates);

  FOR v_month IN SELECT DISTINCT date_trunc('month', d)::date FROM unnest(v_dates) AS d ORDER BY 1 LOOP
    PERFORM public.v5_recompute_streak(p_user, v_month);
  END LOOP;

  SELECT count(*) INTO v_span FROM generate_series(0, v_dates[v_n] - v_dates[1]) AS i
   WHERE extract(dow FROM v_dates[1] + i) <> 0;
  v_label := CASE
    WHEN v_n = 1 THEN 'ngày ' || to_char(v_dates[1], 'DD/MM')
    WHEN v_span = v_n THEN v_n || ' ngày từ ' || to_char(v_dates[1], 'DD/MM') || ' đến ' || to_char(v_dates[v_n], 'DD/MM')
    ELSE v_n || ' ngày ' || (SELECT string_agg(to_char(x, 'DD/MM'), ', ' ORDER BY x) FROM unnest(v_dates) AS x)
  END;
  INSERT INTO public.notifications (organization_id, user_id, type, channel, status, subject, content, metadata)
  VALUES (v_org, p_user, 'CUSTOM', 'IN_APP', 'PENDING',
    CASE WHEN p_approve THEN 'Phép đã duyệt ✅' ELSE 'Phép chưa được duyệt' END,
    CASE WHEN p_approve
      THEN 'Phép ' || v_label || ' đã duyệt ✅ — ngày trung tính, chuỗi được bắc cầu, đơn giá ngày tự điều chỉnh'
      ELSE 'Phép ' || v_label || ' chưa được duyệt — trao đổi thêm với chủ nhé' END,
    jsonb_build_object('v5', 'leave_result', 'date', v_dates[1], 'date_to', v_dates[v_n], 'dates', to_jsonb(v_dates),
                       'approved', p_approve, 'url', '/my-day'));

  RETURN jsonb_build_object('approved', p_approve, 'user', p_user, 'dates', to_jsonb(v_dates));
END;
$fn$;

-- 5. Hậu kiểm: đúng một bản mỗi hàm, đúng thân của file này; authenticated gọi được, anon / PUBLIC thì không; hai hàm
--    cũ còn service_role như production.
DO $sau$
DECLARE
  v_ham text;
  v_fn  regprocedure;
BEGIN
  FOREACH v_ham IN ARRAY ARRAY['request_paid_leave(date,text)', 'approve_leave(uuid,date,boolean)',
                               'request_paid_leave_range(date,date,text)', 'approve_leave_batch(uuid,date[],boolean)'] LOOP
    v_fn := to_regprocedure('public.' || v_ham);
    IF (SELECT count(*) FROM pg_catalog.pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace AND p.proname = split_part(v_ham, '(', 1)) <> 1 THEN
      RAISE EXCEPTION 'Hậu kiểm: public.% phải còn đúng một bản', v_ham USING ERRCODE = '55000';
    END IF;
    IF (SELECT md5(replace(p.prosrc, chr(13), '')) FROM pg_catalog.pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM (CASE v_ham
         WHEN 'request_paid_leave(date,text)' THEN '56306a639ab1c11e9b7705d0944632f0'
         WHEN 'approve_leave(uuid,date,boolean)' THEN 'a3c1757c227f20ea6a15270df1112c5c'
         WHEN 'request_paid_leave_range(date,date,text)' THEN '2bf0cac0b7f192a12da4bd5637407429'
         ELSE 'ff64e789e814ac12d37b1031debf6ef2' END) THEN
      RAISE EXCEPTION 'Hậu kiểm: thân public.% không phải bản của file này', v_ham USING ERRCODE = '55000';
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) AS g WHERE p.oid = v_fn AND g.grantee = 0) THEN
      RAISE EXCEPTION 'Hậu kiểm: quyền gọi public.% sai (authenticated gọi được; anon / PUBLIC thì không)', v_ham
        USING ERRCODE = '55000';
    END IF;
    IF v_ham IN ('request_paid_leave(date,text)', 'approve_leave(uuid,date,boolean)')
       AND NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'Hậu kiểm: public.% phải giữ EXECUTE cho service_role như production', v_ham USING ERRCODE = '55000';
    END IF;
  END LOOP;
END
$sau$;

COMMIT;

NOTIFY pgrst, 'reload schema';
