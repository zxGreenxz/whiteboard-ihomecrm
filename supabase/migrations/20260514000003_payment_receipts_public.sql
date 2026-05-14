-- Đảm bảo bucket payment-receipts là public (đã được dùng làm public URL trong app).
-- Trước đây prod có bucket nhưng public=false → mọi link "Xem ảnh" trả về 404 "Bucket not found".
UPDATE storage.buckets
SET public = true
WHERE id = 'payment-receipts' AND public = false;
