-- Resolve reviewed legacy accounting shapes that are not one-payment/one-voucher
-- receipts. Every production repair is exact-ID guarded and fails closed when
-- the live row shape differs from the reviewed evidence.

BEGIN;

SELECT app_private.begin_accounting_chain_write_v1();

-- Exact-ID repairs are production evidence, not schema prerequisites. A clean
-- environment skips them when none of the reviewed rows exists; any partial
-- presence still enters the guards below and fails closed on shape drift.
CREATE TEMP TABLE _acct_history_resolution_scope ON COMMIT DROP AS
SELECT
  EXISTS (
    SELECT 1
    FROM public.payments payment
    WHERE payment.id = ANY (ARRAY[
      '0da41bd1-b2e5-41ad-b52d-2ba970f2b05d',
      '1700ecac-c64a-42c6-b307-6f5d8475fd24',
      '6517aa8e-94db-4da3-b5d3-458a0caef620',
      'ae08077a-3d31-4d18-9f63-94020857c0bb',
      '82f76140-511b-42c4-98e1-7c69013a2848',
      'b0d755d6-f2ab-4223-aeab-051e9c4dd140',
      'bbc24923-8095-40a5-9952-f2d51857b596',
      '6c914748-8956-4297-9e29-11c9d414c58b',
      'c111d6d6-6e64-4045-8b57-731ca10df15d',
      'afa53ef2-6c6d-4c43-8339-6ca2ab2f98ff',
      'e0c71b3b-a1d8-4a0e-a5bf-0d6fc97356bd',
      'dc490170-8e05-43e5-bcf9-1e6151dbbc5a',
      '2c4c7cf9-e23f-47ba-8293-003844b3fede',
      'bc0eba99-a0ce-4042-b48a-94bb808f0704',
      '12357610-2d88-44dc-ae4a-b5064b75b704',
      '1b6a6fe5-20bd-4e2e-9120-dbfc9ce2dbe7',
      '5b32cb16-b579-4427-bebf-108c5195a279',
      '99b53b2c-db7a-43df-862e-040ec1042ff4'
    ]::uuid[])
  ) AS real_history_present,
  EXISTS (
    SELECT 1
    FROM public.payments payment
    WHERE payment.id = ANY (ARRAY[
      '34a5dec8-d991-4a9e-917c-3d76af80dc35',
      '3eb1dd53-c408-4e7a-a875-60155775fa5d',
      '91200386-089a-4850-b7c9-e1ce6a3b9e0c',
      '94fc58f4-4191-43ba-938e-6d53b58b8936',
      'd1ddbbc4-889b-4c9b-999f-ae6c204e3f82',
      'dc5ba22e-41fa-436e-b572-e2417d7455cf',
      '7611a209-4a16-4aac-a324-af3690ffad3b',
      '147896d8-65b0-4ef8-b6d2-8f1997e0136d',
      '6cd6d7e3-58c6-45da-9e22-7fe94e20fd95',
      'd0d263d8-f45e-4d65-9c2a-6b500629146b',
      '646dbc92-bdf2-40b9-945e-92a0251afd6a',
      '6c606247-9f7b-4a24-bba0-244f54e6d63f',
      'bd7e98ed-92b3-46ed-bdd1-c5014e5aff99',
      '282c7c94-77aa-4e19-832f-10ce9ff9d92f'
    ]::uuid[])
  ) AS demo_history_present;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expense_items'::regclass
      AND tgname = 'a00_ie_item_owned_payload_freeze'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expense_items
      DISABLE TRIGGER a00_ie_item_owned_payload_freeze;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expenses'::regclass
      AND tgname = 'a00_ie_owned_payload_freeze'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expenses
      DISABLE TRIGGER a00_ie_owned_payload_freeze;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expenses'::regclass
      AND tgname = 'trg_ie_handover_guard'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expenses
      DISABLE TRIGGER trg_ie_handover_guard;
  END IF;
END;
$$;

-- The termination RPC wrote payments only to settle invoice A/R. Cash and P&L
-- were posted by separate termination legs, so these rows must not be reported
-- as cash receipts or linked to the revenue voucher.
CREATE TEMP TABLE _acct_expected_settlement_batches (
  batch_key text PRIMARY KEY,
  revenue_voucher_id uuid NOT NULL,
  offset_voucher_id uuid NOT NULL,
  expected_revenue numeric NOT NULL,
  expected_batch_total numeric NOT NULL,
  reversed boolean NOT NULL DEFAULT false
) ON COMMIT DROP;

INSERT INTO _acct_expected_settlement_batches (
  batch_key, revenue_voucher_id, offset_voucher_id,
  expected_revenue, expected_batch_total, reversed
) VALUES
  ('settlement-20260627-46711a02',
   'ea057e06-a039-4f35-a314-8732537b8481',
   '66b0839d-ad8e-42d0-bf80-11cf5ba1fdee', 347000, 347000, false),
  ('settlement-20260604-070d878a',
   '3806a1a6-b97e-49d0-8884-d0ac39f5434f',
   'acebb054-f6dd-474b-9616-71045328560c', 697800, 697800, false),
  ('settlement-20260630-1383a43f',
   '2873d022-5b8d-4c57-9acc-11f542287d3b',
   '20fb61fd-39d0-4a03-9fe5-8d38728d918f', 354000, 354000, false),
  ('settlement-20260706-06440526',
   'd5465e86-9adb-40e0-af90-139fed027333',
   '341282ba-6f56-43d6-9782-c891ef41f5a7', 648000, 649000, false),
  ('settlement-20260702-dc82a099',
   '1bd93819-4def-4aaf-b970-9989991292e5',
   '71b3c543-85ec-4eb5-b3f4-0138fa8045f8', 642200, 643000, false),
  ('settlement-20260628-d3ae786b',
   '6b0e717e-8f8e-4744-ab66-87611c40a58a',
   '18ea7e39-219f-427c-8114-1b754692a1f8', 494000, 494500, false),
  ('settlement-20260430-5080b890',
   '6efc09f4-3c25-4ee0-87a3-9139fca12601',
   'e8064de7-df2b-47dc-bbac-c8fa86b8c05c', 200000, 200000, false),
  ('settlement-20260630-69cdb5dc-reversed',
   'f6eb4b16-c7cc-4912-ad0d-517ed66d7270',
   'd63d9bdc-2035-44e7-a061-f7725d7eaeaa', 1071500, 1071500, true);

CREATE TEMP TABLE _acct_expected_settlement_payments (
  payment_id uuid PRIMARY KEY,
  batch_key text NOT NULL REFERENCES _acct_expected_settlement_batches(batch_key),
  expected_amount numeric NOT NULL
) ON COMMIT DROP;

INSERT INTO _acct_expected_settlement_payments (
  payment_id, batch_key, expected_amount
) VALUES
  ('0da41bd1-b2e5-41ad-b52d-2ba970f2b05d', 'settlement-20260627-46711a02', 347000),
  ('1700ecac-c64a-42c6-b307-6f5d8475fd24', 'settlement-20260604-070d878a', 697800),
  ('6517aa8e-94db-4da3-b5d3-458a0caef620', 'settlement-20260630-1383a43f', 354000),
  ('ae08077a-3d31-4d18-9f63-94020857c0bb', 'settlement-20260706-06440526', 648000),
  ('82f76140-511b-42c4-98e1-7c69013a2848', 'settlement-20260706-06440526', 500),
  ('b0d755d6-f2ab-4223-aeab-051e9c4dd140', 'settlement-20260706-06440526', 500),
  ('bbc24923-8095-40a5-9952-f2d51857b596', 'settlement-20260702-dc82a099', 642200),
  ('6c914748-8956-4297-9e29-11c9d414c58b', 'settlement-20260702-dc82a099', 800),
  ('c111d6d6-6e64-4045-8b57-731ca10df15d', 'settlement-20260628-d3ae786b', 494000),
  ('afa53ef2-6c6d-4c43-8339-6ca2ab2f98ff', 'settlement-20260628-d3ae786b', 500),
  ('e0c71b3b-a1d8-4a0e-a5bf-0d6fc97356bd', 'settlement-20260430-5080b890', 200000),
  ('dc490170-8e05-43e5-bcf9-1e6151dbbc5a', 'settlement-20260630-69cdb5dc-reversed', 1071500);

