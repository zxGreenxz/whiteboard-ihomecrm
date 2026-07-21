-- Reporting must ignore append-only payment rows after a controlled reversal.

BEGIN;

CREATE OR REPLACE VIEW public.active_payments
WITH (security_invoker = true)
AS
SELECT payment.*
FROM public.payments payment
WHERE payment.reversed_at IS NULL;

REVOKE ALL ON public.active_payments FROM PUBLIC, anon;
GRANT SELECT ON public.active_payments TO authenticated, service_role;

COMMENT ON VIEW public.active_payments IS
  'Security-invoker projection of payments that are still economically active.';

-- Legacy payment semantics changed over time. Normalized rows store retained
-- cash in payments.amount and returned change on the linked INCOME voucher.
-- A short-lived older flow stored gross cash plus a separate live expense named
-- "Tiền thối hóa đơn...". Match that exact flow deterministically; never infer
-- returned change merely from the generic "Tiền thối" category because legacy
-- payment reversals intentionally use the same category.
CREATE OR REPLACE VIEW public.legacy_payment_receipt_semantics
WITH (security_invoker = true)
AS
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
), change_candidate_base AS (
  SELECT DISTINCT
    expense.id AS expense_id,
    expense.change_amount,
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
), ranked_change_candidates AS (
  SELECT
    candidate.*,
    dense_rank() OVER (
      PARTITION BY candidate.expense_id
      ORDER BY candidate.method_priority, candidate.payment_amount DESC
    ) AS preference_rank,
    count(*) OVER (
      PARTITION BY candidate.expense_id,
                   candidate.method_priority,
                   candidate.payment_amount
    ) AS preference_peer_count
  FROM change_candidate_base candidate
), change_candidate_summary AS (
  SELECT
    expense.id AS expense_id,
    count(candidate.payment_id)::integer AS candidate_count,
    count(candidate.payment_id) FILTER (
      WHERE candidate.preference_rank = 1
    )::integer AS top_candidate_count
  FROM returned_change_expenses expense
  LEFT JOIN ranked_change_candidates candidate
    ON candidate.expense_id = expense.id
  GROUP BY expense.id
), paired_change_expenses AS (
  SELECT
    candidate.expense_id,
    candidate.payment_id,
    candidate.change_amount
  FROM ranked_change_candidates candidate
  WHERE candidate.preference_rank = 1
    AND candidate.preference_peer_count = 1
), paired_change_by_payment AS (
  SELECT
    pair.payment_id,
    sum(pair.change_amount) AS change_amount,
    count(*)::integer AS expense_count
  FROM paired_change_expenses pair
  GROUP BY pair.payment_id
), unresolved_change_by_invoice_date AS (
  SELECT
    expense.organization_id,
    expense.invoice_id,
    expense.voucher_date,
    count(*)::integer AS expense_count
  FROM returned_change_expenses expense
  JOIN change_candidate_summary summary ON summary.expense_id = expense.id
  WHERE summary.top_candidate_count <> 1
  GROUP BY expense.organization_id, expense.invoice_id, expense.voucher_date
), semantic_base AS (
  SELECT
    payment.id,
    payment.organization_id,
    payment.invoice_id,
    payment.payment_method,
    payment.payment_date,
    payment.receipt_number,
    payment.receipt_image_url,
    payment.created_at,
    payment.reversed_at,
    source_voucher.id AS voucher_id,
    source_voucher.account_id,
    source_voucher.total_amount AS voucher_total_amount,
    source_stats.voucher_count,
    payment.amount AS stored_payment_amount,
    COALESCE(paired_change.change_amount, 0) AS gross_era_change_amount,
    COALESCE(paired_change.expense_count, 0) AS gross_era_expense_count,
    COALESCE(unresolved_change.expense_count, 0)
      AS unresolved_change_expense_count,
    COALESCE(
      payment.received_amount,
      CASE
        WHEN payment.change_amount > 0
          OR COALESCE(source_voucher.change_amount, 0) > 0
          THEN payment.amount
        ELSE GREATEST(
          payment.amount - COALESCE(paired_change.change_amount, 0),
          0
        )
      END
    ) AS retained_amount,
    GREATEST(COALESCE(
      NULLIF(payment.credit_amount, 0),
      NULLIF(credit.total_amount, 0),
      0
    ), 0) AS credit_amount,
    GREATEST(COALESCE(
      NULLIF(payment.change_amount, 0),
      NULLIF(source_voucher.change_amount, 0),
      0
    ), 0) AS metadata_change_amount,
    GREATEST(COALESCE(
      NULLIF(payment.change_amount, 0),
      NULLIF(source_voucher.change_amount, 0),
      NULLIF(paired_change.change_amount, 0),
      0
    ), 0) AS change_amount,
    GREATEST(COALESCE(
      NULLIF(payment.rounding_amount, 0),
      NULLIF(source_voucher.rounding_amount, 0),
      0
    ), 0) AS rounding_amount
  FROM public.payments payment
  LEFT JOIN LATERAL (
    SELECT
      count(*)::integer AS voucher_count,
      (array_agg(
        income.id ORDER BY
          (income.approval_status = 'APPROVED') DESC,
          income.created_at,
          income.id
      ))[1] AS voucher_id
    FROM public.income_expenses income
    WHERE income.payment_id = payment.id
      AND income.organization_id = payment.organization_id
      AND income.type = 'INCOME'
      AND income.deleted_at IS NULL
  ) source_stats ON true
  LEFT JOIN public.income_expenses source_voucher
    ON source_voucher.id = source_stats.voucher_id
  LEFT JOIN paired_change_by_payment paired_change
    ON paired_change.payment_id = payment.id
  LEFT JOIN unresolved_change_by_invoice_date unresolved_change
    ON unresolved_change.organization_id = payment.organization_id
   AND unresolved_change.invoice_id = payment.invoice_id
   AND unresolved_change.voucher_date = payment.payment_date
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(GREATEST(excess.amount, 0)), 0) AS total_amount
    FROM public.excess_amounts excess
    WHERE excess.source_payment_id = payment.id
  ) credit ON true
  WHERE payment.collection_id IS NULL
)
SELECT
  semantic.id,
  semantic.organization_id,
  semantic.invoice_id,
  semantic.payment_method,
  semantic.payment_date,
  semantic.retained_amount + semantic.change_amount AS gross_amount,
  semantic.retained_amount,
  GREATEST(semantic.retained_amount - semantic.credit_amount, 0)
    AS applied_amount,
  semantic.credit_amount,
  semantic.change_amount,
  semantic.rounding_amount,
  semantic.receipt_number,
  semantic.receipt_image_url,
  semantic.created_at,
  semantic.reversed_at,
  semantic.voucher_id,
  semantic.account_id,
  semantic.voucher_total_amount,
  semantic.voucher_count,
  semantic.stored_payment_amount,
  semantic.metadata_change_amount,
  semantic.gross_era_change_amount,
  semantic.gross_era_expense_count,
  semantic.unresolved_change_expense_count
