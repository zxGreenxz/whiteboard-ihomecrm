// Enroll DEMO into the V5 collection canary and flip both money routes to CANARY.
//
// This script drives Phase 7 (§12.2) of PLAN-HOAN-THIEN-V5-COLLECTION-2026-07-22.
// It only ever writes to the DEMO organization; the real organization is never
// enrolled or activated here. Every mutation runs inside ONE serialized, timed
// transaction that self-asserts its postconditions with RAISE (fail-closed) and
// can be rehearsed with --dry-run (ROLLBACK).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  executeManagementQuery,
  loadSupabaseAdminConfig,
  ROLLOUT_LOCK_TIMEOUT,
  ROLLOUT_STATEMENT_TIMEOUT,
} from "./apply-accounting-rollout.mjs";

export const DEMO_ORG = "dddd0000-0000-4000-8000-000000000001";
export const REAL_ORG = "aaaa0000-0000-4000-8000-000000000001";
export const FLAG_RECORD = "invoice.collection.v5";
export const FLAG_REVERSE = "invoice.collection.reverse.v5";
// Locked in ascending feature_key order to keep a single, deadlock-free lock
// discipline across every rollout/freeze script.
export const FLAGS_ASC = Object.freeze([FLAG_REVERSE, FLAG_RECORD]);

export const DEFAULT_EXPECTED_CONFIG_VERSION = 4;
export const CANARY_MAX_OPERATION_COUNT = 500;
export const CANARY_MAX_SINGLE_AMOUNT_VND = 500000000;
export const CANARY_MAX_TOTAL_AMOUNT_VND = 5000000000;
export const CANARY_WINDOW_INTERVAL = "30 days";
export const MAINTENANCE_WINDOW_ID = "v5-collection-canary-20260722";
export const APPROVAL_REFERENCE = "user-approved-v5-completion-20260722";
export const DEFAULT_REASON =
  "V5 collection canary enrollment (DEMO only) per PLAN §12.2";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fileSha256Hex(path, readFile = readFileSync) {
  return createHash("sha256").update(readFile(path)).digest("hex");
}

export function resolveMigrationSha256(
  { migrationSha256, provenanceFile },
  { readFile = readFileSync } = {},
) {
  const hasDirect = typeof migrationSha256 === "string" && migrationSha256.length > 0;
  const hasFile = typeof provenanceFile === "string" && provenanceFile.length > 0;
  if (hasDirect && hasFile) {
    throw new Error("Pass either --migration-sha256 or --provenance-file, not both");
  }
  if (!hasDirect && !hasFile) {
    throw new Error("Provide --migration-sha256 <64hex> or --provenance-file <path>");
  }
  const digest = hasDirect
    ? migrationSha256.trim().toLowerCase()
    : fileSha256Hex(provenanceFile, readFile);
  if (!HEX64.test(digest)) {
    throw new Error("migration-sha256 must be 64 lowercase hex characters");
  }
  return digest;
}

