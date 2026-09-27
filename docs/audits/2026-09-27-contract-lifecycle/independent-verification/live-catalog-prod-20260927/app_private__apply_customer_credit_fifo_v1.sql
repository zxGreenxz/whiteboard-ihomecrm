-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- app_private.apply_customer_credit_fifo_v1(p_actor uuid, p_contract_id uuid, p_amount numeric, p_invoice_id uuid, p_application_kind text, p_description text, p_idempotency_key text) md5(prosrc)=a7023b51ceef79fdbe4fc6303062e136
CREATE OR REPLACE FUNCTION app_private.apply_customer_credit_fifo_v1(p_actor uuid, p_contract_id uuid, p_amount numeric, p_invoice_id uuid, p_application_kind text, p_description text, p_idempotency_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_kind text := upper(btrim(COALESCE(p_application_kind, '')));
  v_description text := NULLIF(btrim(COALESCE(p_description, '')), '');
  v_org uuid;
  v_building_id uuid;
  v_owner uuid;
  v_authz boolean;
  v_route text;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_available numeric(15,2) := 0;
  v_ledger_balance numeric(15,2) := 0;
  v_requested numeric(15,2);
  v_remaining numeric(15,2);
  v_take numeric(15,2);
  v_new_remaining numeric(15,2);
  v_lot public.customer_credit_lots%ROWTYPE;
  v_excess_id uuid;
  v_application_id uuid;
  v_applications jsonb := '[]'::jsonb;
  v_response jsonb;
BEGIN
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Invalid credit actor' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_kind NOT IN ('INVOICE_DISCOUNT', 'MOVE_OUT', 'FORFEIT', 'MANUAL') THEN
    RAISE EXCEPTION 'Invalid customer credit application kind'
      USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NOT NULL AND (
    p_amount = 'NaN'::numeric OR p_amount <= 0
    OR p_amount IS DISTINCT FROM round(p_amount, 2)
  ) THEN
    RAISE EXCEPTION 'Credit amount must be positive with at most two decimals'
      USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL AND v_kind <> 'FORFEIT' THEN
    RAISE EXCEPTION 'Only FORFEIT may consume the full balance'
      USING ERRCODE = '22023';
  END IF;

  SELECT contract_row.organization_id, room_row.building_id, contract_row.user_id
    INTO v_org, v_building_id, v_owner
  FROM public.contracts contract_row
  JOIN public.rooms room_row
    ON room_row.id = contract_row.room_id AND room_row.deleted_at IS NULL
  JOIN public.buildings building_row
    ON building_row.id = room_row.building_id
   AND building_row.deleted_at IS NULL
   AND building_row.organization_id = contract_row.organization_id
  JOIN public.organizations organization_row
    ON organization_row.id = contract_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Contract is outside an active organization'
      USING ERRCODE = '42501';
  END IF;

  IF p_invoice_id IS NOT NULL THEN
    PERFORM 1
    FROM public.invoices invoice_row
    WHERE invoice_row.id = p_invoice_id
      AND invoice_row.contract_id = p_contract_id
      AND invoice_row.organization_id = v_org
      AND invoice_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Credit target invoice does not belong to the contract'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    p_actor, v_org, 'excess_amounts.edit', v_building_id, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Missing permission to apply customer credit'
      USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'organization_id', v_org,
    'contract_id', p_contract_id,
    'amount', p_amount,
    'invoice_id', p_invoice_id,
    'application_kind', v_kind,
    'description', v_description
  )::text);

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, 'customer.credit.apply.v1',
    p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-'),
    p_actor, v_key, v_hash
  ) ON CONFLICT (
    organization_id, operation, subject_scope, actor_id, idempotency_key
  ) DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'customer.credit.apply.v1'
    AND operation_row.subject_scope =
      p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-')
    AND operation_row.actor_id = p_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;

  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'idempotency_key was reused with a different payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  v_route := app_private.evaluate_feature_route('customer.credit.apply.v1', v_org);
  IF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Customer credit writer is not enabled'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.excess_amounts excess
    WHERE excess.contract_id = p_contract_id
      AND excess.credit_lot_id IS NULL
      AND excess.amount <> 0
  ) THEN
    RAISE EXCEPTION 'Legacy customer credit requires manual reconciliation'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM public.customer_credit_lots lot
  WHERE lot.organization_id = v_org
    AND lot.contract_id = p_contract_id
    AND lot.status = 'ACTIVE'
    AND lot.remaining_amount > 0
  ORDER BY lot.created_at, lot.id
  FOR UPDATE;

  SELECT COALESCE(sum(lot.remaining_amount), 0)::numeric(15,2)
    INTO v_available
  FROM public.customer_credit_lots lot
  WHERE lot.organization_id = v_org
    AND lot.contract_id = p_contract_id
    AND lot.status = 'ACTIVE'
    AND lot.remaining_amount > 0;

  SELECT COALESCE(sum(excess.amount), 0)::numeric(15,2)
    INTO v_ledger_balance
  FROM public.excess_amounts excess
  WHERE excess.organization_id = v_org
    AND excess.contract_id = p_contract_id
    AND excess.credit_lot_id IS NOT NULL;

  IF abs(v_available - v_ledger_balance) >= 0.01 THEN
    RAISE EXCEPTION 'Credit lot balance does not match the compatibility ledger'
      USING ERRCODE = '55000';
  END IF;

  v_requested := CASE
    WHEN p_amount IS NULL THEN v_available
    ELSE round(p_amount, 2)
  END;

  IF v_requested > v_available THEN
    RAISE EXCEPTION 'Insufficient customer credit: requested %, available %',
      v_requested, v_available USING ERRCODE = '22023';
  END IF;

  PERFORM app_private.claim_feature_operation_v1(
    'customer.credit.apply.v1',
    v_org,
    p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-'),
    p_actor,
    v_key,
    v_requested
  );

  IF v_requested = 0 THEN
    v_response := jsonb_build_object(
      'contract_id', p_contract_id,
      'invoice_id', p_invoice_id,
      'application_kind', v_kind,
      'applied_amount', 0,
      'remaining_amount', v_available,
      'applications', '[]'::jsonb
    );
    UPDATE app_private.canonical_write_operations
       SET subject_id = COALESCE(p_invoice_id, p_contract_id),
           completed_at = clock_timestamp(),
           response_payload = v_response
     WHERE organization_id = v_org
       AND operation = 'customer.credit.apply.v1'
       AND subject_scope =
         p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-')
       AND actor_id = p_actor
       AND idempotency_key = v_key;
    RETURN v_response;
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();
  v_remaining := v_requested;

  FOR v_lot IN
    SELECT *
    FROM public.customer_credit_lots lot
    WHERE lot.organization_id = v_org
      AND lot.contract_id = p_contract_id
      AND lot.status = 'ACTIVE'
      AND lot.remaining_amount > 0
    ORDER BY lot.created_at, lot.id
    FOR UPDATE
  LOOP
    EXIT WHEN v_remaining <= 0;
    v_take := LEAST(v_lot.remaining_amount, v_remaining);
    v_new_remaining := v_lot.remaining_amount - v_take;

    INSERT INTO public.excess_amounts (
      organization_id, user_id, contract_id, amount, description,
      source_invoice_id, source_payment_id, credit_lot_id
    ) VALUES (
      v_org, v_owner, p_contract_id, -v_take,
      COALESCE(v_description, 'Customer credit application'),
      p_invoice_id, NULL, v_lot.id
    ) RETURNING id INTO v_excess_id;

    INSERT INTO public.customer_credit_applications (
      organization_id, credit_lot_id, invoice_id, excess_amount_id,
      amount, applied_by, application_kind, idempotency_key, description
    ) VALUES (
      v_org, v_lot.id, p_invoice_id, v_excess_id,
      v_take, p_actor, v_kind, v_key, v_description
    ) RETURNING id INTO v_application_id;

    UPDATE public.customer_credit_lots
       SET remaining_amount = v_new_remaining,
           status = CASE WHEN v_new_remaining = 0 THEN 'CONSUMED' ELSE 'ACTIVE' END
     WHERE id = v_lot.id;

    v_applications := v_applications || jsonb_build_array(jsonb_build_object(
      'application_id', v_application_id,
      'credit_lot_id', v_lot.id,
      'excess_amount_id', v_excess_id,
      'amount', v_take
    ));
    v_remaining := v_remaining - v_take;
  END LOOP;

  IF v_remaining <> 0 THEN
    RAISE EXCEPTION 'FIFO credit allocation did not balance'
      USING ERRCODE = '55000';
  END IF;

  v_response := jsonb_build_object(
    'contract_id', p_contract_id,
    'invoice_id', p_invoice_id,
    'application_kind', v_kind,
    'applied_amount', v_requested,
    'remaining_amount', v_available - v_requested,
    'applications', v_applications
  );

  UPDATE app_private.canonical_write_operations
     SET subject_id = COALESCE(p_invoice_id, p_contract_id),
         completed_at = clock_timestamp(),
         response_payload = v_response
   WHERE organization_id = v_org
     AND operation = 'customer.credit.apply.v1'
     AND subject_scope =
       p_contract_id::text || '|' || v_kind || '|' || COALESCE(p_invoice_id::text, '-')
     AND actor_id = p_actor
     AND idempotency_key = v_key;

  PERFORM app_private.end_accounting_chain_write_v1();
  RETURN v_response;
END;
$function$

