-- =============================================================
-- BUNDLE: Tenant-symmetric visibility + close accounts_with_balance leak.
--
-- Mirrors supabase/migrations/20260506000004_tenant_symmetric_visibility.sql
-- so it can be applied directly via the Supabase SQL editor.
--
-- Symptom this fixes
-- ──────────────────
-- Staff member (e.g. Joey, Manager under nguyentamca) opens the
-- "Thu chi" → Thêm phiếu form: the "Sổ quỹ" dropdown is empty even
-- though the same user can see those cashbooks on the Sổ quỹ list
-- page. Cause: the list page reads the `accounts_with_balance` view
-- which used to bypass RLS, while the dropdown reads `accounts`
-- directly under RLS. The RLS visibility helper didn't include
-- co-staff (peer staff sharing the same employer), so cashbooks
-- created by another staff in the same tenant were filtered out.
--
-- Fix
-- ───
-- (a) Extend `current_visible_owner_ids()` so a staff sees data of
--     every co-staff sharing at least one employer.
-- (b) ALTER VIEW accounts_with_balance SET (security_invoker = true)
--     so the view honors RLS and the two pages return the same set.
--
-- Idempotent.
-- =============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.current_visible_owner_ids()
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH my_employers AS (
    SELECT user_id
    FROM public.staff_assignments
    WHERE staff_id = auth.uid()
  )
  SELECT ARRAY(
    SELECT auth.uid()
    UNION
    SELECT user_id FROM my_employers
    UNION
    SELECT staff_id FROM public.staff_assignments
      WHERE user_id = auth.uid()
    UNION
    SELECT staff_id FROM public.staff_assignments
      WHERE user_id IN (SELECT user_id FROM my_employers)
  );
$$;

ALTER VIEW public.accounts_with_balance SET (security_invoker = true);

NOTIFY pgrst, 'reload schema';
COMMIT;
