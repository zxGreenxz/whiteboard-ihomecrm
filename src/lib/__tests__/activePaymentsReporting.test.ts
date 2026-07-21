import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260721102000_active_payments_reporting.sql",
);
const sql = readFileSync(migrationPath, "utf8");

function functionBody(name: string): string {
  const start = sql.indexOf(`FUNCTION public.${name}`);
  const next = sql.indexOf("CREATE OR REPLACE FUNCTION", start + 1);
  return sql.slice(start, next === -1 ? undefined : next);
}

describe("active payment reporting migration", () => {
  it("projects voucher and account provenance for V5 and legacy receipts", () => {
    expect(sql).toContain("tender.voucher_id");
    expect(sql).toContain("tender.account_id");
    expect(sql).toContain("voucher.id AS voucher_id");
    expect(sql).toContain("voucher.account_id");
    expect(sql).toContain("income.payment_id = payment.id");
    expect(sql).toContain("income.organization_id = payment.organization_id");
  });

  it("keeps pure-credit tenders active while excluding reversed collections", () => {
    const viewStart = sql.indexOf("VIEW public.active_payment_receipts");
    const viewEnd = sql.indexOf("REVOKE ALL ON public.active_payment_receipts", viewStart);
    const view = sql.slice(viewStart, viewEnd);

    expect(view).toContain("tender.credit_amount");
    expect(view).toContain("WHERE collection.status = 'ACTIVE'");
    expect(view).not.toMatch(/tender\.applied_amount\s*>\s*0/);
    expect(view).toContain("legacy.reversed_at IS NULL");
  });

  it("uses a stable security-invoker SETOF invoices RPC for method drill-down", () => {
    const body = functionBody("invoice_payment_method_drilldown");

    expect(body).toContain("RETURNS SETOF public.invoices");
    expect(body).toContain("STABLE");
    expect(body).toContain("SECURITY INVOKER");
    expect(body).not.toContain("SECURITY DEFINER");
    expect(body).toContain("FROM public.active_payment_receipts receipt");
    expect(body).toContain("receipt.payment_method = p_payment_method");
    expect(body).toContain("receipt.collected_amount > 0");
  });

  it("aggregates active page methods server-side before returning them", () => {
    const body = functionBody("invoice_active_payment_methods");

    expect(body).toContain("RETURNS TABLE(invoice_id uuid, payment_methods text[])");
    expect(body).toContain("SECURITY INVOKER");
    expect(body).toContain("array_agg(");
    expect(body).toContain("receipt.invoice_id = ANY(p_invoice_ids)");
    expect(body).toContain("GROUP BY receipt.invoice_id");
  });
});
