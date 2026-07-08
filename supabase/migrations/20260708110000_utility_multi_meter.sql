-- =============================================================================
-- Đóng tiền Điện nước — NHIỀU đồng hồ (mã) mỗi toà + loại
--
-- 1 toà có thể có nhiều đồng hồ điện / nhiều đồng hồ nước (mỗi đồng hồ 1 mã PE/
-- nước). Đóng tiền + theo dõi "đã đóng" theo TỪNG đồng hồ.
--   1) Bỏ UNIQUE (building_id, utility_type) → cho nhiều account/(toà,loại).
--   2) income_expenses.utility_account_id: phiếu chi gắn với 1 đồng hồ cụ thể.
--   3) Backfill: tạo account cho (toà,loại) đang có phiếu mà thiếu; link phiếu cũ.
--   4) pay_utility_bill +p_utility_account_id: đóng cho đúng đồng hồ (null = tạo mới).
--   5) save_utility_account / add / delete: quản lý đồng hồ (mã + chủ hộ).
--
-- Biểu đồ vẫn gộp tổng theo loại (không tách theo mã) — không cần đổi.
-- =============================================================================

BEGIN;

-- ── 1. Bỏ unique, cho nhiều đồng hồ / (toà, loại) ───────────────────
DROP INDEX IF EXISTS public.uq_bua_building_utility;
CREATE INDEX IF NOT EXISTS idx_bua_building_type
  ON public.building_utility_accounts(building_id, utility_type) WHERE deleted_at IS NULL;

-- ── 2. Phiếu chi ↔ đồng hồ ──────────────────────────────────────────
ALTER TABLE public.income_expenses
  ADD COLUMN IF NOT EXISTS utility_account_id uuid
  REFERENCES public.building_utility_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ie_utility_account
  ON public.income_expenses(utility_account_id) WHERE utility_account_id IS NOT NULL;

-- ── 3. Backfill ─────────────────────────────────────────────────────
-- 3a. Tạo account cho (toà,loại) đang có phiếu utility mà chưa có account.
INSERT INTO public.building_utility_accounts (building_id, utility_type, user_id)
SELECT DISTINCT ie.building_id,
   CASE WHEN t.name = 'Đóng tiền điện' THEN 'ELECTRIC' ELSE 'WATER' END,
   b.user_id
FROM public.income_expenses ie
JOIN public.buildings b ON b.id = ie.building_id
JOIN public.income_expense_items it ON it.income_expense_id = ie.id
JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
WHERE ie.system_source = 'utility.bill' AND ie.deleted_at IS NULL
  AND t.name IN ('Đóng tiền điện', 'Đóng tiền nước')
  AND NOT EXISTS (
    SELECT 1 FROM public.building_utility_accounts a
    WHERE a.building_id = ie.building_id AND a.deleted_at IS NULL
      AND a.utility_type = CASE WHEN t.name = 'Đóng tiền điện' THEN 'ELECTRIC' ELSE 'WATER' END
  );

-- 3b. Link phiếu utility (mọi trạng thái) với đồng hồ (toà,loại) sớm nhất.
UPDATE public.income_expenses ie SET utility_account_id = sub.acc
FROM (
  SELECT ie2.id AS vid,
    (SELECT a.id FROM public.building_utility_accounts a
      WHERE a.building_id = ie2.building_id AND a.deleted_at IS NULL
        AND a.utility_type = CASE WHEN t.name = 'Đóng tiền điện' THEN 'ELECTRIC' ELSE 'WATER' END
      ORDER BY a.created_at, a.id LIMIT 1) AS acc
  FROM public.income_expenses ie2
  JOIN public.income_expense_items it ON it.income_expense_id = ie2.id
  JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
  WHERE ie2.system_source = 'utility.bill' AND ie2.utility_account_id IS NULL
    AND t.name IN ('Đóng tiền điện', 'Đóng tiền nước')
) sub
WHERE ie.id = sub.vid AND sub.acc IS NOT NULL;


