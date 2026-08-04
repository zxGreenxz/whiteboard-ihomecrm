// Structural guards for 20260729138000_network_center_operational_safety.sql and
// for the disposable PostgreSQL proof that exercises it.
//
// These are cheap shrink guards, not a substitute for the runtime proof: the
// behavioural evidence lives in scripts/test-network-center-release-readback-
// disposable.mjs, which spins up a real PostgreSQL 17 cluster, applies this
// migration and asserts every item against real PL/pgSQL. What is guarded here
// is the set of properties that a later edit could silently drop without any
// single assertion in that proof going red - most importantly the ACL shape and
// the search_path pinning, which are invisible until a tenant leaks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as disposableRunner from "../test-network-center-release-readback-disposable.mjs";

const migrationPath = fileURLToPath(
  new URL(
    "../../supabase/migrations/20260729138000_network_center_operational_safety.sql",
    import.meta.url,
  ),
);
const runnerPath = fileURLToPath(
  new URL("../test-network-center-release-readback-disposable.mjs", import.meta.url),
);
const migration = readFileSync(migrationPath, "utf8");
const runner = readFileSync(runnerPath, "utf8");

// Floor for the operational-safety half of the disposable proof. Raise it when a
// legitimate new invariant is added; it exists only to catch invariants being
// dropped without anyone noticing.
const MINIMUM_OPERATIONAL_SAFETY_INVARIANTS = 25;

test("migration is additive and safe to apply to a live database", () => {
  assert.doesNotMatch(migration, /\bDROP\s+(?:TABLE|COLUMN|CONSTRAINT|SCHEMA)\b/i);
  assert.doesNotMatch(migration, /\bTRUNCATE\b/i);
  assert.doesNotMatch(migration, /\bALTER\s+TABLE\s+\S+\s+ALTER\s+COLUMN\s+\S+\s+TYPE\b/i);
  assert.match(
    migration,
    /ADD COLUMN IF NOT EXISTS reconciliation_attempt_count integer NOT NULL\s*\n?\s*DEFAULT 0/,
    "the new column must carry a constant default so PostgreSQL skips the rewrite",
  );
  assert.match(
    migration,
    /CHECK \(reconciliation_attempt_count BETWEEN 0 AND 50\) NOT VALID/,
    "the CHECK must be added NOT VALID so the hot table is not scanned under an exclusive lock",
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT network_commands_reconciliation_attempt_check/,
    "the constraint must still be validated, under SHARE UPDATE EXCLUSIVE",
  );
  assert.match(migration, /^BEGIN;$/mu);
  assert.match(migration, /^COMMIT;$/mu);
  assert.match(migration, /SELECT pg_advisory_xact_lock\(20260729138000::bigint\)/);
});

test("every SECURITY DEFINER function pins the same search_path", () => {
  const definers = migration.split(/\bCREATE OR REPLACE FUNCTION\b/u).slice(1);
  assert.ok(definers.length >= 10, "expected the migration to define functions");
  for (const body of definers) {
    const header = body.slice(0, body.indexOf("AS $fn$"));
    if (!/SECURITY DEFINER/u.test(header)) continue;
    assert.match(
      header,
      /SET search_path TO 'pg_catalog', 'public', 'app_private'/u,
      `unpinned search_path in: ${header.split("\n")[0].trim()}`,
    );
  }
});

test("operator and kill-switch RPCs are execute-scoped, never worker-scoped", () => {
  for (const signature of [
    "public.network_center_retire_uncertain_command_v1(\n  uuid, uuid, text, uuid\n)",
    "public.network_center_pause_organization_v1(\n  uuid, text, uuid\n)",
    "public.network_center_resume_organization_v1(\n  uuid, bigint, text, uuid\n)",
  ]) {
    assert.ok(
      migration.includes(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC, anon, authenticated, service_role;`),
      `missing full REVOKE for ${signature}`,
    );
    assert.ok(
      migration.includes(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated;`),
      `operator RPC must be granted to authenticated only: ${signature}`,
    );
  }
  // A worker credential authenticates as service_role, so no operator RPC may
  // ever be granted to it.
  const serviceRoleGrants = migration.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO service_role;/gu) ?? [];
  for (const grant of serviceRoleGrants) {
    assert.match(
      grant,
      /network_center_worker_claim_v2/u,
      `only worker RPCs may be granted to service_role: ${grant}`,
    );
  }
  assert.match(
    migration,
    /REVOKE ALL ON TABLE public\.network_org_mutation_gates\s*\n?\s*FROM PUBLIC, anon, authenticated, service_role;/u,
  );
  assert.match(migration, /ALTER TABLE public\.network_org_mutation_gates FORCE ROW LEVEL SECURITY;/u);
});

