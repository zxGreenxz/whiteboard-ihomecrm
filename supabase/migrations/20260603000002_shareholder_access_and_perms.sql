-- =============================================
-- Migration: Cổ đông — quyền tự động (read-only) + scope truy cập theo tòa được gán
-- Mục tiêu:
--   1) get_my_permissions(): cổ đông (shareholders.auth_user_id = caller) nhận BỘ
--      QUYỀN CHỈ-XEM cố định (tránh lỗ hổng "không staff → superadmin bypass").
--      Nếu cổ đông đồng thời là staff → merge: giữ quyền staff + thêm
--      shareholder_profit:view + personal_finance.
--   2) can_access_building(): cổ đông được SELECT đúng các tòa họ có cổ phần
--      (building_shareholders) → chỉ thấy dữ liệu tòa của mình, không thấy toàn bộ.
-- =============================================

BEGIN;

-- 1) can_access_building: thêm nhánh cổ đông (chỉ đọc tòa được gán) -----------
CREATE OR REPLACE FUNCTION public.can_access_building(_building_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT
    public.is_super_admin()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid()
        AND (sa.building_id IS NULL OR sa.building_id = _building_id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.building_shareholders bs
      JOIN public.shareholders s ON s.id = bs.shareholder_id
      WHERE s.auth_user_id = auth.uid()
        AND s.deleted_at IS NULL
        AND bs.building_id = _building_id
    );
$function$;

-- 2) get_my_permissions: nhánh cổ đông (read-only) ---------------------------
CREATE OR REPLACE FUNCTION public.get_my_permissions()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_caller        uuid := auth.uid();
  v_perms         jsonb;
  v_is_shareholder boolean;
  v_sh_perms      jsonb := jsonb_build_object(
    'dashboard',           jsonb_build_object('view', true),
    'notifications',       jsonb_build_object('view', true),
    'buildings',           jsonb_build_object('view', true),
    'rooms',               jsonb_build_object('view', true),
    'services',            jsonb_build_object('view', true),
    'leads',               jsonb_build_object('view', true),
    'deposits',            jsonb_build_object('view', true),
    'contracts',           jsonb_build_object('view', true),
    'customers',           jsonb_build_object('view', true),
    'vehicles',            jsonb_build_object('view', true),
    'cashbooks',           jsonb_build_object('view', true),
    'invoices',            jsonb_build_object('view', true),
    'income_expenses',     jsonb_build_object('view', true),
    'meter_readings',      jsonb_build_object('view', true),
    'assets',              jsonb_build_object('view', true),
    'tasks',               jsonb_build_object('view', true),
    'reports_real_estate', jsonb_build_object('view', true),
    'reports_finance',     jsonb_build_object('view', true),
    'shareholder_profit',  jsonb_build_object('view', true),
    'personal_finance',    jsonb_build_object('view', true, 'create', true, 'edit', true, 'delete', true)
  );
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

  v_is_shareholder := EXISTS (
    SELECT 1 FROM public.shareholders
    WHERE auth_user_id = v_caller AND deleted_at IS NULL
  );

  -- Cổ đông: thêm/giữ quyền chỉ-xem.
  -- merge `v_sh_perms || v_perms` → key của staff GHI ĐÈ base (giữ quyền cao
  -- hơn của staff cho module trùng); shareholder_profit/personal_finance chỉ có
  -- ở base nên luôn được giữ.
  IF v_is_shareholder THEN
    IF v_perms IS NULL THEN
      RETURN v_sh_perms;
    END IF;
    RETURN v_sh_perms || v_perms;
  END IF;

  -- Owner thật (không staff, không cổ đông) → bypass (giữ hành vi cũ)
  IF v_perms IS NULL THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  RETURN v_perms;
END
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
