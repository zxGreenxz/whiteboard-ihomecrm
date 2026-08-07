import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// Người nhận bấm "Xác nhận đã nhận" chết 23505 duplicate key
// "income_expense_v2_backfill_exceptions_key" (án lệ 07/08/2026, BG2608001).
// Chuỗi nhân quả 3 tầng, file migration phải chốt đủ cả ba:
//   1. Clone org Test (20260801060000) trồng vào org cccc một tòa ảo copy
//      NGUYÊN created_at của tòa thật — _chung_building nhánh "tenant thật"
//      (20260704210000) chọn tòa ảo non-demo ĐẦU TIÊN toàn hệ thống KHÔNG lọc
//      org, không tiebreaker ⇒ phiếu chuyển của confirm_cash_handover sinh
//      NHẦM tenant (org Test).
//   2. Bridge a85/a85b không resolve được poster ở org nhầm (giver/receiver
//      không có membership) ⇒ ghi exception BRIDGE_UNRESOLVED_POSTER.
//   3. Exception INSERT ở CẢ HAI bridge thiếu ON CONFLICT DO NOTHING (bảng
//      thiết kế "recorded once") ⇒ bắn lần 2 (a85b lúc INSERT, a85 lúc
//      auto_recalc UPDATE total_amount) là duplicate ⇒ rollback cả confirm.
const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260807160000_chung_building_org_scope.sql"),
  "utf8",
);

describe("_chung_building lọc org + bridge exception idempotent", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("_chung_building: pick tòa chung hệ thống PHẢI lọc theo org user có membership ACTIVE", () => {
    expect(sql).toContain("m.organization_id = b.organization_id");
    expect(sql).toMatch(/organization_memberships m[\s\S]{0,120}m\.user_id = p_user_id[\s\S]{0,60}m\.status = 'ACTIVE'/);
  });

  it("_chung_building: ORDER BY có tiebreaker id — hết nondeterministic khi clone copy created_at", () => {
    expect(sql).toMatch(/ORDER BY b\.created_at, b\.id LIMIT 1/);
  });

  it("_chung_building: giữ nhánh demo/fallback per-user và nhánh tự tạo", () => {
    expect(sql).toContain("demo_user_ids");
    expect(sql).toMatch(/name = 'Chung'/);
    expect(sql).toMatch(/INSERT INTO buildings/);
  });

  it("CẢ HAI bridge: exception BRIDGE_UNRESOLVED_POSTER có ON CONFLICT DO NOTHING", () => {
    const hits = sql.match(
      /'BRIDGE_UNRESOLVED_POSTER',[\s\S]{0,160}?ON CONFLICT DO NOTHING/g,
    );
    expect(hits).toHaveLength(2);
  });

  it("hai bridge giữ nguyên idempotency posting (không nuốt logic khi replace nguyên văn)", () => {
    const gen = sql.match(/'bridge:gen:' \|\| NEW\.id::text/g) ?? [];
    expect(gen.length).toBeGreaterThanOrEqual(2);
    const idem = sql.match(/ON CONFLICT \(organization_id, idempotency_key\) DO NOTHING/g) ?? [];
    expect(idem.length).toBeGreaterThanOrEqual(3);
  });

  it("có preflight md5 cho cả 3 hàm và verify sau replace", () => {
    for (const md5 of [
      "fb1c730a0cab8d3d1670a8c9ac81c16f",
      "24531a236d381e8a8c44a56778359670",
      "a325ae423805d1186f6a5bb839aa2403",
    ]) {
      expect(sql).toContain(md5);
    }
    expect(sql).toMatch(/DO \$preflight\$/);
    expect(sql).toMatch(/DO \$verify\$/);
  });
});
