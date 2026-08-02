import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  ADMIN_COMMANDS,
  getStatus,
  getWorkerReleaseStatus,
  parseAdminCommand,
} from "../network-center-admin.mjs";

const root = new URL("../../", import.meta.url);
const migrationPath = new URL(
  "supabase/migrations/20260729136000_network_center_worker_release_readback.sql",
  root,
);
const runtimeProofPath = new URL(
  "scripts/network-center-release-heartbeat-runtime-proof.sql",
  root,
);
const disposableRunnerPath = new URL(
  "scripts/test-network-center-release-readback-disposable.mjs",
  root,
);
const expectedConnectionsMigrationPath = new URL(
  "supabase/migrations/20260729143000_network_center_worker_release_expected_connections.sql",
  root,
);
const statusHonestyMigrationPath = new URL(
  "supabase/migrations/20260729144000_network_center_worker_heartbeat_status_honesty.sql",
  root,
);

test("release heartbeat readback is additive, version-keyed and service-role-only", () => {
  assert.equal(existsSync(migrationPath), true, "release heartbeat migration missing");
  if (!existsSync(migrationPath)) return;
  const sql = readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE app_private\.network_worker_release_heartbeats/i);
  assert.match(sql, /PRIMARY KEY\s*\(worker_id,\s*worker_version\)/i);
  assert.match(sql, /network_center_worker_heartbeat_core_v2/i);
  assert.match(sql, /ON CONFLICT\s*\(worker_id,\s*worker_version\)/i);
  assert.match(sql, /connection_count\s+integer/i);
  assert.match(sql, /successful_poll_count\s+integer/i);
  assert.match(sql, /failed_poll_count\s+integer/i);
  assert.match(sql, /poll_observed_at\s+timestamptz/i);
  assert.match(sql, /network_center_admin_release_status_v1/i);
  assert.match(sql, /REVOKE ALL[\s\S]*PUBLIC, anon, authenticated, service_role/i);
  assert.match(sql, /GRANT EXECUTE[\s\S]*TO service_role/i);
  const table = sql.match(
    /CREATE TABLE app_private\.network_worker_release_heartbeats\s*\([\s\S]*?\n\);/i,
  )?.[0];
  const statusFunction = sql.match(
    /CREATE OR REPLACE FUNCTION public\.network_center_admin_release_status_v1\([\s\S]*?\n\$fn\$;/i,
  )?.[0];
  assert.ok(table, "release heartbeat table definition missing");
  assert.ok(statusFunction, "release status function definition missing");
  for (const storageOrProjection of [table, statusFunction]) {
    assert.doesNotMatch(storageOrProjection, /credential_digest/i);
    assert.doesNotMatch(storageOrProjection, /safe_metadata/i);
  }
});

