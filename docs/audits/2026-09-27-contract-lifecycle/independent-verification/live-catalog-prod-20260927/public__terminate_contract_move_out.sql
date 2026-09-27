-- LIVE production catalog, read-only snapshot 2026-09-27T12:35:40.599Z
-- public.terminate_contract_move_out(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric, p_penalty_fee numeric, p_excess_rent numeric, p_outstanding_debt numeric, p_notes text, p_extra_charges jsonb, p_shortfall_mode text, p_receipt_account_id uuid, p_refund_items jsonb) md5(prosrc)=55366c922348b55a177db9823aecf93c
CREATE OR REPLACE FUNCTION public.terminate_contract_move_out(p_contract_id uuid, p_move_out_date date, p_deposit_refund numeric DEFAULT 0, p_penalty_fee numeric DEFAULT 0, p_excess_rent numeric DEFAULT 0, p_outstanding_debt numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_extra_charges jsonb DEFAULT '[]'::jsonb, p_shortfall_mode text DEFAULT 'PAID'::text, p_receipt_account_id uuid DEFAULT NULL::uuid, p_refund_items jsonb DEFAULT '[]'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'app_private'
AS $function$
DECLARE
  v_room uuid;
  v_org uuid;
  v_owner uuid;
  v_building uuid;
  v_deposit_paid numeric;
  v_extra numeric := 0;
  v_cash_shortfall numeric := 0;
  v_receipt_account uuid;
  v_cash_authz boolean;
  v_core_writer boolean;
  v_opened_writer boolean := false;
  v_result jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT
    contract_row.room_id,
    contract_row.organization_id,
    contract_row.user_id,
    room_row.building_id,
    contract_row.deposit_paid
    INTO v_room, v_org, v_owner, v_building, v_deposit_paid
  FROM public.contracts contract_row
  LEFT JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  WHERE contract_row.id = p_contract_id
    AND contract_row.deleted_at IS NULL
  FOR UPDATE OF contract_row;

  IF NOT (
    public.is_super_admin()
    OR (
      v_room IS NOT NULL
      AND public.can_do_on_building(
        'contracts', 'edit',
        (SELECT room_row.building_id
         FROM public.rooms room_row
         WHERE room_row.id = v_room)
      )
    )
  ) THEN
    RAISE EXCEPTION 'Missing permission to terminate contract'
      USING ERRCODE = '42501';
  END IF;

  IF p_receipt_account_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.accounts account_row
    WHERE account_row.id = p_receipt_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
  ) THEN
    RAISE EXCEPTION 'Receipt account is outside the contract organization or is not a real active cashbook'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(p_extra_charges, '[]'::jsonb)) = 'array' THEN
    SELECT COALESCE(sum((entry->>'amount')::numeric), 0)
      INTO v_extra
    FROM jsonb_array_elements(COALESCE(p_extra_charges, '[]'::jsonb)) item(entry)
    WHERE NULLIF(entry->>'amount', '') IS NOT NULL
      AND (entry->>'amount')::numeric > 0;
  END IF;

  v_cash_shortfall := GREATEST(
    COALESCE(p_outstanding_debt, 0)
      + COALESCE(p_penalty_fee, 0)
      + v_extra
      - LEAST(
          GREATEST(COALESCE(p_deposit_refund, 0), 0),
          COALESCE(v_deposit_paid, 0)
        )
      - GREATEST(COALESCE(p_excess_rent, 0), 0)
      - COALESCE((
          SELECT SUM((entry->>'amount')::numeric)
          FROM jsonb_array_elements(COALESCE(p_refund_items, '[]'::jsonb)) item(entry)
          WHERE jsonb_typeof(COALESCE(p_refund_items, '[]'::jsonb)) = 'array'
            AND NULLIF(entry->>'amount', '') IS NOT NULL
            AND (entry->>'amount')::numeric > 0
        ), 0),
    0
  );

  IF upper(COALESCE(p_shortfall_mode, 'PAID')) = 'PAID'
     AND v_cash_shortfall > 0 THEN
    v_receipt_account := COALESCE(
      p_receipt_account_id,
      public._collector_thu_account(auth.uid()),
      public._termination_pick_account(v_owner, v_building)
    );

    IF v_receipt_account IS NULL THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = v_receipt_account
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot resolve an active real receipt account in the contract organization'
        USING ERRCODE = '42501';
    END IF;

    PERFORM app_private.lock_org_for_decision_v1(v_org);
    SELECT decision.allowed
      INTO v_cash_authz
    FROM app_private.authorize_tenant_action_v3(
      auth.uid(), v_org, 'thu_tien.collect', v_building, v_receipt_account
    ) decision;
    IF NOT COALESCE(v_cash_authz, false) THEN
      RAISE EXCEPTION 'Missing receipt permission or cashbook possession for termination collection'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    v_receipt_account := p_receipt_account_id;
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM app_private.accounting_chain_writer_xids capability
    WHERE capability.transaction_id = txid_current()
      AND capability.backend_pid = pg_backend_pid()
  ) INTO v_core_writer;

  IF NOT v_core_writer THEN
    PERFORM app_private.assert_contract_has_no_customer_credit_v1(
      p_contract_id, v_org
    );
    PERFORM app_private.begin_accounting_chain_write_v1();
    v_opened_writer := true;
  END IF;

  INSERT INTO app_private.termination_move_out_writer_context (
    transaction_id, backend_pid, organization_id, user_id,
    contract_id, building_id, room_id, move_out_date, opened_at
  ) VALUES (
    txid_current(), pg_backend_pid(), v_org, v_owner,
    p_contract_id, v_building, v_room, p_move_out_date, clock_timestamp()
  ) ON CONFLICT (transaction_id, backend_pid) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      user_id = EXCLUDED.user_id,
      contract_id = EXCLUDED.contract_id,
      building_id = EXCLUDED.building_id,
      room_id = EXCLUDED.room_id,
      move_out_date = EXCLUDED.move_out_date,
      opened_at = EXCLUDED.opened_at;

  BEGIN
    v_result := public.terminate_contract_move_out_impl(
      p_contract_id, p_move_out_date, COALESCE(p_deposit_refund, 0),
      COALESCE(p_penalty_fee, 0), COALESCE(p_excess_rent, 0),
      COALESCE(p_outstanding_debt, 0), p_notes,
      COALESCE(p_extra_charges, '[]'::jsonb),
      COALESCE(p_shortfall_mode, 'PAID'), v_receipt_account,
      COALESCE(p_refund_items, '[]'::jsonb)
    );
  EXCEPTION WHEN OTHERS THEN
    DELETE FROM app_private.termination_move_out_writer_context
    WHERE transaction_id = txid_current()
      AND backend_pid = pg_backend_pid();
    IF v_opened_writer THEN
      PERFORM app_private.end_accounting_chain_write_v1();
    END IF;
    RAISE;
  END;

  DELETE FROM app_private.termination_move_out_writer_context
  WHERE transaction_id = txid_current()
    AND backend_pid = pg_backend_pid();

  IF v_opened_writer THEN
    PERFORM app_private.end_accounting_chain_write_v1();
  END IF;
  RETURN v_result;
END;
$function$

