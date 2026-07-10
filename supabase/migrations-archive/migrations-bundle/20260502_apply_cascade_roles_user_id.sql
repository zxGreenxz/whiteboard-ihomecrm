-- =============================================================
-- BUNDLE: Force CASCADE on roles.user_id + harden RPC.
-- See migrations/20260502000003_cascade_roles_user_id.sql.
-- =============================================================

BEGIN;

ALTER TABLE public.roles
  DROP CONSTRAINT IF EXISTS roles_user_id_fkey;

ALTER TABLE public.roles
  ADD CONSTRAINT roles_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE OR REPLACE FUNCTION public.delete_staff_member(p_staff_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, auth
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  IF p_staff_id = auth.uid() THEN
    RAISE EXCEPTION 'Không thể tự xoá tài khoản của chính bạn' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.staff_assignments
    WHERE staff_id = p_staff_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền xoá nhân viên này' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.roles WHERE user_id = p_staff_id;
  DELETE FROM auth.users WHERE id = p_staff_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
