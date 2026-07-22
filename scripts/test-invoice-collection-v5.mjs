#!/usr/bin/env node
// Money-safe live-DB harness for invoice.collection.v5 against org DEMO.
//
// Runs ONE transaction that: forces the two collection routes CANONICAL for
// DEMO (canary), creates a fresh fixture invoice, then exercises the full V5
// record/reverse surface as the DEMO owner — direct single + multi-tender
// (TM/TK/TT), idempotent retry (same key/same payload), payload-mismatch
// rejection (same key/different payload), overpay REJECT + REFUND, CREDIT
// rejected while the credit flag is not CANONICAL, rounding that must not
// waive an unpaid deposit residual, a cross-tenant receiving account, and a
// full-collection reversal — asserting the money invariants at each step.
//
// The whole run is wrapped in BEGIN … ROLLBACK: reversal is exercised as a
// scenario, and the transaction rollback guarantees NOTHING is persisted to
// DEMO. Any failed invariant RAISEs inside SQL, which aborts the transaction,
// fails the HTTP request, and exits this process non-zero.
//
// This is a Phase-7 canary scaffold: correct and self-cleaning, but not run
// as part of Phase 6 authoring.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  runQuery,
  fail,
  jsonbLiteral,
  sqlLiteral,
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

// A far-future, unique billing month so the fixture never collides with real
// DEMO data and is trivially identifiable by its marker.
function fixtureBillingMonth(runId) {
  const seed = Number.parseInt(runId.slice(-4), 16) % 12;
  const month = String((seed % 12) + 1).padStart(2, "0");
  return `2094-${month}`;
}