export function parseCanaryArgs(argv) {
  const opts = {
    commitSha: null,
    migrationSha256: null,
    provenanceFile: null,
    actor: null,
    reason: DEFAULT_REASON,
    expectedConfigVersion: DEFAULT_EXPECTED_CONFIG_VERSION,
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
    else if (arg === "--expected-config-version")
      opts.expectedConfigVersion = Number.parseInt(next(), 10);
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
  if (!Number.isInteger(opts.expectedConfigVersion)) {
    throw new Error("--expected-config-version must be an integer");
  }
  const migrationSha256 = resolveMigrationSha256(opts, deps);
  return { commitSha: opts.commitSha, migrationSha256, actor: opts.actor };
}

export function buildCanarySql(opts, identity) {
  const commit = sqlLiteral(identity.commitSha);
  const sha = sqlLiteral(identity.migrationSha256);
  const window = sqlLiteral(MAINTENANCE_WINDOW_ID);
  const approval = sqlLiteral(APPROVAL_REFERENCE);
  const actor = `${sqlLiteral(identity.actor)}::uuid`;
  const reason = sqlLiteral(opts.reason);
  const demo = `${sqlLiteral(DEMO_ORG)}::uuid`;
  const real = `${sqlLiteral(REAL_ORG)}::uuid`;
  const flagList = FLAGS_ASC.map(sqlLiteral).join(", ");

  const setterArgs = (flagKey) =>
    `app_private.set_feature_route_v1(
      ${sqlLiteral(flagKey)}, v_expected, 'CANARY',
      now(), now() + interval ${sqlLiteral(CANARY_WINDOW_INTERVAL)},
      ${CANARY_MAX_OPERATION_COUNT}, ${CANARY_MAX_SINGLE_AMOUNT_VND}, ${CANARY_MAX_TOTAL_AMOUNT_VND},
      ${commit}, ${sha}, ${window}, ${approval}, ${actor}, ${reason}
    )`;

  // Enroll DEMO for BOTH flags while they are still SHADOW so the canary
  // enrollment guard skips assert_accounting_feature_activation_v1. Only after
  // enrollment do we flip both flags to CANARY.
  const enroll = `INSERT INTO app_private.server_feature_flag_canary_orgs
  (feature_key, organization_id, added_by, added_at)
VALUES
  (${sqlLiteral(FLAG_REVERSE)}, ${demo}, ${actor}, now()),
  (${sqlLiteral(FLAG_RECORD)}, ${demo}, ${actor}, now())
ON CONFLICT DO NOTHING;`;

  const doBlock = `DO $canary$
DECLARE
  v_expected bigint := ${opts.expectedConfigVersion};
  v_new bigint;
  k text;
  v_demo text;
  v_real text;
BEGIN
  v_new := ${setterArgs(FLAG_REVERSE)};
  RAISE NOTICE '${FLAG_REVERSE} -> CANARY config_version %', v_new;
  v_new := ${setterArgs(FLAG_RECORD)};
  RAISE NOTICE '${FLAG_RECORD} -> CANARY config_version %', v_new;

  FOREACH k IN ARRAY ARRAY[${flagList}] LOOP
    v_demo := app_private.evaluate_feature_route(k, ${demo});
    v_real := app_private.evaluate_feature_route(k, ${real});
    IF v_demo <> 'CANONICAL' THEN
      RAISE EXCEPTION 'V5 canary postcondition failed: % DEMO route=% (want CANONICAL)', k, v_demo;
    END IF;
    IF v_real = 'CANONICAL' THEN
      RAISE EXCEPTION 'V5 canary postcondition failed: % REAL route=% (real org must NEVER be CANONICAL during canary; a non-enrolled org under CANARY evaluates LEGACY)', k, v_real;
    END IF;
  END LOOP;
END
$canary$;`;

  const report = `SELECT jsonb_build_object(
  'flags', COALESCE(jsonb_object_agg(f.feature_key, jsonb_build_object(
    'mode', f.mode,
    'force_freeze', f.force_freeze,
    'config_version', f.config_version,
    'starts_at', f.starts_at,
    'ends_at', f.ends_at,
    'max_operation_count', f.max_operation_count,
    'max_single_amount_vnd', f.max_single_amount_vnd,
    'max_total_amount_vnd', f.max_total_amount_vnd,
    'commit_sha', f.commit_sha,
    'demo_route', app_private.evaluate_feature_route(f.feature_key, ${demo}),
    'real_route', app_private.evaluate_feature_route(f.feature_key, ${real})
  )), '{}'::jsonb),
  'canary_orgs', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'feature_key', c.feature_key,
      'organization_id', c.organization_id
    ) ORDER BY c.feature_key, c.organization_id)
    FROM app_private.server_feature_flag_canary_orgs c
    WHERE c.feature_key IN (${flagList})
  ), '[]'::jsonb)
) AS v5_canary_report
FROM app_private.server_feature_flags f
WHERE f.feature_key IN (${flagList});`;

  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = ${sqlLiteral(ROLLOUT_LOCK_TIMEOUT)};`,
    `SET LOCAL statement_timeout = ${sqlLiteral(ROLLOUT_STATEMENT_TIMEOUT)};`,
    enroll,
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

export function assertCanaryReport(report) {
  const flags = report?.flags ?? {};
  const failures = [];
  for (const key of FLAGS_ASC) {
    const flag = flags[key];
    if (!flag) {
      failures.push(`${key}: missing from report`);
      continue;
    }
    if (flag.mode !== "CANARY") failures.push(`${key}: mode=${flag.mode} (want CANARY)`);
    if (flag.force_freeze !== false)
      failures.push(`${key}: force_freeze=${flag.force_freeze} (want false)`);
    if (flag.demo_route !== "CANONICAL")
      failures.push(`${key}: demo_route=${flag.demo_route} (want CANONICAL)`);
    if (flag.real_route === "CANONICAL")
      failures.push(`${key}: real_route=${flag.real_route} (real org must NOT be CANONICAL during canary)`);
  }
  if (failures.length > 0) {
    throw new Error(`V5 canary postcondition check failed:\n  ${failures.join("\n  ")}`);
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
  const opts = parseCanaryArgs(argv);
  if (opts.help) {
    log("Usage: node scripts/apply-v5-canary.mjs --commit-sha <40hex> \\");
    log("         (--migration-sha256 <64hex> | --provenance-file <path>) \\");
    log("         --actor <uuid> [--reason <text>] [--expected-config-version <int>] [--dry-run]");
    log("  Enrolls DEMO into the V5 collection canary and flips both money routes to CANARY.");
    log("  --dry-run performs every change then ROLLBACK (no production write).");
    log("  The real organization is never enrolled or activated.");
    return 0;
  }

  const identity = validateReleaseIdentity(opts, { readFile });
  const sql = buildCanarySql(opts, identity);

  if (opts.dryRun) {
    warn("DRY RUN: changes execute inside a transaction and are ROLLED BACK.");
  }

  const body = await executeManagementQuery(sql, loadConfig(), fetchImpl);
  const report = parseReport(body, "v5_canary_report");
  assertCanaryReport(report);

  log(JSON.stringify(report, null, 2));
  log(
    opts.dryRun
      ? "V5 canary dry run passed (ROLLED BACK): both routes would be CANARY, DEMO CANONICAL, real org NOT canonical (LEGACY under CANARY)."
      : "V5 canary applied: both routes CANARY, DEMO CANONICAL, real org NOT canonical (LEGACY under CANARY).",
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
