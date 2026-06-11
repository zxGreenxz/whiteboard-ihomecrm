import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  marginPct,
  deltaPct,
  sharePct,
  ratioPct,
  collectionRate,
  occupancyAgg,
  shiftMonth,
  monthsRange,
  ymOf,
  monthLabel,
  aggregatePnlByMonth,
  scaffoldMonths,
  heatClass,
  buildInsights,
  type InsightInput,
} from "../utils";
import type { FaMonthlyPnlRow, MonthAgg } from "../types";

describe("công thức cơ bản", () => {
  it("marginPct = net/revenue*100, revenue<=0 → null", () => {
    expect(marginPct(30, 100)).toBe(30);
    expect(marginPct(-10, 100)).toBe(-10);
    expect(marginPct(5, 0)).toBeNull();
    expect(marginPct(5, -1)).toBeNull();
  });

  it("deltaPct guard prev null/0, base âm vẫn đúng hướng", () => {
    expect(deltaPct(120, 100)).toBeCloseTo(20);
    expect(deltaPct(80, 100)).toBeCloseTo(-20);
    expect(deltaPct(100, 0)).toBeNull();
    expect(deltaPct(100, null)).toBeNull();
    expect(deltaPct(100, undefined)).toBeNull();
    // base âm (lỗ -100 → lãi 50): cải thiện → dương
    expect(deltaPct(50, -100)).toBeCloseTo(150);
  });

  it("sharePct / ratioPct / collectionRate guard chia 0", () => {
    expect(sharePct(25, 100)).toBe(25);
    expect(sharePct(25, 0)).toBeNull();
    expect(ratioPct(60, 100)).toBe(60);
    expect(ratioPct(60, 0)).toBeNull();
    expect(collectionRate(90, 100)).toBe(90);
    expect(collectionRate(90, 0)).toBeNull();
  });

  it("occupancyAgg trọng số THEO PHÒNG, không trung bình %", () => {
    // Toà A 10/10 (100%), toà B 0/90 (0%) → 10/100 = 10%, KHÔNG phải 50%
    const rows = [
      { total_rooms: 10, occupied_rooms: 10 },
      { total_rooms: 90, occupied_rooms: 0 },
    ];
    expect(occupancyAgg(rows)).toBeCloseTo(10);
    expect(occupancyAgg([])).toBeNull();
    expect(occupancyAgg([{ total_rooms: 0, occupied_rooms: 0 }])).toBeNull();
  });
});

describe("số học tháng (string)", () => {
  it("shiftMonth qua năm", () => {
    expect(shiftMonth("2026-06", -1)).toBe("2026-05");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2025-12", 1)).toBe("2026-01");
    expect(shiftMonth("2026-06", -12)).toBe("2025-06");
  });

  it("shiftMonth(ym, -n) rồi +n trả về ym (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: -36, max: 36 }),
        (y, m, d) => {
          const ym = `${y}-${String(m).padStart(2, "0")}`;
          expect(shiftMonth(shiftMonth(ym, d), -d)).toBe(ym);
        },
      ),
    );
  });

  it("monthsRange kết thúc tại endYm, đủ count, liên tiếp", () => {
    const r = monthsRange("2026-02", 4);
    expect(r).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("ymOf / monthLabel", () => {
    expect(ymOf("2026-06-01")).toBe("2026-06");
    expect(monthLabel("2026-06")).toBe("06/26");
    expect(monthLabel("2025-12-01")).toBe("12/25");
  });
});

describe("gộp & scaffold", () => {
  const row = (month: string, b: string, revenue: number, expense: number): FaMonthlyPnlRow => ({
    month,
    building_id: b,
    building_name: b,
    is_virtual: false,
    revenue,
    expense,
    net: revenue - expense,
  });

  it("aggregatePnlByMonth cộng mọi toà cùng tháng", () => {
    const map = aggregatePnlByMonth([
      row("2026-05-01", "A", 100, 40),
      row("2026-05-01", "B", 50, 10),
      row("2026-06-01", "A", 70, 30),
    ]);
    expect(map.get("2026-05")).toEqual({ ym: "2026-05", revenue: 150, expense: 50, net: 100 });
    expect(map.get("2026-06")).toEqual({ ym: "2026-06", revenue: 70, expense: 30, net: 40 });
  });

  it("scaffoldMonths điền 0 cho tháng thiếu", () => {
    const byMonth = new Map<string, MonthAgg>([
      ["2026-05", { ym: "2026-05", revenue: 1, expense: 1, net: 0 }],
    ]);
    const out = scaffoldMonths(["2026-04", "2026-05"], byMonth);
    expect(out[0]).toEqual({ ym: "2026-04", revenue: 0, expense: 0, net: 0 });
    expect(out[1].revenue).toBe(1);
  });
});

