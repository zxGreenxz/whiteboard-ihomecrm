-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.set_reservation_hold_terms_v1(p_income_expense_id uuid, p_hold_until date, p_topup_due_date date, p_deposit_target numeric) md5(prosrc)=6378d889a73c36b1d422f0002ce3fa84
CREATE OR REPLACE FUNCTION public.set_reservation_hold_terms_v1(p_income_expense_id uuid, p_hold_until date DEFAULT NULL::date, p_topup_due_date date DEFAULT NULL::date, p_deposit_target numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_ie    public.income_expenses;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_ie FROM public.income_expenses
   WHERE id = p_income_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy phiếu cọc' USING ERRCODE = 'P0002';
  END IF;
  IF v_ie.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã xoá' USING ERRCODE = '55000';
  END IF;
  IF v_ie.type IS DISTINCT FROM 'INCOME' THEN
    RAISE EXCEPTION 'Chỉ đặt kỳ hạn cho phiếu THU cọc giữ chỗ' USING ERRCODE = '22023';
  END IF;
  IF v_ie.contract_id IS NOT NULL THEN
    RAISE EXCEPTION 'Phiếu đã gắn hợp đồng — kỳ hạn cọc theo hợp đồng, không theo phiếu'
      USING ERRCODE = '55000';
  END IF;

  IF NOT (public.can_access_building(v_ie.building_id)
          OR public.ie_all_buildings_scope(v_ie.building_id)
          OR public.is_admin() OR public.is_super_admin()) THEN
    RAISE EXCEPTION 'Bạn không có quyền trên toà của phiếu này' USING ERRCODE = '42501';
  END IF;

  -- Bỏ hết kỳ hạn thì xoá dòng. Đây là hành vi hợp lệ, không phải lỗi.
  IF p_hold_until IS NULL AND p_topup_due_date IS NULL AND p_deposit_target IS NULL THEN
    DELETE FROM public.reservation_hold_deadlines
     WHERE income_expense_id = p_income_expense_id;
    RETURN jsonb_build_object('incomeExpenseId', p_income_expense_id, 'cleared', true);
  END IF;

  -- Mốc nằm TRƯỚC ngày lập phiếu là đã trễ ngay lúc tạo — gần như chắc chắn gõ
  -- nhầm, và nó đẻ ra một thẻ đỏ giả trên bàn xử lý.
  IF p_hold_until IS NOT NULL AND p_hold_until < v_ie.voucher_date THEN
    RAISE EXCEPTION 'Hạn làm hợp đồng (%) không được trước ngày lập phiếu (%)',
      p_hold_until, v_ie.voucher_date USING ERRCODE = '23514';
  END IF;
  IF p_topup_due_date IS NOT NULL AND p_topup_due_date < v_ie.voucher_date THEN
    RAISE EXCEPTION 'Hạn bổ sung cọc (%) không được trước ngày lập phiếu (%)',
      p_topup_due_date, v_ie.voucher_date USING ERRCODE = '23514';
  END IF;
  -- Bổ sung cọc SAU khi đã hết hạn giữ phòng là vô nghĩa: tới ngày đó phòng đã
  -- nhả khoá rồi. Chặn ở đây thay vì để hai thẻ đỏ mâu thuẫn nhau trên bàn.
  IF p_hold_until IS NOT NULL AND p_topup_due_date IS NOT NULL
     AND p_topup_due_date > p_hold_until THEN
    RAISE EXCEPTION 'Hạn bổ sung cọc (%) không được sau hạn làm hợp đồng (%)',
      p_topup_due_date, p_hold_until USING ERRCODE = '23514';
  END IF;
  IF p_deposit_target IS NOT NULL AND p_deposit_target <= 0 THEN
    RAISE EXCEPTION 'Cọc cần đủ phải lớn hơn 0' USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.reservation_hold_deadlines
    (income_expense_id, organization_id, hold_until, topup_due_date, deposit_target, created_by)
  VALUES (p_income_expense_id, v_ie.organization_id,
          p_hold_until, p_topup_due_date, p_deposit_target, v_actor)
  ON CONFLICT (income_expense_id) DO UPDATE
    SET hold_until     = EXCLUDED.hold_until,
        topup_due_date = EXCLUDED.topup_due_date,
        deposit_target = EXCLUDED.deposit_target,
        updated_at     = now();

  RETURN jsonb_build_object(
    'incomeExpenseId', p_income_expense_id,
    'holdUntil',       p_hold_until,
    'topupDueDate',    p_topup_due_date,
    'depositTarget',   p_deposit_target);
END;
$function$

