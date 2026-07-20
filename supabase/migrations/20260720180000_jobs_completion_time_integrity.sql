-- =============================================
-- Migration: Chot "thoi diem tinh luong = LUC HOAN THANH" bang rang buoc SERVER
--
-- BOI CANH (audit 2026-07-20): toan bo engine luong (legacy `salary_work_ledger`
--   lan V5 `v5_tick_from_job`) da bucket dung theo
--   `vn_local_date(COALESCE(j.completion_time, j.created_at))`. NHUNG gia tri
--   `completion_time` lai den tu mot o <input type="datetime-local"> go tay,
--   ghi thang qua PostgREST — khong trigger, khong CHECK, khong DEFAULT.
--   => Nguoi duoc tra luong tu chon duoc ky luong va he so nhan (ngoai gio /
--      CN / Le). Watermark tren anh ghi gio that nhung khong code nao doc.
--
-- MIGRATION NAY LAM 5 VIEC:
--   (1) Them cot `jobs.completion_captured_at` — moc CHUP THAT do client gui
--       kem (cung bien `at` da ve vao watermark), de doi chieu duoc bang SQL.
--   (2) Trigger `jobs_stamp_completion_time`: khi chuyen sang COMPLETED thi
--       SERVER dong dau `now()`. Nhan vien thuong KHONG dat duoc gia tri khac.
--       Admin duoc phep lui ngay (co truong hop nghiep vu that), tru khi ky
--       luong tuong ung DA CHOT (LOCKED) — chan double-pay qua ranh gioi chot.
--   (3) Backfill + CHECK `status <> 'COMPLETED' OR completion_time IS NOT NULL`.
--       Sau buoc nay fallback `COALESCE(..., created_at)` thanh code chet.
--   (4) Helper `public.job_photo_ok(completion_attachments, attachments)` —
--       BUG: `useJobs.ts` ghi anh vao `jobs.attachments` nhung ledger va
--       `award_job_bonus` lai gate tren `completion_attachments`. Production:
--       169 job COMPLETED -> 0 dong co completion_attachments, 88 dong co
--       attachments => has_photo = false cho 100% job. Bat `requirePhoto` la
--       thuong ve 0d toan bo. V5 da ne loi nay tu 20260703000001; legacy chua.
--   (5) Dinh nghia lai `salary_work_ledger` + `award_job_bonus`: dung helper
--       tren, va bo `COALESCE(..., created_at)` -> `j.completion_time` tran
--       (da co CHECK bao dam NOT NULL) de sai sot no to thay vi am tham tinh
--       theo ngay TAO.
--
-- An toan: kiem tra 2026-07-20 — `salary_monthly` toan DRAFT (locked_at NULL),
--   `salary_work_ledger_snapshot` rong => khong pha snapshot nao.
-- =============================================

BEGIN;

-- ---------------------------------------------------------------------------
-- (1) Cot moc chup that
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS completion_captured_at TIMESTAMPTZ;

COMMENT ON COLUMN public.jobs.completion_captured_at IS
  'Moc bam nut CHUP tren may nhan vien (cung gia tri da ve vao watermark anh). '
  'Chi de DOI CHIEU/audit — KHONG dung tinh luong (dong ho client gia mao duoc). '
  'Tien luon tinh theo completion_time do server dong dau.';

-- ---------------------------------------------------------------------------
-- (3a) Backfill truoc khi them CHECK
-- ---------------------------------------------------------------------------
UPDATE public.jobs
SET completion_time = COALESCE(updated_at, created_at)
WHERE status = 'COMPLETED' AND completion_time IS NULL;

-- ---------------------------------------------------------------------------
-- (2) Trigger dong dau completion_time phia SERVER
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jobs_stamp_completion_time()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_admin  BOOLEAN := public.is_admin() OR public.is_super_admin();
  v_old_pm DATE;
  v_new_pm DATE;
