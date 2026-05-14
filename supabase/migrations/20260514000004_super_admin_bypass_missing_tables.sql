-- =============================================================
-- Super Admin bypass — catch-up for tables created/missed AFTER
-- 20260506000003_super_admin_tier.sql
--
-- Why
-- ───
-- The original super-admin migration applied `<t>_super_admin_all`
-- policies to a hard-coded list of tables that existed at that
-- point in time. Several tables were either:
--   • Created later (income_expense_batches, income_expense_batch_items)
--   • Missing from the original list (ct01_declarations, jobs,
--     service_quota_tiers)
-- ⇒ Super admin (nguyentamca165@gmail.com) cannot see/edit/delete
--   rows owned by other users in those tables.
--
-- This migration adds the same FOR ALL bypass policy used by all
-- other tables. Postgres OR-merges policies, so the existing
-- owner/staff checks remain untouched.
--
-- Note: `income_expense_types` is intentionally NOT here — it has
-- a permissive `authenticated_all` policy from 20260511000002.
-- `super_admins` itself is also excluded (it has bespoke policies).
--
-- Idempotent.
-- =============================================================

BEGIN;

DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'ct01_declarations',
    'income_expense_batches',
    'income_expense_batch_items',
    'jobs',
    'service_quota_tiers'
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
