import { describe, expect, it } from "vitest";

import { thongTinGiayTo } from "../idCardInfo";

describe("thongTinGiayTo — khối thông tin in trên ảnh giấy tờ", () => {
  it("dựng đủ các mục chủ yêu cầu: tên, ngày sinh, CCCD, ngày cấp, địa chỉ", () => {
    const muc = thongTinGiayTo({
      full_name: "Trương Việt Hà",
      id_number: "038098030832",
      date_of_birth: "1998-08-06",
      gender: "Nam",
      id_issue_date: "2024-07-04",
      id_issue_place: "Cục Cảnh Sát",
      permanent_address: "Thôn Ngọc Khạt, Cẩm Thành, Cẩm Thủy, Thanh Hóa",
    });
    expect(muc).toEqual([
      { nhan: "Họ và tên", gia: "Trương Việt Hà" },
      { nhan: "Ngày sinh", gia: "06/08/1998" },
      { nhan: "Giới tính", gia: "Nam" },
      { nhan: "Số CCCD", gia: "038098030832" },
      { nhan: "Ngày cấp", gia: "04/07/2024" },
      { nhan: "Nơi cấp", gia: "Cục Cảnh Sát" },
      { nhan: "Nơi thường trú", gia: "Thôn Ngọc Khạt, Cẩm Thành, Cẩm Thủy, Thanh Hóa" },
    ]);
  });

  it("thiếu địa chỉ thường trú thì lùi về địa chỉ chi tiết", () => {
    // Đo trên prod: chỉ 1/3 khách có `permanent_address`, còn `detailed_address`
    // thì hầu như ai cũng có.
    const muc = thongTinGiayTo({
      full_name: "Đỗ Thị Quế Trân",
      detailed_address: "286/AB2 An Bình 2, An Hoà Tây, Ba Trì, Bến Tre",
    });
    expect(muc.find((m) => m.nhan === "Nơi thường trú")?.gia).toBe(
      "286/AB2 An Bình 2, An Hoà Tây, Ba Trì, Bến Tre",
    );
  });

  it("KHÔNG ghép địa chỉ từ mã hành chính", () => {
    // `ward`/`district`/`province` lưu MÃ SỐ ('15133', '390', '38'), không phải
    // tên. In thẳng ra là hiện một dãy số vô nghĩa cạnh ảnh CCCD.
    const muc = thongTinGiayTo({
      full_name: "A",
      ward: "15133",
      district: "390",
      province: "38",
    });
    expect(muc.some((m) => m.gia.includes("15133"))).toBe(false);
    expect(muc.some((m) => m.nhan === "Nơi thường trú")).toBe(false);
  });

  it("mục nào không có dữ liệu thì bỏ hẳn, không in ô trống", () => {
    const muc = thongTinGiayTo({ full_name: "B", id_number: "123" });
    expect(muc.map((m) => m.nhan)).toEqual(["Họ và tên", "Số CCCD"]);
  });

  it("ngày sai định dạng thì giữ nguyên văn chứ không nuốt mất", () => {
    const muc = thongTinGiayTo({ full_name: "C", date_of_birth: "khong-ro" });
    expect(muc.find((m) => m.nhan === "Ngày sinh")?.gia).toBe("khong-ro");
  });

  it("không có tên thì vẫn dựng được các mục còn lại", () => {
    const muc = thongTinGiayTo({ id_number: "999" });
    expect(muc.map((m) => m.nhan)).toEqual(["Số CCCD"]);
  });
});
