// Unit coverage for the Docker-free disposable cluster and the two CI gates
// that exist because of real incidents on this project: a disposable Postgres
// that survived three days on a public address, and ~56 security tests that
// were skipped silently outside Windows.
//
// These are pure-function tests. The end-to-end behaviour of the cluster itself
// is covered by network-center-hardening-runtime.test.mjs, which boots one.
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  FLEET_SEED_AFTER_MIGRATION,
  MINIMUM_NETWORK_CENTER_MIGRATIONS,
  assertLocalClusterPath,
  assertLoopbackPortClosed,
  assertSupportedLocalPostgresVersion,
  buildLocalClusterProofSql,
  buildLocalClusterSeedSql,
  candidateLocalPostgresBins,
  loadNetworkCenterMigrations,
} from "../network-center-disposable-db.mjs";
import { analyzeTestLog } from "../verify-network-center-test-completeness.mjs";
import {
  findExposedListeners,
  findWideDnatRules,
  verifyDisposableTeardown,
} from "../verify-network-center-disposable-teardown.mjs";

// fileURLToPath chu khong phai .pathname: .pathname giu nguyen percent-encoding,
// nen bat ky duong dan nao co dau cach deu thanh %20 va fs khong mo duoc file.
// Da can tren may that ("C:/Users/Nguyen Tam/..." -> "Nguyen%20Tam"): 32 test do.
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))
  .replace(/^\/([A-Za-z]:)/u, "$1");

test("POSTGRES_BIN wins over the platform defaults", () => {
  const configured = candidateLocalPostgresBins(
    { POSTGRES_BIN: "  /opt/pg/bin  " },
    "linux",
  );
  assert.equal(configured[0], "/opt/pg/bin");
  assert.ok(configured.includes("/usr/lib/postgresql/17/bin"));

  const windows = candidateLocalPostgresBins({}, "win32");
  assert.ok(windows.includes("C:\\Program Files\\PostgreSQL\\17\\bin"));
  assert.ok(!windows.some((entry) => entry.startsWith("/usr/lib")));
});

test("PostgreSQL 16 is the floor and unparsable versions fail closed", () => {
  assert.equal(
    assertSupportedLocalPostgresVersion("initdb", "initdb (PostgreSQL) 17.6"),
    17,
  );
  assert.throws(
    () => assertSupportedLocalPostgresVersion("psql", "psql (PostgreSQL) 15.4"),
    /PostgreSQL 16\+/u,
  );
  assert.throws(
    () => assertSupportedLocalPostgresVersion("psql", "some other tool"),
    /valid PostgreSQL version/u,
  );
});

test("recursive cleanup refuses anything that is not a disposable temp cluster", () => {
  const legitimate = join(tmpdir(), "network-center-pg-abc123");
  assert.equal(assertLocalClusterPath(legitimate), legitimate);

  assert.throws(
    () => assertLocalClusterPath(join(tmpdir(), "important-data")),
    /Refusing destructive cleanup/u,
  );
  assert.throws(
    () => assertLocalClusterPath("/var/lib/postgresql/17/main"),
    /Refusing destructive cleanup/u,
  );
  assert.throws(
    () => assertLocalClusterPath(join(tmpdir(), "sub", "network-center-pg-x")),
    /Refusing destructive cleanup/u,
  );
});

