-- Migration: Per-staff permission overrides
-- - Add column staff_assignments.permissions (JSONB) — snapshot độc lập per staff
-- - Update get_my_permissions() RPC: ưu tiên sa.permissions over role.permissions
-- - Update can_do_on_building() helper: COALESCE(sa.permissions, r.permissions)
-- - Update can_access_org_entity() helper: tương tự
--
-- Mục đích: cho phép owner cài quyền cho từng nhân viên cụ thể (thêm/bớt từng
-- module-action) sau khi áp template, không cần tạo role riêng.

-- 1. Add permissions column (nullable, fallback role.permissions if NULL)
ALTER TABLE public.staff_assignments
  ADD COLUMN IF NOT EXISTS permissions jsonb;

COMMENT ON COLUMN public.staff_assignments.permissions IS
'Per-staff permission snapshot. Copy từ role.permissions khi áp template (Tier 1), rồi tick/untick độc lập (Tier 2). NULL = chưa override, RPC fallback role.permissions.';

-- 2. GIN index cho query JSONB (rare, nhưng đề phòng admin query)
CREATE INDEX IF NOT EXISTS idx_staff_assignments_permissions
  ON public.staff_assignments USING gin (permissions);

-- 3. RPC get_my_permissions() — ưu tiên sa.permissions
CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public, auth
AS $$
DECLARE
  v_caller uuid := auth.uid();
  v_perms  jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  -- Super admin bypass
  IF EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = v_caller) THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  -- Staff: lấy permissions từ assignment đầu tiên (full-scope ưu tiên)
  SELECT COALESCE(sa.permissions, r.permissions)
    INTO v_perms
  FROM public.staff_assignments sa
  JOIN public.roles r ON r.id = sa.role_id
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  ORDER BY (sa.building_id IS NULL) DESC, sa.created_at ASC
  LIMIT 1;

  -- Owner thật (không có staff_assignments) → bypass
  IF v_perms IS NULL THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  RETURN v_perms;
END
$$;

COMMENT ON FUNCTION public.get_my_permissions() IS
'Trả permissions JSONB của caller hiện tại. Ưu tiên staff_assignments.permissions (override per-staff), fallback roles.permissions. Super_admin và owner thật trả sentinel {__superadmin:true}.';

-- 4. Helper can_do_on_building — check qua COALESCE(sa.permissions, r.permissions)
CREATE OR REPLACE FUNCTION public.can_do_on_building(
  _table       text,
  _action      text,
  _building_id uuid
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth
AS $$
  SELECT
    public.is_super_admin()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND (sa.building_id IS NULL OR sa.building_id = _building_id)
        AND COALESCE(
              (COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean,
              false
            ) = true
    )
$$;

COMMENT ON FUNCTION public.can_do_on_building(text, text, uuid) IS
'True nếu caller có quyền (table, action) trên building cụ thể. Ưu tiên staff_assignments.permissions override, fallback roles.permissions.';

-- 5. Helper can_access_org_entity — tương tự, không scope building
CREATE OR REPLACE FUNCTION public.can_access_org_entity(
  _resource text,
  _action   text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth
AS $$
  SELECT
    public.is_super_admin()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND COALESCE(
              (COALESCE(sa.permissions, r.permissions) -> _resource ->> _action)::boolean,
              false
            ) = true
    )
$$;

COMMENT ON FUNCTION public.can_access_org_entity(text, text) IS
'True nếu caller có quyền (resource, action) trên entity global (không gắn building). Ưu tiên staff_assignments.permissions override.';
