-- Rà soát 15/09/2026 · plan con I1 — hai lỗ P0 của engine lương V5.
--
-- LỖ 1 · ĐỌC LƯƠNG NGƯỜI KHÁC BẰNG UUID.
--   `public.v5_month_money(p_user, p_month)` và `public.v5_n_chuan(p_month, p_user)`
--   là SECURITY DEFINER, cấp EXECUTE cho `authenticated`, và KHÔNG hề nhìn
--   `auth.uid()`. Người dùng bất kỳ — kể cả tài khoản của một công ty khác — chỉ
--   cần biết UUID là đọc được lương tháng, số ngày công, số ngày phép của bất kỳ
--   ai. Không có RLS nào chắn: SECURITY DEFINER chạy dưới quyền chủ hàm nên
--   `salary_attendance_day` / `salary_streak_state` được đọc thẳng.
--
-- LỖ 2 · MỌI CÔNG TY TÍNH LƯƠNG BẰNG HẰNG SỐ CỦA CÔNG TY THẬT.
--   `public.get_salary_v5_config()` lấy `salary_bonus_rules` của SUPER ADMIN ĐẦU
--   TIÊN (`SELECT user_id FROM super_admins ORDER BY created_at LIMIT 1`), và
--   `public.vn_workdays(p_month)` lấy `salary_holidays` của đúng người ấy. Bộ
--   luật lương của một doanh nghiệp — ngân sách chuyên cần, mốc chuỗi, ngày
--   nghỉ lễ — do vậy rò sang mọi tổ chức khác, và ai đăng nhập cũng đọc được.
--
-- CÁCH VÁ, VÀ RANH GIỚI CỐ Ý KHÔNG VƯỢT QUA.
--   Migration này CHỈ đổi (a) ai được gọi, (b) bộ luật của tổ chức nào được
--   dùng. Nó KHÔNG đụng một hằng số nào của V5.1 (khiên 3 lớp, phép năm, mốc
--   2,5tr — hiệu lực 01/09/2026): công thức chuyên cần, soft floor, trần quỹ,
--   cách cộng `milestones_banked` được chép nguyên văn từ bản đang chạy trên
--   production (`pg_get_functiondef`, md5 baf83f29cdd0d1a24252efe069a0afd2 cho
--   v5_month_money, 3c0a80728ea718ebdb179debef03e4fc cho get_salary_v5_config,
--   5e76b17d5264d31d788b06bc809ea6d1 cho vn_workdays).
--
--   Đo trên production 15/09/2026 trước khi viết: `salary_bonus_rules` có ĐÚNG 1
--   dòng (org `aaaa…0001`, có `system_v5`); cả 6 dòng `salary_holidays` cũng
--   thuộc org ấy; và toàn bộ 133 dòng `salary_attendance_day` là của hai người
--   cùng org ấy. Nên với dữ liệu thật hiện tại, "bộ luật của super admin đầu
--   tiên" và "bộ luật của tổ chức người được tính" TRẢ RA CÙNG MỘT THỨ — số tiền
--   không đổi một đồng nào. Cái đổi là: org DEMO (và mọi org tương lai) thôi
--   mượn hằng số của công ty thật.
--
-- VÌ SAO KHÔNG ĐỔI CHỮ KÝ `v5_month_money` / `v5_n_chuan` / `vn_workdays`.
--   Chúng đang được gọi từ `src/hooks/useManagerSalary.ts` và có mặt trong
--   `types.ts`. Đổi chữ ký là đổi mọi caller trong cùng một nhịp; giữ nguyên chữ
--   ký thì bản vá này áp được độc lập với phần giao diện.

