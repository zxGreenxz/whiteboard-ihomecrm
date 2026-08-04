// Structural guards for the disposable connection-address proof.
//
// The proof itself needs a PostgreSQL cluster, so it lives in its own runner.
// What is checked here is everything that can rot silently WITHOUT a database:
// that the proof is still bound to a cluster nonce, that its declared invariant
// count cannot drift away from the ledger the SQL emits, that the verdict parser
// refuses a partial or foreign result, and that the SQL still names every reader
// the forward fix repaired. A proof nobody can point at production is the whole
// point of the nonce, and a verdict parser that accepts anything is how a green
// suite covers nothing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CONNECTION_ADDRESS_PROOF_INVARIANTS,
  REPAIRED_FUNCTIONS,
  buildConnectionAddressProofSql,
  parseConnectionAddressProofVerdict,
} from "../test-network-center-connection-address-disposable.mjs";

const MIGRATION_PATH = fileURLToPath(new URL(
  "../../supabase/migrations/20260729145000_network_center_connection_host_fix.sql",
  import.meta.url,
));

const NONCE = "a".repeat(32);

function verdict(overrides = {}) {
  return {
    status: "PASS",
    invariants: CONNECTION_ADDRESS_PROOF_INVARIANTS,
    proofNonce: NONCE,
    names: Array.from(
      { length: CONNECTION_ADDRESS_PROOF_INVARIANTS },
      (_unused, index) => `assertion-${index}`,
    ),
    ...overrides,
  };
}

function output(entry) {
  return `${JSON.stringify(entry)}\n`;
}

test("the proof refuses to build without a disposable cluster nonce", () => {
  assert.throws(() => buildConnectionAddressProofSql({}), /proof nonce/u);
  assert.throws(
    () => buildConnectionAddressProofSql({ localProof: { proofNonce: "not-a-nonce" } }),
    /proof nonce/u,
  );
  assert.throws(
    () => buildConnectionAddressProofSql({ localProof: { proofNonce: "A".repeat(32) } }),
    /proof nonce/u,
  );
});

test("the built SQL binds itself to that cluster and rolls back", () => {
  const sql = buildConnectionAddressProofSql({ localProof: { proofNonce: NONCE } });
  assert.match(sql, new RegExp(`network_center_disposable_proof[\\s\\S]*${NONCE}`, "u"));
  assert.match(sql, /is not running on its own disposable cluster/u);
  assert.ok(sql.trimEnd().endsWith("ROLLBACK;"), "the proof must leave no fixture behind");
});

test("the SQL drives the real RPCs rather than reading the tables", () => {
  const sql = buildConnectionAddressProofSql({ localProof: { proofNonce: NONCE } });
  for (const rpc of [
    "public.network_center_worker_list_connections_v2(",
    "public.network_center_worker_list_connections_v1(",
    "public.network_center_list_aruba_v1(",
    "public.network_center_list_clients_v1(",
    "public.network_center_worker_ingest_v2(",
  ]) {
    assert.ok(sql.includes(rpc), `the proof no longer calls ${rpc}`);
  }
  // The address must come out of a real inet column, never out of a literal the
  // test typed itself - that is precisely how the defect survived every gate.
  assert.match(sql, /management_ip\s*\)?\s*(?:,|$)|'10\.77\.0\.250'::inet/u);
  assert.match(sql, /host\(v_stored\)/u);
  assert.match(sql, /'10\.77\.0\.251\/24'::inet/u, "a non-maximal mask must be covered");
  assert.match(sql, /'2001:db8::250'::inet/u, "IPv6 must be covered");
});

test("the declared invariant count cannot drift from the assertion ledger", () => {
  const sql = buildConnectionAddressProofSql({ localProof: { proofNonce: NONCE } });
  // Two assertion names are composed at run time inside a loop
  // (`'definer-profile-preserved-' || split_part(...)`), so they contribute one
  // row per repaired function, not one row each. They also match the literal
  // scan below, so they have to be taken out of it first.
  const dynamic = [...sql.matchAll(/'([a-z-]+-preserved-)'\s*\|\|/gu)].map((match) => match[1]);
  const names = [...sql.matchAll(/nca_assert\(\s*'([a-z0-9-]+)'/gu)]
    .map((match) => match[1])
    .filter((name) => !dynamic.includes(name));
  assert.equal(dynamic.length, 2, "the looped assertion names changed shape");
  const expected = names.length + (dynamic.length * REPAIRED_FUNCTIONS.length);
  assert.equal(
    expected,
    CONNECTION_ADDRESS_PROOF_INVARIANTS,
    `SQL declares ${expected} assertions but the runner exports `
      + `${CONNECTION_ADDRESS_PROOF_INVARIANTS}`,
  );
  assert.equal(new Set(names).size, names.length, "duplicate assertion name would inflate the count");
});

test("the verdict parser refuses anything short of a complete PASS", () => {
  assert.deepEqual(
    parseConnectionAddressProofVerdict(output(verdict()), {
      expectedLocalProof: { proofNonce: NONCE },
    }).invariants,
    CONNECTION_ADDRESS_PROOF_INVARIANTS,
  );
  for (const [label, broken] of [
    ["a partial run", verdict({ invariants: CONNECTION_ADDRESS_PROOF_INVARIANTS - 1 })],
    ["a failed run", verdict({ status: "FAIL" })],
    ["another cluster", verdict({ proofNonce: "b".repeat(32) })],
    ["a missing ledger", verdict({ names: null })],
    ["a padded ledger", verdict({ names: new Array(CONNECTION_ADDRESS_PROOF_INVARIANTS).fill("same") })],
  ]) {
    assert.throws(
      () => parseConnectionAddressProofVerdict(output(broken), {
        expectedLocalProof: { proofNonce: NONCE },
      }),
      /did not return the expected PASS verdict|malformed assertion ledger/u,
      `${label} was accepted`,
    );
  }
  assert.throws(
    () => parseConnectionAddressProofVerdict("no json here\n", {
      expectedLocalProof: { proofNonce: NONCE },
    }),
    /did not return the expected PASS verdict/u,
  );
});

test("the forward-fix migration is the one the proof pins", () => {
  const migration = readFileSync(MIGRATION_PATH, "utf8");
  assert.ok(migration.length > 0, "the forward-fix migration is missing");
  assert.equal(migration.includes("\r"), false, "the migration must stay LF-only");
  for (const entry of REPAIRED_FUNCTIONS) {
    const name = entry.signature.split("(")[0];
    assert.ok(
      migration.includes(`CREATE OR REPLACE FUNCTION ${name}(`),
      `${name} is not redefined by the forward fix`,
    );
    assert.ok(migration.includes(entry.signature), `${name} is not pinned by exact signature`);
  }
  // Only rendered addresses may change: no repaired body may still cast an inet.
  assert.equal(
    /(management_ip|observed_ip|"observedIp")::text/u.test(
      migration.slice(migration.indexOf("$preflight$;")),
    ),
    true,
    "the defect tokens must still appear in the guard lists",
  );
  const bodies = migration.slice(
    migration.indexOf("$preflight$;"),
    migration.indexOf("REVOKE ALL ON FUNCTION"),
  );
  assert.equal(
    /connection\.management_ip::text|item\.observed_ip::text|jsonb_build_array\("observedIp"::text\)/u
      .test(bodies),
    false,
    "a repaired function body still renders an inet through ::text",
  );
});
