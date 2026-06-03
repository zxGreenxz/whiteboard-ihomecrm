-- =============================================
-- Migration: Module Chia lợi nhuận cổ đông + Ví thu chi cá nhân
-- Description:
--   - shareholders: cổ đông (gắn 1 tài khoản đăng nhập qua auth_user_id)
--   - building_shareholders: tỷ lệ % của cổ đông theo từng tòa
--   - profit_monthly: chốt LN theo nhà/tháng (computed + adjusted "Sau khi Trừ TP", DRAFT/LOCKED)
--   - profit_allocations: snapshot phần mỗi cổ đông tại thời điểm chốt (số đã chốt không đổi)
--   - personal_transactions: ví thu chi cá nhân (own-only, KHÔNG vào income_expenses)
--   - income_expenses.shareholder_id: gắn phiếu chi chia LN với cổ đông ("đã ứng")
--   - current_shareholder_id(): map auth.uid() → shareholders.id
--   - monthly_building_profit(): LN theo nhà cho 1 khoảng (chỉ khoản KQKD)
-- =============================================

BEGIN;

-- 1) shareholders ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.shareholders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  note         TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at   TIMESTAMPTZ,
  CONSTRAINT shareholders_name_not_empty CHECK (char_length(name) > 0)
);
CREATE INDEX IF NOT EXISTS idx_shareholders_user_id   ON public.shareholders(user_id)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_shareholders_auth_user ON public.shareholders(auth_user_id)  WHERE auth_user_id IS NOT NULL;
COMMENT ON TABLE public.shareholders IS 'Cổ đông. auth_user_id = tài khoản đăng nhập của cổ đông (để tự xem phần của mình).';

-- 2) building_shareholders (tỷ lệ % theo tòa) ----------------------------
CREATE TABLE IF NOT EXISTS public.building_shareholders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  building_id    UUID NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  shareholder_id UUID NOT NULL REFERENCES public.shareholders(id) ON DELETE CASCADE,
  percent        NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (percent >= 0 AND percent <= 100),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (building_id, shareholder_id)
);
CREATE INDEX IF NOT EXISTS idx_bldg_sh_building    ON public.building_shareholders(building_id);
CREATE INDEX IF NOT EXISTS idx_bldg_sh_shareholder ON public.building_shareholders(shareholder_id);

-- 3) profit_monthly (chốt LN theo nhà/tháng) -----------------------------
CREATE TABLE IF NOT EXISTS public.profit_monthly (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  building_id     UUID NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  period_month    DATE NOT NULL,            -- luôn là ngày mùng 1
  computed_profit NUMERIC(15,2) NOT NULL DEFAULT 0,
  adjusted_profit NUMERIC(15,2) NOT NULL DEFAULT 0,  -- "Sau khi Trừ TP"
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','LOCKED')),
  note            TEXT,
  locked_at       TIMESTAMPTZ,
  locked_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (building_id, period_month)
);
CREATE INDEX IF NOT EXISTS idx_profit_monthly_user_period ON public.profit_monthly(user_id, period_month);

-- 4) profit_allocations (snapshot phần mỗi cổ đông) ----------------------
CREATE TABLE IF NOT EXISTS public.profit_allocations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  profit_monthly_id UUID NOT NULL REFERENCES public.profit_monthly(id) ON DELETE CASCADE,
  shareholder_id    UUID NOT NULL REFERENCES public.shareholders(id) ON DELETE CASCADE,
  percent           NUMERIC(5,2)  NOT NULL DEFAULT 0,   -- snapshot
  amount            NUMERIC(15,2) NOT NULL DEFAULT 0,   -- snapshot = adjusted_profit * percent/100
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profit_monthly_id, shareholder_id)
);
CREATE INDEX IF NOT EXISTS idx_alloc_shareholder ON public.profit_allocations(shareholder_id);
CREATE INDEX IF NOT EXISTS idx_alloc_user        ON public.profit_allocations(user_id);

