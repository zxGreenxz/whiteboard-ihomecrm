// Why this suite exists.
//
// A catalog-descriptor rollout audit answers exactly one question: "does this
// object exist?". It cannot answer "is this object the one we reviewed?". On
// 2026-08-02 that gap cost a production rollout: migration
// 20260729140000_network_center_admin_status_forward_fix.sql redefines a single
// function body with CREATE OR REPLACE and introduces no new catalog object, so
// the catalog said `complete` before it ran. The apply tool skipped it, printed
// "Applied 15 Network Center migration(s)", and the broken function stayed live
// through a green post-apply audit.
//
// Function bodies are the only part of a migration that is both content-
// addressable from the repository and readable back from the database
// (pg_proc.prosrc is stored verbatim). These tests pin that evidence path.
import assert from "node:assert/strict";
import test from "node:test";

import {
  assertStagesObservable,
  buildFunctionBodyProbeSql,
  expectedFunctionNames,
  extractFunctionDefinitions,
  liveFunctionBodiesFromResult,
  loadMigrationSources,
  resolveStageFunctionExpectations,
  splitSqlStatements,
} from "../network-center-function-bodies.mjs";
import { REPO_ROOT, loadManifest, sha256 } from "../network-center-rollout-common.mjs";
import { assertManifestStructure } from "../validate-network-center-rollout.mjs";
import { auditRollout, classifyCatalog } from "../audit-network-center-rollout.mjs";
import { resolveResumeIndex } from "../apply-network-center-rollout.mjs";

const FORWARD_FIX = "supabase/migrations/20260729140000_network_center_admin_status_forward_fix.sql";
const ADMIN_CONTROL_PLANE =
  "supabase/migrations/20260729134000_network_center_admin_control_plane.sql";
const STATUS_FUNCTION = "public.network_center_admin_status_v1";

test("statement splitting survives dollar quotes, comments and escape strings", () => {
  const sql = [
    "-- CREATE OR REPLACE FUNCTION public.commented_out() RETURNS void AS $fn$ BEGIN END; $fn$;",
    "SELECT 'a;b' AS literal;",
    "SELECT E'a\\';b' AS escaped;",
    "DO $outer$ BEGIN PERFORM 1; PERFORM 2; END; $outer$;",
  ].join("\n");
  // Comment text stays attached to the statement that follows it; what must not
  // happen is a split on a semicolon that lives inside a comment, a literal or a
  // dollar-quoted body.
  const statements = splitSqlStatements(sql);
  assert.equal(statements.length, 3);
  assert.match(statements[0], /SELECT 'a;b' AS literal$/);
  assert.match(statements[1], /^SELECT E'a\\';b' AS escaped$/);
  assert.match(statements[2], /^DO \$outer\$ BEGIN PERFORM 1; PERFORM 2; END; \$outer\$$/);
});

test("function extraction digests the verbatim body and ignores look-alikes", () => {
  const body = "\nBEGIN\n  RETURN 1;\nEND;\n";
  const sql = [
    "-- CREATE OR REPLACE FUNCTION public.in_a_comment() RETURNS int AS $fn$ SELECT 1 $fn$;",
    "SELECT 'CREATE OR REPLACE FUNCTION public.in_a_string()' AS decoy;",
    "CREATE OR REPLACE FUNCTION app_private.real_one(p_id uuid, p_limit integer DEFAULT 10)",
    "RETURNS int",
    "LANGUAGE plpgsql",
    "SET search_path TO 'pg_catalog'",
    `AS $fn$${body}$fn$;`,
    "DO $wrap$ BEGIN EXECUTE 'CREATE OR REPLACE FUNCTION public.dynamic() RETURNS void AS $q$ BEGIN END; $q$'; END; $wrap$;",
  ].join("\n");
  const definitions = extractFunctionDefinitions(sql, "one.sql");
  assert.deepEqual(definitions.map((item) => item.qualifiedName), ["app_private.real_one"]);
  assert.equal(definitions[0].bodyDigest, sha256(body));
});

test("an unparsable function definition fails loudly instead of vanishing", () => {
  assert.throws(
    () => extractFunctionDefinitions("CREATE OR REPLACE FUNCTION public.opaque() RETURNS void LANGUAGE c AS 'x', 'y';", "one.sql"),
    /one\.sql.*public\.opaque/is,
  );
});

test("stage expectations are last-writer-wins in manifest order", () => {
  const manifest = {
    migrations: [
      { path: "one.sql", postApply: { required: ["table:public.a"] } },
      { path: "two.sql", postApply: { required: ["table:public.a", "table:public.b"] } },
    ],
  };
  const first = "\nBEGIN RETURN 1; END;\n";
  const second = "\nBEGIN RETURN 2; END;\n";
  const sources = new Map([
    ["one.sql", `CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $fn$${first}$fn$;`],
    ["two.sql", `CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $fn$${second}$fn$;`],
  ]);
  const expectations = resolveStageFunctionExpectations(manifest, sources);
  assert.deepEqual(expectations.get("one.sql"), []);
  assert.deepEqual(expectations.get("two.sql"), [
    { qualifiedName: "public.f", bodyDigest: sha256(second) },
  ]);
});

test("the body probe is read-only, digests prosrc and escapes identifiers", () => {
  const sql = buildFunctionBodyProbeSql(["public.f", "app_private.g'h"]);
  assert.match(sql, /BEGIN READ ONLY/i);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i);
  assert.match(sql, /encode\(sha256\(convert_to\(\s*[a-z_]+\.prosrc,\s*'UTF8'\)\),\s*'hex'\)/i);
  assert.match(sql, /'app_private\.g''h'/);
  assert.match(buildFunctionBodyProbeSql([]), /BEGIN READ ONLY/i);
});

