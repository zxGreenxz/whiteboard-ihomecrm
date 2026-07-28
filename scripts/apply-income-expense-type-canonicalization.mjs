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

export const CANONICALIZATION_MIGRATION =
  "supabase/migrations/20260728180000_income_expense_type_canonicalization.sql";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function buildIncomeExpenseTypeCanonicalizationRollout() {
  const migrations = loadMigrationBodies([CANONICALIZATION_MIGRATION]);
  const applySql = buildRolloutSql(migrations);
  const rollbackSql = buildRolloutSql(migrations, {
    rollback: true,
    notify: false,
  });
  const sha256 = createHash("sha256").update(applySql).digest("hex");

  return { migrations, applySql, rollbackSql, sha256 };
}

export function parseCanonicalizationArgs(argv) {
  let mode = null;
  let expectedSha256 = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (mode) throw new Error("Choose exactly one rollout mode");
      mode = "dry-run";
    } else if (argument === "--rollback") {
      if (mode) throw new Error("Choose exactly one rollout mode");
      mode = "rollback";
    } else if (argument === "--apply") {
      if (mode) throw new Error("Choose exactly one rollout mode");
      mode = "apply";
    } else if (argument === "--expected-sha256") {
      expectedSha256 = argv[index + 1]?.toLowerCase() ?? "";
      index += 1;
      if (!SHA256_PATTERN.test(expectedSha256)) {
        throw new Error("--expected-sha256 must be a 64-character SHA-256");
      }
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (help) return { mode, expectedSha256, help };
  if (!mode) throw new Error("A rollout mode is required");
  if (mode !== "dry-run" && expectedSha256 === null) {
    throw new Error(`${mode} requires --expected-sha256 with a fresh SHA-256`);
  }

  return { mode, expectedSha256, help };
}

function printUsage(log) {
  log(
    "Usage: node scripts/apply-income-expense-type-canonicalization.mjs --dry-run",
  );
  log(
    "       node scripts/apply-income-expense-type-canonicalization.mjs --rollback --expected-sha256 <sha256>",
  );
  log(
    "       node scripts/apply-income-expense-type-canonicalization.mjs --apply --expected-sha256 <sha256>",
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
  const options = parseCanonicalizationArgs(argv);
  if (options.help) {
    printUsage(log);
    return;
  }

  const rollout = buildIncomeExpenseTypeCanonicalizationRollout();
  if (options.mode === "dry-run") {
    log(
      `Static dry run passed: prepared 1 migration atomically (sha256 ${rollout.sha256}).`,
    );
    log("No Management API request was executed.");
    return;
  }

  if (options.expectedSha256 !== rollout.sha256) {
    throw new Error(
      `Canonicalization rollout hash mismatch: expected ${options.expectedSha256}, got ${rollout.sha256}`,
    );
  }

  const sql = options.mode === "rollback" ? rollout.rollbackSql : rollout.applySql;
  await execute(sql, loadConfig());
  log(
    options.mode === "rollback"
      ? `Rollback validation passed for canonicalization migration (sha256 ${rollout.sha256}).`
      : `Applied canonicalization migration atomically (sha256 ${rollout.sha256}).`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
