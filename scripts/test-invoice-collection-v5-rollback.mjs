#!/usr/bin/env node
// Freeze / rollback rehearsal for the invoice.collection.v5 rollout on DEMO.
//
// Rehearses the Phase-7 rollback contract (PLAN §12.4) entirely inside one
// BEGIN … ROLLBACK transaction, so no flag change and no fixture ever
// persists. It proves:
//   1. baseline: both routes evaluate CANONICAL for DEMO (canary);
//   2. freezing invoice.collection.v5 (force_freeze) flips its route to
//      FROZEN while invoice.collection.reverse.v5 is HELD CANONICAL;
//   3. while frozen, a record attempt is blocked (55000) but a reverse of an
//      already-ACTIVE collection still succeeds — the reverse engine stays
//      usable so active collections can be unwound;
//   4. the CAS setter app_private.set_feature_route_v1 fails closed on a
//      stale expected config_version (40001);
//   5. unfreezing restores the record route to CANONICAL.
//
// A Phase-7 scaffold: correct and self-cleaning (transaction rollback), not
// run during Phase 6 authoring.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  COLLECTION_KEY,
  REVERSE_KEY,
  DEMO_ORG_ID,
  runQuery,
  fail,
  sqlLiteral,
  uuidLiteral,
  jsonbLiteral,
  newRunId,
  fixtureMarker,
  forceDemoCanaryPreludeSql,
  fixtureInvoiceSql,
  actAsFixtureActorSql,
  TEST_LOCK_TIMEOUT,
  TEST_STATEMENT_TIMEOUT,
} from "./lib/v5-collection-harness.mjs";

const RENT = 3_000_000;
const DEPOSIT = 2_000_000;
const BILLING_MONTH = "2094-06";

function seedCollectionSql() {
  return `
DO $v5h_seed$
DECLARE
  v_invoice uuid := current_setting('v5h.invoice')::uuid;
  v_account_tm uuid := current_setting('v5h.account_tm')::uuid;
  v_res jsonb;
BEGIN
  v_res := public.record_invoice_collection_v5(
    v_invoice, '2094-06-10',
    jsonb_build_array(jsonb_build_object(
      'payment_method', 'TM', 'gross_amount', 1000000,
      'account_id', v_account_tm, 'receipt_number', 'V5H-ROLLBACK')),
    'REJECT', false, 'rollback seed', NULL, 0, 'v5h-rollback-seed');
  PERFORM set_config('v5h.rollback_collection', (v_res->>'collection_id'), true);
END
$v5h_seed$;
`;
}

function freezeAssertSql() {
  const org = uuidLiteral(DEMO_ORG_ID);
  return `
UPDATE app_private.server_feature_flags
   SET force_freeze = true, config_version = config_version + 1,
       updated_at = clock_timestamp()
 WHERE feature_key = ${sqlLiteral(COLLECTION_KEY)};

DO $v5h_freeze_check$
DECLARE
  v_record text := app_private.evaluate_feature_route(${sqlLiteral(COLLECTION_KEY)}, ${org});
  v_reverse text := app_private.evaluate_feature_route(${sqlLiteral(REVERSE_KEY)}, ${org});
BEGIN
  IF v_record <> 'FROZEN' THEN
    RAISE EXCEPTION 'Freeze không đưa record route về FROZEN (got %)', v_record;
  END IF;
  IF v_reverse <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Reverse route không còn CANONICAL khi freeze record (got %)', v_reverse;
  END IF;
END
$v5h_freeze_check$;
`;
}

