-- =============================================================
-- Quyền "Mọi toà nhà" cho Thu chi  (income_expenses.all_buildings)
--
-- Bối cảnh
-- ────────
-- Nhân viên bị giới hạn theo toà quản lý (staff_assignments.building_id):
--   - buildings/rooms SELECT  = can_access_building()      → chỉ thấy toà quản lý
--   - income_expenses write   = can_do_on_building()       → chỉ ghi cho toà quản lý
-- Owner/admin/super thấy & ghi mọi toà (qua *_admin_all / *_super_admin_all).
--
-- Yêu cầu: cấp riêng cho 1 số nhân viên (vd kế toán) khả năng XEM + GHI phiếu
-- thu chi cho MỌI toà của chủ, CHỈ trong phạm vi module Thu chi. Toà/phòng ở
-- các module khác (hợp đồng, cư dân, hoá đơn...) VẪN khoá theo toà quản lý.
--
-- Cơ chế
-- ──────
--   - Cờ quyền nằm trong JSONB permissions (role hoặc per-staff):
--       {"income_expenses": {"all_buildings": true}}
--   - 2 helper SECURITY DEFINER:
--       ie_all_buildings_scope(building)        → cho SELECT (cờ all_buildings + building thuộc owner của caller)
--       can_ie_all_buildings(action, building)  → cho WRITE  (như trên + có quyền {action})
--   - Policy ADDITIVE trên income_expenses + income_expense_items (OR với RBAC cũ).
--     INSERT…RETURNING ⇒ cần cả SELECT policy, nên thêm SELECT all_buildings.
--   - 2 RPC SECURITY DEFINER cấp dữ liệu cho DROPDOWN của form thu chi:
--       ie_form_buildings()  → toà (kèm cờ managed để xếp lên đầu)
--       ie_form_rooms(b)     → phòng của 1 toà (hoặc tất cả nếu NULL)
--     Hai RPC này KHÔNG đụng buildings_select_rbac / rooms_select_rbac ⇒ phạm vi
--     "thấy mọi toà" gói gọn trong form thu chi, đúng yêu cầu.
--
-- Idempotent.
-- =============================================================

BEGIN;

-- ── 1) Helper đọc: caller là staff có quyền all_buildings & building thuộc owner của họ
CREATE OR REPLACE FUNCTION public.ie_all_buildings_scope(_building_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_assignments sa
    LEFT JOIN public.roles r ON r.id = sa.role_id
    JOIN public.buildings b ON b.user_id = sa.user_id
    WHERE sa.staff_id = auth.uid()
      AND b.id = _building_id
      AND COALESCE(
            (COALESCE(sa.permissions, r.permissions) -> 'income_expenses' ->> 'all_buildings')::boolean,
            false) = true
  );
$$;

COMMENT ON FUNCTION public.ie_all_buildings_scope(uuid) IS
  'True nếu caller là staff có quyền income_expenses.all_buildings và building thuộc owner của họ. Dùng cho SELECT thu chi xuyên toà.';

-- ── 2) Helper ghi: như (1) + có quyền {action} trên income_expenses
CREATE OR REPLACE FUNCTION public.can_ie_all_buildings(_action text, _building_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_assignments sa
    LEFT JOIN public.roles r ON r.id = sa.role_id
    JOIN public.buildings b ON b.user_id = sa.user_id
    WHERE sa.staff_id = auth.uid()
      AND b.id = _building_id
      AND COALESCE((COALESCE(sa.permissions, r.permissions) -> 'income_expenses' ->> 'all_buildings')::boolean, false) = true
      AND COALESCE((COALESCE(sa.permissions, r.permissions) -> 'income_expenses' ->> _action)::boolean, false) = true
  );
$$;

COMMENT ON FUNCTION public.can_ie_all_buildings(text, uuid) IS
  'True nếu caller có quyền all_buildings + quyền {action} (create/edit/delete) trên income_expenses cho building thuộc owner của họ. Dùng cho INSERT/UPDATE/DELETE thu chi xuyên toà.';

-- ── 3) Policy ADDITIVE trên income_expenses ─────────────────────────────────
DROP POLICY IF EXISTS income_expenses_select_all_buildings ON public.income_expenses;
CREATE POLICY income_expenses_select_all_buildings ON public.income_expenses
  FOR SELECT
  USING (building_id IS NOT NULL AND public.ie_all_buildings_scope(building_id));

DROP POLICY IF EXISTS income_expenses_insert_all_buildings ON public.income_expenses;
CREATE POLICY income_expenses_insert_all_buildings ON public.income_expenses
  FOR INSERT
  WITH CHECK (building_id IS NOT NULL AND public.can_ie_all_buildings('create', building_id));

