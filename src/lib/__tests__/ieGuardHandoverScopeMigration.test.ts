import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Bàn giao tiền mặt chết 55000 "canonical income expense … is frozen (update
// rejected)" (án lệ 07/08/2026, phiên của Hiển): create_cash_handover UPDATE
// handover_id nhưng guard phiếu canonical KHÔNG có cửa HANDOVER — mọi phiếu
// sinh qua create_income_expense_v1 (từ 18/07) đều flow-owned, và phiên bàn
// giao đầu tiên chứa phiếu như vậy rollback nguyên khối. Đường hủy phiên
// (confirm_cancel_handover nhả handover_id = NULL) dính y hệt.
// Test này chốt: cửa HANDOVER tồn tại, hẹp đúng 1 cột, và không cửa cũ nào rơi.
const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260807140000_ie_guard_handover_scope.sql"),
  "utf8",
);

describe("Guard phiếu canonical — cửa HANDOVER (bàn giao tiền mặt)", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("giữ đủ cả bốn cửa flex-writer, không xoá cửa của đợt vá trước", () => {
    for (const scope of ["CASHBOOK_MOVE", "ANNOTATE", "LINK_CONTRACT", "HANDOVER"]) {
      expect(sql).toContain(`w.scope = '${scope}'`);
    }
  });

  it("cửa HANDOVER chỉ cho đổi handover_id + updated_at", () => {
    expect(sql).toContain("array['handover_id','updated_at']");
    expect(sql).toContain("handover scope may only change handover_id of %");
  });

  it("KHÔNG nới allowlist token lifecycle bằng handover_id", () => {
    const allowlist = sql.slice(sql.indexOf("ALLOWLIST, not denylist"));
    expect(allowlist.indexOf("'handover_id'")).toBe(-1);
  });

  it("giữ nguyên đường canonical: không token thì vẫn frozen", () => {
    expect(sql).toContain("app_private.ie_transition_authorization");
    expect(sql).toContain("canonical income expense % is frozen (update rejected)");
    expect(sql).toContain("canonical income expense % is frozen (delete rejected)");
  });

  it("có chốt chặn drift trước và sau khi replace", () => {
    expect(sql).toMatch(/DO \$preflight\$/);
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/RAISE EXCEPTION 'guard sau replace thiếu cửa/);
  });

  it("nới CHECK scope đủ 6 giá trị — không rơi scope cũ nào", () => {
    for (const scope of [
      "'ANNOTATE'",
      "'FLEX_EDIT'",
      "'LINK_CONTRACT'",
      "'SALE_BONUS_DEPOSIT'",
      "'CASHBOOK_MOVE'",
      "'HANDOVER'",
    ]) {
      expect(sql).toContain(scope);
    }
  });

  it("create_cash_handover mở cửa HANDOVER cho TỪNG phiếu quanh UPDATE rồi đóng lại", () => {
    expect(sql).toMatch(
      /begin_ie_flex_write_v1\(u\.id, 'HANDOVER'\)[\s\S]{0,200}UPDATE income_expenses SET handover_id = v_id WHERE id = ANY\(v_ids\);[\s\S]{0,200}end_ie_flex_write_v1\(u\.id\)/,
    );
  });

  it("confirm_cancel_handover mở cửa HANDOVER quanh câu nhả phiếu gốc", () => {
    expect(sql).toMatch(
      /begin_ie_flex_write_v1\(u\.id, 'HANDOVER'\)[\s\S]{0,250}UPDATE income_expenses SET handover_id = NULL WHERE handover_id = p_handover_id;[\s\S]{0,200}end_ie_flex_write_v1\(u\.id\)/,
    );
  });

  it("gate chống rơi cửa nâng sàn scope lên 5 (thêm HANDOVER)", () => {
    const gate = readFileSync(resolve(process.cwd(), "scripts/check-ie-guard-gates.mjs"), "utf8");
    expect(gate).toMatch(/TOI_THIEU_SCOPE = 5/);
  });
});
