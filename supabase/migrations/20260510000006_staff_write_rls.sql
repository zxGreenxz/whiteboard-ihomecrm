-- =============================================
-- Staff write access — let employer's staff edit/insert/delete tenant data
-- =============================================
-- Problem
-- ───────
-- _select_staff policies were added across tenant tables so a Manager/Staff
-- can READ employer's data, but writes still required `auth.uid() = user_id`.
-- Result: a Manager hits "Lưu" on a building, the UPDATE matches 0 rows under
-- RLS, PostgREST returns PGRST116/406 ("Cannot coerce to single JSON object"),
-- and the UI shows a generic error. Same issue blocks rooms/services/etc.
--
-- Approach
-- ────────
-- New helper `public.staff_can(_table, _action, _owner)` returns true when the
-- caller has a staff_assignments row pointing at `_owner` whose role grants
-- the specified action (`edit | view | create | delete`) on the table key.
-- Role permissions live in `roles.permissions` jsonb, e.g.:
--   { "buildings": { "edit": true, "create": true, ... }, ... }
-- The Admin / __superadmin shortcut is preserved (they bypass via is_admin()
-- policies in 20260506000002).
--
-- Then per-table CUD policies use staff_can() for the action, plus
-- `staff_building_scope(user_id)` for tables that have a building scope.
--
-- Re-running drops & recreates idempotently.
-- =============================================

BEGIN;

-- ── 1. staff_can(table, action, owner) helper ────────────────────────
CREATE OR REPLACE FUNCTION public.staff_can(
  _table text,
  _action text,
  _owner uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.staff_assignments sa
    JOIN public.roles r ON r.id = sa.role_id
    WHERE sa.staff_id = auth.uid()
      AND sa.user_id = _owner
      AND (
        -- role-level admin shortcut
        r.permissions @> '{"__superadmin": true}'::jsonb
        OR r.name = 'Admin'
        -- explicit per-table permission flag
        OR COALESCE((r.permissions -> _table ->> _action)::boolean, false) = true
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.staff_can(text, text, uuid)
  TO authenticated, anon, service_role;

-- ── 2. Tables keyed directly by user_id ──────────────────────────────
-- For each table, allow staff INSERT/UPDATE/DELETE when staff_can(...)
-- matches against the row's user_id. WITH CHECK also enforces the same
-- guard so staff can't move a row to another owner.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT *
    FROM (VALUES
      ('buildings',           'buildings'),
      ('floors',              'building_layout'),
      ('areas',               'areas'),
      ('hotlines',            'hotline'),
      ('contracts',           'contracts'),
      ('contract_extensions', 'contracts'),
      ('contract_terminations','contracts'),
      ('contract_transfers',  'contracts'),
      ('deposits',            'deposits'),
      ('invoices',            'invoices'),
      ('payments',            'invoices'),
      ('excess_amounts',      'excess_amounts'),
      ('income_expenses',     'income_expenses'),
      ('income_expense_types','income_expenses'),
      ('income_expense_templates','income_expenses'),
      ('meters',              'meters'),
      ('meter_readings',      'meter_readings'),
      ('services',            'services'),
      ('service_quotas',      'service_quotas'),
      ('customers',           'customers'),
      ('tenants',             'customers'),
      ('leads',               'leads'),
      ('lead_activities',     'leads'),
      ('issues',              'tasks'),
      ('issue_comments',      'tasks'),
      ('jobs',                'tasks'),
      ('job_groups',          'tasks'),
      ('job_types',           'task_types'),
      ('task_flows',          'tasks'),
      ('task_types',          'task_types'),
      ('vehicles',            'vehicles'),
      ('assets',              'assets'),
      ('asset_categories',    'asset_types'),
      ('asset_handovers',     'assets'),
      ('asset_maintenance',   'assets'),
      ('asset_movements',     'assets'),
      ('asset_warehouses',    'warehouses'),
      ('suppliers',           'suppliers'),
      ('document_templates',  'templates'),
      ('settings',            'settings'),
      ('accounts',            'cashbooks'),
      ('auto_debt_config',    'auto_debt'),
      ('notifications',       'notifications')
    ) AS v(tbl, perm_key)
  LOOP
    -- skip if table doesn't exist (defensive)
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = r.tbl AND c.relkind = 'r'
    ) THEN
      CONTINUE;
    END IF;

    -- INSERT
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.tbl || '_staff_insert', r.tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO authenticated '
      'WITH CHECK (public.staff_can(%L, %L, user_id))',
      r.tbl || '_staff_insert', r.tbl, r.perm_key, 'create'
    );

    -- UPDATE
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.tbl || '_staff_update', r.tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO authenticated '
      'USING (public.staff_can(%L, %L, user_id)) '
      'WITH CHECK (public.staff_can(%L, %L, user_id))',
      r.tbl || '_staff_update', r.tbl, r.perm_key, 'edit', r.perm_key, 'edit'
    );

    -- DELETE
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', r.tbl || '_staff_delete', r.tbl);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE TO authenticated '
      'USING (public.staff_can(%L, %L, user_id))',
      r.tbl || '_staff_delete', r.tbl, r.perm_key, 'delete'
    );
  END LOOP;
