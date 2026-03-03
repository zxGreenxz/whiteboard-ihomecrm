-- =============================================
-- Migration: Create jobs table
-- Created: 2025-11-21
-- Description: Create jobs table for task management with RLS policies,
--              auto-generate job code trigger, indexes, and storage bucket
-- =============================================

-- 1. CREATE JOBS TABLE
-- =============================================

CREATE TABLE public.jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  room_id UUID REFERENCES public.rooms(id) ON DELETE SET NULL,
  bed_id UUID REFERENCES public.beds(id) ON DELETE SET NULL,
  job_group_id UUID REFERENCES public.job_groups(id) ON DELETE SET NULL,
  job_type_id UUID REFERENCES public.job_types(id) ON DELETE SET NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL', 'LOW', 'URGENT')),
  assignee_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  deadline TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (status IN ('NOT_STARTED', 'IN_PROGRESS', 'PENDING_ACCEPTANCE', 'ACCEPTED', 'FAILED', 'OVERDUE')),
  visible_to_customer BOOLEAN DEFAULT false,
  attachments JSONB,
  completion_time TIMESTAMPTZ,
  completion_description TEXT,
  completion_attachments JSONB,
  acceptance_result TEXT,
  customer_evaluation TEXT,
  customer_comments TEXT,
  accepted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE public.jobs IS 'Task instances for operational job management';
COMMENT ON COLUMN public.jobs.code IS 'Auto-generated job code in format JOB-YYYYMMDD-NNNN';
COMMENT ON COLUMN public.jobs.priority IS 'Job priority: NORMAL, LOW, URGENT';
COMMENT ON COLUMN public.jobs.status IS 'Job status: NOT_STARTED, IN_PROGRESS, PENDING_ACCEPTANCE, ACCEPTED, FAILED, OVERDUE';

-- 2. ROW LEVEL SECURITY
-- =============================================

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own jobs"
  ON public.jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own jobs"
  ON public.jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own jobs"
  ON public.jobs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own jobs"
  ON public.jobs FOR DELETE
  USING (auth.uid() = user_id);

-- 3. AUTO-GENERATE JOB CODE TRIGGER
-- =============================================

CREATE OR REPLACE FUNCTION public.generate_job_code()
RETURNS TRIGGER AS $$
BEGIN
  NEW.code := 'JOB-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || LPAD(
    (SELECT COALESCE(MAX(CAST(SUBSTRING(code FROM 'JOB-\d{8}-(\d+)') AS INTEGER)), 0) + 1
     FROM public.jobs
     WHERE code LIKE 'JOB-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-%')::TEXT,
    4, '0'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_generate_job_code
  BEFORE INSERT ON public.jobs
  FOR EACH ROW
  WHEN (NEW.code IS NULL OR NEW.code = '')
  EXECUTE FUNCTION public.generate_job_code();

-- 4. AUTO-UPDATE UPDATED_AT TRIGGER
-- Reuses existing update_updated_at_column() function from 008_triggers_functions.sql
-- =============================================

CREATE TRIGGER trigger_jobs_updated_at
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 5. INDEXES
-- =============================================

CREATE INDEX idx_jobs_user_id ON public.jobs(user_id);
CREATE INDEX idx_jobs_status ON public.jobs(status);
CREATE INDEX idx_jobs_building_id ON public.jobs(building_id);
CREATE INDEX idx_jobs_assignee_id ON public.jobs(assignee_id);
CREATE INDEX idx_jobs_created_at ON public.jobs(created_at DESC);

-- 6. SUPABASE STORAGE BUCKET FOR JOB ATTACHMENTS
-- =============================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('job-attachments', 'job-attachments', true);

CREATE POLICY "Users can upload job attachments"
  ON storage.objects FOR INSERT
  WITH CHECK (bucket_id = 'job-attachments' AND auth.role() = 'authenticated');

CREATE POLICY "Anyone can view job attachments"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'job-attachments');

CREATE POLICY "Users can delete own job attachments"
  ON storage.objects FOR DELETE
  USING (bucket_id = 'job-attachments' AND auth.role() = 'authenticated');
