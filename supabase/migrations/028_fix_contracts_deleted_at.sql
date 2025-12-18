-- =============================================
-- Migration 028: Fix contracts RLS policies (URGENT FIX)
-- Created: 2025-12-18
-- Description: Remove deleted_at dependency from RLS policies
-- =============================================

-- STEP 1: DROP ALL EXISTING RLS POLICIES ON contracts TABLE
DROP POLICY IF EXISTS "Users can view own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can insert own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can update own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can delete own contracts" ON contracts;

-- STEP 2: DROP ALL EXISTING RLS POLICIES ON contract_services TABLE
DROP POLICY IF EXISTS "Users can view contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can insert contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can update contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can delete contract services" ON contract_services;

-- STEP 3: Add deleted_at column if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'contracts'
    AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE contracts ADD COLUMN deleted_at TIMESTAMPTZ;
  END IF;
END $$;

-- STEP 4: Create index if not exists
CREATE INDEX IF NOT EXISTS idx_contracts_deleted_at ON contracts(deleted_at);

-- STEP 5: RECREATE RLS POLICIES FOR contracts (SIMPLE - NO deleted_at check for now)
-- SELECT policy: View own contracts only
CREATE POLICY "Users can view own contracts"
  ON contracts FOR SELECT
  USING (auth.uid() = user_id);

-- INSERT policy: Allow inserting new contracts
CREATE POLICY "Users can insert own contracts"
  ON contracts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- UPDATE policy: Allow updating own contracts
CREATE POLICY "Users can update own contracts"
  ON contracts FOR UPDATE
  USING (auth.uid() = user_id);

-- DELETE policy: Allow deleting own contracts
CREATE POLICY "Users can delete own contracts"
  ON contracts FOR DELETE
  USING (auth.uid() = user_id);

-- STEP 6: RECREATE RLS POLICIES FOR contract_services (SIMPLE)
CREATE POLICY "Users can view contract services"
  ON contract_services FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert contract services"
  ON contract_services FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update contract services"
  ON contract_services FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete contract services"
  ON contract_services FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
    )
  );

-- Done!
