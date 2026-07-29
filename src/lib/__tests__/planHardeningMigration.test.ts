import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseMoneyInput, formatMoney, sameMoney } from "@/lib/moneyInput";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

const w1 = readMigration("20260730190000_plan_hardening_wave1.sql");
const w2 = readMigration("20260730200000_plan_hardening_wave2.sql");

describe("Siết plan đợt 1 — những lỗ ma trận bới ra", () => {
  it("repeat_* rời khỏi metadata sang trục tiền", () => {
    // Cron recurring_vouchers_daily biến repeat_* thành máy in tiền: nó INSERT
    // phiếu con APPROVED vào SỔ CỦA PHIẾU MẸ. Xếp chúng vào meta là cho người
    // chỉ có income_expenses.edit trên toà bật máy in trên phiếu người khác.
    expect(w1).toContain("v_meta_keys text[] := ARRAY[''name'',''notes'',''attachments''];");
    expect(w1).toMatch(/''repeat_cycle'',''repeat_count'',''repeat_infinity'',''repeat_auto_approve'',/);
    expect(w1).toContain("''payer_name'',''receive_bank_name'',''receive_bank_account'',");
    // Phải có chốt chặn: nếu prod đã đổi thì DỪNG chứ không vá mù.
    expect(w1).toContain("Không khớp mẫu neo v_money_keys — DỪNG, không vá mù");
  });

  it("p_notes = NULL không xoá trắng ghi chú, và vá CẢ assert marker", () => {
    expect(w1).toContain("notes       = COALESCE(p_notes, notes)");
    expect(w1).toContain("COALESCE(p_notes, v_before.notes)");
    expect(w1).toMatch(/Phải vá CẢ HAI chỗ/);
  });

  it("is_org_owner_v1 tôn trọng cửa sổ hiệu lực của BINDING", () => {
    // Cả repo thu hồi vai trò bằng rb.valid_to = now(); thiếu vế này thì người
    // đã bị tước vai chủ vẫn đi thẳng qua Đợt 1/2/4/6.
    expect(w1).toMatch(/COALESCE\(rb\.valid_from, '-infinity'::timestamptz\) <= now\(\)/);
    expect(w1).toMatch(/rb\.valid_to IS NULL OR rb\.valid_to > now\(\)/);
  });

  it("lock_cashbook_period_v1 không còn là cửa cho client", () => {
    expect(w1).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\.lock_cashbook_period_v1\(uuid, date, boolean\)\s*\n\s*FROM authenticated, anon, service_role;/,
    );
  });

  it("vị ngữ kỳ-mở soi cả handover_transfer_id", () => {
    expect(w1).toContain("v_row.handover_transfer_id IS NOT NULL");
    expect(w1).toContain("v.handover_transfer_id IS NOT NULL");
  });

  it("chặn ghi tay cột dẫn xuất paid_amount, và guard là SECURITY INVOKER", () => {
    expect(w1).toContain("guard_invoice_derived_columns");
    expect(w1).toContain("a00_invoice_derived_guard");
    expect(w1).toContain("NEW.paid_amount IS DISTINCT FROM OLD.paid_amount");
    // Chỉ nổ với vai client — writer SECURITY DEFINER (postgres) phải đi lọt.
    expect(w1).toContain("current_user NOT IN ('authenticated', 'anon')");
    // KHÔNG được khai SECURITY DEFINER: trong hàm DEFINER thì current_user luôn
    // là postgres nên guard sẽ không chặn được ai.
    const fn = w1.slice(
      w1.indexOf("FUNCTION public.guard_invoice_derived_columns"),
      w1.indexOf("DROP TRIGGER IF EXISTS a00_invoice_derived_guard"),
    );
    expect(fn.length).toBeGreaterThan(200);
    expect(fn).not.toMatch(/SECURITY\s+DEFINER/i);
  });

  it("KHÔNG revoke cả bảng invoices/payments khỏi authenticated", () => {
    // FE có 8 đường ghi hợp lệ (status, approved_at, notes, subtotal…);
    // revoke cả bảng là gãy app. Chỉ TRUNCATE bị thu hồi.
    expect(w1).toContain("REVOKE TRUNCATE ON public.invoices FROM authenticated;");
    expect(w1).not.toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.invoices FROM authenticated/);
    expect(w1).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.invoices FROM anon;");
  });
});

