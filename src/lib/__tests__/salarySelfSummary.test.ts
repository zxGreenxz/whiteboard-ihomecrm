import { describe, it, expect } from "vitest";
import { bankedMilestoneDays, salCalc, type SalLedgerRow, type SalManager, type SalV5Info } from "@/lib/managerSalary";
import {
  bonusDaysOf,
  contractRowsOf,
  earnedJobRowsOf,
  jobRowsOf,
  parseV5Plan,
  selfSummaryOf,
  streakViewOf,
  type V5Plan,
} from "@/lib/salarySelfSummary";

function row(over: Partial<SalLedgerRow>): SalLedgerRow {
  return {
    staff_id: "s1", item_type: "JOB", source_id: "j", occurred_date: "2026-01-05", day_label: "", content: "sửa vòi",
    place: "A · 101", job_type_name: "sửa", is_repair: true, is_contract: false, base_amount: 20_000,
    weekend_amount: 0, after_amount: 0, cash_amount: null, has_photo: true, bonus_amount: 20_000, reason: "", excluded: false,
    ...over,
  } as SalLedgerRow;
}

function mgr(over: Partial<SalManager> = {}): SalManager {
  const m: SalManager = {
    id: "s1", name: "Nguyễn Văn A", short: "A", alias: "", role: "Quản lý", initials: "A", tone: "primary",
    workdays: 20, base: 4_000_000, roomRent: 1_500_000, incomeGoal: 0,
    bonusAuto: [
      { icon: "Flame", label: "Thưởng chuỗi (v5)", note: "mốc chuỗi đã đạt", amount: 600_000 },
      { icon: "Wrench", label: "sửa", note: "3 việc × 20.000", amount: 60_000 },
      { icon: "CalendarCheck", label: "CN/Lễ có sửa chữa", note: "1 ngày × 40.000", amount: 40_000 },
    ],
    adjustments: [
      { id: "a1", icon: "Plus", label: "Phụ cấp xăng", amount: 300_000 },
      { id: "a2", icon: "Minus", label: "Đi trễ", amount: -50_000 },
    ],
    investment: 700_000, investmentBy: [{ b: "T1", amount: 900_000 }, { b: "T2", amount: -200_000 }], investmentLocked: true,
    commission: 250_000,
    commissionItems: [
      { label: "HĐ P1", amount: 150_000, approved: true },
      { label: "HĐ P2", amount: 100_000, approved: true, paidElsewhere: 100_000, paidFrom: "Sổ A" },
    ],
    commissionFlagged: [],
    advance: 200_000, advanceItems: [{ date: "03/01", label: "Ứng", amount: 200_000 }], roomRentItems: [], roomRentInvoice: null,
    paid: 0, stats: { jobs: 3, repairs: 3, afterHour: 0, workdays: 20, streak: 0 }, trend: [],
    status: "DRAFT", salaryMonthlyId: null, ledger: [],
    ...over,
  };
  m.calc = m.calc ?? salCalc(m);
  return m;
}

describe("selfSummaryOf — kỳ đang chạy", () => {
  it("các dòng cộng khớp: vận hành + đồng hành + Sale = tổng; tổng − trừ − đã trả = còn nhận", () => {
    const m = mgr({ paid: 1_000_000 });
    const s = selfSummaryOf(m);
    expect(s.base).toBe(4_000_000);
    expect(s.work).toBe(700_000);
    expect(s.allowance).toBe(300_000);
    expect(s.manualDeduct).toBe(-50_000);
    expect(s.other).toBe(0);
    expect(s.base + s.work + s.allowance + s.manualDeduct + s.other).toBe(s.vh);
    expect(s.vh + s.dh + s.sale).toBe(m.calc!.gross);
    // Hoa hồng đã chi từ sổ thật: là thu nhập nhưng trừ lại khi trả.
    expect(s.paidOut).toBe(100_000);
    expect(s.deductTotal).toBe(200_000 + 1_500_000 + 100_000);
    expect(s.net).toBe(m.calc!.takehome - 1_000_000);
    expect(s.gross - s.deductTotal - s.paid).toBe(s.net);
  });

  it("còn nhận không âm khi đã trả quá số thực nhận", () => {
    const m = mgr({ paid: 99_000_000 });
    expect(selfSummaryOf(m).net).toBe(0);
  });
});

describe("selfSummaryOf — kỳ đã chốt", () => {
  it("dùng số đóng băng, phần lệch dòng đọc lại hiện riêng, các dòng vẫn cộng khớp", () => {
    const m = mgr({
      status: "LOCKED",
      // Số live đã trôi sau khi chốt — không được dùng.
      investment: 123_456, commission: 999_999, advance: 777_777,
      frozen: { base: 4_000_000, investment: 700_000, commission: 250_000, advance: 200_000 },
      calc: { autoSum: 700_000, adjSum: 250_000, bonus: 1_000_000, gross: 5_950_000, takehome: 4_100_000 },
      paid: 4_100_000,
    });
    const s = selfSummaryOf(m);
    expect(s.dh).toBe(700_000);
    expect(s.sale).toBe(250_000);
    expect(s.advance).toBe(200_000);
    expect(s.vh).toBe(5_950_000 - 700_000 - 250_000);
    expect(s.base + s.work + s.allowance + s.manualDeduct + s.other).toBe(s.vh);
    expect(s.paidOut).toBe(5_950_000 - 200_000 - 1_500_000 - 4_100_000);
    expect(s.gross - s.deductTotal).toBe(4_100_000);
    expect(s.net).toBe(0);
  });
});

