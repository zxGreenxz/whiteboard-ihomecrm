import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const verifier = await import("../verify-network-center-worker-scope.mjs").catch(
  () => ({}),
);
const root = new URL("../../", import.meta.url);
const hardeningMigration = await readFile(new URL(
  "supabase/migrations/20260729133000_network_center_hardening_rpcs.sql",
  root,
), "utf8");
const edgeWorker = await readFile(new URL(
  "supabase/functions/network-center-worker/index.ts",
  root,
), "utf8");

const EXPECTED_RPC_MANIFEST = Object.freeze([
  ["heartbeat", "network_center_worker_heartbeat_v2", "network_center_worker_heartbeat_v2(text,text,text[],text,integer,jsonb,timestamp with time zone)"],
  ["connections", "network_center_worker_list_connections_v2", "network_center_worker_list_connections_v2(text,integer)"],
  ["claim", "network_center_worker_claim_v2", "network_center_worker_claim_v2(text,integer,integer)"],
  ["renew", "network_center_worker_renew_v2", "network_center_worker_renew_v2(text,uuid,uuid,bigint,integer)"],
  ["ingest", "network_center_worker_ingest_v2", "network_center_worker_ingest_v2(text,jsonb)"],
  ["inventory", "network_center_worker_inventory_v2", "network_center_worker_inventory_v2(text,jsonb)"],
  ["stage", "network_center_worker_command_event_v2", "network_center_worker_command_event_v2(text,uuid,uuid,bigint,text,jsonb)"],
  ["observe", "network_center_worker_observe_v2", "network_center_worker_observe_v2(text,uuid,uuid,bigint,bigint,uuid,text,timestamp with time zone,jsonb)"],
  ["complete", "network_center_worker_complete_v2", "network_center_worker_complete_v2(text,uuid,uuid,bigint,bigint,text,jsonb,jsonb,integer)"],
  ["incidents", "network_center_worker_upsert_incident_v2", "network_center_worker_upsert_incident_v2(text,jsonb)"],
  ["snapshots", "network_center_worker_snapshot_v2", "network_center_worker_snapshot_v2(text,jsonb)"],
  ["maintenance", "network_center_worker_maintenance_v2", "network_center_worker_maintenance_v2(text,timestamp with time zone)"],
]);

function requireExport(name) {
  assert.equal(
    typeof verifier[name],
    "function",
    `expected ${name} to be exported`,
  );
  return verifier[name];
}

function validVerdict(overrides = {}) {
  assert.ok(Array.isArray(verifier.WORKER_SCOPE_CASE_IDS));
  const assertions = verifier.WORKER_SCOPE_CASE_IDS.map((caseId) => ({
    case_id: caseId,
    passed: true,
    detail: null,
  }));
  return {
    status: "PASS",
    passed: true,
    assertion_count: assertions.length,
    failed_count: 0,
    assertions,
    ...overrides,
  };
}

