import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { COLLECTION_BLOCK_TEXT } from "@/hooks/useDeletePayment";
import { readReversalMode } from "@/lib/paymentRecordRpc";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

const sql = readMigration("20260730150000_invoice_collection_inplace_cancel.sql");

describe("Đợt 5 — huỷ tại chỗ phiếu thu hoá đơn", () => {
  it("chốt md5 bản gốc trước khi viết đè hai hàm dài", () => {
    // Thân hàm trên prod hay trôi khỏi file migration. Viết đè mù là xoá bản vá
    // của người khác; migration phải tự dừng nếu prod đã khác bản đã khảo sát.
    expect(sql).toContain("78423815266587a2864ace6558a8fd8a");
    expect(sql).toMatch(/đã trôi khỏi bản khảo sát/);
  });

  it("KHÔNG sinh phiếu đối ứng ở nhánh huỷ tại chỗ", () => {
    // Đường sinh phiếu chỉ được nằm trong nhánh ELSE (chế độ Chuẩn kế toán).
    const inPlaceBranch = sql.slice(
      sql.indexOf("IF v_in_place THEN\n      -- ── HUỶ TẠI CHỖ"),
      sql.indexOf("ELSE\n      -- ── ĐƯỜNG CŨ"),
    );
    expect(inPlaceBranch.length).toBeGreaterThan(100);
    expect(inPlaceBranch).not.toMatch(/INSERT INTO public\.income_expenses\b/i);
  });

  it("tự phát sinh bút toán đảo và soi gương TỪNG DÒNG", () => {
    // Token FINANCE_V2_LIFECYCLE làm cầu a85 tự tắt ⇒ không tự viết thì tiền
    // không nhúc nhích trong im lặng. Và phiếu có tiền thối mang hai dòng nằm ở
    // hai sổ khác nhau, nên không được dựng lại từ total_amount.
    expect(sql).toContain("FINANCE_V2_LIFECYCLE");
    expect(sql).toContain("INSERT INTO public.income_expense_postings");
    expect(sql).toMatch(/SELECT l\.organization_id, v_rev, l\.account_id, 'REVERSAL', -l\.signed_amount/);
    expect(sql).toContain("WHERE l.posting_id = v_active.id");
  });

  it("có hậu điều kiện bút toán triệt tiêu về 0", () => {
    expect(sql).toContain("bút toán không triệt tiêu");
    expect(sql).toMatch(/IF v_sum <> 0 THEN/);
  });

  it("KHÔNG đụng hạng mục phiếu (guard items đóng băng tuyệt đối)", () => {
    // guard_income_expense_owned_items không có cửa token/scope nào; mọi
    // INSERT/UPDATE/DELETE trên items của phiếu flow-owned đều 55000.
    const inPlaceFn = sql.slice(
      sql.indexOf("cancel_collection_voucher_in_place_v1"),
      sql.indexOf("-- ── 5. Hoàn tác thu tiền"),
    );
    expect(inPlaceFn).not.toMatch(/income_expense_items/i);
  });

  it("KHÔNG đụng bảng sở hữu luồng (bất biến tuyệt đối)", () => {
    const inPlaceFn = sql.slice(
      sql.indexOf("cancel_collection_voucher_in_place_v1"),
      sql.indexOf("-- ── 5. Hoàn tác thu tiền"),
    );
    expect(inPlaceFn).not.toMatch(/UPDATE app_private\.income_expense_flow_ownership/i);
  });

  it("chỉ ghi các cột nằm trong allowlist của guard đóng băng", () => {
    const update = sql.slice(
      sql.indexOf("UPDATE public.income_expenses SET\n    approval_status        = 'CANCELLED'"),
      sql.indexOf("WHERE id = p_voucher;\n\n  DELETE FROM app_private.ie_transition_authorization"),
    );
    expect(update.length).toBeGreaterThan(100);
    const allowed = [
      "approval_status", "review_state", "posting_status", "cancellation_kind",
      "active_posting_id_v2", "reversed_by_posting_id", "approval_version", "posting_version",
    ];
    for (const col of allowed) expect(update).toContain(col);
    // total_amount và voucher_date KHÔNG nằm trong allowlist — đụng là 55000.
    expect(update).not.toMatch(/\btotal_amount\s*=/);
    expect(update).not.toMatch(/\bvoucher_date\s*=/);
    // notes là logic tiền thật (lỗ hổng A của Đợt 0) — dấu vết huỷ để bảng riêng.
    expect(update).not.toMatch(/\bnotes\s*=/);
  });

  it("giữ nguyên mọi thứ gánh tiền của đường cũ", () => {
    // recompute_invoice_for_id đọc public.payments chứ không đọc approval_status
    // của phiếu — bỏ bất kỳ cái nào là hoá đơn vẫn hiện ĐÃ THU.
    expect(sql).toContain("UPDATE public.payments");
    expect(sql).toContain("reversed_by_collection_id = p_collection_id");
    expect(sql).toContain("SET status = 'REVERSED'");
    expect(sql).toContain("recompute_invoice_for_id");
    expect(sql).toContain("recompute_contract_deposit_paid");
    expect(sql).toContain("customer_credit_lots");
    expect(sql).toContain("excess_amounts");
    expect(sql).toContain("thứ tự LIFO");
  });

  it("tách nhánh bộ đếm toàn vẹn — nếu không, 4 cờ tính năng kẹt vĩnh viễn", () => {
    expect(sql).toContain("count_invalid_payment_reversals_counter_v1");
    expect(sql).toContain("count_invalid_payment_reversals_in_place_v1");
    // Nhánh cũ được vá vào thân hàm ĐANG CHẠY bằng replace() nên literal trong
    // file bị nhân đôi dấu nháy (chuỗi SQL trong chuỗi SQL).
    expect(sql).toContain("AND reversal.reversal_kind = ''COUNTER_VOUCHER''");
    expect(sql).toContain("reversal.reversal_kind = 'IN_PLACE_CANCEL'");
    // Mặt tiền phải giữ nguyên chữ ký: assert_accounting_feature_activation_v1
    // gọi nó KHÔNG tham số và chặn cứng khi <> 0.
    expect(sql).toMatch(
      /count_invalid_payment_reversals_counter_v1\(p_payment_id\)\s*\+\s*app_private\.count_invalid_payment_reversals_in_place_v1\(p_payment_id\)/,
    );
  });

  it("nhánh mới bắt buộc bút toán triệt tiêu và cấm đảo hai lần", () => {
    expect(sql).toContain("OR posting_net.net <> 0");
    expect(sql).toContain("OR posting_net.reversal_count < 1");
    expect(sql).toMatch(/counter\.reversal_of_income_expense_id = voucher\.id/);
  });

  it("backfill 8 dòng cũ về COUNTER_VOUCHER và khoá bằng CHECK", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS reversal_kind text NOT NULL DEFAULT 'COUNTER_VOUCHER'/);
    expect(sql).toContain("payment_reversals_kind_chk");
    expect(sql).toMatch(/CHECK \(reversal_kind IN \('COUNTER_VOUCHER', 'IN_PLACE_CANCEL'\)\)/);
  });

  it("kỳ đã đóng thì CHẶN kèm hướng dẫn, không lặng lẽ sinh phiếu đối ứng", () => {
    // Quyết định của chủ 29/07/2026. Đường cũ vốn KHÔNG kiểm kỳ nên đây là siết
    // chặt có chủ ý, và thông báo phải chỉ được đường đi tiếp.
    expect(sql).toContain("[PROFIT_LOCKED]");
    expect(sql).toContain("[CASHBOOK_CLOSED]");
    expect(sql).toContain("[HANDOVER_LOCKED]");
    expect(sql).toMatch(/liên hệ quản trị để lập phiếu chi đối ứng ở kỳ hiện tại/);
  });

  it("chế độ Chuẩn kế toán giữ nguyên 100% đường cũ", () => {
    expect(sql).toContain("v_in_place := app_private.ie_flex_mode_enabled_v1(v_org)");
    expect(sql).toContain("INVOICE_COLLECTION_REVERSAL_V5");
    expect(sql).toContain("'Hoàn tác thu tiền ' || COALESCE(v_invoice.invoice_number, '')");
  });

  it("dọn token sau khi dùng", () => {
    expect(sql).toContain("DELETE FROM app_private.ie_transition_authorization WHERE income_expense_id = p_voucher");
  });

  it("hàm nội bộ không lộ ra client, chỉ hai RPC công khai", () => {
    for (const fn of [
      "app_private.cancel_collection_voucher_in_place_v1(uuid, text, uuid, uuid)",
      "app_private.period_block_code_v1(uuid)",
      "app_private.count_invalid_payment_reversals_in_place_v1(uuid)",
      "app_private.count_invalid_payment_reversals_counter_v1(uuid)",
    ]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fn}`);
    }
    expect(sql).toContain("GRANT EXECUTE ON FUNCTION public.can_reverse_collection_v1(uuid[]) TO authenticated");
  });

  it("vị ngữ đọc cho giao diện không rò rỉ sang tổ chức khác", () => {
    const fn = sql.slice(sql.indexOf("FUNCTION public.can_reverse_collection_v1"));
    expect(fn).toContain("organization_memberships");
    expect(fn).toContain("is_super_admin()");
  });
});

describe("Đợt 5 — mặt tiền FE", () => {
  it("có câu giải thích cho mọi mã chặn server trả về", () => {
    // Mã đến từ can_reverse_collection_v1; thiếu một mã là người dùng thấy
    // "undefined" đúng lúc đang lo mất tiền.
    for (const code of [
      "ALREADY_REVERSED", "CASHBOOK_CLOSED", "HANDOVER_LOCKED", "PROFIT_LOCKED", "UNKNOWN",
    ] as const) {
      expect(COLLECTION_BLOCK_TEXT[code]).toBeTruthy();
    }
    expect(COLLECTION_BLOCK_TEXT.PROFIT_LOCKED).toMatch(/quản trị/);
  });

  it("đọc được đường nào đã chạy từ payload RPC", () => {
    expect(readReversalMode({ reversal_mode: "IN_PLACE_CANCEL" })).toBe("IN_PLACE_CANCEL");
    expect(readReversalMode({ reversal_mode: "COUNTER_VOUCHER" })).toBe("COUNTER_VOUCHER");
    // Đường legacy v3 không trả trường này.
    expect(readReversalMode({ collection_id: "x" })).toBeNull();
    expect(readReversalMode(null)).toBeNull();
    expect(readReversalMode({ reversal_mode: "BLAH" })).toBeNull();
  });
});
