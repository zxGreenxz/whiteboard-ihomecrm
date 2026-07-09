-- =============================================================================
-- pay/update/cancel period fee V2 (10/07)
--
-- pay_period_fee v2 (+p_force — đổi chữ ký → DROP trước):
--   - CHỐNG ĐÓNG TRÙNG: kỳ giao nhau đã có phiếu APPROVED cùng hạng mục và
--     p_force=false → RETURN {warning:'duplicate', existing_amount, existing_count}
--     (KHÔNG insert). FE hiện hộp xác nhận rồi gọi lại p_force=true.
--   - Ngữ nghĩa TIỀN ĐA KỲ đã chốt: p_amount = TỔNG cả khoảng (giữ quantity=1,
--     unit_price=p_amount). default_amount học PER-KỲ = round(p_amount/số kỳ).
--   - Học sổ mặc định: default_account_id = COALESCE(cũ, sổ vừa dùng).
--   - Không đụng logic khác (type resolve, restricted, attachments...).
--
-- update_period_fee v2: guard phiếu NHIỀU DÒNG — sửa tiền/kỳ chỉ cho phiếu 1 item
--   (nhiều item mà set unit_price từng dòng = tổng → total phồng n lần). Sửa bên Thu chi.
--
-- cancel_period_fee v2: CHO HỦY CẢ PHIẾU AUTO/nhập tay khớp hạng mục (quyết định
--   user 09/07) — điều kiện: system_source IN ('utility.bill','fixed_fee') HOẶC
--   phiếu EXPENSE có item khớp fee_type_matches với 1 GRID key. CHẶN phiếu thuộc
--   batch (hủy qua phiếu tổng). Giữ permission gate + FOR UPDATE.
-- =============================================================================

BEGIN;

-- ── pay_period_fee v2 ──
DROP FUNCTION IF EXISTS public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb);

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
  p_attachments    jsonb DEFAULT NULL,
  p_force          boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_owner    uuid;
  v_acc      uuid;
  v_type     uuid;
  v_caller   text;
  v_label    text;
  v_vdate    date;
  v_p_start  date;
  v_p_end    date;
  v_months   int;
  v_period   text;
  v_voucher  uuid;
  v_code     text;
  v_total    numeric;
  v_dup_amt  numeric;
  v_dup_cnt  int;
