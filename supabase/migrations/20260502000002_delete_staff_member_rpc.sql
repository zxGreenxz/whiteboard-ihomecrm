-- =============================================================
-- Single source of truth for "xoá nhân viên": auth.users.
--
-- Why
-- ───
-- Trash-icon in /settings/staff used to DELETE only from
-- staff_assignments. The auth.users + profiles rows survived,
-- so:
--   • the deleted username could still log in
--   • the username slot stayed reserved (re-creating with the
--     same name failed with "đã được sử dụng")
--   • the row reappeared if anyone re-inserted into
--     staff_assignments
--
-- Fix
-- ───
-- One RPC that DELETEs from auth.users. The existing CASCADE
-- FKs on profiles + staff_assignments + roles wipe the rest.
-- Authorization: caller must currently manage the target staff
-- (have a staff_assignments row with user_id = auth.uid()).
-- Self-delete is blocked.
-- =============================================================

BEGIN;

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

  -- Cascade clears profiles + staff_assignments + any user-owned data
  -- whose FK references auth.users with ON DELETE CASCADE.
  DELETE FROM auth.users WHERE id = p_staff_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_staff_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_staff_member(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
