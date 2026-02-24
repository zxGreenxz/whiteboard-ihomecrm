-- =============================================
-- Migration: Create meter-images storage bucket
-- Description: Storage bucket for meter reading images (photos of meters)
-- =============================================

-- STEP 1: Create the meter-images storage bucket (public for reading)
INSERT INTO storage.buckets (id, name, public)
VALUES ('meter-images', 'meter-images', true)
ON CONFLICT (id) DO NOTHING;

-- STEP 2: RLS policies for meter-images bucket

-- Policy: Authenticated users can upload meter images
CREATE POLICY "Authenticated users can upload meter images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'meter-images');

-- Policy: Public can view meter images (public bucket)
CREATE POLICY "Public can view meter images"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'meter-images');

-- Policy: Authenticated users can update meter images
CREATE POLICY "Users can update own meter images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'meter-images');

-- Policy: Authenticated users can delete meter images
CREATE POLICY "Users can delete own meter images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'meter-images');