BEGIN
  -- Chuyen SANG hoan thanh (insert thang COMPLETED cung tinh)
  IF NEW.status = 'COMPLETED' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'COMPLETED') THEN
    -- Admin duoc phep khai gio hoan thanh (lui ngay nghiep vu); nguoi thuong thi KHONG.
    IF NOT v_admin OR NEW.completion_time IS NULL THEN
      NEW.completion_time := now();
    END IF;
    -- Chan gio tuong lai trong moi truong hop — khong ai hoan thanh viec o thi tuong lai.
    IF NEW.completion_time > now() + INTERVAL '1 minute' THEN
      RAISE EXCEPTION 'Thoi gian hoan thanh khong duoc o tuong lai (%).', NEW.completion_time
        USING HINT = 'completion_time do server dong dau; kiem tra dong ho thiet bi.';
    END IF;
    RETURN NEW;
  END IF;

  -- Sua completion_time tren dong DA hoan thanh
  IF TG_OP = 'UPDATE' AND OLD.status = 'COMPLETED'
     AND NEW.completion_time IS DISTINCT FROM OLD.completion_time THEN
    IF NOT v_admin THEN
      RAISE EXCEPTION 'Khong duoc sua thoi gian hoan thanh cua cong viec da xong.'
        USING HINT = 'Lien he quan ly neu can dieu chinh — thao tac nay co kiem soat.';
    END IF;
    -- Admin: van chan neu ky luong (cu HOAC moi) da CHOT — tranh tra hai lan.
    v_old_pm := date_trunc('month', public.vn_local_date(OLD.completion_time))::date;
    v_new_pm := date_trunc('month', public.vn_local_date(NEW.completion_time))::date;
    IF EXISTS (
      SELECT 1 FROM public.salary_monthly sm
      WHERE sm.staff_id = OLD.assignee_id
        AND sm.period_month IN (v_old_pm, v_new_pm)
        AND sm.locked_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Ky luong lien quan da chot — khong the doi thoi gian hoan thanh.'
        USING HINT = 'Mo khoa ky luong truoc, hoac dung phieu dieu chinh.';
    END IF;
  END IF;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trigger_jobs_stamp_completion_time ON public.jobs;
CREATE TRIGGER trigger_jobs_stamp_completion_time
  BEFORE INSERT OR UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_stamp_completion_time();

-- ---------------------------------------------------------------------------
-- (3b) CHECK: da COMPLETED thi bat buoc co completion_time
-- ---------------------------------------------------------------------------
ALTER TABLE public.jobs
  DROP CONSTRAINT IF EXISTS jobs_completed_needs_completion_time;
ALTER TABLE public.jobs
  ADD CONSTRAINT jobs_completed_needs_completion_time
  CHECK (status <> 'COMPLETED' OR completion_time IS NOT NULL) NOT VALID;
ALTER TABLE public.jobs VALIDATE CONSTRAINT jobs_completed_needs_completion_time;

-- ---------------------------------------------------------------------------
-- (4) Helper cong anh — chap nhan CA HAI cot
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.job_photo_ok(p_completion jsonb, p_attachments jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT (jsonb_typeof(COALESCE(p_completion, '[]'::jsonb)) = 'array'
          AND jsonb_array_length(COALESCE(p_completion, '[]'::jsonb)) > 0)
      OR (jsonb_typeof(COALESCE(p_attachments, '[]'::jsonb)) = 'array'
          AND jsonb_array_length(COALESCE(p_attachments, '[]'::jsonb)) > 0);
$$;

COMMENT ON FUNCTION public.job_photo_ok(jsonb, jsonb) IS
  'Bang chung anh hoan thanh: FE tung ghi vao `attachments` thay vi '
  '`completion_attachments` nen phai chap nhan ca hai (xem 20260720180000).';

-- ---------------------------------------------------------------------------
-- (5a) salary_work_ledger — cong anh 2-cot + bo fallback created_at
--      Signature GIU NGUYEN so voi 20260720160000 (khong can DROP).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.salary_work_ledger(p_period_month date, p_staff_id uuid DEFAULT NULL::uuid)
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
    public.vn_local_date(j.completion_time),
    CASE
      WHEN EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(j.completion_time)) THEN 'Lễ'
      WHEN public.vn_local_dow(j.completion_time) = ANY(v_weekend) THEN 'CN'
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
    public.job_photo_ok(j.completion_attachments, j.attachments),
    CASE
      WHEN COALESCE(jt.counts_for_salary, true)
       AND NOT COALESCE(j.exclude_from_salary, false)
       AND (NOT v_photo OR public.job_photo_ok(j.completion_attachments, j.attachments))
       AND (NOT COALESCE(jt.is_contract, false)
            OR public.vn_local_time(j.completion_time) >= v_cutoff
            OR public.vn_local_dow(j.completion_time) = ANY(v_weekend)
            OR EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(j.completion_time)))
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
    AND public.vn_local_date(j.completion_time) BETWEEN v_start AND v_end

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
      public.vn_local_date(j.completion_time) AS ld,
      EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(j.completion_time)) AS is_holiday
    FROM public.jobs j
    JOIN public.job_types jt ON jt.id = j.job_type_id
    WHERE j.status = 'COMPLETED'
      AND (COALESCE(jt.is_repair, false) OR COALESCE(jt.is_contract, false))
      AND NOT COALESCE(j.exclude_from_salary, false)
      AND j.assignee_id IS NOT NULL
      AND (v_staff IS NOT NULL AND j.assignee_id = v_staff
           OR v_staff IS NULL AND j.assignee_id IN (SELECT c.staff_id FROM public.manager_salary_config c WHERE c.user_id = v_owner AND c.is_active))
      AND public.vn_local_date(j.completion_time) BETWEEN v_start AND v_end
      AND (public.vn_local_dow(j.completion_time) = ANY(v_weekend)
           OR EXISTS (SELECT 1 FROM public.salary_holidays h WHERE h.user_id = v_owner AND h.holiday_date = public.vn_local_date(j.completion_time)))
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

