import { describe, it, expect } from "vitest";
import { salCalc, type SalManager } from "@/lib/managerSalary";
import {
  baseOf,
  fundLinesOf,
  fundPeopleOf,
  groupTotals,
  isSupplementaryLabel,
  mergeLines,
  operationalTotal,
  per100,
  supplementaryTotal,
} from "@/lib/salaryFundReport";

function mgr(over: Partial<SalManager> = {}): SalManager {
  const m: SalManager = {
    id: "s1", name: "Nguyễn Văn A", short: "A", alias: "", role: "Quản lý", initials: "A", tone: "primary",
    workdays: 26, base: 6_000_000, roomRent: 2_500_000, incomeGoal: 0,
    bonusAuto: [
      { icon: "Wrench", label: "Sửa chữa", note: "11 việc × 100.000", amount: 1_100_000 },
      { icon: "Flame", label: "Thưởng chuỗi (v5)", note: null, amount: 300_000 },
      { icon: "FileClock", label: "Ký HĐ ngoài giờ / CN / lễ", note: null, amount: 200_000 },
    ],
    adjustments: [
      { id: "a1", icon: "Plus", label: "Bonus QL", amount: 3_000_000 },
      { id: "a2", icon: "Plus", label: "Hỗ trợ xăng xe", amount: 500_000 },
      { id: "a3", icon: "Minus", label: "Đi trễ", amount: -100_000 },
    ],
    investment: 2_340_000, investmentBy: [], investmentLocked: true,
    commission: 800_000, commissionItems: [], commissionFlagged: [],
    advance: 1_000_000, advanceItems: [], roomRentItems: [], roomRentInvoice: null,
    paid: 0, stats: { jobs: 0, repairs: 0, afterHour: 0, workdays: 26, streak: 0 }, trend: [],
    status: "DRAFT", salaryMonthlyId: null, ledger: [],
    ...over,
  };
  m.calc = m.calc ?? salCalc(m);
  return m;
}

describe("isSupplementaryLabel", () => {
  it("nhận Bonus QL và lương QL bổ sung, không nhận phụ cấp thường", () => {
    expect(isSupplementaryLabel("Bonus QL")).toBe(true);
    expect(isSupplementaryLabel("bonus ql 44TL")).toBe(true);
    expect(isSupplementaryLabel("Lương QL bổ sung · 481NVK")).toBe(true);
    expect(isSupplementaryLabel("Lương quản lý bổ sung")).toBe(true);
    expect(isSupplementaryLabel("Hỗ trợ xăng xe")).toBe(false);
    expect(isSupplementaryLabel("Bonus quý")).toBe(false);
  });
});

describe("fundLinesOf", () => {
  it("tổng lương vận hành = gross − đầu tư − HH Sale (không đổi công thức)", () => {
    const m = mgr();
    const total = fundLinesOf(m).reduce((s, l) => s + l.amount, 0);
    expect(total).toBe(m.calc!.gross - m.investment - m.commission);
    expect(operationalTotal([m])).toBe(total);
  });

  it("chia 3 nhóm và đánh dấu lương QL bổ sung", () => {
    const t = groupTotals(fundLinesOf(mgr()));
    expect(t).toEqual({ base: 6_000_000, work: 1_600_000, extra: 3_400_000 });
    expect(supplementaryTotal(fundPeopleOf([mgr()]))).toBe(3_000_000);
  });

  it("kỳ đã chốt: lương cứng suy từ số chốt và phần lệch thành dòng riêng", () => {
    const m = mgr({
      status: "LOCKED",
      base: 9_999_999, // cấu hình hiện tại — không được dùng cho kỳ đã chốt
      calc: { autoSum: 1_900_000, adjSum: 3_400_000, bonus: 5_300_000, gross: 5_500_000 + 5_300_000 + 2_340_000 + 800_000, takehome: 0 },
    });
    expect(baseOf(m)).toBe(5_500_000);
    const lines = fundLinesOf(m);
    const extraWork = lines.find((l) => l.key === "work-locked");
    expect(extraWork?.amount).toBe(300_000);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(5_500_000 + 5_300_000);
  });
});

describe("baseOf với số đóng băng", () => {
  it("kỳ đã chốt dùng base_salary đã chốt, không suy từ đầu tư/HH live", () => {
    const m = mgr({
      status: "LOCKED", investment: 999_999, commission: 0, // live đã trôi sau khi chốt
      frozen: { base: 5_500_000, investment: 2_340_000, commission: 800_000, advance: 1_000_000 },
      calc: { autoSum: 1_900_000, adjSum: 3_400_000, bonus: 5_300_000, gross: 5_500_000 + 5_300_000 + 2_340_000 + 800_000, takehome: 0 },
    });
    expect(baseOf(m)).toBe(5_500_000);
    expect(fundLinesOf(m).reduce((s, l) => s + l.amount, 0)).toBe(5_500_000 + 5_300_000);
  });
});

describe("mergeLines", () => {
  it("gộp cùng key giữa nhiều người và bỏ được lương bổ sung", () => {
    const people = fundPeopleOf([mgr(), mgr({ id: "s2", adjustments: [] })]);
    const all = mergeLines(people);
    expect(all.find((l) => l.key === "base")?.amount).toBe(12_000_000);
    const sep = mergeLines(people, true);
    expect(sep.some((l) => l.supplementary)).toBe(false);
    const sum = (ls: typeof all) => ls.reduce((s, l) => s + l.amount, 0);
    expect(sum(all) - sum(sep)).toBe(3_000_000);
  });
});

describe("per100", () => {
  it("luôn cộng đúng 100", () => {
    expect(per100([1, 1, 1]).reduce((s, v) => s + v, 0)).toBe(100);
    expect(per100([15_000_000, 3_000_000, 3_600_000])).toEqual([69, 14, 17]);
  });
  it("tổng 0 hoặc âm không chia", () => {
    expect(per100([0, 0, 0])).toEqual([0, 0, 0]);
    expect(per100([100, 0, -50])).toEqual([100, 0, 0]);
  });
});
