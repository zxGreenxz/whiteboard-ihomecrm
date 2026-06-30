-- =============================================
-- Migration: Quy tac thuong "ky HD" co dieu kien + phu cap ngay CN/Le mo rong
-- Description:
--   - job_types.is_contract: la viec ky hop dong (checkin) — CHI +thuong khi
--     hoan thanh SAU afterHourMark (18h) HOAC CN/Le (mac dinh false → an toan,
--     khong loai viec cu nao bi anh huong).
--   - salary_work_ledger:
--       (A) JOB: viec is_contract chi cong bonus_amount khi sau gio HOAC CN/Le
--       (B) DAY_BONUS: phu cap CN/Le ap cho is_repair HOAC is_contract
--   - award_job_bonus: dong bo dung quy tac tren + tra them cot `icon` cho FE
--     (🔧 sua chua / 📝 ky HD / 🔥 phu cap), doi label phu cap "Phu cap …".
--   Moc thoi gian xet = completion_time cua viec.
-- =============================================

BEGIN;

-- 1) Co loai viec ky HD ----------------------------------------------------
ALTER TABLE public.job_types
  ADD COLUMN IF NOT EXISTS is_contract boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.job_types.is_contract IS
  'La viec ky hop dong (checkin) — chi +thuong khi hoan thanh sau afterHourMark HOAC CN/Le.';

-- 2) salary_work_ledger: nhanh (A) JOB + (B) DAY_BONUS --------------------
-- (Copy tu 20260629000004 + 2 chinh sua; (C)(D) giu nguyen.)
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
  v_wk_day  numeric;
  v_after   numeric;
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
  v_after   := COALESCE((v_rules->>'afterHourContract')::numeric, 50000);
  v_cutoff  := COALESCE((v_rules->>'afterHourMark'), '18:00')::time;
  v_photo   := COALESCE((v_rules->>'requirePhoto')::boolean, false);
  SELECT COALESCE(array_agg((e)::int), ARRAY[0]) INTO v_weekend
  FROM jsonb_array_elements_text(COALESCE(v_rules->'weekendDays', '[0]'::jsonb)) e;

  RETURN QUERY
  -- (A) JOB: viec da hoan thanh, loai viec tinh luong (co thuong hoac la sua chua)
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
    ''::text, NULL::text, true, 0::numeric, v_wk_day, 0::numeric, NULL::numeric, NULL::boolean,
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
  -- (C) CONTRACT: HD tao sau 18:00 HOAC Chu nhat/Le → +50k (GIU NGUYEN)
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
  -- (D) CASH: thu tien mat — hien thi minh bach, KHONG thuong (GIU NGUYEN)
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

