import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { canShowAnnotateAction } from "@/lib/voucherAnnotate";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

const sql = readMigration("20260730120000_ie_annotate_v1.sql");
const code = sql.replace(/--[^\n]*/g, "");

// Byte dieu khien dung String.fromCharCode de chinh file test nay khong chua
// byte dieu khien (tung lam migration bi coi la binary va hong khi apply).
const CONTROL_CHARS = Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)).filter(
  (c) => ![9, 10, 13].includes(c.charCodeAt(0)),
);

describe("Đợt 2 — annotate: ảnh + ghi chú trên mọi phiếu", () => {
  it("năng lực nằm ở bảng xid riêng, KHÔNG mượn purpose của ie_transition_authorization", () => {
    // purpose 'FINANCE_V2_LIFECYCLE' làm cầu a85 tự tắt, và PK của bảng token
    // chỉ là (income_expense_id) nên purpose bị writer canon ghi đè.
    expect(sql).toContain("app_private.ie_flex_writer_xids");
    expect(code).not.toMatch(/ie_transition_authorization/);
  });

  it("năng lực bị khoá khỏi mọi role client", () => {
    for (const fn of ["begin_ie_flex_write_v1", "end_ie_flex_write_v1"]) {
      expect(sql).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION app_private\\.${fn}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated, service_role`,
        ),
      );
    }
    expect(sql).toMatch(
      /REVOKE ALL ON app_private\.ie_flex_writer_xids\s+FROM PUBLIC, anon, authenticated, service_role/,
    );
  });

  it("vá guard TẠI CHỖ có neo + cờ idempotent + dừng khi lệch mẫu", () => {
    expect(sql).toContain("pg_get_functiondef");
    expect(sql).toContain("Không khớp mẫu neo trong guard");
    expect(sql).toContain("Vá guard thất bại");
    // Tuyệt đối không viết đè toàn hàm từ file cũ.
    expect(code).not.toMatch(
      /CREATE OR REPLACE FUNCTION app_private\.guard_income_expense_owned_payload/i,
    );
  });

  it("cửa ANNOTATE chỉ mở đúng ba cột", () => {
    expect(sql).toContain("array['attachments','notes','updated_at']");
    expect(sql).toContain("annotate scope may only change attachments/notes");
    expect(sql).toContain("w.scope = 'ANNOTATE'");
    // Phải khớp cả backend_pid, không chỉ xid.
    expect(sql).toContain("w.backend_pid = pg_backend_pid()");
  });

  it("RPC không bao giờ chạm trục tiền", () => {
    const rpc = sql.slice(sql.indexOf("FUNCTION public.annotate_income_expense_v1"));
    const body = rpc.slice(rpc.indexOf("UPDATE public.income_expenses"), rpc.indexOf("PERFORM app_private.end_ie_flex_write_v1"));
    expect(body).toContain("attachments");
    expect(body).toContain("notes");
    for (const forbidden of ["account_id", "total_amount", "approval_status", "voucher_date"]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("giữ nguyên bộ canh dấu hiệu tiền trong ghi chú", () => {
    expect(sql).toContain("app_private.assert_notes_markers_unchanged_v1");
  });

  it("gỡ ảnh đòi quyền sửa thật, không chỉ là người lập phiếu", () => {
    expect(sql).toContain("Chỉ người có quyền sửa thu chi mới gỡ được ảnh chứng từ");
    expect(sql).toContain("v_may_remove := v_can_edit");
  });

  it("hạng mục hạn chế vẫn bị canh (SECURITY DEFINER đi vòng qua RLS)", () => {
    expect(sql).toContain("has_restricted_item");
    expect(sql).toContain("public.can_view_restricted_ie()");
  });

  it("luôn ghi nhật ký", () => {
    expect(sql).toContain("app_private.append_income_expense_event_v1");
  });

  it("kiểm URL bằng lớp POSIX, không phải dải ký tự viết nhầm", () => {
    // '[ -]' là DẢI từ space tới hyphen — bẫy dễ mắc; phải là lớp cntrl.
    expect(sql).toContain("[[:cntrl:]]");
    expect(sql).toContain("^https://");
  });

  it("file không lẫn byte điều khiển (từng làm hỏng migration)", () => {
    for (const c of CONTROL_CHARS) expect(sql.includes(c)).toBe(false);
  });

  it("KHÔNG đụng cầu a85", () => {
    expect(code).not.toMatch(/FUNCTION\s+app_private\.finance_v2_auto_posting_bridge/i);
  });
});

describe("Đợt 2 — ai thấy nút bổ sung chứng từ", () => {
  const base = {
    hasHandler: true,
    isUnapproved: false,
    isAdmin: false,
    isCreator: false,
    canEdit: false,
  };

  it("người lập phiếu thấy", () => {
    expect(canShowAnnotateAction({ ...base, isCreator: true })).toBe(true);
  });

  it("người có quyền sửa thu chi cũng thấy (đây là điểm mới của Đợt 2)", () => {
    expect(canShowAnnotateAction({ ...base, canEdit: true })).toBe(true);
  });

  it("người không liên quan thì không", () => {
    expect(canShowAnnotateAction(base)).toBe(false);
  });

  it("phiếu Chờ duyệt dùng form sửa đầy đủ, không dùng nút này", () => {
    expect(canShowAnnotateAction({ ...base, isCreator: true, isUnapproved: true })).toBe(false);
  });

  it("admin đã có nút sửa đầy đủ", () => {
    expect(canShowAnnotateAction({ ...base, isCreator: true, isAdmin: true })).toBe(false);
  });

  it("không có handler thì không hiện", () => {
    expect(canShowAnnotateAction({ ...base, isCreator: true, hasHandler: false })).toBe(false);
  });
});
