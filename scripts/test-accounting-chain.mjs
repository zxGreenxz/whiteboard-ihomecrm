#!/usr/bin/env node
// Run the full accounting chain against the live catalog, then roll everything back.
import { readFileSync } from "node:fs";

const migrationFiles = [
  "supabase/migrations/20260721070000_accounting_rollout_prerequisites.sql",
  "supabase/migrations/20260721075000_accounting_canary_caps.sql",
  "supabase/migrations/20260721080000_accounting_semantics_snapshot.sql",
  "supabase/migrations/20260721090000_contract_create_v2.sql",
  "supabase/migrations/20260721100000_invoice_collection_v5.sql",
  "supabase/migrations/20260721102000_active_payments_reporting.sql",
  "supabase/migrations/20260721110000_profit_unallocated_integrity_v3.sql",
  "supabase/migrations/20260721120000_profit_payout_reservations_v2.sql",
  "supabase/migrations/20260721130000_accounting_history_repair.sql",
  "supabase/migrations/20260721132500_accounting_history_resolution_v1.sql",
  "supabase/migrations/20260721135000_customer_credit_application_v1.sql",
  "supabase/migrations/20260721135500_termination_non_cash_payment_semantics.sql",
  "supabase/migrations/20260721140500_accounting_rollout_gate_v1.sql",
];

const projectRef = readFileSync("supabase/.temp/project-ref", "utf8").trim();
const localConfig = readFileSync("CLAUDE.local.md", "utf8");
const pat = (localConfig.match(/sbp_[a-z0-9]+/) || [])[0];

if (!pat) {
  console.error("Missing Supabase PAT in CLAUDE.local.md");
  process.exit(1);
}

async function databaseQuery(query) {
  const response = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Database query failed (${response.status}): ${body}`);
  }
  return JSON.parse(body);
}

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function migrationBody(file) {
  return readFileSync(file, "utf8")
    .replace(/^\uFEFF?\s*BEGIN;\s*/i, "")
    .replace(
      /\s*COMMIT;\s*(?:NOTIFY\s+pgrst\s*,\s*'reload schema';\s*)?$/i,
      "",
    );
}

const migrationHooks = new Map([
  [
    "supabase/migrations/20260721120000_profit_payout_reservations_v2.sql",
    {
      before: String.raw`
DO $legacy_payout_fixture$
DECLARE
  v_org constant uuid := 'dddd0000-0000-4000-8000-000000000001'::uuid;
  v_actor constant uuid := 'de6f33f3-349f-4bec-bd3d-106192f6715e'::uuid;
  v_building uuid;
  v_shareholder uuid;
  v_account uuid;
  v_stale_monthly uuid := gen_random_uuid();
  v_future_monthly uuid := gen_random_uuid();
  v_stale_allocation uuid := gen_random_uuid();
  v_future_allocation uuid := gen_random_uuid();
  v_voucher uuid;
BEGIN
  SELECT link.building_id, link.shareholder_id
    INTO v_building, v_shareholder
  FROM public.building_shareholders link
  JOIN public.buildings building_row ON building_row.id = link.building_id
  WHERE building_row.organization_id = v_org
    AND building_row.deleted_at IS NULL
    AND NOT building_row.is_virtual
  ORDER BY link.building_id, link.id
  LIMIT 1;

  SELECT account_row.id INTO v_account
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;

  IF v_building IS NULL OR v_shareholder IS NULL OR v_account IS NULL THEN
    RAISE EXCEPTION 'Missing DEMO rows for legacy payout migration regression';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.profit_monthly monthly
    WHERE monthly.building_id = v_building
      AND monthly.period_month IN ('1901-05-01'::date, '1901-07-01'::date)
  ) THEN
    RAISE EXCEPTION 'Reserved legacy payout regression months already exist';
  END IF;

  INSERT INTO public.profit_monthly (
    id, user_id, building_id, period_month, computed_profit,
    adjusted_profit, status, note, locked_at, locked_by,
    organization_id, adjustment_amount, source_revenue, source_expense,
    source_net_profit, source_hash, source_captured_at, is_stale,
    stale_reason, revision_number
  ) VALUES
    (
      v_stale_monthly, v_actor, v_building, '1901-05-01', 50000,
      50000, 'LOCKED', 'Accounting rollback stale payout allocation',
      clock_timestamp(), v_actor, v_org, 0, 50000, 0, 50000,
      repeat('1', 32), clock_timestamp(), true,
      'ACCOUNTING_TEST_STALE', 1
    ),
    (
      v_future_monthly, v_actor, v_building, '1901-07-01', 50000,
      50000, 'LOCKED', 'Accounting rollback future payout allocation',
      clock_timestamp(), v_actor, v_org, 0, 50000, 0, 50000,
      repeat('2', 32), clock_timestamp(), false, NULL, 1
    );

  INSERT INTO public.profit_allocations (
    id, user_id, profit_monthly_id, shareholder_id, percent, amount,
    organization_id
  ) VALUES
    (
      v_stale_allocation, v_actor, v_stale_monthly, v_shareholder,
      100, 50000, v_org
    ),
    (
      v_future_allocation, v_actor, v_future_monthly, v_shareholder,
      100, 50000, v_org
    );

  PERFORM app_private.begin_accounting_chain_write_v1();
  INSERT INTO public.income_expenses (
    organization_id, user_id, type, name, building_id, account_id,
    shareholder_id, voucher_date, total_amount, approval_status,
    business_result_accounting, notes
  ) VALUES (
    v_org, v_actor, 'EXPENSE', 'Accounting rollback legacy payout',
    v_building, v_account, v_shareholder, '1901-06-15', 50000,
    'UNAPPROVED', false,
    '[Accounting rollback] stale/future allocation regression'
  ) RETURNING id INTO v_voucher;
  PERFORM app_private.end_accounting_chain_write_v1();

  PERFORM set_config(
    'accounting_test.legacy_payout_voucher', v_voucher::text, true
  );
  PERFORM set_config(
    'accounting_test.legacy_payout_stale_allocation',
    v_stale_allocation::text, true
  );
  PERFORM set_config(
    'accounting_test.legacy_payout_future_allocation',
    v_future_allocation::text, true
  );
  PERFORM set_config(
    'accounting_test.legacy_payout_stale_monthly', v_stale_monthly::text, true
  );
  PERFORM set_config(
    'accounting_test.legacy_payout_future_monthly', v_future_monthly::text, true
  );
END;
$legacy_payout_fixture$;
`,
      after: String.raw`
DO $legacy_payout_regression$
DECLARE
  v_voucher uuid := current_setting(
    'accounting_test.legacy_payout_voucher'
  )::uuid;
  v_stale_allocation uuid := current_setting(
    'accounting_test.legacy_payout_stale_allocation'
  )::uuid;
  v_future_allocation uuid := current_setting(
    'accounting_test.legacy_payout_future_allocation'
  )::uuid;
  v_stale_monthly uuid := current_setting(
    'accounting_test.legacy_payout_stale_monthly'
  )::uuid;
  v_future_monthly uuid := current_setting(
    'accounting_test.legacy_payout_future_monthly'
  )::uuid;
  v_count integer;
  v_amount numeric;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.profit_payout_reservations reservation
  WHERE reservation.payout_voucher_id = v_voucher
    AND reservation.profit_allocation_id IN (
      v_stale_allocation, v_future_allocation
    );
  IF v_count <> 0 THEN
    RAISE EXCEPTION
      'Legacy payout reserved a stale or post-voucher allocation';
  END IF;

  SELECT count(*), COALESCE(sum(exception.amount), 0)
    INTO v_count, v_amount
  FROM public.profit_payout_exceptions exception
  WHERE exception.payout_voucher_id = v_voucher
    AND exception.exception_code = 'LEGACY_PAYOUT_EXCEEDS_ALLOCATIONS';
  IF v_count <> 1 OR v_amount <> 50000 THEN
    RAISE EXCEPTION
      'Legacy payout invalid-allocation remainder was not fail-visible';
  END IF;

  DELETE FROM public.profit_payout_exceptions
  WHERE payout_voucher_id = v_voucher;
  PERFORM app_private.begin_accounting_chain_write_v1();
  DELETE FROM public.income_expenses WHERE id = v_voucher;
  PERFORM app_private.end_accounting_chain_write_v1();
  DELETE FROM public.profit_allocations
  WHERE id IN (v_stale_allocation, v_future_allocation);
  DELETE FROM public.profit_monthly
  WHERE id IN (v_stale_monthly, v_future_monthly);
END;
$legacy_payout_regression$;
`,
    },
  ],
  [
    "supabase/migrations/20260721130000_accounting_history_repair.sql",
    {
      before: String.raw`
DO $recollection_fixture$
DECLARE
  v_org constant uuid := 'dddd0000-0000-4000-8000-000000000001'::uuid;
  v_actor constant uuid := 'de6f33f3-349f-4bec-bd3d-106192f6715e'::uuid;
  v_contract uuid;
  v_owner uuid;
  v_building uuid;
  v_room uuid;
  v_account uuid;
  v_revenue_type uuid;
  v_invoice uuid;
  v_payment_a uuid;
  v_payment_b uuid;
  v_voucher_a uuid;
  v_voucher_b uuid;
BEGIN
  SELECT contract_row.id, contract_row.user_id,
         room_row.building_id, contract_row.room_id
    INTO v_contract, v_owner, v_building, v_room
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE contract_row.organization_id = v_org
    AND contract_row.deleted_at IS NULL
    AND contract_row.status = 'ACTIVE'
    AND room_row.deleted_at IS NULL
    AND building_row.deleted_at IS NULL
    AND NOT building_row.is_virtual
    AND NOT EXISTS (
      SELECT 1
      FROM public.invoices invoice_row
      WHERE invoice_row.contract_id = contract_row.id
        AND invoice_row.kind = 'MONTHLY'
        AND invoice_row.billing_month = '1902-01'
        AND invoice_row.deleted_at IS NULL
    )
  ORDER BY contract_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_account
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;

  SELECT type_row.id INTO v_revenue_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND NOT type_row.is_deposit
  ORDER BY type_row.is_default DESC, type_row.created_at, type_row.id
  LIMIT 1;

  IF v_contract IS NULL OR v_account IS NULL OR v_revenue_type IS NULL THEN
    RAISE EXCEPTION 'Missing DEMO rows for recollection migration regression';
  END IF;

  INSERT INTO public.invoices (
    organization_id, user_id, contract_id, building_id, room_id, kind,
    billing_month, issue_date, due_date, status, subtotal, total_amount, notes
  ) VALUES (
    v_org, v_owner, v_contract, v_building, v_room, 'MONTHLY',
    '1902-01', '1902-01-01', '1902-01-10', 'APPROVED',
    200000, 200000, '[Accounting rollback] reversed-then-recollected fixture'
  ) RETURNING id INTO v_invoice;

  INSERT INTO public.invoice_items (
    invoice_id, accounting_class, type, description,
    unit_price, quantity, coefficient, amount, sort_order
  ) VALUES
    (
      v_invoice, 'REVENUE', 'RENT', 'Recollection revenue',
      100000, 1, 1, 100000, 1
    ),
    (
      v_invoice, 'DEPOSIT', 'OTHER', 'Recollection deposit',
      100000, 1, 1, 100000, 2
    );

  PERFORM app_private.begin_accounting_chain_write_v1();
  INSERT INTO public.payments (
    organization_id, user_id, invoice_id, amount, payment_method,
    payment_date, notes, reversed_at, created_at
  ) VALUES (
    v_org, v_actor, v_invoice, 100000, 'TM', '1902-01-05',
    '[Accounting rollback] reversed receipt A',
    '1902-01-06 00:00:00+07', '1902-01-05 09:00:00+07'
  ) RETURNING id INTO v_payment_a;

  INSERT INTO public.payments (
    organization_id, user_id, invoice_id, amount, payment_method,
    payment_date, notes, created_at
  ) VALUES (
    v_org, v_actor, v_invoice, 200000, 'CT', '1902-01-07',
    '[Accounting rollback] replacement receipt B',
    '1902-01-07 09:00:00+07'
  ) RETURNING id INTO v_payment_b;

  INSERT INTO public.income_expenses (
    organization_id, user_id, type, name, building_id, room_id, contract_id,
    account_id, invoice_id, payment_id, voucher_date, total_amount,
    approval_status, approved_by, approved_at, system_source
  ) VALUES (
    v_org, v_actor, 'INCOME', 'Reversed receipt A',
    v_building, v_room, v_contract, v_account, v_invoice, v_payment_a,
    '1902-01-05', 100000, 'APPROVED', v_actor, clock_timestamp(),
    'accounting.test.recollection'
  ) RETURNING id INTO v_voucher_a;

  INSERT INTO public.income_expenses (
    organization_id, user_id, type, name, building_id, room_id, contract_id,
    account_id, invoice_id, payment_id, voucher_date, total_amount,
    approval_status, approved_by, approved_at, system_source
  ) VALUES (
    v_org, v_actor, 'INCOME', 'Replacement receipt B',
    v_building, v_room, v_contract, v_account, v_invoice, v_payment_b,
    '1902-01-07', 200000, 'APPROVED', v_actor, clock_timestamp(),
    'accounting.test.recollection'
  ) RETURNING id INTO v_voucher_b;

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date,
    accounting_class
  ) VALUES
    (
      v_voucher_a, v_org, v_revenue_type, 'Receipt A legacy revenue',
      1, 100000, 100000, '1902-01-05', '1902-01-05', 'PNL'
    ),
    (
      v_voucher_b, v_org, v_revenue_type, 'Receipt B legacy unsplit amount',
      1, 200000, 200000, '1902-01-07', '1902-01-07', 'PNL'
    );

  PERFORM public.recompute_ie_business_result(v_voucher_a);
  PERFORM public.recompute_ie_business_result(v_voucher_b);
  PERFORM public.recompute_invoice_for_id(v_invoice);
  PERFORM app_private.end_accounting_chain_write_v1();

  PERFORM set_config(
    'accounting_test.recollection_invoice', v_invoice::text, true
  );
  PERFORM set_config(
    'accounting_test.recollection_payment_a', v_payment_a::text, true
  );
  PERFORM set_config(
    'accounting_test.recollection_payment_b', v_payment_b::text, true
  );
  PERFORM set_config(
    'accounting_test.recollection_voucher_b', v_voucher_b::text, true
  );