test("live probe rows collapse into one digest set per qualified name", () => {
  const live = liveFunctionBodiesFromResult([
    { result: [
      { qualified_name: "public.f", identity_arguments: "uuid", body_digest: "a".repeat(64) },
      { qualified_name: "public.f", identity_arguments: "uuid, integer", body_digest: "b".repeat(64) },
    ] },
  ]);
  assert.deepEqual([...live.get("public.f")].sort(), ["a".repeat(64), "b".repeat(64)].sort());
});

test("every rollout stage must be observable: no descriptor and no function is rejected", () => {
  const manifest = {
    migrations: [
      { path: "one.sql", postApply: { required: ["table:public.a"] } },
      { path: "two.sql", postApply: { required: ["table:public.a"] } },
    ],
  };
  assert.throws(
    () => assertStagesObservable(manifest, new Map([["one.sql", "SELECT 1;"], ["two.sql", "SELECT 2;"]])),
    /two\.sql.*unobservable|unobservable.*two\.sql/is,
  );
  const withBody = new Map([
    ["one.sql", "SELECT 1;"],
    ["two.sql", "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE plpgsql AS $fn$ BEGIN RETURN 1; END; $fn$;"],
  ]);
  assert.deepEqual(assertStagesObservable(manifest, withBody), { stages: 2 });
});

test("the reviewed release parses and every one of its stages is observable", async () => {
  const manifest = await loadManifest();
  const sources = await loadMigrationSources(manifest, REPO_ROOT);
  assert.equal(sources.size, manifest.migrations.length);
  const definitions = manifest.migrations.flatMap((migration) =>
    extractFunctionDefinitions(sources.get(migration.path), migration.path),
  );
  assert.ok(definitions.length > 100, `expected the release to define many functions, saw ${definitions.length}`);
  assert.deepEqual(assertStagesObservable(manifest, sources), { stages: manifest.migrations.length });

  // The forward fix is the exact shape that defeated the catalog audit: one
  // CREATE OR REPLACE FUNCTION, zero new catalog objects.
  const forwardFix = manifest.migrations.find((migration) => migration.path === FORWARD_FIX);
  assert.ok(forwardFix, "the forward fix must stay in the reviewed release");
  const previous = manifest.migrations[manifest.migrations.indexOf(forwardFix) - 1];
  assert.deepEqual(
    forwardFix.postApply.required.filter((item) => !previous.postApply.required.includes(item)),
    [],
    "the forward fix introduces no catalog object; that is why body evidence is required",
  );
  const expectations = resolveStageFunctionExpectations(manifest, sources);
  assert.deepEqual(
    expectations.get(FORWARD_FIX).map((item) => item.qualifiedName),
    ["public.network_center_admin_status_v1"],
  );

  // Cross-check the digest with an independent, deliberately naive reader.
  const source = sources.get(FORWARD_FIX);
  const parts = source.split("$fn$");
  assert.equal(parts.length, 3, "the forward fix must contain exactly one $fn$ body");
  assert.equal(expectations.get(FORWARD_FIX)[0].bodyDigest, sha256(parts[1]));
});

