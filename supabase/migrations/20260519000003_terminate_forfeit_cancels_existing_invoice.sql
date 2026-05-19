-- =============================================================================
-- Fix: terminate_contract_forfeit colliding with existing invoice for the
-- same billing_month → duplicate key violation on
-- idx_invoices_unique_contract_billing.
--
-- Khi khách bỏ cọc giữa kỳ, hoá đơn tiền phòng của tháng đó (nếu chưa thanh
-- toán) phải được huỷ — nó đã không còn nghĩa lý vì khách đi và mất cọc.
-- Sau đó RPC mới INSERT được "hoá đơn thanh lý" cho cùng (contract_id,
-- billing_month).
--
-- Nếu có hoá đơn tháng đó đã thu một phần/toàn bộ thì RPC raise lỗi rõ ràng
-- để user xử lý tay (huỷ hoặc hoàn tiền) trước khi thanh lý.
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
  v_contract       RECORD;
  v_building_id    uuid;
  v_invoice_id     uuid;
  v_deposit        numeric(15,2);
  v_billing        text;
  v_paid_exists    boolean;
  v_cancelled_cnt  integer;
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

  -- ── Block khi có hoá đơn tháng đó đã thu tiền (một phần hoặc toàn bộ) ──
  SELECT EXISTS (
    SELECT 1 FROM invoices
     WHERE contract_id   = p_contract_id
       AND billing_month = v_billing
       AND deleted_at    IS NULL
       AND status        <> 'CANCELLED'
       AND COALESCE(paid_amount, 0) > 0
  ) INTO v_paid_exists;
  IF v_paid_exists THEN
    RAISE EXCEPTION
      'Đã có hoá đơn tháng % được thanh toán một phần/toàn bộ — hãy xử lý hoá đơn này trước khi thanh lý bỏ cọc.',
      v_billing;
  END IF;

  -- ── Huỷ tự động mọi hoá đơn unpaid của tháng đó ────────────────────────
  UPDATE invoices
     SET status     = 'CANCELLED',
         notes      = CASE
                        WHEN notes IS NULL OR length(btrim(notes)) = 0
                          THEN '[Huỷ tự động — thanh lý bỏ cọc ngày '
                               || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                        ELSE notes
                             || E'\n[Huỷ tự động — thanh lý bỏ cọc ngày '
                             || to_char(p_forfeit_date,'DD/MM/YYYY') || ']'
                      END,
         updated_at = NOW()
   WHERE contract_id   = p_contract_id
     AND billing_month = v_billing
     AND deleted_at    IS NULL
     AND status        <> 'CANCELLED'
     AND COALESCE(paid_amount, 0) = 0;
  GET DIAGNOSTICS v_cancelled_cnt = ROW_COUNT;

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
        || CASE WHEN v_cancelled_cnt > 0
                  THEN E'\n(Đã huỷ ' || v_cancelled_cnt
                       || ' hoá đơn chưa thanh toán của tháng '
                       || v_billing || ')'
                  ELSE '' END
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
    'contract_id',       p_contract_id,
    'invoice_id',        v_invoice_id,
    'forfeit_amount',    v_deposit,
    'cancelled_invoices', v_cancelled_cnt
  );
END;
$$;

REVOKE ALL ON FUNCTION public.terminate_contract_forfeit(uuid,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.terminate_contract_forfeit(uuid,date) TO authenticated;

NOTIFY pgrst, 'reload schema';
