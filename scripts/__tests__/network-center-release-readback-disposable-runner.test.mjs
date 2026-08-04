import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as disposableRunner from "../test-network-center-release-readback-disposable.mjs";

const runnerPath = fileURLToPath(
  new URL("../test-network-center-release-readback-disposable.mjs", import.meta.url),
);
const tempRoot = resolve(tmpdir());

function postgresBin() {
  const candidates = [
    process.env.POSTGRES_BIN?.trim(),
    process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\17\\bin" : null,
    process.platform === "win32" ? "C:\\Program Files\\PostgreSQL\\16\\bin" : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const pgCtl = join(candidate, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
    const probe = spawnSync(pgCtl, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    if (probe.status === 0 && /PostgreSQL\)?\s+(?:1[6-9]|[2-9]\d)(?:\.|\s|$)/u.test(probe.stdout)) {
      return candidate;
    }
  }

  const command = process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl";
  const pathProbe = spawnSync(command, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (
    pathProbe.status === 0
    && /PostgreSQL\)?\s+(?:1[6-9]|[2-9]\d)(?:\.|\s|$)/u.test(pathProbe.stdout)
  ) {
    return "";
  }
  return null;
}

function disposableClusters(root = tempRoot) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("network-center-pg-"))
    .map((entry) => resolve(root, entry.name));
}

function isDirectDisposableTempCluster(cluster, root = tempRoot) {
  return dirname(resolve(cluster)) === resolve(root)
    && /^network-center-pg-[A-Za-z0-9_-]+$/u.test(basename(cluster));
}

