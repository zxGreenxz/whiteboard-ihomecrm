// Validate locally by default; live DDL compilation requires --live-rollback.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildRolloutSql,
  executeManagementQuery,
  loadMigrationBodies,
  loadSupabaseAdminConfig,
  ROLLOUT_CATALOG_SCOPE_NOTICE,
  STATIC_VALIDATION_NOTICE,
} from "./apply-accounting-rollout.mjs";

export const DEFAULT_FILES = Object.freeze([
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

export function parseValidateArgs(argv) {
  let liveRollback = false;
  let help = false;
  const files = [];

  for (const arg of argv) {
    if (arg === "--live-rollback") liveRollback = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown argument: ${arg}`);
    else files.push(arg);
  }

  return {
    files: files.length > 0 ? files : [...DEFAULT_FILES],
    help,
    liveRollback,
  };
}

function printUsage(log) {
  log(
    "Usage: node scripts/validate-accounting-migrations.mjs [--live-rollback] [migration.sql ...]",
  );
  log("  default          Validate and assemble migration files locally only.");
  log("  --live-rollback  Execute DDL against Supabase in a timed transaction, then rollback.");
  log(`  ${ROLLOUT_CATALOG_SCOPE_NOTICE}`);
  log(`  ${STATIC_VALIDATION_NOTICE}`);
}

export async function main(
  argv = process.argv.slice(2),
  {
    log = console.log,
    warn = console.warn,
    fetchImpl = fetch,
    loadConfig = loadSupabaseAdminConfig,
  } = {},
) {
  const { files, help, liveRollback } = parseValidateArgs(argv);
  if (help) {
    printUsage(log);
    return;
  }

  log(ROLLOUT_CATALOG_SCOPE_NOTICE);

  const migrations = loadMigrationBodies(files);
  const sql = buildRolloutSql(migrations, { rollback: true, notify: false });
  const digest = createHash("sha256").update(sql).digest("hex");

  if (!liveRollback) {
    log(
      `Static validation passed for ${migrations.length} migration(s) (sha256 ${digest}).`,
    );
    log(STATIC_VALIDATION_NOTICE);
    log("No database query was executed. Use --live-rollback to opt in to live DDL validation.");
    return;
  }

  warn(
    "Live rollback validation explicitly enabled: DDL will run with lock_timeout and statement_timeout, then rollback.",
  );
  const config = loadConfig();
  await executeManagementQuery(sql, config, fetchImpl);
  log(`Validated ${migrations.length} migration(s) live with ROLLBACK.`);
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
