// Audit an already-applied accounting schema without permitting database writes.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeManagementQuery,
  loadSupabaseAdminConfig,
  ROLLOUT_LOCK_TIMEOUT,
  ROLLOUT_STATEMENT_TIMEOUT,
} from "./apply-accounting-rollout.mjs";

export const APPLIED_ROLLOUT_MIGRATIONS = Object.freeze([
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
  "supabase/migrations/20260721150500_accounting_scope_narrowing.sql",
]);

export const REPORT_SQL = String.raw`
WITH repair_by_code AS (
  SELECT repair_code, count(*)::integer AS row_count
  FROM public.accounting_repair_audit
  GROUP BY repair_code
),
repair_by_month AS (
  SELECT
    invoice.billing_month,
    count(*)::integer AS payment_count,
    sum((audit.details->>'expected_revenue')::numeric) AS expected_revenue,
    sum((audit.details->>'expected_deposit')::numeric) AS expected_deposit,
    sum((audit.details->>'expected_credit')::numeric) AS expected_credit,
    sum(COALESCE((audit.details->>'credit_compensation')::numeric, 0))
      AS credit_compensation
  FROM public.accounting_repair_audit audit
  JOIN public.income_expenses voucher ON voucher.id = audit.entity_id
  JOIN public.payments payment ON payment.id = voucher.payment_id
  JOIN public.invoices invoice ON invoice.id = payment.invoice_id
  WHERE audit.repair_code IN (
    'PAYMENT_ACCOUNTING_RECLASSIFICATION',
    'CUSTOMER_CREDIT_COMPENSATION'
  )
  GROUP BY invoice.billing_month
),
exception_by_code AS (
  SELECT exception_code, count(*)::integer AS row_count
  FROM public.accounting_integrity_exceptions
  WHERE status = 'OPEN'
  GROUP BY exception_code
),
locked_profit_freshness AS MATERIALIZED (
  SELECT
    profit.organization_id,
    profit.is_stale,
    app_private.profit_monthly_source_is_current_v1(profit.id)
      AS source_is_current
  FROM public.profit_monthly profit
  WHERE profit.status = 'LOCKED'
),
profit_summary AS (
  SELECT
    count(*) FILTER (WHERE status = 'LOCKED')::integer AS locked_count,
    count(*) FILTER (
      WHERE status = 'LOCKED' AND abs(unallocated_profit) >= 0.01
    )::integer AS locked_with_unallocated,
    COALESCE(sum(unallocated_profit) FILTER (
      WHERE status = 'LOCKED'
    ), 0) AS total_unallocated,
    count(*) FILTER (WHERE is_stale)::integer AS stale_count
  FROM public.profit_monthly
),
profit_activation_readiness AS (
  SELECT jsonb_build_object(
    'overall', jsonb_build_object(
      'locked_persisted_stale_count', count(*) FILTER (
        WHERE freshness.is_stale
      ),
      'locked_hash_drift_count', count(*) FILTER (
        WHERE NOT freshness.is_stale
          AND NOT freshness.source_is_current
      ),
      'locked_unsafe_count', count(*) FILTER (
        WHERE freshness.is_stale
          OR NOT freshness.source_is_current
      )
    ),
    'demo', jsonb_build_object(
      'organization_id', 'dddd0000-0000-4000-8000-000000000001'::uuid,
      'locked_persisted_stale_count', count(*) FILTER (
        WHERE freshness.organization_id =
            'dddd0000-0000-4000-8000-000000000001'::uuid
          AND freshness.is_stale
      ),
      'locked_hash_drift_count', count(*) FILTER (
        WHERE freshness.organization_id =
            'dddd0000-0000-4000-8000-000000000001'::uuid
          AND NOT freshness.is_stale
          AND NOT freshness.source_is_current
      ),
      'locked_unsafe_count', count(*) FILTER (
        WHERE freshness.organization_id =
            'dddd0000-0000-4000-8000-000000000001'::uuid
          AND (
            freshness.is_stale
            OR NOT freshness.source_is_current
          )
      )
    ),
    'real', jsonb_build_object(
      'organization_id', 'aaaa0000-0000-4000-8000-000000000001'::uuid,
      'locked_persisted_stale_count', count(*) FILTER (
        WHERE freshness.organization_id =
            'aaaa0000-0000-4000-8000-000000000001'::uuid
          AND freshness.is_stale
      ),
      'locked_hash_drift_count', count(*) FILTER (
        WHERE freshness.organization_id =
            'aaaa0000-0000-4000-8000-000000000001'::uuid
          AND NOT freshness.is_stale
          AND NOT freshness.source_is_current
      ),
      'locked_unsafe_count', count(*) FILTER (
        WHERE freshness.organization_id =
            'aaaa0000-0000-4000-8000-000000000001'::uuid
          AND (
            freshness.is_stale
            OR NOT freshness.source_is_current
          )
      )
    )
  ) AS value
  FROM locked_profit_freshness freshness
),
l03 AS (
  SELECT jsonb_build_object(
    'invoice_id', invoice.id,
    'invoice_number', invoice.invoice_number,
    'total_amount', invoice.total_amount,
    'invoice_deposit', COALESCE(sum(item.amount) FILTER (
      WHERE item.accounting_class = 'DEPOSIT'
    ), 0),
    'invoice_revenue', invoice.total_amount - COALESCE(sum(item.amount) FILTER (
      WHERE item.accounting_class = 'DEPOSIT'
    ), 0),
    'posted_pnl', COALESCE((
      SELECT sum(voucher.kqkd_amount)
      FROM public.income_expenses voucher
      WHERE voucher.invoice_id = invoice.id
        AND voucher.type = 'INCOME'
        AND voucher.approval_status = 'APPROVED'
        AND voucher.deleted_at IS NULL
    ), 0)
  ) AS value
  FROM public.invoices invoice
  LEFT JOIN public.invoice_items item ON item.invoice_id = invoice.id
  WHERE invoice.invoice_number = 'INV-202605-958210'
  GROUP BY invoice.id
)
SELECT jsonb_build_object(
  'repair_by_code', COALESCE((
    SELECT jsonb_object_agg(repair_code, row_count) FROM repair_by_code
  ), '{}'::jsonb),
  'repair_by_month', COALESCE((
    SELECT jsonb_agg(to_jsonb(repair_by_month) ORDER BY billing_month)
    FROM repair_by_month
  ), '[]'::jsonb),
  'exceptions', COALESCE((
    SELECT jsonb_object_agg(exception_code, row_count) FROM exception_by_code
  ), '{}'::jsonb),
  'exception_rows', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'entity_type', exception.entity_type,
      'entity_id', exception.entity_id,
      'organization_id', exception.organization_id,
      'exception_code', exception.exception_code,
      'details', exception.details,
      'invoice_id', payment.invoice_id,
      'payment_amount', payment.amount
    ) ORDER BY exception.exception_code, exception.entity_id)
    FROM public.accounting_integrity_exceptions exception
    LEFT JOIN public.payments payment
      ON exception.entity_type = 'PAYMENT' AND payment.id = exception.entity_id
    WHERE exception.status = 'OPEN'
  ), '[]'::jsonb),
  'legacy_reversal_integrity_failures_diagnostic', (
    SELECT count(*)
    FROM app_private.payment_reversals reversal
    LEFT JOIN public.payments payment
      ON payment.id = reversal.original_payment_id
    LEFT JOIN public.income_expenses voucher
      ON voucher.id = reversal.reversal_voucher_id
    LEFT JOIN public.income_expenses source_voucher
      ON source_voucher.id = voucher.reversal_of_income_expense_id
    LEFT JOIN public.accounts account_row ON account_row.id = voucher.account_id
    LEFT JOIN LATERAL (
      SELECT
        count(*)::integer AS item_count,
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
      WITH source_ids AS (
        SELECT source_voucher.id

        UNION

        SELECT source_row.id
        FROM public.income_expenses source_row
        WHERE source_row.payment_id = payment.id
          AND source_row.organization_id = reversal.organization_id
          AND source_row.type = 'INCOME'
          AND source_row.approval_status = 'APPROVED'
          AND source_row.deleted_at IS NULL

        UNION

        SELECT source_row.id
        FROM public.income_expenses source_row
        WHERE source_row.payment_id IS NULL
          AND source_row.organization_id = reversal.organization_id
          AND source_row.type = 'INCOME'
          AND source_row.approval_status = 'APPROVED'
          AND source_row.deleted_at IS NULL
          AND source_row.notes = '[THU TACH COC ' || payment.id::text || ']'

        UNION

        SELECT source_row.id
        FROM public.income_expenses source_row
        WHERE payment.id = '5b32cb16-b579-4427-bebf-108c5195a279'::uuid
          AND source_row.id = '2ea26ca0-92c6-4896-a7b5-a5ee7031b2cc'::uuid
          AND source_row.organization_id = reversal.organization_id
          AND source_row.type = 'INCOME'
          AND source_row.approval_status = 'APPROVED'
          AND source_row.deleted_at IS NULL
      )
      SELECT
        count(*)::integer AS item_count,
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
      FROM source_ids source
      JOIN public.income_expense_items item
        ON item.income_expense_id = source.id
    ) source_items ON true
    WHERE payment.id IS NULL
       OR payment.organization_id IS DISTINCT FROM reversal.organization_id
       OR payment.received_amount IS NULL
       OR payment.reversed_at IS NULL
       OR voucher.id IS NULL
       OR voucher.organization_id IS DISTINCT FROM reversal.organization_id
       OR voucher.type IS DISTINCT FROM 'EXPENSE'
       OR voucher.approval_status IS DISTINCT FROM 'APPROVED'
       OR voucher.deleted_at IS NOT NULL
       OR voucher.account_id IS NULL
       OR account_row.id IS NULL
       OR account_row.organization_id IS DISTINCT FROM reversal.organization_id
       OR account_row.deleted_at IS NOT NULL
       OR (
         account_row.is_virtual
         AND NOT (
           payment.received_amount = 0
           AND source_voucher.system_source = 'termination.revenue'
         )
       )
       OR source_voucher.id IS NULL
       OR source_voucher.organization_id IS DISTINCT FROM reversal.organization_id
       OR source_voucher.type IS DISTINCT FROM 'INCOME'
       OR source_voucher.approval_status IS DISTINCT FROM 'APPROVED'
       OR source_voucher.deleted_at IS NOT NULL
       OR source_voucher.account_id IS DISTINCT FROM voucher.account_id
       OR voucher.voucher_date < GREATEST(
         payment.payment_date,
         source_voucher.voucher_date
       )
       OR reversal_items.item_count = 0
       OR source_items.item_count = 0
       OR abs(reversal_items.item_total - voucher.total_amount) >= 0.01
       OR abs(
         voucher.total_amount
         - CASE
             WHEN payment.received_amount = 0 THEN payment.amount
             ELSE payment.received_amount
           END
       ) >= 0.01
       OR abs(reversal_items.pnl_total - source_items.pnl_total) >= 0.01
       OR abs(reversal_items.deposit_total - source_items.deposit_total) >= 0.01
       OR abs(reversal_items.credit_total - source_items.credit_total) >= 0.01
       OR abs(reversal_items.internal_total - source_items.internal_total) >= 0.01
       OR abs(reversal_items.pnl_total - COALESCE(voucher.kqkd_amount, 0)) >= 0.01
  ),
  'reversal_integrity_failures',
    app_private.count_invalid_payment_reversals_v1(),
  'reversal_rows', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'payment_id', reversal.original_payment_id,
      'invalid_count', app_private.count_invalid_payment_reversals_v1(
        reversal.original_payment_id
      ),
      'payment_org', payment.organization_id,
      'payment_invoice_id', payment.invoice_id,
      'payment_collection_id', payment.collection_id,
      'payment_tender_id', payment.tender_id,
      'payment_reversed_by_collection_id', payment.reversed_by_collection_id,
      'payment_received_amount', payment.received_amount,
      'invoice_org', invoice.organization_id,
      'invoice_user_id', invoice.user_id,
      'invoice_contract_id', invoice.contract_id,
      'invoice_building_id', invoice.building_id,
      'invoice_room_id', invoice.room_id,
      'reversal_voucher_id', reversal.reversal_voucher_id,
      'reversal_account_id', reversal_voucher.account_id,
      'reversal_user_id', reversal_voucher.user_id,
      'reversal_invoice_id', reversal_voucher.invoice_id,
      'reversal_contract_id', reversal_voucher.contract_id,
      'reversal_building_id', reversal_voucher.building_id,
      'reversal_room_id', reversal_voucher.room_id,
      'reversal_collection_id', reversal_voucher.payment_collection_id,
      'linked_source_id', reversal_voucher.reversal_of_income_expense_id,
      'linked_source', (
        SELECT jsonb_build_object(
          'organization_id', linked_source.organization_id,
          'user_id', linked_source.user_id,
          'invoice_id', linked_source.invoice_id,
          'contract_id', linked_source.contract_id,
          'building_id', linked_source.building_id,
          'room_id', linked_source.room_id,
          'payment_id', linked_source.payment_id,
          'payment_collection_id', linked_source.payment_collection_id,
          'system_source', linked_source.system_source,
          'approval_status', linked_source.approval_status
        )
        FROM public.income_expenses linked_source
        WHERE linked_source.id = reversal_voucher.reversal_of_income_expense_id
      ),
      'invoice_account_candidates', COALESCE((
        SELECT jsonb_agg(DISTINCT source_voucher.account_id)
        FROM public.payments sibling_payment
        JOIN public.income_expenses source_voucher
          ON source_voucher.payment_id = sibling_payment.id
         AND source_voucher.type = 'INCOME'
         AND source_voucher.account_id IS NOT NULL
        WHERE sibling_payment.invoice_id = payment.invoice_id
      ), '[]'::jsonb),
      'organization_account_candidates', COALESCE((
        SELECT jsonb_agg(account_row.id ORDER BY account_row.id)
        FROM public.accounts account_row
        WHERE account_row.organization_id = reversal.organization_id
          AND account_row.deleted_at IS NULL
          AND NOT account_row.is_virtual
      ), '[]'::jsonb),
      'source_voucher_ids', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', source_voucher.id,
          'account_id', source_voucher.account_id,
          'deleted_at', source_voucher.deleted_at,
          'total_amount', source_voucher.total_amount
        ) ORDER BY source_voucher.id)
        FROM public.income_expenses source_voucher
        WHERE source_voucher.payment_id = reversal.original_payment_id
          AND source_voucher.type = 'INCOME'
      ), '[]'::jsonb)
    ) ORDER BY reversal.original_payment_id)
    FROM app_private.payment_reversals reversal
    LEFT JOIN public.payments payment ON payment.id = reversal.original_payment_id
    LEFT JOIN public.invoices invoice ON invoice.id = payment.invoice_id
    LEFT JOIN public.income_expenses reversal_voucher
      ON reversal_voucher.id = reversal.reversal_voucher_id
  ), '[]'::jsonb),
  'profit', (SELECT to_jsonb(profit_summary) FROM profit_summary),
  'profit_activation_readiness', (
    SELECT value FROM profit_activation_readiness
  ),
  'payout_reservations', (
    SELECT count(*) FROM public.profit_payout_reservations
  ),
  'payout_exceptions', (
    SELECT count(*) FROM public.profit_payout_exceptions
    WHERE resolved_at IS NULL
  ),
  'profit_distribution_mode', (
    SELECT feature.mode
    FROM app_private.server_feature_flags feature
    WHERE feature.feature_key = 'shareholder_profit.distribute.v2'
  ),
  'profit_distribution_force_freeze', (
    SELECT feature.force_freeze
    FROM app_private.server_feature_flags feature
    WHERE feature.feature_key = 'shareholder_profit.distribute.v2'
  ),
  'profit_active_unsafe_count', (
    SELECT count(*)
    FROM public.profit_monthly profit
    JOIN app_private.server_feature_flags feature
      ON feature.feature_key = 'shareholder_profit.distribute.v2'
    WHERE profit.status = 'LOCKED'
      AND NOT feature.force_freeze
      AND (
        profit.is_stale
        OR NOT app_private.profit_monthly_source_is_current_v1(profit.id)
      )
      AND (
        feature.mode = 'ON'
        OR (
          feature.mode = 'CANARY'
          AND EXISTS (
            SELECT 1
            FROM app_private.server_feature_flag_canary_orgs canary
            WHERE canary.feature_key = feature.feature_key
              AND canary.organization_id = profit.organization_id
          )
        )
      )
  ),
  'forfeit_authorizations', (
    SELECT jsonb_build_object(
      'count', count(*),
      'approved_count', count(*) FILTER (
        WHERE revenue.approval_status = 'APPROVED'
          AND offset_voucher.approval_status = 'APPROVED'
      ),
      'payment_link_count', count(auth_row.payment_id),
      'mixed_status_count', count(*) FILTER (
        WHERE revenue.approval_status IS DISTINCT FROM offset_voucher.approval_status
      )
    )
    FROM app_private.termination_forfeit_authorizations auth_row
    JOIN public.income_expenses revenue ON revenue.id = auth_row.revenue_voucher_id
    JOIN public.income_expenses offset_voucher ON offset_voucher.id = auth_row.offset_voucher_id
  ),
  'l03', COALESCE((SELECT value FROM l03), '{}'::jsonb)
) AS accounting_rollout_report;
`;

