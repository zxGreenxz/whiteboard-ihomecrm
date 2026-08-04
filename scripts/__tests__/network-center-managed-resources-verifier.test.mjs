import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DEMO_ORG_ID,
  MAX_EVIDENCE_BYTES,
  MAX_QUERY_RESPONSE_BYTES,
  REQUIRED_CASE_IDS,
  buildNetworkCenterManagedResourcesSql,
  formatEvidenceJson,
  main,
  parseNetworkCenterManagedResourcesVerdict,
} from "../verify-network-center-managed-resources.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const verifierPath = join(
  repositoryRoot,
  "scripts/verify-network-center-managed-resources.mjs",
);

function verdict(overrides = {}) {
  const assertions = REQUIRED_CASE_IDS.map((caseId) => ({
    case_id: caseId,
    passed: true,
    detail: { proof: caseId },
  }));
  return {
    passed: true,
    assertion_count: assertions.length,
    failed_count: 0,
    assertions,
    ...overrides,
  };
}

function queryBody(candidate = verdict()) {
  return JSON.stringify([{ verdict: candidate }]);
}

test("builds one DEMO-only rollback matrix from lifecycle, Aruba, and managed-resource proofs", () => {
  const sql = buildNetworkCenterManagedResourcesSql();

  assert.equal(REQUIRED_CASE_IDS.length, 6);
  assert.deepEqual(REQUIRED_CASE_IDS, [
    "queue-admission-runtime",
    "queue-admission-control",
    "client-retention-runtime",
    "client-retention-control",
    "aruba-lifecycle-runtime",
    "aruba-lifecycle-control",
  ]);
  assert.equal((sql.match(/\bBEGIN\s*;/gi) ?? []).length, 1);
  assert.equal((sql.match(/\bROLLBACK\s*;/gi) ?? []).length, 1);
  assert.match(sql, new RegExp(DEMO_ORG_ID, "i"));
  assert.doesNotMatch(sql, /aaaa0000-0000-4000-8000-000000000001/i);
  assert.match(sql, /task9_runtime_proof/i);
  assert.match(sql, /task10_managed_resource_runtime_proof/i);
  assert.match(sql, /network_center_enqueue_command_v1/i);
  assert.match(sql, /network_center_retention_v1/i);
  assert.match(sql, /network_center_worker_inventory_v2\s*\(/i);
  assert.doesNotMatch(sql, /network_center_worker_inventory_v1\s*\(/i);
  assert.doesNotMatch(sql, /network_center_request_snapshot_v1\s*\(/i);
  assert.match(sql, /network_center_admin_provision_worker_v1/i);
  assert.match(sql, /authoritative_total[^\n]*640|640[^\n]*authoritative_total/i);
  assert.match(sql, /_ncmr_aruba_runtime_verdict/i);
  assert.doesNotMatch(
    sql,
    /'aruba-lifecycle-(?:runtime|control)'\s*,\s*true/i,
  );
  for (const budget of [
    "disruptive",
    "device",
    "actor",
    "organization",
    "device_hour",
    "actor_hour",
    "organization_hour",
  ]) {
    assert.match(sql, new RegExp(`'${budget}'`, "i"));
  }
  for (const code of [
    "NETWORK_CENTER_DEVICE_BUSY",
    "NETWORK_CENTER_ACTOR_QUEUE_LIMIT",
    "NETWORK_CENTER_ORG_QUEUE_LIMIT",
    "NETWORK_CENTER_RATE_LIMIT",
    "NETWORK_CENTER_COOLDOWN",
    "NETWORK_CENTER_DUPLICATE_INTENT",
  ]) {
    assert.match(sql, new RegExp(code));
  }
  assert.match(sql, /idempotency[^\n]*(?:hash|23505)|23505[^\n]*idempotency/i);
  assert.match(sql, /orphan[^\n]*(?:event|row)|(?:event|row)[^\n]*orphan/i);
  assert.match(sql, /expected_recent_history/i);
  for (const caseId of REQUIRED_CASE_IDS) assert.match(sql, new RegExp(caseId));

  const beginIndex = sql.search(/\bBEGIN\s*;/i);
  const rollbackIndex = sql.search(/\bROLLBACK\s*;/i);
  const verdictIndex = sql.lastIndexOf("AS verdict");
  assert.ok(beginIndex >= 0 && verdictIndex > beginIndex);
  assert.ok(rollbackIndex > verdictIndex);
  assert.doesNotMatch(sql.slice(rollbackIndex + "ROLLBACK;".length), /\S/);
});

test("parser accepts the exact ordered case manifest", () => {
  const parsed = parseNetworkCenterManagedResourcesVerdict(queryBody());

  assert.equal(parsed.passed, true);
  assert.equal(parsed.assertion_count, 6);
  assert.equal(parsed.failed_count, 0);
});

test("parser rejects malformed JSON and missing verdict rows", () => {
  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict("not json"),
    /invalid JSON/i,
  );
  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict("[]"),
    /valid managed-resource verdict/i,
  );
});

test("parser rejects missing, extra, reordered, and inconsistent cases", () => {
  const missing = verdict();
  missing.assertions.pop();
  missing.assertion_count -= 1;
  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict(queryBody(missing)),
    /case manifest/i,
  );

  const extra = verdict();
  extra.assertions.push({ case_id: "unexpected", passed: true, detail: {} });
  extra.assertion_count += 1;
  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict(queryBody(extra)),
    /case manifest/i,
  );

  const reordered = verdict();
  [reordered.assertions[0], reordered.assertions[1]] = [
    reordered.assertions[1],
    reordered.assertions[0],
  ];
  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict(queryBody(reordered)),
    /case manifest/i,
  );

  const inconsistent = verdict({ passed: false, failed_count: 0 });
  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict(queryBody(inconsistent)),
    /counts are inconsistent/i,
  );
});

