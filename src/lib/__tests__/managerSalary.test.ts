import { describe, it, expect } from "vitest";
import {
  salCalc,
  firstName,
  initialsOf,
  buildBonusAuto,
  computeStats,
  computeStreak,
  resolveSalaryEngine,
  zeroBonusReason,
  isUnqualifiedContractRow,
  staffCeilingYm,
  shiftYm,
  autoStaffYm,
  isStaffMonthVisible,
  latestVisibleStaffYm,
  type SalLedgerRow,
} from "@/lib/managerSalary";

function job(staff: string, date: string, jobType: string, bonus: number, opts: Partial<SalLedgerRow> = {}): SalLedgerRow {
  return {
    staff_id: staff, item_type: "JOB", source_id: "x", occurred_date: date, day_label: "",
    content: "v", place: "405PVB · 201", job_type_name: jobType, is_repair: bonus > 0, is_contract: false,
    base_amount: bonus, weekend_amount: 0, after_amount: 0, cash_amount: null,
    has_photo: true, bonus_amount: bonus, reason: jobType, ...opts,
  };
}
function day(staff: string, date: string): SalLedgerRow {
  return { staff_id: staff, item_type: "DAY_BONUS", source_id: null, occurred_date: date, day_label: "CN",
    content: "CN", place: "", job_type_name: null, is_repair: true, is_contract: false, base_amount: 0, weekend_amount: 20000,
    after_amount: 0, cash_amount: null, has_photo: null, bonus_amount: 20000, reason: "CN/Lễ" };
}
// Dòng CONTRACT legacy (snapshot cũ trước khi bỏ nhánh (C))
function contract(staff: string, date: string): SalLedgerRow {
  return { staff_id: staff, item_type: "CONTRACT", source_id: "c", occurred_date: date, day_label: "",
    content: "HĐ", place: "", job_type_name: null, is_repair: false, is_contract: false, base_amount: 0, weekend_amount: 0,
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

  it("việc ký HĐ (is_contract) → gộp vào dòng FileClock, không nằm nhóm việc Wrench", () => {
    const led = [
      job("h", "2026-06-02", "Sửa", 30000),
      job("h", "2026-06-05", "Ký HĐ", 50000, { is_repair: false, is_contract: true }),
      job("h", "2026-06-06", "Ký HĐ", 50000, { is_repair: false, is_contract: true }),
    ];
    const lines = buildBonusAuto(led);
    const wrench = lines.filter((l) => l.icon === "Wrench");
    const fileClock = lines.find((l) => l.icon === "FileClock");
    expect(wrench.length).toBe(1); // chỉ nhóm "Sửa"
    expect(wrench[0].amount).toBe(30000);
    expect(fileClock?.amount).toBe(100000); // 2 việc ký HĐ × 50k
    expect(fileClock?.note).toContain("2 HĐ");
    // tổng = 30k + 100k
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(130000);
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

  it("afterHour đếm việc ký HĐ (checkin) đủ điều kiện, bỏ việc checkin không thưởng", () => {
    const led = [
      job("h", "2026-06-05", "Ký HĐ", 50000, { is_repair: false, is_contract: true }),
      job("h", "2026-06-06", "Ký HĐ", 0, { is_repair: false, is_contract: true, bonus_amount: 0 }), // giờ thường → 0
    ];
    const s = computeStats(led);
    expect(s.jobs).toBe(2);
    expect(s.afterHour).toBe(1); // chỉ việc checkin có thưởng
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

describe("tháng hiển thị cho nhân viên (lùi tháng + override)", () => {
  it("shiftYm qua biên năm", () => {
    expect(shiftYm("2026-06", -1)).toBe("2026-05");
    expect(shiftYm("2026-01", -1)).toBe("2025-12");
    expect(shiftYm("2026-12", 1)).toBe("2027-01");
  });

  it("mặc định: tháng 5 chưa chốt → hiện tháng 5; chốt rồi → tháng 6", () => {
    // T6 hiện tại, T5 chưa chốt
    let auto = autoStaffYm("2026-06", false);
    expect(auto).toBe("2026-05");
    expect(latestVisibleStaffYm("2026-06", auto, {})).toBe("2026-05");
    // T5 đã chốt → nhảy sang T6
    auto = autoStaffYm("2026-06", true);
    expect(auto).toBe("2026-06");
    expect(latestVisibleStaffYm("2026-06", auto, {})).toBe("2026-06");
  });

  it("override admin ưu tiên: ẩn tháng auto → lùi tiếp; hiện tháng hiện tại sớm", () => {
    const auto = autoStaffYm("2026-06", false); // 2026-05
    // ẩn T5 → lùi về T4
    expect(latestVisibleStaffYm("2026-06", auto, { "2026-05": false })).toBe("2026-04");
    // hiện T6 sớm dù T5 chưa chốt
    expect(latestVisibleStaffYm("2026-06", auto, { "2026-06": true })).toBe("2026-06");
    // không override → theo auto
    expect(isStaffMonthVisible("2026-06", auto, {})).toBe(false);
    expect(isStaffMonthVisible("2026-05", auto, {})).toBe(true);
  });
});

describe("resolveSalaryEngine", () => {
  const v5 = { system_v5: { salary_engine: "v5", effective_from: "2026-07-01" } };

  it("tháng TRƯỚC mốc hiệu lực → legacy (tháng 6 không có dữ liệu chấm công v5)", () => {
    expect(resolveSalaryEngine(v5, "2026-06-01")).toBe("legacy");
    expect(resolveSalaryEngine(v5, "2026-05-01")).toBe("legacy");
  });

  it("tháng TỪ mốc hiệu lực trở đi → v5", () => {
    expect(resolveSalaryEngine(v5, "2026-07-01")).toBe("v5");
    expect(resolveSalaryEngine(v5, "2026-08-01")).toBe("v5");
  });

  it("engine legacy thì luôn legacy dù tháng nào", () => {
    const cfg = { system_v5: { salary_engine: "legacy", effective_from: "2026-07-01" } };
    expect(resolveSalaryEngine(cfg, "2026-09-01")).toBe("legacy");
  });

  it("chưa đặt effective_from → giữ hành vi cũ (v5 áp mọi tháng)", () => {
    const cfg = { system_v5: { salary_engine: "v5" } };
    expect(resolveSalaryEngine(cfg, "2026-06-01")).toBe("v5");
  });

  it("config rỗng/null → legacy, không nổ", () => {
    expect(resolveSalaryEngine(null, "2026-07-01")).toBe("legacy");
    expect(resolveSalaryEngine({}, "2026-07-01")).toBe("legacy");
  });
});

describe("zeroBonusReason", () => {
  const job = (over: Partial<SalLedgerRow> = {}): SalLedgerRow => ({
    staff_id: "s", item_type: "JOB", source_id: "j", occurred_date: "2026-06-15",
    day_label: "", content: "sửa", place: "", job_type_name: "sửa",
    is_repair: true, is_contract: false, base_amount: 30000, weekend_amount: 0,
    after_amount: 0, cash_amount: null, has_photo: false, bonus_amount: 0,
    reason: "sửa", ...over,
  });

  it("việc bị loại khỏi thưởng → 'Không tính', KHÔNG đổ cho thiếu ảnh", () => {
    expect(zeroBonusReason(job({ excluded: true }), false)).toBe("Không tính");
  });

  it("không bắt buộc ảnh thì dù thiếu ảnh vẫn chỉ ghi 'Không tính'", () => {
    expect(zeroBonusReason(job({ has_photo: false }), false)).toBe("Không tính");
  });

  it("bắt buộc ảnh + đúng là thiếu ảnh → 'Thiếu ảnh — chưa tính'", () => {
    expect(zeroBonusReason(job({ has_photo: false }), true)).toBe("Thiếu ảnh — chưa tính");
  });

  it("bắt buộc ảnh nhưng CÓ ảnh (0đ vì lý do khác) → 'Không tính'", () => {
    expect(zeroBonusReason(job({ has_photo: true }), true)).toBe("Không tính");
  });

  it("dòng có thưởng → không chú thích gì", () => {
    expect(zeroBonusReason(job({ bonus_amount: 30000 }), true)).toBeNull();
  });

  it("dòng CASH (bonus null) → không chú thích gì", () => {
    expect(zeroBonusReason(job({ item_type: "CASH", bonus_amount: null }), true)).toBeNull();
  });
});

describe("isUnqualifiedContractRow", () => {
  const row = (over: Partial<SalLedgerRow> = {}): SalLedgerRow => ({
    staff_id: "s", item_type: "JOB", source_id: "j", occurred_date: "2026-06-12",
    day_label: "", content: "checkin làm hợp đồng", place: "", job_type_name: "checkin",
    is_repair: false, is_contract: true, base_amount: 50000, weekend_amount: 0,
    after_amount: 0, cash_amount: null, has_photo: false, bonus_amount: 0,
    reason: "checkin", ...over,
  });

  it("checkin trong giờ (0đ) → ẩn", () => {
    expect(isUnqualifiedContractRow(row())).toBe(true);
  });

  it("checkin ngoài giờ (có thưởng) → KHÔNG ẩn", () => {
    expect(isUnqualifiedContractRow(row({ bonus_amount: 50000 }))).toBe(false);
  });

  it("checkin bị chủ tự tay loại → KHÔNG ẩn (còn phải bấm Tính lại được)", () => {
    expect(isUnqualifiedContractRow(row({ excluded: true }))).toBe(false);
  });

  it("việc sửa 0đ (không phải ký HĐ) → KHÔNG ẩn", () => {
    expect(isUnqualifiedContractRow(row({ is_contract: false, is_repair: true }))).toBe(false);
  });

  it("dòng CN/Lễ và dòng thu tiền → KHÔNG ẩn", () => {
    expect(isUnqualifiedContractRow(row({ item_type: "DAY_BONUS", is_contract: false }))).toBe(false);
    expect(isUnqualifiedContractRow(row({ item_type: "CASH", bonus_amount: null }))).toBe(false);
  });
});

describe("staffCeilingYm", () => {
  it("mặc định = THÁNG HIỆN TẠI, không lùi 1 tháng như trước", () => {
    expect(staffCeilingYm("2026-07", {})).toBe("2026-07");
  });

  it("không phụ thuộc tháng trước đã chốt hay chưa", () => {
    expect(staffCeilingYm("2026-07", {})).toBe("2026-07");
    expect(staffCeilingYm("2026-01", {})).toBe("2026-01");
  });

  it("admin tắt tháng hiện tại → lùi về tháng gần nhất còn bật", () => {
    expect(staffCeilingYm("2026-07", { "2026-07": false })).toBe("2026-06");
    expect(staffCeilingYm("2026-07", { "2026-07": false, "2026-06": false })).toBe("2026-05");
  });

  it("admin bật tường minh tháng hiện tại → vẫn tháng hiện tại", () => {
    expect(staffCeilingYm("2026-07", { "2026-07": true })).toBe("2026-07");
  });
});
