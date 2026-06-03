-- =====================================================================
-- Thanh lý "khách rời phòng" — HOÁ ĐƠN THANH LÝ = CHỨNG TỪ TỔNG HỢP ĐẦY ĐỦ
--
-- YÊU CẦU (user): hoá đơn thanh lý phải hiển thị ĐẦY ĐỦ mọi khoản khi thanh lý
-- (cả khoản thu LẪN phần hoàn cọc/tiền phòng thừa cho khách), net ra "số tiền
-- quyết toán". Phiếu thu/chi chỉ là các PHIẾU CON đại diện từng dòng tiền của
-- hoá đơn. Cọc KHÔNG vào KQKD; các khoản khác thì có.
--
-- Trước đây hoá đơn thanh lý chỉ mang phần PHẢI THU (tiền phòng + phạt), còn
-- phần HOÀN CỌC nằm rời ở phiếu chi → hoá đơn không phản ánh đủ cuộc quyết toán.
--
-- MÔ HÌNH MỚI:
--   • Hoá đơn thanh lý (1 hoá đơn/kỳ) chứa:
--       − các khoản phải thu (tiền phòng/điện/nước/dịch vụ + phí phạt) > 0
--       − dòng "Hoàn tiền cọc" (âm)  và  "Hoàn tiền phòng thừa" (âm)
--     ⇒ total_amount = Σ tất cả = SỐ QUYẾT TOÁN (âm = chủ trả lại khách).
--     (Bảng invoices/invoice_items KHÔNG cấm số âm — đã kiểm.)
--   • Phiếu con gắn invoice_id:
--       − Phiếu THU "Thu thanh lý (khấu trừ cọc)"  = phần thu thực (vào KQKD)
--       − Phiếu CHI "Hoàn cọc thanh lý" (is_deposit, NGOÀI KQKD)
--       − Phiếu CHI "Hoàn tiền phòng thừa" (trong KQKD, giảm doanh thu)
--   • recompute_invoice_for_id mở rộng: trừ thêm phiếu chi hoàn cọc/tiền thừa
--     khỏi "đã thu net" và xử lý hoá đơn TỔNG ÂM ⇒ khi tiền đã khớp thì PAID,
--     hết công nợ treo.
--
-- KQKD vẫn do PHIẾU quyết định (đã đúng): cọc is_deposit → ngoài P&L; thu &
-- hoàn tiền thừa → trong P&L. Hoá đơn chỉ là chứng từ tổng hợp.
--
-- An toàn: hiện 0 hoá đơn nào đang gắn phiếu "Hoàn cọc/tiền thừa" → mở rộng
-- recompute không đụng dữ liệu cũ; nhánh tổng > 0 giữ NGUYÊN logic cũ.
-- =====================================================================

