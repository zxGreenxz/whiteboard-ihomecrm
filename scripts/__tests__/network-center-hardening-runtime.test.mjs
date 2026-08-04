// Executable runtime regressions for the four canonical security findings that
// previously had only source-text evidence:
//
//   worker-heartbeat-global-view
//   execute-queue-unbounded-admission
//   client-session-history-unbounded-retention
//   aruba-inventory-unbounded-retention
//
// Every case below runs against a real PostgreSQL database. The database is
// built by scripts/network-center-disposable-db.mjs from the declared platform
// bootstrap plus the REAL, unmodified supabase/migrations/20260729*_network_
// center_*.sql files, so an assertion here is an assertion about shipped
// migration source rather than about a re-typed copy of it. No Docker, no
// Supabase CLI, no network access and no developer database are involved; the
// cluster binds 127.0.0.1 only and its teardown is verified by evidence.
//
// If PostgreSQL is unavailable the setup throws and EVERY case fails loudly.
// Nothing here is allowed to skip: a skipped security regression is a silently
// missing one, and the hardening verifier treats a skipped case as a failure.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";

import { runDisposableLocalClusterMatrix } from "../network-center-disposable-db.mjs";
import { buildNetworkCenterManagedResourcesSql } from "../verify-network-center-managed-resources.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const heartbeatFixtureUrl = new URL(
  "./network-center-heartbeat-scope-runtime.sql",
  import.meta.url,
);

// Both fragments own their own BEGIN/ROLLBACK transaction and each emits one
// verdict row, so they compose into a single psql session without sharing state.
const EXPECTED_VERDICT_COUNT = 2;
const REQUIRED_CASE_IDS = Object.freeze([
  "queue-admission-runtime",
  "queue-admission-control",
  "client-retention-runtime",
  "client-retention-control",
  "aruba-lifecycle-runtime",
  "aruba-lifecycle-control",
  "heartbeat-scope-runtime",
  "heartbeat-scope-control",
]);

function parseCombinedVerdicts(output) {
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("Disposable cluster produced no output");
  }
  const verdicts = output
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
      (entry) =>
        entry !== null
        && typeof entry === "object"
        && Array.isArray(entry.assertions)
        && Number.isInteger(entry.assertion_count)
        && Number.isInteger(entry.failed_count),
    );
  if (verdicts.length !== EXPECTED_VERDICT_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_VERDICT_COUNT} runtime verdicts, observed ${verdicts.length}`,
    );
  }

  const cases = new Map();
  for (const verdict of verdicts) {
    if (verdict.assertions.length !== verdict.assertion_count) {
      throw new Error("Runtime verdict case manifest is inconsistent");
    }
    const observedFailures = verdict.assertions.filter(
      (assertion) => assertion?.passed !== true,
    ).length;
    if (
      verdict.failed_count !== observedFailures
      || verdict.passed !== (observedFailures === 0)
    ) {
      throw new Error("Runtime verdict counts are inconsistent");
    }
    for (const assertion of verdict.assertions) {
      if (
        typeof assertion?.case_id !== "string"
        || typeof assertion?.passed !== "boolean"
      ) {
        throw new Error("Runtime verdict assertion shape is invalid");
      }
      if (cases.has(assertion.case_id)) {
        throw new Error(`Duplicate runtime case id ${assertion.case_id}`);
      }
      cases.set(assertion.case_id, assertion);
    }
  }
  for (const caseId of REQUIRED_CASE_IDS) {
    if (!cases.has(caseId)) {
      throw new Error(`Runtime proof did not report case ${caseId}`);
    }
  }
  return cases;
}

let runtimeCases = null;
let setupFailure = null;

function requireCase(caseId) {
  if (setupFailure) {
    assert.fail(
      `Runtime proof setup failed, so ${caseId} was never executed: ${setupFailure.message}`,
    );
  }
  const observed = runtimeCases?.get(caseId);
  assert.ok(observed, `Runtime proof did not report case ${caseId}`);
  assert.equal(
    observed.passed,
    true,
    `${caseId} failed: ${JSON.stringify(observed.detail)}`,
  );
}

describe("Network Center hardening runtime regressions", () => {
  before(
    async () => {
      try {
        const heartbeatSql = (await readFile(heartbeatFixtureUrl, "utf8"))
          .replace(/\r\n/g, "\n");
        const output = await runDisposableLocalClusterMatrix({
          repoRoot: repositoryRoot,
          // Both fragments build their own fleet, and network_devices enforces
          // one active MikroTik per building, so the shared fleet fixtures must
          // stay out of the way.
          includeFleetFixtures: false,
          buildSql: () =>
            `${buildNetworkCenterManagedResourcesSql()}\n\n${heartbeatSql}`,
          parseVerdict: (raw) => raw,
        });
        runtimeCases = parseCombinedVerdicts(output);
      } catch (error) {
        setupFailure = error instanceof Error ? error : new Error(String(error));
      }
    },
    { timeout: 900_000 },
  );

  // --- worker-heartbeat-global-view -----------------------------------------
  it("revokes fleet-wide heartbeat exposure and hides other tenants' worker status", () => {
    requireCase("heartbeat-scope-runtime");
  });

  it("still serves the building-scoped worker status projection to an entitled member", () => {
    requireCase("heartbeat-scope-control");
  });

  // --- execute-queue-unbounded-admission ------------------------------------
  it("rejects queue admission at every server-side budget without orphan rows or events", () => {
    requireCase("queue-admission-runtime");
  });

  it("admits a legitimate queued command once and replays it idempotently", () => {
    requireCase("queue-admission-control");
  });

  // --- client-session-history-unbounded-retention ---------------------------
  it("bounds client session history and expires stale sessions in tenant batches", () => {
    requireCase("client-retention-runtime");
  });

  it("preserves a live session and its most recent bounded address history", () => {
    requireCase("client-retention-control");
  });

  // --- aruba-inventory-unbounded-retention ----------------------------------
  it("ages only Aruba discovery lifecycle state inside bounded retention windows", () => {
    requireCase("aruba-lifecycle-runtime");
  });

  it("keeps Aruba inventory uncapped with router-scoped identity across keyset pages", () => {
    requireCase("aruba-lifecycle-control");
  });
});
