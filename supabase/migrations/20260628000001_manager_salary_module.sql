-- =============================================
-- Migration: Module Bảng lương quản lý (/finance/salary)
-- Description:
--   - manager_salary_config: ai hưởng lương + lương cứng, tiền phòng, mục tiêu, biệt danh (effective-dated)
--   - salary_bonus_rules: quy tắc thưởng cấu hình được (20k CN/Lễ, 50k HĐ ngoài giờ, mốc 18:00, cuối tuần, yêu cầu ảnh)
--   - salary_holidays: lịch ngày lễ cho quy tắc thưởng CN/Lễ
--   - salary_monthly: chốt lương theo quản lý/tháng (DRAFT/LOCKED) — đóng băng số liệu
--   - salary_adjustments: dòng thưởng/trừ thủ công (Bonus QL, fighting, hỗ trợ xăng…)
--   - salary_work_ledger_snapshot: đóng băng bảng kê khi chốt (bất biến lịch sử)
--   - job_types.bonus_amount/is_repair/counts_for_salary: thưởng theo loại việc
--   - income_expenses.salary_staff_id/salary_role: gắn phiếu HH Sale / ứng lương / thu tiền mặt cho 1 quản lý
--   - vn_local_*(): chuyển created_at (UTC) → giờ/thứ/ngày địa phương Asia/Ho_Chi_Minh
--   - salary_work_ledger(): bảng kê từng dòng việc/ngày CN-Lễ/HĐ/thu tiền + thưởng (nguồn sự thật quy tắc)
-- =============================================

BEGIN;

-- 0) Helper timezone: created_at là UTC → quy về giờ địa phương trước khi lấy thứ/giờ/ngày
CREATE OR REPLACE FUNCTION public.vn_local_date(ts timestamptz)
RETURNS date LANGUAGE sql IMMUTABLE AS $$ SELECT (ts AT TIME ZONE 'Asia/Ho_Chi_Minh')::date $$;
CREATE OR REPLACE FUNCTION public.vn_local_dow(ts timestamptz)
RETURNS int LANGUAGE sql IMMUTABLE AS $$ SELECT EXTRACT(DOW FROM (ts AT TIME ZONE 'Asia/Ho_Chi_Minh'))::int $$;  -- 0 = Chủ nhật
CREATE OR REPLACE FUNCTION public.vn_local_time(ts timestamptz)
RETURNS time LANGUAGE sql IMMUTABLE AS $$ SELECT (ts AT TIME ZONE 'Asia/Ho_Chi_Minh')::time $$;

-- 1) job_types: thưởng theo loại việc -------------------------------------
ALTER TABLE public.job_types
  ADD COLUMN IF NOT EXISTS bonus_amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_repair         BOOLEAN       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS counts_for_salary BOOLEAN       NOT NULL DEFAULT true;
COMMENT ON COLUMN public.job_types.bonus_amount IS 'Tiền thưởng khi hoàn thành 1 việc loại này (0 = không thưởng).';
COMMENT ON COLUMN public.job_types.is_repair IS 'Là việc sửa chữa — dùng cho quy tắc +20k cả ngày nếu rơi CN/Lễ.';

-- 2) income_expenses: gắn phiếu cho 1 quản lý hưởng lương -----------------
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS salary_staff_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS salary_role     TEXT CHECK (salary_role IN ('ADVANCE','CASH_COLLECTION','COMMISSION'));
CREATE INDEX IF NOT EXISTS idx_ie_salary_staff ON public.income_expenses(salary_staff_id) WHERE salary_staff_id IS NOT NULL;
COMMENT ON COLUMN public.income_expenses.salary_staff_id IS 'Người nhận là quản lý hưởng lương (HH Sale / ứng lương). Hiện dấu * trên form, kết toán vào lương khi DUYỆT.';
COMMENT ON COLUMN public.income_expenses.salary_role IS 'ADVANCE=ứng lương, CASH_COLLECTION=thu tiền mặt (không thưởng), COMMISSION=HH Sale.';

-- 3) manager_salary_config (ai hưởng lương; effective-dated) --------------
CREATE TABLE IF NOT EXISTS public.manager_salary_config (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- owner
  staff_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- = quản lý (auth.uid)
  base_salary       NUMERIC(15,2) NOT NULL DEFAULT 0,
  default_room_rent NUMERIC(15,2) NOT NULL DEFAULT 0,
  income_goal       NUMERIC(15,2) NOT NULL DEFAULT 0,
  role_title        TEXT NOT NULL DEFAULT 'Quản lý vận hành',
  alias             TEXT,
  effective_from    DATE NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date,
  effective_to      DATE,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_msc_staff ON public.manager_salary_config(staff_id, effective_from DESC);
CREATE INDEX IF NOT EXISTS idx_msc_user  ON public.manager_salary_config(user_id);
COMMENT ON TABLE public.manager_salary_config IS 'Quản lý hưởng lương + lương cứng/tiền phòng/mục tiêu. Tập dòng active = danh sách quản lý hưởng lương.';

-- 4) salary_bonus_rules (cấu hình thưởng; 1 dòng/owner) ------------------
CREATE TABLE IF NOT EXISTS public.salary_bonus_rules (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  rules      JSONB NOT NULL DEFAULT '{
    "repair": 30000,
    "weekendRepair": 20000,
    "afterHourContract": 50000,
    "afterHourMark": "18:00",
    "weekendDays": [0],
    "requirePhoto": false
  }'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5) salary_holidays ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.salary_holidays (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  holiday_date DATE NOT NULL,
  name         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, holiday_date)
);

