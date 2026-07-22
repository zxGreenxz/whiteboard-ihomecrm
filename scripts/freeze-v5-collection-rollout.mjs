// Fail-closed freeze (force_freeze) for the V5 collection money routes (§12.4).
//
// Compare-and-set on each flag's CURRENT config_version, keeping a valid mode
// and only raising force_freeze. Refuses to freeze BOTH routes while ACTIVE
// collections still need unwinding (keeps the reverse route open). --dry-run
// runs the freeze then ROLLBACK; --rehearse proves the CAS conflict is
// fail-closed (freeze + stale-CAS rejection + restore, all rolled back).
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
  REAL_ORG,
} from "./apply-v5-canary.mjs";

export const MAINTENANCE_WINDOW_ID = "v5-collection-freeze-20260722";
export const APPROVAL_REFERENCE = "user-approved-v5-completion-20260722";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_SCOPES = new Set(["record", "reverse", "both"]);

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function scopeToFlags(scope) {
  // Ascending feature_key order for a single, deadlock-free lock discipline.
  if (scope === "record") return [FLAG_RECORD];
  if (scope === "reverse") return [FLAG_REVERSE];
  return [FLAG_REVERSE, FLAG_RECORD];
}

export function parseFreezeArgs(argv) {
  const opts = {
    scope: null,
    actor: null,
    reason: null,
    maintenanceWindowId: MAINTENANCE_WINDOW_ID,
    approvalReference: APPROVAL_REFERENCE,
    dryRun: false,
    rehearse: false,
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
    if (arg === "--scope") opts.scope = next().trim();
    else if (arg === "--actor") opts.actor = next().trim();
    else if (arg === "--reason") opts.reason = next();
    else if (arg === "--maintenance-window-id") opts.maintenanceWindowId = next();
    else if (arg === "--approval-reference") opts.approvalReference = next();
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--rehearse") opts.rehearse = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function validateFreezeArgs(opts) {
  if (!opts.scope || !VALID_SCOPES.has(opts.scope)) {
    throw new Error("--scope must be one of: record | reverse | both");
  }
  if (!opts.actor || !UUID_RE.test(opts.actor)) {
    throw new Error("--actor must be a uuid");
  }
  if (opts.dryRun && opts.rehearse) {
    throw new Error("Use either --dry-run or --rehearse, not both");
  }
  const reason =
    opts.reason ||
    `V5 collection freeze (scope=${opts.scope}) per PLAN §12.4 [${opts.approvalReference}]`;
  return { ...opts, reason };
}

export function buildFreezeReadSql() {
  const real = `${sqlLiteral(REAL_ORG)}::uuid`;
  const demo = `${sqlLiteral(DEMO_ORG)}::uuid`;
  const flagList = [FLAG_REVERSE, FLAG_RECORD].map(sqlLiteral).join(", ");
  return `SELECT jsonb_object_agg(f.feature_key, jsonb_build_object(
  'mode', f.mode,
  'force_freeze', f.force_freeze,
  'config_version', f.config_version,
  'maintenance_window_id', f.maintenance_window_id,
  'approval_reference', f.approval_reference,
  'reason', f.reason,
  'updated_by', f.updated_by,
  'updated_at', f.updated_at,
  'real_route', app_private.evaluate_feature_route(f.feature_key, ${real}),
  'demo_route', app_private.evaluate_feature_route(f.feature_key, ${demo})
)) AS v5_flags_before
FROM app_private.server_feature_flags f
WHERE f.feature_key IN (${flagList});`;
}

function reportSql(alias) {
  const real = `${sqlLiteral(REAL_ORG)}::uuid`;
  const demo = `${sqlLiteral(DEMO_ORG)}::uuid`;
  const flagList = [FLAG_REVERSE, FLAG_RECORD].map(sqlLiteral).join(", ");
  return `SELECT jsonb_build_object(
  'flags', COALESCE(jsonb_object_agg(f.feature_key, jsonb_build_object(
    'mode', f.mode,
    'force_freeze', f.force_freeze,
    'config_version', f.config_version,
    'reason', f.reason,
    'real_route', app_private.evaluate_feature_route(f.feature_key, ${real}),
    'demo_route', app_private.evaluate_feature_route(f.feature_key, ${demo})
  )), '{}'::jsonb),
  'active_collections', (
    SELECT count(*) FROM public.invoice_payment_collections WHERE status = 'ACTIVE'
  ),
  'incomplete_canonical_operations', (
    SELECT count(*) FROM app_private.canonical_write_operations WHERE completed_at IS NULL
  )
) AS ${alias}
FROM app_private.server_feature_flags f
WHERE f.feature_key IN (${flagList});`;
}

export function buildFreezeSql(opts) {
  const actor = `${sqlLiteral(opts.actor)}::uuid`;
  const reason = sqlLiteral(opts.reason);
  const window = sqlLiteral(opts.maintenanceWindowId);
  const approval = sqlLiteral(opts.approvalReference);
  const flags = scopeToFlags(opts.scope);
  const flagArray = flags.map(sqlLiteral).join(", ");

  if (opts.rehearse) {
    const rehearse = `DO $rehearse$
DECLARE
  k text;
  v0 bigint;
  rc integer;
BEGIN
  FOREACH k IN ARRAY ARRAY[${flagArray}] LOOP
    SELECT config_version INTO v0
    FROM app_private.server_feature_flags
    WHERE feature_key = k
    FOR UPDATE;

    -- 1) valid freeze at the current config_version (CAS must match exactly 1).
    UPDATE app_private.server_feature_flags
      SET force_freeze = true, config_version = v0 + 1,
          updated_by = ${actor}, updated_at = now(), reason = ${reason}
      WHERE feature_key = k AND config_version = v0;
    GET DIAGNOSTICS rc = ROW_COUNT;
    IF rc <> 1 THEN
      RAISE EXCEPTION 'rehearsal: initial freeze CAS matched % row(s) for % (want 1)', rc, k;
    END IF;

    -- 2) a STALE expected version must match 0 rows (proves fail-closed CAS).
    UPDATE app_private.server_feature_flags
      SET force_freeze = true, config_version = v0 + 2
      WHERE feature_key = k AND config_version = v0;
    GET DIAGNOSTICS rc = ROW_COUNT;
    IF rc <> 0 THEN
      RAISE EXCEPTION 'rehearsal: stale CAS matched % row(s) for % - NOT fail-closed', rc, k;
    END IF;

    -- 3) restore the original state within the rolled-back transaction.
    UPDATE app_private.server_feature_flags
      SET force_freeze = false, config_version = v0, updated_at = now()
      WHERE feature_key = k AND config_version = v0 + 1;
    GET DIAGNOSTICS rc = ROW_COUNT;
    IF rc <> 1 THEN
      RAISE EXCEPTION 'rehearsal: restore CAS matched % row(s) for % (want 1)', rc, k;
    END IF;

    RAISE NOTICE 'rehearsal OK for %: freeze applied, stale CAS rejected, restored', k;
  END LOOP;
END
$rehearse$;`;

    return [
      "BEGIN;",
      `SET LOCAL lock_timeout = ${sqlLiteral(ROLLOUT_LOCK_TIMEOUT)};`,
      `SET LOCAL statement_timeout = ${sqlLiteral(ROLLOUT_STATEMENT_TIMEOUT)};`,
      rehearse,
      reportSql("v5_freeze_report"),
      "ROLLBACK;",
    ].join("\n");
  }

  // Non-rehearse freeze. Refuse to freeze BOTH routes while ACTIVE collections
  // still need unwinding: a frozen reverse route would strand them (§12.4.4).
  const bothGuard =
    opts.scope === "both"
      ? `  SELECT count(*) INTO v_active FROM public.invoice_payment_collections WHERE status = 'ACTIVE';
  IF v_active > 0 THEN
    RAISE EXCEPTION 'Refusing to freeze BOTH routes while % ACTIVE collection(s) exist; freeze --scope record to block writes and keep reverse open for unwinding', v_active;
  END IF;`
      : "";

  const freeze = `DO $freeze$
DECLARE
  v_active bigint;
  k text;
  v_ver bigint;
  rc integer;
  v_route text;
BEGIN
${bothGuard}
  FOREACH k IN ARRAY ARRAY[${flagArray}] LOOP
    SELECT config_version INTO v_ver
    FROM app_private.server_feature_flags
    WHERE feature_key = k
    FOR UPDATE;

    UPDATE app_private.server_feature_flags
      SET force_freeze = true,
          config_version = config_version + 1,
          maintenance_window_id = ${window},
          approval_reference = ${approval},
          reason = ${reason},
          updated_by = ${actor},
          updated_at = now()
      WHERE feature_key = k AND config_version = v_ver;
    GET DIAGNOSTICS rc = ROW_COUNT;
    IF rc <> 1 THEN
      RAISE EXCEPTION 'Freeze CAS failed for %: expected config_version % matched % row(s)', k, v_ver, rc;
    END IF;

    v_route := app_private.evaluate_feature_route(k, ${sqlLiteral(REAL_ORG)}::uuid);
    IF v_route <> 'FROZEN' THEN
      RAISE EXCEPTION 'Freeze postcondition failed: % route=% (want FROZEN)', k, v_route;
    END IF;
    RAISE NOTICE 'froze % (config_version % -> %)', k, v_ver, v_ver + 1;
  END LOOP;
END
$freeze$;`;

  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = ${sqlLiteral(ROLLOUT_LOCK_TIMEOUT)};`,
    `SET LOCAL statement_timeout = ${sqlLiteral(ROLLOUT_STATEMENT_TIMEOUT)};`,
    freeze,
    reportSql("v5_freeze_report"),
    opts.dryRun ? "ROLLBACK;" : "COMMIT;",
  ].join("\n");
}

function parseReport(body, alias) {
  const parsed = JSON.parse(body);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const row = rows.find((candidate) => candidate?.[alias] !== undefined);
  if (!row) throw new Error(`Freeze query returned no ${alias} row`);
  return row[alias];
}

export function assertFrozen(report, flags) {
  const failures = [];
  const flagStates = report?.flags ?? {};
  for (const key of flags) {
    const flag = flagStates[key];
    if (!flag) {
      failures.push(`${key}: missing from report`);
      continue;
    }
    if (flag.force_freeze !== true)
      failures.push(`${key}: force_freeze=${flag.force_freeze} (want true)`);
    if (flag.real_route !== "FROZEN")
      failures.push(`${key}: real_route=${flag.real_route} (want FROZEN)`);
    if (flag.demo_route !== "FROZEN")
      failures.push(`${key}: demo_route=${flag.demo_route} (want FROZEN)`);
  }
  if (failures.length > 0) {
    throw new Error(`V5 freeze postcondition check failed:\n  ${failures.join("\n  ")}`);
  }
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
  const parsed = parseFreezeArgs(argv);
  if (parsed.help) {
    log("Usage: node scripts/freeze-v5-collection-rollout.mjs --scope record|reverse|both \\");
    log("         --actor <uuid> [--reason <text>] [--maintenance-window-id <id>] \\");
    log("         [--approval-reference <ref>] [--dry-run | --rehearse]");
    log("  Fail-closed force_freeze of the V5 collection money routes via CAS.");
    log("  --dry-run  applies the freeze then ROLLBACK.");
    log("  --rehearse proves the CAS conflict is fail-closed (freeze + stale-CAS + restore, rolled back).");
    log("  Refuses --scope both while ACTIVE collections still need unwinding.");
    return 0;
  }

  const opts = validateFreezeArgs(parsed);
  const config = loadConfig();

  // 1) Read + log current state before mutating (§12.4.1).
  const beforeBody = await executeManagementQuery(buildFreezeReadSql(), config, fetchImpl);
  const before = parseReport(beforeBody, "v5_flags_before");
  log("Current V5 flag state (before):");
  log(JSON.stringify(before, null, 2));

  // 2) Run the freeze / dry-run / rehearsal transaction.
  const sql = buildFreezeSql(opts);
  if (opts.dryRun) warn("DRY RUN: freeze executes inside a transaction and is ROLLED BACK.");
  if (opts.rehearse)
    warn("REHEARSE: freeze + stale-CAS rejection + restore run inside a ROLLED BACK transaction.");

  const body = await executeManagementQuery(sql, config, fetchImpl);
  const report = parseReport(body, "v5_freeze_report");
  log(JSON.stringify(report, null, 2));

  if (opts.rehearse) {
    log(
      "V5 freeze rehearsal passed (ROLLED BACK): CAS conflict is fail-closed; " +
        "the stale expected config_version matched 0 rows.",
    );
    return 0;
  }

  const flags = scopeToFlags(opts.scope);
  assertFrozen(report, flags);
  log(
    opts.dryRun
      ? `V5 freeze dry run passed (ROLLED BACK): scope=${opts.scope} would be FROZEN.`
      : `V5 freeze applied: scope=${opts.scope} is FROZEN (force_freeze=true).`,
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
