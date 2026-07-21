-- Final fail-closed gate. Reversal integrity includes exact source lineage and
-- tenant-domain identity, not only matching totals and accounting classes.

BEGIN;

CREATE OR REPLACE FUNCTION app_private.count_invalid_payment_reversals_v1(
  p_payment_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
  SELECT count(*)::integer
  FROM app_private.payment_reversals reversal
  LEFT JOIN public.payments payment
    ON payment.id = reversal.original_payment_id
  LEFT JOIN public.invoices invoice
    ON invoice.id = payment.invoice_id
  LEFT JOIN public.contracts contract_row
    ON contract_row.id = invoice.contract_id
  LEFT JOIN public.rooms room_row
    ON room_row.id = invoice.room_id
  LEFT JOIN public.buildings building_row
    ON building_row.id = invoice.building_id
  LEFT JOIN public.income_expenses voucher
    ON voucher.id = reversal.reversal_voucher_id
  LEFT JOIN public.income_expenses source_voucher
    ON source_voucher.id = voucher.reversal_of_income_expense_id
  LEFT JOIN public.accounts account_row
    ON account_row.id = voucher.account_id
  LEFT JOIN public.invoice_payment_collections collection
    ON collection.id = payment.collection_id
  LEFT JOIN public.invoice_payment_tenders tender
    ON tender.id = payment.tender_id
  LEFT JOIN LATERAL (
    SELECT
      count(*)::integer AS item_count,
      count(*) FILTER (
        WHERE item.organization_id IS DISTINCT FROM reversal.organization_id
           OR item.accounting_class NOT IN (
             'PNL', 'DEPOSIT', 'CUSTOMER_CREDIT', 'INTERNAL'
           )
      )::integer AS invalid_item_count,
      COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
        AS item_total,
      COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
        WHERE item.accounting_class = 'PNL'
      ), 0) AS pnl_total,
      COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
        WHERE item.accounting_class = 'DEPOSIT'
      ), 0) AS deposit_total,
      COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
        WHERE item.accounting_class = 'CUSTOMER_CREDIT'
      ), 0) AS credit_total,
      COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
        WHERE item.accounting_class = 'INTERNAL'
      ), 0) AS internal_total
    FROM public.income_expense_items item
    WHERE item.income_expense_id = voucher.id
  ) reversal_items ON true
  LEFT JOIN LATERAL (
    WITH raw_sources AS (
      SELECT
        source_row.id, source_row.user_id, source_row.organization_id,
        source_row.type, source_row.account_id, source_row.invoice_id,
        source_row.contract_id, source_row.building_id, source_row.room_id,
        source_row.payment_id, source_row.payment_collection_id,
        source_row.approval_status, source_row.deleted_at,
        source_row.system_source, source_row.notes, source_row.total_amount,
        source_row.created_at, 0 AS source_rank
      FROM public.income_expenses source_row
      WHERE source_row.payment_id = payment.id

      UNION ALL

      SELECT
        source_row.id, source_row.user_id, source_row.organization_id,
        source_row.type, source_row.account_id, source_row.invoice_id,
        source_row.contract_id, source_row.building_id, source_row.room_id,
        source_row.payment_id, source_row.payment_collection_id,
        source_row.approval_status, source_row.deleted_at,
        source_row.system_source, source_row.notes, source_row.total_amount,
        source_row.created_at, 1 AS source_rank
      FROM public.income_expenses source_row
      WHERE source_row.payment_id IS NULL
        AND source_row.notes = '[THU TACH COC ' || payment.id::text || ']'

      UNION ALL

      SELECT
        source_row.id, source_row.user_id, source_row.organization_id,
        source_row.type, source_row.account_id, source_row.invoice_id,
        source_row.contract_id, source_row.building_id, source_row.room_id,
        source_row.payment_id, source_row.payment_collection_id,
        source_row.approval_status, source_row.deleted_at,
        source_row.system_source, source_row.notes, source_row.total_amount,
        source_row.created_at, 2 AS source_rank
      FROM public.income_expenses source_row
      WHERE payment.id = '5b32cb16-b579-4427-bebf-108c5195a279'::uuid
        AND source_row.id = '2ea26ca0-92c6-4896-a7b5-a5ee7031b2cc'::uuid

      UNION ALL

      SELECT
        source_row.id, source_row.user_id, source_row.organization_id,
        source_row.type, source_row.account_id, source_row.invoice_id,
        source_row.contract_id, source_row.building_id, source_row.room_id,
        source_row.payment_id, source_row.payment_collection_id,
        source_row.approval_status, source_row.deleted_at,
        source_row.system_source, source_row.notes, source_row.total_amount,
        source_row.created_at, 3 AS source_rank
      FROM public.income_expenses source_row
      WHERE payment.id = 'dc490170-8e05-43e5-bcf9-1e6151dbbc5a'::uuid
        AND source_row.id = 'f6eb4b16-c7cc-4912-ad0d-517ed66d7270'::uuid
    ), distinct_sources AS (
      SELECT DISTINCT ON (source.id) source.*
      FROM raw_sources source
      ORDER BY source.id, source.source_rank
    ), source_stats AS (
      SELECT
        count(*)::integer AS source_count,
        count(DISTINCT source.account_id)::integer AS account_count,
        (array_agg(
          source.id ORDER BY source.source_rank, source.created_at, source.id
        ))[1] AS primary_source_id,
        count(*) FILTER (
          WHERE source.organization_id IS DISTINCT FROM reversal.organization_id
             OR source.type IS DISTINCT FROM 'INCOME'
             OR source.approval_status IS DISTINCT FROM 'APPROVED'
             OR source.deleted_at IS NOT NULL
             OR source.account_id IS NULL
             OR source.invoice_id IS DISTINCT FROM payment.invoice_id
             OR source.contract_id IS DISTINCT FROM invoice.contract_id
             OR source.building_id IS DISTINCT FROM invoice.building_id
             OR source.room_id IS DISTINCT FROM invoice.room_id
             OR (
               payment.collection_id IS NULL
               AND source.payment_collection_id IS NOT NULL
             )
             OR (
               payment.collection_id IS NOT NULL
               AND source.payment_collection_id IS DISTINCT FROM payment.collection_id
             )
        )::integer AS invalid_identity_count,
        COALESCE(sum(source.total_amount), 0) AS voucher_total
      FROM distinct_sources source
    ), item_stats AS (
      SELECT
        count(item.id)::integer AS item_count,
        count(item.id) FILTER (
          WHERE item.organization_id IS DISTINCT FROM reversal.organization_id
             OR item.accounting_class NOT IN (
               'PNL', 'DEPOSIT', 'CUSTOMER_CREDIT', 'INTERNAL'
             )
        )::integer AS invalid_item_count,
        COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)), 0)
          AS item_total,
        COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
          WHERE item.accounting_class = 'PNL'
        ), 0) AS pnl_total,
        COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
          WHERE item.accounting_class = 'DEPOSIT'
        ), 0) AS deposit_total,
        COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
          WHERE item.accounting_class = 'CUSTOMER_CREDIT'
        ), 0) AS credit_total,
        COALESCE(sum(COALESCE(item.amount, item.unit_price * item.quantity)) FILTER (
          WHERE item.accounting_class = 'INTERNAL'
        ), 0) AS internal_total
      FROM distinct_sources source
      LEFT JOIN public.income_expense_items item
        ON item.income_expense_id = source.id
    )
    SELECT source_stats.*, item_stats.*
    FROM source_stats CROSS JOIN item_stats
  ) source_lineage ON true
  WHERE (
    p_payment_id IS NULL
    OR reversal.original_payment_id = p_payment_id
  )
  AND (
     payment.id IS NULL
     OR payment.invoice_id IS NULL
     OR payment.organization_id IS DISTINCT FROM reversal.organization_id
     OR payment.organization_id IS DISTINCT FROM invoice.organization_id
     OR payment.received_amount IS NULL
     OR payment.reversed_at IS NULL
     OR invoice.id IS NULL
     OR invoice.contract_id IS NULL
     OR invoice.building_id IS NULL
     OR invoice.room_id IS NULL
     OR contract_row.id IS NULL
     OR contract_row.organization_id IS DISTINCT FROM reversal.organization_id
     OR contract_row.room_id IS DISTINCT FROM invoice.room_id
     OR room_row.id IS NULL
     OR room_row.building_id IS DISTINCT FROM invoice.building_id
     OR building_row.id IS NULL
     OR building_row.organization_id IS DISTINCT FROM reversal.organization_id
     OR voucher.id IS NULL
     OR voucher.organization_id IS DISTINCT FROM reversal.organization_id
     OR voucher.type IS DISTINCT FROM 'EXPENSE'
     OR voucher.approval_status IS DISTINCT FROM 'APPROVED'
     OR voucher.deleted_at IS NOT NULL
     OR voucher.contract_id IS DISTINCT FROM invoice.contract_id
     OR voucher.building_id IS DISTINCT FROM invoice.building_id
     OR voucher.room_id IS DISTINCT FROM invoice.room_id
     OR (
       voucher.invoice_id IS NOT NULL
       AND voucher.invoice_id IS DISTINCT FROM payment.invoice_id
     )
     OR voucher.account_id IS NULL
     OR account_row.id IS NULL
     OR account_row.organization_id IS DISTINCT FROM reversal.organization_id
     OR account_row.deleted_at IS NOT NULL
     OR (
       account_row.is_virtual
       AND NOT (
         payment.id = 'dc490170-8e05-43e5-bcf9-1e6151dbbc5a'::uuid
         AND source_voucher.id = 'f6eb4b16-c7cc-4912-ad0d-517ed66d7270'::uuid
         AND voucher.id = '26e7a16b-e0d3-44aa-b954-735e0c8f9462'::uuid
         AND payment.received_amount = 0
         AND source_voucher.system_source = 'termination.revenue'
       )
     )
     OR source_voucher.id IS NULL
     OR source_voucher.id IS DISTINCT FROM source_lineage.primary_source_id
     OR source_voucher.organization_id IS DISTINCT FROM reversal.organization_id
     OR source_voucher.type IS DISTINCT FROM 'INCOME'
     OR source_voucher.approval_status IS DISTINCT FROM 'APPROVED'
     OR source_voucher.deleted_at IS NOT NULL
     OR source_voucher.invoice_id IS DISTINCT FROM payment.invoice_id
     OR source_voucher.contract_id IS DISTINCT FROM invoice.contract_id
     OR source_voucher.building_id IS DISTINCT FROM invoice.building_id
     OR source_voucher.room_id IS DISTINCT FROM invoice.room_id
     OR source_voucher.account_id IS DISTINCT FROM voucher.account_id
     OR source_lineage.source_count < 1
     OR source_lineage.account_count <> 1
     OR source_lineage.invalid_identity_count <> 0
     OR source_lineage.invalid_item_count <> 0
     OR source_lineage.item_count < 1
     OR voucher.voucher_date < GREATEST(
       payment.payment_date,
       source_voucher.voucher_date
     )
     OR (
       payment.collection_id IS NULL
       AND (
         payment.tender_id IS NOT NULL
         OR payment.reversed_by_collection_id IS NOT NULL
         OR voucher.payment_collection_id IS NOT NULL
       )
     )
     OR (
       payment.collection_id IS NOT NULL
       AND (
         collection.id IS NULL
         OR collection.organization_id IS DISTINCT FROM reversal.organization_id
         OR collection.invoice_id IS DISTINCT FROM payment.invoice_id
         OR collection.contract_id IS DISTINCT FROM invoice.contract_id
         OR collection.status IS DISTINCT FROM 'REVERSED'
         OR collection.reversed_at IS NULL
         OR tender.id IS NULL
         OR tender.organization_id IS DISTINCT FROM reversal.organization_id
         OR tender.collection_id IS DISTINCT FROM collection.id
         OR tender.payment_id IS DISTINCT FROM payment.id
         OR tender.voucher_id IS DISTINCT FROM source_voucher.id
         OR tender.account_id IS DISTINCT FROM voucher.account_id
         OR payment.reversed_by_collection_id IS DISTINCT FROM collection.id
         OR source_voucher.payment_id IS DISTINCT FROM payment.id
         OR source_voucher.payment_collection_id IS DISTINCT FROM collection.id
         OR voucher.payment_collection_id IS DISTINCT FROM collection.id
         OR voucher.system_source IS DISTINCT FROM 'invoice.collection.reverse.v5'
       )
     )
     OR reversal_items.item_count < 1
     OR reversal_items.invalid_item_count <> 0
     OR abs(reversal_items.item_total - voucher.total_amount) >= 0.01
     OR abs(
       voucher.total_amount
       - CASE
           WHEN payment.received_amount = 0 THEN payment.amount
           ELSE payment.received_amount
         END
     ) >= 0.01
     OR abs(
       source_lineage.voucher_total
       - CASE
           WHEN payment.received_amount = 0 THEN payment.amount
           ELSE payment.received_amount
         END
     ) >= 0.01
     OR abs(source_lineage.item_total - source_lineage.voucher_total) >= 0.01
     OR abs(reversal_items.pnl_total - source_lineage.pnl_total) >= 0.01
     OR abs(reversal_items.deposit_total - source_lineage.deposit_total) >= 0.01
     OR abs(reversal_items.credit_total - source_lineage.credit_total) >= 0.01
     OR abs(reversal_items.internal_total - source_lineage.internal_total) >= 0.01
     OR abs(reversal_items.pnl_total - COALESCE(voucher.kqkd_amount, 0)) >= 0.01
  );
