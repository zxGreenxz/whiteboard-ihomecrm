-- =============================================================================
-- Xin nghỉ phép NHIỀU NGÀY trong một đơn + chủ duyệt / từ chối cả đơn trong một lần.
--
-- VÌ SAO
--   19/11/2026 chủ hỏi mục xin nghỉ phép có cho xin nhiều ngày một lúc không: chưa. public.request_paid_leave(p_date,
--   p_reason) nhận MỘT ngày; nghỉ ba ngày phải gửi ba đơn, chủ nhận ba thông báo và bấm duyệt ba lần.
--
-- LÀM GÌ (chỉ THÊM hai hàm; không sửa hàm, bảng hay dữ liệu nào đã có)
--   1. public.request_paid_leave_range(p_from date, p_to date, p_reason text DEFAULT NULL) — nhân viên xin nghỉ từ ngày
--      đến ngày. Chỉ xin cho NGÀY LÀM của công ty người xin (public.vn_workdays: T2–T7 trừ ngày lễ salary_holidays của
--      tổ chức): Chủ nhật và ngày lễ trong khoảng tự bỏ — ngày lễ trả về ở 'holidays'. Không bỏ ngày lễ thì phép rơi vào
--      ngày lễ bị trừ HAI lần khỏi N_chuẩn (v5_n_chuan_for_org_v1 trừ mọi ngày leave_approved trong tháng, kể cả ngày
--      lễ) ⇒ đơn giá ngày tăng sai, và số dư phép bị trừ cho ngày vốn được nghỉ. Từng ngày làm theo đúng luật của
--      request_paid_leave, xét theo thứ tự ngày như thể gửi lần lượt từng đơn:
--        - chỉ hôm nay hoặc ngày tới; một đơn tối đa 31 ngày lịch;
--        - ngày đã có ngày công (ticked) ⇒ từ chối CẢ đơn;
--        - ngày đã có đơn (chờ duyệt / đã duyệt) ⇒ giữ nguyên, không ghi lại, không tính hai lần;
--        - số dư: từ shield_bank_from là phép năm tích luỹ LEAST(12, tháng × paid_leave_days_per_month) trừ số ngày phép
--          (chờ + đã duyệt) trong năm; trước mốc đó là quota tháng. Ngày mới phía trước tính vào "đã dùng" của ngày sau.
--          Không đủ cho MỌI ngày mới ⇒ từ chối CẢ đơn, nói còn đủ bao nhiêu ngày.
--      Cả đơn ghi trong một giao dịch: đủ hết hoặc không ngày nào. Các ngày cùng đơn mang chung mã đơn (evidence.batch)
--      để màn duyệt gom lại. Một thông báo cho chủ (kèm url /my-day), tổ chức lấy từ dòng ngày công vừa ghi — như
--      20261007082645 đã sửa cho đơn một ngày.
--   2. public.approve_leave_batch(p_user uuid, p_dates date[], p_approve boolean) — chủ (is_admin, như approve_leave)
--      duyệt / từ chối nhiều ngày của một người trong một lần: khoá các dòng, MỌI ngày phải đang chờ duyệt (không thì
--      không đổi ngày nào), cập nhật như approve_leave, tính lại chuỗi một lần cho mỗi tháng bị chạm, MỘT thông báo kết
--      quả cho nhân viên (url /my-day).
--   request_paid_leave và approve_leave giữ nguyên: tab Đơn xin nghỉ ở Bảng lương vẫn duyệt lẻ từng ngày.
--
-- LỖI CHO NGƯỜI DÙNG
--   request_paid_leave_range ném lỗi nghiệp vụ bằng P0001 + HINT 'leave_*'; câu lỗi là câu hiển thị cho nhân viên.
--   Ngày vừa đổi trạng thái giữa lúc xét và lúc ghi ⇒ PT409 + HINT 'leave_day_changed' (gửi lại là đủ).
--   approve_leave_batch giữ nguyên hai câu của approve_leave ('Chỉ chủ được duyệt phép', 'Ngày này không ở trạng thái
--   chờ duyệt phép') để màn hình dùng chung cách báo lỗi; tham số sai ⇒ 22023.
--
-- AN TOÀN CHẠY LẠI
--   Tiền kiểm: đối tượng nền có mặt; mỗi tên hàm mới hoặc chưa có, hoặc có đúng một bản đúng chữ ký của file này (lượt
--   chạy lại). CREATE OR REPLACE + REVOKE / GRANT + COMMENT chạy lại không đổi gì; hậu kiểm đúng ở cả hai lượt.
--
-- LÙI (migration forward mới): DROP FUNCTION hai hàm mới. Không phá dữ liệu: đơn gửi theo đường mới là các dòng
--   salary_attendance_day bình thường (pending_leave / leave_approved) — approve_leave và tab Bảng lương vẫn đọc, duyệt
--   được; khoá evidence.batch thừa không ai đọc thì vô hại.
-- =============================================================================

BEGIN;
SET LOCAL lock_timeout = '5s';

-- 0. Tiền kiểm.
DO $truoc$
BEGIN
  -- get_salary_v5_config: từ 20260915074852 là (p_org uuid DEFAULT NULL) — chỉ cần gọi được không tham số.
  IF to_regclass('public.salary_attendance_day') IS NULL
     OR to_regclass('public.notifications') IS NULL
     OR to_regclass('public.super_admins') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'get_salary_v5_config'
                       AND p.pronargs = p.pronargdefaults AND p.prorettype = 'jsonb'::regtype)
     OR to_regprocedure('public.vn_local_date(timestamp with time zone)') IS NULL
     OR to_regprocedure('public.vn_workdays(date)') IS NULL
     OR to_regprocedure('public.is_admin()') IS NULL
     OR to_regprocedure('public.v5_recompute_streak(uuid,date)') IS NULL THEN
    RAISE EXCEPTION 'Thiếu đối tượng nền của phép v5 (salary_attendance_day, notifications, super_admins, profiles, get_salary_v5_config gọi không tham số, vn_local_date, vn_workdays, is_admin, v5_recompute_streak)'
      USING ERRCODE = '55000';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_attribute a
       WHERE a.attrelid = 'public.salary_attendance_day'::regclass AND NOT a.attisdropped
         AND a.attname IN ('user_id', 'work_date', 'status', 'evidence', 'audit', 'organization_id', 'updated_at')) <> 7 THEN
    RAISE EXCEPTION 'public.salary_attendance_day thiếu cột cần dùng (user_id, work_date, status, evidence, audit, organization_id, updated_at)'
      USING ERRCODE = '55000';
  END IF;
  -- Không để lại overload: mỗi tên hoặc chưa có, hoặc chỉ có đúng bản cùng chữ ký của file này.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'request_paid_leave_range'
                AND p.oid IS DISTINCT FROM to_regprocedure('public.request_paid_leave_range(date,date,text)')::oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'approve_leave_batch'
                AND p.oid IS DISTINCT FROM to_regprocedure('public.approve_leave_batch(uuid,date[],boolean)')::oid) THEN
    RAISE EXCEPTION 'Đã có request_paid_leave_range / approve_leave_batch khác chữ ký — DỪNG, đối chiếu trước khi chạy'
      USING ERRCODE = '55000';
  END IF;