function cleanupOwnedClusters(clusters, bin, root) {
  const pgCtl = bin
    ? join(bin, process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl")
    : process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl";
  for (const cluster of clusters) {
    assert.equal(
      isDirectDisposableTempCluster(cluster, root),
      true,
      `refusing test cleanup outside disposable TEMP: ${cluster}`,
    );
    const stopped = spawnSync(pgCtl, ["-D", cluster, "-m", "immediate", "-w", "stop"], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    if (stopped.status !== 0 && existsSync(join(cluster, "postmaster.pid"))) {
      throw new Error(`test cleanup could not safely stop disposable cluster: ${cluster}`);
    }
    rmSync(cluster, { recursive: true, force: true });
  }
}

test("cleanup guard accepts only direct network-center-pg-* children of TEMP", () => {
  assert.equal(
    typeof disposableRunner.assertDisposableClusterPath,
    "function",
    "runner must expose its destructive cleanup guard for regression coverage",
  );
  if (typeof disposableRunner.assertDisposableClusterPath !== "function") return;

  const valid = join(tempRoot, "network-center-pg-Ab12_3");
  assert.equal(disposableRunner.assertDisposableClusterPath(valid), resolve(valid));
  assert.throws(
    () => disposableRunner.assertDisposableClusterPath(join(tempRoot, "unrelated-cluster")),
    /refusing.*disposable.*TEMP/i,
  );
  assert.throws(
    () => disposableRunner.assertDisposableClusterPath(
      join(tempRoot, "nested", "network-center-pg-Ab12_3"),
    ),
    /refusing.*disposable.*TEMP/i,
  );
  assert.throws(
    () => disposableRunner.assertDisposableClusterPath(
      join(tempRoot, "..", "network-center-pg-Ab12_3"),
    ),
    /refusing.*disposable.*TEMP/i,
  );
});

test("runner reserves its port before creating a disposable cluster", () => {
  const source = readFileSync(runnerPath, "utf8");
  const proofBody = source.slice(source.indexOf("export async function runDisposableReleaseProof"));
  const reservePortAt = proofBody.indexOf("await reserveLoopbackPort()");
  const createClusterAt = proofBody.indexOf("await mkdtemp(");
  assert.ok(reservePortAt >= 0, "loopback port reservation missing");
  assert.ok(createClusterAt >= 0, "disposable cluster creation missing");
  assert.ok(
    reservePortAt < createClusterAt,
    "a port-allocation failure after mkdtemp would bypass cleanup and leak the cluster",
  );
});

test("PostgreSQL version validation requires a real PostgreSQL 16+ version", () => {
  assert.equal(
    typeof disposableRunner.assertSupportedPostgresVersion,
    "function",
    "runner must validate the PostgreSQL major version reported by each binary",
  );
  if (typeof disposableRunner.assertSupportedPostgresVersion !== "function") return;

  assert.equal(
    disposableRunner.assertSupportedPostgresVersion("pg_ctl", "pg_ctl (PostgreSQL) 16.0"),
    16,
  );
  assert.equal(
    disposableRunner.assertSupportedPostgresVersion("psql", "psql (PostgreSQL) 17.5"),
    17,
  );
  assert.throws(
    () => disposableRunner.assertSupportedPostgresVersion(
      "initdb",
      "initdb (PostgreSQL) 15.13",
    ),
    /PostgreSQL 16\+/i,
  );
  assert.throws(
    () => disposableRunner.assertSupportedPostgresVersion("pg_ctl", "not postgres"),
    /valid PostgreSQL version/i,
  );
});

test("dry-run validates all CLI arguments before reporting success", () => {
  const result = spawnSync(process.execPath, [runnerPath, "--dry-run", "--bogus"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });

  assert.notEqual(result.status, 0, "unknown arguments must fail even in dry-run mode");
  assert.match(result.stderr, /Usage:/u);
  assert.doesNotMatch(result.stdout, /dry-run passed/iu);
});

test("disposable proof bootstraps and exercises authoritative keyed readback", () => {
  const source = readFileSync(runnerPath, "utf8");
  assert.match(source, /CREATE SCHEMA extensions/i);
  assert.match(source, /CREATE EXTENSION pgcrypto WITH SCHEMA extensions/i);
  assert.match(source, /CREATE TABLE public\.network_worker_assignments/i);
  assert.match(source, /network_center_admin_worker_release_status_v1/i);
  assert.match(source, /activeAssignedBuildingCount/i);
  assert.match(source, /activeAssignmentCount/i);
  assert.match(source, /activeAssignmentHash/i);
  assert.match(source, /network-worker-assignment-v1/i);
  assert.match(source, /organization_id/i);
  assert.match(source, /device_id/i);
  assert.match(source, /assignment_version/i);
  assert.match(source, /two active assignment rows for one building/i);
  assert.match(source, /same-building device swap/i);
  assert.match(source, /capability change/i);
  assert.match(source, /assignment ID\/version\/window change/i);
  assert.match(source, /COLLATE\s+"C"/i);
  assert.match(source, /v_missing_release_status\s+IS\s+NOT\s+NULL/i);
  assert.match(source, /v_other_worker_release_status/i);
  assert.match(
    source,
    /has_function_privilege\([\s\S]*network_center_admin_worker_release_status_v1\(text,text\)/i,
  );
});

test("published integration timeout covers every legitimate native-command budget", () => {
  const expectedCommandBudget = (3 * 4 * 10_000) + (4 * 60_000) + (2 * 30_000) + 10_000;
  assert.ok(
    Number.isSafeInteger(disposableRunner.DISPOSABLE_PROOF_PROCESS_TIMEOUT_MS),
    "runner must publish the timeout required by its integration test",
  );
  assert.equal(
    disposableRunner.DISPOSABLE_PROOF_PROCESS_TIMEOUT_MS,
    expectedCommandBudget,
    "timeout must cover configured, PostgreSQL 17, PostgreSQL 16, and PATH probes for each binary, every native command, and cleanup slack",
  );
});

// Floor for the disposable release proof's invariant count, reported by the
// runner as "PASS: N/M invariants." Raise this constant whenever a
// legitimate new invariant is added to ASSERTION_SQL in
// scripts/test-network-center-release-readback-disposable.mjs. This test
// does not care about the exact count (that number is expected to grow as
// the proof gains coverage) -- it only guards against the count silently
// SHRINKING, which would mean invariants were dropped without anyone
// noticing.
const MINIMUM_DISPOSABLE_PROOF_INVARIANT_COUNT = 95;

test("disposable PostgreSQL runner cannot retain pg_ctl pipes and cleans its TEMP cluster", {
  timeout: Number.isSafeInteger(disposableRunner.DISPOSABLE_PROOF_PROCESS_TIMEOUT_MS)
    ? disposableRunner.DISPOSABLE_PROOF_PROCESS_TIMEOUT_MS + 10_000
    : 30_000,
}, (t) => {
  const bin = postgresBin();
  if (bin === null) {
    t.skip("PostgreSQL 16+ binaries are unavailable");
    return;
  }

  const ownedTempRoot = mkdtempSync(join(tempRoot, "network-center-runner-test-"));
  const result = spawnSync(process.execPath, [runnerPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(bin ? { POSTGRES_BIN: bin } : {}),
      TEMP: ownedTempRoot,
      TMP: ownedTempRoot,
      TMPDIR: ownedTempRoot,
    },
    timeout: Number.isSafeInteger(disposableRunner.DISPOSABLE_PROOF_PROCESS_TIMEOUT_MS)
      ? disposableRunner.DISPOSABLE_PROOF_PROCESS_TIMEOUT_MS
      : 15_000,
    windowsHide: true,
  });
  const created = disposableClusters(ownedTempRoot);

  try {
    assert.notEqual(
      result.error?.code,
      "ETIMEDOUT",
      "runner timed out because the background postmaster retained a captured pg_ctl pipe",
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const invariantMatch = result.stdout.match(/PASS:\s*(\d+)\/(\d+)\s*invariants/i);
    assert.ok(
      invariantMatch,
      `runner stdout did not report a "PASS: N/M invariants" line: ${result.stdout}`,
    );
    const [, reportedCount, reportedTotal] = invariantMatch;
    assert.equal(
      reportedCount,
      reportedTotal,
      `runner reported a partial proof (${reportedCount}/${reportedTotal}) instead of a full pass`,
    );
    assert.ok(
      Number(reportedCount) >= MINIMUM_DISPOSABLE_PROOF_INVARIANT_COUNT,
      `runner's invariant count dropped to ${reportedCount}; expected at least ` +
        `${MINIMUM_DISPOSABLE_PROOF_INVARIANT_COUNT} (see MINIMUM_DISPOSABLE_PROOF_INVARIANT_COUNT)`,
    );
    assert.deepEqual(created, [], `runner leaked disposable clusters: ${created.join(", ")}`);
  } finally {
    cleanupOwnedClusters(created, bin, ownedTempRoot);
    rmSync(ownedTempRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The bootstrap-unmodelled exclusion list.
//
// The forward-fix glob is what keeps this proof honest: delete a fix and the
// run goes red instead of certifying the superseded body. An exclusion list is
// a hole in exactly that mechanism, so it gets the same scrutiny the glob does.
// ---------------------------------------------------------------------------
test("the forward-fix glob still applies every stage the bootstrap does model", () => {
  const discovered = disposableRunner
    .discoverForwardFixMigrations()
    .map((path) => basename(path));
  assert.ok(discovered.length > 0, "the forward-fix glob matched nothing");
  assert.ok(
    discovered.includes("20260729146000_network_center_worker_heartbeat_coverage_honesty.sql"),
    "the heartbeat coverage forward fix stopped being applied; this proof would "
      + `certify the superseded body. discovered=${discovered.join(", ")}`,
  );
});

test("a stage the bootstrap cannot model is excluded by name, never by watermark", () => {
  const excluded = Object.keys(disposableRunner.BOOTSTRAP_UNMODELLED_MIGRATIONS);
  assert.ok(excluded.length > 0, "the exclusion list is empty but still referenced");
  const discovered = disposableRunner
    .discoverForwardFixMigrations()
    .map((path) => basename(path));
  for (const name of excluded) {
    assert.ok(
      !discovered.includes(name),
      `${name} is listed as unmodelled by the bootstrap yet is still applied`,
    );
    assert.ok(
      typeof disposableRunner.BOOTSTRAP_UNMODELLED_MIGRATIONS[name] === "string"
        && disposableRunner.BOOTSTRAP_UNMODELLED_MIGRATIONS[name].length > 20,
      `${name} is excluded without a reason anyone can act on`,
    );
    // Excluding a stage is only defensible while the stage is NEWER than the
    // floor. Anything at or below it is already excluded and the entry is dead.
    assert.ok(
      name.slice(0, 14) > "20260729145000",
      `${name} is already below the discovery floor; the exclusion entry is dead`,
    );
  }
});

test("an exclusion that no longer names a real migration fails loudly", () => {
  const emptyDirectory = mkdtempSync(join(tempRoot, "network-center-exclusion-test-"));
  try {
    assert.throws(
      () => disposableRunner.discoverForwardFixMigrations(emptyDirectory),
      /excluded from this proof as unmodelled by its bootstrap, but no such/u,
      "a stale exclusion must fail loudly instead of quietly exempting a name a "
        + "future migration could inherit",
    );
  } finally {
    rmSync(emptyDirectory, { recursive: true, force: true });
  }
});
