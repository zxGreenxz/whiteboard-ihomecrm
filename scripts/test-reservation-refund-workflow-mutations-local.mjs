#!/usr/bin/env node
// Mutations only in the disposable loopback DB. Exact definitions are restored in finally.
import pg from "pg";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { bam, bienDoi } from "./dot-bien.mjs";
const db = new pg.Client({
  connectionString: "postgresql://postgres@127.0.0.1:55488/postgres",
});
function proof() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/test-reservation-refund-workflow-local.mjs"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
await db.connect();
try {
  const mutations = [
    {
      name: "revoked source permission before replay",
      signature: "public.create_reservation_refund_pending_v1(jsonb)",
      mutate: (text) =>
        text.replace(
          /IF NOT COALESCE\(\(SELECT allowed FROM app_private.authorize_tenant_action_v3\(uid,s.organization_id,'deposits.refund',s.building_id,NULL\)\),false\) THEN[\s\S]*?END IF;/,
          "-- removed source permission",
        ),
      expected: /403|revoked|replay/,
    },
    {
      name: "frozen remaining CAS at creation",
      signature: "public.create_reservation_refund_pending_v1(jsonb)",
      mutate: (text) =>
        text.replace(
          " OR (p_input->>'expectedRemaining')::numeric IS DISTINCT FROM remaining",
          "",
        ),
      expected: /pending creation cannot change full remaining/,
    },
    {
      name: "old pay cannot bypass a pending review voucher",
      signature: "app_private.reservation_pay_refund_v1(uuid,uuid,date)",
      mutate: (text) =>
        text.replace(
          /  IF EXISTS\([\s\S]*?END IF;/,
          "-- removed live pending refund guard",
        ),
      expected: /old pay must not create a second refund|pending|duplicate/,
    },
    {
      name: "posting CAS remains client-reviewed",
      signature: "public.execute_reservation_refund_action_v1(jsonb)",
      mutate: (text) =>
        text.replace(
          "  OR (p_input->>'expectedPostingVersion')::bigint IS DISTINCT FROM v.posting_version",
          "",
        ),
      expected: /stale|version|CAS/,
    },
  ];
  for (const test of mutations) {
    const original = (
      await db.query(
        "SELECT pg_get_functiondef($1::regprocedure) body,md5(pg_get_functiondef($1::regprocedure)) hash",
        [test.signature],
      )
    ).rows[0];
    const changed = bienDoi(original.body, {
      tim: original.body,
      thay: test.mutate(original.body),
    }).moi;
    assert.notEqual(
      bam(changed),
      bam(original.body),
      "digest must change before running suite",
    );
    assert.notEqual(changed, original.body, test.name + " must alter guard");
    try {
      await db.query(changed);
      const result = await proof();
      assert.notEqual(result.code, 0, test.name + " escaped actual JWT suite");
      assert.match(
        result.output,
        test.expected,
        test.name + ": unexpected failure\n" + result.output,
      );
      console.log(
        "KILLED " +
          test.name +
          " sha256 " +
          bam(original.body).slice(0, 12) +
          " -> " +
          bam(changed).slice(0, 12),
      );
    } finally {
      await db.query(original.body);
      assert.equal(
        (
          await db.query(
            "SELECT md5(pg_get_functiondef($1::regprocedure)) hash",
            [test.signature],
          )
        ).rows[0].hash,
        original.hash,
      );
    }
  }
  console.log(
    "PASS actual JWT monetary/authority mutations; exact definitions restored",
  );
} finally {
  await db.end();
}
