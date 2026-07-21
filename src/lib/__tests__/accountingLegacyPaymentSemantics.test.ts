import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const reportingSql = readFileSync(
  "supabase/migrations/20260721102000_active_payments_reporting.sql",
  "utf8",
);
const repairSql = readFileSync(
  "supabase/migrations/20260721130000_accounting_history_repair.sql",
  "utf8",
);

describe("legacy payment accounting semantics", () => {
  it("keeps normalized metadata rows net and only subtracts exact gross-era change vouchers", () => {
    expect(reportingSql).toContain(
      "CREATE OR REPLACE VIEW public.legacy_payment_receipt_semantics",
    );
    expect(reportingSql).toContain("'tiền thối hoá đơn%'");
    expect(reportingSql).toContain("'tiền thối hóa đơn%'");
    expect(reportingSql).toContain("expense.payment_id IS NULL");
    expect(reportingSql).toContain("THEN payment.amount");
    expect(reportingSql).toContain(
      "payment.amount - COALESCE(paired_change.change_amount, 0)",
    );
    expect(reportingSql).not.toMatch(
      /payment\.amount\s*-\s*(?:source_voucher\.)?change_amount/,
    );
  });

  it("reports legacy gross as retained plus change and preserves true credit", () => {
    expect(reportingSql).toContain(
      "semantic.retained_amount + semantic.change_amount AS gross_amount",
    );
    expect(reportingSql).toContain(
      "GREATEST(semantic.retained_amount - semantic.credit_amount, 0)",
    );
    expect(reportingSql).toContain(
      "FROM public.legacy_payment_receipt_semantics legacy",
    );
    expect(reportingSql).toContain("legacy.retained_amount AS collected_amount");
    expect(reportingSql).toContain("-legacy.retained_amount AS collected_amount");
  });

  it("repairs allocation windows from retained cash and stops on ambiguous change evidence", () => {
    expect(repairSql).toContain("WHEN payment.reversed_at IS NULL");
    expect(repairSql).toContain("THEN semantics.retained_amount");
    expect(repairSql).toContain(") OVER (");
    expect(repairSql).toContain(
      "v_credit := GREATEST(v_payment.retained_amount - v_applied, 0)",
    );
    expect(repairSql).toContain(
      "received_amount = v_payment.retained_amount",
    );
    expect(repairSql).toContain("UNMATCHED_LEGACY_CHANGE_EXPENSE");
    expect(repairSql).toContain("AMBIGUOUS_LEGACY_CHANGE_EXPENSE");
    expect(repairSql).toContain("UNRESOLVED_LEGACY_CHANGE_CONTEXT");
    expect(repairSql).toContain("CONFLICTING_LEGACY_CHANGE_EVIDENCE");
  });
});