FROM semantic_base semantic;

REVOKE ALL ON public.legacy_payment_receipt_semantics FROM PUBLIC, anon;
GRANT SELECT ON public.legacy_payment_receipt_semantics
  TO authenticated, service_role;

COMMENT ON VIEW public.legacy_payment_receipt_semantics IS
  'Normalized legacy receipt semantics: retained metadata rows stay net; only exact live gross-era change vouchers are subtracted.';

-- Cash collection reports use retained tender money. V5 stores the amount
-- applied to the invoice in payments.amount; history repair annotates legacy
-- rows with received_amount/credit_amount because legacy payments.amount was
-- the retained amount before any customer-credit split.
CREATE OR REPLACE VIEW public.active_payment_receipts
WITH (security_invoker = true)
AS
SELECT
  tender.id,
  'COLLECTION_TENDER'::text AS source_kind,
  tender.payment_id,
  collection.id AS collection_id,
  collection.organization_id,
  collection.invoice_id,
  tender.payment_method,
  collection.collection_date AS payment_date,
  tender.gross_amount,
  tender.retained_amount AS collected_amount,
  tender.applied_amount,
  tender.credit_amount,
  tender.change_amount,
  tender.rounding_amount,
  tender.receipt_number,
  CASE WHEN tender.line_index = 0 THEN collection.receipt_image_url END
    AS receipt_image_url,
  tender.created_at,
  tender.voucher_id,
  tender.account_id
