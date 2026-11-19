// Ngày nghỉ phép nhiều ngày phía màn hình — phải khớp luật máy chủ request_paid_leave_range (20261119020927):
// Chủ nhật không tính, một đơn tối đa 31 ngày lịch. Lịch 11/2026: Chủ nhật 22/11, 29/11; 01/01/2027 thứ Sáu.
import { describe, expect, it } from "vitest";
import {
  calendarDaysBetween, groupPendingLeaves, leaveDateSpan, leaveDaysLabel, leaveMonths, leaveRequestSchema, leaveWorkDays,
  MAX_LEAVE_RANGE_DAYS, type PendingLeaveDay,
} from "@/lib/leaveDates";

describe("leaveMonths", () => {
  it("mọi tháng khoảng chạm tới, kể cả tháng giữa của đơn 31 ngày; khoảng sai / quá dài ⇒ không đọc lịch", () => {
    expect(leaveMonths("2026-11-20", "2026-11-23")).toEqual(["2026-11-01"]);
    expect(leaveMonths("2026-12-31", "2027-01-02")).toEqual(["2026-12-01", "2027-01-01"]);
    expect(leaveMonths("2027-01-30", "2027-03-01")).toEqual(["2027-01-01", "2027-02-01", "2027-03-01"]);
    expect(leaveMonths("2026-11-23", "2026-11-20")).toEqual([]);
    expect(leaveMonths("2026-11-20", "2026-12-21")).toEqual([]);
    expect(leaveMonths("", "")).toEqual([]);
  });
});

describe("leaveWorkDays / calendarDaysBetween", () => {
  it("bỏ Chủ nhật, giữ thứ tự, đi qua tháng và năm", () => {
    expect(leaveWorkDays("2026-11-20", "2026-11-23")).toEqual(["2026-11-20", "2026-11-21", "2026-11-23"]);
    expect(leaveWorkDays("2026-11-28", "2026-12-01")).toEqual(["2026-11-28", "2026-11-30", "2026-12-01"]);
    expect(leaveWorkDays("2026-12-31", "2027-01-02")).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
    expect(leaveWorkDays("2026-11-19", "2026-11-19")).toEqual(["2026-11-19"]);
  });
  it("chỉ Chủ nhật, ngày kết thúc trước ngày bắt đầu, chuỗi sai dạng hoặc khoảng quá dài ⇒ không có ngày", () => {
    expect(leaveWorkDays("2026-11-22", "2026-11-22")).toEqual([]);
    expect(leaveWorkDays("2026-11-23", "2026-11-20")).toEqual([]);
    expect(leaveWorkDays("", "2026-11-20")).toEqual([]);
    expect(leaveWorkDays("2026-11-20", "3026-11-20")).toEqual([]);
  });
  it("đếm ngày lịch cả hai đầu", () => {
    expect(calendarDaysBetween("2026-11-20", "2026-12-20")).toBe(31);
    expect(calendarDaysBetween("2026-11-20", "2026-11-20")).toBe(1);
    expect(calendarDaysBetween("2026-11-21", "2026-11-20")).toBe(0);
    expect(calendarDaysBetween("x", "2026-11-20")).toBe(0);
  });
});

describe("leaveDateSpan / leaveDaysLabel", () => {
  it("một ngày đủ năm; liền nhau (chỉ cách Chủ nhật) thành khoảng; rời nhau thì liệt kê", () => {
    expect(leaveDaysLabel(["2026-11-18"])).toBe("ngày 18/11/2026");
    expect(leaveDaysLabel(["2026-11-23", "2026-11-20", "2026-11-21"])).toBe("3 ngày: 20/11 → 23/11");
    expect(leaveDaysLabel(["2026-11-20", "2026-11-24"])).toBe("2 ngày: 20/11, 24/11");
    expect(leaveDateSpan(["2026-11-20", "2026-11-20"])).toBe("20/11/2026");
    expect(leaveDateSpan([])).toBe("");
  });
});

describe("groupPendingLeaves", () => {
  const day = (user_id: string, work_date: string, batch: string | null, staff_name = user_id): PendingLeaveDay =>
    ({ user_id, work_date, batch, staff_name, reason: batch ? `lý do ${batch}` : null, requested_at: null });

  it("gom theo người + mã đơn; ngày không mã đơn đứng riêng; sắp theo ngày đầu", () => {
    const groups = groupPendingLeaves([
      day("joey", "2026-11-23", "b1"), day("nathan", "2026-11-19", null), day("joey", "2026-11-20", "b1"),
      day("joey", "2026-11-25", "b2"), day("joey", "2026-11-21", "b1"), day("joey", "2026-11-18", null),
    ]);
    expect(groups.map((g) => [g.user_id, g.dates, g.reason])).toEqual([
      ["joey", ["2026-11-18"], null],
      ["nathan", ["2026-11-19"], null],
      ["joey", ["2026-11-20", "2026-11-21", "2026-11-23"], "lý do b1"],
      ["joey", ["2026-11-25"], "lý do b2"],
    ]);
  });
  it("cùng mã đơn nhưng khác người không gộp; ngày lặp không nhân đôi", () => {
    const groups = groupPendingLeaves([day("a", "2026-11-20", "b"), day("b", "2026-11-20", "b"), day("a", "2026-11-20", "b")]);
    expect(groups.map((g) => [g.user_id, g.dates])).toEqual([["a", ["2026-11-20"]], ["b", ["2026-11-20"]]]);
  });
});

describe("leaveRequestSchema", () => {
  const schema = leaveRequestSchema("2026-11-19");
  const loi = (value: { from: string; to: string; reason?: string }) => {
    const result = schema.safeParse({ reason: "", ...value });
    return result.success ? null : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  };

  it("hợp lệ: một ngày (để trống Đến ngày), khoảng nhiều ngày, đúng 31 ngày lịch", () => {
    expect(loi({ from: "2026-11-19", to: "" })).toBeNull();
    expect(loi({ from: "2026-11-20", to: "2026-11-23" })).toBeNull();
    expect(loi({ from: "2026-11-20", to: "2026-12-20" })).toBeNull();
  });
  it("từ chối đúng trường với câu dễ hiểu", () => {
    expect(loi({ from: "", to: "" })).toEqual(["from: Chọn ngày bắt đầu nghỉ."]);
    expect(loi({ from: "2026-11-18", to: "2026-11-20" })).toEqual(["from: Chọn hôm nay hoặc ngày sau đó."]);
    expect(loi({ from: "2026-11-23", to: "2026-11-20" })).toEqual(["to: Ngày kết thúc phải bằng hoặc sau ngày bắt đầu."]);
    expect(loi({ from: "2026-11-20", to: "2026-12-21" })).toEqual([`to: Mỗi đơn tối đa ${MAX_LEAVE_RANGE_DAYS} ngày — chia thành nhiều đơn.`]);
    expect(loi({ from: "2026-11-22", to: "2026-11-22" })).toEqual(["to: Chủ nhật đã là ngày nghỉ — không cần xin phép."]);
    expect(loi({ from: "2026-11-20", to: "2026-11-20", reason: "x".repeat(501) })).toEqual(["reason: Lý do tối đa 500 ký tự."]);
  });
});
