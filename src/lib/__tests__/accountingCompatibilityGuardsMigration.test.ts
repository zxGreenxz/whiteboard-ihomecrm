import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const collectionSql = readFileSync(
  "supabase/migrations/20260721100000_invoice_collection_v5.sql",
  "utf8",
);
const payoutSql = readFileSync(
  "supabase/migrations/20260721120000_profit_payout_reservations_v2.sql",
  "utf8",
);
const payoutDialog = readFileSync(
  "src/components/shareholders/ProfitDistributeDialog.tsx",
  "utf8",
);
const approvalPage = readFileSync(
  "src/pages/payments/IncomeExpensePage.tsx",
  "utf8",
);

const extractFunction = (sql: string, functionName: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}(`);
  expect(start).toBeGreaterThanOrEqual(0);

  const nextFunction = sql.indexOf("\nCREATE OR REPLACE FUNCTION ", start + 1);
  return sql.slice(start, nextFunction === -1 ? undefined : nextFunction);
};

describe("accounting compatibility migration guards", () => {
  it("uses stable dates and classified sources for v3 payment reversals", () => {
    const body = extractFunction(collectionSql, "reverse_invoice_payment_v3");

    expect(body).toContain("public.vn_local_date(clock_timestamp())");
    expect(body).toContain("collection.reversal_date");
    expect(body).toContain("collection.collection_date");
    expect(body).toMatch(
      /RETURN public\.reverse_invoice_collection_v5\(\s*v_collection_id,\s*v_reversal_date,/,
    );
    expect(body).toContain("public.vn_local_date(v_reversal_created_at)");
    expect(body).toContain("v_reversal_date := GREATEST(");
    expect(body).toContain("IF v_existing_source IS NOT NULL THEN");
    expect(body).toContain("payment.reversed_at IS NULL");
    expect(body).toContain("item.accounting_class IN ('PNL', 'DEPOSIT', 'CUSTOMER_CREDIT')");
    expect(body).toContain("AND NOT account_row.is_virtual");
    expect(body).toContain("Đây là bút toán cấn trừ thanh lý");
    expect(body).toContain(
      "SELECT public._reverse_invoice_payment_v3_legacy($1,$2,$3)",
    );
  });

  it("rejects virtual payout accounts before authorization and effects", () => {
    const body = extractFunction(payoutSql, "distribute_shareholder_profit_v1");
    const accountGuard = body.indexOf(
      "PERFORM 1 FROM public.accounts account_row",
    );
    const authorization = body.indexOf("authorize_tenant_action_v3");
    const firstEffect = body.indexOf(
      "INSERT INTO app_private.canonical_write_operations",
    );

    expect(body).toMatch(
      /PERFORM 1 FROM public\.accounts account_row[\s\S]*?account_row\.id = p_account_id[\s\S]*?account_row\.organization_id = v_org[\s\S]*?account_row\.deleted_at IS NULL[\s\S]*?AND NOT account_row\.is_virtual[\s\S]*?FOR SHARE;/,
    );
    expect(accountGuard).toBeGreaterThanOrEqual(0);
    expect(accountGuard).toBeLessThan(authorization);
    expect(accountGuard).toBeLessThan(firstEffect);
  });

  it("validates direct and core-writer payout account changes in the trigger", () => {
    const body = extractFunction(payoutSql, "_guard_profit_payout_insert_v2");
    const accountGuard = body.indexOf(
      "IF NEW.shareholder_id IS NOT NULL THEN",
    );
    const coreWriterCheck = body.indexOf("SELECT EXISTS (");

    expect(payoutSql).toContain(
      "BEFORE INSERT OR UPDATE OF shareholder_id, account_id ON public.income_expenses",
    );
    expect(body).toMatch(
      /account_row\.id = NEW\.account_id[\s\S]*?account_row\.organization_id = NEW\.organization_id[\s\S]*?account_row\.deleted_at IS NULL[\s\S]*?AND NOT account_row\.is_virtual[\s\S]*?FOR SHARE;/,
    );
    expect(body).toContain("IF NEW.account_id IS NULL THEN");
    expect(accountGuard).toBeGreaterThanOrEqual(0);
    expect(accountGuard).toBeLessThan(coreWriterCheck);
    expect(body).toContain("AND NOT v_core_writer THEN");
    expect(body).not.toContain(
      "NEW.account_id IS DISTINCT FROM OLD.account_id",
    );
  });

  it("does not offer virtual accounts in shareholder payout selectors", () => {
    expect(payoutDialog).toContain(
      "accounts.filter((account) => !account.is_virtual)",
    );
    expect(payoutDialog).toContain("options={payoutAccounts.map");
    expect(approvalPage).toContain("!!approveTarget?.shareholder_id");
    expect(approvalPage).toContain(
      "accounts.filter((account) => !account.is_virtual)",
    );
    expect(approvalPage).toContain("approvalAccounts.map");
  });
});