export const AUDIT_SQL = [
  "BEGIN TRANSACTION READ ONLY;",
  `SET LOCAL lock_timeout = '${ROLLOUT_LOCK_TIMEOUT}';`,
  `SET LOCAL statement_timeout = '${ROLLOUT_STATEMENT_TIMEOUT}';`,
  REPORT_SQL,
  "COMMIT;",
].join("\n");

export function parseAuditResponse(body) {
  const parsed = JSON.parse(body);
  if (!Array.isArray(parsed)) return parsed;

  const row = parsed.find(
    (candidate) => candidate?.accounting_rollout_report !== undefined,
  );
  if (!row) throw new Error("Accounting rollout audit returned no report row");
  return row.accounting_rollout_report;
}

export function evaluateAuditReport(report) {
  const openExceptionCount = Object.values(report.exceptions ?? {}).reduce(
    (total, value) => total + Number(value || 0),
    0,
  );
  const reversalFailureCount = Number(report.reversal_integrity_failures || 0);
  const payoutExceptionCount = Number(report.payout_exceptions || 0);
  const profitReadiness = report.profit_activation_readiness ?? {};
  const overallProfitReadiness = profitReadiness.overall ?? {};
  const persistedStaleProfitCount = Number(
    overallProfitReadiness.locked_persisted_stale_count || 0,
  );
  const hashDriftProfitCount = Number(
    overallProfitReadiness.locked_hash_drift_count || 0,
  );
  const unsafeProfitCount = Number(
    overallProfitReadiness.locked_unsafe_count || 0,
  );
  const profitDistributionMode = String(
    report.profit_distribution_mode || "OFF",
  );
  const profitDistributionForceFreeze =
    report.profit_distribution_force_freeze === true;
  const activeUnsafeProfitCount = Number(
    report.profit_active_unsafe_count || 0,
  );
  const schemaIntegrityReady =
    openExceptionCount === 0 &&
    reversalFailureCount === 0 &&
    payoutExceptionCount === 0;

  if (!schemaIntegrityReady || activeUnsafeProfitCount > 0) {
    throw new Error(
      `Accounting rollout audit blocked: ${openExceptionCount} open exception(s), ` +
        `${reversalFailureCount} invalid reversal(s), ` +
        `${payoutExceptionCount} payout exception(s), ` +
        `${activeUnsafeProfitCount} active unsafe locked profit row(s) while profit mode is ` +
        `${profitDistributionMode}.`,
    );
  }

  return {
    activeUnsafeProfitCount,
    hashDriftProfitCount,
    openExceptionCount,
    payoutExceptionCount,
    persistedStaleProfitCount,
    reversalFailureCount,
    schemaIntegrityReady,
    unsafeProfitCount,
    profitActivationReady: unsafeProfitCount === 0,
    profitDistributionForceFreeze,
    profitDistributionMode,
    profitReadinessByOrganization: {
      demo: profitReadiness.demo ?? {},
      real: profitReadiness.real ?? {},
    },
  };
}

