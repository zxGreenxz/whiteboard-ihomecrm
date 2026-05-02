-- =============================================================
-- Force CASCADE on roles.user_id and harden delete_staff_member.
--
-- Why
-- ───
-- Migration 20250101000008 declared
--   user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
-- but the live DB FK has NO CASCADE (created before that migration
-- was applied, or rebuilt without the action). Result: deleting an
-- auth user that ever created a role fails with
--   "violates foreign key constraint roles_user_id_fkey on table roles".
--
-- Same FK shape exists everywhere in the schema — but roles is the
-- one we hit first because every admin owns at least one role.
--
-- Fix
-- ───
-- 1. Drop+re-add roles_user_id_fkey with ON DELETE CASCADE.
-- 2. Belt-and-suspenders: have delete_staff_member also DELETE the
--    target's roles upfront, so even if a future env loses CASCADE
--    we don't fail silently.
--
-- Idempotent.
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

  -- Defensive: drop any role/data the target owns so we don't trip
  -- on a non-cascading FK in older envs.
  DELETE FROM public.roles WHERE user_id = p_staff_id;

  DELETE FROM auth.users WHERE id = p_staff_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
