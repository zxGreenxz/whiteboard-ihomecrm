-- =============================================================
-- BUNDLE: Admin bypass — full-tenant god mode for users with
-- the Admin role.
--
-- Mirrors supabase/migrations/20260506000002_admin_bypass_rls.sql so
-- it can be applied directly via the Supabase SQL editor.
--
-- After this migration, any auth.uid() that has at least one
-- staff_assignments row pointing to a role marked
--   • permissions @> {"__superadmin": true}
--   • or name = 'Admin'
-- will pass RLS on every listed table for SELECT/INSERT/UPDATE/DELETE.
--
-- This adds an "OR admin" branch alongside the existing per-table
-- policies; it does NOT remove the per-row owner/staff policies.
-- Idempotent.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.is_admin()
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
      AND (
        r.permissions @> '{"__superadmin": true}'::jsonb
        OR r.name = 'Admin'
      )
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, anon, service_role;

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
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_admin_all', t);
      EXECUTE format(
        'CREATE POLICY %I ON %I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())',
        t || '_admin_all', t
      );
    END IF;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
COMMIT;