describe("Siết plan đợt 2 — vị ngữ đọc phải nói đúng sự thật của writer", () => {
  it("khoá kỳ áp dụng cho CẢ HAI chế độ kế toán", () => {
    // Quyết định #5 nói về KỲ, không nói về chế độ. Bản Đợt 5 đặt vòng kiểm
    // trong nhánh linh hoạt nên Chuẩn kế toán đi thẳng — đo thật đã hoàn tác
    // được khoản thu của tháng lợi nhuận đã chốt.
    expect(w2).toContain("KIỂM KỲ CHO CẢ HAI CHẾ ĐỘ");
    expect(w2).toContain("Không khớp mẫu neo nhánh kiểm kỳ — DỪNG, không vá mù");
  });

  it("can_reverse_collection_v1 kiểm đủ quyền, LIFO và credit như writer", () => {
    const fn = w2.slice(
      w2.indexOf("FUNCTION public.can_reverse_collection_v1"),
      w2.indexOf("FUNCTION public.can_flex_cancel_v1"),
    );
    expect(fn).toContain("'thu_tien.undo'");
    expect(fn).toContain("'NO_PERMISSION'");
    expect(fn).toContain("'NOT_LIFO'");
    expect(fn).toContain("'CREDIT_USED'");
    // Quyền phải kiểm ở CẢ cấp toà lẫn TỪNG sổ quỹ nguồn — writer kiểm hai lần.
    expect(fn).toMatch(/'thu_tien\.undo', v_inv\.building_id, NULL/);
    expect(fn).toMatch(/'thu_tien\.undo', v_inv\.building_id, t\.account_id/);
  });

  it("can_flex_cancel_v1 kiểm đủ như writer", () => {
    const fn = w2.slice(w2.indexOf("FUNCTION public.can_flex_cancel_v1"));
    for (const code of [
      "DELETED", "ALREADY_CANCELLED", "STRICT_MODE", "RESTRICTED",
      "NO_ACTIVE_POSTING", "NO_PERMISSION", "NOT_CUSTODIAN",
    ]) {
      expect(fn).toContain(`'${code}'`);
    }
    expect(fn).toContain("'income_expenses.cancel'");
    expect(fn).toContain("assert_cashbook_access_v2");
    // Chủ tổ chức / super admin vào thẳng — đúng quyết định #4.
    expect(fn).toContain("is_org_owner_v1");
  });

  it("cả hai reader vẫn không rò rỉ sang tổ chức khác", () => {
    for (const fnName of ["can_reverse_collection_v1", "can_flex_cancel_v1"]) {
      const fn = w2.slice(w2.indexOf("FUNCTION public." + fnName));
      expect(fn).toContain("organization_memberships");
    }
  });

  it("cancel_income_expense_flex_v1 kiểm thành viên TRƯỚC mọi thông điệp", () => {
    // Thứ tự cũ để lộ: phiếu có tồn tại không, system_source gì, và cả TÊN SỔ
    // QUỸ + ngày chốt của tổ chức khác qua [CASHBOOK_CLOSED].
    expect(w2).toContain("người ngoài không được nghe");
    expect(w2).toContain("Không thuộc tổ chức của phiếu");
  });
});

describe("Đọc số tiền người dùng gõ", () => {
  it("hiểu dấu chấm phân cách hàng nghìn kiểu Việt", () => {
    // Regex cũ giữ dấu chấm: "2.655.000" -> NaN (nút xác nhận không bao giờ
    // bật) và "-680.000" -> -680 (SAI 1000 lần, ghi thẳng vào biên bản chốt sổ).
    expect(parseMoneyInput("2.655.000")).toBe(2655000);
    expect(parseMoneyInput("2655000")).toBe(2655000);
    expect(parseMoneyInput("-680.000")).toBe(-680000);
    expect(parseMoneyInput("2.655.000đ")).toBe(2655000);
    expect(parseMoneyInput("1.000")).toBe(1000);
  });

  it("rỗng / rác trả null chứ không phải 0", () => {
    // Trả 0 sẽ thành "đã đếm 0đ" — một con số hợp lệ nhưng sai.
    for (const s of ["", "   ", "abc", "-", null, undefined]) {
      expect(parseMoneyInput(s as string)).toBeNull();
    }
  });

  it("so tiền theo đồng, chịu được cả number lẫn string từ jsonb", () => {
    expect(sameMoney(2655000, "2655000")).toBe(true);
    expect(sameMoney("2655000.00", 2655000)).toBe(true);
    expect(sameMoney(2655000, 2655001)).toBe(false);
    expect(sameMoney(null, 1)).toBe(false);
    expect(sameMoney(1, undefined)).toBe(false);
  });

  it("định dạng lại theo kiểu Việt", () => {
    expect(formatMoney(2655000)).toContain("2.655.000");
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(Number.NaN)).toBe("—");
  });
});