END;
$recollection_fixture$;
`,
      after: String.raw`
DO $recollection_regression$
DECLARE
  v_invoice uuid := current_setting(
    'accounting_test.recollection_invoice'
  )::uuid;
  v_payment_a uuid := current_setting(
    'accounting_test.recollection_payment_a'
  )::uuid;
  v_payment_b uuid := current_setting(
    'accounting_test.recollection_payment_b'
  )::uuid;
  v_voucher_b uuid := current_setting(
    'accounting_test.recollection_voucher_b'
  )::uuid;
  v_received numeric;
  v_credit numeric;
  v_pnl numeric;
  v_deposit numeric;
  v_item_credit numeric;
  v_paid numeric;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.payments payment
    WHERE payment.id = v_payment_a
      AND payment.reversed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Receipt A is not reversed in recollection regression';
  END IF;

  SELECT payment.received_amount, payment.credit_amount
    INTO v_received, v_credit
  FROM public.payments payment
  WHERE payment.id = v_payment_b;
  IF v_received IS DISTINCT FROM 200000 OR v_credit IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION
      'Replacement receipt B reused reversed paid_before: received %, credit %',
      v_received, v_credit;
  END IF;

  SELECT
    COALESCE(sum(item.amount) FILTER (
      WHERE item.accounting_class = 'PNL'
    ), 0),
    COALESCE(sum(item.amount) FILTER (
      WHERE item.accounting_class = 'DEPOSIT'
    ), 0),
    COALESCE(sum(item.amount) FILTER (
      WHERE item.accounting_class = 'CUSTOMER_CREDIT'
    ), 0)
    INTO v_pnl, v_deposit, v_item_credit
  FROM public.income_expense_items item
  WHERE item.income_expense_id = v_voucher_b;
  IF v_pnl <> 100000 OR v_deposit <> 100000 OR v_item_credit <> 0 THEN
    RAISE EXCEPTION
      'Replacement receipt B split mismatch: pnl %, deposit %, credit %',
      v_pnl, v_deposit, v_item_credit;
  END IF;

  SELECT invoice_row.paid_amount INTO v_paid
  FROM public.invoices invoice_row
  WHERE invoice_row.id = v_invoice;
  IF v_paid IS DISTINCT FROM 200000 THEN
    RAISE EXCEPTION
      'Replacement receipt B did not restore invoice paid amount: %', v_paid;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.excess_amounts excess
    WHERE excess.source_payment_id = v_payment_b
      AND excess.amount <> 0
  ) THEN
    RAISE EXCEPTION 'Replacement receipt B created false customer credit';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.accounting_integrity_exceptions exception
    WHERE exception.status = 'OPEN'
      AND exception.entity_id IN (v_invoice, v_payment_a, v_payment_b)
  ) THEN
    RAISE EXCEPTION 'Recollection fixture produced an accounting exception';
  END IF;
END;
$recollection_regression$;
`,
    },
  ],
  [
    "supabase/migrations/20260721135000_customer_credit_application_v1.sql",
    {
      before: String.raw`
DO $soft_deleted_credit_fixture$
DECLARE
  v_org constant uuid := 'dddd0000-0000-4000-8000-000000000001'::uuid;
  v_contract uuid;
  v_owner uuid;
  v_building uuid;
  v_room uuid;
  v_invoice uuid;
  v_excess uuid;
BEGIN
  SELECT contract_row.id, contract_row.user_id,
         room_row.building_id, contract_row.room_id
    INTO v_contract, v_owner, v_building, v_room
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE contract_row.organization_id = v_org
    AND contract_row.deleted_at IS NULL
    AND contract_row.status = 'ACTIVE'
    AND room_row.deleted_at IS NULL
    AND building_row.deleted_at IS NULL
    AND NOT building_row.is_virtual
    AND NOT EXISTS (
      SELECT 1
      FROM public.invoices invoice_row
      WHERE invoice_row.contract_id = contract_row.id
        AND invoice_row.kind = 'MONTHLY'
        AND invoice_row.billing_month = '1903-01'
        AND invoice_row.deleted_at IS NULL
    )
  ORDER BY contract_row.id
  LIMIT 1;

  IF v_contract IS NULL THEN
    RAISE EXCEPTION 'Missing DEMO contract for soft-deleted credit regression';
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();
  INSERT INTO public.invoices (
    organization_id, user_id, contract_id, building_id, room_id, kind,
    billing_month, issue_date, due_date, status, subtotal, total_amount,
    notes, deleted_at
  ) VALUES (
    v_org, v_owner, v_contract, v_building, v_room, 'MONTHLY',
    '1903-01', '1903-01-01', '1903-01-10', 'APPROVED', 43210, 43210,
    '[Accounting rollback] soft-deleted credit source', clock_timestamp()
  ) RETURNING id INTO v_invoice;

  INSERT INTO public.excess_amounts (
    organization_id, user_id, contract_id, amount, description,
    source_invoice_id, source_payment_id, credit_lot_id
  ) VALUES (
    v_org, v_owner, v_contract, 43210,
    '[Accounting rollback] soft-deleted invoice credit',
    v_invoice, NULL, NULL
  ) RETURNING id INTO v_excess;
  PERFORM app_private.end_accounting_chain_write_v1();

  PERFORM set_config(
    'accounting_test.soft_deleted_credit_invoice', v_invoice::text, true
  );
  PERFORM set_config(
    'accounting_test.soft_deleted_credit_excess', v_excess::text, true
  );
END;
$soft_deleted_credit_fixture$;
`,
      after: String.raw`
DO $soft_deleted_credit_regression$
DECLARE
  v_invoice uuid := current_setting(
    'accounting_test.soft_deleted_credit_invoice'
  )::uuid;
  v_excess uuid := current_setting(
    'accounting_test.soft_deleted_credit_excess'
  )::uuid;
  v_lot uuid;
  v_exception_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.invoices invoice_row
    WHERE invoice_row.id = v_invoice
      AND invoice_row.deleted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Soft-deleted credit source invoice lost its lifecycle state';
  END IF;

  SELECT excess.credit_lot_id INTO v_lot
  FROM public.excess_amounts excess
  WHERE excess.id = v_excess;
  SELECT count(*) INTO v_exception_count
  FROM public.accounting_integrity_exceptions exception
  WHERE exception.entity_type = 'EXCESS_AMOUNT'
    AND exception.entity_id = v_excess
    AND exception.status = 'OPEN';

  IF v_lot IS NULL AND v_exception_count = 0 THEN
    RAISE EXCEPTION
      'Soft-deleted invoice credit was silently skipped by canonicalization';
  END IF;
  IF v_lot IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.customer_credit_lots lot
    WHERE lot.id = v_lot
      AND lot.source_excess_amount_id = v_excess
      AND lot.amount = 43210
      AND lot.remaining_amount = 43210
      AND lot.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'Soft-deleted invoice credit lot is not canonical';
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();
  IF v_lot IS NOT NULL THEN
    UPDATE public.excess_amounts
       SET credit_lot_id = NULL
     WHERE id = v_excess;
    DELETE FROM public.customer_credit_lots WHERE id = v_lot;
  END IF;
  DELETE FROM public.accounting_integrity_exceptions
  WHERE entity_type = 'EXCESS_AMOUNT'
    AND entity_id = v_excess;
  DELETE FROM public.excess_amounts WHERE id = v_excess;
  PERFORM app_private.end_accounting_chain_write_v1();
END;
$soft_deleted_credit_regression$;
`,
    },
  ],
]);

const assertions = String.raw`
DO $fixture$
DECLARE
  v_org constant uuid := 'dddd0000-0000-4000-8000-000000000001'::uuid;
  v_actor constant uuid := 'de6f33f3-349f-4bec-bd3d-106192f6715e'::uuid;
  v_building uuid;
  v_room uuid;
  v_customer uuid;
  v_account_tm uuid;
  v_account_tk uuid;
  v_virtual_account uuid;
  v_virtual_building uuid;
  v_account_payout uuid;
  v_cross_org_account uuid;
  v_shareholder_link uuid;
  v_shareholder uuid;
  v_legacy_contract uuid;
  v_legacy_owner uuid;
  v_legacy_building uuid;
  v_legacy_room uuid;
  v_legacy_invoice uuid;
  v_legacy_payment uuid;
  v_legacy_source uuid;
  v_legacy_type uuid;
  v_deposit_type uuid;
  v_orphan_deposit uuid;
  v_termination_probe uuid;
  v_moveout_invoice uuid;
  v_forfeit_invoice uuid;
  v_forfeit_revenue uuid;
  v_forfeit_offset uuid;
  v_forfeit_payment uuid;
  v_flag_count integer;
