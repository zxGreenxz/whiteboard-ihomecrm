import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH =
  "supabase/migrations/20260728030000_business_performance_invoice_cohort_and_categories.sql";

function migrationSql(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

describe("business-performance cohort, cash and category migration", () => {
  it("creates canonical invoice-component and immutable allocation ledgers", () => {
    const sql = migrationSql();

    expect(sql).toContain("CREATE TABLE public.finance_invoice_component_manifests");
    expect(sql).toContain("CREATE TABLE public.finance_invoice_components");
    expect(sql).toContain("CREATE TABLE public.finance_invoice_component_allocations");
    expect(sql).toContain("CURRENT_CHARGE");
    expect(sql).toContain("CARRIED_INVOICE_DEBT");
    expect(sql).toContain("CARRIED_DEPOSIT_DEBT");
    expect(sql).toContain("CURRENT_DEPOSIT");
    expect(sql).toContain("INTERNAL");
    expect(sql).toContain("SETTLEMENT");
    expect(sql).toContain("UNCLASSIFIED");
    expect(sql).toContain("COMPLETE");
    expect(sql).toContain("ANOMALY");
    expect(sql).toContain("finance_invoice_component_allocations_immutable_guard");
  });

  it("keeps ledgers private with tenant constraints, RLS and supporting indexes", () => {
    const sql = migrationSql();
    const tables = [
      "finance_invoice_component_manifests",
      "finance_invoice_components",
      "finance_invoice_component_allocations",
    ];

    for (const table of tables) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(
        `REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated`,
      );
    }
    expect(sql).toContain("finance_invoice_component_manifests_invoice_uq");
    expect(sql).toContain("finance_invoice_components_manifest_kind_uq");
    expect(sql).toContain("finance_invoice_component_allocations_collection_component_uq");
    expect(sql).toContain("finance_invoice_component_allocations_component_idx");
  });

  it("syncs invoice components and records only prospective deterministic allocations", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION app_private.sync_finance_invoice_components_v1",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION app_private.allocate_finance_collection_components_v1",
    );
    expect(sql).toMatch(/oldest carried invoice debt/i);
    expect(sql).toContain("allocation_unknown");
    expect(sql).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(sql).toContain("invoice_payment_allocations");
    expect(sql).toContain("previous_debt_sources");
    expect(sql).toContain("accounting_class = 'DEPOSIT'");
    expect(sql).toContain("accounting_class = 'NON_PNL'");
  });

  it("publishes a strict cohort contract without carry, deposit or settlement double-counting", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.business_performance_invoice_cohort_v1",
    );
    expect(sql).toContain(
      "business_performance_invoice_cohort_v1(uuid, date, uuid[])",
    );
    expect(sql).toContain("kind = 'MONTHLY'");
    expect(sql).toContain("APPROVED");
    expect(sql).toContain("PARTIAL_PAID");
    expect(sql).toContain("PAID");
    expect(sql).toContain("OVERDUE");
    expect(sql).toContain("DRAFT");
    expect(sql).toContain("PENDING_APPROVAL");
    expect(sql).toContain("cohort_available");
    expect(sql).toContain("allocation_unknown_count");
    expect(sql).toContain("carried_invoice_debt");
    expect(sql).toContain("carried_deposit_debt");
    expect(sql).toContain("settlement_amount");
    expect(sql).toContain("business_performance_exact_scope_v1");
    expect(sql).toMatch(/p_require_restricted\s*=>\s*true/);
  });

  it("falls back per invoice when summing allocation-unknown amounts", () => {
    const sql = migrationSql();

    expect(sql).toMatch(
      /sum\(\s*COALESCE\(\s*invoice_row\.current_charge\s*,\s*invoice_row\.total_amount\s*\)\s*\)\s*FILTER\s*\(\s*WHERE NOT COALESCE\(invoice_row\.component_complete AND invoice_row\.allocation_complete, false\)\s*\)/i,
    );
    expect(sql).not.toMatch(
      /COALESCE\(\s*sum\(invoice_row\.current_charge\)[\s\S]*?sum\(invoice_row\.total_amount\)/i,
    );
  });

  it("publishes cash received by real payment date from canonical active receipts", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.business_performance_cash_received_v1",
    );
    expect(sql).toContain(
      "business_performance_cash_received_v1(uuid, date, uuid[])",
    );
    expect(sql).toContain("payment_date");
    expect(sql).toContain("payment_event_count");
    expect(sql).toContain("FROM public.active_payment_receipts receipt_row");
    expect(sql).toContain("receipt_row.collected_amount");
    expect(sql).not.toContain(
      "COALESCE(payment_row.received_amount, payment_row.amount)::numeric AS retained_cash",
    );
  });

  it("publishes scoped category breakdown for both bases", () => {
    const sql = migrationSql();

    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION public.business_performance_category_breakdown_v1",
    );
    expect(sql).toContain(
      "business_performance_category_breakdown_v1(uuid, text, date, date, uuid[])",
    );
    expect(sql).toContain("fa_accrual_allocations");
    expect(sql).toContain("fa_type_breakdown");
    expect(sql).toContain("voucher_count");
    expect(sql).toContain("Unsupported business performance basis");
  });

  it("grants authenticated execution only on report RPCs", () => {
    const sql = migrationSql();
    const signatures = [
      "public.business_performance_invoice_cohort_v1(uuid, date, uuid[])",
      "public.business_performance_cash_received_v1(uuid, date, uuid[])",
      "public.business_performance_category_breakdown_v1(uuid, text, date, date, uuid[])",
    ];

    for (const signature of signatures) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM authenticated`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM service_role`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
    }
  });
});
