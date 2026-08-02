#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runDisposableLocalClusterMatrix,
  runDisposableSupabaseMatrix,
} from "./network-center-disposable-db.mjs";

export const DEMO_ORG_ID = "dddd0000-0000-4000-8000-000000000001";
export const MAX_EVIDENCE_BYTES = 16 * 1024;
export const MAX_QUERY_RESPONSE_BYTES = 256 * 1024;
export const REQUIRED_CASE_IDS = Object.freeze([
  "queue-admission-runtime",
  "queue-admission-control",
  "client-retention-runtime",
  "client-retention-control",
  "aruba-lifecycle-runtime",
  "aruba-lifecycle-control",
]);

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lifecycleRuntimeUrl = new URL(
  "./__tests__/network-center-resource-lifecycle-runtime.sql",
  import.meta.url,
);
const arubaRuntimeUrl = new URL(
  "./__tests__/network-center-aruba-runtime.sql",
  import.meta.url,
);
const managedResourcesRuntimeUrl = new URL(
  "./__tests__/network-center-managed-resources-runtime.sql",
  import.meta.url,
);
const secretKeyPattern = /(?:authorization|credential|password|secret|token)/i;
const fixtureRouterIds = Object.freeze(Array.from(
  { length: 8 },
  (_, index) => `dddd2000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
));
const arubaDynamicExecTag = "$ncmr_aruba_dynamic_exec$";

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function requiredCaseValues() {
  return REQUIRED_CASE_IDS.map(
    (caseId, index) => `(${index + 1}, ${sqlLiteral(caseId)})`,
  ).join(",\n  ");
}

function unwrapRollbackRuntime(source, label) {
  let sql = source.replace(/\r\n/g, "\n").trim();
  sql = sql.replace(/^\\set[^\n]*\n+/i, "");
  if (!/^BEGIN\s*;/i.test(sql) || !/ROLLBACK\s*;\s*$/i.test(sql)) {
    throw new Error(`${label} must be rollback-only SQL`);
  }
  sql = sql.replace(/^BEGIN\s*;\s*/i, "");
  sql = sql.replace(/\s*ROLLBACK\s*;\s*$/i, "");
  return sql.trim();
}

function replaceOnce(source, pattern, replacement, label) {
  if (!pattern.test(source)) throw new Error(`Unable to scope ${label} to DEMO`);
  return source.replace(pattern, replacement);
}

function scopeArubaRuntimeToDemo(source) {
  const routerList = fixtureRouterIds.map((id) => sqlLiteral(id)).join(", ");
  return replaceOnce(
    source,
    /WHERE router\.device_kind = 'MIKROTIK'/,
    `WHERE router.organization_id = '${DEMO_ORG_ID}'::uuid
  AND router.id IN (${routerList})
  AND router.device_kind = 'MIKROTIK'`,
    "Aruba runtime",
  );
}

function scopeManagedResourcesRuntimeToDemo(source) {
  let sql = replaceOnce(
    source,
    /WHERE router\.device_kind = 'MIKROTIK'/,
    `WHERE router.organization_id = '${DEMO_ORG_ID}'::uuid
  AND router.id = '${fixtureRouterIds[0]}'::uuid
  AND router.device_kind = 'MIKROTIK'`,
    "managed-resource runtime",
  );
  sql = replaceOnce(
    sql,
    /\(SELECT id FROM auth\.users ORDER BY id LIMIT 1\) AS actor_id/,
    `(SELECT membership.user_id
      FROM public.organization_memberships membership
      WHERE membership.organization_id = '${DEMO_ORG_ID}'::uuid
        AND membership.status = 'ACTIVE'
      ORDER BY membership.user_id LIMIT 1) AS actor_id`,
    "managed-resource actor",
  );
  return sql;
}

// The Aruba (Task 9) fragment is a flat sequence of top-level statements; on
// its own it has no catchable exception boundary, so a failed
// pg_temp.t9_assert() would either abort the whole matrix (if unguarded) or
// be silently absorbed by an explicit ROLLBACK TO SAVEPOINT (the previous
// design), reporting a false PASS either way. Running it as one dynamic
// EXECUTE inside a PL/pgSQL function fixes this: the function's own
// EXCEPTION handler establishes an implicit savepoint at block entry and
// automatically rolls back to it on error, isolating a failed proof's
// partial mutations without any explicit SAVEPOINT/ROLLBACK TO SAVEPOINT
// pair of our own — which would otherwise also discard the verdict row
// itself, since ROLLBACK TO SAVEPOINT undoes every row change made after
// the savepoint mark regardless of which table it targets. The pass/fail
// signal instead flows out as the function's RETURN value: PL/pgSQL local
// variables are documented to survive exception handling untouched ("local
// variables ... remain as they were when the error occurred"), so the
// caller can safely persist what the function returns.
function buildArubaProofCaptureFunction(arubaSql) {
  if (arubaSql.includes(arubaDynamicExecTag)) {
    throw new Error(
      "Aruba runtime fragment collides with the dynamic-execute delimiter",
    );
  }
  return `CREATE OR REPLACE FUNCTION pg_temp.ncmr_run_aruba_proof()
RETURNS jsonb
LANGUAGE plpgsql
AS $ncmr_aruba_fn$
BEGIN
  EXECUTE ${arubaDynamicExecTag}
${arubaSql}
${arubaDynamicExecTag};
  RETURN jsonb_build_object('passed', true);
EXCEPTION WHEN OTHERS THEN
  RETURN jsonb_build_object(
    'passed', false,
    'sqlstate', SQLSTATE,
    'message', left(coalesce(SQLERRM, ''), 500)
  );
END;
$ncmr_aruba_fn$;`;
}

export function buildNetworkCenterManagedResourcesSql({
  readSql = (url) => readFileSync(url, "utf8"),
} = {}) {
  const lifecycleSql = readSql(lifecycleRuntimeUrl).replace(/\r\n/g, "\n").trim();
  if (/^\s*(?:BEGIN|ROLLBACK)\s*;/im.test(lifecycleSql)) {
    throw new Error("Lifecycle runtime fragment must not own a transaction");
  }
  const arubaSql = scopeArubaRuntimeToDemo(unwrapRollbackRuntime(
    readSql(arubaRuntimeUrl),
    "Aruba runtime",
  ));
  const managedSql = scopeManagedResourcesRuntimeToDemo(unwrapRollbackRuntime(
    readSql(managedResourcesRuntimeUrl),
    "Managed-resource runtime",
  ));
  const arubaProofCaptureFn = buildArubaProofCaptureFunction(arubaSql);

  return `BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15min';
SET CONSTRAINTS ALL DEFERRED;

${lifecycleSql}

-- Task 9's own RAISE EXCEPTION assertions (malformed-item quarantine,
-- identity replay/churn, bounded admission, keyset pagination, and
-- discovery-only retention) must be able to fail this matrix as a real
-- FAIL naming the assertion, not disappear into a false PASS. See
-- buildArubaProofCaptureFunction() for why this runs as a dynamic EXECUTE
-- inside a function rather than a SAVEPOINT/ROLLBACK TO SAVEPOINT pair.
${arubaProofCaptureFn}

INSERT INTO _ncmr_aruba_runtime_verdict(verdict)
SELECT pg_temp.ncmr_run_aruba_proof();

-- Combine the captured Task 9 result with the independent, non-throwing
-- observations the lifecycle fixture already recorded while it drove the
-- same authoritative v2 RPC directly, so a regression in either mechanism
-- is a real FAIL rather than a hardcoded pass.
INSERT INTO _ncmr_results(case_id, passed, detail)
SELECT
  'aruba-lifecycle-runtime',
  (task9.verdict->>'passed')::boolean
    AND observation.malformed_isolated AND observation.churn_stable,
  jsonb_build_object(
    'proofs', jsonb_build_array(
      'malformed_quarantine', 'stable_identity_replay', 'identity_churn',
      'keyset_pagination', 'discovery_retention'
    ),
    'task9_runtime_proof', task9.verdict,
    'observed', jsonb_build_object(
      'malformed_isolated', observation.malformed_isolated,
      'churn_stable', observation.churn_stable
    )
  )
FROM _ncmr_aruba_runtime_verdict task9
CROSS JOIN _ncmr_aruba_observations observation
UNION ALL
SELECT
  'aruba-lifecycle-control',
  (task9.verdict->>'passed')::boolean
    AND observation.authoritative_pages = 10
    AND observation.authoritative_total = 640
    AND observation.stable_identity_count = 640,
  jsonb_build_object(
    'proofs', jsonb_build_array(
      'unlimited_total_inventory', 'router_scoped_identity',
      'pinned_identity_preserved', 'durable_sort_order'
    ),
    'task9_runtime_proof', task9.verdict,
    'observed', jsonb_build_object(
      'authoritative_pages', observation.authoritative_pages,
      'authoritative_total', observation.authoritative_total,
      'stable_identity_count', observation.stable_identity_count
    )
  )
FROM _ncmr_aruba_runtime_verdict task9
CROSS JOIN _ncmr_aruba_observations observation;

-- Task 10 has no dedicated case_id in REQUIRED_CASE_IDS (the test file
-- pins that manifest to exactly six entries), so there is no row of its
-- own to attach a captured verdict to. Unlike the Aruba section above, do
-- NOT wrap this in a SAVEPOINT/ROLLBACK TO SAVEPOINT that would recover
-- from and silently absorb a failed assertion here too: let a Task 10
-- exception propagate uncaught and abort the whole script, so a Task 10
-- regression is reported as an overall FAIL (via the CLI/JS error-handling
-- path) instead of a false overall PASS.
${managedSql}

CREATE TEMP TABLE _ncmr_required_cases (
  sequence integer PRIMARY KEY,
  case_id text NOT NULL UNIQUE
) ON COMMIT DROP;
INSERT INTO _ncmr_required_cases(sequence, case_id) VALUES
  ${requiredCaseValues()};

WITH evaluated AS (
  SELECT
    required.sequence,
    required.case_id,
    coalesce(result.passed, false) AS passed,
    CASE WHEN result.case_id IS NULL
      THEN jsonb_build_object('missing_result', true)
      ELSE result.detail
    END AS detail
  FROM _ncmr_required_cases required
  LEFT JOIN _ncmr_results result USING (case_id)
)
SELECT jsonb_build_object(
  'passed', bool_and(evaluated.passed),
  'assertion_count', count(*),
  'failed_count', count(*) FILTER (WHERE NOT evaluated.passed),
  'assertions', jsonb_agg(jsonb_build_object(
    'case_id', evaluated.case_id,
    'passed', evaluated.passed,
    'detail', evaluated.detail
  ) ORDER BY evaluated.sequence)
) AS verdict
FROM evaluated;
ROLLBACK;`;
}

// psql prints a single jsonb column as a bare object per line; the Supabase CLI
// wraps rows in a JSON array. Normalise the cluster output into the CLI shape so
// exactly one validator governs both execution paths.
export function parseManagedResourcesClusterVerdict(output) {
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("Disposable cluster returned no managed-resource verdict");
  }
  const candidates = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(
      (entry) => entry !== null
        && typeof entry === "object"
        && Array.isArray(entry.assertions),
    );
  if (candidates.length !== 1) {
    throw new Error(
      `Disposable cluster returned ${candidates.length} managed-resource verdicts; expected exactly one`,
    );
  }
  return parseNetworkCenterManagedResourcesVerdict(
    JSON.stringify([{ verdict: candidates[0] }]),
  );
}

export function parseNetworkCenterManagedResourcesVerdict(body) {
  if (
    typeof body !== "string"
    || Buffer.byteLength(body, "utf8") > MAX_QUERY_RESPONSE_BYTES
  ) {
    throw new Error("Disposable Supabase response exceeded the raw response limit");
  }
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    throw new Error("Disposable Supabase query returned invalid JSON");
  }
  if (!Array.isArray(rows)) {
    throw new Error("Supabase response has no valid managed-resource verdict");
  }
  const contradictoryRows = rows.filter((row) => (
    row && typeof row === "object" && Object.hasOwn(row, "verdict")
      && (Object.keys(row).length !== 1 || !Object.hasOwn(row, "verdict"))
  ));
  if (contradictoryRows.length > 0) {
    throw new Error("Supabase response contains a contradictory verdict row");
  }
  const verdictRows = rows.filter((row) => (
    row && typeof row === "object"
      && Object.keys(row).length === 1
      && Object.hasOwn(row, "verdict")
  ));
  if (verdictRows.length === 0) {
    throw new Error("Supabase response has no valid managed-resource verdict");
  }
  if (verdictRows.length > 1) {
    throw new Error("Supabase response must contain exactly one verdict row");
  }
  const verdict = verdictRows[0].verdict;
  if (
    !verdict
    || typeof verdict.passed !== "boolean"
    || !Array.isArray(verdict.assertions)
    || typeof verdict.assertion_count !== "number"
    || !Number.isInteger(verdict.assertion_count)
    || typeof verdict.failed_count !== "number"
    || !Number.isInteger(verdict.failed_count)
  ) {
    throw new Error("Supabase response has no valid managed-resource verdict");
  }

  const assertionCount = verdict.assertion_count;
  const failedCount = verdict.failed_count;
  if (
    assertionCount !== REQUIRED_CASE_IDS.length
    || verdict.assertions.length !== REQUIRED_CASE_IDS.length
  ) {
    throw new Error("Managed-resource verdict case manifest is inconsistent");
  }
  for (const [index, assertion] of verdict.assertions.entries()) {
    if (
      assertion?.case_id !== REQUIRED_CASE_IDS[index]
      || typeof assertion?.passed !== "boolean"
    ) {
      throw new Error("Managed-resource verdict case manifest is inconsistent");
    }
  }
  const observedFailures = verdict.assertions.filter(
    (assertion) => !assertion.passed,
  ).length;
  if (failedCount !== observedFailures || verdict.passed !== (failedCount === 0)) {
    throw new Error("Managed-resource verdict counts are inconsistent");
  }
  return {
    ...verdict,
    assertion_count: assertionCount,
    failed_count: failedCount,
  };
}

function sanitizeEvidence(value, key = "", depth = 0) {
  if (secretKeyPattern.test(key)) return "[REDACTED]";
  if (depth >= 6) return "[TRUNCATED]";
  if (typeof value === "string") {
    return value.length <= 512 ? value : `${value.slice(0, 509)}...`;
  }
  if (Array.isArray(value)) {
    const output = value.slice(0, 32).map(
      (item) => sanitizeEvidence(item, "", depth + 1),
    );
    if (value.length > 32) output.push(`[TRUNCATED ${value.length - 32} ITEMS]`);
    return output;
  }
  if (value && typeof value === "object") {
    const output = {};
    const entries = Object.entries(value);
    for (const [entryKey, entryValue] of entries.slice(0, 64)) {
      output[entryKey] = sanitizeEvidence(entryValue, entryKey, depth + 1);
    }
    if (entries.length > 64) output.truncatedKeys = entries.length - 64;
    return output;
  }
  return value;
}

export function formatEvidenceJson(value) {
  const sanitized = sanitizeEvidence(value);
  let json = JSON.stringify(sanitized);
  if (Buffer.byteLength(json, "utf8") <= MAX_EVIDENCE_BYTES) return json;

  json = JSON.stringify({
    status: sanitized?.status ?? "FAIL",
    ok: sanitized?.ok ?? false,
    password: sanitized?.password,
    mode: sanitized?.mode,
    summary: sanitized?.summary ?? {},
    failures: Array.isArray(sanitized?.failures)
      ? sanitized.failures.slice(0, 8)
      : [],
    truncated: true,
  });
  return Buffer.byteLength(json, "utf8") <= MAX_EVIDENCE_BYTES
    ? json
    : JSON.stringify({ status: "FAIL", ok: false, truncated: true });
}

function parseMode(argv) {
  const allowed = new Set(["--dry-run", "--local-cluster", "--local-disposable"]);
  const unknown = argv.find((argument) => !allowed.has(argument));
  if (unknown) throw new Error(`Unknown argument: ${unknown}`);
  const modes = argv.filter((argument) => allowed.has(argument));
  if (modes.length !== 1) {
    throw new Error(
      "Choose exactly one mode: --dry-run, --local-cluster or --local-disposable",
    );
  }
  return modes[0];
}

function failureEvidence(error, mode) {
  return {
    status: "FAIL",
    ok: false,
    exitCode: 1,
    mode,
    failures: [{
      code: "MANAGED_RESOURCES_VERIFIER_FAILED",
      message: error instanceof Error ? error.message : "Unknown verifier failure",
    }],
  };
}

export async function main(
  argv = process.argv.slice(2),
  {
    log = console.log,
    runLocalDisposable = runDisposableSupabaseMatrix,
    runLocalCluster = runDisposableLocalClusterMatrix,
    disposableOptions = {},
  } = {},
) {
  let evidence;
  let mode;
  try {
    mode = parseMode(argv);
    if (mode === "--dry-run") {
      const sql = buildNetworkCenterManagedResourcesSql();
      const beginCount = (sql.match(/\bBEGIN\s*;/gi) ?? []).length;
      const rollbackCount = (sql.match(/\bROLLBACK\s*;/gi) ?? []).length;
      if (
        beginCount !== 1
        || rollbackCount !== 1
        || !/ROLLBACK\s*;\s*$/i.test(sql)
        || /aaaa0000-0000-4000-8000-000000000001/i.test(sql)
      ) {
        throw new Error("Dry-run SQL is not one DEMO-only rollback transaction");
      }
      evidence = {
        status: "PASS",
        ok: true,
        exitCode: 0,
        mode: "dry-run",
        summary: {
          assertions: REQUIRED_CASE_IDS.length,
          sqlBytes: Buffer.byteLength(sql, "utf8"),
          rollbackOnly: true,
        },
        failures: [],
      };
    } else {
      const runMatrix = mode === "--local-cluster"
        ? runLocalCluster
        : runLocalDisposable;
      const verdict = await runMatrix({
        ...disposableOptions,
        repoRoot: disposableOptions.repoRoot ?? repositoryRoot,
        // The lifecycle fixture builds its own 32-building fleet, and
        // network_devices allows one active MikroTik per building.
        ...(mode === "--local-cluster" ? { includeFleetFixtures: false } : {}),
        buildSql: buildNetworkCenterManagedResourcesSql,
        parseVerdict: mode === "--local-cluster"
          ? parseManagedResourcesClusterVerdict
          : parseNetworkCenterManagedResourcesVerdict,
      });
      const failedAssertions = verdict.assertions.filter(
        (assertion) => !assertion.passed,
      );
      evidence = {
        status: failedAssertions.length === 0 ? "PASS" : "FAIL",
        ok: failedAssertions.length === 0,
        exitCode: failedAssertions.length === 0 ? 0 : 1,
        mode: mode === "--local-cluster" ? "local-cluster" : "local-disposable",
        summary: {
          assertions: verdict.assertion_count,
          failed: verdict.failed_count,
          rollbackOnly: true,
        },
        failures: failedAssertions,
      };
    }
  } catch (error) {
    evidence = failureEvidence(error, mode?.slice(2));
  }

  log(formatEvidenceJson(evidence));
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const evidence = await main();
  process.exitCode = evidence.exitCode;
}
