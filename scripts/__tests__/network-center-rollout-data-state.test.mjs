// Data-state descriptors versus catalog descriptors.
//
// WHY THIS SUITE EXISTS
//
// On 2026-08-03 `node scripts/apply-network-center-rollout.mjs` refused stage 23
// with "Network Center catalog is divergent; automatic rollout is blocked" and
// no resume instruction, and `--preflight` blamed three function bodies. Neither
// was the cause. Production was measured, read-only, and held 438 of the
// manifest's 445 descriptors. Six of the seven absent ones are exactly what
// stage 23 introduces. The seventh is
// `rows_rollout_off:public.network_site_settings`, which is not a schema fact at
// all: it asserts that no site row has been switched out of `OFF`.
//
// The DEMO organisation had been deliberately promoted to `EXECUTE` by
// `public.network_center_admin_set_rollout_v1` - the RPC this very release
// ships in order to make that possible. So the descriptor was correctly false,
// and because it first appears in stage 6's cumulative set, the catalog prefix
// walk stopped at 5. Every descriptor from stages 6..22 that production legally
// holds - 185 of them - then read as "present but not expected at this prefix",
// which is the definition of `divergent`.
//
// The generator already knows this class of descriptor is dangerous: it drops
// any descriptor that is not MONOTONE across the replay, with a stated reason
// (`realtime:public:network_worker_heartbeats`). `rows_rollout_off` passes that
// filter only because a disposable replay never promotes a site. It is
// monotone in the harness and guaranteed non-monotone in production.
//
// The fix is NOT to stop asserting it. It is the only thing standing between a
// migration and `UPDATE network_site_settings SET rollout_state = 'EXECUTE'`.
// It is moved to where it can mean what it says: the rollout still refuses,
// inside the stage transaction, any site that is switched on which was not
// already on when the rollout started. On a greenfield database that inherited
// nothing, that is byte-identical to the absolute all-OFF assertion it replaces.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuditSql,
  classifyCatalog,
} from "../audit-network-center-rollout.mjs";
import {
  applyRollout,
  buildCatalogReadSql,
  buildMigrationTransaction,
  catalogDescriptorSql,
  isDataStateDescriptor,
  readDataStateBaseline,
  resolveResumeIndex,
} from "../apply-network-center-rollout.mjs";
import {
  expectedFunctionNames,
  loadMigrationSources,
  resolveStageFunctionExpectations,
} from "../network-center-function-bodies.mjs";
import { REPO_ROOT, loadManifest } from "../network-center-rollout-common.mjs";

const ROLLOUT_OFF = "rows_rollout_off:public.network_site_settings";
const STAGE_23 = "supabase/migrations/20260729148000_network_center_action_path_reachability.sql";
// Stage 25 (14/08/2026): forward-fix làm stage 24 DML thuần quan sát được. Chưa
// từng chạy trên production — hàm nó khai vắng mặt y như bộ object của stage 23.
const STAGE_25 =
  "supabase/migrations/20260814004500_network_center_cap_lai_slot_mikrotik_tai_lap_duoc.sql";
// Stage 27 (26/08/2026): forward-fix làm stage 26 DML thuần (cap slot 950NK,
// ledger-applied qua lane forward ngày 23/08) quan sát được — cùng khuôn với
// cặp stage 24→25. Chưa từng chạy trên production: hàm nó khai vắng mặt.
const STAGE_27 =
  "supabase/migrations/20260826010000_network_center_cap_slot_950nk_tai_lap_duoc.sql";

// Measured against production on 2026-08-03, read-only, via the Management API.
// These are the ONLY manifest descriptors that were absent.
// Cập nhật 14/08/2026 khi manifest lên 25 stage: stage 24 (DML thuần,
// ledger-applied qua lane forward) không thêm descriptor nào; stage 25 thêm đúng
// MỘT — hàm dưới đây — và chưa apply nên nó vào danh sách vắng mặt.
const MEASURED_ABSENT = [
  ROLLOUT_OFF,
  "function_service_only:public.network_center_admin_enroll_access_port_v1(uuid,text,text,uuid)",
  "function_service_only:public.network_center_admin_list_access_ports_v1(uuid)",
  "function:app_private.network_center_derive_device_lifecycle_v1()",
  "function:app_private.network_center_reconcile_device_lifecycle_v1(timestamp with time zone)",
  "function:public.network_center_admin_enroll_access_port_v1(uuid,text,text,uuid)",
  "function:public.network_center_admin_list_access_ports_v1(uuid)",
  "function:app_private.network_center_cap_lai_slot_mikrotik_v1()",
  "function:app_private.network_center_cap_slot_950nk_v1()",
];

