import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  PERIOD_BLOCK_DETAIL,
  PERIOD_BLOCK_SHORT,
  periodBlockCodeFromError,
  periodBlockMessage,
} from "@/lib/cashbookClosing";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

const lock = readMigration("20260730130000_cashbook_lock_hardening.sql");
const pred = readMigration("20260730131000_period_open_predicate.sql");
const lockCode = lock.replace(/--[^\n]*/g, "");

describe("Đợt 3 — siết khoá sổ", () => {
  it("kiểm CẢ OLD LẪN NEW, không chỉ NEW", () => {
    // Bản cũ chỉ đọc NEW.account_id / NEW.voucher_date nên đổi sổ hoặc đẩy
    // ngày là thoát khỏi kỳ khoá.
    expect(lock).toContain("OLD.account_id");
    expect(lock).toContain("NEW.account_id");
    expect(lock).toContain("OLD.voucher_date");
    expect(lock).toContain("NEW.voucher_date");
  });

  it("kiểm cả sổ thối và sổ làm tròn", () => {
    // Tồn quỹ cộng theo account của TỪNG DÒNG posting; dòng CHANGE/ROUNDING
    // rơi vào sổ khác với header.
    for (const col of ["change_account_id", "rounding_account_id"]) {
      expect(lock).toContain(`OLD.${col}`);
      expect(lock).toContain(`NEW.${col}`);
    }
  });

  it("bỏ mệnh đề WHEN từng cho soft-delete thoát khỏi kỳ khoá", () => {
    expect(lockCode).not.toMatch(/WHEN \(OLD\.deleted_at IS NULL\)/i);
    expect(lock).toContain("CREATE TRIGGER trg_ie_check_lock_upd");
  });

  it("giữ khoá dòng để giao dịch chốt sổ không bị lọt phiếu", () => {
    expect(lock).toContain("FOR KEY SHARE");
  });

  it("khoá cả hạng mục lẫn dòng bút toán", () => {
    expect(lock).toContain("a01_ie_items_check_lock");
    expect(lock).toContain("a01_ie_posting_lines_check_lock");
  });

  it("bút toán ĐẢO xét theo kỳ của bút toán GỐC", () => {
    // Nếu xét theo ngày của chính nó thì chốt tới HÔM NAY sẽ khoá luôn ngày đó.
    expect(lock).toContain("reversal_of_id");
    expect(lock).toContain("event_kind = 'REVERSAL'");
  });

  it("đóng băng cả số dư đầu, không chỉ ngày khoá", () => {
    // accounts_with_balance = initial_amount + Σ dòng posting ⇒ đổi
    // initial_amount là đổi chính con số người nhận đã ký.
    expect(lock).toContain("a00_accounts_closed_book_guard");
    for (const col of ["initial_amount", "initial_date", "is_virtual", "organization_id", "user_id"]) {
      expect(lock).toContain(col);
    }
  });

  it("guard sổ quỹ phải là SECURITY INVOKER", () => {
    // Trong hàm SECURITY DEFINER owner postgres thì guard không chặn được ai.
    const fn = lock.slice(lock.indexOf("FUNCTION public.accounts_closed_book_guard"));
    const header = fn.slice(0, fn.indexOf("AS $fn$"));
    expect(header).not.toMatch(/SECURITY DEFINER/i);
  });

  it("mở khoá không còn là một khái niệm", () => {
    expect(lock).toContain("Không mở khoá kỳ đã chốt");
    expect(lock).toContain("REVOKE EXECUTE ON FUNCTION public.create_opening_adjustment");
  });

  it("biên bản chốt là append-only và không cấp cho client", () => {
    expect(lock).toContain("a00_cashbook_closures_append_only");
    expect(lock).toContain("a00_cashbook_closures_no_truncate");
    expect(lock).toMatch(
      /REVOKE ALL ON app_private\.cashbook_closures FROM PUBLIC, anon, authenticated, service_role/,
    );
  });

  it("miễn trừ demo là cờ THEO TRANSACTION, không phải theo tài khoản", () => {
    // Miễn trừ theo "sổ của người dùng demo" sẽ đưa TOÀN BỘ org DEMO — nơi chạy
    // mọi kiểm thử — ra ngoài vòng khoá, tức thứ được test không phải thứ chạy thật.
    expect(lock).toContain("current_setting('app_private.demo_reset', true)");
    expect(lockCode).not.toMatch(/is_demo_cashbook_v1/);
    expect(lock).toContain("set_config(''app_private.demo_reset'', ''on'', true)");
  });

  it("vá demo_reset TẠI CHỖ, có neo và cờ idempotent", () => {
    expect(lock).toContain("pg_get_functiondef");
    expect(lock).toContain("Không khớp mẫu neo trong demo_reset");
    expect(lockCode).not.toMatch(/CREATE OR REPLACE FUNCTION public\.demo_reset/i);
  });

  it("KHÔNG đụng cầu a85 và guard đóng băng", () => {
    expect(lockCode).not.toMatch(/FUNCTION\s+app_private\.finance_v2_auto_posting_bridge/i);
    expect(lockCode).not.toMatch(/FUNCTION\s+app_private\.guard_income_expense_owned_payload/i);
  });

  it("vẫn cho bổ sung ảnh/ghi chú sau khi chốt (quyết định #8), có tự kiểm delta", () => {
    expect(lock).toContain("scope = 'ANNOTATE'");
    expect(lock).toContain("ARRAY['attachments','notes','updated_at']");
  });
});

