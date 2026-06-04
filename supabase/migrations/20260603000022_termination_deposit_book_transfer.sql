-- =====================================================================
-- Thanh lý "khách rời phòng" — SỔ "CỌC" + CHUYỂN KHOẢN NỘI BỘ (transfer)
--
-- YÊU CẦU (user, phương án 1): tiền cọc nằm ở 1 sổ quỹ "CỌC (giữ hộ khách)"
-- riêng (mọi toà). Khi thanh lý:
--   • CHI từ sổ CỌC → khách: S = (cọc+thừa) − (nợ+phạt)  [số thực trả khách]
--   • CHUYỂN KHOẢN nội bộ CỌC → vận hành phần đã cấn (applied = nợ+phạt được cọc
--     gánh): CHI sổ CỌC (is_deposit, ngoài KQKD) + THU sổ vận hành (doanh thu,
--     VÀO KQKD của toà). Doanh thu là TIỀN THẬT chuyển sang sổ vận hành — KHÔNG
--     treo, dòng tiền không lệch, KHÔNG cần cờ "không kết toán".
--   • S<0 (khách trả thêm): THU sổ vận hành |S| (doanh thu, KQKD).
--
-- Sổ CỌC tất toán về 0 mỗi HĐ sau thanh lý; tổng sổ CỌC = cọc đang giữ toàn hệ.
-- =====================================================================

