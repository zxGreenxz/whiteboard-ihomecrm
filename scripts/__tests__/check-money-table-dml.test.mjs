// Test cho gate check-money-table-dml.
//
// Gate này ra đời từ một lỗi sống 35 ngày (nút "Dừng lặp lại" trả 403). Nên thứ
// phải kiểm không chỉ là "có bắt được vi phạm không", mà cả hai hướng hỏng đã
// thấy ở các gate khác trong repo: đọc nhầm CHÚ THÍCH thành mã (báo thừa), và
// in SAI SỐ DÒNG khiến người đi sửa mò không ra chỗ.

import { describe, expect, it } from "vitest";

import {
  BANG_TIEN,
  boChuThichGiuDong,
  quet,
  timGhiThang,
} from "../check-money-table-dml.mjs";

describe("timGhiThang", () => {
  it("bắt .from(bảng tiền).update() — đúng hình dạng đã làm hỏng nút Dừng lặp lại", () => {
    const ra = timGhiThang(`
      const { error } = await supabase
        .from("income_expenses")
        .update({ repeat_cycle: "NONE" })
        .eq("id", id);
    `);
    expect(ra).toHaveLength(1);
    expect(ra[0]).toMatchObject({ bang: "income_expenses", phepGhi: "update" });
  });

  it("bắt cả insert/delete/upsert, không chỉ update", () => {
    for (const phep of ["insert", "delete", "upsert"]) {
      const ra = timGhiThang(`supabase.from("accounts").${phep}({ a: 1 });`);
      expect(ra.map((v) => v.phepGhi)).toEqual([phep]);
    }
  });

  it("KHÔNG tính .select() — đọc vẫn được phép, chỉ ghi mới bị REVOKE", () => {
    expect(timGhiThang(`supabase.from("income_expenses").select("id").eq("id", x);`)).toEqual([]);
  });

  it("KHÔNG tính bảng ngoài danh sách bảng tiền", () => {
    expect(timGhiThang(`supabase.from("buildings").update({ name: "x" });`)).toEqual([]);
  });

  it("KHÔNG tính .update() ở CÂU KHÁC — phép đo cắt ở dấu chấm phẩy", () => {
    expect(
      timGhiThang(`
        const a = supabase.from("income_expenses").select("id");
        const b = supabase.from("buildings").update({ x: 1 });
      `),
    ).toEqual([]);
  });

  it("KHÔNG đọc chú thích thành mã — hướng báo thừa đã dính ở 4 gate khác", () => {
    expect(
      timGhiThang(`
        // đừng bao giờ .from("income_expenses").update(...) ở client
        /* .from("accounts").insert({}) cũng vậy */
        await rpc("ie_stop_recurring_v1", { p_id: id });
      `),
    ).toEqual([]);
  });

  it("số dòng in ra là dòng THẬT trong file gốc, không phải dòng sau khi cắt chú thích", () => {
    const van = ["// c1", "// c2", "// c3", "", 'supabase.from("accounts").update({ a: 1 });'].join("\n");
    expect(timGhiThang(van)[0].dong).toBe(5);
  });
});

describe("boChuThichGiuDong", () => {
  it("giữ nguyên số dòng sau khi bỏ chú thích", () => {
    const van = ["// a", "const x = 1;", "/* khối", "nhiều dòng */", "const y = 2;"].join("\n");
    expect(boChuThichGiuDong(van).split("\n")).toHaveLength(van.split("\n").length);
  });
});

describe("quét thật trên repo", () => {
  const ketQua = quet();

  it("phép quét chạy được (không rơi vào nhánh KHÔNG ĐO ĐƯỢC)", () => {
    expect(ketQua.loi).toBeUndefined();
    expect(ketQua.files.length).toBeGreaterThan(400);
  });

  it("useStopRecurring KHÔNG còn ghi thẳng — nó là lỗi gate này sinh ra để canh", () => {
    const dinh = ketQua.viPham.filter((v) => v.file === "src/hooks/income-expenses/recurring.ts");
    expect(dinh).toEqual([]);
  });

  it("danh sách bảng tiền khớp hai migration REVOKE làm nguồn sự thật", () => {
    expect(new Set(BANG_TIEN)).toEqual(
      new Set([
        "income_expenses",
        "income_expense_items",
        "accounts",
        "cash_handovers",
        "cash_handover_items",
        "cashbook_reconciliations",
      ]),
    );
  });
});
