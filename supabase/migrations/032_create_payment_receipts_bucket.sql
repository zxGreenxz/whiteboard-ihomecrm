-- =============================================
-- Migration 032: Create payment-receipts Storage Bucket
-- Created: 2026-01-08
-- Description: Create storage bucket for payment receipt images
-- =============================================

-- STEP 1: Create the payment-receipts storage bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('payment-receipts', 'payment-receipts', true)
ON CONFLICT (id) DO NOTHING;

-- STEP 2: RLS policies for payment-receipts bucket

-- Policy: Users can upload payment receipts to their own folder
CREATE POLICY "Users can upload payment receipts"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'payment-receipts' AND
    auth.role() = 'authenticated' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Anyone can read payment receipts (public bucket)
CREATE POLICY "Anyone can read payment receipts"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'payment-receipts');

-- Policy: Users can update their own payment receipts
CREATE POLICY "Users can update own payment receipts"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'payment-receipts' AND
    auth.role() = 'authenticated' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Policy: Users can delete their own payment receipts
CREATE POLICY "Users can delete own payment receipts"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'payment-receipts' AND
    auth.role() = 'authenticated' AND
    (storage.foldername(name))[1] = auth.uid()::text
  );

-- Done!
-- Run this migration with: npx supabase db push
-- Or execute directly in Supabase Dashboard → SQL Editor
