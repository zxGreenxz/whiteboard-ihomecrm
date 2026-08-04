import { describe, expect, it } from "vitest";

/**
 * Query-plan evidence for the hot read paths, at a volume where a missing index
 * stops being invisible.
 *
 * These paths all look instant on a fixture with six rows, which is what every
 * other SQL harness here runs on. The failure they hide is the one that only
 * appears in production: a page of fifty conversations that reads every
 * conversation the account has ever had, and gets slower every week.
 *
 * The assertions are about PLAN SHAPE, never about time. PGlite is a
 * single-connection WebAssembly build; its timings say nothing about Supabase.
 * Its planner is real PostgreSQL, so "does this use the index" transfers and
 * "how many milliseconds" does not.
 */

const SEED_ROWS = 10_000;

async function seededDatabase() {
  const {
    createDisposableOpenClawDatabase,
    prepareDisposableConcurrencyFixtures,
    DEMO_ORG_ID,
  } = await import("../test-openclaw-migrations.mjs");

  const database = await createDisposableOpenClawDatabase();
  await prepareDisposableConcurrencyFixtures(database);

  const seed = await database.query(
    `select account_id, target_id from public.openclaw_conversations
      where organization_id = $1 limit 1`,
    [DEMO_ORG_ID],
  );
  expect(seed.rows.length, "fixture has no conversation to model").toBe(1);
  const { account_id: accountId, target_id: targetId } = seed.rows[0];

  // Triggers off while seeding: this is volume, not behaviour, and the row-level
  // guards would otherwise dominate the insert.
  await database.query("set session_replication_role='replica'");
  await database.query(
    `insert into public.openclaw_conversations
       (id, organization_id, account_id, target_id, provider_conversation_id,
        status, last_received_at, unread_count)
     select gen_random_uuid(), $1, $2, $3, 'planseed-' || g,
            (array['OPEN','CLOSED','ARCHIVED'])[1 + (g % 3)],
            now() - (g || ' minutes')::interval, g % 5
       from generate_series(1, ${SEED_ROWS}) g`,
    [DEMO_ORG_ID, accountId, targetId],
  );
  // Without ANALYZE the planner works from defaults and the plans mean nothing.
  await database.query("analyze public.openclaw_conversations");
  await database.query("set session_replication_role='origin'");

  return { database, accountId, organizationId: DEMO_ORG_ID };
}

/** Runs EXPLAIN (ANALYZE, BUFFERS) and reduces the tree to what can be asserted. */
async function explain(database, sql, params) {
  const result = await database.query(
    `explain (analyze, buffers, format json) ${sql}`,
    params,
  );
  const raw = result.rows[0]["QUERY PLAN"];
  const text = JSON.stringify(typeof raw === "string" ? JSON.parse(raw) : raw);
  return {
    text,
    seqScan: /"Node Type":"Seq Scan"/u.test(text),
    sort: /"Node Type":"Sort"/u.test(text),
    indexes: [...text.matchAll(/"Index Name":"([^"]+)"/gu)].map(match => match[1]),
    /** The most rows any single node actually touched. */
    peakRows: Math.max(
      ...[...text.matchAll(/"Actual Rows":(\d+)/gu)].map(match => Number(match[1])),
    ),
  };
}

describe("OpenClaw hot-path query plans at volume", () => {
  it("reads one page of the inbox without touching every conversation", async () => {
    // openclaw_list_conversations_v1 filters on (organization_id, account_id) and
    // orders by (last_received_at desc, id desc). It does NOT filter on status.
    // An index carrying status between the equality columns and the ordering
    // columns cannot serve that, so the planner falls back to reading everything
    // and sorting - fifty rows returned, ten thousand read.
    const { database, organizationId, accountId } = await seededDatabase();
    try {
      const plan = await explain(
        database,
        `select * from public.openclaw_conversations
          where organization_id = $1 and account_id = $2
          order by last_received_at desc, id desc limit 50`,
        [organizationId, accountId],
      );
      expect(plan.seqScan, `sequential scan on the inbox list: ${plan.indexes.join(",")}`)
        .toBe(false);
      expect(plan.sort, "sorting the whole account to return one page").toBe(false);
      // Generous ceiling: the point is O(page), not O(table).
      expect(plan.peakRows, "rows touched for a 50-row page").toBeLessThan(SEED_ROWS / 10);
    } finally {
      await database.close();
    }
  }, 120_000);

  it("makes the second page cost the same as the first", async () => {
    // Keyset pagination exists precisely so page 20 is not twenty times page 1. If
    // the cursor predicate cannot use an index, every page re-reads the table and
    // the design has bought nothing.
    const { database, organizationId, accountId } = await seededDatabase();
    try {
      const plan = await explain(
        database,
        `select * from public.openclaw_conversations
          where organization_id = $1 and account_id = $2
            and (last_received_at, id) < ($3::timestamptz, $4::uuid)
          order by last_received_at desc, id desc limit 50`,
        [organizationId, accountId, new Date(Date.now() - 60_000).toISOString(),
          "ffffffff-ffff-4fff-8fff-ffffffffffff"],
      );
      expect(plan.seqScan, "sequential scan on a cursor page").toBe(false);
      expect(plan.peakRows, "rows touched for a cursor page").toBeLessThan(SEED_ROWS / 10);
    } finally {
      await database.close();
    }
  }, 120_000);

  it("still serves the status-filtered list from an index", async () => {
    // The existing index is not wrong, it is just narrower than the query. This
    // pins the case it does serve, so a fix for the two above cannot quietly
    // regress it.
    const { database, organizationId, accountId } = await seededDatabase();
    try {
      const plan = await explain(
        database,
        `select * from public.openclaw_conversations
          where organization_id = $1 and account_id = $2 and status = 'OPEN'
          order by last_received_at desc, id desc limit 50`,
        [organizationId, accountId],
      );
      expect(plan.seqScan).toBe(false);
      expect(plan.indexes.length, "no index used for the status-filtered list")
        .toBeGreaterThan(0);
    } finally {
      await database.close();
    }
  }, 120_000);
});
