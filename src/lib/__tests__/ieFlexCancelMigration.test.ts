import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { FLEX_CANCEL_BLOCK_TEXT } from "@/hooks/income-expenses/flexMutations";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

const sql = readMigration("20260730140000_ie_flex_cancel.sql");
const code = sql.replace(/--[^\n]*/g, "");

describe("Đợt 4 — huỷ một nhát, không phiếu đối ứng", () => {
  it("KHÔNG chèn phiếu mới vào income_expenses", () => {
    // Đây là yêu cầu gốc của chủ: huỷ thì trừ thẳng, đừng đẻ thêm dòng.
    expect(code).not.toMatch(/INSERT INTO public\.income_expenses/i);
  });

  it("TỰ phát sinh bút toán đảo thay vì trông chờ cầu a85", () => {
    // Token FINANCE_V2_LIFECYCLE (bắt buộc để qua trigger đóng băng) lại làm
    // cầu a85 tự tắt ⇒ nếu không tự viết thì tiền không nhúc nhích trong im lặng.
    expect(sql).toContain("INSERT INTO public.income_expense_postings");
    expect(sql).toContain("'REVERSAL'");
    expect(sql).toContain("reversal_of_id");
    expect(sql).toContain("FINANCE_V2_LIFECYCLE");
  });

  it("có hậu điều kiện bút toán triệt tiêu về 0", () => {
    expect(sql).toContain("bút toán không triệt tiêu");
    expect(sql).toMatch(/IF v_sum <> 0 THEN/);
  });

  it("bắt buộc có lý do huỷ", () => {
    expect(sql).toContain("char_length(v_reason) < 8");
    expect(sql).toContain("Phải ghi lý do huỷ");
  });

  it("lưu đủ mốc lập / duyệt / huỷ + lý do", () => {
    expect(sql).toContain("app_private.income_expense_cancellations");
    for (const col of ["created_at_snap", "approved_at_snap", "cancelled_at", "cancel_reason"]) {
      expect(sql).toContain(col);
    }
    expect(sql).toContain("a00_ie_cancellations_append_only");
  });

  it("dấu vết huỷ KHÔNG thêm cột vào income_expenses", () => {
    // Thêm cột buộc phải nới allowlist trigger đóng băng thêm lần nữa, mà bản
    // snapshot của guard đã lạc hậu và tự nhận là an toàn chạy lại.
    expect(code).not.toMatch(/ALTER TABLE public\.income_expenses\s+ADD COLUMN/i);
  });

  it("chỉ nhận phiếu THỦ CÔNG — danh sách CHO PHÉP, không phải danh sách cấm", () => {
    expect(sql).toContain("assert_manual_voucher_v1");
    for (const col of [
      "payment_id",
      "payment_collection_id",
      "invoice_id",
      "salary_staff_id",
      "shareholder_id",
      "profit_manager_id",
      "handover_id",
      "reversal_of_income_expense_id",
      "system_source",
      "profit_payout_reservations",
    ]) {
      expect(sql).toContain(col);
    }
    // flow_kind đọc trực tiếp: assert_income_expense_flow_owner_v2 trả im lặng
    // khi không có dòng sở hữu nên không phải hàng rào.
    expect(sql).toContain("flow_kind");
  });

  it("giữ nguyên quyền: chế độ linh hoạt nới TRẠNG THÁI chứ không nới quyền", () => {
    expect(sql).toContain("'income_expenses.cancel'");
    expect(sql).toContain("assert_cashbook_access_v2");
    expect(sql).toContain("'CUSTODIAN'");
  });

  it("tôn trọng công tắc chế độ và kỳ đã đóng", () => {
    expect(sql).toContain("ie_flex_mode_enabled_v1");
    expect(sql).toContain("[STRICT_MODE]");
    expect(sql).toContain("assert_period_open_for_edit_v1");
  });

  it("có CAS chống hai người cùng thao tác", () => {
    expect(sql).toContain("p_expected_approval_version");
    expect(sql).toContain("p_expected_posting_version");
    expect(sql).toContain("40001");
  });

  it("chặn khôi phục phiếu đã chi rồi mới huỷ", () => {
    expect(sql).toContain("CANCELLED_AFTER_POSTING");
    expect(sql).toContain("restore_income_expense");
    // vá tại chỗ, có neo
    expect(sql).toContain("Không khớp mẫu neo trong restore_income_expense");
    expect(code).not.toMatch(/CREATE OR REPLACE FUNCTION public\.restore_income_expense/i);
  });

  it("RPC hỏi-trước chỉ trả MÃ, không lộ tên sổ quỹ", () => {
    expect(sql).toContain("reason_code text");
    expect(sql).toContain("'NOT_MANUAL'");
    expect(sql).not.toMatch(/reason_code := SQLERRM/);
  });

  it("KHÔNG đụng cầu a85 và guard đóng băng", () => {
    expect(code).not.toMatch(/FUNCTION\s+app_private\.finance_v2_auto_posting_bridge/i);
    expect(code).not.toMatch(/FUNCTION\s+app_private\.guard_income_expense_owned_payload/i);
  });
});

describe("Đợt 4 — chữ hiển thị lý do không huỷ nhanh được", () => {
  it("phủ đủ mọi mã server có thể trả", () => {
    for (const code of [
      "STRICT_MODE",
      "NOT_MANUAL",
      "CASHBOOK_CLOSED",
      "HANDOVER_LOCKED",
      "PROFIT_LOCKED",
      "UNKNOWN",
    ] as const) {
      expect(FLEX_CANCEL_BLOCK_TEXT[code].length).toBeGreaterThan(0);
    }
  });
});