DO $settlement_guard$
DECLARE
  v_batch record;
  v_org uuid;
  v_contract uuid;
  v_payment_date date;
  v_created_at timestamptz;
  v_expected_count integer;
  v_actual_count integer;
  v_actual_total numeric;
BEGIN
  IF NOT (SELECT real_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM _acct_expected_settlement_payments) <> 12 THEN
    RAISE EXCEPTION 'Settlement repair allowlist is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _acct_expected_settlement_payments expected
    LEFT JOIN public.payments payment ON payment.id = expected.payment_id
    LEFT JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    WHERE payment.id IS NULL
       OR payment.organization_id <> 'aaaa0000-0000-4000-8000-000000000001'::uuid
       OR invoice.organization_id IS DISTINCT FROM payment.organization_id
       OR invoice.contract_id IS NULL
       OR payment.amount IS DISTINCT FROM expected.expected_amount
       OR payment.notes IS DISTINCT FROM (
         'Quyết toán khi thanh lý ' || to_char(payment.payment_date, 'DD/MM/YYYY')
       )
       OR EXISTS (
         SELECT 1 FROM public.income_expenses voucher
         WHERE voucher.payment_id = payment.id
           AND voucher.type = 'INCOME'
           AND voucher.deleted_at IS NULL
       )
  ) THEN
    RAISE EXCEPTION 'Reviewed settlement payment shape changed; refusing repair';
  END IF;

  FOR v_batch IN SELECT * FROM _acct_expected_settlement_batches ORDER BY batch_key
  LOOP
    SELECT
      (array_agg(payment.organization_id ORDER BY payment.id))[1],
      (array_agg(invoice.contract_id ORDER BY payment.id))[1],
      min(payment.payment_date),
      min(payment.created_at),
      count(*)::integer
      INTO v_org, v_contract, v_payment_date, v_created_at, v_expected_count
    FROM _acct_expected_settlement_payments expected
    JOIN public.payments payment ON payment.id = expected.payment_id
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    WHERE expected.batch_key = v_batch.batch_key;

    SELECT count(*)::integer, COALESCE(sum(payment.amount), 0)
      INTO v_actual_count, v_actual_total
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    WHERE payment.organization_id = v_org
      AND invoice.organization_id = v_org
      AND invoice.contract_id = v_contract
      AND payment.payment_date = v_payment_date
      AND payment.created_at = v_created_at
      AND payment.notes = (
        'Quyết toán khi thanh lý ' || to_char(payment.payment_date, 'DD/MM/YYYY')
      );

    IF v_actual_count <> v_expected_count
       OR v_actual_total <> v_batch.expected_batch_total
       OR EXISTS (
         SELECT 1
         FROM public.payments payment
         JOIN public.invoices invoice ON invoice.id = payment.invoice_id
         WHERE payment.organization_id = v_org
           AND invoice.contract_id = v_contract
           AND payment.payment_date = v_payment_date
           AND payment.created_at = v_created_at
           AND payment.notes = (
             'Quyết toán khi thanh lý ' || to_char(payment.payment_date, 'DD/MM/YYYY')
           )
           AND NOT EXISTS (
             SELECT 1 FROM _acct_expected_settlement_payments expected
             WHERE expected.batch_key = v_batch.batch_key
               AND expected.payment_id = payment.id
           )
       ) THEN
      RAISE EXCEPTION 'Settlement batch % contains unexpected payments', v_batch.batch_key;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM public.income_expenses revenue
      JOIN public.income_expenses offset_leg
        ON offset_leg.id = v_batch.offset_voucher_id
      JOIN public.accounts revenue_account ON revenue_account.id = revenue.account_id
      JOIN public.accounts offset_account ON offset_account.id = offset_leg.account_id
      WHERE revenue.id = v_batch.revenue_voucher_id
        AND revenue.organization_id = v_org
        AND offset_leg.organization_id = v_org
        AND revenue.contract_id = v_contract
        AND offset_leg.contract_id = v_contract
        AND revenue.voucher_date = v_payment_date
        AND offset_leg.voucher_date = v_payment_date
        AND revenue.created_at = v_created_at
        AND offset_leg.created_at = v_created_at
        AND revenue.type = 'INCOME'
        AND offset_leg.type = 'EXPENSE'
        AND revenue.system_source = 'termination.revenue'
        AND offset_leg.system_source = 'termination.offset'
        AND revenue.deleted_at IS NULL
        AND offset_leg.deleted_at IS NULL
        AND revenue.total_amount = v_batch.expected_revenue
        AND offset_leg.total_amount = v_batch.expected_revenue
        AND revenue_account.organization_id = v_org
        AND offset_account.organization_id = v_org
        AND revenue_account.deleted_at IS NULL
        AND offset_account.deleted_at IS NULL
        AND revenue.invoice_id IN (
          SELECT payment.invoice_id
          FROM _acct_expected_settlement_payments expected
          JOIN public.payments payment ON payment.id = expected.payment_id
          WHERE expected.batch_key = v_batch.batch_key
        )
        AND (
          (NOT v_batch.reversed
           AND revenue.approval_status = 'APPROVED'
           AND offset_leg.approval_status = 'APPROVED')
          OR
          (v_batch.reversed
           AND revenue.approval_status = 'CANCELLED'
           AND offset_leg.approval_status = 'CANCELLED')
        )
        AND (SELECT count(*) FROM public.income_expense_items item
             WHERE item.income_expense_id = revenue.id) = 1
        AND (SELECT COALESCE(sum(item.amount), 0)
             FROM public.income_expense_items item
             WHERE item.income_expense_id = revenue.id) = revenue.total_amount
        AND (SELECT count(*) FROM public.income_expense_items item
             WHERE item.income_expense_id = offset_leg.id) = 1
        AND (SELECT COALESCE(sum(item.amount), 0)
             FROM public.income_expense_items item
             WHERE item.income_expense_id = offset_leg.id) = offset_leg.total_amount
    ) THEN
      RAISE EXCEPTION 'Settlement batch % accounting legs changed', v_batch.batch_key;
    END IF;

    IF v_batch.expected_batch_total - v_batch.expected_revenue < 0
       OR v_batch.expected_batch_total - v_batch.expected_revenue >= 10000 THEN
      RAISE EXCEPTION 'Settlement batch % residual is outside reviewed bounds',
        v_batch.batch_key;
    END IF;

    IF (
      SELECT count(*)
      FROM public.income_expenses voucher
      WHERE voucher.organization_id = v_org
        AND voucher.contract_id = v_contract
        AND voucher.voucher_date = v_payment_date
        AND voucher.created_at = v_created_at
        AND voucher.deleted_at IS NULL
        AND voucher.system_source IN ('termination.revenue', 'termination.offset')
    ) <> 2 THEN
      RAISE EXCEPTION 'Settlement batch % has duplicate or missing accounting legs',
        v_batch.batch_key;
    END IF;

    IF v_batch.reversed AND NOT EXISTS (
      SELECT 1
      FROM _acct_expected_settlement_payments expected
      JOIN app_private.payment_reversals reversal
        ON reversal.original_payment_id = expected.payment_id
      JOIN public.income_expenses reversal_voucher
        ON reversal_voucher.id = reversal.reversal_voucher_id
      WHERE expected.batch_key = v_batch.batch_key
        AND reversal_voucher.id = '26e7a16b-e0d3-44aa-b954-735e0c8f9462'::uuid
        AND reversal_voucher.type = 'EXPENSE'
        AND reversal_voucher.approval_status = 'APPROVED'
        AND reversal_voucher.deleted_at IS NULL
        AND reversal.created_at = '2026-07-20 08:29:39.814213+00'::timestamptz
    ) THEN
      RAISE EXCEPTION 'Reviewed settlement reversal evidence changed';
    END IF;
  END LOOP;
