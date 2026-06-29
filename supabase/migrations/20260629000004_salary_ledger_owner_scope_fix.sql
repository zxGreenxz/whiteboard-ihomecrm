-- Fix: salary_work_ledger JOB/DAY_BONUS branches dropped every staff-created job.
--
-- The JOB and DAY_BONUS branches filtered `j.user_id = v_owner`, but jobs are
-- created with user_id = the CREATOR (staff), not the owner. So a manager's own
-- completed repair jobs (assignee = the manager, user_id = the manager) were all
-- excluded → work bonus computed as 0 even when the manager had many "sửa" jobs.
--
-- Tenant scoping is already enforced by assignee: either assignee_id = v_staff
-- (self-view) or assignee_id IN (this owner's active manager_salary_config). So
-- removing the redundant `j.user_id = v_owner` predicate is the correct fix.
-- (Holiday EXISTS subqueries keep `h.user_id = v_owner` — holidays do belong to
-- the owner.) CONTRACT/CASH branches are unchanged.

CREATE OR REPLACE FUNCTION public.salary_work_ledger(p_period_month date, p_staff_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(staff_id uuid, item_type text, source_id uuid, occurred_date date, day_label text, content text, place text, job_type_name text, is_repair boolean, base_amount numeric, weekend_amount numeric, after_amount numeric, cash_amount numeric, has_photo boolean, bonus_amount numeric, reason text)
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
  v_wk_day  numeric;   -- thưởng cả ngày CN/Lễ có sửa chữa
  v_after   numeric;   -- thưởng HĐ ngoài giờ
  v_photo   boolean;
BEGIN
  v_owner := (SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1);
  -- Bảo mật: người không phải admin chỉ được xem CỦA CHÍNH MÌNH
  IF NOT (public.is_admin() OR public.is_super_admin()) THEN
    v_staff := auth.uid();
  END IF;

  v_start := date_trunc('month', p_period_month)::date;
  v_end   := (v_start + INTERVAL '1 month - 1 day')::date;

  SELECT r.rules INTO v_rules FROM public.salary_bonus_rules r WHERE r.user_id = v_owner;
  v_rules   := COALESCE(v_rules, '{}'::jsonb);
  v_wk_day  := COALESCE((v_rules->>'weekendRepair')::numeric, 20000);
  v_after   := COALESCE((v_rules->>'afterHourContract')::numeric, 50000);
  v_cutoff  := COALESCE((v_rules->>'afterHourMark'), '18:00')::time;
  v_photo   := COALESCE((v_rules->>'requirePhoto')::boolean, false);
  SELECT COALESCE(array_agg((e)::int), ARRAY[0]) INTO v_weekend
  FROM jsonb_array_elements_text(COALESCE(v_rules->'weekendDays', '[0]'::jsonb)) e;

  RETURN QUERY
  -- (A) JOB: việc đã hoàn thành, loại việc tính lương (có thưởng hoặc là sửa chữa)
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
    COALESCE(jt.bonus_amount, 0),
    0::numeric,
    0::numeric,
    NULL::numeric,
    (j.completion_attachments IS NOT NULL AND jsonb_typeof(j.completion_attachments) = 'array' AND jsonb_array_length(j.completion_attachments) > 0),
    CASE
      WHEN COALESCE(jt.counts_for_salary, true)
       AND (NOT v_photo OR (j.completion_attachments IS NOT NULL AND jsonb_typeof(j.completion_attachments) = 'array' AND jsonb_array_length(j.completion_attachments) > 0))
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
  -- (B) DAY_BONUS: +20k cho mỗi ngày CN/Lễ có ≥1 việc sửa chữa
  SELECT
    d.staff_id, 'DAY_BONUS'::text, NULL::uuid, d.ld,
    CASE WHEN d.is_holiday THEN 'Lễ' ELSE 'CN' END,
    CASE WHEN d.is_holiday THEN 'Ngày lễ có sửa chữa' ELSE 'Chủ nhật có sửa chữa' END,
    ''::text, NULL::text, true, 0::numeric, v_wk_day, 0::numeric, NULL::numeric, NULL::boolean,
    v_wk_day, 'CN/Lễ có sửa chữa'::text
  FROM (
    SELECT DISTINCT
      j.assignee_id AS staff_id,
      public.vn_local_date(COALESCE(j.completion_time, j.created_at)) AS ld,
      EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(COALESCE(j.completion_time, j.created_at))) AS is_holiday
    FROM public.jobs j
    JOIN public.job_types jt ON jt.id = j.job_type_id
    WHERE j.status = 'COMPLETED'
      AND COALESCE(jt.is_repair, false)
      AND j.assignee_id IS NOT NULL
      AND (v_staff IS NOT NULL AND j.assignee_id = v_staff
           OR v_staff IS NULL AND j.assignee_id IN (SELECT c.staff_id FROM public.manager_salary_config c WHERE c.user_id = v_owner AND c.is_active))
      AND public.vn_local_date(COALESCE(j.completion_time, j.created_at)) BETWEEN v_start AND v_end
      AND (public.vn_local_dow(COALESCE(j.completion_time, j.created_at)) = ANY(v_weekend)
           OR EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(COALESCE(j.completion_time, j.created_at))))
  ) d

  UNION ALL
  -- (C) CONTRACT: HĐ tạo sau 18:00 HOẶC Chủ nhật/Lễ → +50k
  SELECT
    c.user_id, 'CONTRACT'::text, c.id, public.vn_local_date(c.created_at),
    CASE
      WHEN EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(c.created_at)) THEN 'Lễ'
      WHEN public.vn_local_dow(c.created_at) = ANY(v_weekend) THEN 'CN'
      ELSE ''
    END,
    'Lập HĐ' || COALESCE(' ' || r.name, '') || ' lúc ' || to_char(public.vn_local_time(c.created_at), 'HH24:MI'),
    COALESCE(b.code, b.name, '') || COALESCE(' · ' || r.name, ''),
    NULL::text, false, 0::numeric, 0::numeric, v_after, NULL::numeric, NULL::boolean,
    v_after, 'HĐ ngoài giờ/CN/lễ'::text
  FROM public.contracts c
  LEFT JOIN public.rooms r ON r.id = c.room_id
  LEFT JOIN public.buildings b ON b.id = r.building_id
  WHERE c.deleted_at IS NULL
    AND c.user_id IS NOT NULL
    AND (v_staff IS NOT NULL AND c.user_id = v_staff
         OR v_staff IS NULL AND c.user_id IN (SELECT cf.staff_id FROM public.manager_salary_config cf WHERE cf.user_id = v_owner AND cf.is_active))
    AND public.vn_local_date(c.created_at) BETWEEN v_start AND v_end
    AND (public.vn_local_time(c.created_at) >= v_cutoff
         OR public.vn_local_dow(c.created_at) = ANY(v_weekend)
         OR EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(c.created_at)))

  UNION ALL
  -- (D) CASH: thu tiền mặt — hiển thị minh bạch, KHÔNG thưởng
  SELECT
    ie.salary_staff_id, 'CASH'::text, ie.id, ie.voucher_date,
    ''::text,
    'Thu tiền mặt' || COALESCE(' ' || r.name, ''),
    COALESCE(b.code, b.name, '') || COALESCE(' · ' || r.name, ''),
    NULL::text, false, 0::numeric, 0::numeric, 0::numeric, ie.total_amount, NULL::boolean,
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
