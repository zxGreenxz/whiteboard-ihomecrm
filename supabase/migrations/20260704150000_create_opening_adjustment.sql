-- =====================================================================
-- B6 (thống nhất tài chính 04/07) — cut-over ngày D:
-- RPC create_opening_adjustment(p_account_id, p_counted_balance, p_as_of)
--
-- Nghiệp vụ (quyết định chủ 04/07): chuẩn hoá két bằng KIỂM KÊ 1 NGÀY D
-- + 1 phiếu "Điều chỉnh số dư đầu kỳ" NGOÀI-KQKD + khoá sổ tới D.
-- KHÔNG sửa số quá khứ, KHÔNG đổi accounts.initial_amount.
--
--  1. Chênh = số đếm thực tế − số dư hệ thống hiện tại (accounts_with_balance).
--  2. Chênh > 0 → phiếu THU; < 0 → phiếu CHI; = 0 → chỉ khoá sổ.
--     Phiếu: APPROVED, business_result_accounting = FALSE (kqkd_amount = 0 —
--     không bao giờ lọt Phân bổ lợi nhuận), system_source =
--     'adjustment.opening_balance', hạng mục "Điều chỉnh số dư"
--     (hide_in_report = TRUE), toà = toà ảo "Chung", voucher_date = p_as_of.
--  3. accounts.lock_date = p_as_of (chặn sửa phiếu trước D theo cơ chế sẵn có).
--
-- Quyền: chủ sổ hoặc super admin. Chặn sổ ảo (is_virtual) — chỉ kiểm kê
-- được tiền thật. SECURITY DEFINER + search_path cố định + khoá FOR UPDATE.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.create_opening_adjustment(
  p_account_id      uuid,
  p_counted_balance numeric,
  p_as_of           date DEFAULT CURRENT_DATE
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_acc        accounts%ROWTYPE;
  v_system     numeric;
  v_diff       numeric;
  v_type_id    uuid;
  v_voucher_id uuid;
  v_kind       text;
BEGIN
  SELECT * INTO v_acc FROM accounts WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy sổ quỹ';
  END IF;
  IF v_acc.user_id <> auth.uid() AND NOT public.is_super_admin() THEN
    RAISE EXCEPTION 'Bạn không có quyền chốt sổ này';
  END IF;
  IF COALESCE(v_acc.is_virtual, FALSE) THEN
    RAISE EXCEPTION 'Sổ theo dõi (ảo) không kiểm kê tiền thật — không cần điều chỉnh';
  END IF;
  IF p_as_of > CURRENT_DATE THEN
    RAISE EXCEPTION 'Ngày chốt không được ở tương lai';
  END IF;
  IF v_acc.lock_date IS NOT NULL AND v_acc.lock_date > p_as_of THEN
    RAISE EXCEPTION 'Sổ đã khoá tới % — không thể chốt lùi về %',
      v_acc.lock_date, p_as_of;
  END IF;

  SELECT current_amount INTO v_system
  FROM accounts_with_balance WHERE id = p_account_id;
  v_diff := COALESCE(p_counted_balance, 0) - COALESCE(v_system, 0);

  IF abs(v_diff) >= 1 THEN
    -- Trigger khoá sổ chặn phiếu có ngày ≤ lock_date — phiếu điều chỉnh ngày D
    -- chính là ngày khoá, nên TẠM GỠ lock trong transaction (row đã FOR UPDATE)
    -- rồi khoá lại ở cuối. Chốt lại lần 2 cùng ngày cũng đi đường này.
    IF v_acc.lock_date IS NOT NULL THEN
      UPDATE accounts SET lock_date = NULL WHERE id = p_account_id;
    END IF;
    v_kind := CASE WHEN v_diff > 0 THEN 'income' ELSE 'expense' END;
    -- Hạng mục "Điều chỉnh số dư" (get-or-create) — ẩn khỏi báo cáo P&L.
    v_type_id := public._termination_ensure_type(
      v_acc.user_id, v_kind, 'Điều chỉnh số dư');
    UPDATE income_expense_types
       SET hide_in_report = TRUE
     WHERE id = v_type_id AND hide_in_report IS DISTINCT FROM TRUE;

    INSERT INTO income_expenses (
      user_id, type, name, building_id, account_id, voucher_date,
      total_amount, approval_status, business_result_accounting,
      system_source, notes
    ) VALUES (
      v_acc.user_id,
      CASE WHEN v_diff > 0 THEN 'INCOME' ELSE 'EXPENSE' END,
      'Điều chỉnh số dư đầu kỳ — ' || v_acc.name || ' (kiểm kê ' ||
        to_char(p_as_of, 'DD/MM/YYYY') || ')',
      public._chung_building(v_acc.user_id),
      p_account_id,
      p_as_of,
      abs(v_diff),
      'APPROVED',
      FALSE,  -- ép ngoài-KQKD: kqkd_amount = 0, không lọt Phân bổ LN
      'adjustment.opening_balance',
      '[ĐIỀU CHỈNH SỐ DƯ ĐẦU KỲ] Đếm thực tế ' || p_counted_balance ||
        ' − hệ thống ' || COALESCE(v_system, 0) || ' = ' || v_diff ||
        '. Kiểm kê ngày ' || to_char(p_as_of, 'DD/MM/YYYY') ||
        ' theo quy trình chuẩn hoá két (không tính vào lợi nhuận).'
    ) RETURNING id INTO v_voucher_id;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price
    ) VALUES (
      v_voucher_id, v_type_id,
      'Chênh lệch kiểm kê ' || to_char(p_as_of, 'DD/MM/YYYY'),
      1, abs(v_diff)
    );
  END IF;

  UPDATE accounts SET lock_date = p_as_of WHERE id = p_account_id;

  RETURN jsonb_build_object(
    'account_id', p_account_id,
    'system_balance', COALESCE(v_system, 0),
    'counted_balance', COALESCE(p_counted_balance, 0),
    'diff', v_diff,
    'voucher_id', v_voucher_id,
    'locked_to', p_as_of
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_opening_adjustment(uuid, numeric, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_opening_adjustment(uuid, numeric, date)
  TO authenticated, service_role;