export async function main(
  argv = process.argv.slice(2),
  {
    log = console.log,
    fetchImpl = fetch,
    loadConfig = loadSupabaseAdminConfig,
  } = {},
) {
  if (argv.includes("--help") || argv.includes("-h")) {
    log("Usage: node scripts/audit-accounting-rollout.mjs");
    log("Runs a read-only audit after all 14 accounting migrations are applied.");
    return;
  }
  if (argv.length > 0) throw new Error(`Unknown argument: ${argv[0]}`);
  if (APPLIED_ROLLOUT_MIGRATIONS.length !== 14) {
    throw new Error("Accounting rollout audit expects exactly 14 migrations");
  }

  const body = await executeManagementQuery(
    AUDIT_SQL,
    loadConfig(),
    fetchImpl,
  );
  const report = parseAuditResponse(body);
  log(JSON.stringify(report, null, 2));
  const evaluation = evaluateAuditReport(report);
  log("Schema integrity audit passed.");
  if (evaluation.profitActivationReady) {
    log("Profit activation readiness passed: no unsafe locked profit rows.");
  } else {
    const rolloutState = evaluation.profitDistributionForceFreeze
      ? `${evaluation.profitDistributionMode} mode is force-frozen`
      : `${evaluation.profitDistributionMode} mode`;
    log(
      `Profit activation readiness is NOT READY: ${evaluation.unsafeProfitCount} ` +
        `unsafe locked row(s) (${evaluation.persistedStaleProfitCount} persisted ` +
        `stale, ${evaluation.hashDriftProfitCount} source hash drift); ` +
        `${rolloutState}.`,
    );
  }
  log("Read-only accounting rollout audit completed; production data is unchanged.");
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
