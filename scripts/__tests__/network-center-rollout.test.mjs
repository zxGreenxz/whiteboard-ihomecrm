import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const requiredFiles = [
  "scripts/network-center-rollout-manifest.json",
  "scripts/validate-network-center-rollout.mjs",
  "scripts/apply-network-center-rollout.mjs",
  "scripts/audit-network-center-rollout.mjs",
  "scripts/network-center-admin.mjs",
];

const load = async (path) => import(new URL(path, root)).catch(() => null);
const loadCliSafely = async (path) => {
  const originalExit = process.exit;
  process.exit = (code) => { throw new Error(`CLI exited during import: ${code}`); };
  try {
    return await load(path);
  } finally {
    process.exit = originalExit;
  }
};
const applyModule = await load("scripts/apply-network-center-rollout.mjs");
const validateModule = await load("scripts/validate-network-center-rollout.mjs");
const auditModule = await load("scripts/audit-network-center-rollout.mjs");
const adminModule = await load("scripts/network-center-admin.mjs");
const edgeModule = await loadCliSafely("scripts/deploy-edge-fn.mjs");

test("ships the complete Network Center rollout toolchain", () => {
  for (const path of requiredFiles) {
    assert.equal(existsSync(new URL(path, root)), true, `missing ${path}`);
  }
});

test("manifest pins fifteen ordered migration and Edge source digests", () => {
  const path = new URL("scripts/network-center-rollout-manifest.json", root);
  assert.equal(existsSync(path), true, "manifest missing");
  if (!existsSync(path)) return;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  assert.match(manifest.reviewedGitSha, /^[a-f0-9]{40}$/);
  assert.equal(manifest.migrations.length, 15);
  assert.deepEqual(
    manifest.migrations.map((item) => item.path),
    [...manifest.migrations.map((item) => item.path)].sort(),
  );
  for (const item of manifest.migrations) assert.match(item.sha256, /^[a-f0-9]{64}$/);
  assert.match(manifest.edgeFunction.sha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.preflight.required.length > 0);
  assert.ok(manifest.postApply.required.length > manifest.preflight.required.length);
});

test("local validation stops dirty, divergent, hash-mismatched and wrong-project rollouts before fetch", async () => {
  assert.ok(validateModule, "validator module missing");
  if (!validateModule) return;
  const manifest = {
    projectRef: "expectedprojectref1234",
    reviewedGitSha: "a".repeat(40),
    migrations: [{ path: "one.sql", sha256: "b".repeat(64) }],
    edgeFunction: { path: "edge", sha256: "c".repeat(64) },
  };
  let fetched = false;
  const dependencies = {
    manifest,
    projectRef: manifest.projectRef,
    isClean: true,
    isReviewedAncestor: true,
    hashes: new Map([["one.sql", "b".repeat(64)], ["edge", "c".repeat(64)]]),
    fetchImpl: async () => { fetched = true; throw new Error("must not fetch"); },
  };
  for (const override of [
    { isClean: false },
    { isReviewedAncestor: false },
    { hashes: new Map([["one.sql", "0".repeat(64)], ["edge", "c".repeat(64)]]) },
    { projectRef: "wrongprojectref00000" },
  ]) {
    fetched = false;
    await assert.rejects(
      validateModule.validateLocalRollout({ ...dependencies, ...override }),
      /dirty|revision|digest|project/i,
    );
    assert.equal(fetched, false);
  }
});

test("ordered apply checks catalog first and emits one bounded receipt per migration", async () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  const calls = [];
  const receipts = [];
  const manifest = {
    projectRef: "expectedprojectref1234",
    migrations: [
      { path: "one.sql", sha256: "1".repeat(64) },
      { path: "two.sql", sha256: "2".repeat(64) },
    ],
    preflight: { required: ["public.buildings"] },
    postApply: { required: ["public.network_workers"] },
  };
  await applyModule.applyRollout({
    manifest,
    migrationBodies: new Map([["one.sql", "SELECT 1;"], ["two.sql", "SELECT 2;"]]),
    query: async (sql) => {
      calls.push(sql);
      if (calls.length === 1) return { objects: ["public.buildings"] };
      if (calls.length === 4) return { objects: ["public.network_workers"] };
      return { ok: true };
    },
    writeReceipt: async (receipt) => receipts.push(receipt),
    now: () => new Date("2026-07-31T00:00:00.000Z"),
  });
  assert.match(calls[0], /READ ONLY/i);
  assert.match(calls[1], /ihomecrm:network-center-rollout:v1/);
  assert.match(calls[1], /SELECT 1/);
  assert.match(calls[1], /AS objects/i);
  assert.match(calls[2], /SELECT 2/);
  assert.match(calls[2], /AS objects/i);
  assert.equal(receipts.length, 2);
  assert.deepEqual(receipts.map((item) => item.migration), ["one.sql", "two.sql"]);
  assert.ok(receipts.every((item) => JSON.stringify(item).length < 4096));
});

