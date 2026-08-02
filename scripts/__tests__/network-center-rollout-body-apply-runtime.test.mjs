// End-to-end proof, against a real PostgreSQL, that a migration whose only
// effect is a replaced function body applies through the ordinary rollout path.
//
// The unit suites prove the DECISION (a stale body is not `complete`, and the
// rollout refuses to claim otherwise). This proves the ACTION: the exact
// transaction applyRollout would send -- advisory lock, in-lock precondition
// over the previous stage's 426 descriptors, migration body, post-apply
// assertion, bounded readback -- actually commits on a database that is
// catalog-complete and body-stale, which is the state production was in on
// 2026-08-02.
//
// The cluster is built by scripts/network-center-disposable-db.mjs from the
// declared platform bootstrap plus the real, unmodified migration files. No
// Docker, no network, no developer database; it binds 127.0.0.1 only and its
// teardown is verified. If PostgreSQL is unavailable this fails loudly rather
// than skipping: a skipped rollout regression is a silently missing one.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";

import { runDisposableLocalClusterMatrix } from "../network-center-disposable-db.mjs";
import {
  buildMigrationTransaction,
  stripMigrationTransactionControl,
} from "../apply-network-center-rollout.mjs";
import {
  extractFunctionDefinitions,
  loadMigrationSources,
  resolveStageFunctionExpectations,
  splitSqlStatements,
} from "../network-center-function-bodies.mjs";
import { loadManifest } from "../network-center-rollout-common.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FORWARD_FIX = "supabase/migrations/20260729140000_network_center_admin_status_forward_fix.sql";
const ADMIN_CONTROL_PLANE =
  "supabase/migrations/20260729134000_network_center_admin_control_plane.sql";
const STATUS_FUNCTION = "network_center_admin_status_v1";

function findFunctionStatement(source, name) {
  const statement = splitSqlStatements(source).find((candidate) =>
    new RegExp(`CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+public\\.${name}\\s*\\(`, "i").test(candidate),
  );
  if (!statement) throw new Error(`No CREATE OR REPLACE FUNCTION public.${name} in the source`);
  return statement;
}

function buildBodyDigestProbe(label) {
  return `DO $${label}$
DECLARE
  v_digest text;
  v_call_failed boolean := false;
  v_sqlstate text := '';
BEGIN
  SELECT encode(sha256(convert_to(function_row.prosrc, 'UTF8')), 'hex')
  INTO v_digest
  FROM pg_proc function_row
  JOIN pg_namespace function_schema ON function_schema.oid = function_row.pronamespace
  WHERE function_schema.nspname = 'public'
    AND function_row.proname = '${STATUS_FUNCTION}';
  BEGIN
    PERFORM public.${STATUS_FUNCTION}(NULL, 1);
  EXCEPTION WHEN others THEN
    v_call_failed := true;
    v_sqlstate := SQLSTATE;
  END;
  INSERT INTO rollout_body_proof (line)
  VALUES (json_build_object(
    'case', '${label}',
    'digest', v_digest,
    'callFailed', v_call_failed,
    'sqlstate', v_sqlstate
  )::text);
END;
$${label}$;`;
}

describe("body-only rollout stage on a real database", () => {
  let verdicts;
  let brokenDigest;
  let fixedDigest;

  before(async () => {
    const manifest = await loadManifest();
    const sources = await loadMigrationSources(manifest, repositoryRoot);
    const expectations = resolveStageFunctionExpectations(manifest, sources);
    fixedDigest = expectations
      .get(FORWARD_FIX)
      .find((item) => item.qualifiedName === `public.${STATUS_FUNCTION}`).bodyDigest;
    brokenDigest = extractFunctionDefinitions(sources.get(ADMIN_CONTROL_PLANE), ADMIN_CONTROL_PLANE)
      .find((item) => item.qualifiedName === `public.${STATUS_FUNCTION}`).bodyDigest;
    assert.notEqual(brokenDigest, fixedDigest);

    const index = manifest.migrations.findIndex((item) => item.path === FORWARD_FIX);
    const stage = manifest.migrations[index];
    const priorRequired = manifest.migrations[index - 1].postApply.required;
    // The exact SQL applyRollout builds for this stage. Nothing is re-typed.
    const stageTransaction = buildMigrationTransaction({
      migration: stage,
      body: stripMigrationTransactionControl(
        await readFile(join(repositoryRoot, stage.path), "utf8"),
        stage.path,
      ),
      priorRequired,
      futureForbidden: [],
    });
    const regressToBrokenBody = findFunctionStatement(
      sources.get(ADMIN_CONTROL_PLANE),
      STATUS_FUNCTION,
    );

    verdicts = await runDisposableLocalClusterMatrix({
      repoRoot: repositoryRoot,
      buildSql: () =>
        [
          "CREATE TEMP TABLE rollout_body_proof (id serial PRIMARY KEY, line text);",
          // Put the database back into the state production was in: every
          // catalog object present, the superseded function body live.
          `${regressToBrokenBody};`,
          buildBodyDigestProbe("before"),
          stageTransaction,
          buildBodyDigestProbe("after"),
          "SELECT line FROM rollout_body_proof ORDER BY id;",
        ].join("\n"),
      parseVerdict: (output) => {
        const parsed = output
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('{"case"'))
          .map((line) => JSON.parse(line));
        if (parsed.length !== 2) {
          throw new Error(`Expected two body verdicts, saw ${parsed.length}`);
        }
        return new Map(parsed.map((entry) => [entry.case, entry]));
      },
    });
  });

  it("reproduces the production defect: the superseded body is live and raises at runtime", () => {
    const before = verdicts.get("before");
    assert.equal(before.digest, brokenDigest);
    assert.equal(before.callFailed, true);
    // 42703 = undefined_column. The body referenced state.enabled, which the
    // compatibility table has never had; plpgsql only resolves it on execution,
    // which is precisely why every catalog-shaped audit stayed green.
    assert.equal(before.sqlstate, "42703");
  });

  it("applies the body-only stage through the rollout transaction and the function works", () => {
    const after = verdicts.get("after");
    assert.equal(after.digest, fixedDigest);
    assert.equal(after.callFailed, false);
    assert.equal(after.sqlstate, "");
  });
});
