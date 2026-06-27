import { describe, it, expect } from "vitest";
import {
  salCalc,
  firstName,
  initialsOf,
  buildBonusAuto,
  computeStats,
  computeStreak,
  type SalLedgerRow,
} from "@/lib/managerSalary";

function job(staff: string, date: string, jobType: string, bonus: number, opts: Partial<SalLedgerRow> = {}): SalLedgerRow {
  return {
    staff_id: staff, item_type: "JOB", source_id: "x", occurred_date: date, day_label: "",
    content: "v", place: "405PVB · 201", job_type_name: jobType, is_repair: bonus > 0,
    base_amount: bonus, weekend_amount: 0, after_amount: 0, cash_amount: null,
    has_photo: true, bonus_amount: bonus, reason: jobType, ...opts,
  };
}
function day(staff: string, date: string): SalLedgerRow {
  return { staff_id: staff, item_type: "DAY_BONUS", source_id: null, occurred_date: date, day_label: "CN",
    content: "CN", place: "", job_type_name: null, is_repair: true, base_amount: 0, weekend_amount: 20000,
    after_amount: 0, cash_amount: null, has_photo: null, bonus_amount: 20000, reason: "CN/Lễ" };
}
function contract(staff: string, date: string): SalLedgerRow {
  return { staff_id: staff, item_type: "CONTRACT", source_id: "c", occurred_date: date, day_label: "",
    content: "HĐ", place: "", job_type_name: null, is_repair: false, base_amount: 0, weekend_amount: 0,
    after_amount: 50000, cash_amount: null, has_photo: null, bonus_amount: 50000, reason: "HĐ ngoài giờ" };
}

describe("firstName / initials", () => {
  it("lấy tên gọi tiếng Việt", () => {
    expect(firstName("Quách Cao Phú Hiển")).toBe("Hiển");
    expect(firstName("Trần Bảo Hiệp")).toBe("Hiệp");
    expect(initialsOf("Hiển")).toBe("H");
  });
});

describe("buildBonusAuto", () => {
  it("gộp việc theo loại + ngày CN/Lễ + HĐ, đúng tổng", () => {
    const led = [
      job("h", "2026-06-02", "sửa", 30000),
      job("h", "2026-06-03", "sửa", 30000),
      job("h", "2026-06-04", "thay", 30000),
      day("h", "2026-06-02"),
      contract("h", "2026-06-05"),
      contract("h", "2026-06-09"),
    ];
    const lines = buildBonusAuto(led);
    const total = lines.reduce((s, l) => s + l.amount, 0);
    // 3 việc × 30k + 1 ngày × 20k + 2 HĐ × 50k = 90k + 20k + 100k = 210k
    expect(total).toBe(210000);
    const contractLine = lines.find((l) => l.icon === "FileClock");
    expect(contractLine?.amount).toBe(100000);
    expect(contractLine?.note).toContain("2 HĐ");
  });

  it("bỏ việc thiếu ảnh (bonus_amount=0) khỏi tổng", () => {
    const led = [job("h", "2026-06-08", "sửa", 0, { has_photo: false })];
    const lines = buildBonusAuto(led);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(0);
  });
});

describe("salCalc", () => {
  it("gross/takehome đúng công thức", () => {
    const m = {
      base: 8000000, investment: 5254000, commission: 600000, advance: 4974000, roomRent: 2742000,
      bonusAuto: [{ icon: "Wrench", label: "Sửa chữa", amount: 540000 }],
      adjustments: [{ icon: "Plus", label: "Cố gắng", amount: 260000 }, { icon: "Minus", label: "Phạt", amount: -30000 }],
    };
    const c = salCalc(m);
    expect(c.bonus).toBe(540000 + 260000 - 30000); // 770000
    expect(c.gross).toBe(8000000 + 770000 + 5254000 + 600000); // 14624000
    expect(c.takehome).toBe(c.gross - 4974000 - 2742000);
  });
});

describe("computeStats / computeStreak", () => {
  it("đếm việc/sửa chữa/HĐ và ngày công", () => {
    const led = [
      job("h", "2026-06-02", "sửa", 30000),
      job("h", "2026-06-03", "thay", 30000),
      day("h", "2026-06-02"),
      contract("h", "2026-06-05"),
    ];
    const s = computeStats(led);
    expect(s.jobs).toBe(2);
    expect(s.repairs).toBe(2);
    expect(s.afterHour).toBe(1);
    expect(s.workdays).toBe(3); // 02, 03, 05 (DAY_BONUS không tính)
  });

  it("streak ngày liên tục gần nhất", () => {
    const led = [
      job("h", "2026-06-10", "sửa", 30000),
      job("h", "2026-06-11", "sửa", 30000),
      job("h", "2026-06-12", "sửa", 30000),
    ];
    expect(computeStreak(led)).toBe(3);
  });
});
