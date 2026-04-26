-- =============================================================
-- BUNDLE: Admin super-view + creator-owns-data model.
--
-- Decision
-- ────────
-- Original direction (route staff writes → employer's user_id) was
-- wrong. The correct model is:
--   • Whoever creates a row owns it (user_id = creator's auth.uid())
--   • Each user sees their OWN rows
--   • Admin (employer) ALSO sees rows owned by anyone who works
--     for them via staff_assignments
--   • Staff still see shared infrastructure owned by admin
--     (buildings, rooms, etc.) because admin's uid is in their
--     visible_owner_ids set via staff_assignments.
--
-- This bundle simply re-defines `current_visible_owner_ids()` to
-- be bidirectional:
--   - own uid
--   - + every employer of mine (staff → admin)
--   - + every staff member that works for me (admin → staff)
--
-- After this:
--   admin: visible_owner_ids = [admin] ∪ [Joey, ...]   ← sees Joey's vouchers
--   Joey:  visible_owner_ids = [Joey] ∪ [admin]         ← sees admin's buildings
--
-- No backfill needed — existing rows keep their creator owner.
-- All existing SELECT policies (added in 20260427_apply_staff_visibility.sql)
-- already use this function and start working bidirectionally as
-- soon as it's updated.
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
  SELECT ARRAY(
    -- always self
    SELECT auth.uid()
    UNION
    -- if I'm a staff: my employers (so I see their shared infra)
    SELECT user_id FROM public.staff_assignments WHERE staff_id = auth.uid()
    UNION
    -- if I'm an employer: my staff (admin super-view of staff data)
    SELECT staff_id FROM public.staff_assignments WHERE user_id = auth.uid()
  );
$$;

NOTIFY pgrst, 'reload schema';
COMMIT;