DROP POLICY IF EXISTS income_expenses_update_all_buildings ON public.income_expenses;
CREATE POLICY income_expenses_update_all_buildings ON public.income_expenses
  FOR UPDATE
  USING (building_id IS NOT NULL AND public.can_ie_all_buildings('edit', building_id))
  WITH CHECK (building_id IS NOT NULL AND public.can_ie_all_buildings('edit', building_id));

DROP POLICY IF EXISTS income_expenses_delete_all_buildings ON public.income_expenses;
CREATE POLICY income_expenses_delete_all_buildings ON public.income_expenses
  FOR DELETE
  USING (building_id IS NOT NULL AND public.can_ie_all_buildings('delete', building_id));

-- ── 4) Policy ADDITIVE trên income_expense_items (traverse parent voucher) ───
DROP POLICY IF EXISTS income_expense_items_select_all_buildings ON public.income_expense_items;
CREATE POLICY income_expense_items_select_all_buildings ON public.income_expense_items
  FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND public.ie_all_buildings_scope(ie.building_id)
  ));

DROP POLICY IF EXISTS income_expense_items_insert_all_buildings ON public.income_expense_items;
CREATE POLICY income_expense_items_insert_all_buildings ON public.income_expense_items
  FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND public.can_ie_all_buildings('create', ie.building_id)
  ));

DROP POLICY IF EXISTS income_expense_items_update_all_buildings ON public.income_expense_items;
CREATE POLICY income_expense_items_update_all_buildings ON public.income_expense_items
  FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND public.can_ie_all_buildings('edit', ie.building_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND public.can_ie_all_buildings('edit', ie.building_id)
  ));

DROP POLICY IF EXISTS income_expense_items_delete_all_buildings ON public.income_expense_items;
CREATE POLICY income_expense_items_delete_all_buildings ON public.income_expense_items
  FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND ie.building_id IS NOT NULL
      AND public.can_ie_all_buildings('delete', ie.building_id)
  ));

-- ── 5) RPC cấp danh sách TOÀ cho dropdown form thu chi ──────────────────────
-- Mặc định = toà quản lý (can_access_building). Có quyền all_buildings → thêm
-- mọi toà của owner. Cờ managed = toà thuộc quyền quản lý (FE xếp lên đầu).
-- Điều kiện hiển thị KHỚP với quyền ghi: managed (can_access_building) HOẶC
-- mở rộng all_buildings cho ĐÚNG owner sở hữu toà (ie_all_buildings_scope —
-- per-owner). Tránh lộ tên toà của owner khác với staff đa-owner mà chỉ có
-- quyền all_buildings ở 1 owner. Đối xứng với ie_form_rooms.
CREATE OR REPLACE FUNCTION public.ie_form_buildings()
RETURNS TABLE(id uuid, name text, code text, is_virtual boolean, user_id uuid, managed boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT b.id, b.name, b.code, b.is_virtual, b.user_id,
         public.can_access_building(b.id) AS managed
  FROM public.buildings b
  WHERE b.deleted_at IS NULL
    AND (
      public.can_access_building(b.id)
      OR public.ie_all_buildings_scope(b.id)
    );
$$;

COMMENT ON FUNCTION public.ie_form_buildings() IS
  'Danh sách toà cho dropdown form Thu chi. Mặc định = toà quản lý; có quyền income_expenses.all_buildings → thêm mọi toà của owner. Cờ managed = toà thuộc quyền quản lý (xếp lên đầu).';

-- ── 6) RPC cấp danh sách PHÒNG cho dropdown form thu chi ────────────────────
-- _building_id NULL → mọi phòng caller được chọn (dùng cho ô nhập nhanh).
CREATE OR REPLACE FUNCTION public.ie_form_rooms(_building_id uuid DEFAULT NULL)
RETURNS SETOF public.rooms
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT r.*
  FROM public.rooms r
  WHERE r.deleted_at IS NULL
    AND (_building_id IS NULL OR r.building_id = _building_id)
    AND (
      public.can_access_building(r.building_id)
      OR public.ie_all_buildings_scope(r.building_id)
    );
$$;

COMMENT ON FUNCTION public.ie_form_rooms(uuid) IS
  'Danh sách phòng cho dropdown form Thu chi. Toà quản lý (can_access_building) hoặc toà mở rộng qua quyền all_buildings (ie_all_buildings_scope).';

-- ── 7) Grants: chỉ authenticated được gọi 2 RPC (revoke anon/public) ─────────
REVOKE ALL ON FUNCTION public.ie_form_buildings()    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ie_form_rooms(uuid)    FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ie_form_buildings() TO authenticated;
GRANT EXECUTE ON FUNCTION public.ie_form_rooms(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
