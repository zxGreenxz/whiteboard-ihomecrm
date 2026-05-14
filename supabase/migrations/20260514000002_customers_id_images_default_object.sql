-- =============================================
-- Migration: Sửa default + chuẩn hoá customers.id_images
-- Description: Cột id_images đang có default '[]'::jsonb nên mọi khách hàng
-- chưa upload ảnh sẽ có id_images = []. Frontend lại expect object
-- (Record<string,string> với keys front/back/passport), khiến Zod schema
-- z.record(z.string()) reject khi load form → submit silently fail.
-- Đổi default sang '{}'::jsonb và chuẩn hoá các row hiện đang là array.
-- =============================================

ALTER TABLE customers
  ALTER COLUMN id_images SET DEFAULT '{}'::jsonb;

UPDATE customers
SET id_images = '{}'::jsonb
WHERE id_images IS NOT NULL
  AND jsonb_typeof(id_images) = 'array';
