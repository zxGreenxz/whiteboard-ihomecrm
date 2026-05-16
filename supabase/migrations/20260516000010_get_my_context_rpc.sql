-- =============================================
-- Migration: get_my_context() RPC
-- Created: 2026-05-16
-- Description:
--   Hook FE useMyContext không SELECT được staff_assignments của chính
--   caller vì RLS chỉ cho owner đọc (auth.uid() = user_id). Tạo RPC
--   SECURITY DEFINER trả về { is_super, is_staff, owner_id } cho caller.
-- =============================================

CREATE OR REPLACE FUNCTION public.get_my_context()
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $BODY$
DECLARE
  v_caller   UUID := auth.uid();
  v_is_super BOOLEAN := FALSE;
  v_owner    UUID;
BEGIN
  IF v_caller IS NULL THEN
    RETURN json_build_object(
      'is_super', false,
      'is_staff', false,
      'owner_id', NULL
    );
  END IF;

  SELECT EXISTS (SELECT 1 FROM super_admins WHERE user_id = v_caller)
    INTO v_is_super;

  IF v_is_super THEN
    RETURN json_build_object(
      'is_super', true,
      'is_staff', false,
      'owner_id', v_caller
    );
  END IF;

  SELECT sa.user_id INTO v_owner
  FROM staff_assignments sa
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  LIMIT 1;

  IF v_owner IS NOT NULL THEN
    RETURN json_build_object(
      'is_super', false,
      'is_staff', true,
      'owner_id', v_owner
    );
  END IF;

  RETURN json_build_object(
    'is_super', false,
    'is_staff', false,
    'owner_id', v_caller
  );
END;
$BODY$;

GRANT EXECUTE ON FUNCTION public.get_my_context() TO authenticated, anon;

COMMENT ON FUNCTION public.get_my_context() IS
  'Phân loại caller hiện tại: is_super / is_staff / owner_id. SECURITY DEFINER để bypass RLS của staff_assignments.';