test("every migration rechecks the exact catalog prefix while holding the advisory lock", async () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  const migrationSql = applyModule.buildMigrationTransaction({
    migration: {
      path: "one.sql",
      postApply: { required: ["table:public.network_devices"] },
    },
    body: "SELECT 1;",
    priorRequired: ["table:public.buildings"],
    futureForbidden: ["table:public.network_devices"],
  });
  const lockOffset = migrationSql.indexOf("pg_try_advisory_xact_lock");
  const prefixOffset = migrationSql.indexOf("Network Center expected prefix mismatch");
  const stageOffset = migrationSql.indexOf("-- Network Center rollout stage");
  const prefixGuard = migrationSql.slice(lockOffset, stageOffset);
  assert.ok(lockOffset >= 0 && prefixOffset > lockOffset, "prefix assertion must run after the lock");
  assert.match(
    prefixGuard,
    /NOT\s*\(to_regclass\('public\.network_devices'\) IS NOT NULL\)/i,
    "the in-lock precondition must reject objects from a later stage",
  );
});

test("partial apply returns an exact forward-fix instruction and redacts PAT failures", async () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  const pat = "sbp_test_super_secret_123456";
  const manifest = {
    migrations: [
      { path: "one.sql", sha256: "1".repeat(64) },
      { path: "two.sql", sha256: "2".repeat(64) },
    ],
    preflight: { required: [] },
    postApply: { required: [] },
  };
  let index = 0;
  const error = await applyModule.applyRollout({
    manifest,
    migrationBodies: new Map([["one.sql", "SELECT 1;"], ["two.sql", "SELECT 2;"]]),
    query: async () => {
      index += 1;
      if (index === 3) throw new Error(`request ${pat} failed`);
      return { objects: [] };
    },
    writeReceipt: async () => {},
    secrets: [pat],
  }).catch((caught) => caught);
  assert.match(error.message, /forward-fix.*two\.sql/i);
  assert.doesNotMatch(error.message, new RegExp(pat));
  assert.match(error.message, /\[REDACTED\]/);
});

test("a remote catalog prefix requires an exact explicit resume", () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  const manifest = {
    migrations: [
      { path: "one.sql", sha256: "1".repeat(64) },
      { path: "two.sql", sha256: "2".repeat(64) },
    ],
  };
  let error;
  try {
    applyModule.resolveResumeIndex(manifest, { state: "prefix", prefix: 1 }, {});
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(error.message, /--resume-from two\.sql/i);
  const digest = error.message.match(/--expected-prefix ([a-f0-9]{64})/)?.[1];
  assert.ok(digest);
  assert.equal(
    applyModule.resolveResumeIndex(
      manifest,
      { state: "prefix", prefix: 1 },
      { resumeFrom: "two.sql", expectedPrefix: digest },
    ),
    1,
  );
  assert.throws(
    () => applyModule.resolveResumeIndex(manifest, { state: "divergent", prefix: 1 }, {}),
    /divergent.*additive/i,
  );
});

test("catalog descriptors verify ACL, RLS, columns, indexes, realtime and inert rollout data", () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  const sql = applyModule.buildCatalogReadSql([
    "function_service_only:public.network_center_admin_status_v1(uuid,integer)",
    "rls:public.network_workers",
    "column:public.network_site_settings:rollout_state",
    "index:public:network_device_connections_one_enabled_per_device_idx",
    "realtime:public:network_device_current",
    "rows_rollout_off:public.network_site_settings",
  ]);
  assert.match(sql, /aclexplode/i);
  assert.match(
    sql,
    /grantee\.rolname\s+NOT IN\s*\('postgres',\s*'service_role'\)/i,
    "service-only descriptors must reject every explicit EXECUTE grantee except owner and service_role",
  );
  assert.match(sql, /relrowsecurity/i);
  assert.match(sql, /pg_attribute/i);
  assert.match(sql, /relkind[\s\S]*i/i);
  assert.match(sql, /pg_publication_tables/i);
  assert.match(sql, /rollout_state[\s\S]*OFF/i);
});

