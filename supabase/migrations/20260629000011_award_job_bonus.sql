-- =============================================
-- Migration: Thong bao thuong khi hoan thanh cong viec (award_job_bonus)
-- Description:
--   - notifications: them cot job_id + metadata (jsonb) de luu + dedup thong bao thuong
--   - 2 partial unique index chong race / re-complete (1 JOB / job, 1 DAY_BONUS / ngay)
--   - fmt_bonus_k(): format tien thuong "+30K"
--   - award_job_bonus(p_job_id): SECURITY DEFINER — tinh thuong cho 1 job vua hoan thanh,
--     tai dung DUNG quy tac nhanh (A) JOB + (B) DAY_BONUS cua salary_work_ledger
--     (xem 20260628000001 + ban va owner-scope 20260629000004). INSERT notifications +
--     tra ve CHI cac dong MOI award (FE hien toast + self-push).
--   - Nguoi nhan = jobs.assignee_id = auth.uid() (nguoi tu hoan thanh tai cho).
--   - Scope tenant theo assignee (KHONG loc j.user_id) — giong ban va 20260629000004.
--   - PHAI chay SAU file 20260629000010 (da them gia tri enum 'SALARY_BONUS').
-- =============================================

BEGIN;

-- 1) notifications: cot dedup + hien thi ----------------------------------
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS job_id   UUID REFERENCES public.jobs(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN public.notifications.metadata IS
  'Thuong viec: { bonus_kind:JOB|DAY_BONUS, amount, label, place, bonus_date }.';

-- 2) Partial unique index — luoi an toan chong trung (race / re-complete) --
CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_bonus_job
  ON public.notifications (user_id, job_id)
  WHERE type = 'SALARY_BONUS' AND (metadata->>'bonus_kind') = 'JOB';

CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_bonus_day
  ON public.notifications (user_id, (metadata->>'bonus_date'))
  WHERE type = 'SALARY_BONUS' AND (metadata->>'bonus_kind') = 'DAY_BONUS';

-- 3) Helper format tien: 30000 -> '+30K' ---------------------------------
CREATE OR REPLACE FUNCTION public.fmt_bonus_k(amt numeric)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT '+' || trim(to_char(round(amt / 1000), 'FM999990')) || 'K'
$$;

