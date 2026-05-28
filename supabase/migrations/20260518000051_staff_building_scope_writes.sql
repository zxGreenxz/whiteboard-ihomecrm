-- =============================================================
-- Staff building scope — thắt WRITE RLS theo tòa nhà được giao
--
-- Bối cảnh
-- ────────
-- Trước migration này, staff WRITE policies (`*_staff_insert/update/delete`
-- trong 20260510000006_staff_write_rls.sql) chỉ check role permission qua
-- `staff_can(table, action, owner)`. Không kiểm tra rằng row mà staff đang
-- ghi có nằm trong các tòa nhà staff được giao (`staff_assignments.building_id`)
-- hay không. Joey được tick 6 tòa nhưng vẫn có thể sửa hợp đồng/phương tiện
-- ở tòa khác miễn role có quyền.
--
-- Yêu cầu user (2026-05-18): với hợp đồng, khách hàng, phương tiện —
--   • SELECT mở cho mọi staff cùng owner (đã có sẵn ở
--     `*_select_staff`, không đổi).
--   • INSERT/UPDATE/DELETE phải nằm trong building scope của staff.
--
-- Cách làm
-- ────────
-- 1. RPC `get_my_assignments()` — SECURITY DEFINER, trả về (user_id, building_id)
--    của caller. FE dùng để biết cần ẩn nút action nào.
-- 2. Helper `staff_in_building(owner, building_id)` — true khi caller là
--    owner / admin / staff "tất cả tòa" / staff có row trùng building_id.
-- 3. Helper `customer_in_my_scope(owner, customer_id)` — customer không có
--    building_id trực tiếp; coi customer thuộc scope nếu ÍT NHẤT một hợp đồng
--    còn sống của khách nằm trong tòa caller quản lý. Khách chưa có hợp đồng
--    nào → fallback role permission (tránh khoá UC tạo khách mới).
-- 4. Replace `contracts_staff_*`, `vehicles_staff_*`, `customers_staff_*`
--    write policies để AND thêm building scope.
--
-- Idempotent.
-- =============================================================

BEGIN;

-- ── 1. RPC get_my_assignments ────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_my_assignments()
RETURNS TABLE (user_id uuid, building_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT sa.user_id, sa.building_id
  FROM public.staff_assignments sa
  WHERE sa.staff_id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.get_my_assignments()
  TO authenticated, anon, service_role;

-- ── 2. staff_in_building(owner, building_id) ─────────────────
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
    )
    OR (
      _building_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.staff_assignments
        WHERE staff_id = auth.uid()
          AND user_id = _owner
          AND building_id = _building_id
      )
    );
$$;

GRANT EXECUTE ON FUNCTION public.staff_in_building(uuid, uuid)
  TO authenticated, anon, service_role;

-- ── 3. customer_in_my_scope(owner, customer_id) ──────────────
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
    -- ÍT NHẤT một hợp đồng còn sống nằm ở tòa caller quản lý.
    OR EXISTS (
      SELECT 1
      FROM public.contract_customers cc
      JOIN public.contracts c ON c.id = cc.contract_id
      JOIN public.rooms r ON r.id = c.room_id
      JOIN public.staff_assignments sa
        ON sa.staff_id = auth.uid()
       AND sa.user_id = _owner
       AND sa.building_id = r.building_id
      WHERE cc.customer_id = _customer_id
        AND c.deleted_at IS NULL
    );
$$;

GRANT EXECUTE ON FUNCTION public.customer_in_my_scope(uuid, uuid)
  TO authenticated, anon, service_role;

-- ── 4. Replace contracts write policies ──────────────────────
DROP POLICY IF EXISTS contracts_staff_insert ON contracts;
DROP POLICY IF EXISTS contracts_staff_update ON contracts;
DROP POLICY IF EXISTS contracts_staff_delete ON contracts;

CREATE POLICY contracts_staff_insert ON contracts
  FOR INSERT TO authenticated
  WITH CHECK (
    public.staff_can('contracts', 'create', user_id)
    AND EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = contracts.room_id
        AND public.staff_in_building(contracts.user_id, r.building_id)
    )
  );

CREATE POLICY contracts_staff_update ON contracts
  FOR UPDATE TO authenticated
  USING (
    public.staff_can('contracts', 'edit', user_id)
    AND EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = contracts.room_id
        AND public.staff_in_building(contracts.user_id, r.building_id)
    )
  )
  WITH CHECK (
    public.staff_can('contracts', 'edit', user_id)
    AND EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = contracts.room_id
        AND public.staff_in_building(contracts.user_id, r.building_id)
    )
  );

CREATE POLICY contracts_staff_delete ON contracts
  FOR DELETE TO authenticated
  USING (
    public.staff_can('contracts', 'delete', user_id)
    AND EXISTS (
      SELECT 1 FROM rooms r
      WHERE r.id = contracts.room_id
        AND public.staff_in_building(contracts.user_id, r.building_id)
    )
  );

-- ── 5. Replace vehicles write policies (building_id trực tiếp) ─
DROP POLICY IF EXISTS vehicles_staff_insert ON vehicles;
DROP POLICY IF EXISTS vehicles_staff_update ON vehicles;
DROP POLICY IF EXISTS vehicles_staff_delete ON vehicles;

CREATE POLICY vehicles_staff_insert ON vehicles
  FOR INSERT TO authenticated
  WITH CHECK (
    public.staff_can('vehicles', 'create', user_id)
    AND public.staff_in_building(user_id, building_id)
  );

CREATE POLICY vehicles_staff_update ON vehicles
  FOR UPDATE TO authenticated
  USING (
    public.staff_can('vehicles', 'edit', user_id)
    AND public.staff_in_building(user_id, building_id)
  )
  WITH CHECK (
    public.staff_can('vehicles', 'edit', user_id)
    AND public.staff_in_building(user_id, building_id)
  );

CREATE POLICY vehicles_staff_delete ON vehicles
  FOR DELETE TO authenticated
  USING (
    public.staff_can('vehicles', 'delete', user_id)
    AND public.staff_in_building(user_id, building_id)
  );

-- ── 6. Replace customers write policies (qua contracts) ──────
DROP POLICY IF EXISTS customers_staff_insert ON customers;
DROP POLICY IF EXISTS customers_staff_update ON customers;
DROP POLICY IF EXISTS customers_staff_delete ON customers;

CREATE POLICY customers_staff_insert ON customers
  FOR INSERT TO authenticated
  WITH CHECK (public.staff_can('customers', 'create', user_id));

CREATE POLICY customers_staff_update ON customers
  FOR UPDATE TO authenticated
  USING (
    public.staff_can('customers', 'edit', user_id)
    AND public.customer_in_my_scope(user_id, id)
  )
  WITH CHECK (
    public.staff_can('customers', 'edit', user_id)
    AND public.customer_in_my_scope(user_id, id)
  );

CREATE POLICY customers_staff_delete ON customers
  FOR DELETE TO authenticated
  USING (
    public.staff_can('customers', 'delete', user_id)
    AND public.customer_in_my_scope(user_id, id)
  );

NOTIFY pgrst, 'reload schema';
COMMIT;
