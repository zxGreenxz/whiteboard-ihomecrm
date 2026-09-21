#!/usr/bin/env node
// Local-only schema mutations, role rehearsal and first/reapply are rolled back.
import fs from "node:fs";
import assert from "node:assert/strict";
import pg from "pg";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
const db = new pg.Client({
  connectionString: "postgresql://postgres@127.0.0.1:55488/postgres",
});
const file =
  "supabase/migrations/20260921015956_reservation_refund_pending_workflow.sql";
const sql = fs
  .readFileSync(file, "utf8")
  .replace(/^BEGIN;$/m, "")
  .replace(/^COMMIT;$/m, "");
const pins = [
  ...sql.matchAll(
    /\('([^']+)','([a-f0-9]{32})','([a-f0-9]{32})','([^']+)',ARRAY\[([^\]]+)\]::text\[\],(true|false)\)/g,
  ),
].map((m) => ({
  signature: m[1],
  before: m[2],
  after: m[3],
  owner: m[4],
  required: m[6] === "true",
}));
assert.ok(pins.length > 30, "actual SQL preflight pins parsed");
async function rollback(fn) {
  await db.query("BEGIN");
  try {
    await fn();
  } finally {
    await db.query("ROLLBACK");
  }
}
function definition(path, name) {
  const s = fs
      .readFileSync(path, "utf8")
      .replace(/CREATE FUNCTION/gi, "CREATE OR REPLACE FUNCTION"),
    start = s
      .toLowerCase()
      .indexOf("create or replace function " + name.toLowerCase() + "(");
  assert.notEqual(start, -1, name);
  const part = s.slice(start),
    d = part.match(/AS\s+(\$[a-zA-Z_]*\$)/i)[1],
    end = part.indexOf(d, part.indexOf(d) + d.length);
  return part.slice(0, part.indexOf(";", end + d.length) + 1);
}
async function original() {
  for (const [path, name] of [
    [
      "supabase/migrations/20260920182530_shared_income_expense_review_transitions.sql",
      "app_private.authorize_income_expense_review_v1",
    ],
    [
      "supabase/migrations/20260910015750_reservation_refund_evidence_and_creator_v1.sql",
      "app_private.reservation_create_leg_v1",
    ],
    [
      "supabase/migrations/20260909172332_reservation_deposit_settlement_v1.sql",
      "app_private.reservation_pay_refund_v1",
    ],
    [
      "supabase/migrations/20260920200252_shared_income_expense_action_capabilities.sql",
      "app_private.income_expense_action_capabilities_v1",
    ],
  ])
    await db.query(definition(path, name));
  const sig =
    "app_private.finance_v2_post_manual_voucher(income_expenses,uuid,uuid,uuid,date,uuid[],text)";
  const current = (
    await db.query("select pg_get_functiondef($1::regprocedure) def", [sig])
  ).rows[0].def;
  const expr =
    "CASE WHEN app_private.reservation_refund_dispatch_authorized_v1(p_ie.organization_id,p_ie.id,NULL) THEN 'RESERVATION_REFUND' ELSE 'MANUAL' END";
  assert.ok(current.includes(expr));
  await db.query(current.replace(expr, "'MANUAL'"));
  for (const p of pins.filter((x) => x.required && x.before !== x.after))
    assert.equal(
      (
        await db.query(
          "select md5(pg_get_functiondef($1::regprocedure)) hash",
          [p.signature],
        )
      ).rows[0].hash,
      p.before,
      p.signature + " predecessor",
    );
  for (const p of pins.filter((x) => !x.required))
    await db.query("DROP FUNCTION " + p.signature);
}
await db.connect();
try {
  await rollback(async () => {
    await db.query(sql);
    await db.query(sql);
  });
  await rollback(async () => {
    await original();
    await db.query(sql);
    await db.query(sql);
  });
  console.log(
    "PASS first + reapply from exact hash-pinned predecessor definitions",
  );
  for (const p of pins) {
    await rollback(async () => {
      await db.query(
        "ALTER FUNCTION " + p.signature + " SET search_path=public",
      );
      await assert.rejects(db.query(sql), /definition drift/i);
    });
  }
  for (const p of pins.filter((x) => !x.required || x.before !== x.after)) {
    await rollback(async () => {
      await db.query("GRANT EXECUTE ON FUNCTION " + p.signature + " TO anon");
      await assert.rejects(db.query(sql), /ACL drift/i);
    });
  }
  await rollback(async () => {
    await db.query("ALTER ROLE ie_action_snapshot_reader BYPASSRLS");
    await assert.rejects(db.query(sql), /role drift/i);
  });
  for (const [relation, name] of [
    ["public.income_expenses", "a01_reservation_voucher_guard"],
    [
      "public.reservation_deposit_settlements",
      "reservation_settlement_record_guard",
    ],
    ["public.contract_deposit_links", "a01_reservation_contract_link_guard"],
  ])
    await rollback(async () => {
      await db.query("ALTER TABLE " + relation + " DISABLE TRIGGER " + name);
      await assert.rejects(db.query(sql), /trigger drift/i);
    });
  await rollback(async () => {
    await db.query(
      "GRANT INSERT ON app_private.reservation_settlement_write_tokens TO authenticated",
    );
    await assert.rejects(db.query(sql), /token ACL drift/i);
  });
  const literal = fs
    .readFileSync("scripts/check-stable-fn-locks.mjs", "utf8")
    .match(/const sql = (`[\s\S]*?`);/)[1];
  const violations = (await db.query(vm.runInNewContext(literal))).rows.filter(
    (x) => pins.some((p) => p.signature.includes(x.fn_name + "(")),
  );
  assert.deepEqual(violations, [], "transitive STABLE read-only gate");
  console.log(
    "PASS all definition pins + new/modified ACL + reader role + source trigger + token ACL drift and transitive STABLE",
  );
  const deploy = "t6r_deploy_" + randomUUID().replaceAll("-", "");
  try {
    await db.query(
      "CREATE ROLE " +
        deploy +
        " NOLOGIN NOSUPERUSER CREATEROLE NOCREATEDB BYPASSRLS INHERIT",
    );
    await db.query("GRANT postgres TO " + deploy);
    await db.query("GRANT authenticated TO " + deploy + " WITH ADMIN TRUE");
    await rollback(async () => {
      await original();
      await db.query(
        "GRANT USAGE,CREATE ON SCHEMA public,app_private TO " + deploy,
      );
      await db.query("SET LOCAL SESSION AUTHORIZATION " + deploy);
      await db.query(sql);
      await db.query(sql);
    });
  } finally {
    await db.query("DROP ROLE IF EXISTS " + deploy);
  }
  console.log(
    "PASS measured non-superuser first apply + reapply; all schema mutations rolled back",
  );
} finally {
  await db.end();
}
