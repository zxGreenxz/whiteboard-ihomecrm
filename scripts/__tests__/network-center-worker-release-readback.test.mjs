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
