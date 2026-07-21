-- Deterministic historical repair for payment-linked vouchers. Existing rows
-- remain in place and are reclassified as INTERNAL; canonical replacement
-- lines and compensating credit entries preserve a complete audit trail.

BEGIN;

SELECT app_private.begin_accounting_chain_write_v1();

CREATE TABLE IF NOT EXISTS public.accounting_repair_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  repair_code text NOT NULL,
  before_snapshot jsonb NOT NULL,
  after_snapshot jsonb NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  repaired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  repaired_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_repair_audit_entity_code_uq
  ON public.accounting_repair_audit(entity_type, entity_id, repair_code);
CREATE INDEX IF NOT EXISTS accounting_repair_audit_org_idx
  ON public.accounting_repair_audit(organization_id, repaired_at);

CREATE TABLE IF NOT EXISTS public.accounting_integrity_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  exception_code text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolution_note text,
  CONSTRAINT accounting_integrity_exceptions_status_check
    CHECK (status IN ('OPEN', 'RESOLVED', 'IGNORED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS accounting_integrity_exceptions_open_uq
  ON public.accounting_integrity_exceptions(entity_type, entity_id, exception_code)
  WHERE status = 'OPEN';

ALTER TABLE public.accounting_repair_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_integrity_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS accounting_repair_audit_read ON public.accounting_repair_audit;
CREATE POLICY accounting_repair_audit_read
ON public.accounting_repair_audit FOR SELECT TO authenticated
USING (public._profit_can_read_audit_v2(organization_id));

DROP POLICY IF EXISTS accounting_integrity_exceptions_read
  ON public.accounting_integrity_exceptions;
CREATE POLICY accounting_integrity_exceptions_read
ON public.accounting_integrity_exceptions FOR SELECT TO authenticated
USING (public._profit_can_read_audit_v2(organization_id));

REVOKE ALL ON public.accounting_repair_audit
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.accounting_integrity_exceptions
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.accounting_repair_audit TO authenticated;
GRANT SELECT ON public.accounting_integrity_exceptions TO authenticated;

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

-- Stamp legacy reversals before rebuilding invoice paid_amount. The controlled
-- guard permits only the dedicated reversal columns in this transaction.
SELECT set_config('app.invoice_collection_reversal_v5', 'on', true);
UPDATE public.payments payment
SET reversed_at = reversal.created_at
FROM app_private.payment_reversals reversal
WHERE reversal.original_payment_id = payment.id
  AND payment.reversed_at IS NULL;

-- Record any live gross-era returned-change voucher that cannot be paired
-- uniquely. The exact name prefix is essential: payment reversal vouchers use
-- the same generic "Tiền thối" category but are not customer change.
WITH returned_change_expenses AS (
  SELECT
    expense.id,
    expense.organization_id,
    expense.invoice_id,
    expense.voucher_date,
    expense.total_amount AS change_amount
  FROM public.income_expenses expense
  WHERE expense.payment_collection_id IS NULL
    AND expense.payment_id IS NULL
    AND expense.type = 'EXPENSE'
    AND expense.approval_status = 'APPROVED'
    AND expense.deleted_at IS NULL
    AND expense.total_amount > 0
    AND lower(btrim(expense.name)) LIKE ANY (ARRAY[
      'tiền thối hoá đơn%',
      'tiền thối hóa đơn%'
    ])
), candidate_base AS (
  SELECT DISTINCT
    expense.id AS expense_id,
    payment.id AS payment_id,
    CASE payment.payment_method::text
      WHEN 'TM' THEN 0
      WHEN 'TK' THEN 1
      ELSE 2
    END AS method_priority,
    payment.amount AS payment_amount
  FROM returned_change_expenses expense
  JOIN public.income_expenses source_voucher
    ON source_voucher.organization_id = expense.organization_id
   AND source_voucher.invoice_id = expense.invoice_id
   AND source_voucher.voucher_date = expense.voucher_date
   AND source_voucher.type = 'INCOME'
   AND source_voucher.deleted_at IS NULL
   AND source_voucher.payment_id IS NOT NULL
  JOIN public.payments payment
    ON payment.id = source_voucher.payment_id
   AND payment.organization_id = expense.organization_id
   AND payment.collection_id IS NULL
   AND payment.amount >= expense.change_amount
), ranked_candidates AS (
  SELECT
    candidate.*,
    dense_rank() OVER (
      PARTITION BY candidate.expense_id
      ORDER BY candidate.method_priority, candidate.payment_amount DESC
    ) AS preference_rank
  FROM candidate_base candidate
), candidate_summary AS (
  SELECT
    expense.id AS expense_id,
    count(candidate.payment_id)::integer AS candidate_count,
    count(candidate.payment_id) FILTER (
      WHERE candidate.preference_rank = 1
    )::integer AS top_candidate_count
  FROM returned_change_expenses expense
  LEFT JOIN ranked_candidates candidate ON candidate.expense_id = expense.id
  GROUP BY expense.id
)
INSERT INTO public.accounting_integrity_exceptions (
  organization_id, entity_type, entity_id, exception_code, details
)
SELECT
  expense.organization_id,
  'INCOME_EXPENSE',
  expense.id,
  CASE
    WHEN summary.candidate_count = 0
      THEN 'UNMATCHED_LEGACY_CHANGE_EXPENSE'
    ELSE 'AMBIGUOUS_LEGACY_CHANGE_EXPENSE'
  END,
  jsonb_build_object(
    'invoice_id', expense.invoice_id,
    'voucher_date', expense.voucher_date,
    'change_amount', expense.change_amount,
    'candidate_count', summary.candidate_count,
    'top_candidate_count', summary.top_candidate_count
  )
FROM returned_change_expenses expense
JOIN candidate_summary summary ON summary.expense_id = expense.id
WHERE summary.top_candidate_count <> 1
ON CONFLICT DO NOTHING;

DO $repair$
DECLARE
  v_payment record;
  v_voucher_id uuid;
  v_voucher_count integer;
  v_voucher_total numeric;
  v_before_items jsonb;
  v_after_items jsonb;
  v_deposit_due numeric;
  v_revenue_due numeric;
  v_applied numeric;
  v_credit numeric;
  v_deposit_before numeric;
  v_deposit_after numeric;
  v_expected_deposit numeric;
  v_expected_revenue numeric;
  v_revenue_type uuid;
  v_deposit_type uuid;
  v_credit_type uuid;
  v_actual_revenue numeric;
  v_actual_deposit numeric;
  v_actual_item_credit numeric;
  v_actual_credit numeric;
  v_credit_delta numeric;
  v_needs_reclassification boolean;
BEGIN
  FOR v_payment IN
    SELECT
      payment.id,
      payment.organization_id,
      payment.user_id,
      payment.invoice_id,
      payment.amount,
      semantics.retained_amount,
      semantics.change_amount AS returned_change_amount,
      semantics.rounding_amount AS legacy_rounding_amount,
      semantics.metadata_change_amount,
      semantics.gross_era_change_amount,
      semantics.gross_era_expense_count,
      semantics.unresolved_change_expense_count,
      semantics.voucher_count,
      semantics.voucher_id,
      semantics.voucher_total_amount,
      payment.payment_date,
      payment.created_at,
      payment.reversed_at,
      invoice.contract_id,
      invoice.building_id,
      invoice.total_amount,
      invoice.billing_month,
      COALESCE(
        sum(
          CASE
            WHEN payment.reversed_at IS NULL THEN semantics.retained_amount
            ELSE 0
          END
        ) OVER (
          PARTITION BY payment.invoice_id
          ORDER BY payment.payment_date, payment.created_at, payment.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ),
        0
      ) AS paid_before
    FROM public.legacy_payment_receipt_semantics semantics
    JOIN public.payments payment ON payment.id = semantics.id
    JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    ORDER BY payment.invoice_id, payment.payment_date, payment.created_at, payment.id
  LOOP
    v_voucher_count := v_payment.voucher_count;
    v_voucher_id := v_payment.voucher_id;
    v_voucher_total := v_payment.voucher_total_amount;

    IF v_voucher_count <> 1 THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_payment.organization_id, 'PAYMENT', v_payment.id,
        'PAYMENT_VOUCHER_COUNT',
        jsonb_build_object('voucher_count', v_voucher_count)
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    IF v_payment.unresolved_change_expense_count > 0 THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_payment.organization_id, 'PAYMENT', v_payment.id,
        'UNRESOLVED_LEGACY_CHANGE_CONTEXT',
        jsonb_build_object(
          'invoice_id', v_payment.invoice_id,
          'payment_date', v_payment.payment_date,
          'unresolved_expense_count', v_payment.unresolved_change_expense_count
        )
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    IF v_payment.metadata_change_amount > 0
       AND v_payment.gross_era_change_amount > 0 THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_payment.organization_id, 'PAYMENT', v_payment.id,
        'CONFLICTING_LEGACY_CHANGE_EVIDENCE',
        jsonb_build_object(
          'metadata_change', v_payment.metadata_change_amount,
          'gross_era_change', v_payment.gross_era_change_amount,
          'gross_era_expense_count', v_payment.gross_era_expense_count
        )
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    v_applied := LEAST(
      v_payment.retained_amount,
      GREATEST(v_payment.total_amount - v_payment.paid_before, 0)
    );
    v_credit := GREATEST(v_payment.retained_amount - v_applied, 0);

    -- Backfill explicit semantics without rewriting the legacy amount column.
    -- Normalized metadata rows are already retained; only a paired live
    -- gross-era change expense is subtracted by the shared semantics view.
    UPDATE public.payments
       SET received_amount = v_payment.retained_amount,
           credit_amount = v_credit,
           change_amount = v_payment.returned_change_amount,
           rounding_amount = v_payment.legacy_rounding_amount
     WHERE id = v_payment.id
       AND (
         received_amount IS DISTINCT FROM v_payment.retained_amount
         OR credit_amount IS DISTINCT FROM v_credit
         OR change_amount IS DISTINCT FROM v_payment.returned_change_amount
         OR rounding_amount IS DISTINCT FROM v_payment.legacy_rounding_amount
       );

    IF abs(v_voucher_total - v_payment.amount) >= 0.01 THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_payment.organization_id, 'PAYMENT', v_payment.id,
        'PAYMENT_VOUCHER_TOTAL_MISMATCH',
        jsonb_build_object(
          'payment_amount', v_payment.amount,
          'voucher_amount', v_voucher_total,
          'voucher_id', v_voucher_id
        )
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    SELECT
      COALESCE(sum(item.amount) FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0)
      + COALESCE((
        SELECT sum((source_row->>'amount')::numeric)
        FROM jsonb_array_elements(
          COALESCE(invoice.previous_debt_sources, '[]'::jsonb)
        ) source_row
        WHERE source_row->>'type' = 'deposit'
      ), 0)
      INTO v_deposit_due
    FROM public.invoices invoice
    LEFT JOIN public.invoice_items item ON item.invoice_id = invoice.id
    WHERE invoice.id = v_payment.invoice_id
    GROUP BY invoice.id, invoice.previous_debt_sources;

    v_deposit_due := COALESCE(v_deposit_due, 0);
    IF v_deposit_due - v_payment.total_amount >= 0.01 THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_payment.organization_id, 'INVOICE', v_payment.invoice_id,
        'DEPOSIT_EXCEEDS_INVOICE_TOTAL',
        jsonb_build_object(
          'deposit_due', v_deposit_due,
          'invoice_total', v_payment.total_amount
        )
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    v_revenue_due := GREATEST(v_payment.total_amount - v_deposit_due, 0);
    v_deposit_before := GREATEST(
      LEAST(v_deposit_due, v_payment.paid_before - v_revenue_due),
      0
    );
    v_deposit_after := GREATEST(
      LEAST(v_deposit_due, v_payment.paid_before + v_applied - v_revenue_due),
      0
    );
    v_expected_deposit := v_deposit_after - v_deposit_before;
    v_expected_revenue := v_applied - v_expected_deposit;

    SELECT type_row.id INTO v_revenue_type
    FROM public.income_expense_types type_row
    WHERE type_row.organization_id = v_payment.organization_id
      AND lower(type_row.type) = 'income'
      AND NOT type_row.is_deposit
    ORDER BY type_row.is_default DESC,
             CASE WHEN lower(btrim(type_row.name)) IN (
               'thu tiền hoá đơn', 'thu tiền hóa đơn'
             ) THEN 0 ELSE 1 END,
             type_row.created_at
    LIMIT 1;

    SELECT type_row.id INTO v_deposit_type
    FROM public.income_expense_types type_row
    WHERE type_row.organization_id = v_payment.organization_id
      AND lower(type_row.type) = 'income'
      AND type_row.is_deposit
    ORDER BY CASE WHEN lower(btrim(type_row.name)) = 'tiền cọc' THEN 0 ELSE 1 END,
             type_row.created_at
    LIMIT 1;

    SELECT type_row.id INTO v_credit_type
    FROM public.income_expense_types type_row
    WHERE type_row.organization_id = v_payment.organization_id
      AND lower(type_row.type) = 'income'
      AND lower(btrim(type_row.name)) = 'tiền khách trả thừa'
    ORDER BY type_row.created_at
    LIMIT 1;

    IF v_expected_revenue > 0 AND v_revenue_type IS NULL
       OR v_expected_deposit > 0 AND v_deposit_type IS NULL THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_payment.organization_id, 'PAYMENT', v_payment.id,
        'MISSING_ACCOUNTING_TYPE',
        jsonb_build_object(
          'expected_revenue', v_expected_revenue,
          'expected_deposit', v_expected_deposit
        )
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    IF v_credit > 0 AND v_credit_type IS NULL THEN
      INSERT INTO public.income_expense_types (
        organization_id, user_id, name, type, description,
        is_default, is_deposit
      ) VALUES (
        v_payment.organization_id, v_payment.user_id,
        'Tiền khách trả thừa', 'income',
        'Khoản khách trả dư giữ lại để cấn kỳ sau; ngoài KQKD',
        false, false
      ) RETURNING id INTO v_credit_type;
    END IF;

    SELECT
      COALESCE(sum(item.amount) FILTER (WHERE item.accounting_class = 'PNL'), 0),
      COALESCE(sum(item.amount) FILTER (WHERE item.accounting_class = 'DEPOSIT'), 0),
      COALESCE(sum(item.amount) FILTER (
        WHERE item.accounting_class = 'CUSTOMER_CREDIT'
      ), 0)
    INTO v_actual_revenue, v_actual_deposit, v_actual_item_credit
    FROM public.income_expense_items item
    WHERE item.income_expense_id = v_voucher_id;

    SELECT COALESCE(sum(excess.amount), 0)
      INTO v_actual_credit
    FROM public.excess_amounts excess
    WHERE excess.source_payment_id = v_payment.id;
    v_credit_delta := v_credit - v_actual_credit;
    v_needs_reclassification :=
      abs(v_actual_revenue - v_expected_revenue) >= 0.01
      OR abs(v_actual_deposit - v_expected_deposit) >= 0.01
      OR abs(v_actual_item_credit - v_credit) >= 0.01;

    IF NOT v_needs_reclassification
       AND (v_payment.reversed_at IS NOT NULL OR abs(v_credit_delta) < 0.01) THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id), '[]'::jsonb)
      INTO v_before_items
    FROM public.income_expense_items item
    WHERE item.income_expense_id = v_voucher_id;

    IF v_needs_reclassification THEN
      UPDATE public.income_expense_items
         SET accounting_class = 'INTERNAL',
             unit_price = 0,
             amount = 0
       WHERE income_expense_id = v_voucher_id;
    END IF;

    IF v_needs_reclassification AND v_expected_revenue > 0 THEN
      INSERT INTO public.income_expense_items (
        income_expense_id, organization_id, income_expense_type_id,
        description, quantity, unit_price, amount, start_date, end_date,
        accounting_class
      ) VALUES (
        v_voucher_id, v_payment.organization_id, v_revenue_type,
        '[Accounting repair] Invoice revenue', 1,
        v_expected_revenue, v_expected_revenue,
        v_payment.payment_date, v_payment.payment_date, 'PNL'
      );
    END IF;

    IF v_needs_reclassification AND v_expected_deposit > 0 THEN
      INSERT INTO public.income_expense_items (
        income_expense_id, organization_id, income_expense_type_id,
        description, quantity, unit_price, amount, start_date, end_date,
        accounting_class
      ) VALUES (
        v_voucher_id, v_payment.organization_id, v_deposit_type,
        '[Accounting repair] Contract deposit', 1,
        v_expected_deposit, v_expected_deposit,
        v_payment.payment_date, v_payment.payment_date, 'DEPOSIT'
      );
    END IF;

    IF v_needs_reclassification AND v_credit > 0 THEN
      INSERT INTO public.income_expense_items (
        income_expense_id, organization_id, income_expense_type_id,
        description, quantity, unit_price, amount, start_date, end_date,
        accounting_class
      ) VALUES (
        v_voucher_id, v_payment.organization_id, v_credit_type,
        '[Accounting repair] Customer credit', 1,
        v_credit, v_credit,
        v_payment.payment_date, v_payment.payment_date, 'CUSTOMER_CREDIT'
      );
    END IF;

    IF v_needs_reclassification THEN
      PERFORM public.recompute_ie_business_result(v_voucher_id);
    END IF;

    SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id), '[]'::jsonb)
      INTO v_after_items
    FROM public.income_expense_items item
    WHERE item.income_expense_id = v_voucher_id;

    IF abs(v_credit_delta) >= 0.01 AND v_payment.reversed_at IS NULL THEN
      IF v_payment.contract_id IS NULL THEN
        INSERT INTO public.accounting_integrity_exceptions (
          organization_id, entity_type, entity_id, exception_code, details
        ) VALUES (
          v_payment.organization_id, 'PAYMENT', v_payment.id,
          'CREDIT_WITHOUT_CONTRACT',
          jsonb_build_object('credit_delta', v_credit_delta)
        ) ON CONFLICT DO NOTHING;
      ELSE
        INSERT INTO public.excess_amounts (
          organization_id, user_id, contract_id, amount, description,
          source_invoice_id, source_payment_id
        ) VALUES (
          v_payment.organization_id, v_payment.user_id, v_payment.contract_id,
          v_credit_delta,
          '[Accounting repair] Compensating customer credit entry',
          v_payment.invoice_id, v_payment.id
        );
      END IF;
    END IF;

    INSERT INTO public.accounting_repair_audit (
      organization_id, entity_type, entity_id, repair_code,
      before_snapshot, after_snapshot, details
    ) VALUES (
      v_payment.organization_id, 'INCOME_EXPENSE', v_voucher_id,
      CASE WHEN v_needs_reclassification
        THEN 'PAYMENT_ACCOUNTING_RECLASSIFICATION'
        ELSE 'CUSTOMER_CREDIT_COMPENSATION'
      END,
      v_before_items, v_after_items,
      jsonb_build_object(
        'payment_id', v_payment.id,
        'invoice_id', v_payment.invoice_id,
        'expected_revenue', v_expected_revenue,
        'expected_deposit', v_expected_deposit,
        'expected_credit', v_credit,
        'credit_before', v_actual_credit,
        'credit_compensation', CASE
          WHEN v_payment.reversed_at IS NULL THEN v_credit_delta ELSE 0
        END
      )
    ) ON CONFLICT DO NOTHING;

    IF v_needs_reclassification
       AND v_payment.billing_month ~ '^\d{4}-\d{2}$' THEN
      UPDATE public.profit_monthly pm
         SET is_stale = true,
             stale_reason = left(
               'ACCOUNTING_RECLASSIFICATION payment ' || v_payment.id::text,
               1000
             )
       WHERE pm.organization_id = v_payment.organization_id
         AND pm.building_id = v_payment.building_id
         AND pm.period_month = to_date(v_payment.billing_month, 'YYYY-MM')
         AND pm.status = 'LOCKED';
    END IF;
  END LOOP;
