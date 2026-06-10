-- =============================================================
-- Phạm vi nhân viên theo KHU VỰC (LIVE) — staff_assignments.area_id
--
-- Ngữ nghĩa row staff_assignments sau migration này:
--   • building_id NOT NULL, area_id NULL  → scope toà lẻ (snapshot, như cũ)
--   • building_id NULL,     area_id NOT NULL → scope NHÓM (live): toà
--     thêm/bớt khỏi khu → quyền nhân viên tự đổi theo (resolve qua
--     area_buildings tại thời điểm query, không snapshot)
--   • cả hai NULL → full scope (tất cả toà, như cũ)
--   • cả hai NOT NULL → cấm (CHECK)
--
-- ⚠ HAZARD trọng yếu: mọi helper cũ coi `building_id IS NULL` = full
-- scope. Row nhóm mới cũng có building_id NULL → nếu không sửa helper
-- ĐỒNG THỜI trong file này, gán 1 khu sẽ vô tình cấp full quyền.
-- Mọi chỗ test full-scope phải thành (building_id IS NULL AND area_id IS NULL).
-- =============================================================

BEGIN;

-- ── 1. Cột area_id + ràng buộc ───────────────────────────────
ALTER TABLE public.staff_assignments
  ADD COLUMN IF NOT EXISTS area_id UUID REFERENCES public.areas(id) ON DELETE RESTRICT;

COMMENT ON COLUMN public.staff_assignments.area_id IS
'Scope theo khu vực (LIVE): NULL = không dùng; NOT NULL = nhân viên có quyền trên MỌI toà thuộc khu này tại thời điểm query (area_buildings). RESTRICT: không xoá khu đang được dùng làm phạm vi.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'staff_assignments_building_xor_area'
      AND conrelid = 'public.staff_assignments'::regclass
  ) THEN
    ALTER TABLE public.staff_assignments
      ADD CONSTRAINT staff_assignments_building_xor_area
      CHECK (building_id IS NULL OR area_id IS NULL);
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS staff_assignments_unique_staff_area
  ON public.staff_assignments(staff_id, area_id) WHERE area_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_assignments_area_id
  ON public.staff_assignments(area_id);

-- ── 2. can_access_building: thêm nhánh scope nhóm (live) ─────
-- Base: 20260603000002 (giữ nguyên nhánh cổ đông).
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
        AND (
          (sa.building_id IS NULL AND sa.area_id IS NULL)   -- full scope
          OR sa.building_id = _building_id                  -- toà lẻ
          OR (sa.area_id IS NOT NULL AND EXISTS (           -- nhóm LIVE
                SELECT 1 FROM public.area_buildings ab
                WHERE ab.area_id = sa.area_id
                  AND ab.building_id = _building_id
             ))
        )
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

-- ── 3. can_do_on_building: cùng pattern 3 nhánh ──────────────
-- Base: 20260529000001.
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
        AND (
          (sa.building_id IS NULL AND sa.area_id IS NULL)
          OR sa.building_id = _building_id
          OR (sa.area_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.area_buildings ab
                WHERE ab.area_id = sa.area_id
                  AND ab.building_id = _building_id
             ))
        )
        AND COALESCE(
              (COALESCE(sa.permissions, r.permissions) -> _table ->> _action)::boolean,
              false
            ) = true
    )
$$;

-- ── 4. staff_in_building: thêm nhánh nhóm (giữ check _owner) ─
-- Base: 20260518000051.
CREATE OR REPLACE FUNCTION public.staff_in_building(
  _owner uuid,
  _building_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() = _owner
    OR public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments
      WHERE staff_id = auth.uid()
        AND user_id = _owner
        AND building_id IS NULL
        AND area_id IS NULL
    )
    OR (
      _building_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.staff_assignments
        WHERE staff_id = auth.uid()
          AND user_id = _owner
          AND building_id = _building_id
      )
    )
    OR (
      _building_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM public.staff_assignments sa
        JOIN public.area_buildings ab ON ab.area_id = sa.area_id
        WHERE sa.staff_id = auth.uid()
          AND sa.user_id = _owner
          AND ab.building_id = _building_id
      )
    );
