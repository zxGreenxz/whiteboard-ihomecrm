-- =============================================================================
-- Sprint 0.1 — Đóng lỗ hổng fail-open của get_my_permissions() + bản sao
-- ai_copilot_perms_for(). (AUTHORIZATION-PLAN.md §5.2, §17 Sprint 0 deliverable 1)
--
-- VẤN ĐỀ (P0): nhánh cuối "không staff/cổ đông/quản lý ⇒ __superadmin" giả định
-- "không có assignment = owner". Live có 2 auth user rơi vào nhánh này:
--   • demo.chunha (de6f33f3…)  — legacy owner THẬT (2 toà + 12 assignment) → GIỮ.
--   • phanboichauthcs@gmail.com (17602998…) — KHÔNG sở hữu gì, không staff/
--     cổ đông/owner, nhưng đang được cấp __superadmin toàn hệ → LỖ HỔNG.
--
-- CÁCH VÁ (fail closed, có bằng chứng owner tạm thời):
--   • Tạo legacy_owner_allowlist — "bằng chứng legacy owner" TẠM cho Sprint 0,
--     sẽ được thay bằng organizations/organization_memberships ở Sprint 1.
--   • Seed = user sở hữu ≥1 building HOẶC là user_id-owner của ≥1 staff_assignment
--     (⇒ bosshuy, demo.chunha, joey, nathan, nguyentamca165). phanboichauthcs
--     KHÔNG lọt danh sách → nhận '{}'.
--   • Nhánh cuối 2 hàm: chỉ trả __superadmin khi user nằm trong allowlist;
--     ngược lại trả '{}' (deny-by-default).
--
-- KHÔNG đổi hành vi cho super_admin / staff / cổ đông / quản lý.
-- Idempotent.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Bảng bằng chứng legacy owner (tạm Sprint 0)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.legacy_owner_allowlist (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.legacy_owner_allowlist ENABLE ROW LEVEL SECURITY;

-- Chỉ super admin ĐỌC; KHÔNG có policy write cho client roles → chỉ
-- migration/service_role sửa được (deny-by-default cho anon/authenticated).
DROP POLICY IF EXISTS legacy_owner_allowlist_select_super ON public.legacy_owner_allowlist;
CREATE POLICY legacy_owner_allowlist_select_super
  ON public.legacy_owner_allowlist FOR SELECT TO authenticated
  USING (public.is_super_admin());

REVOKE ALL   ON public.legacy_owner_allowlist FROM anon, authenticated;
GRANT  SELECT ON public.legacy_owner_allowlist TO authenticated;

-- Seed từ dữ liệu sở hữu thực tế (không suy đoán im lặng).
INSERT INTO public.legacy_owner_allowlist (user_id, note)
SELECT DISTINCT u.id, 'seed Sprint0: owns buildings or is owner of staff_assignments'
FROM auth.users u
WHERE EXISTS (SELECT 1 FROM public.buildings b        WHERE b.user_id  = u.id)
   OR EXISTS (SELECT 1 FROM public.staff_assignments sa WHERE sa.user_id = u.id)
ON CONFLICT (user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) get_my_permissions() — nhánh cuối fail closed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_permissions()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_caller         uuid := auth.uid();
  v_perms          jsonb;
  v_is_shareholder boolean;
  v_is_manager     boolean;
  -- Cổ đông / quản lý lợi nhuận: CHỈ trang Phân bổ & chia lợi nhuận.
  v_sh_perms       jsonb := jsonb_build_object(
    'shareholder_profit', jsonb_build_object('view', true)
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
  v_is_manager := EXISTS (
    SELECT 1 FROM public.profit_managers
    WHERE auth_user_id = v_caller AND deleted_at IS NULL
  );

  IF v_is_shareholder OR v_is_manager THEN
    IF v_perms IS NULL THEN
      RETURN v_sh_perms;          -- cổ đông THUẦN: đúng 1 quyền
    END IF;
    RETURN v_sh_perms || v_perms; -- kiêm nhân viên: quyền staff + cửa trang LN
  END IF;

  -- Owner thật: CHỈ khi có bằng chứng legacy owner (allowlist tạm Sprint 0).
  -- Orphan (không staff/cổ đông/quản lý/owner) ⇒ FAIL CLOSED, KHÔNG sentinel.
  IF v_perms IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.legacy_owner_allowlist WHERE user_id = v_caller) THEN
      RETURN '{"__superadmin": true}'::jsonb;
    END IF;
    RETURN '{}'::jsonb;
  END IF;

  RETURN v_perms;
END
$function$;

-- ---------------------------------------------------------------------------
-- 3) ai_copilot_perms_for() — BẢN SAO, phải vá cùng lúc (comment gốc cảnh báo)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ai_copilot_perms_for(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_perms jsonb;
  v_is_shareholder boolean;
  v_is_manager boolean;
  v_sh_perms jsonb := jsonb_build_object('shareholder_profit', jsonb_build_object('view', true));
BEGIN
  IF p_user IS NULL THEN RETURN '{}'::jsonb; END IF;

  IF EXISTS (SELECT 1 FROM public.super_admins WHERE user_id = p_user) THEN
    RETURN '{"__superadmin": true}'::jsonb;
  END IF;

  SELECT COALESCE(sa.permissions, r.permissions) INTO v_perms
  FROM public.staff_assignments sa
  JOIN public.roles r ON r.id = sa.role_id
  WHERE sa.staff_id = p_user AND sa.user_id <> p_user
  ORDER BY (sa.building_id IS NULL) DESC, sa.created_at ASC
  LIMIT 1;

  v_is_shareholder := EXISTS (SELECT 1 FROM public.shareholders   WHERE auth_user_id = p_user AND deleted_at IS NULL);
  v_is_manager     := EXISTS (SELECT 1 FROM public.profit_managers WHERE auth_user_id = p_user AND deleted_at IS NULL);

  IF v_is_shareholder OR v_is_manager THEN
    IF v_perms IS NULL THEN RETURN v_sh_perms; END IF;
    RETURN v_sh_perms || v_perms;
  END IF;

  -- FAIL CLOSED giống get_my_permissions: orphan ⇒ '{}'.
  IF v_perms IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.legacy_owner_allowlist WHERE user_id = p_user) THEN
      RETURN '{"__superadmin": true}'::jsonb;
    END IF;
    RETURN '{}'::jsonb;
  END IF;
  RETURN v_perms;
END $function$;

COMMIT;

-- =============================================================================
-- ROLLBACK (nếu cần khôi phục hành vi fail-open cũ — KHÔNG khuyến nghị):
--   thay 2 nhánh cuối bằng `IF v_perms IS NULL THEN RETURN '{"__superadmin": true}'`
--   và (tuỳ chọn) DROP TABLE public.legacy_owner_allowlist.
-- =============================================================================