-- ── 1. recompute_invoice_for_id — nhận diện phiếu hoàn + xử lý tổng âm ──
CREATE OR REPLACE FUNCTION public.recompute_invoice_for_id(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_total     NUMERIC(15,2);
  v_collected NUMERIC(15,2);
  v_refunded  NUMERIC(15,2);
  v_paid      NUMERIC(15,2);
  v_status    invoice_status;
  v_existing  invoice_status;
  v_paid_date DATE;
  v_threshold CONSTANT NUMERIC(15,2) := 10000;
BEGIN
  IF p_invoice_id IS NULL THEN RETURN; END IF;

  SELECT total_amount, status INTO v_total, v_existing
  FROM invoices WHERE id = p_invoice_id;
  IF v_total IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(amount), 0), MAX(payment_date)
  INTO v_collected, v_paid_date
  FROM payments WHERE invoice_id = p_invoice_id;

  -- Khoản chi gắn hoá đơn làm GIẢM "đã thu net":
  --   • "Tiền thối"                              (đã có từ trước)
  --   • "Hoàn cọc thanh lý" / "Hoàn tiền phòng thừa" (phiếu con hoá đơn quyết toán)
  SELECT COALESCE(SUM(iei.unit_price * iei.quantity), 0)
  INTO v_refunded
  FROM income_expenses ie
  JOIN income_expense_items iei ON iei.income_expense_id = ie.id
  JOIN income_expense_types iet ON iet.id = iei.income_expense_type_id
  WHERE ie.invoice_id = p_invoice_id
    AND ie.type = 'EXPENSE'
    AND ie.approval_status = 'APPROVED'
    AND ie.deleted_at IS NULL
    AND iet.name IN ('Tiền thối', 'Hoàn cọc thanh lý', 'Hoàn tiền phòng thừa');

  v_paid := v_collected - v_refunded;

  -- HĐ đã huỷ: cập nhật paid_amount nhưng GIỮ CANCELLED (không hồi sinh).
  IF v_existing = 'CANCELLED' THEN
    UPDATE invoices SET paid_amount = v_paid WHERE id = p_invoice_id;
    RETURN;
  END IF;

  IF v_total > 0 THEN
    -- ── Hoá đơn dương: GIỮ NGUYÊN logic cũ ──
    IF v_paid > 0 AND (v_total - v_paid) < v_threshold THEN
      v_status := 'PAID';
    ELSIF v_paid >= v_total THEN
      v_status := 'PAID';
    ELSIF v_paid > 0 THEN
      v_status := 'PARTIAL_PAID'; v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED'; v_paid_date := NULL;
    END IF;
  ELSE
    -- ── Hoá đơn quyết toán/hoàn trả (tổng ≤ 0, chủ nợ khách) ──
    IF v_collected = 0 AND v_refunded = 0 THEN
      -- Chưa có động tĩnh (gồm hoá đơn âm legacy) → giữ chờ.
      v_status := 'APPROVED'; v_paid_date := NULL;
    ELSIF abs(v_total - v_paid) < v_threshold THEN
      -- Tiền đã khớp tổng quyết toán → xong.
      v_status := 'PAID';
    ELSE
      v_status := 'PARTIAL_PAID'; v_paid_date := NULL;
    END IF;
  END IF;

  UPDATE invoices
  SET paid_amount = v_paid,
      status      = v_status,
      paid_date   = v_paid_date
  WHERE id = p_invoice_id;
END;
$function$;

-- ── 2. terminate_contract_move_out_impl — hoá đơn tổng hợp đầy đủ ──────
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
  v_contract     RECORD;
  v_building_id  uuid;
  v_account_id   uuid;
  v_billing      text;
  v_cnumber      text;
  v_deposit      numeric(15,2) := COALESCE(p_deposit_refund, 0);
  v_penalty      numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess       numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt         numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_pool         numeric(15,2);
  v_collected    numeric(15,2) := 0;
  v_net_refund   numeric(15,2);
  v_settle_inv   uuid;
  v_next_sort    integer;
  v_type_inc     uuid;
  v_type_dep     uuid;
  v_type_exc     uuid;
  v_dep_voucher  uuid;
  v_exc_voucher  uuid;
  v_payment_id   uuid;
  v_inc_voucher  uuid;
  rec            RECORD;
  v_pay          numeric(15,2);