-- 3) award_job_bonus: dong bo quy tac + cot icon -------------------------
DROP FUNCTION IF EXISTS public.award_job_bonus(uuid);
CREATE FUNCTION public.award_job_bonus(p_job_id uuid)
RETURNS TABLE (
  bonus_kind text,
  amount     numeric,
  label      text,
  place      text,
  content    text,
  icon       text,
  notif_id   uuid
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_owner      uuid;
  v_rules      jsonb;
  v_weekend    int[];
  v_wk_day     numeric;
  v_cutoff     time;
  v_photo      boolean;
  v_job        record;
  v_jt         record;
  v_bld        text;
  v_room       text;
  v_place      text;
  v_is_holiday boolean;
  v_is_we      boolean;
  v_amt        numeric;
  v_label      text;
  v_content    text;
  v_icon       text;
  v_nid        uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  v_owner := (SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1);

  -- Verify: job COMPLETED + assignee = chinh minh. KHONG loc j.user_id.
  SELECT
    j.id,
    j.job_type_id,
    j.building_id,
    j.room_id,
    j.completion_attachments,
    public.vn_local_date(COALESCE(j.completion_time, j.created_at)) AS ld,
    public.vn_local_dow(COALESCE(j.completion_time, j.created_at))  AS dow,
    public.vn_local_time(COALESCE(j.completion_time, j.created_at)) AS ltime
  INTO v_job
  FROM public.jobs j
  WHERE j.id = p_job_id
    AND j.status = 'COMPLETED'
    AND j.assignee_id = v_uid;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT
    jt.name,
    COALESCE(jt.bonus_amount, 0)         AS bonus_amount,
    COALESCE(jt.is_repair, false)        AS is_repair,
    COALESCE(jt.is_contract, false)      AS is_contract,
    COALESCE(jt.counts_for_salary, true) AS counts_for_salary
  INTO v_jt
  FROM public.job_types jt
  WHERE jt.id = v_job.job_type_id;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT r.rules INTO v_rules FROM public.salary_bonus_rules r WHERE r.user_id = v_owner;
  v_rules  := COALESCE(v_rules, '{}'::jsonb);
  v_wk_day := COALESCE((v_rules->>'weekendRepair')::numeric, 20000);
  v_cutoff := COALESCE((v_rules->>'afterHourMark'), '18:00')::time;
  v_photo  := COALESCE((v_rules->>'requirePhoto')::boolean, false);
  SELECT COALESCE(array_agg((e)::int), ARRAY[0]) INTO v_weekend
  FROM jsonb_array_elements_text(COALESCE(v_rules->'weekendDays', '[0]'::jsonb)) e;

  SELECT COALESCE(b.code, b.name) INTO v_bld
  FROM public.buildings b WHERE b.id = v_job.building_id;
  SELECT rm.name INTO v_room
  FROM public.rooms rm WHERE rm.id = v_job.room_id;
  v_place := COALESCE(v_bld, '') || COALESCE(' · ' || v_room, '');

  v_is_holiday := EXISTS (
    SELECT 1 FROM public.salary_holidays h
    WHERE h.user_id = v_owner AND h.holiday_date = v_job.ld
  );
  v_is_we := (v_job.dow = ANY(v_weekend)) OR v_is_holiday;

  -- (A) JOB: thuong theo loai viec; ky HD (is_contract) can sau gio HOAC CN/Le
  IF v_jt.counts_for_salary
     AND v_jt.bonus_amount > 0
     AND (NOT v_photo OR (
            v_job.completion_attachments IS NOT NULL
            AND jsonb_typeof(v_job.completion_attachments) = 'array'
            AND jsonb_array_length(v_job.completion_attachments) > 0))
     AND (NOT v_jt.is_contract OR v_job.ltime >= v_cutoff OR v_is_we)
     AND NOT EXISTS (
            SELECT 1 FROM public.notifications n
            WHERE n.user_id = v_uid
              AND n.job_id = p_job_id
              AND n.type = 'SALARY_BONUS'
              AND n.metadata->>'bonus_kind' = 'JOB')
  THEN
    v_amt   := v_jt.bonus_amount;
    v_label := v_jt.name;
    v_icon  := CASE WHEN v_jt.is_repair THEN '🔧'
                    WHEN v_jt.is_contract THEN '📝'
                    ELSE '💰' END;
    v_content := public.fmt_bonus_k(v_amt) || ' ' || COALESCE(v_label, 'Việc')
                 || CASE WHEN v_place <> '' THEN ' · ' || v_place ELSE '' END;
    INSERT INTO public.notifications (user_id, type, channel, status, subject, content, job_id, metadata)
    VALUES (v_uid, 'SALARY_BONUS', 'IN_APP', 'PENDING', 'Thưởng công việc', v_content, p_job_id,
            jsonb_build_object('bonus_kind', 'JOB', 'amount', v_amt, 'label', v_label,
                               'place', v_place, 'bonus_date', v_job.ld::text, 'icon', v_icon))
    RETURNING id INTO v_nid;
    bonus_kind := 'JOB'; amount := v_amt; label := v_label; place := v_place;
    content := v_content; icon := v_icon; notif_id := v_nid;
    RETURN NEXT;
  END IF;

  -- (B) DAY_BONUS: phu cap CN/Le (sua chua HOAC ky HD), 1 lan/ngay
  IF (v_jt.is_repair OR v_jt.is_contract)
     AND v_is_we
     AND NOT EXISTS (
            SELECT 1 FROM public.notifications n
            WHERE n.user_id = v_uid
              AND n.type = 'SALARY_BONUS'
              AND n.metadata->>'bonus_kind' = 'DAY_BONUS'
              AND n.metadata->>'bonus_date' = v_job.ld::text)
  THEN
    v_amt   := v_wk_day;
    v_label := CASE WHEN v_is_holiday THEN 'Phụ cấp ngày Lễ'
                    ELSE 'Phụ cấp Chủ Nhật' END;
    v_icon  := '🔥';
    v_content := public.fmt_bonus_k(v_amt) || ' ' || v_label;
    INSERT INTO public.notifications (user_id, type, channel, status, subject, content, job_id, metadata)
    VALUES (v_uid, 'SALARY_BONUS', 'IN_APP', 'PENDING', 'Thưởng công việc', v_content, p_job_id,
            jsonb_build_object('bonus_kind', 'DAY_BONUS', 'amount', v_amt, 'label', v_label,
                               'place', '', 'bonus_date', v_job.ld::text, 'icon', v_icon))
    RETURNING id INTO v_nid;
    bonus_kind := 'DAY_BONUS'; amount := v_amt; label := v_label; place := '';
    content := v_content; icon := v_icon; notif_id := v_nid;
    RETURN NEXT;
  END IF;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.award_job_bonus(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
