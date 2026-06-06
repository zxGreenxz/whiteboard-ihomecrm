-- =============================================
-- Migration: Bucket PUBLIC 'room-sale-images' cho ảnh sale phòng/tòa.
-- - Trang "Phòng trống" (/r/:token) phục vụ khách VÃNG LAI (anon) → ảnh phải xem
--   được qua getPublicUrl (không signed URL). Ảnh marketing vốn để công khai.
-- - Pattern theo customer-images (20260514000001): bucket public + RLS storage.objects
--   (ghi: authenticated; đọc: public).
-- =============================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('room-sale-images', 'room-sale-images', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS "Authenticated upload room sale images" ON storage.objects;
CREATE POLICY "Authenticated upload room sale images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'room-sale-images');

DROP POLICY IF EXISTS "Public view room sale images" ON storage.objects;
CREATE POLICY "Public view room sale images"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'room-sale-images');

DROP POLICY IF EXISTS "Authenticated update room sale images" ON storage.objects;
CREATE POLICY "Authenticated update room sale images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'room-sale-images');

DROP POLICY IF EXISTS "Authenticated delete room sale images" ON storage.objects;
CREATE POLICY "Authenticated delete room sale images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'room-sale-images');
