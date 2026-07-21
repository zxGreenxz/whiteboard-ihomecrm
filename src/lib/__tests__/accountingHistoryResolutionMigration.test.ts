import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const resolutionSql = readFileSync(
  "supabase/migrations/20260721132500_accounting_history_resolution_v1.sql",
  "utf8",
);
const gateSql = readFileSync(
  "supabase/migrations/20260721140500_accounting_rollout_gate_v1.sql",
  "utf8",
);
const auditScript = readFileSync("scripts/audit-accounting-rollout.mjs", "utf8");

describe("accounting history resolution", () => {
  it("classifies every reviewed termination A/R payment as non-cash", () => {
    expect(resolutionSql).toContain("SETTLEMENT_OFFSET_PAYMENT_CLASSIFICATION");
    expect(resolutionSql).toContain(
      "LINKED_SETTLEMENT_OFFSET_PAYMENT_CLASSIFICATION",
    );
    expect(resolutionSql).toContain("SET received_amount = 0");
    expect(resolutionSql).toContain("An unreviewed termination A/R offset");

    const reviewedIds = [
      "0da41bd1-b2e5-41ad-b52d-2ba970f2b05d",
      "1700ecac-c64a-42c6-b307-6f5d8475fd24",
      "6517aa8e-94db-4da3-b5d3-458a0caef620",
      "ae08077a-3d31-4d18-9f63-94020857c0bb",
      "bbc24923-8095-40a5-9952-f2d51857b596",
      "c111d6d6-6e64-4045-8b57-731ca10df15d",
      "e0c71b3b-a1d8-4a0e-a5bf-0d6fc97356bd",
      "dc490170-8e05-43e5-bcf9-1e6151dbbc5a",
      "6c914748-8956-4297-9e29-11c9d414c58b",
      "82f76140-511b-42c4-98e1-7c69013a2848",
      "afa53ef2-6c6d-4c43-8339-6ca2ab2f98ff",
      "b0d755d6-f2ab-4223-aeab-051e9c4dd140",
      "2c4c7cf9-e23f-47ba-8293-003844b3fede",
      "bc0eba99-a0ce-4042-b48a-94bb808f0704",
    ];
    for (const id of reviewedIds) expect(resolutionSql).toContain(id);
  });

  it("guards split deposit and gross/net-change repairs by exact provenance", () => {
    expect(resolutionSql).toContain("LEGACY_SPLIT_RECEIPT_CLASSIFICATION");
    expect(resolutionSql).toContain("LEGACY_SPLIT_DEPOSIT_RECLASSIFICATION");
    expect(resolutionSql).toContain("LEGACY_GROSS_NET_CHANGE_RECLASSIFICATION");
    expect(resolutionSql).toContain("'[THU TACH COC ' || v_row.payment_id::text");
    expect(resolutionSql).toContain("companion.business_result_accounting = false");
    expect(resolutionSql).toContain("change_expense.deleted_at IS NOT NULL");
    expect(resolutionSql).toContain("item.description");
  });

  it("repairs the real reversal and removes only exact DEMO artifacts", () => {
    expect(resolutionSql).toContain("SETTLEMENT_REVERSAL_SOURCE_RESTORATION");
    expect(resolutionSql).toContain("SETTLEMENT_PAYMENT_REVERSAL_REPAIR");
    expect(resolutionSql).toContain("_acct_demo_artifact_payments");
    expect(resolutionSql).toContain("invoice.billing_month >= '2027-01'");
    expect(resolutionSql).toContain("DEMO_DOCS_RECEIPT_BACKFILL");
    expect(resolutionSql).toContain("DEMO_REVERSAL_SOURCE_ROOM_BINDING");
  });
});

describe("accounting rollout gates", () => {
  it("binds every reversal to exact invoice, domain, and writer lineage", () => {
    expect(gateSql).toContain("exception.status = 'OPEN'");
    expect(gateSql).toContain(
      "CREATE OR REPLACE FUNCTION app_private.count_invalid_payment_reversals_v1",
    );

    const requiredPredicates = [
      "source_voucher.id IS DISTINCT FROM source_lineage.primary_source_id",
      "source_voucher.invoice_id IS DISTINCT FROM payment.invoice_id",
      "source_voucher.contract_id IS DISTINCT FROM invoice.contract_id",
      "source_voucher.building_id IS DISTINCT FROM invoice.building_id",
      "source_voucher.room_id IS DISTINCT FROM invoice.room_id",
      "voucher.contract_id IS DISTINCT FROM invoice.contract_id",
      "voucher.building_id IS DISTINCT FROM invoice.building_id",
      "voucher.room_id IS DISTINCT FROM invoice.room_id",
      "tender.payment_id IS DISTINCT FROM payment.id",
      "tender.voucher_id IS DISTINCT FROM source_voucher.id",
      "voucher.payment_collection_id IS DISTINCT FROM collection.id",
      "reversal_items.pnl_total - source_lineage.pnl_total",
      "reversal_items.deposit_total - source_lineage.deposit_total",
      "reversal_items.credit_total - source_lineage.credit_total",
      "reversal_items.internal_total - source_lineage.internal_total",
    ];
    for (const predicate of requiredPredicates) {
      expect(gateSql, predicate).toContain(predicate);
    }
    expect(gateSql).toContain("unresolved payout exceptions");
    expect(gateSql).toContain("profit.status = 'LOCKED'");
    expect(gateSql).toContain("profit.is_stale");
    expect(gateSql).toContain("stale locked profit periods");
    expect(gateSql).toContain("assert_accounting_feature_activation_v1");
    expect(gateSql).toContain("a10_accounting_feature_activation_guard");
    expect(gateSql).toContain("a10_accounting_canary_enrollment_guard");
    expect(gateSql).toContain("shareholder_profit.distribute.v2");
  });

  it("uses the same callable gate in audit and post-fixture mutation probes", () => {
    expect(auditScript).toContain("reversal_integrity_failures");
    expect(auditScript).toContain("openExceptionCount");
    expect(auditScript).toContain(
      "app_private.count_invalid_payment_reversals_v1()",
    );
    expect(auditScript).toContain("invalid_count");
    expect(auditScript).toContain("process.exit(1)");
    expect(auditScript).toContain("Accounting rollout audit blocked");

    const integrationScript = readFileSync(
      "scripts/test-accounting-chain.mjs",
      "utf8",
    );
    for (const mutation of [
      "source payment_id mutation",
      "source invoice_id mutation",
      "source contract_id mutation",
      "source building_id mutation",
      "source room_id mutation",
      "reversal contract_id mutation",
      "V5 tender/source mutation",
    ]) {
      expect(integrationScript).toContain(mutation);
    }
  });
});
