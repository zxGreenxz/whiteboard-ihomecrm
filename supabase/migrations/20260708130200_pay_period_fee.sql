-- =============================================================================
-- pay_period_fee — RPC thanh toán phí cố định TỔNG QUÁT (tổng quát hóa pay_utility_bill)
--
-- 1 phiếu CHI / tòa / hạng mục / khoảng kỳ. Đa kỳ (period_start≠period_end) →
-- item.start_date/end_date trải khoảng → accrual TỰ CHIA ĐỀU ở Báo cáo Lợi Nhuận
-- (không code thêm). system_source='fixed_fee'. Restricted (quan_ly) kiểm
-- can_create_restricted_ie(). Type resolve server-side theo OWNER của tòa.
--
-- Điện/Nước vẫn dùng đường pay_utility_bill (đồng hồ) — KHÔNG đụng ở đây.
-- cancel_period_fee/cancel_utility_bill mở rộng nhận cả 'fixed_fee'.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.pay_period_fee(
  p_building_id    uuid,
  p_category_key   text,
  p_amount         numeric,
  p_period_start   text,
  p_period_end     text,
  p_voucher_date   date  DEFAULT NULL,
  p_provider_code  text  DEFAULT NULL,
  p_account_holder text  DEFAULT NULL,
  p_account_id     uuid  DEFAULT NULL,
  p_attachments    jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner   uuid;
  v_acc     uuid;
  v_type    uuid;
  v_caller  text;
  v_label   text;
  v_vdate   date;
  v_p_start date;
  v_p_end   date;
  v_period  text;
  v_voucher uuid;
  v_code    text;
  v_total   numeric;
BEGIN
  -- Validate
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Số tiền phải lớn hơn 0';
  END IF;
  IF p_period_start !~ '^\d{4}-\d{2}$' OR p_period_end !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Kỳ không hợp lệ (cần YYYY-MM)';
  END IF;
  IF p_period_start > p_period_end THEN
    RAISE EXCEPTION 'Kỳ bắt đầu phải trước hoặc bằng kỳ kết thúc';
  END IF;
  IF p_category_key NOT IN ('tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may') THEN
    RAISE EXCEPTION 'Hạng mục phí không hợp lệ: %', p_category_key;
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

  -- Hạng mục hạn chế (Quản Lý): cần quyền tạo phiếu hạn chế
  IF p_category_key = 'quan_ly' AND NOT public.can_create_restricted_ie() THEN
    RAISE EXCEPTION 'Bạn không có quyền tạo phiếu hạng mục hạn chế' USING ERRCODE = '42501';
  END IF;

  -- Sổ ghi chi: ưu tiên sổ user CHỌN (của chính user, hoặc admin), fallback "…Thu".
  IF p_account_id IS NOT NULL THEN
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR public.is_admin() OR public.is_super_admin());
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501';
    END IF;
  ELSE
    SELECT id INTO v_acc FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Bạn chưa có sổ quỹ "…Thu" để chi tiền';
    END IF;
  END IF;

  -- Hạng mục CHI của CHỦ TOÀ (tái dùng type sẵn có, tránh trùng)
  v_type := public.resolve_fixed_expense_type(v_owner, p_category_key);
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

  -- Kỳ → đầu/cuối tháng; ngày đóng mặc định hôm nay
  v_p_start := to_date(p_period_start || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', to_date(p_period_end || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date;
  v_vdate   := COALESCE(p_voucher_date, CURRENT_DATE);
  v_period  := CASE WHEN p_period_start = p_period_end
                    THEN to_char(v_p_start, 'MM/YYYY')
                    ELSE to_char(v_p_start, 'MM/YYYY') || '–' || to_char(v_p_end, 'MM/YYYY') END;

  v_label := CASE p_category_key
    WHEN 'tien_nha'  THEN 'Tiền nhà'
    WHEN 'dien'      THEN 'Điện'
    WHEN 'nuoc'      THEN 'Nước'
    WHEN 'internet'  THEN 'Internet'
    WHEN 'quan_ly'   THEN 'Quản lý'
    WHEN 've_sinh'   THEN 'Vệ sinh tòa nhà'
    WHEN 'cong_an'   THEN 'Công an'
    WHEN 'rac'       THEN 'Rác'
    WHEN 'thang_may' THEN 'Bảo trì thang máy'
  END;

  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();

  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name,
     attachments, system_source)
  VALUES
    (auth.uid(), 'EXPENSE',
     v_label || ' — kỳ ' || v_period,
     p_building_id, v_acc, v_vdate,
     p_amount, 'APPROVED', TRUE,
     'Đóng ' || lower(v_label) || ' — kỳ ' || v_period
       || COALESCE(' — mã ' || NULLIF(btrim(p_provider_code), ''), '')
       || COALESCE(' — ' || NULLIF(btrim(p_account_holder), ''), ''),
     v_caller,
     COALESCE(p_attachments, '[]'::jsonb), 'fixed_fee')
  RETURNING id INTO v_voucher;

  -- 1 hạng mục; start/end trải kỳ → accrual tự chia. Trigger auto tính amount + total.
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type, v_label || ' kỳ ' || v_period, 1, p_amount, v_p_start, v_p_end);

  -- Lưu cấu hình tòa×hạng mục (mã NCC/chủ hộ + số tiền pre-fill kỳ sau)
  INSERT INTO building_fee_accounts
    (building_id, fee_category, provider_code, account_holder, default_amount, user_id)
  VALUES
    (p_building_id, p_category_key,
     NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''),
     p_amount, v_owner)
  ON CONFLICT (building_id, fee_category) WHERE deleted_at IS NULL
  DO UPDATE SET
    provider_code  = COALESCE(NULLIF(btrim(EXCLUDED.provider_code), ''),  building_fee_accounts.provider_code),
    account_holder = COALESCE(NULLIF(btrim(EXCLUDED.account_holder), ''), building_fee_accounts.account_holder),
    default_amount = COALESCE(EXCLUDED.default_amount, building_fee_accounts.default_amount),
    updated_at = now();

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;

  RETURN jsonb_build_object(
    'voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb) TO authenticated;


-- ── Hủy phiếu: mở rộng nhận cả 'fixed_fee' (giữ 'utility.bill' legacy) ──
CREATE OR REPLACE FUNCTION public.cancel_period_fee(p_voucher_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bld     uuid;
  v_owner   uuid;
  v_src     text;
  v_del     timestamptz;
  v_creator uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT ie.building_id, ie.system_source, ie.deleted_at, ie.user_id
    INTO v_bld, v_src, v_del, v_creator
    FROM income_expenses ie
   WHERE ie.id = p_voucher_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;
  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy trước đó'; END IF;
  IF v_src IS DISTINCT FROM 'utility.bill' AND v_src IS DISTINCT FROM 'fixed_fee' THEN
    RAISE EXCEPTION 'Phiếu này không phải phiếu Đóng tiền theo kỳ';
  END IF;

  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = v_bld;

  IF NOT (v_creator = auth.uid()
          OR public.can_access_building(v_bld)
          OR public.ie_all_buildings_scope(v_bld)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền hủy phiếu này' USING ERRCODE = '42501';
  END IF;

  UPDATE income_expenses SET deleted_at = now()
   WHERE id = p_voucher_id AND deleted_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id);
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_period_fee(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_period_fee(uuid) TO authenticated;

-- cancel_utility_bill cũng nhận 'fixed_fee' (để FE gọi 1 đường thống nhất nếu muốn)
CREATE OR REPLACE FUNCTION public.cancel_utility_bill(p_voucher_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bld     uuid;
  v_owner   uuid;
  v_src     text;
  v_del     timestamptz;
  v_creator uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT ie.building_id, ie.system_source, ie.deleted_at, ie.user_id
    INTO v_bld, v_src, v_del, v_creator
    FROM income_expenses ie
   WHERE ie.id = p_voucher_id
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;
  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy trước đó'; END IF;
  IF v_src IS DISTINCT FROM 'utility.bill' AND v_src IS DISTINCT FROM 'fixed_fee' THEN
    RAISE EXCEPTION 'Phiếu này không phải phiếu Đóng tiền Điện nước';
  END IF;

  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = v_bld;

  IF NOT (v_creator = auth.uid()
          OR public.can_access_building(v_bld)
          OR public.ie_all_buildings_scope(v_bld)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền hủy phiếu này' USING ERRCODE = '42501';
  END IF;

  UPDATE income_expenses SET deleted_at = now()
   WHERE id = p_voucher_id AND deleted_at IS NULL;

  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id);
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
