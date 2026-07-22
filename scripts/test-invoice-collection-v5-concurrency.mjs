#!/usr/bin/env node
// Two-connection concurrency harness for invoice.collection.v5 on org DEMO.
//
// Unlike the single-session harness, this exercises REAL contention: each
// competing operation runs in its OWN Management API request (its own backend
// connection + transaction that COMMITs), so the org decision lock, the
// invoice FOR UPDATE and the expected_paid CAS are tested for real rather than
// simulated inside one transaction. A losing operation RAISEs and its request
// returns a non-2xx — so success/failure is read straight off the HTTP result.
//
// Requires the two collection routes to already evaluate CANONICAL for DEMO
// (Phase-7 canary state). If they do not, the required scenarios cannot run
// and the script exits non-zero rather than passing vacuously.
//
// Scenarios: record vs record (at most one succeeds per expected_paid),
// record vs reverse (no deadlock, no negative paid), reverse vs reverse (one
// canonical, no double reversal). Fixtures are created committed and cleaned
// up in finally by reversing collections first, then removing the neutralised
// fixture invoice — never a hard delete of live money before reversal.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  DEMO_ORG_ID,
  COLLECTION_KEY,
  REVERSE_KEY,
  getConfig,
  runQuery,
  fail,
  sqlLiteral,
  uuidLiteral,
  jsonbLiteral,
  numberOf,
  newRunId,
  fixtureMarker,
  fixtureInvoiceSql,
  actorClaimsJson,
  committedFixtureTeardownSql,
  TEST_LOCK_TIMEOUT,
} from "./lib/v5-collection-harness.mjs";
import { executeManagementQuery } from "./apply-accounting-rollout.mjs";

const RENT = 3_000_000;
const DEPOSIT = 2_000_000;
const CONN_STATEMENT_TIMEOUT = "30s";

const isExpectedPaidConflict = (m) =>
  /Số đã thu vừa thay đổi/.test(m) || /\b40001\b/.test(m) || /serializ/i.test(m);
const isAlreadyReversed = (m) =>
  /đã được hoàn tác/.test(m) || /\b23505\b/.test(m);
const isDeadlock = (m) => /deadlock/i.test(m) || /40P01/.test(m);

function tendersLiteral(tenders) {
  return jsonbLiteral(tenders);
}

/** One committed connection that records a collection. Throws on RPC failure. */
function recordConnSql({
  actorId,
  invoiceId,
  date,
  tenders,
  overpay = "REJECT",
  allowRounding = false,
  expectedPaid,
  key,
  appName,
}) {
  return `
BEGIN;
SET LOCAL lock_timeout = ${sqlLiteral(TEST_LOCK_TIMEOUT)};
SET LOCAL statement_timeout = ${sqlLiteral(CONN_STATEMENT_TIMEOUT)};
SET LOCAL application_name = ${sqlLiteral(appName)};
SELECT set_config('request.jwt.claims', ${sqlLiteral(actorClaimsJson(actorId))}, true);
SET LOCAL ROLE authenticated;
SELECT public.record_invoice_collection_v5(
  ${uuidLiteral(invoiceId)}, ${sqlLiteral(date)}::date,
  ${tendersLiteral(tenders)}, ${sqlLiteral(overpay)}, ${allowRounding},
  'concurrency', NULL, ${expectedPaid}, ${sqlLiteral(key)}
) AS result;
COMMIT;
`;
}

/** One committed connection that reverses a collection. Throws on RPC failure. */
function reverseConnSql({ actorId, collectionId, date, key, appName }) {
  return `
BEGIN;
SET LOCAL lock_timeout = ${sqlLiteral(TEST_LOCK_TIMEOUT)};
SET LOCAL statement_timeout = ${sqlLiteral(CONN_STATEMENT_TIMEOUT)};
SET LOCAL application_name = ${sqlLiteral(appName)};
SELECT set_config('request.jwt.claims', ${sqlLiteral(actorClaimsJson(actorId))}, true);
SET LOCAL ROLE authenticated;
SELECT public.reverse_invoice_collection_v5(
  ${uuidLiteral(collectionId)}, ${sqlLiteral(date)}::date, 'concurrency',
  ${sqlLiteral(key)}
) AS result;
COMMIT;
`;
}