END
$truoc$;

-- 1. Nhân viên xin nghỉ từ ngày đến ngày.
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
      IF v_ok = 0 THEN
        RAISE EXCEPTION 'Số dư phép đã hết (tích lũy % — đã dùng %)', v_quota, v_used
          USING HINT = 'leave_quota_exceeded';
      END IF;
      RAISE EXCEPTION 'Số dư phép chỉ còn đủ % ngày, đơn này cần % ngày — bớt ngày rồi gửi lại', v_ok, v_n
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

COMMENT ON FUNCTION public.request_paid_leave_range(date, date, text) IS
  'Nhân viên xin nghỉ phép có lương từ p_from đến p_to trong MỘT đơn, chỉ cho ngày làm của công ty (vn_workdays: bỏ Chủ nhật và ngày lễ — ngày lễ trả về ở holidays): từng ngày theo luật request_paid_leave, số dư phải đủ cho mọi ngày mới, ghi cả đơn hoặc không ngày nào; một thông báo cho chủ. Lỗi nghiệp vụ: P0001 + HINT leave_*; ngày vừa đổi trạng thái: PT409 leave_day_changed. 20261119020927.';

-- 2. Chủ duyệt / từ chối nhiều ngày của một người trong một lần.
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
     FOR UPDATE;
  SELECT count(*), (array_agg(a.organization_id ORDER BY a.work_date))[1] INTO v_pending, v_org
    FROM public.salary_attendance_day a
   WHERE a.user_id = p_user AND a.work_date = ANY (v_dates) AND a.status = 'pending_leave';
  IF v_pending <> v_n THEN
    RAISE EXCEPTION 'Ngày này không ở trạng thái chờ duyệt phép'
      USING DETAIL = format('%s/%s ngày còn chờ duyệt', v_pending, v_n);
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