BEGIN
  SELECT * INTO v_contract FROM contracts WHERE id = p_contract_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Hợp đồng không tồn tại'; END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn'; END IF;
  IF v_contract.room_id IS NULL THEN RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý'; END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng'; END IF;

  v_billing    := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_account_id := public._termination_pick_account(v_contract.user_id, v_building_id);
  v_cnumber    := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_pool       := v_deposit + v_excess;

  -- ── 1. Hoá đơn quyết toán của tháng (dùng HĐ còn sống, hoặc tạo mới) ──
  SELECT id INTO v_settle_inv
    FROM invoices
   WHERE contract_id = p_contract_id
     AND billing_month = v_billing
     AND deleted_at IS NULL
     AND status <> 'CANCELLED'
   ORDER BY (status = 'PAID'), created_at
   LIMIT 1;

  IF v_settle_inv IS NULL
     AND (v_penalty > 0 OR v_deposit > 0 OR v_excess > 0 OR v_debt > 0) THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id,
      billing_month, issue_date, due_date,
      status, subtotal, total_amount, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id,
      v_billing, p_move_out_date, p_move_out_date,
      'APPROVED'::invoice_status, 0, 0,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY')
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id INTO v_settle_inv;
  END IF;

  -- ── 2. Gộp phí phạt vào hoá đơn (1 dòng PENALTY) ──────────────────────
  IF v_penalty > 0 AND v_settle_inv IS NOT NULL THEN
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);
    UPDATE invoices
       SET subtotal = COALESCE(subtotal,0) + v_penalty,
           total_amount = COALESCE(total_amount,0) + v_penalty,
           updated_at = NOW()
     WHERE id = v_settle_inv;
  END IF;

  -- ── 3. Khấu trừ phần PHẢI THU vào cọc/tiền thừa (phiếu thu con → KQKD) ─
  --     Chạy TRƯỚC khi thêm dòng hoàn (lúc này tổng HĐ còn dương = phải thu).
  IF v_pool > 0 THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khấu trừ cọc)');
    UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    FOR rec IN
      SELECT id, (total_amount - paid_amount) AS remaining
        FROM invoices
       WHERE contract_id = p_contract_id
         AND deleted_at IS NULL
         AND status <> 'CANCELLED'
         AND (total_amount - paid_amount) > 0
       ORDER BY billing_month, created_at
    LOOP
      EXIT WHEN v_pool <= 0;
      v_pay := LEAST(rec.remaining, v_pool);
      IF v_pay > 0 THEN
        INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
        VALUES (v_contract.user_id, rec.id, v_pay, 'TM'::payment_method, p_move_out_date,
                'Khấu trừ vào tiền cọc khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY'))
        RETURNING id INTO v_payment_id;

        INSERT INTO income_expenses (
          user_id, type, name, building_id, room_id,
          contract_id, account_id, invoice_id, payment_id,
          voucher_date, total_amount, approval_status, notes
        ) VALUES (
          v_contract.user_id, 'INCOME', 'Thu thanh lý (khấu trừ cọc) — HĐ ' || v_cnumber,
          v_building_id, v_contract.room_id, p_contract_id, v_account_id, rec.id, v_payment_id,
          p_move_out_date, v_pay, 'APPROVED',
          'Tự tạo khi thanh lý — khấu trừ công nợ/phí phạt vào tiền cọc.'
        )
        RETURNING id INTO v_inc_voucher;

        INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
        VALUES (v_inc_voucher, v_type_inc, 'Khấu trừ công nợ/phí phạt vào cọc', 1, v_pay, p_move_out_date, p_move_out_date);

        v_pool      := v_pool - v_pay;
        v_collected := v_collected + v_pay;
      END IF;
    END LOOP;
  END IF;

  -- ── 4. Thêm dòng HOÀN (âm) vào hoá đơn + phiếu chi con gắn hoá đơn ─────
  IF v_settle_inv IS NOT NULL AND (v_deposit > 0 OR v_excess > 0) THEN
    SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_next_sort FROM invoice_items WHERE invoice_id = v_settle_inv;

    IF v_deposit > 0 THEN
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_settle_inv, 'OTHER', 'Hoàn tiền cọc cho khách', -v_deposit, 1, 1, -v_deposit, v_next_sort);
      v_next_sort := v_next_sort + 1;
    END IF;
    IF v_excess > 0 THEN
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_settle_inv, 'OTHER', 'Hoàn tiền phòng thừa cho khách', -v_excess, 1, 1, -v_excess, v_next_sort);
    END IF;

    UPDATE invoices
       SET total_amount = COALESCE(total_amount,0) - v_deposit - v_excess,
           updated_at = NOW()
     WHERE id = v_settle_inv;

    -- Phiếu chi HOÀN CỌC (is_deposit → ngoài P&L), gắn hoá đơn.
    IF v_deposit > 0 THEN
      v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
      UPDATE income_expense_types SET is_deposit = TRUE WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;

      INSERT INTO income_expenses (
        user_id, type, name, building_id, room_id,
        contract_id, account_id, invoice_id,
        voucher_date, total_amount, approval_status, notes
      ) VALUES (
        v_contract.user_id, 'EXPENSE', 'Hoàn cọc thanh lý — HĐ ' || v_cnumber,
        v_building_id, v_contract.room_id, p_contract_id, v_account_id, v_settle_inv,
        p_move_out_date, v_deposit, 'APPROVED',
        'Tự tạo khi thanh lý — hoàn tiền cọc cho khách (không tính KQKD).' || COALESCE(E'\n' || p_notes, '')
      )
      RETURNING id INTO v_dep_voucher;

      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_dep_voucher, v_type_dep, 'Hoàn tiền cọc', 1, v_deposit, p_move_out_date, p_move_out_date);
    END IF;

    -- Phiếu chi HOÀN TIỀN PHÒNG THỪA (trong P&L), gắn hoá đơn.
    IF v_excess > 0 THEN
      v_type_exc := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thừa');
      UPDATE income_expense_types SET is_deposit = FALSE WHERE id = v_type_exc AND is_deposit IS DISTINCT FROM FALSE;

      INSERT INTO income_expenses (
        user_id, type, name, building_id, room_id,
        contract_id, account_id, invoice_id,
        voucher_date, total_amount, approval_status, notes
      ) VALUES (
        v_contract.user_id, 'EXPENSE', 'Hoàn tiền phòng thừa thanh lý — HĐ ' || v_cnumber,
        v_building_id, v_contract.room_id, p_contract_id, v_account_id, v_settle_inv,
        p_move_out_date, v_excess, 'APPROVED',
        'Tự tạo khi thanh lý — hoàn tiền phòng khách đóng dư (giảm doanh thu).' || COALESCE(E'\n' || p_notes, '')
      )
      RETURNING id INTO v_exc_voucher;

      INSERT INTO income_expense_items (income_expense_id, income_expense_type_id, description, quantity, unit_price, start_date, end_date)
      VALUES (v_exc_voucher, v_type_exc, 'Hoàn tiền phòng thừa', 1, v_excess, p_move_out_date, p_move_out_date);
    END IF;
  END IF;

  -- Đảm bảo hoá đơn được tính lại trạng thái cuối (kể cả khi total đổi mà không
  -- có phiếu nào trigger sau đó).
  IF v_settle_inv IS NOT NULL THEN
    PERFORM public.recompute_invoice_for_id(v_settle_inv);
  END IF;

  v_net_refund := (v_deposit + v_excess) - v_collected;   -- tiền mặt ròng trả khách

  -- ── 5. Thanh lý hợp đồng ──────────────────────────────────────────────
  UPDATE contracts
     SET status          = 'TERMINATED',
         actual_end_date = p_move_out_date,
         notes           = CASE
                             WHEN notes IS NULL OR length(btrim(notes)) = 0
                               THEN '[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']'
                                    || COALESCE(E'\n' || p_notes, '')
                             ELSE notes || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY') || ']'
                                  || COALESCE(E'\n' || p_notes, '')
                           END,
         updated_at      = NOW()
   WHERE id = p_contract_id;

  -- ── 6. Audit row ──────────────────────────────────────────────────────
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, outstanding_debt,
      early_termination_fee, total_deposit,
      total_deductions, refund_amount,
      status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date,
      'NORMAL', v_debt, v_penalty, COALESCE(v_contract.total_deposit, 0),
      v_collected, v_net_refund, 'COMPLETED', auth.uid(), NOW(), p_notes
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id',          p_contract_id,
    'settlement_invoice_id', v_settle_inv,
    'penalty',              v_penalty,
    'collected_from_deposit', v_collected,
    'deposit_refund',       v_deposit,
    'excess_refund',        v_excess,
    'net_refund',           v_net_refund
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