-- 4) RPC: tinh + ghi thong bao thuong cho 1 job vua hoan thanh ------------
CREATE OR REPLACE FUNCTION public.award_job_bonus(p_job_id uuid)
RETURNS TABLE (
  bonus_kind text,
  amount     numeric,
  label      text,
  place      text,
  content    text,
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
  v_nid        uuid;
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;

  -- Owner = super_admin dau tien (chi dung de doc rules + holidays cua owner)
  v_owner := (SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1);

  -- Verify: job COMPLETED + assignee = chinh minh. KHONG loc j.user_id
  -- (job tao boi nhieu staff — scope theo assignee, giong ban va 20260629000004).
  SELECT
    j.id,
    j.job_type_id,
    j.building_id,
    j.room_id,
    j.completion_attachments,
    public.vn_local_date(COALESCE(j.completion_time, j.created_at)) AS ld,
    public.vn_local_dow(COALESCE(j.completion_time, j.created_at))  AS dow
  INTO v_job
  FROM public.jobs j
  WHERE j.id = p_job_id
    AND j.status = 'COMPLETED'
    AND j.assignee_id = v_uid;
  IF NOT FOUND THEN RETURN; END IF;   -- owner lam ho / khong phai cua minh -> rong

  SELECT
    jt.name,
    COALESCE(jt.bonus_amount, 0)       AS bonus_amount,
    COALESCE(jt.is_repair, false)      AS is_repair,
    COALESCE(jt.counts_for_salary, true) AS counts_for_salary
  INTO v_jt
  FROM public.job_types jt
  WHERE jt.id = v_job.job_type_id;
  IF NOT FOUND THEN RETURN; END IF;

  -- Rules cua owner (giong salary_work_ledger)
  SELECT r.rules INTO v_rules FROM public.salary_bonus_rules r WHERE r.user_id = v_owner;
  v_rules  := COALESCE(v_rules, '{}'::jsonb);
  v_wk_day := COALESCE((v_rules->>'weekendRepair')::numeric, 20000);
  v_photo  := COALESCE((v_rules->>'requirePhoto')::boolean, false);
  SELECT COALESCE(array_agg((e)::int), ARRAY[0]) INTO v_weekend
  FROM jsonb_array_elements_text(COALESCE(v_rules->'weekendDays', '[0]'::jsonb)) e;

  -- place = ma toa/phong  (giong ledger: COALESCE(b.code,b.name,'') || COALESCE(' · '||r.name,''))
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

  -- (A) JOB: thuong theo loai viec ---------------------------------------
  IF v_jt.counts_for_salary
     AND v_jt.bonus_amount > 0
     AND (NOT v_photo OR (
            v_job.completion_attachments IS NOT NULL
            AND jsonb_typeof(v_job.completion_attachments) = 'array'
            AND jsonb_array_length(v_job.completion_attachments) > 0))
     AND NOT EXISTS (
            SELECT 1 FROM public.notifications n
            WHERE n.user_id = v_uid
              AND n.job_id = p_job_id
              AND n.type = 'SALARY_BONUS'
              AND n.metadata->>'bonus_kind' = 'JOB')
  THEN
    v_amt   := v_jt.bonus_amount;
    v_label := v_jt.name;
    v_content := public.fmt_bonus_k(v_amt) || ' ' || COALESCE(v_label, 'Việc')
                 || CASE WHEN v_place <> '' THEN ' · ' || v_place ELSE '' END;
    INSERT INTO public.notifications (user_id, type, channel, status, subject, content, job_id, metadata)
    VALUES (v_uid, 'SALARY_BONUS', 'IN_APP', 'PENDING', 'Thưởng công việc', v_content, p_job_id,
            jsonb_build_object('bonus_kind', 'JOB', 'amount', v_amt, 'label', v_label,
                               'place', v_place, 'bonus_date', v_job.ld::text))
    RETURNING id INTO v_nid;
    bonus_kind := 'JOB'; amount := v_amt; label := v_label; place := v_place;
    content := v_content; notif_id := v_nid;
    RETURN NEXT;
  END IF;

  -- (B) DAY_BONUS: +weekendRepair cho viec sua chua roi CN/Le (1 lan/ngay)
  IF v_jt.is_repair
     AND v_is_we
     AND NOT EXISTS (
            SELECT 1 FROM public.notifications n
            WHERE n.user_id = v_uid
              AND n.type = 'SALARY_BONUS'
              AND n.metadata->>'bonus_kind' = 'DAY_BONUS'
              AND n.metadata->>'bonus_date' = v_job.ld::text)
  THEN
    v_amt   := v_wk_day;
    v_label := CASE WHEN v_is_holiday THEN 'Thưởng làm việc ngày Lễ'
                    ELSE 'Thưởng làm việc Chủ nhật' END;
    v_content := public.fmt_bonus_k(v_amt) || ' ' || v_label;
    INSERT INTO public.notifications (user_id, type, channel, status, subject, content, job_id, metadata)
    VALUES (v_uid, 'SALARY_BONUS', 'IN_APP', 'PENDING', 'Thưởng công việc', v_content, p_job_id,
            jsonb_build_object('bonus_kind', 'DAY_BONUS', 'amount', v_amt, 'label', v_label,
                               'place', '', 'bonus_date', v_job.ld::text))
    RETURNING id INTO v_nid;
    bonus_kind := 'DAY_BONUS'; amount := v_amt; label := v_label; place := '';
    content := v_content; notif_id := v_nid;
    RETURN NEXT;
  END IF;

  RETURN;
END;
$$;

GRANT EXECUTE ON FUNCTION public.award_job_bonus(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
