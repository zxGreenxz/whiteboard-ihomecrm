import { describe, expect, it } from "vitest";

import type { ContractVehicle } from "@/components/contracts/detail/types";
import { anhCccd, moTaXe, mucMetaKhach } from "../tenantMetaLines";

const xe = (over: Partial<ContractVehicle>): ContractVehicle => ({
  id: "v1",
  customer_id: "c1",
  vehicle_type: null,
  vehicle_name: null,
  brand: null,
  model: null,
  license_plate: null,
  color: null,
  parking_fee: null,
  ...over,
});

describe("moTaXe — số xe · tên · màu", () => {
  it("ghép đủ ba phần theo đúng thứ tự chủ yêu cầu", () => {
    expect(
      moTaXe(xe({ license_plate: "86AA-042.67", vehicle_name: "Galaxy SYM", color: "Đen" })),
    ).toBe("86AA-042.67 · Galaxy SYM · Đen");
  });

  it("thiếu phần nào thì bỏ phần đó, không để dấu chấm cụt", () => {
    expect(moTaXe(xe({ license_plate: "86AA-042.67", color: "Đen" }))).toBe(
      "86AA-042.67 · Đen",
    );
    expect(moTaXe(xe({ license_plate: "86AA-042.67" }))).toBe("86AA-042.67");
  });

  it("không có tên xe thì lùi về hãng + dòng xe", () => {
    // Bảng vehicles có cả `vehicle_name` lẫn cặp brand/model; hồ sơ cũ chỉ điền
    // cặp sau, bỏ qua là dòng xe trống trơn dù dữ liệu vẫn có.
    expect(
      moTaXe(xe({ license_plate: "59Y2-43654", brand: "Honda", model: "Vision", color: "Trắng" })),
    ).toBe("59Y2-43654 · Honda Vision · Trắng");
  });

  it("chưa có biển số thì nói rõ chứ không bỏ trống vế đầu", () => {
    expect(moTaXe(xe({ vehicle_name: "Wave", color: "Đỏ" }))).toBe(
      "Chưa có biển số · Wave · Đỏ",
    );
  });

  it("xe rỗng hoàn toàn trả chuỗi rỗng để nơi gọi bỏ qua", () => {
    expect(moTaXe(xe({}))).toBe("");
  });
});

describe("anhCccd — đọc id_images", () => {
  it("lấy được mặt trước và mặt sau", () => {
    expect(anhCccd({ front: "a.jpg", back: "b.jpg" })).toEqual({
      truoc: "a.jpg",
      sau: "b.jpg",
    });
  });

  it("chỉ có một mặt vẫn tính là có ảnh", () => {
    expect(anhCccd({ front: "a.jpg" })).toEqual({ truoc: "a.jpg", sau: undefined });
  });

  it("hộ chiếu tính vào mặt trước khi không có CCCD", () => {
    expect(anhCccd({ passport: "p.jpg" })).toEqual({ truoc: "p.jpg", sau: undefined });
  });

  it("rỗng / sai kiểu / chuỗi rỗng đều là không có ảnh", () => {
    expect(anhCccd(null)).toBeNull();
    expect(anhCccd({})).toBeNull();
    expect(anhCccd({ front: "" })).toBeNull();
    expect(anhCccd("khong-phai-object")).toBeNull();
    expect(anhCccd({ front: 123 })).toBeNull();
  });
});

describe("mucMetaKhach — mục nào hiện, mục nào ẩn", () => {
  it("email rỗng thì ẨN HẲN, không hiện 'Chưa có'", () => {
    // Yêu cầu của chủ 13/09: ô email trống chỉ tổ chiếm chỗ.
    const muc = mucMetaKhach({ phone: "0383050431", id_number: "089308021003" }, []);
    expect(muc.map((m) => m.loai)).toEqual(["phone", "cccd"]);
  });

  it("có email thì hiện", () => {
    const muc = mucMetaKhach(
      { phone: "0383050431", id_number: "089", email: "a@b.com" },
      [],
    );
    expect(muc.map((m) => m.loai)).toEqual(["phone", "cccd", "email"]);
    expect(muc.find((m) => m.loai === "email")?.chu).toBe("a@b.com");
  });

  it("không có xe thì ẩn mục xe", () => {
    const muc = mucMetaKhach({ phone: "0383050431" }, []);
    expect(muc.some((m) => m.loai === "xe")).toBe(false);
  });

  it("nhiều xe thì mỗi xe một mục riêng", () => {
    const muc = mucMetaKhach({ phone: "1" }, [
      xe({ license_plate: "86AA-042.67", vehicle_name: "SYM", color: "Đen" }),
      xe({ id: "v2", license_plate: "59Y2-43654", color: "Trắng" }),
    ]);
    const dsXe = muc.filter((m) => m.loai === "xe");
    expect(dsXe).toHaveLength(2);
    expect(dsXe[0]?.chu).toBe("86AA-042.67 · SYM · Đen");
    expect(dsXe[1]?.chu).toBe("59Y2-43654 · Trắng");
  });

  it("xe không có thông tin gì thì không đẻ ra mục rỗng", () => {
    const muc = mucMetaKhach({ phone: "1" }, [xe({}), xe({ id: "v2", license_plate: "86AA" })]);
    expect(muc.filter((m) => m.loai === "xe").map((m) => m.chu)).toEqual(["86AA"]);
  });

  it("điện thoại và CCCD vẫn hiện dù rỗng — thiếu giấy tờ là chuyện phải thấy", () => {
    const muc = mucMetaKhach({}, []);
    expect(muc.map((m) => m.loai)).toEqual(["phone", "cccd"]);
    expect(muc.every((m) => m.thieu)).toBe(true);
    expect(muc.map((m) => m.chu)).toEqual(["Chưa có", "Chưa có"]);
  });
});