BEGIN
  IF has_function_privilege(
    'authenticated',
    'app_private.claim_feature_operation_v1(text,uuid,text,uuid,text,numeric)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Authenticated can execute the private canary claimant';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.legacy_payment_receipt_semantics semantics
    WHERE semantics.metadata_change_amount > 0
      AND (
        semantics.retained_amount <> semantics.stored_payment_amount
        OR semantics.change_amount <> semantics.metadata_change_amount
      )
  ) THEN
    RAISE EXCEPTION 'Legacy metadata change was subtracted twice or underreported';
  END IF;

  SELECT building_row.id, room_row.id
    INTO v_building, v_room
  FROM public.buildings building_row
  JOIN public.rooms room_row ON room_row.building_id = building_row.id
  WHERE building_row.organization_id = v_org
    AND building_row.deleted_at IS NULL
    AND NOT building_row.is_virtual
    AND room_row.deleted_at IS NULL
    AND room_row.status IN ('AVAILABLE', 'RESERVED')
    AND NOT EXISTS (
      SELECT 1
      FROM public.contracts contract_row
      WHERE contract_row.room_id = room_row.id
        AND contract_row.status = 'ACTIVE'
        AND contract_row.deleted_at IS NULL
    )
    AND (
      SELECT count(*)
      FROM public.building_shareholders link
      WHERE link.building_id = building_row.id
    ) >= 2
    AND abs((
      SELECT COALESCE(sum(link.percent), 0)
      FROM public.building_shareholders link
      WHERE link.building_id = building_row.id
    ) - 100) < 0.01
    AND COALESCE((
      SELECT allowed
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'contracts.create', building_row.id, NULL
      )
    ), false)
    AND COALESCE((
      SELECT allowed
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'invoices.create', building_row.id, NULL
      )
    ), false)
    AND COALESCE((
      SELECT allowed
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', building_row.id, NULL
      )
    ), false)
    AND COALESCE((
      SELECT allowed
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'income_expenses.approve', building_row.id, NULL
      )
    ), false)
  ORDER BY building_row.id, room_row.id
  LIMIT 1;

  IF v_building IS NULL OR v_room IS NULL THEN
    RAISE EXCEPTION 'No eligible DEMO building/room for accounting integration test';
  END IF;

  SELECT customer_row.id INTO v_customer
  FROM public.customers customer_row
  WHERE customer_row.organization_id = v_org
    AND customer_row.deleted_at IS NULL
  ORDER BY customer_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_account_tm
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
    AND COALESCE((
      SELECT allowed
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_building, account_row.id
      )
    ), false)
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_account_tk
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
    AND account_row.id <> v_account_tm
    AND COALESCE((
      SELECT allowed
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_building, account_row.id
      )
    ), false)
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_virtual_account
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org
    AND account_row.deleted_at IS NULL
    AND account_row.is_virtual
    AND COALESCE((
      SELECT allowed
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'thu_tien.collect', v_building, account_row.id
      )
    ), false)
  ORDER BY account_row.id
  LIMIT 1;

  SELECT building_row.id INTO v_virtual_building
  FROM public.buildings building_row
  WHERE building_row.organization_id = v_org
    AND building_row.is_virtual
    AND building_row.deleted_at IS NULL
  ORDER BY building_row.created_at, building_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_account_payout
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
    AND COALESCE((
      SELECT allowed
      FROM app_private.authorize_tenant_action_v3(
        v_actor, v_org, 'shareholder_profit.distribute',
        v_virtual_building, account_row.id
      )
    ), false)
  ORDER BY account_row.is_default DESC, account_row.id
  LIMIT 1;

  SELECT account_row.id INTO v_cross_org_account
  FROM public.accounts account_row
  WHERE account_row.organization_id <> v_org
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  ORDER BY account_row.organization_id, account_row.id
  LIMIT 1;

  IF v_customer IS NULL OR v_account_tm IS NULL OR v_account_tk IS NULL
     OR v_virtual_account IS NULL OR v_virtual_building IS NULL
     OR v_account_payout IS NULL OR v_cross_org_account IS NULL THEN
    RAISE EXCEPTION 'DEMO fixture lacks customer or permitted cashbook accounts';
  END IF;

  SELECT type_row.id INTO v_deposit_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND type_row.is_deposit
  ORDER BY type_row.is_default DESC, type_row.created_at, type_row.id
  LIMIT 1;
  IF v_deposit_type IS NULL THEN
    RAISE EXCEPTION 'DEMO fixture lacks an income deposit type';
  END IF;

  SELECT link.id, link.shareholder_id INTO v_shareholder_link, v_shareholder
  FROM public.building_shareholders link
  WHERE link.building_id = v_building
  ORDER BY link.percent DESC, link.id
  LIMIT 1;

  UPDATE app_private.server_feature_flags
     SET mode = 'CANARY',
         force_freeze = false,
         config_version = config_version + 1000,
         starts_at = clock_timestamp() - interval '1 hour',
         ends_at = clock_timestamp() + interval '1 day',
         max_operation_count = CASE
           WHEN feature_key = 'invoice.collection.v5' THEN 2
           ELSE 1
         END,
         max_single_amount_vnd = 1000000000,
         max_total_amount_vnd = 10000000000,
         commit_sha = 'rollback-accounting-test',
         migration_sha256 = repeat('a', 64),
         maintenance_window_id = 'rollback-accounting-test',
         approval_reference = 'rollback-accounting-test',
         updated_at = clock_timestamp()
   WHERE feature_key = ANY (ARRAY[
     'contract.create.v2',
     'invoice.collection.v5',
     'customer.credit.apply.v1',
     'shareholder_profit.distribute.v2'
   ]);
  GET DIAGNOSTICS v_flag_count = ROW_COUNT;
  IF v_flag_count <> 4 THEN
    RAISE EXCEPTION 'Expected 4 forward canary flags, found %', v_flag_count;
  END IF;

  INSERT INTO app_private.server_feature_flag_canary_orgs (
    feature_key, organization_id, added_by
  )
  SELECT feature_key, v_org, v_actor
  FROM unnest(ARRAY[
    'contract.create.v2',
    'invoice.collection.v5',
    'customer.credit.apply.v1',
    'shareholder_profit.distribute.v2'
  ]) AS feature(feature_key)
  ON CONFLICT (feature_key, organization_id) DO NOTHING;

  UPDATE app_private.server_feature_flags
     SET mode = 'ON',
         force_freeze = false,
         commit_sha = 'rollback-accounting-test',
         migration_sha256 = repeat('a', 64),
         maintenance_window_id = 'rollback-accounting-test',
         approval_reference = 'rollback-accounting-test',
         updated_at = clock_timestamp()
   WHERE feature_key = ANY (ARRAY[
     'invoice.create.v1',
     'invoice.reverse_payment.v1',
     'invoice.collection.reverse.v5',
     'customer.credit.reverse.v1'
   ]);
  GET DIAGNOSTICS v_flag_count = ROW_COUNT;
  IF v_flag_count <> 4 THEN
    RAISE EXCEPTION 'Expected 4 canonical support/reversal flags, found %', v_flag_count;
  END IF;

  UPDATE public.building_shareholders
     SET percent = percent - 40
   WHERE id = v_shareholder_link;

  PERFORM app_private.begin_accounting_chain_write_v1();
  INSERT INTO public.income_expenses (
    organization_id, user_id, type, name, building_id, room_id, contract_id,
    account_id, voucher_date, total_amount, approval_status, approved_by,
    approved_at, notes, system_source
  ) VALUES (
    v_org, v_actor, 'INCOME', 'Accounting rollback orphan deposit',
    v_building, v_room, NULL, v_account_tm, '2099-01-01', 1000000,
    'APPROVED', v_actor, clock_timestamp(),
    '[Accounting rollback] explicit contract deposit link',
    'accounting.test.orphan_deposit'
  ) RETURNING id INTO v_orphan_deposit;

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date,
    accounting_class
  ) VALUES (
    v_orphan_deposit, v_org, v_deposit_type,
    'Approved orphan deposit fixture', 1, 1000000, 1000000,
    '2099-01-01', '2099-01-01', 'DEPOSIT'
  );
  PERFORM public.recompute_ie_business_result(v_orphan_deposit);
  PERFORM app_private.end_accounting_chain_write_v1();

  SELECT contract_row.id, contract_row.user_id,
         room_row.building_id, contract_row.room_id
    INTO v_legacy_contract, v_legacy_owner, v_legacy_building, v_legacy_room
  FROM public.contracts contract_row
  JOIN public.rooms room_row ON room_row.id = contract_row.room_id
  WHERE contract_row.organization_id = v_org
    AND contract_row.deleted_at IS NULL
    AND contract_row.status = 'ACTIVE'
    AND room_row.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.invoices invoice
      WHERE invoice.contract_id = contract_row.id
        AND invoice.kind = 'MONTHLY'
        AND invoice.billing_month = '2097-12'
        AND invoice.deleted_at IS NULL
    )
  ORDER BY contract_row.id
  LIMIT 1;

  SELECT type_row.id INTO v_legacy_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND NOT type_row.is_deposit
  ORDER BY type_row.is_default DESC, type_row.created_at, type_row.id
  LIMIT 1;

  IF v_legacy_contract IS NULL OR v_legacy_type IS NULL THEN
    RAISE EXCEPTION 'No eligible DEMO source for legacy reversal integration test';
  END IF;

  INSERT INTO public.invoices (
    organization_id, user_id, contract_id, building_id, room_id, kind,
    billing_month, issue_date, due_date, status, subtotal, total_amount, notes
  ) VALUES (
    v_org, v_legacy_owner, v_legacy_contract,
    v_legacy_building, v_legacy_room, 'MONTHLY',
    '2097-12', '2097-12-01', '2097-12-10', 'APPROVED', 100000, 100000,
    '[Accounting rollback] legacy reversal fixture'
  ) RETURNING id INTO v_legacy_invoice;

  INSERT INTO public.invoice_items (
    invoice_id, accounting_class, type, description,
    unit_price, quantity, coefficient, amount, sort_order
  ) VALUES (
    v_legacy_invoice, 'REVENUE', 'OTHER', 'Legacy reversal fixture',
    100000, 1, 1, 100000, 1
  );

  INSERT INTO public.invoices (
    organization_id, user_id, contract_id, building_id, room_id, kind,
    billing_month, issue_date, due_date, status, subtotal, total_amount, notes
  ) VALUES (
    v_org, v_legacy_owner, v_legacy_contract,
    v_legacy_building, v_legacy_room, 'SETTLEMENT',
    '2097-12', '2097-12-01', '2097-12-01', 'APPROVED', 1, 1,
    '[Accounting rollback] move-out context fixture'
  ) RETURNING id INTO v_moveout_invoice;

  INSERT INTO public.invoice_items (
    invoice_id, accounting_class, type, description,
    unit_price, quantity, coefficient, amount, sort_order
  ) VALUES (
    v_moveout_invoice, 'REVENUE', 'OTHER', 'Move-out context fixture',
    1, 1, 1, 1, 1
  );

  PERFORM app_private.begin_accounting_chain_write_v1();
  INSERT INTO public.payments (
    organization_id, user_id, invoice_id, amount, received_amount,
    credit_amount, change_amount, rounding_amount,
    payment_method, payment_date, notes
  ) VALUES (
    v_org, v_actor, v_legacy_invoice, 100000, 100000,
    0, 0, 0, 'TM', public.vn_local_date(clock_timestamp()),
    '[Accounting rollback] legacy receipt'
  ) RETURNING id INTO v_legacy_payment;

  INSERT INTO public.income_expenses (
    organization_id, user_id, type, name, building_id, room_id, contract_id,
    account_id, invoice_id, payment_id, voucher_date, total_amount,
    approval_status, approved_by, approved_at, system_source
  ) VALUES (
    v_org, v_actor, 'INCOME', 'Legacy receipt reversal fixture',
    v_legacy_building, v_legacy_room, v_legacy_contract,
    v_account_tm, v_legacy_invoice, v_legacy_payment,
    public.vn_local_date(clock_timestamp()), 100000,
    'APPROVED', v_actor, clock_timestamp(), 'accounting.test.legacy'
  ) RETURNING id INTO v_legacy_source;

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date,
    accounting_class
  ) VALUES (
    v_legacy_source, v_org, v_legacy_type, 'Legacy receipt revenue',
    1, 100000, 100000,
    public.vn_local_date(clock_timestamp()), public.vn_local_date(clock_timestamp()),
    'PNL'
  );

  BEGIN
    INSERT INTO public.payments (
      organization_id, user_id, invoice_id, amount, payment_method,
      payment_date, notes
    ) VALUES (
      v_org, v_actor, v_moveout_invoice, 1, 'CT', '2097-12-01',
      'Quyết toán khi thanh lý 01/12/2097'
    );
    RAISE EXCEPTION 'Generic writer forged a move-out payment without context';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  INSERT INTO app_private.termination_move_out_writer_context (
    transaction_id, backend_pid, organization_id, user_id,
    contract_id, building_id, room_id, move_out_date
  ) VALUES (
    txid_current(), pg_backend_pid(), v_org, v_legacy_owner,
    v_legacy_contract, v_legacy_building, v_legacy_room, '2097-12-01'
  );

  INSERT INTO public.payments (
    organization_id, user_id, invoice_id, amount, payment_method,
    payment_date, notes
  ) VALUES (
    v_org, v_legacy_owner, v_moveout_invoice, 1, 'CT', '2097-12-01',
    'Quyết toán khi thanh lý 01/12/2097'
  ) RETURNING id INTO v_termination_probe;
  IF NOT EXISTS (
    SELECT 1
    FROM public.payments payment
    WHERE payment.id = v_termination_probe
      AND payment.amount = 1
      AND payment.received_amount = 0
      AND payment.credit_amount = 0
      AND payment.change_amount = 0
      AND payment.rounding_amount = 0
  ) THEN
    RAISE EXCEPTION 'Trusted termination payment was not classified as non-cash';
  END IF;
  DELETE FROM public.payments WHERE id = v_termination_probe;
  DELETE FROM app_private.termination_move_out_writer_context
  WHERE transaction_id = txid_current()
    AND backend_pid = pg_backend_pid();

  INSERT INTO public.invoices (
    organization_id, user_id, contract_id, building_id, room_id, kind,
    billing_month, issue_date, due_date, status, subtotal, total_amount, notes
  ) VALUES (
    v_org, v_legacy_owner, v_legacy_contract, v_legacy_building, v_legacy_room,
    'SETTLEMENT', '2097-12', '2097-12-02', '2097-12-02', 'APPROVED',
    12345, 12345, '[Accounting rollback] forfeit provenance fixture'
  ) RETURNING id INTO v_forfeit_invoice;

  INSERT INTO public.invoice_items (
    invoice_id, type, description, unit_price, quantity, coefficient,
    amount, sort_order, accounting_class
  ) VALUES (
    v_forfeit_invoice, 'PENALTY', 'Forfeit provenance fixture',
    12345, 1, 1, 12345, 1, 'REVENUE'
  );

  INSERT INTO public.income_expenses (
    user_id, organization_id, type, name, building_id, room_id, contract_id,
    account_id, voucher_date, total_amount, approval_status, notes, system_source
  ) VALUES (
    v_legacy_owner, v_org, 'EXPENSE', 'Forfeit offset fixture',
    v_legacy_building, v_legacy_room, v_legacy_contract, v_virtual_account,
    '2097-12-02', 12345, 'UNAPPROVED', '[Accounting rollback] forfeit pair',
    'termination.forfeit_offset'
  ) RETURNING id INTO v_forfeit_offset;

  INSERT INTO app_private.ie_transition_authorization (
    income_expense_id, xid, purpose
  ) VALUES (
    v_forfeit_offset, pg_current_xact_id(), 'UNAPPROVED'
  );

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date,
    accounting_class
  ) VALUES (
    v_forfeit_offset, v_org, v_deposit_type, 'Forfeit deposit offset',
    1, 12345, 12345, '2097-12-02', '2097-12-02', 'DEPOSIT'
  );
  DELETE FROM app_private.ie_transition_authorization
  WHERE income_expense_id = v_forfeit_offset
    AND xid = pg_current_xact_id();

  INSERT INTO public.income_expenses (
    user_id, organization_id, type, name, building_id, room_id, contract_id,
    account_id, invoice_id, voucher_date, total_amount, approval_status,
    notes, system_source
  ) VALUES (
    v_legacy_owner, v_org, 'INCOME', 'Forfeit revenue fixture',
    v_legacy_building, v_legacy_room, v_legacy_contract, v_virtual_account,
    v_forfeit_invoice, '2097-12-02', 12345, 'UNAPPROVED',
    '[Accounting rollback] forfeit pair', 'termination.forfeit_revenue'
  ) RETURNING id INTO v_forfeit_revenue;

  INSERT INTO app_private.ie_transition_authorization (
    income_expense_id, xid, purpose
  ) VALUES (
    v_forfeit_revenue, pg_current_xact_id(), 'UNAPPROVED'
  );

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date,
    accounting_class
  ) VALUES (
    v_forfeit_revenue, v_org, v_legacy_type, 'Forfeit revenue',
    1, 12345, 12345, '2097-12-02', '2097-12-02', 'PNL'
  );
  DELETE FROM app_private.ie_transition_authorization
  WHERE income_expense_id = v_forfeit_revenue
    AND xid = pg_current_xact_id();
  PERFORM public.recompute_ie_business_result(v_forfeit_offset);
  PERFORM public.recompute_ie_business_result(v_forfeit_revenue);

  PERFORM public.recompute_ie_business_result(v_legacy_source);
  PERFORM public.recompute_invoice_for_id(v_legacy_invoice);
  PERFORM app_private.end_accounting_chain_write_v1();

  BEGIN
    INSERT INTO public.payments (
      organization_id, user_id, invoice_id, amount, payment_method,
      payment_date, notes
    ) VALUES (
      v_org, v_actor, v_moveout_invoice, 1, 'CT', '2097-12-01',
      'Quyết toán khi thanh lý 01/12/2097'
    );
    RAISE EXCEPTION 'Untrusted termination payment unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.income_expenses (
      user_id, organization_id, type, name, building_id, room_id, contract_id,
      account_id, invoice_id, voucher_date, total_amount, approval_status,
      system_source
    ) VALUES (
      v_actor, v_org, 'INCOME', 'Forged forfeit revenue probe',
      v_legacy_building, v_legacy_room, v_legacy_contract,
      v_virtual_account, v_legacy_invoice, '2097-12-01', 1, 'UNAPPROVED',
      'termination.forfeit_revenue'
    );
    RAISE EXCEPTION 'Authenticated-style insert forged a forfeit voucher';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    UPDATE public.income_expenses
       SET notes = COALESCE(notes, '') || ' forged'
     WHERE id = (
       SELECT auth_row.revenue_voucher_id
       FROM app_private.termination_forfeit_authorizations auth_row
       WHERE auth_row.organization_id = v_org
       ORDER BY auth_row.revenue_voucher_id
       LIMIT 1
     );
    IF FOUND THEN
      RAISE EXCEPTION 'Protected forfeit voucher accepted direct metadata drift';
    END IF;
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  PERFORM set_config('accounting_test.actor', v_actor::text, true);
  PERFORM set_config('accounting_test.org', v_org::text, true);
  PERFORM set_config('accounting_test.building', v_building::text, true);
  PERFORM set_config('accounting_test.room', v_room::text, true);
  PERFORM set_config('accounting_test.customer', v_customer::text, true);
  PERFORM set_config('accounting_test.account_tm', v_account_tm::text, true);
  PERFORM set_config('accounting_test.account_tk', v_account_tk::text, true);
  PERFORM set_config(
    'accounting_test.account_payout', v_account_payout::text, true
  );
  PERFORM set_config(
    'accounting_test.cross_org_account', v_cross_org_account::text, true
  );
  PERFORM set_config(
    'accounting_test.shareholder', v_shareholder::text, true
  );
  PERFORM set_config(
    'accounting_test.virtual_account', v_virtual_account::text, true
  );
  PERFORM set_config(
    'accounting_test.legacy_invoice', v_legacy_invoice::text, true
  );
  PERFORM set_config(
    'accounting_test.legacy_contract', v_legacy_contract::text, true
  );
  PERFORM set_config(
    'accounting_test.legacy_payment', v_legacy_payment::text, true
  );
  PERFORM set_config(
    'accounting_test.legacy_source', v_legacy_source::text, true
  );
  PERFORM set_config(
    'accounting_test.orphan_deposit', v_orphan_deposit::text, true
  );
  PERFORM set_config(
    'accounting_test.forfeit_invoice', v_forfeit_invoice::text, true
  );
  PERFORM set_config(
    'accounting_test.forfeit_revenue', v_forfeit_revenue::text, true
  );
  PERFORM set_config(
    'accounting_test.forfeit_offset', v_forfeit_offset::text, true
  );
