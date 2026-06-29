import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  computeManagementSalaries,
  totalManagementSalary,
  type SalaryRule,
  type BuildingBase,
} from "@/lib/managementSalary";

const B = (id: string, base: number): BuildingBase => ({ building_id: id, base });
const sum = (m: Map<string, number>) => [...m.values()].reduce((s, x) => s + x, 0);

describe("computeManagementSalaries — ví dụ cụ thể", () => {
  const bases = [B("b1", 10_000_000), B("b2", 30_000_000), B("b3", -5_000_000)];

  it("FIXED PER_BUILDING: mỗi nhà trong tập trừ đúng `amount`", () => {
    const rules: SalaryRule[] = [
      { manager_id: "m1", form: "FIXED", basis: "PER_BUILDING", amount: 2_000_000, percent: 0, building_ids: ["b1", "b2"] },
    ];
    const r = computeManagementSalaries(bases, rules);
    expect(r.perBuilding.get("b1")).toBe(2_000_000);
    expect(r.perBuilding.get("b2")).toBe(2_000_000);
    expect(r.perBuilding.get("b3")).toBeUndefined();
    expect(totalManagementSalary(r)).toBe(4_000_000);
  });

  it("FIXED TOTAL_GROUP: chia tổng theo tỷ lệ LN dương, Σ phần == tổng", () => {
    const rules: SalaryRule[] = [
      { manager_id: "m1", form: "FIXED", basis: "TOTAL_GROUP", amount: 4_000_000, percent: 0, building_ids: ["b1", "b2", "b3"] },
    ];
    const r = computeManagementSalaries(bases, rules);
    // trọng số: b1=10tr, b2=30tr, b3=0 (lỗ) → b1 1tr, b2 3tr, b3 0
    expect(r.perBuilding.get("b1")).toBe(1_000_000);
    expect(r.perBuilding.get("b2")).toBe(3_000_000);
    expect(r.perBuilding.get("b3") ?? 0).toBe(0);
    expect(totalManagementSalary(r)).toBe(4_000_000);
  });

  it("FIXED TOTAL_GROUP: tất cả nhà lỗ → chia ĐỀU", () => {
    const lossy = [B("b1", -1_000_000), B("b2", -2_000_000)];
    const rules: SalaryRule[] = [
      { manager_id: "m1", form: "FIXED", basis: "TOTAL_GROUP", amount: 3_000_001, percent: 0, building_ids: ["b1", "b2"] },
    ];
    const r = computeManagementSalaries(lossy, rules);
    // 3.000.001 / 2 → 1.500.000 + 1.500.001 (largest-remainder), tổng đúng
    expect(sum(r.perBuilding)).toBe(3_000_001);
  });

  it("PERCENT PER_BUILDING: % trên LN ròng, nhà lỗ = 0", () => {
    const rules: SalaryRule[] = [
      { manager_id: "m1", form: "PERCENT", basis: "PER_BUILDING", amount: 0, percent: 10, building_ids: ["b1", "b2", "b3"] },
    ];
    const r = computeManagementSalaries(bases, rules);
    expect(r.perBuilding.get("b1")).toBe(1_000_000); // 10% × 10tr
    expect(r.perBuilding.get("b2")).toBe(3_000_000); // 10% × 30tr
    expect(r.perBuilding.get("b3") ?? 0).toBe(0); // lỗ → 0
  });

  it("PERCENT TOTAL_GROUP: % trên tổng LN dương rồi chia tỷ lệ", () => {
    const rules: SalaryRule[] = [
      { manager_id: "m1", form: "PERCENT", basis: "TOTAL_GROUP", amount: 0, percent: 10, building_ids: ["b1", "b2", "b3"] },
    ];
    const r = computeManagementSalaries(bases, rules);
    // 10% × (10tr+30tr) = 4tr; chia tỷ lệ 1:3 → 1tr, 3tr
    expect(totalManagementSalary(r)).toBe(4_000_000);
    expect(r.perBuilding.get("b1")).toBe(1_000_000);
    expect(r.perBuilding.get("b2")).toBe(3_000_000);
  });

  it("nhiều quản lý cộng dồn trên cùng một nhà", () => {
    const rules: SalaryRule[] = [
      { manager_id: "m1", form: "FIXED", basis: "PER_BUILDING", amount: 1_000_000, percent: 0, building_ids: ["b1"] },
      { manager_id: "m2", form: "FIXED", basis: "PER_BUILDING", amount: 500_000, percent: 0, building_ids: ["b1"] },
    ];
    const r = computeManagementSalaries(bases, rules);
    expect(r.perBuilding.get("b1")).toBe(1_500_000);
    expect(r.perManager).toEqual(
      expect.arrayContaining([
        { manager_id: "m1", building_id: "b1", amount: 1_000_000 },
        { manager_id: "m2", building_id: "b1", amount: 500_000 },
      ])
    );
  });

  it("bỏ nhà ngoài scope (không có trong buildingBase)", () => {
    const rules: SalaryRule[] = [
      { manager_id: "m1", form: "FIXED", basis: "PER_BUILDING", amount: 1_000_000, percent: 0, building_ids: ["b1", "ngoai-thang"] },
    ];
    const r = computeManagementSalaries(bases, rules);
    expect(r.perBuilding.get("ngoai-thang")).toBeUndefined();
    expect(totalManagementSalary(r)).toBe(1_000_000);
  });
});