FROM public.invoice_payment_tenders tender
JOIN public.invoice_payment_collections collection
  ON collection.id = tender.collection_id
 AND collection.organization_id = tender.organization_id
WHERE collection.status = 'ACTIVE'

UNION ALL

SELECT
  legacy.id,
  'LEGACY_PAYMENT'::text AS source_kind,
  legacy.id AS payment_id,
  NULL::uuid AS collection_id,
  legacy.organization_id,
  legacy.invoice_id,
  legacy.payment_method,
  legacy.payment_date,
  legacy.gross_amount,
  legacy.retained_amount AS collected_amount,
  legacy.applied_amount,
  legacy.credit_amount,
  legacy.change_amount,
  legacy.rounding_amount,
  legacy.receipt_number,
  legacy.receipt_image_url,
  legacy.created_at,
  legacy.voucher_id,
  legacy.account_id
FROM public.legacy_payment_receipt_semantics legacy
WHERE legacy.reversed_at IS NULL;

REVOKE ALL ON public.active_payment_receipts FROM PUBLIC, anon;
GRANT SELECT ON public.active_payment_receipts TO authenticated;

COMMENT ON VIEW public.active_payment_receipts IS
  'Active cash receipt lines. collected_amount includes customer credit but excludes returned change.';

-- Returning the invoices themselves lets PostgREST apply the remaining list
-- filters, count and range inside one server query. Fetching receipt IDs first
-- would both race reversals and hit the 1000-row response ceiling.
CREATE OR REPLACE FUNCTION public.invoice_payment_method_drilldown(
  p_payment_method public.payment_method
)
RETURNS SETOF public.invoices
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT invoice_row.*
  FROM public.invoices invoice_row
  WHERE EXISTS (
    SELECT 1
    FROM public.active_payment_receipts receipt
    WHERE receipt.invoice_id = invoice_row.id
      AND receipt.organization_id = invoice_row.organization_id
      AND receipt.payment_method = p_payment_method
      AND receipt.collected_amount > 0
  );
$$;

REVOKE ALL ON FUNCTION public.invoice_payment_method_drilldown(
  public.payment_method
) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_payment_method_drilldown(
  public.payment_method
) TO authenticated;

COMMENT ON FUNCTION public.invoice_payment_method_drilldown(
  public.payment_method
) IS
  'Security-invoker invoice source for active receipt-method drill-down with server-side filtering and pagination.';

-- The list page only needs four possible methods per visible invoice. Aggregate
-- them server-side so mixed-method highlighting cannot be truncated by row caps.
CREATE OR REPLACE FUNCTION public.invoice_active_payment_methods(
  p_invoice_ids uuid[]
)
RETURNS TABLE(invoice_id uuid, payment_methods text[])
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
  SELECT
    receipt.invoice_id,
    array_agg(
      DISTINCT receipt.payment_method::text
      ORDER BY receipt.payment_method::text
    ) AS payment_methods
  FROM public.active_payment_receipts receipt
  WHERE receipt.invoice_id = ANY(p_invoice_ids)
    AND receipt.collected_amount > 0
  GROUP BY receipt.invoice_id;
$$;

REVOKE ALL ON FUNCTION public.invoice_active_payment_methods(uuid[])
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.invoice_active_payment_methods(uuid[])
  TO authenticated;

COMMENT ON FUNCTION public.invoice_active_payment_methods(uuid[]) IS
  'Active retained receipt methods for a bounded invoice page; one aggregate row per invoice.';

