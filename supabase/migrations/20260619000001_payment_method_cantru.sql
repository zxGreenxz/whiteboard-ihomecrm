-- 20260619000001_payment_method_cantru.sql
-- Thêm phương thức thanh toán thứ 4: 'CT' (Cấn trừ) — KHÔNG phải tiền mặt.
--
-- Lý do: luồng thanh lý/bỏ cọc (terminate_contract_move_out_impl,
-- trg_forfeit_settle_on_approve) trước đây insert payments với method='TM' chỉ để
-- gạch nợ AR (đánh dấu hoá đơn PAID), KHÔNG có tiền mặt thật. Ô thống kê TM của
-- dashboard (get_invoice_statistics_v2) cộng mọi payments method='TM' nên bị phồng
-- bằng đúng các khoản cấn cọc khi thanh lý.
--
-- Sửa: tách các bút toán đối-trừ-công-nợ sang method 'CT'; với move-out còn tạo
-- thêm 1 phiếu thu cấn trừ (income_expenses, INCOME, business_result_accounting=false
-- → ngoài KQKD) vào sổ ảo "Cấn trừ thanh lý (nội bộ)" (TK000055) để truy vết.
-- Dashboard thêm thẻ "Cấn trừ" (payment_ct). 'CT' KHÔNG cho nhân viên chọn tay.
--
-- Vá dữ liệu (đã chạy trực tiếp, không nằm trong file này):
--   * payment 1.142.166 của hoá đơn INV-202605-713985 (80DS3/303): TM -> CT
--   * tạo phiếu thu cấn trừ PT2606020 vào TK000055 cho khoản trên.

ALTER TYPE payment_method ADD VALUE IF NOT EXISTS 'CT';

-- ============ terminate_contract_move_out_impl (CT + phiếu cấn trừ) ============
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_impl(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_acc_off   uuid;
  v_type_ct   uuid;
  v_ct_pay    uuid;
  v_ct_voucher uuid;
  rec         RECORD;
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  SELECT building_id INTO v_building FROM rooms WHERE id = v_contract.room_id;
  IF v_building IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nh�� của hợp đồng'; END IF;

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

  -- 2. Đánh dấu mọi hoá đơn còn nợ → PAID qua CẤN TRỪ (payments method='CT', KHÔNG
  --    phải tiền mặt — nên không lẫn vào thống kê TM). Mỗi khoản kèm 1 phiếu thu
  --    cấn trừ vào sổ ảo "Cấn trừ thanh lý (nội bộ)" (ngoài KQKD) để truy vết.
  --    Doanh thu/tiền thật được ghi riêng ở B3-4.
  v_acc_off := public._termination_offset_account(v_contract.user_id);
  v_type_ct := public._termination_ensure_type(v_contract.user_id, 'income', 'Cấn trừ thanh lý');
  UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_ct AND is_deposit IS DISTINCT FROM FALSE;
  FOR rec IN
    SELECT id, (total_amount - paid_amount) AS remaining FROM invoices
     WHERE contract_id = p_contract_id AND deleted_at IS NULL AND status <> 'CANCELLED'
       AND (total_amount - paid_amount) > 0
     ORDER BY billing_month, created_at
  LOOP
    INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
    VALUES (v_contract.user_id, rec.id, rec.remaining, 'CT'::payment_method, p_move_out_date,
            'Cấn trừ công nợ khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY'))
    RETURNING id INTO v_ct_pay;
    INSERT INTO income_expenses (user_id, type, name, building_id, room_id, contract_id, account_id, invoice_id, payment_id, voucher_date, total_amount, approval_status, business_result_accounting, notes)
    VALUES (v_contract.user_id, 'INCOME', 'Cấn trừ thanh lý — HĐ ' || v_cnumber, v_building, v_contract.room_id, p_contract_id, v_acc_off, rec.id, v_ct_pay, p_move_out_date, rec.remaining, 'APPROVED', FALSE,
            '[CẤN TRỪ] Đối trừ công nợ hoá đơn khi thanh lý — không phải tiền mặt.')
    RETURNING id INTO v_ct_voucher;
    INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
    VALUES (v_ct_voucher, v_type_ct, 'Cấn trừ thanh lý', 1, rec.remaining, p_move_out_date, p_move_out_date);
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
END $function$
;

