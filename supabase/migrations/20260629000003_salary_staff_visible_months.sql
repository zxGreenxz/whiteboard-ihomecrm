-- Salary: per-month visibility for the staff self-view.
--
-- Admin controls which months the employee self-view shows, stored in
-- salary_bonus_rules.rules->'staffMonths' as { 'YYYY-MM': boolean } overrides.
-- Default (no override) = "lag by one month until settled": show the previous
-- month until it is LOCKED (chốt lương), then advance to the current month.
--
-- Staff cannot read salary_bonus_rules (owner-only RLS), so expose ONLY the
-- overrides map (not the reward amounts) through a SECURITY DEFINER accessor.
-- All month logic lives in the TS layer (shared by staff compute + admin UI);
-- this function is just a guarded read of the overrides jsonb.

CREATE OR REPLACE FUNCTION public.salary_staff_months()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT COALESCE(
    (SELECT rules -> 'staffMonths' FROM public.salary_bonus_rules LIMIT 1),
    '{}'::jsonb
  );
$$;

REVOKE ALL ON FUNCTION public.salary_staff_months() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.salary_staff_months() FROM anon;
GRANT EXECUTE ON FUNCTION public.salary_staff_months() TO authenticated;
