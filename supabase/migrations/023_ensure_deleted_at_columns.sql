-- =============================================
-- Migration 023: Ensure deleted_at columns exist
-- Created: 2025-11-22
-- Description: Add deleted_at column to contracts table if not exists
-- =============================================

-- Add deleted_at to contracts table if not exists
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
    CREATE INDEX idx_contracts_deleted_at ON contracts(deleted_at);
    COMMENT ON COLUMN contracts.deleted_at IS 'Soft delete timestamp';
  END IF;
END $$;