$$;

-- ── 5. customer_in_my_scope: nhánh hợp đồng theo toà → thêm nhóm ─
-- Base: 20260518000051.
CREATE OR REPLACE FUNCTION public.customer_in_my_scope(
  _owner uuid,
  _customer_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    auth.uid() = _owner
    OR public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments
      WHERE staff_id = auth.uid()
        AND user_id = _owner
        AND building_id IS NULL
        AND area_id IS NULL
    )
    -- Khách chưa có hợp đồng còn sống → không có building để check,
    -- để staff có quyền role 'customers.edit' vẫn quản lý được.
    OR NOT EXISTS (
      SELECT 1
      FROM public.contract_customers cc
      JOIN public.contracts c ON c.id = cc.contract_id
      WHERE cc.customer_id = _customer_id
        AND c.deleted_at IS NULL
    )
    -- ÍT NHẤT một hợp đồng còn sống nằm ở toà caller quản lý
    -- (toà lẻ trực tiếp HOẶC toà thuộc khu được gán — live).
    OR EXISTS (
      SELECT 1
      FROM public.contract_customers cc
      JOIN public.contracts c ON c.id = cc.contract_id
      JOIN public.rooms r ON r.id = c.room_id
      JOIN public.staff_assignments sa
        ON sa.staff_id = auth.uid()
       AND sa.user_id = _owner
       AND (
         sa.building_id = r.building_id
         OR (sa.area_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM public.area_buildings ab
               WHERE ab.area_id = sa.area_id
                 AND ab.building_id = r.building_id
            ))
       )
      WHERE cc.customer_id = _customer_id
        AND c.deleted_at IS NULL
    );
$$;

-- ── 6. get_my_permissions: ưu tiên row full-scope THẬT ───────
-- Base: 20260603000002 (giữ nguyên nhánh cổ đông). Chỉ đổi ORDER BY.
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

  -- Staff: lấy permissions từ assignment đầu tiên (full-scope THẬT ưu tiên —
  -- row area_id NOT NULL là scope nhóm, không phải full scope)
  SELECT COALESCE(sa.permissions, r.permissions)
    INTO v_perms
  FROM public.staff_assignments sa
  JOIN public.roles r ON r.id = sa.role_id
  WHERE sa.staff_id = v_caller AND sa.user_id <> v_caller
  ORDER BY (sa.building_id IS NULL AND sa.area_id IS NULL) DESC, sa.created_at ASC
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

-- ── 7. get_my_assignments: BUNG row nhóm thành building_id cụ thể ─
-- Giữ contract FE (useMyBuildingScope): building_id NULL = tất cả toà.
-- Row nhóm được expand qua area_buildings → FE không cần đổi gì.
CREATE OR REPLACE FUNCTION public.get_my_assignments()
RETURNS TABLE (user_id uuid, building_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- Row toà lẻ + row full-scope thật (building_id NULL, area_id NULL)
  SELECT sa.user_id, sa.building_id
  FROM public.staff_assignments sa
  WHERE sa.staff_id = auth.uid()
    AND sa.area_id IS NULL
  UNION
  -- Row nhóm: bung LIVE thành các building_id thuộc khu
  SELECT sa.user_id, ab.building_id
  FROM public.staff_assignments sa
  JOIN public.area_buildings ab ON ab.area_id = sa.area_id
  WHERE sa.staff_id = auth.uid()
    AND sa.area_id IS NOT NULL;
$$;

-- ── 8. Policies có inline test full-scope ────────────────────
-- Drop & recreate với (building_id IS NULL AND area_id IS NULL),
-- đồng thời đổi r.permissions → COALESCE(sa.permissions, r.permissions)
-- cho khớp convention per-staff override (20260529000001).

DROP POLICY IF EXISTS areas_select_rbac ON public.areas;
CREATE POLICY areas_select_rbac ON public.areas
  FOR SELECT
  USING (
    public.is_super_admin()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid()
        AND (
          (sa.building_id IS NULL AND sa.area_id IS NULL)   -- full scope
          OR sa.area_id = areas.id                          -- được gán đúng khu này
          OR EXISTS (                                       -- có toà lẻ thuộc khu
            SELECT 1 FROM public.area_buildings ab
            WHERE ab.area_id = areas.id AND ab.building_id = sa.building_id
          )
        )
    )
  );

