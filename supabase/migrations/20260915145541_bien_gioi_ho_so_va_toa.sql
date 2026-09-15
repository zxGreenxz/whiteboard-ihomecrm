-- =============================================================================
-- Hai chỗ biên giới lệch: hồ sơ super admin lộ ra mọi tổ chức, và
-- can_access_building rộng hơn buildings_for_v3
--
-- I3.5, plan rà soát 15/09/2026.
--
-- ========================= (A) profiles_select_super_admin ===================
-- Policy hiện tại (20260701150000):
--     USING (public.is_user_super_admin(id))
-- tức MỌI người đã đăng nhập — kể cả người của một công ty khác — đọc được hồ
-- sơ của super admin: họ tên, điện thoại, email, avatar. Không có
-- profiles_org_boundary nào chặn lại (đã tra: bảng profiles không có policy
-- RESTRICTIVE biên giới tổ chức, chỉ có hai policy ẩn demo/sandbox).
--
-- PLAN ĐỀ XUẤT đổi thành USING (is_super_admin()) — tức chỉ super admin đọc
-- được hồ sơ super admin. KHÔNG làm thế, vì nó dựng lại đúng lỗi mà
-- 20260701150000 sinh ra để vá: nhân viên KHÁC ĐỘI (án lệ: JOEY) không thấy
-- CHỦ trong ô "Người nhận" khi bàn giao tiền, nên không nộp tiền cho chủ được
-- dù backend đã cho phép. Đường tiền, không phải chuyện hiển thị.
--
-- LÀM HẸP ĐÚNG CHỖ HỞ: hồ sơ super admin chỉ lộ cho người CÙNG TỔ CHỨC với
-- người đó. Nhân viên cùng công ty vẫn chọn được chủ làm người nhận (vá 01/07
-- còn nguyên tác dụng); người của công ty khác không còn đọc được gì.
--
-- ĐO TRƯỚC (production, read-only 15/09/2026):
--     12 hồ sơ, tất cả đều có membership ACTIVE
--     super admin (1 người) là thành viên của cả 2 tổ chức
--     số người MẤT quyền xem vì lần siết này: 0
-- Hôm nay không ai mất gì — cửa được đóng cho các tổ chức sau này.
--
-- ========================= (B) can_access_building ==========================
-- app_private.buildings_for_v3 (01/08/2026) nói lại ĐÚNG hai mệnh đề RESTRICTIVE
-- của RLS trên public.buildings, vì nhánh SECURITY DEFINER đi vòng qua RLS:
--     NOT (is_super_admin() AND org ∈ sandbox_org_ids())
--     NOT ((is_super_admin() OR is_admin()) AND b.user_id ∈ demo_user_ids())
--
-- public.can_access_building — cũng SECURITY DEFINER, cũng là cửa xem toà cho
-- hàng loạt báo cáo — chỉ có mệnh đề sandbox, THIẾU mệnh đề demo. Nên cùng một
-- người, cùng một toà, hai đường đọc cho hai câu trả lời khác nhau: toà do tài
-- khoản demo đứng tên bị RLS giấu khi đọc thẳng bảng, nhưng lọt qua mọi báo
-- cáo đi bằng can_access_building.
--
-- SỬA: thêm đúng mệnh đề còn thiếu, chép nguyên văn từ buildings_for_v3.
--
-- AI BỊ ẢNH HƯỞNG — đo trên production 15/09/2026:
--   public.is_admin() thân hàm hiện tại là `SELECT public.is_super_admin()`,
--   nên mệnh đề demo chỉ chạm tới SUPER ADMIN. Hệ chỉ có 1 super admin, và
--   tài khoản demo.* KHÔNG phải super admin (đã đếm: la_super = 0 cho cả 7 tài
--   khoản demo). Vậy các tài khoản DEMO vẫn xem được toà của chính họ — đúng
--   như hôm nay, vì RLS trên bảng đã áp cùng mệnh đề này từ lâu mà DEMO vẫn
--   chạy. Thay đổi thật: 4 toà do "DEMO Chủ Nhà" đứng tên thôi lọt vào các báo
--   cáo definer của super admin — đúng điều ORG_ISOLATION_V1 muốn.
--
-- KHÔNG đụng mệnh đề sandbox của can_access_building. Nó khác buildings_for_v3
-- (ở đây là "không phải thành viên", ở kia là "là super admin") và việc hợp
-- nhất hai cách diễn đạt đó làm đổi tập người lọt — cần một lần đo riêng, ghi
-- vào báo cáo chứ không kèm vào file này.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- (A) Hồ sơ super admin chỉ lộ trong phạm vi tổ chức.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_private.cung_to_chuc_voi_toi_v1(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $f$
  SELECT EXISTS (
    SELECT 1
      FROM public.organization_memberships m
     WHERE m.user_id = p_user
       AND m.status = 'ACTIVE'
       AND m.organization_id = ANY (public.my_org_ids())
  );
$f$;

COMMENT ON FUNCTION app_private.cung_to_chuc_voi_toi_v1(uuid) IS
  'Nguoi dang dang nhap va p_user co chung it nhat mot to chuc ACTIVE khong. SECURITY DEFINER de doc organization_memberships ma khong de quy RLS - cung ly do ma same_team() la definer.';

-- Hàm này được gọi TRONG BIỂU THỨC RLS, mà biểu thức RLS chạy bằng quyền của
-- người đang đọc. Cắt EXECUTE của `authenticated` là mọi SELECT trên profiles
-- nổ "permission denied for function". Cấp đúng một vai, cắt phần còn lại —
-- cùng khuôn với app_private.authorized_scope_v3 (authenticated true, anon
-- false), đo trên production 15/09/2026.
REVOKE ALL ON FUNCTION app_private.cung_to_chuc_voi_toi_v1(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_private.cung_to_chuc_voi_toi_v1(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION app_private.cung_to_chuc_voi_toi_v1(uuid) TO authenticated;

DROP POLICY IF EXISTS profiles_select_super_admin ON public.profiles;
CREATE POLICY profiles_select_super_admin ON public.profiles
  FOR SELECT TO authenticated
  USING (
    public.is_user_super_admin(id)
    AND app_private.cung_to_chuc_voi_toi_v1(id)
  );

COMMENT ON POLICY profiles_select_super_admin ON public.profiles IS
  'Ho so super admin (chu) hien cho nhan vien CUNG TO CHUC, de chu luon chon duoc lam Nguoi nhan khi ban giao tien (an le JOEY, 20260701150000). Tu 15/09/2026 co them ve cung-to-chuc: truoc do moi nguoi dang nhap o bat ky cong ty nao cung doc duoc ho so chu.';

-- ---------------------------------------------------------------------------
-- (B) can_access_building nói lại đủ hai mệnh đề RESTRICTIVE của RLS.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_access_building(_building_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
  SELECT NOT EXISTS (
           SELECT 1
           FROM public.buildings b
           WHERE b.id = _building_id
             AND COALESCE(b.organization_id = ANY (public.sandbox_org_ids()), false)
             AND NOT COALESCE(b.organization_id = ANY (public.my_org_ids()), false)
         )
     -- ORG_ISOLATION_V1, bổ sung 15/09/2026: nói lại mệnh đề RESTRICTIVE
     -- buildings_hide_demo_admin mà buildings_for_v3 đã nói từ 01/08. Thiếu nó
     -- thì toà của tài khoản demo bị RLS giấu khi đọc bảng nhưng vẫn lọt vào
     -- mọi báo cáo SECURITY DEFINER.
     AND NOT EXISTS (
           SELECT 1
           FROM public.buildings b
           WHERE b.id = _building_id
             AND (public.is_super_admin() OR public.is_admin())
             AND b.user_id = ANY (public.demo_user_ids())
         )
     AND (public.is_super_admin() OR app_private.can_v3('buildings.view', _building_id));
$function$;

COMMENT ON FUNCTION public.can_access_building(_building_id uuid) IS
  'Quyen xem mot toa. Chan san org sandbox (xem public.sandbox_org_ids()) doi voi nguoi khong co membership o org do. Tu 15/09/2026 chan them toa do tai khoan demo dung ten doi voi super admin/admin - noi lai dung hai menh de RESTRICTIVE cua RLS tren public.buildings, giong app_private.buildings_for_v3. Neu khong, RLS giau toa demo khi doc bang nhung bao cao SECURITY DEFINER van thay.';

-- ---------------------------------------------------------------------------
-- NGHIỆM THU
-- ---------------------------------------------------------------------------
DO $nghiem_thu$
DECLARE
  v_n int; v_mat bigint; v_auth boolean; v_anon boolean;
BEGIN
  -- Biểu thức RLS chạy bằng quyền người đọc: thiếu GRANT là chết cả bảng.
  SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE'),
         has_function_privilege('anon', p.oid, 'EXECUTE')
    INTO v_auth, v_anon
    FROM pg_proc p
   WHERE p.proname = 'cung_to_chuc_voi_toi_v1'
     AND p.pronamespace = 'app_private'::regnamespace;
  IF NOT v_auth THEN
    RAISE EXCEPTION 'authenticated khong goi duoc cung_to_chuc_voi_toi_v1 - moi SELECT tren profiles se no. DUNG.';
  END IF;
  IF v_anon THEN
    RAISE EXCEPTION 'anon goi duoc cung_to_chuc_voi_toi_v1. DUNG.';
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_policy
   WHERE polrelid = 'public.profiles'::regclass
     AND polname = 'profiles_select_super_admin'
     AND pg_get_expr(polqual, polrelid) LIKE '%cung_to_chuc_voi_toi_v1%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'profiles_select_super_admin chua co ve cung-to-chuc. DUNG.';
  END IF;

  -- Khong ai dang co membership bi mat quyen xem ho so super admin.
  SELECT count(*) INTO v_mat
    FROM public.profiles p
   WHERE EXISTS (SELECT 1 FROM public.organization_memberships m
                  WHERE m.user_id = p.id AND m.status = 'ACTIVE')
     AND NOT EXISTS (
       SELECT 1
         FROM public.organization_memberships m
         JOIN public.organization_memberships sm ON sm.organization_id = m.organization_id
         JOIN public.super_admins sa ON sa.user_id = sm.user_id
        WHERE m.user_id = p.id AND m.status = 'ACTIVE' AND sm.status = 'ACTIVE'
     );
  IF v_mat > 0 THEN
    RAISE EXCEPTION '% nguoi dang co to chuc se mat quyen xem ho so chu. Soi tay truoc khi siet.', v_mat;
  END IF;

  SELECT count(*) INTO v_n
    FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'can_access_building'
     AND p.prosrc LIKE '%demo_user_ids%';
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'can_access_building chua co menh de loai tru toa demo. DUNG.';
  END IF;

  RAISE NOTICE 'OK: ho so chu chi lo trong to chuc, can_access_building khop buildings_for_v3.';
END
$nghiem_thu$;

-- =============================================================================
-- ROLLBACK:
--   DROP POLICY profiles_select_super_admin ON public.profiles; rồi CREATE lại
--   USING (public.is_user_super_admin(id)) như 20260701150000.
--   DROP FUNCTION app_private.cung_to_chuc_voi_toi_v1(uuid);
--   CREATE OR REPLACE public.can_access_building bỏ khối NOT EXISTS demo (bản
--   pg_get_functiondef 15/09/2026 chính là phần còn lại của hàm trong file này).
-- =============================================================================
