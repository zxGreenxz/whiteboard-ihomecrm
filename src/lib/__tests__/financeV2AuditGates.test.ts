import { describe, expect, it } from "vitest";

import { evaluateFinanceV2Audit, parseAuditResponse } from "../../../scripts/audit-finance-v2-rollout.mjs";

describe("Finance V2 audit gate evaluation (§10.5)", () => {
  it("treats pre-apply (schema not applied) as not-ready / build phase", () => {
    const e = evaluateFinanceV2Audit({ schema_applied: false });
    expect(e.cutoverReady).toBe(false);
    expect(e.phase).toBe("pre-apply");
  });

  it("is cutover-ready only when every hard gate is clean", () => {
    const clean = {
      schema_applied: true,
      backfill_exceptions: { income_expense: 0, cashbook_access: 0 },
      change_log_lag: 0,
      account_shared_users: 0,
    };
    expect(evaluateFinanceV2Audit(clean).cutoverReady).toBe(true);
  });

  it("blocks on backfill exceptions, change-log lag, or undrained sharing", () => {
    const dirty = {
      schema_applied: true,
      backfill_exceptions: { income_expense: 2, cashbook_access: 1 },
      change_log_lag: 5,
      account_shared_users: 15,
    };
    const e = evaluateFinanceV2Audit(dirty);
    expect(e.cutoverReady).toBe(false);
    expect(e.blockers.join(" ")).toContain("2 income_expense backfill exception");
    expect(e.blockers.join(" ")).toContain("5 unapplied change-log row");
    expect(e.blockers.join(" ")).toContain("15 undrained account_shared_users");
  });

  it("parses the Management API report row shape", () => {
    expect(parseAuditResponse(JSON.stringify([{ finance_v2_audit: { schema_applied: false } }]))).toEqual({
      schema_applied: false,
    });
    expect(() => parseAuditResponse(JSON.stringify([{ other: 1 }]))).toThrow(/no report row/);
  });
});
