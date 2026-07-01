-- =====================================================================
-- Nhân viên (không cùng đội, vd JOEY) không thấy CHỦ (super admin) trong ô
-- "Người nhận" khi bàn giao → không nộp tiền cho chủ được, dù guard backend đã
-- cho phép nộp cho super admin.
--
-- Vá: cho MỌI authenticated THẤY profile của super admin (chủ) → chủ luôn xuất
-- hiện làm người nhận. Dùng helper SECURITY DEFINER (đọc super_admins bỏ RLS,
-- giống same_team) để tránh lỗi RLS lồng như profiles_select_via_staff_assignments.
-- Chỉ lộ profile của chủ (1 dòng) — không đụng dữ liệu khác.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.is_user_super_admin(p_user uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.super_admins sa WHERE sa.user_id = p_user);
$$;
GRANT EXECUTE ON FUNCTION public.is_user_super_admin(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS profiles_select_super_admin ON public.profiles;
CREATE POLICY profiles_select_super_admin ON public.profiles
  FOR SELECT TO authenticated
  USING (public.is_user_super_admin(id));

COMMIT;

NOTIFY pgrst, 'reload schema';