test("worker-heartbeat-runtime", () => {
  const buildSql = requireExport("buildNetworkCenterWorkerScopeSql");
  const sql = buildSql();

  assert.match(sql, /^BEGIN;\s*$/m);
  assert.match(sql, /network_center_worker_inventory_v2\s*\(/);
  assert.match(sql, /network_center_worker_heartbeat_v2\s*\(/);
  assert.match(sql, /Worker is not assigned|SQLSTATE '42501'/);
  assert.match(sql, /network_worker_heartbeats/);
  assert.match(sql, /SET LOCAL ROLE (?:anon|authenticated|service_role)/);
  for (const [route, rpcName, signature] of EXPECTED_RPC_MANIFEST) {
    assert.match(sql, new RegExp(`${rpcName}\\s*\\(`), route);
    assert.match(sql, new RegExp(`rpc\\.${route}\\.runtime`), route);
    assert.match(sql, new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), route);
  }
});

test("worker-heartbeat-control", () => {
  const buildSql = requireExport("buildNetworkCenterWorkerScopeSql");
  const sql = buildSql();

  assert.match(sql, /dddd0000-0000-4000-8000-000000000001/);
  assert.doesNotMatch(sql, /aaaa0000-0000-4000-8000-000000000001/);
  assert.match(sql, /network_worker_building_status/);
  assert.match(sql, /pg_publication_tables/);
  assert.match(sql, /supabase_realtime/);
  assert.match(sql, /assigned worker/i);
  assert.match(sql, /browser projection/i);
  for (const [route] of EXPECTED_RPC_MANIFEST) {
    assert.match(sql, new RegExp(`rpc\\.${route}\\.control`), route);
  }
});

test("exports the exact public worker v2 route and signature manifest", () => {
  assert.deepEqual(
    verifier.PUBLIC_WORKER_V2_RPC_MANIFEST?.map((entry) => [
      entry.route,
      entry.rpcName,
      entry.signature,
    ]),
    EXPECTED_RPC_MANIFEST,
  );

  const migrationRpcNames = [...hardeningMigration.matchAll(
    /CREATE OR REPLACE FUNCTION public\.(network_center_worker_[a-z_]+_v2)\s*\(/g,
  )].map((match) => match[1]);
  // A regex that matches zero times because the source shape changed (not
  // because the RPC list shrank to zero) would make the deepEqual below pass
  // vacuously only if EXPECTED_RPC_MANIFEST were also empty -- it never is,
  // so today this assert.ok is redundant with the deepEqual. It stays as an
  // explicit trip-wire: it names the failure mode (parser rot, not migration
  // regression) instead of leaving the next person to puzzle out a diff
  // between an empty array and a 12-entry manifest.
  assert.ok(
    migrationRpcNames.length > 0,
    "extracted zero RPC names from the hardening migration; the " +
      "`CREATE OR REPLACE FUNCTION public.<name>(` parse no longer matches " +
      "the migration's source shape and needs updating",
  );
  assert.deepEqual(
    [...new Set(migrationRpcNames)].sort(),
    EXPECTED_RPC_MANIFEST.map(([, rpcName]) => rpcName).sort(),
  );

  const edgeRoutes = [...edgeWorker.matchAll(
    /^\s{2}\[\s*"([a-z]+)"\s*,\s*\{[\s\S]*?rpcName:\s*"(network_center_worker_[a-z_]+_v2)"/gm,
  )].map((match) => [match[1], match[2]]);
  // Same trip-wire as above: ROUTES is a `new Map([["route", { ... }], ...])`
  // tuple list (converted from a frozen object literal to close a
  // prototype-chain route-lookup hole), so a zero-length extraction here
  // means the ROUTES declaration shape moved again, not that every route
  // was deleted.
  assert.ok(
    edgeRoutes.length > 0,
    "extracted zero routes from supabase/functions/network-center-worker/" +
      "index.ts; the ROUTES map tuple parse " +
      '(`["route", { ... rpcName: "..." }]`) no longer matches the Edge ' +
      "source shape and needs updating",
  );
  assert.deepEqual(
    edgeRoutes,
    EXPECTED_RPC_MANIFEST.map(([route, rpcName]) => [route, rpcName]),
  );
});

test("requires distinct runtime and control verdicts for every public worker v2 RPC", () => {
  assert.ok(Array.isArray(verifier.WORKER_SCOPE_CASE_IDS));
  const expectedCases = EXPECTED_RPC_MANIFEST.flatMap(([route]) => [
    `rpc.${route}.runtime`,
    `rpc.${route}.control`,
  ]);
  for (const caseId of expectedCases) {
    assert.ok(verifier.WORKER_SCOPE_CASE_IDS.includes(caseId), caseId);
  }
  assert.equal(new Set(expectedCases).size, EXPECTED_RPC_MANIFEST.length * 2);
});

test("builder is rollback-only and keeps all fixture writes in DEMO", () => {
  const buildSql = requireExport("buildNetworkCenterWorkerScopeSql");
  const sql = buildSql();

  assert.equal((sql.match(/\bBEGIN\s*;/gi) ?? []).length, 1);
  assert.equal((sql.match(/\bROLLBACK\s*;/gi) ?? []).length, 1);
  assert.doesNotMatch(sql, /\bCOMMIT\s*;/i);
  assert.match(sql, /ROLLBACK;\s*$/);
  assert.doesNotMatch(sql, /(?:db\s+push|management\s+api|api\.supabase\.com)/i);
});

test("parser accepts the exact bounded worker-scope verdict", () => {
  const parseVerdict = requireExport("parseNetworkCenterWorkerScopeVerdict");
  const expected = validVerdict();
  const parsed = parseVerdict(JSON.stringify([{ verdict: expected }]));

  assert.deepEqual(parsed, expected);
});

test("parser rejects invalid, missing, duplicated, and inconsistent verdicts", () => {
  const parseVerdict = requireExport("parseNetworkCenterWorkerScopeVerdict");
  const expected = validVerdict();

  assert.throws(() => parseVerdict("not-json"), /invalid JSON/i);
  assert.throws(() => parseVerdict(JSON.stringify([])), /valid worker-scope verdict/i);
  assert.throws(
    () => parseVerdict(JSON.stringify([{ verdict: expected }, { verdict: expected }])),
    /exactly one worker-scope verdict/i,
  );
  assert.throws(
    () => parseVerdict(JSON.stringify([{
      verdict: { ...expected, failed_count: 1 },
    }])),
    /counts are inconsistent/i,
  );
  assert.throws(
    () => parseVerdict(JSON.stringify([{
      verdict: {
        ...expected,
        assertions: expected.assertions.toReversed(),
      },
    }])),
    /case manifest is inconsistent/i,
  );
});

test("parser rejects oversized runner output", () => {
  const parseVerdict = requireExport("parseNetworkCenterWorkerScopeVerdict");
  assert.throws(
    () => parseVerdict(`[{"padding":"${"x".repeat(70_000)}"}]`),
    /output exceeds/i,
  );
});

test("dry-run emits one bounded PASS record without starting Docker", async () => {
  const main = requireExport("main");
  const output = [];
  let runnerCalled = false;
  const result = await main(["--dry-run"], {
    log: (line) => output.push(line),
    runLocalDisposable: async () => {
      runnerCalled = true;
      throw new Error("runner must not be called");
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(runnerCalled, false);
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).status, "PASS");
  assert.ok(Buffer.byteLength(output[0], "utf8") <= 8_192);
});

test("local mode injects the disposable runner and emits PASS", async () => {
  const main = requireExport("main");
  const output = [];
  let observedSql = "";
  const result = await main(["--local-disposable"], {
    log: (line) => output.push(line),
    runDisposableSupabaseMatrix: async ({ buildSql, parseVerdict }) => {
      observedSql = buildSql();
      return parseVerdict(JSON.stringify([{ verdict: validVerdict() }]));
    },
  });

  assert.equal(result.exitCode, 0);
  assert.match(observedSql, /ROLLBACK;\s*$/);
  assert.equal(output.length, 1);
  const evidence = JSON.parse(output[0]);
  assert.equal(evidence.status, "PASS");
  assert.equal(evidence.mode, "local-disposable");
});

test("missing, conflicting, duplicate, and unknown modes fail closed", async () => {
  const main = requireExport("main");
  const cases = [
    [],
    ["--dry-run", "--local-disposable"],
    ["--dry-run", "--dry-run"],
    ["--production"],
  ];

  for (const argv of cases) {
    const output = [];
    const result = await main(argv, {
      log: (line) => output.push(line),
      runLocalDisposable: async () => {
        throw new Error("runner must not be called for invalid arguments");
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(output.length, 1);
    assert.equal(JSON.parse(output[0]).status, "FAIL");
  }
});

test("Docker absence and runner failures are bounded JSON FAIL records", async () => {
  const main = requireExport("main");
  const output = [];
  const result = await main(["--local-disposable"], {
    log: (line) => output.push(line),
    runLocalDisposable: async () => {
      throw new Error(
        `Docker is required for --local-disposable; ${"secret-token=".repeat(2_000)}`,
      );
    },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(output.length, 1);
  assert.ok(Buffer.byteLength(output[0], "utf8") <= 8_192);
  assert.doesNotMatch(output[0], /secret-token=/i);
  const evidence = JSON.parse(output[0]);
  assert.equal(evidence.status, "FAIL");
  assert.match(evidence.failures[0].message, /Docker is required/);
});
