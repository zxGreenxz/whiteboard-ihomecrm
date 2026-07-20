-- =============================================
-- Migration: (1) ledger tra them co `excluded` de UI co nut bat/tat
--            (2) them moc hieu luc `system_v5.effective_from`
--
-- (1) salary_work_ledger tra them cot `excluded` = jobs.exclude_from_salary.
--     Truoc day UI khong phan biet duoc "0d vi bi loai" vs "0d vi checkin
--     trong gio" → khong render duoc nut toggle. Doi signature nen phai
--     DROP truoc roi CREATE. Snapshot KHONG can cot nay: thang da chot dong
--     bang bang bonus_amount roi.
--
-- (2) BUG: co `salary_engine='v5'` bat 03/07/2026 nhung ap NGUOC cho MOI thang
--     chua chot. Thang 6/2026 khong he co du lieu cham cong v5 → v5_month_money
--     tra 0 → man luong hien Ngay cong 0, Luong thang 0d, va con VUT LUON
--     thuong viec tu bang ke (useManagerSalary.ts thay the bonusAuto).
--     Ket qua: ca 2 nhan su mat trang luong thang 6.
--     FIX: them `system_v5.effective_from`; FE chi ap v5 cho thang >= moc nay,
--     thang truoc do roi ve legacy (luong cung + thuong viec tu bang ke).
--     Dat = 2026-07-01 (thang v5 that su co du lieu).
-- =============================================

BEGIN;

-- (2) moc hieu luc v5 — chi set neu chua co, khong de len cau hinh dang chay
UPDATE public.salary_bonus_rules
SET rules = jsonb_set(
      rules,
      '{system_v5,effective_from}',
      '"2026-07-01"'::jsonb,
      true
    )
WHERE rules -> 'system_v5' IS NOT NULL
  AND rules -> 'system_v5' -> 'effective_from' IS NULL;

-- (1) ledger + cot `excluded`
DROP FUNCTION IF EXISTS public.salary_work_ledger(date, uuid);
CREATE FUNCTION public.salary_work_ledger(p_period_month date, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(staff_id uuid, item_type text, source_id uuid, occurred_date date, day_label text, content text, place text, job_type_name text, is_repair boolean, is_contract boolean, base_amount numeric, weekend_amount numeric, after_amount numeric, cash_amount numeric, has_photo boolean, bonus_amount numeric, reason text, excluded boolean)
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
  -- (A) JOB: viec ky HD (is_contract) chi +thuong khi sau gio/CN-Le;
  --     viec co exclude_from_salary → van hien dong nhung thuong = 0
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
       AND NOT COALESCE(j.exclude_from_salary, false)
       AND (NOT v_photo OR (j.completion_attachments IS NOT NULL AND jsonb_typeof(j.completion_attachments) = 'array' AND jsonb_array_length(j.completion_attachments) > 0))
       AND (NOT COALESCE(jt.is_contract, false)
            OR public.vn_local_time(COALESCE(j.completion_time, j.created_at)) >= v_cutoff
            OR public.vn_local_dow(COALESCE(j.completion_time, j.created_at)) = ANY(v_weekend)
            OR EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(COALESCE(j.completion_time, j.created_at))))
      THEN COALESCE(jt.bonus_amount, 0) ELSE 0
    END,
    COALESCE(jt.name, 'Việc'),
    COALESCE(j.exclude_from_salary, false)
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
  -- (B) DAY_BONUS: viec bi loai-tru KHONG kich hoat phu cap CN/Le
  SELECT
    d.staff_id, 'DAY_BONUS'::text, NULL::uuid, d.ld,
    CASE WHEN d.is_holiday THEN 'Lễ' ELSE 'CN' END,
    CASE WHEN d.is_holiday THEN 'Ngày lễ có làm việc' ELSE 'Chủ nhật có làm việc' END,
    ''::text, NULL::text, true, false, 0::numeric, v_wk_day, 0::numeric, NULL::numeric, NULL::boolean,
    v_wk_day, 'CN/Lễ có sửa chữa hoặc ký HĐ'::text, false
  FROM (
    SELECT DISTINCT
      j.assignee_id AS staff_id,
      public.vn_local_date(COALESCE(j.completion_time, j.created_at)) AS ld,
      EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(COALESCE(j.completion_time, j.created_at))) AS is_holiday
    FROM public.jobs j
    JOIN public.job_types jt ON jt.id = j.job_type_id
    WHERE j.status = 'COMPLETED'
      AND (COALESCE(jt.is_repair, false) OR COALESCE(jt.is_contract, false))
      AND NOT COALESCE(j.exclude_from_salary, false)
      AND j.assignee_id IS NOT NULL
      AND (v_staff IS NOT NULL AND j.assignee_id = v_staff
           OR v_staff IS NULL AND j.assignee_id IN (SELECT c.staff_id FROM public.manager_salary_config c WHERE c.user_id = v_owner AND c.is_active))
      AND public.vn_local_date(COALESCE(j.completion_time, j.created_at)) BETWEEN v_start AND v_end
      AND (public.vn_local_dow(COALESCE(j.completion_time, j.created_at)) = ANY(v_weekend)
           OR EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(COALESCE(j.completion_time, j.created_at))))
  ) d

  UNION ALL
  -- (D) CASH: thu tien mat — hien thi minh bach, KHONG thuong
  SELECT
    ie.salary_staff_id, 'CASH'::text, ie.id, ie.voucher_date,
    ''::text,
    'Thu tiền mặt' || COALESCE(' ' || r.name, ''),
    COALESCE(b.code, b.name, '') || COALESCE(' · ' || r.name, ''),
    NULL::text, false, false, 0::numeric, 0::numeric, 0::numeric, ie.total_amount, NULL::boolean,
    NULL::numeric, 'Không tính thưởng'::text, false
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

COMMIT;

NOTIFY pgrst, 'reload schema';
