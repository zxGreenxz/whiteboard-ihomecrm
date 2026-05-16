-- =============================================
-- Migration: get_my_context() trả thêm default_area_id cho staff
-- Created: 2026-05-16
-- Description:
--   Staff được FE auto-lock vào "khu vực phụ trách" — mặc định lấy area
--   có name khớp (case-insensitive) với username của staff (phần trước
--   @ trong email). Owner & super admin: default_area_id = NULL.
-- =============================================

CREATE OR REPLACE FUNCTION public.get_my_context()
RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $BODY$
DECLARE
  v_caller          UUID := auth.uid();
  v_is_super        BOOLEAN := FALSE;
  v_owner           UUID;
  v_username        TEXT;
  v_default_area_id UUID;
BEGIN
  IF v_caller IS NULL THEN
    RETURN json_build_object(
      'is_super', false, 'is_staff', false,
      'owner_id', NULL, 'default_area_id', NULL
    );
  END IF;

  SELECT EXISTS (SELECT 1 FROM super_admins WHERE user_id = v_caller)
    INTO v_is_super;

  IF v_is_super THEN
    RETURN json_build_object(
      'is_super', true, 'is_staff', false,
      'owner_id', v_caller, 'default_area_id', NULL
    );
  END IF;

  SELECT sa.user_id INTO v_owner
  FROM staff_assignments sa
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  LIMIT 1;

  IF v_owner IS NOT NULL THEN
    -- Lấy username của staff từ auth.users (raw_user_meta_data.username
    -- hoặc phần local của email).
    SELECT COALESCE(
      LOWER(NULLIF(raw_user_meta_data ->> 'username', '')),
      LOWER(SPLIT_PART(email, '@', 1))
    )
    INTO v_username
    FROM auth.users
    WHERE id = v_caller;

    IF v_username IS NOT NULL AND length(v_username) > 0 THEN
      SELECT a.id INTO v_default_area_id
      FROM areas a
      WHERE a.user_id = v_owner
        AND a.deleted_at IS NULL
        AND LOWER(a.name) = v_username
      LIMIT 1;
    END IF;

    RETURN json_build_object(
      'is_super', false, 'is_staff', true,
      'owner_id', v_owner, 'default_area_id', v_default_area_id
    );
  END IF;

  RETURN json_build_object(
    'is_super', false, 'is_staff', false,
    'owner_id', v_caller, 'default_area_id', NULL
  );
END;
$BODY$;

GRANT EXECUTE ON FUNCTION public.get_my_context() TO authenticated, anon;
