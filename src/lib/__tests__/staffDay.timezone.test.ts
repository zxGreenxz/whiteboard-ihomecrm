import { describe, expect, it } from "vitest";
import { addDays, addMonths, daysBetween, mondayIndex, monthLastDay, vnDateOf, vnTime } from "@/lib/staffDay";

describe("ngày giờ theo giờ Việt Nam", () => {
  it("đổi múi giờ đúng khi UTC còn là hôm trước", () => {
    expect(vnDateOf("2026-11-06T18:30:00Z")).toBe("2026-11-07");
    expect(vnTime("2026-11-06T18:30:00Z")).toBe("01:30");
  });
  it("cộng ngày và tháng qua ranh giới", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthLastDay("2026-02")).toBe("2026-02-28");
    expect(daysBetween("2026-07-01", "2026-11-07")).toBe(129);
  });
  it("lịch bắt đầu từ Thứ Hai", () => {
    expect(mondayIndex("2026-11-02")).toBe(0);
    expect(mondayIndex("2026-11-01")).toBe(6);
  });
});
