-- =============================================================
-- Super Admin tier — global, cross-tenant bypass
--
-- Goal
-- ────
-- Add a tier ABOVE the regular tenant Admin (20260506000002):
--   • Tenant Admin: bypasses RLS within their own tenant only.
--   • Super Admin: bypasses RLS on EVERY table, EVERY tenant — even
--     across tenants. Designed for platform support / owner accounts.
--
-- Mechanism
-- ─────────
-- A simple denylist-style table `super_admins(user_id)`. The helper
-- `is_super_admin()` checks `auth.uid() ∈ super_admins`. A per-table
-- policy `<t>_super_admin_all FOR ALL` is added alongside the existing
-- per-table policies; Postgres OR-merges them, so the super admin
-- branch always passes regardless of any owner/staff/admin checks.
--
-- Bootstrap
-- ─────────
-- nguyentamca165@gmail.com (auth.uid 90450d5f-29b6-4897-bdef-cdb5fb53f339)
-- is seeded as the first super admin. Adding more later is just
-- INSERT INTO public.super_admins (user_id, note) VALUES (...).
--
-- Idempotent.
-- =============================================================

BEGIN;

-- ── 1. super_admins table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.super_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.super_admins TO authenticated;

-- ── 2. is_super_admin() helper ───────────────────────────────
-- SECURITY DEFINER so the SELECT inside the policy USING clauses
-- below does NOT recurse through super_admins' own RLS.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins WHERE user_id = auth.uid()
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, anon, service_role;

-- ── 3. RLS on super_admins itself ────────────────────────────
-- Only super admins can see / mutate this table.
DROP POLICY IF EXISTS "super_admins_select" ON public.super_admins;
CREATE POLICY "super_admins_select" ON public.super_admins
  FOR SELECT USING (public.is_super_admin());

DROP POLICY IF EXISTS "super_admins_modify" ON public.super_admins;
CREATE POLICY "super_admins_modify" ON public.super_admins
  FOR ALL
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- ── 4. Seed first super admin ────────────────────────────────
INSERT INTO public.super_admins (user_id, note)
SELECT id, 'Bootstrap super admin: ' || COALESCE(email, 'nguyentamca165@gmail.com')
FROM auth.users
WHERE email = 'nguyentamca165@gmail.com'
   OR id = '90450d5f-29b6-4897-bdef-cdb5fb53f339'
ON CONFLICT (user_id) DO NOTHING;

-- ── 5. Apply super-admin bypass on every RLS-enabled table ───
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'accounts','ai_api_keys','ai_conversations','ai_memory_embeddings','ai_messages','ai_usage_stats',
    'areas','asset_categories','asset_handovers','asset_maintenance','asset_movements','asset_warehouses','assets',
    'auto_debt_config','beds','building_services','buildings','code_sequences',
    'contract_customers','contract_extensions','contract_services','contract_tenants','contract_terminations','contract_transfers','contracts',
    'customers','departments','deposits','document_templates','excess_amounts','expenses','floors','hotlines',
    'income_expense_items','income_expense_templates','income_expense_types','income_expenses',
    'invoice_generation_settings','invoice_items','invoices',
    'issue_categories','issue_comments','issue_phase_history','issue_status_history','issues',
    'job_groups','job_types','lead_activities','leads','meter_readings','meters',
    'notification_logs','notification_templates','notifications','payments','phase_transitions',
    'profiles','roles','rooms','scheduled_jobs','service_quotas','services','settings',
    'signature_templates','sla_configs','staff_assignments','subscription_plans','suppliers',
    'task_flows','task_phases','task_types','tenants','user_roles','user_subscriptions','vehicles'
  ])
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r'
    ) THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_super_admin_all', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (public.is_super_admin()) WITH CHECK (public.is_super_admin())',
        t || '_super_admin_all', t
      );
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
