import { describe, expect, it } from "vitest";

import { kiemChotChongAoGiac, xepNhomTheoSoDo, MA_THOAT_CHOT_HONG } from "../measure-org-leak.mjs";

// Bộ đo này chỉ có giá trị nếu nó KHÔNG BAO GIỜ nói dối theo hướng an toàn.
//
// Án lệ trong chính phiên rà soát 07/08/2026: một phép đo cho ra "0 dòng rò" và
// suýt được ghi vào kết luận, hoá ra hàm ghi log của bài đo bị đặt SECURITY
// DEFINER nên mọi truy vấn chạy bằng quyền postgres chứ không phải vai đang giả
// lập. Một bộ đo hỏng theo hướng "mọi thứ đều ổn" còn nguy hiểm hơn không đo,
// vì nó tạo ra bằng chứng giả để người ta dựa vào.
//
// Vì vậy: thiếu bất kỳ chốt nào → THOÁT MÃ 3, tuyệt đối không bao giờ thoát 0.
describe("kiemChotChongAoGiac — bốn chốt bắt buộc", () => {
  const dat = {
    current_user: "authenticated",
    rolbypassrls: false,
    auth_uid: "df8d1df5-1c24-4723-9733-4640c43c382b",
    uid_mong_doi: "df8d1df5-1c24-4723-9733-4640c43c382b",
    doi_chung_duong_tong: 90,
    doi_chung_duong_ngoai: 0,
    doi_chung_am: 0,
  };

  it("qua khi cả bốn chốt đều đạt", () => {
    expect(kiemChotChongAoGiac(dat).dat).toBe(true);
  });

  it("đỏ khi phiên KHÔNG chạy bằng vai authenticated", () => {
    const r = kiemChotChongAoGiac({ ...dat, current_user: "postgres" });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/authenticated/);
  });

  it("đỏ khi vai đang được bỏ qua RLS — đo lúc đó là đo hư không", () => {
    const r = kiemChotChongAoGiac({ ...dat, rolbypassrls: true });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/bypass/i);
  });

  it("đỏ khi auth.uid() không khớp người mình định giả lập", () => {
    const r = kiemChotChongAoGiac({ ...dat, auth_uid: "khac-hoan-toan" });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/auth\.uid/);
  });

  it("đỏ khi đối chứng DƯƠNG không thấy gì — nghĩa là phép đo mù, không phải sạch", () => {
    // income_expense_types đã có biên giới: người này PHẢI thấy vài chục dòng của
    // chính mình và 0 dòng ngoài. Thấy 0/0 nghĩa là bài đo không đọc được gì cả.
    const r = kiemChotChongAoGiac({ ...dat, doi_chung_duong_tong: 0 });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/đối chứng dương/i);
  });

  it("đỏ khi đối chứng dương lại thấy dòng ngoài — bảng mốc phải sạch", () => {
    const r = kiemChotChongAoGiac({ ...dat, doi_chung_duong_ngoai: 5 });
    expect(r.dat).toBe(false);
  });

  it("đỏ khi người mồ côi vẫn thấy dữ liệu — RLS không có hiệu lực", () => {
    const r = kiemChotChongAoGiac({ ...dat, doi_chung_am: 12 });
    expect(r.dat).toBe(false);
    expect(r.loi.join(" ")).toMatch(/mồ côi|đối chứng âm/i);
  });

  it("mã thoát khi chốt hỏng là 3, không phải 1 — phân biệt với 'đo xong, có rò'", () => {
    expect(MA_THOAT_CHOT_HONG).toBe(3);
  });
});

describe("xepNhomTheoSoDo — gán giai đoạn từ số đo, không từ phỏng đoán", () => {
  const nen = { table_name: "x", visible_foreign: 0, ground_truth_total: 0, authenticated_can_select: true };

  it("có dòng của tổ chức khác → GĐ4, vá cẩn thận vì đang có người nhìn nhầm", () => {
    const r = xepNhomTheoSoDo({ ...nen, visible_foreign: 33, ground_truth_total: 63 });
    expect(r.group).toBe("LIVE_LEAK");
    expect(r.assigned_phase).toBe("GĐ4");
  });

  it("bảng rỗng → GĐ3, vá không thể gây hồi quy vì không có gì để mất", () => {
    const r = xepNhomTheoSoDo({ ...nen, ground_truth_total: 0 });
    expect(r.group).toBe("A_RONG");
    expect(r.assigned_phase).toBe("GĐ3");
  });

  it("authenticated không đọc được → GĐ3, RLS đã chặn từ tầng quyền", () => {
    const r = xepNhomTheoSoDo({ ...nen, authenticated_can_select: false, ground_truth_total: 500 });
    expect(r.group).toBe("B_KHONG_CAP_QUYEN");
    expect(r.assigned_phase).toBe("GĐ3");
  });

  it("có dữ liệu, đọc được, nhưng KHÔNG rò → GĐ3", () => {
    // Đã được rào bằng đường khác (theo toà, theo người). Gắn thêm biên giới tổ
    // chức là siết chồng, không lấy mất của ai thứ gì.
    const r = xepNhomTheoSoDo({ ...nen, ground_truth_total: 124, visible_foreign: 0 });
    expect(r.group).toBe("C_DA_KIN");
    expect(r.assigned_phase).toBe("GĐ3");
  });

  it("rò THẮNG mọi nhóm khác — kể cả khi bảng nhỏ", () => {
    const r = xepNhomTheoSoDo({ ...nen, ground_truth_total: 2, visible_foreign: 1 });
    expect(r.assigned_phase).toBe("GĐ4");
  });

  it("chưa đo được thì nói chưa đo, KHÔNG mặc định là an toàn", () => {
    const r = xepNhomTheoSoDo({ ...nen, visible_foreign: null, ground_truth_total: null });
    expect(r.group).toBe("CHUA_DO");
    expect(r.assigned_phase).toBe(null);
  });
});