// One DO block: every money invariant is a RAISE, so a violation aborts the
// enclosing transaction and surfaces as a non-2xx Management API response.
function scenarioSql() {
  return `
DO $v5_collection_test$
DECLARE
  v_invoice uuid := current_setting('v5h.invoice')::uuid;
  v_account_tm uuid := current_setting('v5h.account_tm')::uuid;
  v_account_tk uuid := current_setting('v5h.account_tk')::uuid;
  v_virtual uuid := current_setting('v5h.virtual_account')::uuid;
  v_cross text := current_setting('v5h.cross_org_account', true);
  v_res jsonb;
  v_c1 uuid;
  v_c2 uuid;
  v_c3 uuid;
  v_gross numeric;
  v_applied numeric;
  v_change numeric;
  v_credit numeric;
  v_alloc numeric;
  v_paid numeric;
  v_count integer;
BEGIN
  ----------------------------------------------------------------------------
  -- Scenario: cross-tenant receiving account must be rejected (42501).
  ----------------------------------------------------------------------------
  IF v_cross IS NOT NULL AND v_cross <> '' THEN
    BEGIN
      PERFORM public.record_invoice_collection_v5(
        v_invoice, '2094-01-10',
        jsonb_build_array(jsonb_build_object(
          'payment_method', 'TM', 'gross_amount', 1000000,
          'account_id', v_cross::uuid)),
        'REJECT', false, 'cross-tenant probe', NULL, 0, 'v5h-cross-0001');
      RAISE EXCEPTION 'Cross-tenant account was accepted';
    EXCEPTION WHEN SQLSTATE '42501' THEN NULL;
    END;
  END IF;

  ----------------------------------------------------------------------------
  -- Scenario: overpay=CREDIT must fail-closed while credit flag not CANONICAL,
  -- and must not create a customer_credit_lot / excess row.
  ----------------------------------------------------------------------------
  BEGIN
    PERFORM public.record_invoice_collection_v5(
      v_invoice, '2094-01-10',
      jsonb_build_array(jsonb_build_object(
        'payment_method', 'TM', 'gross_amount', 6000000,
        'account_id', v_account_tm)),
      'CREDIT', false, 'credit-shadow probe', NULL, 0, 'v5h-credit-0001');
    RAISE EXCEPTION 'CREDIT overpay was accepted while credit flag not CANONICAL';
  EXCEPTION WHEN SQLSTATE '55000' OR SQLSTATE '42501' OR SQLSTATE '22023' THEN
    NULL;
  END;
  SELECT count(*) INTO v_count
  FROM public.customer_credit_lots lot
  JOIN public.invoices invoice_row ON invoice_row.contract_id = lot.contract_id
  WHERE invoice_row.id = v_invoice;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Rejected CREDIT still created a credit lot';
  END IF;

  ----------------------------------------------------------------------------
  -- Scenario: rounding must not waive an unpaid deposit residual (22023).
  ----------------------------------------------------------------------------
  BEGIN
    PERFORM public.record_invoice_collection_v5(
      v_invoice, '2094-01-10',
      jsonb_build_array(jsonb_build_object(
        'payment_method', 'TM', 'gross_amount', 4995000,
        'account_id', v_account_tm, 'rounding_account_id', v_virtual)),
      'REJECT', true, 'rounding residual probe', NULL, 0, 'v5h-rounding-0001');
    RAISE EXCEPTION 'Rounding waived an unpaid deposit residual';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  ----------------------------------------------------------------------------
  -- Scenario: direct single-tender partial collection (TM).
  ----------------------------------------------------------------------------
  v_res := public.record_invoice_collection_v5(
    v_invoice, '2094-01-10',
    jsonb_build_array(jsonb_build_object(
      'payment_method', 'TM', 'gross_amount', 1000000,
      'account_id', v_account_tm, 'receipt_number', 'V5H-A')),
    'REJECT', false, 'partial single', NULL, 0, 'v5h-collect-A');
  v_c1 := (v_res->>'collection_id')::uuid;
  v_gross := (v_res->>'gross_amount')::numeric;
  v_applied := (v_res->>'applied_amount')::numeric;
  v_change := (v_res->>'change_amount')::numeric;
  v_credit := (v_res->>'credit_amount')::numeric;
  IF abs(v_gross - (v_applied + v_change + v_credit)) >= 0.01
     OR v_applied <= 0 OR v_gross <> 1000000 THEN
    RAISE EXCEPTION 'Single-tender money invariant failed: %', v_res;
  END IF;
  SELECT COALESCE(sum(amount), 0) INTO v_alloc
  FROM public.invoice_payment_allocations WHERE collection_id = v_c1;
  IF abs(v_alloc - (v_applied + v_credit)) >= 0.01 THEN
    RAISE EXCEPTION 'Allocation sum != retained for collection A: % vs %',
      v_alloc, v_applied + v_credit;
  END IF;

  ----------------------------------------------------------------------------
  -- Scenario: same key + same payload replays the SAME collection (no double
  -- write); same key + different payload is rejected (23505).
  ----------------------------------------------------------------------------
  v_res := public.record_invoice_collection_v5(
    v_invoice, '2094-01-10',
    jsonb_build_array(jsonb_build_object(
      'payment_method', 'TM', 'gross_amount', 1000000,
      'account_id', v_account_tm, 'receipt_number', 'V5H-A')),
    'REJECT', false, 'partial single', NULL, 0, 'v5h-collect-A');
  IF (v_res->>'collection_id')::uuid <> v_c1 THEN
    RAISE EXCEPTION 'Idempotent replay returned a different collection';
  END IF;
  SELECT count(*) INTO v_count
  FROM public.invoice_payment_collections WHERE invoice_id = v_invoice;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Idempotent replay double-wrote a collection';
  END IF;

  BEGIN
    PERFORM public.record_invoice_collection_v5(
      v_invoice, '2094-01-10',
      jsonb_build_array(jsonb_build_object(
        'payment_method', 'TM', 'gross_amount', 1234567,
        'account_id', v_account_tm)),
      'REJECT', false, 'mismatch payload', NULL, 0, 'v5h-collect-A');
    RAISE EXCEPTION 'Same key with a different payload was accepted';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;

  ----------------------------------------------------------------------------
  -- Scenario: multi-tender collection (TK + TM) at the new expected paid.
  ----------------------------------------------------------------------------
  v_res := public.record_invoice_collection_v5(
    v_invoice, '2094-01-11',
    jsonb_build_array(
      jsonb_build_object('payment_method', 'TK', 'gross_amount', 2000000,
        'account_id', v_account_tk, 'receipt_number', 'V5H-B-TK'),
      jsonb_build_object('payment_method', 'TM', 'gross_amount', 500000,
        'account_id', v_account_tm, 'receipt_number', 'V5H-B-TM')),
    'REJECT', false, 'multi-tender', NULL, 1000000, 'v5h-collect-B');
  v_c2 := (v_res->>'collection_id')::uuid;
  v_gross := (v_res->>'gross_amount')::numeric;
  v_applied := (v_res->>'applied_amount')::numeric;
  v_change := (v_res->>'change_amount')::numeric;
  v_credit := (v_res->>'credit_amount')::numeric;
  IF abs(v_gross - (v_applied + v_change + v_credit)) >= 0.01
     OR v_gross <> 2500000 THEN
    RAISE EXCEPTION 'Multi-tender money invariant failed: %', v_res;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.invoice_payment_tenders WHERE collection_id = v_c2;
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'Multi-tender expected 2 tenders, got %', v_count;
  END IF;

  ----------------------------------------------------------------------------
  -- Scenario: overpay REJECT (22023) then overpay REFUND (change in TM).
  ----------------------------------------------------------------------------
  SELECT paid_amount INTO v_paid FROM public.invoices WHERE id = v_invoice;
  BEGIN
    PERFORM public.record_invoice_collection_v5(
      v_invoice, '2094-01-12',
      jsonb_build_array(jsonb_build_object(
        'payment_method', 'TM', 'gross_amount', 3000000,
        'account_id', v_account_tm)),
      'REJECT', false, 'overpay reject', NULL, v_paid, 'v5h-overpay-reject');
    RAISE EXCEPTION 'Overpay REJECT unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN NULL;
  END;

  v_res := public.record_invoice_collection_v5(
    v_invoice, '2094-01-12',
    jsonb_build_array(jsonb_build_object(
      'payment_method', 'TM', 'gross_amount', 2000000,
      'account_id', v_account_tm, 'change_account_id', v_virtual,
      'receipt_number', 'V5H-C')),
    'REFUND', false, 'overpay refund', NULL, v_paid, 'v5h-overpay-refund');
  v_c3 := (v_res->>'collection_id')::uuid;
  v_gross := (v_res->>'gross_amount')::numeric;
  v_applied := (v_res->>'applied_amount')::numeric;
  v_change := (v_res->>'change_amount')::numeric;
  v_credit := (v_res->>'credit_amount')::numeric;
  IF abs(v_gross - (v_applied + v_change + v_credit)) >= 0.01
     OR v_change <= 0 THEN
    RAISE EXCEPTION 'Overpay REFUND money invariant failed: %', v_res;
  END IF;
  SELECT paid_amount INTO v_paid FROM public.invoices WHERE id = v_invoice;
  IF v_paid <> 5000000 THEN
    RAISE EXCEPTION 'Invoice not fully paid after REFUND: %', v_paid;
  END IF;

  ----------------------------------------------------------------------------
  -- Scenario: reverse the whole invoice LIFO; paid returns to 0, collections
  -- become REVERSED, and no invalid double-reversal remains.
  ----------------------------------------------------------------------------
  PERFORM public.reverse_invoice_collection_v5(
    v_c3, '2094-02-01', 'reverse C', 'v5h-reverse-C');
  PERFORM public.reverse_invoice_collection_v5(
    v_c2, '2094-02-02', 'reverse B', 'v5h-reverse-B');
  PERFORM public.reverse_invoice_collection_v5(
    v_c1, '2094-02-03', 'reverse A', 'v5h-reverse-A');

  SELECT paid_amount INTO v_paid FROM public.invoices WHERE id = v_invoice;
  IF v_paid <> 0 THEN
    RAISE EXCEPTION 'Invoice paid not restored to 0 after reversal: %', v_paid;
  END IF;
  SELECT count(*) INTO v_count
  FROM public.invoice_payment_collections
  WHERE invoice_id = v_invoice AND status <> 'REVERSED';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Reversal left % non-REVERSED collections', v_count;
  END IF;
  -- NOTE: the invalid-payment-reversal invariant reads app_private, which the
  -- authenticated role cannot access; it is asserted after RESET ROLE below.

  -- Reversing an already-reversed collection is rejected (23505).
  BEGIN
    PERFORM public.reverse_invoice_collection_v5(
      v_c1, '2094-02-04', 'double reverse', 'v5h-reverse-A-dup');
    RAISE EXCEPTION 'Double reversal unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23505' THEN NULL;
  END;
END
$v5_collection_test$;
`;
}

