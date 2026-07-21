import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260721135000_customer_credit_application_v1.sql",
);
const sql = readFileSync(migrationPath, "utf8");

function functionBody(name: string): string {
  const start = sql.indexOf(`FUNCTION ${name}(`);
  const next = sql.indexOf("CREATE OR REPLACE FUNCTION", start + 1);
  return sql.slice(start, next === -1 ? undefined : next);
}

describe("customer credit lifecycle migration", () => {
  it("runs after history repair and backfills multi-lot negatives by FIFO split", () => {
    expect(migrationPath).toContain("20260721135000");
    expect(sql).toContain("ORDER BY lot.created_at, lot.id");
    expect(sql).toContain("v_take := LEAST(v_lot.remaining_amount, v_needed)");
    expect(sql).toContain("amount = -v_take");
    expect(sql).toContain("CUSTOMER_CREDIT_FIFO_SPLIT");
    expect(sql).toContain(
      "ORDER BY lot.created_at, lot.source_excess_amount_id, lot.id",
    );
  });

  it("makes linked and negative compatibility-ledger writes core-only", () => {
    expect(sql).toContain("guard_customer_credit_ledger_v1");
    expect(sql).toContain("NEW.credit_lot_id IS NOT NULL OR NEW.amount < 0");
    expect(sql).toContain(
      "REVOKE INSERT, UPDATE, DELETE ON public.excess_amounts",
    );
  });

  it("blocks direct cancel/delete/restore updates for invoices with credit", () => {
    expect(sql).toContain("guard_invoice_credit_lifecycle_v1");
    expect(sql).toContain(
      "Invoice credit lifecycle changes are core-writer only",
    );
    expect(sql).toContain("a00_invoice_credit_lifecycle_guard");
  });

  it("enforces composite tenant provenance for lots and applications", () => {
    expect(sql).toContain("customer_credit_lots_collection_org_fkey");
    expect(sql).toContain("customer_credit_lots_tender_org_fkey");
    expect(sql).toContain("customer_credit_lots_payment_org_fkey");
    expect(sql).toContain("customer_credit_lots_excess_org_fkey");
    expect(sql).toContain("customer_credit_applications_invoice_org_fkey");
    expect(sql).toContain("customer_credit_applications_reversal_excess_org_fkey");
    expect(sql).toContain("VALIDATE CONSTRAINT customer_credit_applications_lot_org_fkey");
  });

  it("reverses applications in locked LIFO order with an opposing ledger row", () => {
    expect(sql).toContain("reverse_customer_credit_application_lifo_v1");
    expect(sql).toContain(
      "ORDER BY application_row.applied_at DESC, application_row.id DESC",
    );
    expect(sql).toContain("v_lot.remaining_amount + v_application.amount");
    expect(sql).toContain("reversal_excess_amount_id = v_reversal_excess_id");
  });

  it.each([
    "create_invoice_with_credit_v1",
    "terminate_contract_forfeit_with_credit_v1",
    "terminate_contract_move_out_with_credit_v1",
    "cancel_invoice_with_credit_v1",
    "soft_delete_invoice_with_credit_v1",
    "bulk_soft_delete_invoices_with_credit_v1",
    "super_admin_force_cancel_invoice_with_credit_v1",
    "restore_invoice_with_credit_v1",
  ])("defines the atomic wrapper %s", (rpcName) => {
    expect(sql).toContain(`FUNCTION public.${rpcName}`);
  });

  it("never hard-deletes credit application or compatibility-ledger history", () => {
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.customer_credit_applications/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.excess_amounts/i);
  });

  it("replays completed idempotent operations before checking the feature route", () => {
    for (const name of [
      "app_private.apply_customer_credit_fifo_v1",
      "app_private.reverse_customer_credit_application_lifo_v1",
    ]) {
      const body = functionBody(name);
      expect(body.indexOf("v_operation.completed_at IS NOT NULL")).toBeGreaterThan(-1);
      expect(body.indexOf("evaluate_feature_route")).toBeGreaterThan(
        body.indexOf("v_operation.completed_at IS NOT NULL"),
      );
    }
  });

  it("starts in SHADOW, preserves an existing mode, and hides generic RPCs", () => {
    expect(sql).toContain(
      "'customer.credit.apply.v1', 'invoices', 'MONEY', 'SHADOW'",
    );
    expect(sql).not.toContain("SET mode = 'ON'");
    expect(sql).not.toContain("SET mode = EXCLUDED.mode");
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.apply_customer_credit_v1[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.reverse_customer_credit_application_v1[\s\S]*?FROM PUBLIC, anon, authenticated, service_role;/,
    );
    expect(sql).not.toContain("GRANT EXECUTE ON FUNCTION public.apply_customer_credit_v1");
    expect(sql).not.toContain(
      "GRANT EXECUTE ON FUNCTION public.reverse_customer_credit_application_v1",
    );
  });

  it("requires invoice discount to equal non-credit discount plus applied credit", () => {
    const body = functionBody("public.create_invoice_with_credit_v1");
    expect(body).toContain("p_non_credit_discount_amount");
    expect(body).toContain(
      "Invoice discount must equal non-credit discount plus applied credit",
    );
  });

  it("uses a restore-cycle key derived from the pending reversal set", () => {
    const body = functionBody("public.restore_invoice_with_credit_v1");
    expect(body).toContain("v_restore_fingerprint");
    expect(body).toContain(":cycle:");
    expect(body).toContain("restoration_idempotency_key = v_apply_key");
  });

  it("orders bulk deletion by newest active application", () => {
    const body = functionBody("public.bulk_soft_delete_invoices_with_credit_v1");
    expect(body).toContain("latest_application.applied_at DESC NULLS LAST");
  });

  it("keeps legacy termination as a zero-credit compatibility shim", () => {
    const assertion = functionBody(
      "app_private.assert_contract_has_no_customer_credit_v1",
    );
    const balance = functionBody(
      "app_private.contract_customer_credit_balance_v1",
    );
    const forfeit = functionBody("public.terminate_contract_forfeit");
    const moveOut = functionBody("public.terminate_contract_move_out");

    expect(balance).toContain("excess.credit_lot_id IS NULL");
    expect(balance).not.toContain("source_invoice.deleted_at IS NULL");
    expect(balance).toContain("lot.status = 'ACTIVE'");
    expect(balance).toContain("v_ledger_balance IS DISTINCT FROM v_balance");
    expect(assertion).toContain("IF v_balance > 0 THEN");
    for (const body of [forfeit, moveOut]) {
      expect(body).toContain("app_private.accounting_chain_writer_xids");
      expect(body).toContain("IF NOT v_core_writer THEN");
      expect(body).toContain(
        "app_private.assert_contract_has_no_customer_credit_v1",
      );
      expect(body).toContain("public.can_do_on_building(");
    }
    expect(forfeit).toContain("public.terminate_contract_forfeit_impl(");
    expect(moveOut).toContain("public.terminate_contract_move_out_impl(");
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.terminate_contract_forfeit\(uuid, date, jsonb\)[\s\S]*?TO authenticated, service_role;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.terminate_contract_move_out\([\s\S]*?TO authenticated, service_role;/,
    );
  });

  it("skips the gated forfeit writer when verified credit is zero", () => {
    const body = functionBody(
      "public.terminate_contract_forfeit_with_credit_v1",
    );
    expect(body).toContain(
      "app_private.contract_customer_credit_balance_v1",
    );
    expect(body).toContain("IF v_credit_balance > 0 THEN");
    expect(body).toContain("'application_kind', 'FORFEIT'");
    expect(body).toContain("'applied_amount', 0");
  });
});