test("parser requires bounded raw JSON with one exact-key verdict row", () => {
  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict("x".repeat(MAX_QUERY_RESPONSE_BYTES + 1)),
    /response.*limit/i,
  );

  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict(JSON.stringify([
      { verdict: verdict() },
      { verdict: verdict() },
    ])),
    /exactly one verdict row/i,
  );

  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict(JSON.stringify([
      { verdict: verdict(), contradictory: true },
    ])),
    /contradictory verdict row/i,
  );
});

test("parser rejects numeric strings and non-integer counts", () => {
  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict(queryBody(verdict({
      assertion_count: "6",
    }))),
    /valid managed-resource verdict/i,
  );
  assert.throws(
    () => parseNetworkCenterManagedResourcesVerdict(queryBody(verdict({
      failed_count: 0.5,
    }))),
    /valid managed-resource verdict/i,
  );
});

test("dry-run is rollback-only and never invokes the disposable runner", async () => {
  const output = [];
  let runnerCalls = 0;

  const evidence = await main(["--dry-run"], {
    log: (line) => output.push(line),
    runLocalDisposable: async () => {
      runnerCalls += 1;
      return verdict();
    },
  });

  assert.equal(runnerCalls, 0);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.mode, "dry-run");
  assert.equal(JSON.parse(output.at(-1)).status, "PASS");
});

test("local-disposable injects the SQL builder and verdict parser", async () => {
  const output = [];
  let captured;
  const expected = verdict();

  const evidence = await main(["--local-disposable"], {
    log: (line) => output.push(line),
    runLocalDisposable: async (options) => {
      captured = options;
      return options.parseVerdict(queryBody(expected));
    },
    disposableOptions: { runner: "fake-runner" },
  });

  assert.equal(typeof captured.buildSql, "function");
  assert.equal(typeof captured.parseVerdict, "function");
  assert.equal(captured.runner, "fake-runner");
  assert.match(captured.buildSql(), /\bROLLBACK\s*;\s*$/i);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.summary.assertions, REQUIRED_CASE_IDS.length);
  assert.equal(JSON.parse(output.at(-1)).status, "PASS");
});

test("local-disposable reports assertion failures with a nonzero result", async () => {
  const output = [];
  const failed = verdict();
  failed.assertions[0].passed = false;
  failed.assertions[0].detail = { code: "QUEUE_LIMIT_MISSING" };
  failed.passed = false;
  failed.failed_count = 1;

  const evidence = await main(["--local-disposable"], {
    log: (line) => output.push(line),
    runLocalDisposable: async () => failed,
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.exitCode, 1);
  assert.deepEqual(evidence.failures.map((failure) => failure.case_id), [
    "queue-admission-runtime",
  ]);
  assert.equal(JSON.parse(output.at(-1)).status, "FAIL");
});

test("requires exactly one safe execution mode", async () => {
  for (const argv of [
    [],
    ["--dry-run", "--local-disposable"],
    ["--unknown"],
  ]) {
    const output = [];
    const evidence = await main(argv, { log: (line) => output.push(line) });
    assert.equal(evidence.ok, false);
    assert.equal(evidence.exitCode, 1);
    assert.equal(JSON.parse(output.at(-1)).status, "FAIL");
  }
});

test("Docker absence stays local-only and is rendered as bounded JSON", async () => {
  const output = [];
  const evidence = await main(["--local-disposable"], {
    log: (line) => output.push(line),
    runLocalDisposable: async () => {
      throw new Error(
        "Docker is required for --local-disposable; no production config or network access was attempted.",
      );
    },
  });

  assert.equal(evidence.ok, false);
  assert.equal(evidence.exitCode, 1);
  assert.match(evidence.failures[0].message, /no production config or network access/i);
  assert.ok(Buffer.byteLength(output.at(-1), "utf8") <= MAX_EVIDENCE_BYTES);
});

test("formatEvidenceJson bounds oversized failures and redacts secrets", () => {
  const json = formatEvidenceJson({
    status: "FAIL",
    ok: false,
    password: "do-not-print",
    failures: Array.from({ length: 100 }, (_, index) => ({
      case_id: `failure-${index}`,
      message: "x".repeat(2_000),
    })),
  });
  const parsed = JSON.parse(json);

  assert.ok(Buffer.byteLength(json, "utf8") <= MAX_EVIDENCE_BYTES);
  assert.equal(parsed.password, "[REDACTED]");
});

test("CLI rejects missing mode with nonzero bounded JSON", () => {
  const run = spawnSync(process.execPath, [verifierPath], {
    encoding: "utf8",
    maxBuffer: MAX_EVIDENCE_BYTES * 2,
    timeout: 30_000,
  });

  assert.notEqual(run.status, 0);
  assert.equal(run.stderr, "");
  assert.ok(Buffer.byteLength(run.stdout.trim(), "utf8") <= MAX_EVIDENCE_BYTES);
  const evidence = JSON.parse(run.stdout);
  assert.equal(evidence.status, "FAIL");
});
