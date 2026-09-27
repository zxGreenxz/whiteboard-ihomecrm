-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric, p_penalty_fee numeric, p_excess_rent numeric, p_outstanding_debt numeric, p_notes text, p_extra_charges jsonb, p_shortfall_mode text, p_receipt_account_id uuid, p_refund_items jsonb) md5(prosrc)=9477e5fa91a4906e2f159fe373c00bda
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '[]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành (fallback nhận tiền thật)
  v_acc_int   uuid;   -- sổ bút toán nội bộ (cả 2 chân cấn cọc)
  v_acc_rcpt  uuid;   -- sổ NHẬN "khách trả thêm" (tiền thật)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_extra     numeric(15,2) := 0;
  v_owed      numeric(15,2) := 0;   -- tổng "Hoàn lại khách" (mình nợ khách)
  v_charges_left numeric(15,2);
  v_owed_applied numeric(15,2);
  v_refund_owed  numeric(15,2);
  v_type_rentref uuid;
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_applied_dep numeric(15,2);
  v_refund_dep  numeric(15,2);
  v_refund_exc  numeric(15,2);
  v_S         numeric(15,2);
  v_budget    numeric(15,2);
  v_pay       numeric(15,2);
  v_settle_inv uuid;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_type_excr uuid;
  v_voucher   uuid;
  v_refund_voucher uuid;
  v_breakdown text;
  rec         RECORD;
