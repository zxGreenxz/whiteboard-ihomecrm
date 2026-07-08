-- =============================================================================
-- update_period_fee — SỬA phiếu phí đã có, 2 TẦNG QUYỀN (server-authoritative).
--   • Admin (is_admin / is_super_admin / chủ tòa): sửa TOÀN BỘ — số tiền, kỳ áp
--     dụng, sổ quỹ, ảnh, ghi chú.
--   • Quản lý (can_do_on_building income_expenses.edit, hoặc người tạo phiếu):
--     GIỚI HẠN — chỉ thêm ảnh + gán sổ quỹ KHI ĐANG TRỐNG.
-- Dùng cho phiếu system_source='fixed_fee' và cả 'utility.bill' (điện/nước).
-- Definer → không vướng RLS "chỉ sửa UNAPPROVED" của đường PostgREST thường.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.update_period_fee(
  p_voucher_id   uuid,
  p_account_id   uuid    DEFAULT NULL,   -- gán/đổi sổ (manager: chỉ khi đang trống)
  p_attachments  jsonb   DEFAULT NULL,   -- FE gửi mảng ĐẦY ĐỦ (cũ + mới)
  p_amount       numeric DEFAULT NULL,   -- admin
  p_period_start text    DEFAULT NULL,   -- admin (YYYY-MM)
  p_period_end   text    DEFAULT NULL,   -- admin
  p_notes        text    DEFAULT NULL    -- admin
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

  -- Sổ quỹ: admin đổi tự do; manager chỉ gán khi ĐANG TRỐNG.
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

  -- Ảnh phiếu (cả 2 tầng được thêm)
  IF p_attachments IS NOT NULL THEN
    UPDATE income_expenses SET attachments = p_attachments WHERE id = p_voucher_id;
  END IF;

  -- Admin: số tiền / kỳ / ghi chú
  IF v_is_admin THEN
    IF p_notes IS NOT NULL THEN
      UPDATE income_expenses SET notes = p_notes WHERE id = p_voucher_id;
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

COMMIT;

NOTIFY pgrst, 'reload schema';