// Measured the same way: the functions stage 23 owns whose live body is not the
// reviewed one. Four exist with the body an earlier stage installed; four do not
// exist at all, because stage 23 has never run.
const MEASURED_STALE_BODIES = [
  "app_private.network_center_bind_managed_interface_v1",
  "app_private.network_center_worker_inventory_legacy_impl_v1",
  "public.network_center_admin_set_rollout_v1",
  "public.network_center_watchdog_liveness_v1",
];
const MEASURED_ABSENT_BODIES = [
  "app_private.network_center_derive_device_lifecycle_v1",
  "app_private.network_center_reconcile_device_lifecycle_v1",
  "public.network_center_admin_enroll_access_port_v1",
  "public.network_center_admin_list_access_ports_v1",
  "app_private.network_center_cap_lai_slot_mikrotik_v1",
  "app_private.network_center_cap_slot_950nk_v1",
];

// The two DEMO sites that were legitimately promoted. Real ids are not needed
// and are not pinned; the shape is what the assertion consumes.
const DEMO_BASELINE = [
  "dddd0000-0000-0000-0000-000000000001:11111111-1111-1111-1111-111111111111:EXECUTE",
  "dddd0000-0000-0000-0000-000000000001:22222222-2222-2222-2222-222222222222:EXECUTE",
];

async function productionFixture() {
  const manifest = await loadManifest();
  const sources = await loadMigrationSources(manifest, REPO_ROOT);
  const expectations = resolveStageFunctionExpectations(manifest, sources);
  const every = [
    ...new Set([
      ...manifest.preflight.required,
      ...manifest.migrations.flatMap((migration) => migration.postApply.required),
      ...manifest.postApply.required,
    ]),
  ];
  const absent = new Set(MEASURED_ABSENT);
  const present = every.filter((descriptor) => !absent.has(descriptor));

  const owned = new Map(
    [...expectations.values()].flat().map((item) => [item.qualifiedName, item.bodyDigest]),
  );
  const stale = new Set(MEASURED_STALE_BODIES);
  const missingBody = new Set(MEASURED_ABSENT_BODIES);
  const live = new Map();
  for (const name of expectedFunctionNames(expectations)) {
    if (missingBody.has(name)) continue;
    live.set(name, new Set([stale.has(name) ? "9".repeat(64) : owned.get(name)]));
  }
  return { manifest, sources, expectations, present, live, every };
}

// The fixture must keep describing the database that was measured. If a later
// release changes which stage owns these bodies, this fails rather than quietly
// testing something else.
test("the fixture reproduces the state measured on production", async () => {
  const { manifest, expectations, present, live, every } = await productionFixture();
  assert.equal(every.length, 447);
  assert.equal(present.length, 438);
  assert.equal(manifest.migrations.length, 27);
  assert.equal(manifest.migrations[22].path, STAGE_23);
  assert.equal(manifest.migrations[24].path, STAGE_25);
  assert.equal(manifest.migrations[26].path, STAGE_27);
  const classification = classifyCatalog(manifest, present, { expectations, live });
  assert.equal(classification.bodyMismatches.length, 10);
  assert.deepEqual(
    [...new Set(classification.bodyMismatches.map((item) => item.migration))].sort(),
    [STAGE_23, STAGE_25, STAGE_27].sort(),
    "every stale body must belong to an unapplied stage; an earlier one would be a different bug",
  );
});

test("a legitimately promoted site does not make the catalog divergent", async () => {
  const { manifest, expectations, present, live } = await productionFixture();
  const classification = classifyCatalog(manifest, present, { expectations, live });
  assert.equal(classification.state, "prefix");
  assert.equal(classification.prefix, 22);
  assert.deepEqual(classification.unexpected ?? [], []);

  // And the apply path offers the resume it withheld.
  let error;
  try {
    resolveResumeIndex(manifest, classification, {});
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "a stage that has not run must still not run itself");
  assert.match(error.message, new RegExp(`--resume-from ${STAGE_23}`));
  const expectedPrefix = error.message.match(/--expected-prefix ([a-f0-9]{64})/)?.[1];
  assert.ok(expectedPrefix, "the refusal must carry a usable resume digest");
  assert.equal(
    resolveResumeIndex(manifest, classification, { resumeFrom: STAGE_23, expectedPrefix }),
    22,
  );
});

