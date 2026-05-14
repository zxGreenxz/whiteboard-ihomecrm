-- =============================================
-- Migration: RLS policies for customer image buckets
-- Description: Buckets customer-images & customer-id-cards đã tồn tại nhưng
-- thiếu RLS policies, khiến mọi INSERT (upload) bị chặn. Bổ sung policies
-- theo cùng pattern với meter-images.
-- =============================================

-- Đảm bảo buckets tồn tại + đang public (để hiển thị ảnh sau khi upload)
INSERT INTO storage.buckets (id, name, public)
VALUES ('customer-images', 'customer-images', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

INSERT INTO storage.buckets (id, name, public)
VALUES ('customer-id-cards', 'customer-id-cards', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- ---------- customer-images ----------
DROP POLICY IF EXISTS "Authenticated users can upload customer images" ON storage.objects;
CREATE POLICY "Authenticated users can upload customer images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'customer-images');

DROP POLICY IF EXISTS "Public can view customer images" ON storage.objects;
CREATE POLICY "Public can view customer images"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'customer-images');

DROP POLICY IF EXISTS "Users can update customer images" ON storage.objects;
CREATE POLICY "Users can update customer images"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'customer-images');

DROP POLICY IF EXISTS "Users can delete customer images" ON storage.objects;
CREATE POLICY "Users can delete customer images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'customer-images');

-- ---------- customer-id-cards ----------
DROP POLICY IF EXISTS "Authenticated users can upload customer id cards" ON storage.objects;
CREATE POLICY "Authenticated users can upload customer id cards"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'customer-id-cards');

DROP POLICY IF EXISTS "Public can view customer id cards" ON storage.objects;
CREATE POLICY "Public can view customer id cards"
  ON storage.objects FOR SELECT
  TO public
  USING (bucket_id = 'customer-id-cards');

DROP POLICY IF EXISTS "Users can update customer id cards" ON storage.objects;
CREATE POLICY "Users can update customer id cards"
  ON storage.objects FOR UPDATE
  TO authenticated
  USING (bucket_id = 'customer-id-cards');

DROP POLICY IF EXISTS "Users can delete customer id cards" ON storage.objects;
CREATE POLICY "Users can delete customer id cards"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'customer-id-cards');
