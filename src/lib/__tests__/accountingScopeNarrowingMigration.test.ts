import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

const sql = readFileSync(
  "supabase/migrations/20260721150500_accounting_scope_narrowing.sql",
  "utf8",
).replace(/\r\n/g, "\n");

function functionBody(name: string): string {
  const signature = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = sql.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end, signature).toBeGreaterThan(start);
  return sql.slice(start, end + 4);
}

describe("accounting scope narrowing migration", () => {
  it("keeps historical schemas and ledgers while disabling only forward routes", () => {
    const migrationWithoutRuntimeLegacyCleanup = sql.replace(
      functionBody("undo_invoice_payment_compat_v1"),
      "",
    );

    expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|SCHEMA|COLUMN)\b/i);
    expect(migrationWithoutRuntimeLegacyCleanup).not.toMatch(
      /DELETE\s+FROM\s+public\./i,
    );
    expect(sql).not.toContain("DELETE FROM app_private.canonical_write_operations");
    expect(sql).not.toContain("DELETE FROM app_private.server_feature_flag_operations");
    expect(sql).toContain("DELETE FROM app_private.server_feature_flag_canary_orgs");
    expect(sql).toContain("collection_row.status = 'ACTIVE'");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("v_locked_flags <> 2");
    expect(sql).toContain("'shareholder_profit.distribute.v2'");
  });

  it("enables contract V2 and leaves expanded money writers in shadow", () => {
    expect(sql).toMatch(
      /SET mode = 'ON',[\s\S]*?WHERE feature_key = 'contract\.create\.v2';/,
    );
    for (const feature of [
      "invoice.collection.v5",
      "invoice.collection.reverse.v5",
      "customer.credit.apply.v1",
      "shareholder_profit.distribute.v2",
    ]) {
      expect(sql).toContain(`'${feature}'`);
    }
    expect(sql).toContain("SET mode = 'SHADOW'");
    expect(sql).toMatch(
      /SET mode = 'ON',[\s\S]*?WHERE feature_key = 'customer\.credit\.reverse\.v1';/,
    );
    expect(sql).not.toContain("SET mode = 'FROZEN'");
  });

  it("preserves rollout attestations for every ON route and fails closed", () => {
    const contractUpdate = sql.slice(
      sql.indexOf("SET mode = 'ON'"),
      sql.indexOf("WHERE feature_key = 'contract.create.v2';") +
        "WHERE feature_key = 'contract.create.v2';".length,
    );
    const creditStart = sql.indexOf("SET mode = 'ON'", sql.indexOf("customer.credit.reverse.v1") - 500);
    const creditUpdate = sql.slice(
      creditStart,
      sql.indexOf("WHERE feature_key = 'customer.credit.reverse.v1';") +
        "WHERE feature_key = 'customer.credit.reverse.v1';".length,
    );

    for (const update of [contractUpdate, creditUpdate]) {
      expect(update).not.toContain("commit_sha = NULL");
      expect(update).not.toContain("migration_sha256 = NULL");
      expect(update).not.toContain("maintenance_window_id = NULL");
      expect(update).not.toContain("approval_reference = NULL");
    }
    expect(sql).toContain("DO $assert_on_routes$");
    expect(sql).toContain("evaluate_feature_route(");
    expect(sql).toContain("<> 'CANONICAL'");
    expect(sql).toContain("user-approved-scope-narrowing-20260721");
  });

  it("uses a reproducible release identity and normalized migration digest", () => {
    const commitMatches = [
      ...sql.matchAll(/commit_sha = COALESCE\([\s\S]*?'([0-9a-f]{40})'/g),
    ].map((match) => match[1]);
    const digestMatches = [
      ...sql.matchAll(/migration_sha256 = COALESCE\([\s\S]*?'([0-9a-f]{64})'/g),
    ].map((match) => match[1]);

    expect(commitMatches).toHaveLength(2);
    expect(commitMatches[0]).toBe(commitMatches[1]);
    expect(digestMatches).toHaveLength(2);
    expect(digestMatches[0]).toBe(digestMatches[1]);

    const normalized = sql.split(digestMatches[0]).join("0".repeat(64));
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(
      digestMatches[0],
    );
  });

  it("routes one-payment clients to the reviewed legacy V4 writer, never V5", () => {
    const body = functionBody("record_invoice_payment_v4");

    expect(body).toContain("public._record_invoice_payment_v4_legacy(");
    expect(body).not.toContain("record_invoice_collection_v5");
    expect(body).not.toContain("evaluate_feature_route('invoice.collection.v5'");
    expect(body).toContain("invoice.record_payment.v1");
    expect(body).toContain("invoice.collection.compat.v4");
    expect(body).toContain("v_compat_operation.payload_hash <> v_hash");
    expect(body).toContain("operation_row.completed_at IS NOT NULL");
  });

  it("rejects generic invoice payments that omit accounting semantics", () => {
    const body = functionBody("record_invoice_payment_v4");

    expect(body).toContain("IF NOT v_validate_semantics THEN");
    expect(body).toContain("p_account_id IS NOT NULL");
    expect(body).toContain("jsonb_typeof(p_items) = 'array'");
    expect(body).toContain("Invoice payments require the invoice payment screen");
    expect(body).toContain("item.accounting_class = 'DEPOSIT'");
    expect(body).toContain("item.accounting_class = 'NON_PNL'");
    expect(body).toContain("v_expected_revenue := LEAST(");
    expect(body).toContain("v_expected_deposit := LEAST(");
    expect(body).toContain("Rounding must exactly close a positive invoice residual below 10000");
    expect(body).toContain("rounding_amount = 0");
    expect(body).toContain("Phân bổ phiếu thu không khớp semantic hóa đơn");
    expect(body).toContain("received_amount = p_amount");
    expect(body).toContain("public.recompute_contract_deposit_paid");
  });

  it("keeps the old v3 signature as a thin alias of the narrowed v4 writer", () => {
    const body = functionBody("record_invoice_payment_v3");

    expect(body).toContain("SELECT public.record_invoice_payment_v4(");
    expect(body).not.toContain("record_invoice_collection_v5");
  });

  it("restores legacy payout creation without removing payout integrity guards", () => {
    expect(sql).toContain(
      "DROP TRIGGER IF EXISTS a00_00_profit_payout_account_guard",
    );
    expect(sql).toContain("guard_profit_payout_scope_compat_v1");
    expect(sql).toContain("AND NOT account_row.is_virtual");
    expect(sql).toContain("shareholder_row.organization_id = NEW.organization_id");
    expect(sql).toContain("manager_row.organization_id = NEW.organization_id");
    expect(sql).not.toContain("DROP TRIGGER IF EXISTS a05_profit_payout_linked_guard");
    expect(sql).not.toContain("DROP TRIGGER IF EXISTS a05_profit_payout_item_guard");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public._guard_profit_payout_insert_v2()",
    );
  });

  it("moves compatibility money writes into tenant-scoped server transactions", () => {
    const payout = functionBody("create_profit_payout_compat_v1");
    const methodUpdate = functionBody("update_invoice_payment_method_v1");
    const undo = functionBody("undo_invoice_payment_compat_v1");

    expect(payout).toContain("account_row.organization_id = v_org");
    expect(payout).toContain("AND NOT account_row.is_virtual");
    expect(payout).toContain("app_private.canonical_write_operations");
    expect(payout).toContain("INSERT INTO public.income_expense_items");
    expect(payout).toContain("accounting_class");

    expect(methodUpdate).toContain("FOR UPDATE OF payment_row, invoice_row");
    expect(methodUpdate).toContain("account_row.organization_id = v_org");
    expect(methodUpdate).toContain("UPDATE public.income_expenses");
    expect(methodUpdate).toContain("UPDATE public.payments");

    expect(undo).toContain("public.reverse_invoice_payment_v3(");
    expect(undo).toContain("'thu_tien.undo'");
    expect(undo).toContain("DELETE FROM public.excess_amounts");
    expect(undo).toContain("DELETE FROM public.payments");
  });

  it("removes implicit PUBLIC execute from accounting trigger functions", () => {
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION app_private.guard_payment_canonical_link()",
    );
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION app_private.guard_income_expense_accounting_links_v1()",
    );
    expect(sql).toContain("FROM PUBLIC, anon, authenticated, service_role");
  });
});
