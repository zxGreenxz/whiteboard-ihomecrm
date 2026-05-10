-- =============================================================================
-- Termination v3: full settlement invoice, no auto-payment, no auto-voucher.
--
-- Round 2 still wasn't right:
--   • The MOVE_OUT invoice only carried the penalty line — the deposit
--     refund and excess rent only existed inside Thu chi, so the printed
--     hoá đơn lost half the story.
--   • Both functions auto-created the cash voucher. The user wants the
--     voucher to come from clicking "Ghi nhận thanh toán" on the invoice,
--     so the cashbook entry mirrors a real cash event.
--
-- New shape:
--   • One settlement invoice that lists everything:
--       PENALTY items   → penalty_fee (charge to tenant)
--       DISCOUNT items  → deposit_refund + excess_rent (credit to tenant)
--     subtotal       = penalty_fee
--     discount_amount= deposit_refund + excess_rent
--     total_amount   = subtotal - discount_amount   (can be negative)
--   • status = APPROVED. No payment row. No voucher row.
--   • The FE "Ghi nhận thanh toán" decides Phiếu thu vs Phiếu chi based on
--     sign(total_amount - paid_amount). The DB just stores the truth.
--
-- recompute_invoice_for_id is taught to flip a negative-total invoice to
-- PAID once an EXPENSE voucher of the matching abs(total) lands on it.
-- =============================================================================


-- ── Drop the helpers from the previous attempt; rewritten below ──────────
DROP FUNCTION IF EXISTS public.terminate_contract_forfeit(uuid, date);
DROP FUNCTION IF EXISTS public.terminate_contract_move_out(uuid, date, numeric, numeric, numeric, numeric, text);


-- =============================================================================
-- terminate_contract_forfeit — khách bỏ cọc
-- =============================================================================
CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit(
  p_contract_id  uuid,
  p_forfeit_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contract     RECORD;
  v_building_id  uuid;
  v_invoice_id   uuid;
  v_deposit      numeric(15,2);
  v_billing      text;
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

  v_deposit := COALESCE(v_contract.total_deposit, 0);
  v_billing := to_char(COALESCE(p_forfeit_date, CURRENT_DATE), 'YYYY-MM');

  IF v_contract.room_id IS NULL THEN
    RAISE EXCEPTION 'Hợp đồng chưa gán phòng — không thể thanh lý';
  END IF;
  SELECT building_id INTO v_building_id FROM rooms WHERE id = v_contract.room_id;
  IF v_building_id IS NULL THEN
    RAISE EXCEPTION 'Không xác định được toà nhà của hợp đồng';
  END IF;

  -- ── Settlement invoice — penalty = forfeited deposit ──────────────────
  IF v_deposit > 0 THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id, bed_id,
      billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id, v_contract.bed_id,
      v_billing, p_forfeit_date, p_forfeit_date,
      'APPROVED'::invoice_status, v_deposit, 0, v_deposit,
      'Hoá đơn thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
    )
    RETURNING id INTO v_invoice_id;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, 'PENALTY',
      'Phí phạt khách bỏ cọc (giữ tiền cọc)',
      v_deposit, 1, 1, v_deposit, 1
    );
  END IF;

  -- ── Terminate the contract (room/bed freed by trigger) ────────────────
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

  -- ── Audit row ────────────────────────────────────────────────────────
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      'FORFEIT', v_deposit, 'COMPLETED', auth.uid(), NOW(),
      'Khách bỏ cọc — chờ ghi nhận thanh toán để lập phiếu thu.'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id',    p_contract_id,
    'invoice_id',     v_invoice_id,
    'forfeit_amount', v_deposit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_forfeit(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid,date) TO authenticated;


