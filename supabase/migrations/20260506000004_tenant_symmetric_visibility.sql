-- =============================================================
-- Tenant-symmetric visibility + close accounts_with_balance leak
--
-- Problem
-- ───────
-- 1. `current_visible_owner_ids()` returns only:
--      • self
--      • my employers (rows where staff_id = me)
--      • my staff (rows where user_id = me)
--    A regular staff (e.g. Joey, Manager under nguyentamca) therefore
--    cannot see *co-staff* data (e.g. cashbooks owned by Hiệp, who is
--    also a staff under nguyentamca). The income-expense form's
--    "Sổ quỹ" dropdown queries `accounts` directly with RLS, so the
--    list comes back empty for Joey even though those cashbooks
--    belong to the same tenant.
--
-- 2. The `accounts_with_balance` view was created without
--    `security_invoker = true`. PG runs it as the view owner →
--    bypasses RLS on `accounts`. That's why the cashbook list
--    page shows rows the underlying RLS would have hidden — papering
--    over the visibility gap, but also leaking across tenants.
--
-- Fix
-- ───
-- (a) Extend the helper so a staff member sees every co-staff sharing
--     at least one employer. After the patch, both same-page reads
--     (table) and view reads return the same tenant-scoped set.
-- (b) Flip `accounts_with_balance` to `security_invoker = true` so
--     it honors the underlying RLS. The cashbook list page will keep
--     working because the broadened helper now grants the right rows.
--
-- Idempotent.
-- =============================================================

BEGIN;

-- ── (a) tenant-symmetric helper ───────────────────────────────
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
    -- self
    SELECT auth.uid()
    UNION
    -- my employers (employers I'm staff under)
    SELECT user_id FROM my_employers
    UNION
    -- my own staff (any one who has me as their employer)
    SELECT staff_id FROM public.staff_assignments
      WHERE user_id = auth.uid()
    UNION
    -- co-staff: anyone who works under the same employers as me
    SELECT staff_id FROM public.staff_assignments
      WHERE user_id IN (SELECT user_id FROM my_employers)
  );
$$;

-- ── (b) view honors RLS ───────────────────────────────────────
ALTER VIEW public.accounts_with_balance SET (security_invoker = true);

NOTIFY pgrst, 'reload schema';
COMMIT;
