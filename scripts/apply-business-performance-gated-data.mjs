import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildRolloutSql,
  loadMigrationBodies,
} from "./apply-accounting-rollout.mjs";
import {
  executeManagementQuery,
  loadAdminConfig,
} from "./test-business-performance-authz.mjs";

export const BUSINESS_PERFORMANCE_GATED_DATA_MIGRATIONS = Object.freeze([
  "supabase/migrations/20260728010000_business_performance_month_snapshots.sql",
  "supabase/migrations/20260728020000_business_performance_finance_roles_and_break_even.sql",
  "supabase/migrations/20260728030000_business_performance_invoice_cohort_and_categories.sql",
  "supabase/migrations/20260728040000_business_performance_inventory_history_safe_scope.sql",
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function buildBusinessPerformanceGatedDataRollout() {
  const migrations = loadMigrationBodies(
    BUSINESS_PERFORMANCE_GATED_DATA_MIGRATIONS,
  );
  const sql = buildRolloutSql(migrations);
  return {
    migrations,
    sql,
    sha256: createHash("sha256").update(sql).digest("hex"),
  };
}

export function parseRolloutArgs(argv) {
  let dryRun = false;
  let expectedSha256 = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--expected-sha256") {
      expectedSha256 = argv[index + 1]?.toLowerCase() ?? "";
      index += 1;
      if (!SHA256_PATTERN.test(expectedSha256)) {
        throw new Error("--expected-sha256 must be a 64-character lowercase SHA-256");
      }
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!dryRun && !help && expectedSha256 === null) {
    throw new Error("Live apply requires --expected-sha256 from a fresh dry run");
  }
  return { dryRun, expectedSha256, help };
}

function printUsage(log) {
  log(
    "Usage: node scripts/apply-business-performance-gated-data.mjs --dry-run",
  );
  log(
    "       node scripts/apply-business-performance-gated-data.mjs --expected-sha256 <sha256>",
  );
}

export async function main(
  argv = process.argv.slice(2),
  {
    loadConfig = loadAdminConfig,
    execute = executeManagementQuery,
    log = console.log,
  } = {},
) {
  const options = parseRolloutArgs(argv);
  if (options.help) {
    printUsage(log);
    return;
  }

  const rollout = buildBusinessPerformanceGatedDataRollout();
  if (options.dryRun) {
    log(
      `Static dry run passed: prepared ${rollout.migrations.length} migration(s) atomically (sha256 ${rollout.sha256}).`,
    );
    log("No Management API request was executed.");
    return;
  }

  if (options.expectedSha256 !== rollout.sha256) {
    throw new Error(
      `Business-performance rollout hash mismatch: expected ${options.expectedSha256}, got ${rollout.sha256}`,
    );
  }

  await execute(rollout.sql, loadConfig());
  log(
    `Applied ${rollout.migrations.length} business-performance migration(s) atomically (sha256 ${rollout.sha256}).`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