END
$settlement_guard$;

CREATE TEMP TABLE _acct_settlement_payment_before ON COMMIT DROP AS
SELECT payment.*
FROM public.payments payment
JOIN _acct_expected_settlement_payments expected ON expected.payment_id = payment.id;

UPDATE public.payments payment
SET received_amount = 0,
    credit_amount = 0,
    change_amount = 0,
    rounding_amount = 0,
    updated_at = now()
FROM _acct_expected_settlement_payments expected
WHERE payment.id = expected.payment_id;

INSERT INTO public.accounting_repair_audit (
  organization_id, entity_type, entity_id, repair_code,
  before_snapshot, after_snapshot, details
)
SELECT
  after_row.organization_id, 'PAYMENT', after_row.id,
  'SETTLEMENT_OFFSET_PAYMENT_CLASSIFICATION',
  to_jsonb(before_row), to_jsonb(after_row),
  jsonb_build_object(
    'batch_key', expected.batch_key,
    'revenue_voucher_id', batch.revenue_voucher_id,
    'offset_voucher_id', batch.offset_voucher_id,
    'applied_amount', after_row.amount,
    'cash_received_amount', 0
  )
FROM _acct_expected_settlement_payments expected
JOIN _acct_expected_settlement_batches batch USING (batch_key)
JOIN _acct_settlement_payment_before before_row ON before_row.id = expected.payment_id
JOIN public.payments after_row ON after_row.id = expected.payment_id
ON CONFLICT DO NOTHING;

UPDATE public.accounting_integrity_exceptions exception
SET status = 'RESOLVED',
    resolved_at = clock_timestamp(),
    resolution_note = 'Reviewed termination A/R offset; no cash receipt voucher is expected.'
WHERE exception.status = 'OPEN'
  AND exception.entity_type = 'PAYMENT'
  AND exception.exception_code = 'PAYMENT_VOUCHER_COUNT'
  AND exception.entity_id IN (
    SELECT payment_id FROM _acct_expected_settlement_payments
  );

-- Two older termination offsets already had a linked voucher, so the generic
-- one-voucher repair did not flag them. Their own notes and voucher policy make
-- the non-cash meaning explicit; classify them with exact guards as well.
CREATE TEMP TABLE _acct_expected_linked_settlement_offsets (
  payment_id uuid PRIMARY KEY,
  voucher_id uuid NOT NULL,
  expected_amount numeric NOT NULL
) ON COMMIT DROP;

INSERT INTO _acct_expected_linked_settlement_offsets VALUES
  ('2c4c7cf9-e23f-47ba-8293-003844b3fede',
   '83ebe66a-0385-4fe9-8f46-5ac5319c19cb', 1142166),
  ('bc0eba99-a0ce-4042-b48a-94bb808f0704',
   '7b0db73c-03d2-43cb-96e0-9f9fb2e73663', 787500);

DO $linked_settlement_guard$
BEGIN
  IF NOT (SELECT real_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    JOIN public.income_expenses voucher
      ON voucher.id = '83ebe66a-0385-4fe9-8f46-5ac5319c19cb'::uuid
    JOIN public.accounts account_row ON account_row.id = voucher.account_id
    WHERE payment.id = '2c4c7cf9-e23f-47ba-8293-003844b3fede'::uuid
      AND payment.organization_id = 'aaaa0000-0000-4000-8000-000000000001'::uuid
      AND payment.amount = 1142166
      AND payment.payment_method = 'CT'
      AND payment.notes = 'Quyết toán khi thanh lý 03/06/2026 (cấn cọc)'
      AND invoice.contract_id = 'ac43b7da-658b-4553-9453-b8506ad437bf'::uuid
      AND voucher.payment_id = payment.id
      AND voucher.organization_id = payment.organization_id
      AND voucher.invoice_id = payment.invoice_id
      AND voucher.total_amount = payment.amount
      AND voucher.type = 'INCOME'
      AND voucher.approval_status = 'APPROVED'
      AND voucher.deleted_at IS NULL
      AND voucher.business_result_accounting = false
      AND voucher.name = 'Cấn trừ thanh lý — HĐ INV-202605-713985'
      AND voucher.notes = '[CẤN TRỪ] Quyết toán công nợ thanh lý bằng cấn cọc — không phải tiền mặt. Vá payment treo TM.'
      AND account_row.organization_id = payment.organization_id
      AND account_row.deleted_at IS NULL
      AND account_row.is_virtual
      AND (SELECT count(*) FROM public.income_expense_items item
           WHERE item.income_expense_id = voucher.id
             AND item.amount = payment.amount) = 1
  ) THEN
    RAISE EXCEPTION 'Reviewed linked CT settlement offset changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    JOIN public.income_expenses revenue
      ON revenue.id = '7b0db73c-03d2-43cb-96e0-9f9fb2e73663'::uuid
    JOIN public.income_expenses offset_leg
      ON offset_leg.id = 'd457b067-e1d3-4203-b447-7f21aa528b27'::uuid
    JOIN public.accounts revenue_account ON revenue_account.id = revenue.account_id
    JOIN public.accounts offset_account ON offset_account.id = offset_leg.account_id
    WHERE payment.id = 'bc0eba99-a0ce-4042-b48a-94bb808f0704'::uuid
      AND payment.organization_id = 'aaaa0000-0000-4000-8000-000000000001'::uuid
      AND payment.amount = 787500
      AND payment.payment_method = 'TM'
      AND payment.notes = 'Quyết toán khi thanh lý 30/06/2026'
      AND invoice.contract_id = '11664aa4-33b6-4c8d-b889-2c1ff6777de1'::uuid
      AND revenue.payment_id = payment.id
      AND revenue.organization_id = payment.organization_id
      AND revenue.invoice_id = payment.invoice_id
      AND revenue.total_amount = payment.amount
      AND revenue.type = 'INCOME'
      AND revenue.approval_status = 'APPROVED'
      AND revenue.deleted_at IS NULL
      AND revenue.name = 'Doanh thu thanh lý — HĐ HĐT-090540/28122025'
      AND offset_leg.organization_id = payment.organization_id
      AND offset_leg.contract_id = invoice.contract_id
      AND offset_leg.total_amount = payment.amount
      AND offset_leg.type = 'EXPENSE'
      AND offset_leg.approval_status = 'APPROVED'
      AND offset_leg.deleted_at IS NULL
      AND offset_leg.system_source = 'termination.offset'
      AND revenue_account.organization_id = payment.organization_id
      AND revenue_account.deleted_at IS NULL
      AND NOT revenue_account.is_virtual
      AND offset_account.organization_id = payment.organization_id
      AND offset_account.deleted_at IS NULL
      AND offset_account.is_virtual
      AND (SELECT COALESCE(sum(item.amount), 0)
           FROM public.income_expense_items item
           WHERE item.income_expense_id = revenue.id) = revenue.total_amount
      AND (SELECT COALESCE(sum(item.amount), 0)
           FROM public.income_expense_items item
           WHERE item.income_expense_id = offset_leg.id) = offset_leg.total_amount
  ) THEN
    RAISE EXCEPTION 'Reviewed linked TM settlement offset changed';
  END IF;
END
$linked_settlement_guard$;

CREATE TEMP TABLE _acct_linked_settlement_before ON COMMIT DROP AS
SELECT payment.*
FROM public.payments payment
JOIN _acct_expected_linked_settlement_offsets expected
  ON expected.payment_id = payment.id;

UPDATE public.payments payment
SET received_amount = 0,
    credit_amount = 0,
    change_amount = 0,
    rounding_amount = 0,
    updated_at = now()
FROM _acct_expected_linked_settlement_offsets expected
WHERE payment.id = expected.payment_id;