DROP POLICY IF EXISTS areas_insert_rbac ON public.areas;
CREATE POLICY areas_insert_rbac ON public.areas
  FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL AND sa.area_id IS NULL  -- chỉ full-scope thật
        AND (
          COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((COALESCE(sa.permissions, r.permissions) -> 'areas' ->> 'create')::boolean, false) = true
        )
    )
  );

DROP POLICY IF EXISTS areas_update_rbac ON public.areas;
CREATE POLICY areas_update_rbac ON public.areas
  FOR UPDATE
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL AND sa.area_id IS NULL
        AND (
          COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((COALESCE(sa.permissions, r.permissions) -> 'areas' ->> 'edit')::boolean, false) = true
        )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL AND sa.area_id IS NULL
        AND (
          COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((COALESCE(sa.permissions, r.permissions) -> 'areas' ->> 'edit')::boolean, false) = true
        )
    )
  );

DROP POLICY IF EXISTS areas_delete_rbac ON public.areas;
CREATE POLICY areas_delete_rbac ON public.areas
  FOR DELETE
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL AND sa.area_id IS NULL
        AND (
          COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((COALESCE(sa.permissions, r.permissions) -> 'areas' ->> 'delete')::boolean, false) = true
        )
    )
  );

DROP POLICY IF EXISTS buildings_insert_rbac ON public.buildings;
CREATE POLICY buildings_insert_rbac ON public.buildings
  FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL AND sa.area_id IS NULL  -- chỉ full-scope thật mới tạo toà
        AND (
          COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((COALESCE(sa.permissions, r.permissions) -> 'buildings' ->> 'create')::boolean, false) = true
        )
    )
  );

-- Siết write policy của area_buildings (file 20260611100000 tạo bản v1)
DROP POLICY IF EXISTS area_buildings_write_rbac ON public.area_buildings;
CREATE POLICY area_buildings_write_rbac ON public.area_buildings
  FOR ALL
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL AND sa.area_id IS NULL
        AND (
          COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((COALESCE(sa.permissions, r.permissions) -> 'areas' ->> 'edit')::boolean, false) = true
        )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      LEFT JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL AND sa.area_id IS NULL
        AND (
          COALESCE(sa.permissions, r.permissions) @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((COALESCE(sa.permissions, r.permissions) -> 'areas' ->> 'edit')::boolean, false) = true
        )
    )
  );

-- ── 9. Guard: chặn soft-delete khu đang dùng làm phạm vi ─────
-- Lý do: get_my_permissions trả {__superadmin} khi user có 0 row
-- staff_assignments → nếu xoá khu kéo theo row scope cuối của 1 staff
-- thì staff đó bị NÂNG QUYỀN nhầm thành owner. Chặn là default an toàn.
-- (Hard delete đã có ON DELETE RESTRICT; trigger này lo đường soft-delete.)
CREATE OR REPLACE FUNCTION public.areas_block_soft_delete_in_scope()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM public.staff_assignments WHERE area_id = NEW.id) THEN
    RAISE EXCEPTION 'AREA_IN_STAFF_SCOPE'
      USING HINT = 'Khu vực đang được dùng làm phạm vi phân quyền nhân viên — gỡ phân quyền trước khi xoá.';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS areas_guard_soft_delete ON public.areas;
CREATE TRIGGER areas_guard_soft_delete
  BEFORE UPDATE OF deleted_at ON public.areas
  FOR EACH ROW EXECUTE FUNCTION public.areas_block_soft_delete_in_scope();

COMMIT;

NOTIFY pgrst, 'reload schema';
