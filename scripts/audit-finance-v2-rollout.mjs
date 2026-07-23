// Read-only audit of Finance V2 (Thu Chi V2) rollout state and the §10.5 cutover gates.
// Never writes. Runs in a READ ONLY transaction via the Management API. Safe to run at any
// stage: if the Finance V2 schema is not yet applied it prints a baseline-only summary and
// exits 0. With --strict it exits non-zero unless every hard cutover gate is clean.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeManagementQuery,
  loadSupabaseAdminConfig,
} from "./apply-accounting-rollout.mjs";
import {
  FINANCE_V2_LOCK_TIMEOUT,
  FINANCE_V2_STATEMENT_TIMEOUT,
} from "./apply-finance-v2-rollout.mjs";

const FINANCE_KEYS = [
  "income_expense.workflow.v2",
  "income_expense.posting.v2",
  "cashbook.access.v2",
  "income_expense.profit_close.v2",
  "income_expense.read_semantics.v2",
  "contract.commission.settlement.v2",
  "salary.settlement.v2",
];

// Always-safe baseline probe (only references tables guaranteed present pre-apply).
export const BASELINE_SQL = `
SELECT jsonb_build_object(
  'schema_applied', to_regclass('public.income_expense_postings') IS NOT NULL,
  'finance_feature_modes', COALESCE((
    SELECT jsonb_object_agg(feature_key, jsonb_build_object('mode', mode, 'force_freeze', force_freeze))
    FROM app_private.server_feature_flags
    WHERE feature_key = ANY (ARRAY[${FINANCE_KEYS.map((k) => `'${k}'`).join(",")}])
  ), '{}'::jsonb),
  'possession_open_by_kind', COALESCE((
    SELECT jsonb_object_agg(possession_kind, cnt)
    FROM (SELECT possession_kind, count(*) AS cnt FROM public.cashbook_possession_bindings
          WHERE valid_to IS NULL GROUP BY possession_kind) k
  ), '{}'::jsonb),
  'account_shared_users', (SELECT count(*) FROM public.account_shared_users),
  'pending_kqkd_by_org', COALESCE((
    SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT organization_id, count(*) AS cnt, COALESCE(sum(total_amount),0) AS total
      FROM public.income_expenses WHERE approval_status='UNAPPROVED' AND deleted_at IS NULL
      GROUP BY organization_id ORDER BY count(*) DESC
    ) t
  ), '[]'::jsonb)
) AS finance_v2_audit;`;

// Full post-apply gate report (§10.5). References Finance V2 objects directly.
export const FULL_SQL = `
SELECT jsonb_build_object(
  'schema_applied', true,
  'finance_feature_modes', COALESCE((
    SELECT jsonb_object_agg(feature_key, jsonb_build_object('mode', mode, 'force_freeze', force_freeze))
    FROM app_private.server_feature_flags
    WHERE feature_key = ANY (ARRAY[${FINANCE_KEYS.map((k) => `'${k}'`).join(",")}])
  ), '{}'::jsonb),
  'backfill_exceptions', jsonb_build_object(
    'income_expense', (SELECT count(*) FROM app_private.income_expense_v2_backfill_exceptions WHERE disposition_at IS NULL),
    'cashbook_access', (SELECT count(*) FROM app_private.cashbook_access_v2_backfill_exceptions)
  ),
  'change_log_lag', (
    SELECT count(*) FROM app_private.finance_v2_backfill_change_log WHERE applied_at IS NULL
  ),
  'postings', jsonb_build_object(
    'events', (SELECT count(*) FROM public.income_expense_postings),
    'lines', (SELECT count(*) FROM public.income_expense_posting_lines),
    'active_pointers', (SELECT count(*) FROM public.income_expenses WHERE active_posting_id_v2 IS NOT NULL)
  ),
  'backfill_coverage', jsonb_build_object(
    'vouchers_total', (SELECT count(*) FROM public.income_expenses WHERE deleted_at IS NULL),
    'vouchers_posting_mode_set', (SELECT count(*) FROM public.income_expenses WHERE deleted_at IS NULL AND posting_mode IS NOT NULL)
  ),
  'semantic_events_by_kind', COALESCE((
    SELECT jsonb_object_agg(source_kind, cnt) FROM (
      SELECT source_kind, count(*) AS cnt FROM app_private.finance_v2_semantic_event_log GROUP BY source_kind
    ) s
  ), '{}'::jsonb),
  'activation_attestations', (SELECT count(*) FROM app_private.finance_v2_activation_attestations),
  'business_policy_decisions', (SELECT count(*) FROM app_private.finance_business_policy_decisions),
  'possession_open_by_kind', COALESCE((
    SELECT jsonb_object_agg(possession_kind, cnt) FROM (
      SELECT possession_kind, count(*) AS cnt FROM public.cashbook_possession_bindings WHERE valid_to IS NULL GROUP BY possession_kind
    ) k
  ), '{}'::jsonb),
  'account_shared_users', (SELECT count(*) FROM public.account_shared_users),
  'pending_kqkd_by_org', COALESCE((
    SELECT jsonb_agg(row_to_json(t)) FROM (
      SELECT organization_id, count(*) AS cnt, COALESCE(sum(total_amount),0) AS total
      FROM public.income_expenses WHERE approval_status='UNAPPROVED' AND deleted_at IS NULL
      GROUP BY organization_id ORDER BY count(*) DESC
    ) t
  ), '[]'::jsonb)
) AS finance_v2_audit;`;

