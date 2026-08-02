// Executable coverage for
// supabase/migrations/20260729140000_network_center_admin_status_forward_fix.sql.
//
// public.network_center_admin_status_v1 shipped in 20260729134000 projecting
// `state.enabled` and `state.cutover_finalized_at` from
// app_private.network_worker_compatibility_state, which has neither column.
// plpgsql resolves column references when a statement first EXECUTES, so the
// migration applied, the post-apply catalog audit passed, and the function only
// failed at 42703 when an operator called it -- which every mutating admin
// command does as its readback, after its RPC has already committed.
//
// The lesson is that catalog shape is not evidence about a plpgsql body. So
// these cases CALL the shipped function, against a disposable PostgreSQL built
// by scripts/network-center-disposable-db.mjs from the declared platform
// bootstrap plus the REAL, unmodified supabase/migrations/20260729*_network_
// center_*.sql files. No Docker, no Supabase CLI, no network, no developer
// database; the cluster binds 127.0.0.1 only and its teardown is verified.
//
// Nothing here is allowed to skip: if the cluster cannot be built, every case
// fails loudly.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";

import { runDisposableLocalClusterMatrix } from "../network-center-disposable-db.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixtureUrl = new URL(
  "./network-center-admin-status-forward-fix-runtime.sql",
  import.meta.url,
);

// The fixture runs three transactions -- live, expired, finalized -- because the
// last two states are one-way and cannot be undone inside one transaction. Each
// emits its own verdict.
const EXPECTED_VERDICT_COUNT = 3;
const REQUIRED_CASE_IDS = Object.freeze([
  "admin-status-projections-resolve",
  "compat-window-live",
  "compat-window-expired",
  "compat-window-finalized",
]);

function parseVerdicts(output) {
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

describe("Network Center admin status forward fix", () => {
  before(
    async () => {
      try {
        const fixtureSql = (await readFile(fixtureUrl, "utf8")).replace(/\r\n/g, "\n");
        const output = await runDisposableLocalClusterMatrix({
          repoRoot: repositoryRoot,
          buildSql: () => fixtureSql,
          parseVerdict: (raw) => raw,
        });
        runtimeCases = parseVerdicts(output);
      } catch (error) {
        setupFailure = error instanceof Error ? error : new Error(String(error));
      }
    },
    { timeout: 900_000 },
  );

  it("resolves every projection in the admin readback against the real schema", () => {
    requireCase("admin-status-projections-resolve");
  });

  it("reports a live compatibility window exactly as the admission helper admits it", () => {
    requireCase("compat-window-live");
  });

  it("stops reporting a lapsed compatibility window as enabled", () => {
    requireCase("compat-window-expired");
  });

  it("follows the shipped finalize RPC into a disabled, stamped window", () => {
    requireCase("compat-window-finalized");
  });
});
