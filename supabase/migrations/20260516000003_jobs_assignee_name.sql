-- =============================================
-- Migration: jobs.assignee_name
-- Created: 2026-05-16
-- Description: Cho phép nhập tên người thực hiện tự do không khớp
--   với danh sách profiles. Cột assignee_id (FK profiles) giữ nguyên,
--   khi user gõ tên không có trong list thì lưu vào assignee_name.
--   Hiển thị: profiles.full_name (nếu có assignee_id) || assignee_name.
-- =============================================

ALTER TABLE public.jobs ADD COLUMN IF NOT EXISTS assignee_name TEXT;

COMMENT ON COLUMN public.jobs.assignee_name IS 'Tên người thực hiện gõ tay khi không khớp profile. Mutex với assignee_id ở UI nhưng không enforce ở DB.';