-- Historical reports use signed economic events so a later reversal does not
-- erase the original period. V5 uses the explicit reversal_date; legacy rows
-- prefer the linked reversal voucher date and fall back to reversed_at::date.
CREATE OR REPLACE VIEW public.payment_receipt_events
WITH (security_invoker = true)
AS
SELECT
  tender.id AS source_id,
  'COLLECTION'::text AS event_kind,
  collection.organization_id,
  collection.invoice_id,
  collection.id AS collection_id,
  tender.payment_id,
  tender.payment_method,
  collection.collection_date AS payment_date,
  tender.retained_amount AS collected_amount,
  tender.applied_amount,
  tender.credit_amount,
  tender.created_at
FROM public.invoice_payment_tenders tender
JOIN public.invoice_payment_collections collection
  ON collection.id = tender.collection_id
 AND collection.organization_id = tender.organization_id

UNION ALL

SELECT
  tender.id AS source_id,
  'COLLECTION_REVERSAL'::text AS event_kind,
  collection.organization_id,
  collection.invoice_id,
  collection.id AS collection_id,
  tender.payment_id,
  tender.payment_method,
  collection.reversal_date AS payment_date,
  -tender.retained_amount AS collected_amount,
  -tender.applied_amount AS applied_amount,
  -tender.credit_amount AS credit_amount,
  collection.reversed_at AS created_at
FROM public.invoice_payment_tenders tender
JOIN public.invoice_payment_collections collection
  ON collection.id = tender.collection_id
 AND collection.organization_id = tender.organization_id
WHERE collection.status = 'REVERSED'
  AND collection.reversal_date IS NOT NULL

UNION ALL

SELECT
  legacy.id AS source_id,
  'LEGACY_PAYMENT'::text AS event_kind,
  legacy.organization_id,
  legacy.invoice_id,
  NULL::uuid AS collection_id,
  legacy.id AS payment_id,
  legacy.payment_method,
  legacy.payment_date,
  legacy.retained_amount AS collected_amount,
  legacy.applied_amount,
  legacy.credit_amount,
  legacy.created_at
FROM public.legacy_payment_receipt_semantics legacy

UNION ALL

SELECT
  legacy.id AS source_id,
  'LEGACY_REVERSAL'::text AS event_kind,
  legacy.organization_id,
  legacy.invoice_id,
  NULL::uuid AS collection_id,
  legacy.id AS payment_id,
  legacy.payment_method,
  COALESCE(reversal.event_date, legacy.reversed_at::date) AS payment_date,
  -legacy.retained_amount AS collected_amount,
  -legacy.applied_amount AS applied_amount,
  -legacy.credit_amount AS credit_amount,
  legacy.reversed_at AS created_at
FROM public.legacy_payment_receipt_semantics legacy
LEFT JOIN LATERAL (
  SELECT min(reversal_voucher.voucher_date) AS event_date
  FROM public.income_expenses source_voucher
  JOIN public.income_expenses reversal_voucher
    ON reversal_voucher.reversal_of_income_expense_id = source_voucher.id
   AND reversal_voucher.deleted_at IS NULL
   AND reversal_voucher.approval_status = 'APPROVED'
  WHERE source_voucher.payment_id = legacy.id
) reversal ON true
WHERE legacy.reversed_at IS NOT NULL;

REVOKE ALL ON public.payment_receipt_events FROM PUBLIC, anon;
GRANT SELECT ON public.payment_receipt_events TO authenticated;

COMMENT ON VIEW public.payment_receipt_events IS
  'Signed retained/applied receipt events using the economic collection or reversal date.';

-- Dashboard revenue is the invoice-linked P&L component, not deposit or credit.
-- Reversal vouchers remain append-only and offset their original income rows.
CREATE OR REPLACE VIEW public.invoice_pnl_cash_entries
WITH (security_invoker = true)
AS
SELECT
  voucher.id,
  voucher.organization_id,
  COALESCE(voucher.invoice_id, source_voucher.invoice_id, collection.invoice_id)
    AS invoice_id,
  COALESCE(voucher.building_id, source_voucher.building_id, invoice_row.building_id)
    AS building_id,
  voucher.voucher_date AS revenue_date,
  CASE voucher.type
    WHEN 'INCOME' THEN voucher.kqkd_amount
    WHEN 'EXPENSE' THEN -voucher.kqkd_amount
    ELSE 0
  END AS pnl_amount