-- 5) personal_transactions (ví cá nhân, own-only) ------------------------
CREATE TABLE IF NOT EXISTS public.personal_transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('INCOME','EXPENSE')),
  amount      NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  description TEXT,
  txn_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  category    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_personal_txn_user_date ON public.personal_transactions(user_id, txn_date) WHERE deleted_at IS NULL;
COMMENT ON TABLE public.personal_transactions IS 'Ví thu chi cá nhân của từng user — tách biệt, KHÔNG ảnh hưởng báo cáo hệ thống.';

-- 6) income_expenses.shareholder_id --------------------------------------
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS shareholder_id UUID REFERENCES public.shareholders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_income_expenses_shareholder_id
  ON public.income_expenses(shareholder_id) WHERE shareholder_id IS NOT NULL;
COMMENT ON COLUMN public.income_expenses.shareholder_id IS
  'Phiếu chi chia lợi nhuận gắn cổ đông — dùng tính "đã ứng/đã chia". Phiếu loại này đặt business_result_accounting=false.';

-- updated_at triggers (idempotent) ---------------------------------------
DROP TRIGGER IF EXISTS set_shareholders_updated_at ON public.shareholders;
CREATE TRIGGER set_shareholders_updated_at BEFORE UPDATE ON public.shareholders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_bldg_sh_updated_at ON public.building_shareholders;
CREATE TRIGGER set_bldg_sh_updated_at BEFORE UPDATE ON public.building_shareholders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_profit_monthly_updated_at ON public.profit_monthly;
CREATE TRIGGER set_profit_monthly_updated_at BEFORE UPDATE ON public.profit_monthly
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_personal_txn_updated_at ON public.personal_transactions;
CREATE TRIGGER set_personal_txn_updated_at BEFORE UPDATE ON public.personal_transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 7) Helper: auth.uid() → shareholders.id --------------------------------
CREATE OR REPLACE FUNCTION public.current_shareholder_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT id FROM public.shareholders
  WHERE auth_user_id = auth.uid() AND deleted_at IS NULL
  LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.current_shareholder_id() TO authenticated;

-- 8) RPC: LN theo nhà cho 1 khoảng (chỉ khoản KQKD) ----------------------
CREATE OR REPLACE FUNCTION public.monthly_building_profit(
  p_start date,
  p_end   date,
  p_building_id uuid DEFAULT NULL
)
RETURNS TABLE (
  building_id   uuid,
  building_name text,
  total_income  numeric,
  total_expense numeric,
  net_profit    numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner uuid;
BEGIN
  -- App single-org: owner = super_admin
  v_owner := (SELECT sa.user_id FROM public.super_admins sa ORDER BY sa.created_at LIMIT 1);

  RETURN QUERY
  SELECT
    b.id,
    b.name,
    COALESCE(i.total, 0)::numeric,
    COALESCE(e.total, 0)::numeric,
    (COALESCE(i.total, 0) - COALESCE(e.total, 0))::numeric
  FROM public.buildings b
  LEFT JOIN (
    SELECT ie.building_id, SUM(ie.total_amount) AS total
    FROM public.income_expenses ie
    WHERE ie.user_id = v_owner
      AND ie.type = 'INCOME'
      AND ie.counts_in_business_result = true
      AND ie.approval_status = 'APPROVED'
      AND ie.deleted_at IS NULL
      AND ie.voucher_date BETWEEN p_start AND p_end
    GROUP BY ie.building_id
  ) i ON i.building_id = b.id
  LEFT JOIN (
    SELECT ie.building_id, SUM(ie.total_amount) AS total
    FROM public.income_expenses ie
    WHERE ie.user_id = v_owner
      AND ie.type = 'EXPENSE'
      AND ie.counts_in_business_result = true
      AND ie.approval_status = 'APPROVED'
      AND ie.deleted_at IS NULL
      AND ie.voucher_date BETWEEN p_start AND p_end
    GROUP BY ie.building_id
  ) e ON e.building_id = b.id
  WHERE b.user_id = v_owner
    AND b.is_virtual = false
    AND b.deleted_at IS NULL
    AND (p_building_id IS NULL OR b.id = p_building_id)
  ORDER BY b.name;
END;
$$;
GRANT EXECUTE ON FUNCTION public.monthly_building_profit(date, date, uuid) TO authenticated;

-- 9) Seed hạng mục chi "Chia lợi nhuận cổ đông" cho owner ----------------
INSERT INTO public.income_expense_types (user_id, name, type, category, is_default, is_deposit, description)
SELECT sa.user_id, 'Chia lợi nhuận cổ đông', 'expense', 'Chia lợi nhuận', false, false,
       'Phiếu chi chia lợi nhuận cho cổ đông — không tính KQKD'
