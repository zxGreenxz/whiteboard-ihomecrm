-- =============================================
-- Migration: Alter document_templates table
-- Description: Add content, variables columns and expand type support
-- The table already exists from 016_document_templates.sql with template_category enum.
-- This migration adds columns needed by the new design (content-based templates
-- with variables support) alongside the existing file-based approach.
-- Requirements: 38.7, 32.1-32.6
-- =============================================

-- Add 'content' column for inline template content (HTML/text)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_templates' AND column_name = 'content'
  ) THEN
    ALTER TABLE document_templates ADD COLUMN content TEXT;
  END IF;
END $$;

-- Add 'variables' column for template variable definitions
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_templates' AND column_name = 'variables'
  ) THEN
    ALTER TABLE document_templates ADD COLUMN variables JSONB DEFAULT '[]'::jsonb;
  END IF;
END $$;

-- Add 'type' column as a simpler text-based type alongside the existing category enum
-- This supports the 6 template types from the design doc:
-- signature, deposit_contract, lease_contract, handover_report, invoice, receipt
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'document_templates' AND column_name = 'type'
  ) THEN
    ALTER TABLE document_templates ADD COLUMN type TEXT
      CHECK (type IN ('signature', 'deposit_contract', 'lease_contract', 'handover_report', 'invoice', 'receipt'));
  END IF;
END $$;

COMMENT ON COLUMN document_templates.content IS 'Inline template content (HTML/text) for content-based templates';
COMMENT ON COLUMN document_templates.variables IS 'Template variable definitions as JSONB array';
COMMENT ON COLUMN document_templates.type IS 'Simple type classification: signature, deposit_contract, lease_contract, handover_report, invoice, receipt';