test("explicit resume reconciles one bounded receipt for every existing prefix stage", async () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  const receipts = [];
  const manifest = {
    projectRef: "expectedprojectref1234",
    reviewedGitSha: "a".repeat(40),
    preflight: { required: [] },
    postApply: { required: [] },
    migrations: [
      { path: "one.sql", sha256: "1".repeat(64), postApply: { required: ["public.one"] } },
      { path: "two.sql", sha256: "2".repeat(64), postApply: { required: ["public.two"] } },
    ],
  };
  await applyModule.applyRollout({
    manifest,
    migrationBodies: new Map([["two.sql", "SELECT 2;"]]),
    query: async () => ({ objects: [] }),
    writeReceipt: async (receipt) => receipts.push(receipt),
    startIndex: 1,
    reconcileExisting: true,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
  });
  assert.deepEqual(receipts.map((receipt) => receipt.outcome), ["reconciled-existing", "committed"]);
  assert.deepEqual(receipts.map((receipt) => receipt.migration), ["one.sql", "two.sql"]);
});

test("explicit resume accepts an identical immutable receipt from a prior partial apply", async () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  const directory = await mkdtemp(join(tmpdir(), "network-center-resume-"));
  const manifestDigest = "a".repeat(64);
  const projectRef = "expectedprojectref1234";
  const releaseSha = "b".repeat(40);
  const firstMigrationDigest = "1".repeat(64);
  try {
    await applyModule.writeReceiptAtomic({
      schemaVersion: 1,
      manifestDigest,
      projectRef,
      reviewedGitSha: "c".repeat(40),
      releaseSha,
      ordinal: 1,
      migration: "one.sql",
      migrationSha256: firstMigrationDigest,
      outcome: "committed",
      startedAt: "2026-07-31T00:00:00.000Z",
      observedAt: "2026-07-31T00:00:01.000Z",
      beforeCatalogFingerprint: "d".repeat(64),
      afterCatalogFingerprint: "e".repeat(64),
    }, { receiptRoot: directory });
    const manifest = {
      projectRef,
      reviewedGitSha: "c".repeat(40),
      preflight: { required: [] },
      postApply: { required: [] },
      migrations: [
        { path: "one.sql", sha256: firstMigrationDigest, postApply: { required: [] } },
        { path: "two.sql", sha256: "2".repeat(64), postApply: { required: [] } },
      ],
    };
    await applyModule.applyRollout({
      manifest,
      manifestDigest,
      releaseSha,
      migrationBodies: new Map([["two.sql", "SELECT 2;"]]),
      query: async () => ({ objects: [] }),
      writeReceipt: (receipt, options) => applyModule.writeReceiptAtomic(
        receipt,
        { receiptRoot: directory, ...options },
      ),
      startIndex: 1,
      reconcileExisting: true,
      now: () => new Date("2026-07-31T00:00:02.000Z"),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live apply is disabled in GitHub Actions and receipts are bounded and exclusive", async () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  assert.throws(
    () => applyModule.assertLiveApplyAllowed({ GITHUB_ACTIONS: "true" }, false),
    /GitHub Actions|CI/i,
  );
  const directory = await mkdtemp(join(tmpdir(), "network-center-receipt-"));
  try {
    const receipt = {
      schemaVersion: 1,
      manifestDigest: "a".repeat(64),
      projectRef: "expectedprojectref1234",
      reviewedGitSha: "b".repeat(40),
      releaseSha: "c".repeat(40),
      ordinal: 1,
      migration: "one.sql",
      migrationSha256: "d".repeat(64),
      outcome: "committed",
      startedAt: "2026-07-31T00:00:00.000Z",
      observedAt: "2026-07-31T00:00:00.000Z",
      beforeCatalogFingerprint: "e".repeat(64),
      afterCatalogFingerprint: "f".repeat(64),
    };
    const target = await applyModule.writeReceiptAtomic(receipt, { receiptRoot: directory });
    const contents = await readFile(target, "utf8");
    assert.ok(contents.length < 4096);
    await assert.rejects(
      applyModule.writeReceiptAtomic(receipt, { receiptRoot: directory }),
      /exists|receipt/i,
    );
    if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audit is read-only and Edge deploy pins digest plus worker-only no-verify-jwt", () => {
  assert.ok(auditModule, "audit module missing");
  assert.ok(edgeModule, "edge deploy module missing");
  if (!auditModule || !edgeModule) return;
  assert.match(auditModule.NETWORK_CENTER_AUDIT_SQL, /BEGIN READ ONLY/i);
  assert.doesNotMatch(auditModule.NETWORK_CENTER_AUDIT_SQL, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i);
  const worker = edgeModule.buildDeploymentMetadata("network-center-worker", "a".repeat(64), []);
  assert.equal(worker.verify_jwt, false);
  assert.equal(worker.source_digest, "a".repeat(64));
  assert.throws(
    () => edgeModule.buildDeploymentMetadata("other-function", "a".repeat(64), ["--no-verify-jwt"]),
    /only.*network-center-worker/i,
  );
});

test("Edge deployment rejects a missing full release revision before any network call", async () => {
  assert.ok(edgeModule, "edge deploy module missing");
  if (!edgeModule) return;
  const manifest = JSON.parse(
    readFileSync(new URL("scripts/network-center-rollout-manifest.json", root), "utf8"),
  );
  let fetched = false;
  await assert.rejects(
    edgeModule.deployEdgeFunction({
      slug: "network-center-worker",
      args: ["--no-verify-jwt"],
      revision: undefined,
      manifest,
      config: { projectRef: manifest.projectRef, pat: "sbp_test_not_logged" },
      fetchImpl: async () => {
        fetched = true;
        throw new Error("network call reached");
      },
      writeReceipt: async () => {},
    }),
    /full release revision/i,
  );
  assert.equal(fetched, false);
});

test("admin credentials are CSPRNG, atomically persisted, never returned, and RPC receives digest only", async () => {
  assert.ok(adminModule, "admin module missing");
  if (!adminModule) return;
  const directory = await mkdtemp(join(tmpdir(), "network-center-admin-"));
  const target = join(directory, "worker.secret");
  try {
    const rpcCalls = [];
    const result = await adminModule.provisionWorker({
      workerKey: "worker-demo-01",
      displayName: "Demo worker",
      outputPath: target,
      expiresAt: "2026-08-30T00:00:00.000Z",
      assignments: [{
        organizationId: "dddd0000-0000-4000-8000-000000000001",
        buildingId: "11111111-1111-4111-8111-111111111111",
        deviceId: "22222222-2222-4222-8222-222222222222",
        enabled: true,
        canPoll: true,
        canInventory: true,
        canExecute: false,
      }],
      rpc: async (name, args) => { rpcCalls.push({ name, args }); return { workerKey: args.p_worker_key }; },
    });
    const secret = (await readFile(target, "utf8")).trim();
    assert.ok(secret.length >= 43);
    assert.equal("secret" in result, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(JSON.stringify(rpcCalls).includes(secret), false);
    assert.match(rpcCalls[0].args.p_secret_digest, /^[a-f0-9]{64}$/);
    assert.match(rpcCalls[0].args.p_fingerprint, /^sha256:[a-f0-9]{12,64}$/);
    assert.equal(rpcCalls[0].args.p_assignments.length, 1);
    if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("admin exports every required fail-closed command", () => {
  assert.ok(adminModule, "admin module missing");
  if (!adminModule) return;
  assert.deepEqual(
    [...adminModule.ADMIN_COMMANDS].sort(),
    [
      "assign",
      "finalize-worker-cutover",
      "provision-connection",
      "provision-worker",
      "revoke-worker",
      "rotate-worker",
      "set-rollout",
      "status",
      "unassign",
      "worker-release-status",
    ],
  );
  assert.throws(
    () => adminModule.parseAdminCommand("provision-connection", ["--credential-secret", "nope"]),
    /unknown.*flag|unsupported/i,
  );
});

// 2026-08-02 incident. Production had every catalog descriptor, so the audit
// classified the rollout `complete`, resolveResumeIndex returned
// manifest.migrations.length, and applyRollout executed nothing while main()
// printed "Applied 15 Network Center migration(s)". The migration that was
// skipped only redefined a function body -- the commonest forward-fix shape --
// and the broken body stayed live behind a green post-apply audit.
test("a catalog-complete database with a stale function body is not complete", () => {
  assert.ok(auditModule, "audit module missing");
  if (!auditModule) return;
  const manifest = {
    preflight: { required: ["table:public.buildings"] },
    migrations: [
      { path: "one.sql", postApply: { required: ["table:public.a"] } },
      // The forward-fix shape: no new catalog object at all.
      { path: "two.sql", postApply: { required: ["table:public.a"] } },
    ],
  };
  const evidence = {
    expectations: new Map([
      ["one.sql", []],
      ["two.sql", [{ qualifiedName: "public.f", bodyDigest: "a".repeat(64) }]],
    ]),
    live: new Map([["public.f", new Set(["b".repeat(64)])]]),
  };
  const stale = auditModule.classifyCatalog(
    manifest,
    ["table:public.buildings", "table:public.a"],
    evidence,
  );
  assert.equal(stale.state, "prefix");
  assert.equal(stale.prefix, 1);
  assert.deepEqual(stale.bodyMismatches.map((item) => item.qualifiedName), ["public.f"]);
  assert.equal(stale.bodyMismatches[0].migration, "two.sql");

  const healthy = auditModule.classifyCatalog(
    manifest,
    ["table:public.buildings", "table:public.a"],
    { ...evidence, live: new Map([["public.f", new Set(["a".repeat(64)])]]) },
  );
  assert.equal(healthy.state, "complete");
  assert.deepEqual(healthy.bodyMismatches, []);
});

test("post-apply audit names the function whose live body left the reviewed release", async () => {
  assert.ok(auditModule, "audit module missing");
  if (!auditModule) return;
  const manifest = {
    preflight: { required: [] },
    postApply: { required: ["table:public.a"] },
    migrations: [
      { path: "one.sql", postApply: { required: ["table:public.a"] } },
      { path: "two.sql", postApply: { required: ["table:public.a"] } },
    ],
  };
  const sources = new Map([
    ["one.sql", "SELECT 1;"],
    ["two.sql", "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $fn$ BEGIN RETURN 1; END; $fn$;"],
  ]);
  const query = async (sql) =>
    /prosrc/i.test(sql)
      ? [{ result: [{ qualified_name: "public.f", identity_arguments: "", body_digest: "0".repeat(64) }] }]
      : [{ result: [{ name: "table:public.a", present: true }] }];
  await assert.rejects(
    auditModule.auditRollout({ manifest, sources, mode: "post-apply", query }),
    /public\.f/,
  );
});

test("apply reports only the stages whose SQL actually executed", async () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  const manifest = {
    projectRef: "expectedprojectref1234",
    preflight: { required: [] },
    postApply: { required: [] },
    migrations: [
      { path: "one.sql", sha256: "1".repeat(64), postApply: { required: [] } },
      { path: "two.sql", sha256: "2".repeat(64), postApply: { required: [] } },
    ],
  };
  const noop = await applyModule.applyRollout({
    manifest,
    migrationBodies: new Map(),
    query: async () => ({ objects: [] }),
    writeReceipt: async () => assert.fail("a no-op rollout must not mint receipts"),
    reserveReceipt: async () => {},
    startIndex: 2,
  });
  assert.equal(noop.committed.length, 0);
  assert.equal(noop.applied.length, 0);
  const noopSummary = applyModule.formatApplySummary(noop);
  assert.match(noopSummary, /Applied 0 of 2/);
  assert.doesNotMatch(noopSummary, /Applied 2\b/);
  // The 2026-08-02 shape: start index 15 of 15. Nothing ran, so nothing may be
  // reconciled either.
  assert.equal(applyModule.shouldReconcileExisting(15, 15), false);
  assert.equal(applyModule.shouldReconcileExisting(14, 15), true);
  assert.equal(applyModule.shouldReconcileExisting(0, 15), false);

  const resumed = await applyModule.applyRollout({
    manifest,
    migrationBodies: new Map([["two.sql", "SELECT 2;"]]),
    query: async () => ({ objects: [] }),
    writeReceipt: async () => {},
    reserveReceipt: async () => {},
    startIndex: 1,
    reconcileExisting: true,
    now: () => new Date("2026-08-02T00:00:00.000Z"),
  });
  assert.equal(resumed.committed.length, 1);
  assert.equal(resumed.reconciled.length, 1);
  const resumedSummary = applyModule.formatApplySummary(resumed);
  assert.match(resumedSummary, /Applied 1 of 2/);
  assert.match(resumedSummary, /reconciled 1/i);
});

test("a rollout that cannot be proved complete refuses to claim it is", () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  const manifest = {
    migrations: [
      { path: "one.sql", sha256: "1".repeat(64) },
      { path: "two.sql", sha256: "2".repeat(64) },
    ],
  };
  // A proved-complete rollout applies nothing and must not accept resume flags
  // that would silently re-run a stage nobody asked for.
  assert.equal(applyModule.resolveResumeIndex(manifest, { state: "complete", prefix: 2 }, {}), 2);
  assert.throws(
    () => applyModule.resolveResumeIndex(
      manifest,
      { state: "complete", prefix: 2 },
      { resumeFrom: "two.sql", expectedPrefix: "a".repeat(64) },
    ),
    /nothing to resume|already/i,
  );
  // Body drift lands in the prefix branch, which still demands both flags.
  let error;
  try {
    applyModule.resolveResumeIndex(
      manifest,
      { state: "prefix", prefix: 1, bodyMismatches: [{ migration: "two.sql", qualifiedName: "public.f" }] },
      {},
    );
  } catch (caught) {
    error = caught;
  }
  assert.ok(error);
  assert.match(error.message, /--resume-from two\.sql/);
  assert.match(error.message, /--expected-prefix [a-f0-9]{64}/);
});

test("a stage refuses to run when a receipt already claims it, before touching the database", async () => {
  assert.ok(applyModule, "apply module missing");
  if (!applyModule) return;
  let stageQueries = 0;
  const error = await applyModule.applyRollout({
    manifest: {
      projectRef: "expectedprojectref1234",
      preflight: { required: [] },
      postApply: { required: [] },
      migrations: [{ path: "one.sql", sha256: "1".repeat(64), postApply: { required: [] } }],
    },
    migrationBodies: new Map([["one.sql", "SELECT 1;"]]),
    query: async (sql) => {
      if (!/READ ONLY/i.test(sql)) stageQueries += 1;
      return { objects: [] };
    },
    writeReceipt: async () => assert.fail("must not write a receipt it refused to reserve"),
    reserveReceipt: async () => {
      throw new Error("Rollout receipt already exists and records work that was not performed");
    },
  }).catch((caught) => caught);
  assert.match(error.message, /receipt already exists/i);
  assert.equal(stageQueries, 0);

  const directory = await mkdtemp(join(tmpdir(), "network-center-reserve-"));
  try {
    const identity = {
      projectRef: "expectedprojectref1234",
      manifestDigest: "a".repeat(64),
      ordinal: 1,
      migrationSha256: "d".repeat(64),
    };
    await applyModule.assertReceiptAbsent(identity, { receiptRoot: directory });
    await applyModule.writeReceiptAtomic(
      {
        schemaVersion: 1,
        ...identity,
        reviewedGitSha: "b".repeat(40),
        releaseSha: "c".repeat(40),
        migration: "one.sql",
        outcome: "reconciled-existing",
        startedAt: "2026-08-02T00:00:00.000Z",
        observedAt: "2026-08-02T00:00:00.000Z",
        beforeCatalogFingerprint: "e".repeat(64),
        afterCatalogFingerprint: "f".repeat(64),
      },
      { receiptRoot: directory },
    );
    await assert.rejects(
      applyModule.assertReceiptAbsent(identity, { receiptRoot: directory }),
      /receipt already exists/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("admin rejects implicit assignments and connection secrets before RPC", async () => {
  assert.ok(adminModule, "admin module missing");
  if (!adminModule) return;
  let calls = 0;
  const rpc = async () => { calls += 1; return {}; };
  await assert.rejects(
    adminModule.setAssignments({ workerKey: "worker-demo-01", assignments: [], rpc }),
    /explicit.*enabled/i,
  );
  await assert.rejects(
    adminModule.provisionConnection({
      deviceId: "22222222-2222-4222-8222-222222222222",
      transport: "ROUTEROS_SSH",
      managementIp: "198.18.0.10",
      managementPort: 22,
      credentialRef: "plaintext-password",
      credentialSecret: "must-not-enter-db",
      hostKeyFingerprint: null,
      rpc,
    }),
    /credential_ref.*host-key|secret/i,
  );
  assert.equal(calls, 0);
});