test("release heartbeat accepts only an exact lowercase 40-character commit SHA", () => {
  const sql = readFileSync(migrationPath, "utf8");
  const table = sql.match(
    /CREATE TABLE app_private\.network_worker_release_heartbeats\s*\([\s\S]*?\n\);/i,
  )?.[0];
  const heartbeatFunction = sql.match(
    /CREATE OR REPLACE FUNCTION public\.network_center_worker_heartbeat_v2\([\s\S]*?\n\$fn\$;/i,
  )?.[0];
  const heartbeatCore = sql.match(
    /CREATE OR REPLACE FUNCTION app_private\.network_center_worker_heartbeat_core_v2\([\s\S]*?\n\$fn\$;/i,
  )?.[0];
  assert.ok(table, "release heartbeat table definition missing");
  assert.ok(heartbeatFunction, "release heartbeat wrapper missing");
  assert.ok(heartbeatCore, "private heartbeat core hardening definition missing");
  assert.match(table, /octet_length\(worker_version\)\s*=\s*40/i);
  assert.match(table, /CHECK\s*\(worker_version\s*~\s*'\^\[a-f0-9\]\{40\}\$'\)/i);
  assert.match(heartbeatFunction, /octet_length\(p_worker_version\)\s*<>\s*40/i);
  assert.match(heartbeatCore, /octet_length\(p_worker_version\)\s*<>\s*40/i);
  assert.match(heartbeatCore, /p_worker_version\s*!~\s*'\^\[a-f0-9\]\{40\}\$'/);
  assert.match(heartbeatFunction, /p_worker_version\s*!~\s*'\^\[a-f0-9\]\{40\}\$'/);
  assert.doesNotMatch(
    heartbeatFunction,
    /v_worker_version\s+text\s*:=\s*btrim/i,
    "raw worker_version must be validated without trimming or canonicalization",
  );
  const validationOffset = heartbeatFunction.search(/p_worker_version\s*!~/);
  const coreCallOffset = heartbeatFunction.search(/network_center_worker_heartbeat_core_v2\s*\(/i);
  assert.ok(validationOffset >= 0 && validationOffset < coreCallOffset,
    "worker_version must be rejected before the mutation-capable heartbeat core runs");
});

test("retention never expires a release that is still a reachable rollback target", () => {
  const sql = readFileSync(migrationPath, "utf8");
  const heartbeatFunction = sql.match(
    /CREATE OR REPLACE FUNCTION public\.network_center_worker_heartbeat_v2\([\s\S]*?\n\$fn\$;/i,
  )?.[0];
  assert.ok(heartbeatFunction, "release heartbeat wrapper missing");

  // An age-only purge deletes the previous release 30 days after it was
  // superseded, even though the host still names it as the rollback target and
  // rollback-vultr.ps1 refuses to roll back without that row.
  assert.doesNotMatch(
    heartbeatFunction,
    /DELETE FROM app_private\.network_worker_release_heartbeats\s+heartbeat\s+WHERE heartbeat\.heartbeat_at\s*<\s*v_now\s*-\s*INTERVAL/i,
    "age-based retention must not delete rows without checking rollback reachability",
  );
  assert.match(
    heartbeatFunction,
    /c_rollback_reachable_releases\s+constant\s+integer\s*:=\s*(\d+)/i,
    "retention must declare an explicit rollback-reachable release depth",
  );
  assert.match(
    heartbeatFunction,
    /row_number\(\)\s*OVER\s*\(\s*PARTITION BY\s+ranked\.worker_id\s+ORDER BY\s+ranked\.heartbeat_at DESC/i,
    "reachability must be ranked per worker by promotion recency",
  );
  assert.match(
    heartbeatFunction,
    /release_rank\s*>\s*c_rollback_reachable_releases[\s\S]{0,200}heartbeat_at\s*<\s*v_now\s*-\s*c_release_retention_max_age/i,
    "age expiry must apply only beyond the rollback-reachable depth",
  );

  // Unbounded growth must still be impossible: fresh releases never age out, so
  // the per-worker hard cap is their only bound.
  assert.match(
    heartbeatFunction,
    /c_release_retention_limit\s+constant\s+integer\s*:=\s*(\d+)/i,
  );
  assert.match(heartbeatFunction, /OFFSET c_release_retention_limit/i);
  const reachable = Number.parseInt(
    heartbeatFunction.match(/c_rollback_reachable_releases\s+constant\s+integer\s*:=\s*(\d+)/i)[1],
    10,
  );
  const cap = Number.parseInt(
    heartbeatFunction.match(/c_release_retention_limit\s+constant\s+integer\s*:=\s*(\d+)/i)[1],
    10,
  );
  assert.ok(reachable >= 2, "rollback needs at least the current and previous release");
  assert.ok(cap > reachable, "the hard cap must never be able to evict a reachable target");
  assert.match(
    sql,
    /CREATE INDEX network_worker_release_heartbeats_worker_recent_idx[\s\S]*?worker_id,\s*heartbeat_at DESC/i,
    "per-worker promotion-recency ranking needs a supporting index",
  );
});

test("poll evidence fails closed on JSON null, not just on a missing key", () => {
  const sql = readFileSync(migrationPath, "utf8");
  const heartbeatFunction = sql.match(
    /CREATE OR REPLACE FUNCTION public\.network_center_worker_heartbeat_v2\([\s\S]*?\n\$fn\$;/i,
  )?.[0];
  assert.ok(heartbeatFunction, "release heartbeat wrapper missing");

  // `?|` and `?&` test key existence and ignore the value, so a JSON null
  // reaches the integer casts, produces SQL NULL without raising, and makes the
  // range guard evaluate to NULL rather than TRUE.
  for (const key of ["connections", "successfulPolls", "failedPolls"]) {
    assert.match(
      heartbeatFunction,
      new RegExp(`p_safe_metadata->>'${key}'\\s+IS NULL`, "i"),
      `JSON null ${key} must be rejected explicitly`,
    );
  }
  const incompleteGuard = heartbeatFunction.match(
    /IF NOT \(p_safe_metadata \?&[\s\S]*?RAISE EXCEPTION 'Incomplete worker poll evidence'/i,
  )?.[0];
  assert.ok(
    incompleteGuard,
    "JSON null values must fail closed with the same error as missing keys",
  );
  for (const key of ["connections", "successfulPolls", "failedPolls"]) {
    assert.match(incompleteGuard, new RegExp(`>>'${key}'\\s+IS NULL`, "i"));
  }
  assert.match(
    heartbeatFunction,
    /v_connection_count IS NULL\s+OR v_successful_poll_count IS NULL\s+OR v_failed_poll_count IS NULL\s+OR v_connection_count NOT BETWEEN/i,
    "a three-way NULL comparison must never be read as a passed range check",
  );
  assert.match(
    heartbeatFunction,
    /IF v_worker_id IS NULL/i,
    "the server-derived worker principal must be re-checked before the release write",
  );
});

test("ships an exact keyed release readback outside the bounded status list", () => {
  const sql = readFileSync(migrationPath, "utf8");
  const keyedFunction = sql.match(
    /CREATE OR REPLACE FUNCTION public\.network_center_admin_worker_release_status_v1\([\s\S]*?\n\$fn\$;/i,
  )?.[0];
  assert.ok(keyedFunction, "exact keyed release readback function missing");
  assert.match(keyedFunction, /p_worker_key\s+text/i);
  assert.match(keyedFunction, /p_worker_version\s+text/i);
  assert.match(keyedFunction, /octet_length\(p_worker_version\)\s*<>\s*40/i);
  assert.match(keyedFunction, /p_worker_version\s*!~\s*'\^\[a-f0-9\]\{40\}\$'/);
  assert.match(keyedFunction, /worker\.worker_key\s*=\s*p_worker_key/i);
  assert.match(keyedFunction, /heartbeat\.worker_version\s*=\s*p_worker_version/i);
  assert.doesNotMatch(keyedFunction, /\bLIMIT\b/i);
  assert.doesNotMatch(keyedFunction, /credential_digest|safe_metadata|secret_digest/i);
  for (const field of [
    "schemaVersion", "workerKey", "workerVersion", "status", "heartbeatAt", "startedAt",
    "assignedBuildingCount", "activeAssignedBuildingCount", "activeAssignmentCount",
    "activeAssignmentHash",
    "connectionCount", "successfulPollCount", "failedPollCount", "pollObservedAt",
  ]) {
    assert.match(keyedFunction, new RegExp(field, "i"), `missing ${field}`);
  }
  assert.equal(
    keyedFunction.match(/FROM public\.network_worker_assignments\s+assignment/gi)?.length,
    1,
    "counts and digest must share one effective-assignment relation",
  );
  assert.match(
    keyedFunction,
    /count\s*\(\s*DISTINCT\s*\(\s*organization_id\s*,\s*building_id\s*\)\s*\)/i,
  );
  assert.match(keyedFunction, /count\s*\(\s*\*\s*\).*active_assignment_count/is);
  assert.match(
    keyedFunction,
    /concat_ws\(\s*'\|'\s*,\s*'network-worker-assignment-v1'\s*,\s*assignment\.id::text\s*,\s*assignment\.worker_id::text\s*,\s*assignment\.organization_id::text\s*,\s*assignment\.building_id::text\s*,\s*assignment\.device_id::text\s*,\s*assignment\.device_kind\s*,\s*assignment\.assignment_version::text[\s\S]*assignment\.can_poll[\s\S]*assignment\.can_inventory[\s\S]*assignment\.can_execute[\s\S]*assignment\.active_from[\s\S]*assignment\.active_until/i,
    "assignment hash must serialize every canonical v1 field in contract order",
  );
  assert.match(
    keyedFunction,
    /string_agg\(\s*canonical_row\s*,\s*E?'\\n'\s+ORDER BY\s+canonical_row\s+COLLATE\s+"C"/i,
    "canonical assignment rows must use newline framing and bytewise ordering",
  );
  assert.match(keyedFunction, /extensions\.digest[\s\S]*'sha256'/i);
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.network_center_admin_worker_release_status_v1\(\s*text,\s*text\s*\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/i,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.network_center_admin_worker_release_status_v1\(\s*text,\s*text\s*\)[\s\S]*?TO service_role/i,
  );
});

test("admin status preserves the control plane and merges release heartbeats", async () => {
  const calls = [];
  const baseStatus = {
    workers: [{ workerKey: "worker-01", version: 41 }],
    assignments: [{ workerKey: "worker-01", buildingId: "building-01" }],
  };
  const releaseHeartbeats = [{
    workerKey: "worker-01",
    workerVersion: "a".repeat(40),
    status: "PAUSED",
    connectionCount: 1,
    successfulPollCount: 1,
    failedPollCount: 0,
    pollObservedAt: "2026-08-01T07:00:00.000Z",
  }];
  const result = await getStatus({
    buildingId: null,
    limit: 100,
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "network_center_admin_status_v1") return baseStatus;
      if (name === "network_center_admin_release_status_v1") {
        return { releaseHeartbeats };
      }
      throw new Error(`Unexpected RPC ${name}`);
    },
  });
  assert.deepEqual(calls, [
    {
      name: "network_center_admin_status_v1",
      args: { p_building_id: null, p_limit: 100 },
    },
    {
      name: "network_center_admin_release_status_v1",
      args: { p_limit: 100 },
    },
  ]);
  assert.deepEqual(result, { ...baseStatus, releaseHeartbeats });
});

test("admin exact release readback uses only the keyed RPC and validates authoritative evidence", async () => {
  const workerKey = "vultr-network-center-01";
  const workerVersion = "a".repeat(40);
  const expected = {
    schemaVersion: 1,
    workerKey,
    displayName: "Vultr Network Center",
    workerVersion,
    status: "PAUSED",
    heartbeatAt: "2026-08-01T07:00:00.000Z",
    startedAt: "2026-08-01T06:00:00.000Z",
    assignedBuildingCount: 2,
    activeAssignedBuildingCount: 2,
    activeAssignmentCount: 2,
    activeAssignmentHash: "b".repeat(64),
    expectedConnectionCount: 2,
    connectionCount: 2,
    successfulPollCount: 2,
    failedPollCount: 0,
    pollObservedAt: "2026-08-01T06:59:59.000Z",
  };
  const calls = [];
  const result = await getWorkerReleaseStatus({
    workerKey,
    workerVersion,
    rpc: async (name, args) => {
      calls.push({ name, args });
      assert.equal(name, "network_center_admin_worker_release_status_v1");
      return expected;
    },
  });
  assert.deepEqual(calls, [{
    name: "network_center_admin_worker_release_status_v1",
    args: { p_worker_key: workerKey, p_worker_version: workerVersion },
  }]);
  assert.deepEqual(result, expected);
  assert.notStrictEqual(result, expected, "validated RPC data must be reconstructed safely");
});

test("admin exact release readback preserves SQL NULL and rejects malformed evidence", async () => {
  const workerKey = "vultr-network-center-01";
  const workerVersion = "a".repeat(40);
  assert.equal(await getWorkerReleaseStatus({
    workerKey,
    workerVersion,
    rpc: async () => null,
  }), null);

  const valid = {
    schemaVersion: 1,
    workerKey,
    displayName: "Vultr Network Center",
    workerVersion,
    status: "PAUSED",
    heartbeatAt: "2026-08-01T07:00:00.000Z",
    startedAt: "2026-08-01T06:00:00.000Z",
    assignedBuildingCount: 1,
    activeAssignedBuildingCount: 1,
    activeAssignmentCount: 2,
    activeAssignmentHash: "b".repeat(64),
    expectedConnectionCount: 1,
    connectionCount: 1,
    successfulPollCount: 1,
    failedPollCount: 0,
    pollObservedAt: "2026-08-01T06:59:59.000Z",
  };
  assert.deepEqual(await getWorkerReleaseStatus({
    workerKey,
    workerVersion,
    rpc: async () => valid,
  }), valid, "a fully qualified RFC3339 control payload must remain valid");

  const malformedTimestamps = ["heartbeatAt", "startedAt", "pollObservedAt"]
    .flatMap((field) => [
      { ...valid, [field]: [valid[field]] },
      { ...valid, [field]: { value: valid[field] } },
      { ...valid, [field]: "2026-08-01" },
      { ...valid, [field]: `${"2".repeat(65)}Z` },
    ]);
  for (const malformed of [
    { ...valid, workerVersion: "c".repeat(40) },
    { ...valid, workerKey: [workerKey] },
    { ...valid, workerVersion: [workerVersion] },
    { ...valid, activeAssignedBuildingCount: -1 },
    { ...valid, activeAssignmentCount: -1 },
    { ...valid, activeAssignmentCount: 10_001 },
    { ...valid, activeAssignmentCount: 0 },
    { ...valid, activeAssignmentCount: undefined },
    { ...valid, activeAssignmentHash: ["b".repeat(64)] },
    // The deployment gate compares the reported poll evidence against this
    // number. Without it there is nothing to compare against, and a client that
    // defaulted it to 0 would read "nothing to poll" on a fleet that has
    // routers - so a missing or malformed value must sink the whole payload
    // rather than degrade.
    { ...valid, expectedConnectionCount: undefined },
    { ...valid, expectedConnectionCount: null },
    { ...valid, expectedConnectionCount: -1 },
    { ...valid, expectedConnectionCount: 10_001 },
    { ...valid, expectedConnectionCount: "1" },
    { ...valid, expectedConnectionCount: 1.5 },
    { ...valid, activeAssignmentHash: "B".repeat(64) },
    { ...valid, failedPollCount: 1 },
    { ...valid, secretDigest: "forbidden" },
    ...malformedTimestamps,
  ]) {
    await assert.rejects(
      getWorkerReleaseStatus({ workerKey, workerVersion, rpc: async () => malformed }),
      /invalid exact worker release status payload/i,
    );
  }
});

test("worker-release-status CLI requires an exact raw SHA and never broadens to generic status", async () => {
  assert.equal(ADMIN_COMMANDS.has("worker-release-status"), true);
  assert.deepEqual(
    parseAdminCommand("worker-release-status", [
      "--worker-key", "vultr-network-center-01",
      "--worker-version", "a".repeat(40),
    ]),
    { workerKey: "vultr-network-center-01", workerVersion: "a".repeat(40) },
  );
  for (const invalidVersion of [
    "A".repeat(40),
    "a".repeat(39),
    "a".repeat(41),
    "g".repeat(40),
    ` ${"a".repeat(40)}`,
    `${"a".repeat(40)}\n`,
  ]) {
    let rpcCalled = false;
    await assert.rejects(
      getWorkerReleaseStatus({
        workerKey: "vultr-network-center-01",
        workerVersion: invalidVersion,
        rpc: async () => { rpcCalled = true; },
      }),
      /invalid worker release status request/i,
    );
    assert.equal(rpcCalled, false);
  }
  for (const invalidIdentity of [
    { workerKey: ["vultr-network-center-01"], workerVersion: "a".repeat(40) },
    { workerKey: "vultr-network-center-01", workerVersion: ["a".repeat(40)] },
  ]) {
    let rpcCalled = false;
    await assert.rejects(
      getWorkerReleaseStatus({
        ...invalidIdentity,
        rpc: async () => { rpcCalled = true; },
      }),
      /invalid worker release status request/i,
    );
    assert.equal(rpcCalled, false, "non-scalar worker identity must fail before RPC");
  }
});

test("Vultr deployment accepts only the exact version-keyed paused heartbeat", () => {
  const admin = readFileSync(new URL("scripts/network-center-admin.mjs", root), "utf8");
  const deploy = readFileSync(
    new URL("infra/network-center-worker/scripts/deploy-vultr.ps1", root),
    "utf8",
  );
  const rollback = readFileSync(
    new URL("infra/network-center-worker/scripts/rollback-vultr.ps1", root),
    "utf8",
  );
  assert.match(admin, /network_center_admin_worker_release_status_v1/);
  for (const source of [deploy, rollback]) {
    assert.match(source, /"worker-release-status"/i);
    assert.match(source, /"--worker-key"\s*,\s*\$WorkerKey/i);
    assert.match(source, /"--worker-version"\s*,\s*\$(?:Expected)?ReleaseSha/i);
    assert.match(source, /\.schemaVersion/i);
    assert.match(source, /\.workerKey/i);
    assert.match(source, /\.workerVersion/i);
    assert.match(source, /\.status/i);
    assert.match(source, /\.heartbeatAt/i);
    assert.match(source, /\.pollObservedAt/i);
    assert.match(source, /\.connectionCount/i);
    assert.match(source, /\.successfulPollCount/i);
    assert.match(source, /\.failedPollCount/i);
    assert.match(source, /\.assignedBuildingCount/i);
    assert.match(source, /\.activeAssignedBuildingCount/i);
    assert.match(source, /\.activeAssignmentCount/i);
    assert.match(source, /\.activeAssignmentHash/i);
    assert.match(source, /\.expectedConnectionCount/i);
    assert.doesNotMatch(
      source,
      /connectionCount -ge 1/,
      "the green-field deadlock returns the moment a literal poll floor comes back",
    );
    assert.doesNotMatch(source, /releaseHeartbeats|\.assignments|"status"\s*,\s*"--limit"/i);
  }
});

test("ships a rollback-only PostgreSQL proof for release isolation and ACLs", () => {
  assert.equal(existsSync(runtimeProofPath), true, "release heartbeat runtime proof missing");
  if (!existsSync(runtimeProofPath)) return;
  const sql = readFileSync(runtimeProofPath, "utf8");
  assert.match(sql, /^BEGIN;/m);
  assert.match(sql, /ROLLBACK;\s*$/);
  assert.match(sql, /SET LOCAL ROLE service_role/i);
  assert.match(sql, /network_center_worker_heartbeat_v2/i);
  assert.match(sql, /network_center_admin_release_status_v1/i);
  assert.match(sql, /repeat\('1',\s*40\)/i);
  assert.match(sql, /repeat\('2',\s*40\)/i);
  assert.match(sql, /insufficient_privilege/i);
  assert.match(sql, /heartbeat_at[\s\S]*interval '31 days'/i);
  assert.match(sql, /network_center_admin_worker_release_status_v1/i);
  assert.match(sql, /invalid_parameter_value/i);
  for (const invalidVersionEvidence of [
    /upper\(repeat\('a',\s*40\)\)/i,
    /repeat\('a',\s*39\)/i,
    /repeat\('a',\s*41\)/i,
    /repeat\('g',\s*40\)/i,
    /repeat\('a',\s*40\)\s*\|\|\s*E?'\\n'/i,
    /' '\s*\|\|\s*repeat\('a',\s*40\)/i,
  ]) {
    assert.match(sql, invalidVersionEvidence);
  }
  assert.match(sql, /activeAssignmentCount/i);
  assert.match(sql, /network-worker-assignment-v1/i);
  assert.match(sql, /two active assignment rows for one building/i);
  assert.match(sql, /same-building device swap/i);
  assert.match(sql, /capability change/i);
  assert.match(sql, /assignment ID\/version\/window change/i);
  assert.match(sql, /network_center_worker_heartbeat_core_v2/i);
  assert.match(sql, /has_function_privilege/i);
  assert.match(sql, /'status',\s*'PASS'/i);
});

test("runtime proof creates isolated DEMO identities and scopes broad readback assertions", () => {
  const sql = readFileSync(runtimeProofPath, "utf8");
  assert.match(
    sql,
    /v_organization_id uuid := 'dddd0000-0000-4000-8000-000000000001'[\s\S]*INSERT INTO public\.buildings[\s\S]*v_organization_id/i,
    "proof must create its own rollback-only DEMO building identity",
  );
  assert.match(
    sql,
    /INSERT INTO public\.network_devices[\s\S]*v_device_id/i,
    "proof must create its own rollback-only MikroTik identity",
  );
  assert.doesNotMatch(
    sql,
    /FROM public\.network_devices device[\s\S]{0,300}device\.is_active[\s\S]{0,100}LIMIT 1/i,
    "proof must not assign itself to an existing active poller device",
  );
  assert.match(
    sql,
    /WHERE item->>'workerKey'\s*=\s*v_worker_key/i,
    "broad status evidence must be filtered back to the fixture worker",
  );
  assert.match(sql, /jsonb_array_length\(v_fixture_release_heartbeats\)\s*=\s*2/i);
  assert.doesNotMatch(
    sql,
    /jsonb_array_length\(v_release_status->'releaseHeartbeats'\)\s*=\s*2/i,
    "proof must tolerate pre-existing release rows from other workers",
  );
});

test("runtime proof covers rollback-target retention and null poll evidence", () => {
  const sql = readFileSync(runtimeProofPath, "utf8");
  assert.match(
    sql,
    /retention must not expire a release that is still a reachable rollback target/i,
  );
  assert.match(
    sql,
    /reachable_rollback_target_never_expired/,
    "the proof verdict must name the rollback-reachability invariant",
  );
  assert.match(sql, /bounded_30_day_cleanup/, "age-based collection must stay proven");
  assert.match(
    sql,
    /no longer a reachable rollback target/i,
    "the proof must still show expired displaced releases being collected",
  );
  assert.match(sql, /null_poll_evidence_fails_closed/);
  assert.match(
    sql,
    /'connections',\s*NULL,\s*'successfulPolls',\s*NULL,\s*'failedPolls',\s*NULL/i,
    "the proof must post JSON null poll counts",
  );
  assert.match(
    sql,
    /must not refresh poll freshness or poll counts/i,
    "a rejected null-poll heartbeat must be shown not to renew canary freshness",
  );
  assert.match(
    sql,
    /SET started_at[\s\S]{0,200}poll_observed_at\s*=\s*statement_timestamp\(\)\s*-\s*INTERVAL '31 days'/i,
    "ageing a row must keep poll_observed_at inside the all-or-nothing CHECK",
  );
});

test("disposable proof exercises both retention reachability and null poll evidence", () => {
  const source = readFileSync(disposableRunnerPath, "utf8");
  assert.match(source, /'invariants',\s*37/);
  // The runner now applies a second migration and prints a second verdict, so
  // the release-readback count is pinned by name. Its enforcement must stay
  // exact: a shrunk or missing release verdict has to fail the proof.
  assert.match(source, /RELEASE_READBACK_INVARIANTS\s*=\s*37/);
  assert.match(
    source,
    /verdicts\[0\]\?\.invariants !== RELEASE_READBACK_INVARIANTS/,
    "the release readback verdict must still be checked exactly",
  );
  assert.match(
    source,
    /verdicts\.length !== 2/,
    "a missing operational-safety verdict must fail the proof",
  );
  assert.match(
    source,
    /'connections',\s*NULL,\s*'successfulPolls',\s*NULL,\s*'failedPolls',\s*NULL/,
    "must post an all-null poll payload against a release with real poll evidence",
  );
  assert.match(source, /JSON null poll evidence was accepted on an existing release/);
  assert.match(source, /JSON null poll evidence was accepted on a fresh release/);
  assert.match(source, /a single JSON null poll count was accepted/);
  assert.match(source, /rejected null poll heartbeat refreshed poll freshness/);
  assert.match(source, /retention expired a still-reachable rollback target/);
  assert.match(
    source,
    /expired releases beyond the reachable depth were not collected/,
    "age-based collection must still be proven once a release is unreachable",
  );
  assert.match(source, /fresh release growth is not bounded by the per-worker cap/);
  assert.match(
    source,
    /age-based collection deleted another worker/,
    "the global age purge must be proven not to touch other workers",
  );
});

test("the heartbeat status guard is additive, downgrade-only and reaches the building status", () => {
  // The client half of this fix lives in a container image. rollback-vultr.ps1
  // restarts a PREVIOUS image, and every image built before it still sends the
  // hardcoded ONLINE, so the server half is the only one a rollback cannot
  // undo. These assertions pin the shape that makes it work.
  assert.equal(existsSync(statusHonestyMigrationPath), true, "status honesty migration missing");
  if (!existsSync(statusHonestyMigrationPath)) return;
  const sql = readFileSync(statusHonestyMigrationPath, "utf8");

  // Additive forward fix: same signature, no schema surgery on an applied
  // migration's objects.
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.network_center_worker_heartbeat_v2\(\s*p_credential_digest text,\s*p_worker_version text,\s*p_capabilities text\[\],\s*p_status text,\s*p_queue_age_seconds integer,\s*p_safe_metadata jsonb,\s*p_started_at timestamptz\s*\)/i,
  );
  assert.doesNotMatch(sql, /DROP FUNCTION|ALTER TABLE|CREATE TABLE|DROP TABLE/i);
  assert.match(sql, /SECURITY DEFINER/i);
  assert.match(sql, /SET search_path TO 'pg_catalog'/i);

  // The rule itself: downgrade only, fresh evidence first, stored evidence as
  // the fallback for a heartbeat that brought none.
  const guard = sql.match(
    /IF v_status = 'ONLINE'[\s\S]{0,300}?END IF;/i,
  )?.[0];
  assert.ok(guard, "the downgrade guard could not be located; this check has rotted");
  assert.match(guard, /coalesce\(\s*v_failed_poll_count,\s*v_retained_failed_poll_count,\s*0\s*\)\s*>\s*0/i);
  assert.match(guard, /v_status := 'DEGRADED';/);
  // Never upgrades: the only assignment inside the guard is to DEGRADED.
  assert.doesNotMatch(guard, /v_status := '(?:ONLINE|PAUSED|STOPPING)'/i);

  // The retained verdict is read for THIS release only, never fleet-wide.
  const retained = sql.match(
    /SELECT retained\.failed_poll_count[\s\S]{0,400}?;/i,
  )?.[0];
  assert.ok(retained, "the retained-evidence lookup could not be located; this check has rotted");
  assert.match(retained, /retained\.worker_id = v_worker_id/i);
  assert.match(retained, /retained\.worker_version = v_worker_version/i);

  // The core is what writes public.network_worker_building_status - the row the
  // UI and Realtime read. It must receive the EFFECTIVE status, or the release
  // readback would be honest while the operator's screen still said ONLINE.
  const coreCall = sql.match(
    /v_result := app_private\.network_center_worker_heartbeat_core_v2\([\s\S]{0,400}?\);/i,
  )?.[0];
  assert.ok(coreCall, "the core call could not be located; this check has rotted");
  assert.match(coreCall, /\n\s*v_status,\n/);
  assert.doesNotMatch(coreCall, /\n\s*p_status,\n/);

  // The core call has to come AFTER the guard, otherwise the building status is
  // written before the downgrade is known.
  assert.ok(
    sql.indexOf("v_status := 'DEGRADED';") < sql.indexOf("v_result := app_private.network_center_worker_heartbeat_core_v2("),
    "the downgrade must be computed before the building-status core runs",
  );

  // Poll evidence stays fail-closed exactly as 20260729136000 left it.
  assert.match(sql, /Incomplete worker poll evidence/);
  assert.match(sql, /Invalid worker poll evidence/);
  assert.match(sql, /v_poll_observed_at := v_now;/);
});

test("disposable release proof runner has no production path and supports dry-run", () => {
  assert.equal(existsSync(disposableRunnerPath), true, "disposable PostgreSQL runner missing");
  if (!existsSync(disposableRunnerPath)) return;
  const source = readFileSync(disposableRunnerPath, "utf8");
  assert.doesNotMatch(source, /Management API|CLAUDE\.local|SUPABASE_(?:PAT|ACCESS_TOKEN)/i);
  assert.match(source, /initdb/i);
  assert.match(source, /pg_ctl/i);
  assert.match(source, /mkdtemp/i);
  const result = spawnSync(process.execPath, [disposableRunnerPath.pathname.slice(1), "--dry-run"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no PostgreSQL process was started/i);
});

test("the deploy expectation is server-derived and mirrors what the worker is served", () => {
  // The green-field deadlock had two candidate fixes. The rejected one was an
  // operator switch that waives the poll evidence; the shipped one makes the
  // EXPECTATION server state, so the gate is right in every fleet state without
  // anyone choosing. That only holds if the count is computed from the same
  // predicate that decides which connections the worker is actually handed, and
  // if the deploying client cannot influence it.
  assert.equal(existsSync(expectedConnectionsMigrationPath), true, "expected-connection migration missing");
  const sql = readFileSync(expectedConnectionsMigrationPath, "utf8");

  // Additive: same signature, so grants and callers are untouched.
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION public\.network_center_admin_worker_release_status_v1\(\s*p_worker_key text,\s*p_worker_version text\s*\)/i,
  );
  assert.doesNotMatch(sql, /DROP FUNCTION|ALTER TABLE|CREATE TABLE/i);
  assert.match(sql, /'expectedConnectionCount',/);

  const lateral = sql.match(
    /SELECT count\(\*\)::integer AS expected_connection_count[\s\S]*?\) connection_evidence/i,
  )?.[0];
  assert.ok(lateral, "the expectation must be computed in its own lateral");

  // Only server-side facts. The two parameters this function accepts are the
  // worker key and the release SHA, and neither may reach the count.
  assert.doesNotMatch(lateral, /p_worker_key|p_worker_version/, "the count must not read a caller parameter");
  assert.match(lateral, /assignment\.worker_id = worker\.id/i);

  // Predicate parity with network_center_worker_list_connections_v2: anything
  // the worker is not served must not be expected of it, or a healthy cycle
  // looks short forever.
  for (const predicate of [
    /connection\.is_enabled/i,
    /device\.is_active/i,
    /assignment\.can_poll/i,
    /assignment\.active_from <= v_now/i,
    /assignment\.active_until IS NULL/i,
    /worker\.status IN \('ACTIVE', 'DRAINING'\)/i,
    /'POLL' = ANY\(worker\.capabilities\)/i,
    /coalesce\(settings\.monitoring_enabled, true\)/i,
    /device\.device_kind = 'MIKROTIK'/i,
    /connection\.transport = 'ROUTEROS_SSH'/i,
    /SELECT DISTINCT connection\.id/i,
  ]) {
    assert.match(lateral, predicate, `expectation predicate missing: ${predicate}`);
  }

  // The service-role-only ACL must be re-asserted by the migration that owns the
  // final body, not inherited by accident.
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.network_center_admin_worker_release_status_v1\(\s*text, text\s*\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/i,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.network_center_admin_worker_release_status_v1\(\s*text, text\s*\)[\s\S]*?TO service_role/i,
  );

  // The disposable PostgreSQL proof has to apply it, or it would keep
  // certifying the superseded 20260729136000 body.
  const runner = readFileSync(disposableRunnerPath, "utf8");
  assert.match(runner, /20260729143000_network_center_worker_release_expected_connections\.sql/);
  assert.match(runner, /EXPECTED_CONNECTIONS_MIGRATION_PATH,/);
  for (const message of [
    "expected pollable connection count is not the two enabled RouterOS SSH connections",
    "overlapping assignment rows multiplied the expectation",
    "enabling a provisioned connection did not raise the expectation",
    "transport is not part of the expectation predicate",
    "an inactive device stayed in the expectation",
    "a monitoring-disabled building stayed in the expectation",
    "a non-polling assignment stayed in the expectation",
    "a closed assignment window stayed in the expectation",
    "a worker without POLL did not read back a zero expectation",
    "a connectionless fleet did not read back a zero expectation",
  ]) {
    assert.ok(runner.includes(message), `disposable proof is missing the assertion: ${message}`);
  }
});
