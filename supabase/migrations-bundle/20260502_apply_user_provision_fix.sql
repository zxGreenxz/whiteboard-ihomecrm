-- =============================================================
-- BUNDLE: Fix user provisioning flow.
--
-- Mirrors supabase/migrations/20260502000001_fix_user_provision_flow.sql
-- — apply this via Supabase SQL Editor on hosted DB.
--
-- See migrations/20260502000001_fix_user_provision_flow.sql for
-- detailed rationale.
-- =============================================================

BEGIN;

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS department    TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS job_title     TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS employee_code TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_active     BOOLEAN NOT NULL DEFAULT TRUE;

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

DROP FUNCTION IF EXISTS public.create_profile_for_new_user() CASCADE;

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

UPDATE profiles
SET email = NULL
WHERE email LIKE '%@%.ihomecrm.local';

NOTIFY pgrst, 'reload schema';
COMMIT;
