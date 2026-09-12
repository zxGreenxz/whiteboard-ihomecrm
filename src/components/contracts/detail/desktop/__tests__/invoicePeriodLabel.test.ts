import { describe, expect, it } from "vitest";

import { nhanKyHoaDon } from "../invoicePeriodLabel";

const hd = (
  billing_month: string | null,
  ngay: Array<[string | null, string | null]> = [],
) => ({
  billing_month,
  invoice_items: ngay.map(([from_date, to_date]) => ({ from_date, to_date })),
});

describe("nhanKyHoaDon", () => {
  it("gộp khoảng ngày của các dòng, cùng năm thì vế đầu bỏ năm", () => {
    // Ca phổ biến nhất trên prod: dòng tiền phòng mang 01/09–30/09, dòng dịch
    // vụ không mang ngày.
    expect(
      nhanKyHoaDon(hd("2026-09", [["2026-09-01", "2026-09-30"], [null, null]])),
    ).toBe("01/09 – 30/09/2026");
  });

  it("lấy min(from) và max(to) khi nhiều dòng mang ngày", () => {
    expect(
      nhanKyHoaDon(
        hd("2026-09", [
          ["2026-09-09", "2026-09-30"],
          ["2026-09-06", "2026-09-20"],
        ]),
      ),
    ).toBe("06/09 – 30/09/2026");
  });

  it("khác năm thì hiện đủ năm ở cả hai vế", () => {
    expect(
      nhanKyHoaDon(hd("2025-12", [["2025-12-06", "2026-01-05"]])),
    ).toBe("06/12/2025 – 05/01/2026");
  });

  it("không dòng nào mang ngày thì rơi về kỳ tháng", () => {
    // 423/1470 hoá đơn trên prod ở trạng thái này — phải có chữ, không được trống.
    expect(nhanKyHoaDon(hd("2026-09", [[null, null]]))).toBe("09/2026");
    expect(nhanKyHoaDon(hd("2026-09"))).toBe("09/2026");
  });

  it("thiếu to_date thì vẫn coi như không có khoảng ngày", () => {
    expect(nhanKyHoaDon(hd("2026-09", [["2026-09-01", null]]))).toBe("09/2026");
  });

  it("billing_month dị dạng thì trả nguyên chuỗi, không bịa", () => {
    expect(nhanKyHoaDon(hd("thang 9"))).toBe("thang 9");
  });

  it("không có gì để nói thì trả gạch ngang", () => {
    expect(nhanKyHoaDon(hd(null))).toBe("—");
    expect(nhanKyHoaDon({})).toBe("—");
  });

  it("ngày rác không làm vỡ, rơi về kỳ tháng", () => {
    expect(nhanKyHoaDon(hd("2026-09", [["khong-phai-ngay", "cung-vay"]]))).toBe(
      "09/2026",
    );
  });
});
