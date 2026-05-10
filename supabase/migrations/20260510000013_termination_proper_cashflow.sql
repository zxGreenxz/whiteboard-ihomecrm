-- =============================================================================
-- Termination cash-flow rewrite.
--
-- The first cut auto-marked the settlement invoice as PAID by stuffing the
-- deposit refund into prepaid_amount. That's wrong: prepaid_amount is for
-- excess from prior payments, not for "the landlord owes the tenant the
-- difference". The tenant didn't pay anything new and no Phiếu chi was
-- recorded — money showed as settled when in reality it hadn't moved.
--
-- Resident's model is one event ⇒ one cash voucher (PT/PC) inside Thu chi.
-- That's what useInvoicePayments already does for normal payments. The
-- termination flow now mirrors it:
--
--   Khách bỏ cọc (FORFEIT)
--     • Invoice for the forfeited deposit (status APPROVED, then PAID via
--       record_invoice_payment trigger).
--     • One payment of `deposit` — the deposit was already in landlord's
--       cashbook, this just recognises it as revenue.
--     • One Phiếu thu (income_expenses INCOME) tied to invoice + payment +
--       contract, posted to the matching building cashbook.
--
--   Khách rời phòng (MOVE_OUT)
--     • Invoice with subtotal = penalty (the only NEW charge), status
--       APPROVED. No auto-payment — the penalty might be paid in cash, or
--       netted against the deposit refund, that's the user's call.
--     • If deposit_refund + excess_rent > 0, a single Phiếu chi (EXPENSE)
--       for the gross refund, posted to the matching building cashbook.
--
-- The previous helper "v_building_id := SELECT building_id FROM rooms" stays.
-- =============================================================================

-- ── Pick the cashbook (accounts.id) that best matches a building ─────────
-- Prefers exact name match (the seed data uses building name as account
-- name), then a default account, then the first cash account for the user.
CREATE OR REPLACE FUNCTION public._termination_pick_account(
  p_user_id     uuid,
  p_building_id uuid
)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH building AS (
    SELECT name FROM buildings WHERE id = p_building_id
  )
  SELECT a.id
    FROM accounts a, building
   WHERE a.user_id = p_user_id
     AND a.deleted_at IS NULL
   ORDER BY (a.name = building.name) DESC,
            a.is_default DESC NULLS LAST,
            a.created_at
   LIMIT 1;
$$;