INSERT INTO public.accounting_repair_audit (
  organization_id, entity_type, entity_id, repair_code,
  before_snapshot, after_snapshot, details
)
SELECT
  after_row.organization_id, 'PAYMENT', after_row.id,
  'LINKED_SETTLEMENT_OFFSET_PAYMENT_CLASSIFICATION',
  to_jsonb(before_row), to_jsonb(after_row),
  jsonb_build_object(
    'source_voucher_id', expected.voucher_id,
    'applied_amount', after_row.amount,
    'cash_received_amount', 0
  )
FROM _acct_expected_linked_settlement_offsets expected
JOIN _acct_linked_settlement_before before_row ON before_row.id = expected.payment_id
JOIN public.payments after_row ON after_row.id = expected.payment_id
ON CONFLICT DO NOTHING;

DO $settlement_receipt_gate$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    WHERE payment.organization_id = 'aaaa0000-0000-4000-8000-000000000001'::uuid
      AND invoice.contract_id IS NOT NULL
      AND payment.notes ILIKE 'Quyết toán khi thanh lý%'
      AND COALESCE(payment.received_amount, payment.amount) <> 0
  ) THEN
    RAISE EXCEPTION 'An unreviewed termination A/R offset still reports cash received';
  END IF;
END
$settlement_receipt_gate$;

-- Two historical receipts intentionally split rent revenue and contract deposit
-- into separate vouchers on the same real account.
CREATE TEMP TABLE _acct_expected_standard_splits (
  payment_id uuid PRIMARY KEY,
  direct_voucher_id uuid NOT NULL,
  companion_voucher_id uuid NOT NULL,
  expected_amount numeric NOT NULL
) ON COMMIT DROP;

INSERT INTO _acct_expected_standard_splits VALUES
  ('12357610-2d88-44dc-ae4a-b5064b75b704',
   '4deb6e9c-4c92-4e54-899b-a490e44ca386',
   '8ad577fd-3253-46b3-855d-3c7fea72407d', 6550000),
  ('1b6a6fe5-20bd-4e2e-9120-dbfc9ce2dbe7',
   'e913c814-e766-4608-850d-4370ba46af88',
   '11d7c4c6-112d-4a2f-bbf3-fa91da7bc019', 1300000);

DO $standard_split_guard$
DECLARE
  v_row record;
  v_marker text;
