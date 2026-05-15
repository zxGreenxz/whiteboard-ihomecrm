-- =============================================================
-- BUNDLE: delete_staff_member RPC + cleanup orphan auth.users
-- caused by the old "xoá staff_assignments only" UI behaviour.
--
-- See migrations/20260502000002_delete_staff_member_rpc.sql
-- for rationale.
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

  DELETE FROM auth.users WHERE id = p_staff_id;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_staff_member(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_staff_member(uuid) TO authenticated;

-- ── One-shot cleanup: drop synthetic-email auth users that have
--    NO staff_assignments row (i.e. orphans created by old flow
--    where the trash icon only deleted assignments). Only synthetic
--    placeholder accounts are safe to nuke since real human users
--    have a real email.
DELETE FROM auth.users u
WHERE u.email LIKE '%@%.ihomecrm.local'
  AND NOT EXISTS (SELECT 1 FROM public.staff_assignments sa WHERE sa.staff_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM public.staff_assignments sa WHERE sa.user_id  = u.id);

NOTIFY pgrst, 'reload schema';
COMMIT;
