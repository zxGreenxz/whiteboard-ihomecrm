import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Án lệ 27/07/2026 (phòng 103/102LVT): tạo phiếu cọc giữ chỗ cho phòng "Sắp trống"
 * mà phòng VẪN hiện trên bảng phòng trống công khai. Hai tầng cùng hở:
 *   1. recompute_room_reservation RETURN sớm khi phòng còn HĐ hiệu lực → không có
 *      cờ rooms.status='RESERVED' nào để dựa vào;
 *   2. trong 2 RPC bảng phòng, nhánh 'soon' (suy từ contracts) đứng TRƯỚC nhánh
 *      đọc rooms.status → kể cả có RESERVED cũng bị nuốt.
 *
 * Vá bằng helper dùng chung room_has_holding_deposit() gọi thẳng trong RPC, đặt
 * SAU 'pass' và TRƯỚC 'soon'. 2 RPC này có án drift (sửa 1 quên 1) nên test khoá
 * cả hai bản.
 */
const migrationPath = resolve(
  process.cwd(),
  "supabase/migrations/20260727120000_public_rooms_hide_held_by_deposit.sql",
);
const sql = existsSync(migrationPath)
  ? readFileSync(migrationPath, "utf8").replace(/\r\n/g, "\n")
  : "";

function functionBlock(functionName: string): string {
  const marker = new RegExp(
    `CREATE OR REPLACE FUNCTION ${functionName.replace(/\./g, "\\.")}\\(`,
  );
  const match = marker.exec(sql);
  expect(match, `${functionName} must be defined`).not.toBeNull();

  const start = match?.index ?? 0;
  const next = sql.indexOf("\nCREATE OR REPLACE FUNCTION ", start + 1);
  return sql.slice(start, next >= 0 ? next : sql.length);
}

const ROOM_RPCS = [
  "public.get_public_available_rooms",
  "public.get_my_available_rooms",
] as const;

describe("migration 20260727120000 — cọc giữ chỗ khoá cả phòng Sắp trống", () => {
  it("migration tồn tại", () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(sql.length).toBeGreaterThan(0);
  });

  describe("helper room_has_holding_deposit", () => {
    const block = () => functionBlock("public.room_has_holding_deposit");

    it("phủ cả 2 nguồn cọc: deposits PENDING/CONFIRMED và phiếu thu có item cọc", () => {
      const body = block();
      expect(body).toMatch(/FROM public\.deposits d/);
      expect(body).toMatch(/d\.status IN \('PENDING','CONFIRMED'\)/);
      expect(body).toMatch(/FROM public\.income_expenses ie/);
      expect(body).toMatch(/ie\.type = 'INCOME'/);
      expect(body).toMatch(/public\.ie_has_deposit_item\(ie\.id\)/);
    });

    it("chỉ tính cọc CHƯA gắn HĐ, chưa xoá, và tính cả phiếu chưa duyệt", () => {
      const body = block();
      // chưa gắn HĐ + chưa xoá trên cả 2 nhánh
      expect(body.match(/contract_id IS NULL/g)?.length).toBe(2);
      expect(body.match(/deleted_at IS NULL/g)?.length).toBe(2);
      // chỉ loại CANCELLED — KHÔNG được siết thành approval_status = 'APPROVED'
      expect(body).toMatch(
        /COALESCE\(ie\.approval_status, ''\) <> 'CANCELLED'/,
      );
      expect(body).not.toMatch(/approval_status\s*=\s*'APPROVED'/);
    });

    it("là hàm nội bộ — revoke anon + authenticated", () => {
      expect(sql).toMatch(
        /REVOKE ALL ON FUNCTION public\.room_has_holding_deposit\(uuid\) FROM PUBLIC, anon, authenticated;/,
      );
    });
  });

  it("recompute_room_reservation dùng lại helper thay vì nhân bản predicate", () => {
    const body = functionBlock("public.recompute_room_reservation");
    expect(body).toMatch(
      /v_has_holding := public\.room_has_holding_deposit\(p_room_id\);/,
    );
    // vẫn nhường quyền sở hữu OCCUPIED cho HĐ hiệu lực
    expect(body).toMatch(/IF v_has_active THEN\n\s*RETURN;/);
    // vẫn chỉ lật 2 chiều AVAILABLE <-> RESERVED
    expect(body).toMatch(/v_status = 'AVAILABLE' AND v_has_holding/);
    expect(body).toMatch(/v_status = 'RESERVED' AND NOT v_has_holding/);
  });

  describe.each(ROOM_RPCS)("%s", (fn) => {
    it("khoá phòng đã có cọc giữ chỗ (status_public = 'rented')", () => {
      expect(functionBlock(fn)).toMatch(
        /WHEN public\.room_has_holding_deposit\(rm\.id\) THEN 'rented'/,
      );
    });

    it("nhánh cọc đứng SAU 'pass' và TRƯỚC 'soon' (nếu không, phòng Sắp trống lọt lưới)", () => {
      const body = functionBlock(fn);
      const pass = body.indexOf("WHEN pl.id IS NOT NULL THEN 'pass'");
      const deposit = body.indexOf("public.room_has_holding_deposit(rm.id)");
      const soon = body.indexOf("THEN 'soon'");

      expect(pass).toBeGreaterThan(-1);
      expect(deposit).toBeGreaterThan(pass);
      expect(soon).toBeGreaterThan(deposit);
    });

    it("giữ nguyên nhánh 'soon' theo cửa sổ soon_days và cờ pass_contact_manager", () => {
      const body = functionBlock(fn);
      expect(body).toMatch(
        /c\.expected_move_out_date BETWEEN CURRENT_DATE AND CURRENT_DATE \+ v_soon/,
      );
      expect(body).toMatch(
        /COALESCE\(pl\.contact_manager, false\) AS pass_contact_manager/,
      );
      expect(body).toMatch(
        /CASE WHEN pl\.contact_manager THEN NULL ELSE pl\.contact_phone END AS pass_contact_phone/,
      );
    });
  });

  it("giữ grants cho 2 RPC bảng phòng", () => {
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_public_available_rooms\(text\) TO anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_my_available_rooms\(\) TO authenticated;/,
    );
  });
});
