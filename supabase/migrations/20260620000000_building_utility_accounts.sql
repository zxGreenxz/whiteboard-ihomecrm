-- =============================================================================
-- Đóng tiền Điện nước (NCC) cho cả toà — trang Thu tiền
--
-- 1) Bảng building_utility_accounts: lưu mã PE (điện) / số tài khoản nước +
--    tên chủ hộ đăng ký với nhà cung cấp, theo (toà, loại). Owner-scoped:
--    1 nguồn dùng chung của chủ toà, staff đọc qua RLS (giống sổ hệ thống).
-- 2) upsert_building_utility_account: lưu/sửa mã inline (SECURITY DEFINER).
-- 3) pay_utility_bill: tạo 1 phiếu CHI từ sổ "…Thu" của user, tính KQKD,
--    gắn kỳ qua start_date/end_date của hạng mục, voucher_date = ngày đóng
--    thực tế (để báo cáo theo ngày). Mirror confirm_cash_handover.
-- =============================================================================

BEGIN;

-- ── 1. Bảng lưu mã NCC + tên chủ hộ ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.building_utility_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id    uuid NOT NULL REFERENCES public.buildings(id) ON DELETE CASCADE,
  utility_type   text NOT NULL CHECK (utility_type IN ('ELECTRIC','WATER')),
  provider_code  text,        -- mã PE (điện) / số tài khoản (danh bạ) nước
  account_holder text,        -- tên chủ hộ đăng ký với nhà cung cấp
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- = buildings.user_id (chủ toà)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

-- 1 nguồn duy nhất / (toà, loại) khi còn hiệu lực.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bua_building_utility
  ON public.building_utility_accounts(building_id, utility_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_bua_building ON public.building_utility_accounts(building_id);
CREATE INDEX IF NOT EXISTS idx_bua_user    ON public.building_utility_accounts(user_id);

DROP TRIGGER IF EXISTS trg_bua_updated_at ON public.building_utility_accounts;
CREATE TRIGGER trg_bua_updated_at
  BEFORE UPDATE ON public.building_utility_accounts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.building_utility_accounts IS
  'Mã PE/nước + tên chủ hộ đăng ký với nhà cung cấp, theo (toà, loại điện/nước). Owner-scoped, staff đọc/ghi theo scope. Dùng cho màn "Đóng tiền Điện nước".';

-- ── RLS: chỉ cần SELECT (mọi ghi đi qua RPC SECURITY DEFINER → bypass RLS) ──
ALTER TABLE public.building_utility_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bua_select ON public.building_utility_accounts;
CREATE POLICY bua_select ON public.building_utility_accounts
  FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.can_access_building(building_id)
    OR public.ie_all_buildings_scope(building_id)
    OR public.is_admin() OR public.is_super_admin()
  );


