-- =============================================================================
-- Thanh lý bỏ cọc: KHÔNG chặn khi tính năng "tiền khách trả dư" chưa bật.
--
-- BUG: terminate_contract_forfeit_with_credit_v1 gọi apply_customer_credit_fifo_v1
--   VÔ ĐIỀU KIỆN khi contract còn dư customer-credit (v_credit_balance > 0). Nhưng
--   apply_customer_credit_fifo_v1 ném 55000 "Customer credit writer is not enabled"
--   khi evaluate_feature_route('customer.credit.apply.v1', org) <> 'CANONICAL'
--   (tính năng đang SHADOW/chưa bật) → GÃY luôn cả thao tác thanh lý bỏ cọc cho
--   MỌI hợp đồng có khách trả dư.
--
-- QUYẾT ĐỊNH (chủ dự án chọn 2026-07-22): "gỡ kẹt ngay, gác tiền dư xử sau".
--   Thanh lý phải chạy được; khoản dư gác lại xử lý riêng (hoàn/cấn trừ thủ công).
--
-- FIX: chỉ áp customer-credit khi route = 'CANONICAL'. Nếu còn dư mà tính năng
--   CHƯA bật → bỏ qua bước áp, trả credit result đánh dấu deferred=true +
--   remaining_amount = số dư (để truy vết), thanh lý hoàn tất bình thường. Khi
--   tính năng bật (CANONICAL) → hành vi cũ giữ nguyên (vẫn áp credit). Không dư →
--   không đổi.
--
-- Verify (live, rollback): HĐ DEMO có dư credit trước fix ném 55000; sau fix trả
--   {deferred:true, applied_amount:0, remaining_amount:<dư>} và thanh lý xong.
--
-- Chỉ CREATE OR REPLACE wrapper. Idempotent.
-- =============================================================================

begin;

CREATE OR REPLACE FUNCTION public.terminate_contract_forfeit_with_credit_v1(p_contract_id uuid, p_forfeit_date date, p_extra_charges jsonb, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_org uuid;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_credit_balance numeric(15,2);
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
    'forfeit_date', p_forfeit_date,
    'extra_charges', COALESCE(p_extra_charges, '[]'::jsonb)
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'contract.terminate.forfeit.credit.v1', p_contract_id::text,
    v_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'contract.terminate.forfeit.credit.v1'
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

  v_credit_balance := app_private.contract_customer_credit_balance_v1(
    p_contract_id, v_org
  );
  PERFORM app_private.begin_accounting_chain_write_v1();
  v_termination := public.terminate_contract_forfeit(
    p_contract_id, p_forfeit_date, COALESCE(p_extra_charges, '[]'::jsonb)
  );
  PERFORM app_private.end_accounting_chain_write_v1();
  IF v_credit_balance > 0
     AND app_private.evaluate_feature_route('customer.credit.apply.v1', v_org) = 'CANONICAL' THEN
    v_credit := app_private.apply_customer_credit_fifo_v1(
      v_actor, p_contract_id, NULL, NULL, 'FORFEIT',
      'Forfeit remaining customer credit on contract termination', v_key
    );
  ELSIF v_credit_balance > 0 THEN
    -- Tính năng xử lý "tiền khách trả dư" chưa bật (route <> CANONICAL): KHÔNG
    -- chặn thanh lý. Gác khoản dư lại, đánh dấu deferred để xử lý riêng (hoàn/cấn
    -- trừ thủ công) sau. Trước đây nhánh này gọi apply_customer_credit_fifo_v1 vô
    -- điều kiện → ném 55000 "Customer credit writer is not enabled" làm gãy cả
    -- thao tác thanh lý bỏ cọc.
    v_credit := jsonb_build_object(
      'contract_id', p_contract_id,
      'invoice_id', NULL,
      'application_kind', 'FORFEIT',
      'applied_amount', 0,
      'remaining_amount', v_credit_balance,
      'applications', '[]'::jsonb,
      'deferred', true,
      'deferred_reason', 'customer_credit_writer_not_enabled'
    );
  ELSE
    v_credit := jsonb_build_object(
      'contract_id', p_contract_id,
      'invoice_id', NULL,
      'application_kind', 'FORFEIT',
      'applied_amount', 0,
      'remaining_amount', 0,
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
     AND operation = 'contract.terminate.forfeit.credit.v1'
     AND subject_scope = p_contract_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END;
$function$;

commit;