-- =============================================================================
-- terminate_contract_move_out — khách rời phòng
-- =============================================================================
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
  v_invoice_id   uuid;
  v_billing      text;
  v_deposit      numeric(15,2) := COALESCE(p_deposit_refund, 0);
  v_penalty      numeric(15,2) := COALESCE(p_penalty_fee,    0);
  v_excess       numeric(15,2) := COALESCE(p_excess_rent,    0);
  v_debt         numeric(15,2) := COALESCE(p_outstanding_debt, 0);
  v_credit       numeric(15,2);
  v_total        numeric(15,2);
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

  v_billing := to_char(COALESCE(p_move_out_date, CURRENT_DATE), 'YYYY-MM');
  v_credit  := v_deposit + v_excess;
  v_total   := v_penalty - v_credit;   -- > 0 khách trả thêm; < 0 chủ trả lại

  -- ── Settlement invoice with all line items ────────────────────────────
  IF v_penalty > 0 OR v_credit > 0 THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id, bed_id,
      billing_month, issue_date, due_date,
      status, subtotal, discount_amount, total_amount,
      previous_debt, notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id, v_contract.bed_id,
      v_billing, p_move_out_date, p_move_out_date,
      'APPROVED'::invoice_status, v_penalty, v_credit, v_total,
      v_debt,
      'Hoá đơn thanh lý — khách rời phòng ngày ' || to_char(p_move_out_date,'DD/MM/YYYY')
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id INTO v_invoice_id;

    IF v_penalty > 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_invoice_id, 'PENALTY', 'Phí phạt thanh lý', v_penalty, 1, 1, v_penalty, v_sort);
    END IF;

    IF v_deposit > 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_invoice_id, 'DISCOUNT', 'Tiền cọc hoàn trả', v_deposit, 1, 1, v_deposit, v_sort);
    END IF;

    IF v_excess > 0 THEN
      v_sort := v_sort + 1;
      INSERT INTO invoice_items (invoice_id, type, description, unit_price, quantity, coefficient, amount, sort_order)
      VALUES (v_invoice_id, 'DISCOUNT', 'Tiền phòng thừa', v_excess, 1, 1, v_excess, v_sort);
    END IF;
  END IF;

  -- ── Terminate the contract ────────────────────────────────────────────
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

  -- ── Audit row ────────────────────────────────────────────────────────
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
      v_debt + v_penalty, v_credit,
      'COMPLETED', auth.uid(), NOW(),
      COALESCE(p_notes,'') || ' — chờ ghi nhận thanh toán.'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id,
    'invoice_id',  v_invoice_id,
    'penalty',     v_penalty,
    'credit',      v_credit,
    'net_total',   v_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text) TO authenticated;


-- =============================================================================
-- recompute_invoice_for_id — handle negative-total settlement invoices.
--
-- For positive totals (the normal case) the math is unchanged: paid =
-- SUM(payments) - SUM(EXPENSE 'Tiền thối' linked to invoice).
--
-- For negative totals (landlord owes tenant), the cash event is a Phiếu
-- chi linked to the invoice. Treat any EXPENSE voucher with the same
-- invoice_id (and the type name 'Hoàn trả thanh lý') as a refund payment
-- — paid_amount becomes -SUM(refund_voucher_total). Status flips to PAID
-- once paid <= total (i.e. the refund covers the obligation).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.recompute_invoice_for_id(p_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total    numeric(15,2);
  v_paid     numeric(15,2);
  v_refunded numeric(15,2);
  v_settle   numeric(15,2);
  v_status   invoice_status;
  v_paid_date date;
BEGIN
  IF p_invoice_id IS NULL THEN RETURN; END IF;

  SELECT total_amount INTO v_total FROM invoices WHERE id = p_invoice_id;
  IF v_total IS NULL THEN RETURN; END IF;

  SELECT COALESCE(SUM(amount), 0), MAX(payment_date)
    INTO v_paid, v_paid_date
    FROM payments
   WHERE invoice_id = p_invoice_id;

  SELECT COALESCE(SUM(iei.unit_price * iei.quantity), 0)
    INTO v_refunded
    FROM income_expenses ie
    JOIN income_expense_items iei ON iei.income_expense_id = ie.id
    JOIN income_expense_types iet ON iet.id = iei.income_expense_type_id
   WHERE ie.invoice_id = p_invoice_id
     AND ie.type = 'EXPENSE'
     AND ie.approval_status = 'APPROVED'
     AND ie.deleted_at IS NULL
     AND iet.name = 'Tiền thối';

  SELECT COALESCE(SUM(ie.total_amount), 0)
    INTO v_settle
    FROM income_expenses ie
   WHERE ie.invoice_id = p_invoice_id
     AND ie.type = 'EXPENSE'
     AND ie.approval_status = 'APPROVED'
     AND ie.deleted_at IS NULL
     AND ie.notes LIKE '[Hoàn trả thanh lý]%';

  v_paid := v_paid - v_refunded - v_settle;

  IF v_total > 0 THEN
    IF v_paid >= v_total THEN
      v_status := 'PAID';
    ELSIF v_paid > 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSIF v_total < 0 THEN
    -- Landlord-owes-tenant invoice: refund settles it.
    IF v_paid <= v_total THEN
      v_status := 'PAID';
    ELSIF v_paid < 0 THEN
      v_status := 'PARTIAL_PAID';
      v_paid_date := NULL;
    ELSE
      v_status := 'APPROVED';
      v_paid_date := NULL;
    END IF;
  ELSE
    -- Net zero settlement; treat as PAID once anything is recorded, else APPROVED.
    v_status := CASE WHEN v_paid <> 0 THEN 'PAID'::invoice_status ELSE 'APPROVED'::invoice_status END;
  END IF;

  UPDATE invoices
     SET paid_amount = v_paid,
         status      = v_status,
         paid_date   = v_paid_date
   WHERE id = p_invoice_id;
END;
$$;
