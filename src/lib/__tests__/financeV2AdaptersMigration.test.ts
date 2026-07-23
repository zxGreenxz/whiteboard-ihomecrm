import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260723060000_finance_v2_system_writer_adapters.sql"),
  "utf8",
);

describe("Finance V2 Stage 6 — system-writer adapters + flow-owner dispatch", () => {
  it("is a single-transaction migration that changes no feature mode", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
    expect(sql).not.toMatch(/select\s+app_private\.set_feature_route_v1\s*\(/i);
  });

  it("has a fail-closed flow-owner -> adapter registry (unknown owner never falls back to manual)", () => {
    expect(sql).toContain("app_private.finance_flow_owner_adapters");
    expect(sql).toContain("app_private.dispatch_finance_decision_v2");
    // fail closed: unknown owner raises, does not manual-fallback
    expect(sql).toMatch(/fail closed|unknown flow owner/i);
    for (const owner of [
      "'MANUAL'",
      "'INVOICE_REFUND'",
      "'SALARY_BUNDLE'",
      "'PROFIT_PAYOUT'",
      "'TERMINATION_FORFEIT_PAIR_V2'",
      "'TERMINATION_MOVE_OUT_PAIR'",
    ]) {
      expect(sql).toContain(owner);
    }
  });

  it("defines the private adapters that WRAP the landed invariants (§7.1)", () => {
    for (const fn of [
      "post_collection_tender_v2",
      "reverse_collection_tender_v2",
      "reserve_invoice_refund_obligation_v2",
      "transition_invoice_refund_reservation_v2",
      "transition_salary_settlement_bundle_v2",
      "post_salary_settlement_tranche_v2",
      "transition_profit_payout_reservation_v2",
      "transition_termination_forfeit_pair_v2",
      "transition_termination_move_out_pair_v2",
      "enqueue_deferred_customer_credit_v2",
      "register_system_evidence_v2",
    ]) {
      expect(sql).toContain(fn);
    }
  });

  it("gates commission/salary adapters on a §2.6 business-policy decision", () => {
    expect(sql).toContain("requires_policy_key");
    expect(sql).toContain("contract.commission.settlement.v2");
    expect(sql).toContain("salary.settlement.v2");
    expect(sql).toContain("finance_business_policy_decisions");
  });

  it("registers V5 tender postings with per-tender external provenance + system evidence", () => {
    expect(sql).toContain("EXTERNAL_TENDER_GROSS");
    expect(sql).toContain("COLLECTION_V5");
  });
});
