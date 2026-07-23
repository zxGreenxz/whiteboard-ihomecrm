// Apply the Finance V2 (Thu Chi V2) rollout as an ORDERED, forward-only stage manifest.
//
// Unlike the accounting bundle (one all-or-nothing transaction), Finance V2 stages are
// applied sequentially — each stage in its own advisory-locked transaction — so that an
// earlier, already-verified stage is never rolled back by a later failure (plan §13/§10.0:
// "Mỗi stage chỉ được đánh dấu applied khi cả catalog fingerprint, data invariants, route
// state và audit record khớp"). Use --atomic only for a clean-room DEMO re-apply.
//
// This script NEVER changes a feature mode or enrolls a canary org. Mode transitions,
// canary enrollment, cohort CAS and force_freeze are operational CAS steps done separately
// with their own approval reference/audit (plan §13, §20). This is production-catalog-only.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  loadSupabaseAdminConfig,
  executeManagementQuery,
  stripMigrationTransactionControl,
} from "./apply-accounting-rollout.mjs";

// Ordered main train (stages 1–12 of plan §13). Stage 13 (contract cleanup) is a LATER
// release applied out-of-band, deliberately not in this manifest.
export const FINANCE_V2_MIGRATIONS = Object.freeze([
  "supabase/migrations/20260723010000_finance_v2_semantics_snapshot.sql",
  "supabase/migrations/20260723020000_finance_v2_schema_inert_and_activation_guard.sql",
  "supabase/migrations/20260723030000_finance_v2_containment.sql",
  "supabase/migrations/20260723040000_finance_v2_backfill.sql",
  "supabase/migrations/20260723050000_finance_v2_writers.sql",
  "supabase/migrations/20260723060000_finance_v2_system_writer_adapters.sql",
  "supabase/migrations/20260723070000_finance_v2_caller_drain_acl.sql",
  "supabase/migrations/20260723080000_finance_v2_delta_catchup.sql",
  // NOTE: shadow-reconcile (§13 stage 9) intentionally applies AFTER read-models (stage 10):
  // its parity views read accounts_with_balance_v2 / effective_profit_contributions_v2.
  "supabase/migrations/20260723100000_finance_v2_read_models.sql",
  "supabase/migrations/20260723105000_finance_v2_shadow_reconcile.sql",
  "supabase/migrations/20260723110000_finance_v2_rls_canary.sql",
  "supabase/migrations/20260723115000_finance_v2_client_flags.sql",
  "supabase/migrations/20260723120000_finance_v2_cutover_readiness.sql",
  // Stage 7b: compat gateway RPCs so the LAST raw-DML FE callers (edit/import/batch/
  // copilot/refund/metadata) drain to RPCs BEFORE Stage-7 revokes client DML.
  "supabase/migrations/20260723130000_finance_v2_drain_compat_rpcs.sql",
  "supabase/migrations/20260723140000_finance_v2_compat_whitelist_patch.sql",
  "supabase/migrations/20260723150000_finance_v2_read_cutover_bridge.sql",
  "supabase/migrations/20260723160000_finance_v2_compat_guard_fix.sql",
  "supabase/migrations/20260723170000_finance_v2_readonly_txn_fix.sql",
  "supabase/migrations/20260723180000_finance_v2_compat_columns_fix.sql",
  "supabase/migrations/20260723190000_finance_v2_compat_update_reemit.sql",
  "supabase/migrations/20260723210000_finance_v2_evidence_rpcs.sql",
  "supabase/migrations/20260723220000_finance_v2_canonical_op_reserve_fix.sql",
  "supabase/migrations/20260723230000_finance_v2_birth_provenance.sql",
  "supabase/migrations/20260723240000_finance_v2_lifecycle_token_bridge_skip.sql",
]);

export const FINANCE_V2_LOCK_NAME = "ihomecrm:finance-v2-rollout:v1";
export const FINANCE_V2_LOCK_TIMEOUT = "5s";
export const FINANCE_V2_STATEMENT_TIMEOUT = "15min";
export const FINANCE_V2_CATALOG_SCOPE_NOTICE =
  "Finance V2 rollout is production-catalog-only: it requires the Accounting/V5/RBAC baseline, is applied out-of-band via the Management API, never runs via schema_migrations/db push/reset, and never changes a feature mode or enrolls an org.";
export const FINANCE_V2_STATIC_NOTICE =
  "Static only: no target catalog was queried; per-stage guards run only during --live-rollback or apply.";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function advisoryLockSql() {
  return `DO $finance_v2_rollout_lock$
BEGIN
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended(${sqlLiteral(FINANCE_V2_LOCK_NAME)}, 0)
  ) THEN
    RAISE EXCEPTION 'Another Finance V2 rollout transaction is already running';
  END IF;
END
$finance_v2_rollout_lock$;`;
}

export function loadStageBodies(files, { baseDir = REPO_ROOT, readFile = readFileSync } = {}) {
  return files.map((file) => ({
    file,
    body: stripMigrationTransactionControl(readFile(resolve(baseDir, file), "utf8"), file),
  }));
}

