-- Narrow the L03 rollout back to contract creation and deposit/P&L semantics.
-- Historical V5, customer-credit and payout data stays intact; only new writes
-- are routed away from the out-of-scope writers.

BEGIN;

DO $preflight$
DECLARE
  v_locked_flags integer := 0;
  v_flag record;
BEGIN
  -- Serialize against V5 admission. A writer that already claimed the feature
  -- finishes before this lock; a later writer blocks and then observes SHADOW.
  FOR v_flag IN
    SELECT feature_key
    FROM app_private.server_feature_flags
    WHERE feature_key IN (
      'invoice.collection.v5',
      'invoice.collection.reverse.v5'
    )
    ORDER BY feature_key
    FOR UPDATE
  LOOP
    v_locked_flags := v_locked_flags + 1;
  END LOOP;
  IF v_locked_flags <> 2 THEN
    RAISE EXCEPTION 'Missing V5 feature rows required for a serialized quarantine'
      USING ERRCODE = '55000';
  END IF;

  IF to_regprocedure(
    'public._record_invoice_payment_v4_legacy(uuid,numeric,public.payment_method,date,text,uuid,text,text,jsonb,jsonb,text,uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'Missing reviewed single-payment compatibility writer'
      USING ERRCODE = '55000';
  END IF;

  IF to_regprocedure('public._reverse_invoice_payment_v3_legacy(uuid,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Missing reviewed legacy payment reversal writer'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.invoice_payment_collections collection_row
    WHERE collection_row.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION
      'Cannot quarantine V5 while an active collection still requires unwind'
      USING ERRCODE = '55000';
  END IF;
END
$preflight$;

-- Contract V2 is the core L03 fix. It atomically snapshots the first invoice
-- with structured REVENUE/DEPOSIT classes, so it is enabled for every tenant.
-- migration_sha256 below hashes this file after normalizing both digest literals
-- to 64 zeroes, avoiding a circular self-hash while keeping it reproducible.
UPDATE app_private.server_feature_flags
SET mode = 'ON',
    force_freeze = false,
    config_version = config_version + 1,
    starts_at = NULL,
    ends_at = NULL,
    max_operation_count = 0,
    max_single_amount_vnd = 0,
    max_total_amount_vnd = 0,
    commit_sha = COALESCE(
      NULLIF(btrim(commit_sha), ''),
      '7b33f8546bc69c1f78dc14ad51f5b199e91c4a60'
    ),
    migration_sha256 = COALESCE(
      NULLIF(btrim(migration_sha256), ''),
      'a07fac74bb3e9a51e3e4df38ad559fe21d32435d4ce133cc520f8041880f8753'
    ),
    maintenance_window_id = COALESCE(
      NULLIF(btrim(maintenance_window_id), ''),
      'inline-migration-20260721150500'
    ),
    approval_reference = COALESCE(
      NULLIF(btrim(approval_reference), ''),
      'user-approved-scope-narrowing-20260721'
    ),
    reason = 'Core L03: atomic contract and first-invoice accounting enabled',
    updated_at = clock_timestamp()
WHERE feature_key = 'contract.create.v2';

-- These schemas and ledgers remain for provenance, but their forward routes are
-- deliberately dormant. SHADOW (rather than FROZEN) keeps the independent
-- legacy reversal adapter available for existing payment history.
UPDATE app_private.server_feature_flags
SET mode = 'SHADOW',
    force_freeze = false,
    config_version = config_version + 1,
    starts_at = NULL,
    ends_at = NULL,
    max_operation_count = 0,
    max_single_amount_vnd = 0,
    max_total_amount_vnd = 0,
    commit_sha = NULL,
    migration_sha256 = NULL,
    maintenance_window_id = NULL,
    approval_reference = NULL,
    reason = CASE feature_key
      WHEN 'invoice.collection.v5'
        THEN 'Out of L03 scope: multi-tender collection retained as dormant history'
      WHEN 'invoice.collection.reverse.v5'
        THEN 'Out of L03 scope: V5 reversal dormant; legacy unwind remains independent'
      WHEN 'customer.credit.apply.v1'
        THEN 'Out of L03 scope: customer-credit forward application quarantined'
      WHEN 'shareholder_profit.distribute.v2'
        THEN 'Out of L03 scope: allocation reservations and profit locking quarantined'
      ELSE reason
    END,
    updated_at = clock_timestamp()
WHERE feature_key IN (
  'invoice.collection.v5',
  'invoice.collection.reverse.v5',
  'customer.credit.apply.v1',
  'shareholder_profit.distribute.v2'
);

-- Existing backfilled credit applications need a support-only unwind route.
-- The frontend no longer creates new applications, while LIFO reversal stays
-- available for the reviewed historical rows.
UPDATE app_private.server_feature_flags
SET mode = 'ON',
    force_freeze = false,
    config_version = config_version + 1,
    starts_at = NULL,
    ends_at = NULL,
    max_operation_count = 0,
    max_single_amount_vnd = 0,
    max_total_amount_vnd = 0,
    commit_sha = COALESCE(
      NULLIF(btrim(commit_sha), ''),
      '7b33f8546bc69c1f78dc14ad51f5b199e91c4a60'
    ),
    migration_sha256 = COALESCE(
      NULLIF(btrim(migration_sha256), ''),
      'a07fac74bb3e9a51e3e4df38ad559fe21d32435d4ce133cc520f8041880f8753'
    ),
    maintenance_window_id = COALESCE(
      NULLIF(btrim(maintenance_window_id), ''),
      'inline-migration-20260721150500'
    ),
    approval_reference = COALESCE(
      NULLIF(btrim(approval_reference), ''),
      'user-approved-scope-narrowing-20260721'
    ),
    reason = 'Support-only unwind for historical customer-credit applications',
    updated_at = clock_timestamp()
WHERE feature_key = 'customer.credit.reverse.v1';

-- ON routes require release identity fields. Preserve any stronger existing
-- attestation and install this user-approved migration identity only when the
-- rollout row was previously left blank.
DO $assert_on_routes$
BEGIN
  IF app_private.evaluate_feature_route(
       'contract.create.v2',
       '00000000-0000-0000-0000-000000000000'::uuid
     ) <> 'CANONICAL' THEN
    RAISE EXCEPTION
      'contract.create.v2 lacks the reviewed rollout identity required for ON'
      USING ERRCODE = '55000';
  END IF;

  IF app_private.evaluate_feature_route(
       'customer.credit.reverse.v1',
       '00000000-0000-0000-0000-000000000000'::uuid
     ) <> 'CANONICAL' THEN
    RAISE EXCEPTION
      'customer.credit.reverse.v1 lacks the reviewed rollout identity required for support unwind'
      USING ERRCODE = '55000';
  END IF;
END
$assert_on_routes$;

DELETE FROM app_private.server_feature_flag_canary_orgs
WHERE feature_key IN (
  'contract.create.v2',
  'invoice.collection.v5',
  'invoice.collection.reverse.v5',
  'customer.credit.apply.v1',
  'customer.credit.reverse.v1',
  'shareholder_profit.distribute.v2'
);

-- Restore the pre-V5 one-payment surface. The underlying V4 writer keeps its
-- existing authorization and idempotency ledger; this adapter additionally
-- verifies structured invoice allocation server-side for ordinary payments.
CREATE OR REPLACE FUNCTION public.record_invoice_payment_v4(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_method public.payment_method,
  p_payment_date date,
  p_idempotency_key text,
  p_account_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_receipt_image_url text DEFAULT NULL,
  p_voucher jsonb DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_receipt_number text DEFAULT NULL,
  p_voucher_owner_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_invoice public.invoices%ROWTYPE;
  v_org uuid;
  v_authz boolean;
  v_remaining numeric;
  v_deposit_due numeric := 0;
  v_internal_due numeric := 0;
  v_revenue_due numeric := 0;
  v_revenue_covered numeric := 0;
  v_deposit_covered numeric := 0;
  v_internal_covered numeric := 0;
  v_expected_revenue numeric := 0;
  v_expected_deposit numeric := 0;
  v_left numeric := 0;
  v_result jsonb;
  v_payment_id uuid;
  v_voucher_id uuid;
  v_compat_operation app_private.canonical_write_operations%ROWTYPE;
  v_hash text;
  v_actual_revenue numeric := 0;
  v_actual_deposit numeric := 0;
  v_actual_other numeric := 0;
  v_credit numeric := 0;
  v_change numeric := 0;
  v_change_account uuid;
  v_rounding numeric := 0;
  v_rounding_account uuid;
  v_validate_semantics boolean := false;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Chưa đăng nhập' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'idempotency_key không hợp lệ' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount = 'NaN'::numeric
     OR p_amount <= 0 OR round(p_amount, 2) <> p_amount THEN
    RAISE EXCEPTION 'Số tiền thanh toán không hợp lệ' USING ERRCODE = '22023';
  END IF;
  v_validate_semantics := p_account_id IS NOT NULL
    AND p_voucher IS NOT NULL
    AND CASE
      WHEN jsonb_typeof(p_items) = 'array' THEN jsonb_array_length(p_items) > 0
      ELSE false
    END;
  v_change := COALESCE((p_voucher->>'change_amount')::numeric, 0);
  v_rounding := COALESCE((p_voucher->>'rounding_amount')::numeric, 0);
  v_change_account := NULLIF(p_voucher->>'change_account_id', '')::uuid;
  v_rounding_account := NULLIF(p_voucher->>'rounding_account_id', '')::uuid;
  IF v_change = 'NaN'::numeric OR v_rounding = 'NaN'::numeric
     OR v_change < 0 OR v_rounding < 0
     OR round(v_change, 2) <> v_change
     OR round(v_rounding, 2) <> v_rounding THEN
    RAISE EXCEPTION 'Payment change/rounding metadata is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_invoice
  FROM public.invoices invoice_row
  WHERE invoice_row.id = p_invoice_id
    AND invoice_row.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Không tìm thấy hóa đơn' USING ERRCODE = '42501';
  END IF;

  SELECT building_row.organization_id INTO v_org
  FROM public.buildings building_row
  JOIN public.organizations organization_row
    ON organization_row.id = building_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE building_row.id = v_invoice.building_id
    AND building_row.deleted_at IS NULL
    AND building_row.organization_id = v_invoice.organization_id
  FOR SHARE OF building_row, organization_row;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Hóa đơn không thuộc tổ chức hợp lệ' USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.collect', v_invoice.building_id, p_account_id
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Không có quyền thu tiền hóa đơn' USING ERRCODE = '42501';
  END IF;

  IF p_account_id IS NOT NULL THEN
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = p_account_id
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Sổ nhận tiền phải là sổ tiền thật của tổ chức'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- V5 used a different operation namespace. Replaying a completed V5 call
  -- after this cutover must return its stored response, never create a second
  -- legacy payment with the same idempotency key.
  v_hash := md5(jsonb_build_object(
    'invoice_id', p_invoice_id,
    'amount', p_amount,
    'payment_method', p_payment_method,
    'payment_date', p_payment_date,
    'account_id', p_account_id,
    'notes', p_notes,
    'receipt_image_url', p_receipt_image_url,
    'voucher', p_voucher,
    'items', p_items,
    'receipt_number', p_receipt_number,
    'voucher_owner_id', p_voucher_owner_id
  )::text);
  SELECT * INTO v_compat_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = 'invoice.collection.compat.v4'
    AND operation_row.subject_scope = p_invoice_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_compat_operation.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'idempotency_key was reused with a different payload'
        USING ERRCODE = '23505';
    END IF;
    IF v_compat_operation.completed_at IS NOT NULL THEN
      RETURN v_compat_operation.response_payload::json;
    END IF;
  END IF;

  IF v_change > 0 THEN
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = v_change_account
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Change account must be a virtual account in the invoice organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_rounding > 0 THEN
    PERFORM 1
    FROM public.accounts account_row
    WHERE account_row.id = v_rounding_account
      AND account_row.organization_id = v_org
      AND account_row.deleted_at IS NULL
      AND account_row.is_virtual
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Rounding account must be a virtual account in the invoice organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- A completed replay must be evaluated by the original V4 payload hash, not
  -- against the invoice balance after the first successful write.
  IF EXISTS (
    SELECT 1
    FROM app_private.canonical_write_operations operation_row
    WHERE operation_row.organization_id = v_org
      AND operation_row.operation = 'invoice.record_payment.v1'
      AND operation_row.subject_scope = p_invoice_id::text
      AND operation_row.actor_id = v_actor
      AND operation_row.idempotency_key = v_key
      AND operation_row.completed_at IS NOT NULL
  ) THEN
    RETURN public._record_invoice_payment_v4_legacy(
      p_invoice_id, p_amount, p_payment_method, p_payment_date, v_key,
      p_account_id, p_notes, p_receipt_image_url, p_voucher, p_items,
      p_receipt_number, p_voucher_owner_id
    );
  END IF;

  v_remaining := GREATEST(
    v_invoice.total_amount - COALESCE(v_invoice.paid_amount, 0),
    0
  );

  SELECT
    COALESCE(sum(item.amount) FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
    COALESCE(sum(item.amount) FILTER (WHERE item.accounting_class = 'NON_PNL'), 0)
    INTO v_deposit_due, v_internal_due
  FROM public.invoice_items item
  WHERE item.invoice_id = p_invoice_id;

  SELECT v_deposit_due + COALESCE(sum((source_row->>'amount')::numeric), 0)
    INTO v_deposit_due
  FROM jsonb_array_elements(
    COALESCE(v_invoice.previous_debt_sources, '[]'::jsonb)
  ) source_row
  WHERE source_row->>'type' = 'deposit';

  v_deposit_due := COALESCE(v_deposit_due, 0);
  v_internal_due := COALESCE(v_internal_due, 0);

  IF p_amount > v_remaining + 0.009 THEN
    RAISE EXCEPTION 'Customer-credit creation is quarantined; invoice overpayment is not allowed'
      USING ERRCODE = '55000';
  END IF;
  IF v_rounding > 0 AND (
    v_rounding >= 10000
    OR v_remaining - p_amount <= 0
    OR abs(v_rounding - (v_remaining - p_amount)) >= 0.01
  ) THEN
    RAISE EXCEPTION 'Rounding must exactly close a positive invoice residual below 10000'
      USING ERRCODE = '22023';
  END IF;

  -- Invoice-linked cash must always carry a real account, voucher and items.
  -- The generic cashbook form cannot provide those semantics, so it must use
  -- the invoice payment screen rather than creating an irreversible payment.
  IF NOT v_validate_semantics THEN
    RAISE EXCEPTION 'Invoice payments require the invoice payment screen with full accounting semantics'
      USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_items) input_item
    LEFT JOIN public.income_expense_types type_row
      ON type_row.id = NULLIF(input_item->>'income_expense_type_id', '')::uuid
    WHERE type_row.id IS NULL
      OR type_row.organization_id IS DISTINCT FROM v_org
      OR lower(type_row.type) <> 'income'
  ) THEN
    RAISE EXCEPTION 'Payment item type must be an income type in the invoice organization'
      USING ERRCODE = '42501';
  END IF;
  v_revenue_due := GREATEST(
    v_invoice.total_amount - v_deposit_due - v_internal_due,
    0
  );

  IF v_deposit_due + v_internal_due - v_invoice.total_amount >= 0.01 THEN
    RAISE EXCEPTION 'Dữ liệu cọc/NON_PNL vượt tổng hóa đơn; cần đối soát'
      USING ERRCODE = '55000';
  END IF;
  IF v_internal_due >= 0.01 THEN
    RAISE EXCEPTION 'Writer tương thích chưa hỗ trợ hóa đơn có NON_PNL'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'PNL'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'INTERNAL'), 0)
    INTO v_revenue_covered, v_deposit_covered, v_internal_covered
  FROM public.income_expenses voucher
  JOIN public.income_expense_items item
    ON item.income_expense_id = voucher.id
  LEFT JOIN public.invoice_payment_collections source_collection
    ON source_collection.id = voucher.payment_collection_id
  LEFT JOIN public.payments source_payment
    ON source_payment.id = voucher.payment_id
  WHERE voucher.invoice_id = p_invoice_id
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL
    AND (
      voucher.payment_collection_id IS NULL
      OR source_collection.status = 'ACTIVE'
    )
    AND (voucher.payment_id IS NULL OR source_payment.reversed_at IS NULL);

  IF abs(
    v_revenue_covered + v_deposit_covered + v_internal_covered
    - COALESCE(v_invoice.paid_amount, 0)
  ) >= 0.01 THEN
    RAISE EXCEPTION 'Số đã thu không khớp bút toán semantic; cần đối soát trước'
      USING ERRCODE = '55000';
  END IF;

  v_left := p_amount;
  v_expected_revenue := LEAST(
    v_left,
    GREATEST(v_revenue_due - v_revenue_covered, 0)
  );
  v_left := v_left - v_expected_revenue;
  v_expected_deposit := LEAST(
    v_left,
    GREATEST(v_deposit_due - v_deposit_covered, 0)
  );
  v_left := v_left - v_expected_deposit;
  IF abs(v_left) >= 0.01 THEN
    RAISE EXCEPTION 'Không thể phân bổ khoản thu vào doanh thu/cọc của hóa đơn'
      USING ERRCODE = '55000';
  END IF;

  v_result := public._record_invoice_payment_v4_legacy(
    p_invoice_id, p_amount, p_payment_method, p_payment_date, v_key,
    p_account_id, p_notes, p_receipt_image_url, p_voucher, p_items,
    p_receipt_number, p_voucher_owner_id
  )::jsonb;

  v_payment_id := NULLIF(v_result->>'payment_id', '')::uuid;
  v_voucher_id := NULLIF(v_result->>'voucher_id', '')::uuid;
  IF v_payment_id IS NULL OR v_voucher_id IS NULL THEN
    RAISE EXCEPTION 'Writer tương thích không trả đủ payment/voucher'
      USING ERRCODE = '55000';
  END IF;

  v_credit := GREATEST(COALESCE((v_result->>'excess_amount')::numeric, 0), 0);
  -- New legacy-compatible payments need explicit receipt semantics so the
  -- compensating reversal adapter can verify and copy their accounting classes.
  PERFORM app_private.begin_accounting_chain_write_v1();
  UPDATE public.payments payment_row
     SET received_amount = p_amount,
          credit_amount = v_credit,
          change_amount = v_change,
          rounding_amount = 0,
         updated_at = clock_timestamp()
   WHERE payment_row.id = v_payment_id
     AND payment_row.invoice_id = p_invoice_id;
  UPDATE public.income_expenses voucher_row
     SET change_amount = v_change,
         change_account_id = CASE WHEN v_change > 0 THEN v_change_account ELSE NULL END,
         rounding_amount = v_rounding,
         rounding_account_id = CASE WHEN v_rounding > 0 THEN v_rounding_account ELSE NULL END
   WHERE voucher_row.id = v_voucher_id
     AND voucher_row.payment_id = v_payment_id
     AND voucher_row.invoice_id = p_invoice_id;
  PERFORM app_private.end_accounting_chain_write_v1();

  SELECT
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'PNL'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
    COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity))
      FILTER (WHERE item.accounting_class NOT IN ('PNL', 'DEPOSIT')), 0)
    INTO v_actual_revenue, v_actual_deposit, v_actual_other
  FROM public.income_expense_items item
  WHERE item.income_expense_id = v_voucher_id;

  IF abs(v_actual_revenue - v_expected_revenue) >= 0.01
     OR abs(v_actual_deposit - v_expected_deposit) >= 0.01
     OR abs(v_actual_other) >= 0.01
     OR abs(v_actual_revenue + v_actual_deposit - p_amount) >= 0.01 THEN
    RAISE EXCEPTION
      'Phân bổ phiếu thu không khớp semantic hóa đơn (PNL %/%; cọc %/%)',
      v_actual_revenue, v_expected_revenue,
      v_actual_deposit, v_expected_deposit
      USING ERRCODE = '55000';
  END IF;

  PERFORM public.recompute_ie_business_result(v_voucher_id);
  IF v_invoice.contract_id IS NOT NULL THEN
    PERFORM public.recompute_contract_deposit_paid(v_invoice.contract_id);
  END IF;

  RETURN v_result::json;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_invoice_payment_v3(
  p_invoice_id uuid,
  p_amount numeric,
  p_payment_method public.payment_method,
  p_payment_date date,
  p_idempotency_key text,
  p_account_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_receipt_image_url text DEFAULT NULL,
  p_voucher jsonb DEFAULT NULL,
  p_items jsonb DEFAULT NULL,
  p_receipt_number text DEFAULT NULL,
  p_voucher_owner_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.record_invoice_payment_v4(
    p_invoice_id, p_amount, p_payment_method, p_payment_date, p_idempotency_key,
    p_account_id, p_notes, p_receipt_image_url, p_voucher, p_items,
    p_receipt_number, p_voucher_owner_id
  );
$$;

REVOKE ALL ON FUNCTION public.record_invoice_payment_v4(
  uuid, numeric, public.payment_method, date, text, uuid, text, text,
  jsonb, jsonb, text, uuid
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v4(
  uuid, numeric, public.payment_method, date, text, uuid, text, text,
  jsonb, jsonb, text, uuid
) TO authenticated;

REVOKE ALL ON FUNCTION public.record_invoice_payment_v3(
  uuid, numeric, public.payment_method, date, text, uuid, text, text,
  jsonb, jsonb, text, uuid
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.record_invoice_payment_v3(
  uuid, numeric, public.payment_method, date, text, uuid, text, text,
  jsonb, jsonb, text, uuid
) TO authenticated;

-- V2 payout reservations stay dormant. Replace the V2-only insertion gate
-- with an integrity guard that still enforces tenant, identity and real-account
-- boundaries for both the legacy payout path and historical linked rows.
CREATE OR REPLACE FUNCTION app_private.guard_profit_payout_scope_compat_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_is_payout boolean := false;
BEGIN
  v_is_payout := NEW.shareholder_id IS NOT NULL
    OR NEW.profit_manager_id IS NOT NULL
    OR COALESCE(
      NEW.system_source IN ('profit.distribution', 'profit.manager_salary'),
      false
    );

  IF TG_OP = 'UPDATE' THEN
    v_is_payout := v_is_payout
      OR OLD.shareholder_id IS NOT NULL
      OR OLD.profit_manager_id IS NOT NULL
      OR COALESCE(
        OLD.system_source IN ('profit.distribution', 'profit.manager_salary'),
        false
      );
  END IF;

  v_is_payout := v_is_payout OR EXISTS (
    SELECT 1
    FROM public.profit_payout_reservations reservation
    WHERE reservation.payout_voucher_id = NEW.id
  ) OR EXISTS (
    SELECT 1
    FROM public.approval_requests request_row
    WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.subject_id = NEW.id
      AND request_row.system_source = 'profit.distribution'
  );

  IF NOT v_is_payout THEN
    RETURN NEW;
  END IF;
  IF NEW.shareholder_id IS NOT NULL AND NEW.profit_manager_id IS NOT NULL THEN
    RAISE EXCEPTION 'Profit payout cannot target both a shareholder and a manager'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.account_id IS NULL THEN
    RAISE EXCEPTION 'Profit payout requires a real cashbook account'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.accounts account_row
  WHERE account_row.id = NEW.account_id
    AND account_row.organization_id = NEW.organization_id
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Profit payout account must be active, real and in the same organization'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.shareholder_id IS NOT NULL THEN
    PERFORM 1
    FROM public.shareholders shareholder_row
    WHERE shareholder_row.id = NEW.shareholder_id
      AND shareholder_row.organization_id = NEW.organization_id
      AND shareholder_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Profit payout shareholder must belong to the same organization'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.profit_manager_id IS NOT NULL THEN
    PERFORM 1
    FROM public.profit_managers manager_row
    WHERE manager_row.id = NEW.profit_manager_id
      AND manager_row.organization_id = NEW.organization_id
      AND manager_row.deleted_at IS NULL
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Manager payout target must belong to the same organization'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'Profit payout cannot clear its shareholder/manager identity'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_payout_reservations reservation
    WHERE reservation.payout_voucher_id = NEW.id
      AND (
        reservation.organization_id IS DISTINCT FROM NEW.organization_id
        OR reservation.shareholder_id IS DISTINCT FROM NEW.shareholder_id
      )
  ) THEN
    RAISE EXCEPTION 'Historical payout no longer matches its reservation identity'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.approval_requests request_row
    WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
      AND request_row.subject_id = NEW.id
      AND request_row.system_source = 'profit.distribution'
      AND (
        request_row.organization_id IS DISTINCT FROM NEW.organization_id
        OR request_row.cashbook_id IS DISTINCT FROM NEW.account_id
      )
  ) THEN
    RAISE EXCEPTION 'Historical payout no longer matches its approval request'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a00_00_profit_payout_account_guard
  ON public.income_expenses;
CREATE TRIGGER a00_00_profit_payout_account_guard
BEFORE INSERT OR UPDATE OF
  shareholder_id, profit_manager_id, account_id, organization_id, system_source
ON public.income_expenses
FOR EACH ROW EXECUTE FUNCTION app_private.guard_profit_payout_scope_compat_v1();

-- Keep the pre-reservation payout UX, but perform tenant resolution, account
-- validation, idempotency and voucher/item insertion in one server transaction.
CREATE OR REPLACE FUNCTION public.create_profit_payout_compat_v1(
  p_target_kind text,
  p_target_id uuid,
  p_amount numeric,
  p_account_id uuid,
  p_voucher_date date,
  p_note text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_name text;
  v_kind text := upper(btrim(COALESCE(p_target_kind, '')));
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_org uuid;
  v_building uuid;
  v_owner uuid;
  v_subject_name text;
  v_permission text;
  v_operation_name text;
  v_type_name text;
  v_category text := 'Chia lợi nhuận';
  v_system_source text;
  v_authz boolean;
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_type uuid;
  v_voucher uuid;
  v_voucher_name text;
  v_response jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF v_kind NOT IN ('SHAREHOLDER', 'MANAGER') THEN
    RAISE EXCEPTION 'Unsupported profit payout target' USING ERRCODE = '22023';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE = '22023';
  END IF;
  IF p_amount IS NULL OR p_amount = 'NaN'::numeric
     OR p_amount <= 0 OR round(p_amount, 2) <> p_amount THEN
    RAISE EXCEPTION 'Invalid payout amount' USING ERRCODE = '22023';
  END IF;
  IF p_account_id IS NULL OR p_voucher_date IS NULL THEN
    RAISE EXCEPTION 'Payout account and date are required' USING ERRCODE = '22023';
  END IF;

  IF v_kind = 'SHAREHOLDER' THEN
    SELECT target.organization_id,
           COALESCE(NULLIF(btrim(target.name), ''), 'Cổ đông')
      INTO v_org, v_subject_name
    FROM public.shareholders target
    WHERE target.id = p_target_id
      AND target.deleted_at IS NULL
      AND target.is_active
    FOR SHARE;
    v_permission := 'shareholder_profit.distribute';
    v_operation_name := 'shareholder_profit.distribute.compat.v1';
    v_type_name := 'Chia lợi nhuận cổ đông';
    v_system_source := 'profit.distribution';
  ELSE
    SELECT target.organization_id,
           COALESCE(NULLIF(btrim(target.name), ''), 'Quản lý')
      INTO v_org, v_subject_name
    FROM public.profit_managers target
    WHERE target.id = p_target_id
      AND target.deleted_at IS NULL
      AND target.is_active
    FOR SHARE;
    v_permission := 'shareholder_profit.pay_manager';
    v_operation_name := 'shareholder_profit.pay_manager.compat.v1';
    v_type_name := 'Lương điều hành';
    v_system_source := 'profit.manager_salary';
  END IF;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Payout target does not belong to an active organization'
      USING ERRCODE = '42501';
  END IF;

  SELECT building_row.id, building_row.user_id
    INTO v_building, v_owner
  FROM public.buildings building_row
  JOIN public.organizations organization_row
    ON organization_row.id = building_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE building_row.organization_id = v_org
    AND building_row.is_virtual
    AND building_row.deleted_at IS NULL
  ORDER BY building_row.created_at, building_row.id
  LIMIT 1
  FOR SHARE OF building_row, organization_row;
  IF v_building IS NULL OR v_owner IS NULL THEN
    RAISE EXCEPTION 'Organization has no virtual accounting building'
      USING ERRCODE = '55000';
  END IF;

  PERFORM 1
  FROM public.accounts account_row
  WHERE account_row.id = p_account_id
    AND account_row.organization_id = v_org
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payout account must be real and in the same organization'
      USING ERRCODE = '42501';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, v_permission, v_building, p_account_id
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Not authorized to create this payout'
      USING ERRCODE = '42501';
  END IF;

  v_hash := md5(jsonb_build_object(
    'target_kind', v_kind,
    'target_id', p_target_id,
    'amount', round(p_amount, 2),
    'account_id', p_account_id,
    'voucher_date', p_voucher_date,
    'note', NULLIF(btrim(COALESCE(p_note, '')), ''),
    'organization_id', v_org
  )::text);
  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, v_operation_name, v_kind || ':' || p_target_id::text,
    v_actor, v_key, v_hash
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = v_operation_name
    AND operation_row.subject_scope = v_kind || ':' || p_target_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'Idempotency key reused with a different payout payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('profit-payout-type:' || v_org::text, 0)
  );

  SELECT COALESCE(
           NULLIF(btrim(profile.full_name), ''),
           NULLIF(btrim(profile.email), ''),
           'Người dùng'
         )
    INTO v_actor_name
  FROM public.profiles profile
  WHERE profile.id = v_actor;

  SELECT type_row.id INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'expense'
    AND lower(btrim(type_row.name)) = lower(v_type_name)
  ORDER BY type_row.created_at, type_row.id
  LIMIT 1;
  IF v_type IS NULL THEN
    INSERT INTO public.income_expense_types (
      user_id, organization_id, name, type, category,
      is_default, is_deposit, description
    ) VALUES (
      v_owner, v_org, v_type_name, 'expense', v_category,
      false, false, 'Legacy-compatible profit payout; excluded from P&L'
    ) RETURNING id INTO v_type;
  END IF;

  v_voucher_name := COALESCE(
    NULLIF(btrim(COALESCE(p_note, '')), ''),
    CASE WHEN v_kind = 'SHAREHOLDER'
      THEN 'Chia lợi nhuận: ' || v_subject_name
      ELSE 'Lương điều hành: ' || v_subject_name
    END
  );

  PERFORM app_private.begin_accounting_chain_write_v1();
  INSERT INTO public.income_expenses (
    user_id, organization_id, creator_name, type, name,
    building_id, account_id, shareholder_id, profit_manager_id,
    business_result_accounting, approval_status, voucher_date,
    attachments, repeat_cycle, repeat_infinity, repeat_count, repeat_remaining,
    source_payload_hash, system_source, idempotency_key
  ) VALUES (
    v_owner, v_org, COALESCE(v_actor_name, 'Người dùng'), 'EXPENSE', v_voucher_name,
    v_building, p_account_id,
    CASE WHEN v_kind = 'SHAREHOLDER' THEN p_target_id ELSE NULL END,
    CASE WHEN v_kind = 'MANAGER' THEN p_target_id ELSE NULL END,
    false, 'UNAPPROVED', p_voucher_date,
    '[]'::jsonb, 'NONE', false, 0, 0,
    v_hash, v_system_source, v_key
  ) RETURNING id INTO v_voucher;

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date,
    accounting_class
  ) VALUES (
    v_voucher, v_org, v_type,
    NULLIF(btrim(COALESCE(p_note, '')), ''),
    1, round(p_amount, 2), round(p_amount, 2),
    p_voucher_date, p_voucher_date, 'INTERNAL'
  );
  PERFORM public.recompute_ie_business_result(v_voucher);
  PERFORM app_private.end_accounting_chain_write_v1();

  v_response := jsonb_build_object(
    'voucher_id', v_voucher,
    'target_kind', v_kind,
    'target_id', p_target_id,
    'state', 'UNAPPROVED'
  );
  UPDATE app_private.canonical_write_operations
     SET subject_id = v_voucher,
         response_payload = v_response,
         completed_at = clock_timestamp()
   WHERE organization_id = v_org
     AND operation = v_operation_name
     AND subject_scope = v_kind || ':' || p_target_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END;