test("the data-state descriptor is reported, not silently dropped", async () => {
  const { manifest, expectations, present, live } = await productionFixture();
  const classification = classifyCatalog(manifest, present, { expectations, live });
  const entry = (classification.dataState ?? []).find((item) => item.descriptor === ROLLOUT_OFF);
  assert.ok(entry, "a descriptor removed from the verdict must still be reported");
  assert.equal(entry.satisfied, false);
});

// The whole point of the check. None of these may become classifiable.
test("a schema object that arrives before its stage is still divergent", async () => {
  const { manifest, expectations, present, live } = await productionFixture();
  const early = "function:public.network_center_admin_list_access_ports_v1(uuid)";
  const classification = classifyCatalog(manifest, [...present, early], { expectations, live });
  assert.equal(classification.state, "divergent");
  assert.ok(classification.unexpected.includes(early));
});

test("a schema object missing from an already-applied stage is still divergent", async () => {
  const { manifest, expectations, present, live } = await productionFixture();
  const dropped = present.filter((item) => item !== "table:public.network_devices");
  const classification = classifyCatalog(manifest, dropped, { expectations, live });
  assert.equal(classification.state, "divergent");
  assert.ok(classification.unexpected.length > 0);
});

test("a stale body in an already-applied stage still blocks that stage", async () => {
  const { manifest, expectations, present, live } = await productionFixture();
  // Owned by stage 6, the very stage whose descriptor set the data-state
  // descriptor used to break the prefix walk at. Body evidence there must keep
  // biting.
  const early = "app_private.network_center_enqueue_command_v1";
  assert.ok(
    (expectations.get(manifest.migrations[5].path) ?? []).some(
      (item) => item.qualifiedName === early,
    ),
    "fixture drift: this function is no longer owned by stage 6",
  );
  const drifted = new Map(live);
  drifted.set(early, new Set(["8".repeat(64)]));
  const classification = classifyCatalog(manifest, present, { expectations, live: drifted });
  // Stage 6's own catalog objects are all present, so resuming there could not
  // work: the in-lock precondition requires them absent. That is divergence and
  // stays divergence - the rule this change must not soften.
  assert.equal(classification.state, "divergent");
  assert.equal(classification.prefix, 5);
  assert.equal(classification.bodyBlockedAt, manifest.migrations[5].path);
  assert.ok(classification.bodyMismatches.some((item) => item.qualifiedName === early));
  assert.throws(() => resolveResumeIndex(manifest, classification, {}), /divergent/i);
});

test("descriptor kind is decided by shape, not by a hardcoded string", () => {
  assert.equal(isDataStateDescriptor(ROLLOUT_OFF), true);
  assert.equal(isDataStateDescriptor("table:public.network_devices"), false);
  assert.equal(isDataStateDescriptor("column:public.network_site_settings:rollout_state"), false);
});

// ---------------------------------------------------------------------------
// The teeth: the inert-fleet assertion, relative to what the rollout inherited
// ---------------------------------------------------------------------------

