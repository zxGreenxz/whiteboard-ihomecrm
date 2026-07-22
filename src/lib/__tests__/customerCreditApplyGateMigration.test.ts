import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// §B7 server-side fail-closed gate for customer credit forward-apply.
const sql = readFileSync(
  "supabase/migrations/20260722130000_customer_credit_apply_gate_v1.sql",
  "utf8",
).replace(/\r\n/g, "\n");

describe("customer credit apply gate (§B7 server fail-closed)", () => {
  it("installs a BEFORE INSERT trigger on customer_credit_lots", () => {
    expect(sql).toContain("BEFORE INSERT ON public.customer_credit_lots");
    expect(sql).toContain("a05_customer_credit_apply_gate");
    expect(sql).toContain(
      "app_private.guard_customer_credit_apply_gate_v1",
    );
  });

  it("fails closed (55000) unless customer.credit.apply.v1 is CANONICAL", () => {
    expect(sql).toContain(
      "evaluate_feature_route('customer.credit.apply.v1'",
    );
    expect(sql).toMatch(/v_route <> 'CANONICAL'/);
    expect(sql).toContain("55000");
  });

  it("is defense-in-depth only: never enables credit or flips a feature flag", () => {
    expect(sql).not.toMatch(/SET\s+mode\s*=/i);
    expect(sql).not.toMatch(/UPDATE\s+app_private\.server_feature_flags/i);
  });

  it("is idempotent / forward-only (safe to re-apply)", () => {
    expect(sql).toContain("CREATE OR REPLACE FUNCTION");
    expect(sql).toContain("DROP TRIGGER IF EXISTS a05_customer_credit_apply_gate");
  });

  it("pins a definer search_path and revokes PUBLIC execute", () => {
    expect(sql).toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(/SET search_path = pg_catalog, app_private, public/);
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
  });
});
