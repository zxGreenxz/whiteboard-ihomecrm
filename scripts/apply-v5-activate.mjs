// Activate the two core V5 collection money routes (CANARY -> ON) globally.
//
// This script drives Phase 7 (§12.3) of PLAN-HOAN-THIEN-V5-COLLECTION-2026-07-22.
// It never touches customer.credit.apply.v1 or shareholder_profit.distribute.v2.
// Every mutation runs inside ONE serialized, timed transaction that pre-asserts
// activation gates and self-asserts postconditions with RAISE (fail-closed).
// --dry-run performs every change then ROLLBACK.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeManagementQuery,
  loadSupabaseAdminConfig,
  ROLLOUT_LOCK_TIMEOUT,
  ROLLOUT_STATEMENT_TIMEOUT,
} from "./apply-accounting-rollout.mjs";
import {
  DEMO_ORG,
  FLAG_RECORD,
  FLAG_REVERSE,
  FLAGS_ASC,
  REAL_ORG,
  resolveMigrationSha256,
} from "./apply-v5-canary.mjs";

export const MAINTENANCE_WINDOW_ID = "v5-collection-activate-20260722";
export const APPROVAL_REFERENCE = "user-approved-v5-completion-20260722";
export const DEFAULT_REASON =
  "V5 collection core activation (record + reverse) per PLAN §12.3";

