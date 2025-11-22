-- =============================================
-- Migration 025: Create contract-files storage bucket
-- Created: 2025-11-22
-- Description: Storage bucket for signed contract files (PDF, images)
-- =============================================

-- 1. Create storage bucket for contract files
INSERT INTO storage.buckets (id, name, public)
VALUES ('contract-files', 'contract-files', false)
ON CONFLICT (id) DO NOTHING;

-- 2. Storage policies for contract-files bucket

-- Policy: Users can upload files to their own folder
CREATE POLICY "Users can upload own contract files"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'contract-files' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Users can read files from their own folder
CREATE POLICY "Users can read own contract files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'contract-files' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Users can update files in their own folder
CREATE POLICY "Users can update own contract files"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'contract-files' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Users can delete files from their own folder
CREATE POLICY "Users can delete own contract files"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'contract-files' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Comment
COMMENT ON CONSTRAINT "contract-files bucket policies" IS 'Users can only access files in their own folder (user_id/)';
