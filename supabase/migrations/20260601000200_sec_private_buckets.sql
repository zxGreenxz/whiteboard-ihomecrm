-- =============================================================================
-- Security: đóng các bucket ảnh nhạy cảm — chuyển từ PUBLIC → PRIVATE và thay
--           policy đọc TO public → TO authenticated.
--
-- BỐI CẢNH: 7 bucket dưới đây đang public=true và có policy SELECT cho role
-- {public} ⇒ bất kỳ ai trên Internet đều liệt kê + tải được (gồm ảnh CCCD khách,
-- biên lai, chứng từ thu/chi…). Migration này CHẶN truy cập ẩn danh; chỉ user đã
-- đăng nhập mới đọc được (qua signed URL do frontend tạo).
--
-- KHÔNG xoá file: chỉ đổi cờ public + đổi role policy. File và URL đã lưu trong
-- DB vẫn nguyên; frontend đã chuyển sang signed URL (StorageImage/useSignedUrl).
--
-- LƯU Ý: phải deploy frontend (signed URL) TRƯỚC khi chạy migration này để ảnh
-- không bị hỏng hiển thị.
-- =============================================================================

-- 1) Đóng cờ public của 7 bucket.
UPDATE storage.buckets
   SET public = false
 WHERE id IN (
   'customer-id-cards',
   'customer-images',
   'payment-receipts',
   'income-expense-attachments',
   'meter-images',
   'job-attachments',
   'ui-references'
 );

-- 2) Thay policy SELECT công khai (TO public) bằng TO authenticated.
DROP POLICY IF EXISTS "Public can view customer id cards" ON storage.objects;
DROP POLICY IF EXISTS "Public can view customer images"   ON storage.objects;
DROP POLICY IF EXISTS "Anyone can read payment receipts"   ON storage.objects;
DROP POLICY IF EXISTS "ie_attachments_select"              ON storage.objects;
DROP POLICY IF EXISTS "Public can view meter images"       ON storage.objects;
DROP POLICY IF EXISTS "Anyone can view job attachments"    ON storage.objects;
DROP POLICY IF EXISTS "Public can view UI references"      ON storage.objects;

CREATE POLICY "customer_id_cards_select_authenticated" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'customer-id-cards');
CREATE POLICY "customer_images_select_authenticated" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'customer-images');
CREATE POLICY "payment_receipts_select_authenticated" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'payment-receipts');
CREATE POLICY "ie_attachments_select_authenticated" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'income-expense-attachments');
CREATE POLICY "meter_images_select_authenticated" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'meter-images');
CREATE POLICY "job_attachments_select_authenticated" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'job-attachments');
CREATE POLICY "ui_references_select_authenticated" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'ui-references');