-- ── Helper: sổ "CỌC (giữ hộ khách)" theo owner (get-or-create) ─────────
CREATE OR REPLACE FUNCTION public._deposit_account(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM accounts
   WHERE user_id = p_user_id AND deleted_at IS NULL
     AND name = 'CỌC (giữ hộ khách)'
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO accounts (user_id, name, description, initial_amount)
  VALUES (p_user_id, 'CỌC (giữ hộ khách)',
          'Sổ giữ tiền cọc của khách (mọi toà). Số dư = tổng cọc đang giữ. Thanh lý: chi trả khách + chuyển phần cấn nợ sang sổ vận hành.', 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- RPC cho frontend lấy sổ CỌC khi ghi nhận cọc lúc ký HĐ.
CREATE OR REPLACE FUNCTION public.get_or_create_deposit_account()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Bạn chưa đăng nhập' USING ERRCODE='42501'; END IF;
  RETURN public._deposit_account(auth.uid());
END $$;
REVOKE ALL     ON FUNCTION public._deposit_account(uuid)            FROM PUBLIC, anon, authenticated;
REVOKE ALL     ON FUNCTION public.get_or_create_deposit_account()   FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_or_create_deposit_account()   TO authenticated;

-- ── Helper: đảm bảo cọc ban đầu (vào sổ CỌC) + TRẢ VỀ sổ chứa cọc ───────
-- Nếu HĐ đã có phiếu thu cọc (is_deposit) → trả account_id của phiếu đó (dùng
-- chính sổ đó làm nguồn cọc). Nếu chưa có và deposit_paid>0 → tạo trên sổ CỌC.
CREATE OR REPLACE FUNCTION public._ensure_initial_deposit_voucher(p_contract_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_c RECORD; v_building uuid; v_account uuid; v_type uuid;
  v_amount numeric(15,2); v_date date; v_existing_acc uuid;
BEGIN
  SELECT * INTO v_c FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Đã có phiếu thu cọc? → dùng đúng sổ đang chứa cọc.
  SELECT ie.account_id INTO v_existing_acc
    FROM income_expenses ie
   WHERE ie.contract_id = p_contract_id AND ie.type = 'INCOME'
     AND ie.approval_status = 'APPROVED' AND ie.deleted_at IS NULL
     AND public.ie_has_deposit_item(ie.id)
   ORDER BY ie.voucher_date LIMIT 1;
  IF v_existing_acc IS NOT NULL THEN RETURN v_existing_acc; END IF;

  v_amount := COALESCE(v_c.deposit_paid, 0);
  v_account := public._deposit_account(v_c.user_id);   -- sổ CỌC
  IF v_amount <= 0 OR v_c.room_id IS NULL THEN RETURN v_account; END IF;

  SELECT building_id INTO v_building FROM rooms WHERE id = v_c.room_id;
  IF v_building IS NULL THEN RETURN v_account; END IF;

  v_date := COALESCE(v_c.signed_date, v_c.start_date, CURRENT_DATE);
  v_type := public._termination_ensure_type(v_c.user_id, 'income', 'Tiền cọc');
  UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type AND is_deposit IS DISTINCT FROM TRUE;

  INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
  VALUES (v_c.user_id, 'INCOME', 'Cọc giữ phòng (ghi nhận ban đầu) — HĐ ' || COALESCE(v_c.contract_number, p_contract_id::text),
          v_building, v_c.room_id, p_contract_id, v_account, v_date, v_amount, 'APPROVED',
          '[BACKFILL_INITIAL_DEPOSIT] Ghi nhận cọc ban đầu (giả định đã thu đủ) vào sổ CỌC.');
  -- item
  INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
  SELECT ie.id, v_type, 'Tiền cọc giữ phòng (ghi nhận ban đầu)', 1, v_amount, v_date, v_date
    FROM income_expenses ie WHERE ie.contract_id = p_contract_id AND ie.account_id = v_account
      AND ie.notes LIKE '[BACKFILL_INITIAL_DEPOSIT]%' AND ie.deleted_at IS NULL
    ORDER BY ie.created_at DESC LIMIT 1;

  RETURN v_account;
END $$;
REVOKE ALL ON FUNCTION public._ensure_initial_deposit_voucher(uuid) FROM PUBLIC, anon, authenticated;

-- ── Rewrite: terminate_contract_move_out_impl (sổ CỌC + transfer) ──────
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(
  p_contract_id      uuid,
  p_move_out_date    date,
  p_deposit_refund   numeric DEFAULT 0,
  p_penalty_fee      numeric DEFAULT 0,
  p_excess_rent      numeric DEFAULT 0,
  p_outstanding_debt numeric DEFAULT 0,
  p_notes            text    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract  RECORD;
  v_building  uuid;
  v_acc_op    uuid;   -- sổ vận hành (HKDHUY...)
  v_acc_dep   uuid;   -- sổ CỌC (hoặc sổ đang chứa cọc HĐ)
  v_billing   text;
  v_cnumber   text;
  v_deposit   numeric(15,2) := COALESCE(p_deposit_refund, 0);
  v_penalty   numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess    numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt      numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_charges   numeric(15,2);
  v_pool      numeric(15,2);
  v_applied   numeric(15,2);
  v_S         numeric(15,2);
  v_settle_inv uuid;
  v_next_sort integer;
  v_type_inc  uuid;
  v_type_off  uuid;
  v_type_dep  uuid;
  v_voucher   uuid;
  rec         RECORD;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng'; END IF;

  v_billing := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_cnumber := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_acc_op  := public._termination_pick_account(v_contract.user_id, v_building);
  v_acc_dep := public._ensure_initial_deposit_voucher(p_contract_id);   -- đảm bảo cọc trên sổ + lấy sổ cọc
  IF v_acc_dep IS NULL THEN v_acc_dep := public._deposit_account(v_contract.user_id); END IF;

  v_charges := v_debt + v_penalty;
  v_pool    := v_deposit + v_excess;
  v_applied := LEAST(v_pool, v_charges);
  v_S       := v_pool - v_charges;

  -- 1. Hoá đơn công nợ tháng + gộp phí phạt.
  SELECT id INTO v_settle_inv FROM invoices
   WHERE contract_id = p_contract_id AND billing_month = v_billing
     AND deleted_at IS NULL AND status <> 'CANCELLED'
   ORDER BY (status = 'PAID'), created_at LIMIT 1;

  IF v_penalty > 0 THEN
    IF v_settle_inv IS NULL THEN
      INSERT INTO invoices (user_id, contract_id, building_id, room_id, billing_month, issue_date, due_date, status, subtotal, total_amount, notes)
      VALUES (v_contract.user_id, p_contract_id, v_building, v_contract.room_id, v_billing, p_move_out_date, p_move_out_date, 'APPROVED'::invoice_status, 0, 0,
        'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY') || COALESCE(E'\n' || p_notes, ''))
      RETURNING id INTO v_settle_inv;
    END IF;
    SELECT COALESCE(MAX(sort_order),0)+1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices SET subtotal = COALESCE(subtotal,0)+v_penalty, total_amount = COALESCE(total_amount,0)+v_penalty, updated_at = NOW() WHERE id = v_settle_inv;
  END IF;

  -- 2. Đánh dấu mọi hoá đơn còn nợ → PAID (payments = AR; doanh thu ghi ở B3-4).
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> 'CANCELLED'
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
    VALUES (v_contract.user_id, rec.id, rec.remaining, 'TM'::payment_method, p_move_out_date,
            'Quyết toán khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY'));
  END LOOP;

  -- 3. CHUYỂN KHOẢN nội bộ: applied từ sổ CỌC → sổ vận hành (ghi doanh thu).
  IF v_applied > 0 THEN
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn cọc chuyển doanh thu');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Doanh thu thanh lý');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    -- CHI sổ CỌC (is_deposit, ngoài KQKD) — cọc rời sổ CỌC.
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn cọc → chuyển doanh thu — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_dep, p_move_out_date, v_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Cọc cấn nợ/phạt, chuyển sang sổ vận hành thành doanh thu.')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, 'Cấn cọc chuyển doanh thu', 1, v_applied, p_move_out_date, p_move_out_date);

    -- THU sổ vận hành (KQKD) — doanh thu thanh lý vào toà.
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Doanh thu thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_op, v_settle_inv, p_move_out_date, v_applied, 'APPROVED',
      '[CHUYỂN KHOẢN] Doanh thu thanh lý (cọc cấn nợ/phạt) — chuyển từ sổ CỌC.')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. Quyết toán ròng.
  IF v_S > 0 THEN
    -- Chủ trả khách: CHI từ sổ CỌC = S (is_deposit, ngoài KQKD) — phiếu trả khách thực tế.
    v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
    UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Trả khách thanh lý (hoàn cọc sau khấu trừ) — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_dep, p_move_out_date, v_S, 'APPROVED',
      'Chủ nhà trả lại khách khi thanh lý (đã trừ công nợ/phạt) — chi từ sổ CỌC.' || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_dep, 'Trả lại khách (cọc sau khấu trừ)', 1, v_S, p_move_out_date, p_move_out_date);

  ELSIF v_S < 0 THEN
    -- Khách trả thêm: THU sổ vận hành = |S| (doanh thu, KQKD).
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khách trả thêm)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Khách trả thêm khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_op, v_settle_inv, p_move_out_date, -v_S, 'APPROVED',
      'Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý.' || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Khách trả thêm khi thanh lý', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Hoá đơn → PAID.
  IF v_settle_inv IS NOT NULL THEN PERFORM public.recompute_invoice_for_id(v_settle_inv); END IF;

  -- 6. Thanh lý hợp đồng.
  UPDATE contracts
     SET status = 'TERMINATED', actual_end_date = p_move_out_date,
         notes = CASE WHEN notes IS NULL OR length(btrim(notes)) = 0
                        THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '')
                        ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '') END,
         updated_at = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  BEGIN
    INSERT INTO contract_terminations (user_id, contract_id, termination_date, actual_move_out_date, termination_type, outstanding_debt, early_termination_fee, total_deposit, total_deductions, refund_amount, status, approved_by, approved_at, notes)
    VALUES (v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date, 'NORMAL', v_debt, v_penalty, COALESCE(v_contract.total_deposit, 0), v_applied, GREATEST(v_S, 0), 'COMPLETED', auth.uid(), NOW(), p_notes);
  EXCEPTION WHEN OTHERS THEN NULL; END;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id, 'settlement_invoice_id', v_settle_inv,
    'charges', v_charges, 'applied', v_applied, 'net_settlement', v_S,
    'acc_op', v_acc_op, 'acc_deposit', v_acc_dep
  );
END $$;

NOTIFY pgrst, 'reload schema';
