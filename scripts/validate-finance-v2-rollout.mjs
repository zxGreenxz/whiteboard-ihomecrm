// Validate the Finance V2 stage manifest. Static (digest) by default; --live-rollback
// compiles the selected stages IN ORDER against the live catalog inside one timed
// transaction, then ROLLBACK (nothing is persisted). Plan §10.0 / §16.6.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { executeManagementQuery, loadSupabaseAdminConfig } from "./apply-accounting-rollout.mjs";
import {
  FINANCE_V2_MIGRATIONS,
  FINANCE_V2_CATALOG_SCOPE_NOTICE,
  FINANCE_V2_STATIC_NOTICE,
  buildAtomicSql,
  loadStageBodies,
  selectStages,
} from "./apply-finance-v2-rollout.mjs";

export function parseValidateArgs(argv) {
  const opts = { liveRollback: false, help: false, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live-rollback") opts.liveRollback = true;
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
  log("Usage: node scripts/validate-finance-v2-rollout.mjs [--live-rollback] [--only <substr>]...");
  log("  default          Assemble + digest selected stages locally only.");
  log("  --live-rollback  Compile selected stages in order against live catalog, then ROLLBACK.");
  log("  --only <substr>  Restrict to manifest stages whose path contains <substr> (repeatable).");
  log(`  ${FINANCE_V2_CATALOG_SCOPE_NOTICE}`);
}

export async function main(
  argv = process.argv.slice(2),
  { log = console.log, warn = console.warn, fetchImpl = fetch, loadConfig = loadSupabaseAdminConfig } = {},
) {
  const opts = parseValidateArgs(argv);
  if (opts.help) return printUsage(log);
  log(FINANCE_V2_CATALOG_SCOPE_NOTICE);

  const files = selectStages([...FINANCE_V2_MIGRATIONS], opts.only);
  const stages = loadStageBodies(files);
  const sql = buildAtomicSql(stages, { rollback: true, notify: false });
  const digest = createHash("sha256").update(sql).digest("hex");

  if (!opts.liveRollback) {
    log(`Static validation passed for ${stages.length} stage(s) (sha256 ${digest}).`);
    log(FINANCE_V2_STATIC_NOTICE);
    log("No database query was executed. Use --live-rollback to opt in to live DDL validation.");
    return;
  }

  warn("Live rollback validation enabled: DDL runs with lock/statement timeouts, then ROLLBACK.");
  await executeManagementQuery(sql, loadConfig(), fetchImpl);
  log(`Validated ${stages.length} Finance V2 stage(s) live with ROLLBACK (sha256 ${digest}).`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