-- ── 2. RPC: lưu/sửa mã NCC + tên chủ hộ inline ──────────────────────
CREATE OR REPLACE FUNCTION public.upsert_building_utility_account(
  p_building_id    uuid,
  p_utility_type   text,
  p_provider_code  text DEFAULT NULL,
  p_account_holder text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_utility_type NOT IN ('ELECTRIC','WATER') THEN
    RAISE EXCEPTION 'Loại tiện ích không hợp lệ';
  END IF;

  SELECT b.user_id INTO v_owner FROM buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id)
          OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  INSERT INTO building_utility_accounts
    (building_id, utility_type, provider_code, account_holder, user_id)
  VALUES
    (p_building_id, p_utility_type,
     NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''), v_owner)
  ON CONFLICT (building_id, utility_type) WHERE deleted_at IS NULL
  DO UPDATE SET
    provider_code  = COALESCE(NULLIF(btrim(EXCLUDED.provider_code), ''),  building_utility_accounts.provider_code),
    account_holder = COALESCE(NULLIF(btrim(EXCLUDED.account_holder), ''), building_utility_accounts.account_holder),
    updated_at = now();

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_building_utility_account(uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_building_utility_account(uuid,text,text,text) TO authenticated;


-- ── 3. RPC: tạo phiếu CHI đóng tiền điện/nước (NCC) ─────────────────
CREATE OR REPLACE FUNCTION public.pay_utility_bill(
  p_building_id    uuid,
  p_utility_type   text,        -- 'ELECTRIC' | 'WATER'
  p_amount         numeric,
  p_period_month   text,        -- 'YYYY-MM' (kỳ)
  p_voucher_date   date DEFAULT NULL,  -- ngày đóng thực tế (báo cáo theo ngày)
  p_provider_code  text DEFAULT NULL,
  p_account_holder text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner   uuid;
  v_acc     uuid;
  v_type    uuid;
  v_caller  text;
  v_type_nm text;
  v_vdate   date;
  v_p_start date;
  v_p_end   date;
  v_voucher uuid;
  v_code    text;
  v_total   numeric;
BEGIN
  -- Validate
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_utility_type NOT IN ('ELECTRIC','WATER') THEN
    RAISE EXCEPTION 'Loại tiện ích không hợp lệ';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền phải lớn hơn 0';
  END IF;
  IF p_period_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;

  -- Toà + chủ toà + kiểm quyền (definer bypass RLS nên phải tự kiểm)
  SELECT b.user_id INTO v_owner FROM buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id)
          OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  -- Sổ "…Thu" của CALLER (giống confirm_cash_handover)
  SELECT id INTO v_acc FROM accounts
   WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
   ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa có sổ quỹ "…Thu" để chi tiền';
  END IF;

  -- Hạng mục CHI của CHỦ TOÀ (staff + chủ dùng chung), tên riêng để báo cáo không lẫn
  v_type_nm := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'Đóng tiền điện' ELSE 'Đóng tiền nước' END;
  v_type := public._termination_ensure_type(v_owner, 'expense', v_type_nm);
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

  -- Kỳ → đầu/cuối tháng; ngày đóng mặc định hôm nay
  v_p_start := to_date(p_period_month || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', v_p_start) + interval '1 month - 1 day')::date;
  v_vdate   := COALESCE(p_voucher_date, CURRENT_DATE);

  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  -- Phiếu CHI: KQKD = TRUE; APPROVED; user_id = caller (staff thấy phiếu của mình)
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (auth.uid(), 'EXPENSE',
     'Đóng ' || lower(v_type_nm) || ' (NCC) — kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     p_building_id, v_acc, v_vdate,
     p_amount, 'APPROVED', TRUE,
     'Chủ nhà đóng ' || lower(v_type_nm) || ' cho cả toà — kỳ ' || to_char(v_p_start, 'MM/YYYY')
       || COALESCE(' — mã ' || NULLIF(btrim(p_provider_code), ''), '')
       || COALESCE(' — chủ hộ ' || NULLIF(btrim(p_account_holder), ''), ''),
     v_caller)
  RETURNING id INTO v_voucher;

  -- 1 hạng mục → trigger auto-calc amount = 1 * p_amount, recalc total_amount
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type,
     'Đóng ' || lower(v_type_nm) || ' kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     1, p_amount, v_p_start, v_p_end);

  -- Lưu mã NCC + tên chủ hộ nếu có nhập
  IF NULLIF(btrim(p_provider_code), '') IS NOT NULL
     OR NULLIF(btrim(p_account_holder), '') IS NOT NULL THEN
    INSERT INTO building_utility_accounts
      (building_id, utility_type, provider_code, account_holder, user_id)
    VALUES
      (p_building_id, p_utility_type,
       NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''), v_owner)
    ON CONFLICT (building_id, utility_type) WHERE deleted_at IS NULL
    DO UPDATE SET
      provider_code  = COALESCE(NULLIF(btrim(EXCLUDED.provider_code), ''),  building_utility_accounts.provider_code),
      account_holder = COALESCE(NULLIF(btrim(EXCLUDED.account_holder), ''), building_utility_accounts.account_holder),
      updated_at = now();
  END IF;

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;

  RETURN jsonb_build_object(
    'voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_utility_bill(uuid,text,numeric,text,date,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_utility_bill(uuid,text,numeric,text,date,text,text) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