test("with nothing inherited the assertion is the absolute all-OFF check", () => {
  const absolute = catalogDescriptorSql(ROLLOUT_OFF);
  assert.match(absolute, /rollout_state/);
  assert.match(absolute, /IS DISTINCT FROM 'OFF'/);
  // No baseline means no exemption clause at all.
  assert.doesNotMatch(absolute, /ARRAY\[/);
  assert.equal(catalogDescriptorSql(ROLLOUT_OFF, { dataStateBaseline: [] }), absolute);
});

test("an inherited site is exempted by exact identity and nothing else is", () => {
  const relative = catalogDescriptorSql(ROLLOUT_OFF, { dataStateBaseline: DEMO_BASELINE });
  assert.match(relative, /IS DISTINCT FROM 'OFF'/, "the rule itself must be unchanged");
  for (const entry of DEMO_BASELINE) assert.ok(relative.includes(entry));
  // The exemption is keyed on organisation, building AND state, so an inherited
  // site that is moved to a different rollout state is not exempt either.
  assert.match(relative, /organization_id/);
  assert.match(relative, /building_id/);
  assert.match(relative, /<>\s*ALL/);
});

test("a baseline entry cannot smuggle SQL into the assertion", () => {
  const rendered = catalogDescriptorSql(ROLLOUT_OFF, {
    dataStateBaseline: ["o'; DROP TABLE public.network_site_settings; --"],
  });
  assert.ok(rendered.includes("o''; DROP TABLE"), "quotes must be doubled, not executed");
});

test("the stage transaction carries the inherited baseline into every assertion", async () => {
  const manifest = await loadManifest();
  const stage = manifest.migrations[22];
  const prior = manifest.migrations[21].postApply.required;
  const all = [
    ...new Set(manifest.migrations.flatMap((migration) => migration.postApply.required)),
  ];
  const sql = buildMigrationTransaction({
    migration: stage,
    body: "SELECT 1;",
    priorRequired: prior,
    futureForbidden: all.filter((descriptor) => !prior.includes(descriptor)),
    dataStateBaseline: DEMO_BASELINE,
  });
  assert.ok(prior.includes(ROLLOUT_OFF), "the manifest still declares the inert property");
  assert.match(sql, /IS DISTINCT FROM 'OFF'/, "the stage must still assert an inert fleet");
  for (const entry of DEMO_BASELINE) {
    assert.ok(sql.includes(entry), "the assertion must exempt exactly what was inherited");
  }
});

// End to end through applyRollout: the baseline is read from the database
// before any stage, and it is what every stage transaction is rendered against.
test("the rollout inherits the baseline once, before the first stage", async () => {
  const manifest = {
    projectRef: "expectedprojectref1234",
    preflight: { required: [] },
    postApply: { required: [] },
    migrations: [
      { path: "one.sql", sha256: "1".repeat(64), postApply: { required: [ROLLOUT_OFF] } },
      { path: "two.sql", sha256: "2".repeat(64), postApply: { required: [ROLLOUT_OFF] } },
    ],
  };
  const stageSql = [];
  let baselineReads = 0;
  await applyRollout({
    manifest,
    migrationBodies: new Map([["one.sql", "SELECT 1;"], ["two.sql", "SELECT 2;"]]),
    query: async (sql) => {
      if (/rollout stage/.test(sql)) stageSql.push(sql);
      return { objects: [] };
    },
    readBaseline: async () => {
      baselineReads += 1;
      return DEMO_BASELINE;
    },
    writeReceipt: async () => {},
    reserveReceipt: async () => {},
  });
  assert.equal(baselineReads, 1, "re-reading per stage would let a stage bless its own promotion");
  assert.equal(stageSql.length, 2);
  for (const sql of stageSql) {
    for (const entry of DEMO_BASELINE) assert.ok(sql.includes(entry));
  }
});

test("a release declaring no data-state descriptor issues no extra query", async () => {
  const manifest = {
    projectRef: "expectedprojectref1234",
    preflight: { required: [] },
    postApply: { required: [] },
    migrations: [{ path: "one.sql", sha256: "1".repeat(64), postApply: { required: [] } }],
  };
  let baselineReads = 0;
  await applyRollout({
    manifest,
    migrationBodies: new Map([["one.sql", "SELECT 1;"]]),
    query: async () => ({ objects: [] }),
    readBaseline: async () => {
      baselineReads += 1;
      return [];
    },
    writeReceipt: async () => {},
    reserveReceipt: async () => {},
  });
  assert.equal(baselineReads, 0);
});

test("the baseline probe tolerates a database this rollout has never touched", async () => {
  const asked = [];
  const baseline = await readDataStateBaseline(async (sql) => {
    asked.push(sql);
    return { objects: [] };
  });
  assert.deepEqual(baseline, []);
  assert.equal(asked.length, 1, "the table must be proved to exist before it is named in a FROM");
  assert.match(asked[0], /to_regclass/);
  assert.doesNotMatch(asked[0], /FROM public\.network_site_settings/);
});

test("the catalog read and the audit probe render the same descriptor the same way", async () => {
  const readSql = buildCatalogReadSql([ROLLOUT_OFF], { dataStateBaseline: DEMO_BASELINE });
  const auditSql = buildAuditSql([ROLLOUT_OFF], { dataStateBaseline: DEMO_BASELINE });
  for (const entry of DEMO_BASELINE) {
    assert.ok(readSql.includes(entry));
    assert.ok(auditSql.includes(entry));
  }
});