describe("danh sách việc sau từng khoản thưởng", () => {
  const ledger = [
    row({ source_id: "1", occurred_date: "2026-01-04", day_label: "CN" }),
    row({ source_id: "2", occurred_date: "2026-01-04", day_label: "CN", bonus_amount: 0, has_photo: false }),
    row({ source_id: "3", job_type_name: "lắp đặt" }),
    row({ source_id: "4", is_contract: true, job_type_name: "checkin" }),
    row({ source_id: "5", is_contract: true, job_type_name: "checkin", bonus_amount: 0 }),
    row({ source_id: "d", item_type: "DAY_BONUS", occurred_date: "2026-01-04", bonus_amount: 40_000, content: "Chủ nhật có làm việc" }),
    row({ source_id: "c", item_type: "CASH", bonus_amount: null }),
    row({ source_id: "6", occurred_date: "2026-01-02" }),
  ];
  const m = mgr({ ledger });

  it("chỉ lấy việc có thưởng đúng loại, bỏ việc ký HĐ, xếp theo ngày", () => {
    expect(jobRowsOf(m, "sửa").map((r) => r.source_id)).toEqual(["6", "1"]);
    expect(earnedJobRowsOf(m).map((r) => r.source_id)).toEqual(["6", "1", "3"]);
  });

  it("ký HĐ chỉ tính dòng đủ điều kiện", () => {
    expect(contractRowsOf(m).map((r) => r.source_id)).toEqual(["4"]);
  });

  it("ngày CN/lễ kèm mọi việc của ngày đó", () => {
    const days = bonusDaysOf(m);
    expect(days).toHaveLength(1);
    expect(days[0].jobs.map((r) => r.source_id)).toEqual(["1", "2"]);
  });
});

describe("mốc chuỗi v5", () => {
  const cfg = {
    attendance_v5: { budget: 5_000_000 },
    streak_v5: { budget: 2_000_000, milestones: [4, 8, 13, "n_top"], deltas: [200_000, 400_000, 600_000, 800_000] },
  };
  const plan = parseV5Plan(cfg) as V5Plan;
  const v5 = (over: Partial<SalV5Info> = {}): SalV5Info => ({ ticked: 18, nchuan: 22, streakCurrent: 3, streakBest: 8, banked: [4, 8], ...over });

  it("đọc cấu hình; sai dạng thì không đoán", () => {
    expect(plan).toEqual({ attendBudget: 5_000_000, streakBudget: 2_000_000, milestones: [4, 8, 13, "n_top"], deltas: [200_000, 400_000, 600_000, 800_000] });
    expect(parseV5Plan(null)).toBeNull();
    expect(parseV5Plan({ streak_v5: { milestones: [4, 8], deltas: [1] } })).toBeNull();
    expect(parseV5Plan({ streak_v5: { milestones: [4, "x"], deltas: [1, 2] } })).toBeNull();
  });

  it("tiền chuỗi khớp tổng mốc đầu (máy tính) → đạt đúng các mốc đó, mốc đỉnh = ngày công chuẩn", () => {
    const sv = streakViewOf(plan, v5(), 600_000);
    expect(sv.steps.map((s) => s.label)).toEqual(["4", "8", "13", "22"]);
    expect(sv.steps.map((s) => s.reached)).toEqual([true, true, false, false]);
    expect(sv.reached).toBe(2);
    expect(sv.days).toBe(8);
    expect(sv.nchuan).toBe(22);
    expect(sv.budget).toBe(2_000_000);
  });

  it("chủ sửa tay khôi phục chuỗi tới mốc 13 → hiện đạt 3 mốc và ngày chuỗi không thấp hơn 13", () => {
    const sv = streakViewOf(plan, v5(), 1_200_000);
    expect(sv.reached).toBe(3);
    expect(sv.days).toBe(13);
  });

  it("tiền không khớp mốc nào → dùng mốc máy đã ghi nhận", () => {
    const sv = streakViewOf(plan, v5({ banked: [4] }), 777_000);
    expect(sv.steps.map((s) => s.reached)).toEqual([true, false, false, false]);
  });

  it("chưa có tiền chuỗi → chưa đạt mốc nào", () => {
    expect(streakViewOf(plan, v5({ banked: [] , streakBest: 2 }), 0).reached).toBe(0);
  });

  it("đọc mốc máy đã ghi nhận từ cột JSON, bỏ phần tử sai dạng", () => {
    expect(bankedMilestoneDays([{ milestone: 4 }, { milestone: "8" }, { milestone: "n_top" }, null, 5])).toEqual([4, 8]);
    expect(bankedMilestoneDays(null)).toEqual([]);
  });
});