test("the organization gate predicate fails closed on an unresolvable tenant", () => {
  assert.match(
    migration,
    /SELECT p_organization_id IS NULL OR EXISTS \(/u,
    "a NULL tenant must count as paused, never as ungated",
  );
});

function functionBody(name) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = migration.indexOf("\n$fn$;", start);
  assert.notEqual(end, -1, `unterminated function ${name}`);
  return migration.slice(start, end);
}

test("the fleet resume is owner-only and the pause is not", () => {
  const resume = functionBody("public.network_center_resume_organization_v1");
  assert.match(resume, /membership\.member_type = 'OWNER'/u);
  assert.match(resume, /NETWORK_CENTER_ORG_RESUME_REQUIRES_OWNER/u);
  const pause = functionBody("public.network_center_pause_organization_v1");
  assert.doesNotMatch(
    pause,
    /member_type = 'OWNER'/u,
    "a fail-safe stop must never wait for an owner",
  );
  // Both directions must stay usable while the gate is engaged.
  for (const body of [pause, resume]) {
    assert.match(body, /network_center_require_execute_permission_v1/u);
    assert.doesNotMatch(body, /network_center_require_execute_v1\(/u);
  }
});

test("a recorded disable can never on its own manufacture SUCCEEDED", () => {
  const evaluator = migration.slice(
    migration.indexOf("ELSIF p_command.action_type = 'CYCLE_ACCESS_PORT' THEN"),
    migration.indexOf("ELSIF p_command.action_type = 'REBOOT_ROUTER' THEN"),
  );
  assert.match(evaluator, /observation\.observation_kind = 'POST_ACTION'/u);
  assert.match(evaluator, /observation\.command_id = p_command\.id/u);
  assert.match(evaluator, /observation\.organization_id = p_command\.organization_id/u);
  assert.match(
    evaluator,
    /p_after #>> '\{accessInterface,enabledObserved\}' = 'true'\s*\n\s*AND p_after #>> '\{accessInterface,enabled\}' = 'true'/u,
    "the live enabled readback must remain mandatory",
  );
});

test("the expiry sweeper never settles a doomed command as UNCERTAIN", () => {
  const sweeper = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION app_private.network_center_sweep_expired_commands_v1"),
    migration.indexOf("CREATE OR REPLACE FUNCTION app_private.network_center_claim_commands_v1"),
  );
  assert.match(sweeper, /SET status = 'FAILED'/u);
  assert.doesNotMatch(sweeper, /SET status = 'UNCERTAIN'/u);
  assert.match(sweeper, /OBSERVATION_DEADLINE_EXPIRED_BEFORE_DISPATCH/u);
  assert.match(sweeper, /RECONCILIATION_WINDOW_EXPIRED/u);
  assert.match(
    sweeper,
    /started_at = coalesce\(command\.started_at, p_now\)/u,
    "a never-started command still has to satisfy the finish-time CHECK",
  );
});

test("the disposable proof carries and enforces the operational-safety invariants", () => {
  assert.equal(
    disposableRunner.OPERATIONAL_SAFETY_INVARIANTS,
    MINIMUM_OPERATIONAL_SAFETY_INVARIANTS,
  );
  assert.equal(
    disposableRunner.TOTAL_DISPOSABLE_INVARIANTS,
    disposableRunner.RELEASE_READBACK_INVARIANTS
      + disposableRunner.OPERATIONAL_SAFETY_INVARIANTS
      + disposableRunner.COVERAGE_HONESTY_INVARIANTS,
  );
  assert.ok(
    disposableRunner.MIGRATION_PATHS.some((path) =>
      path.endsWith("20260729138000_network_center_operational_safety.sql"),
    ),
    "the proof must actually apply the migration under test",
  );
  for (const message of [
    "a command past its observation deadline was still claimed",
    "expired queued command was not settled honestly",
    "the legacy claim helper leased a doomed command",
    "reconciliation attempts were not bounded",
    "expired UNCERTAIN was not retired",
    "the device stayed wedged after the UNCERTAIN was retired",
    "operator retirement was not audited",
    "operator retirement ACL is worker reachable",
    "a foreign tenant retired a command",
    "recorded disable evidence was not accepted",
    "a recorded disable manufactured SUCCEEDED",
    "recorded evidence leaked to another command",
    "a failed post-check did not pause its building",
    "a not-applicable DHCP renew paused its building",
    "a transport failure paused its building",
    "the shared execute guard ignored the organization gate",
    "an execute-scoped RPC bypassed the organization gate",
    "a paused organization stopped another tenant",
    "a non-owner resumed the fleet",
    "organization gate ACL is not fail closed",
  ]) {
    assert.ok(
      runner.includes(message),
      `the disposable proof lost the assertion: ${message}`,
    );
  }
});

test("the disposable proof bootstrap holds no credential material", () => {
  assert.doesNotMatch(runner, /Management API|CLAUDE\.local|SUPABASE_(?:PAT|ACCESS_TOKEN)|sbp_[a-f0-9]/iu);
});