BEGIN;
SET LOCAL lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Tổ chức tính lương của một người.
-- ---------------------------------------------------------------------------
-- Người thuộc đúng một tổ chức thì không có gì phải chọn. Người thuộc nhiều tổ
-- chức (thực tế: tài khoản hệ thống vừa ở công ty thật vừa ở DEMO) thì chọn tổ
-- chức CÓ bộ luật lương v5. Nếu vẫn còn hơn một ứng viên thì DỪNG bằng lỗi:
-- đoán bừa ở đây là tính sai lương của một người thật, và một lỗi ồn ào rẻ hơn
-- rất nhiều so với một con số sai im lặng.
CREATE OR REPLACE FUNCTION app_private.v5_salary_org_of_user_v1(p_user uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_org uuid;
  v_count integer;
BEGIN
  IF p_user IS NULL THEN
    RETURN NULL;
  END IF;

  v_org := app_private.single_org_of_user_v1(p_user);
  IF v_org IS NOT NULL THEN
    RETURN v_org;
  END IF;

  -- `(array_agg(DISTINCT …))[1]` chứ không phải `min()`: Postgres không có
  -- `min(uuid)`. Cùng lối viết với app_private.single_org_of_user_v1.
  SELECT count(DISTINCT m.organization_id), (array_agg(DISTINCT m.organization_id))[1]
  INTO v_count, v_org
  FROM public.organization_memberships m
  JOIN public.salary_bonus_rules r
    ON r.organization_id = m.organization_id
  WHERE m.user_id = p_user
    AND m.status = 'ACTIVE'
    AND r.rules ? 'system_v5';

  IF v_count > 1 THEN
    RAISE EXCEPTION
      'v5_salary_org_ambiguous: % thuoc % to chuc cung co bo luat luong v5', p_user, v_count
      USING ERRCODE = 'P0001';
  END IF;

  RETURN CASE WHEN v_count = 1 THEN v_org ELSE NULL END;
END;
$fn$;

COMMENT ON FUNCTION app_private.v5_salary_org_of_user_v1(uuid) IS
  'To chuc dung de tinh luong v5 cho mot nguoi; mo ho thi raise thay vi doan.';

REVOKE ALL ON FUNCTION app_private.v5_salary_org_of_user_v1(uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Ai được xem lương của ai.
-- ---------------------------------------------------------------------------
-- Hai cửa, và chỉ hai: xem của CHÍNH MÌNH, hoặc có `salary.view` phạm vi toàn
-- tổ chức trong một tổ chức mà NGƯỜI ĐƯỢC XEM đang là thành viên hoạt động.
--
-- `authorized_scope_v3` tự kiểm tư cách thành viên của NGƯỜI GỌI trong tổ chức
-- truyền vào (mệnh đề `membership` neo theo `auth.uid()`), nên một quản trị viên
-- của công ty khác truyền UUID người thật vào sẽ không có dòng membership nào →
-- `org_wide` = false. Đó là lý do không cần thêm một phép kiểm "cùng công ty"
-- nữa ở đây: nó đã nằm sẵn trong hàm kia.
CREATE OR REPLACE FUNCTION app_private.v5_can_view_salary_v1(p_target uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT CASE
    WHEN p_target IS NULL THEN false
    -- Job đêm (edge function salary-v5-jobs dùng service_role → v5_run_job →
    -- v5_close_period → v5_month_money từng nhân viên) và mọi đường nội bộ
    -- không mang JWT người dùng: KHÔNG có auth.uid() để so, nhưng đó không phải
    -- "người lạ đọc lương" — service_role/postgres đã là chủ toàn database.
    -- Không có mệnh đề này thì đóng kỳ lương tự động gãy 42501 ngay đêm đầu
    -- (phát hiện 16/09/2026 lúc gộp, đo chuỗi gọi trên production).
    WHEN auth.role() = 'service_role' OR session_user = 'postgres' THEN true
    WHEN (SELECT auth.uid()) IS NULL THEN false
    WHEN p_target = (SELECT auth.uid()) THEN true
    ELSE EXISTS (
      SELECT 1
      FROM public.organization_memberships m
      CROSS JOIN LATERAL app_private.authorized_scope_v3('salary.view', m.organization_id) scope
      WHERE m.user_id = p_target
        AND m.status = 'ACTIVE'
        AND COALESCE(scope.org_wide, false)
    )
  END;
$fn$;

COMMENT ON FUNCTION app_private.v5_can_view_salary_v1(uuid) IS
  'Chinh minh, hoac salary.view org_wide trong mot to chuc cua nguoi duoc xem.';

REVOKE ALL ON FUNCTION app_private.v5_can_view_salary_v1(uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Bộ luật lương v5 của MỘT tổ chức.
-- ---------------------------------------------------------------------------
-- Thân hàm chép nguyên văn bản production, đổi đúng một chỗ: mệnh đề WHERE
-- không còn neo vào super admin đầu tiên mà neo vào `organization_id`. Phần
-- `pending_money_patch` (cơ chế hẹn giờ của V5.1) giữ y nguyên.
CREATE OR REPLACE FUNCTION app_private.v5_salary_config_for_org_v1(p_org uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_rules JSONB;
  v_pending JSONB;
  v_eff JSONB;
BEGIN
  IF p_org IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT r.rules INTO v_rules
  FROM public.salary_bonus_rules r
  WHERE r.organization_id = p_org
    AND r.rules ? 'system_v5'
  ORDER BY r.updated_at DESC NULLS LAST, r.created_at DESC, r.id
  LIMIT 1;

  IF v_rules IS NULL THEN
    RETURN NULL; -- tổ chức chưa seed v5
  END IF;

  v_eff := jsonb_build_object(
    'attendance_v5', v_rules->'attendance_v5',
    'streak_v5',     v_rules->'streak_v5',
    'coverage_v5',   v_rules->'coverage_v5',
    'system_v5',     v_rules->'system_v5'
  );

  -- áp pending key nếu đã tới tháng hiệu lực
  v_pending := v_rules->'system_v5'->'pending_money_patch';
  IF v_pending IS NOT NULL AND jsonb_typeof(v_pending) = 'object'
     AND (v_pending->>'effective_month')::date <= date_trunc('month', public.vn_local_date(now()))::date THEN
    v_eff := v_eff || COALESCE(v_pending->'patch', '{}'::jsonb);
  END IF;

  RETURN v_eff || jsonb_build_object(
    'version', v_rules->'system_v5'->'config_version',
    'as_of', public.vn_local_date(now())
  );
END;
$fn$;

COMMENT ON FUNCTION app_private.v5_salary_config_for_org_v1(uuid) IS
  'Bo luat luong v5 cua mot to chuc; hang so V5.1 giu nguyen, chi doi cach chon.';

REVOKE ALL ON FUNCTION app_private.v5_salary_config_for_org_v1(uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Lịch ngày-làm của MỘT tổ chức.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.vn_workdays_for_org_v1(p_month date, p_org uuid)
RETURNS SETOF date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
  SELECT d::date
  FROM generate_series(date_trunc('month', p_month),
                       date_trunc('month', p_month) + INTERVAL '1 month - 1 day',
                       INTERVAL '1 day') AS g(d)
  WHERE EXTRACT(dow FROM d) <> 0                     -- bỏ CN
    AND d::date NOT IN (
      SELECT h.holiday_date FROM public.salary_holidays h
      WHERE h.organization_id = p_org
    );
$fn$;

COMMENT ON FUNCTION app_private.vn_workdays_for_org_v1(date, uuid) IS
  'Ngay-lam trong thang theo lich nghi le cua MOT to chuc (T2-T7, bo CN).';

REVOKE ALL ON FUNCTION app_private.vn_workdays_for_org_v1(date, uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. N_chuẩn nội bộ — không kiểm quyền, vì người gọi nó đã kiểm.
-- ---------------------------------------------------------------------------
-- Tách ra để `v5_month_money` không phải chạy lại phép kiểm quyền lần thứ hai,
-- và để chỉ có ĐÚNG MỘT nơi định nghĩa công thức. Hàm này nằm trong
-- `app_private` và không cấp EXECUTE cho ai, nên không phải là bề mặt tấn công.
CREATE OR REPLACE FUNCTION app_private.v5_n_chuan_for_org_v1(p_month date, p_user uuid, p_org uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
  SELECT (SELECT COUNT(*) FROM app_private.vn_workdays_for_org_v1(p_month, p_org))::int
       - (SELECT COUNT(*) FROM public.salary_attendance_day sad
          WHERE sad.user_id = p_user
            AND sad.status = 'leave_approved'
            AND sad.work_date >= date_trunc('month', p_month)::date
            AND sad.work_date <  (date_trunc('month', p_month) + INTERVAL '1 month')::date)::int;
$fn$;

COMMENT ON FUNCTION app_private.v5_n_chuan_for_org_v1(date, uuid, uuid) IS
  'N_chuan: ngay-lam cua to chuc tru ngay phep-duyet cua nguoi do (mau so trung tinh).';

REVOKE ALL ON FUNCTION app_private.v5_n_chuan_for_org_v1(date, uuid, uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Tiền lương tháng nội bộ — cùng lý do như trên.
-- ---------------------------------------------------------------------------
-- Công thức chép nguyên văn bản production. Đổi đúng hai nguồn đầu vào: cấu
-- hình và N_chuẩn nay đi theo TỔ CHỨC của người được tính, thay vì theo super
-- admin đầu tiên của hệ thống.
CREATE OR REPLACE FUNCTION app_private.v5_month_money_for_user_v1(p_user uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_org UUID := app_private.v5_salary_org_of_user_v1(p_user);
  v_cfg JSONB := app_private.v5_salary_config_for_org_v1(v_org);
  v_month DATE := date_trunc('month', p_month)::date;
  v_n INT; v_rate NUMERIC; v_ticked INT;
  v_budget NUMERIC := (v_cfg->'attendance_v5'->>'budget')::numeric;
  v_sbudget NUMERIC := (v_cfg->'streak_v5'->>'budget')::numeric;
  v_soft JSONB := v_cfg->'attendance_v5'->'soft_floor';
  v_attend NUMERIC; v_streak NUMERIC; v_banked JSONB;
BEGIN
  -- Tổ chức chưa seed v5 thì KHÔNG có bộ luật để tính. Trả khung số 0 kèm
  -- `configured=false` thay vì để NULL lan qua mọi phép cộng — NULL ở đây là
  -- cách "mất trắng lương" im lặng (xem chú thích resolveSalaryEngine trong
  -- src/lib/managerSalary.ts). Trước bản vá này trường hợp đó không tồn tại vì
  -- mọi tổ chức đều mượn cấu hình của công ty thật; chính điều đó là lỗ hổng.
  IF v_cfg IS NULL THEN
    RETURN jsonb_build_object(
      'month', v_month, 'n_chuan', 0, 'day_rate', 0,
      'ticked_days', 0,
      'attend_amount', 0, 'attend_budget', 0,
      'streak_amount', 0, 'streak_budget', 0,
      'banked', '[]'::jsonb,
      'total', 0,
      'configured', false
    );
  END IF;

  v_n := app_private.v5_n_chuan_for_org_v1(v_month, p_user, v_org);
  v_rate := CASE WHEN v_n > 0 THEN v_budget / v_n ELSE 0 END;
  SELECT COUNT(*) INTO v_ticked FROM public.salary_attendance_day
  WHERE user_id = p_user AND status = 'ticked'
    AND work_date >= v_month AND work_date < (v_month + INTERVAL '1 month')::date;
  v_attend := ROUND(v_rate * LEAST(v_ticked, v_n));
  IF COALESCE((v_soft->>'enabled')::boolean, false) AND v_ticked >= (v_soft->>'at_days')::int THEN
    v_attend := GREATEST(v_attend, (v_soft->>'amount')::numeric);
  END IF;
  v_attend := LEAST(v_attend, v_budget);
  SELECT COALESCE(milestones_banked, '[]'::jsonb) INTO v_banked
  FROM public.salary_streak_state WHERE user_id = p_user AND period_month = v_month;
  v_banked := COALESCE(v_banked, '[]'::jsonb);
  SELECT COALESCE(SUM((b->>'delta')::numeric), 0) INTO v_streak FROM jsonb_array_elements(v_banked) b;
  v_streak := LEAST(v_streak, v_sbudget);
  RETURN jsonb_build_object(
    'month', v_month, 'n_chuan', v_n, 'day_rate', ROUND(v_rate),
    'ticked_days', v_ticked,
    'attend_amount', v_attend, 'attend_budget', v_budget,
    'streak_amount', v_streak, 'streak_budget', v_sbudget,
    'banked', v_banked,
    'total', v_attend + v_streak,
    'configured', true
  );
END;
$fn$;

COMMENT ON FUNCTION app_private.v5_month_money_for_user_v1(uuid, date) IS
  'Tien chuyen can + chuoi cua mot nguoi theo bo luat TO CHUC cua nguoi do; khong kiem quyen.';

REVOKE ALL ON FUNCTION app_private.v5_month_money_for_user_v1(uuid, date) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7. Ba hàm public: giữ nguyên chữ ký, thêm cổng quyền.
-- ---------------------------------------------------------------------------
-- `vn_workdays` không nhận người nào, nên tổ chức lấy theo CHÍNH NGƯỜI GỌI.
CREATE OR REPLACE FUNCTION public.vn_workdays(p_month date)
RETURNS SETOF date
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT *
  FROM app_private.vn_workdays_for_org_v1(p_month, app_private.v5_salary_org_of_user_v1(v_uid));
END;
$fn$;

COMMENT ON FUNCTION public.vn_workdays(date) IS
  'Ngay-lam theo lich nghi le cua to chuc NGUOI GOI (truoc 15/09/2026: cua super admin dau tien).';

CREATE OR REPLACE FUNCTION public.v5_n_chuan(p_month date, p_user uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  IF NOT app_private.v5_can_view_salary_v1(p_user) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  RETURN app_private.v5_n_chuan_for_org_v1(
    p_month, p_user, app_private.v5_salary_org_of_user_v1(p_user));
END;
$fn$;

COMMENT ON FUNCTION public.v5_n_chuan(date, uuid) IS
  'N_chuan cua mot nguoi. 42501 neu nguoi goi khong phai chinh ho va khong co salary.view.';

CREATE OR REPLACE FUNCTION public.v5_month_money(p_user uuid, p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
BEGIN
  IF NOT app_private.v5_can_view_salary_v1(p_user) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  RETURN app_private.v5_month_money_for_user_v1(p_user, p_month);
END;
$fn$;

COMMENT ON FUNCTION public.v5_month_money(uuid, date) IS
  'Tien chuyen can + chuoi cua mot nguoi. 42501 neu nguoi goi khong phai chinh ho va khong co salary.view.';

-- ---------------------------------------------------------------------------
-- 8. Bản gộp — thay vòng lặp N+1 ở màn lương quản lý.
-- ---------------------------------------------------------------------------
-- `useManagerSalary` đang gọi `v5_month_money` MỘT LẦN CHO MỖI quản lý trong
-- một `Promise.all`. Bản gộp trả một object khoá theo UUID.
--
-- KHÁC BIỆT CÓ CHỦ Ý so với bản đơn: bản gộp KHÔNG raise khi trong danh sách có
-- người mà người gọi không được xem — nó chỉ BỎ QUA người ấy. Lý do là hành vi
-- thật của giao diện: một quản lý toà chỉ có quyền xem lương của chính mình vẫn
-- mở được màn lương, và nếu một UUID không có quyền làm hỏng cả lời gọi thì anh
-- ta mất luôn số của CHÍNH MÌNH. Bỏ qua thì không rò gì (không có khoá nào cho
-- người không được xem) mà vẫn trả đủ phần hợp lệ.
CREATE OR REPLACE FUNCTION public.v5_month_money_bulk(p_users uuid[], p_month date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_users uuid[] := COALESCE(p_users, '{}'::uuid[]);
  v_out jsonb;
BEGIN
  IF (SELECT auth.uid()) IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;
  -- Trần phòng lạm dụng: màn lương thật có chưa tới mười quản lý một kỳ.
  IF cardinality(v_users) > 200 THEN
    RAISE EXCEPTION 'v5_month_money_bulk: toi da 200 nguoi moi loi goi'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(
    jsonb_object_agg(u.id::text, app_private.v5_month_money_for_user_v1(u.id, p_month)),
    '{}'::jsonb)
  INTO v_out
  FROM (SELECT DISTINCT x AS id FROM unnest(v_users) x WHERE x IS NOT NULL) u
  WHERE app_private.v5_can_view_salary_v1(u.id);

  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.v5_month_money_bulk(uuid[], date) IS
  'v5_month_money cho nhieu nguoi trong mot luot; bo qua nguoi ma nguoi goi khong duoc xem.';

REVOKE ALL ON FUNCTION public.v5_month_money_bulk(uuid[], date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.v5_month_money_bulk(uuid[], date) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Cấu hình lương: thêm `p_org`, và khoá theo tổ chức người gọi.
-- ---------------------------------------------------------------------------
-- DROP rồi CREATE chứ không CREATE OR REPLACE: thêm tham số vào một hàm đang tồn
-- tại sẽ đẻ ra một overload thứ hai, và PostgREST phân giải theo tên tham số nên
-- lời gọi cũ có thể rơi vào bản nào không đoán trước được.
--
-- `p_org` có DEFAULT NULL nên `supabase.rpc('get_salary_v5_config')` không tham
-- số — cách `useSalaryV5Config.ts` và `useSalaryV5Admin.ts` đang gọi — vẫn chạy
-- y như cũ; hai file ấy thuộc plan khác nên bản vá này cố ý không đụng tới.
DROP FUNCTION IF EXISTS public.get_salary_v5_config();

CREATE OR REPLACE FUNCTION public.get_salary_v5_config(p_org uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $fn$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_org uuid;
BEGIN
  IF v_uid IS NULL THEN
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

COMMENT ON FUNCTION public.get_salary_v5_config(uuid) IS
  'Bo luat luong v5 cua to chuc nguoi goi (truoc 15/09/2026: cua super admin dau tien).';

-- DROP ở trên xoá luôn ACL cũ, phải dựng lại đúng bộ đã đo trên production:
-- {postgres, authenticated, service_role}. REVOKE FROM public KHÔNG cắt `anon`
-- trên Supabase — `anon` là role riêng, phải gọi tên.
REVOKE ALL ON FUNCTION public.get_salary_v5_config(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_salary_v5_config(uuid) TO authenticated, service_role;

COMMIT;
