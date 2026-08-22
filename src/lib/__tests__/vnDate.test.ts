import { describe, expect, it } from "vitest";
import {
  addDaysISO,
  diffDaysISO,
  formatISODateVN,
  formatISODayMonth,
  vnTodayISO,
} from "../vnDate";

describe("diffDaysISO", () => {
  it("đếm đúng số ngày giữa hai mốc", () => {
    expect(diffDaysISO("2026-08-25", "2026-08-21")).toBe(4);
    expect(diffDaysISO("2026-08-21", "2026-08-21")).toBe(0);
    expect(diffDaysISO("2026-08-18", "2026-08-21")).toBe(-3);
  });

  it("qua ranh giới tháng và năm", () => {
    expect(diffDaysISO("2026-09-01", "2026-08-31")).toBe(1);
    expect(diffDaysISO("2027-01-01", "2026-12-31")).toBe(1);
    // 2028 nhuận: 29/02 tồn tại.
    expect(diffDaysISO("2028-03-01", "2028-02-28")).toBe(2);
  });

  it("bỏ qua phần giờ thừa ở đuôi chuỗi", () => {
    expect(diffDaysISO("2026-08-25T17:30:00Z", "2026-08-21")).toBe(4);
  });

  it("trả null khi mốc thiếu hoặc không hợp lệ", () => {
    expect(diffDaysISO(null, "2026-08-21")).toBeNull();
    expect(diffDaysISO("2026-08-21", undefined)).toBeNull();
    expect(diffDaysISO("hôm nay", "2026-08-21")).toBeNull();
    // Ngày không tồn tại KHÔNG được im lặng cuộn sang tháng sau.
    expect(diffDaysISO("2026-02-31", "2026-02-01")).toBeNull();
    expect(diffDaysISO("2026-13-01", "2026-02-01")).toBeNull();
  });
});

describe("addDaysISO", () => {
  it("cộng ngày và cuộn tháng đúng", () => {
    expect(addDaysISO("2026-08-21", 7)).toBe("2026-08-28");
    expect(addDaysISO("2026-08-28", 7)).toBe("2026-09-04");
    expect(addDaysISO("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDaysISO("2028-03-01", -1)).toBe("2028-02-29");
  });

  it("cộng rồi trừ về đúng chỗ cũ", () => {
    const base = "2026-08-21";
    expect(addDaysISO(addDaysISO(base, 30), -30)).toBe(base);
  });

  it("trả null với đầu vào hỏng", () => {
    expect(addDaysISO(null, 3)).toBeNull();
    expect(addDaysISO("2026-08-21", Number.NaN)).toBeNull();
  });
});

describe("vnTodayISO", () => {
  // Đây là phép kiểm ĐÁNG GIÁ NHẤT của file: chốt 01:00 giờ VN ngày 21/08 —
  // thời điểm mà giờ UTC vẫn còn là 20/08. Máy chạy UTC (CI) đọc giờ máy sẽ ra
  // "2026-08-20" và làm một phiếu đúng hạn bị coi là quá hạn.
  it("lấy ngày theo giờ VN chứ không theo giờ máy", () => {
    const earlyMorningVN = new Date("2026-08-20T18:00:00Z"); // 01:00 ngày 21/08 giờ VN
    expect(vnTodayISO(earlyMorningVN)).toBe("2026-08-21");
  });

  it("cuối ngày VN vẫn là ngày đó", () => {
    const lateVN = new Date("2026-08-21T16:59:00Z"); // 23:59 ngày 21/08 giờ VN
    expect(vnTodayISO(lateVN)).toBe("2026-08-21");
  });

  it("trả đúng định dạng YYYY-MM-DD", () => {
    expect(vnTodayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("định dạng hiển thị", () => {
  it("formatISODateVN / formatISODayMonth", () => {
    expect(formatISODateVN("2026-08-21")).toBe("21/08/2026");
    expect(formatISODayMonth("2026-08-21")).toBe("21/08");
    expect(formatISODateVN(null)).toBe("—");
    expect(formatISODayMonth(undefined)).toBe("—");
  });
});
