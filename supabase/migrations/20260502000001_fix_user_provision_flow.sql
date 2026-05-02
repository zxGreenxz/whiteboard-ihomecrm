-- =============================================================
-- Fix user provisioning flow
--
-- Problems addressed
-- ─────────────────
--   1. Trigger handle_new_user copied auth.users.email (synthetic
--      "<slug>@username.ihomecrm.local") into profiles.email,
--      which then leaked into the UI as if it were a real email.
--   2. Admin couldn't write profile/extended fields when creating
--      or editing staff because profiles RLS only allowed
--      auth.uid() = id; the client-side upsert in useProvisionStaff
--      silently failed.
--   3. Extended profile columns (department, job_title, employee_code,
--      is_active) were referenced by the UI but never had a guaranteed
--      migration in the main migrations/ directory.
--   4. Legacy create_profile_for_new_user() function from
--      migration 008 still existed even though replaced.
--
-- Fixes
-- ─────
--   • Add extended profile columns (idempotent).
--   • Rewrite handle_new_user to:
--       - read full_name/phone/email/department/job_title/employee_code/is_active
--         from raw_user_meta_data
--       - drop synthetic emails (anything ending in @*.ihomecrm.local)
--       - validate phone format → NULL if it doesn't match
--       - safe ON CONFLICT (id) DO NOTHING (re-runs from re-signup harmless)
--   • Add admin UPDATE/INSERT policies on profiles so the user who
--     manages a staff (via staff_assignments.user_id = auth.uid()) can
--     edit that staff's profile.
--   • Backfill existing rows: clear synthetic emails in profiles.email.
--   • Drop the legacy create_profile_for_new_user() function.
--
-- Idempotent.
-- =============================================================

BEGIN;

-- ── 1. Extended profile columns ─────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS department    TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS job_title     TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS employee_code TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT TRUE;

-- ── 2. Trigger handle_new_user — read from raw_user_meta_data,
--      filter synthetic emails ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_full_name TEXT;
  v_phone     TEXT;
  v_email     TEXT;
BEGIN
  v_full_name := COALESCE(
    NULLIF(NEW.raw_user_meta_data->>'full_name', ''),
    NULLIF(NEW.raw_user_meta_data->>'username',  ''),
    NULLIF(split_part(NEW.email, '@', 1), ''),
    'User'
  );

  v_phone := NULLIF(NEW.raw_user_meta_data->>'phone', '');
  IF v_phone IS NOT NULL AND v_phone !~ '^[0-9]{10,11}$' THEN
    v_phone := NULL;
  END IF;

  -- Prefer real email from metadata; otherwise use auth email IFF
  -- it isn't a synthetic placeholder (@*.ihomecrm.local).
  v_email := NULLIF(NEW.raw_user_meta_data->>'email', '');
  IF v_email IS NULL
     AND NEW.email IS NOT NULL
     AND NEW.email NOT LIKE '%@%.ihomecrm.local'
  THEN
    v_email := NEW.email;
  END IF;

  INSERT INTO public.profiles (
    id, full_name, phone, email,
    department, job_title, employee_code, is_active
  )
  VALUES (
    NEW.id,
    v_full_name,
    v_phone,
    v_email,
    NULLIF(NEW.raw_user_meta_data->>'department',    ''),
    NULLIF(NEW.raw_user_meta_data->>'job_title',     ''),
    NULLIF(NEW.raw_user_meta_data->>'employee_code', ''),
    COALESCE((NEW.raw_user_meta_data->>'is_active')::boolean, TRUE)
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── 3. Drop legacy unused function ─────────────────────────────
DROP FUNCTION IF EXISTS public.create_profile_for_new_user() CASCADE;

-- ── 4. Admin can SELECT/INSERT/UPDATE managed-staff profile ────
-- SELECT policy may already exist from 20260427 bundles; recreate
-- it here so the migrations/ directory is self-sufficient.
DROP POLICY IF EXISTS "profiles_select_via_staff_assignments" ON profiles;
CREATE POLICY "profiles_select_via_staff_assignments" ON profiles
  FOR SELECT USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM staff_assignments sa
      WHERE sa.staff_id = profiles.id
        AND sa.user_id  = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM staff_assignments sa
      WHERE sa.user_id  = profiles.id
        AND sa.staff_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "profiles_admin_insert" ON profiles;
CREATE POLICY "profiles_admin_insert" ON profiles
  FOR INSERT WITH CHECK (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM staff_assignments sa
      WHERE sa.staff_id = profiles.id
        AND sa.user_id  = auth.uid()
    )
  );

-- Replace the original "Users can update own profile" with one
-- that also covers admin-→-staff updates.
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "profiles_admin_update" ON profiles;
CREATE POLICY "profiles_admin_update" ON profiles
  FOR UPDATE USING (
    id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM staff_assignments sa
      WHERE sa.staff_id = profiles.id
        AND sa.user_id  = auth.uid()
    )
  );

-- ── 5. Backfill: clear synthetic emails leaked by old trigger ──
UPDATE profiles
SET email = NULL
WHERE email LIKE '%@%.ihomecrm.local';

NOTIFY pgrst, 'reload schema';
COMMIT;
