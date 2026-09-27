import { describe, expect, it } from "vitest";
import {
  ownerSupplementByBuilding, parseRecurringRows, recurringAmountFor,
  type RecurringItem, type RecurringVersion,
} from "@/lib/salaryRecurring";

const v = (seq: number, kind: RecurringVersion["kind"], month: string, amount: number | null) =>
  ({ seq, kind, effectiveMonth: month + "-01", amount });

describe("recurringAmountFor — cùng luật app_private.salary_recurring_amount_v1", () => {
  // Cùng chuỗi phiên bản đã chạy trên TEST (34/34 ca) ngày 27/09/2026.
  const base = [v(1, "CHANGE", "2026-09", 500000), v(2, "ONCE", "2026-10", 300000), v(3, "STOP", "2026-12", null)];

  it("CHANGE áp từ tháng hiệu lực; ONCE chỉ đúng tháng; STOP về 0", () => {
    expect(recurringAmountFor(base, "2026-08-01")).toBeNull();
    expect(recurringAmountFor(base, "2026-09-01")).toBe(500000);
    expect(recurringAmountFor(base, "2026-10-01")).toBe(300000);
    expect(recurringAmountFor(base, "2026-11-01")).toBe(500000);
    expect(recurringAmountFor(base, "2026-12-01")).toBe(0);
    expect(recurringAmountFor(base, "2027-01-01")).toBe(0);
  });

  it("CHANGE từ 10 tạo SAU ONCE 10 thắng tháng 10, nhưng STOP 12 (tháng muộn hơn) vẫn giữ", () => {
    const vs = [...base, v(4, "CHANGE", "2026-10", 700000)];
    expect(recurringAmountFor(vs, "2026-10-01")).toBe(700000);
    expect(recurringAmountFor(vs, "2026-11-01")).toBe(700000);
    expect(recurringAmountFor(vs, "2026-12-01")).toBe(0);
  });

  it("ONCE tạo sau bản nền thắng riêng tháng đó", () => {
    const vs = [...base, v(4, "CHANGE", "2026-10", 700000), v(5, "ONCE", "2026-11", 250000)];
    expect(recurringAmountFor(vs, "2026-10-01")).toBe(700000);
    expect(recurringAmountFor(vs, "2026-11-01")).toBe(250000);
  });

  it("cùng tháng hiệu lực: bản tạo sau (seq lớn) thắng", () => {
    const vs = [v(1, "CHANGE", "2026-09", 500000), v(2, "CHANGE", "2026-09", 650000)];
    expect(recurringAmountFor(vs, "2026-09-01")).toBe(650000);
  });

  it("ONCE trước khi khoản bắt đầu vẫn áp cho đúng tháng đó", () => {
    expect(recurringAmountFor([v(1, "CHANGE", "2026-10", 500000), v(2, "ONCE", "2026-09", 100000)], "2026-09-01")).toBe(100000);
  });
});

describe("parseRecurringRows — biên RPC", () => {
  const row = {
    item_id: "i1", staff_id: "s1", staff_name: "NATHAN", label: "Lương QL bổ sung", category: "SUPPLEMENTARY",
    building_id: "b44", building_name: "44TL", note: null, created_at: "2026-09-27T08:00:00Z",
    amount_for_period: "1500000", period_locked: false,
    versions: [{ id: "v1", seq: 7, kind: "CHANGE", effective_month: "2026-09-01", amount: 1500000, reason: "Nhà 44TL", created_by: "u", created_by_name: "Chủ", created_at: "2026-09-27T08:00:00Z" }],
  };

  it("đọc số dạng chuỗi numeric và chuẩn hoá tháng", () => {
    const [it0] = parseRecurringRows([row]);
    expect(it0.amountForPeriod).toBe(1500000);
    expect(it0.versions[0]).toMatchObject({ seq: 7, kind: "CHANGE", effectiveMonth: "2026-09-01", amount: 1500000 });
  });

  it("sai hình dạng thì NÉM — không lặng lẽ thành 0đ", () => {
    expect(() => parseRecurringRows([{ ...row, category: "KHAC" }])).toThrow();
    expect(() => parseRecurringRows([{ ...row, amount_for_period: undefined }])).toThrow();
  });
});

describe("ownerSupplementByBuilding — nguồn Chủ công ty cấp thêm", () => {
  const mk = (p: Partial<RecurringItem>): RecurringItem => ({
    id: "x", staffId: "s", staffName: "A", label: "Lương QL bổ sung", category: "SUPPLEMENTARY",
    buildingId: "b1", buildingName: "44TL", note: null, amountForPeriod: 0, periodLocked: false, versions: [], ...p,
  });

  it("chỉ gom khoản bổ sung đang phát sinh, theo toà", () => {
    const r = ownerSupplementByBuilding([
      mk({ id: "1", amountForPeriod: 1500000 }),
      mk({ id: "2", staffName: "B", amountForPeriod: 500000 }),
      mk({ id: "3", buildingId: "b2", buildingName: "481NVK", amountForPeriod: 2000000 }),
      mk({ id: "4", buildingId: "b3", buildingName: "950NK", amountForPeriod: 0 }),
      mk({ id: "5", category: "ALLOWANCE", buildingId: null, buildingName: null, amountForPeriod: 700000 }),
    ]);
    expect(r.total).toBe(4000000);
    expect(r.rows.map((x) => [x.buildingName, x.amount, x.people.length])).toEqual([["44TL", 2000000, 2], ["481NVK", 2000000, 1]]);
  });
});