-- ============ trg_forfeit_settle_on_approve (TM -> CT) ============
CREATE OR REPLACE FUNCTION public.trg_forfeit_settle_on_approve()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_pay_note text;
BEGIN
  -- Chỉ xử lý phiếu thuộc nhóm "cấn cọc bỏ cọc".
  IF NEW.notes IS NULL OR NEW.notes NOT LIKE '[CẤN CỌC BỎ CỌC %' THEN
    RETURN NULL;
  END IF;

  -- DUYỆT: UNAPPROVED → APPROVED
  IF NEW.approval_status = 'APPROVED'
     AND COALESCE(OLD.approval_status,'') <> 'APPROVED'
     AND NEW.deleted_at IS NULL THEN
    -- Duyệt nốt phiếu còn lại cùng nhóm (1 cú bấm xong cả cặp).
    UPDATE income_expenses
       SET approval_status = 'APPROVED',
           approved_by     = NEW.approved_by,
           approved_at     = NEW.approved_at,
           updated_at      = NOW()
     WHERE contract_id = NEW.contract_id
       AND id <> NEW.id
       AND notes LIKE '[CẤN CỌC BỎ CỌC %'
       AND deleted_at IS NULL
       AND approval_status = 'UNAPPROVED';

    -- Phiếu THU gắn hoá đơn → INSERT payments để hoá đơn thanh lý → PAID.
    IF NEW.type = 'INCOME' AND NEW.invoice_id IS NOT NULL AND COALESCE(NEW.total_amount,0) > 0 THEN
      v_pay_note := '[CẤN CỌC BỎ CỌC PAYMENT ' || NEW.id::text || ']';
      INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
      SELECT NEW.user_id, NEW.invoice_id, NEW.total_amount, 'CT'::payment_method,
             COALESCE(NEW.voucher_date, CURRENT_DATE), v_pay_note
       WHERE NOT EXISTS (
         SELECT 1 FROM payments WHERE invoice_id = NEW.invoice_id AND notes = v_pay_note
       );
    END IF;
    RETURN NULL;
  END IF;

  -- ĐẢO DUYỆT: APPROVED → UNAPPROVED/CANCELLED (gỡ đối xứng)
  IF COALESCE(OLD.approval_status,'') = 'APPROVED'
     AND NEW.approval_status IN ('UNAPPROVED','CANCELLED') THEN
    IF NEW.type = 'INCOME' AND NEW.invoice_id IS NOT NULL THEN
      DELETE FROM payments
       WHERE invoice_id = NEW.invoice_id
         AND notes = '[CẤN CỌC BỎ CỌC PAYMENT ' || NEW.id::text || ']';
    END IF;
    UPDATE income_expenses
       SET approval_status = NEW.approval_status, updated_at = NOW()
     WHERE contract_id = NEW.contract_id
       AND id <> NEW.id
       AND notes LIKE '[CẤN CỌC BỎ CỌC %'
       AND deleted_at IS NULL
       AND approval_status = 'APPROVED';
    RETURN NULL;
  END IF;

  RETURN NULL;
END;
$function$
;

