// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { salCalc, type SalLedgerRow, type SalManager } from "@/lib/managerSalary";
import type { V5Plan } from "@/lib/salarySelfSummary";
import SalarySelfView from "../SalarySelfView";

afterEach(cleanup);

const job = (i: number, over: Partial<SalLedgerRow> = {}): SalLedgerRow => ({
  staff_id: "s1", item_type: "JOB", source_id: "j" + i, occurred_date: `2026-01-0${i}`, day_label: "", content: `việc mẫu ${i}`,
  place: `T1 · 10${i}`, job_type_name: "sửa", is_repair: true, is_contract: false, base_amount: 20_000, weekend_amount: 0,
  after_amount: 0, cash_amount: null, has_photo: true, bonus_amount: 20_000, reason: "", excluded: false, ...over,
} as SalLedgerRow);

function mgr(over: Partial<SalManager> = {}): SalManager {
  const m: SalManager = {
    id: "s1", name: "Nhân viên A", short: "A", alias: "", role: "Quản lý vận hành", initials: "A", tone: "primary",
    workdays: 18, base: 4_000_000, roomRent: 1_500_000, incomeGoal: 0,
    bonusAuto: [
      { icon: "Flame", label: "Thưởng chuỗi (v5)", note: "mốc chuỗi đã đạt", amount: 600_000 },
      { icon: "Wrench", label: "sửa", note: "3 việc × 20.000", amount: 60_000 },
    ],
    adjustments: [{ id: "a1", icon: "Plus", label: "Phụ cấp xăng", amount: 300_000 }],
    investment: 700_000, investmentBy: [{ b: "T1", amount: 900_000 }, { b: "T2", amount: -200_000 }], investmentLocked: true,
    commission: 0, commissionItems: [], commissionFlagged: [],
    advance: 0, advanceItems: [], roomRentItems: [{ date: "", label: "HĐ phòng P1 · T2", amount: 1_500_000 }], roomRentInvoice: null,
    paid: 0, stats: { jobs: 3, repairs: 3, afterHour: 0, workdays: 18, streak: 0 }, trend: [],
    status: "DRAFT", salaryMonthlyId: null, ledger: [job(1), job(2), job(3), job(4, { bonus_amount: 0, has_photo: false })],
    v5: { ticked: 18, nchuan: 22, streakCurrent: 3, streakBest: 8, banked: [4, 8] },
    ...over,
  };
  m.calc = salCalc(m);
  return m;
}

const plan: V5Plan = { attendBudget: 5_000_000, streakBudget: 2_000_000, milestones: [4, 8, 13, "n_top"], deltas: [200_000, 400_000, 600_000, 800_000] };

function view(m = mgr()) {
  return render(<SalarySelfView m={m} period={{ label: "Tháng 1", year: 2026 }} v5Plan={plan} canPrev canNext={false} />);
}

it("tóm tắt: tổng thu nhập − trừ khi trả = còn nhận, ghi chi tiết dưới tổng", () => {
  view();
  const sum = screen.getByRole("region", { name: "Tóm tắt kỳ" });
  // 4.000.000 + 660.000 + 300.000 + 700.000 = 5.660.000; trừ 1.500.000 tiền phòng.
  expect(sum.textContent).toContain("5.660.000₫");
  expect(sum.textContent).toContain("1.500.000₫");
  expect(sum.textContent).toContain("4.160.000₫");
  expect(within(sum).getByText("Lương cứng")).toBeTruthy();
  expect(within(sum).getByText("Phụ cấp & lương bổ sung")).toBeTruthy();
  expect(sum.textContent).toContain("Chuyên cần · 18/22 ngày công");
});

it("hoạt động tháng: ngày công và chuỗi ghi dạng x/y, đạt mấy mốc", () => {
  view();
  const act = screen.getByRole("region", { name: "Hoạt động tháng" });
  expect(act.textContent).toContain("18/22");
  expect(act.textContent).toContain("8/22");
  expect(act.textContent).toContain("đạt 2/4 mốc");
  expect(act.textContent).toContain("Lương cứng4tr/5tr");
  expect(act.textContent).toContain("Thưởng chuỗi600k/2tr");
  expect(within(act).getByRole("img", { name: /4 ngày đã đạt, 8 ngày đã đạt, 13 ngày chưa đạt/ })).toBeTruthy();
});

it("bấm Thưởng việc mở đủ danh sách việc có thưởng ngay tại chỗ", () => {
  view();
  const btn = screen.getByRole("button", { name: /Thưởng việc · sửa/ });
  expect(btn.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(btn);
  expect(btn.getAttribute("aria-expanded")).toBe("true");
  const panel = document.getElementById(btn.getAttribute("aria-controls") as string)!;
  // Việc không được thưởng (thiếu ảnh) không nằm trong danh sách tiền thưởng.
  expect(within(panel).getAllByRole("row")).toHaveLength(1 + 3);
  expect(panel.textContent).toContain("việc mẫu 3");
  expect(panel.textContent).not.toContain("việc mẫu 4");
});

it("khoản sửa tay: nhân viên thấy số máy tính và số đã điều chỉnh, không thấy lý do hay người sửa", () => {
  view(mgr({ overrides: { base: { computed: 4_200_000, amount: 4_000_000, reason: "ghi chú nội bộ mẫu", byName: "Quản trị B", at: "2026-01-20T00:00:00Z" } } }));
  const btn = screen.getAllByRole("button").find((b) => b.textContent?.includes("Đã điều chỉnh"))!;
  expect(btn.textContent).toContain("Máy tính 4.200.000");
  fireEvent.click(btn);
  const panel = document.getElementById(btn.getAttribute("aria-controls") as string)!;
  expect(panel.textContent).toContain("Số đã điều chỉnh");
  expect(document.body.textContent).not.toContain("ghi chú nội bộ mẫu");
  expect(document.body.textContent).not.toContain("Quản trị B");
});

it("mốc máy ghi nhận không thuộc thang hiện hành (kỳ cũ) → ẩn thẻ mốc chuỗi, không đoán", () => {
  view(mgr({
    bonusAuto: [{ icon: "Flame", label: "Thưởng chuỗi (v5)", note: "", amount: 777_000 }],
    v5: { ticked: 18, nchuan: 22, streakCurrent: 3, streakBest: 8, banked: [5, 10] },
  }));
  const act = screen.getByRole("region", { name: "Hoạt động tháng" });
  expect(act.textContent).not.toContain("Mốc chuỗi");
});

it("thu nhập đồng hành chỉ hiển thị, không bấm; tòa lỗ hiện số âm", () => {
  view();
  const dh = screen.getByRole("region", { name: "Thu nhập đồng hành" });
  expect(within(dh).queryAllByRole("button")).toHaveLength(0);
  expect(dh.textContent).toContain("−200.000");
});
