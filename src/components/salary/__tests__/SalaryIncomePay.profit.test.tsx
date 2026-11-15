// @vitest-environment jsdom
// D2.10 — khung "Thu nhập & thanh toán": dòng trừ tạm ứng lợi nhuận, đầu tư đã trả theo mốc, chặn
// trả khi bảng chốt trước mốc, và phần đầu tư được chọn đi theo lời gọi trả lương. Số liệu mẫu.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { salCalc, type SalManager } from "@/lib/managerSalary";
import type { SalaryProfitStaff } from "@/lib/profitLedger/salaryReaders";
import { withSalaryProfit } from "@/lib/salaryProfit";
import SalaryIncomePay from "../SalaryIncomePay";

afterEach(cleanup);

function profitStaff(over: Partial<SalaryProfitStaff> = {}): SalaryProfitStaff {
  return {
    staff_id: "s1", organization_id: "org-1", shareholder_id: "sh-1", sheet_status: "DRAFT", profit_draft: false,
    allocations: [{ building_id: "b1", building_label: "T1", amount: 3_000_000, status: "LOCKED", is_stale: false }],
    by_building: [], allocated_total: 3_000_000, investment_month: 3_000_000, investment_cap: 3_000_000,
    marker_through: null, settled_by_marker: false, settlement: null, paid_lines: [], paid_investment: 0, paid_offset: 0,
    advance_open: 0, advance_offset_month: 0, suggested_advance_offset: 0, remaining_offset: 0, offset_conflict: false,
    needs_review: { count: 0, suggested: 0 }, ...over,
  };
}

function manager(profit: SalaryProfitStaff | null, over: Partial<SalManager> = {}): SalManager {
  const base: SalManager = {
    id: "s1", name: "Nhân viên A", short: "A", alias: "", role: "Quản lý", initials: "A", tone: "primary", workdays: 20,
    base: 5_000_000, roomRent: 0, incomeGoal: 0, bonusAuto: [], adjustments: [],
    investment: 3_000_000, investmentBy: [{ b: "T1", amount: 3_000_000 }], investmentLocked: true,
    commission: 0, commissionItems: [], commissionFlagged: [],
    advance: 500_000, advanceItems: [{ date: "05/10", label: "Ứng lương", amount: 500_000 }], roomRentItems: [], roomRentInvoice: null,
    paid: 0, stats: { jobs: 0, repairs: 0, afterHour: 0, workdays: 20, streak: 0 }, trend: [], status: "DRAFT",
    salaryMonthlyId: null, ledger: [], ...over,
  };
  const m = withSalaryProfit(base, profit);
  m.calc = m.calc ?? salCalc(m);
  return m;
}

function view(m: SalManager) {
  const onPayout = vi.fn(async () => undefined);
  render(
    <MemoryRouter>
      <SalaryIncomePay managers={[m]} period={{ label: "Tháng 10", year: 2026 }} selectedId={m.id} onSelect={() => {}}
        pending={[]} accounts={[{ id: "acc", name: "Sổ A" }]} canPay onPayout={onPayout} payBusy={false}
        onOpenLedger={() => {}} onAdjust={() => {}} onRemoveAdjustment={() => {}} canEditAmounts={false} onEditAmount={() => {}} />
    </MemoryRouter>,
  );
  return onPayout;
}

const payButton = () => screen.getByRole("button", { name: /Lập yêu cầu thanh toán|Chưa trả được/ });
const dhBox = () => screen.getByRole("checkbox", { name: "Đưa vào thanh toán: T1 · lợi nhuận kỳ" }) as HTMLInputElement;

describe("trừ tạm ứng lợi nhuận chỉ trong phần đầu tư được chọn", () => {
  const withD = profitStaff({ advance_offset_month: 1_200_000, suggested_advance_offset: 1_200_000 });

  it("chọn đủ: tiền chuyển = thực nhận; gửi phần đầu tư đã chọn cùng lời gọi trả lương", async () => {
    const m = manager(withD);
    const onPayout = view(m);
    expect(document.body.textContent).toContain("Trừ tạm ứng lợi nhuận");
    expect(document.body.textContent).toContain("Tạm ứng LN");
    fireEvent.click(payButton());
    await waitFor(() => expect(onPayout).toHaveBeenCalled());
    expect(onPayout).toHaveBeenCalledWith("s1", "Nhân viên A", m.calc!.takehome, "acc", expect.any(String), "Lương Tháng 10/2026", { investmentSelected: 3_000_000 });
    expect(m.calc!.takehome).toBe(5_000_000 + 3_000_000 - 500_000 - 1_200_000);
  });

  it("bỏ chọn phần đầu tư: không trừ tạm ứng vào lương cơ bản", async () => {
    const onPayout = view(manager(withD));
    fireEvent.click(dhBox());
    fireEvent.click(payButton());
    await waitFor(() => expect(onPayout).toHaveBeenCalled());
    expect(onPayout).toHaveBeenCalledWith("s1", "Nhân viên A", 5_000_000 - 500_000, "acc", expect.any(String), expect.any(String), { investmentSelected: 0 });
  });
});

it("tháng trong mốc 'đã trả đủ': dòng đầu tư luôn đi kèm, tiền chuyển bớt đúng phần đó, tổng thu nhập giữ nguyên", async () => {
  const m = manager(profitStaff({ settled_by_marker: true, marker_through: "2026-09-01", investment_cap: 0 }));
  const onPayout = view(m);
  expect(dhBox().disabled).toBe(true);
  expect(dhBox().checked).toBe(true);
  expect(document.body.textContent).toContain("Đã trả theo mốc");
  expect(document.body.textContent).toContain("8.000.000");
  fireEvent.click(payButton());
  await waitFor(() => expect(onPayout).toHaveBeenCalled());
  expect(onPayout).toHaveBeenCalledWith("s1", "Nhân viên A", 5_000_000 - 500_000, "acc", expect.any(String), expect.any(String), { investmentSelected: 0 });
});

it("bảng chốt trước mốc: chặn nút trả, nói rõ phải chốt lại", () => {
  const frozen = { base: 5_000_000, investment: 3_000_000, commission: 0, advance: 500_000 };
  const m = manager(profitStaff({ sheet_status: "LOCKED", settled_by_marker: true, marker_through: "2026-09-01" }), {
    status: "LOCKED", frozen, calc: { autoSum: 0, adjSum: 0, bonus: 0, gross: 8_000_000, takehome: 7_500_000 },
  });
  const onPayout = view(m);
  expect((payButton() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toMatch(/Mở chốt rồi chốt lại/);
  expect(onPayout).not.toHaveBeenCalled();
});

it("hồi quy — nhân viên không phải cổ đông: không dòng mới, trả đúng số cũ, không gửi phần đầu tư", async () => {
  const m = manager(null, { investment: 0, investmentBy: [] });
  const onPayout = view(m);
  expect(document.body.textContent).not.toContain("Trừ tạm ứng lợi nhuận");
  expect(document.body.textContent).not.toContain("theo mốc");
  fireEvent.click(payButton());
  await waitFor(() => expect(onPayout).toHaveBeenCalled());
  expect(onPayout).toHaveBeenCalledWith("s1", "Nhân viên A", 5_000_000 - 500_000, "acc", expect.any(String), expect.any(String), undefined);
});
