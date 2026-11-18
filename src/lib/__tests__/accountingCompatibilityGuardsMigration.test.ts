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
// 18/11/2026: hộp của chủ thành hộp CHỐT chi lợi nhuận (vẫn file trên — phiếu chi tiền của lần chốt chọn sổ ở
// đó); hộp "Chi tạm ứng cho tôi" của cổ đông tách sang file riêng. Cả hai ô chọn sổ quỹ đều phải qua cùng luật lọc.
const selfAdvanceDialog = readFileSync(
  "src/components/shareholders/ProfitSelfAdvanceDialog.tsx",
  "utf8",
);
// Đợt 2 (sổ tổng): luật lọc sổ của hộp Chi lợi nhuận tách thành hàm thuần dùng chung cho hai chế độ
// (chủ / người giữ sổ tự tạm ứng) — có test hành vi ở src/lib/profitLedger/__tests__/profitLedger.test.ts.
const payoutAccountRule = readFileSync(
  "src/lib/profitLedger/payoutAccounts.ts",
  "utf8",
);
// 18/11/2026: chế độ "Tạm Ứng" của form Thu chi chọn sổ quỹ từ danh sách MÁY CHỦ trả (R3
// shareholder_profit_advance_options_v1 → advance_options.accounts) — máy chủ đã loại sổ ảo và chỉ trả sổ người gọi
// đang giữ; form không thêm sổ nào ngoài danh sách đó.
const advancePanel = readFileSync(
  "src/components/income-expenses/ShareholderAdvanceVoucherPanel.tsx",
  "utf8",
);
const advanceOptionsReader = readFileSync(
  "src/lib/profitLedger/positionReaders.ts",
  "utf8",
);
const tamUngChotSql = readFileSync(
  "supabase/migrations/20261118041911_tam_ung_co_dong_va_chot_chi_loi_nhuan.sql",
  "utf8",
);
// Hộp Duyệt đã gom về MỘT nguồn cho Thu chi máy tính/điện thoại và Báo cáo LN:
// luật lọc sổ nằm ở hook, danh sách sổ được vẽ ở bộ hộp xác nhận dùng chung.
const approvalActions = readFileSync(
  "src/hooks/income-expenses/useVoucherActions.ts",
  "utf8",
);
const approvalDialogs = readFileSync(
  "src/components/income-expenses/VoucherActionDialogs.tsx",
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
    expect(payoutAccountRule).toContain(
      "accounts.filter((account) => !account.is_virtual)",
    );
    // Mọi ô "Chi từ sổ quỹ" của phiếu chi lợi nhuận / tạm ứng: danh sách đi qua profitPayoutAccounts (bỏ sổ ảo)
    // và ô chọn vẽ đúng danh sách đã lọc đó — không file nào tự vẽ thẳng từ danh sách sổ thô.
    for (const dialog of [payoutDialog, selfAdvanceDialog]) {
      expect(dialog).toContain("profitPayoutAccounts({");
      expect(dialog).toContain("options={payoutAccounts.map");
      expect(dialog).not.toMatch(/options=\{\s*(accountsQuery\.data|accounts)\b/);
    }
    expect(payoutDialog).toContain("mode: 'OWNER'");
    expect(selfAdvanceDialog).toContain("mode: 'SELF_ADVANCE'");
    expect(approvalActions).toContain("!!approveTarget?.shareholder_id");
    expect(approvalActions).toContain(
      "accounts.filter((account) => !account.is_virtual)",
    );
    expect(approvalActions).toContain("accounts: approvalAccounts");
    expect(approvalDialogs).toContain("approve.accounts.map");
  });

  it("form Thu chi chế độ Tạm Ứng: ô sổ quỹ chỉ vẽ danh sách máy chủ trả (đã loại sổ ảo), không thêm sổ nào khác", () => {
    // Máy chủ (R3): chỉ sổ TIỀN THẬT của đúng công ty, chưa xoá, người gọi đang giữ.
    const r3 = extractFunction(tamUngChotSql, "shareholder_profit_advance_options_v1");
    expect(r3).toMatch(
      /FROM public\.accounts a\s+WHERE a\.organization_id = p_organization_id\s+AND a\.deleted_at IS NULL\s+AND NOT a\.is_virtual\s+AND app_private\.profit_ledger_chot_holds_cashbook_v1\(/,
    );
    // Bộ đọc lấy đúng mảng `accounts` của máy chủ (không ghép thêm nguồn khác).
    expect(advanceOptionsReader).toContain("list(root.accounts, 'R3.accounts'");
    // Form: ô "Sổ quỹ" của chế độ Tạm Ứng vẽ đúng `options.accounts` — không đọc danh sách sổ thô (useAccounts /
    // quyền giữ sổ phía trình duyệt), không có nguồn sổ thứ hai.
    expect(advancePanel).toContain("options={options.accounts.map((account) => ({ value: account.account_id, label: account.name }))}");
    expect((advancePanel.match(/options=\{/g) ?? []).length).toBe(2); // ô sổ quỹ + ô người nhận, không ô nào khác
    expect(advancePanel).toContain("options={options.payees.map(");
    expect(advancePanel).not.toMatch(/useAccounts|useMyCashbookAccess|profitPayoutAccounts|accountsQuery|is_virtual/);
  });
});