BEGIN
  IF NOT (SELECT real_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  FOR v_row IN SELECT * FROM _acct_expected_standard_splits ORDER BY payment_id
  LOOP
    v_marker := '[THU TACH COC ' || v_row.payment_id::text || ']';
    IF NOT EXISTS (
      SELECT 1
      FROM public.payments payment
      JOIN public.invoices invoice ON invoice.id = payment.invoice_id
      JOIN public.income_expenses direct_voucher
        ON direct_voucher.id = v_row.direct_voucher_id
      JOIN public.income_expenses companion
        ON companion.id = v_row.companion_voucher_id
      JOIN public.accounts account_row ON account_row.id = direct_voucher.account_id
      WHERE payment.id = v_row.payment_id
        AND payment.organization_id = 'aaaa0000-0000-4000-8000-000000000001'::uuid
        AND payment.amount = v_row.expected_amount
        AND payment.received_amount = payment.amount
        AND invoice.organization_id = payment.organization_id
        AND direct_voucher.organization_id = payment.organization_id
        AND companion.organization_id = payment.organization_id
        AND direct_voucher.invoice_id = payment.invoice_id
        AND companion.invoice_id = payment.invoice_id
        AND direct_voucher.voucher_date = payment.payment_date
        AND companion.voucher_date = payment.payment_date
        AND direct_voucher.account_id = companion.account_id
        AND direct_voucher.payment_id = payment.id
        AND companion.payment_id IS NULL
        AND direct_voucher.type = 'INCOME'
        AND companion.type = 'INCOME'
        AND direct_voucher.approval_status = 'APPROVED'
        AND companion.approval_status = 'APPROVED'
        AND direct_voucher.deleted_at IS NULL
        AND companion.deleted_at IS NULL
        AND direct_voucher.system_source = 'invoice.payment'
        AND companion.system_source = 'contract.deposit'
        AND direct_voucher.notes = v_marker
        AND companion.notes = v_marker
        AND direct_voucher.total_amount + companion.total_amount = payment.amount
        AND account_row.organization_id = payment.organization_id
        AND account_row.deleted_at IS NULL
        AND NOT account_row.is_virtual
        AND NOT EXISTS (
          SELECT 1 FROM public.income_expense_items item
          WHERE item.income_expense_id = direct_voucher.id
            AND item.accounting_class <> 'PNL'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.income_expense_items item
          WHERE item.income_expense_id = companion.id
            AND item.accounting_class <> 'DEPOSIT'
        )
        AND (SELECT COALESCE(sum(item.amount), 0)
             FROM public.income_expense_items item
             WHERE item.income_expense_id = direct_voucher.id)
            = direct_voucher.total_amount
        AND (SELECT COALESCE(sum(item.amount), 0)
             FROM public.income_expense_items item
             WHERE item.income_expense_id = companion.id)
            = companion.total_amount
        AND (SELECT count(*) FROM public.income_expenses voucher
             WHERE voucher.organization_id = payment.organization_id
               AND voucher.notes = v_marker
               AND voucher.deleted_at IS NULL) = 2
    ) THEN
      RAISE EXCEPTION 'Reviewed split receipt % changed', v_row.payment_id;
    END IF;
  END LOOP;
END
$standard_split_guard$;

INSERT INTO public.accounting_repair_audit (
  organization_id, entity_type, entity_id, repair_code,
  before_snapshot, after_snapshot, details
)
SELECT
  payment.organization_id, 'PAYMENT', payment.id,
  'LEGACY_SPLIT_RECEIPT_CLASSIFICATION',
  jsonb_build_object('payment', to_jsonb(payment),
                     'direct_voucher', to_jsonb(direct_voucher),
                     'companion_voucher', to_jsonb(companion)),
  jsonb_build_object('payment', to_jsonb(payment),
                     'direct_voucher', to_jsonb(direct_voucher),
                     'companion_voucher', to_jsonb(companion)),
  jsonb_build_object(
    'source_voucher_ids', jsonb_build_array(direct_voucher.id, companion.id),
    'primary_voucher_id', direct_voucher.id,
    'account_id', direct_voucher.account_id
  )
FROM _acct_expected_standard_splits expected
JOIN public.payments payment ON payment.id = expected.payment_id
JOIN public.income_expenses direct_voucher ON direct_voucher.id = expected.direct_voucher_id
JOIN public.income_expenses companion ON companion.id = expected.companion_voucher_id
ON CONFLICT DO NOTHING;

UPDATE public.accounting_integrity_exceptions exception
SET status = 'RESOLVED',
    resolved_at = clock_timestamp(),
    resolution_note = 'Reviewed split revenue/deposit receipt; voucher totals reconcile to payment.'
WHERE exception.status = 'OPEN'
  AND exception.entity_type = 'PAYMENT'
  AND exception.exception_code = 'PAYMENT_VOUCHER_TOTAL_MISMATCH'
  AND exception.entity_id IN (
    SELECT payment_id FROM _acct_expected_standard_splits
  );

-- One manual legacy correction explicitly moved the duplicate-deposit portion
-- outside P&L but retained a non-deposit type. Snapshot its intended class.
DO $special_split$
DECLARE
  v_payment constant uuid := '5b32cb16-b579-4427-bebf-108c5195a279'::uuid;
  v_direct constant uuid := 'fcf4b6f0-ac75-43ac-9a99-7cc731452ff1'::uuid;
  v_companion constant uuid := '2ea26ca0-92c6-4896-a7b5-a5ee7031b2cc'::uuid;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF NOT (SELECT real_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    JOIN public.income_expenses direct_voucher ON direct_voucher.id = v_direct
    JOIN public.income_expenses companion ON companion.id = v_companion
    JOIN public.accounts account_row ON account_row.id = direct_voucher.account_id
    WHERE payment.id = v_payment
      AND payment.organization_id = 'aaaa0000-0000-4000-8000-000000000001'::uuid
      AND payment.amount = 2944000
      AND payment.received_amount = 2944000
      AND payment.rounding_amount = 1161
      AND invoice.id = '7e42743e-c516-48aa-85a9-27ac2e5ab65b'::uuid
      AND invoice.total_amount = 2945161
      AND direct_voucher.payment_id = payment.id
      AND companion.payment_id IS NULL
      AND direct_voucher.total_amount = 1045161
      AND companion.total_amount = 1898839
      AND direct_voucher.total_amount + companion.total_amount = payment.amount
      AND direct_voucher.rounding_amount = 1161
      AND direct_voucher.organization_id = payment.organization_id
      AND companion.organization_id = payment.organization_id
      AND direct_voucher.invoice_id = invoice.id
      AND companion.invoice_id = invoice.id
      AND direct_voucher.voucher_date = payment.payment_date
      AND companion.voucher_date = payment.payment_date
      AND direct_voucher.account_id = companion.account_id
      AND direct_voucher.approval_status = 'APPROVED'
      AND companion.approval_status = 'APPROVED'
      AND direct_voucher.deleted_at IS NULL
      AND companion.deleted_at IS NULL
      AND companion.business_result_accounting = false
      AND companion.name = 'Cọc thu trùng HĐ 401/1392QT — tách ra ngoài KQKD (chờ hoàn/cấn trừ)'
      AND account_row.organization_id = payment.organization_id
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
      AND (SELECT COALESCE(sum(item.amount), 0)
           FROM public.invoice_items item
           WHERE item.invoice_id = invoice.id
             AND item.accounting_class = 'DEPOSIT') = 1900000
      AND (SELECT count(*) FROM public.income_expense_items item
           WHERE item.income_expense_id = direct_voucher.id
             AND item.amount = 1045161
             AND item.accounting_class = 'PNL') = 1
      AND (SELECT count(*) FROM public.income_expense_items item
           WHERE item.income_expense_id = companion.id
             AND item.amount = 1898839
             AND item.accounting_class = 'PNL') = 1
  ) THEN
    RAISE EXCEPTION 'Special reviewed split receipt changed; refusing repair';
  END IF;

  SELECT jsonb_build_object(
    'voucher', to_jsonb(voucher),
    'items', (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
              FROM public.income_expense_items item
              WHERE item.income_expense_id = voucher.id)
  ) INTO v_before
  FROM public.income_expenses voucher WHERE voucher.id = v_companion;

  UPDATE public.income_expense_items
  SET accounting_class = 'DEPOSIT'
  WHERE income_expense_id = v_companion;

  PERFORM public.recompute_ie_business_result(v_direct);
  PERFORM public.recompute_ie_business_result(v_companion);

  SELECT jsonb_build_object(
    'voucher', to_jsonb(voucher),
    'items', (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
              FROM public.income_expense_items item
              WHERE item.income_expense_id = voucher.id)
  ) INTO v_after
  FROM public.income_expenses voucher WHERE voucher.id = v_companion;

  INSERT INTO public.accounting_repair_audit (
    organization_id, entity_type, entity_id, repair_code,
    before_snapshot, after_snapshot, details
  ) VALUES (
    'aaaa0000-0000-4000-8000-000000000001', 'INCOME_EXPENSE', v_companion,
    'LEGACY_SPLIT_DEPOSIT_RECLASSIFICATION', v_before, v_after,
    jsonb_build_object(
      'payment_id', v_payment,
      'primary_voucher_id', v_direct,
      'source_voucher_ids', jsonb_build_array(v_direct, v_companion)
    )
  ) ON CONFLICT DO NOTHING;

  UPDATE public.accounting_integrity_exceptions
  SET status = 'RESOLVED',
      resolved_at = clock_timestamp(),
      resolution_note = 'Exact reviewed split receipt; companion is deposit liability outside P&L.'
  WHERE status = 'OPEN'
    AND entity_type = 'PAYMENT'
    AND entity_id = v_payment
    AND exception_code = 'PAYMENT_VOUCHER_TOTAL_MISMATCH';
END
$special_split$;

-- A single pre-normalization receipt stored gross on the voucher and retained
-- cash on payments.amount. Preserve the deleted change voucher and rebuild P&L
-- from the retained amount only.
DO $gross_net_change$
DECLARE
  v_payment constant uuid := '99b53b2c-db7a-43df-862e-040ec1042ff4'::uuid;
  v_voucher constant uuid := 'b773b6b4-9936-4772-96f5-350ea6cdf160'::uuid;
  v_change_expense constant uuid := '63ae7480-fb55-4383-87f9-39856a3f3fde'::uuid;
  v_type uuid;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF NOT (SELECT real_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    JOIN public.income_expenses voucher ON voucher.id = v_voucher
    JOIN public.accounts account_row ON account_row.id = voucher.account_id
    JOIN public.accounts change_account ON change_account.id = voucher.change_account_id
    JOIN public.income_expenses change_expense ON change_expense.id = v_change_expense
    WHERE payment.id = v_payment
      AND payment.organization_id = 'aaaa0000-0000-4000-8000-000000000001'::uuid
      AND payment.amount = 5689000
      AND payment.received_amount = 5689000
      AND payment.change_amount = 80000
      AND payment.payment_method = 'TK'
      AND invoice.id = 'c4cc57dd-e7bf-4968-90b0-3af712c69a83'::uuid
      AND invoice.total_amount = 5689000
      AND voucher.payment_id = payment.id
      AND voucher.total_amount = payment.amount + voucher.change_amount
      AND voucher.change_amount = 80000
      AND voucher.approval_status = 'APPROVED'
      AND voucher.deleted_at IS NULL
      AND account_row.organization_id = payment.organization_id
      AND account_row.deleted_at IS NULL
      AND NOT account_row.is_virtual
      AND change_account.organization_id = payment.organization_id
      AND change_account.deleted_at IS NULL
      AND change_account.is_virtual
      AND change_expense.organization_id = payment.organization_id
      AND change_expense.invoice_id = payment.invoice_id
      AND change_expense.voucher_date = payment.payment_date
      AND change_expense.type = 'EXPENSE'
      AND change_expense.approval_status = 'APPROVED'
      AND change_expense.deleted_at IS NOT NULL
      AND change_expense.total_amount = voucher.change_amount
      AND change_expense.account_id = voucher.change_account_id
      AND (SELECT count(*) FROM public.income_expense_items item
           WHERE item.income_expense_id = voucher.id
             AND item.amount = 5769000
             AND item.accounting_class = 'PNL') = 1
      AND (SELECT count(*) FROM public.income_expense_items item
           WHERE item.income_expense_id = change_expense.id
             AND item.amount = 80000
             AND lower(btrim(item.description)) LIKE ANY (ARRAY[
               'tiền thối hoá đơn%', 'tiền thối hóa đơn%'
             ])) = 1
  ) THEN
    RAISE EXCEPTION 'Reviewed gross/net change receipt changed; refusing repair';
  END IF;

  SELECT item.income_expense_type_id INTO v_type
  FROM public.income_expense_items item
  WHERE item.income_expense_id = v_voucher
  ORDER BY item.created_at, item.id
  LIMIT 1;

  SELECT jsonb_build_object(
    'voucher', to_jsonb(voucher),
    'items', (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
              FROM public.income_expense_items item
              WHERE item.income_expense_id = voucher.id)
  ) INTO v_before
  FROM public.income_expenses voucher WHERE voucher.id = v_voucher;

  UPDATE public.income_expense_items
  SET accounting_class = 'INTERNAL', unit_price = 0, amount = 0
  WHERE income_expense_id = v_voucher;

  INSERT INTO public.income_expense_items (
    income_expense_id, organization_id, income_expense_type_id,
    description, quantity, unit_price, amount, start_date, end_date,
    accounting_class
  ) VALUES (
    v_voucher, 'aaaa0000-0000-4000-8000-000000000001', v_type,
    '[Accounting repair] Retained invoice revenue', 1,
    5689000, 5689000, '2026-05-01', '2026-05-01', 'PNL'
  );

  PERFORM public.recompute_ie_business_result(v_voucher);

  SELECT jsonb_build_object(
    'voucher', to_jsonb(voucher),
    'items', (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
              FROM public.income_expense_items item
              WHERE item.income_expense_id = voucher.id)
  ) INTO v_after
  FROM public.income_expenses voucher WHERE voucher.id = v_voucher;

  INSERT INTO public.accounting_repair_audit (
    organization_id, entity_type, entity_id, repair_code,
    before_snapshot, after_snapshot, details
  ) VALUES (
    'aaaa0000-0000-4000-8000-000000000001', 'INCOME_EXPENSE', v_voucher,
    'LEGACY_GROSS_NET_CHANGE_RECLASSIFICATION', v_before, v_after,
    jsonb_build_object(
      'payment_id', v_payment,
      'deleted_change_expense_id', v_change_expense,
      'gross_amount', 5769000,
      'retained_amount', 5689000,
      'change_amount', 80000
    )
  ) ON CONFLICT DO NOTHING;

  UPDATE public.accounting_integrity_exceptions
  SET status = 'RESOLVED',
      resolved_at = clock_timestamp(),
      resolution_note = 'Exact reviewed gross voucher equals retained payment plus returned change.'
  WHERE status = 'OPEN'
    AND entity_type = 'PAYMENT'
    AND entity_id = v_payment
    AND exception_code = 'PAYMENT_VOUCHER_TOTAL_MISMATCH';
END
$gross_net_change$;

-- Restore the single real termination revenue source that an old reversal
-- cancelled in-place, then rebuild its append-only compensating voucher.
DO $reviewed_reversal$
DECLARE
  v_payment constant uuid := 'dc490170-8e05-43e5-bcf9-1e6151dbbc5a'::uuid;
  v_source constant uuid := 'f6eb4b16-c7cc-4912-ad0d-517ed66d7270'::uuid;
  v_offset constant uuid := 'd63d9bdc-2035-44e7-a061-f7725d7eaeaa'::uuid;
  v_reversal constant uuid := '26e7a16b-e0d3-44aa-b954-735e0c8f9462'::uuid;
  v_actor uuid;
  v_type uuid;
  v_invoice uuid;
  v_account uuid;
  v_source_before jsonb;
  v_source_after jsonb;
  v_reversal_before jsonb;
  v_reversal_after jsonb;
  v_item record;
BEGIN
  IF NOT (SELECT real_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    JOIN app_private.payment_reversals reversal
      ON reversal.original_payment_id = payment.id
    JOIN public.income_expenses source_voucher ON source_voucher.id = v_source
    JOIN public.income_expenses offset_voucher ON offset_voucher.id = v_offset
    JOIN public.income_expenses reversal_voucher ON reversal_voucher.id = v_reversal
    JOIN public.accounts account_row ON account_row.id = source_voucher.account_id
    WHERE payment.id = v_payment
      AND payment.organization_id = 'aaaa0000-0000-4000-8000-000000000001'::uuid
      AND payment.amount = 1071500
      AND payment.received_amount = 0
      AND payment.reversed_at = reversal.created_at
      AND invoice.id = '8470ced6-f1d0-4f01-beb1-b8efdd387fd2'::uuid
      AND source_voucher.organization_id = payment.organization_id
      AND source_voucher.invoice_id = invoice.id
      AND source_voucher.total_amount = payment.amount
      AND source_voucher.system_source = 'termination.revenue'
      AND source_voucher.approval_status = 'CANCELLED'
      AND source_voucher.deleted_at IS NULL
      AND offset_voucher.organization_id = payment.organization_id
      AND offset_voucher.total_amount = payment.amount
      AND offset_voucher.system_source = 'termination.offset'
      AND offset_voucher.approval_status = 'CANCELLED'
      AND offset_voucher.deleted_at IS NULL
      AND reversal.reversal_voucher_id = reversal_voucher.id
      AND reversal.created_at = '2026-07-20 08:29:39.814213+00'::timestamptz
      AND reversal_voucher.organization_id = payment.organization_id
      AND reversal_voucher.type = 'EXPENSE'
      AND reversal_voucher.total_amount = payment.amount
      AND reversal_voucher.approval_status = 'APPROVED'
      AND reversal_voucher.deleted_at IS NULL
      AND reversal_voucher.account_id IS NULL
      AND account_row.organization_id = payment.organization_id
      AND account_row.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Reviewed real reversal shape changed; refusing repair';
  END IF;

  SELECT reversal.actor_id, payment.invoice_id, source_voucher.account_id
    INTO v_actor, v_invoice, v_account
  FROM app_private.payment_reversals reversal
  JOIN public.payments payment ON payment.id = reversal.original_payment_id
  JOIN public.income_expenses source_voucher ON source_voucher.id = v_source
  WHERE reversal.original_payment_id = v_payment;

  SELECT jsonb_build_object(
    'voucher', to_jsonb(voucher),
    'items', (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
              FROM public.income_expense_items item
              WHERE item.income_expense_id = voucher.id)
  ) INTO v_source_before
  FROM public.income_expenses voucher WHERE voucher.id = v_source;

  SELECT jsonb_build_object(
    'voucher', to_jsonb(voucher),
    'items', (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
              FROM public.income_expense_items item
              WHERE item.income_expense_id = voucher.id)
  ) INTO v_reversal_before
  FROM public.income_expenses voucher WHERE voucher.id = v_reversal;

  UPDATE public.income_expenses
  SET approval_status = 'APPROVED'
  WHERE id = v_source;

  UPDATE public.income_expenses
  SET account_id = v_account,
      voucher_date = '2026-07-20',
      reversal_of_income_expense_id = v_source
  WHERE id = v_reversal;

  SELECT type_row.id INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = 'aaaa0000-0000-4000-8000-000000000001'::uuid
    AND lower(type_row.type) = 'expense'
    AND lower(btrim(type_row.name)) = 'hoàn tác thu tiền'
  ORDER BY type_row.created_at
  LIMIT 1;

  IF v_type IS NULL THEN
    INSERT INTO public.income_expense_types (
      organization_id, user_id, name, type, description,
      is_default, is_deposit
    ) VALUES (
      'aaaa0000-0000-4000-8000-000000000001', v_actor,
      'Hoàn tác thu tiền', 'expense',
      'Bút toán đối ứng cho khoản thu đã hoàn tác', false, false
    ) RETURNING id INTO v_type;
  END IF;

  UPDATE public.income_expense_items
  SET accounting_class = 'INTERNAL', unit_price = 0, amount = 0
  WHERE income_expense_id = v_reversal;

  FOR v_item IN
    SELECT item.accounting_class, item.amount
    FROM public.income_expense_items item
    WHERE item.income_expense_id = v_source
      AND item.accounting_class IN ('PNL', 'DEPOSIT', 'CUSTOMER_CREDIT')
    ORDER BY item.created_at, item.id
  LOOP
    INSERT INTO public.income_expense_items (
      income_expense_id, organization_id, income_expense_type_id,
      description, quantity, unit_price, amount, start_date, end_date,
      accounting_class
    ) VALUES (
      v_reversal, 'aaaa0000-0000-4000-8000-000000000001', v_type,
      '[Accounting repair] Reversal ' || v_item.accounting_class,
      1, v_item.amount, v_item.amount,
      '2026-07-20', '2026-07-20', v_item.accounting_class
    );
  END LOOP;

  PERFORM public.recompute_ie_business_result(v_source);
  PERFORM public.recompute_ie_business_result(v_reversal);
  PERFORM public.recompute_invoice_for_id(v_invoice);

  SELECT jsonb_build_object(
    'voucher', to_jsonb(voucher),
    'items', (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
              FROM public.income_expense_items item
              WHERE item.income_expense_id = voucher.id)
  ) INTO v_source_after
  FROM public.income_expenses voucher WHERE voucher.id = v_source;

  SELECT jsonb_build_object(
    'voucher', to_jsonb(voucher),
    'items', (SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
              FROM public.income_expense_items item
              WHERE item.income_expense_id = voucher.id)
  ) INTO v_reversal_after
  FROM public.income_expenses voucher WHERE voucher.id = v_reversal;

  INSERT INTO public.accounting_repair_audit (
    organization_id, entity_type, entity_id, repair_code,
    before_snapshot, after_snapshot, details
  ) VALUES
    ('aaaa0000-0000-4000-8000-000000000001', 'INCOME_EXPENSE', v_source,
     'SETTLEMENT_REVERSAL_SOURCE_RESTORATION',
     v_source_before, v_source_after,
     jsonb_build_object('payment_id', v_payment, 'offset_voucher_id', v_offset)),
    ('aaaa0000-0000-4000-8000-000000000001', 'INCOME_EXPENSE', v_reversal,
     'SETTLEMENT_PAYMENT_REVERSAL_REPAIR',
     v_reversal_before, v_reversal_after,
     jsonb_build_object('payment_id', v_payment, 'source_voucher_id', v_source))
  ON CONFLICT DO NOTHING;

  UPDATE public.accounting_integrity_exceptions
  SET status = 'RESOLVED',
      resolved_at = clock_timestamp(),
      resolution_note = 'Exact reviewed termination revenue source restored and reversal rebuilt.'
  WHERE status = 'OPEN'
    AND entity_type = 'PAYMENT'
    AND entity_id = v_payment
    AND exception_code IN ('PAYMENT_VOUCHER_COUNT', 'REVERSAL_SOURCE_AMBIGUOUS');
END
$reviewed_reversal$;

-- Remove orphaned DEMO canary/retest rows. They are test artifacts, not ledger
-- history, and every ID is constrained to the DEMO organization and future data.
CREATE TEMP TABLE _acct_demo_artifact_payments (
  payment_id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO _acct_demo_artifact_payments VALUES
  ('34a5dec8-d991-4a9e-917c-3d76af80dc35'),
  ('3eb1dd53-c408-4e7a-a875-60155775fa5d'),
  ('91200386-089a-4850-b7c9-e1ce6a3b9e0c'),
  ('94fc58f4-4191-43ba-938e-6d53b58b8936'),
  ('d1ddbbc4-889b-4c9b-999f-ae6c204e3f82'),
  ('dc5ba22e-41fa-436e-b572-e2417d7455cf'),
  ('7611a209-4a16-4aac-a324-af3690ffad3b'),
  ('147896d8-65b0-4ef8-b6d2-8f1997e0136d'),
  ('6cd6d7e3-58c6-45da-9e22-7fe94e20fd95'),
  ('d0d263d8-f45e-4d65-9c2a-6b500629146b');

DO $demo_cleanup_guard$
BEGIN
  IF NOT (SELECT demo_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM _acct_demo_artifact_payments) <> 10
     OR (SELECT count(*)
         FROM _acct_demo_artifact_payments target
         JOIN public.payments payment ON payment.id = target.payment_id
         JOIN public.invoices invoice ON invoice.id = payment.invoice_id
         WHERE payment.organization_id = 'dddd0000-0000-4000-8000-000000000001'::uuid
           AND invoice.organization_id = payment.organization_id
           AND invoice.billing_month >= '2027-01') <> 10 THEN
    RAISE EXCEPTION 'DEMO accounting artifact allowlist changed; refusing cleanup';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM _acct_demo_artifact_payments target
    JOIN public.payments payment ON payment.id = target.payment_id
    WHERE payment.notes IS NOT NULL
      AND payment.notes NOT ILIKE 'pga-%'
      AND payment.notes NOT ILIKE 'PF19%'
      AND payment.notes NOT ILIKE 's14%'
  ) THEN
    RAISE EXCEPTION 'DEMO cleanup target no longer has a test marker';
  END IF;
END
$demo_cleanup_guard$;

CREATE TEMP TABLE _acct_demo_invoice_ids ON COMMIT DROP AS
SELECT DISTINCT payment.invoice_id
FROM _acct_demo_artifact_payments target
JOIN public.payments payment ON payment.id = target.payment_id;

CREATE TEMP TABLE _acct_demo_voucher_ids ON COMMIT DROP AS
SELECT voucher.id
FROM public.income_expenses voucher
WHERE voucher.payment_id IN (
  SELECT payment_id FROM _acct_demo_artifact_payments
)
UNION
SELECT reversal.reversal_voucher_id
FROM app_private.payment_reversals reversal
WHERE reversal.original_payment_id IN (
  SELECT payment_id FROM _acct_demo_artifact_payments
);

DO $demo_reference_guard$
BEGIN
  IF NOT (SELECT demo_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM app_private.income_expense_flow_ownership ownership
    WHERE ownership.income_expense_id IN (SELECT id FROM _acct_demo_voucher_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.cash_handover_items item
    WHERE item.voucher_id IN (SELECT id FROM _acct_demo_voucher_ids)
  ) OR EXISTS (
    SELECT 1 FROM public.income_expense_batch_items item
    WHERE item.income_expense_id IN (SELECT id FROM _acct_demo_voucher_ids)
  ) THEN
    RAISE EXCEPTION 'DEMO accounting artifact gained durable downstream references';
  END IF;
END
$demo_reference_guard$;

DELETE FROM app_private.payment_reversals reversal
WHERE reversal.original_payment_id IN (
  SELECT payment_id FROM _acct_demo_artifact_payments
);

DELETE FROM public.excess_amounts excess
WHERE excess.source_payment_id IN (
  SELECT payment_id FROM _acct_demo_artifact_payments
);

DELETE FROM public.income_expenses voucher
WHERE voucher.id IN (SELECT id FROM _acct_demo_voucher_ids);

DELETE FROM public.payments payment
WHERE payment.id IN (SELECT payment_id FROM _acct_demo_artifact_payments);

UPDATE public.accounting_integrity_exceptions exception
SET status = 'RESOLVED',
    resolved_at = clock_timestamp(),
    resolution_note = 'Removed exact DEMO canary/retest artifact and its dependent rows.'
WHERE exception.status = 'OPEN'
  AND exception.entity_id IN (
    SELECT payment_id FROM _acct_demo_artifact_payments
    UNION SELECT id FROM _acct_demo_voucher_ids
  );

DO $demo_recompute$
DECLARE
  v_invoice uuid;
BEGIN
  IF NOT (SELECT demo_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  FOR v_invoice IN SELECT invoice_id FROM _acct_demo_invoice_ids
  LOOP
    PERFORM public.recompute_invoice_for_id(v_invoice);
  END LOOP;
END
$demo_recompute$;

-- Backfill the three stable documentation receipts instead of deleting them.
DO $demo_docs$
DECLARE
  v_org constant uuid := 'dddd0000-0000-4000-8000-000000000001'::uuid;
  v_account uuid;
  v_type uuid;
  v_payment record;
  v_voucher uuid;
  v_before jsonb;
  v_after jsonb;
BEGIN
  IF NOT (SELECT demo_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  SELECT account_row.id INTO v_account
  FROM public.accounts account_row
  WHERE account_row.organization_id = v_org
    AND account_row.code = 'DEMO01'
    AND account_row.deleted_at IS NULL
    AND NOT account_row.is_virtual
  ORDER BY account_row.id
  LIMIT 1;

  SELECT type_row.id INTO v_type
  FROM public.income_expense_types type_row
  WHERE type_row.organization_id = v_org
    AND lower(type_row.type) = 'income'
    AND NOT type_row.is_deposit
  ORDER BY type_row.is_default DESC,
           CASE WHEN lower(btrim(type_row.name)) IN (
             'thu tiền hoá đơn', 'thu tiền hóa đơn'
           ) THEN 0 ELSE 1 END,
           type_row.created_at, type_row.id
  LIMIT 1;

  IF v_account IS NULL OR v_type IS NULL THEN
    RAISE EXCEPTION 'DEMO docs backfill lacks a real account or income type';
  END IF;

  IF (
    SELECT count(*)
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    WHERE payment.id IN (
      '646dbc92-bdf2-40b9-945e-92a0251afd6a'::uuid,
      '6c606247-9f7b-4a24-bba0-244f54e6d63f'::uuid,
      'bd7e98ed-92b3-46ed-bdd1-c5014e5aff99'::uuid
    )
      AND payment.organization_id = v_org
      AND invoice.organization_id = v_org
      AND payment.notes = '[DEMO-DOCS] Thu tiền'
      AND NOT EXISTS (
        SELECT 1 FROM public.income_expenses voucher
        WHERE voucher.payment_id = payment.id
          AND voucher.type = 'INCOME'
          AND voucher.deleted_at IS NULL
      )
  ) <> 3 THEN
    RAISE EXCEPTION 'DEMO docs receipt shape changed; refusing backfill';
  END IF;

  FOR v_payment IN
    SELECT payment.*, invoice.building_id, invoice.room_id, invoice.contract_id,
           invoice.invoice_number
    FROM public.payments payment
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    WHERE payment.id IN (
      '646dbc92-bdf2-40b9-945e-92a0251afd6a'::uuid,
      '6c606247-9f7b-4a24-bba0-244f54e6d63f'::uuid,
      'bd7e98ed-92b3-46ed-bdd1-c5014e5aff99'::uuid
    )
    ORDER BY payment.id
  LOOP
    v_before := to_jsonb(v_payment);

    UPDATE public.payments
    SET received_amount = amount,
        credit_amount = 0,
        change_amount = 0,
        rounding_amount = 0,
        updated_at = now()
    WHERE id = v_payment.id;

    INSERT INTO public.income_expenses (
      user_id, organization_id, type, name, building_id, room_id, contract_id,
      account_id, invoice_id, payment_id, voucher_date, total_amount,
      approval_status, approved_by, approved_at, notes, system_source
    ) VALUES (
      v_payment.user_id, v_org, 'INCOME',
      'DEMO Thu tiền theo HĐ ' || COALESCE(v_payment.invoice_number, ''),
      v_payment.building_id, v_payment.room_id, v_payment.contract_id,
      v_account, v_payment.invoice_id, v_payment.id, v_payment.payment_date,
      v_payment.amount, 'APPROVED', v_payment.user_id, clock_timestamp(),
      '[DEMO-DOCS] Backfill payment-linked voucher', 'demo.docs.payment'
    ) RETURNING id INTO v_voucher;

    INSERT INTO public.income_expense_items (
      income_expense_id, organization_id, income_expense_type_id,
      description, quantity, unit_price, amount, start_date, end_date,
      accounting_class
    ) VALUES (
      v_voucher, v_org, v_type,
      'DEMO Thanh toán ' || COALESCE(v_payment.invoice_number, ''),
      1, v_payment.amount, v_payment.amount,
      v_payment.payment_date, v_payment.payment_date, 'PNL'
    );

    PERFORM public.recompute_ie_business_result(v_voucher);
    PERFORM public.recompute_invoice_for_id(v_payment.invoice_id);

    SELECT to_jsonb(payment) INTO v_after
    FROM public.payments payment WHERE payment.id = v_payment.id;

    INSERT INTO public.accounting_repair_audit (
      organization_id, entity_type, entity_id, repair_code,
      before_snapshot, after_snapshot, details
    ) VALUES (
      v_org, 'PAYMENT', v_payment.id, 'DEMO_DOCS_RECEIPT_BACKFILL',
      v_before, v_after,
      jsonb_build_object('voucher_id', v_voucher, 'account_id', v_account)
    ) ON CONFLICT DO NOTHING;

    UPDATE public.accounting_integrity_exceptions
    SET status = 'RESOLVED',
        resolved_at = clock_timestamp(),
        resolution_note = 'Backfilled stable DEMO documentation receipt and accounting item.'
    WHERE status = 'OPEN'
      AND entity_type = 'PAYMENT'
      AND entity_id = v_payment.id
      AND exception_code = 'PAYMENT_VOUCHER_COUNT';
  END LOOP;
END
$demo_docs$;

-- One reviewed DEMO reversal source predates room_id propagation. Bind it to
-- the exact invoice domain so the final lineage gate cannot accept ambiguity.
DO $demo_reversal_room_repair$
DECLARE
  v_source constant uuid := '727cc039-479f-41fa-8ee2-e14a1a72eda8'::uuid;
  v_payment constant uuid := '282c7c94-77aa-4e19-832f-10ce9ff9d92f'::uuid;
  v_before jsonb;
  v_after jsonb;
  v_room uuid;
  v_org uuid;
BEGIN
  IF NOT (SELECT demo_history_present FROM _acct_history_resolution_scope) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.income_expenses voucher WHERE voucher.id = v_source
  ) THEN
    RETURN;
  END IF;

  SELECT invoice.room_id, payment.organization_id
    INTO v_room, v_org
  FROM public.payments payment
  JOIN public.invoices invoice ON invoice.id = payment.invoice_id
  JOIN app_private.payment_reversals reversal
    ON reversal.original_payment_id = payment.id
  JOIN public.income_expenses reversal_voucher
    ON reversal_voucher.id = reversal.reversal_voucher_id
  JOIN public.income_expenses source_voucher
    ON source_voucher.id = reversal_voucher.reversal_of_income_expense_id
  WHERE payment.id = v_payment
    AND payment.organization_id = 'dddd0000-0000-4000-8000-000000000001'::uuid
    AND source_voucher.id = v_source
    AND source_voucher.organization_id = payment.organization_id
    AND source_voucher.invoice_id = invoice.id
    AND source_voucher.contract_id = invoice.contract_id
    AND source_voucher.building_id = invoice.building_id
    AND source_voucher.room_id IS NULL
    AND reversal_voucher.organization_id = payment.organization_id
    AND reversal_voucher.invoice_id = invoice.id
    AND reversal_voucher.contract_id = invoice.contract_id
    AND reversal_voucher.building_id = invoice.building_id
    AND reversal_voucher.room_id = invoice.room_id;

  IF v_room IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.income_expenses source_voucher
      JOIN public.payments payment ON payment.id = v_payment
      JOIN public.invoices invoice ON invoice.id = payment.invoice_id
      WHERE source_voucher.id = v_source
        AND source_voucher.room_id = invoice.room_id
    ) THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Reviewed DEMO reversal room shape changed; refusing repair';
  END IF;

  SELECT to_jsonb(source_voucher) INTO v_before
  FROM public.income_expenses source_voucher WHERE source_voucher.id = v_source;

  UPDATE public.income_expenses
  SET room_id = v_room,
      updated_at = now()
  WHERE id = v_source AND room_id IS NULL;

  SELECT to_jsonb(source_voucher) INTO v_after
  FROM public.income_expenses source_voucher WHERE source_voucher.id = v_source;

  INSERT INTO public.accounting_repair_audit (
    organization_id, entity_type, entity_id, repair_code,
    before_snapshot, after_snapshot, details
  ) VALUES (
    v_org, 'INCOME_EXPENSE', v_source,
    'DEMO_REVERSAL_SOURCE_ROOM_BINDING', v_before, v_after,
    jsonb_build_object('payment_id', v_payment, 'room_id', v_room)
  ) ON CONFLICT DO NOTHING;
END
$demo_reversal_room_repair$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expense_items'::regclass
      AND tgname = 'a00_ie_item_owned_payload_freeze'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expense_items
      ENABLE TRIGGER a00_ie_item_owned_payload_freeze;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expenses'::regclass
      AND tgname = 'a00_ie_owned_payload_freeze'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expenses
      ENABLE TRIGGER a00_ie_owned_payload_freeze;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.income_expenses'::regclass
      AND tgname = 'trg_ie_handover_guard'
      AND NOT tgisinternal
  ) THEN
    ALTER TABLE public.income_expenses
      ENABLE TRIGGER trg_ie_handover_guard;
  END IF;
END;
$$;

SELECT app_private.end_accounting_chain_write_v1();

COMMIT;

NOTIFY pgrst, 'reload schema';
