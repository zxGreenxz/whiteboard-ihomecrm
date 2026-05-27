-- =============================================
-- Phase 1: RBAC helper functions (additive, không động policy nào)
-- =============================================
-- Mục tiêu: thêm helpers để các policy mới (phase 2-5) gọi vào.
-- Behavior không đổi (chưa attach vào policy nào).
--
-- Naming convention:
--   can_access_building(building_id)            : true nếu caller có quyền XEM building (qua super_admin / admin / staff_assignment).
--   can_do_on_building(table, action, building) : true nếu caller có quyền {action} trên {table} cho building cụ thể.
--   building_of_*(entity_id)                    : trả về building_id liên quan tới entity, dùng cho RLS traversal.
--
-- Quan hệ với helpers cũ (KHÔNG động):
--   is_super_admin(), is_admin(), staff_can(table, action, owner), staff_in_building(owner, building_id), current_visible_owner_ids()
--   → Helpers cũ phụ thuộc `_owner` (multi-tenant). Helpers mới chỉ dùng `_building_id` (pure RBAC).
-- =============================================

-- can_access_building --------------------------------------------------------
-- True nếu caller có thể xem building_id. Dùng cho SELECT policy.
-- Super admin / admin: pass. Staff: pass nếu có staff_assignments row với building_id NULL (full scope) hoặc trùng _building_id.
CREATE OR REPLACE FUNCTION public.can_access_building(_building_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_admin()
    OR public.is_admin()
    OR EXISTS (
      SELECT 1
      FROM public.staff_assignments sa
      WHERE sa.staff_id = auth.uid()
        AND (sa.building_id IS NULL OR sa.building_id = _building_id)
    );
$$;

COMMENT ON FUNCTION public.can_access_building(uuid) IS
  'RBAC: true nếu caller có thể XEM data thuộc building này (super_admin / admin / staff_assignment phù hợp). Dùng trong RLS SELECT.';

-- can_do_on_building ---------------------------------------------------------
-- True nếu caller có quyền action ({create,edit,delete,view,...}) trên table cho building cụ thể.
-- Check qua roles.permissions JSONB: {table: {action: true}} hoặc role 'Admin' hoặc __superadmin.
CREATE OR REPLACE FUNCTION public.can_do_on_building(_table text, _action text, _building_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.staff_assignments sa
      JOIN public.roles r ON r.id = sa.role_id
      WHERE sa.staff_id = auth.uid()
        AND (sa.building_id IS NULL OR sa.building_id = _building_id)
        AND (
             r.permissions @> '{"__superadmin": true}'::jsonb
          OR r.name = 'Admin'
          OR COALESCE((r.permissions -> _table ->> _action)::boolean, false) = true
        )
    );
$$;

COMMENT ON FUNCTION public.can_do_on_building(text, text, uuid) IS
  'RBAC: true nếu caller có quyền {action} trên {table} cho building này. Dùng trong RLS INSERT/UPDATE/DELETE.';

-- building_of_contract -------------------------------------------------------
CREATE OR REPLACE FUNCTION public.building_of_contract(_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.building_id
  FROM public.contracts c
  JOIN public.rooms r ON r.id = c.room_id
  WHERE c.id = _id;
$$;

COMMENT ON FUNCTION public.building_of_contract(uuid) IS
  'Trả về building_id của contract qua chain contract → room → building.';

-- building_of_invoice --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.building_of_invoice(_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT building_id FROM public.invoices WHERE id = _id;
$$;

COMMENT ON FUNCTION public.building_of_invoice(uuid) IS
  'Trả về building_id của invoice (cột trực tiếp).';

-- building_of_payment --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.building_of_payment(_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT i.building_id
  FROM public.payments p
  JOIN public.invoices i ON i.id = p.invoice_id
  WHERE p.id = _id;
$$;

COMMENT ON FUNCTION public.building_of_payment(uuid) IS
  'Trả về building_id của payment qua chain payment → invoice → building.';
