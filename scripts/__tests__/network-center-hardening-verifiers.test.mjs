import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { spawnSync } from "node:child_process";

import {
  CANONICAL_FINDING_SLUGS,
  HARDENING_REGISTRY,
  MAX_EVIDENCE_BYTES,
  formatEvidenceJson,
  verifyHardeningRegistry,
} from "../verify-network-center-hardening.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const verifierPath = join(repositoryRoot, "scripts/verify-network-center-hardening.mjs");
const exploitCaseId = "rejects the exploit";
const controlCaseId = "allows the legitimate control";

let fixtureRoot;

before(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "network-center-hardening-"));
});

after(async () => {
  await rm(fixtureRoot, { force: true, recursive: true });
});

function regression(overrides = {}) {
  return {
    id: "runtime-regression",
    evidenceKind: "runtime",
    path: "fixture.test.mjs",
    command: ["node", "--test", "fixture.test.mjs"],
    exploitCaseId,
    legitimateControlCaseId: controlCaseId,
    ...overrides,
  };
}

function registry(overrides = {}) {
  return {
    schemaVersion: 1,
    findings: CANONICAL_FINDING_SLUGS.map((slug) => ({
      slug,
      regressions: [regression({ id: `${slug}-runtime` })],
    })),
    ...overrides,
  };
}

async function writeRunnableFixture(source = `
import test from "node:test";
test("${exploitCaseId}", () => {});
test("${controlCaseId}", () => {});
`) {
  await writeFile(join(fixtureRoot, "fixture.test.mjs"), source, "utf8");
}

function failureCodes(result) {
  return new Set(result.failures.map((failure) => failure.code));
}

test("rejects a registry with a missing canonical finding", async () => {
  await writeRunnableFixture();
  const candidate = registry();
  candidate.findings.pop();

  const result = await verifyHardeningRegistry(candidate, { rootDir: fixtureRoot });

  assert.equal(result.ok, false);
  assert.ok(failureCodes(result).has("MISSING_CANONICAL_FINDING"));
});

test("rejects duplicate finding slugs", async () => {
  await writeRunnableFixture();
  const candidate = registry();
  candidate.findings.push(structuredClone(candidate.findings[0]));

  const result = await verifyHardeningRegistry(candidate, { rootDir: fixtureRoot });

  assert.equal(result.ok, false);
  assert.ok(failureCodes(result).has("DUPLICATE_FINDING_SLUG"));
});

test("rejects an absent regression file and an absent legitimate control case", async () => {
  await writeRunnableFixture();
  const candidate = registry();
  candidate.findings[0].regressions[0].path = "missing.test.mjs";
  candidate.findings[0].regressions[0].command = ["node", "--test", "missing.test.mjs"];
  candidate.findings[1].regressions[0].legitimateControlCaseId = "missing control";

  const result = await verifyHardeningRegistry(candidate, { rootDir: fixtureRoot });

  assert.equal(result.ok, false);
  assert.ok(failureCodes(result).has("REGRESSION_FILE_MISSING"));
  assert.ok(failureCodes(result).has("CONTROL_CASE_MISSING"));
});

test("rejects referenced skip or todo cases", async () => {
  await writeRunnableFixture(`
import test from "node:test";
test.skip("${exploitCaseId}", () => {});
test.todo("${controlCaseId}");
`);

  const result = await verifyHardeningRegistry(registry(), { rootDir: fixtureRoot });

  assert.equal(result.ok, false);
  assert.ok(failureCodes(result).has("EXPLOIT_CASE_SKIPPED"));
  assert.ok(failureCodes(result).has("CONTROL_CASE_SKIPPED"));
});

test("rejects ancestor suite skips and object-form skip or todo cases", async () => {
  await writeRunnableFixture(`
import { describe, test } from "node:test";
describe.skip("disabled exploit suite", () => {
  test("${exploitCaseId}", () => {});
});
test("${controlCaseId}", { todo: true }, () => {});
`);

  const result = await verifyHardeningRegistry(registry(), { rootDir: fixtureRoot });

  assert.equal(result.ok, false);
  assert.ok(failureCodes(result).has("EXPLOIT_CASE_SKIPPED"));
  assert.ok(failureCodes(result).has("CONTROL_CASE_SKIPPED"));
});

test("uses trusted canonical runtime policy instead of registry declarations", async () => {
  await writeRunnableFixture();
  const candidate = registry();
  candidate.findings[0].regressions[0].evidenceKind = "source-text";
  candidate.findings[0].runtimeBoundaryAvailable = false;

  const result = await verifyHardeningRegistry(candidate, { rootDir: fixtureRoot });

  assert.equal(result.ok, false);
  assert.ok(failureCodes(result).has("RUNTIME_WRAPPER_MISSING"));
});

test("requires independent exploit and legitimate-control case IDs", async () => {
  await writeRunnableFixture();
  const candidate = registry();
  candidate.findings[0].regressions[0].legitimateControlCaseId = exploitCaseId;

  const result = await verifyHardeningRegistry(candidate, { rootDir: fixtureRoot });

  assert.equal(result.ok, false);
  assert.ok(failureCodes(result).has("CONTROL_CASE_NOT_INDEPENDENT"));
});

test("executes each unique command once and requires case evidence in output", async () => {
  const counterPath = join(fixtureRoot, "execution-count.txt");
  await writeRunnableFixture(`
import { appendFileSync } from "node:fs";
import test from "node:test";
appendFileSync(${JSON.stringify(counterPath)}, "1\\n");
test("${exploitCaseId}", () => {});
test("${controlCaseId}", () => {});
`);

  const result = await verifyHardeningRegistry(registry(), { rootDir: fixtureRoot });

  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal((await readFile(counterPath, "utf8")).trim(), "1");
  assert.equal(result.summary.commandsExecuted, 1);
});

