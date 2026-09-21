#!/usr/bin/env node
// Loopback only. Schema/ACL mutations and non-superuser rehearsal always roll back.
import assert from "node:assert/strict";
import fs from "node:fs";
import pg from "pg";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
const db = new pg.Client({
  connectionString: "postgresql://postgres@127.0.0.1:55488/postgres",
});
const files = [
  "supabase/migrations/20260920212716_contract_settlement_source_creation_reader.sql",
  "supabase/migrations/20260920235851_termination_refund_creation_recipient.sql",
];
const bodies = files.map((f) =>
  fs
    .readFileSync(f, "utf8")
    .replace(/^BEGIN;$/m, "")
    .replace(/^COMMIT;$/m, ""),
);
const claimBody = fs
  .readFileSync(
    "supabase/migrations/20260921004515_sale_bonus_explicit_source_claim_guard.sql",
    "utf8",
  )
  .replace(/^BEGIN;$/m, "")
  .replace(/^COMMIT;$/m, "");
const claimLookup = "app_private.sale_bonus_source_claims_v1(uuid,uuid,uuid)",
  claimGuard = "app_private.guard_sale_bonus_source_claim_v1()",
  commission =
    "public.create_commission_voucher(uuid,text,numeric,date,uuid,text,text,text,text,text,jsonb)",
  depositWriter =
    "public.create_sale_bonus_from_deposit_v1(uuid,numeric,text,text,text,date,uuid,jsonb)";
function definition(file, name, delimiter) {
  const text = fs.readFileSync(file, "utf8");
  const start = text.indexOf("CREATE OR REPLACE FUNCTION " + name + "(");
  assert.notEqual(start, -1, name);
  const end = text.indexOf(
    delimiter + ";",
    text.indexOf(delimiter, start) + delimiter.length,
  );
  assert.notEqual(end, -1, name);
  return text.slice(start, end + delimiter.length + 1);
}
async function restorePreClaim() {
  for (const [relation, name] of [
    ["public.contract_deposit_links", "guard_sale_bonus_link_claim"],
    ["app_private.sale_bonus_claims", "guard_sale_bonus_deposit_claim"],
    ["public.income_expenses", "guard_sale_bonus_voucher_claim"],
  ])
    await db.query("DROP TRIGGER IF EXISTS " + name + " ON " + relation);
  await db.query(
    definition(
      "supabase/migrations/20260902100049_ten_phieu_hoa_hong_theo_phong_va_ghi_chu_luc_xem.sql",
      "public.create_commission_voucher",
      "$function$",
    ),
  );
  await db.query(
    definition(
      "supabase/migrations/20260820090000_sale_bonus_deposit_account_attachments.sql",
      "public.create_sale_bonus_from_deposit_v1",
      "$fn$",
    ),
  );
  await db.query(
    definition(
      files[0],
      "app_private.contract_settlement_create_facts_v1",
      "$facts$",
    ),
  );
  await db.query("DROP FUNCTION IF EXISTS " + claimGuard);
  await db.query("DROP FUNCTION IF EXISTS " + claimLookup);
}
async function rollbackPreClaim(fn) {
  await rollback(async () => {
    await restorePreClaim();
    await fn();
  });
}
const reader =
    "public.read_contract_settlement_create_source_v1(uuid,text,uuid,numeric)",
  facts = "app_private.contract_settlement_create_facts_v1(uuid,text,uuid)",
  core =
    "app_private.create_termination_refund_voucher_with_recipient_v1(uuid,uuid,boolean,text,text,text,text)",
  legacy =
    "public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text)",
  recipient =
    "public.create_termination_refund_voucher_v1(uuid,uuid,boolean,text,text,text,text)";