-- ---------------------------------------------------------------------------
-- (5b) award_job_bonus — cong anh 2-cot + bo fallback created_at.
--      Signature GIU NGUYEN so voi 20260630000005.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.award_job_bonus(p_job_id uuid)
RETURNS TABLE (
  bonus_kind   text,
  amount       numeric,
  label        text,
  note         text,
  place        text,
  content      text,
  icon         text,
  time_context text,
  notif_id     uuid
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
  v_time_ctx   text;
  v_amt        numeric;
  v_label      text;
  v_note       text;
  v_content    text;
  v_icon       text;
  v_nid        uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  v_owner := (SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1);

  -- Verify: job COMPLETED + assignee = chinh minh. KHONG loc j.user_id.
  SELECT
    j.id,
    j.title,
    j.job_type_id,
    j.building_id,
    j.room_id,
    public.job_photo_ok(j.completion_attachments, j.attachments) AS photo_ok,
    public.vn_local_date(j.completion_time) AS ld,
    public.vn_local_dow(j.completion_time)  AS dow,
    public.vn_local_time(j.completion_time) AS ltime
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

  -- Ngu canh thoi gian de FE chon skin popup (uu tien Le > CN > ngoai gio > thuong)
  v_time_ctx := CASE
                  WHEN v_is_holiday              THEN 'HOLIDAY'
                  WHEN v_job.dow = ANY(v_weekend) THEN 'SUNDAY'
                  WHEN v_job.ltime >= v_cutoff   THEN 'AFTER_HOURS'
                  ELSE 'NORMAL'
                END;

  -- (A) JOB: thuong theo loai viec; ky HD (is_contract) can sau gio/CN-Le
  IF v_jt.counts_for_salary
     AND v_jt.bonus_amount > 0
     AND (NOT v_photo OR v_job.photo_ok)
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
    v_note  := NULLIF(btrim(COALESCE(v_job.title, '')), '');
    v_icon  := CASE WHEN v_jt.is_repair THEN '🔧'
                    WHEN v_jt.is_contract THEN '📝'
                    ELSE '💰' END;
    v_content := public.fmt_bonus_k(v_amt) || ' ' || COALESCE(v_label, 'Việc')
                 || CASE WHEN v_note IS NOT NULL AND v_note <> v_label THEN ' · ' || v_note ELSE '' END
                 || CASE WHEN v_place <> '' THEN ' · ' || v_place ELSE '' END;
    INSERT INTO public.notifications (user_id, type, channel, status, subject, content, job_id, metadata)
    VALUES (v_uid, 'SALARY_BONUS', 'IN_APP', 'PENDING', 'Thưởng công việc', v_content, p_job_id,
            jsonb_build_object('bonus_kind', 'JOB', 'amount', v_amt, 'label', v_label, 'note', v_note,
                               'place', v_place, 'bonus_date', v_job.ld::text, 'icon', v_icon,
                               'time_context', v_time_ctx))
    RETURNING id INTO v_nid;
    bonus_kind := 'JOB'; amount := v_amt; label := v_label; note := v_note; place := v_place;
    content := v_content; icon := v_icon; time_context := v_time_ctx; notif_id := v_nid;
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
    v_note  := NULL;
    v_icon  := '🔥';
    v_content := public.fmt_bonus_k(v_amt) || ' ' || v_label;
    INSERT INTO public.notifications (user_id, type, channel, status, subject, content, job_id, metadata)
    VALUES (v_uid, 'SALARY_BONUS', 'IN_APP', 'PENDING', 'Thưởng công việc', v_content, p_job_id,
            jsonb_build_object('bonus_kind', 'DAY_BONUS', 'amount', v_amt, 'label', v_label, 'note', NULL,
                               'place', '', 'bonus_date', v_job.ld::text, 'icon', v_icon,
                               'time_context', v_time_ctx))
    RETURNING id INTO v_nid;
    bonus_kind := 'DAY_BONUS'; amount := v_amt; label := v_label; note := v_note; place := '';
    content := v_content; icon := v_icon; time_context := v_time_ctx; notif_id := v_nid;
    RETURN NEXT;
  END IF;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.award_job_bonus(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.job_photo_ok(jsonb, jsonb) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
