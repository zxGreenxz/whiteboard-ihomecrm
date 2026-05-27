-- =============================================
-- Phase 4: RBAC policies cho buildings/rooms/areas/floors/beds/building_services
-- =============================================
-- ADDITIVE: policy mới song song với policy cũ.
--
-- Quan hệ phân quyền:
--   areas: visible nếu super_admin/admin HOẶC có staff_assignments với building thuộc area (qua EXISTS).
--          Đơn giản hoá: nếu user có bất kỳ staff_assignments nào (full scope hoặc cho 1 building cụ thể
--          trong area) thì thấy area đó.
--   buildings: can_access_building(id)
--   floors: can_access_building(building_id)
--   rooms: can_access_building(building_id)
--   beds: can_access_building(room → building)
--   building_services: can_access_building(building_id)
-- =============================================

-- ─── AREAS ──────────────────────────────────────────────────────────────────
-- Visible nếu super_admin/admin HOẶC EXISTS staff_assignments where user can access at least
-- 1 building trong area (hoặc full scope).
CREATE POLICY areas_select_rbac ON public.areas
  FOR SELECT
  USING (
    public.is_super_admin()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid()
        AND (
          sa.building_id IS NULL
          OR EXISTS (
            SELECT 1 FROM public.buildings b
            WHERE b.id = sa.building_id AND b.area_id = areas.id
          )
        )
    )
  );

CREATE POLICY areas_insert_rbac ON public.areas
  FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL  -- chỉ user full-scope mới được tạo area mới
        AND (
          r.permissions @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((r.permissions -> 'areas' ->> 'create')::boolean, false) = true
        )
    )
  );

CREATE POLICY areas_update_rbac ON public.areas
  FOR UPDATE
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL
        AND (
          r.permissions @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((r.permissions -> 'areas' ->> 'edit')::boolean, false) = true
        )
    )
  )
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL
        AND (
          r.permissions @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((r.permissions -> 'areas' ->> 'edit')::boolean, false) = true
        )
    )
  );

CREATE POLICY areas_delete_rbac ON public.areas
  FOR DELETE
  USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL
        AND (
          r.permissions @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((r.permissions -> 'areas' ->> 'delete')::boolean, false) = true
        )
    )
  );

-- ─── BUILDINGS ──────────────────────────────────────────────────────────────
CREATE POLICY buildings_select_rbac ON public.buildings
  FOR SELECT
  USING (public.can_access_building(id));

CREATE POLICY buildings_insert_rbac ON public.buildings
  FOR INSERT
  WITH CHECK (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.staff_assignments sa
      JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND sa.building_id IS NULL  -- chỉ full-scope mới tạo building
        AND (
          r.permissions @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((r.permissions -> 'buildings' ->> 'create')::boolean, false) = true
        )
    )
  );

CREATE POLICY buildings_update_rbac ON public.buildings
  FOR UPDATE
  USING (public.can_do_on_building('buildings','edit', id))
  WITH CHECK (public.can_do_on_building('buildings','edit', id));

CREATE POLICY buildings_delete_rbac ON public.buildings
  FOR DELETE
  USING (public.can_do_on_building('buildings','delete', id));

-- ─── FLOORS ─────────────────────────────────────────────────────────────────
CREATE POLICY floors_select_rbac ON public.floors
  FOR SELECT
  USING (public.can_access_building(building_id));

CREATE POLICY floors_insert_rbac ON public.floors
  FOR INSERT
  WITH CHECK (public.can_do_on_building('buildings','create', building_id));

CREATE POLICY floors_update_rbac ON public.floors
  FOR UPDATE
  USING (public.can_do_on_building('buildings','edit', building_id))
  WITH CHECK (public.can_do_on_building('buildings','edit', building_id));

CREATE POLICY floors_delete_rbac ON public.floors
  FOR DELETE
  USING (public.can_do_on_building('buildings','delete', building_id));

-- ─── ROOMS ──────────────────────────────────────────────────────────────────
CREATE POLICY rooms_select_rbac ON public.rooms
  FOR SELECT
  USING (public.can_access_building(building_id));

CREATE POLICY rooms_insert_rbac ON public.rooms
  FOR INSERT
  WITH CHECK (public.can_do_on_building('rooms','create', building_id));

CREATE POLICY rooms_update_rbac ON public.rooms
  FOR UPDATE
  USING (public.can_do_on_building('rooms','edit', building_id))
  WITH CHECK (public.can_do_on_building('rooms','edit', building_id));

CREATE POLICY rooms_delete_rbac ON public.rooms
  FOR DELETE
  USING (public.can_do_on_building('rooms','delete', building_id));

-- ─── BEDS ───────────────────────────────────────────────────────────────────
CREATE POLICY beds_select_rbac ON public.beds
  FOR SELECT
  USING (public.can_access_building(
    (SELECT building_id FROM public.rooms WHERE id = beds.room_id)
  ));

CREATE POLICY beds_insert_rbac ON public.beds
  FOR INSERT
  WITH CHECK (public.can_do_on_building('beds','create',
    (SELECT building_id FROM public.rooms WHERE id = beds.room_id)
  ));

CREATE POLICY beds_update_rbac ON public.beds
  FOR UPDATE
  USING (public.can_do_on_building('beds','edit',
    (SELECT building_id FROM public.rooms WHERE id = beds.room_id)
  ))
  WITH CHECK (public.can_do_on_building('beds','edit',
    (SELECT building_id FROM public.rooms WHERE id = beds.room_id)
  ));

CREATE POLICY beds_delete_rbac ON public.beds
  FOR DELETE
  USING (public.can_do_on_building('beds','delete',
    (SELECT building_id FROM public.rooms WHERE id = beds.room_id)
  ));

-- ─── BUILDING_SERVICES ──────────────────────────────────────────────────────
CREATE POLICY building_services_select_rbac ON public.building_services
  FOR SELECT
  USING (public.can_access_building(building_id));

CREATE POLICY building_services_insert_rbac ON public.building_services
  FOR INSERT
  WITH CHECK (public.can_do_on_building('services','create', building_id));

CREATE POLICY building_services_update_rbac ON public.building_services
  FOR UPDATE
  USING (public.can_do_on_building('services','edit', building_id))
  WITH CHECK (public.can_do_on_building('services','edit', building_id));

CREATE POLICY building_services_delete_rbac ON public.building_services
  FOR DELETE
  USING (public.can_do_on_building('services','delete', building_id));

-- ─── TRIGGERS auto-fill user_id (cho các bảng có cột user_id) ───────────────
-- areas: có user_id NOT NULL
-- buildings: có user_id NOT NULL
-- floors: có user_id NOT NULL
-- rooms/beds/building_services: KHÔNG có user_id
CREATE TRIGGER areas_set_user_id_audit
  BEFORE INSERT ON public.areas
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

CREATE TRIGGER buildings_set_user_id_audit
  BEFORE INSERT ON public.buildings
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();

CREATE TRIGGER floors_set_user_id_audit
  BEFORE INSERT ON public.floors
  FOR EACH ROW EXECUTE FUNCTION public.set_user_id_from_auth();
