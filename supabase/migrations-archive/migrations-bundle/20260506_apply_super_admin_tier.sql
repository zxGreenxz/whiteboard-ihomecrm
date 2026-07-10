-- =============================================================
-- BUNDLE: Super Admin tier — global cross-tenant bypass.
--
-- Mirrors supabase/migrations/20260506000003_super_admin_tier.sql so
-- it can be applied directly via the Supabase SQL editor.
--
-- Adds:
--   • public.super_admins (user_id PK)
--   • is_super_admin() SECURITY DEFINER helper
--   • RLS on super_admins (only super admins can read/mutate)
--   • Bootstrap row for nguyentamca165@gmail.com
--   • Per-table <t>_super_admin_all policies on every RLS table
--
-- Idempotent.
-- =============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.super_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.super_admins TO authenticated;

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

DROP POLICY IF EXISTS "super_admins_select" ON public.super_admins;
CREATE POLICY "super_admins_select" ON public.super_admins
  FOR SELECT USING (public.is_super_admin());

DROP POLICY IF EXISTS "super_admins_modify" ON public.super_admins;
CREATE POLICY "super_admins_modify" ON public.super_admins
  FOR ALL
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

INSERT INTO public.super_admins (user_id, note)
SELECT id, 'Bootstrap super admin: ' || COALESCE(email, 'nguyentamca165@gmail.com')
FROM auth.users
WHERE email = 'nguyentamca165@gmail.com'
   OR id = '90450d5f-29b6-4897-bdef-cdb5fb53f339'
ON CONFLICT (user_id) DO NOTHING;

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
