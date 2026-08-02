import assert from "node:assert/strict";
import test from "node:test";

import {
  assertDisposableTenantTestTarget,
} from "../network-center-disposable-db.mjs";
import { main as runCrossTenantMatrix } from "../test-cross-tenant.mjs";

const PRODUCTION_REF = "tryymsxyyckgbrmmvozx";
const FUTURE_EXPIRY = "2026-07-29T12:00:00.000Z";

test("rejects production and unknown targets before database work", () => {
  for (const target of [
    {
      projectRef: PRODUCTION_REF,
      host: "127.0.0.1",
      marker: "network-center-disposable:v1:019f8c63",
      expiresAt: FUTURE_EXPIRY,
    },
    {
      projectRef: "local-run-019f8c63",
      host: "127.0.0.1",
      marker: undefined,
      expiresAt: FUTURE_EXPIRY,
    },
    {
      projectRef: "local-run-019f8c63",
      host: "db.example.com",
      marker: "network-center-disposable:v1:019f8c63",
      expiresAt: FUTURE_EXPIRY,
    },
  ]) {
    assert.throws(
      () => assertDisposableTenantTestTarget(target, {
        productionRefs: new Set([PRODUCTION_REF]),
        now: new Date("2026-07-29T00:00:00.000Z"),
      }),
      /production|disposable marker|local Supabase/i,
    );
  }
});

test("accepts one unexpired per-run local Supabase identity", () => {
  assert.deepEqual(
    assertDisposableTenantTestTarget({
      projectRef: "local-run-019f8c63",
      host: "localhost",
      marker: "network-center-disposable:v1:019f8c63",
      expiresAt: FUTURE_EXPIRY,
    }, {
      productionRefs: new Set([PRODUCTION_REF]),
      now: new Date("2026-07-29T00:00:00.000Z"),
    }),
    {
      projectRef: "local-run-019f8c63",
      host: "localhost",
      runId: "019f8c63",
      expiresAt: FUTURE_EXPIRY,
    },
  );
});

test("rejects a marker that does not own the project reference", () => {
  assert.throws(
    () => assertDisposableTenantTestTarget({
      projectRef: "local-run-other999",
      host: "127.0.0.1",
      marker: "network-center-disposable:v1:019f8c63",
      expiresAt: FUTURE_EXPIRY,
    }, {
      productionRefs: new Set([PRODUCTION_REF]),
      now: new Date("2026-07-29T00:00:00.000Z"),
    }),
    /marker.*project reference|project reference.*marker/i,
  );
});

test("rejects an expired disposable sentinel", () => {
  assert.throws(
    () => assertDisposableTenantTestTarget({
      projectRef: "local-run-expired1",
      host: "127.0.0.1",
      marker: "network-center-disposable:v1:expired1",
      expiresAt: "2026-07-28T23:59:59.000Z",
    }, {
      productionRefs: new Set([PRODUCTION_REF]),
      now: new Date("2026-07-29T00:00:00.000Z"),
    }),
    /expired/i,
  );
});

test("rejects a disposable sentinel valid for more than 24 hours", () => {
  assert.throws(
    () => assertDisposableTenantTestTarget({
      projectRef: "local-run-toolong1",
      host: "127.0.0.1",
      marker: "network-center-disposable:v1:toolong1",
      expiresAt: "2026-07-30T00:00:00.001Z",
    }, {
      productionRefs: new Set([PRODUCTION_REF]),
      now: new Date("2026-07-29T00:00:00.000Z"),
    }),
    /24 hours/i,
  );
});

test("missing production RPC fails after read-only preflight without shadow DDL", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify([{ applied: false }]), { status: 200 });
  };

  await assert.rejects(
    runCrossTenantMatrix([], {
      fetchImpl,
      loadConfig: () => ({ pat: "sbp_test_only", projectRef: PRODUCTION_REF }),
      log: () => {},
    }),
    /migration.*not applied|schema.*not applied/i,
  );

  assert.equal(requests.length, 1);
  assert.match(requests[0].query, /to_regprocedure/i);
  assert.doesNotMatch(requests[0].query, /CREATE\s+(?:TABLE|INDEX|FUNCTION)|ALTER\s+TABLE/i);
});
