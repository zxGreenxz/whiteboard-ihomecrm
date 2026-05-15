-- =============================================
-- Migration: Drop jobs.job_group_id
-- Created: 2026-05-16
-- Description: Bỏ cột job_group_id khỏi bảng jobs.
--   Form tạo công việc nhanh không còn dùng nhóm công việc ở cấp job
--   (job_groups vẫn giữ cho job_types để phân loại).
-- =============================================

ALTER TABLE public.jobs DROP COLUMN IF EXISTS job_group_id;