END;
$fixture$;

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', current_setting('accounting_test.actor'),
    'role', 'authenticated',
    'email', 'accounting-rollback@example.test',
    'user_metadata', jsonb_build_object('full_name', 'Accounting Rollback Test')
  )::text,
  true
);

DO $test$
DECLARE
  v_actor uuid := current_setting('accounting_test.actor')::uuid;
  v_org uuid := current_setting('accounting_test.org')::uuid;
  v_building uuid := current_setting('accounting_test.building')::uuid;
  v_room uuid := current_setting('accounting_test.room')::uuid;
  v_customer uuid := current_setting('accounting_test.customer')::uuid;
  v_account_tm uuid := current_setting('accounting_test.account_tm')::uuid;
  v_account_tk uuid := current_setting('accounting_test.account_tk')::uuid;
  v_account_payout uuid := current_setting('accounting_test.account_payout')::uuid;
  v_virtual_account uuid := current_setting('accounting_test.virtual_account')::uuid;
  v_legacy_invoice uuid := current_setting('accounting_test.legacy_invoice')::uuid;
  v_legacy_contract uuid := current_setting('accounting_test.legacy_contract')::uuid;
  v_legacy_payment uuid := current_setting('accounting_test.legacy_payment')::uuid;
  v_legacy_source uuid := current_setting('accounting_test.legacy_source')::uuid;
  v_orphan_deposit uuid := current_setting('accounting_test.orphan_deposit')::uuid;
  v_forfeit_invoice uuid := current_setting('accounting_test.forfeit_invoice')::uuid;
  v_forfeit_revenue uuid := current_setting('accounting_test.forfeit_revenue')::uuid;
  v_forfeit_offset uuid := current_setting('accounting_test.forfeit_offset')::uuid;
  v_forfeit_payment uuid;
  v_cross_org_account uuid := current_setting(
    'accounting_test.cross_org_account'
  )::uuid;
  v_legacy_reversal uuid;
  v_legacy_reversal_date date;
  v_shareholder uuid := current_setting('accounting_test.shareholder')::uuid;
  v_contract_response jsonb;
  v_contract_payload jsonb;
  v_collection_one jsonb;
  v_collection_two jsonb;
  v_credit_invoice jsonb;
  v_cancel_result jsonb;
  v_profit_preview jsonb;
  v_profit_close jsonb;
  v_profit_payout json;
  v_profit_building jsonb;
  v_manager_report jsonb;
  v_reverse_result jsonb;
  v_contract uuid;
  v_invoice uuid;
  v_credit_invoice_id uuid;
  v_collection_one_id uuid;
  v_collection_two_id uuid;
  v_probe_payment uuid;
  v_credit_lot uuid;
  v_adjustments jsonb;
  v_amount numeric;
  v_pnl numeric;
  v_deposit numeric;
  v_credit numeric;
  v_payout_amount numeric;
  v_count integer;
  v_status text;
