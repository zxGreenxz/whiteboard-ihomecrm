-- transfer_room_with_notice_v2 owns the permission checks and the surrounding transaction.
CREATE OR REPLACE FUNCTION app_private.quote_room_transfer_deposit_v1(
  p_contract_id uuid, p_new_room_id uuid, p_new_deposit numeric
) RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  v_contract public.contracts%ROWTYPE;
  v_required numeric;
  v_held numeric;
  v_shortfall numeric;
  v_billed numeric;
BEGIN
  SELECT c.* INTO STRICT v_contract FROM public.contracts c
  WHERE c.id = p_contract_id AND c.deleted_at IS NULL;

  SELECT COALESCE(p_new_deposit, r.deposit_amount, v_contract.total_deposit)
    INTO STRICT v_required
  FROM public.rooms r
  WHERE r.id = p_new_room_id AND r.organization_id = v_contract.organization_id AND r.deleted_at IS NULL;
  IF v_required IS NULL OR v_required < 0 OR v_required > 9999999999999.99
     OR v_required <> round(v_required, 2) THEN
    RAISE EXCEPTION 'Tiền cọc yêu cầu không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_held := COALESCE(v_contract.deposit_paid, 0);
  v_shortfall := GREATEST(v_required - v_held, 0);

  -- The invoice collection RPC allocates DEPOSIT lines and carried deposit debt
  -- separately from revenue. Deduct approved coverage using the same provenance.
  SELECT COALESCE(sum(GREATEST(0, LEAST(
    i.total_amount - COALESCE(i.paid_amount, 0),
    COALESCE((SELECT sum(it.amount) FROM public.invoice_items it
              WHERE it.invoice_id = i.id AND it.accounting_class = 'DEPOSIT'), 0)
    + COALESCE((SELECT sum((debt->>'amount')::numeric)
                FROM jsonb_array_elements(i.previous_debt_sources) debt WHERE debt->>'type' = 'deposit'), 0)
    - COALESCE((SELECT sum(COALESCE(it.amount, it.quantity * it.unit_price))
                FROM public.income_expenses v
                JOIN public.income_expense_items it ON it.income_expense_id = v.id
                LEFT JOIN public.invoice_payment_collections ipc ON ipc.id = v.payment_collection_id
                LEFT JOIN public.payments pay ON pay.id = v.payment_id
                WHERE v.invoice_id = i.id AND v.type = 'INCOME' AND v.approval_status = 'APPROVED'
                  AND v.deleted_at IS NULL AND it.accounting_class = 'DEPOSIT'
                  AND (v.payment_collection_id IS NULL OR ipc.status = 'ACTIVE')
                  AND (v.payment_id IS NULL OR pay.reversed_at IS NULL)), 0)
  ))), 0) INTO v_billed
  FROM public.invoices i
  WHERE i.organization_id = v_contract.organization_id AND i.contract_id = p_contract_id
    AND i.deleted_at IS NULL AND i.status <> 'CANCELLED' AND i.total_amount > COALESCE(i.paid_amount, 0);
  IF v_billed > v_shortfall THEN
    RAISE EXCEPTION 'Hóa đơn còn thu cọc vượt số thiếu theo mức cọc mới. Hãy điều chỉnh hóa đơn trước khi chuyển phòng.'
      USING ERRCODE = '55000';
  END IF;

  RETURN jsonb_build_object('required_deposit', v_required, 'held_deposit', v_held,
                            'deposit_invoiced_shortfall', v_billed, 'deposit_unbilled_shortfall', v_shortfall - v_billed,
                            'deposit_shortfall', v_shortfall, 'deposit_surplus', GREATEST(v_held - v_required, 0));
END;
$$;

CREATE OR REPLACE FUNCTION app_private.apply_room_transfer_deposit_v1(
  p_contract_id uuid, p_new_room_id uuid, p_new_deposit numeric
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog AS $$
DECLARE
  v_quote jsonb;
  v_required numeric;
  v_contract public.contracts%ROWTYPE;
  v_reclassify boolean := false;
BEGIN
  -- Contract and target room are already locked by the transfer. Serialize with
  -- deposit_paid recomputations as well, and apply only after the move succeeded.
  SELECT c.* INTO v_contract FROM public.contracts c
  WHERE c.id = p_contract_id AND c.room_id = p_new_room_id AND c.deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Hợp đồng chưa chuyển đến phòng mới' USING ERRCODE = '55000';
  END IF;
  v_quote := app_private.quote_room_transfer_deposit_v1(p_contract_id, p_new_room_id, p_new_deposit);
  v_required := (v_quote->>'required_deposit')::numeric;
  -- The original invoice can still collect its own items. A new amount above
  -- its outstanding deposit needs the regular contract top-up route.
  IF v_contract.deposit_debt_mode = 'FIRST_INVOICE' AND v_required > v_contract.total_deposit
     AND (v_quote->>'deposit_unbilled_shortfall')::numeric > 0 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.invoices i
      WHERE i.organization_id=v_contract.organization_id AND i.contract_id=p_contract_id
        AND i.deleted_at IS NULL AND i.status <> 'CANCELLED' AND i.kind='MONTHLY'
        AND (EXISTS (SELECT 1 FROM app_private.canonical_write_operations op
              WHERE op.organization_id=i.organization_id AND op.subject_id=p_contract_id AND op.operation='contract.create.v2'
                AND op.completed_at IS NOT NULL AND op.response_payload #>> '{invoice,id}'=i.id::text)
          OR (v_contract.start_billing_date IS NOT NULL AND v_contract.end_billing_date IS NOT NULL
              AND i.billing_month=public.compute_first_billing_month_v2(v_contract.start_billing_date,v_contract.end_billing_date)
              AND EXISTS (SELECT 1 FROM public.invoice_items it WHERE it.invoice_id=i.id AND it.accounting_class='DEPOSIT')))
    ) INTO v_reclassify;
  END IF;
  UPDATE public.contracts SET total_deposit = v_required,
      deposit_debt_mode = CASE WHEN v_reclassify THEN 'DEBT' ELSE deposit_debt_mode END,
      deposit_debt_reason = CASE WHEN v_reclassify THEN concat_ws(E'\n', nullif(deposit_debt_reason,''),
        'Bổ sung cọc sau khi chuyển phòng. Thu phần còn ghi trên hóa đơn qua hóa đơn đó. Chỉ lập phiếu thu cọc riêng cho phần thiếu chưa có trên hóa đơn.')
        ELSE deposit_debt_reason END
  WHERE id = p_contract_id AND total_deposit IS DISTINCT FROM v_required;
  RETURN v_quote;
END;
$$;

REVOKE ALL ON FUNCTION app_private.quote_room_transfer_deposit_v1(uuid,uuid,numeric) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.apply_room_transfer_deposit_v1(uuid,uuid,numeric) FROM PUBLIC, anon, authenticated, service_role;