async function rollback(fn) {
  await db.query("BEGIN");
  try {
    await fn();
  } finally {
    await db.query("ROLLBACK");
  }
}
await db.connect();
try {
  await rollbackPreClaim(async () => {
    for (const b of bodies) await db.query(b);
    for (const b of bodies) await db.query(b);
  });
  for (const [signature, index] of [
    [reader, 0],
    [facts, 0],
    [core, 1],
    [legacy, 1],
    [recipient, 1],
  ])
    await rollbackPreClaim(async () => {
      await db.query(`ALTER FUNCTION ${signature} SET search_path=public`);
      await assert.rejects(db.query(bodies[index]), /definition drift/i);
    });
  for (const [signature, index, role] of [
    [reader, 0, "anon"],
    [facts, 0, "authenticated"],
    [core, 1, "authenticated"],
    [recipient, 1, "anon"],
  ])
    await rollbackPreClaim(async () => {
      await db.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${role}`);
      await assert.rejects(db.query(bodies[index]), /ACL drift/i);
    });
  for (const [signature, index] of [
    [facts, 0],
    [core, 1],
    [recipient, 1],
  ])
    await rollbackPreClaim(async () => {
      await db.query(
        `ALTER FUNCTION ${signature} OWNER TO ie_action_snapshot_reader`,
      );
      await assert.rejects(db.query(bodies[index]), /owner\/ACL drift/i);
    });
  await rollbackPreClaim(async () => {
    await db.query("ALTER ROLE ie_action_snapshot_reader BYPASSRLS");
    await assert.rejects(db.query(bodies[0]), /role drift/i);
  });
  await rollback(async () => {
    await db.query(claimBody);
    await db.query(claimBody);
  });
  for (const signature of [
    commission,
    depositWriter,
    facts,
    claimLookup,
    claimGuard,
  ])
    await rollback(async () => {
      await db.query("ALTER FUNCTION " + signature + " SET search_path=public");
      await assert.rejects(db.query(claimBody), /definition drift/i);
    });
  for (const [signature, role] of [
    [commission, "anon"],
    [depositWriter, "anon"],
    [facts, "authenticated"],
    [claimLookup, "authenticated"],
    [claimGuard, "authenticated"],
  ])
    await rollback(async () => {
      await db.query("GRANT EXECUTE ON FUNCTION " + signature + " TO " + role);
      await assert.rejects(db.query(claimBody), /ACL drift/i);
    });
  for (const [relation, name] of [
    ["public.contract_deposit_links", "guard_sale_bonus_link_claim"],
    ["app_private.sale_bonus_claims", "guard_sale_bonus_deposit_claim"],
    ["public.income_expenses", "guard_sale_bonus_voucher_claim"],
  ])
    await rollback(async () => {
      await db.query("ALTER TABLE " + relation + " DISABLE TRIGGER " + name);
      await assert.rejects(db.query(claimBody), /trigger drift/i);
    });
  for (const signature of [claimLookup, claimGuard])
    await rollback(async () => {
      await db.query(
        "ALTER FUNCTION " + signature + " OWNER TO ie_action_snapshot_reader",
      );
      await assert.rejects(db.query(claimBody), /owner\/ACL drift/i);
    });
  assert.deepEqual(
    (
      await db.query(
        "SELECT has_function_privilege('authenticated',$1,'EXECUTE') allowed,has_function_privilege('ie_action_snapshot_reader',$1,'EXECUTE') reader_allowed",
        [claimLookup],
      )
    ).rows[0],
    { allowed: false, reader_allowed: false },
  );
  const acl = (
    await db.query(
      `SELECT has_function_privilege('authenticated',$1,'EXECUTE') reader,has_function_privilege('authenticated',$2,'EXECUTE') facts,has_function_privilege('ie_action_snapshot_reader',$2,'EXECUTE') reader_facts,has_function_privilege('authenticated',$3,'EXECUTE') core,has_function_privilege('ie_action_snapshot_reader',$3,'EXECUTE') reader_core,has_function_privilege('authenticated',$4,'EXECUTE') recipient,has_function_privilege('anon',$4,'EXECUTE') anon_recipient,has_function_privilege('service_role',$4,'EXECUTE') service_recipient,pg_has_role('authenticated','ie_action_snapshot_reader','SET') client_set`,
      [reader, facts, core, recipient],
    )
  ).rows[0];
  assert.deepEqual(acl, {
    reader: true,
    facts: false,
    reader_facts: true,
    core: false,
    reader_core: false,
    recipient: true,
    anon_recipient: false,
    service_recipient: false,
    client_set: false,
  });
  const literal = fs
    .readFileSync("scripts/check-stable-fn-locks.mjs", "utf8")
    .match(/const sql = (`[\s\S]*?`);/)[1];
  assert.equal(
    (await db.query(vm.runInNewContext(literal))).rows.filter((r) =>
      [
        "read_contract_settlement_create_source_v1",
        "contract_settlement_create_facts_v1",
        "sale_bonus_source_claims_v1",
      ].includes(r.fn_name),
    ).length,
    0,
  );
  const deploy = "t6_deployer_" + randomUUID().replaceAll("-", "");
  try {
    await db.query(
      `CREATE ROLE ${deploy} NOLOGIN NOSUPERUSER CREATEROLE NOCREATEDB BYPASSRLS INHERIT`,
    );
    await db.query(`GRANT postgres TO ${deploy}`);
    await db.query(`GRANT authenticated TO ${deploy} WITH ADMIN TRUE`);
    await rollbackPreClaim(async () => {
      const previous = fs
        .readFileSync(
          "supabase/migrations/20260828090000_termination_refund_writer_hardening.sql",
          "utf8",
        )
        .match(
          /CREATE OR REPLACE FUNCTION public\.create_termination_refund_voucher_v1[\s\S]*?\$function\$;/,
        )[0];
      await db.query(previous);
      assert.equal(
        (
          await db.query(
            "SELECT md5(pg_get_functiondef($1::regprocedure)) hash",
            [legacy],
          )
        ).rows[0].hash,
        "cdc2896ff50e836cb782219683ba5474",
      );
      for (const signature of [recipient, core, reader, facts])
        await db.query(`DROP FUNCTION ${signature}`);
      // Shared postgres preflight has CREATE/USAGE on both schemas. Model those measured privileges explicitly.
      await db.query(
        `GRANT USAGE,CREATE ON SCHEMA public,app_private TO ${deploy}`,
      );
      await db.query(`SET LOCAL SESSION AUTHORIZATION ${deploy}`);
      for (const b of bodies) await db.query(b);
      for (const b of bodies) await db.query(b);
      await db.query(claimBody);
      await db.query(claimBody);
    });
  } finally {
    await db.query(`DROP ROLE IF EXISTS ${deploy}`);
  }
  console.log(
    "PASS T6 reader/refund migration first apply + reapply under non-superuser, definition/owner/ACL/role/claim-trigger drift, explicit Sale bridge first/reapply, private core isolation, transitive STABLE gate; mutations rolled back.",
  );
} finally {
  await db.end();
}