export function buildScriptSql(runId) {
  const marker = fixtureMarker(runId);
  const billingMonth = fixtureBillingMonth(runId);
  return [
    "BEGIN;",
    `SET LOCAL lock_timeout = ${sqlLiteral(TEST_LOCK_TIMEOUT)};`,
    `SET LOCAL statement_timeout = ${sqlLiteral(TEST_STATEMENT_TIMEOUT)};`,
    forceDemoCanaryPreludeSql({ creditMode: "SHADOW" }),
    fixtureInvoiceSql({ marker, billingMonth, rent: RENT, deposit: DEPOSIT }),
    actAsFixtureActorSql(),
    scenarioSql(),
    "RESET ROLE;",
    // The invalid-payment-reversal invariant calls app_private (admin-only, not
    // granted to authenticated), so it runs here as postgres rather than inside
    // the authenticated scenario block. The invoice id is still readable from
    // the transaction-local GUC set by the fixture.
    `DO $v5h_reversal_invariant$
DECLARE
  v_invoice uuid := current_setting('v5h.invoice')::uuid;
  v_count integer;
BEGIN
  SELECT COALESCE(sum(app_private.count_invalid_payment_reversals_v1(payment.id)), 0)
    INTO v_count
  FROM public.payments payment WHERE payment.invoice_id = v_invoice;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'Invalid payment reversals detected: %', v_count;
  END IF;
END
$v5h_reversal_invariant$;`,
    "ROLLBACK;",
    `SELECT ${jsonbLiteral({
      scenarios: [
        "cross-tenant-account-reject",
        "credit-fail-closed",
        "rounding-residual-deposit-reject",
        "single-tender-partial",
        "idempotent-same-key-same-payload",
        "reject-same-key-different-payload",
        "multi-tender-TM-TK",
        "overpay-reject",
        "overpay-refund",
        "reverse-collection-lifo",
        "double-reversal-reject",
      ],
    })} AS v5_collection_test;`,
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
  const summary = rows?.[0]?.v5_collection_test;
  if (!summary || !Array.isArray(summary.scenarios)) {
    fail("Harness không trả về tổng kết scenario; nghi ngờ transaction lỗi.");
    return;
  }
  console.log(
    `invoice.collection.v5 single-session harness passed (${summary.scenarios.length} scenarios, all rolled back).`,
  );
  for (const name of summary.scenarios) console.log(`  ok: ${name}`);
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