BEGIN
  IF has_function_privilege(
    'authenticated',
    'public.apply_customer_credit_v1(uuid,numeric,uuid,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Generic customer credit apply RPC is exposed';
  END IF;
  IF has_function_privilege(
    'authenticated',
    'public.reverse_customer_credit_application_v1(uuid,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Generic customer credit reversal RPC is exposed';
  END IF;
  IF has_table_privilege('authenticated', 'public.excess_amounts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.excess_amounts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.excess_amounts', 'DELETE') THEN
    RAISE EXCEPTION 'Authenticated can mutate the customer credit ledger directly';
  END IF;

  BEGIN
    UPDATE public.income_expenses
       SET approval_status = 'APPROVED',
           approved_by = v_actor,
           approved_at = now()
     WHERE id = v_forfeit_revenue;
    RAISE EXCEPTION 'Direct forfeit approval bypassed the protected RPC';
  EXCEPTION
    WHEN SQLSTATE '42501' OR SQLSTATE '55000' THEN
    IF position('authorized transition RPC' IN SQLERRM) = 0
       AND position('writer' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'Direct forfeit PATCH failed at the wrong guard: %', SQLERRM;
    END IF;
  END;

  SELECT count(*) INTO v_count
  FROM public.income_expenses voucher
  WHERE voucher.id IN (v_forfeit_revenue, v_forfeit_offset)
    AND voucher.approval_status = 'UNAPPROVED';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Rejected direct forfeit PATCH changed pair status';
  END IF;

  PERFORM public.set_termination_forfeit_status_v1(
    v_forfeit_revenue, 'APPROVED'
  );
  SELECT count(*) INTO v_count
  FROM public.income_expenses voucher
  WHERE voucher.id IN (v_forfeit_revenue, v_forfeit_offset)
    AND voucher.approval_status = 'APPROVED'
    AND voucher.approved_by = v_actor
    AND voucher.approved_at IS NOT NULL;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Dedicated forfeit status RPC did not approve both legs';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.payments payment
  WHERE payment.invoice_id = v_forfeit_invoice
    AND payment.amount = 12345
    AND payment.received_amount = 0
    AND payment.payment_method = 'CT'
    AND payment.reversed_at IS NULL;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Authorized forfeit approval expected one non-cash payment';
  END IF;
  SELECT payment.id INTO v_forfeit_payment
  FROM public.payments payment
  WHERE payment.invoice_id = v_forfeit_invoice
    AND payment.amount = 12345
    AND payment.received_amount = 0
    AND payment.payment_method = 'CT'
    AND payment.reversed_at IS NULL
  LIMIT 1;
  IF v_forfeit_payment IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.payments payment
    WHERE payment.id = v_forfeit_payment
      AND payment.invoice_id = v_forfeit_invoice
      AND payment.amount = 12345
      AND payment.received_amount = 0
      AND payment.payment_method = 'CT'
      AND payment.reversed_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Authorized forfeit approval did not create exact non-cash payment';
  END IF;

  BEGIN
    UPDATE public.payments SET amount = amount + 1 WHERE id = v_forfeit_payment;
    RAISE EXCEPTION 'Forfeit payment accepted a direct amount mutation';
  EXCEPTION
    WHEN SQLSTATE '42501' OR SQLSTATE '55000' THEN NULL;
  END;

  PERFORM public.set_termination_forfeit_status_v1(
    v_forfeit_offset, 'CANCELLED'
  );
  IF EXISTS (
    SELECT 1 FROM public.income_expenses voucher
    WHERE voucher.id IN (v_forfeit_revenue, v_forfeit_offset)
      AND voucher.approval_status <> 'CANCELLED'
  ) OR EXISTS (
    SELECT 1 FROM public.payments payment WHERE payment.id = v_forfeit_payment
  ) THEN
    RAISE EXCEPTION 'Forfeit cancellation did not clear payment and cascade pair';
  END IF;

  BEGIN
    PERFORM public.terminate_contract_move_out(
      p_contract_id => v_legacy_contract,
      p_move_out_date => '2097-12-03',
      p_penalty_fee => 1,
      p_shortfall_mode => 'PAID',
      p_receipt_account_id => v_cross_org_account
    );
    RAISE EXCEPTION 'Termination accepted a cross-organization receipt account';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    IF position('outside the contract organization' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION
        'Cross-org receipt probe failed before the account guard: %', SQLERRM;
    END IF;
  END;

  v_contract_payload := jsonb_build_object(
      'contract', jsonb_build_object(
        'room_id', v_room,
        'signed_date', '2099-01-01',
        'start_date', '2099-01-01',
        'end_date', '2099-12-31',
        'rent_price', 3000000,
        'total_deposit', 3000000,
        'payment_cycle', 'MONTHLY',
        'start_billing_date', '2099-01-01',
        'end_billing_date', '2099-01-31',
        'deposit_debt_mode', 'FIRST_INVOICE'
      ),
      'customers', jsonb_build_array(jsonb_build_object(
        'customer_id', v_customer,
        'is_representative', true
      )),
      'services', '[]'::jsonb,
      'deposit_receipts', '[]'::jsonb,
      'existing_deposit_voucher_ids', jsonb_build_array(v_orphan_deposit),
      'first_invoice', jsonb_build_object(
        'items', jsonb_build_array(
          jsonb_build_object(
            'type', 'RENT',
            'accounting_class', 'REVENUE',
            'description', 'Rollback test rent',
            'unit_price', 3000000,
            'quantity', 1,
            'from_date', '2099-01-01',
            'to_date', '2099-01-31'
          ),
          jsonb_build_object(
            'type', 'OTHER',
            'accounting_class', 'DEPOSIT',
            'description', 'Rollback test deposit',
            'unit_price', 2000000,
            'quantity', 1
          )
        ),
        'discount_amount', 0,
        'issue_date', '2099-01-01',
        'due_date', '2099-01-05',
        'notes', 'Accounting chain rollback test'
      )
    );

  BEGIN
    PERFORM public.create_contract_v2(
      jsonb_set(
        v_contract_payload,
        '{first_invoice,due_date}',
        to_jsonb('2099-02-01'::text)
      ),
      'acct-contract-invalid-due-0001'
    );
    RAISE EXCEPTION 'Contract V2 accepted a due date outside the billing period';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.create_contract_v2(
      jsonb_set(
        v_contract_payload,
        '{first_invoice,issue_date}',
        to_jsonb('2098-12-31'::text)
      ),
      'acct-contract-invalid-issue-0001'
    );
    RAISE EXCEPTION 'Contract V2 accepted an issue date before signing';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.create_contract_v2(
      jsonb_set(
        v_contract_payload,
        '{first_invoice,items,0,to_date}',
        to_jsonb('2099-02-01'::text)
      ),
      'acct-contract-invalid-item-0001'
    );
    RAISE EXCEPTION 'Contract V2 accepted revenue outside the billing period';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  v_contract_response := public.create_contract_v2(
    v_contract_payload,
    'acct-contract-create-0001'
  );

  v_contract := NULLIF(v_contract_response #>> '{contract,id}', '')::uuid;
  v_invoice := NULLIF(v_contract_response #>> '{invoice,id}', '')::uuid;
  IF v_contract IS NULL OR v_invoice IS NULL THEN
    RAISE EXCEPTION 'Contract V2 did not atomically return contract and invoice';
  END IF;
  IF (v_contract_response->>'deposit_shortfall')::numeric <> 2000000 THEN
    RAISE EXCEPTION 'First invoice deposit shortfall is incorrect';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.contract_deposit_links link_row
    JOIN public.income_expenses voucher
      ON voucher.id = link_row.income_expense_id
    WHERE link_row.contract_id = v_contract
      AND link_row.income_expense_id = v_orphan_deposit
      AND voucher.contract_id = v_contract
  ) THEN
    RAISE EXCEPTION 'Explicit orphan deposit did not enter the contract lifecycle';
  END IF;
  SELECT contract_row.deposit_paid INTO v_deposit
  FROM public.contracts contract_row
  WHERE contract_row.id = v_contract;
  IF v_deposit <> 1000000 THEN
    RAISE EXCEPTION 'Linked orphan deposit expected 1000000, got %', v_deposit;
  END IF;

  v_contract_response := public.create_contract_v2(
    v_contract_payload,
    'acct-contract-create-0001'
  );
  IF NULLIF(v_contract_response #>> '{contract,id}', '')::uuid <> v_contract THEN
    RAISE EXCEPTION 'Contract idempotency replay returned a different contract';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.contract_deposit_links link_row
  WHERE link_row.contract_id = v_contract
    AND link_row.income_expense_id = v_orphan_deposit;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Contract idempotency replay duplicated the deposit link';
  END IF;

  SELECT invoice_row.total_amount INTO v_amount
  FROM public.invoices invoice_row
  WHERE invoice_row.id = v_invoice;
  IF v_amount <> 5000000 THEN
    RAISE EXCEPTION 'First invoice total expected 5000000, got %', v_amount;
  END IF;
  SELECT COALESCE(sum(item.amount), 0) INTO v_deposit
  FROM public.invoice_items item
  WHERE item.invoice_id = v_invoice
    AND item.accounting_class = 'DEPOSIT';
  IF v_deposit <> 2000000 THEN
    RAISE EXCEPTION 'First invoice deposit item expected 2000000, got %', v_deposit;
  END IF;

  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      'role', 'authenticated'
    )::text,
    true
  );
  BEGIN
    PERFORM public.record_invoice_collection_v5(
      v_invoice, '2099-01-10',
      jsonb_build_array(jsonb_build_object(
        'payment_method', 'TM', 'gross_amount', 1000000,
        'account_id', v_account_tm
      )),
      'REJECT', false, 'Unauthorized probe', NULL, 0,
      'acct-auth-denial-0001'
    );
    RAISE EXCEPTION 'Unauthorized collection unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub', v_actor,
      'role', 'authenticated',
      'email', 'accounting-rollback@example.test',
      'user_metadata', jsonb_build_object('full_name', 'Accounting Rollback Test')
    )::text,
    true
  );

  BEGIN
    PERFORM public.record_invoice_collection_v5(
      v_invoice, '2099-01-10',
      jsonb_build_array(jsonb_build_object(
        'payment_method', 'TM',
        'gross_amount', 4995000,
        'account_id', v_account_tm,
        'rounding_account_id', v_virtual_account
      )),
      'REJECT', true, 'Deposit rounding rejection probe', NULL, 0,
      'acct-rounding-reject-0001'
    );
    RAISE EXCEPTION 'Rounding incorrectly waived an unpaid deposit residual';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  v_collection_one := public.record_invoice_collection_v5(
    v_invoice, '2099-01-10',
    jsonb_build_array(jsonb_build_object(
      'payment_method', 'TM',
      'gross_amount', 1000000,
      'account_id', v_account_tm,
      'receipt_number', 'ROLLBACK-C1'
    )),
    'REJECT', false, 'First partial collection', NULL, 0,
    'acct-collection-one-0001'
  );
  v_collection_one_id := (v_collection_one->>'collection_id')::uuid;
  PERFORM set_config(
    'accounting_test.collection_one', v_collection_one_id::text, true
  );

  v_collection_one := public.record_invoice_collection_v5(
    v_invoice, '2099-01-10',
    jsonb_build_array(jsonb_build_object(
      'payment_method', 'TM',
      'gross_amount', 1000000,
      'account_id', v_account_tm,
      'receipt_number', 'ROLLBACK-C1'
    )),
    'REJECT', false, 'First partial collection', NULL, 0,
    'acct-collection-one-0001'
  );
  IF (v_collection_one->>'collection_id')::uuid <> v_collection_one_id THEN
    RAISE EXCEPTION 'Collection idempotency replay returned a different collection';
  END IF;

  v_collection_two := public.record_invoice_collection_v5(
    v_invoice, '2099-01-11',
    jsonb_build_array(
      jsonb_build_object(
        'payment_method', 'TK',
        'gross_amount', 4000000,
        'account_id', v_account_tk,
        'receipt_number', 'ROLLBACK-C2-TK'
      ),
      jsonb_build_object(
        'payment_method', 'TM',
        'gross_amount', 300000,
        'account_id', v_account_tm,
        'receipt_number', 'ROLLBACK-C2-TM-CREDIT'
      )
    ),
    'CREDIT', false, 'Multi-tender collection with credit', NULL, 1000000,
    'acct-collection-two-0001'
  );
  v_collection_two_id := (v_collection_two->>'collection_id')::uuid;
  v_credit_lot := (v_collection_two->>'credit_lot_id')::uuid;

  BEGIN
    PERFORM public.reverse_invoice_collection_v5(
      v_collection_two_id, '2099-01-10',
      'Reject a reversal dated before the collection',
      'acct-reverse-date-guard-0001'
    );
    RAISE EXCEPTION 'Collection reversal accepted a date before collection';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;

  SELECT
    COALESCE(sum(allocation.amount) FILTER (
      WHERE allocation.accounting_class = 'PNL'
    ), 0),
    COALESCE(sum(allocation.amount) FILTER (
      WHERE allocation.accounting_class = 'DEPOSIT'
    ), 0),
    COALESCE(sum(allocation.amount) FILTER (
      WHERE allocation.accounting_class = 'CUSTOMER_CREDIT'
    ), 0)
    INTO v_pnl, v_deposit, v_credit
  FROM public.invoice_payment_allocations allocation
  WHERE allocation.collection_id IN (v_collection_one_id, v_collection_two_id);

  IF v_pnl <> 3000000 OR v_deposit <> 2000000 OR v_credit <> 300000 THEN
    RAISE EXCEPTION
      'Collection semantic split mismatch: pnl %, deposit %, credit %',
      v_pnl, v_deposit, v_credit;
  END IF;

  SELECT COALESCE(sum(voucher.kqkd_amount), 0) INTO v_amount
  FROM public.income_expenses voucher
  WHERE voucher.payment_collection_id IN (v_collection_one_id, v_collection_two_id)
    AND voucher.type = 'INCOME'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL;
  IF v_amount <> 3000000 THEN
    RAISE EXCEPTION 'P&L included deposit/credit: expected 3000000, got %', v_amount;
  END IF;

  SELECT count(*) INTO v_count
  FROM public.invoice_payment_tenders tender
  WHERE tender.collection_id = v_collection_two_id;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Multi-tender collection expected 2 tenders, got %', v_count;
  END IF;

  SELECT
    COALESCE(sum(receipt.collected_amount), 0),
    COALESCE(sum(receipt.applied_amount), 0),
    COALESCE(sum(receipt.credit_amount), 0),
    count(*)
    INTO v_amount, v_pnl, v_credit, v_count
  FROM public.active_payment_receipts receipt
  WHERE receipt.invoice_id = v_invoice;
  IF v_amount <> 5300000 OR v_pnl <> 5000000
     OR v_credit <> 300000 OR v_count <> 3 THEN
    RAISE EXCEPTION
      'Receipt projection mismatch: collected %, applied %, credit %, rows %',
      v_amount, v_pnl, v_credit, v_count;
  END IF;
  SELECT COALESCE(sum(receipt.collected_amount), 0) INTO v_amount
  FROM public.active_payment_receipts receipt
  WHERE receipt.invoice_id = v_invoice
    AND receipt.payment_method = 'TM';
  IF v_amount <> 1300000 THEN
    RAISE EXCEPTION 'Pure-credit TM tender missing from retained receipts';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.active_payments payment
  WHERE payment.invoice_id = v_invoice;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Pure-credit tender incorrectly created a payment row';
  END IF;
  SELECT COALESCE(sum(entry.pnl_amount), 0) INTO v_amount
  FROM public.invoice_pnl_cash_entries entry
  WHERE entry.invoice_id = v_invoice;
  IF v_amount <> 3000000 THEN
    RAISE EXCEPTION 'Dashboard P&L cash projection expected 3000000, got %', v_amount;
  END IF;

  v_manager_report := public.manager_collection_cycle_report(
    v_actor, '2099-01-01', '2099-01-31'
  );
  IF COALESCE((
    v_manager_report #>> '{summary,collected_period}'
  )::numeric, 0) <> 5300000 THEN
    RAISE EXCEPTION 'Manager collection report missed retained/pure-credit cash';
  END IF;

  v_credit_invoice := public.create_invoice_with_credit_v1(
    v_contract, v_building, v_room, '2099-02',
    '2099-02-01', '2099-02-05', 'MONTHLY',
    500000, 200000, 300000, 0,
    jsonb_build_array(jsonb_build_object(
      'type', 'RENT',
      'description', 'Rollback credit invoice',
      'unit_price', 500000,
      'quantity', 1,
      'coefficient', 1,
      'amount', 500000,
      'from_date', '2099-02-01',
      'to_date', '2099-02-28',
      'sort_order', 0
    )),
    'acct-credit-invoice-0001',
    0, 'Customer credit discount', false, '[]'::jsonb,
    NULL, 'Rollback credit lifecycle', 200000, 0,
    'Accounting Rollback Test'
  );
  v_credit_invoice_id := (v_credit_invoice->>'invoice_id')::uuid;

  SELECT public.get_customer_credit_balance_v1(v_contract) INTO v_amount;
  IF v_amount <> 100000 THEN
    RAISE EXCEPTION 'Credit balance after FIFO apply expected 100000, got %', v_amount;
  END IF;

  BEGIN
    PERFORM public.reverse_invoice_collection_v5(
      v_collection_two_id, '2099-01-20',
      'Must reject while customer credit is consumed',
      'acct-reverse-used-credit-0001'
    );
    RAISE EXCEPTION 'Collection reversal ignored consumed customer credit';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  v_cancel_result := public.cancel_invoice_with_credit_v1(
    v_credit_invoice_id, 'acct-cancel-credit-invoice-0001'
  );
  IF v_cancel_result #>> '{invoice,status}' <> 'CANCELLED' THEN
    RAISE EXCEPTION 'Credit invoice cancellation did not complete';
  END IF;
  SELECT public.get_customer_credit_balance_v1(v_contract) INTO v_amount;
  IF v_amount <> 300000 THEN
    RAISE EXCEPTION 'Credit unwind expected balance 300000, got %', v_amount;
  END IF;

  BEGIN
    PERFORM public.reverse_invoice_collection_v5(
      v_collection_one_id, '2099-01-20',
      'Must reject older collection before newer collection',
      'acct-reverse-out-of-order-0001'
    );
    RAISE EXCEPTION 'Collection reversal ignored LIFO order';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  v_profit_preview := public.profit_close_preview_v2(
    v_org, '2099-01-01', NULL, '[]'::jsonb
  );

  SELECT jsonb_agg(jsonb_build_object(
    'building_id', row_value->>'building_id',
    'adjustment_amount', 0,
    'adjustment_reason', NULL,
    'unallocated_disposition', CASE
      WHEN (row_value->>'building_id')::uuid = v_building
        THEN 'RETAINED_EARNINGS'
      ELSE NULL
    END,
    'unallocated_disposition_reason', CASE
      WHEN (row_value->>'building_id')::uuid = v_building
        THEN 'Retain residual in rollback integration test'
      ELSE NULL
    END
  ) ORDER BY row_value->>'building_id')
    INTO v_adjustments
  FROM jsonb_array_elements(v_profit_preview->'buildings') row_data(row_value);

  v_profit_preview := public.profit_close_preview_v2(
    v_org, '2099-01-01', NULL, v_adjustments
  );
  SELECT row_value INTO v_profit_building
  FROM jsonb_array_elements(v_profit_preview->'buildings') row_data(row_value)
  WHERE (row_value->>'building_id')::uuid = v_building;

  IF abs(COALESCE((
    v_profit_building->>'source_revenue'
  )::numeric, 0) - 3000000) >= 0.01 THEN
    RAISE EXCEPTION 'Profit preview revenue did not exclude deposit and credit';
  END IF;
  IF abs(COALESCE((
    v_profit_building->>'shareholder_percent_total'
  )::numeric, 0) - 60) >= 0.01 THEN
    RAISE EXCEPTION 'Profit preview shareholder percent expected 60';
  END IF;
  IF abs(COALESCE((
    v_profit_building->>'unallocated_profit'
  )::numeric, 0) - 1200000) >= 0.01 THEN
    RAISE EXCEPTION 'Profit preview residual expected 1200000';
  END IF;

  v_profit_close := public.profit_close_v2(
    v_org, '2099-01-01', v_profit_preview->>'source_hash',
    'Rollback accounting integration close',
    'acct-profit-close-0001', NULL, v_adjustments
  );
  SELECT pm.status, pm.unallocated_profit
    INTO v_status, v_amount
  FROM public.profit_monthly pm
  WHERE pm.organization_id = v_org
    AND pm.building_id = v_building
    AND pm.period_month = '2099-01-01';
  IF v_status <> 'LOCKED' OR abs(v_amount - 1200000) >= 0.01 THEN
    RAISE EXCEPTION 'Profit close did not persist the explicit residual';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.profit_monthly pm
    WHERE pm.organization_id = v_org
      AND pm.building_id = v_building
      AND pm.period_month = '2099-01-01'
      AND pm.unallocated_disposition = 'RETAINED_EARNINGS'
      AND char_length(pm.unallocated_disposition_reason) >= 8
  ) THEN
    RAISE EXCEPTION 'Profit residual disposition was not persisted';
  END IF;

  SELECT COALESCE(sum(allocation.amount), 0)
    INTO v_payout_amount
  FROM public.profit_allocations allocation
  JOIN public.profit_monthly monthly
    ON monthly.id = allocation.profit_monthly_id
  WHERE allocation.organization_id = v_org
    AND allocation.shareholder_id = v_shareholder
    AND monthly.building_id = v_building
    AND monthly.period_month = '2099-01-01'
    AND monthly.status = 'LOCKED'
    AND NOT monthly.is_stale;
  v_payout_amount := LEAST(v_payout_amount, 100000);
  IF v_payout_amount < 0.01 THEN
    RAISE EXCEPTION 'Rollback fixture has no shareholder allocation to reserve';
  END IF;

  BEGIN
    PERFORM public.distribute_shareholder_profit_v1(
      v_shareholder,
      v_payout_amount,
      v_virtual_account,
      '2099-01-31',
      'Reject a virtual cashbook for shareholder payout',
      'acct-profit-payout-virtual-0001'
    );
    RAISE EXCEPTION 'Virtual shareholder payout account unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
  SELECT count(*) INTO v_count
  FROM public.income_expenses voucher
  WHERE voucher.idempotency_key = 'acct-profit-payout-virtual-0001';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Rejected virtual payout left a voucher behind';
  END IF;

  v_profit_payout := public.distribute_shareholder_profit_v1(
    v_shareholder,
    v_payout_amount,
    v_account_payout,
    '2099-01-31',
    'Rollback shareholder payout reservation',
    'acct-profit-payout-0001'
  );
  IF v_profit_payout->>'state' <> 'PENDING_APPROVAL' THEN
    RAISE EXCEPTION 'Shareholder payout did not create a pending reservation';
  END IF;
  SELECT COALESCE(sum(reservation.amount), 0) INTO v_amount
  FROM public.profit_payout_reservations reservation
  WHERE reservation.payout_voucher_id =
    (v_profit_payout->>'profit_voucher_id')::uuid;
  IF abs(v_amount - v_payout_amount) >= 0.01 THEN
    RAISE EXCEPTION 'Payout reservation mismatch: expected %, got %',
      v_payout_amount, v_amount;
  END IF;
  PERFORM set_config(
    'accounting_test.payout_amount', v_payout_amount::text, true
  );
  PERFORM set_config(
    'accounting_test.payout_voucher',
    (v_profit_payout->>'profit_voucher_id')::text,
    true
  );

  v_reverse_result := public.reverse_invoice_collection_v5(
    v_collection_two_id, '2099-02-02',
    'Reverse newer collection after credit unwind',
    'acct-reverse-collection-two-0001'
  );
  v_reverse_result := public.reverse_invoice_collection_v5(
    v_collection_one_id, '2099-02-03',
    'Reverse older collection after newer collection',
    'acct-reverse-collection-one-0001'
  );

  v_reverse_result := public.reverse_invoice_payment_v3(
    v_legacy_payment,
    'Reverse a classified legacy receipt in the rollback test',
    'acct-reverse-legacy-payment-0001'
  )::jsonb;
  v_legacy_reversal := (v_reverse_result->>'reversal_voucher_id')::uuid;
  PERFORM set_config(
    'accounting_test.legacy_reversal', v_legacy_reversal::text, true
  );

  SELECT voucher.voucher_date INTO v_legacy_reversal_date
  FROM public.income_expenses voucher
  WHERE voucher.id = v_legacy_reversal
    AND voucher.account_id = v_account_tm
    AND voucher.reversal_of_income_expense_id = v_legacy_source
    AND voucher.type = 'EXPENSE'
    AND voucher.approval_status = 'APPROVED'
    AND voucher.deleted_at IS NULL;
  IF v_legacy_reversal_date IS DISTINCT FROM public.vn_local_date(clock_timestamp()) THEN
    RAISE EXCEPTION 'Legacy reversal did not use the stable VN-local date';
  END IF;

  SELECT COALESCE(sum(item.amount), 0) INTO v_amount
  FROM public.income_expense_items item
  WHERE item.income_expense_id = v_legacy_reversal
    AND item.accounting_class = 'PNL';
  IF v_amount <> 100000 THEN
    RAISE EXCEPTION 'Legacy reversal P&L mirror expected 100000, got %', v_amount;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.payments payment
    WHERE payment.id = v_legacy_payment
      AND payment.reversed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Legacy reversal did not stamp payment.reversed_at';
  END IF;

  SELECT invoice.paid_amount INTO v_amount
  FROM public.invoices invoice WHERE invoice.id = v_legacy_invoice;
  IF v_amount <> 0 THEN
    RAISE EXCEPTION 'Legacy reversal invoice expected paid_amount 0, got %', v_amount;
  END IF;

  SELECT COALESCE(sum(entry.pnl_amount), 0) INTO v_amount
  FROM public.invoice_pnl_cash_entries entry
  WHERE entry.invoice_id = v_legacy_invoice;
  IF v_amount <> 0 THEN
    RAISE EXCEPTION 'Legacy reversal did not net P&L to zero';
  END IF;

  v_reverse_result := public.reverse_invoice_payment_v3(
    v_legacy_payment,
    'Reverse a classified legacy receipt in the rollback test',
    'acct-reverse-legacy-payment-0001'
  )::jsonb;
  IF (v_reverse_result->>'reversal_voucher_id')::uuid <> v_legacy_reversal THEN
    RAISE EXCEPTION 'Legacy reversal replay changed reversal voucher';
  END IF;
  IF (SELECT voucher_date FROM public.income_expenses WHERE id = v_legacy_reversal)
     IS DISTINCT FROM v_legacy_reversal_date THEN
    RAISE EXCEPTION 'Legacy reversal replay changed the committed date';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.invoice_payment_collections collection_row
  WHERE collection_row.id IN (v_collection_one_id, v_collection_two_id)
    AND collection_row.status = 'REVERSED';
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Expected both collections to be reversed';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.active_payments payment
  WHERE payment.invoice_id = v_invoice;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Reversed payments remain visible in active_payments';
  END IF;
  SELECT invoice_row.paid_amount INTO v_amount
  FROM public.invoices invoice_row
  WHERE invoice_row.id = v_invoice;
  IF v_amount <> 0 THEN
    RAISE EXCEPTION 'Invoice paid_amount expected 0 after full reversal, got %', v_amount;
  END IF;
  SELECT COALESCE(sum(entry.pnl_amount), 0) INTO v_amount
  FROM public.invoice_pnl_cash_entries entry
  WHERE entry.invoice_id = v_invoice;
  IF v_amount <> 0 THEN
    RAISE EXCEPTION 'Reversal did not net dashboard P&L cash entries to zero';
  END IF;

  SELECT
    COALESCE(sum(event.collected_amount), 0),
    COALESCE(sum(event.applied_amount), 0)
    INTO v_amount, v_pnl
  FROM public.payment_receipt_events event
  WHERE event.invoice_id = v_invoice
    AND event.payment_date BETWEEN '2099-01-01' AND '2099-01-31';
  IF v_amount <> 5300000 OR v_pnl <> 5000000 THEN
    RAISE EXCEPTION
      'January receipt history changed after February reversal: collected %, applied %',
      v_amount, v_pnl;
  END IF;

  SELECT
    COALESCE(sum(event.collected_amount), 0),
    COALESCE(sum(event.applied_amount), 0)
    INTO v_amount, v_pnl
  FROM public.payment_receipt_events event
  WHERE event.invoice_id = v_invoice
    AND event.payment_date BETWEEN '2099-02-01' AND '2099-02-28';
  IF v_amount <> -5300000 OR v_pnl <> -5000000 THEN
    RAISE EXCEPTION
      'February receipt reversal history mismatch: collected %, applied %',
      v_amount, v_pnl;
  END IF;

  SELECT COALESCE(sum(entry.pnl_amount), 0) INTO v_amount
  FROM public.invoice_pnl_cash_entries entry
  WHERE entry.invoice_id = v_invoice
    AND entry.revenue_date BETWEEN '2099-01-01' AND '2099-01-31';
  IF v_amount <> 3000000 THEN
    RAISE EXCEPTION 'January P&L history changed after February reversal';
  END IF;
  SELECT COALESCE(sum(entry.pnl_amount), 0) INTO v_amount
  FROM public.invoice_pnl_cash_entries entry
  WHERE entry.invoice_id = v_invoice
    AND entry.revenue_date BETWEEN '2099-02-01' AND '2099-02-28';
  IF v_amount <> -3000000 THEN
    RAISE EXCEPTION 'February P&L reversal expected -3000000, got %', v_amount;
  END IF;

  v_manager_report := public.manager_collection_cycle_report(
    v_actor, '2099-01-01', '2099-01-31'
  );
  IF COALESCE((
    v_manager_report #>> '{summary,collected_period}'
  )::numeric, 0) <> 5300000 THEN
    RAISE EXCEPTION 'January manager report was erased by February reversal';
  END IF;
  v_manager_report := public.manager_collection_cycle_report(
    v_actor, '2099-02-01', '2099-02-28'
  );
  IF COALESCE((
    v_manager_report #>> '{summary,collected_period}'
  )::numeric, 0) <> -5300000 THEN
    RAISE EXCEPTION 'February manager report missed signed reversal';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.customer_credit_lots lot
    WHERE lot.id = v_credit_lot
      AND lot.status = 'REVERSED'
      AND lot.remaining_amount = 0
  ) THEN
    RAISE EXCEPTION 'Collection credit lot was not reversed';
  END IF;

  PERFORM set_config(
    'accounting_test.verdict',
    jsonb_build_object(
      'contract_id', v_contract,
      'invoice_id', v_invoice,
      'invoice_total', 5000000,
      'pnl_revenue', 3000000,
      'deposit_liability', 2000000,
      'customer_credit', 300000,
      'profit_unallocated', 1200000,
      'collections_reversed', 2,
      'status', 'PASS'
    )::text,
    true
  );