COMMENT ON FUNCTION public.approve_leave_batch(uuid, date[], boolean) IS
  'Chủ (is_admin) duyệt / từ chối nhiều ngày phép của một người trong một lần: mọi ngày phải đang pending_leave (không thì không đổi ngày nào), tính lại chuỗi mỗi tháng bị chạm, một thông báo kết quả. Cùng câu lỗi với approve_leave. 20261119020927.';

REVOKE ALL ON FUNCTION public.request_paid_leave_range(date, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.request_paid_leave_range(date, date, text) TO authenticated;
REVOKE ALL ON FUNCTION public.approve_leave_batch(uuid, date[], boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.approve_leave_batch(uuid, date[], boolean) TO authenticated;

-- 3. Hậu kiểm: đúng một bản mỗi hàm, đúng hình dạng; authenticated gọi được, anon / PUBLIC thì không.
DO $sau$
DECLARE
  v_fn regprocedure;
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('request_paid_leave_range', 'approve_leave_batch')) <> 2 THEN
    RAISE EXCEPTION 'Hậu kiểm: request_paid_leave_range / approve_leave_batch phải có đúng một bản mỗi hàm'
      USING ERRCODE = '55000';
  END IF;
  FOREACH v_fn IN ARRAY ARRAY[to_regprocedure('public.request_paid_leave_range(date,date,text)'),
                              to_regprocedure('public.approve_leave_batch(uuid,date[],boolean)')] LOOP
    IF v_fn IS NULL OR NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc p
          WHERE p.oid = v_fn AND p.prosecdef AND p.provolatile = 'v'
            AND p.prorettype = 'jsonb'::regtype
            AND p.proconfig = ARRAY['search_path=pg_catalog, public']::text[]) THEN
      RAISE EXCEPTION 'Hậu kiểm: % phải là jsonb, VOLATILE, SECURITY DEFINER, search_path pg_catalog, public', v_fn
        USING ERRCODE = '55000';
    END IF;
    IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
       OR has_function_privilege('anon', v_fn, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(p.proacl) AS g WHERE p.oid = v_fn AND g.grantee = 0) THEN
      RAISE EXCEPTION 'Hậu kiểm: quyền gọi % sai (authenticated phải gọi được; anon / PUBLIC thì không)', v_fn
        USING ERRCODE = '55000';
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'request_paid_leave_range' AND p.pronargdefaults = 1) <> 1 THEN
    RAISE EXCEPTION 'Hậu kiểm: request_paid_leave_range phải giữ DEFAULT NULL cho p_reason' USING ERRCODE = '55000';
  END IF;
END
$sau$;

COMMIT;

NOTIFY pgrst, 'reload schema';