BEGIN
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

  SELECT b.user_id INTO v_owner FROM buildings b
   WHERE b.id = p_building_id AND b.deleted_at IS NULL;
  IF v_owner IS NULL THEN RAISE EXCEPTION 'Không tìm thấy toà nhà'; END IF;
  IF NOT (public.can_access_building(p_building_id)
          OR public.ie_all_buildings_scope(p_building_id)
          OR v_owner = auth.uid()
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên toà này' USING ERRCODE = '42501';
  END IF;

  IF p_category_key = 'quan_ly' AND NOT public.can_create_restricted_ie() THEN
    RAISE EXCEPTION 'Bạn không có quyền tạo phiếu hạng mục hạn chế' USING ERRCODE = '42501';
  END IF;

  v_p_start := to_date(p_period_start || '-01', 'YYYY-MM-DD');
  v_p_end   := (date_trunc('month', to_date(p_period_end || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date;
  v_months  := (extract(YEAR FROM age(date_trunc('month', v_p_end), date_trunc('month', v_p_start))) * 12
               + extract(MONTH FROM age(date_trunc('month', v_p_end), date_trunc('month', v_p_start))))::int + 1;

  -- ── CHỐNG ĐÓNG TRÙNG: đã có phiếu APPROVED cùng hạng mục giao kỳ? ──
  IF NOT p_force THEN
    SELECT COALESCE(SUM(d.total_amount), 0), COUNT(*)
      INTO v_dup_amt, v_dup_cnt
      FROM (
        SELECT DISTINCT ie.id, ie.total_amount
          FROM income_expense_items it
          JOIN income_expense_types t ON t.id = it.income_expense_type_id
                                     AND t.type = 'expense'
                                     AND public.fee_type_matches(p_category_key, t.category, t.name)
          JOIN income_expenses ie ON ie.id = it.income_expense_id
                                 AND ie.building_id = p_building_id
                                 AND ie.type = 'EXPENSE'
                                 AND ie.approval_status = 'APPROVED'
                                 AND ie.deleted_at IS NULL
         WHERE it.start_date <= v_p_end AND it.end_date >= v_p_start
      ) d;
    IF v_dup_cnt > 0 THEN
      RETURN jsonb_build_object(
        'warning', 'duplicate',
        'existing_count', v_dup_cnt,
        'existing_amount', v_dup_amt);
    END IF;
  END IF;

  -- Sổ ghi chi
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

  v_type := public.resolve_fixed_expense_type(v_owner, p_category_key);
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type AND is_deposit IS DISTINCT FROM FALSE;

  v_vdate  := COALESCE(p_voucher_date, CURRENT_DATE);
  v_period := CASE WHEN p_period_start = p_period_end
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

  -- p_amount = TỔNG cả khoảng (đã chốt); accrual chia đều theo start/end.
  INSERT INTO income_expense_items
    (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  VALUES
    (v_voucher, v_type, v_label || ' kỳ ' || v_period, 1, p_amount, v_p_start, v_p_end);

  -- Học cấu hình: default_amount PER-KỲ + sổ mặc định (first-write-wins cho sổ)
  INSERT INTO building_fee_accounts
    (building_id, fee_category, provider_code, account_holder, default_amount, default_account_id, user_id)
  VALUES
    (p_building_id, p_category_key,
     NULLIF(btrim(p_provider_code), ''), NULLIF(btrim(p_account_holder), ''),
     round(p_amount / GREATEST(v_months, 1)), v_acc, v_owner)
  ON CONFLICT (building_id, fee_category) WHERE deleted_at IS NULL
  DO UPDATE SET
    provider_code      = COALESCE(NULLIF(btrim(EXCLUDED.provider_code), ''),  building_fee_accounts.provider_code),
    account_holder     = COALESCE(NULLIF(btrim(EXCLUDED.account_holder), ''), building_fee_accounts.account_holder),
    default_amount     = COALESCE(EXCLUDED.default_amount, building_fee_accounts.default_amount),
    default_account_id = COALESCE(building_fee_accounts.default_account_id, EXCLUDED.default_account_id),
    updated_at = now();

  SELECT code, total_amount INTO v_code, v_total FROM income_expenses WHERE id = v_voucher;

  RETURN jsonb_build_object(
    'voucher_id', v_voucher, 'code', v_code,
    'total_amount', v_total, 'account_id', v_acc);
END;
$$;

REVOKE ALL ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pay_period_fee(uuid,text,numeric,text,text,date,text,text,uuid,jsonb,boolean) TO authenticated;


-- ── update_period_fee v2: guard phiếu nhiều dòng ──
CREATE OR REPLACE FUNCTION public.update_period_fee(
  p_voucher_id   uuid,
  p_account_id   uuid    DEFAULT NULL,
  p_attachments  jsonb   DEFAULT NULL,
  p_amount       numeric DEFAULT NULL,
  p_period_start text    DEFAULT NULL,
  p_period_end   text    DEFAULT NULL,
  p_notes        text    DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bld      uuid;
  v_owner    uuid;
  v_del      timestamptz;
  v_creator  uuid;
  v_cur_acc  uuid;
  v_is_admin boolean;
  v_can_edit boolean;
  v_acc      uuid;
  v_items    int;
  v_ps       date;
  v_pe       date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT ie.building_id, ie.deleted_at, ie.user_id, ie.account_id
    INTO v_bld, v_del, v_creator, v_cur_acc
    FROM income_expenses ie
   WHERE ie.id = p_voucher_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;
  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy'; END IF;

  SELECT b.user_id INTO v_owner FROM buildings b WHERE b.id = v_bld;

  v_is_admin := public.is_admin() OR public.is_super_admin() OR v_owner = auth.uid();
  v_can_edit := v_is_admin
                OR v_creator = auth.uid()
                OR (v_bld IS NOT NULL AND public.can_do_on_building('income_expenses', 'edit', v_bld));
  IF NOT v_can_edit THEN
    RAISE EXCEPTION 'Bạn không có quyền sửa phiếu này' USING ERRCODE = '42501';
  END IF;

  IF p_account_id IS NOT NULL THEN
    IF NOT v_is_admin AND v_cur_acc IS NOT NULL THEN
      RAISE EXCEPTION 'Chỉ được gán sổ quỹ khi phiếu chưa có sổ' USING ERRCODE = '42501';
    END IF;
    SELECT id INTO v_acc FROM accounts
     WHERE id = p_account_id AND deleted_at IS NULL
       AND (user_id = auth.uid() OR v_is_admin);
    IF v_acc IS NULL THEN
      RAISE EXCEPTION 'Sổ quỹ không hợp lệ hoặc bạn không có quyền ghi chi vào sổ này' USING ERRCODE = '42501';
    END IF;
    UPDATE income_expenses SET account_id = v_acc WHERE id = p_voucher_id;
  END IF;

  IF p_attachments IS NOT NULL THEN
    UPDATE income_expenses SET attachments = p_attachments WHERE id = p_voucher_id;
  END IF;

  IF v_is_admin THEN
    IF p_notes IS NOT NULL THEN
      UPDATE income_expenses SET notes = p_notes WHERE id = p_voucher_id;
    END IF;

    IF (p_amount IS NOT NULL AND p_amount > 0)
       OR (p_period_start ~ '^\d{4}-\d{2}$' AND p_period_end ~ '^\d{4}-\d{2}$') THEN
      SELECT count(*) INTO v_items FROM income_expense_items WHERE income_expense_id = p_voucher_id;
      IF v_items > 1 THEN
        RAISE EXCEPTION 'Phiếu có nhiều dòng hạng mục — sửa số tiền/kỳ ở trang Thu chi';
      END IF;
    END IF;

    IF p_amount IS NOT NULL AND p_amount > 0 THEN
      UPDATE income_expense_items
         SET unit_price = p_amount, quantity = 1
       WHERE income_expense_id = p_voucher_id;
    END IF;
    IF p_period_start ~ '^\d{4}-\d{2}$' AND p_period_end ~ '^\d{4}-\d{2}$'
       AND p_period_start <= p_period_end THEN
      v_ps := to_date(p_period_start || '-01', 'YYYY-MM-DD');
      v_pe := (date_trunc('month', to_date(p_period_end || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date;
      UPDATE income_expense_items
         SET start_date = v_ps, end_date = v_pe
       WHERE income_expense_id = p_voucher_id;
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'voucher_id', p_voucher_id);
END;
$$;

REVOKE ALL ON FUNCTION public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_period_fee(uuid,uuid,jsonb,numeric,text,text,text) TO authenticated;


-- ── cancel_period_fee v2: hủy được cả phiếu auto/nhập tay khớp hạng mục ──
CREATE OR REPLACE FUNCTION public.cancel_period_fee(p_voucher_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bld       uuid;
  v_owner     uuid;
  v_src       text;
  v_del       timestamptz;
  v_creator   uuid;
  v_type_ok   boolean;
  v_in_batch  boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT ie.building_id, ie.system_source, ie.deleted_at, ie.user_id
    INTO v_bld, v_src, v_del, v_creator
    FROM income_expenses ie
   WHERE ie.id = p_voucher_id AND ie.type = 'EXPENSE'
   FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiếu' USING ERRCODE = 'P0002'; END IF;
  IF v_del IS NOT NULL THEN RAISE EXCEPTION 'Phiếu đã bị hủy trước đó'; END IF;

  -- Phiếu hợp lệ để hủy từ trang này: tạo từ trang (fixed_fee/utility.bill)
  -- HOẶC phiếu chi có item khớp 1 hạng mục phí cố định (kể cả "(tự động lập)").
  IF v_src IS DISTINCT FROM 'utility.bill' AND v_src IS DISTINCT FROM 'fixed_fee' THEN
    SELECT EXISTS (
      SELECT 1
        FROM income_expense_items it
        JOIN income_expense_types t ON t.id = it.income_expense_type_id AND t.type = 'expense'
       WHERE it.income_expense_id = p_voucher_id
         AND EXISTS (
           SELECT 1 FROM unnest(ARRAY['tien_nha','dien','nuoc','internet','quan_ly','ve_sinh','cong_an','rac','thang_may']) k
            WHERE public.fee_type_matches(k, t.category, t.name)
         )
    ) INTO v_type_ok;
    IF NOT v_type_ok THEN
      RAISE EXCEPTION 'Phiếu này không thuộc hạng mục phí cố định — hủy ở trang Thu chi';
    END IF;
  END IF;

  SELECT EXISTS (SELECT 1 FROM income_expense_batch_items bi WHERE bi.income_expense_id = p_voucher_id)
    INTO v_in_batch;
  IF v_in_batch THEN
    RAISE EXCEPTION 'Phiếu thuộc phiếu tổng — hủy qua chi tiết phiếu tổng ở Thu chi';
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
