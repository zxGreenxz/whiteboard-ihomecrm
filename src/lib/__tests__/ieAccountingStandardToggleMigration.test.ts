import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { LEGACY_ROUTES, isFlexibleMode } from "@/lib/financeV2Route";

function readMigration(basename: string): string {
  return readFileSync(resolve(process.cwd(), "supabase/migrations", basename), "utf8");
}

const sql = readMigration("20260730110000_ie_accounting_standard_toggle.sql");

describe("Đợt 1 — công tắc Chuẩn kế toán (server)", () => {
  it("KHÔNG dùng server_feature_flags (bảng đó không có organization_id)", () => {
    // Bật 'linh hoạt cho DEMO' trên cơ chế đó là bật luôn cho org thật.
    expect(sql).not.toMatch(/insert\s+into\s+app_private\.server_feature_flags/i);
    expect(sql).not.toMatch(/set_feature_route_v1/i);
    expect(sql).toContain("app_private.org_accounting_mode");
  });

  it("fail-closed THẬT: thiếu dòng ⇒ CHẶT", () => {
    // COALESCE(..., true) là điểm mấu chốt — org mới không tự được nới lỏng.
    expect(sql).toMatch(/COALESCE\(\s*\(SELECT m\.strict_mode[\s\S]*?\),\s*true/);
    expect(sql).toContain("app_private.ie_accounting_strict_v1");
    expect(sql).toContain("app_private.ie_flex_mode_enabled_v1");
  });

  it("tổ chức là THAM SỐ BẮT BUỘC — không lặp lại bug min(organization_id)", () => {
    expect(sql).toContain("set_ie_accounting_standard_v1(\n  p_organization_id uuid,");
    expect(sql).toContain("Thiếu tổ chức");
    // Mẫu cũ suy ra org kiểu này; tuyệt đối không được xuất hiện lại trong MÃ.
    // Phải bỏ chú thích trước khi soi — phần giải thích bug có trích nguyên văn.
    const code = sql.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/min\(\s*m?\.?organization_id::text\s*\)/i);
  });

  it("quyền chủ kiểm TRONG ĐÚNG org được truyền vào", () => {
    expect(sql).toContain("app_private.is_org_owner_v1(p_organization_id, v_actor)");
    expect(sql).toContain("Chủ sở hữu tổ chức");
  });

  it("sổ chế độ là append-only, không cấp cho client", () => {
    expect(sql).toContain("a00_org_accounting_mode_append_only");
    expect(sql).toContain("a00_org_accounting_mode_no_truncate");
    expect(sql).toMatch(
      /REVOKE ALL ON app_private\.org_accounting_mode\s+FROM PUBLIC, anon, authenticated, service_role/,
    );
  });

  it("cờ client: DROP rồi CREATE và CẤP LẠI quyền (DROP xoá ACL)", () => {
    // CREATE OR REPLACE trên RETURNS TABLE mà thêm cột sẽ raise 42P13.
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.get_finance_v2_client_flags_v1()");
    expect(sql).toContain("accounting_standard_strict boolean");
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_finance_v2_client_flags_v1\(\) TO authenticated/,
    );
    expect(sql).toContain("NOTIFY pgrst");
  });

  it("seed hai org đã biết sang linh hoạt, và nói rõ là cố ý ngược mặc định", () => {
    expect(sql).toContain("aaaa0000-0000-4000-8000-000000000001");
    expect(sql).toContain("dddd0000-0000-4000-8000-000000000001");
    expect(sql).toMatch(/strict_mode = false|false, 'Seed Đợt 1/);
    expect(sql).toContain("CỐ Ý ngược nhau");
  });

  it("KHÔNG đụng 4 hàm chỉ-được-vá-tại-chỗ", () => {
    expect(sql).not.toMatch(/FUNCTION\s+app_private\.finance_v2_auto_posting_bridge/i);
    expect(sql).not.toMatch(/FUNCTION\s+app_private\.guard_income_expense_owned_payload/i);
    expect(sql).not.toMatch(/FUNCTION\s+app_private\.guard_income_expense_owned_items/i);
    expect(sql).not.toMatch(/FUNCTION\s+public\.cancel_income_expense_v1/i);
  });

  it("Đợt 1 BẤT ĐỘNG: chưa writer nào đọc cờ", () => {
    // Không được sửa RPC vòng đời nào trong cùng migration này.
    expect(sql).not.toMatch(/FUNCTION\s+public\.ie_compat_update_pending_v2/i);
    expect(sql).not.toMatch(/FUNCTION\s+public\.approve_income_expense/i);
    expect(sql).not.toMatch(/FUNCTION\s+public\.reverse_posted_income_expense/i);
  });
});

describe("Đợt 1 — cờ chế độ phía client fail-closed", () => {
  it("LEGACY_ROUTES mặc định là CHẶT", () => {
    expect(LEGACY_ROUTES.accountingStandardStrict).toBe(true);
    expect(isFlexibleMode(LEGACY_ROUTES)).toBe(false);
  });

  it("chỉ `false` tường minh mới là linh hoạt", () => {
    expect(isFlexibleMode({ ...LEGACY_ROUTES, accountingStandardStrict: false })).toBe(true);
    expect(isFlexibleMode({ ...LEGACY_ROUTES, accountingStandardStrict: true })).toBe(false);
  });
});