// Wrap ONE stage body in a locked transaction (default) — the forward-only unit of apply.
export function buildStageSql({ file, body }, { rollback = false, notify = !rollback } = {}) {
  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = ${sqlLiteral(FINANCE_V2_LOCK_TIMEOUT)};`,
    `SET LOCAL statement_timeout = ${sqlLiteral(FINANCE_V2_STATEMENT_TIMEOUT)};`,
    advisoryLockSql(),
    `\n-- finance v2 rollout stage: ${file}\n${body}`,
    notify ? "NOTIFY pgrst, 'reload schema';" : null,
    rollback ? "ROLLBACK;" : "COMMIT;",
  ]
    .filter(Boolean)
    .join("\n");
}

// Assemble MANY stages into one transaction (only for --atomic clean-room re-apply).
export function buildAtomicSql(stages, { rollback = false, notify = !rollback } = {}) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error("At least one stage body is required");
  }
  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = ${sqlLiteral(FINANCE_V2_LOCK_TIMEOUT)};`,
    `SET LOCAL statement_timeout = ${sqlLiteral(FINANCE_V2_STATEMENT_TIMEOUT)};`,
    advisoryLockSql(),
    ...stages.map(({ file, body }) => `\n-- finance v2 rollout stage: ${file}\n${body}`),
    notify ? "NOTIFY pgrst, 'reload schema';" : null,
    rollback ? "ROLLBACK;" : "COMMIT;",
  ]
    .filter(Boolean)
    .join("\n");
}

export function selectStages(files, only) {
  if (!only || only.length === 0) return files;
  const selected = files.filter((f) => only.some((needle) => f.includes(needle)));
  if (selected.length === 0) {
    throw new Error(`--only matched no stage in the manifest: ${only.join(", ")}`);
  }
  return selected;
}

export function parseApplyArgs(argv) {
  const opts = { dryRun: false, atomic: false, help: false, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--atomic") opts.atomic = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--only") {
      const next = argv[i + 1];
      if (!next) throw new Error("--only requires a filename substring");
      opts.only.push(next);
      i += 1;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function printUsage(log) {
  log("Usage: node scripts/apply-finance-v2-rollout.mjs [--dry-run] [--atomic] [--only <substr>]...");
  log("  default          Apply selected stages SEQUENTIALLY (each its own locked transaction).");
  log("  --only <substr>  Apply only manifest stages whose path contains <substr> (repeatable).");
  log("  --atomic         Apply all selected stages in ONE transaction (clean-room DEMO only).");
  log("  --dry-run        Assemble + digest the payload(s) without calling Supabase.");
  log(`  ${FINANCE_V2_CATALOG_SCOPE_NOTICE}`);
}

export async function main(
  argv = process.argv.slice(2),
  { log = console.log, fetchImpl = fetch, loadConfig = loadSupabaseAdminConfig } = {},
) {
  const opts = parseApplyArgs(argv);
  if (opts.help) return printUsage(log);
  log(FINANCE_V2_CATALOG_SCOPE_NOTICE);

  const files = selectStages([...FINANCE_V2_MIGRATIONS], opts.only);
  const stages = loadStageBodies(files);

  if (opts.atomic) {
    const sql = buildAtomicSql(stages);
    const digest = createHash("sha256").update(sql).digest("hex");
    if (opts.dryRun) {
      log(`Static dry run (atomic): ${stages.length} stage(s) in one transaction (sha256 ${digest}).`);
      log(FINANCE_V2_STATIC_NOTICE);
      return;
    }
    await executeManagementQuery(sql, loadConfig(), fetchImpl);
    log(`Applied ${stages.length} Finance V2 stage(s) atomically (sha256 ${digest}).`);
    return;
  }

  // Sequential per-stage apply (forward-only). Compute digests up front for auditability.
  const digests = stages.map((stage) => ({
    file: stage.file,
    digest: createHash("sha256").update(buildStageSql(stage)).digest("hex"),
  }));
  const bundleDigest = createHash("sha256")
    .update(digests.map((d) => `${d.file}:${d.digest}`).join("\n"))
    .digest("hex");

  if (opts.dryRun) {
    for (const d of digests) log(`  stage ${d.file} sha256 ${d.digest}`);
    log(`Static dry run (sequential): ${stages.length} stage(s), bundle sha256 ${bundleDigest}.`);
    log(FINANCE_V2_STATIC_NOTICE);
    return;
  }

  const config = loadConfig();
  for (const stage of stages) {
    const sql = buildStageSql(stage);
    const digest = createHash("sha256").update(sql).digest("hex");
    await executeManagementQuery(sql, config, fetchImpl);
    log(`Applied stage ${stage.file} (sha256 ${digest}).`);
  }
  log(`Applied ${stages.length} Finance V2 stage(s) sequentially; bundle sha256 ${bundleDigest}.`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
