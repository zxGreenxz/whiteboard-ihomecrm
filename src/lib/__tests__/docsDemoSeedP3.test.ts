import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("scripts/docs-demo/seed-p3.mjs", "utf8");
const paymentFlow =
  source.match(/if \(inv\.pay > 0\) \{([\s\S]*?)\n  \}\n  console\.log/)?.[1] ?? "";
const v5Cleanup =
  source.match(/const v5CleanupSql = `([\s\S]*?)`\n\nawait runSql/)?.[1] ?? "";

describe("docs demo P3 payment seed", () => {
  it("creates one linked live receipt and item for every seeded payment", () => {
    expect(paymentFlow).toContain("WITH inserted_payment AS");
    expect(paymentFlow.match(/INSERT INTO payments/g)).toHaveLength(1);
    expect(paymentFlow.match(/INSERT INTO income_expenses/g)).toHaveLength(1);
    expect(paymentFlow.match(/INSERT INTO income_expense_items/g)).toHaveLength(1);
    expect(paymentFlow).toContain("payment_id");
    expect(paymentFlow).toContain("'INCOME'");
    expect(paymentFlow).toContain("${DEMO_ACCOUNT_ID}");
    expect(paymentFlow).toContain("${PAYMENT_TYPE_ID}");
    expect(paymentFlow).toContain("payment.amount");
    expect(paymentFlow).toContain("voucher.total_amount");
    expect(paymentFlow).toContain("'Thu tiền hoá đơn'");
  });

  it("stores real cash decomposition when the V5 payment columns exist", () => {
    expect(source).toContain("has_payment_semantics");
    expect(source).toContain(
      "'received_amount', 'credit_amount', 'change_amount', 'rounding_amount'",
    );
    expect(source).toContain(
      "', received_amount, credit_amount, change_amount, rounding_amount'",
    );
    expect(source).toContain("? `, ${amount}, 0, 0, 0`");
    expect(paymentFlow).toContain("notes${paymentSemanticColumns}");
    expect(paymentFlow).toContain("${paymentSemanticValues(inv.pay)}");
    expect(source).toContain("paymentWriterOpen");
    expect(source).toContain("SELECT app_private.begin_accounting_chain_write_v1();");
    expect(source).toContain("paymentWriterClose");
    expect(source).toContain("app_private.end_accounting_chain_write_v1() AS writer_closed");
    expect(paymentFlow).toContain("${paymentWriterClose}");
    expect(paymentFlow).toContain("inserted_item AS");
  });

  it("cleans V5 fixture dependencies before payments and collections", () => {
    const allocationDelete = v5Cleanup.indexOf(
      "DELETE FROM public.invoice_payment_allocations",
    );
    const tenderDelete = v5Cleanup.indexOf(
      "DELETE FROM public.invoice_payment_tenders",
    );
    const paymentDelete = v5Cleanup.indexOf("DELETE FROM public.payments");
    const collectionDelete = v5Cleanup.indexOf(
      "DELETE FROM public.invoice_payment_collections",
    );

    expect(allocationDelete).toBeGreaterThan(-1);
    expect(tenderDelete).toBeGreaterThan(allocationDelete);
    expect(paymentDelete).toBeGreaterThan(tenderDelete);
    expect(collectionDelete).toBeGreaterThan(paymentDelete);
    expect(v5Cleanup).toContain("SET collection_id=NULL");
    expect(v5Cleanup).toContain("SET payment_collection_id=NULL");
    expect(v5Cleanup).toContain(
      "DELETE FROM app_private.income_expense_flow_ownership",
    );
  });

  it("scopes cleanup from the exact DEMO-DOCS fixture marker", () => {
    expect(source).toContain("invoice.notes LIKE '[DEMO-DOCS] %'");
    expect(source).toContain("voucher.notes LIKE '[DEMO-DOCS]%'");
    expect(source).toContain("WHERE user_id=${O} AND notes='[DEMO-DOCS]';");
    expect(source).not.toContain("email LIKE 'demo.%@username.ihomecrm.local'");
    expect(source).not.toMatch(/DELETE FROM (?:public\.)?payments WHERE user_id/);
    expect(source).not.toMatch(/DELETE FROM (?:public\.)?invoices WHERE user_id/);
  });

  it("fails closed when customer credit crosses the fixture boundary", () => {
    expect(v5Cleanup).toContain("DO $credit_boundary$");
    expect(v5Cleanup).toContain(
      "a non-P3 credit lot is applied to DEMO-DOCS data",
    );
    expect(v5Cleanup).toContain(
      "DEMO-DOCS credit was consumed outside the fixture",
    );
    expect(v5Cleanup.indexOf("DO $credit_boundary$")).toBeLessThan(
      v5Cleanup.indexOf("DELETE FROM public.customer_credit_applications"),
    );
  });
});
