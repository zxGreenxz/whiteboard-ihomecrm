-- =====================================================================
-- FIX + REWRITE: terminate_contract_move_out_impl — thanh lý "khách rời phòng"
--
-- BUG GỐC (409 duplicate key idx_invoices_unique_contract_billing):
--   Bản cũ khi phí phạt > 0 luôn INSERT MỘT hoá đơn phạt MỚI với
--   billing_month = tháng chuyển đi. Nếu HĐ đã có hoá đơn còn sống cùng tháng
--   (công nợ tiền phòng kỳ đó) → đụng unique index (contract_id, billing_month)
--   → 23505. Nó KHÔNG hề gộp/khấu trừ hoá đơn cũ vào hoá đơn mới: cột
--   previous_debt được set nhưng không cộng vào total_amount (số trang trí),
--   còn hoá đơn cũ vẫn sống → 2 hoá đơn cùng kỳ.
--
-- SAI BẢN CHẤT (kể cả khi không crash):
--   Bản cũ làm 3 việc rời rạc: (1) tạo HĐ phạt, (2) phiếu chi hoàn cọc GROSS,
--   (3) KHÔNG đụng công nợ cũ. ⇒ tiền cọc ra hết 3.2tr trong khi công nợ
--   (tiền phòng + phạt) treo mãi, KHÔNG khớp "Số tiền quyết toán" mà dialog
--   tính (deposit + excess − debt − penalty).
--
-- MÔ HÌNH MỚI (auto-net — đúng với dialog & KQKD):
--   Doanh thu/P&L của hệ thống tính theo PHIẾU THU (income_expenses), không
--   theo hoá đơn (xem 20260531000001). Nên để khớp một con số quyết toán:
--     1. PHÍ PHẠT → gộp thành 1 dòng PENALTY vào hoá đơn còn sống của tháng
--        chuyển đi (nếu chưa có HĐ tháng đó thì tạo mới). KHÔNG đẻ hoá đơn thứ
--        hai ⇒ hết đụng unique index.
--     2. KHẤU TRỪ VÀO CỌC → duyệt mọi hoá đơn còn nợ của HĐ, ghi payment +
--        phiếu thu INCOME (vào P&L) tới khi tiêu hết (deposit + excess). Hoá
--        đơn được trigger recompute set PAID ⇒ hết công nợ treo, ghi nhận đúng
--        doanh thu tiền phòng + phạt.
--     3. HOÀN CỌC/TIỀN THỪA → giữ phiếu chi GROSS như cũ: cọc (is_deposit=TRUE,
--        ngoài P&L) + tiền phòng thừa (is_deposit=FALSE, giảm doanh thu).
--   Tiền mặt ròng rời sổ quỹ = thu (khấu trừ) − hoàn (gross) = −(deposit +
--   excess − debt − penalty) = đúng "Chủ nhà trả lại khách". Trường hợp âm
--   ("khách phải trả thêm") tự xử lý: chỉ thu tới mức cọc, phần dư còn nợ.
--
-- Giữ NGUYÊN signature để wrapper terminate_contract_move_out (kiểm quyền,
-- 20260601000100) gọi không đổi. CREATE OR REPLACE không đổi quyền hiện có.
-- =====================================================================

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
  v_contract      RECORD;
  v_building_id   uuid;
  v_account_id    uuid;
  v_billing       text;
  v_cnumber       text;

  v_deposit       numeric(15,2) := COALESCE(p_deposit_refund, 0);
  v_penalty       numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess        numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt          numeric(15,2) := COALESCE(p_outstanding_debt, 0);

  v_pool          numeric(15,2);          -- cọc + tiền thừa còn dùng để khấu trừ
  v_collected     numeric(15,2) := 0;     -- đã khấu trừ vào cọc (= ghi doanh thu)
  v_net_refund    numeric(15,2);          -- tiền mặt thực trả lại khách

  v_settle_inv    uuid;                   -- hoá đơn quyết toán (mang phí phạt)
  v_next_sort     integer;
  v_type_inc      uuid;                   -- hạng mục thu "khấu trừ cọc" (P&L)
  v_type_dep      uuid;                   -- hạng mục chi hoàn cọc (ngoài P&L)
  v_type_exc      uuid;                   -- hạng mục chi hoàn tiền thừa (P&L)
  v_dep_voucher   uuid;
  v_exc_voucher   uuid;
  v_payment_id    uuid;
  v_inc_voucher   uuid;
  rec             RECORD;
  v_pay           numeric(15,2);