describe("Đợt 3 — vị ngữ kỳ còn mở", () => {
  it("phủ đủ ba nguyên nhân", () => {
    expect(pred).toContain("[CASHBOOK_CLOSED]");
    expect(pred).toContain("[HANDOVER_LOCKED]");
    expect(pred).toContain("[PROFIT_LOCKED]");
  });

  it("bỏ qua phiếu ngoài KQKD khi xét tháng lợi nhuận", () => {
    expect(pred).toContain("business_result_accounting");
  });

  it("RPC đọc chỉ trả MÃ, không trả tên sổ quỹ", () => {
    expect(pred).toContain("reason_code text");
    expect(pred).toContain("'CASHBOOK_CLOSED'");
    // Không được trả nguyên văn SQLERRM ra ngoài.
    expect(pred).not.toMatch(/reason_code := SQLERRM/);
  });

  it("RPC đọc chặn người ngoài tổ chức", () => {
    expect(pred).toContain("organization_memberships");
    expect(pred).toContain("is_super_admin");
  });
});

describe("Đợt 3 — dịch lý do sang tiếng Việt", () => {
  it("nhận đúng mã từ thông báo lỗi", () => {
    expect(periodBlockCodeFromError("[CASHBOOK_CLOSED] Sổ quỹ ...")).toBe("CASHBOOK_CLOSED");
    expect(periodBlockCodeFromError("[HANDOVER_LOCKED] ...")).toBe("HANDOVER_LOCKED");
    expect(periodBlockCodeFromError("[PROFIT_LOCKED] ...")).toBe("PROFIT_LOCKED");
    expect(periodBlockCodeFromError("loi khac")).toBeNull();
  });

  it("giữ nguyên thông báo gốc (đã có tên sổ + ngày) nhưng bỏ tiền tố kỹ thuật", () => {
    const out = periodBlockMessage('[CASHBOOK_CLOSED] Sổ quỹ "A" đã chốt tới 19/07/2026.');
    expect(out).toBe('Sổ quỹ "A" đã chốt tới 19/07/2026.');
  });

  it("lỗi không liên quan thì trả null để caller giữ nguyên", () => {
    expect(periodBlockMessage("Không đủ quyền")).toBeNull();
  });

  it("có đủ câu ngắn và câu chi tiết cho mọi mã", () => {
    for (const code of ["CASHBOOK_CLOSED", "HANDOVER_LOCKED", "PROFIT_LOCKED", "UNKNOWN"] as const) {
      expect(PERIOD_BLOCK_SHORT[code].length).toBeGreaterThan(0);
      expect(PERIOD_BLOCK_DETAIL[code].length).toBeGreaterThan(20);
    }
  });
});