-- 6) salary_monthly (chốt lương theo quản lý/tháng) ----------------------
CREATE TABLE IF NOT EXISTS public.salary_monthly (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- owner
  staff_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,   -- quản lý
  period_month      DATE NOT NULL,                                               -- ngày mùng 1
  status            TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','LOCKED')),
  base_salary       NUMERIC(15,2) NOT NULL DEFAULT 0,
  work_bonus        NUMERIC(15,2) NOT NULL DEFAULT 0,   -- việc + ngày CN/Lễ
  contract_bonus    NUMERIC(15,2) NOT NULL DEFAULT 0,   -- HĐ ngoài giờ/CN/lễ
  commission_total  NUMERIC(15,2) NOT NULL DEFAULT 0,   -- HH Sale (đã duyệt)
  investment_profit NUMERIC(15,2) NOT NULL DEFAULT 0,   -- lợi nhuận đầu tư (đã chốt)
  adjustments_total NUMERIC(15,2) NOT NULL DEFAULT 0,   -- tổng thưởng tay − trừ tay (có dấu)
  advances_total    NUMERIC(15,2) NOT NULL DEFAULT 0,   -- ứng lương
  room_rent         NUMERIC(15,2) NOT NULL DEFAULT 0,   -- tiền phòng
  gross_total       NUMERIC(15,2) NOT NULL DEFAULT 0,
  take_home         NUMERIC(15,2) NOT NULL DEFAULT 0,
  paid              NUMERIC(15,2) NOT NULL DEFAULT 0,
  payout_voucher_id UUID REFERENCES public.income_expenses(id) ON DELETE SET NULL,
  note              TEXT,
  locked_at         TIMESTAMPTZ,
  locked_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (staff_id, period_month)
);
CREATE INDEX IF NOT EXISTS idx_salary_monthly_user_period ON public.salary_monthly(user_id, period_month);

-- 7) salary_adjustments (thưởng/trừ thủ công) ----------------------------
CREATE TABLE IF NOT EXISTS public.salary_adjustments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  salary_monthly_id UUID NOT NULL REFERENCES public.salary_monthly(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('BONUS','DEDUCTION')),
  label             TEXT NOT NULL,
  amount            NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  note              TEXT,
  source            TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','ADVANCE_IE','ROOM_RENT','KPI')),
  income_expense_id UUID REFERENCES public.income_expenses(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sal_adj_monthly ON public.salary_adjustments(salary_monthly_id);

-- 8) salary_work_ledger_snapshot (đóng băng bảng kê khi chốt) ------------
CREATE TABLE IF NOT EXISTS public.salary_work_ledger_snapshot (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  salary_monthly_id UUID NOT NULL REFERENCES public.salary_monthly(id) ON DELETE CASCADE,
  staff_id          UUID NOT NULL,
  item_type         TEXT NOT NULL,
  source_id         UUID,
  occurred_date     DATE,
  day_label         TEXT,
  content           TEXT,
  place             TEXT,
  job_type_name     TEXT,
  is_repair         BOOLEAN,
  base_amount       NUMERIC(15,2),
  weekend_amount    NUMERIC(15,2),
  after_amount      NUMERIC(15,2),
  cash_amount       NUMERIC(15,2),
  has_photo         BOOLEAN,
  bonus_amount      NUMERIC(15,2),
  reason            TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sal_snap_monthly ON public.salary_work_ledger_snapshot(salary_monthly_id);

-- updated_at triggers (idempotent) ---------------------------------------
DROP TRIGGER IF EXISTS set_msc_updated_at ON public.manager_salary_config;
CREATE TRIGGER set_msc_updated_at BEFORE UPDATE ON public.manager_salary_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_sbr_updated_at ON public.salary_bonus_rules;
CREATE TRIGGER set_sbr_updated_at BEFORE UPDATE ON public.salary_bonus_rules
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_salary_monthly_updated_at ON public.salary_monthly;
CREATE TRIGGER set_salary_monthly_updated_at BEFORE UPDATE ON public.salary_monthly
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_sal_adj_updated_at ON public.salary_adjustments;
CREATE TRIGGER set_sal_adj_updated_at BEFORE UPDATE ON public.salary_adjustments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 9) RPC: bảng kê công việc (nguồn sự thật của mọi quy tắc thưởng) -------
CREATE OR REPLACE FUNCTION public.salary_work_ledger(
  p_period_month date,
  p_staff_id     uuid DEFAULT NULL
)
RETURNS TABLE (
  staff_id       uuid,
  item_type      text,
  source_id      uuid,
  occurred_date  date,
  day_label      text,
  content        text,
  place          text,
  job_type_name  text,
  is_repair      boolean,
  base_amount    numeric,
  weekend_amount numeric,
  after_amount   numeric,
  cash_amount    numeric,
  has_photo      boolean,
  bonus_amount   numeric,
  reason         text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
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
  WHERE j.user_id = v_owner
    AND j.status = 'COMPLETED'
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
    WHERE j.user_id = v_owner
      AND j.status = 'COMPLETED'
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
$$;
GRANT EXECUTE ON FUNCTION public.salary_work_ledger(date, uuid) TO authenticated;

-- 10) Seed: hạng mục chi lương + ứng lương cho owner ---------------------
INSERT INTO public.income_expense_types (user_id, name, type, category, is_default, is_deposit, description)
SELECT sa.user_id, v.name, 'expense', 'Lương', false, false, v.descr
FROM public.super_admins sa
CROSS JOIN (VALUES
  ('Lương quản lý', 'Phiếu chi trả lương quản lý — không tính KQKD'),
  ('Ứng lương quản lý', 'Phiếu chi ứng lương cho quản lý')
) AS v(name, descr)
WHERE NOT EXISTS (
  SELECT 1 FROM public.income_expense_types t
  WHERE t.user_id = sa.user_id AND lower(t.type) = 'expense' AND t.name = v.name
);