END $$;

-- ── 3. Junction / nested tables (no user_id) ─────────────────────────
-- Mirror via parent. Each policy looks up the owning user via FK.

-- rooms → buildings.user_id (rooms has no user_id, only building_id)
DROP POLICY IF EXISTS rooms_staff_write ON rooms;
CREATE POLICY rooms_staff_write ON rooms
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM buildings b
    WHERE b.id = rooms.building_id
      AND public.staff_can('rooms', 'edit', b.user_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM buildings b
    WHERE b.id = rooms.building_id
      AND public.staff_can('rooms', 'edit', b.user_id)
  ));

-- beds → rooms.building_id → buildings.user_id (no user_id, no building_id)
DROP POLICY IF EXISTS beds_staff_write ON beds;
CREATE POLICY beds_staff_write ON beds
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM rooms r
    JOIN buildings b ON b.id = r.building_id
    WHERE r.id = beds.room_id
      AND public.staff_can('beds', 'edit', b.user_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM rooms r
    JOIN buildings b ON b.id = r.building_id
    WHERE r.id = beds.room_id
      AND public.staff_can('beds', 'edit', b.user_id)
  ));

-- building_services → buildings.user_id
DROP POLICY IF EXISTS building_services_staff_write ON building_services;
CREATE POLICY building_services_staff_write ON building_services
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM buildings b
    WHERE b.id = building_services.building_id
      AND public.staff_can('buildings', 'edit', b.user_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM buildings b
    WHERE b.id = building_services.building_id
      AND public.staff_can('buildings', 'edit', b.user_id)
  ));

-- contract_services → contracts.user_id
DROP POLICY IF EXISTS contract_services_staff_write ON contract_services;
CREATE POLICY contract_services_staff_write ON contract_services
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM contracts c
    WHERE c.id = contract_services.contract_id
      AND public.staff_can('contracts', 'edit', c.user_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM contracts c
    WHERE c.id = contract_services.contract_id
      AND public.staff_can('contracts', 'edit', c.user_id)
  ));

-- contract_customers / contract_tenants → contracts.user_id
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY['contract_customers','contract_tenants']) LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_staff_write', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL TO authenticated '
        'USING (EXISTS (SELECT 1 FROM contracts c WHERE c.id = %I.contract_id AND public.staff_can(%L, %L, c.user_id))) '
        'WITH CHECK (EXISTS (SELECT 1 FROM contracts c WHERE c.id = %I.contract_id AND public.staff_can(%L, %L, c.user_id)))',
        t || '_staff_write', t, t, 'contracts', 'edit', t, 'contracts', 'edit'
      );
    END IF;
  END LOOP;
END $$;

-- invoice_items → invoices.user_id
DROP POLICY IF EXISTS invoice_items_staff_write ON invoice_items;
CREATE POLICY invoice_items_staff_write ON invoice_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = invoice_items.invoice_id
      AND public.staff_can('invoices', 'edit', i.user_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM invoices i
    WHERE i.id = invoice_items.invoice_id
      AND public.staff_can('invoices', 'edit', i.user_id)
  ));

-- income_expense_items → income_expenses.user_id
DROP POLICY IF EXISTS income_expense_items_staff_write ON income_expense_items;
CREATE POLICY income_expense_items_staff_write ON income_expense_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND public.staff_can('income_expenses', 'edit', ie.user_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM income_expenses ie
    WHERE ie.id = income_expense_items.income_expense_id
      AND public.staff_can('income_expenses', 'edit', ie.user_id)
  ));

NOTIFY pgrst, 'reload schema';
COMMIT;
