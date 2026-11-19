import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { attendPay, dayRate, effectiveMilestones } from "../v5Calendar";

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

describe("effectiveMilestones V5.1 — sentinel n_top: đỉnh động = N_chuẩn, Σ = 2.5tr", () => {
  const MILESTONES: (number | "full_month" | "n_top")[] = [4, 8, 13, 18, 23, "n_top"];
  const DELTAS = [300_000, 400_000, 500_000, 500_000, 400_000, 400_000];

  it("n=26: đỉnh động tại 26, delta 400k, Σ = 2.5tr", () => {
    const eff = effectiveMilestones(MILESTONES, DELTAS, 26);
    const top = eff[eff.length - 1];
    expect(top).toMatchObject({ milestone: "n_top", at: 26, delta: 400_000 });
    expect(eff.reduce((s, m) => s + m.delta, 0)).toBe(2_500_000);
  });

  it("n=23: n_top MERGE vào mốc 23 (một mốc duy nhất, delta 800k)", () => {
    const eff = effectiveMilestones(MILESTONES, DELTAS, 23);
    expect(eff.filter((m) => m.at === 23)).toHaveLength(1);
    expect(eff.find((m) => m.at === 23)!.delta).toBe(800_000);
    expect(eff.reduce((s, m) => s + m.delta, 0)).toBe(2_500_000);
  });

  it("n=22: mốc 23 bị cắt, delta dồn vào đỉnh động 22", () => {
    const eff = effectiveMilestones(MILESTONES, DELTAS, 22);
    const top = eff[eff.length - 1];
    expect(top.at).toBe(22);
    expect(top.delta).toBe(800_000);
    expect(eff.reduce((s, m) => s + m.delta, 0)).toBe(2_500_000);
  });

  it("property: với mọi N ∈ [1..31], Σ delta = 2.5tr và đỉnh luôn tại N", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 31 }), (n) => {
        const eff = effectiveMilestones(MILESTONES, DELTAS, n);
        expect(eff.reduce((s, m) => s + m.delta, 0)).toBe(2_500_000);
        expect(Math.max(...eff.map((m) => m.at ?? 0))).toBe(n);
      }),
    );
  });
});
