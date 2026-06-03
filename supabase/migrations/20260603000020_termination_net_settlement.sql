-- =====================================================================
-- Thanh lý "khách rời phòng" — SỔ QUỸ CHỈ 1 PHIẾU CHI RÒNG (đối trừ riêng)
--
-- YÊU CẦU (user — phương án A): khi thanh lý, sổ quỹ VẬN HÀNH chỉ hiện ĐÚNG 1
-- phiếu = số quyết toán ròng (để chi đúng, không chi nhầm nguyên cọc). Phần ghi
-- nhận doanh thu (tiền phòng cuối kỳ + phạt) và cấn cọc làm bằng CẶP BÚT TOÁN
-- ĐỐI TRỪ net 0 trên 1 sổ riêng "Cấn trừ thanh lý (nội bộ)", không lẫn tiền thật.
-- KQKD vẫn đủ doanh thu (cash-basis → cần phiếu thu).
--
-- Ký hiệu: charges = nợ + phạt; pool = cọc hoàn + tiền thừa;
--          applied = min(pool, charges); S = pool − charges (quyết toán ròng).
--   acc_op  = sổ vận hành theo toà (_termination_pick_account)
--   acc_off = sổ ảo "Cấn trừ thanh lý (nội bộ)" (mỗi owner 1 sổ)
--
--   • acc_op : cọc ban đầu (THU is_deposit, dated ký) [+ tạo nếu HĐ cũ thiếu]
--              + 1 phiếu quyết toán ròng:  S>0 → CHI S (is_deposit, trả khách)
--                                          S<0 → THU |S| (KQKD, khách trả thêm)
--   • acc_off: THU applied (KQKD, doanh thu) + CHI applied (is_deposit) = net 0
--   • Hoá đơn công nợ = charges, đánh PAID bằng payments (AR), KHÔNG nhồi dòng âm.
--
-- KQKD = applied (đối trừ thu) + max(0,−S) (net thu) = charges. Tiền mặt ròng rời
-- acc_op = −S (S>0) / +|S| (S<0). Cọc giữ lại = charges (đúng doanh thu).
--
-- Giữ signature để wrapper terminate_contract_move_out (20260601000100) gọi không
-- đổi. KHÔNG đụng recompute_invoice_for_id (bản gốc). KHÔNG tạo hoá đơn âm.
-- =====================================================================

