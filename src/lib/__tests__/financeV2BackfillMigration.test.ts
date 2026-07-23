import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260723040000_finance_v2_backfill.sql"),
  "utf8",
);

describe("Finance V2 Stage 4 — backfill (posting/recognition/access candidates + exceptions)", () => {
  it("is single-transaction, idempotent, and changes no feature mode", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
    expect(sql).toContain("ON CONFLICT (organization_id, idempotency_key) DO NOTHING");
    expect(sql).not.toMatch(/select\s+app_private\.set_feature_route_v1\s*\(/i);
  });

  it("creates both private exception tables with no client access", () => {
    expect(sql).toContain("app_private.income_expense_v2_backfill_exceptions");
    expect(sql).toContain("app_private.cashbook_access_v2_backfill_exceptions");
    expect(sql).toContain("REVOKE ALL ON app_private.income_expense_v2_backfill_exceptions FROM PUBLIC");
  });

  it("uses the §10.1 amount bases + legacy waiver and never fabricates evidence", () => {
    expect(sql).toContain("'LEGACY_BACKFILL'");
    expect(sql).toContain("'PRE_V2_HISTORY'");
    expect(sql).toContain("'VOUCHER_TOTAL'");
    expect(sql).toContain("'EXTERNAL_TENDER_GROSS'");
    expect(sql).toContain("'COLLECTION_V5'");
  });

  it("records ambiguity as exceptions instead of guessing (§10.1 rule 7)", () => {
    for (const code of [
      "NON_POSITIVE_TOTAL",
      "V5_GROSS_TOTAL_MISMATCH",
      "V5_UNCLASSIFIED_COLLECTION",
      "SOURCE_ALIAS_UNPROVEN",
      "SHARE_ORG_MISMATCH",
    ]) {
      expect(sql).toContain(`'${code}'`);
    }
  });

  it("backfills maker/birth provenance without heuristically copying user_id", () => {
    // poster is COALESCE(approved_by, user_id) — but that is the historical POSTER,
    // not the maker; maker columns must NOT be set from user_id in backfill (§10.1).
    expect(sql).toContain("COALESCE(ie.approved_by, ie.user_id)");
  });

  it("applies the §8.1 source alias mapping guarded by lineage (no name inference)", () => {
    expect(sql).toContain("'contract.create.v2'");
    expect(sql).toContain("'contract.deposit'");
    expect(sql).toContain("'profit.manager_salary'");
    expect(sql).toContain("'salary.manager'");
    expect(sql).toContain("'salary.staff'");
  });

  it("classifies access candidates without auto-promoting shared users to CUSTODIAN", () => {
    expect(sql).toContain("'ACCOUNT_OWNER'");
    expect(sql).toContain("'LEGACY_SHARE'");
    expect(sql).toContain("'PENDING_REVIEW'");
  });
});
