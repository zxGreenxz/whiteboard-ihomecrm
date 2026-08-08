import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// GĐ5 — biên giới SINH TỪ CATALOG, gắn ngay lúc CREATE TABLE.
//
// Bốn giai đoạn trước vá được 297/304 bảng ĐANG có. Chúng không làm gì cho bảng
// NGÀY MAI — mà đó chính là cách khuyết tật này sinh ra: Sprint 3b liệt kê 28
// bảng năm ngoái, mọi bảng ra đời sau đều thiếu, âm thầm, cho tới khi đo mới lòi.
// Vá xong 304 bảng rồi dừng nghĩa là hẹn gặp lại đúng vấn đề này sau một năm.
//
// Event trigger giải quyết ở đúng chỗ: policy được gắn TRONG CÙNG transaction với
// CREATE TABLE, nên không tồn tại khoảnh khắc nào bảng sống trên production mà
// thiếu biên giới. Mạnh hơn "gate chặn ở CI" vì nó không thể bị quên.
//
// ⚠ CÁI BẪY: `ALTER TABLE … ENABLE ROW LEVEL SECURITY` do chính hàm phát ra LẠI
// là một ddl_command_end, nên nó gọi lại chính mình → đệ quy vô hạn, lỗi 54001
// stack depth. Phải có chốt chống tái nhập, và test phải canh chốt đó.
const sql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260808030000_gd5_event_trigger_org_boundary.sql"),
  "utf8",
);

describe("GĐ5 — hàm gắn biên giới", () => {
  it("chạy trong đúng một transaction", () => {
    expect(sql.match(/^\s*BEGIN\s*;\s*$/gm)).toHaveLength(1);
    expect(sql.match(/^\s*COMMIT\s*;\s*$/gm)).toHaveLength(1);
  });

  it("chỉ nhận cột tên ĐÚNG organization_id, không dò theo hậu tố", () => {
    // Dò theo '%organization_id' sẽ bắt cả source_organization_id /
    // target_organization_id, rồi sinh policy tham chiếu một cột không tồn tại
    // → lỗi 42703 ngay lúc CREATE TABLE của người khác.
    expect(sql).toMatch(/attname = 'organization_id'/);
    expect(sql).not.toMatch(/attname LIKE '%organization_id'/);
  });

  it("bỏ qua bảng nằm trong sổ miễn trừ", () => {
    expect(sql).toMatch(/org_boundary_exemptions/);
  });

  it("không gắn đè khi policy đã tồn tại", () => {
    expect(sql).toMatch(/polname = p_relname \|\| '_org_boundary'/);
  });

  it("dùng nguyên văn công thức Sprint 3b ở cả USING lẫn WITH CHECK", () => {
    const ct =
      /organization_id IS NULL OR \(SELECT public\.is_super_admin\(\)\) OR organization_id IN \(SELECT unnest\(public\.my_org_ids\(\)\)\)/g;
    expect((sql.match(ct) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("policy sinh ra là RESTRICTIVE FOR ALL", () => {
    expect(sql).toMatch(/AS RESTRICTIVE FOR ALL TO authenticated/);
  });
});

describe("GĐ5 — chốt chống đệ quy", () => {
  it("có chốt tái nhập bằng biến phiên", () => {
    expect(sql).toMatch(/current_setting\('app\.org_boundary_guard', true\)/);
    expect(sql).toMatch(/set_config\('app\.org_boundary_guard'/);
  });

  it("thoát sớm khi chốt đang bật", () => {
    expect(sql).toMatch(/=\s*'on' THEN\s*\n?\s*RETURN/);
  });

  it("nhả chốt cả trên đường lỗi, không chỉ đường thành công", () => {
    // Không nhả trên đường lỗi thì mọi DDL sau đó trong cùng transaction bị bỏ
    // qua âm thầm — bảng mới ra đời không có biên giới và không ai biết.
    const khoiTrigger = sql.slice(sql.indexOf("RETURNS event_trigger"));
    expect(khoiTrigger).toMatch(/EXCEPTION WHEN OTHERS/);
    expect(khoiTrigger).toMatch(/RAISE;/);
  });

  it("ghi rõ vì sao cần chốt — kẻo người sau tưởng là dòng thừa", () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY[\s\S]{0,300}(đệ quy|ddl_command_end)/i);
  });
});

describe("GĐ5 — tự kiểm chứng ngay trong migration", () => {
  it("verify TẠO một bảng thử rồi khẳng định policy tự xuất hiện", () => {
    // Một event trigger được cài mà không ai thử bắn nó là một event trigger
    // không ai biết có chạy hay không.
    expect(sql).toMatch(/DO \$verify\$/);
    expect(sql).toMatch(/CREATE TABLE public\.zz_thu_bien_gioi/);
    expect(sql).toMatch(/DROP TABLE .*zz_thu_bien_gioi/);
  });

  it("verify kiểm CẢ ca ngược: bảng KHÔNG có cột org thì không bị đụng", () => {
    expect(sql).toMatch(/zz_thu_khong_org/);
  });

  it("verify khẳng định policy thử ra RESTRICTIVE, không phải PERMISSIVE", () => {
    const verify = sql.slice(sql.indexOf("DO $verify$"));
    expect(verify).toMatch(/polpermissive/);
  });

  it("dọn sạch bảng thử — không để rác trên production", () => {
    expect(sql).toMatch(/DROP TABLE IF EXISTS public\.zz_thu_bien_gioi/);
    expect(sql).toMatch(/DROP TABLE IF EXISTS public\.zz_thu_khong_org/);
  });

  it("ghi rõ đường rollback", () => {
    expect(sql).toMatch(/ROLLBACK:/);
    expect(sql).toMatch(/DROP EVENT TRIGGER/);
  });
});