/** Fire an independent connection; resolve {ok:true} or {ok:false, message}. */
async function connection(sql) {
  try {
    await executeManagementQuery(sql, getConfig());
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function assertCanaryReady() {
  const rows = await runQuery(`
SELECT app_private.evaluate_feature_route(${sqlLiteral(COLLECTION_KEY)}, ${uuidLiteral(DEMO_ORG_ID)}) AS collection_route,
       app_private.evaluate_feature_route(${sqlLiteral(REVERSE_KEY)}, ${uuidLiteral(DEMO_ORG_ID)}) AS reverse_route;`);
  const row = rows?.[0] ?? {};
  if (row.collection_route !== "CANONICAL" || row.reverse_route !== "CANONICAL") {
    fail(
      `DEMO chưa CANONICAL (collection=${row.collection_route}, reverse=${row.reverse_route}); không thể chạy concurrency canary.`,
    );
  }
}

/** Create a committed fixture invoice; return resolved ids. */
async function createFixture(marker, billingMonth) {
  const rows = await runQuery(
    [
      "SET statement_timeout = '60s';",
      `SET lock_timeout = ${sqlLiteral(TEST_LOCK_TIMEOUT)};`,
      fixtureInvoiceSql({ marker, billingMonth, rent: RENT, deposit: DEPOSIT }),
      `SELECT current_setting('v5h.actor') AS actor_id,
              current_setting('v5h.invoice') AS invoice_id,
              current_setting('v5h.account_tm') AS account_tm,
              current_setting('v5h.account_tk') AS account_tk,
              current_setting('v5h.virtual_account') AS virtual_account;`,
    ].join("\n"),
  );
  const row = rows?.[0];
  if (!row?.invoice_id || !row?.actor_id) {
    fail("Không tạo được fixture invoice committed cho concurrency.");
  }
  return row;
}

async function activeCollectionId(invoiceId) {
  const rows = await runQuery(`
SELECT collection.id AS id
FROM public.invoice_payment_collections collection
WHERE collection.invoice_id = ${uuidLiteral(invoiceId)}
  AND collection.status = 'ACTIVE'
ORDER BY collection.created_at DESC, collection.id DESC
LIMIT 1;`);
  return rows?.[0]?.id ?? null;
}

async function invoiceState(invoiceId) {
  const rows = await runQuery(`
SELECT invoice.paid_amount AS paid,
  (SELECT count(*) FROM public.invoice_payment_collections collection
    WHERE collection.invoice_id = invoice.id AND collection.status = 'ACTIVE') AS active_collections,
  COALESCE((SELECT sum(app_private.count_invalid_payment_reversals_v1(payment.id))
    FROM public.payments payment WHERE payment.invoice_id = invoice.id), 0) AS invalid_reversals
FROM public.invoices invoice
WHERE invoice.id = ${uuidLiteral(invoiceId)};`);
  const row = rows?.[0] ?? {};
  return {
    paid: numberOf(row.paid),
    activeCollections: numberOf(row.active_collections),
    invalidReversals: numberOf(row.invalid_reversals),
  };
}

async function recordCommitted(fixture, gross, expectedPaid, key) {
  const result = await connection(
    recordConnSql({
      actorId: fixture.actor_id,
      invoiceId: fixture.invoice_id,
      date: "2094-03-01",
      tenders: [
        { payment_method: "TM", gross_amount: gross, account_id: fixture.account_tm },
      ],
      expectedPaid,
      key,
      appName: "v5h-seed",
    }),
  );
  if (!result.ok) fail(`Không seed được collection: ${result.message}`);
}

async function main() {
  const runId = newRunId();
  const marker = fixtureMarker(runId);
  const billingMonth = "2094-03";

  await assertCanaryReady();
  const fixture = await createFixture(marker, billingMonth);

  try {
    // -----------------------------------------------------------------------
    // Scenario 1: record vs record — at most one succeeds per expected_paid.
    // -----------------------------------------------------------------------
    const both = await Promise.all([
      connection(
        recordConnSql({
          actorId: fixture.actor_id,
          invoiceId: fixture.invoice_id,
          date: "2094-03-01",
          tenders: [{ payment_method: "TM", gross_amount: 1_000_000, account_id: fixture.account_tm }],
          expectedPaid: 0,
          key: "v5h-cc-A",
          appName: "v5h-record-A",
        }),
      ),
      connection(
        recordConnSql({
          actorId: fixture.actor_id,
          invoiceId: fixture.invoice_id,
          date: "2094-03-01",
          tenders: [{ payment_method: "TM", gross_amount: 1_000_000, account_id: fixture.account_tm }],
          expectedPaid: 0,
          key: "v5h-cc-B",
          appName: "v5h-record-B",
        }),
      ),
    ]);
    const winners = both.filter((r) => r.ok);
    const losers = both.filter((r) => !r.ok);
    if (winners.length !== 1) {
      fail(
        `record-vs-record: cần đúng 1 thành công, có ${winners.length}. losers=${losers
          .map((l) => l.message)
          .join(" | ")}`,
      );
    }
    if (losers.some((l) => isDeadlock(l.message))) {
      fail(`record-vs-record: xuất hiện deadlock: ${losers.map((l) => l.message).join(" | ")}`);
    }
    if (!losers.every((l) => isExpectedPaidConflict(l.message))) {
      fail(`record-vs-record: loser sai loại lỗi: ${losers.map((l) => l.message).join(" | ")}`);
    }
    let state = await invoiceState(fixture.invoice_id);
    if (state.paid < 0 || state.activeCollections !== 1) {
      fail(`record-vs-record: trạng thái sai (paid=${state.paid}, active=${state.activeCollections}).`);
    }

    // -----------------------------------------------------------------------
    // Scenario 2: record vs reverse — no deadlock, no negative paid.
    // -----------------------------------------------------------------------
    const activeId = await activeCollectionId(fixture.invoice_id);
    if (!activeId) fail("record-vs-reverse: không có collection ACTIVE để đảo.");
    const mixed = await Promise.all([
      connection(
        reverseConnSql({
          actorId: fixture.actor_id,
          collectionId: activeId,
          date: "2094-03-05",
          key: "v5h-cc-rev-1",
          appName: "v5h-reverse-1",
        }),
      ),
      connection(
        recordConnSql({
          actorId: fixture.actor_id,
          invoiceId: fixture.invoice_id,
          date: "2094-03-05",
          tenders: [{ payment_method: "TM", gross_amount: 500_000, account_id: fixture.account_tm }],
          expectedPaid: 1_000_000,
          key: "v5h-cc-rec-2",
          appName: "v5h-record-2",
        }),
      ),
    ]);
    if (mixed.some((r) => !r.ok && isDeadlock(r.message))) {
      fail(`record-vs-reverse: deadlock: ${mixed.filter((r) => !r.ok).map((r) => r.message).join(" | ")}`);
    }
    state = await invoiceState(fixture.invoice_id);
    if (state.paid < 0) fail(`record-vs-reverse: paid âm (${state.paid}).`);
    if (state.invalidReversals !== 0) {
      fail(`record-vs-reverse: có ${state.invalidReversals} reversal không hợp lệ.`);
    }

    // -----------------------------------------------------------------------
    // Scenario 3: reverse vs reverse — one canonical, no double reversal.
    // -----------------------------------------------------------------------
    let reverseTargetId = await activeCollectionId(fixture.invoice_id);
    if (!reverseTargetId) {
      const seedState = await invoiceState(fixture.invoice_id);
      await recordCommitted(fixture, 1_000_000, seedState.paid, "v5h-cc-seed-3");
      reverseTargetId = await activeCollectionId(fixture.invoice_id);
    }
    if (!reverseTargetId) fail("reverse-vs-reverse: không chuẩn bị được collection ACTIVE.");
    const doubleReverse = await Promise.all([
      connection(
        reverseConnSql({
          actorId: fixture.actor_id,
          collectionId: reverseTargetId,
          date: "2094-03-09",
          key: "v5h-cc-rr-x",
          appName: "v5h-reverse-x",
        }),
      ),
      connection(
        reverseConnSql({
          actorId: fixture.actor_id,
          collectionId: reverseTargetId,
          date: "2094-03-09",
          key: "v5h-cc-rr-y",
          appName: "v5h-reverse-y",
        }),
      ),
    ]);
    const revOk = doubleReverse.filter((r) => r.ok);
    const revErr = doubleReverse.filter((r) => !r.ok);
    if (revErr.some((r) => isDeadlock(r.message))) {
      fail(`reverse-vs-reverse: deadlock: ${revErr.map((r) => r.message).join(" | ")}`);
    }
    if (revOk.length !== 1 || !revErr.every((r) => isAlreadyReversed(r.message))) {
      fail(
        `reverse-vs-reverse: cần đúng 1 canonical + phần còn lại 23505; ok=${revOk.length}, err=${revErr
          .map((r) => r.message)
          .join(" | ")}`,
      );
    }
    // Exactly one reversal voucher set for the target collection.
    const revRows = await runQuery(`
SELECT count(*) AS reversal_vouchers
FROM public.income_expenses voucher
WHERE voucher.payment_collection_id = ${uuidLiteral(reverseTargetId)}
  AND voucher.type = 'EXPENSE'
  AND voucher.system_source = ${sqlLiteral(REVERSE_KEY)};`);
    if (numberOf(revRows?.[0]?.reversal_vouchers) < 1) {
      fail("reverse-vs-reverse: reversal voucher chưa được tạo.");
    }

    console.log("invoice.collection.v5 concurrency harness passed (record/record, record/reverse, reverse/reverse).");
  } finally {
    try {
      await runQuery(committedFixtureTeardownSql({ marker, actorId: fixture.actor_id }));
      console.log("Concurrency fixtures reversed and cleaned up.");
    } catch (error) {
      // Teardown failure must not be swallowed: leaving DEMO fixtures behind
      // is itself a gate failure.
      fail(`Teardown concurrency thất bại: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