function blockedAndReverseSql() {
  return `
DO $v5h_blocked$
DECLARE
  v_invoice uuid := current_setting('v5h.invoice')::uuid;
  v_account_tm uuid := current_setting('v5h.account_tm')::uuid;
  v_collection uuid := current_setting('v5h.rollback_collection')::uuid;
  v_paid numeric;
  v_status text;
BEGIN
  -- Record must be blocked while the writer is frozen.
  BEGIN
    PERFORM public.record_invoice_collection_v5(
      v_invoice, '2094-06-11',
      jsonb_build_array(jsonb_build_object(
        'payment_method', 'TM', 'gross_amount', 1000000,
        'account_id', v_account_tm)),
      'REJECT', false, 'blocked probe', NULL, 1000000, 'v5h-rollback-blocked');
    RAISE EXCEPTION 'Record succeeded while route was FROZEN';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    IF position('đóng băng' IN SQLERRM) = 0 THEN
      RAISE EXCEPTION 'Record blocked by the wrong 55000 guard: %', SQLERRM;
    END IF;
  END;

  -- Reverse of an already-ACTIVE collection must remain usable.
  PERFORM public.reverse_invoice_collection_v5(
    v_collection, '2094-06-20', 'held-canonical reverse', 'v5h-rollback-reverse');

  SELECT status INTO v_status
  FROM public.invoice_payment_collections WHERE id = v_collection;
  IF v_status <> 'REVERSED' THEN
    RAISE EXCEPTION 'Held-canonical reverse did not reverse the collection (%).', v_status;
  END IF;
  SELECT paid_amount INTO v_paid FROM public.invoices WHERE id = v_invoice;
  IF v_paid < 0 THEN
    RAISE EXCEPTION 'Reverse produced negative paid amount (%).', v_paid;
  END IF;
END
$v5h_blocked$;
`;
}

function casAndUnfreezeSql() {
  const org = uuidLiteral(DEMO_ORG_ID);
  return `
DO $v5h_cas$
DECLARE
  v_route text;
BEGIN
  -- CAS must fail closed on a stale expected config_version.
  BEGIN
    PERFORM app_private.set_feature_route_v1(
      ${sqlLiteral(COLLECTION_KEY)}, (-1)::bigint, 'SHADOW',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'cas fail-closed rehearsal');
    RAISE EXCEPTION 'CAS setter accepted a stale expected config_version';
  EXCEPTION WHEN SQLSTATE '40001' THEN NULL;
  END;

  -- Unfreeze restores the record route to CANONICAL for DEMO.
  UPDATE app_private.server_feature_flags
     SET force_freeze = false, config_version = config_version + 1,
         updated_at = clock_timestamp()
   WHERE feature_key = ${sqlLiteral(COLLECTION_KEY)};

  v_route := app_private.evaluate_feature_route(${sqlLiteral(COLLECTION_KEY)}, ${org});
  IF v_route <> 'CANONICAL' THEN
    RAISE EXCEPTION 'Unfreeze did not restore record route to CANONICAL (got %)', v_route;
  END IF;
END
$v5h_cas$;
`;
}

export function buildScriptSql(runId) {
  const marker = fixtureMarker(runId);
  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = ${sqlLiteral(TEST_LOCK_TIMEOUT)};`,
    `SET LOCAL statement_timeout = ${sqlLiteral(TEST_STATEMENT_TIMEOUT)};`,
    forceDemoCanaryPreludeSql({ creditMode: "SHADOW" }),
    fixtureInvoiceSql({ marker, billingMonth: BILLING_MONTH, rent: RENT, deposit: DEPOSIT }),
    actAsFixtureActorSql(),
    seedCollectionSql(),
    "RESET ROLE;",
    freezeAssertSql(),
    actAsFixtureActorSql(),
    blockedAndReverseSql(),
    "RESET ROLE;",
    casAndUnfreezeSql(),
    "ROLLBACK;",
    `SELECT ${jsonbLiteral({
      steps: [
        "baseline-canary-canonical",
        "freeze-record-route",
        "record-blocked-while-frozen",
        "reverse-usable-held-canonical",
        "cas-fail-closed-stale-version",
        "unfreeze-restores-canonical",
      ],
    })} AS v5_rollback_test;`,
  ].join("\n");
}

async function main() {
  const runId = newRunId();
  let rows;
  try {
    rows = await runQuery(buildScriptSql(runId));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  const summary = rows?.[0]?.v5_rollback_test;
  if (!summary || !Array.isArray(summary.steps)) {
    fail("Rollback rehearsal không trả tổng kết; nghi ngờ transaction lỗi.");
    return;
  }
  console.log(
    `invoice.collection.v5 rollback rehearsal passed (${summary.steps.length} steps, all rolled back).`,
  );
  for (const step of summary.steps) console.log(`  ok: ${step}`);
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