-- ── Helper 1: sổ "Cấn trừ thanh lý (nội bộ)" theo owner (get-or-create) ──
CREATE OR REPLACE FUNCTION public._termination_offset_account(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM accounts
   WHERE user_id = p_user_id
     AND deleted_at IS NULL
     AND name = 'Cấn trừ thanh lý (nội bộ)'
   LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  INSERT INTO accounts (user_id, name, description, initial_amount)
  VALUES (p_user_id, 'Cấn trừ thanh lý (nội bộ)',
          'Sổ kỹ thuật: bút toán đối trừ khi thanh lý (doanh thu cấn cọc). Số dư luôn = 0.', 0)
  RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- ── Helper 2: ghi nhận cọc ban đầu nếu HĐ cũ còn thiếu (giả định đã thu đủ) ──
CREATE OR REPLACE FUNCTION public._ensure_initial_deposit_voucher(p_contract_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_c       RECORD;
  v_building uuid;
  v_account uuid;
  v_type    uuid;
  v_amount  numeric(15,2);
  v_date    date;
  v_voucher uuid;
BEGIN
  SELECT * INTO v_c FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_amount := COALESCE(v_c.deposit_paid, 0);
  IF v_amount <= 0 OR v_c.room_id IS NULL THEN RETURN NULL; END IF;

  -- Đã có phiếu thu cọc (is_deposit) → bỏ qua (idempotent).
  IF EXISTS (
    SELECT 1 FROM income_expenses ie
     WHERE ie.contract_id = p_contract_id
       AND ie.type = 'INCOME'
       AND ie.approval_status = 'APPROVED'
       AND ie.deleted_at IS NULL
       AND public.ie_has_deposit_item(ie.id)
  ) THEN
    RETURN NULL;
  END IF;

  SELECT building_id INTO v_building FROM rooms WHERE id = v_c.room_id;
  IF v_building IS NULL THEN RETURN NULL; END IF;

  v_account := public._termination_pick_account(v_c.user_id, v_building);
  IF v_account IS NULL THEN RETURN NULL; END IF;

  v_date := COALESCE(v_c.signed_date, v_c.start_date, CURRENT_DATE);

  v_type := public._termination_ensure_type(v_c.user_id, 'income', 'Tiền cọc');
  UPDATE income_expense_types SET is_deposit = TRUE
   WHERE id = v_type AND is_deposit IS DISTINCT FROM TRUE;

  INSERT INTO income_expenses (
    user_id, type, name, building_id, room_id, contract_id, account_id,
    voucher_date, total_amount, approval_status, notes
  ) VALUES (
    v_c.user_id, 'INCOME',
    'Cọc giữ phòng (ghi nhận ban đầu) — HĐ ' || COALESCE(v_c.contract_number, p_contract_id::text),
    v_building, v_c.room_id, p_contract_id, v_account,
    v_date, v_amount, 'APPROVED',
    '[BACKFILL_INITIAL_DEPOSIT] Ghi nhận cọc ban đầu (giả định đã thu đủ).'
  )
  RETURNING id INTO v_voucher;

  INSERT INTO income_expense_items (
    income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date
  ) VALUES (
    v_voucher, v_type, 'Tiền cọc giữ phòng (ghi nhận ban đầu)', 1, v_amount, v_date, v_date
  );

  RETURN v_voucher;
END $$;

REVOKE ALL ON FUNCTION public._termination_offset_account(uuid)    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._ensure_initial_deposit_voucher(uuid) FROM PUBLIC, anon, authenticated;

-- ── Rewrite: terminate_contract_move_out_impl (phương án A) ───────────
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
  v_contract   RECORD;
  v_building   uuid;
  v_acc_op     uuid;
  v_acc_off    uuid;
  v_billing    text;
  v_cnumber    text;
  v_deposit    numeric(15,2) := COALESCE(p_deposit_refund, 0);
  v_penalty    numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess     numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt       numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_charges    numeric(15,2);
  v_pool       numeric(15,2);
  v_applied    numeric(15,2);
  v_S          numeric(15,2);
  v_settle_inv uuid;
  v_next_sort  integer;
  v_type_inc   uuid;
  v_type_off   uuid;
  v_type_dep   uuid;
  v_voucher    uuid;
  rec          RECORD;
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
  v_acc_off := public._termination_offset_account(v_contract.user_id);

  -- 0. Đảm bảo cọc ban đầu đã trên sổ (HĐ cũ thiếu → tạo, dated ký).
  PERFORM public._ensure_initial_deposit_voucher(p_contract_id);

  v_charges := v_debt + v_penalty;
  v_pool    := v_deposit + v_excess;
  v_applied := LEAST(v_pool, v_charges);
  v_S       := v_pool - v_charges;

  -- 1. Hoá đơn công nợ tháng: dùng HĐ còn sống của billing_month; gộp phí phạt.
  SELECT id INTO v_settle_inv
    FROM invoices
   WHERE contract_id = p_contract_id AND billing_month = v_billing
     AND deleted_at IS NULL AND status <> 'CANCELLED'
   ORDER BY (status = 'PAID'), created_at
   LIMIT 1;

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

  -- 2. Đánh dấu mọi hoá đơn còn nợ → PAID (payments = AR; KHÔNG mirror phiếu thu).
  --    Doanh thu được ghi nhận riêng ở bước 3-4 để tránh đếm trùng.
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining
      FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> 'CANCELLED'
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
    VALUES (v_contract.user_id, rec.id, rec.remaining, 'TM'::payment_method, p_move_out_date,
            'Quyết toán khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ' (cấn cọc/khách trả)');
  END LOOP;

  -- 3. Đối trừ trên acc_off (net 0): ghi nhận doanh thu phần cấn cọc + giảm cọc.
  IF v_applied > 0 THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khấu trừ cọc)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    v_type_off := public._termination_ensure_type(v_contract.user_id, 'expense', 'Cấn công nợ vào cọc');
    UPDATE income_expense_types SET is_deposit = TRUE  WHERE id = v_type_off AND is_deposit IS DISTINCT FROM TRUE;

    -- THU doanh thu (KQKD), gắn hoá đơn để truy vết (recompute bỏ qua INCOME).
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Thu thanh lý (khấu trừ cọc) — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_off, v_settle_inv, p_move_out_date, v_applied, 'APPROVED',
      '[ĐỐI TRỪ] Doanh thu công nợ/phạt cấn vào cọc — không xuất tiền.')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Doanh thu thanh lý (cấn cọc)', 1, v_applied, p_move_out_date, p_move_out_date);

    -- CHI cấn cọc (is_deposit, ngoài KQKD), KHÔNG gắn hoá đơn (tránh đụng recompute).
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Cấn công nợ vào cọc — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_off, p_move_out_date, v_applied, 'APPROVED',
      '[ĐỐI TRỪ] Trừ công nợ/phạt vào tiền cọc — không xuất tiền.')
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_off, 'Cấn công nợ vào cọc', 1, v_applied, p_move_out_date, p_move_out_date);
  END IF;

  -- 4. Quyết toán RÒNG trên acc_op — phiếu DUY NHẤT trên sổ vận hành.
  IF v_S > 0 THEN
    -- Chủ trả khách: CHI ròng (hoàn cọc dư, is_deposit, ngoài KQKD).
    v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
    UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'EXPENSE', 'Trả khách thanh lý (hoàn cọc sau khấu trừ) — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_op, p_move_out_date, v_S, 'APPROVED',
      'Chủ nhà trả lại khách khi thanh lý (đã trừ công nợ/phạt).' || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_dep, 'Trả lại khách (cọc sau khấu trừ)', 1, v_S, p_move_out_date, p_move_out_date);

  ELSIF v_S < 0 THEN
    -- Khách trả thêm: THU ròng (KQKD — phần doanh thu khách trả tiền mặt).
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khách trả thêm)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, voucher_date, total_amount, approval_status, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Khách trả thêm khi thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_op, v_settle_inv, p_move_out_date, -v_S, 'APPROVED',
      'Khách trả thêm phần công nợ vượt tiền cọc khi thanh lý.' || COALESCE(E'\n' || p_notes, ''))
    RETURNING id INTO v_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_voucher, v_type_inc, 'Khách trả thêm khi thanh lý', 1, -v_S, p_move_out_date, p_move_out_date);
  END IF;

  -- 5. Đảm bảo hoá đơn cập nhật trạng thái (PAID).
  IF v_settle_inv IS NOT NULL THEN
    PERFORM public.recompute_invoice_for_id(v_settle_inv);
  END IF;

  -- 6. Thanh lý hợp đồng.
  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_move_out_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '')
                             ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']' || COALESCE(E'\n' || p_notes, '')
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  -- 7. Audit.
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, outstanding_debt, early_termination_fee, total_deposit,
      total_deductions, refund_amount, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date,
      'NORMAL', v_debt, v_penalty, COALESCE(v_contract.total_deposit, 0),
      v_applied, GREATEST(v_S, 0), 'COMPLETED', auth.uid(), NOW(), p_notes
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id',           p_contract_id,
    'settlement_invoice_id', v_settle_inv,
    'charges',               v_charges,
    'applied',               v_applied,
    'net_settlement',        v_S,
    'acc_op',                v_acc_op,
    'acc_offset',            v_acc_off
  );
END $$;

NOTIFY pgrst, 'reload schema';