BEGIN
  IF p_shortfall_mode NOT IN ('PAID', 'DEBT') THEN
    RAISE EXCEPTION 'p_shortfall_mode phải là PAID hoặc DEBT';
  END IF;

  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  IF p_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_move_out_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng'; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, public.org_today_v1(NULL)), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_int := public._internal_settlement_account(v_contract.user_id);

  -- Sổ NHẬN "khách trả thêm" (tiền thật): form chọn > sổ %Thu của người bấm > sổ vận hành toà.
  v_acc_rcpt := COALESCE(p_receipt_account_id, public._collector_thu_account(auth.uid()), v_acc_op);
  IF p_receipt_account_id IS NOT NULL THEN
    PERFORM 1 FROM accounts a WHERE a.id = p_receipt_account_id AND a.deleted_at IS NULL AND a.is_virtual = false;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền không hợp lệ (không tồn tại hoặc là sổ ảo)';
    END IF;
  END IF;

  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid).
  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  IF jsonb_typeof(COALESCE(p_refund_items, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_owed
      FROM jsonb_array_elements(p_refund_items) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  v_charges     := v_debt + v_penalty + v_extra;
  v_pool        := v_deposit + v_excess;
  v_applied     := LEAST(v_pool + v_owed, v_charges);
  v_applied_dep := LEAST(v_deposit, v_charges);
  v_refund_dep  := v_deposit - v_applied_dep;
  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));
  -- "Hoàn lại khách" CHỈ được cấn vào phần công nợ CÒN LẠI sau khi cọc và credit
  -- đã cấn xong. Cấn sớm hơn sẽ làm v_refund_dep xê dịch — mà con số đó phải
  -- khớp cột GENERATED contract_terminations.refund_amount, nền của cảnh báo
  -- VUOT_COC_THAT trong nghĩa vụ hoàn cọc (preview_termination_refund_v1).
  v_charges_left := GREATEST(v_charges - v_deposit - v_excess, 0);
  v_owed_applied := LEAST(v_owed, v_charges_left);
  v_refund_owed  := v_owed - v_owed_applied;
  v_S           := v_pool + v_owed - v_charges;

  v_breakdown :=
       'QUYẾT TOÁN THANH LÝ ' || to_char(p_move_out_date,'DD/MM/YYYY') || ' — HĐ ' || v_cnumber
    || E'\n• Cọc đã thu: ' || to_char(v_deposit, 'FM999G999G999G990') || 'đ'
    || E'\n• Khấu trừ: công nợ ' || to_char(v_debt, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_penalty > 0 THEN ' + phí phạt ' || to_char(v_penalty, 'FM999G999G999G990') || 'đ' ELSE '' END
    || CASE WHEN v_extra   > 0 THEN ' + thu thêm ' || to_char(v_extra, 'FM999G999G999G990') || 'đ' ELSE '' END
    || ' = ' || to_char(v_charges, 'FM999G999G999G990') || 'đ'
    || E'\n• Cọc cấn vào khấu trừ: ' || to_char(v_applied_dep, 'FM999G999G999G990') || 'đ (bút toán nội bộ, không đụng sổ tiền thật)'
    || CASE WHEN v_excess > 0 THEN E'\n• Tiền thừa (credit) áp dụng: ' || to_char(v_excess, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_excess - v_refund_exc, 'FM999G999G999G990') || 'đ, hoàn ' || to_char(v_refund_exc, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || CASE WHEN v_owed > 0 THEN E'\n• Hoàn lại khách (tiền phòng ngày không ở…): ' || to_char(v_owed, 'FM999G999G999G990') || 'đ (cấn ' || to_char(v_owed_applied, 'FM999G999G999G990') || 'đ, chi ' || to_char(v_refund_owed, 'FM999G999G999G990') || 'đ)' ELSE '' END
    || E'\n• Hoàn cọc lại khách: ' || to_char(v_refund_dep, 'FM999G999G999G990') || 'đ'
    || CASE WHEN v_S < 0 THEN E'\n• Khách còn phải trả: ' || to_char(-v_S, 'FM999G999G999G990') || 'đ ('
         || CASE WHEN p_shortfall_mode = 'PAID' THEN 'đã thu ngay khi thanh lý' ELSE 'GHI NỢ — chờ thu' END || ')'
       ELSE '' END
    || CASE WHEN v_refund_dep + v_refund_exc + v_refund_owed > 0 THEN E'\n• Tổng chi hoàn khách: ' || to_char(v_refund_dep + v_refund_exc + v_refund_owed, 'FM999G999G999G990') || 'đ (phiếu chi chờ duyệt — chọn sổ quỹ khi duyệt)' ELSE '' END;

  -- 1. HOÁ ĐƠN THANH LÝ RIÊNG (kind='SETTLEMENT', ĐÚNG kỳ tháng trả phòng).
  --    v4: KHÔNG đụng hoá đơn tháng nữa — dù nó chưa/đã PAID. Công nợ của nó
  --    vẫn được gạch ở bước 2 bằng payments 'CT' (không sửa nội dung hoá đơn).
  IF v_penalty > 0 OR v_extra > 0 THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, kind, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, 'SETTLEMENT',
      v_billing, p_move_out_date, p_move_out_date, 'APPROVED'::invoice_status, 0, 0,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY') || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_settle_inv;
  END IF;

  IF v_penalty > 0 THEN
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  IF v_extra > 0 THEN
    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);
  END IF;

  IF v_settle_inv IS NOT NULL THEN
    UPDATE invoices
       SET notes = COALESCE(notes || E'\n\n', '') || v_breakdown,
           updated_at = NOW()
     WHERE id = v_settle_inv;
  END IF;

  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ 'CT' (PAID: gạch hết; DEBT: trong pool).
  v_budget := CASE WHEN p_shortfall_mode = 'DEBT' THEN v_applied ELSE NULL END;
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> 'CANCELLED'
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    v_pay := rec.remaining;
    IF v_budget IS NOT NULL THEN
      EXIT WHEN v_budget <= 0;
      v_pay := LEAST(v_pay, v_budget);
      v_budget := v_budget - v_pay;
    END IF;
    IF v_pay > 0 THEN
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      VALUES (v_contract.user_id, rec.id, v_pay, 'CT'::payment_method, p_move_out_date,
              'Quyết toán khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY'));
    END IF;
  END LOOP;

  -- 3. CẶP BÚT TOÁN NỘI BỘ (cấn cọc → doanh thu) — CẢ 2 CHÂN trên sổ nội bộ,
  --    net 0/thương vụ; KHÔNG đụng sổ tiền thật (mô hình chốt 04/07).
  IF v_applied_dep > 0 THEN
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc → chuyển doanh thu — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: cọc cấn công nợ/phạt (không phải tiền thật).' || E'\n\n' || v_breakdown,
      'termination.offset')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, 'Cấn cọc chuyển doanh thu', 1, v_applied_dep, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu thanh lý từ cọc cấn nợ/phạt (KQKD đếm theo hạng mục).',
      'termination.revenue')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied_dep, p_move_out_date, p_move_out_date);
  END IF;

  -- 3b. KHOẢN HOÀN BỊ CẤN VÀO CÔNG NỢ — cặp bút toán nội bộ, net 0 trên sổ nội
  --     bộ, KHÔNG đụng sổ tiền thật. Gương của cặp cấn cọc ở bước 3, khác ở chỗ
  --     chân chi mang loại is_deposit=FALSE: tiền phòng đã ghi doanh thu rồi nên
  --     trả lại là GIẢM LÃI THẬT, còn cọc là tiền giữ hộ nên nằm ngoài KQKD.
  IF v_owed_applied > 0 THEN
    v_type_rentref := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', 'Hoàn tiền phòng cấn công nợ — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, p_move_out_date, v_owed_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: khoản hoàn cho khách được cấn vào công nợ còn lại (không phải tiền thật).' || E'\n\n' || v_breakdown,
      'termination.rent_refund_offset')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_rentref, 'Hoàn tiền phòng (cấn công nợ)', 1, v_owed_applied, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý (khoản hoàn cấn nợ) — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_int, v_settle_inv, p_move_out_date, v_owed_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Bút toán nội bộ: ghi nhận doanh thu từ phần công nợ được khoản hoàn cấn trừ.',
      'termination.rent_refund_revenue')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (khoản hoàn cấn nợ)', 1, v_owed_applied, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. HOÀN KHÁCH = TIỀN THẬT: 1 phiếu chi NHÁP, SỔ TRỐNG (chọn khi duyệt).
  IF v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'EXPENSE', COALESCE(app_private.termination_refund_name_v1(p_contract_id, p_move_out_date), 'Trả khách thanh lý — HĐ ' || v_cnumber), v_building, v_contract.room_id, p_contract_id, NULL, p_move_out_date, v_refund_dep + v_refund_exc + v_refund_owed, 'UNAPPROVED',
      '[HOÀN KHÁCH THANH LÝ] Phiếu chi hoàn khách (tiền thật). CHỌN SỔ QUỸ chi tiền (Sửa phiếu) rồi mới duyệt được.' || E'\n\n' || v_breakdown || COALESCE(E'\n' || p_notes, ''),
      'termination.refund')
    RETURNING id INTO v_refund_voucher;

    IF v_refund_dep > 0 THEN
      v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_dep, 'Trả lại khách (cọc sau khấu trừ)', 1, v_refund_dep, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_exc > 0 THEN
      v_type_excr := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền thừa thanh lý');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_excr, 'Hoàn tiền thừa khi thanh lý', 1, v_refund_exc, p_move_out_date, p_move_out_date);
    END IF;

    IF v_refund_owed > 0 THEN
      v_type_rentref := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thanh lý');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_rentref AND is_deposit IS DISTINCT FROM FALSE;
      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_refund_voucher, v_type_rentref, 'Hoàn tiền phòng ngày khách không ở', 1, v_refund_owed, p_move_out_date, p_move_out_date);
    END IF;
  END IF;

  -- 4c. Khách trả thêm (TIỀN THẬT) — chế độ PAID: vào SỔ NHẬN đã chọn.
  IF v_S < 0 AND p_shortfall_mode = 'PAID' THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khách trả thêm)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes, system_source)
    VALUES (v_contract.user_id, 'INCOME', 'Khách trả thêm khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_rcpt, v_settle_inv, p_move_out_date, -v_S, 'APPROVED',
      'Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý (tiền thật vào sổ nhận).' || COALESCE(E'\n' || p_notes, ''),
      'termination.extra_receipt')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Khách trả thêm khi thanh lý', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Recompute hoá đơn quyết toán.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng (ghi chú kèm bản quyết toán đầy đủ).
  UPDATE contracts
     SET status = 'TERMINATED', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown
                        ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') || E'\n' || v_breakdown END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  --
  -- [H2.4 - 15/09/2026] DA GO khoi bat loi trum (BEGIN ... WHEN OTHERS ... END)
  -- bao quanh INSERT nay. Audit "best-effort" o day nghia la: hop dong DA
  -- TERMINATED, hoa don quyet toan DA dung, phieu tien DA ghi - ma bang
  -- contract_terminations khong co mot dong nao. Sau do khong ai tra loi duoc
  -- "khach tra phong ngay nao, quyet toan ra sao", va moi read model dung tren
  -- bang do thieu doan trong im lang (man /deposits, KPI hoan coc, preview
  -- nghia vu hoan). Dung lop loi da va cho transfer_room o 20260731050000:
  -- loi audit => rollback toan bo, vi mot cu thanh ly khong ghi duoc vet thi
  -- tha dung xay ra.
  INSERT INTO contract_terminations (
    user_id, contract_id, termination_date, actual_move_out_date, termination_type,
    outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
    total_deposit, rent_refund_amount, refund_method, status, approved_by, approved_at, notes)
  VALUES (
    v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, 'NORMAL',
    v_debt, v_penalty + v_extra, 0, 0, 0,
    v_deposit, v_owed,
    CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 OR v_refund_owed > 0 THEN 'TM'::payment_method ELSE NULL END,
    'COMPLETED', auth.uid(), NOW(),
    COALESCE(p_notes || E'\n', '') || v_breakdown);

  RETURN jsonb_build_object(
    'contract_id', p_contract_id, 'settlement_invoice_id', v_settle_inv,
    'charges', v_charges, 'extra_charges_total', v_extra,
    'applied', v_applied, 'applied_deposit', v_applied_dep,
    'refund_deposit', v_refund_dep, 'refund_excess', v_refund_exc,
    'customer_refund_total', v_owed, 'customer_refund_applied', v_owed_applied,
    'refund_customer', v_refund_owed,
    'refund_voucher_id', v_refund_voucher,
    'net_settlement', v_S, 'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', CASE WHEN v_S < 0 AND p_shortfall_mode = 'PAID' THEN v_acc_rcpt END,
    'acc_op', v_acc_op, 'acc_internal', v_acc_int
  );
END $function$