describe("heatClass", () => {
  it("dương → emerald, âm → red, 0/maxAbs<=0 → rỗng", () => {
    expect(heatClass(100, 100)).toContain("emerald");
    expect(heatClass(-100, 100)).toContain("red");
    expect(heatClass(0, 100)).toBe("");
    expect(heatClass(50, 0)).toBe("");
  });
});

describe("buildInsights", () => {
  const baseInput = (over?: Partial<InsightInput>): InsightInput => ({
    ym: "2026-06",
    byMonth: new Map([
      ["2026-04", { ym: "2026-04", revenue: 1000, expense: 500, net: 500 }],
      ["2026-05", { ym: "2026-05", revenue: 1000, expense: 500, net: 500 }],
      ["2026-06", { ym: "2026-06", revenue: 1000, expense: 500, net: 500 }],
    ]),
    occupancyPct: 95,
    vacantRooms: 2,
    vacancyLoss: 5_000_000,
    collection: { billed: 1000, collected: 950 },
    agingOver90: 0,
    buildingNets: [{ name: "Toà A", net: 100, isVirtual: false }],
    uncategorizedIncomePct: 0,
    uncategorizedExpensePct: 0,
    ...over,
  });

  it("mọi chỉ số khoẻ → 1 insight xanh duy nhất", () => {
    const out = buildInsights(baseInput());
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe("green");
  });

  it("tháng lỗ → insight đỏ", () => {
    const byMonth = new Map(baseInput().byMonth);
    byMonth.set("2026-06", { ym: "2026-06", revenue: 100, expense: 300, net: -200 });
    const out = buildInsights(baseInput({ byMonth }));
    expect(out.some((i) => i.severity === "red" && i.title.includes("LỖ"))).toBe(true);
  });

  it("toà ảo Chung âm KHÔNG kích hoạt rule toà lỗ", () => {
    const out = buildInsights(
      baseInput({ buildingNets: [{ name: "Chung", net: -999, isVirtual: true }] }),
    );
    expect(out.every((i) => !i.title.includes("lợi nhuận âm"))).toBe(true);
  });

  it("lấp đầy 60% → đỏ; 80% → amber", () => {
    expect(
      buildInsights(baseInput({ occupancyPct: 60 })).some(
        (i) => i.severity === "red" && i.title.includes("lấp đầy"),
      ),
    ).toBe(true);
    expect(
      buildInsights(baseInput({ occupancyPct: 80 })).some(
        (i) => i.severity === "amber" && i.title.includes("lấp đầy"),
      ),
    ).toBe(true);
  });

  it("nợ >90 ngày > 0 → đỏ; thu hồi < 90% → cảnh báo", () => {
    expect(
      buildInsights(baseInput({ agingOver90: 1_000_000 })).some((i) => i.severity === "red"),
    ).toBe(true);
    expect(
      buildInsights(baseInput({ collection: { billed: 1000, collected: 500 } })).some((i) =>
        i.title.includes("Mới thu"),
      ),
    ).toBe(true);
  });

  it("CP/DT tăng 3 tháng liên tiếp → amber", () => {
    const byMonth = new Map<string, MonthAgg>([
      ["2026-04", { ym: "2026-04", revenue: 1000, expense: 400, net: 600 }],
      ["2026-05", { ym: "2026-05", revenue: 1000, expense: 500, net: 500 }],
      ["2026-06", { ym: "2026-06", revenue: 1000, expense: 600, net: 400 }],
    ]);
    const out = buildInsights(baseInput({ byMonth }));
    expect(out.some((i) => i.title.includes("tăng 3 tháng"))).toBe(true);
  });

  it("doanh thu giảm ≥10% MoM → amber; phiếu thiếu hạng mục >10% → amber", () => {
    const byMonth = new Map(baseInput().byMonth);
    byMonth.set("2026-06", { ym: "2026-06", revenue: 850, expense: 200, net: 650 });
    expect(
      buildInsights(baseInput({ byMonth })).some((i) => i.title.includes("Doanh thu giảm")),
    ).toBe(true);
    expect(
      buildInsights(baseInput({ uncategorizedExpensePct: 25 })).some((i) =>
        i.title.includes("chưa gắn hạng mục"),
      ),
    ).toBe(true);
  });
});
