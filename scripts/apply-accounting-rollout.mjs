// Apply the accounting rollout as one serialized, all-or-nothing transaction.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ACCOUNTING_MIGRATIONS = Object.freeze([
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

export const ROLLOUT_LOCK_NAME = "ihomecrm:accounting-rollout:v1";
export const ROLLOUT_LOCK_TIMEOUT = "5s";
export const ROLLOUT_STATEMENT_TIMEOUT = "15min";
export const ROLLOUT_CATALOG_SCOPE_NOTICE =
  "This script is production-catalog-only: it requires the existing authz foundation, does not support a fresh reset/bare database, and must not be used instead of foundation migrations.";
export const STATIC_VALIDATION_NOTICE =
  "Static only: no target catalog was queried; prerequisite guards run only during live rollback validation or apply.";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BEGIN_LINE = /^\s*BEGIN\s*;\s*$/i;
const COMMIT_LINE = /^\s*COMMIT\s*;\s*$/i;
const PGRST_NOTIFY_LINE =
  /^\s*NOTIFY\s+pgrst\s*,\s*'reload schema'\s*;\s*$/i;

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function matchingLineIndexes(lines, pattern) {
  const indexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) indexes.push(index);
  }
  return indexes;
}

export function stripMigrationTransactionControl(sql, file = "migration.sql") {
  const lines = sql.replace(/^\uFEFF/, "").split(/\r?\n/);
  const beginIndexes = matchingLineIndexes(lines, BEGIN_LINE);
  const commitIndexes = matchingLineIndexes(lines, COMMIT_LINE);
  const notifyIndexes = matchingLineIndexes(lines, PGRST_NOTIFY_LINE);

  if (beginIndexes.length !== 1 || commitIndexes.length !== 1) {
    throw new Error(
      `${file} must contain exactly one standalone BEGIN; and COMMIT; wrapper`,
    );
  }
  if (beginIndexes[0] >= commitIndexes[0]) {
    throw new Error(`${file} has an invalid transaction wrapper order`);
  }
  if (notifyIndexes.length > 1) {
    throw new Error(`${file} contains more than one pgrst schema notification`);
  }
  if (
    notifyIndexes.length === 1 &&
    notifyIndexes[0] < commitIndexes[0]
  ) {
    throw new Error(`${file} must notify pgrst only after its COMMIT; wrapper`);
  }

  const controls = new Set([
    ...beginIndexes,
    ...commitIndexes,
    ...notifyIndexes,
  ]);
  const body = lines
    .filter((_, index) => !controls.has(index))
    .join("\n")
    .trim();

  if (!body) throw new Error(`${file} is empty after removing its wrapper`);
  return body;
}

export function loadMigrationBodies(
  files = ACCOUNTING_MIGRATIONS,
  { baseDir = REPO_ROOT, readFile = readFileSync } = {},
) {
  return files.map((file) => ({
    file,
    body: stripMigrationTransactionControl(
      readFile(resolve(baseDir, file), "utf8"),
      file,
    ),
  }));
}

function advisoryLockSql() {
  return `DO $accounting_rollout_lock$
BEGIN
  IF NOT pg_try_advisory_xact_lock(
    hashtextextended(${sqlLiteral(ROLLOUT_LOCK_NAME)}, 0)
  ) THEN
    RAISE EXCEPTION 'Another accounting rollout transaction is already running';
  END IF;
END
$accounting_rollout_lock$;`;
}

export function buildRolloutSql(
  migrations,
  { rollback = false, notify = !rollback } = {},
) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new Error("At least one migration body is required");
  }

  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = ${sqlLiteral(ROLLOUT_LOCK_TIMEOUT)};`,
    `SET LOCAL statement_timeout = ${sqlLiteral(ROLLOUT_STATEMENT_TIMEOUT)};`,
    advisoryLockSql(),
    ...migrations.map(
      ({ file, body }) => `\n-- accounting rollout: ${file}\n${body}`,
    ),
    notify ? "NOTIFY pgrst, 'reload schema';" : null,
    rollback ? "ROLLBACK;" : "COMMIT;",
  ]
    .filter(Boolean)
    .join("\n");
}

function readOptionalFile(url, readFile) {
  try {
    return readFile(url, "utf8");
  } catch {
    return null;
  }
}

export function loadSupabaseAdminConfig({
  env = process.env,
  readFile = readFileSync,
} = {}) {
  let pat = env.SUPABASE_PAT?.trim();
  if (!pat) {
    const localConfig = readOptionalFile(
      new URL("../CLAUDE.local.md", import.meta.url),
      readFile,
    );
    pat = localConfig?.match(/\bsbp_[A-Za-z0-9_-]+\b/)?.[0];
  }
  if (!pat) {
    throw new Error(
      "Missing Supabase PAT (set SUPABASE_PAT or configure CLAUDE.local.md)",
    );
  }

  let projectRef = env.SUPABASE_PROJECT_REF?.trim();
  if (!projectRef) {
    projectRef = readOptionalFile(
      new URL("../supabase/.temp/project-ref", import.meta.url),
      readFile,
    )?.trim();
  }
  if (!projectRef) {
    const config = readOptionalFile(
      new URL("../supabase/config.toml", import.meta.url),
      readFile,
    );
    projectRef = config?.match(/project_id\s*=\s*"([a-z0-9]+)"/i)?.[1];
  }
  if (!projectRef || !/^[a-z0-9]+$/i.test(projectRef)) {
    throw new Error("Missing or invalid Supabase project reference");
  }

  return { pat, projectRef };
}

function redact(value, secret) {
  return secret ? String(value).replaceAll(secret, "[REDACTED]") : String(value);
}

export async function executeManagementQuery(
  query,
  { pat, projectRef },
  fetchImpl = fetch,
) {
  let response;
  try {
    response = await fetchImpl(
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Supabase database query request failed: ${redact(message, pat)}`);
  }

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Supabase database query failed (${response.status}): ${redact(body, pat).slice(0, 4000)}`,
    );
  }
  return body;
}

export function parseApplyArgs(argv) {
  let dryRun = false;
  let help = false;

  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { dryRun, help };
}

function printUsage(log) {
  log("Usage: node scripts/apply-accounting-rollout.mjs [--dry-run]");
  log("  --dry-run  Build and validate the atomic payload without calling Supabase.");
  log(`  ${ROLLOUT_CATALOG_SCOPE_NOTICE}`);
  log(`  ${STATIC_VALIDATION_NOTICE}`);
}

export async function main(
  argv = process.argv.slice(2),
  {
    log = console.log,
    fetchImpl = fetch,
    loadConfig = loadSupabaseAdminConfig,
  } = {},
) {
  const { dryRun, help } = parseApplyArgs(argv);
  if (help) {
    printUsage(log);
    return;
  }

  log(ROLLOUT_CATALOG_SCOPE_NOTICE);

  const migrations = loadMigrationBodies(ACCOUNTING_MIGRATIONS);
  if (migrations.length !== 14) {
    throw new Error(`Expected exactly 14 accounting migrations, got ${migrations.length}`);
  }
  const sql = buildRolloutSql(migrations);
  const digest = createHash("sha256").update(sql).digest("hex");

  if (dryRun) {
    log(
      `Static dry run passed: prepared ${migrations.length} migration(s) in one transaction (sha256 ${digest}).`,
    );
    log(STATIC_VALIDATION_NOTICE);
    log("No database query was executed.");
    return;
  }

  const config = loadConfig();
  await executeManagementQuery(sql, config, fetchImpl);
  log(
    `Applied ${migrations.length} accounting migration(s) atomically (sha256 ${digest}).`,
  );
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