FROM public.super_admins sa
WHERE NOT EXISTS (
  SELECT 1 FROM public.income_expense_types t
  WHERE t.user_id = sa.user_id AND lower(t.type) = 'expense' AND t.name = 'Chia lợi nhuận cổ đông'
);

-- 10) RLS ----------------------------------------------------------------
ALTER TABLE public.shareholders            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.building_shareholders   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_monthly          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profit_allocations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.personal_transactions   ENABLE ROW LEVEL SECURITY;

-- shareholders: owner/admin full; cổ đông xem chính mình
DROP POLICY IF EXISTS shareholders_owner_all ON public.shareholders;
CREATE POLICY shareholders_owner_all ON public.shareholders TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS shareholders_self_select ON public.shareholders;
CREATE POLICY shareholders_self_select ON public.shareholders FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() AND deleted_at IS NULL);

-- building_shareholders: owner/admin full; cổ đông xem dòng của mình
DROP POLICY IF EXISTS bldg_sh_owner_all ON public.building_shareholders;
CREATE POLICY bldg_sh_owner_all ON public.building_shareholders TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS bldg_sh_self_select ON public.building_shareholders;
CREATE POLICY bldg_sh_self_select ON public.building_shareholders FOR SELECT TO authenticated
  USING (shareholder_id = public.current_shareholder_id());

-- profit_monthly: owner/admin full; cổ đông xem tháng có phần của mình
DROP POLICY IF EXISTS profit_monthly_owner_all ON public.profit_monthly;
CREATE POLICY profit_monthly_owner_all ON public.profit_monthly TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS profit_monthly_self_select ON public.profit_monthly;
CREATE POLICY profit_monthly_self_select ON public.profit_monthly FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.profit_allocations pa
    WHERE pa.profit_monthly_id = profit_monthly.id
      AND pa.shareholder_id = public.current_shareholder_id()
  ));

-- profit_allocations: owner/admin full; cổ đông xem phần của mình
DROP POLICY IF EXISTS profit_alloc_owner_all ON public.profit_allocations;
CREATE POLICY profit_alloc_owner_all ON public.profit_allocations TO authenticated
  USING (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin())
  WITH CHECK (auth.uid() = user_id OR public.is_admin() OR public.is_super_admin());
DROP POLICY IF EXISTS profit_alloc_self_select ON public.profit_allocations;
CREATE POLICY profit_alloc_self_select ON public.profit_allocations FOR SELECT TO authenticated
  USING (shareholder_id = public.current_shareholder_id());

-- personal_transactions: own-only (mỗi user 1 ví)
DROP POLICY IF EXISTS personal_txn_own ON public.personal_transactions;
CREATE POLICY personal_txn_own ON public.personal_transactions TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- income_expenses: cổ đông xem phiếu ứng gắn mình (cộng thêm policy hiện có)
DROP POLICY IF EXISTS income_expenses_select_shareholder ON public.income_expenses;
CREATE POLICY income_expenses_select_shareholder ON public.income_expenses FOR SELECT TO authenticated
  USING (deleted_at IS NULL AND shareholder_id = public.current_shareholder_id());

COMMIT;

NOTIFY pgrst, 'reload schema';
