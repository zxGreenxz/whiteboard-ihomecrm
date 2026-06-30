-- =============================================
-- Migration: Bo nhanh (C) CONTRACT (doc bang contracts) khoi salary_work_ledger.
--   Thuong ky HD +50k GIO chi den tu VIEC loai checkin (job_types.is_contract):
--   nhanh (A) JOB da co dieu kien sau gio/CN-Le, nhanh (B) phu cap CN/Le da mo
--   rong cho is_contract. => khong con +50k tu bang contracts (tranh trung).
--   Them cot `is_contract` vao output ledger + bang snapshot de FE phan loai
--   "Cu dem / Thuong HD" tu viec checkin.
-- =============================================

BEGIN;

-- snapshot luu them is_contract (thang chot moi giu duoc phan loai HD)
ALTER TABLE public.salary_work_ledger_snapshot
  ADD COLUMN IF NOT EXISTS is_contract boolean;

-- Doi signature (them cot) → DROP truoc roi CREATE
DROP FUNCTION IF EXISTS public.salary_work_ledger(date, uuid);
CREATE FUNCTION public.salary_work_ledger(p_period_month date, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(staff_id uuid, item_type text, source_id uuid, occurred_date date, day_label text, content text, place text, job_type_name text, is_repair boolean, is_contract boolean, base_amount numeric, weekend_amount numeric, after_amount numeric, cash_amount numeric, has_photo boolean, bonus_amount numeric, reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_owner   uuid;
  v_start   date;
  v_end     date;
  v_staff   uuid := p_staff_id;
  v_rules   jsonb;
  v_weekend int[];
  v_cutoff  time;
  v_wk_day  numeric;
  v_photo   boolean;
BEGIN
  v_owner := (SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1);
  IF NOT (public.is_admin() OR public.is_super_admin()) THEN
    v_staff := auth.uid();
  END IF;

  v_start := date_trunc('month', p_period_month)::date;
  v_end   := (v_start + INTERVAL '1 month - 1 day')::date;

  SELECT r.rules INTO v_rules FROM public.salary_bonus_rules r WHERE r.user_id = v_owner;
  v_rules   := COALESCE(v_rules, '{}'::jsonb);
  v_wk_day  := COALESCE((v_rules->>'weekendRepair')::numeric, 20000);
  v_cutoff  := COALESCE((v_rules->>'afterHourMark'), '18:00')::time;
  v_photo   := COALESCE((v_rules->>'requirePhoto')::boolean, false);
  SELECT COALESCE(array_agg((e)::int), ARRAY[0]) INTO v_weekend
  FROM jsonb_array_elements_text(COALESCE(v_rules->'weekendDays', '[0]'::jsonb)) e;

  RETURN QUERY
  -- (A) JOB: viec da hoan thanh; viec ky HD (is_contract) chi +thuong khi sau gio/CN-Le
  SELECT
    j.assignee_id,
    'JOB'::text,
    j.id,
    public.vn_local_date(COALESCE(j.completion_time, j.created_at)),
    CASE
      WHEN EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(COALESCE(j.completion_time, j.created_at))) THEN 'Lễ'
      WHEN public.vn_local_dow(COALESCE(j.completion_time, j.created_at)) = ANY(v_weekend) THEN 'CN'
      ELSE ''
    END,
    j.title,
    COALESCE(b.code, b.name, '') || COALESCE(' · ' || r.name, ''),
    jt.name,
    COALESCE(jt.is_repair, false),
    COALESCE(jt.is_contract, false),
    COALESCE(jt.bonus_amount, 0),
    0::numeric,
    0::numeric,
    NULL::numeric,
    (j.completion_attachments IS NOT NULL AND jsonb_typeof(j.completion_attachments) = 'array' AND jsonb_array_length(j.completion_attachments) > 0),
    CASE
      WHEN COALESCE(jt.counts_for_salary, true)
       AND (NOT v_photo OR (j.completion_attachments IS NOT NULL AND jsonb_typeof(j.completion_attachments) = 'array' AND jsonb_array_length(j.completion_attachments) > 0))
       AND (NOT COALESCE(jt.is_contract, false)
            OR public.vn_local_time(COALESCE(j.completion_time, j.created_at)) >= v_cutoff
            OR public.vn_local_dow(COALESCE(j.completion_time, j.created_at)) = ANY(v_weekend)
            OR EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(COALESCE(j.completion_time, j.created_at))))
      THEN COALESCE(jt.bonus_amount, 0) ELSE 0
    END,
    COALESCE(jt.name, 'Việc')
  FROM public.jobs j
  JOIN public.job_types jt ON jt.id = j.job_type_id
  LEFT JOIN public.buildings b ON b.id = j.building_id
  LEFT JOIN public.rooms r ON r.id = j.room_id
  WHERE j.status = 'COMPLETED'
    AND COALESCE(jt.counts_for_salary, true)
    AND (COALESCE(jt.bonus_amount, 0) > 0 OR COALESCE(jt.is_repair, false))
    AND j.assignee_id IS NOT NULL
    AND (v_staff IS NOT NULL AND j.assignee_id = v_staff
         OR v_staff IS NULL AND j.assignee_id IN (SELECT c.staff_id FROM public.manager_salary_config c WHERE c.user_id = v_owner AND c.is_active))
    AND public.vn_local_date(COALESCE(j.completion_time, j.created_at)) BETWEEN v_start AND v_end

  UNION ALL
  -- (B) DAY_BONUS: +weekendRepair cho moi ngay CN/Le co >=1 viec sua chua HOAC ky HD
  SELECT
    d.staff_id, 'DAY_BONUS'::text, NULL::uuid, d.ld,
    CASE WHEN d.is_holiday THEN 'Lễ' ELSE 'CN' END,
    CASE WHEN d.is_holiday THEN 'Ngày lễ có làm việc' ELSE 'Chủ nhật có làm việc' END,
    ''::text, NULL::text, true, false, 0::numeric, v_wk_day, 0::numeric, NULL::numeric, NULL::boolean,
    v_wk_day, 'CN/Lễ có sửa chữa hoặc ký HĐ'::text
  FROM (
    SELECT DISTINCT
      j.assignee_id AS staff_id,
      public.vn_local_date(COALESCE(j.completion_time, j.created_at)) AS ld,
      EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(COALESCE(j.completion_time, j.created_at))) AS is_holiday
    FROM public.jobs j
    JOIN public.job_types jt ON jt.id = j.job_type_id
    WHERE j.status = 'COMPLETED'
      AND (COALESCE(jt.is_repair, false) OR COALESCE(jt.is_contract, false))
      AND j.assignee_id IS NOT NULL
      AND (v_staff IS NOT NULL AND j.assignee_id = v_staff
           OR v_staff IS NULL AND j.assignee_id IN (SELECT c.staff_id FROM public.manager_salary_config c WHERE c.user_id = v_owner AND c.is_active))
      AND public.vn_local_date(COALESCE(j.completion_time, j.created_at)) BETWEEN v_start AND v_end
      AND (public.vn_local_dow(COALESCE(j.completion_time, j.created_at)) = ANY(v_weekend)
           OR EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(COALESCE(j.completion_time, j.created_at))))
  ) d

  UNION ALL
  -- (D) CASH: thu tien mat — hien thi minh bach, KHONG thuong (nhanh (C) CONTRACT da BO)
  SELECT
    ie.salary_staff_id, 'CASH'::text, ie.id, ie.voucher_date,
    ''::text,
    'Thu tiền mặt' || COALESCE(' ' || r.name, ''),
    COALESCE(b.code, b.name, '') || COALESCE(' · ' || r.name, ''),
    NULL::text, false, false, 0::numeric, 0::numeric, 0::numeric, ie.total_amount, NULL::boolean,
    NULL::numeric, 'Không tính thưởng'::text
  FROM public.income_expenses ie
  LEFT JOIN public.rooms r ON r.id = ie.room_id
  LEFT JOIN public.buildings b ON b.id = ie.building_id
  WHERE ie.type = 'INCOME'
    AND ie.salary_role = 'CASH_COLLECTION'
    AND ie.deleted_at IS NULL
    AND ie.salary_staff_id IS NOT NULL
    AND (v_staff IS NULL OR ie.salary_staff_id = v_staff)
    AND ie.voucher_date BETWEEN v_start AND v_end;
END;
$function$;
GRANT EXECUTE ON FUNCTION public.salary_work_ledger(date, uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
