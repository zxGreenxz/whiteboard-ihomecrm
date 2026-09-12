import { describe, expect, it } from "vitest";

import {
  chipTrangThai,
  nhanThoiHan,
  tienDoHopDong,
} from "../contractHeaderStats";

describe("chipTrangThai", () => {
  it("đặt nhãn tiếng Việt cho 5 trạng thái đã biết", () => {
    expect(chipTrangThai("DRAFT").nhan).toBe("Nháp");
    expect(chipTrangThai("ACTIVE").nhan).toBe("Đang hoạt động");
    expect(chipTrangThai("TRANSFERRED").nhan).toBe("Đã chuyển nhượng");
    expect(chipTrangThai("TERMINATED").nhan).toBe("Đã thanh lý");
    expect(chipTrangThai("EXPIRED").nhan).toBe("Hết hạn");
  });

  it("trạng thái lạ thì hiện nguyên chuỗi, không nuốt thành rỗng", () => {
    // Thà hiện mã lạ để người ta hỏi, còn hơn hiện ô trống rồi ai cũng tưởng
    // HĐ không có trạng thái.
    expect(chipTrangThai("SOMETHING_NEW").nhan).toBe("SOMETHING_NEW");
  });

  it("chỉ ACTIVE mới là chấm xanh", () => {
    expect(chipTrangThai("ACTIVE").xanh).toBe(true);
    expect(chipTrangThai("TERMINATED").xanh).toBe(false);
  });
});

describe("tienDoHopDong", () => {
  it("tính phần trăm đã thuê", () => {
    expect(tienDoHopDong(358, 6)).toBe(2);
    expect(tienDoHopDong(100, 50)).toBe(50);
  });

  it("tổng thời hạn 0 thì trả 0, không chia cho 0", () => {
    expect(tienDoHopDong(0, 5)).toBe(0);
    expect(tienDoHopDong(-10, 5)).toBe(0);
  });

  it("kẹp trong khoảng 0–100", () => {
    expect(tienDoHopDong(100, -3)).toBe(0);
    expect(tienDoHopDong(100, 999)).toBe(100);
  });
});

describe("nhanThoiHan", () => {
  it("còn hạn thì đếm ngày còn lại", () => {
    expect(nhanThoiHan(351)).toEqual({ tienTo: "còn", so: 351, donVi: "ngày" });
  });

  it("quá hạn thì đổi chữ và dùng trị tuyệt đối", () => {
    expect(nhanThoiHan(-4)).toEqual({ tienTo: "quá hạn", so: 4, donVi: "ngày" });
  });

  it("đúng ngày cuối vẫn là còn 0 ngày, không phải quá hạn", () => {
    expect(nhanThoiHan(0)).toEqual({ tienTo: "còn", so: 0, donVi: "ngày" });
  });
});
