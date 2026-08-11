import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Án lệ 07/08/2026 (phiên của Nathan): tạo Phiếu chi hạng mục "Vệ Sinh Phòng"
// chết 403/42501 "Loại hạng mục 1 không thuộc tổ chức hoặc sai chiều thu/chi".
// Gốc: Sprint 3b (20260713121000) gắn RESTRICTIVE *_org_boundary cho 28 bảng
// tenant nhưng BỎ SÓT income_expense_types, mà policy SELECT duy nhất của bảng
// (income_expense_types_select_rbac) chỉ hỏi capability toàn cục
// can_access_org_entity('categories','view') — không so organization_id. Người
// dùng vì thế THẤY hạng mục của mọi tổ chức; hai org seed cùng lúc có hạng mục
// trùng tên nên dropdown bốc nhầm id org khác, còn create_income_expense_v1
// (đòi type cùng org caller) từ chối đúng luật.
const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260807163000_ie_types_org_boundary.sql"),
  "utf8",
);

describe("RESTRICTIVE org boundary cho income_expense_types", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("policy là RESTRICTIVE — siết chứ không nới quyền hiện có", () => {
    expect(sql).toMatch(
      /CREATE POLICY income_expense_types_org_boundary ON public\.income_expense_types\s+AS RESTRICTIVE/i,
    );
  });

  it("dùng đúng công thức boundary của 28 bảng Sprint 3b, không bịa luật mới", () => {
    const formula =
      /organization_id IS NULL OR \(SELECT public\.is_super_admin\(\)\) OR organization_id IN \(SELECT unnest\(public\.my_org_ids\(\)\)\)/;
    const usingCount = sql.match(new RegExp(formula, "g")) ?? [];
    expect(usingCount.length).toBe(2); // USING + WITH CHECK
  });

  it("phủ cả đọc lẫn ghi (FOR ALL) trên role authenticated", () => {
    expect(sql).toMatch(/FOR ALL TO authenticated/i);
    expect(sql).toMatch(/WITH CHECK \(/i);
  });

  it("idempotent — drop trước khi create", () => {
    expect(sql).toMatch(
      /DROP POLICY IF EXISTS income_expense_types_org_boundary ON public\.income_expense_types/i,
    );
  });

  it("KHÔNG đụng tới policy cũ nào của bảng (chỉ THÊM lớp restrictive)", () => {
    for (const keep of [
      "income_expense_types_select_rbac",
      "income_expense_types_restricted_select",
      "income_expense_types_select_shareholder",
      "ie_canonical_writer_read",
    ]) {
      expect(sql).not.toMatch(new RegExp(`DROP POLICY[^;]*${keep}`, "i"));
    }
  });

  it("có preflight chặn khoá nhầm dữ liệu và verify sau khi tạo", () => {
    expect(sql).toMatch(/DO \$preflight\$/);
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/polpermissive/);
  });

  it("ghi rõ đường rollback", () => {
    expect(sql).toMatch(/ROLLBACK:/);
  });
});