test("rejects a registered command that exits 23", async () => {
  await writeFile(join(fixtureRoot, "exit-23.test.mjs"), `
import test from "node:test";
if (false) {
  test("${exploitCaseId}", () => {});
  test("${controlCaseId}", () => {});
}
console.log("${exploitCaseId}");
console.log("${controlCaseId}");
process.exit(23);
`, "utf8");
  const candidate = registry();
  for (const finding of candidate.findings) {
    finding.regressions[0].path = "exit-23.test.mjs";
    finding.regressions[0].command = ["node", "exit-23.test.mjs"];
  }

  const result = await verifyHardeningRegistry(candidate, { rootDir: fixtureRoot });

  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => (
    failure.code === "REGRESSION_COMMAND_FAILED" && failure.exitCode === 23
  )));
});

test("rejects successful commands that do not emit both case IDs", async () => {
  await writeFile(join(fixtureRoot, "silent.test.mjs"), `
import test from "node:test";
if (false) {
  test("${exploitCaseId}", () => {});
  test("${controlCaseId}", () => {});
}
`, "utf8");
  const candidate = registry();
  for (const finding of candidate.findings) {
    finding.regressions[0].path = "silent.test.mjs";
    finding.regressions[0].command = ["node", "silent.test.mjs"];
  }

  const result = await verifyHardeningRegistry(candidate, { rootDir: fixtureRoot });

  assert.equal(result.ok, false);
  assert.ok(failureCodes(result).has("EXPLOIT_CASE_EVIDENCE_MISSING"));
  assert.ok(failureCodes(result).has("CONTROL_CASE_EVIDENCE_MISSING"));
});

test("bounds command time and captured output", async () => {
  await writeFile(join(fixtureRoot, "bounded.test.mjs"), `
import test from "node:test";
if (false) {
  test("${exploitCaseId}", () => {});
  test("${controlCaseId}", () => {});
}
console.log("${exploitCaseId}");
console.log("${controlCaseId}");
console.log("x".repeat(4096));
setInterval(() => {}, 1000);
`, "utf8");
  const candidate = registry();
  for (const finding of candidate.findings) {
    finding.regressions[0].path = "bounded.test.mjs";
    finding.regressions[0].command = ["node", "bounded.test.mjs"];
  }

  const result = await verifyHardeningRegistry(candidate, {
    rootDir: fixtureRoot,
    commandTimeoutMs: 100,
    maxCommandOutputBytes: 512,
  });

  assert.equal(result.ok, false);
  assert.ok([
    "REGRESSION_COMMAND_OUTPUT_LIMIT",
    "REGRESSION_COMMAND_TIMEOUT",
  ].some((code) => failureCodes(result).has(code)));
});

test("canonical CLI executes regressions and reports the four DB wrappers plus heartbeat control gap", () => {
  const run = spawnSync(process.execPath, [verifierPath], {
    encoding: "utf8",
    maxBuffer: MAX_EVIDENCE_BYTES * 2,
    timeout: 180_000,
  });

  assert.equal(CANONICAL_FINDING_SLUGS.length, 14);
  assert.equal(HARDENING_REGISTRY.findings.length, 14);
  assert.notEqual(run.status, 0);
  assert.equal(run.stderr, "");
  const evidence = JSON.parse(run.stdout);
  assert.equal(evidence.status, "FAIL");
  assert.equal(evidence.summary.commandsExecuted, 10);
  assert.deepEqual(
    evidence.failures.map((failure) => `${failure.slug}:${failure.code}`).sort(),
    [
      "aruba-inventory-unbounded-retention:RUNTIME_WRAPPER_MISSING",
      "client-session-history-unbounded-retention:RUNTIME_WRAPPER_MISSING",
      "execute-queue-unbounded-admission:RUNTIME_WRAPPER_MISSING",
      "worker-heartbeat-global-view:CONTROL_CASE_NOT_INDEPENDENT",
      "worker-heartbeat-global-view:RUNTIME_WRAPPER_MISSING",
    ],
  );
});

test("formats bounded JSON evidence and redacts secret-shaped fields", () => {
  const json = formatEvidenceJson({
    ok: false,
    status: "FAIL",
    secret: "never-print-this-secret",
    nested: {
      authorization: "Bearer never-print-this-token",
      detail: "x".repeat(MAX_EVIDENCE_BYTES * 2),
    },
  });

  assert.ok(Buffer.byteLength(json, "utf8") <= MAX_EVIDENCE_BYTES);
  assert.doesNotMatch(json, /never-print-this/i);
  assert.deepEqual(JSON.parse(json).secret, "[REDACTED]");
});

test("CLI emits JSON and exits nonzero for every registry failure", async () => {
  await writeRunnableFixture();
  const candidate = registry();
  candidate.findings.pop();
  const registryPath = join(fixtureRoot, "invalid-registry.json");
  await writeFile(registryPath, JSON.stringify(candidate), "utf8");

  const run = spawnSync(process.execPath, [
    verifierPath,
    "--registry",
    registryPath,
    "--root",
    fixtureRoot,
  ], { encoding: "utf8" });

  assert.notEqual(run.status, 0);
  assert.equal(run.stderr, "");
  const evidence = JSON.parse(run.stdout);
  assert.equal(evidence.status, "FAIL");
  assert.ok(evidence.failures.some((failure) => (
    failure.code === "MISSING_CANONICAL_FINDING"
  )));
});
