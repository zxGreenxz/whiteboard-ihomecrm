import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boChuThichSql } from "../../../scripts/lib/bo-chu-thich.mjs";

type Migration = { file: string; sql: string };
const MIGRATION_DIR = "supabase/migrations";
const migrations: Migration[] = readdirSync(MIGRATION_DIR)
  .filter(file => file.endsWith(".sql"))
  .sort()
  .map(file => ({ file, sql: boChuThichSql(readFileSync(`${MIGRATION_DIR}/${file}`, "utf8")) }));

// Select the latest CREATE, then isolate its dollar-quoted body. Assertions
// must not borrow a guard from an obsolete definition or a neighboring RPC.
function liveDefinitionOf(name: string, corpus = migrations) {
  const escapedName = name.replace(/\./g, "\\.");
  const create = new RegExp(`^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${escapedName}\\s*\\(`, "gmi");
  let hit: { file: string; sql: string; migrationSql: string } | undefined;
  for (const migration of corpus) {
    const sql = boChuThichSql(migration.sql);
    for (const match of sql.matchAll(create)) {
      const start = match.index;
      const headerAndBody = sql.slice(start);
      const delimiter = /\bAS\s+(\$(?:[a-z_][a-z0-9_]*)?\$)/i.exec(headerAndBody);
      const quote = delimiter?.[1];
      if (!delimiter || !quote) throw new Error(`${migration.file}: missing function body for ${name}`);
      const bodyStart = start + delimiter.index + delimiter[0].length;
      const bodyEnd = sql.indexOf(quote, bodyStart);
      if (bodyEnd < 0) throw new Error(`${migration.file}: unterminated body for ${name}`);
      hit = { file: migration.file, sql: sql.slice(start, bodyEnd + quote.length), migrationSql: sql };
    }
  }
  if (!hit) throw new Error(`Missing latest definition of ${name}`);
  return hit;
}

function schemaCreationSql(): string {
  const creation = migrations.find(({ sql }) => /CREATE\s+TABLE\s+public\.finance_invoice_component_manifests\b/i.test(sql));
  if (!creation) throw new Error("Missing canonical invoice-component table creation");
  return creation.sql;
}