$$;

-- Resolve the destination cashbook from the locked payment/invoice tenant and
-- update both the payment and every legacy source voucher atomically.
CREATE OR REPLACE FUNCTION public.update_invoice_payment_method_v1(
  p_payment_id uuid,
  p_new_method public.payment_method
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_payment_user uuid;
  v_current_method public.payment_method;
  v_collection uuid;
  v_tender uuid;
  v_reversed_at timestamptz;
  v_org uuid;
  v_building uuid;
  v_building_name text;
  v_default_tt uuid;
  v_default_tk uuid;
  v_account uuid;
  v_authz boolean;
  v_voucher_count integer := 0;
  v_marker text := '[THU TACH COC ' || p_payment_id::text || ']';
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_new_method IS NULL OR p_new_method::text NOT IN ('TM', 'TT', 'TK') THEN
    RAISE EXCEPTION 'Unsupported editable payment method' USING ERRCODE = '22023';
  END IF;

  SELECT payment_row.user_id, payment_row.payment_method,
         payment_row.collection_id, payment_row.tender_id, payment_row.reversed_at,
         invoice_row.organization_id, invoice_row.building_id,
         building_row.name, building_row.default_account_id_tt,
         building_row.default_account_id_tk
    INTO v_payment_user, v_current_method, v_collection, v_tender, v_reversed_at,
         v_org, v_building, v_building_name, v_default_tt, v_default_tk
  FROM public.payments payment_row
  JOIN public.invoices invoice_row
    ON invoice_row.id = payment_row.invoice_id
   AND invoice_row.deleted_at IS NULL
   AND invoice_row.organization_id = payment_row.organization_id
  JOIN public.buildings building_row
    ON building_row.id = invoice_row.building_id
   AND building_row.organization_id = invoice_row.organization_id
   AND building_row.deleted_at IS NULL
  JOIN public.organizations organization_row
    ON organization_row.id = invoice_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE payment_row.id = p_payment_id
  FOR UPDATE OF payment_row, invoice_row;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'Payment not found in an active organization'
      USING ERRCODE = '42501';
  END IF;
  IF v_reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A reversed payment cannot change method'
      USING ERRCODE = '55000';
  END IF;
  IF v_collection IS NOT NULL OR v_tender IS NOT NULL THEN
    RAISE EXCEPTION 'Collection-based payments must be edited at collection level'
      USING ERRCODE = '55000';
  END IF;
  IF v_current_method = p_new_method THEN
    RETURN jsonb_build_object(
      'payment_id', p_payment_id,
      'new_method', p_new_method,
      'skipped', true
    );
  END IF;

  IF p_new_method = 'TM'::public.payment_method THEN
    SELECT account_row.id INTO v_account
    FROM public.accounts account_row
    WHERE account_row.organization_id = v_org
      AND account_row.user_id = v_payment_user
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
      AND right(lower(btrim(account_row.name)), 3) = 'thu'
    ORDER BY account_row.is_default DESC, account_row.created_at, account_row.id
    LIMIT 1
    FOR SHARE;
    IF v_account IS NULL THEN
      SELECT account_row.id INTO v_account
      FROM public.accounts account_row
      WHERE account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND NOT account_row.is_virtual
        AND lower(btrim(account_row.name)) = 'chung'
      ORDER BY account_row.is_default DESC, account_row.created_at, account_row.id
      LIMIT 1
      FOR SHARE;
    END IF;
  ELSE
    v_account := CASE
      WHEN p_new_method = 'TT'::public.payment_method THEN v_default_tt
      ELSE v_default_tk
    END;
    IF v_account IS NOT NULL THEN
      PERFORM 1
      FROM public.accounts account_row
      WHERE account_row.id = v_account
        AND account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND NOT account_row.is_virtual
      FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Configured building cashbook is invalid for this organization'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NULLIF(btrim(v_building_name), '') IS NOT NULL THEN
      SELECT account_row.id INTO v_account
      FROM public.accounts account_row
      WHERE account_row.organization_id = v_org
        AND account_row.deleted_at IS NULL
        AND NOT account_row.is_virtual
        AND account_row.name = v_building_name
      ORDER BY account_row.is_default DESC, account_row.created_at, account_row.id
      LIMIT 1
      FOR SHARE;
    END IF;
  END IF;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'No real cashbook is configured for the selected payment method'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.collect', v_building, v_account
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Not authorized to edit this payment'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.income_expenses voucher_row
  WHERE voucher_row.deleted_at IS NULL
    AND (
      voucher_row.payment_id = p_payment_id
      OR position(v_marker IN COALESCE(voucher_row.notes, '')) > 0
    )
  ORDER BY voucher_row.id
  FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM public.income_expenses voucher_row
    WHERE voucher_row.deleted_at IS NULL
      AND (
        voucher_row.payment_id = p_payment_id
        OR position(v_marker IN COALESCE(voucher_row.notes, '')) > 0
      )
      AND voucher_row.organization_id IS DISTINCT FROM v_org
  ) THEN
    RAISE EXCEPTION 'Payment source voucher crosses organization boundary'
      USING ERRCODE = '55000';
  END IF;

  UPDATE public.income_expenses voucher_row
     SET account_id = v_account,
         updated_at = clock_timestamp()
   WHERE voucher_row.organization_id = v_org
     AND voucher_row.deleted_at IS NULL
     AND (
       voucher_row.payment_id = p_payment_id
       OR position(v_marker IN COALESCE(voucher_row.notes, '')) > 0
     );
  GET DIAGNOSTICS v_voucher_count = ROW_COUNT;

  UPDATE public.payments payment_row
     SET payment_method = p_new_method,
         updated_at = clock_timestamp()
   WHERE payment_row.id = p_payment_id
     AND payment_row.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment changed concurrently' USING ERRCODE = '40001';
  END IF;

  RETURN jsonb_build_object(
    'payment_id', p_payment_id,
    'new_method', p_new_method,
    'new_account_id', v_account,
    'voucher_count', v_voucher_count,
    'voucher_found', v_voucher_count > 0,
    'skipped', false
  );