-- ============ get_invoice_statistics_v2 (+ payment_ct) ============
CREATE OR REPLACE FUNCTION public.get_invoice_statistics_v2(p_building_id uuid DEFAULT NULL::uuid, p_room_id uuid DEFAULT NULL::uuid, p_status invoice_status DEFAULT NULL::invoice_status, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_billing_month text DEFAULT NULL::text, p_payment_status text DEFAULT NULL::text, p_building_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total_paid        DECIMAL(15, 2) := 0;
  v_total_remaining   DECIMAL(15, 2) := 0;
  v_total_amount      DECIMAL(15, 2) := 0;
  v_total_refunded    DECIMAL(15, 2) := 0;
  v_total_count       BIGINT         := 0;
  v_rent_amount       DECIMAL(15, 2) := 0;
  v_electric_amount   DECIMAL(15, 2) := 0;
  v_water_amount      DECIMAL(15, 2) := 0;
  v_pdv_amount        DECIMAL(15, 2) := 0;
  v_total_collected   DECIMAL(15, 2) := 0;
  v_payment_tm        DECIMAL(15, 2) := 0;
  v_payment_tk        DECIMAL(15, 2) := 0;
  v_payment_tt        DECIMAL(15, 2) := 0;
  v_change_amount     DECIMAL(15, 2) := 0;
  v_deposit_collected DECIMAL(15, 2) := 0;
  v_payment_ct        DECIMAL(15, 2) := 0;
BEGIN
  WITH filtered_invoices AS (
    SELECT i.id, i.total_amount, i.paid_amount, i.remaining_amount
    FROM public.invoices i
    WHERE i.deleted_at IS NULL
      AND public.can_access_building(i.building_id)
      AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
      AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
      AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
      AND (p_status        IS NULL OR i.status        = p_status)
      AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
      AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
      AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
      AND (
        p_payment_status IS NULL
        OR (p_payment_status = 'paid'    AND i.status = 'PAID')
        OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
        OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
      )
  )
  SELECT
    COALESCE(SUM(total_amount), 0),
    COALESCE(SUM(paid_amount), 0),
    COALESCE(SUM(GREATEST(remaining_amount, 0)), 0),
    COALESCE(SUM(GREATEST(-remaining_amount, 0)), 0),
    COUNT(*)
  INTO v_total_amount, v_total_paid, v_total_remaining, v_total_refunded, v_total_count
  FROM filtered_invoices;

  SELECT
    COALESCE(SUM(CASE WHEN ii.type = 'RENT' THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%điện%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE
      WHEN ii.type NOT IN ('RENT','DISCOUNT')
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%điện%'
        AND LOWER(COALESCE(ii.description, '')) NOT LIKE '%nước%'
      THEN ii.amount ELSE 0 END), 0)
  INTO v_rent_amount, v_electric_amount, v_water_amount, v_pdv_amount
  FROM public.invoices i
  JOIN public.invoice_items ii ON ii.invoice_id = i.id
  WHERE i.deleted_at IS NULL
    AND public.can_access_building(i.building_id)
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT
    COALESCE(SUM(p.amount), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TM' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TK' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'TT' THEN p.amount ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN p.payment_method = 'CT' THEN p.amount ELSE 0 END), 0)
  INTO v_total_collected, v_payment_tm, v_payment_tk, v_payment_tt, v_payment_ct
  FROM public.payments p
  JOIN public.invoices i ON i.id = p.invoice_id
  WHERE i.deleted_at IS NULL
    AND public.can_access_building(i.building_id)
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  SELECT COALESCE(SUM(ie.change_amount), 0)
  INTO v_change_amount
  FROM public.income_expenses ie
  JOIN public.invoices i ON i.id = ie.invoice_id
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.change_amount > 0
    AND i.deleted_at IS NULL
    AND public.can_access_building(i.building_id)
    AND (p_building_id   IS NULL OR i.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR i.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR i.room_id       = p_room_id)
    AND (p_status        IS NULL OR i.status        = p_status)
    AND (p_start_date    IS NULL OR i.issue_date    >= p_start_date)
    AND (p_end_date      IS NULL OR i.issue_date    <= p_end_date)
    AND (p_billing_month IS NULL OR i.billing_month = p_billing_month)
    AND (
      p_payment_status IS NULL
      OR (p_payment_status = 'paid'    AND i.status = 'PAID')
      OR (p_payment_status = 'partial' AND i.status = 'PARTIAL_PAID')
      OR (p_payment_status = 'unpaid'  AND i.status NOT IN ('PAID','PARTIAL_PAID'))
    );

  -- Cọc đã thu — filter theo ie.building_id/room_id/voucher_date.
  SELECT COALESCE(SUM(ie.total_amount), 0)
  INTO v_deposit_collected
  FROM public.income_expenses ie
  WHERE ie.deleted_at IS NULL
    AND ie.type = 'INCOME'
    AND ie.approval_status = 'APPROVED'
    AND public.can_access_building(ie.building_id)
    AND (p_building_id   IS NULL OR ie.building_id   = p_building_id)
    AND (p_building_ids  IS NULL OR ie.building_id   = ANY(p_building_ids))
    AND (p_room_id       IS NULL OR ie.room_id       = p_room_id)
    AND (p_start_date    IS NULL OR ie.voucher_date  >= p_start_date)
    AND (p_end_date      IS NULL OR ie.voucher_date  <= p_end_date)
    AND (p_billing_month IS NULL OR to_char(ie.voucher_date, 'YYYY-MM') = p_billing_month)
    AND EXISTS (
      SELECT 1
      FROM public.income_expense_items it
      JOIN public.income_expense_types t ON t.id = it.income_expense_type_id
      WHERE it.income_expense_id = ie.id AND t.is_deposit = TRUE
    );

  RETURN json_build_object(
    'total_amount',       v_total_amount,
    'total_paid',         v_total_paid,
    'total_remaining',    v_total_remaining,
    'total_refunded',     v_total_refunded,
    'total_count',        v_total_count,
    'rent_amount',        v_rent_amount,
    'electric_amount',    v_electric_amount,
    'water_amount',       v_water_amount,
    'pdv_amount',         v_pdv_amount,
    'total_collected',    v_total_collected,
    'payment_tm',         v_payment_tm,
    'payment_tk',         v_payment_tk,
    'payment_tt',         v_payment_tt,
    'payment_ct',         v_payment_ct,
    'change_amount',      v_change_amount,
    'deposit_collected',  v_deposit_collected
  );
END;
$function$
;
