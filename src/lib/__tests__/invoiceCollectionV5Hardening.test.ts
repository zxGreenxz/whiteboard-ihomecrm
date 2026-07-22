import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260722120000_invoice_collection_v5_hardening.sql",
  "utf8",
).replace(/\r\n/g, "\n");

describe("invoice collection V5 hardening migration", () => {
  it("is an assert-only forward guard wrapped in a single transaction", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
    expect(sql).toContain("DO $hardening$");
    expect(sql).toMatch(/NOTIFY pgrst, 'reload schema';\s*$/);

    // NOTIFY must sit AFTER COMMIT, never inside the asserting transaction.
    expect(sql.indexOf("NOTIFY pgrst")).toBeGreaterThan(
      sql.lastIndexOf("COMMIT;"),
    );
  });

  it("never flips a feature-flag mode", () => {
    // The whole point of a hardening guard is that it does not change rollout
    // state. A mode-flip UPDATE here would silently activate a money route.
    expect(sql).not.toMatch(/SET\s+mode\s*=/i);
    expect(sql).not.toMatch(/UPDATE\s+app_private\.server_feature_flags/i);
  });

  it("never redefines the money writers", () => {
    expect(sql).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.record_invoice_collection_v5/i,
    );
    expect(sql).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.reverse_invoice_collection_v5/i,
    );
    expect(sql).not.toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.undo_invoice_payment_compat_v1/i,
    );
    // And it must not create/replace or drop objects at all beyond asserting.
    expect(sql).not.toMatch(/\bCREATE\s+OR\s+REPLACE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|FUNCTION|TRIGGER|VIEW|SCHEMA)\b/i);
  });

  it("asserts the security posture of all three money writers", () => {
    for (const signature of [
      "public.record_invoice_collection_v5(uuid, date, jsonb, text, boolean, text, text, numeric, text)",
      "public.reverse_invoice_collection_v5(uuid, date, text, text)",
      "public.undo_invoice_payment_compat_v1(uuid, text, text)",
    ]) {
      expect(sql).toContain(signature);
    }

    // SECURITY DEFINER + pinned search_path + permitted owner.
    expect(sql).toContain("p.prosecdef");
    expect(sql).toContain("NOT v_secdef");
    expect(sql).toContain("^search_path=pg_catalog");
    expect(sql).toContain("pg_get_userbyid(p.proowner)");
    expect(sql).toContain("NOT IN ('postgres', 'supabase_admin')");

    // ACL must not leak EXECUTE to anon or service_role, but authenticated keeps it.
    expect(sql).toContain("has_function_privilege('anon', v_oid, 'EXECUTE')");
    expect(sql).toContain(
      "has_function_privilege('service_role', v_oid, 'EXECUTE')",
    );
    expect(sql).toContain(
      "has_function_privilege('authenticated', v_oid, 'EXECUTE')",
    );
  });

  it("asserts the canonical-link guard triggers are installed", () => {
    expect(sql).toContain("a00_payment_canonical_link_guard");
    expect(sql).toContain("a00_income_expense_accounting_links_guard");
    expect(sql).toContain("NOT tg.tgisinternal");
  });

  it("asserts both V5 routes exist and are MONEY", () => {
    expect(sql).toContain("'invoice.collection.v5'");
    expect(sql).toContain("'invoice.collection.reverse.v5'");
    expect(sql).toContain("risk_class = 'MONEY'");
    expect(sql).toContain("app_private.server_feature_flags");
  });

  it("asserts the ACTIVE collection balance invariant via SELECT ... HAVING", () => {
    expect(sql).toContain("public.invoice_payment_collections");
    expect(sql).toContain("c.status = 'ACTIVE'");
    expect(sql).toMatch(/GROUP BY[\s\S]*?HAVING/);
    expect(sql).toContain(
      "c.applied_amount + c.change_amount + c.credit_amount",
    );
    expect(sql).toContain("sum(t.gross_amount)");
  });

  it("fails closed with 55000 on every violated invariant", () => {
    const raises = [...sql.matchAll(/RAISE EXCEPTION/g)];
    const errcodes = [...sql.matchAll(/USING ERRCODE = '55000'/g)];
    // Every RAISE in this guard must carry the 55000 fail-closed code.
    expect(raises.length).toBeGreaterThanOrEqual(8);
    expect(errcodes.length).toBe(raises.length);
  });
});