const HEX40 = /^[0-9a-f]{40}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function parseActivateArgs(argv) {
  const opts = {
    commitSha: null,
    migrationSha256: null,
    provenanceFile: null,
    actor: null,
    reason: DEFAULT_REASON,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    if (arg === "--commit-sha") opts.commitSha = next().trim().toLowerCase();
    else if (arg === "--migration-sha256") opts.migrationSha256 = next();
    else if (arg === "--provenance-file") opts.provenanceFile = next();
    else if (arg === "--actor") opts.actor = next().trim();
    else if (arg === "--reason") opts.reason = next();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function validateReleaseIdentity(opts, deps) {
  if (!opts.commitSha || !HEX40.test(opts.commitSha)) {
    throw new Error("--commit-sha must be exactly 40 lowercase hex characters");
  }
  if (!opts.actor || !UUID_RE.test(opts.actor)) {
    throw new Error("--actor must be a uuid");
  }
  const migrationSha256 = resolveMigrationSha256(opts, deps);
  return { commitSha: opts.commitSha, migrationSha256, actor: opts.actor };
}

export function buildActivateSql(opts, identity) {
  const commit = sqlLiteral(identity.commitSha);
  const sha = sqlLiteral(identity.migrationSha256);
  const window = sqlLiteral(MAINTENANCE_WINDOW_ID);
  const approval = sqlLiteral(APPROVAL_REFERENCE);
  const actor = `${sqlLiteral(identity.actor)}::uuid`;
  const reason = sqlLiteral(opts.reason);
  const demo = `${sqlLiteral(DEMO_ORG)}::uuid`;
  const real = `${sqlLiteral(REAL_ORG)}::uuid`;
  const flagList = FLAGS_ASC.map(sqlLiteral).join(", ");

  // For ON, set_feature_route_v1 requires full release identity but not a
  // finite window or caps (those are CANARY-only). Pass now()/NULLs.
  const setter = (flagKey, expectedVar) =>
    `app_private.set_feature_route_v1(
      ${sqlLiteral(flagKey)}, ${expectedVar}, 'ON',
      now(), NULL, NULL, NULL, NULL,
      ${commit}, ${sha}, ${window}, ${approval}, ${actor}, ${reason}
    )`;

  const doBlock = `DO $activate$
DECLARE
  v_incomplete bigint;
  v_open_exceptions bigint;
  v_has_exc boolean;
  v_mode_reverse text;
  v_mode_record text;
  v_ver_reverse bigint;
  v_ver_record bigint;
  v_new bigint;
  k text;
  v_real text;
BEGIN
  -- Lock both flag rows up front in ascending feature_key order.
  SELECT mode, config_version INTO v_mode_reverse, v_ver_reverse
  FROM app_private.server_feature_flags
  WHERE feature_key = ${sqlLiteral(FLAG_REVERSE)}
  FOR UPDATE;
  SELECT mode, config_version INTO v_mode_record, v_ver_record
  FROM app_private.server_feature_flags
  WHERE feature_key = ${sqlLiteral(FLAG_RECORD)}
  FOR UPDATE;

  -- PRE-ASSERT: activation gate must be fully clear.
  SELECT count(*) INTO v_incomplete
  FROM app_private.canonical_write_operations
  WHERE completed_at IS NULL;
  IF v_incomplete <> 0 THEN
    RAISE EXCEPTION 'V5 activation blocked: % incomplete canonical write operation(s) (must be 0)', v_incomplete;
  END IF;

  IF v_mode_reverse IS DISTINCT FROM 'CANARY'
     OR v_mode_record IS DISTINCT FROM 'CANARY' THEN
    RAISE EXCEPTION 'V5 activation blocked: both flags must be CANARY, got record=%, reverse=%',
      v_mode_record, v_mode_reverse;
  END IF;

  v_has_exc := to_regclass('public.accounting_integrity_exceptions') IS NOT NULL;
  IF v_has_exc THEN
    SELECT count(*) INTO v_open_exceptions
    FROM public.accounting_integrity_exceptions
    WHERE status = 'OPEN';
    IF v_open_exceptions <> 0 THEN
      RAISE EXCEPTION 'V5 activation blocked: % open accounting integrity exception(s)', v_open_exceptions;
    END IF;
  END IF;

  -- Flip both flags to ON with each flag's just-read config_version.
  v_new := ${setter(FLAG_REVERSE, "v_ver_reverse")};
  RAISE NOTICE '${FLAG_REVERSE} -> ON config_version %', v_new;
  v_new := ${setter(FLAG_RECORD, "v_ver_record")};
  RAISE NOTICE '${FLAG_RECORD} -> ON config_version %', v_new;

  -- POST-ASSERT: every org (real included) now evaluates CANONICAL.
  FOREACH k IN ARRAY ARRAY[${flagList}] LOOP
    v_real := app_private.evaluate_feature_route(k, ${real});
    IF v_real <> 'CANONICAL' THEN
      RAISE EXCEPTION 'V5 activation postcondition failed: % real route=% (want CANONICAL)', k, v_real;
    END IF;
  END LOOP;
END
$activate$;`;

  const report = `SELECT jsonb_build_object(
  'flags', COALESCE(jsonb_object_agg(f.feature_key, jsonb_build_object(
    'mode', f.mode,
    'force_freeze', f.force_freeze,
    'config_version', f.config_version,
    'commit_sha', f.commit_sha,
    'demo_route', app_private.evaluate_feature_route(f.feature_key, ${demo}),
    'real_route', app_private.evaluate_feature_route(f.feature_key, ${real})
  )), '{}'::jsonb),
  'incomplete_canonical_operations', (
    SELECT count(*) FROM app_private.canonical_write_operations
    WHERE completed_at IS NULL
  ),
  'open_integrity_exceptions', CASE
    WHEN to_regclass('public.accounting_integrity_exceptions') IS NULL THEN NULL
    ELSE (
      SELECT count(*) FROM public.accounting_integrity_exceptions
      WHERE status = 'OPEN'
    )
  END
) AS v5_activate_report
FROM app_private.server_feature_flags f
WHERE f.feature_key IN (${flagList});`;

  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = ${sqlLiteral(ROLLOUT_LOCK_TIMEOUT)};`,
    `SET LOCAL statement_timeout = ${sqlLiteral(ROLLOUT_STATEMENT_TIMEOUT)};`,
    doBlock,
    report,
    opts.dryRun ? "ROLLBACK;" : "COMMIT;",
  ].join("\n");
}

function parseReport(body, alias) {
  const parsed = JSON.parse(body);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const row = rows.find((candidate) => candidate?.[alias] !== undefined);
  if (!row) throw new Error(`Rollout query returned no ${alias} row`);
  return row[alias];
}

export function assertActivateReport(report) {
  const failures = [];
  const flags = report?.flags ?? {};
  for (const key of FLAGS_ASC) {
    const flag = flags[key];
    if (!flag) {
      failures.push(`${key}: missing from report`);
      continue;
    }
    if (flag.mode !== "ON") failures.push(`${key}: mode=${flag.mode} (want ON)`);
    if (flag.demo_route !== "CANONICAL")
      failures.push(`${key}: demo_route=${flag.demo_route} (want CANONICAL)`);
    if (flag.real_route !== "CANONICAL")
      failures.push(`${key}: real_route=${flag.real_route} (want CANONICAL)`);
  }
  const incomplete = Number(report?.incomplete_canonical_operations ?? -1);
  if (incomplete !== 0) {
    failures.push(`incomplete_canonical_operations=${incomplete} (want 0)`);
  }
  if (failures.length > 0) {
    throw new Error(`V5 activation postcondition check failed:\n  ${failures.join("\n  ")}`);
  }
}

export async function main(
  argv = process.argv.slice(2),
  {
    log = console.log,
    warn = console.warn,
    fetchImpl = fetch,
    loadConfig = loadSupabaseAdminConfig,
    readFile = readFileSync,
  } = {},
) {
  const opts = parseActivateArgs(argv);
  if (opts.help) {
    log("Usage: node scripts/apply-v5-activate.mjs --commit-sha <40hex> \\");
    log("         (--migration-sha256 <64hex> | --provenance-file <path>) \\");
    log("         --actor <uuid> [--reason <text>] [--dry-run]");
    log("  Activates the two core V5 collection money routes (CANARY -> ON).");
    log("  Pre-asserts 0 incomplete canonical operations, both flags CANARY, 0 open exceptions.");
    log("  --dry-run performs every change then ROLLBACK.");
    return 0;
  }

  const identity = validateReleaseIdentity(opts, { readFile });
  const sql = buildActivateSql(opts, identity);

  if (opts.dryRun) {
    warn("DRY RUN: activation executes inside a transaction and is ROLLED BACK.");
  }

  const body = await executeManagementQuery(sql, loadConfig(), fetchImpl);
  const report = parseReport(body, "v5_activate_report");
  assertActivateReport(report);

  log(JSON.stringify(report, null, 2));
  log(
    opts.dryRun
      ? "V5 activation dry run passed (ROLLED BACK): both core routes would be ON and CANONICAL for all orgs."
      : "V5 activation applied: both core routes ON and CANONICAL for all orgs.",
  );
  return 0;
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
