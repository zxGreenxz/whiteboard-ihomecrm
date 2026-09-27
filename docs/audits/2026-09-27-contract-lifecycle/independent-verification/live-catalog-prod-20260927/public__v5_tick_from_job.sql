-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.v5_tick_from_job(p_job_id uuid) md5(prosrc)=b15ee632fb6ab5e9c1b948a21265ff33
CREATE OR REPLACE FUNCTION public.v5_tick_from_job(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid UUID := auth.uid();
  v_j public.jobs;
BEGIN
  SELECT * INTO v_j FROM public.jobs WHERE id = p_job_id;
  IF NOT FOUND OR v_j.status <> 'COMPLETED' OR v_j.assignee_id <> v_uid THEN
    RETURN jsonb_build_object('ticked', false, 'reason', 'job_not_eligible');
  END IF;
  -- bằng chứng ảnh: chấp nhận cả attachments (nơi ảnh được merge) lẫn completion_attachments
  IF NOT public.job_photo_ok(v_j.completion_attachments, v_j.attachments) THEN
    RETURN jsonb_build_object('ticked', false, 'reason', 'no_photo_evidence');
  END IF;
  -- completion_time NOT NULL được bảo đảm bởi CHECK jobs_completed_needs_completion_time
  RETURN public.v5_tick_attendance(v_uid, public.vn_local_date(v_j.completion_time), 'JOB', p_job_id, v_j.title);
END; $function$