// The regression test that matters: replay 2026-08-02 with the real bytes.
//
// Production held the body that 20260729134000 created (the one projecting
// `state.enabled` from a table with no such column) while the repository held
// the forward fix. Every catalog descriptor in the manifest was present, so the
// old classifier said `complete`, the old resolveResumeIndex returned 15, and
// the old summary line claimed fifteen migrations had been applied.
test("the 2026-08-02 silent skip replays as an explicit refusal", async () => {
  const manifest = await loadManifest();
  const sources = await loadMigrationSources(manifest, REPO_ROOT);
  const expectations = resolveStageFunctionExpectations(manifest, sources);

  const brokenDefinition = extractFunctionDefinitions(
    sources.get(ADMIN_CONTROL_PLANE),
    ADMIN_CONTROL_PLANE,
  ).find((definition) => definition.qualifiedName === STATUS_FUNCTION);
  assert.ok(brokenDefinition, "the superseded definition must still be readable from the release");
  const fixedDigest = expectations
    .get(FORWARD_FIX)
    .find((item) => item.qualifiedName === STATUS_FUNCTION)?.bodyDigest;
  assert.ok(fixedDigest);
  assert.notEqual(brokenDefinition.bodyDigest, fixedDigest);

  // Exactly what production reported that day: every descriptor present.
  const present = [
    ...new Set([
      ...manifest.preflight.required,
      ...manifest.migrations.flatMap((migration) => migration.postApply.required),
      ...manifest.postApply.required,
    ]),
  ];
  const owned = new Map(
    [...expectations.values()].flat().map((item) => [item.qualifiedName, item.bodyDigest]),
  );
  const live = new Map(
    expectedFunctionNames(expectations).map((name) => [
      name,
      new Set([name === STATUS_FUNCTION ? brokenDefinition.bodyDigest : owned.get(name)]),
    ]),
  );

  const classification = classifyCatalog(manifest, present, { expectations, live });
  assert.equal(classification.state, "prefix");
  // The block lands on the stage that OWNS the repaired body, wherever it sits in
  // the release — not on the last stage. Adding any later migration must not move it.
  assert.equal(
    classification.prefix,
    manifest.migrations.findIndex((migration) => migration.path === FORWARD_FIX),
  );
  assert.equal(classification.bodyBlockedAt, FORWARD_FIX);
  assert.deepEqual(
    classification.bodyMismatches.map((item) => item.qualifiedName),
    [STATUS_FUNCTION],
  );

  // The rollout stays refusable-by-default: it names the stage and still demands
  // both resume flags, the same gate every other resume passes through.
  let error;
  try {
    resolveResumeIndex(manifest, classification, {});
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, "a rollout it cannot prove complete must refuse");
  assert.match(error.message, new RegExp(`--resume-from ${FORWARD_FIX}`));
  assert.match(error.message, /live function body differs/i);
  const expectedPrefix = error.message.match(/--expected-prefix ([a-f0-9]{64})/)?.[1];
  assert.ok(expectedPrefix);
  assert.equal(
    resolveResumeIndex(manifest, classification, { resumeFrom: FORWARD_FIX, expectedPrefix }),
    manifest.migrations.length - 1,
  );

  // And the post-apply gate, which passed green while the function was broken,
  // now fails and names it.
  const query = async (sql) =>
    /prosrc/i.test(sql)
      ? [{
          result: [...live].flatMap(([name, digests]) =>
            [...digests].map((digest) => ({
              qualified_name: name,
              identity_arguments: "",
              body_digest: digest,
            })),
          ),
        }]
      : [{ result: present.map((name) => ({ name, present: true })) }];
  await assert.rejects(
    auditRollout({ manifest, sources, mode: "post-apply", query }),
    new RegExp(STATUS_FUNCTION.replace(".", "\\.")),
  );
});

test("manifest validation refuses a release containing a stage nothing can observe", async () => {
  const manifest = await loadManifest();
  const sources = await loadMigrationSources(manifest, REPO_ROOT);
  assert.deepEqual(assertManifestStructure(manifest, { sources }), {
    migrationCount: manifest.migrations.length,
  });
  const blinded = new Map(sources);
  blinded.set(FORWARD_FIX, "-- nothing a catalog read or a body digest can see\nSELECT 1;\n");
  assert.throws(
    () => assertManifestStructure(manifest, { sources: blinded }),
    /unobservable/i,
  );
});