END;
$test$;

RESET ROLE;

DO $payout_stale_approval$
DECLARE
  v_payout_voucher uuid := current_setting(
    'accounting_test.payout_voucher'
  )::uuid;
  v_profit_monthly uuid;
  v_shareholder_link uuid;
  v_original_percent numeric;
  v_request uuid;
  v_request_version bigint;
  v_posting uuid;
  v_request_state text;
  v_status text;
BEGIN
  SELECT monthly.id, link.id, link.percent
    INTO v_profit_monthly, v_shareholder_link, v_original_percent
  FROM public.profit_payout_reservations reservation
  JOIN public.profit_allocations allocation
    ON allocation.id = reservation.profit_allocation_id
  JOIN public.profit_monthly monthly
    ON monthly.id = allocation.profit_monthly_id
  JOIN public.building_shareholders link
    ON link.building_id = monthly.building_id
   AND link.shareholder_id = reservation.shareholder_id
   AND link.organization_id = reservation.organization_id
  WHERE reservation.payout_voucher_id = v_payout_voucher
  ORDER BY monthly.period_month, monthly.building_id, allocation.id
  LIMIT 1;

  IF v_profit_monthly IS NULL OR v_shareholder_link IS NULL THEN
    RAISE EXCEPTION 'Pending payout has no source row available for stale probe';
  END IF;
  IF NOT app_private.profit_monthly_source_is_current_v1(v_profit_monthly) THEN
    RAISE EXCEPTION 'Pending payout source was stale before approval probe';
  END IF;

  UPDATE public.building_shareholders
     SET percent = CASE
       WHEN v_original_percent < 100 THEN v_original_percent + 0.01
       ELSE v_original_percent - 0.01
     END
   WHERE id = v_shareholder_link;

  IF app_private.profit_monthly_source_is_current_v1(v_profit_monthly) THEN
    RAISE EXCEPTION 'Shareholder source mutation did not drift the profit hash';
  END IF;

  BEGIN
    PERFORM app_private.transition_canonical_income_expense_v1(
      v_payout_voucher, 'APPROVED', NULL, NULL
    );
    RAISE EXCEPTION 'Stale pending payout unexpectedly transitioned to APPROVED';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IS DISTINCT FROM
       'Profit payout approval blocked by stale locked allocations' THEN
      RAISE;
    END IF;
  END;

  UPDATE public.building_shareholders
     SET percent = v_original_percent
   WHERE id = v_shareholder_link;

  IF NOT app_private.profit_monthly_source_is_current_v1(v_profit_monthly) THEN
    RAISE EXCEPTION 'Stale approval probe did not restore the profit source';
  END IF;
  SELECT voucher.approval_status INTO v_status
  FROM public.income_expenses voucher
  WHERE voucher.id = v_payout_voucher;
  IF v_status IS DISTINCT FROM 'UNAPPROVED' THEN
    RAISE EXCEPTION 'Rejected stale payout changed voucher status to %', v_status;
  END IF;

  BEGIN
    UPDATE public.income_expenses
       SET notes = notes
     WHERE id = v_payout_voucher;
    RAISE EXCEPTION 'Direct canonical payout update unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF SQLERRM IS DISTINCT FROM format(
      'canonical income expense %s is frozen (update rejected)',
      v_payout_voucher
    ) THEN
      RAISE;
    END IF;
  END;

  SELECT request_row.id, request_row.version
    INTO v_request, v_request_version
  FROM public.approval_requests request_row
  WHERE request_row.subject_type = 'FINANCIAL_VOUCHER'
    AND request_row.subject_id = v_payout_voucher
    AND request_row.system_source = 'profit.distribution';
  IF v_request IS NULL THEN
    RAISE EXCEPTION 'Pending payout request is missing before post probe';
  END IF;

  BEGIN
    v_posting := app_private.post_financial_request_v1(
      v_request,
      v_request_version,
      current_setting('accounting_test.actor')::uuid
    );
    IF v_posting IS NULL THEN
      RAISE EXCEPTION 'Payout post probe returned no posting id';
    END IF;
    RAISE EXCEPTION 'ACCOUNTING_TEST_ROLLBACK_PAYOUT_POST';
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    IF SQLERRM IS DISTINCT FROM 'ACCOUNTING_TEST_ROLLBACK_PAYOUT_POST' THEN
      RAISE;
    END IF;
  END;

  SELECT request_row.state, voucher.approval_status
    INTO v_request_state, v_status
  FROM public.approval_requests request_row
  JOIN public.income_expenses voucher
    ON voucher.id = request_row.subject_id
  WHERE request_row.id = v_request;
  IF v_request_state IS DISTINCT FROM 'PENDING_APPROVAL'
     OR v_status IS DISTINCT FROM 'UNAPPROVED' THEN
    RAISE EXCEPTION
      'Rolled-back post probe leaked state: request %, voucher %',
      v_request_state, v_status;
  END IF;