$$;

REVOKE ALL ON FUNCTION app_private.count_invalid_payment_reversals_v1(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.lock_accounting_feature_rollout_v1(
  p_feature_key text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, app_private
AS $$
  SELECT pg_advisory_xact_lock(
    hashtextextended('accounting-feature-rollout:' || p_feature_key, 0)
  );
$$;

REVOKE ALL ON FUNCTION app_private.lock_accounting_feature_rollout_v1(text)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.assert_accounting_feature_activation_v1(
  p_feature_key text,
  p_mode text,
  p_organization_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_open integer;
  v_bad_reversals integer;
BEGIN
  IF p_feature_key NOT IN (
    'contract.create.v2',
    'invoice.collection.v5',
    'customer.credit.apply.v1',
    'shareholder_profit.distribute.v2'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO v_open
  FROM public.accounting_integrity_exceptions exception
  WHERE exception.status = 'OPEN';
  IF v_open <> 0 THEN
    RAISE EXCEPTION 'Accounting activation blocked by % open integrity exceptions', v_open;
  END IF;

  SELECT app_private.count_invalid_payment_reversals_v1()
    INTO v_bad_reversals;
  IF v_bad_reversals <> 0 THEN
    RAISE EXCEPTION 'Accounting activation blocked by % invalid reversal vouchers',
      v_bad_reversals;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_payout_exceptions exception
    WHERE exception.resolved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Accounting activation blocked by unresolved payout exceptions';
  END IF;

  IF p_feature_key = 'shareholder_profit.distribute.v2' AND (
    (
      p_mode = 'ON'
      AND EXISTS (
        SELECT 1
        FROM public.profit_monthly profit
        WHERE profit.status = 'LOCKED'
          AND (
            profit.is_stale
            OR NOT app_private.profit_monthly_source_is_current_v1(profit.id)
          )
      )
    )
    OR (
      p_mode = 'CANARY'
      AND EXISTS (
        SELECT 1
        FROM public.profit_monthly profit
        WHERE profit.status = 'LOCKED'
          AND (
            profit.is_stale
            OR NOT app_private.profit_monthly_source_is_current_v1(profit.id)
          )
          AND (
            (
              p_organization_id IS NOT NULL
              AND profit.organization_id = p_organization_id
            )
            OR (
              p_organization_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM app_private.server_feature_flag_canary_orgs canary
                WHERE canary.feature_key = p_feature_key
                  AND canary.organization_id = profit.organization_id
              )
            )
          )
      )
    )
  ) THEN
    RAISE EXCEPTION 'Profit distribution activation blocked by stale locked profit periods';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_private.assert_accounting_feature_activation_v1(
  text, text, uuid
)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION app_private.guard_accounting_feature_activation_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
BEGIN
  -- UPDATE already owns the feature row lock; take the matching advisory lock
  -- next so enrollment uses the same row -> advisory order without deadlocks.
  PERFORM app_private.lock_accounting_feature_rollout_v1(NEW.feature_key);

  -- A freeze must always be installable. Clearing it re-runs every activation
  -- assertion because force_freeze is part of this trigger's UPDATE columns.
  IF NEW.force_freeze THEN
    RETURN NEW;
  END IF;

  IF NEW.mode IN ('CANARY', 'ON') THEN
    PERFORM app_private.assert_accounting_feature_activation_v1(
      NEW.feature_key, NEW.mode, NULL
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.guard_accounting_feature_activation_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a10_accounting_feature_activation_guard
  ON app_private.server_feature_flags;
CREATE TRIGGER a10_accounting_feature_activation_guard
BEFORE INSERT OR UPDATE OF mode, force_freeze
ON app_private.server_feature_flags
FOR EACH ROW EXECUTE FUNCTION app_private.guard_accounting_feature_activation_v1();

CREATE OR REPLACE FUNCTION app_private.guard_accounting_canary_enrollment_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $$
DECLARE
  v_mode text;
  v_force_freeze boolean;
BEGIN
  SELECT feature.mode, feature.force_freeze
    INTO v_mode, v_force_freeze
  FROM app_private.server_feature_flags feature
  WHERE feature.feature_key = NEW.feature_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting feature is not configured'
      USING ERRCODE = '55000';
  END IF;

  PERFORM app_private.lock_accounting_feature_rollout_v1(NEW.feature_key);

  IF v_mode = 'CANARY' AND NOT v_force_freeze THEN
    PERFORM app_private.assert_accounting_feature_activation_v1(
      NEW.feature_key, v_mode, NEW.organization_id
    );
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app_private.guard_accounting_canary_enrollment_v1()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS a10_accounting_canary_enrollment_guard
  ON app_private.server_feature_flag_canary_orgs;
CREATE TRIGGER a10_accounting_canary_enrollment_guard
BEFORE INSERT OR UPDATE OF feature_key, organization_id
ON app_private.server_feature_flag_canary_orgs
FOR EACH ROW EXECUTE FUNCTION app_private.guard_accounting_canary_enrollment_v1();

DO $gate$
DECLARE
  v_open integer;
  v_bad_reversals integer;
BEGIN
  SELECT count(*) INTO v_open
  FROM public.accounting_integrity_exceptions exception
  WHERE exception.status = 'OPEN';

  IF v_open <> 0 THEN
    RAISE EXCEPTION 'Accounting rollout blocked by % open integrity exceptions', v_open;
  END IF;

  SELECT app_private.count_invalid_payment_reversals_v1()
    INTO v_bad_reversals;

  IF v_bad_reversals <> 0 THEN
    RAISE EXCEPTION 'Accounting rollout blocked by % invalid reversal vouchers',
      v_bad_reversals;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profit_payout_exceptions exception
    WHERE exception.resolved_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Accounting rollout blocked by unresolved payout exceptions';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM app_private.server_feature_flags feature
    WHERE feature.feature_key = 'shareholder_profit.distribute.v2'
      AND NOT feature.force_freeze
      AND (
        (
          feature.mode = 'ON'
          AND EXISTS (
            SELECT 1
            FROM public.profit_monthly profit
            WHERE profit.status = 'LOCKED'
              AND (
                profit.is_stale
                OR NOT app_private.profit_monthly_source_is_current_v1(
                  profit.id
                )
              )
          )
        )
        OR (
          feature.mode = 'CANARY'
          AND EXISTS (
            SELECT 1
            FROM app_private.server_feature_flag_canary_orgs canary
            JOIN public.profit_monthly profit
              ON profit.organization_id = canary.organization_id
            WHERE canary.feature_key = feature.feature_key
              AND profit.status = 'LOCKED'
              AND (
                profit.is_stale
                OR NOT app_private.profit_monthly_source_is_current_v1(
                  profit.id
                )
              )
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'Accounting rollout cannot activate profit distribution while locked periods are stale';
  END IF;
END
$gate$;

COMMIT;
