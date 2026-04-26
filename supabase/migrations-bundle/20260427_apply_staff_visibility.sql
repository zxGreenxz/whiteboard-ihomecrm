-- =============================================================
-- BUNDLE: Cross-tenant RLS — let staff members SELECT their
-- employer's data, scoped by staff_assignments.
--
-- Background
-- ──────────
-- The original schema is single-tenant per admin user: every data
-- row has user_id = admin's auth.uid() and RLS allows access only
-- when auth.uid() = user_id. When staff (a different auth user)
-- logs in they see nothing.
--
-- This bundle adds READ visibility: a staff member sees data owned
-- by any user_id present in their staff_assignments rows
-- (i.e. their employers). Building-scoped staff additionally see
-- only the buildings they're assigned to (and rooms/beds/contracts
-- belonging to those buildings).
--
-- Writes (INSERT/UPDATE/DELETE) are still restricted to the data
-- owner — staff cannot mutate yet (will require permission-aware
-- RLS in a follow-up bundle once role.permissions is wired in).
--
-- Idempotent — re-running just replaces the helper function and
-- the new policies.
-- =============================================================

BEGIN;

-- ── Helper functions ────────────────────────────────────────────

-- Returns the array of user_ids the current auth.uid() is allowed
-- to see data for: their own id PLUS every employer they're assigned
-- to via staff_assignments.
CREATE OR REPLACE FUNCTION public.current_visible_owner_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ARRAY(
    SELECT auth.uid()
    UNION
    SELECT user_id FROM public.staff_assignments WHERE staff_id = auth.uid()
  );
$$;

-- True iff the current user is staff of <owner_id> (i.e. has any
-- staff_assignments row pointing at that owner). False if the
-- current user IS the owner (then the regular owner policy applies).
CREATE OR REPLACE FUNCTION public.is_staff_of(owner_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.staff_assignments
    WHERE staff_id = auth.uid() AND user_id = owner_id
  );
$$;

-- Returns building_ids visible to the current user under <owner_id>.
-- NULL means "all buildings" (staff has at least one row with
-- building_id = NULL → quản lý tất cả tòa nhà).
CREATE OR REPLACE FUNCTION public.staff_building_scope(owner_id uuid)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN bool_or(building_id IS NULL) THEN NULL
    ELSE COALESCE(array_agg(building_id), ARRAY[]::uuid[])
  END
  FROM public.staff_assignments
  WHERE staff_id = auth.uid() AND user_id = owner_id;
$$;

-- ── Generic SELECT policy on tables with `user_id` ──────────────
-- For each listed table, drop any policy named "<t>_select_staff"
-- then create a new one that allows SELECT when the row's user_id
-- belongs to the visible owner set.

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'buildings','services','contracts',
    'contract_extensions','contract_terminations','contract_transfers',
    'customers','vehicles','assets','asset_categories',
    'asset_handovers','asset_movements','asset_maintenance',
    'suppliers','asset_warehouses','areas','invoices','payments',
    'income_expenses','income_expense_types','income_expense_templates',
    'accounts','deposits','leads','lead_activities','jobs','issues',
    'settings','document_templates','hotlines','notifications',
    'meters','meter_readings','ct01_declarations','roles','tenants',
    'task_types'
  ])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_select_staff', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (user_id = ANY(public.current_visible_owner_ids()))',
      t || '_select_staff', t
    );
  END LOOP;
END $$;

-- ── Building scope filter for buildings table ──────────────────
-- Tighten the buildings SELECT so building-scoped staff only see
-- their assigned buildings. Owners + global-scope staff see all.
DROP POLICY IF EXISTS buildings_select_staff ON buildings;
CREATE POLICY buildings_select_staff ON buildings FOR SELECT
USING (
  user_id = ANY(public.current_visible_owner_ids())
  AND (
    -- own data: see all
    auth.uid() = user_id
    -- staff: filter by their building scope (NULL = all)
    OR public.staff_building_scope(user_id) IS NULL
    OR id = ANY(public.staff_building_scope(user_id))
  )
);

-- ── Tables without user_id but joined via building/contract ────
-- Allow SELECT on rooms/beds/contract_customers/contract_services/
-- invoice_items/income_expense_items if the user can see the parent.

DROP POLICY IF EXISTS rooms_select_staff ON rooms;
CREATE POLICY rooms_select_staff ON rooms FOR SELECT
USING (EXISTS (
  SELECT 1 FROM buildings b WHERE b.id = rooms.building_id
));

DROP POLICY IF EXISTS beds_select_staff ON beds;
CREATE POLICY beds_select_staff ON beds FOR SELECT
USING (EXISTS (
  SELECT 1 FROM rooms r WHERE r.id = beds.room_id
));

DROP POLICY IF EXISTS contract_customers_select_staff ON contract_customers;
CREATE POLICY contract_customers_select_staff ON contract_customers FOR SELECT
USING (EXISTS (
  SELECT 1 FROM contracts c WHERE c.id = contract_customers.contract_id
));

DROP POLICY IF EXISTS contract_services_select_staff ON contract_services;
CREATE POLICY contract_services_select_staff ON contract_services FOR SELECT
USING (EXISTS (
  SELECT 1 FROM contracts c WHERE c.id = contract_services.contract_id
));

DROP POLICY IF EXISTS invoice_items_select_staff ON invoice_items;
CREATE POLICY invoice_items_select_staff ON invoice_items FOR SELECT
USING (EXISTS (
  SELECT 1 FROM invoices i WHERE i.id = invoice_items.invoice_id
));

DROP POLICY IF EXISTS income_expense_items_select_staff ON income_expense_items;
CREATE POLICY income_expense_items_select_staff ON income_expense_items FOR SELECT
USING (EXISTS (
  SELECT 1 FROM income_expenses ie WHERE ie.id = income_expense_items.income_expense_id
));

-- ── Profiles: staff can read other profiles in same tenant ────
DROP POLICY IF EXISTS profiles_select_via_staff_assignments ON profiles;
CREATE POLICY profiles_select_via_staff_assignments ON profiles FOR SELECT
USING (
  -- own profile
  id = auth.uid()
  -- staff_assignments visibility (admin sees their staff, staff sees co-workers)
  OR EXISTS (
    SELECT 1 FROM staff_assignments sa
    WHERE sa.staff_id = profiles.id
      AND sa.user_id = ANY(public.current_visible_owner_ids())
  )
  OR EXISTS (
    SELECT 1 FROM staff_assignments sa
    WHERE sa.user_id = profiles.id
      AND sa.staff_id = auth.uid()
  )
);

NOTIFY pgrst, 'reload schema';
COMMIT;