END;
$payout_stale_approval$;

DO $canary_ledger$
DECLARE
  v_count integer;
  v_amount numeric;
  v_payout_amount numeric := current_setting('accounting_test.payout_amount')::numeric;
  v_payout_voucher uuid := current_setting('accounting_test.payout_voucher')::uuid;
  v_virtual_account uuid := current_setting('accounting_test.virtual_account')::uuid;
  v_legacy_payment uuid := current_setting('accounting_test.legacy_payment')::uuid;
  v_legacy_source uuid := current_setting('accounting_test.legacy_source')::uuid;
  v_legacy_reversal uuid := current_setting('accounting_test.legacy_reversal')::uuid;
  v_collection_one uuid := current_setting('accounting_test.collection_one')::uuid;
  v_probe_payment uuid;
  v_other_building uuid;
  v_other_room uuid;
BEGIN
  SELECT building_row.id INTO v_other_building
  FROM public.buildings building_row
  WHERE building_row.organization_id = (
      SELECT source_voucher.organization_id
      FROM public.income_expenses source_voucher
      WHERE source_voucher.id = v_legacy_source
    )
    AND building_row.id <> (
      SELECT source_voucher.building_id
      FROM public.income_expenses source_voucher
      WHERE source_voucher.id = v_legacy_source
    )
    AND building_row.deleted_at IS NULL
  ORDER BY building_row.id
  LIMIT 1;

  SELECT room_row.id INTO v_other_room
  FROM public.rooms room_row
  JOIN public.buildings building_row ON building_row.id = room_row.building_id
  WHERE building_row.organization_id = (
      SELECT source_voucher.organization_id
      FROM public.income_expenses source_voucher
      WHERE source_voucher.id = v_legacy_source
    )
    AND room_row.id <> (
      SELECT source_voucher.room_id
      FROM public.income_expenses source_voucher
      WHERE source_voucher.id = v_legacy_source
    )
    AND room_row.deleted_at IS NULL
  ORDER BY room_row.id
  LIMIT 1;

  IF v_other_building IS NULL OR v_other_room IS NULL THEN
    RAISE EXCEPTION 'Missing alternate DEMO domain rows for reversal gate probes';
  END IF;

  IF app_private.count_invalid_payment_reversals_v1(v_legacy_payment) <> 0 THEN
    RAISE EXCEPTION 'Valid legacy reversal failed the final lineage gate';
  END IF;

  PERFORM app_private.begin_accounting_chain_write_v1();

  BEGIN
    UPDATE public.income_expenses SET payment_id = NULL WHERE id = v_legacy_source;
    IF app_private.count_invalid_payment_reversals_v1(v_legacy_payment) <> 1 THEN
      RAISE EXCEPTION 'Gate missed a source payment_id mutation';
    END IF;
    RAISE EXCEPTION 'rollback probe' USING ERRCODE = 'ZP001';
  EXCEPTION WHEN SQLSTATE 'ZP001' THEN NULL;
  END;

  BEGIN
    UPDATE public.income_expenses SET invoice_id = NULL WHERE id = v_legacy_source;
    IF app_private.count_invalid_payment_reversals_v1(v_legacy_payment) <> 1 THEN
      RAISE EXCEPTION 'Gate missed a source invoice_id mutation';
    END IF;
    RAISE EXCEPTION 'rollback probe' USING ERRCODE = 'ZP001';
  EXCEPTION WHEN SQLSTATE 'ZP001' THEN NULL;
  END;

  BEGIN
    UPDATE public.income_expenses SET contract_id = NULL WHERE id = v_legacy_source;
    IF app_private.count_invalid_payment_reversals_v1(v_legacy_payment) <> 1 THEN
      RAISE EXCEPTION 'Gate missed a source contract_id mutation';
    END IF;
    RAISE EXCEPTION 'rollback probe' USING ERRCODE = 'ZP001';
  EXCEPTION WHEN SQLSTATE 'ZP001' THEN NULL;
  END;

  BEGIN
    UPDATE public.income_expenses
    SET building_id = v_other_building WHERE id = v_legacy_source;
    IF app_private.count_invalid_payment_reversals_v1(v_legacy_payment) <> 1 THEN
      RAISE EXCEPTION 'Gate missed a source building_id mutation';
    END IF;
    RAISE EXCEPTION 'rollback probe' USING ERRCODE = 'ZP001';
  EXCEPTION WHEN SQLSTATE 'ZP001' THEN NULL;
  END;

  BEGIN
    UPDATE public.income_expenses
    SET room_id = v_other_room WHERE id = v_legacy_source;
    IF app_private.count_invalid_payment_reversals_v1(v_legacy_payment) <> 1 THEN
      RAISE EXCEPTION 'Gate missed a source room_id mutation';
    END IF;
    RAISE EXCEPTION 'rollback probe' USING ERRCODE = 'ZP001';
  EXCEPTION WHEN SQLSTATE 'ZP001' THEN NULL;
  END;

  BEGIN
    UPDATE public.income_expenses SET contract_id = NULL WHERE id = v_legacy_reversal;
    IF app_private.count_invalid_payment_reversals_v1(v_legacy_payment) <> 1 THEN
      RAISE EXCEPTION 'Gate missed a reversal contract_id mutation';
    END IF;
    RAISE EXCEPTION 'rollback probe' USING ERRCODE = 'ZP001';
  EXCEPTION WHEN SQLSTATE 'ZP001' THEN NULL;
  END;

  SELECT payment.id INTO v_probe_payment
  FROM public.payments payment
  WHERE payment.collection_id = v_collection_one
  ORDER BY payment.id
  LIMIT 1;
  IF v_probe_payment IS NULL
     OR app_private.count_invalid_payment_reversals_v1(v_probe_payment) <> 0 THEN
    RAISE EXCEPTION 'Valid V5 reversal failed the final lineage gate';
  END IF;

  BEGIN
    UPDATE public.invoice_payment_tenders tender
       SET voucher_id = v_legacy_source
     WHERE tender.id = (
       SELECT payment.tender_id
       FROM public.payments payment
       WHERE payment.id = v_probe_payment
     );
    IF app_private.count_invalid_payment_reversals_v1(v_probe_payment) <> 1 THEN
      RAISE EXCEPTION 'Gate missed a V5 tender/source mutation';
    END IF;
    RAISE EXCEPTION 'rollback probe' USING ERRCODE = 'ZP001';
  EXCEPTION WHEN SQLSTATE 'ZP001' THEN NULL;
  END;

  PERFORM app_private.end_accounting_chain_write_v1();

  BEGIN
    UPDATE public.income_expenses
       SET account_id = v_virtual_account
     WHERE id = v_payout_voucher;
    RAISE EXCEPTION 'Payout account trigger accepted a virtual cashbook';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
  BEGIN
    UPDATE public.income_expenses
       SET account_id = NULL
     WHERE id = v_payout_voucher;
    RAISE EXCEPTION 'Payout account trigger accepted a null cashbook';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  SELECT count(*), COALESCE(sum(operation_row.amount_vnd), 0)
    INTO v_count, v_amount
  FROM app_private.server_feature_flag_operations operation_row
  JOIN app_private.server_feature_flags feature_row
    ON feature_row.feature_key = operation_row.feature_key
   AND feature_row.config_version = operation_row.config_version
  WHERE operation_row.feature_key = 'contract.create.v2';
  IF v_count <> 1 OR v_amount <> 5000000 THEN
    RAISE EXCEPTION 'Contract canary ledger mismatch: rows %, amount %',
      v_count, v_amount;
  END IF;

  SELECT count(*), COALESCE(sum(operation_row.amount_vnd), 0)
    INTO v_count, v_amount
  FROM app_private.server_feature_flag_operations operation_row
  JOIN app_private.server_feature_flags feature_row
    ON feature_row.feature_key = operation_row.feature_key
   AND feature_row.config_version = operation_row.config_version
  WHERE operation_row.feature_key = 'invoice.collection.v5';
  IF v_count <> 2 OR v_amount <> 5300000 THEN
    RAISE EXCEPTION 'Collection canary ledger/replay mismatch: rows %, amount %',
      v_count, v_amount;
  END IF;

  SELECT count(*), COALESCE(sum(operation_row.amount_vnd), 0)
    INTO v_count, v_amount
  FROM app_private.server_feature_flag_operations operation_row
  JOIN app_private.server_feature_flags feature_row
    ON feature_row.feature_key = operation_row.feature_key
   AND feature_row.config_version = operation_row.config_version
  WHERE operation_row.feature_key = 'customer.credit.apply.v1';
  IF v_count <> 1 OR v_amount <> 200000 THEN
    RAISE EXCEPTION 'Customer-credit canary ledger mismatch: rows %, amount %',
      v_count, v_amount;
  END IF;

  SELECT count(*), COALESCE(sum(operation_row.amount_vnd), 0)
    INTO v_count, v_amount
  FROM app_private.server_feature_flag_operations operation_row
  JOIN app_private.server_feature_flags feature_row
    ON feature_row.feature_key = operation_row.feature_key
   AND feature_row.config_version = operation_row.config_version
  WHERE operation_row.feature_key = 'shareholder_profit.distribute.v2';
  IF v_count <> 1 OR abs(v_amount - v_payout_amount) >= 0.01 THEN
    RAISE EXCEPTION 'Payout canary ledger mismatch: rows %, amount %',
      v_count, v_amount;
  END IF;
