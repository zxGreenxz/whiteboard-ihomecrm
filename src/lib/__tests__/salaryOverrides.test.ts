import { describe, expect, it } from "vitest";
import { salCalc, type SalManager } from "@/lib/managerSalary";
import { applySalaryExtras, bonusLineKey, isOverridableKey, parseOverrideRows, type SalLineOverride } from "@/lib/salaryOverrides";
import { fundLinesOf } from "@/lib/salaryFundReport";
import type { RecurringItem } from "@/lib/salaryRecurring";

const VID = "0e0f3c2a-1111-4222-8333-944455556666";
const IID = "04d94e26-72cb-4ead-86b0-866646efd3fd";

function mgr(p: Partial<SalManager> = {}): SalManager {
  return {
    id: "s1", name: "NATHAN", short: "Nathan", alias: "", role: "Quản lý vận hành", initials: "N", tone: "primary",
    workdays: 25, base: 6000000, roomRent: 0, incomeGoal: 0,
    bonusAuto: [
      { icon: "Flame", label: "Thưởng chuỗi (v5)", amount: 1700000 },
      { icon: "Wrench", label: "sửa", note: "16 việc × 30.000", amount: 480000 },
      { icon: "FileClock", label: "Ký HĐ ngoài giờ", amount: 650000 },
    ],
    adjustments: [], investment: 0, investmentBy: [], investmentLocked: true,
    commission: 2340000, commissionItems: [{ label: "Hoa hồng 303/405PVB", amount: 2340000, approved: false, voucherId: VID }],
    commissionFlagged: [], advance: 0, advanceItems: [], roomRentItems: [], roomRentInvoice: null,
    paid: 0, stats: { jobs: 16, repairs: 16, afterHour: 0, workdays: 25, streak: 0 }, trend: [],
    status: "DRAFT", salaryMonthlyId: null, ledger: [], frozen: null, organizationId: "org", ...p,
  };
}

const rec = (p: Partial<RecurringItem> = {}): RecurringItem => ({
  id: IID, staffId: "s1", staffName: "NATHAN", label: "Lương QL bổ sung", category: "SUPPLEMENTARY",
  buildingId: "b44", buildingName: "44TL", note: null, amountForPeriod: 1500000, periodLocked: false, versions: [], ...p,
});

const ovr = (key: string, amount: number, computed = 0): SalLineOverride =>
  ({ staffId: "s1", key, label: key, computed, amount, reason: "lý do", byName: "Chủ", at: "2026-09-27T08:00:00Z" });

describe("khoá dòng", () => {
  it("khớp CHECK line_key của server", () => {
    expect(bonusLineKey({ icon: "Flame", label: "x" })).toBe("streak");
    expect(bonusLineKey({ icon: "CalendarCheck", label: "x" })).toBe("ot");
    expect(bonusLineKey({ icon: "FileClock", label: "x" })).toBe("contract");
    expect(bonusLineKey({ icon: "Wrench", label: "sửa" })).toBe("job:sửa");
    for (const k of ["base", "streak", "job:sửa", "rec:" + IID, "sale:" + VID, "dh:44TL"]) expect(isOverridableKey(k)).toBe(true);
    for (const k of ["advance", "room", "adj:" + IID, "extra-locked", "work-locked"]) expect(isOverridableKey(k)).toBe(false);
  });
});

describe("applySalaryExtras — kỳ chưa chốt", () => {
  it("khoản định kỳ vào Thưởng/Trừ, thực nhận tăng đúng", () => {
    const m = applySalaryExtras(mgr(), [rec()], []);
    expect(m.adjustments.map((a) => [a.id, a.amount, a.recurring?.category])).toEqual([["rec:" + IID, 1500000, "SUPPLEMENTARY"]]);
    expect(salCalc(m).takehome - salCalc(mgr()).takehome).toBe(1500000);
    // báo cáo cơ cấu nhận đúng loại (không cần đoán nhãn)
    expect(fundLinesOf(m).find((l) => l.key === "supplementary")?.amount).toBe(1500000);
  });

  it("khoản đã ngừng / chưa bắt đầu (0đ) không sinh dòng", () => {
    expect(applySalaryExtras(mgr(), [rec({ amountForPeriod: 0 })], []).adjustments).toEqual([]);
  });

  it("ghi đè từng khoản thay số máy tính trước salCalc, giữ số máy tính để hiển thị", () => {
    const m = applySalaryExtras(mgr(), [rec()], [
      ovr("base", 5500000, 6000000), ovr("streak", 1000000, 1700000), ovr("job:sửa", 0, 480000),
      ovr("rec:" + IID, 1200000, 1500000), ovr("sale:" + VID, 2000000, 2340000),
    ]);
    expect(m.base).toBe(5500000);
    expect(m.bonusAuto.map((b) => b.amount)).toEqual([1000000, 0, 650000]);
    expect(m.adjustments[0].amount).toBe(1200000);
    expect(m.commission).toBe(2000000);
    expect(m.overrides?.base).toMatchObject({ computed: 6000000, amount: 5500000, reason: "lý do" });
    expect(m.overrides?.streak?.computed).toBe(1700000);
    const c = salCalc(m);
    expect(c.gross).toBe(5500000 + 1000000 + 0 + 650000 + 1200000 + 2000000);
  });

  it("phân bổ lợi nhuận gộp theo toà, ghi đè được cả số âm", () => {
    const m = applySalaryExtras(mgr({ investmentBy: [{ b: "44TL", amount: 300000 }, { b: "44TL", amount: 200000 }], investment: 500000 }), [], [ovr("dh:44TL", -200000, 500000)]);
    expect(m.investmentBy).toEqual([{ b: "44TL", amount: -200000 }]);
    expect(m.investment).toBe(-200000);
  });

  it("ghi đè của người khác không áp", () => {
    const m = applySalaryExtras(mgr(), [], [{ ...ovr("base", 1), staffId: "s2" }]);
    expect(m.base).toBe(6000000);
    expect(m.overrides).toEqual({});
  });
});

describe("applySalaryExtras — kỳ đã chốt", () => {
  it("không áp lại lương cứng / HH / đồng hành vào số đóng băng; chỉ gắn để hiển thị", () => {
    const locked = mgr({ status: "LOCKED", base: 6000000, commission: 2000000, frozen: { base: 5500000, investment: 0, commission: 2000000, advance: 0 } });
    const m = applySalaryExtras(locked, [], [ovr("base", 5500000, 6000000), ovr("sale:" + VID, 2000000, 2340000)]);
    expect(m.base).toBe(6000000); // baseOf dùng frozen.base
    expect(m.commission).toBe(2000000); // giữ số đang có của kỳ chốt
    expect(m.commissionItems[0].amount).toBe(2000000); // dòng khớp tổng đã chốt
    expect(m.overrides?.base?.amount).toBe(5500000);
  });
});

describe("parseOverrideRows — biên RPC", () => {
  it("đọc hàng, sai hình dạng thì ném", () => {
    const r = { staff_id: "s1", line_key: "base", line_label: "Lương cứng", computed_amount: "6000000", amount: 5500000, reason: "x", created_by: "u", created_by_name: null, created_at: "t" };
    expect(parseOverrideRows([r])[0]).toMatchObject({ key: "base", computed: 6000000, amount: 5500000 });
    expect(() => parseOverrideRows([{ ...r, amount: null }])).toThrow();
  });
});
