-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.terminate_contract_move_out_with_credit_v1(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric, p_penalty_fee numeric, p_excess_rent numeric, p_outstanding_debt numeric, p_notes text, p_extra_charges jsonb, p_shortfall_mode text, p_receipt_account_id uuid, p_idempotency_key text, p_refund_items jsonb) md5(prosrc)=dfffdc97765e2ce18223f90c81a79ffa
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out_with_credit_v1(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric, p_penalty_fee numeric, p_excess_rent numeric, p_outstanding_debt numeric, p_notes text, p_extra_charges jsonb, p_shortfall_mode text, p_receipt_account_id uuid, p_idempotency_key text, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_credit_amount numeric(15,2) := round(COALESCE(p_excess_rent, 0), 2);
  v_org uuid;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_termination jsonb;
  v_credit jsonb;
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_excess_rent = 'NaN'::numeric
     OR COALESCE(p_excess_rent, 0) < 0
     OR COALESCE(p_excess_rent, 0) IS DISTINCT FROM round(
       COALESCE(p_excess_rent, 0), 2
     ) THEN
    RAISE EXCEPTION 'Move-out credit amount must be non-negative with at most two decimals'
      USING ERRCODE = '22023';
  END IF;

  SELECT contract_row.organization_id INTO v_org
  FROM public.contracts contract_row
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Contract not found' USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'contract_id', p_contract_id,
    'move_out_date', p_move_out_date,
    'deposit_refund', p_deposit_refund,
    'penalty_fee', p_penalty_fee,
    'excess_rent', p_excess_rent,
    'outstanding_debt', p_outstanding_debt,
    'notes', p_notes,
    'extra_charges', COALESCE(p_extra_charges, '[]'::jsonb),
    'shortfall_mode', p_shortfall_mode,
    'receipt_account_id', p_receipt_account_id,
    'refund_items', COALESCE(p_refund_items, '[]'::jsonb)
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'contract.terminate.move_out.credit.v1', p_contract_id::text,
    v_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'contract.terminate.move_out.credit.v1'
    AND operation_row.subject_scope = p_contract_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key was reused with a different payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  -- [A2] Tính năng áp credit chưa bật ⇒ CHẶN SỚM, trước khi ghi bất cứ thứ gì.
  -- Không sao chép nhánh deferred của forfeit sang đây: terminate_contract_move_out
  -- đã TIÊU credit trên trục tiền (cấn nợ CT + phiếu hoàn) NGAY trong lệnh dưới,
  -- nên hoãn burn-down = chi HAI LẦN. Chặn trước là cách duy nhất đúng.
  IF v_credit_amount > 0
     AND app_private.evaluate_feature_route('customer.credit.apply.v1', v_org)
         IS DISTINCT FROM 'CANONICAL' THEN
    RAISE EXCEPTION 'Tính năng áp tiền trả dư (credit) vào quyết toán chưa được kích hoạt, nên không thể thanh lý kèm % đ tiền thừa. Hãy để ô "Tiền phòng thừa" bằng 0 rồi thanh lý; khoản dư giữ nguyên trên sổ và xử lý riêng.',
      round(v_credit_amount)::bigint
      USING ERRCODE = '55000';
  END IF;
  PERFORM app_private.begin_accounting_chain_write_v1();
  v_termination := public.terminate_contract_move_out(
    p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
    COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
    COALESCE(p_outstanding_debt, 0), p_notes,
    COALESCE(p_extra_charges, '[]'::jsonb),
    COALESCE(p_shortfall_mode, 'PAID'), p_receipt_account_id,
    COALESCE(p_refund_items, '[]'::jsonb)
  );
  PERFORM app_private.end_accounting_chain_write_v1();

  IF v_credit_amount > 0 THEN
    v_credit := app_private.apply_customer_credit_fifo_v1(
      v_actor, p_contract_id, v_credit_amount, NULL, 'MOVE_OUT',
      'Apply customer credit during move-out settlement', v_key
    );
  ELSE
    v_credit := jsonb_build_object(
      'contract_id', p_contract_id,
      'application_kind', 'MOVE_OUT',
      'applied_amount', 0,
      'applications', '[]'::jsonb
    );
  END IF;

  v_response := jsonb_build_object(
    'termination', v_termination,
    'credit', v_credit
  );
  UPDATE app_private.canonical_write_operations
     SET subject_id = p_contract_id,
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'contract.terminate.move_out.credit.v1'
     AND subject_scope = p_contract_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END;
$function$