END;
$canary_ledger$;

DO $canary_caps$
DECLARE
  v_org uuid := current_setting('accounting_test.org')::uuid;
  v_actor uuid := current_setting('accounting_test.actor')::uuid;
  v_version bigint;
  v_count integer;
  v_amount numeric;
BEGIN
  UPDATE app_private.server_feature_flags
     SET mode = 'CANARY',
         force_freeze = false,
         config_version = config_version + 1,
         starts_at = clock_timestamp() - interval '1 hour',
         ends_at = clock_timestamp() + interval '1 day',
         max_operation_count = 2,
         max_single_amount_vnd = 100,
         max_total_amount_vnd = 100,
         commit_sha = 'rollback-cap-test',
         migration_sha256 = repeat('b', 64),
         maintenance_window_id = 'rollback-cap-test',
         approval_reference = 'rollback-cap-test',
         updated_at = clock_timestamp()
   WHERE feature_key = 'shareholder_profit.distribute.v2'
   RETURNING config_version INTO v_version;

  BEGIN
    PERFORM app_private.claim_feature_operation_v1(
      'shareholder_profit.distribute.v2', v_org, 'single-cap', v_actor,
      'cap-single-0001', 101
    );
    RAISE EXCEPTION 'Single-operation canary cap was not enforced';
  EXCEPTION WHEN SQLSTATE '54000' THEN
    NULL;
  END;

  PERFORM app_private.claim_feature_operation_v1(
    'shareholder_profit.distribute.v2', v_org, 'total-a', v_actor,
    'cap-total-a-0001', 60
  );

  BEGIN
    PERFORM app_private.claim_feature_operation_v1(
      'shareholder_profit.distribute.v2', v_org, 'total-b-reject', v_actor,
      'cap-total-b-reject-0001', 50
    );
    RAISE EXCEPTION 'Total-amount canary cap was not enforced';
  EXCEPTION WHEN SQLSTATE '54000' THEN
    NULL;
  END;

  PERFORM app_private.claim_feature_operation_v1(
    'shareholder_profit.distribute.v2', v_org, 'total-b', v_actor,
    'cap-total-b-0001', 40
  );

  BEGIN
    PERFORM app_private.claim_feature_operation_v1(
      'shareholder_profit.distribute.v2', v_org, 'count-cap', v_actor,
      'cap-count-0001', 0
    );
    RAISE EXCEPTION 'Operation-count canary cap was not enforced';
  EXCEPTION WHEN SQLSTATE '54000' THEN
    NULL;
  END;

  SELECT count(*), COALESCE(sum(operation_row.amount_vnd), 0)
    INTO v_count, v_amount
  FROM app_private.server_feature_flag_operations operation_row
  WHERE operation_row.feature_key = 'shareholder_profit.distribute.v2'
    AND operation_row.config_version = v_version;
  IF v_count <> 2 OR v_amount <> 100 THEN
    RAISE EXCEPTION 'Canary cap ledger expected 2 rows / 100, got % / %',
      v_count, v_amount;
  END IF;
END;
$canary_caps$;

SELECT current_setting('accounting_test.verdict')::jsonb
  AS accounting_chain_test;
`;

const sql = [
  "BEGIN;",
  ...migrationFiles.flatMap((file) => {
    const hook = migrationHooks.get(file);
    return [
      hook?.before ?? "",
      `\n-- accounting chain: ${file}\n${migrationBody(file)}`,
      hook?.after ?? "",
    ];
  }),
  assertions,
  "ROLLBACK;",
].join("\n");

const response = await fetch(
  `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql }),
  },
);
const body = await response.text();

if (!response.ok) {
  console.error(`Accounting chain integration failed (${response.status})`);
  console.error(body.slice(0, 5000));
  process.exit(1);
}

const parsed = JSON.parse(body);
console.log(
  JSON.stringify(parsed[0]?.accounting_chain_test ?? parsed, null, 2),
);
console.log(
  "Accounting chain integration passed; all fixture data was rolled back.",
);

const [itemProbe] = await databaseQuery(`
  SELECT item.id::text AS item_id
  FROM public.income_expense_items item
  JOIN public.income_expenses voucher
    ON voucher.id = item.income_expense_id
  LEFT JOIN app_private.income_expense_flow_ownership ownership
    ON ownership.income_expense_id = voucher.id
  WHERE voucher.organization_id =
          'dddd0000-0000-4000-8000-000000000001'::uuid
    AND voucher.deleted_at IS NULL
    AND voucher.approval_status = 'UNAPPROVED'
    AND voucher.system_source IS DISTINCT FROM 'profit.distribution'
    AND ownership.income_expense_id IS NULL
  ORDER BY voucher.created_at DESC, item.id
  LIMIT 1;
`);

if (!itemProbe?.item_id || !/^[0-9a-f-]{36}$/i.test(itemProbe.item_id)) {
  throw new Error("No safe DEMO income-expense item found for lock-order probe");
}

async function runItemParentLockProbe(lockMode, label) {
  const applicationName = `accounting-${label}-${Date.now()}`;
  const itemWriter = databaseQuery(`
    BEGIN;
    SET LOCAL application_name = '${applicationName}';
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '10s';
    LOCK TABLE public.income_expense_items IN ROW EXCLUSIVE MODE;
    SELECT pg_sleep(1.5);
    UPDATE public.income_expense_items
       SET description = description
     WHERE id = '${itemProbe.item_id}'::uuid;
    ROLLBACK;
    SELECT 'ITEM_DML_OK' AS result;
  `);

  let itemLockObserved = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await delay(50);
    const [lockState] = await databaseQuery(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_locks lock_row
        JOIN pg_catalog.pg_stat_activity activity
          ON activity.pid = lock_row.pid
        WHERE activity.application_name = '${applicationName}'
          AND lock_row.relation =
              'public.income_expense_items'::regclass
          AND lock_row.mode = 'RowExclusiveLock'
          AND lock_row.granted
      ) AS locked;
    `);
    if (lockState?.locked) {
      itemLockObserved = true;
      break;
    }
  }
  if (!itemLockObserved) {
    await itemWriter;
    throw new Error(`${label} probe never observed the item writer lock`);
  }

  const sourceReader = databaseQuery(`
    BEGIN;
    SET LOCAL lock_timeout = '5s';
    SET LOCAL statement_timeout = '10s';
    LOCK TABLE public.income_expense_items,
               public.income_expenses
      IN ${lockMode} MODE;
    ROLLBACK;
    SELECT 'SOURCE_LOCK_OK' AS result;
  `);

  const [itemResult, sourceResult] = await Promise.all([
    itemWriter,
    sourceReader,
  ]);
  if (
    !itemResult.some((row) => row.result === "ITEM_DML_OK") ||
    !sourceResult.some((row) => row.result === "SOURCE_LOCK_OK")
  ) {
    throw new Error(`${label} item/parent lock-order probe returned bad output`);
  }
}

await runItemParentLockProbe("SHARE", "profit-close-lock-order");
await runItemParentLockProbe(
  "SHARE ROW EXCLUSIVE",
  "profit-payout-lock-order",
);
console.log(
  "Direct item DML concurrency passed for Profit Close and payout lock modes.",
);
