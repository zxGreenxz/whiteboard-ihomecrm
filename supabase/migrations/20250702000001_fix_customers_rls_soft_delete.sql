-- =============================================
-- Fix: customers RLS policy for soft-delete
-- The UPDATE policy needs WITH CHECK that allows setting deleted_at
-- Previously missing WITH CHECK caused 42501 when soft-deleting
-- =============================================

-- Drop existing update policy
DROP POLICY IF EXISTS "Users can update own customers" ON customers;

-- Recreate with explicit WITH CHECK that doesn't block soft-delete
CREATE POLICY "Users can update own customers"
  ON customers FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