describe("business-performance cohort, cash and category migration", () => {
  it("creates canonical invoice-component and immutable allocation ledgers", () => {
    const sql = schemaCreationSql();

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
    const sql = schemaCreationSql();
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
    const currentSchema = liveDefinitionOf("app_private.sync_finance_invoice_components_v1").migrationSql;
    expect(currentSchema).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS finance_component_manifest_revision_uq[\s\S]*?\(invoice_id,\s*adjustment_revision\)/);
    expect(sql).toContain("finance_invoice_components_manifest_kind_uq");
    expect(sql).toContain("finance_invoice_component_allocations_collection_component_uq");
    expect(sql).toContain("finance_invoice_component_allocations_component_idx");
  });

  it("syncs invoice components and records only prospective deterministic allocations", () => {
    const sync = liveDefinitionOf("app_private.sync_finance_invoice_components_v1").sql;
    const allocation = liveDefinitionOf("app_private.allocate_finance_collection_components_v1").sql;

    expect(sync).toContain("manifest.adjustment_revision = v_invoice.adjustment_revision");
    expect(sync).toMatch(/IF v_manifest_finalized_at IS NOT NULL THEN\s+RETURN v_manifest_id/);
    expect(sync).toContain("previous_debt_sources");
    expect(sync).toContain("accounting_class = 'DEPOSIT'");
    expect(sync).toContain("accounting_class = 'NON_PNL'");
    expect(sync).toMatch(/'CARRIED_INVOICE_DEBT'::text, v_previous_invoice, 10/);
    expect(sync).toMatch(/'CURRENT_CHARGE'::text, v_current_charge, 20/);
    expect(allocation).toMatch(/ORDER BY c\.component_order,\s*c\.id/);
    expect(allocation).toContain("m.id=collection.component_manifest_id");
    expect(allocation).toContain("collection.component_manifest_id IS NULL AND m.adjustment_revision=0");
    expect(allocation).toContain("proved_legacy_invoice_pnl_v2(collection.invoice_id,p_collection_id)");
    expect(allocation).toMatch(/IF legacy_pnl IS NULL THEN RETURN/);
    expect(allocation).toContain("prior_component.component_kind=component.component_kind");
    expect(allocation).toContain("a.collection_id<>p_collection_id");
    expect(allocation).toContain("active_collection.status='ACTIVE'");
    expect(allocation).not.toMatch(/(?:UPDATE\s+|DELETE\s+FROM\s+)public\.finance_invoice_component_allocations\b/i);
    expect(schemaCreationSql()).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(schemaCreationSql()).toContain("AFTER INSERT ON public.invoice_payment_allocations");
  });

  it("publishes a strict cohort contract without carry, deposit or settlement double-counting", () => {
    const sql = liveDefinitionOf("public.business_performance_invoice_cohort_v1").sql;
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
    expect(sql).toContain("manifest.adjustment_revision = invoice_row.adjustment_revision");
    expect(sql).toContain("component.id = allocation.component_id");
    expect(sql).toContain("app_private.proved_legacy_invoice_pnl_v2(invoice_row.id)");
    expect(sql).toContain("payment_row.allocated_current_charge + payment_row.legacy_pnl");
    expect(sql).toContain("payment_row.legacy_pnl IS NOT NULL");
  });

  it("falls back per invoice when summing allocation-unknown amounts", () => {
    const sql = liveDefinitionOf("public.business_performance_invoice_cohort_v1").sql;

    expect(sql).toMatch(
      /sum\(\s*COALESCE\(\s*invoice_row\.current_charge\s*,\s*invoice_row\.total_amount\s*\)\s*\)\s*FILTER\s*\(\s*WHERE NOT COALESCE\(invoice_row\.component_complete AND invoice_row\.allocation_complete, false\)\s*\)/i,
    );
    expect(sql).not.toMatch(
      /COALESCE\(\s*sum\(invoice_row\.current_charge\)[\s\S]*?sum\(invoice_row\.total_amount\)/i,
    );
  });

  it("publishes cash received by real payment date from canonical active receipts", () => {
    const sql = liveDefinitionOf("public.business_performance_cash_received_v1").sql;
    expect(sql).toContain("payment_date");
    expect(sql).toContain("payment_event_count");
    expect(sql).toContain("FROM public.active_payment_receipts receipt_row");
    expect(sql).toContain("receipt_row.collected_amount");
    expect(sql).not.toContain(
      "COALESCE(payment_row.received_amount, payment_row.amount)::numeric AS retained_cash",
    );
  });

  it("publishes scoped category breakdown for both bases", () => {
    const sql = liveDefinitionOf("public.business_performance_category_breakdown_v1").sql;
    expect(sql).toContain("fa_accrual_allocations");
    expect(sql).toContain("fa_type_breakdown");
    expect(sql).toContain("voucher_count");
    expect(sql).toContain("Unsupported business performance basis");
  });

  it("grants authenticated execution only on report RPCs", () => {
    const signatures = [
      "public.business_performance_invoice_cohort_v1(uuid, date, uuid[])",
      "public.business_performance_cash_received_v1(uuid, date, uuid[])",
      "public.business_performance_category_breakdown_v1(uuid, text, date, date, uuid[])",
    ];

    for (const signature of signatures) {
      const sql = liveDefinitionOf(signature.slice(0, signature.indexOf("("))).migrationSql;
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM anon`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM authenticated`);
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM service_role`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION ${signature} TO authenticated`);
    }
  });
  it("selects the final function body instead of an old or neighboring guard", () => {
    const result = liveDefinitionOf("public.probe", [
      { file: "earlier.sql", sql: "CREATE FUNCTION public.probe() RETURNS text LANGUAGE sql AS $$ SELECT 'old guard' $$;" },
      { file: "later.sql", sql: "CREATE OR REPLACE FUNCTION public.probe() RETURNS text LANGUAGE sql AS $body$ SELECT 'current' $body$;\nCREATE FUNCTION public.neighbor() RETURNS text LANGUAGE sql AS $$ SELECT 'old guard' $$;" },
    ]);
    expect(result.file).toBe("later.sql");
    expect(result.sql).toContain("SELECT 'current'");
    expect(result.sql).not.toContain("old guard");
    expect(result.sql).not.toContain("public.neighbor");
  });
  it("ignores commented CREATE definitions and commented guards", () => {
    const result = liveDefinitionOf("public.probe", [
      { file: "active.sql", sql: "CREATE FUNCTION public.probe() RETURNS int LANGUAGE sql AS $$\n-- fake guard\n/* fake guard */ SELECT 1 $$;" },
      { file: "comment-only.sql", sql: "-- CREATE OR REPLACE FUNCTION public.probe() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$;\n/* CREATE FUNCTION public.probe() RETURNS int LANGUAGE sql AS $$ SELECT 3 $$; */" },
    ]);
    expect(result.file).toBe("active.sql");
    expect(result.sql).toContain("SELECT 1");
    expect(result.sql).not.toContain("fake guard");
  });
});