END;
$$;

-- Route ordinary payments through compensating reversal. Only the historical
-- split-voucher shape uses atomic cleanup, preserving the old support behavior.
CREATE OR REPLACE FUNCTION public.undo_invoice_payment_compat_v1(
  p_payment_id uuid,
  p_reason text,
  p_idempotency_key text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_key text := btrim(COALESCE(p_idempotency_key, ''));
  v_hash text;
  v_operation app_private.canonical_write_operations%ROWTYPE;
  v_org uuid;
  v_building uuid;
  v_invoice uuid;
  v_collection uuid;
  v_tender uuid;
  v_reversed_at timestamptz;
  v_has_pair boolean := false;
  v_authz boolean;
  v_marker text := '[THU TACH COC ' || p_payment_id::text || ']';
  v_deleted integer := 0;
  v_reverse jsonb;
  v_response jsonb;
  c_operation constant text := 'invoice.legacy_split.delete.compat.v1';
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF v_key !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$' THEN
    RAISE EXCEPTION 'Invalid idempotency key' USING ERRCODE = '22023';
  END IF;
  v_hash := md5(jsonb_build_object(
    'payment_id', p_payment_id,
    'reason', NULLIF(btrim(COALESCE(p_reason, '')), '')
  )::text);

  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.operation = c_operation
    AND operation_row.subject_scope = p_payment_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_operation.payload_hash <> v_hash THEN
      RAISE EXCEPTION 'Idempotency key reused with a different undo payload'
        USING ERRCODE = '23505';
    END IF;
    IF v_operation.completed_at IS NOT NULL THEN
      RETURN v_operation.response_payload;
    END IF;
  END IF;

  SELECT payment_row.organization_id, invoice_row.building_id, invoice_row.id,
         payment_row.collection_id, payment_row.tender_id, payment_row.reversed_at
    INTO v_org, v_building, v_invoice, v_collection, v_tender, v_reversed_at
  FROM public.payments payment_row
  JOIN public.invoices invoice_row
    ON invoice_row.id = payment_row.invoice_id
   AND invoice_row.deleted_at IS NULL
   AND invoice_row.organization_id = payment_row.organization_id
  JOIN public.buildings building_row
    ON building_row.id = invoice_row.building_id
   AND building_row.organization_id = invoice_row.organization_id
   AND building_row.deleted_at IS NULL
  JOIN public.organizations organization_row
    ON organization_row.id = invoice_row.organization_id
   AND organization_row.status = 'ACTIVE'
  WHERE payment_row.id = p_payment_id
  FOR UPDATE OF payment_row, invoice_row;
  IF v_org IS NULL THEN
    SELECT * INTO v_operation
    FROM app_private.canonical_write_operations operation_row
    WHERE operation_row.operation = c_operation
      AND operation_row.subject_scope = p_payment_id::text
      AND operation_row.actor_id = v_actor
      AND operation_row.idempotency_key = v_key
      AND operation_row.completed_at IS NOT NULL;
    IF FOUND AND v_operation.payload_hash = v_hash THEN
      RETURN v_operation.response_payload;
    END IF;
    RAISE EXCEPTION 'Payment not found in an active organization'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
  FROM public.income_expenses voucher_row
  WHERE voucher_row.organization_id = v_org
    AND voucher_row.deleted_at IS NULL
    AND (
      voucher_row.payment_id = p_payment_id
      OR position(v_marker IN COALESCE(voucher_row.notes, '')) > 0
    )
  ORDER BY voucher_row.id
  FOR UPDATE;
  SELECT EXISTS (
    SELECT 1
    FROM public.income_expenses voucher_row
    WHERE voucher_row.organization_id = v_org
      AND voucher_row.deleted_at IS NULL
      AND position(v_marker IN COALESCE(voucher_row.notes, '')) > 0
  ) INTO v_has_pair;

  IF NOT v_has_pair THEN
    v_reverse := public.reverse_invoice_payment_v3(
      p_payment_id, p_reason, v_key
    )::jsonb;
    RETURN jsonb_build_object(
      'payment_id', p_payment_id,
      'mode', 'REVERSED',
      'result', v_reverse
    );
  END IF;
  IF v_collection IS NOT NULL OR v_tender IS NOT NULL OR v_reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy split cleanup cannot delete a canonical or reversed payment'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.lock_org_for_decision_v1(v_org);
  SELECT allowed INTO v_authz
  FROM app_private.authorize_tenant_action_v3(
    v_actor, v_org, 'thu_tien.undo', v_building, NULL
  );
  IF NOT COALESCE(v_authz, false) THEN
    RAISE EXCEPTION 'Not authorized to undo this payment'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO app_private.canonical_write_operations (
    organization_id, operation, subject_scope, actor_id,
    idempotency_key, payload_hash
  ) VALUES (
    v_org, c_operation, p_payment_id::text, v_actor, v_key, v_hash
  )
  ON CONFLICT (organization_id, operation, subject_scope, actor_id, idempotency_key)
  DO NOTHING;
  SELECT * INTO v_operation
  FROM app_private.canonical_write_operations operation_row
  WHERE operation_row.organization_id = v_org
    AND operation_row.operation = c_operation
    AND operation_row.subject_scope = p_payment_id::text
    AND operation_row.actor_id = v_actor
    AND operation_row.idempotency_key = v_key
  FOR UPDATE;
  IF v_operation.payload_hash <> v_hash THEN
    RAISE EXCEPTION 'Idempotency key reused with a different undo payload'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.completed_at IS NOT NULL THEN
    RETURN v_operation.response_payload;
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();
  UPDATE public.income_expenses voucher_row
     SET deleted_at = clock_timestamp(),
         updated_at = clock_timestamp()
   WHERE voucher_row.organization_id = v_org
     AND voucher_row.deleted_at IS NULL
     AND (
       voucher_row.payment_id = p_payment_id
       OR position(v_marker IN COALESCE(voucher_row.notes, '')) > 0
     );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  DELETE FROM public.excess_amounts excess_row
  WHERE excess_row.source_payment_id = p_payment_id;
  DELETE FROM public.payments payment_row
  WHERE payment_row.id = p_payment_id
    AND payment_row.organization_id = v_org;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Payment changed concurrently' USING ERRCODE = '40001';
  END IF;
  PERFORM app_private.end_accounting_chain_write_v1();

  v_response := jsonb_build_object(
    'payment_id', p_payment_id,
    'invoice_id', v_invoice,
    'mode', 'DELETED',
    'deleted_voucher_count', v_deleted
  );
  UPDATE app_private.canonical_write_operations
     SET subject_id = p_payment_id,
         response_payload = v_response,
         completed_at = clock_timestamp()
   WHERE organization_id = v_org
     AND operation = c_operation
     AND subject_scope = p_payment_id::text
     AND actor_id = v_actor
     AND idempotency_key = v_key;
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.create_profit_payout_compat_v1(
  text, uuid, numeric, uuid, date, text, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_profit_payout_compat_v1(
  text, uuid, numeric, uuid, date, text, text
) TO authenticated;
REVOKE ALL ON FUNCTION public.update_invoice_payment_method_v1(
  uuid, public.payment_method
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.update_invoice_payment_method_v1(
  uuid, public.payment_method
) TO authenticated;
REVOKE ALL ON FUNCTION public.undo_invoice_payment_compat_v1(
  uuid, text, text
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.undo_invoice_payment_compat_v1(
  uuid, text, text
) TO authenticated;

-- Trigger functions must not retain PostgreSQL's implicit PUBLIC EXECUTE.
REVOKE ALL ON FUNCTION app_private.guard_payment_canonical_link()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_income_expense_accounting_links_v1()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._guard_profit_payout_insert_v2()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION app_private.guard_profit_payout_scope_compat_v1()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.record_invoice_payment_v4(
  uuid, numeric, public.payment_method, date, text, uuid, text, text,
  jsonb, jsonb, text, uuid
) IS
  'Single-payment compatibility writer for the narrowed L03 rollout. Validates PNL/DEPOSIT allocation server-side and does not create V5 collections.';

COMMIT;
