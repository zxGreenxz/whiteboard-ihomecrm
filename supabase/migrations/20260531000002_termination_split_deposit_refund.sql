-- =====================================================================
-- Thanh lý "khách rời phòng" — TÁCH phiếu chi hoàn tiền thành 2 loại:
--   (a) Hoàn CỌC          → hạng mục "Hoàn cọc thanh lý" (is_deposit=TRUE)
--                            → tự loại khỏi báo cáo Lợi nhuận (đối xứng với
--                              lúc thu cọc, vốn cũng loại khỏi P&L).
--   (b) Hoàn TIỀN PHÒNG THỪA → hạng mục "Hoàn tiền phòng thừa"
--                            (is_deposit=FALSE) → vẫn TÍNH vào P&L (giảm
--                              doanh thu, vì tiền phòng trước đó đã ghi thu).
--
-- Trước đây gộp cả hai vào 1 phiếu chung hạng mục "Hoàn cọc / tiền thừa
-- khi thanh lý" → không thể phân biệt trong P&L. Cờ counts_in_business_result
-- ở mức PHIẾU, nên buộc phải tách thành 2 phiếu riêng để mỗi phiếu đồng nhất.
--
-- Phần còn lại (invoice phí phạt, terminate contract, audit) giữ nguyên.
-- =====================================================================
DROP FUNCTION IF EXISTS public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text);

CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(
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
  v_type_dep     uuid;   -- hạng mục hoàn cọc (is_deposit=TRUE)
  v_type_exc     uuid;   -- hạng mục hoàn tiền phòng thừa (is_deposit=FALSE)
  v_invoice_id   uuid;
  v_invoice_no   text;
  v_dep_voucher_id uuid;
  v_exc_voucher_id uuid;
  v_billing      text;
  v_deposit      numeric(15,2) := COALESCE(p_deposit_refund, 0);
  v_penalty      numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess       numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt         numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_refund_total numeric(15,2);
  v_sort         integer := 0;
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

  v_billing      := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_refund_total := v_deposit + v_excess;
  v_account_id   := public._termination_pick_account(v_contract.user_id, v_building_id);

  -- ── 1. Penalty invoice (charge to tenant) ─────────────────────────────
  IF v_penalty > 0 THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id, bed_id,
      billing_month, issue_date, due_date,
      status, subtotal, total_amount,
      previous_debt, notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id, v_contract.bed_id,
      v_billing, p_move_out_date, p_move_out_date,
      'APPROVED'::invoice_status, v_penalty, v_penalty,
      v_debt,
      'Hoá đơn thanh lý — phí phạt khi khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY')
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id, invoice_number INTO v_invoice_id, v_invoice_no;

    v_sort := v_sort + 1;
    INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
    VALUES (v_invoice_id, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_sort);
  END IF;

  -- ── 2a. Phiếu chi HOÀN CỌC (loại khỏi P&L) ────────────────────────────
  IF v_deposit > 0 THEN
    v_type_dep := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc thanh lý');
    -- Đảm bảo hạng mục này được đánh dấu là cọc (tự loại khỏi báo cáo Lợi nhuận).
    UPDATE income_expense_types
       SET is_deposit = TRUE
     WHERE id = v_type_dep AND is_deposit IS DISTINCT FROM TRUE;

    INSERT INTO income_expenses (
      user_id, type, name, building_id, room_id, bed_id,
      contract_id, account_id,
      voucher_date, total_amount, approval_status, notes
    ) VALUES (
      v_contract.user_id, 'EXPENSE',
      'Hoàn cọc thanh lý — HĐ ' || COALESCE(v_contract.contract_number, p_contract_id::text),
      v_building_id, v_contract.room_id, v_contract.bed_id,
      p_contract_id, v_account_id,
      p_move_out_date, v_deposit, 'APPROVED',
      'Tự tạo khi thanh lý — hoàn tiền cọc cho khách (không tính KQKD).'
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id INTO v_dep_voucher_id;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, start_date, end_date
    ) VALUES (
      v_dep_voucher_id, v_type_dep, 'Hoàn tiền cọc',
      1, v_deposit, p_move_out_date, p_move_out_date
    );
  END IF;

  -- ── 2b. Phiếu chi HOÀN TIỀN PHÒNG THỪA (vẫn tính P&L) ─────────────────
  IF v_excess > 0 THEN
    v_type_exc := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn tiền phòng thừa');
    -- Hạng mục này KHÔNG phải cọc → giảm doanh thu, vẫn tính KQKD.
    UPDATE income_expense_types
       SET is_deposit = FALSE
     WHERE id = v_type_exc AND is_deposit IS DISTINCT FROM FALSE;

    INSERT INTO income_expenses (
      user_id, type, name, building_id, room_id, bed_id,
      contract_id, account_id,
      voucher_date, total_amount, approval_status, notes
    ) VALUES (
      v_contract.user_id, 'EXPENSE',
      'Hoàn tiền phòng thừa thanh lý — HĐ ' || COALESCE(v_contract.contract_number, p_contract_id::text),
      v_building_id, v_contract.room_id, v_contract.bed_id,
      p_contract_id, v_account_id,
      p_move_out_date, v_excess, 'APPROVED',
      'Tự tạo khi thanh lý — hoàn tiền phòng khách đóng dư (giảm doanh thu).'
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id INTO v_exc_voucher_id;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, start_date, end_date
    ) VALUES (
      v_exc_voucher_id, v_type_exc, 'Hoàn tiền phòng thừa',
      1, v_excess, p_move_out_date, p_move_out_date
    );
  END IF;

  -- ── 3. Terminate the contract ─────────────────────────────────────────
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

  -- ── 4. Audit row ──────────────────────────────────────────────────────
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
      v_debt + v_penalty, v_refund_total,
      'COMPLETED', auth.uid(), NOW(), p_notes
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id',              p_contract_id,
    'invoice_id',               v_invoice_id,
    'deposit_refund_voucher_id', v_dep_voucher_id,
    'excess_refund_voucher_id',  v_exc_voucher_id,
    'penalty',                  v_penalty,
    'refund_total',             v_refund_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text) TO authenticated;