-- Seed: 1 dòng quy tắc thưởng mặc định cho owner
INSERT INTO public.salary_bonus_rules (user_id)
SELECT sa.user_id FROM public.super_admins sa
ON CONFLICT (user_id) DO NOTHING;

-- 11) RLS ----------------------------------------------------------------
ALTER TABLE public.manager_salary_config      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_bonus_rules         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_holidays            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_monthly             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_adjustments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.salary_work_ledger_snapshot ENABLE ROW LEVEL SECURITY;

-- manager_salary_config: owner/admin full; quản lý xem dòng của mình
DROP POLICY IF EXISTS msc_owner_all ON public.manager_salary_config;
CREATE POLICY msc_owner_all ON public.manager_salary_config TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS msc_self_select ON public.manager_salary_config;
CREATE POLICY msc_self_select ON public.manager_salary_config FOR SELECT TO authenticated
  USING (staff_id = auth.uid());

-- salary_bonus_rules / salary_holidays: owner/admin full (RPC đọc nội bộ)
DROP POLICY IF EXISTS sbr_owner_all ON public.salary_bonus_rules;
CREATE POLICY sbr_owner_all ON public.salary_bonus_rules TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS sh_owner_all ON public.salary_holidays;
CREATE POLICY sh_owner_all ON public.salary_holidays TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());

-- salary_monthly: owner/admin full; quản lý xem của mình
DROP POLICY IF EXISTS sm_owner_all ON public.salary_monthly;
CREATE POLICY sm_owner_all ON public.salary_monthly TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS sm_self_select ON public.salary_monthly;
CREATE POLICY sm_self_select ON public.salary_monthly FOR SELECT TO authenticated
  USING (staff_id = auth.uid());

-- salary_adjustments: owner/admin full; quản lý xem qua salary_monthly của mình
DROP POLICY IF EXISTS sa_owner_all ON public.salary_adjustments;
CREATE POLICY sa_owner_all ON public.salary_adjustments TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS sa_self_select ON public.salary_adjustments;
CREATE POLICY sa_self_select ON public.salary_adjustments FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.salary_monthly sm WHERE sm.id = salary_adjustments.salary_monthly_id AND sm.staff_id = auth.uid()));

-- salary_work_ledger_snapshot: owner/admin full; quản lý xem của mình
DROP POLICY IF EXISTS sws_owner_all ON public.salary_work_ledger_snapshot;
CREATE POLICY sws_owner_all ON public.salary_work_ledger_snapshot TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS sws_self_select ON public.salary_work_ledger_snapshot;
CREATE POLICY sws_self_select ON public.salary_work_ledger_snapshot FOR SELECT TO authenticated
  USING (staff_id = auth.uid());

-- income_expenses: quản lý xem phiếu HH Sale / ứng gắn mình
DROP POLICY IF EXISTS income_expenses_select_salary_staff ON public.income_expenses;
CREATE POLICY income_expenses_select_salary_staff ON public.income_expenses FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND salary_staff_id = auth.uid());

COMMIT;

NOTIFY pgrst, 'reload schema';
