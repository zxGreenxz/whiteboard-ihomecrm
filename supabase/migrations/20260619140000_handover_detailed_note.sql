-- =============================================
-- Ghi chú phiếu bàn giao CHI TIẾT: liệt kê từng dòng
-- phòng · tòa · số tiền · kỳ hóa đơn · mã hóa đơn.
--  - confirm_cash_handover: dựng ghi chú chi tiết khi tạo 2 phiếu chuyển.
--  - Backfill ghi chú cho các phiếu bàn giao đã có (guard chỉ chặn đổi
--    cột tài chính, KHÔNG chặn đổi notes → update an toàn).
-- =============================================

CREATE OR REPLACE FUNCTION public.confirm_cash_handover(p_handover_id uuid, p_to_account_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_h          cash_handovers%ROWTYPE;
  v_to         uuid;
  v_sum        numeric;
  v_cnt        int;
  v_type_exp   uuid;
  v_type_inc   uuid;
  v_bld_giver  uuid;
  v_bld_recv   uuid;
  v_caller     text;
  v_recv       text;
  v_giver      text;
  v_exp        uuid;     -- phiếu CHI tổng (sổ người giao)
  v_inc        uuid;     -- phiếu THU tổng (sổ người nhận)
  v_desc       text;
  v_lines      text;     -- danh sách dòng chi tiết cho ghi chú
  rec          record;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_h FROM cash_handovers WHERE id = p_handover_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Không tìm thấy phiên bàn giao'; END IF;
  IF v_h.receiver_id <> auth.uid() THEN
    RAISE EXCEPTION 'Chỉ người nhận mới được xác nhận đã nhận tiền';
  END IF;
  IF v_h.status <> 'PENDING' THEN
    RAISE EXCEPTION 'Phiên % không ở trạng thái chờ nhận', v_h.code;
  END IF;
  IF v_h.cancel_requested_by IS NOT NULL THEN
    RAISE EXCEPTION 'Phiên % đang có yêu cầu hủy — xử lý yêu cầu hủy trước', v_h.code;
  END IF;

  -- Sổ đích: truyền vào (phải của receiver) hoặc fallback sổ "…Thu" của receiver
  IF p_to_account_id IS NOT NULL THEN
    SELECT id INTO v_to FROM accounts
     WHERE id = p_to_account_id AND user_id = auth.uid() AND deleted_at IS NULL;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'Sổ nhận không hợp lệ (phải là sổ quỹ do bạn sở hữu)';
    END IF;
  ELSE
    SELECT id INTO v_to FROM accounts
     WHERE user_id = auth.uid() AND deleted_at IS NULL AND btrim(name) LIKE '%Thu'
     ORDER BY is_default DESC NULLS LAST, name LIMIT 1;
    IF v_to IS NULL THEN
      RAISE EXCEPTION 'Bạn chưa có sổ quỹ nhận — hãy chọn sổ khi xác nhận';
    END IF;
  END IF;

  -- Re-validate: danh sách phiếu còn nguyên vẹn, tổng khớp snapshot
  SELECT COALESCE(sum(ie.total_amount), 0), count(*) INTO v_sum, v_cnt
    FROM cash_handover_items it
    JOIN income_expenses ie ON ie.id = it.voucher_id
   WHERE it.handover_id = p_handover_id
     AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
     AND ie.handover_id = p_handover_id
     AND ie.account_id = v_h.from_account_id;
  IF v_cnt <> v_h.voucher_count OR v_sum <> v_h.total_amount THEN
    RAISE EXCEPTION 'Danh sách phiếu của phiên % đã thay đổi — hãy hủy phiên và tạo lại', v_h.code;
  END IF;

  -- Loại thu/chi "bàn giao" (ngoài KQKD) + tòa ảo Chung (fallback)
  v_type_exp := public._termination_ensure_type(v_h.giver_id, 'expense', 'Bàn giao tiền mặt');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_exp AND is_deposit IS DISTINCT FROM FALSE;
  v_type_inc := public._termination_ensure_type(v_h.receiver_id, 'income', 'Nhận bàn giao tiền mặt');
  UPDATE income_expense_types SET is_deposit = FALSE
   WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
  v_bld_giver := public._chung_building(v_h.giver_id);
  v_bld_recv  := public._chung_building(v_h.receiver_id);

  SELECT COALESCE(full_name, '') INTO v_caller FROM profiles WHERE id = auth.uid();
  v_recv  := COALESCE(v_h.receiver_name, '');
  v_giver := COALESCE(v_h.giver_name, '');

  -- ── Dựng danh sách dòng chi tiết: phòng · tòa · số tiền · kỳ HĐ · mã HĐ ──
  SELECT string_agg(
           '• ' || COALESCE(NULLIF(btrim(it.room_name), ''), '?')
                || ' · ' || COALESCE(NULLIF(btrim(it.building_name), ''), '?')
                || ' · ' || replace(to_char(it.amount::bigint, 'FM999,999,999'), ',', '.') || 'đ'
                || ' · kỳ ' || COALESCE(to_char(to_date(inv.billing_month, 'YYYY-MM'), 'MM/YYYY'), '—')
                || ' · HĐ ' || COALESCE(NULLIF(btrim(inv.invoice_number), ''), '—'),
           E'\n' ORDER BY it.building_name, it.room_name)
    INTO v_lines
    FROM cash_handover_items it
    LEFT JOIN income_expenses ie ON ie.id = it.voucher_id
    LEFT JOIN invoices inv ON inv.id = ie.invoice_id
   WHERE it.handover_id = p_handover_id;

  -- ── 1 phiếu CHI tổng (sổ người giao) ──────────────────────────────────
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.giver_id, 'EXPENSE',
     'Bàn giao tiền mặt → ' || v_recv || ' — ' || v_h.code,
     v_bld_giver, v_h.from_account_id, CURRENT_DATE,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Chuyển tiền mặt sang sổ ' || v_recv || ' (phiên ' || v_h.code
       || ', ' || v_h.voucher_count || ' phiếu):' || E'\n' || COALESCE(v_lines, ''),
     v_caller)
  RETURNING id INTO v_exp;

  -- ── 1 phiếu THU tổng (sổ người nhận) ──────────────────────────────────
  INSERT INTO income_expenses
    (user_id, type, name, building_id, account_id, voucher_date,
     total_amount, approval_status, business_result_accounting, notes, creator_name)
  VALUES
    (v_h.receiver_id, 'INCOME',
     'Nhận bàn giao tiền mặt ← ' || v_giver || ' — ' || v_h.code,
     v_bld_recv, v_to, CURRENT_DATE,
     v_h.total_amount, 'APPROVED', FALSE,
     '[BÀN GIAO] Nhận tiền mặt từ ' || v_giver || ' (phiên ' || v_h.code
       || ', ' || v_h.voucher_count || ' phiếu):' || E'\n' || COALESCE(v_lines, ''),
     v_caller)
  RETURNING id INTO v_inc;

  -- ── N hạng mục chi tiết: 1 hạng mục / phiếu gốc, gắn vào CẢ 2 phiếu tổng ─
  FOR rec IN
    SELECT ie.name AS src_name, it.amount AS amt,
           it.room_name, it.building_name, it.voucher_code,
           inv.billing_month, inv.invoice_number
      FROM cash_handover_items it
      JOIN income_expenses ie ON ie.id = it.voucher_id
      LEFT JOIN invoices inv ON inv.id = ie.invoice_id
     WHERE it.handover_id = p_handover_id
     ORDER BY ie.voucher_date, ie.created_at
  LOOP
    -- Nhãn hạng mục: phòng · tòa · kỳ · mã HĐ (đầy đủ); fallback tên phiếu gốc.
    v_desc := COALESCE(
      NULLIF(btrim(
        COALESCE(rec.room_name, '?') || ' · ' || COALESCE(rec.building_name, '?')
        || COALESCE(' · kỳ ' || to_char(to_date(rec.billing_month, 'YYYY-MM'), 'MM/YYYY'), '')
        || COALESCE(' · HĐ ' || NULLIF(btrim(rec.invoice_number), ''), '')
      ), ''),
      NULLIF(btrim(rec.src_name), ''),
      'Bàn giao tiền mặt'
    );

    INSERT INTO income_expense_items
      (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_exp, v_type_exp, v_desc, 1, rec.amt, NULL, NULL);

    INSERT INTO income_expense_items
      (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_inc, v_type_inc, v_desc, 1, rec.amt, NULL, NULL);
  END LOOP;

  -- Khoá 2 phiếu chuyển bằng handover_transfer_id (sau khi nạp xong hạng mục)
  UPDATE income_expenses
     SET handover_transfer_id = p_handover_id
   WHERE id IN (v_exp, v_inc);

  UPDATE cash_handovers
     SET status = 'CONFIRMED', to_account_id = v_to, confirmed_at = now()
   WHERE id = p_handover_id;

  RETURN jsonb_build_object('id', p_handover_id, 'code', v_h.code,
                            'total_amount', v_h.total_amount, 'to_account_id', v_to,
                            'voucher_count', v_h.voucher_count);
END;
$function$;

-- ── Backfill ghi chú chi tiết cho phiếu bàn giao ĐÃ CÓ (chỉ đổi notes → guard cho phép) ──
UPDATE public.income_expenses tgt
   SET notes = CASE
        WHEN tgt.type = 'EXPENSE'
          THEN '[BÀN GIAO] Chuyển tiền mặt sang sổ ' || COALESCE(h.receiver_name, '')
               || ' (phiên ' || h.code || ', ' || h.voucher_count || ' phiếu):' || E'\n' || d.lines
        ELSE '[BÀN GIAO] Nhận tiền mặt từ ' || COALESCE(h.giver_name, '')
               || ' (phiên ' || h.code || ', ' || h.voucher_count || ' phiếu):' || E'\n' || d.lines
      END
  FROM public.cash_handovers h
  JOIN LATERAL (
    SELECT string_agg(
             '• ' || COALESCE(NULLIF(btrim(it.room_name), ''), '?')
                  || ' · ' || COALESCE(NULLIF(btrim(it.building_name), ''), '?')
                  || ' · ' || replace(to_char(it.amount::bigint, 'FM999,999,999'), ',', '.') || 'đ'
                  || ' · kỳ ' || COALESCE(to_char(to_date(inv.billing_month, 'YYYY-MM'), 'MM/YYYY'), '—')
                  || ' · HĐ ' || COALESCE(NULLIF(btrim(inv.invoice_number), ''), '—'),
             E'\n' ORDER BY it.building_name, it.room_name) AS lines
      FROM public.cash_handover_items it
      LEFT JOIN public.income_expenses ie2 ON ie2.id = it.voucher_id
      LEFT JOIN public.invoices inv ON inv.id = ie2.invoice_id
     WHERE it.handover_id = h.id
  ) d ON true
 WHERE tgt.handover_transfer_id = h.id
   AND d.lines IS NOT NULL;