describe("computeManagementSalaries — bất biến (property-based)", () => {
  const arbBase = fc.array(
    fc.record({
      building_id: fc.string({ minLength: 1, maxLength: 4 }),
      base: fc.integer({ min: -50_000_000, max: 50_000_000 }),
    }),
    { minLength: 1, maxLength: 6 }
  ).map((arr) => {
    // building_id duy nhất
    const seen = new Set<string>();
    return arr.filter((b) => (seen.has(b.building_id) ? false : (seen.add(b.building_id), true)));
  });

  const arbRule = (ids: string[]) =>
    fc.record({
      manager_id: fc.constantFrom("m1", "m2", "m3"),
      form: fc.constantFrom<"FIXED" | "PERCENT">("FIXED", "PERCENT"),
      basis: fc.constantFrom<"PER_BUILDING" | "TOTAL_GROUP">("PER_BUILDING", "TOTAL_GROUP"),
      amount: fc.integer({ min: 0, max: 20_000_000 }),
      percent: fc.integer({ min: 0, max: 100 }),
      building_ids: fc.subarray(ids, { minLength: 0 }),
    });

  it("Σ perManager == Σ perBuilding; mọi khoản ≥ 0", () => {
    fc.assert(
      fc.property(
        arbBase.chain((bases) =>
          fc.tuple(
            fc.constant(bases),
            fc.array(arbRule(bases.map((b) => b.building_id)), { maxLength: 5 })
          )
        ),
        ([bases, rules]) => {
          const r = computeManagementSalaries(bases, rules);
          const sumPerManager = r.perManager.reduce((s, x) => s + x.amount, 0);
          expect(sumPerManager).toBe(sum(r.perBuilding));
          for (const v of r.perBuilding.values()) expect(v).toBeGreaterThanOrEqual(0);
          for (const x of r.perManager) expect(x.amount).toBeGreaterThanOrEqual(0);
        }
      )
    );
  });

  it("FIXED TOTAL_GROUP: tổng trừ == round(amount) khi có ≥1 nhà", () => {
    fc.assert(
      fc.property(
        arbBase,
        fc.integer({ min: 1, max: 20_000_000 }),
        (bases, amount) => {
          const ids = bases.map((b) => b.building_id);
          const rules: SalaryRule[] = [
            { manager_id: "m1", form: "FIXED", basis: "TOTAL_GROUP", amount, percent: 0, building_ids: ids },
          ];
          const r = computeManagementSalaries(bases, rules);
          expect(sum(r.perBuilding)).toBe(Math.round(amount));
        }
      )
    );
  });
});
