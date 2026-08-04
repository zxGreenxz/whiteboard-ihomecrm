import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

/**
 * Đợt 0 — vá 4 lỗ hổng phân quyền có thật trên production (đo 29-30/07/2026).
 *
 * Các test này là CHARACTERIZATION: chúng khoá lại đúng những mệnh đề mà bản vá
 * dựa vào, để một lần sửa sau đó vô tình gỡ rào là đỏ ngay. Chúng KHÔNG chạy SQL —
 * bằng chứng hành vi nằm ở bộ probe đã chạy trên org DEMO (ghi trong plan).
 */

describe("Đợt 0 — LỖ A/B: siết ghi metadata phiếu thu chi", () => {
  const sql = readMigration("20260730100000_ie_meta_write_hardening.sql");

  it("nhận diện đúng HAI dấu hiệu tiền nhúng trong notes", () => {
    // Hai chuỗi này là logic tiền thật, không phải chữ trang trí:
    //  - recompute_invoice_for_id TRỪ tiền hoá đơn theo '[Hoàn trả thanh lý]%'
    //  - trg_forfeit_settle_on_approve rẽ nhánh theo '[CẤN CỌC BỎ CỌC %'
    expect(sql).toContain("'[Hoàn trả thanh lý]%'");
    expect(sql).toContain("'[CẤN CỌC BỎ CỌC %'");
    expect(sql).toContain("app_private.ie_notes_money_markers_v1");
    expect(sql).toContain("app_private.assert_notes_markers_unchanged_v1");
  });

  it("canh dấu ghi chú ở CẢ HAI writer, không chỉ một", () => {
    const guardCalls = sql.match(/assert_notes_markers_unchanged_v1\s*\(/g) ?? [];
    // 1 lần định nghĩa + 2 lần gọi (compat_update + quick)
    expect(guardCalls.length).toBeGreaterThanOrEqual(3);
    expect(sql).toContain("public.ie_compat_update_pending_v2");
    expect(sql).toContain("public.update_income_expense_quick");
  });

  it("ảnh chứng từ chỉ NỐI THÊM khi phiếu đã duyệt/ghi sổ", () => {
    expect(sql).toContain("app_private.ie_attachments_union_v1");
    // Chỉ được thay cả mảng khi còn Chờ duyệt và chưa ghi sổ.
    expect(sql).toContain("v_can_replace_attachments");
    expect(sql).toMatch(/v_row\.approval_status\s*=\s*'UNAPPROVED'/);
  });

  it("đổi sổ quỹ đòi GIỮ SỔ cả bên đi lẫn bên đến", () => {
    const custodianAsserts = sql.match(/assert_cashbook_access_v2\s*\(/g) ?? [];
    // 2 lần trong compat_update (sổ cũ + sổ mới) + 2 lần trong quick
    expect(custodianAsserts.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain("'CUSTODIAN'");
  });

  it("chặn đổi sổ quỹ trên phiếu ĐÃ GHI SỔ (lỗ B)", () => {
    expect(sql).toContain("Phiếu đã ghi sổ — không đổi sổ quỹ ở đây");
    expect(sql).toMatch(/COALESCE\(v_before\.posting_status,\s*'UNPOSTED'\)\s*=\s*'POSTED'/);
  });

  it("sửa nhanh để lại dấu vết (trước đây không ghi gì)", () => {
    expect(sql).toContain("app_private.append_income_expense_event_v1");
  });

  it("client không còn tự đặt accounting_class cho item", () => {
    // set_ie_item_accounting_class chỉ suy ra khi NULL ⇒ client gửi 'PNL' cho
    // hạng mục CỌC là rút contracts.deposit_paid và thổi KQKD.
    expect(sql).toContain("v_item_keys");
    expect(sql).not.toMatch(/v_item_keys[^;]*accounting_class/);
    expect(sql).not.toMatch(/v_item_keys[^;]*'organization_id'/);
  });

  it("KHÔNG đụng vào 4 hàm chỉ-được-vá-tại-chỗ", () => {
    // Viết đè bằng CREATE OR REPLACE từ file migration cũ sẽ xoá hai bản vá
    // hotfix của cầu a85 và tái sinh sự cố double-posting.
    expect(sql).not.toMatch(/FUNCTION\s+app_private\.finance_v2_auto_posting_bridge/i);
    expect(sql).not.toMatch(/FUNCTION\s+app_private\.guard_income_expense_owned_payload/i);
    expect(sql).not.toMatch(/FUNCTION\s+app_private\.guard_income_expense_owned_items/i);
    expect(sql).not.toMatch(/FUNCTION\s+public\.cancel_income_expense_v1/i);
  });
});

describe("Đợt 0 — LỖ C: RPC tổng hợp sổ quỹ rò tồn quỹ", () => {
  const sql = readMigration("20260730101000_cashbook_aggregate_possession.sql");

  it("cả BA hàm tổng hợp đều tự kiểm phạm vi nhìn", () => {
    for (const fn of [
      "cashbook_period_totals_v2",
      "cashbook_opening_balance_v2",
      "cashflow_by_day_v2",
    ]) {
      expect(sql).toContain(`public.${fn}`);
    }
    const asserts = sql.match(/assert_cashbook_readable_v1\s*\(/g) ?? [];
    expect(asserts.length).toBeGreaterThanOrEqual(4); // 1 định nghĩa + 3 lần gọi
  });

  it("lọc theo tập sổ nhìn thấy được kể cả khi không truyền p_account_id", () => {
    const filters = sql.match(/ie_visible_cashbook_ids_v1\(\)\s*v\)/g) ?? [];
    expect(filters.length).toBeGreaterThanOrEqual(3);
  });

  it("giữ lối thoát cho super admin để không làm chết bảng điều khiển của chủ", () => {
    // finance_v2_can_read_posting_v1 thuần CHỈ nhận CUSTODIAN và không có
    // đường cho super admin ⇒ áp thẳng sẽ đưa số của chủ về 0.
    expect(sql).toContain("public.is_super_admin()");
    expect(sql).toContain("public.is_account_shared_with_me");
    expect(sql).toContain("'CUSTODIAN'");
  });

  it("ném 42501 thay vì trả 0 im lặng", () => {
    expect(sql).toContain("Không có quyền xem số dư của sổ quỹ này");
    expect(sql).toContain("42501");
  });

  it("helper nội bộ không lộ cho client", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION app_private\.ie_visible_cashbook_ids_v1\(\)[\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
    );
  });
});

describe("Đợt 0 — LỖ D: quyền DML thừa trên bảng tiền", () => {
  const sql = readMigration("20260730102000_money_tables_revoke_dml.sql");

  it("cắt DML trên accounts — đường tự mở khoá sổ và tự đổi số dư", () => {
    expect(sql).toMatch(
      /REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public\.accounts\s+FROM authenticated, anon/,
    );
  });

  it("cắt DML trên hai bảng bàn giao và bảng đối chiếu", () => {
    for (const t of [
      "public.cash_handovers",
      "public.cash_handover_items",
      "public.cashbook_reconciliations",
    ]) {
      expect(sql).toContain(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ${t}`);
    }
  });

  it("cắt TRUNCATE trên bảng phiếu và bảng posting (TRUNCATE bỏ qua RLS)", () => {
    for (const t of [
      "public.income_expenses",
      "public.income_expense_items",
      "public.income_expense_postings",
      "public.income_expense_posting_lines",
    ]) {
      expect(sql).toMatch(new RegExp(`REVOKE TRUNCATE ON ${t.replace(".", "\\.")}`));
    }
  });

  it("GIỮ quyền SELECT — không cắt nhầm đường đọc", () => {
    // Bỏ chú thích trước khi soi, nếu không chữ "SELECT" trong phần giải thích
    // sẽ làm test đỏ oan.
    const code = sql.replace(/--[^\n]*/g, "");
    const revokes = code.match(/REVOKE[\s\S]*?;/gi) ?? [];
    expect(revokes.length).toBeGreaterThan(0);
    for (const stmt of revokes) {
      expect(stmt).not.toMatch(/\bSELECT\b/i);
    }
  });
});