BEGIN
  SELECT * INTO v_contract
    FROM contracts
   WHERE id = p_contract_id
     AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng không tồn tại';
  END IF;
  IF v_contract.status IN ('TERMINATED','EXPIRED') THEN
    RAISE EXCEPTION 'Hợp đồng đã thanh lý/hết hạn';
  END IF;
  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;

  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  v_billing    := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_account_id := public._termination_pick_account(v_contract.user_id, v_building_id);
  v_cnumber    := COALESCE(v_contract.contract_number, p_contract_id::text);
  v_pool       := v_deposit + v_excess;

  -- ── 1. Phí phạt → gộp vào hoá đơn còn sống của tháng chuyển đi ─────────
  IF v_penalty > 0 THEN
    SELECT id INTO v_settle_inv
      FROM invoices
     WHERE contract_id   = p_contract_id
       AND billing_month = v_billing
       AND deleted_at    IS NULL
       AND status        <> 'CANCELLED'
     ORDER BY (status = 'PAID'), created_at   -- ưu tiên hoá đơn chưa thu
     LIMIT 1;

    IF v_settle_inv IS NOT NULL THEN
      -- Thêm 1 dòng PENALTY và nâng subtotal/total (giữ nguyên các khoản cũ).
      SELECT COALESCE(MAX(sort_order), 0) + 1 INTO v_next_sort
        FROM invoice_items WHERE invoice_id = v_settle_inv;

      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_next_sort);

      UPDATE invoices
         SET subtotal     = COALESCE(subtotal, 0)     + v_penalty,
             total_amount = COALESCE(total_amount, 0) + v_penalty,
             notes = COALESCE(notes, '')
                     || E'\n[Thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY')
                     || ' — cộng phí phạt ' || to_char(v_penalty, 'FM999G999G999') || 'đ]',
             updated_at = NOW()
       WHERE id = v_settle_inv;
    ELSE
      -- Chưa có hoá đơn tháng đó → tạo hoá đơn quyết toán chỉ chứa phí phạt.
      INSERT INTO invoices (
        user_id, contract_id, building_id, room_id,
        billing_month, issue_date, due_date,
        status, subtotal, total_amount, notes
      ) VALUES (
        v_contract.user_id, p_contract_id, v_building_id, v_contract.room_id,
        v_billing, p_move_out_date, p_move_out_date,
        'APPROVED'::invoice_status, v_penalty, v_penalty,
        'Hoá đơn thanh lý — phí phạt khi khách rời phòng ngày '
          || to_char(p_move_out_date,'DD/MM/YYYY') || COALESCE(E'\n' || p_notes, '')
      )
      RETURNING id INTO v_settle_inv;

      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_settle_inv, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, 1);
    END IF;
  END IF;

  -- ── 2. Khấu trừ công nợ + phạt vào cọc/tiền thừa (ghi phiếu thu → P&L) ─
  IF v_pool > 0 THEN
    v_type_inc := public._termination_ensure_type(v_contract.user_id, 'income', 'Thu thanh lý (khấu trừ cọc)');
    UPDATE income_expense_types
       SET is_deposit = FALSE
     WHERE id = v_type_inc AND is_deposit IS DISTINCT FROM FALSE;

    FOR rec IN
      SELECT id, (total_amount - paid_amount) AS remaining
        FROM invoices
       WHERE contract_id = p_contract_id
         AND deleted_at  IS NULL
         AND status      <> 'CANCELLED'
         AND (total_amount - paid_amount) > 0
       ORDER BY billing_month, created_at
    LOOP
      EXIT WHEN v_pool <= 0;
      v_pay := LEAST(rec.remaining, v_pool);
      IF v_pay > 0 THEN
        INSERT INTO payments (user_id, invoice_id, amount, payment_method, payment_date, notes)
        VALUES (
          v_contract.user_id, rec.id, v_pay, 'TM'::payment_method, p_move_out_date,
          'Khấu trừ vào tiền cọc khi thanh lý ' || to_char(p_move_out_date,'DD/MM/YYYY')
        )
        RETURNING id INTO v_payment_id;
        -- trigger trg_payments_recompute_invoice tự set hoá đơn PAID/PARTIAL.

        INSERT INTO income_expenses (
          user_id, type, name, building_id, room_id,
          contract_id, account_id, invoice_id, payment_id,
          voucher_date, total_amount, approval_status, notes
        ) VALUES (
          v_contract.user_id, 'INCOME',
          'Thu thanh lý (khấu trừ cọc) — HĐ ' || v_cnumber,
          v_building_id, v_contract.room_id,
          p_contract_id, v_account_id, rec.id, v_payment_id,
          p_move_out_date, v_pay, 'APPROVED',
          'Tự tạo khi thanh lý — khấu trừ công nợ/phí phạt vào tiền cọc.'
        )
        RETURNING id INTO v_inc_voucher;

        INSERT INTO income_expense_items (
          income_expense_id, income_expense_type_id, description,
          quantity, unit_price, start_date, end_date
        ) VALUES (
          v_inc_voucher, v_type_inc, 'Khấu trừ công nợ/phí phạt vào cọc',
          1, v_pay, p_move_out_date, p_move_out_date
        );

        v_pool      := v_pool - v_pay;
        v_collected := v_collected + v_pay;
      END IF;
    END LOOP;
  END IF;

  -- ── 3a. Phiếu chi HOÀN CỌC (gross, loại khỏi P&L) ─────────────────────
  IF v_deposit > 0 THEN
    v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
    UPDATE income_expense_types
       SET is_deposit = TRUE
     WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;

    INSERT INTO income_expenses (
      user_id, type, name, building_id, room_id,
      contract_id, account_id,
      voucher_date, total_amount, approval_status, notes
    ) VALUES (
      v_contract.user_id, 'EXPENSE',
      'Hoàn cọc thanh lý — HĐ ' || v_cnumber,
      v_building_id, v_contract.room_id,
      p_contract_id, v_account_id,
      p_move_out_date, v_deposit, 'APPROVED',
      'Tự tạo khi thanh lý — hoàn tiền cọc cho khách (không tính KQKD).'
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id INTO v_dep_voucher;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, start_date, end_date
    ) VALUES (
      v_dep_voucher, v_type_dep, 'Hoàn tiền cọc',
      1, v_deposit, p_move_out_date, p_move_out_date
    );
  END IF;

  -- ── 3b. Phiếu chi HOÀN TIỀN PHÒNG THỪA (vẫn tính P&L) ─────────────────
  IF v_excess > 0 THEN
    v_type_exc := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thừa');
    UPDATE income_expense_types
       SET is_deposit = FALSE
     WHERE id = v_type_exc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (
      user_id, type, name, building_id, room_id,
      contract_id, account_id,
      voucher_date, total_amount, approval_status, notes
    ) VALUES (
      v_contract.user_id, 'EXPENSE',
      'Hoàn tiền phòng thừa thanh lý — HĐ ' || v_cnumber,
      v_building_id, v_contract.room_id,
      p_contract_id, v_account_id,
      p_move_out_date, v_excess, 'APPROVED',
      'Tự tạo khi thanh lý — hoàn tiền phòng khách đóng dư (giảm doanh thu).'
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id INTO v_exc_voucher;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, start_date, end_date
    ) VALUES (
      v_exc_voucher, v_type_exc, 'Hoàn tiền phòng thừa',
      1, v_excess, p_move_out_date, p_move_out_date
    );
  END IF;

  v_net_refund := (v_deposit + v_excess) - v_collected;   -- tiền mặt ròng trả khách

  -- ── 4. Thanh lý hợp đồng ──────────────────────────────────────────────
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

  -- ── 5. Audit row ──────────────────────────────────────────────────────
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, outstanding_debt,
      early_termination_fee, total_deposit,
      total_deductions, refund_amount,
      status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_move_out_date, p_move_out_date,
      'NORMAL', v_debt,
      v_penalty, COALESCE(v_contract.total_deposit, 0),
      v_collected, v_net_refund,
      'COMPLETED', auth.uid(), NOW(), p_notes
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
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