-- ── Get-or-create a per-user income/expense category for terminations ────
-- We want stable names so reports group correctly across users without
-- relying on seed data. If the user already has a type with the exact name,
-- reuse it; otherwise create one.
CREATE OR REPLACE FUNCTION public._termination_ensure_type(
  p_user_id uuid,
  p_type    text,    -- 'income' or 'expense'
  p_name    text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id
    FROM income_expense_types
   WHERE user_id = p_user_id
     AND lower(name) = lower(p_name)
     AND lower(type) = lower(p_type)
   LIMIT 1;

  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  INSERT INTO income_expense_types (user_id, type, name, description)
  VALUES (p_user_id, lower(p_type), p_name,
          'Tự tạo khi thanh lý hợp đồng')
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;


-- =============================================================================
-- terminate_contract_forfeit — khách bỏ cọc
-- =============================================================================
DROP FUNCTION IF EXISTS public.terminate_contract_forfeit(uuid, date);

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
  v_account_id   uuid;
  v_type_id      uuid;
  v_invoice_id   uuid;
  v_payment_id   uuid;
  v_voucher_id   uuid;
  v_deposit      numeric(15,2);
  v_billing      text;
  v_invoice_no   text;
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

  -- ── 1. Invoice for the forfeited deposit ──────────────────────────────
  IF v_deposit > 0 THEN
    INSERT INTO invoices (
      user_id, contract_id, building_id, room_id, bed_id,
      billing_month, issue_date, due_date,
      status, subtotal, total_amount,
      notes
    ) VALUES (
      v_contract.user_id, p_contract_id,
      v_building_id, v_contract.room_id, v_contract.bed_id,
      v_billing, p_forfeit_date, p_forfeit_date,
      'APPROVED'::invoice_status, v_deposit, v_deposit,
      'Hoá đơn thanh lý — khách bỏ cọc ngày ' || to_char(p_forfeit_date,'DD/MM/YYYY')
    )
    RETURNING id, invoice_number INTO v_invoice_id, v_invoice_no;

    INSERT INTO invoice_items (
      invoice_id, type, description,
      unit_price, quantity, coefficient, amount, sort_order
    ) VALUES (
      v_invoice_id, 'PENALTY',
      'Phí phạt khách bỏ cọc (giữ tiền cọc)',
      v_deposit, 1, 1, v_deposit, 1
    );

    -- ── 2. Payment — deposit was already in cashbook ────────────────────
    INSERT INTO payments (
      user_id, invoice_id, amount, payment_method, payment_date,
      notes
    ) VALUES (
      v_contract.user_id, v_invoice_id, v_deposit,
      'TM'::payment_method, p_forfeit_date,
      'Khách bỏ cọc — chuyển tiền cọc đã nhận thành doanh thu.'
    )
    RETURNING id INTO v_payment_id;
    -- The trg_payments_recompute_invoice trigger will flip the invoice to PAID.

    -- ── 3. Phiếu thu (income_expenses INCOME) ────────────────────────────
    v_account_id := public._termination_pick_account(v_contract.user_id, v_building_id);
    v_type_id    := public._termination_ensure_type(v_contract.user_id, 'income', 'Tiền cọc khách bỏ');

    INSERT INTO income_expenses (
      user_id, type, name, building_id, room_id, bed_id,
      contract_id, account_id, invoice_id, payment_id,
      voucher_date, total_amount, approval_status, notes
    ) VALUES (
      v_contract.user_id, 'INCOME',
      'Thu tiền cọc khách bỏ — HĐ ' || COALESCE(v_contract.contract_number, p_contract_id::text),
      v_building_id, v_contract.room_id, v_contract.bed_id,
      p_contract_id, v_account_id, v_invoice_id, v_payment_id,
      p_forfeit_date, v_deposit, 'APPROVED',
      'Tự tạo khi thanh lý — khách bỏ cọc.'
    )
    RETURNING id INTO v_voucher_id;

    INSERT INTO income_expense_items (
      income_expense_id, income_expense_type_id, description,
      quantity, unit_price, start_date, end_date
    ) VALUES (
      v_voucher_id, v_type_id,
      'Tiền cọc khách bỏ — HĐ ' || COALESCE(v_contract.contract_number, p_contract_id::text),
      1, v_deposit, p_forfeit_date, p_forfeit_date
    );
  END IF;

  -- ── 4. Terminate the contract (room/bed freed by trigger) ─────────────
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

  -- ── 5. Audit row ──────────────────────────────────────────────────────
  BEGIN
    INSERT INTO contract_terminations (
      user_id, contract_id, termination_date, actual_move_out_date,
      termination_type, total_deposit, status, approved_by, approved_at, notes
    ) VALUES (
      v_contract.user_id, p_contract_id, p_forfeit_date, p_forfeit_date,
      'FORFEIT', v_deposit, 'COMPLETED', auth.uid(), NOW(),
      'Khách bỏ cọc — tiền cọc ghi nhận doanh thu, lập phiếu thu.'
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN jsonb_build_object(
    'contract_id',    p_contract_id,
    'invoice_id',     v_invoice_id,
    'payment_id',     v_payment_id,
    'voucher_id',     v_voucher_id,
    'forfeit_amount', v_deposit
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_forfeit(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid,date) TO authenticated;


-- =============================================================================
-- terminate_contract_move_out — khách rời phòng
-- =============================================================================
-- Two cash flows live in Thu chi after this runs:
--   • Phiếu chi (EXPENSE) for `deposit_refund + excess_rent` if > 0 — the
--     real cash leaving the cashbook.
--   • Invoice for `penalty_fee` if > 0, status APPROVED — waits for the
--     tenant to pay (or for the user to manually record a netting payment).
--
-- We deliberately do NOT auto-net or auto-pay. Netting is a business call
-- (the tenant might walk away, the deposit might be partially seized, etc.)
-- and the previous attempt's auto-PAID + prepaid_amount hack was confusing.
-- =============================================================================
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
  v_type_id      uuid;
  v_invoice_id   uuid;
  v_invoice_no   text;
  v_refund_voucher_id uuid;
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

  -- ── 2. Phiếu chi for the refund (deposit + excess rent) ───────────────
  IF v_refund_total > 0 THEN
    v_type_id := public._termination_ensure_type(v_contract.user_id, 'expense', 'Hoàn cọc / tiền thừa khi thanh lý');

    INSERT INTO income_expenses (
      user_id, type, name, building_id, room_id, bed_id,
      contract_id, account_id,
      voucher_date, total_amount, approval_status, notes
    ) VALUES (
      v_contract.user_id, 'EXPENSE',
      'Hoàn cọc/tiền thừa thanh lý — HĐ ' || COALESCE(v_contract.contract_number, p_contract_id::text),
      v_building_id, v_contract.room_id, v_contract.bed_id,
      p_contract_id, v_account_id,
      p_move_out_date, v_refund_total, 'APPROVED',
      'Tự tạo khi thanh lý — chủ nhà hoàn cọc và/hoặc tiền phòng thừa.'
        || COALESCE(E'\n' || p_notes, '')
    )
    RETURNING id INTO v_refund_voucher_id;

    IF v_deposit > 0 THEN
      INSERT INTO income_expense_items (
        income_expense_id, income_expense_type_id, description,
        quantity, unit_price, start_date, end_date
      ) VALUES (
        v_refund_voucher_id, v_type_id, 'Hoàn tiền cọc',
        1, v_deposit, p_move_out_date, p_move_out_date
      );
    END IF;

    IF v_excess > 0 THEN
      INSERT INTO income_expense_items (
        income_expense_id, income_expense_type_id, description,
        quantity, unit_price, start_date, end_date
      ) VALUES (
        v_refund_voucher_id, v_type_id, 'Hoàn tiền phòng thừa',
        1, v_excess, p_move_out_date, p_move_out_date
      );
    END IF;
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
    'contract_id',       p_contract_id,
    'invoice_id',        v_invoice_id,
    'refund_voucher_id', v_refund_voucher_id,
    'penalty',           v_penalty,
    'refund_total',      v_refund_total
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_contract_move_out(uuid,date,numeric,numeric,numeric,numeric,text) TO authenticated;