function wrapReadOnly(sql) {
  return [
    "BEGIN TRANSACTION READ ONLY;",
    `SET LOCAL lock_timeout = '${FINANCE_V2_LOCK_TIMEOUT}';`,
    `SET LOCAL statement_timeout = '${FINANCE_V2_STATEMENT_TIMEOUT}';`,
    sql,
    "COMMIT;",
  ].join("\n");
}

export function parseAuditResponse(body) {
  const parsed = JSON.parse(body);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const row = rows.find((r) => r?.finance_v2_audit !== undefined);
  if (!row) throw new Error("Finance V2 audit returned no report row");
  return row.finance_v2_audit;
}

// Hard cutover gates (§10.5). Returns { cutoverReady, blockers }.
export function evaluateFinanceV2Audit(report) {
  if (!report.schema_applied) {
    return { cutoverReady: false, blockers: ["schema not applied (build phase)"], phase: "pre-apply" };
  }
  const blockers = [];
  const ex = report.backfill_exceptions || {};
  if (Number(ex.income_expense || 0) > 0) blockers.push(`${ex.income_expense} income_expense backfill exception(s)`);
  if (Number(ex.cashbook_access || 0) > 0) blockers.push(`${ex.cashbook_access} cashbook-access backfill exception(s)`);
  if (Number(report.change_log_lag || 0) > 0) blockers.push(`${report.change_log_lag} unapplied change-log row(s)`);
  if (Number(report.account_shared_users || 0) > 0) blockers.push(`${report.account_shared_users} undrained account_shared_users row(s)`);
  return { cutoverReady: blockers.length === 0, blockers, phase: "applied" };
}

export async function main(
  argv = process.argv.slice(2),
  { log = console.log, fetchImpl = fetch, loadConfig = loadSupabaseAdminConfig } = {},
) {
  const strict = argv.includes("--strict");
  if (argv.some((a) => a !== "--strict" && a !== "--help" && a !== "-h")) {
    throw new Error(`Unknown argument`);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    log("Usage: node scripts/audit-finance-v2-rollout.mjs [--strict]");
    log("  Read-only Finance V2 rollout audit. --strict exits non-zero unless cutover-ready.");
    return;
  }

  const config = loadConfig();
  // Probe first so we pick the right (parse-safe) query for the current stage.
  const probe = parseAuditResponse(await executeManagementQuery(wrapReadOnly(BASELINE_SQL), config, fetchImpl));
  const report = probe.schema_applied
    ? parseAuditResponse(await executeManagementQuery(wrapReadOnly(FULL_SQL), config, fetchImpl))
    : probe;

  log(JSON.stringify(report, null, 2));
  const evaluation = evaluateFinanceV2Audit(report);
  if (!report.schema_applied) {
    log("Finance V2 schema not yet applied — baseline summary only. Full gate audit runs after forward-apply.");
    return;
  }
  if (evaluation.cutoverReady) {
    log("Finance V2 cutover gates: CLEAN (no unresolved exceptions / change-log lag / undrained sharing).");
  } else {
    log(`Finance V2 cutover gates: NOT READY — ${evaluation.blockers.join("; ")}.`);
    if (strict) process.exitCode = 1;
  }
  log("Read-only Finance V2 audit completed; production data is unchanged.");
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
