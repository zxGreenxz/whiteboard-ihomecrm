-- =============================================
-- Migration 030: Final Fix - Remove all deleted_at dependencies + Fix notification_status enum
-- Created: 2026-01-08
-- Description: Completely remove deleted_at from RLS policies and ensure contracts table works
-- =============================================

-- STEP 0: Add READ to notification_status enum if not exists
DO $$
BEGIN
  -- Check if READ value exists in enum
  IF NOT EXISTS (
    SELECT 1
    FROM pg_enum
    WHERE enumlabel = 'READ'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'notification_status')
  ) THEN
    ALTER TYPE notification_status ADD VALUE 'READ';
  END IF;
END $$;

-- STEP 1: Ensure deleted_at column exists on contracts (safe to run multiple times)
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

-- STEP 2: Ensure deleted_at column exists on invoices
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'invoices'
    AND column_name = 'deleted_at'
  ) THEN
    ALTER TABLE invoices ADD COLUMN deleted_at TIMESTAMPTZ;
  END IF;
END $$;

-- STEP 3: Drop and recreate RLS policies for contracts - absolutely no deleted_at
DROP POLICY IF EXISTS "Users can view own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can insert own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can update own contracts" ON contracts;
DROP POLICY IF EXISTS "Users can delete own contracts" ON contracts;
DROP POLICY IF EXISTS "contracts_select_policy" ON contracts;
DROP POLICY IF EXISTS "contracts_insert_policy" ON contracts;
DROP POLICY IF EXISTS "contracts_update_policy" ON contracts;
DROP POLICY IF EXISTS "contracts_delete_policy" ON contracts;

CREATE POLICY "Users can view own contracts"
  ON contracts FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own contracts"
  ON contracts FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own contracts"
  ON contracts FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own contracts"
  ON contracts FOR DELETE
  USING (auth.uid() = user_id);

-- STEP 4: Drop and recreate RLS policies for contract_services
DROP POLICY IF EXISTS "Users can view contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can insert contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can update contract services" ON contract_services;
DROP POLICY IF EXISTS "Users can delete contract services" ON contract_services;

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

-- STEP 5: Ensure notifications table doesn't have problematic column references
-- The error shows notifications query is also failing
DO $$
BEGIN
  -- Check if status column exists and has correct type
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
    AND table_name = 'notifications'
    AND column_name = 'status'
  ) THEN
    -- Add status column if not exists
    ALTER TABLE notifications ADD COLUMN status TEXT DEFAULT 'UNREAD';
  END IF;
END $$;

-- STEP 6: Fix notifications RLS policies
DROP POLICY IF EXISTS "Users can view own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can insert own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can delete own notifications" ON notifications;

CREATE POLICY "Users can view own notifications"
  ON notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own notifications"
  ON notifications FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own notifications"
  ON notifications FOR DELETE
  USING (auth.uid() = user_id);

-- Done!