-- ── 4. save_utility_account: tạo (p_id null) / sửa (p_id có) 1 đồng hồ ──
CREATE OR REPLACE FUNCTION public.save_utility_account(
  p_id             uuid,
  p_building_id    uuid,
  p_utility_type   text,
  p_provider_code  text DEFAULT NULL,
  p_account_holder text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner uuid;
  v_id    uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_utility_type NOT IN ('ELECTRIC','WATER') THEN RAISE EXCEPTION 'Loại tiện ích không hợp lệ'; END IF;

  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id) OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid() OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  IF p_id IS NOT NULL THEN
    UPDATE building_utility_accounts SET
      provider_code  = NULLIF(btrim(p_provider_code), ''),
      account_holder = NULLIF(btrim(p_account_holder), ''),
      updated_at = now()
    WHERE id = p_id AND building_id = p_building_id AND utility_type = p_utility_type AND deleted_at IS NULL
    RETURNING id INTO v_id;
    IF v_id IS NULL THEN RAISE EXCEPTION 'Không tìm thấy đồng hồ'; END IF;
  ELSE
    INSERT INTO building_utility_accounts (building_id, utility_type, provider_code, account_holder, user_id)
    VALUES (p_building_id, p_utility_type,
            NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''), v_owner)
    RETURNING id INTO v_id;
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_utility_account(uuid,uuid,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_utility_account(uuid,uuid,text,text,text) TO authenticated;


-- ── 5. delete_utility_account: xoá đồng hồ CHƯA có phiếu chi nào ──────
CREATE OR REPLACE FUNCTION public.delete_utility_account(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bld   uuid;
  v_owner uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  SELECT building_id INTO v_bld FROM building_utility_accounts WHERE id = p_id AND deleted_at IS NULL;
  IF v_bld IS NULL THEN RAISE EXCEPTION 'Không tìm thấy đồng hồ'; END IF;
  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = v_bld;
  IF NOT (public.can_access_building(v_bld) OR public.ie_all_buildings_scope(v_bld)
          OR v_owner = auth.uid() OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM income_expenses WHERE utility_account_id = p_id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Đồng hồ đã có phiếu chi, không thể xoá';
  END IF;
  UPDATE building_utility_accounts SET deleted_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.delete_utility_account(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_utility_account(uuid) TO authenticated;


-- ── 6. pay_utility_bill: +p_utility_account_id (đóng cho đúng đồng hồ) ──
DROP FUNCTION IF EXISTS public.pay_utility_bill(uuid, text, numeric, text, date, text, text, uuid, jsonb);

CREATE OR REPLACE FUNCTION public.pay_utility_bill(
  p_building_id       uuid,
  p_utility_type      text,
  p_amount            numeric,
  p_period_month      text,
  p_voucher_date      date DEFAULT NULL,
  p_provider_code     text DEFAULT NULL,
  p_account_holder    text DEFAULT NULL,
  p_account_id        uuid DEFAULT NULL,   -- sổ quỹ ghi chi
  p_attachments       jsonb DEFAULT NULL,  -- ảnh phiếu chi
  p_utility_account_id uuid DEFAULT NULL   -- đồng hồ (null = tạo đồng hồ mới)
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner   uuid;
  v_acc     uuid;
  v_meter   uuid;
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
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501'; END IF;
  IF p_utility_type NOT IN ('ELECTRIC','WATER') THEN RAISE EXCEPTION 'Loại tiện ích không hợp lệ'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Số tiền phải lớn hơn 0'; END IF;
  IF p_period_month !~ '^\d{4}-\d{2}$' THEN RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)'; END IF;

  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id) OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid() OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  -- Sổ ghi chi (mặc định "…Thu" caller)
  IF p_account_id IS NOT NULL THEN
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501'; END IF;
  ELSE
    SELECT id INTO v_acc FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_acc IS NULL THEN RAISE EXCEPTION 'Bạn chưa có sổ quỹ "…Thu" để chi tiền'; END IF;
  END IF;

  -- Đồng hồ: dùng đồng hồ chỉ định, hoặc tạo mới (dòng "thêm mã" chưa lưu)
  IF p_utility_account_id IS NOT NULL THEN
    SELECT id INTO v_meter FROM building_utility_accounts
     WHERE id = p_utility_account_id AND building_id = p_building_id
       AND utility_type = p_utility_type AND deleted_at IS NULL;
    IF v_meter IS NULL THEN RAISE EXCEPTION 'Không tìm thấy đồng hồ điện/nước'; END IF;
    UPDATE building_utility_accounts SET
      provider_code  = COALESCE(NULLIF(btrim(p_provider_code), ''), provider_code),
      account_holder = COALESCE(NULLIF(btrim(p_account_holder), ''), account_holder),
      updated_at = now()
    WHERE id = v_meter;
  ELSE
    INSERT INTO building_utility_accounts (building_id, utility_type, provider_code, account_holder, user_id)
    VALUES (p_building_id, p_utility_type,
            NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''), v_owner)
    RETURNING id INTO v_meter;
  END IF;

  v_type_nm := CASE WHEN p_utility_type = 'ELECTRIC' THEN 'Đóng tiền điện' ELSE 'Đóng tiền nước' END;
  v_type := public._termination_ensure_type(v_owner, 'expense', v_type_nm);
  UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

  v_p_start := to_date(p_period_month || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', v_p_start) + interval '1 month - 1 day')::date;
  v_vdate   := COALESCE(p_voucher_date, CURRENT_DATE);
  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     attachments, system_source, utility_account_id)
  VALUES
    (auth.uid(), 'EXPENSE',
     'Đóng ' || lower(v_type_nm) || ' (NCC) — kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     p_building_id, v_acc, v_vdate,
     p_amount, 'APPROVED', TRUE,
     'Chủ nhà đóng ' || lower(v_type_nm) || ' cho cả toà — kỳ ' || to_char(v_p_start, 'MM/YYYY')
       || COALESCE(' — mã ' || NULLIF(btrim(p_provider_code), ''), '')
       || COALESCE(' — chủ hộ ' || NULLIF(btrim(p_account_holder), ''), ''),
     v_caller,
     COALESCE(p_attachments, '[]'::jsonb), 'utility.bill', v_meter)
  RETURNING id INTO v_voucher;

  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type, 'Đóng ' || lower(v_type_nm) || ' kỳ ' || to_char(v_p_start, 'MM/YYYY'),
     1, p_amount, v_p_start, v_p_end);

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;
  RETURN jsonb_build_object('voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc, 'utility_account_id', v_meter);
END;
$$;
REVOKE ALL ON FUNCTION public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_utility_bill(uuid,text,numeric,text,date,text,text,uuid,jsonb,uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
