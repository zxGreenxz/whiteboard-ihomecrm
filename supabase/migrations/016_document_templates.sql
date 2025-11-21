-- =====================================================
-- MIGRATION 016: DOCUMENT TEMPLATES
-- Description: Template management for contracts, invoices, receipts
-- Author: Claude
-- Date: 2025-11-21
-- =====================================================

-- 1. CREATE ENUM for template categories
CREATE TYPE template_category AS ENUM (
  'CONTRACT_NEW',           -- Hợp đồng ký mới
  'CONTRACT_TERMINATION',   -- Biên bản thanh lý hợp đồng
  'CONTRACT_EXTENSION',     -- Biên bản gia hạn hợp đồng
  'CONTRACT_TRANSFER',      -- Biên bản chuyển nhượng hợp đồng
  'INVOICE',                -- Hóa đơn
  'RECEIPT',                -- Biên lai
  'HANDOVER'                -- Biên bản bàn giao tài sản
);

-- 2. CREATE TABLE
CREATE TABLE document_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Basic info
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category template_category NOT NULL,
  description TEXT,

  -- File storage
  file_url TEXT NOT NULL,                    -- Supabase Storage URL
  file_name VARCHAR(255) NOT NULL,           -- Original filename
  file_size INTEGER,                         -- File size in bytes
  file_type VARCHAR(50) DEFAULT 'docx',      -- File extension

  -- Status
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,

  -- Constraints
  CONSTRAINT document_templates_name_not_empty CHECK (char_length(name) > 0),
  CONSTRAINT document_templates_code_not_empty CHECK (char_length(code) > 0)
);

-- 3. CREATE INDEXES
CREATE INDEX idx_document_templates_user_id ON document_templates(user_id);
CREATE INDEX idx_document_templates_code ON document_templates(code);
CREATE INDEX idx_document_templates_category ON document_templates(category);
CREATE INDEX idx_document_templates_is_default ON document_templates(is_default);
CREATE INDEX idx_document_templates_is_active ON document_templates(is_active);
CREATE INDEX idx_document_templates_deleted_at ON document_templates(deleted_at);

-- 4. ROW LEVEL SECURITY
ALTER TABLE document_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own templates"
  ON document_templates FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 5. TRIGGER for updated_at (reuse existing function)
CREATE TRIGGER set_document_templates_updated_at
  BEFORE UPDATE ON document_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 6. FUNCTION to ensure only one default per category per user
CREATE OR REPLACE FUNCTION ensure_single_default_template()
RETURNS TRIGGER AS $$
BEGIN
  -- If setting a template as default, unset all other defaults for same category and user
  IF NEW.is_default = TRUE THEN
    UPDATE document_templates
    SET is_default = FALSE
    WHERE user_id = NEW.user_id
      AND category = NEW.category
      AND id != NEW.id
      AND is_default = TRUE
      AND deleted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ensure_single_default_template_trigger
  BEFORE INSERT OR UPDATE ON document_templates
  FOR EACH ROW
  WHEN (NEW.is_default = TRUE)
  EXECUTE FUNCTION ensure_single_default_template();

-- 7. COMMENT
COMMENT ON TABLE document_templates IS 'Document templates for contracts, invoices, receipts, and handover documents';
COMMENT ON COLUMN document_templates.code IS 'Auto-generated unique code (e.g., MHD000001)';
COMMENT ON COLUMN document_templates.category IS 'Template category type';
COMMENT ON COLUMN document_templates.is_default IS 'Only one template can be default per category per user';
COMMENT ON COLUMN document_templates.deleted_at IS 'Soft delete timestamp';

-- 8. Create storage bucket for templates (if not exists)
INSERT INTO storage.buckets (id, name, public)
VALUES ('document-templates', 'document-templates', false)
ON CONFLICT (id) DO NOTHING;

-- 9. Storage policies for document-templates bucket
DO $$
BEGIN
  -- Drop existing policies if any
  DROP POLICY IF EXISTS "Users can upload own templates" ON storage.objects;
  DROP POLICY IF EXISTS "Users can read own templates" ON storage.objects;
  DROP POLICY IF EXISTS "Users can update own templates" ON storage.objects;
  DROP POLICY IF EXISTS "Users can delete own templates" ON storage.objects;
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;

-- Policy: Users can upload files to their own folder
CREATE POLICY "Users can upload own templates"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'document-templates' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Users can read files from their own folder
CREATE POLICY "Users can read own templates"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'document-templates' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Users can update files in their own folder
CREATE POLICY "Users can update own templates"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'document-templates' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Users can delete files from their own folder
CREATE POLICY "Users can delete own templates"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'document-templates' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );
