-- =============================================================================
-- FIX chùm lỗi thanh lý (audit 2026-07-03): A1, A2, A4, A5, A6, A7, A8, A9
--
-- A1: move-out kẹp hoàn cọc theo cọc THỰC THU  v_deposit := LEAST(p_deposit_refund, deposit_paid)
-- A2: audit contract_terminations hết mất im lặng — bỏ INSERT vào cột GENERATED
--     (total_deductions/refund_amount), cung cấp đủ trường thành phần; lỗi audit
--     (nếu còn) RAISE WARNING thay vì nuốt NULL.
-- A4: payments quyết toán move-out dùng 'CT' (cấn trừ) thay 'TM' — hết phồng ô Tiền mặt.
-- A5: thêm p_shortfall_mode ('PAID' mặc định = như cũ | 'DEBT' = ghi nợ phần thiếu,
--     KHÔNG tạo phiếu "Khách trả thêm", hoá đơn để lại công nợ thật chờ thu).
-- A6: tách nguồn hoàn: phần CỌC chi từ sổ CỌC (is_deposit); phần TIỀN THỪA (excess)
--     chi từ sổ VẬN HÀNH dạng non-deposit (đảo doanh thu đã ghi lúc thu dư)
--     → sổ CỌC luôn net 0/HĐ, KQKD không còn dôi phần tiền thừa đã hoàn.
-- A7: SELECT ... FOR UPDATE trên contracts — chặn double-submit hoàn cọc 2 lần.
-- A8: nếu hoá đơn tháng thanh lý đã PAID → KHÔNG mở lại; tạo hoá đơn thanh lý
--     ở tháng trống kế (_termination_free_billing_month) như đường forfeit.
-- A9: trigger auto_calculate_termination_financials TÔN TRỌNG giá trị RPC cung cấp
--     (chỉ tự tính khi IS NULL); RPC tự validate ngày thanh lý >= ngày bắt đầu HĐ.
--
-- Forfeit audit: outstanding_debt=0, early_termination_fee=v_deposit,
-- prorated*=0, total_deposit=v_deposit → generated refund_amount=0 (qua CHECK
-- refund_method) — hết mất dòng khi cọc thu thiếu (F4).
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Trigger: chỉ tự tính khi caller không cung cấp (A9)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_calculate_termination_financials()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_contract RECORD;
  v_days_in_month INTEGER;
  v_daily_rate DECIMAL(15,2);
  v_prorated_days INTEGER;
BEGIN
  SELECT c.start_date, c.end_date, c.rent_price, c.total_deposit
  INTO v_contract
  FROM contracts c
  WHERE c.id = NEW.contract_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Contract not found: %', NEW.contract_id;
  END IF;

  IF NEW.actual_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Move-out date (%) cannot be before contract start date (%)',
      NEW.actual_move_out_date, v_contract.start_date;
  END IF;

  -- Các RPC thanh lý cung cấp SẴN số liệu quyết toán thực — trigger chỉ tự tính
  -- khi caller (UI/manual) KHÔNG cung cấp (IS NULL). Trước đây trigger ghi đè
  -- mọi giá trị bằng mô hình prorated cũ → audit sai lệch / vi phạm CHECK.
  IF NEW.outstanding_debt IS NULL THEN
    SELECT COALESCE(SUM(remaining_amount), 0)
    INTO NEW.outstanding_debt
    FROM invoices
    WHERE contract_id = NEW.contract_id
      AND status NOT IN ('PAID', 'CANCELLED');
  END IF;

  v_days_in_month := EXTRACT(DAY FROM (
    DATE_TRUNC('month', NEW.actual_move_out_date) + INTERVAL '1 month - 1 day'
  ));
  v_prorated_days := EXTRACT(DAY FROM NEW.actual_move_out_date);

  IF NEW.prorated_rent IS NULL THEN
    v_daily_rate := v_contract.rent_price / v_days_in_month;
    IF v_prorated_days < v_days_in_month THEN
      NEW.prorated_rent := v_daily_rate * v_prorated_days;
    ELSE
      NEW.prorated_rent := 0;
    END IF;
  END IF;

  IF NEW.prorated_days IS NULL THEN
    IF v_prorated_days < v_days_in_month THEN
      NEW.prorated_days := v_prorated_days;
    ELSE
      NEW.prorated_days := 0;
    END IF;
  END IF;

  IF NEW.total_deposit IS NULL THEN
    NEW.total_deposit := v_contract.total_deposit;
  END IF;

  IF NEW.prorated_services IS NULL THEN
    SELECT COALESCE(SUM(cs.unit_price *
      CASE s.type
        WHEN 'FIXED' THEN (v_prorated_days::DECIMAL / v_days_in_month)
        WHEN 'PER_PERSON' THEN 1
        WHEN 'PER_ROOM' THEN (v_prorated_days::DECIMAL / v_days_in_month)
        ELSE 0
      END
    ), 0)
    INTO NEW.prorated_services
    FROM contract_services cs
    JOIN services s ON s.id = cs.service_id
    WHERE cs.contract_id = NEW.contract_id
      AND s.type != 'METER_READING';
  END IF;

  RETURN NEW;
END;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. DROP wrapper + impl move-out cũ (đổi chữ ký +p_shortfall_mode — tránh overload)
-- ─────────────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb);
DROP FUNCTION IF EXISTS public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. move_out_impl mới (A1, A2, A4, A5, A6, A7, A8)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.terminate_contract_move_out_impl(
  p_contract_id uuid,
  p_move_out_date date,
  p_deposit_refund numeric DEFAULT 0,
  p_penalty_fee numeric DEFAULT 0,
  p_excess_rent numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes text DEFAULT NULL::text,
  p_extra_charges jsonb DEFAULT '[]'::jsonb,
  p_shortfall_mode text DEFAULT 'PAID')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành
  v_acc_dep   uuid;   -- sổ CỌC (hoặc sổ đang chứa cọc HĐ)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_extra     numeric(15,2) := 0;
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_applied_dep numeric(15,2);   -- phần cọc cấn vào công nợ/phạt (A6)
  v_refund_dep  numeric(15,2);   -- phần cọc hoàn khách (chi sổ CỌC)
  v_refund_exc  numeric(15,2);   -- phần tiền thừa hoàn khách (chi sổ VH, non-deposit)
  v_S         numeric(15,2);
  v_budget    numeric(15,2);
  v_pay       numeric(15,2);
  v_settle_inv uuid;
  v_settle_status invoice_status;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_type_excr uuid;
  v_voucher   uuid;
  rec         RECORD;
BEGIN
  IF p_shortfall_mode NOT IN ('PAID', 'DEBT') THEN
    RAISE EXCEPTION 'p_shortfall_mode phải là PAID hoặc DEBT';
  END IF;

  -- A7: khoá dòng hợp đồng — lần gọi song song thứ 2 chờ rồi rơi vào guard TERMINATED.
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  -- A9: validate ngày (trước đây lỗi này chỉ nổ trong trigger audit và bị nuốt).
  IF p_move_out_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày chuyển đi (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_move_out_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng'; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_dep := public._ensure_initial_deposit_voucher(p_contract_id);   -- đảm bảo cọc trên sổ + lấy sổ cọc
  IF v_acc_dep IS NULL THEN v_acc_dep := public._deposit_account(v_contract.user_id); END IF;

  -- A1: hoàn/cấn cọc tối đa bằng cọc THỰC THU (deposit_paid) — mirror forfeit.
  v_deposit := LEAST(GREATEST(COALESCE(p_deposit_refund, 0), 0), COALESCE(v_contract.deposit_paid, 0));

  -- Tổng thu thêm (cấn vào cọc cùng công nợ/phạt).
  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  v_charges     := v_debt + v_penalty + v_extra;
  v_pool        := v_deposit + v_excess;
  v_applied     := LEAST(v_pool, v_charges);
  -- A6: cọc cấn TRƯỚC, tiền thừa cấn phần còn lại; phần dư mỗi nguồn hoàn từ đúng sổ.
  v_applied_dep := LEAST(v_deposit, v_charges);
  v_refund_dep  := v_deposit - v_applied_dep;
  v_refund_exc  := v_excess - LEAST(v_excess, GREATEST(v_charges - v_deposit, 0));
  v_S           := v_pool - v_charges;

  -- 1. Hoá đơn công nợ tháng + gộp phí phạt + thu thêm.
  SELECT id, status INTO v_settle_inv, v_settle_status FROM invoices
   WHERE contract_id = p_contract_id AND billing_month = v_billing
     AND deleted_at IS NULL AND status <> 'CANCELLED'
   ORDER BY (status = 'PAID'), created_at LIMIT 1;

  -- A8: hoá đơn tháng đã PAID → không mở lại hoá đơn đã đóng; dùng tháng trống kế.
  IF v_settle_inv IS NOT NULL AND v_settle_status = 'PAID' AND (v_penalty > 0 OR v_extra > 0) THEN
    v_settle_inv := NULL;
  END IF;

  IF (v_penalty > 0 OR v_extra > 0) AND v_settle_inv IS NULL THEN
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id,
      public._termination_free_billing_month(p_contract_id, v_billing),
      p_move_out_date, p_move_out_date, 'APPROVED'::invoice_status, 0, 0,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY') || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_settle_inv;
  END IF;

  IF v_penalty > 0 THEN
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  -- Thu thêm itemize (cập nhật subtotal/total + chốt số điện).
  IF v_extra > 0 THEN
    PERFORM public._termination_apply_extra_charges(v_settle_inv, p_extra_charges, p_move_out_date, v_contract.user_id, p_contract_id);
  END IF;

  -- 2. Quyết toán hoá đơn còn nợ bằng CẤN TRỪ ('CT' — A4, không phải tiền mặt).
  --    PAID mode: gạch toàn bộ (khách đã trả phần thiếu tại chỗ).
  --    DEBT mode (A5): chỉ gạch trong phạm vi pool (cọc + tiền thừa) — phần thiếu
  --    để lại công nợ thật trên hoá đơn, chờ thu qua /thu-tien.
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

  -- 3. CHUYỂN KHOẢN nội bộ: phần CỌC cấn nợ/phạt từ sổ CỌC → sổ vận hành (ghi doanh thu).
  --    A6: chỉ chuyển v_applied_dep (phần cọc); phần tiền thừa cấn nợ KHÔNG tạo doanh thu
  --    mới (doanh thu đã ghi khi khách trả dư) — chỉ gạch AR ở bước 2.
  IF v_applied_dep > 0 THEN
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc → chuyển doanh thu — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_dep, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Cọc cấn nợ/phạt, chuyển sang sổ vận hành thành doanh thu.')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, 'Cấn cọc chuyển doanh thu', 1, v_applied_dep, p_move_out_date, p_move_out_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_op, v_settle_inv, p_move_out_date, v_applied_dep, 'APPROVED',
      '[CHUYỂN KHOẢN] Doanh thu thanh lý (cọc cấn nợ/phạt) — chuyển từ sổ CỌC.')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied_dep, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. Quyết toán ròng.
  --    4a. Hoàn phần CỌC còn dư — CHI sổ CỌC (is_deposit, ngoài KQKD) → sổ CỌC net 0/HĐ.
  IF v_refund_dep > 0 THEN
    v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
    UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Trả khách thanh lý (hoàn cọc sau khấu trừ) — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_dep, p_move_out_date, v_refund_dep, 'APPROVED',
      'Chủ nhà trả lại khách khi thanh lý (đã trừ công nợ/phạt) — chi từ sổ CỌC.' || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_dep, 'Trả lại khách (cọc sau khấu trừ)', 1, v_refund_dep, p_move_out_date, p_move_out_date);
  END IF;

  --    4b. Hoàn phần TIỀN THỪA còn dư — CHI sổ VẬN HÀNH non-deposit (A6):
  --        đảo lại doanh thu đã ghi khi khách trả dư → KQKD hết dôi, sổ CỌC không âm.
  IF v_refund_exc > 0 THEN
    v_type_excr := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền thừa thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_excr AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Hoàn tiền thừa khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_op, p_move_out_date, v_refund_exc, 'APPROVED',
      'Hoàn tiền phòng thừa (credit khách trả dư) khi thanh lý — chi từ sổ vận hành, giảm KQKD tương ứng doanh thu đã ghi lúc thu dư.' || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_excr, 'Hoàn tiền thừa khi thanh lý', 1, v_refund_exc, p_move_out_date, p_move_out_date);
  END IF;

  --    4c. Khách trả thêm phần thiếu — CHỈ ở chế độ PAID (A5).
  IF v_S < 0 AND p_shortfall_mode = 'PAID' THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khách trả thêm)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Khách trả thêm khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_op, v_settle_inv, p_move_out_date, -v_S, 'APPROVED',
      'Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý.' || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Khách trả thêm khi thanh lý', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Hoá đơn quyết toán → recompute trạng thái.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng.
  UPDATE contracts
     SET status = 'TERMINATED', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '')
                        ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit (A2): KHÔNG ghi cột generated; cung cấp đủ trường thành phần
  --    (trigger đã tôn trọng giá trị cung cấp — A9). refund_amount generated
  --    = total_deposit − deductions = phần cọc hoàn (khớp 4a).
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date, termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, refund_method, status, approved_by, approved_at, notes)
    VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, 'NORMAL',
      v_debt, v_penalty + v_extra, 0, 0, 0,
      v_deposit,
      CASE WHEN v_refund_dep > 0 OR v_refund_exc > 0 THEN 'TM'::payment_method ELSE NULL END,
      'COMPLETED', auth.uid(), NOW(), p_notes);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'terminate_contract_move_out_impl: audit insert failed for %: %', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id, 'settlement_invoice_id', v_settle_inv,
    'charges', v_charges, 'extra_charges_total', v_extra,
    'applied', v_applied, 'applied_deposit', v_applied_dep,
    'refund_deposit', v_refund_dep, 'refund_excess', v_refund_exc,
    'net_settlement', v_S, 'shortfall_mode', p_shortfall_mode,
    'acc_op', v_acc_op, 'acc_deposit', v_acc_dep
  );
END $function$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text) FROM anon;
REVOKE ALL ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out_impl(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Wrapper move-out mới (giữ guard quyền y nguyên, +p_shortfall_mode)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION public.terminate_contract_move_out(
  p_contract_id uuid,
  p_move_out_date date,
  p_deposit_refund numeric DEFAULT 0,
  p_penalty_fee numeric DEFAULT 0,
  p_excess_rent numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes text DEFAULT NULL::text,
  p_extra_charges jsonb DEFAULT '[]'::jsonb,
  p_shortfall_mode text DEFAULT 'PAID')
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_room uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  SELECT room_id INTO v_room FROM public.contracts
   WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT (
    public.is_super_admin()
    OR (v_room IS NOT NULL AND public.can_do_on_building('contracts','edit',
          (SELECT building_id FROM public.rooms WHERE id = v_room)))
  ) THEN
    RAISE EXCEPTION 'Bạn không có quyền thao tác trên hợp đồng này' USING ERRCODE = '42501';
  END IF;
  RETURN public.terminate_contract_move_out_impl(
    p_contract_id, p_move_out_date, p_deposit_refund, p_penalty_fee,
    p_excess_rent, p_outstanding_debt, p_notes, p_extra_charges, p_shortfall_mode);
END $function$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text, jsonb, text) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. forfeit_impl: FOR UPDATE (A7) + validate ngày (A9) + audit không mất (A2)
--    (chữ ký giữ nguyên → CREATE OR REPLACE, ACL giữ)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_impl(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_extra_inv      uuid;
  v_extra          numeric(15,2) := 0;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_billing_dep    text;
  v_billing_extra  text;
  v_cnumber        text;
  v_marker         text;
  v_acc_dep        uuid;
  v_acc_op         uuid;
  v_type_off       uuid;
  v_type_inc       uuid;
  v_chi_id         uuid;
  v_thu_id         uuid;
  v_kept_paid      numeric(15,2);
  v_paid_cnt       integer;
  v_unpaid_cnt     integer;
  v_cancelled_cnt  integer;
BEGIN
  -- A7: khoá dòng hợp đồng chống double-submit.
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;
  -- A9: validate ngày.
  IF p_forfeit_date < v_contract.start_date THEN
    RAISE EXCEPTION 'Ngày bỏ cọc (%) không được trước ngày bắt đầu hợp đồng (%)',
      to_char(p_forfeit_date,'DD/MM/YYYY'), to_char(v_contract.start_date,'DD/MM/YYYY');
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  -- Cọc forfeit = cọc THỰC đã thu (không thể giữ tiền khách chưa đưa).
  v_deposit := LEAST(COALESCE(v_contract.total_deposit, 0), COALESCE(v_contract.deposit_paid, 0));
  v_billing := to_char(COALESCE(p_forfeit_date, CURRENT_DATE), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_marker  := '[CẤN CỌC BỎ CỌC ' || p_contract_id::text || ']';

  v_acc_dep := public._ensure_initial_deposit_voucher(p_contract_id);
  IF v_acc_dep IS NULL THEN v_acc_dep := public._deposit_account(v_contract.user_id); END IF;
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building_id);

  -- ── Tổng đã thu của các HĐ thu-1-phần sắp huỷ (giữ làm doanh thu) ──────
  SELECT COALESCE(SUM(paid_amount), 0)
    INTO v_kept_paid
    FROM invoices
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) > 0;

  -- ── Huỷ HĐ ĐÃ THU một phần — GIỮ payment/phiếu thu làm doanh thu ───────
  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = COALESCE(paid_amount, 0),
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY')
                               || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                               || 'đ đã thu làm doanh thu, huỷ phần nợ '
                               || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                        ELSE notes
                             || E'\n[Huỷ — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY')
                             || '; giữ lại ' || round(COALESCE(paid_amount,0))::bigint
                             || 'đ đã thu làm doanh thu, huỷ phần nợ '
                             || round(COALESCE(remaining_amount,0))::bigint || 'đ]'
                      END,
         updated_at = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) > 0;
  GET DIAGNOSTICS v_paid_cnt = ROW_COUNT;

  -- ── Huỷ mọi HĐ CHƯA thu của HĐ (mọi tháng; total_amount → 0) ──────────
  UPDATE invoices
     SET status       = 'CANCELLED',
         total_amount = 0,
         notes        = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ tự động — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                        ELSE notes
                             || E'\n[Huỷ tự động — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                      END,
         updated_at   = NOW()
   WHERE contract_id = p_contract_id
     AND deleted_at  IS NULL
     AND status      IN ('APPROVED','OVERDUE','PARTIAL_PAID')
     AND COALESCE(paid_amount, 0) = 0;
  GET DIAGNOSTICS v_unpaid_cnt = ROW_COUNT;

  v_cancelled_cnt := COALESCE(v_paid_cnt, 0) + COALESCE(v_unpaid_cnt, 0);

  -- ── Hoá đơn thanh lý — PENALTY = cọc THỰC bị bỏ ───────────────────────
  IF v_deposit > 0 THEN
    v_billing_dep := public._termination_free_billing_month(p_contract_id, v_billing);
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id,
      v_billing_dep, p_forfeit_date, p_forfeit_date,
      'APPROVED'::invoice_status, v_deposit, 0, v_deposit,
      'Hoá đơn thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
        || CASE WHEN v_cancelled_cnt > 0
                  THEN E'\n(Đã huỷ ' || v_cancelled_cnt || ' hoá đơn còn nợ'
                       || CASE WHEN v_kept_paid > 0
                                 THEN '; giữ lại ' || round(v_kept_paid)::bigint
                                      || 'đ đã thu làm doanh thu'
                                 ELSE '' END
                       || ')'
                  ELSE '' END
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, 'PENALTY',
      'Phí phạt khách bỏ cọc (giữ tiền cọc đã thu)',
      v_deposit, 1, 1, v_deposit, 1
    );

    -- ── Cặp phiếu chuyển khoản nội bộ CHỜ DUYỆT (cọc → doanh thu) ───────
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu bỏ cọc');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc bỏ cọc → chuyển doanh thu — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_dep, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Cọc khách bỏ rời sổ, chuyển sang doanh thu (chờ duyệt).')
    RETURNING id INTO v_chi_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_chi_id, v_type_off, 'Cấn cọc bỏ cọc chuyển doanh thu', 1, v_deposit, p_forfeit_date, p_forfeit_date);

    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu bỏ cọc — HĐ ' || v_cnumber,
            v_building_id, v_contract.room_id, p_contract_id, v_acc_op, v_invoice_id, p_forfeit_date, v_deposit, 'UNAPPROVED',
            v_marker || ' Cọc khách bỏ ghi nhận doanh thu (chờ duyệt → tất toán hoá đơn thanh lý).')
    RETURNING id INTO v_thu_id;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_thu_id, v_type_inc, 'Doanh thu bỏ cọc (cọc khách bỏ)', 1, v_deposit, p_forfeit_date, p_forfeit_date);
  END IF;

  -- ── Thu thêm → HOÁ ĐƠN AR RIÊNG (chờ thu), TÁCH với hoá đơn bù cọc ─────
  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(SUM((j->>'amount')::numeric), 0) INTO v_extra
      FROM jsonb_array_elements(p_extra_charges) AS t(j)
     WHERE (j->>'amount') IS NOT NULL AND (j->>'amount') <> ''
       AND (j->>'amount')::numeric > 0;
  END IF;

  IF v_extra > 0 THEN
    v_billing_extra := public._termination_free_billing_month(p_contract_id, v_billing);
    INSERT INTO invoices (user_id, contract_id, building_id, room_id, billing_month, issue_date, due_date, status, subtotal, discount_amount, total_amount, notes)
    VALUES (v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id, v_billing_extra, p_forfeit_date, p_forfeit_date,
            'APPROVED'::invoice_status, 0, 0, 0,
            'Hoá đơn thu thêm khi thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
              || ' (kỳ ' || v_billing || ', thu riêng — không liên quan hoá đơn bù cọc).')
    RETURNING id INTO v_extra_inv;
    PERFORM public._termination_apply_extra_charges(v_extra_inv, p_extra_charges, p_forfeit_date, v_contract.user_id, p_contract_id);
    PERFORM public.recompute_invoice_for_id(v_extra_inv);
  END IF;

  -- ── Thanh lý hợp đồng (trigger giải phóng phòng) ──────────────────────
  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_forfeit_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                             ELSE notes || E'\n[Thanh lý — khách bỏ cọc ' || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  -- ── Audit row (A2): cung cấp đủ trường; generated refund_amount = 0 ────
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type,
      outstanding_debt, early_termination_fee, prorated_rent, prorated_days, prorated_services,
      total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      'FORFEIT',
      0, v_deposit, 0, 0, 0,
      v_deposit, 'COMPLETED', auth.uid(), NOW(),
      'Khách bỏ cọc — đã tạo phiếu thu "Doanh thu bỏ cọc" (chờ duyệt) cho phần cọc thực thu ' || round(v_deposit)::bigint || 'đ.'
        || CASE WHEN v_kept_paid > 0
                  THEN ' Đã giữ lại ' || round(v_kept_paid)::bigint
                       || 'đ đã thu làm doanh thu.'
                  ELSE '' END
        || CASE WHEN v_extra > 0
                  THEN ' Hoá đơn thu thêm riêng ' || round(v_extra)::bigint || 'đ (chờ thu).'
                  ELSE '' END
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'terminate_contract_forfeit_impl: audit insert failed for %: %', p_contract_id, SQLERRM;
  END;

  RETURN jsonb_build_object(
    'contract_id',                p_contract_id,
    'invoice_id',                 v_invoice_id,
    'settlement_invoice_id',      v_invoice_id,
    'extra_invoice_id',           v_extra_inv,
    'extra_charges_total',        v_extra,
    'forfeit_amount',             v_deposit,
    'cancelled_invoices',         v_cancelled_cnt,
    'kept_paid_amount',           v_kept_paid,
    'pending_income_voucher_id',  v_thu_id,
    'pending_expense_voucher_id', v_chi_id
  );
END;
$function$;