FROM public.income_expenses voucher
LEFT JOIN public.income_expenses source_voucher
  ON source_voucher.id = voucher.reversal_of_income_expense_id
LEFT JOIN public.invoice_payment_collections collection
  ON collection.id = voucher.payment_collection_id
LEFT JOIN public.invoices invoice_row
  ON invoice_row.id = COALESCE(
    voucher.invoice_id, source_voucher.invoice_id, collection.invoice_id
  )
WHERE voucher.approval_status = 'APPROVED'
  AND voucher.deleted_at IS NULL
  AND voucher.kqkd_amount > 0
  AND (
    (voucher.type = 'INCOME' AND COALESCE(
      voucher.invoice_id, collection.invoice_id
    ) IS NOT NULL)
    OR (
      voucher.type = 'EXPENSE'
      AND voucher.reversal_of_income_expense_id IS NOT NULL
    )
  );

REVOKE ALL ON public.invoice_pnl_cash_entries FROM PUBLIC, anon;
GRANT SELECT ON public.invoice_pnl_cash_entries TO authenticated;

COMMENT ON VIEW public.invoice_pnl_cash_entries IS
  'Signed invoice-linked cash P&L entries. Deposit and customer credit have pnl_amount zero.';

DO $patch_reports$
DECLARE
  v_signature text;
  v_oid regprocedure;
  v_definition text;
  v_patched text;
  v_expected_hash text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.get_invoice_statistics_v2(uuid,uuid,public.invoice_status,date,date,text,text,uuid[])',
    'public.get_dashboard_summary(uuid)',
    'public.manager_collection_cycle_report(uuid,date,date)'
  ] LOOP
    v_oid := to_regprocedure(v_signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'Missing payment-report function %', v_signature;
    END IF;

    v_definition := pg_get_functiondef(v_oid);
    v_expected_hash := CASE v_signature
      WHEN 'public.get_invoice_statistics_v2(uuid,uuid,public.invoice_status,date,date,text,text,uuid[])'
        THEN '330a79a7addad089bfaae46e34944c01'
      WHEN 'public.get_dashboard_summary(uuid)'
        THEN '1f124c1740f601333845603e4b40c1bf'
      WHEN 'public.manager_collection_cycle_report(uuid,date,date)'
        THEN '8b4f61516781b743712cf88bd1dd2af9'
    END;
    IF md5(v_definition) IS DISTINCT FROM v_expected_hash THEN
      RAISE EXCEPTION
        'Payment-report function % drifted from the reviewed source definition',
        v_signature;
    END IF;

    v_patched := regexp_replace(
      v_definition,
      '\m(public\.)?payments\M',
      'public.active_payments',
      'gi'
    );
    IF v_signature LIKE 'public.get_invoice_statistics_v2(%' THEN
      v_patched := replace(
        v_patched,
        'FROM public.active_payments p',
        'FROM public.active_payment_receipts p'
      );
      v_patched := replace(v_patched, 'p.amount', 'p.collected_amount');
      IF v_patched !~ 'ie\.payment_collection_id IS NULL' THEN
        v_patched := replace(
          v_patched,
          'AND ie.type = ''INCOME''',
          'AND ie.type = ''INCOME''
    AND (
      ie.payment_collection_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.invoice_payment_collections active_collection
        WHERE active_collection.id = ie.payment_collection_id
          AND active_collection.status = ''ACTIVE''
      )
    )
    AND (
      ie.payment_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.active_payments active_payment
        WHERE active_payment.id = ie.payment_id
      )
    )'
        );
      END IF;
    ELSIF v_signature = 'public.get_dashboard_summary(uuid)' THEN
      v_patched := replace(
        v_patched,
        'v_pay_from date := (v_month_start AT TIME ZONE ''UTC'')::date;',
        'v_pay_from date := v_month_start_d;'
      );
      v_patched := replace(
        v_patched,
        'v_pay_to   date := ((v_next_month - interval ''1 millisecond'') AT TIME ZONE ''UTC'')::date;',
        'v_pay_to   date := (v_month_start_d + interval ''1 month - 1 day'')::date;'
      );
      v_patched := regexp_replace(
        v_patched,
        'SELECT COALESCE\(sum\(p\.amount\), 0\) INTO r_revenue[[:space:]]+FROM public\.active_payments p[[:space:]]+JOIN invoices i ON i\.id = p\.invoice_id AND i\.building_id = p_building_id[[:space:]]+WHERE p\.payment_date >= v_pay_from AND p\.payment_date <= v_pay_to;',
        $replacement$SELECT COALESCE(sum(entry.pnl_amount), 0) INTO r_revenue
      FROM public.invoice_pnl_cash_entries entry
      WHERE entry.building_id = p_building_id
        AND entry.revenue_date >= v_pay_from
        AND entry.revenue_date <= v_pay_to;$replacement$,
        'i'
      );
      v_patched := regexp_replace(
        v_patched,
        'SELECT COALESCE\(sum\(p\.amount\), 0\) INTO r_revenue[[:space:]]+FROM public\.active_payments p[[:space:]]+WHERE p\.payment_date >= v_pay_from AND p\.payment_date <= v_pay_to;',
        $replacement$SELECT COALESCE(sum(entry.pnl_amount), 0) INTO r_revenue
      FROM public.invoice_pnl_cash_entries entry
      WHERE entry.revenue_date >= v_pay_from
        AND entry.revenue_date <= v_pay_to;$replacement$,
        'i'
      );
      IF v_patched ~ 'sum\(p\.amount\).*r_revenue'
         OR v_patched !~ 'invoice_pnl_cash_entries'
         OR v_patched !~ 'v_pay_from date := v_month_start_d'
         OR v_patched !~ '1 month - 1 day' THEN
        RAISE EXCEPTION 'Dashboard revenue patch did not replace payment totals';
      END IF;
    ELSIF v_signature = 'public.manager_collection_cycle_report(uuid,date,date)' THEN
      v_patched := regexp_replace(
        v_patched,
        'SELECT COALESCE\(sum\(p\.amount\), 0\) INTO v_collected_period[[:space:]]+FROM public\.active_payments p',
        $replacement$SELECT COALESCE(sum(p.collected_amount), 0) INTO v_collected_period
    FROM (
      SELECT * FROM public.payment_receipt_events
      WHERE payment_method <> 'CT'
    ) p$replacement$,
        'i'
      );
      v_patched := regexp_replace(
        v_patched,
        'SELECT COALESCE\(sum\(p\.amount\), 0\) INTO v_seg[[:space:]]+FROM public\.active_payments p',
        $replacement$SELECT COALESCE(sum(p.collected_amount), 0) INTO v_seg
      FROM (
        SELECT * FROM public.payment_receipt_events
        WHERE payment_method <> 'CT'
      ) p$replacement$,
        'gi'
      );
      v_patched := regexp_replace(
        v_patched,
        'SELECT sum\(p\.amount\) AS paid FROM public\.active_payments p[[:space:]]+WHERE p\.invoice_id = i\.id AND p\.payment_date <= v_this',
        $replacement$SELECT sum(p.applied_amount) AS paid
        FROM public.payment_receipt_events p
         WHERE p.invoice_id = i.id AND p.payment_date <= v_this$replacement$,
        'i'
      );
      IF v_patched !~ 'payment_receipt_events' THEN
        RAISE EXCEPTION 'Manager collection report still lacks signed receipt events';
      END IF;
    END IF;
    IF v_patched = v_definition
       AND v_definition !~* '\m(active_payments|active_payment_receipts|payment_receipt_events|invoice_pnl_cash_entries)\M' THEN
      RAISE EXCEPTION 'Function % contains no patchable payments source', v_signature;
    END IF;
    EXECUTE v_patched;
  END LOOP;
END;
$patch_reports$;

COMMIT;

NOTIFY pgrst, 'reload schema';
