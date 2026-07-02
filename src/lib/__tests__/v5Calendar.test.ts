import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  attendPay,
  dayOfWeek,
  dayRate,
  daysInMonth,
  effectiveMilestones,
  nChuan,
  toIso,
  workdaysInMonth,
} from "../v5Calendar";

// Fixture ĐÃ ĐỐI CHIẾU với SQL live (vn_workdays) ngày 2026-07-03:
//   T7/2026 = 27 ngày-làm (31 ngày − 4 CN, 0 lễ)
//   T9/2026 = 25 ngày-làm (30 − 4 CN − 1 lễ 02/09)
describe("v5Calendar — parity fixtures với SQL", () => {
  it("T7/2026 có 27 ngày-làm", () => {
    expect(workdaysInMonth(2026, 7, [])).toHaveLength(27);
  });
  it("T9/2026 có 25 ngày-làm (lễ 02/09)", () => {
    expect(workdaysInMonth(2026, 9, ["2026-09-02"])).toHaveLength(25);
  });
  it("N_chuẩn T7/2026 với 1 phép-duyệt = 26 (khớp SQL v5_n_chuan)", () => {
    expect(nChuan(2026, 7, [], ["2026-07-08"])).toBe(26);
  });
});

describe("v5Calendar — bất biến (property-based)", () => {
  const arbYm = fc.record({
    year: fc.integer({ min: 2024, max: 2030 }),
    month1: fc.integer({ min: 1, max: 12 }),
  });

  it("không có CN trong ngày-làm; tất cả thuộc đúng tháng", () => {
    fc.assert(
      fc.property(arbYm, ({ year, month1 }) => {
        const wd = workdaysInMonth(year, month1, []);
        expect(wd.every((d) => dayOfWeek(d) !== 0)).toBe(true);
        expect(wd.every((d) => d.startsWith(`${year}-${String(month1).padStart(2, "0")}`))).toBe(true);
      }),
    );
  });

  it("mỗi ngày lễ rơi vào T2–T7 giảm đúng 1 ngày-làm; lễ CN không giảm", () => {
    fc.assert(
      fc.property(arbYm, fc.integer({ min: 1, max: 28 }), ({ year, month1 }, day) => {
        const iso = toIso(year, month1, day);
        const base = workdaysInMonth(year, month1, []).length;
        const withHol = workdaysInMonth(year, month1, [iso]).length;
        expect(withHol).toBe(dayOfWeek(iso) === 0 ? base : base - 1);
      }),
    );
  });

  it("phép-duyệt giảm N_chuẩn đúng số ngày phép hợp lệ; phép trùng CN/lễ không trừ", () => {
    fc.assert(
      fc.property(arbYm, fc.integer({ min: 1, max: 28 }), ({ year, month1 }, day) => {
        const iso = toIso(year, month1, day);
        const base = nChuan(year, month1, [], []);
        const withLeave = nChuan(year, month1, [], [iso, iso]); // trùng lặp không trừ đôi
        expect(withLeave).toBe(dayOfWeek(iso) === 0 ? base : base - 1);
      }),
    );
  });

  it("đơn giá × N_chuẩn = budget (sai số float ≤ 1e-6); đi đủ N ngày nhận tròn budget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_000_000, max: 20_000_000 }),
        fc.integer({ min: 1, max: 31 }),
        (budget, n) => {
          expect(Math.abs(dayRate(budget, n) * n - budget)).toBeLessThan(1e-6);
          expect(Math.abs(attendPay(budget, n, n) - budget)).toBeLessThan(1e-6);
          expect(attendPay(budget, n, n + 5)).toBeCloseTo(budget, 6); // cap tại N
          expect(attendPay(budget, n, 0)).toBe(0);
        },
      ),
    );
  });

  it("daysInMonth đúng cho năm nhuận", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });
});

describe("effectiveMilestones — tháng ngắn cắt mốc từ trên xuống, Σ luôn = budget (C10)", () => {
  const MILESTONES: (number | "full_month")[] = [4, 8, 13, 18, 23, "full_month"];
  const DELTAS = [300_000, 500_000, 600_000, 600_000, 500_000, 500_000];

  it("tháng đủ dài: giữ nguyên 6 mốc, Σ = 3tr", () => {
    const eff = effectiveMilestones(MILESTONES, DELTAS, 26);
    expect(eff).toHaveLength(6);
    expect(eff.reduce((s, m) => s + m.delta, 0)).toBe(3_000_000);
  });

  it("tháng Tết N=20: mốc 23 bị cắt, delta dồn vào full_month, Σ vẫn = 3tr", () => {
    const eff = effectiveMilestones(MILESTONES, DELTAS, 20);
    expect(eff.map((m) => m.milestone)).toEqual([4, 8, 13, 18, "full_month"]);
    expect(eff.find((m) => m.milestone === "full_month")!.delta).toBe(1_000_000);
    expect(eff.reduce((s, m) => s + m.delta, 0)).toBe(3_000_000);
  });

  it("property: với mọi N ∈ [1..31], Σ delta hiệu-lực luôn = Σ delta gốc", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 31 }), (n) => {
        const eff = effectiveMilestones(MILESTONES, DELTAS, n);
        expect(eff.reduce((s, m) => s + m.delta, 0)).toBe(3_000_000);
        // full_month luôn còn
        expect(eff.some((m) => m.milestone === "full_month")).toBe(true);
      }),
    );
  });
});
