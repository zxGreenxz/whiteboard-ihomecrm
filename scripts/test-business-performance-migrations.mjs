import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripMigrationTransactionControl } from "./apply-accounting-rollout.mjs";
import {
  executeManagementQuery,
  loadAdminConfig,
} from "./test-business-performance-authz.mjs";

// fileURLToPath chứ không phải `.pathname` — xem ghi chú đầy đủ ở
// scripts/test-openclaw-migrations.mjs: `.pathname` giữ percent-encoding nên
// đường dẫn có dấu cách thành `%20` và fs không mở được file.
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIGRATION_ROOT = resolve(ROOT, "supabase", "migrations");

function resolveMigration(input) {
  const absolute = resolve(ROOT, input);
  const fromMigrationRoot = relative(MIGRATION_ROOT, absolute);
  if (
    !input.endsWith(".sql") ||
    fromMigrationRoot === "" ||
    fromMigrationRoot.startsWith(`..${sep}`) ||
    fromMigrationRoot === ".."
  ) {
    throw new Error(`Expected a SQL file below supabase/migrations: ${input}`);
  }
  return absolute;
}

export function buildRollbackMigrationQuery(inputs, readFile = readFileSync) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("Pass at least one migration path");
  }

  const bodies = inputs.map((input) => {
    const path = resolveMigration(input);
    const sql = readFile(path, "utf8");
    return {
      path,
      body: stripMigrationTransactionControl(sql, input),
      sha256: createHash("sha256").update(sql).digest("hex"),
    };
  });

  return {
    migrations: bodies.map(({ path, sha256 }) => ({ path, sha256 })),
    query: [
      "BEGIN;",
      "SET LOCAL statement_timeout = '120s';",
      "SET LOCAL lock_timeout = '10s';",
      "SELECT pg_advisory_xact_lock(hashtext('business-performance-migration-test'));",
      ...bodies.map(({ body }) => body),
      "ROLLBACK;",
    ].join("\n"),
  };
}

export async function main({
  argv = process.argv.slice(2),
  loadConfig = loadAdminConfig,
  execute = executeManagementQuery,
  log = console.log,
} = {}) {
  const { migrations, query } = buildRollbackMigrationQuery(argv);
  await execute(query, loadConfig());
  for (const migration of migrations) {
    log(`Rollback compile passed: ${migration.path} (sha256 ${migration.sha256}).`);
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