END
$repair$;

-- Rebuild legacy reversal vouchers from the repaired source allocation, and
-- restore deterministic account/effective date metadata.
DO $reversal$
DECLARE
  v_row record;
  v_source_voucher uuid;
  v_source_count integer;
  v_source_account uuid;
  v_source_total numeric;
  v_reversal_total numeric;
  v_reversal_type uuid;
  v_before jsonb;
  v_after jsonb;
  v_item record;
BEGIN
  FOR v_row IN
    SELECT
      reversal.original_payment_id,
      reversal.reversal_voucher_id,
      reversal.organization_id,
      reversal.actor_id,
      reversal.created_at,
      payment.invoice_id
    FROM app_private.payment_reversals reversal
    JOIN public.payments payment ON payment.id = reversal.original_payment_id
    ORDER BY reversal.created_at, reversal.original_payment_id
  LOOP
    SELECT count(*),
           (array_agg(voucher.id ORDER BY voucher.id))[1],
           (array_agg(voucher.account_id ORDER BY voucher.id)
             FILTER (WHERE voucher.account_id IS NOT NULL))[1],
           min(voucher.total_amount)
      INTO v_source_count, v_source_voucher, v_source_account, v_source_total
    FROM public.income_expenses voucher
    WHERE voucher.payment_id = v_row.original_payment_id
      AND voucher.type = 'INCOME'
      AND voucher.deleted_at IS NULL;

    SELECT voucher.total_amount INTO v_reversal_total
    FROM public.income_expenses voucher
    WHERE voucher.id = v_row.reversal_voucher_id
      AND voucher.type = 'EXPENSE'
      AND voucher.deleted_at IS NULL;

    IF v_source_count <> 1 OR v_reversal_total IS NULL THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_row.organization_id, 'PAYMENT', v_row.original_payment_id,
        'REVERSAL_SOURCE_AMBIGUOUS',
        jsonb_build_object(
          'source_voucher_count', v_source_count,
          'reversal_voucher_id', v_row.reversal_voucher_id
        )
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    IF abs(v_source_total - v_reversal_total) >= 0.01 THEN
      INSERT INTO public.accounting_integrity_exceptions (
        organization_id, entity_type, entity_id, exception_code, details
      ) VALUES (
        v_row.organization_id, 'INCOME_EXPENSE', v_row.reversal_voucher_id,
        'REVERSAL_TOTAL_MISMATCH',
        jsonb_build_object(
          'source_total', v_source_total,
          'reversal_total', v_reversal_total
        )
      ) ON CONFLICT DO NOTHING;
      CONTINUE;
    END IF;

    SELECT jsonb_build_object(
      'voucher', to_jsonb(voucher),
      'items', COALESCE((
        SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
        FROM public.income_expense_items item
        WHERE item.income_expense_id = voucher.id
      ), '[]'::jsonb)
    ) INTO v_before
    FROM public.income_expenses voucher
    WHERE voucher.id = v_row.reversal_voucher_id;

    UPDATE public.income_expenses
       SET account_id = v_source_account,
           voucher_date = (v_row.created_at AT TIME ZONE 'Asia/Bangkok')::date,
           reversal_of_income_expense_id = v_source_voucher
     WHERE id = v_row.reversal_voucher_id;

    SELECT type_row.id INTO v_reversal_type
    FROM public.income_expense_types type_row
    WHERE type_row.organization_id = v_row.organization_id
      AND lower(type_row.type) = 'expense'
      AND lower(btrim(type_row.name)) = 'hoàn tác thu tiền'
    ORDER BY type_row.created_at
    LIMIT 1;
    IF v_reversal_type IS NULL THEN
      INSERT INTO public.income_expense_types (
        organization_id, user_id, name, type, description,
        is_default, is_deposit
      ) VALUES (
        v_row.organization_id, v_row.actor_id,
        'Hoàn tác thu tiền', 'expense',
        'Bút toán đối ứng cho khoản thu đã hoàn tác', false, false
      ) RETURNING id INTO v_reversal_type;
    END IF;

    UPDATE public.income_expense_items
       SET accounting_class = 'INTERNAL',
           unit_price = 0,
           amount = 0
     WHERE income_expense_id = v_row.reversal_voucher_id;

    FOR v_item IN
      SELECT item.accounting_class, item.amount
      FROM public.income_expense_items item
      WHERE item.income_expense_id = v_source_voucher
        AND item.accounting_class IN ('PNL', 'DEPOSIT', 'CUSTOMER_CREDIT')
      ORDER BY item.created_at, item.id
    LOOP
      INSERT INTO public.income_expense_items (
        income_expense_id, organization_id, income_expense_type_id,
        description, quantity, unit_price, amount, start_date, end_date,
        accounting_class
      ) VALUES (
        v_row.reversal_voucher_id, v_row.organization_id, v_reversal_type,
        '[Accounting repair] Reversal ' || v_item.accounting_class,
        1, v_item.amount, v_item.amount,
        (v_row.created_at AT TIME ZONE 'Asia/Bangkok')::date,
        (v_row.created_at AT TIME ZONE 'Asia/Bangkok')::date,
        v_item.accounting_class
      );
    END LOOP;

    PERFORM public.recompute_ie_business_result(v_row.reversal_voucher_id);
    PERFORM public.recompute_invoice_for_id(v_row.invoice_id);

    SELECT jsonb_build_object(
      'voucher', to_jsonb(voucher),
      'items', COALESCE((
        SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
        FROM public.income_expense_items item
        WHERE item.income_expense_id = voucher.id
      ), '[]'::jsonb)
    ) INTO v_after
    FROM public.income_expenses voucher
    WHERE voucher.id = v_row.reversal_voucher_id;

    INSERT INTO public.accounting_repair_audit (
      organization_id, entity_type, entity_id, repair_code,
      before_snapshot, after_snapshot, details
    ) VALUES (
      v_row.organization_id, 'INCOME_EXPENSE', v_row.reversal_voucher_id,
      'PAYMENT_REVERSAL_REPAIR', v_before, v_after,
      jsonb_build_object(
        'original_payment_id', v_row.original_payment_id,
        'source_voucher_id', v_source_voucher
      )
    ) ON CONFLICT DO NOTHING;
  END LOOP;
END
$reversal$;

DO $$
DECLARE
  v_contract_id uuid;
  v_invoice_id uuid;
BEGIN
  FOR v_contract_id IN
    SELECT DISTINCT contract_id
    FROM public.income_expenses
    WHERE contract_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.accounting_repair_audit audit
        WHERE audit.entity_type = 'INCOME_EXPENSE'
          AND audit.entity_id = income_expenses.id
      )
  LOOP
    PERFORM public.recompute_contract_deposit_paid(v_contract_id);
  END LOOP;

  FOR v_invoice_id IN
    SELECT DISTINCT payment.invoice_id
    FROM public.payments payment
    WHERE EXISTS (
      SELECT 1 FROM public.accounting_repair_audit audit
      JOIN public.income_expenses voucher ON voucher.id = audit.entity_id
      WHERE audit.entity_type = 'INCOME_EXPENSE'
        AND voucher.payment_id = payment.id
    )
  LOOP
    PERFORM public.recompute_invoice_for_id(v_invoice_id);
  END LOOP;
END;
$$;

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
