-- =============================================================
-- BUNDLE: Extend `profiles` with staff fields used by Manager dialog.
-- Resident-style staff info: department, job title, employee code,
-- active flag. Idempotent — safe to re-run.
-- =============================================================

BEGIN;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS department    TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS job_title     TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS employee_code TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT TRUE;

-- Allow Admin/staff_assignment owners to read all profile rows referenced
-- by their staff_assignments (so the Người dùng list can show full_name etc).
DROP POLICY IF EXISTS "profiles_select_via_staff_assignments" ON profiles;
CREATE POLICY "profiles_select_via_staff_assignments" ON profiles
  FOR SELECT USING (
    id IN (
      SELECT staff_id FROM staff_assignments
       WHERE user_id = auth.uid()
    )
  );

NOTIFY pgrst, 'reload schema';
COMMIT;
