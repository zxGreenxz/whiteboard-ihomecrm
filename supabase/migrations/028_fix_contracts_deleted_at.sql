-- =============================================
-- Migration 028: Fix contracts deleted_at column and RLS policies
-- Created: 2025-12-18
-- Description: Ensure deleted_at column exists and fix RLS policies
-- =============================================

-- Step 1: Add deleted_at column if not exists
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
    RAISE NOTICE 'Added deleted_at column to contracts table';
  ELSE
    RAISE NOTICE 'deleted_at column already exists in contracts table';
  END IF;
END $$;

-- Step 2: Create index if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE tablename = 'contracts'
    AND indexname = 'idx_contracts_deleted_at'
  ) THEN
    CREATE INDEX idx_contracts_deleted_at ON contracts(deleted_at);
    RAISE NOTICE 'Created index idx_contracts_deleted_at';
  ELSE
    RAISE NOTICE 'Index idx_contracts_deleted_at already exists';
  END IF;
END $$;

-- Step 3: Drop and recreate RLS policies for contracts table
-- Drop existing policies
DROP POLICY IF EXISTS "Users can view own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can insert own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can update own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can delete own contracts" ON contracts;

-- Recreate policies with proper deleted_at handling
-- SELECT policy: Only show non-deleted contracts
CREATE POLICY "Users can view own contracts"
  ON contracts FOR SELECT
  USING (auth.uid() = user_id AND (deleted_at IS NULL));

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

-- Step 4: Fix contract_services RLS policies
DROP POLICY IF EXISTS "Users can view contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can insert contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can update contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can delete contract services" ON contract_services;

-- Recreate contract_services policies
CREATE POLICY "Users can view contract services"
  ON contract_services FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contracts
      WHERE contracts.id = contract_services.contract_id
        AND contracts.user_id = auth.uid()
        AND (contracts.deleted_at IS NULL)
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

-- Add comment
COMMENT ON COLUMN contracts.deleted_at IS 'Soft delete timestamp - NULL means active, timestamp means deleted';

-- Migration completed
-- =============================================
