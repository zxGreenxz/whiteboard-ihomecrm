-- =============================================
-- Migration: RPC get_my_permissions() — staff đọc được permissions của role mình
-- Created: 2026-05-25
-- Description:
--   RLS của staff_assignments chỉ cho owner đọc → staff không thể tự query
--   roles.permissions để gate UI. Tạo RPC SECURITY DEFINER trả về JSONB
--   permissions của role mà caller đang được gán. Owner & super admin: trả
--   sentinel { "__superadmin": true } → mọi quyền true ở FE.
-- =============================================

CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller   UUID := auth.uid();
  v_is_super BOOLEAN := FALSE;
  v_perms    JSONB;
BEGIN
  IF v_caller IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  SELECT EXISTS (SELECT 1 FROM super_admins WHERE user_id = v_caller)
    INTO v_is_super;
  IF v_is_super THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  -- Staff: lấy permissions từ role gắn với staff_assignment đầu tiên.
  SELECT r.permissions
  INTO v_perms
  FROM staff_assignments sa
  JOIN roles r ON r.id = sa.role_id
  WHERE sa.staff_id = v_caller
    AND sa.user_id <> v_caller
  LIMIT 1;

  IF v_perms IS NULL THEN
    -- Owner (không phải staff của ai) — toàn quyền với dữ liệu của chính mình.
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  RETURN v_perms;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_permissions() TO authenticated, anon;