test("teardown verification rejects a port that still accepts connections", async () => {
  const server = createServer();
  const port = await new Promise((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
  try {
    await assert.rejects(
      () => assertLoopbackPortClosed(port),
      /still accepts connections/u,
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
  await assertLoopbackPortClosed(port);
});

test("every Network Center migration is discovered in lexicographic order", async () => {
  const migrations = await loadNetworkCenterMigrations(repositoryRoot);
  assert.ok(migrations.length >= MINIMUM_NETWORK_CENTER_MIGRATIONS);
  const names = migrations.map((entry) => entry.name);
  assert.deepEqual(names, [...names].sort());
  for (const name of names) {
    assert.match(name, /^20260729\d{6}_network_center_[a-z0-9_]+\.sql$/u);
  }
  for (const entry of migrations) {
    assert.ok(entry.body.length > 0, entry.name);
  }
});

// The fleet seed must land before the hardening wave, because 20260729133000
// snapshots the MikroTik devices that exist when it runs. If that anchor file
// is ever renamed, the seed silently lands in the wrong place and every legacy
// compatibility path starts failing for a reason unrelated to security.
test("the fleet seed anchor migration still exists", async () => {
  const migrations = await loadNetworkCenterMigrations(repositoryRoot);
  assert.ok(
    migrations.some((entry) => entry.name === FLEET_SEED_AFTER_MIGRATION),
    `${FLEET_SEED_AFTER_MIGRATION} is missing`,
  );
});

test("the seed writes tenancy for DEMO and keeps fleet fixtures optional", () => {
  const withFleet = buildLocalClusterSeedSql({});
  const withoutFleet = buildLocalClusterSeedSql({ includeFleetFixtures: false });

  assert.match(withFleet, /dddd0000-0000-4000-8000-000000000001/u);
  assert.match(withFleet, /network_devices/u);
  assert.match(withFleet, /network_site_settings/u);
  assert.doesNotMatch(withoutFleet, /INSERT INTO public\.network_devices/u);
  assert.doesNotMatch(withoutFleet, /INSERT INTO public\.network_site_settings/u);
  assert.match(withoutFleet, /dddd0000-0000-4000-8000-000000000001/u);

  // The non-demo organization exists only as a read-only negative target: it
  // gets an organization row, an owner membership and one building, and no
  // Network Center device or site settings row is ever created for it.
  assert.match(withFleet, /aaaa0000-0000-4000-8000-000000000001/u);
  const deviceSection = withFleet.slice(
    withFleet.indexOf("INSERT INTO public.network_devices"),
  );
  assert.doesNotMatch(deviceSection, /aaaa0000-0000-4000-8000-000000000001/u);

  for (const sql of [withFleet, withoutFleet]) {
    assert.doesNotMatch(sql, /sbp_[a-f0-9]/u);
    assert.doesNotMatch(sql, /service_role_key/u);
  }
});

test("the disposable proof table is never readable by a browser role", () => {
  const sql = buildLocalClusterProofSql({
    proofNonce: "0".repeat(32),
    manifestSha256: "a".repeat(64),
    migrationCount: 14,
  });
  assert.match(
    sql,
    /REVOKE ALL ON app_private\.network_center_disposable_proof\s+FROM PUBLIC, anon, authenticated, service_role/u,
  );
  assert.match(sql, /'0{32}'/u);
});

// --- CI gate: a skipped suite must fail --------------------------------------

test("vitest logs fail when anything was skipped and when nothing ran", () => {
  const clean = analyzeTestLog(
    "vitest",
    " Test Files  3 passed (3)\n      Tests  42 passed (42)\n",
  );
  assert.equal(clean.ok, true);
  assert.equal(clean.executed, 42);

  const skipped = analyzeTestLog(
    "vitest",
    " Test Files  3 passed (3)\n      Tests  40 passed | 2 skipped (42)\n",
  );
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, "TESTS_SKIPPED");

  const empty = analyzeTestLog(
    "vitest",
    " Test Files  no tests\n      Tests  0 passed (0)\n",
  );
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "NO_TESTS_EXECUTED");

  assert.equal(analyzeTestLog("vitest", "").reason, "TEST_LOG_EMPTY");
  assert.equal(
    analyzeTestLog("vitest", "some unrelated output").reason,
    "VITEST_SUMMARY_MISSING",
  );
});

test("node:test and deno logs fail on skipped, todo or ignored cases", () => {
  const nodeClean = analyzeTestLog(
    "node",
    "# tests 8\n# pass 8\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n",
  );
  assert.equal(nodeClean.ok, true);

  const nodeSkipped = analyzeTestLog(
    "node",
    "# tests 8\n# pass 7\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n",
  );
  assert.equal(nodeSkipped.ok, false);
  assert.equal(nodeSkipped.reason, "TESTS_SKIPPED");

  const nodeTodo = analyzeTestLog(
    "node",
    "# tests 8\n# pass 7\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 1\n",
  );
  assert.equal(nodeTodo.reason, "TESTS_SKIPPED");
  assert.equal(
    analyzeTestLog("node", "no summary here").reason,
    "NODE_SUMMARY_MISSING",
  );

  const denoClean = analyzeTestLog(
    "deno",
    "ok | 22 passed | 0 failed (1s)\n",
  );
  assert.equal(denoClean.ok, true);
  const denoIgnored = analyzeTestLog(
    "deno",
    "ok | 21 passed | 0 failed | 1 ignored (1s)\n",
  );
  assert.equal(denoIgnored.ok, false);
  assert.equal(denoIgnored.reason, "TESTS_SKIPPED");
});

// --- CI gate: teardown proven by evidence ------------------------------------

test("a DNAT rule that does not land on loopback is reported", () => {
  const rules = [
    "-A DOCKER -p tcp -m tcp --dport 54322 -j DNAT --to-destination 172.17.0.2:5432",
    "-A DOCKER -p tcp -m tcp --dport 20128 -j DNAT --to-destination 127.0.0.1:20128",
    "-A DOCKER -p tcp -m tcp --dport 54321 -j DNAT --to-destination 127.0.0.1:54321",
  ].join("\n");
  const wide = findWideDnatRules(rules);
  assert.equal(wide.length, 1);
  assert.match(wide[0], /54322/u);
});

test("a listener on a non-loopback address is reported", () => {
  const listeners = [
    "LISTEN 0 4096 0.0.0.0:54322 0.0.0.0:*",
    "LISTEN 0 4096 127.0.0.1:54323 0.0.0.0:*",
    "LISTEN 0 4096 [::1]:54324 [::]:*",
    "LISTEN 0 4096 0.0.0.0:22 0.0.0.0:*",
  ].join("\n");
  const exposed = findExposedListeners(listeners);
  assert.equal(exposed.length, 1);
  assert.match(exposed[0], /54322/u);
});

test("teardown verification fails on a surviving container or a restart policy", () => {
  const runner = (command, args) => {
    if (command === "docker" && args[0] === "ps") {
      return { available: true, stdout: "supabase_db_ihome-nc-disposable-1\n" };
    }
    if (command === "docker" && args[0] === "inspect") {
      return { available: true, stdout: "unless-stopped\n" };
    }
    return { available: false, stdout: "" };
  };
  const result = verifyDisposableTeardown({ runner });
  assert.equal(result.ok, false);
  const codes = result.failures.map((failure) => failure.code);
  assert.ok(codes.includes("DISPOSABLE_CONTAINER_SURVIVED"));
  assert.ok(codes.includes("DISPOSABLE_RESTART_POLICY"));
});

test("teardown that could not be checked at all is a failure, not a pass", () => {
  const result = verifyDisposableTeardown({
    runner: () => ({ available: false, stdout: "" }),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.code),
    ["TEARDOWN_UNVERIFIABLE"],
  );
});

test("a clean host passes every available teardown check", () => {
  const runner = (command, args) => {
    if (command === "docker" && args[0] === "ps") {
      return { available: true, stdout: "unrelated-app\n" };
    }
    if (command === "docker" && args[0] === "inspect") {
      return { available: true, stdout: "no\n" };
    }
    if (command === "iptables") {
      return {
        available: true,
        stdout: "-A DOCKER -p tcp --dport 20128 -j DNAT --to-destination 127.0.0.1:20128",
      };
    }
    if (command === "ss") {
      return { available: true, stdout: "LISTEN 0 4096 127.0.0.1:54322 0.0.0.0:*" };
    }
    return { available: false, stdout: "" };
  };
  const result = verifyDisposableTeardown({ runner });
  assert.deepEqual(result.failures, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, {
    containers: "pass",
    dnat: "pass",
    listeners: "pass",
  });
});
