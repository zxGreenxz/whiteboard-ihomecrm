import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// GĐ3 — rào 251 bảng mà SỐ ĐO chứng minh là không thể gây hồi quy.
//
// File .sql được SINH BẰNG MÁY từ docs/generated/org-boundary-inventory.json.
// Test này canh hai thứ khác nhau:
//   1. file sinh ra đúng hình dạng (transaction, công thức, preflight, verify);
//   2. và quan trọng hơn — file KHỚP với inventory. Nếu ai đó sửa tay file .sql
//      để thêm một bảng vào, hoặc inventory đổi mà file không sinh lại, test đỏ.
// Không có mệnh đề thứ hai thì "sinh bằng máy" chỉ là một lời hứa.
const duong = "supabase/migrations/20260808010000_gd3_rao_bang_an_toan.sql";
const sql = readFileSync(resolve(process.cwd(), duong), "utf8");
const inventory = JSON.parse(
  readFileSync(resolve(process.cwd(), "docs/generated/org-boundary-inventory.json"), "utf8"),
);

// So với SỔ TAY sinh cùng file, KHÔNG so với inventory sống.
//
// Bản đầu của test này so file .sql với inventory hiện tại. Nó xanh đúng vài giờ:
// apply xong, cả 251 bảng chuyển sang nhóm DA_CO_BOUNDARY, inventory không còn
// dòng GĐ3 nào, và test đỏ dù chẳng ai sửa gì. Một test chỉ đúng trong vài giờ là
// một test sẽ bị xoá — rồi mất luôn mệnh đề nó đang canh.
const soTay = JSON.parse(
  readFileSync(resolve(process.cwd(), `${duong}.tables.json`), "utf8"),
);
const bangTrongInventory: string[] = [...soTay.tables].sort();

const bangTrongSql = [
  ...sql.matchAll(/^CREATE POLICY (\w+)_org_boundary ON public\.(\w+)$/gm),
].map((m) => m[2]).sort();

describe("GĐ3 — hình dạng migration", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("mọi policy đều RESTRICTIVE FOR ALL — siết, không nới", () => {
    const soCreate = (sql.match(/^CREATE POLICY \w+_org_boundary/gm) ?? []).length;
    const soRestrictive = (sql.match(/^  AS RESTRICTIVE FOR ALL TO authenticated$/gm) ?? []).length;
    expect(soCreate).toBeGreaterThan(200);
    expect(soRestrictive).toBe(soCreate);
    expect(sql).not.toMatch(/AS PERMISSIVE/);
  });

  it("dùng NGUYÊN VĂN công thức Sprint 3b, cả USING lẫn WITH CHECK", () => {
    const congThuc =
      /organization_id IS NULL OR \(SELECT public\.is_super_admin\(\)\) OR organization_id IN \(SELECT unnest\(public\.my_org_ids\(\)\)\)/g;
    const soCreate = (sql.match(/^CREATE POLICY \w+_org_boundary/gm) ?? []).length;
    expect((sql.match(congThuc) ?? []).length).toBe(soCreate * 2);
  });

  it("idempotent — mỗi CREATE có một DROP IF EXISTS đi trước", () => {
    const soDrop = (sql.match(/^DROP POLICY IF EXISTS \w+_org_boundary/gm) ?? []).length;
    const soCreate = (sql.match(/^CREATE POLICY \w+_org_boundary/gm) ?? []).length;
    expect(soDrop).toBe(soCreate);
  });

  it("tên policy khớp quy ước relname||'_org_boundary'", () => {
    for (const m of sql.matchAll(/^CREATE POLICY (\w+)_org_boundary ON public\.(\w+)$/gm)) {
      expect(m[1]).toBe(m[2]);
    }
  });

  it("có preflight chặn inventory cũ và verify đếm lại sau khi chạy", () => {
    expect(sql).toMatch(/DO \$preflight\$/);
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/Inventory đã cũ so với production/);
  });

  it("preflight chặn bảng vừa bị rào vừa nằm trong sổ miễn trừ", () => {
    expect(sql).toMatch(/org_boundary_exemptions/);
    expect(sql).toMatch(/vừa nằm trong sổ miễn trừ vừa bị rào/);
  });

  it("verify chặn policy lỡ ra PERMISSIVE", () => {
    const verify = sql.slice(sql.indexOf("DO $verify$"));
    expect(verify).toMatch(/polpermissive/);
    expect(verify).toMatch(/nới quyền/);
  });
});

describe("GĐ3 — file phải KHỚP inventory, không được sửa tay", () => {
  it("số bảng trong file bằng đúng số bảng inventory gán cho GĐ3", () => {
    expect(bangTrongSql.length).toBe(bangTrongInventory.length);
    expect(bangTrongSql.length).toBeGreaterThan(200);
  });

  it("từng tên bảng khớp một-một với inventory", () => {
    expect(bangTrongSql).toEqual(bangTrongInventory);
  });

  it("KHÔNG rào bảng nào đang rò thật — chúng thuộc giai đoạn sau", () => {
    // So với SỔ TAY của GĐ4, không so với inventory sống.
    //
    // Bản đầu so với inventory sống và khẳng định `dangRo.length > 0` để test
    // không rỗng nghĩa. Mệnh đề đó ngầm giả định THẾ GIỚI VẪN CÒN HỎNG: khi GĐ4
    // vá xong và không còn bảng nào rò, chính cái chốt chống-rỗng ấy làm test đỏ
    // — đúng lúc mọi thứ thành công. Sổ tay GĐ4 đóng băng danh sách 14 bảng từng
    // rò, nên mệnh đề "hai file rời nhau" đúng vĩnh viễn.
    const soTayGd4 = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "supabase/migrations/20260808020000_gd4_rao_bang_dang_ro.sql.tables.json"),
        "utf8",
      ),
    );
    expect(soTayGd4.tables.length).toBeGreaterThan(0);
    for (const t of soTayGd4.tables) expect(bangTrongSql).not.toContain(t);
  });

  it("KHÔNG rào bảng nào đang được miễn trừ", () => {
    const mienTru = inventory.rows
      .filter((r: any) => r.group === "EXEMPT")
      .map((r: any) => r.table_name);
    expect(mienTru.length).toBeGreaterThan(0);
    for (const t of mienTru) expect(bangTrongSql).not.toContain(t);
  });

  it("không rào trùng một bảng hai lần", () => {
    expect(new Set(bangTrongSql).size).toBe(bangTrongSql.length);
  });

  it("có bao gồm hai bảng phân mảnh cha — chỗ generator lọc relkind='r' bỏ sót", () => {
    expect(bangTrongSql).toContain("network_device_samples");
    expect(bangTrongSql).toContain("network_interface_samples");
  });
});
